// scripts/weekly/test/stage.stage.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stagePlan, buildItems, buildRevision, idempotencyKey, nextRevisionNumber, exportPaths, writeExports, defaultSummary,
  EXPORT_FILES, EXPORT_MODES, ITEM_TYPES, STAGE_MODES,
} from '../lib/stage.mjs';
import { createFileStore } from '../lib/store.mjs';
import { GenerationInvalid, ValidationFailed } from '../lib/errors.mjs';
import { SHADOW_DIR } from '../lib/paths.mjs';
import { PlanItemSchema, RevisionSchema, parseOrIssues } from '../lib/schemas.mjs';
import { NOW, ISO, WEEK, ATTEMPT_ID, SERVICES, makePlan } from './stage.helpers.mjs';

function makeAttempt(overrides = {}) {
  return {
    id: ATTEMPT_ID, week_of: '2026-09-07', mode: 'shadow', git_sha: 'abc123',
    versions: { schema: '2026-09-06.1', prompt: 'p1', policy: '2026-09-06.1' },
    models: { generate: 'deepseek-chat', fallback: null },
    started_at: ISO, finished_at: null, stages: { collect: { started_at: ISO, finished_at: ISO, status: 'ok', error: null } },
    lease_until: null, budget_usd: 20, spent_usd: 0.42, status: 'running', error: null,
    ...overrides,
  };
}

const candidate = {
  service_key: 'panel_upgrade', service_label: SERVICES[0], city: 'Rockwall', query_family: ['electrical panel upgrade rockwall'],
  scores: { priority: 1, demand: 0.5, opportunity: 0.6, recency: 1, season: 0.5, performance: 0.5 }, total: 0.7, reasons: ['priority 5'],
};
const SELECTION = { winner: candidate, ranked: [candidate], excluded: [], rationale: 'Panel upgrade in Rockwall leads on priority and opportunity.', degraded: false };
const VALID = { ok: true, errors: [], warnings: ['GBP day 2: headline over 58 chars'] };
const RENDERED = { gbp: '# GBP schedule\n**DAY:** 1\n', facebook: '## Week of 2026-09-07\n**DAY:** 1\n', website: '# Website queue\n- item\n', summary: '# Summary\n' };

let root;
let counter = 0;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-stage-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });
const fresh = () => {
  const dir = path.join(root, `case-${++counter}`);
  return { store: createFileStore(path.join(dir, 'store')), outDir: path.join(dir, 'shadow'), dir };
};

/** Store spy that records calls; `withAtomic` adds stageRevision. */
function spyStore({ withAtomic, revisions = [] } = {}) {
  const calls = [];
  const store = {
    calls,
    async listRevisions() { calls.push('listRevisions'); return revisions; },
    async putRevision(rev) { calls.push('putRevision'); store.revision = rev; return rev; },
    async putItems(items) { calls.push('putItems'); store.items = items; return { count: items.length }; },
  };
  if (withAtomic) {
    store.stageRevision = async ({ revision, items }) => { calls.push('stageRevision'); store.revision = revision; store.items = items; return { revision_id: revision.id, items: items.length }; };
  }
  return store;
}

describe('idempotencyKey', () => {
  it('is sha256 hex of week_of|platform|slot_date|item_type|service', () => {
    const expected = crypto.createHash('sha256').update('2026-09-07|gbp|2026-09-04|gbp_post|EV Charger Installation').digest('hex');
    assert.equal(idempotencyKey({ week_of: '2026-09-07', platform: 'gbp', slot_date: '2026-09-04', item_type: 'gbp_post', service: 'EV Charger Installation' }), expected);
  });
  it('treats null and undefined fields as empty strings', () => {
    const expected = crypto.createHash('sha256').update('2026-09-07|website||website_blog_post|').digest('hex');
    assert.equal(idempotencyKey({ week_of: '2026-09-07', platform: 'website', slot_date: null, item_type: 'website_blog_post', service: undefined }), expected);
  });
});

