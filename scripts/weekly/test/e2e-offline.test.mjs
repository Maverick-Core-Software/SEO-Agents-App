// scripts/weekly/test/e2e-offline.test.mjs
// The integrator's end-to-end test: scripts/weekly/run.mjs in --mode offline
// runs the whole chain (attempt → collect → select → generate → validate →
// stage → compare → finish) against test/fixtures/e2e with no network, writing
// only to temp dirs. Also covers the lease refusal, the degraded path, the one
// validation regeneration, shadow-mode plumbing (file-store fallback, photo
// inventory, mirror), prior-week winner exclusion, the CLI exit codes, and the
// pure helpers. globalThis.fetch is replaced with a trap for the whole file.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  COLLECTOR_NAMES, DEFAULT_FIXTURES_DIR, FIXTURE_FILES, MIRROR_FILES, OFFLINE_MODEL,
  availabilityBySource, collectAll, createFixtureCollectors, createFixtureLlm, formatRunSummary, listPhotoInventory,
  parseArgs, priorWinners, resolveBudget, resolveNow, resolveOptions, rotateSerpQueries, runWeekly, selectStore,
  serpQueriesForWeek, unavailableSources, unusedPhotos,
} from '../run.mjs';
import { createFileStore } from '../lib/store.mjs';
import { loadFacts } from '../lib/facts.mjs';
import { LeaseHeld, ValidationFailed } from '../lib/errors.mjs';
import {
  AttemptSchema, ModelPlanSchema, ObservationSchema, PlanItemSchema, PlanSchema, RevisionSchema, SelectionSchema, parseOrIssues,
} from '../lib/schemas.mjs';
import { addDays, weekSpecForWeekOf } from '../lib/week-spec.mjs';
import { buildSerpQueries } from '../lib/collectors/serpapi.mjs';
import { POLICY_PATH, OUTPUTS_DIR, SHADOW_DIR, STATE_DIR } from '../lib/paths.mjs';
// Legacy parsers (supabase-sync.mjs guards its CLI with invokedDirectly; importing only reads .env).
import { parseFacebookSchedule, parseGbpSchedule, resolveWeekOf } from '../../supabase-sync.mjs';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..', '..', '..');
const RUN = path.join(here, '..', 'run.mjs');
const FIXTURES = DEFAULT_FIXTURES_DIR;
const LEGACY_DIR = path.join(FIXTURES, 'legacy');
const LEGACY_EMPTY_DIR = path.join(FIXTURES, 'legacy-empty');
const PLAN_PATH = path.join(FIXTURES, FIXTURE_FILES.plan);
const NOW = '2026-09-04T17:00:00.000Z';
const WEEK_OF = '2026-09-07';
const WEEK = weekSpecForWeekOf(WEEK_OF, new Date(NOW));
const POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const FACTS = loadFacts(path.join(FIXTURES, FIXTURE_FILES.facts));
const PHOTOS = JSON.parse(fs.readFileSync(path.join(FIXTURES, FIXTURE_FILES.photos), 'utf8'));
const GBP_DAYS = [1, 2, 3, 4, 5, 6, 7];
const FB_DAYS = [1, 3, 5, 6];

const tmpDirs = [];
function tmp(label = 'e2e') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `weekly-${label}-`));
  tmpDirs.push(dir);
  return dir;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function readLines(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); }
function clean(schema, value, label) {
  const { issues } = parseOrIssues(schema, value);
  assert.deepEqual(issues, [], `${label} should be schema-valid`);
}

/** In-process run with the machine env masked and the fixture facts. */
function run(options = {}, deps = {}) {
  const storeDir = options.storeDir || tmp('store');
  const outDir = options.outDir || path.join(tmp('out'), 'shadow');
  return runWeekly({ mode: 'offline', now: NOW, storeDir, outDir, ...options }, { env: {}, ...deps })
    .then((result) => Object.assign(result, { storeDir, outDir }));
}

