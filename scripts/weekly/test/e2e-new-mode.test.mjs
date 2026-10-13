// scripts/weekly/test/e2e-new-mode.test.mjs
// Phase C (cutover) guards for `--mode new`: the live chain against a fake
// store and an in-memory Supabase fake, with no network. Proves the contract
// the publishers depend on (7 GBP + 4 Facebook weekly_posts rows and the
// website_tasks rows, week_of = the WeekSpec Monday, status per
// SEO_AUTO_APPROVE), that the legacy schedule files land under --out in the
// exact legacy format (parsed with the legacy parsers themselves), that `new`
// never falls back to the file store, and that the T1 notify receipt is
// written to the attempt record in both shadow and new (V2).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FIXTURES_DIR, FIXTURE_FILES, LIVE_MODES, MIRROR_FILES, MODES, NOTIFY_MODES, StoreRefused,
  SUPABASE_REQUIRED_MODES, createFixtureCollectors, createFixtureLlm, main, resolveOptions, runWeekly, selectStore,
} from '../run.mjs';
import { createFileStore } from '../lib/store.mjs';
import { loadFacts } from '../lib/facts.mjs';
import { DEFAULT_EXPORT_DIRS, EXPORT_FILES, EXPORT_MODES, failedExportDir } from '../lib/stage.mjs';
import { formatAttemptMessage } from '../lib/notify.mjs';
import { weekSpecForWeekOf } from '../lib/week-spec.mjs';
import { OUTPUTS_DIR, PROJECT_ROOT, SHADOW_DIR } from '../lib/paths.mjs';
// Legacy consumers of the exported schedules. Every one guards its CLI with an
// invokedDirectly check; importing only defines functions (supabase-sync and
// facebook-poster read .env into process.env, nothing else).
import { parseFacebookSchedule, parseGbpSchedule, resolveWeekOf } from '../../supabase-sync.mjs';
import { parseGbpScheduleMarkdown } from '../../sync-gbp-schedule.mjs';
import { parseScheduleText } from '../../facebook-poster.mjs';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(here, '..', 'run.mjs');
const FIXTURES = DEFAULT_FIXTURES_DIR;
const PLAN_PATH = path.join(FIXTURES, FIXTURE_FILES.plan);
const NOW = '2026-09-04T17:00:00.000Z';
const WEEK_OF = '2026-09-07';
const WEEK = weekSpecForWeekOf(WEEK_OF, new Date(NOW));
const FACTS = loadFacts(path.join(FIXTURES, FIXTURE_FILES.facts));
const PHOTOS = JSON.parse(fs.readFileSync(path.join(FIXTURES, FIXTURE_FILES.photos), 'utf8'));
const GBP_DAYS = [1, 2, 3, 4, 5, 6, 7];
const FB_DAYS = [1, 3, 5, 6];
const GBP_DATES = GBP_DAYS.map((d) => WEEK.gbp_dates[d]);
const FB_DATES = FB_DAYS.map((d) => WEEK.fb_dates[d]);

const tmpDirs = [];
function tmp(label = 'new') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `weekly-${label}-`));
  tmpDirs.push(dir);
  return dir;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network reachable from the new-mode e2e test'); };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * An in-memory Supabase fake with real tables, enough for projectPlan and the
 * legacy autoApproveRun compare-and-set: insert/upsert/update/delete/select
 * with `eq` filters, `select().single()/maybeSingle()`, and `onConflict`
 * upserts. Every call is recorded; `rpc` is refused (the store is injected).
 */