describe('buildItems', () => {
  const plan = makePlan();
  const items = buildItems(plan, 'rev-1');

  it('emits one item per GBP day, Facebook day and website action, all schema-valid', () => {
    assert.equal(items.length, 7 + 4 + 2);
    for (const it of items) assert.deepEqual(parseOrIssues(PlanItemSchema, it).issues, []);
    assert.deepEqual(items.map((i) => i.platform), [...Array(7).fill('gbp'), ...Array(4).fill('facebook'), 'website', 'website']);
    assert.deepEqual(items.map((i) => i.revision_id), Array(13).fill('rev-1'));
  });
  it('sets ids, slot dates, item types, media refs and null projection fields', () => {
    const gbp1 = items[0];
    assert.equal(gbp1.id, 'rev-1-gbp-1');
    assert.equal(gbp1.slot_date, WEEK.gbp_dates[1]);
    assert.equal(gbp1.item_type, ITEM_TYPES.gbp);
    assert.equal(gbp1.media_ref, 'IMG_2701.JPG');
    assert.equal(items[1].media_ref, null);
    assert.equal(gbp1.projected_ref, null);
    assert.equal(gbp1.publish_status, null);
    assert.deepEqual(gbp1.content, plan.gbp[0]);
    const fb3 = items[8];
    assert.equal(fb3.id, 'rev-1-facebook-3');
    assert.equal(fb3.slot_date, WEEK.fb_dates[3]);
    assert.equal(fb3.item_type, ITEM_TYPES.facebook);
    assert.equal(fb3.media_ref, 'IMG_3403.JPG');
    const web = items[11];
    assert.equal(web.id, 'rev-1-website-1');
    assert.equal(web.slot_date, null);
    assert.equal(web.item_type, 'website_service_page_update');
    assert.equal(web.media_ref, null);
    assert.deepEqual(web.content, plan.website_actions[0]);
  });
  it('idempotency keys follow the contract and stay unique within the revision', () => {
    const gbp1 = items[0];
    assert.equal(gbp1.idempotency_key, idempotencyKey({ week_of: '2026-09-07', platform: 'gbp', slot_date: WEEK.gbp_dates[1], item_type: 'gbp_post', service: plan.gbp[0].service }));
    const fb1 = items[7];
    assert.equal(fb1.idempotency_key, idempotencyKey({ week_of: '2026-09-07', platform: 'facebook', slot_date: WEEK.fb_dates[1], item_type: 'facebook_post', service: plan.facebook[0].service }));
    assert.equal(new Set(items.map((i) => i.idempotency_key)).size, items.length);
  });
  it('Facebook keys do not change when the post type changes between revisions', () => {
    const other = makePlan();
    other.facebook[1].type = 'photo';
    assert.equal(buildItems(other, 'rev-2')[8].idempotency_key, items[8].idempotency_key);
  });
  it('website keys use target, then title, in the service slot', () => {
    assert.equal(items[11].idempotency_key, idempotencyKey({ week_of: '2026-09-07', platform: 'website', slot_date: null, item_type: 'website_service_page_update', service: '/panel-upgrades/' }));
    assert.equal(items[12].idempotency_key, idempotencyKey({ week_of: '2026-09-07', platform: 'website', slot_date: null, item_type: 'website_blog_post', service: 'Panel upgrade cost in Rockwall' }));
  });
  it('two website actions with the same type and target get deterministic distinct keys', () => {
    const dup = makePlan();
    dup.website_actions.push({ ...dup.website_actions[0], title: 'Second edit of the panel page' });
    const out = buildItems(dup, 'rev-1');
    const keys = out.filter((i) => i.platform === 'website').map((i) => i.idempotency_key);
    assert.equal(new Set(keys).size, 3);
    assert.equal(keys[2], idempotencyKey({ week_of: '2026-09-07', platform: 'website', slot_date: null, item_type: 'website_service_page_update', service: '/panel-upgrades/#2' }));
    assert.deepEqual(buildItems(dup, 'rev-1').map((i) => i.idempotency_key), out.map((i) => i.idempotency_key));
  });
  it('rejects missing inputs', () => {
    assert.throws(() => buildItems(null, 'r'), TypeError);
    assert.throws(() => buildItems(plan, ''), TypeError);
  });
  it('refuses a plan that names the same day twice instead of emitting colliding item ids', () => {
    const dup = makePlan();
    dup.gbp[1] = { ...dup.gbp[0] };
    assert.throws(() => buildItems(dup, 'rev-1'), (e) => e instanceof GenerationInvalid
      && /duplicate gbp day 1/.test(e.message)
      && e.issues.length === 1 && e.issues[0].path === 'gbp[1].day');
    const dupFb = makePlan();
    dupFb.facebook[3] = { ...dupFb.facebook[2] };
    assert.throws(() => buildItems(dupFb, 'rev-1'), (e) => e instanceof GenerationInvalid && e.issues[0].path === 'facebook[3].day');
    // The same id twice would be silently collapsed by the file store's upsert.
    assert.equal(new Set(buildItems(plan, 'rev-1').map((i) => i.id)).size, 13);
  });
});