/** An llm that answers with the canned plan mutated by `mutators[i]` on call i (last one repeats). */
function scriptedLlm(mutators) {
  const base = createFixtureLlm({ planPath: PLAN_PATH, model: 'scripted' });
  const labels = [];
  let n = 0;
  return {
    model: 'scripted',
    endpoint: 'scripted',
    labels,
    async chatJSON(args) {
      const reply = await base.chatJSON(args);
      labels.push(args.label);
      const mutate = mutators[Math.min(n, mutators.length - 1)];
      n += 1;
      if (!mutate) return reply;
      const plan = JSON.parse(reply.raw);
      mutate(plan);
      const { data, issues } = parseOrIssues(args.schema || ModelPlanSchema, plan);
      return { ...reply, data, issues, raw: JSON.stringify(plan) };
    },
  };
}
const badPhone = (plan) => { plan.gbp[0].body += ' Call (214) 555-0199 today.'; };

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network reachable from the e2e test'); };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('offline end to end (fixture collectors, canned plan, no network)', () => {
  let r;
  before(async () => {
    r = await run({ legacyDir: LEGACY_DIR });
  });

  it('finishes the attempt as succeeded with every stage ok and the lease released', () => {
    clean(AttemptSchema, r.attempt, 'attempt');
    assert.equal(r.attempt.status, 'succeeded');
    assert.equal(r.attempt.mode, 'offline');
    assert.equal(r.attempt.week_of, WEEK_OF);
    assert.equal(r.attempt.error, null);
    assert.equal(r.attempt.lease_until, null);
    assert.ok(r.attempt.finished_at);
    assert.deepEqual(
      Object.fromEntries(Object.entries(r.attempt.stages).map(([k, v]) => [k, v.status])),
      { collect: 'ok', select: 'ok', generate: 'ok', validate: 'ok', stage: 'ok', compare: 'ok' },
    );
    assert.equal(r.attempt.models.generate, OFFLINE_MODEL);
    assert.equal(r.attempt.versions.policy, POLICY.version);
    assert.match(r.attempt.versions.prompt, /^[0-9a-f]{12}$/);
    assert.equal(r.attempt.budget_usd, POLICY.budget_usd);
    assert.equal(r.attempt.spent_usd, 0);
    assert.equal(r.storeKind, 'file');
    assert.deepEqual(fs.readdirSync(path.join(r.storeDir, 'leases')), []);
    const stored = readJson(path.join(r.storeDir, 'attempts', `${r.attempt.id}.json`));
    assert.equal(stored.status, 'succeeded');
  });

  it('collects every fixture source and stores the observations', () => {
    assert.deepEqual(r.availability, {
      search_console: { ok: 10, unavailable: 0, error: 0 },
      facebook: { ok: 3, unavailable: 0, error: 0 },
      serpapi: { ok: 3, unavailable: 1, error: 0 },
      history: { ok: 12, unavailable: 0, error: 0 },
    });
    for (const obs of r.observations) {
      clean(ObservationSchema, obs, obs.id);
      assert.equal(obs.attempt_id, r.attempt.id);
      assert.equal(obs.retrieved_at, NOW);
    }
    const lines = readLines(path.join(r.storeDir, 'observations', `${r.attempt.id}.jsonl`));
    assert.equal(lines.length, r.observations.length);
    assert.equal(r.history.posts.length, 8);
    assert.equal(r.history.website_tasks.length, 2);
    assert.deepEqual(r.history.winners, []);
  });

  it('selects Panel Upgrade in Rockwall from the fixture signals (not degraded)', () => {
    clean(SelectionSchema, r.selection, 'selection');
    assert.equal(r.selection.degraded, false);
    assert.equal(r.selection.winner.service_key, 'panel_upgrade');
    assert.equal(r.selection.winner.city, 'Rockwall');
    assert.equal(r.selection.ranked.length, POLICY.services.length * POLICY.cities.length);
    assert.match(r.selection.rationale, /Winner: Electrical Panel Upgrade \/ Replacement in Rockwall/);
  });

  it('produces seven GBP items and four Facebook items carrying the WeekSpec dates', () => {
    clean(PlanSchema, r.plan, 'plan');
    assert.equal(r.plan.attempt_id, r.attempt.id);
    assert.equal(r.plan.week_of, WEEK_OF);
    assert.deepEqual(r.plan.topic, r.selection.winner && {
      service_key: r.selection.winner.service_key,
      service_label: r.selection.winner.service_label,
      city: r.selection.winner.city,
      query_family: r.selection.winner.query_family,
    });
    assert.deepEqual(r.plan.gbp.map((g) => g.day), GBP_DAYS);
    assert.deepEqual(r.plan.gbp.map((g) => g.date), GBP_DAYS.map((d) => WEEK.gbp_dates[d]));
    assert.deepEqual(r.plan.facebook.map((f) => f.day), FB_DAYS);
    assert.deepEqual(r.plan.facebook.map((f) => f.date), FB_DAYS.map((d) => WEEK.fb_dates[d]));
    for (const f of r.plan.facebook) {
      assert.equal(f.video_prompt, '');
      assert.match(f.contact, /\(469\) 896-3862/);
    }
    assert.equal(r.plan.notes.degraded, false);
    assert.equal(r.llmCalls, 1);
  });

  it('validates clean against the fixture facts, photos and history', () => {
    assert.deepEqual(r.validation, { ok: true, errors: [], warnings: [] });
  });

  it('stages one revision with 7 + 4 + website items in the store', () => {
    clean(RevisionSchema, r.revision, 'revision');
    assert.equal(r.revision.id, `${r.attempt.id}-r1`);
    assert.equal(r.revision.revision, 1);
    assert.equal(r.revision.validation.ok, true);
    assert.ok(r.revision.exported_at);
    assert.equal(r.revision.projected_at, null);
    const items = readLines(path.join(r.storeDir, 'items', `${r.revision.id}.jsonl`)).map((l) => JSON.parse(l));
    assert.equal(items.length, 7 + 4 + r.plan.website_actions.length);
    for (const item of items) clean(PlanItemSchema, item, item.id);
    assert.equal(items.filter((i) => i.platform === 'gbp').length, 7);
    assert.equal(items.filter((i) => i.platform === 'facebook').length, 4);
    assert.equal(fs.existsSync(path.join(r.storeDir, 'revisions', `${r.revision.id}.json`)), true);
  });

  it('writes every export, the mirror files and a summary into --out', () => {
    const expected = [
      'gbp_posting_schedule.md', 'facebook_posting_schedule.md', 'website_queue.md', 'plan.json', 'selection.json',
      'attempt.json', 'summary.md', MIRROR_FILES.revision, MIRROR_FILES.observations, MIRROR_FILES.meter, MIRROR_FILES.compare,
    ];
    for (const name of expected) assert.equal(fs.existsSync(path.join(r.outDir, name)), true, `${name} should exist`);
    assert.equal(Object.values(r.paths).length, expected.length);
    // The mirrored attempt is the final record, not the mid-run snapshot stage.mjs wrote.
    const mirrored = readJson(path.join(r.outDir, 'attempt.json'));
    assert.equal(mirrored.status, 'succeeded');
    assert.equal(mirrored.finished_at, r.attempt.finished_at);
    assert.equal(readJson(path.join(r.outDir, MIRROR_FILES.revision)).id, r.revision.id);
    assert.equal(readLines(path.join(r.outDir, MIRROR_FILES.observations)).length, r.observations.length);
    const meter = readJson(path.join(r.outDir, MIRROR_FILES.meter));
    assert.equal(meter.spent_usd, 0);
    assert.equal(meter.ceiling_usd, POLICY.budget_usd);
    assert.equal(meter.entries.length, 1);
    assert.equal(meter.entries[0].model, OFFLINE_MODEL);
    const summary = fs.readFileSync(path.join(r.outDir, 'summary.md'), 'utf8');
    assert.match(summary, new RegExp(`Week of ${WEEK_OF}`));
    assert.match(summary, /offline \/ succeeded/);
    assert.match(summary, /Electrical Panel Upgrade \/ Replacement/);
    assert.match(summary, /\| compare \| ok \|/);
    assert.equal(readJson(path.join(r.outDir, 'plan.json')).attempt_id, r.attempt.id);
  });

  it('round-trips the rendered schedules through the legacy supabase-sync parsers', () => {
    const gbpText = fs.readFileSync(path.join(r.outDir, 'gbp_posting_schedule.md'), 'utf8');
    const fbText = fs.readFileSync(path.join(r.outDir, 'facebook_posting_schedule.md'), 'utf8');
    const gbp = parseGbpSchedule(gbpText);
    assert.equal(gbp.length, 7);
    assert.deepEqual(gbp.map((row) => row.day), GBP_DAYS);
    assert.deepEqual(gbp.map((row) => row.post_date), GBP_DAYS.map((d) => WEEK.gbp_dates[d]));
    assert.ok(gbp.every((row) => row.platform === 'gbp'));
    const fb = parseFacebookSchedule(fbText);
    assert.equal(fb.length, 4);
    assert.deepEqual(fb.map((row) => row.day), FB_DAYS);
    assert.deepEqual(fb.map((row) => row.post_date), FB_DAYS.map((d) => WEEK.fb_dates[d]));
    assert.ok(fb.every((row) => row.platform === 'facebook'));
    assert.equal(resolveWeekOf({ argv: [], fbText }), WEEK_OF);
  });

  it('compares against the legacy fixture outputs (7 and 4 legacy rows, dates on spec)', () => {
    const report = fs.readFileSync(path.join(r.outDir, MIRROR_FILES.compare), 'utf8');
    assert.equal(report, r.compare);
    assert.match(report, /\| GBP \| 7 \| 7 \| 7 \|/);
    assert.match(report, /\| Facebook \| 4 \| 4 \| 4 \|/);
    assert.match(report, /Legacy: 0 of 11 slots off-spec/);
    assert.match(report, /Shadow: 0 of 11 slots off-spec/);
    assert.match(report, /### Shadow copy\s+_None\._/);
  });

  it('prints a one-screen summary naming the status, topic, counts and paths', () => {
    assert.equal(r.summary, formatRunSummary(r));
    assert.match(r.summary, /status succeeded/);
    assert.match(r.summary, /Electrical Panel Upgrade \/ Replacement in Rockwall/);
    assert.match(r.summary, /GBP 7, Facebook 4, website 1/);
    assert.match(r.summary, /validate {2}ok/);
    assert.match(r.summary, /compare ok/);
    assert.ok(r.summary.includes(path.join(r.outDir, 'summary.md')));
    assert.ok(r.summary.split('\n').length <= 30, 'fits one screen');
  });
});