function memorySupabase() {
  const tables = { seo_runs: [], weekly_posts: [], website_tasks: [], plan_items: [], plan_revisions: [] };
  const calls = [];
  let nextId = 1;
  function builder(table) {
    const ops = [];
    const chain = { table, ops };
    const api = {};
    for (const op of ['insert', 'upsert', 'select', 'update', 'delete', 'eq', 'in', 'not', 'order', 'limit']) {
      api[op] = (...args) => { ops.push([op, ...args]); return api; };
    }
    function exec() {
      calls.push(chain);
      if (!tables[table]) tables[table] = [];
      const rows = tables[table];
      const filters = ops.filter((o) => o[0] === 'eq').map((o) => (r) => String(r[o[1]]) === String(o[2]));
      const match = (r) => filters.every((f) => f(r));
      const [first, arg, extra] = ops[0];
      if (first === 'upsert') {
        const conflict = extra && extra.onConflict;
        let row = conflict ? rows.find((r) => r[conflict] === arg[conflict]) : null;
        if (row) Object.assign(row, arg);
        else { row = { id: `${table}-${nextId++}`, ...arg }; rows.push(row); }
        return { data: [row], error: null };
      }
      if (first === 'insert') {
        const list = (Array.isArray(arg) ? arg : [arg]).map((r) => ({ id: `${table}-${nextId++}`, ...r }));
        rows.push(...list);
        return { data: list, error: null };
      }
      if (first === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, arg);
        return { data: hit, error: null };
      }
      if (first === 'delete') {
        tables[table] = rows.filter((r) => !match(r));
        return { data: null, error: null };
      }
      return { data: rows.filter(match), error: null };
    }
    const single = async () => { const r = exec(); return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }; };
    api.single = single;
    api.maybeSingle = single;
    api.then = (resolve, reject) => Promise.resolve().then(exec).then(resolve, reject);
    return api;
  }
  return { tables, calls, from: (t) => builder(t), rpc() { throw new Error('rpc must not be reached with an injected store'); } };
}

/** A new-mode run against the file store (injected) with every write to Supabase caught by the fake. */
function runNew({ env = {}, options = {}, deps = {} } = {}) {
  const storeDir = options.storeDir || tmp('store');
  const outDir = options.outDir || tmp('out');
  const supabase = deps.supabase || memorySupabase();
  const warnings = [];
  const logs = [];
  return runWeekly(
    { mode: 'new', now: NOW, storeDir, outDir, legacyDir: null, log: (m) => logs.push(m), warn: (m) => warnings.push(m), ...options },
    {
      env, store: createFileStore(storeDir), supabase, collectors: createFixtureCollectors(FIXTURES),
      llm: createFixtureLlm({ planPath: PLAN_PATH }), facts: FACTS, photos: PHOTOS, ...deps,
    },
  ).then((result) => Object.assign(result, { storeDir, outDir, supabase, warnings, logs }));
}

// ---------------------------------------------------------------------------