describe('buildRevision / nextRevisionNumber / exportPaths', () => {
  it('builds a schema-valid revision with a null projected_at', () => {
    const rev = buildRevision({ attempt: makeAttempt(), plan: makePlan(), selection: SELECTION, validation: VALID, revisionNumber: 3, exportedAt: ISO });
    assert.deepEqual(parseOrIssues(RevisionSchema, rev).issues, []);
    assert.equal(rev.id, `${ATTEMPT_ID}-r3`);
    assert.equal(rev.revision, 3);
    assert.equal(rev.exported_at, ISO);
    assert.equal(rev.projected_at, null);
  });
  it('numbers from the highest existing revision for the week', async () => {
    assert.equal(await nextRevisionNumber(spyStore(), '2026-09-07'), 1);
    assert.equal(await nextRevisionNumber(spyStore({ revisions: [{ revision: 2 }, { revision: 5 }, { revision: 'x' }] }), '2026-09-07'), 6);
  });
  it('exportPaths defaults to outputs/shadow and lists the seven files', () => {
    const paths = exportPaths();
    assert.deepEqual(Object.keys(paths), Object.keys(EXPORT_FILES));
    for (const [key, p] of Object.entries(paths)) assert.equal(p, path.join(SHADOW_DIR, EXPORT_FILES[key]));
    assert.deepEqual(EXPORT_MODES, ['shadow', 'offline']);
  });
});