// ---------------------------------------------------------------------------

describe('lease', () => {
  it('a second run for the same week while the lease is held fails with LeaseHeld and records the refusal', async () => {
    const storeDir = tmp('lease');
    const outDir = path.join(tmp('lease-out'), 'shadow');
    const store = createFileStore(storeDir);
    const held = await store.acquireLease({ week_of: WEEK_OF, attempt_id: 'other-holder', ttlMs: 60_000, now: new Date(NOW) });
    assert.equal(held.ok, true);
    await assert.rejects(
      run({ storeDir, outDir }),
      (e) => e instanceof LeaseHeld && e.holder === 'other-holder' && e.week_of === WEEK_OF && !e.attempt,
    );
    const attempts = fs.readdirSync(path.join(storeDir, 'attempts'));
    assert.equal(attempts.length, 1);
    const refused = readJson(path.join(storeDir, 'attempts', attempts[0]));
    assert.equal(refused.status, 'failed');
    assert.match(refused.error, /^LeaseHeld: week 2026-09-07 lease held by other-holder/);
    assert.equal(fs.existsSync(outDir), false, 'nothing is exported for a refused run');
    assert.equal((await store.releaseLease({ week_of: WEEK_OF, attempt_id: 'other-holder' })).ok, true);
    // With the lease gone the same store admits the run.
    const r = await run({ storeDir, outDir });
    assert.equal(r.attempt.status, 'succeeded');
  });
});