describe('--mode new: projection into the publisher tables (fake store, no network)', () => {
  let r;
  before(async () => { r = await runNew(); });

  it('finishes succeeded with the project stage ok and nothing warned', () => {
    assert.equal(r.attempt.mode, 'new');
    assert.equal(r.attempt.status, 'succeeded');
    assert.equal(r.attempt.week_of, WEEK_OF);
    assert.equal(r.storeKind, 'injected');
    assert.deepEqual(
      Object.fromEntries(Object.entries(r.attempt.stages).map(([k, v]) => [k, v.status])),
      { preflight: 'ok', collect: 'ok', select: 'ok', generate: 'ok', validate: 'ok', stage: 'ok', project: 'ok', compare: 'skipped' },
    );
    assert.deepEqual(r.warnings, []);
    assert.equal(r.attempt.budget_usd, 5, 'config/weekly-policy.json budget_usd is the new-mode default');
  });

  it('writes exactly 7 GBP + 4 Facebook weekly_posts rows and the website_tasks rows for one seo_runs week', () => {
    const { seo_runs, weekly_posts, website_tasks } = r.supabase.tables;
    assert.equal(seo_runs.length, 1);
    assert.equal(seo_runs[0].week_of, WEEK_OF, 'seo_runs.week_of is the WeekSpec Monday');
    const runId = seo_runs[0].id;
    const gbp = weekly_posts.filter((p) => p.platform === 'gbp');
    const fb = weekly_posts.filter((p) => p.platform === 'facebook');
    assert.equal(gbp.length, 7);
    assert.equal(fb.length, 4);
    assert.equal(weekly_posts.length, 11);
    assert.ok(weekly_posts.every((p) => p.run_id === runId));
    assert.deepEqual(gbp.map((p) => p.post_date), GBP_DATES, 'GBP post_date follows gbp_dates 1..7');
    assert.deepEqual(fb.map((p) => p.post_date), FB_DATES, 'Facebook post_date follows fb_dates 1,3,5,6');
    assert.deepEqual(fb.map((p) => p.day), FB_DAYS);
    assert.equal(website_tasks.length, r.plan.website_actions.length);
    assert.ok(website_tasks.length >= 1, 'the fixture plan carries at least one website action');
    assert.ok(website_tasks.every((t) => t.run_id === runId && t.details.source === 'weekly' && t.details.revision_id === r.revision.id));
  });

  it('leaves every row pending_approval when SEO_AUTO_APPROVE is unset and never calls auto-approve', () => {
    const { seo_runs, weekly_posts, website_tasks } = r.supabase.tables;
    assert.equal(seo_runs[0].status, 'pending_approval');
    assert.ok(weekly_posts.every((p) => p.status === 'pending_approval'));
    assert.ok(website_tasks.every((t) => ['pending_approval', 'waiting_on_owner'].includes(t.status)));
    assert.equal(r.projection.auto_approve, false);
    assert.equal(r.projection.approved, null);
    assert.ok(!r.supabase.calls.some((c) => c.table === 'weekly_posts' && c.ops[0][0] === 'update'), 'no approval update was issued');
  });

  it('records the projection on the attempt mirror and links the revision', () => {
    assert.deepEqual({ runId: r.projection.runId, posts: r.projection.posts, tasks: r.projection.tasks, linked: r.projection.linked },
      { runId: r.supabase.tables.seo_runs[0].id, posts: 11, tasks: r.plan.website_actions.length, linked: 11 + r.plan.website_actions.length });
    assert.equal(r.projection.attempt_id, r.attempt.id);
    assert.equal(r.projection.revision_id, r.revision.id);
    assert.equal(r.projection.week_of, WEEK_OF);
    assert.ok(r.revision.projected_at, 'stagePlan returns the revision stamped projected_at');
    const file = path.join(r.outDir, MIRROR_FILES.projection);
    assert.equal(r.paths.projection, file);
    assert.equal(readJson(file).runId, r.projection.runId);
    const links = r.supabase.calls.filter((c) => c.table === 'plan_items' && c.ops[0][0] === 'update');
    assert.equal(links.length, 11 + r.plan.website_actions.length, 'every plan item is linked to its projected row');
    assert.ok(r.supabase.calls.some((c) => c.table === 'plan_revisions' && c.ops[0][0] === 'update' && c.ops[0][1].projected_at));
    assert.ok(r.logs.some((m) => /^project: seo_runs .* 11 post\(s\)/.test(m)), r.logs.join('\n'));
  });

  it('exports both legacy schedule files under --out and they parse with the legacy parsers', () => {
    const gbpFile = path.join(r.outDir, EXPORT_FILES.gbp);
    const fbFile = path.join(r.outDir, EXPORT_FILES.facebook);
    for (const name of Object.values(EXPORT_FILES)) assert.equal(fs.existsSync(path.join(r.outDir, name)), true, name);
    assert.equal(fs.existsSync(path.join(SHADOW_DIR, EXPORT_FILES.gbp)) && r.outDir === SHADOW_DIR, false, 'not written to outputs/shadow');
    const gbpText = fs.readFileSync(gbpFile, 'utf8');
    const fbText = fs.readFileSync(fbFile, 'utf8');
    // supabase-sync.mjs (the legacy projection) — same rows the new projection wrote.
    const gbpRows = parseGbpSchedule(gbpText);
    assert.equal(gbpRows.length, 7);
    assert.deepEqual(gbpRows.map((p) => p.post_date), GBP_DATES);
    assert.ok(gbpRows.every((p) => p.platform === 'gbp'));
    const fbRows = parseFacebookSchedule(fbText);
    assert.equal(fbRows.length, 4);
    assert.deepEqual(fbRows.map((p) => p.day), FB_DAYS);
    assert.deepEqual(fbRows.map((p) => p.post_date), FB_DATES);
    assert.equal(resolveWeekOf({ argv: [], fbText }), WEEK_OF, 'the FB header carries the ISO week_of the sync needs');
    // sync-gbp-schedule.mjs (workbook sync) and facebook-poster.mjs (the poster).
    const workbookRows = parseGbpScheduleMarkdown(gbpText);
    assert.equal(workbookRows.length, 7);
    assert.deepEqual(workbookRows.map((p) => p.date), GBP_DATES);
    assert.ok(workbookRows.every((p) => p.headline && p.body && p.status));
    const posterRows = parseScheduleText(fbText);
    assert.equal(posterRows.length, 4);
    assert.deepEqual(posterRows.map((p) => p.day), FB_DAYS);
    assert.deepEqual(posterRows.map((p) => p.hook), r.plan.facebook.map((p) => p.hook));
    // The DB rows and the Markdown rows describe the same posts.
    const dbHooks = r.supabase.tables.weekly_posts.filter((p) => p.platform === 'facebook').map((p) => p.hook);
    assert.deepEqual(fbRows.map((p) => p.hook), dbHooks);
  });

  it('a second new-mode run for the same week replaces the pending rows instead of duplicating them', async () => {
    const again = await runNew({ deps: { supabase: r.supabase }, options: { storeDir: r.storeDir, outDir: r.outDir } });
    assert.equal(again.attempt.status, 'succeeded');
    assert.equal(again.supabase.tables.seo_runs.length, 1, 'seo_runs upsert on week_of');
    assert.equal(again.supabase.tables.weekly_posts.length, 11);
    assert.equal(again.supabase.tables.website_tasks.length, r.plan.website_actions.length);
    assert.equal(again.revision.revision, 2);
  });
});