describe('stagePlan in shadow mode with the real file store', () => {
  it('persists the revision and items, exports the seven files, and numbers the next revision', async () => {
    const { store, outDir } = fresh();
    const attempt = makeAttempt();
    const plan = makePlan();
    const rev = await stagePlan({ store, attempt, plan, selection: SELECTION, validation: VALID, rendered: RENDERED, mode: 'shadow', now: NOW, outDir });

    assert.deepEqual(parseOrIssues(RevisionSchema, rev).issues, []);
    assert.equal(rev.id, `${ATTEMPT_ID}-r1`);
    assert.equal(rev.revision, 1);
    assert.equal(rev.attempt_id, ATTEMPT_ID);
    assert.equal(rev.week_of, '2026-09-07');
    assert.equal(rev.exported_at, ISO);
    assert.equal(rev.projected_at, null);
    assert.deepEqual(rev.topic, plan.topic);
    assert.deepEqual(rev.validation, VALID);
    assert.deepEqual(rev.selection, SELECTION);

    const stored = await store.listRevisions('2026-09-07');
    assert.deepEqual(stored, [rev]);
    const items = await store.listItems(rev.id);
    assert.equal(items.length, 13);
    assert.deepEqual(items, buildItems(plan, rev.id));

    const paths = exportPaths(outDir);
    for (const p of Object.values(paths)) assert.ok(fs.existsSync(p), `missing ${p}`);
    assert.equal(fs.readFileSync(paths.gbp, 'utf8'), RENDERED.gbp);
    assert.equal(fs.readFileSync(paths.facebook, 'utf8'), RENDERED.facebook);
    assert.equal(fs.readFileSync(paths.website, 'utf8'), RENDERED.website);
    assert.equal(fs.readFileSync(paths.summary, 'utf8'), RENDERED.summary);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.plan, 'utf8')), plan);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.selection, 'utf8')), SELECTION);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.attempt, 'utf8')), attempt);
    assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith('.tmp')), []);

    const rev2 = await stagePlan({ store, attempt, plan, selection: SELECTION, validation: VALID, rendered: RENDERED, mode: 'shadow', now: NOW, outDir });
    assert.equal(rev2.revision, 2);
    assert.equal(rev2.id, `${ATTEMPT_ID}-r2`);
    assert.equal((await store.listRevisions('2026-09-07')).length, 2);
    assert.equal((await store.listItems(rev2.id)).length, 13);
  });

  it('offline mode exports too and generates a summary when none is rendered', async () => {
    const { store, outDir } = fresh();
    const attempt = makeAttempt({ mode: 'offline' });
    const { summary, ...noSummary } = RENDERED;
    void summary;
    const rev = await stagePlan({ store, attempt, plan: makePlan(), selection: SELECTION, validation: VALID, rendered: noSummary, now: NOW, outDir });
    assert.equal(rev.exported_at, ISO);
    const text = fs.readFileSync(exportPaths(outDir).summary, 'utf8');
    assert.match(text, /week of 2026-09-07/);
    assert.match(text, /Electrical Panel Upgrade \/ Replacement in Rockwall/);
    assert.match(text, /Revision: 1/);
    assert.match(text, /1 warning/);
    assert.match(text, /headline over 58 chars/);
    assert.match(text, /Panel upgrade in Rockwall leads/);
  });

  it('accepts the long rendered key names', async () => {
    const { store, outDir } = fresh();
    const rendered = { gbp_posting_schedule: RENDERED.gbp, facebook_posting_schedule: RENDERED.facebook, website_queue: RENDERED.website, plan_summary: RENDERED.summary };
    await stagePlan({ store, attempt: makeAttempt(), plan: makePlan(), selection: SELECTION, validation: VALID, rendered, mode: 'shadow', now: NOW, outDir });
    assert.equal(fs.readFileSync(exportPaths(outDir).facebook, 'utf8'), RENDERED.facebook);
  });

  it('stages a revision whose validation failed (recorded, never projected)', async () => {
    const { store, outDir } = fresh();
    const failed = { ok: false, errors: ['GBP day 1: phone (214) 555-0100 is not a business number'], warnings: [] };
    const rev = await stagePlan({ store, attempt: makeAttempt(), plan: makePlan(), selection: SELECTION, validation: failed, rendered: RENDERED, mode: 'shadow', now: NOW, outDir });
    assert.equal(rev.validation.ok, false);
    assert.deepEqual((await store.listRevisions('2026-09-07'))[0].validation, failed);
  });

  it('does not stage when a rendered file is missing (files are written before the store)', async () => {
    const { store, outDir } = fresh();
    const { facebook, ...missingFb } = RENDERED;
    void facebook;
    await assert.rejects(
      stagePlan({ store, attempt: makeAttempt(), plan: makePlan(), selection: SELECTION, validation: VALID, rendered: missingFb, mode: 'shadow', now: NOW, outDir }),
      (e) => e instanceof TypeError && /rendered\.facebook/.test(e.message),
    );
    assert.deepEqual(await store.listRevisions('2026-09-07'), []);
    assert.ok(!fs.existsSync(path.join(outDir, EXPORT_FILES.plan)));
  });

  it('never calls project outside mode new, even when one is passed', async () => {
    const { store, outDir } = fresh();
    let called = 0;
    const project = async () => { called++; };
    const rev = await stagePlan({ store, attempt: makeAttempt(), plan: makePlan(), selection: SELECTION, validation: VALID, rendered: RENDERED, mode: 'shadow', now: NOW, outDir, project });
    await stagePlan({ store, attempt: makeAttempt({ mode: 'offline' }), plan: makePlan(), selection: SELECTION, validation: VALID, rendered: RENDERED, now: NOW, outDir, project });
    assert.equal(called, 0);
    assert.equal(rev.projected_at, null);
  });
});