// ---------------------------------------------------------------------------

describe('degraded path (every collector unavailable)', () => {
  it('still produces a validated plan with notes.degraded=true and finishes as degraded', async () => {
    const fixturesDir = tmp('fixtures-degraded');
    for (const name of [FIXTURE_FILES.facts, FIXTURE_FILES.photos, FIXTURE_FILES.plan]) {
      fs.copyFileSync(path.join(FIXTURES, name), path.join(fixturesDir, name));
    }
    const r = await run({ fixturesDir, legacyDir: LEGACY_DIR });
    assert.equal(r.attempt.status, 'degraded');
    assert.equal(r.attempt.error, null);
    assert.deepEqual(unavailableSources(r.availability), [...COLLECTOR_NAMES]);
    assert.equal(r.observations.length, 5, 'one unavailable marker per source (history has two tables)');
    assert.ok(r.observations.every((o) => o.status === 'unavailable'));
    assert.equal(r.selection.degraded, true);
    assert.match(r.selection.rationale, /degraded selection/);
    assert.equal(r.plan.notes.degraded, true);
    assert.equal(typeof r.plan.notes.degraded_reason, 'string');
    assert.ok(r.plan.notes.degraded_reason.length > 0);
    assert.equal(r.validation.ok, true);
    assert.equal(r.plan.gbp.length, 7);
    assert.equal(r.plan.facebook.length, 4);
    assert.deepEqual(r.plan.topic.service_key, r.selection.winner.service_key);
    assert.equal(r.revision.validation.ok, true);
    assert.deepEqual(
      Object.fromEntries(Object.entries(r.attempt.stages).map(([k, v]) => [k, v.status])),
      { collect: 'ok', select: 'ok', generate: 'ok', validate: 'ok', stage: 'ok', compare: 'ok' },
    );
    assert.match(r.summary, /status degraded/);
    assert.match(r.summary, /\[degraded\]/);
    const summary = fs.readFileSync(path.join(r.outDir, 'summary.md'), 'utf8');
    assert.match(summary, /\*\*Degraded:\*\* yes/);
    const rendered = fs.readFileSync(path.join(r.outDir, 'gbp_posting_schedule.md'), 'utf8');
    assert.equal(parseGbpSchedule(rendered).length, 7);
  });

  it('a collector that throws becomes one unavailable observation instead of stopping the run', async () => {
    const collectors = createFixtureCollectors(FIXTURES);
    collectors.facebook = async () => { throw new Error('boom token=sk-secret-value'); };
    const collected = await collectAll(collectors, { attemptId: 'a1', now: new Date(NOW), retrievedAt: NOW, weekOf: WEEK_OF });
    const fb = collected.observations.filter((o) => o.source === 'facebook');
    assert.equal(fb.length, 1);
    assert.equal(fb[0].status, 'unavailable');
    assert.match(fb[0].note, /collector threw: Error: boom/);
    assert.doesNotMatch(fb[0].note, /sk-secret-value/);
    assert.equal(availabilityBySource(collected.observations).facebook.unavailable, 1);
    const r = await run({}, { collectors });
    assert.equal(r.attempt.status, 'degraded');
    assert.equal(r.selection.degraded, false, 'search sources were still there');
    assert.equal(r.plan.notes.degraded, false, 'the plan is only degraded when selection is');
    assert.deepEqual(unavailableSources(r.availability), ['facebook']);
  });

  it('collectAll drops a schema-invalid fixture row into an unavailable marker', async () => {
    const collectors = createFixtureCollectors(FIXTURES);
    collectors.serpapi = async () => [{ id: 'bad', source: 'serpapi' }];
    const collected = await collectAll(collectors, { attemptId: 'a1', now: new Date(NOW), retrievedAt: NOW, weekOf: WEEK_OF });
    const serp = collected.observations.filter((o) => o.source === 'serpapi');
    assert.equal(serp.length, 1);
    assert.equal(serp[0].status, 'unavailable');
    assert.match(serp[0].note, /observation dropped \(schema\)/);
    for (const obs of collected.observations) clean(ObservationSchema, obs, obs.id);
  });
});