describe('--mode new: SEO_AUTO_APPROVE=1', () => {
  it('approves the posts and the run through the legacy compare-and-set and reports it in the alert', async () => {
    const r = await runNew({ env: { SEO_AUTO_APPROVE: '1' } });
    assert.equal(r.attempt.status, 'succeeded');
    const { seo_runs, weekly_posts } = r.supabase.tables;
    assert.equal(seo_runs[0].status, 'approved');
    assert.ok(seo_runs[0].approved_at);
    assert.equal(weekly_posts.length, 11);
    assert.ok(weekly_posts.every((p) => p.status === 'approved' && p.approved_at));
    assert.equal(r.projection.auto_approve, true);
    assert.deepEqual(r.projection.approved, { ok: true, count: 11 });
    const message = formatAttemptMessage({ attempt: r.attempt, event: 'succeeded', plan: r.plan, validation: r.validation, projection: r.projection });
    assert.match(message, /Projected: 11 post\(s\) \+ \d+ task\(s\) → seo_runs .*auto-approved \(11 post\(s\)\)/);
    assert.doesNotMatch(message, /Shadow mode/);
  });

  it('any other value leaves the week at the MCC gate', async () => {
    const r = await runNew({ env: { SEO_AUTO_APPROVE: 'true' } });
    assert.equal(r.supabase.tables.seo_runs[0].status, 'pending_approval');
    assert.equal(r.projection.auto_approve, false);
    const message = formatAttemptMessage({ attempt: r.attempt, event: 'succeeded', plan: r.plan, projection: r.projection });
    assert.match(message, /pending approval in MCC/);
  });
});

describe('--mode new: a projection failure is a failed attempt, never a silent stage', () => {
  it('marks the project stage failed, fails the attempt, and projects nothing twice', async () => {
    const supabase = memorySupabase();
    const broken = {
      ...supabase,
      from(table) {
        if (table === 'weekly_posts') {
          const api = supabase.from(table);
          const origThen = api.then;
          api.then = (resolve, reject) => Promise.resolve({ data: null, error: { message: 'insert refused (test)' } }).then(resolve, reject);
          api.select = () => api;
          void origThen;
          return api;
        }
        return supabase.from(table);
      },
    };
    const outDir = tmp('out-fail');
    const err = await runNew({ deps: { supabase: broken }, options: { outDir } }).catch((e) => e);
    assert.ok(err instanceof Error);
    // The fake refuses every weekly_posts write; the first one projectPlan issues is the pending-row delete.
    assert.match(err.message, /weekly_posts (delete pending|insert): insert refused \(test\)/);
    assert.equal(err.attempt.status, 'failed');
    assert.equal(err.attempt.stages.project.status, 'failed');
    assert.match(err.attempt.stages.project.error, /weekly_posts (delete pending|insert)/);
    assert.equal(supabase.tables.weekly_posts.length, 0, 'nothing reached weekly_posts');
    assert.equal(err.attempt.stages.stage.status, 'failed');
    assert.equal(fs.existsSync(path.join(outDir, MIRROR_FILES.projection)), false, 'no projection.json for a failed projection');
    // V5: nothing of this attempt reaches the export dir; the artifacts are kept under shadow/failed-<attempt>/.
    const failedDir = failedExportDir(outDir, err.attempt.id);
    for (const name of [EXPORT_FILES.gbp, EXPORT_FILES.facebook, EXPORT_FILES.website, EXPORT_FILES.plan, EXPORT_FILES.selection, EXPORT_FILES.summary]) {
      assert.equal(fs.existsSync(path.join(outDir, name)), false, `${name} must not be in the export dir`);
      assert.ok(fs.existsSync(path.join(failedDir, name)), `${name} kept under ${failedDir}`);
    }
    assert.equal(fs.readdirSync(outDir).some((n) => n.endsWith('_posting_schedule.md')), false, 'no *_posting_schedule.md in the out dir');
    assert.ok(fs.existsSync(path.join(outDir, 'attempt.json')), 'attempt.json mirror stays in --out for the wrapper health derivation');
    assert.ok(fs.existsSync(path.join(failedDir, MIRROR_FILES.meter)), 'meter mirrored into the failed dir');
    assert.equal(err.result.paths.plan, path.join(failedDir, EXPORT_FILES.plan));
  });
});