describe('stagePlan in mode new', () => {
  it('writes no files and does not project without a project function', async () => {
    const { store, outDir } = fresh();
    const rev = await stagePlan({ store, attempt: makeAttempt({ mode: 'new' }), plan: makePlan(), selection: SELECTION, validation: VALID, mode: 'new', now: NOW, outDir });
    assert.equal(rev.exported_at, null);
    assert.equal(rev.projected_at, null);
    assert.ok(!fs.existsSync(outDir));
    assert.equal((await store.listItems(rev.id)).length, 13);
  });

  it('calls project with the staged revision and items when validation passed', async () => {
    const { store, outDir } = fresh();
    const attempt = makeAttempt({ mode: 'new' });
    const seen = [];
    const project = async (args) => { seen.push(args); return { runId: 'run-1' }; };
    const rev = await stagePlan({ store, attempt, plan: makePlan(), selection: SELECTION, validation: VALID, mode: 'new', now: NOW, outDir, project });
    assert.equal(seen.length, 1);
    const args = seen[0];
    assert.equal(args.store, store);
    assert.equal(args.attempt, attempt);
    assert.equal(args.mode, 'new');
    assert.equal(args.now, NOW);
    assert.equal(args.revision.id, rev.id);
    assert.equal(args.items.length, 13);
    assert.deepEqual(args.items, await store.listItems(rev.id));
    assert.equal(args.plan.week_of, '2026-09-07');
    assert.equal(rev.projected_at, ISO);
    assert.ok(!fs.existsSync(outDir));
  });

  it('refuses to project a plan that failed validation and leaves the revision staged', async () => {
    const { store } = fresh();
    let called = 0;
    const project = async () => { called++; };
    const failed = { ok: false, errors: ['date mismatch'], warnings: [] };
    await assert.rejects(
      stagePlan({ store, attempt: makeAttempt({ mode: 'new' }), plan: makePlan(), selection: SELECTION, validation: failed, mode: 'new', now: NOW, project }),
      (e) => e instanceof ValidationFailed && e.errors[0] === 'date mismatch',
    );
    assert.equal(called, 0);
    assert.equal((await store.listRevisions('2026-09-07')).length, 1);
  });

  it('propagates a project failure after the revision is staged', async () => {
    const { store } = fresh();
    const project = async () => { throw new Error('weekly_posts insert: boom'); };
    await assert.rejects(
      stagePlan({ store, attempt: makeAttempt({ mode: 'new' }), plan: makePlan(), selection: SELECTION, validation: VALID, mode: 'new', now: NOW, project }),
      /weekly_posts insert: boom/,
    );
    assert.equal((await store.listRevisions('2026-09-07')).length, 1);
  });
});