// ---------------------------------------------------------------------------

describe('validation regeneration', () => {
  it('regenerates once with the errors appended and succeeds when the second plan is clean', async () => {
    const llm = scriptedLlm([badPhone, null]);
    const r = await run({}, { llm });
    assert.deepEqual(llm.labels, ['generate', 'generate']);
    assert.equal(r.llmCalls, 2);
    assert.equal(r.attempt.status, 'succeeded');
    assert.equal(r.validation.ok, true);
    assert.equal(r.attempt.stages.validate.status, 'ok');
    assert.doesNotMatch(r.plan.gbp[0].body, /555-0199/);
  });

  it('a plan that still fails is staged with validation.ok=false and the attempt fails with ValidationFailed', async () => {
    const llm = scriptedLlm([badPhone]);
    const storeDir = tmp('store-fail');
    const outDir = path.join(tmp('out-fail'), 'shadow');
    let error;
    await assert.rejects(run({ storeDir, outDir, legacyDir: LEGACY_DIR }, { llm }), (e) => { error = e; return e instanceof ValidationFailed; });
    assert.deepEqual(llm.labels, ['generate', 'generate']);
    assert.ok(error.errors.some((line) => /555-0199/.test(line)), 'the phone error is on the exception');
    const { attempt, result } = error;
    assert.equal(attempt.status, 'failed');
    assert.match(attempt.error, /^ValidationFailed: plan failed validation after one regeneration/);
    assert.equal(attempt.stages.validate.status, 'failed');
    assert.match(attempt.stages.validate.error, /ValidationFailed/);
    assert.equal(attempt.stages.stage.status, 'ok', 'the failed plan is still staged for inspection');
    assert.equal(attempt.stages.compare, undefined, 'compare never ran');
    assert.equal(attempt.lease_until, null);
    assert.deepEqual(fs.readdirSync(path.join(storeDir, 'leases')), []);
    assert.equal(result.validation.ok, false);
    assert.equal(result.revision.validation.ok, false);
    const stored = readJson(path.join(storeDir, 'revisions', `${result.revision.id}.json`));
    assert.equal(stored.validation.ok, false);
    assert.equal(readJson(path.join(outDir, 'attempt.json')).status, 'failed');
    assert.match(fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8'), /offline \/ failed/);
    assert.equal(fs.existsSync(path.join(outDir, MIRROR_FILES.compare)), false);
    assert.match(result.summary, /status failed/);
    assert.match(result.summary, /validate {2}FAILED — 1 error\(s\)/);
  });
});

// ---------------------------------------------------------------------------

describe('compare stage gating', () => {
  it('offline skips compare with no legacy dir and with an empty one', async () => {
    const none = await run({});
    assert.equal(none.attempt.stages.compare.status, 'skipped');
    assert.equal(none.compare, null);
    assert.equal(fs.existsSync(path.join(none.outDir, MIRROR_FILES.compare)), false);
    assert.equal(none.attempt.status, 'succeeded');
    const empty = await run({ legacyDir: LEGACY_EMPTY_DIR });
    assert.equal(empty.attempt.stages.compare.status, 'skipped');
    assert.equal(fs.existsSync(path.join(empty.outDir, MIRROR_FILES.compare)), false);
  });
});

// ---------------------------------------------------------------------------

describe('shadow mode plumbing (no network)', () => {
  it('falls back to the file store with a warning, lists photos from --photos-dir, mirrors and compares', async () => {
    const photosDir = tmp('photos');
    for (const name of [...PHOTOS, 'ev-charger-garage.jpg']) fs.writeFileSync(path.join(photosDir, name), '');
    fs.writeFileSync(path.join(photosDir, 'notes.txt'), 'not a photo');
    const warnings = [];
    const storeDir = tmp('shadow-store');
    const outDir = path.join(tmp('shadow-out'), 'shadow');
    const r = await runWeekly(
      { mode: 'shadow', now: NOW, storeDir, outDir, photosDir, legacyDir: LEGACY_DIR, warn: (m) => warnings.push(m) },
      { env: {}, collectors: createFixtureCollectors(FIXTURES), llm: createFixtureLlm({ planPath: PLAN_PATH }), facts: FACTS },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SUPABASE_URL \/ SUPABASE_SERVICE_KEY not set/);
    assert.doesNotMatch(warnings[0], /DEEPSEEK/);
    assert.equal(r.storeKind, 'file');
    assert.equal(r.attempt.mode, 'shadow');
    assert.equal(r.attempt.status, 'succeeded');
    assert.equal(r.validation.ok, true);
    assert.equal(r.attempt.stages.compare.status, 'ok');
    assert.equal(fs.existsSync(path.join(outDir, MIRROR_FILES.compare)), true);
    assert.equal(readJson(path.join(outDir, 'attempt.json')).status, 'succeeded');
    assert.equal(fs.existsSync(path.join(storeDir, 'revisions', `${r.revision.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(outDir, MIRROR_FILES.revision)), true);
    assert.deepEqual(listPhotoInventory({ dirs: [photosDir] }), [...PHOTOS, 'ev-charger-garage.jpg'].sort());
    assert.deepEqual(unusedPhotos(listPhotoInventory({ dirs: [photosDir] }), r.history), [...PHOTOS].sort());
  });

  it('shadow refuses to start without DEEPSEEK_API_KEY (no attempt, no files)', async () => {
    const storeDir = tmp('shadow-nokey');
    const outDir = path.join(tmp('shadow-nokey-out'), 'shadow');
    await assert.rejects(
      runWeekly({ mode: 'shadow', now: NOW, storeDir, outDir }, { env: {}, facts: FACTS }),
      /DEEPSEEK_API_KEY is not set/,
    );
    assert.equal(fs.existsSync(path.join(storeDir, 'attempts')), false);
    assert.equal(fs.existsSync(outDir), false);
  });

  it('selectStore picks Supabase only in shadow mode with both env vars (stub client, no calls)', () => {
    const stub = { from() { throw new Error('must not be called'); }, rpc() { throw new Error('must not be called'); } };
    const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key' };
    const warnings = [];
    const warn = (m) => warnings.push(m);
    const picked = selectStore({ mode: 'shadow', storeDir: 'x', env, deps: { supabase: stub }, warn });
    assert.equal(picked.kind, 'supabase');
    assert.equal(picked.store.kind, 'supabase');
    assert.equal(picked.supabase, stub);
    assert.equal(selectStore({ mode: 'offline', storeDir: tmp('sel'), env, deps: { supabase: stub }, warn }).kind, 'file');
    assert.equal(selectStore({ mode: 'shadow', storeDir: tmp('sel'), env: { SUPABASE_URL: 'x' }, warn }).kind, 'file');
    assert.equal(warnings.length, 1);
    const injected = { kind: 'mine' };
    assert.equal(selectStore({ mode: 'shadow', storeDir: 'x', env, deps: { store: injected }, warn }).store, injected);
    assert.equal(warnings.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('prior-week winners from stored revisions', () => {
  it('last week\'s staged topic is excluded this week and the plan follows the new winner', async () => {
    const storeDir = tmp('winners');
    const first = await run({ storeDir, now: '2026-08-28T17:00:00.000Z', outDir: path.join(tmp('w1'), 'shadow') });
    assert.equal(first.attempt.week_of, '2026-08-31');
    assert.equal(first.selection.winner.service_key, 'panel_upgrade');
    const winners = await priorWinners(createFileStore(storeDir), WEEK_OF);
    assert.deepEqual(winners, [{ week_of: '2026-08-31', topic: first.plan.topic }]);

    const second = await run({ storeDir, outDir: path.join(tmp('w2'), 'shadow') });
    assert.equal(second.attempt.week_of, WEEK_OF);
    assert.deepEqual(second.history.winners, winners);
    assert.notEqual(second.selection.winner.service_key, 'panel_upgrade');
    const excluded = second.selection.excluded.filter((e) => e.candidate.service_key === 'panel_upgrade');
    assert.ok(excluded.length > 0);
    assert.match(excluded[0].reason, /selected for week of 2026-08-31/);
    assert.equal(second.plan.topic.service_key, second.selection.winner.service_key);
    assert.equal(second.plan.topic.city, second.selection.winner.city);
    assert.equal(second.validation.ok, true);
    assert.ok(['succeeded', 'degraded'].includes(second.attempt.status));
    assert.deepEqual(fs.readdirSync(path.join(storeDir, 'leases')), []);
  });
});

// ---------------------------------------------------------------------------

describe('CLI (subprocess)', () => {
  it('exit 0 with the one-screen summary for --mode offline', async () => {
    const storeDir = tmp('cli-store');
    const outDir = path.join(tmp('cli-out'), 'shadow');
    const { stdout } = await execFileP(process.execPath, [
      RUN, '--mode', 'offline', '--now', NOW, '--store', storeDir, '--out', outDir, '--legacy-dir', LEGACY_DIR, '--budget-usd', '3',
    ], { cwd: PROJECT_ROOT, timeout: 60_000 });
    assert.match(stdout, /\[weekly\] attempt 2026-09-07-/);
    assert.match(stdout, /status succeeded/);
    assert.match(stdout, /of \$3\.00/);
    assert.match(stdout, /GBP 7, Facebook 4/);
    assert.ok(stdout.includes(path.join(outDir, 'compare.md')));
    assert.equal(fs.existsSync(path.join(outDir, 'summary.md')), true);
    assert.equal(fs.readdirSync(path.join(storeDir, 'attempts')).length, 1);
  });

  it('exit 2 on a usage error, 1 on a run error, 0 on --help', async () => {
    const usage = await execFileP(process.execPath, [RUN, '--bogus'], { cwd: PROJECT_ROOT, timeout: 60_000 }).catch((e) => e);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /unknown option --bogus/);
    const mode = await execFileP(process.execPath, [RUN, '--mode', 'nope'], { cwd: PROJECT_ROOT, timeout: 60_000 }).catch((e) => e);
    assert.equal(mode.code, 2);
    assert.match(mode.stderr, /--mode must be one of shadow, offline/);
    const monday = await execFileP(process.execPath, [RUN, '--mode', 'offline', '--week-of', '2026-09-08', '--store', tmp('cli-x'), '--out', tmp('cli-y')], { cwd: PROJECT_ROOT, timeout: 60_000 }).catch((e) => e);
    assert.equal(monday.code, 1);
    assert.match(monday.stderr, /--week-of must be a Monday/);
    const help = await execFileP(process.execPath, [RUN, '--help'], { cwd: PROJECT_ROOT, timeout: 60_000 });
    assert.match(help.stdout, /^usage: node scripts\/weekly\/run\.mjs/);
  });
});

// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('parseArgs reads value flags, --flag=value, booleans, and rejects junk', () => {
    assert.deepEqual(parseArgs(['--mode', 'offline', '--week-of=2026-09-07', '--budget-usd', '2.5', '--notify', '-h']),
      { mode: 'offline', weekOf: '2026-09-07', budgetUsd: 2.5, notify: true, help: true });
    assert.deepEqual(parseArgs([]), {});
    assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
    assert.throws(() => parseArgs(['--mode']), /--mode needs a value/);
    assert.throws(() => parseArgs(['--store', '--out', 'x']), /--store needs a value/);
    assert.throws(() => parseArgs(['--budget-usd', 'lots']), /non-negative number/);
  });

  it('resolveOptions applies the mode defaults and rejects an unknown mode', () => {
    const offline = resolveOptions({ mode: 'offline' });
    assert.equal(offline.storeDir, path.join(STATE_DIR, 'offline'));
    assert.equal(offline.outDir, path.join(SHADOW_DIR, 'offline'));
    assert.equal(offline.fixturesDir, FIXTURES);
    assert.equal(offline.legacyDir, null);
    const shadow = resolveOptions({ mode: 'shadow', legacyDir: 'legacy', photosDir: 'pics' });
    assert.equal(shadow.storeDir, STATE_DIR);
    assert.equal(shadow.outDir, SHADOW_DIR);
    assert.equal(shadow.legacyDir, path.resolve('legacy'));
    assert.equal(shadow.photosDir, path.resolve('pics'));
    assert.equal(resolveOptions({ mode: 'shadow' }).legacyDir, OUTPUTS_DIR);
    assert.throws(() => resolveOptions({ mode: 'new' }), /--mode must be one of shadow, offline/);
    assert.throws(() => resolveOptions({}), /got nothing/);
  });

  it('resolveNow and resolveBudget', () => {
    assert.equal(resolveNow(NOW).toISOString(), NOW);
    assert.equal(resolveNow(new Date(NOW)).toISOString(), NOW);
    assert.ok(resolveNow(undefined) instanceof Date);
    assert.throws(() => resolveNow('junk'), TypeError);
    assert.equal(resolveBudget({ budgetUsd: 1, env: { WEEKLY_BUDGET_USD: '7' }, policy: { budget_usd: 20 } }), 1);
    assert.equal(resolveBudget({ env: { WEEKLY_BUDGET_USD: '7' }, policy: { budget_usd: 20 } }), 7);
    assert.equal(resolveBudget({ env: { WEEKLY_BUDGET_USD: '' }, policy: { budget_usd: 20 } }), 20);
    assert.equal(resolveBudget({ env: {}, policy: {} }), 0);
    assert.throws(() => resolveBudget({ env: { WEEKLY_BUDGET_USD: 'x' } }), /non-negative number/);
  });

  it('rotateSerpQueries: deterministic per week, wraps, and covers the list over consecutive weeks', () => {
    const list = Array.from({ length: 7 }, (_, i) => ({ query: `q${i}` }));
    const a = rotateSerpQueries(list, '2026-09-07', 3);
    const b = rotateSerpQueries(list, '2026-09-14', 3);
    assert.equal(a.length, 3);
    assert.deepEqual(a, rotateSerpQueries(list, '2026-09-07', 3));
    assert.notDeepEqual(a, b);
    assert.deepEqual(rotateSerpQueries(list, '2026-09-07', 7), list);
    assert.deepEqual(rotateSerpQueries(list, '2026-09-07', 10), list);
    assert.deepEqual(rotateSerpQueries(list, '2026-09-07', 3, { rotate: false }), list);
    assert.deepEqual(rotateSerpQueries(list, '2026-09-07', 0), list);
    assert.deepEqual(rotateSerpQueries(null, '2026-09-07', 3), []);
    // Real policy: max_calls-sized slices cover every query within ceil(n / max_calls) weeks.
    const all = buildSerpQueries(POLICY);
    const size = POLICY.serp.max_calls;
    const weeks = Math.ceil(all.length / size);
    const seen = new Set();
    let week = WEEK_OF;
    for (let i = 0; i < weeks; i += 1) {
      const slice = serpQueriesForWeek(POLICY, week);
      assert.equal(slice.length, Math.min(size, all.length));
      for (const q of slice) seen.add(q.query);
      week = addDays(week, 7);
    }
    assert.equal(seen.size, all.length);
    assert.ok(all.length > size, 'the policy list is larger than one week of live calls');
  });

  it('availability helpers and unusedPhotos', () => {
    const obs = [
      { source: 'search_console', status: 'ok' }, { source: 'serpapi', status: 'unavailable' }, { source: 'serpapi', status: 'error' },
      { source: 'facebook', status: 'ok' }, { source: 'facebook', status: 'unavailable' }, { source: 'trends', status: 'ok' },
    ];
    const a = availabilityBySource(obs);
    assert.deepEqual(a.serpapi, { ok: 0, unavailable: 1, error: 1 });
    assert.deepEqual(a.facebook, { ok: 1, unavailable: 1, error: 0 });
    assert.deepEqual(a.history, { ok: 0, unavailable: 0, error: 0 });
    assert.deepEqual(unavailableSources(a), ['serpapi']);
    assert.deepEqual(unusedPhotos(['A.jpg', 'b.jpg', 'c.jpg'], { posts: [{ photo_file: 'C:\\photos\\a.JPG' }, { photo_file: null }] }), ['b.jpg', 'c.jpg']);
    assert.deepEqual(unusedPhotos(['a.jpg'], null), ['a.jpg']);
  });

  it('the fixture LLM copies the winner into topic and meters a zero-cost call', async () => {
    const entries = [];
    const meter = { record: (e) => entries.push(e) };
    const llm = createFixtureLlm({ planPath: PLAN_PATH, meter });
    const winner = { service_key: 'generator', service_label: 'Generator Inlet, Interlock & Installation', city: 'Wylie', query_family: ['x'] };
    const reply = await llm.chatJSON({ user: { topic: { winner, degraded: false } }, schema: ModelPlanSchema, label: 'generate' });
    assert.deepEqual(reply.issues, []);
    assert.deepEqual(reply.data.topic, winner);
    assert.equal(reply.data.notes.degraded, false);
    assert.equal(reply.model, OFFLINE_MODEL);
    assert.deepEqual(entries, [{ kind: 'llm', model: OFFLINE_MODEL, inputTokens: 0, outputTokens: 0, usd: 0, label: 'generate' }]);
    const repair = await llm.chatJSON({ user: { original_request: { topic: { winner, degraded: true } } }, schema: ModelPlanSchema, label: 'generate-repair' });
    assert.deepEqual(repair.data.topic, winner);
    assert.equal(repair.data.notes.degraded, true);
    assert.equal(llm.calls.length, 2);
  });

  it('every e2e fixture is schema-valid', () => {
    for (const name of ['search_console', 'facebook', 'serpapi']) {
      const rows = readJson(path.join(FIXTURES, FIXTURE_FILES[name]));
      assert.ok(Array.isArray(rows) && rows.length > 0, `${name} fixture has rows`);
      for (const row of rows) {
        clean(ObservationSchema, { ...row, attempt_id: 'a', retrieved_at: NOW }, `${name}:${row.id}`);
        assert.equal(row.source, name);
      }
    }
    const history = readJson(path.join(FIXTURES, FIXTURE_FILES.history));
    assert.ok(history.posts.length >= 5 && history.website_tasks.length >= 1);
    clean(ModelPlanSchema, readJson(PLAN_PATH), 'model-plan');
    assert.ok(Array.isArray(PHOTOS) && PHOTOS.length >= 6);
    for (const name of ['gbp_posting_schedule.md', 'facebook_posting_schedule.md']) {
      assert.equal(fs.existsSync(path.join(LEGACY_DIR, name)), true);
    }
    assert.deepEqual(fs.readdirSync(LEGACY_EMPTY_DIR).filter((n) => n !== '.gitkeep'), []);
    assert.equal(FACTS.founded_year, 2021);
  });
});