describe('--mode new: store selection', () => {
  it('refuses to run without Supabase configuration — StoreRefused, exit code 2, no attempt, no files', async () => {
    const storeDir = tmp('refuse-store');
    const outDir = tmp('refuse-out');
    const err = await runWeekly(
      { mode: 'new', now: NOW, storeDir, outDir },
      { env: { DEEPSEEK_API_KEY: 'present-but-irrelevant' }, facts: FACTS, llm: createFixtureLlm({ planPath: PLAN_PATH }) },
    ).catch((e) => e);
    assert.ok(err instanceof StoreRefused, String(err));
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /--mode new requires the Supabase store/);
    assert.equal(fs.existsSync(path.join(storeDir, 'attempts')), false);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it('selectStore: new never yields the file store; shadow keeps its warned fallback', () => {
    const stub = { from() { throw new Error('must not be called'); }, rpc() { throw new Error('must not be called'); } };
    const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key' };
    const warnings = [];
    const warn = (m) => warnings.push(m);
    const picked = selectStore({ mode: 'new', storeDir: 'x', env, deps: { supabase: stub }, warn });
    assert.equal(picked.kind, 'supabase');
    assert.equal(picked.supabase, stub);
    for (const partial of [{}, { SUPABASE_URL: 'x' }, { SUPABASE_SERVICE_KEY: 'y' }, { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' }]) {
      assert.throws(() => selectStore({ mode: 'new', storeDir: tmp('sel'), env: partial, warn }), StoreRefused);
    }
    assert.equal(warnings.length, 0, 'a refusal is thrown, not warned');
    assert.equal(selectStore({ mode: 'shadow', storeDir: tmp('sel'), env: {}, warn }).kind, 'file');
    assert.equal(warnings.length, 1);
    assert.deepEqual([...MODES], ['shadow', 'new', 'offline']);
    assert.deepEqual([...LIVE_MODES], ['shadow', 'new']);
    assert.deepEqual([...NOTIFY_MODES], ['shadow', 'new']);
    assert.deepEqual([...SUPABASE_REQUIRED_MODES], ['new']);
    assert.deepEqual([...EXPORT_MODES], ['shadow', 'new', 'offline']);
  });

  it('resolveOptions: new exports to outputs/ by default, compares against nothing, honours --out', () => {
    const opts = resolveOptions({ mode: 'new' });
    assert.equal(opts.outDir, OUTPUTS_DIR);
    assert.equal(DEFAULT_EXPORT_DIRS.new, OUTPUTS_DIR);
    assert.equal(opts.legacyDir, null);
    assert.equal(opts.notify, false);
    assert.equal(resolveOptions({ mode: 'new', outDir: 'elsewhere' }).outDir, path.resolve('elsewhere'));
    assert.equal(resolveOptions({ mode: 'new', legacyDir: 'legacy' }).legacyDir, path.resolve('legacy'));
    assert.equal(resolveOptions({ mode: 'shadow' }).outDir, SHADOW_DIR);
  });

  // A subprocess inherits the real environment and run.mjs loads .env, so this
  // case runs only where neither can supply Supabase credentials: a refused
  // run must never be a live one by accident.
  const liveEnvPossible = fs.existsSync(path.join(PROJECT_ROOT, '.env')) || Boolean(process.env.SUPABASE_URL);
  it('CLI: exit 2 with the refusal when Supabase is not configured', { skip: liveEnvPossible && 'a .env or SUPABASE_URL is present; the subprocess could reach a live store' }, async () => {
    const storeDir = tmp('cli-store');
    const outDir = tmp('cli-out');
    const env = { ...process.env, DEEPSEEK_API_KEY: 'present-but-irrelevant' };
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_KEY;
    const r = await execFileP(process.execPath, [RUN, '--mode', 'new', '--now', NOW, '--store', storeDir, '--out', outDir], { cwd: PROJECT_ROOT, timeout: 60_000, env }).catch((e) => e);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\[weekly\] refused: SUPABASE_URL \/ SUPABASE_SERVICE_KEY not set; --mode new requires the Supabase store/);
    assert.equal(fs.existsSync(path.join(storeDir, 'attempts')), false);
    assert.deepEqual(fs.readdirSync(outDir), []);
  });

  it('main() maps StoreRefused to exit 2 in-process', { skip: liveEnvPossible && 'a .env or SUPABASE_URL is present' }, async () => {
    const saved = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.DEEPSEEK_API_KEY = 'present-but-irrelevant';
    const errors = [];
    const origError = console.error;
    console.error = (m) => errors.push(String(m));
    try {
      const code = await main(['--mode', 'new', '--now', NOW, '--store', tmp('main-store'), '--out', tmp('main-out')]);
      assert.equal(code, 2);
      assert.ok(errors.some((m) => /requires the Supabase store/.test(m)), errors.join('\n'));
    } finally {
      console.error = origError;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

// ---------------------------------------------------------------------------

describe('V2: the notify receipt lands on the attempt record (shadow and new)', () => {
  const transportsOk = { hermes: async () => ({ ok: true }), smtp: async () => ({ ok: false, reason: 'smtp not configured' }) };
  const transportsDead = { hermes: async () => { throw new Error('hermes cli missing'); }, smtp: async () => { throw new Error('smtp auth failed'); } };

  for (const mode of NOTIFY_MODES) {
    it(`${mode}: a stubbed send yields sent=true with a channel, written as notify:<event> on the stored and mirrored attempt`, async () => {
      const storeDir = tmp(`${mode}-notify-store`);
      const outDir = tmp(`${mode}-notify-out`);
      const r = await runWeekly(
        { mode, now: NOW, storeDir, outDir, legacyDir: null, notify: true },
        {
          env: {}, store: createFileStore(storeDir), supabase: memorySupabase(), collectors: createFixtureCollectors(FIXTURES),
          llm: createFixtureLlm({ planPath: PLAN_PATH }), facts: FACTS, photos: PHOTOS, notifyTransports: transportsOk,
        },
      );
      assert.equal(r.attempt.status, 'succeeded');
      assert.deepEqual(r.notify, { sent: true, channel: 'hermes', reason: '' });
      const receipt = r.attempt.stages['notify:succeeded'];
      assert.equal(receipt.status, 'ok');
      assert.equal(receipt.error, 'via hermes', 'the channel rides in the receipt error field (what the wrapper parses)');
      assert.ok(receipt.started_at && receipt.finished_at);
      // Both copies the wrapper reads (attempt_records): the store record and the --out mirror.
      assert.equal(readJson(path.join(storeDir, 'attempts', `${r.attempt.id}.json`)).stages['notify:succeeded'].status, 'ok');
      assert.deepEqual(readJson(path.join(outDir, EXPORT_FILES.attempt)).stages['notify:succeeded'], receipt);
    });
  }

  it('a failed send yields sent=false with the reason, the receipt reads failed, and the run still resolves', async () => {
    const storeDir = tmp('dead-notify-store');
    const outDir = tmp('dead-notify-out');
    const warnings = [];
    const r = await runWeekly(
      { mode: 'new', now: NOW, storeDir, outDir, legacyDir: null, notify: true, warn: (m) => warnings.push(m) },
      {
        env: {}, store: createFileStore(storeDir), supabase: memorySupabase(), collectors: createFixtureCollectors(FIXTURES),
        llm: createFixtureLlm({ planPath: PLAN_PATH }), facts: FACTS, photos: PHOTOS, notifyTransports: transportsDead,
      },
    );
    assert.equal(r.attempt.status, 'succeeded', 'an undelivered alert never changes the attempt status');
    assert.equal(r.notify.sent, false);
    assert.equal(r.notify.channel, 'none');
    assert.match(r.notify.reason, /hermes: hermes cli missing/);
    const receipt = r.attempt.stages['notify:succeeded'];
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.error, /hermes cli missing/);
    assert.equal(readJson(path.join(outDir, EXPORT_FILES.attempt)).stages['notify:succeeded'].status, 'failed');
    assert.deepEqual(warnings, []);
  });

  it('offline never notifies, even with --notify', async () => {
    let sends = 0;
    const storeDir = tmp('offline-notify-store');
    const r = await runWeekly(
      { mode: 'offline', now: NOW, storeDir, outDir: tmp('offline-notify-out'), notify: true },
      { env: {}, notifyTransports: { hermes: async () => { sends += 1; return { ok: true }; }, smtp: async () => { sends += 1; return { ok: true }; } } },
    );
    assert.equal(sends, 0);
    assert.equal(r.notify, null);
    assert.equal('notify:succeeded' in r.attempt.stages, false);
  });
});