describe('stagePlan store selection', () => {
  it('prefers the atomic stageRevision when the store has it', async () => {
    const store = spyStore({ withAtomic: true });
    const rev = await stagePlan({ store, attempt: makeAttempt({ mode: 'new' }), plan: makePlan(), selection: SELECTION, validation: VALID, mode: 'new', now: NOW });
    assert.deepEqual(store.calls, ['listRevisions', 'stageRevision']);
    assert.equal(store.revision.id, rev.id);
    assert.equal(store.items.length, 13);
    assert.ok(store.items.every((i) => i.revision_id === rev.id));
  });

  it('falls back to putRevision then putItems', async () => {
    const store = spyStore({ revisions: [{ revision: 4 }] });
    const rev = await stagePlan({ store, attempt: makeAttempt({ mode: 'new' }), plan: makePlan(), selection: SELECTION, validation: VALID, mode: 'new', now: NOW });
    assert.deepEqual(store.calls, ['listRevisions', 'putRevision', 'putItems']);
    assert.equal(rev.revision, 5);
    assert.equal(store.revision.id, `${ATTEMPT_ID}-r5`);
    assert.equal(store.items[0].revision_id, `${ATTEMPT_ID}-r5`);
  });

  it('uses attempt.mode when mode is not passed', async () => {
    const store = spyStore({ withAtomic: true });
    const { outDir } = fresh();
    const rev = await stagePlan({ store, attempt: makeAttempt({ mode: 'shadow' }), plan: makePlan(), selection: SELECTION, validation: VALID, rendered: RENDERED, now: NOW, outDir });
    assert.equal(rev.exported_at, ISO);
    assert.ok(fs.existsSync(exportPaths(outDir).plan));
  });

  it('surfaces a store failure', async () => {
    const store = spyStore({ withAtomic: true });
    store.stageRevision = async () => { throw new Error('stage_plan_revision: permission denied'); };
    await assert.rejects(
      stagePlan({ store, attempt: makeAttempt({ mode: 'new' }), plan: makePlan(), selection: SELECTION, validation: VALID, mode: 'new', now: NOW }),
      /stage_plan_revision: permission denied/,
    );
  });
});

describe('stagePlan input guards', () => {
  const base = () => ({ store: spyStore({ withAtomic: true }), attempt: makeAttempt({ mode: 'new' }), plan: makePlan(), selection: SELECTION, validation: VALID, mode: 'new', now: NOW });

  it('requires store, attempt, mode and validation', async () => {
    await assert.rejects(stagePlan({ ...base(), store: null }), /store is required/);
    await assert.rejects(stagePlan({ ...base(), attempt: {} }), /attempt with an id/);
    await assert.rejects(stagePlan({ ...base(), attempt: makeAttempt({ mode: undefined }), mode: undefined }), /mode is required/);
    await assert.rejects(stagePlan({ ...base(), validation: undefined }), /validation \{ ok, errors, warnings \} is required/);
  });

  it('rejects a schema-invalid plan with GenerationInvalid carrying the issues', async () => {
    const plan = makePlan();
    plan.gbp.pop();
    await assert.rejects(stagePlan({ ...base(), plan }), (e) => e instanceof GenerationInvalid && e.issues.some((i) => i.path === 'gbp'));
  });

  it('rejects a schema-valid plan with a duplicated day before touching the store', async () => {
    const store = spyStore({ withAtomic: true });
    const plan = makePlan();
    plan.gbp[2] = { ...plan.gbp[1] };
    await assert.rejects(stagePlan({ ...base(), store, plan }), (e) => e instanceof GenerationInvalid && e.issues[0].path === 'gbp[2].day');
    assert.deepEqual(store.calls, ['listRevisions']);
  });

  it('rejects an unknown mode before touching the store (a typo must not silently skip the export)', async () => {
    assert.deepEqual(STAGE_MODES, ['legacy', 'shadow', 'new', 'offline']);
    for (const mode of ['shadaw', 'SHADOW', 'live']) {
      const store = spyStore({ withAtomic: true });
      await assert.rejects(stagePlan({ ...base(), store, mode }), (e) => e instanceof TypeError && e.message.includes(`unknown mode "${mode}"`));
      assert.deepEqual(store.calls, []);
    }
    const store = spyStore({ withAtomic: true });
    await assert.rejects(stagePlan({ ...base(), store, attempt: makeAttempt({ mode: 'nope' }), mode: undefined }), /unknown mode "nope"/);
    assert.deepEqual(store.calls, []);
  });

  it('accepts now as an ISO string and hands project a Date; rejects an invalid now', async () => {
    const { store, outDir } = fresh();
    const rev = await stagePlan({ ...base(), store, attempt: makeAttempt({ mode: 'shadow' }), mode: 'shadow', rendered: RENDERED, outDir, now: ISO });
    assert.equal(rev.exported_at, ISO);
    const seen = [];
    const rev2 = await stagePlan({ ...base(), now: ISO, project: async (args) => { seen.push(args.now); } });
    assert.ok(seen[0] instanceof Date);
    assert.equal(seen[0].toISOString(), ISO);
    assert.equal(rev2.projected_at, ISO);
    const untouched = spyStore({ withAtomic: true });
    await assert.rejects(stagePlan({ ...base(), store: untouched, now: 'not a date' }), /now must be a valid Date/);
    assert.deepEqual(untouched.calls, []);
  });

  it('rejects a plan for another week or another attempt', async () => {
    await assert.rejects(stagePlan({ ...base(), plan: makePlan({ week_of: '2026-09-14' }) }), /plan\.week_of 2026-09-14 does not match attempt\.week_of 2026-09-07/);
    await assert.rejects(stagePlan({ ...base(), plan: makePlan({ attempt_id: 'someone-else' }) }), /plan\.attempt_id someone-else does not match/);
  });

  it('rejects a selection that does not fit the revision schema before touching the store', async () => {
    const store = spyStore({ withAtomic: true });
    await assert.rejects(stagePlan({ ...base(), store, selection: { winner: null } }), /revision failed schema validation/);
    assert.deepEqual(store.calls, ['listRevisions']);
  });

  it('normalizes validation lists to strings and booleans', async () => {
    const rev = await stagePlan({ ...base(), validation: { ok: 1, errors: null, warnings: [42] } });
    assert.deepEqual(rev.validation, { ok: true, errors: [], warnings: ['42'] });
  });
});

describe('writeExports / defaultSummary', () => {
  it('writes atomically (no tmp files left) and returns the paths', async () => {
    const { outDir } = fresh();
    const attempt = makeAttempt();
    const plan = makePlan();
    const revision = buildRevision({ attempt, plan, selection: SELECTION, validation: VALID, revisionNumber: 1, exportedAt: ISO });
    const paths = await writeExports(outDir, { rendered: RENDERED, plan, selection: SELECTION, attempt, revision, validation: VALID });
    assert.deepEqual(paths, exportPaths(outDir));
    assert.deepEqual(fs.readdirSync(outDir).sort(), Object.values(EXPORT_FILES).sort());
  });
  it('rejects blank rendered text', async () => {
    const { outDir } = fresh();
    const attempt = makeAttempt();
    const plan = makePlan();
    const revision = buildRevision({ attempt, plan, selection: SELECTION, validation: VALID, revisionNumber: 1 });
    await assert.rejects(writeExports(outDir, { rendered: { ...RENDERED, website: '   ' }, plan, selection: SELECTION, attempt, revision, validation: VALID }), /rendered\.website/);
  });
  it('defaultSummary lists validation errors', () => {
    const attempt = makeAttempt();
    const plan = makePlan();
    const validation = { ok: false, errors: ['bad date'], warnings: [] };
    const revision = buildRevision({ attempt, plan, selection: SELECTION, validation, revisionNumber: 2 });
    const text = defaultSummary({ plan, selection: SELECTION, validation, revision, attempt });
    assert.match(text, /Validation: FAILED — 1 error/);
    assert.match(text, /- bad date/);
    assert.match(text, /GBP posts: 7 \(2026-09-04 to 2026-09-10\)/);
  });
});
