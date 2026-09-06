#!/usr/bin/env node
/**
 * run.mjs — orchestrator CLI for the weekly content pipeline (scripts/weekly).
 *
 *   node scripts/weekly/run.mjs --mode shadow|offline [--week-of YYYY-MM-DD] [--now ISO]
 *        [--store <dir>] [--out <dir>] [--budget-usd N] [--fixtures <dir>]
 *        [--legacy-dir <dir>] [--photos-dir <dir>] [--notify]
 *
 * Order (DESIGN.md, "integrator"): attempt → collect (every collector in parallel
 * with Promise.allSettled) → select → generate → validate (one regeneration with
 * the errors appended, then fail) → stage → compare (shadow, when legacy outputs
 * exist) → finish. Every stage is wrapped with stageStart/stageEnd; any throw
 * marks the attempt failed and exits 1; unavailable collectors degrade the run
 * instead of stopping it. Exit 0 on `succeeded` or `degraded`.
 *
 * `offline` runs the whole chain with no network: fixture collectors and a fake
 * LLM that answers with a canned ModelPlan (test/fixtures/e2e). `shadow` runs the
 * live collectors and DeepSeek, stores to Supabase when SUPABASE_URL and
 * SUPABASE_SERVICE_KEY are set (else the file store, with a warning) and always
 * mirrors the attempt, revision, observations and summary into --out. Nothing
 * here writes weekly_posts or website_tasks.
 *
 * `runWeekly(options, deps)` is the library entry the e2e test drives in-process;
 * `main()` only runs when this file is the entry point.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';
import { FACTS_PATH, OUTPUTS_DIR, POLICY_PATH, SHADOW_DIR, STATE_DIR } from './lib/paths.mjs';
import { LeaseHeld, ValidationFailed } from './lib/errors.mjs';
import { ModelPlanSchema, ObservationSchema, SCHEMA_VERSION, parseOrIssues } from './lib/schemas.mjs';
import { addDays, computeWeekSpec, parseDate, weekSpecForWeekOf } from './lib/week-spec.mjs';
import { createCostMeter } from './lib/cost-meter.mjs';
import { createLlmClient } from './lib/llm.mjs';
import { loadFacts } from './lib/facts.mjs';
import { createFileStore } from './lib/store.mjs';
import { createSupabaseStore } from './lib/store-supabase.mjs';
import { createAttempt, errorText, finishAttempt, readGitSha, stageEnd, stageStart } from './lib/attempt.mjs';
import { collectSearchConsole } from './lib/collectors/search-console.mjs';
import { collectFacebook } from './lib/collectors/facebook.mjs';
import { buildSerpQueries, collectSerp } from './lib/collectors/serpapi.mjs';
import {
  POSTS_TABLE, TASKS_TABLE, collectHistory, postObservation, summaryObservation, taskObservation,
  unavailableObservation as historyUnavailable, chicagoDate,
} from './lib/collectors/history.mjs';
import { rankCandidates } from './lib/select.mjs';
import { buildGenerationInput, generatePlan, promptVersion } from './lib/generate.mjs';
import { validatePlan } from './lib/validate.mjs';
import { renderFacebookSchedule, renderGbpSchedule, renderPlanSummary, renderWebsiteQueue } from './lib/render.mjs';
import { exportPaths, stagePlan } from './lib/stage.mjs';
import { LEGACY_FILES, compareWithLegacy, redactSecrets } from './lib/compare.mjs';
import { formatAttemptMessage, notifyAttempt } from './lib/notify.mjs';
import { defaultGbpPhotoDirs, existingPhotoSearchDirs } from '../lib/gbp-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MODES = Object.freeze(['shadow', 'offline']);
export const OFFLINE_MODEL = 'offline-fixture';
export const DEFAULT_FIXTURES_DIR = path.join(__dirname, 'test', 'fixtures', 'e2e');
/** Where an offline run keeps its state and exports, away from the live week's lease and shadow files. */
export const OFFLINE_STORE_DIR = path.join(STATE_DIR, 'offline');
export const OFFLINE_OUT_DIR = path.join(SHADOW_DIR, 'offline');
/** Files a fixtures directory may carry (an absent observations file makes that source unavailable). */
export const FIXTURE_FILES = Object.freeze({
  facts: 'facts.md',
  photos: 'photos.json',
  plan: 'model-plan.json',
  search_console: path.join('observations', 'search-console.json'),
  facebook: path.join('observations', 'facebook.json'),
  serpapi: path.join('observations', 'serpapi.json'),
  history: path.join('observations', 'history.json'),
});
/** Extra files mirrored into --out on top of stage.mjs's exports. */
export const MIRROR_FILES = Object.freeze({
  revision: 'revision.json',
  observations: 'observations.jsonl',
  meter: 'meter.json',
  compare: 'compare.md',
});
export const COLLECTOR_NAMES = Object.freeze(['search_console', 'facebook', 'serpapi', 'history']);
export const PRIOR_WINNER_WEEKS = 2;

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const USAGE = [
  'usage: node scripts/weekly/run.mjs --mode shadow|offline [options]',
  '',
  '  --mode shadow|offline   shadow: live collectors + DeepSeek, Supabase store when configured',
  '                          offline: fixture collectors + canned plan, no network (the e2e path)',
  '  --week-of YYYY-MM-DD    plan this Monday week (default: the week for --now / today, Chicago)',
  '  --now ISO               fixed clock for every timestamp and window (default: the wall clock)',
  '  --store <dir>           file store root (default: state/weekly; offline: state/weekly/offline)',
  '  --out <dir>             export dir (default: outputs/shadow; offline: outputs/shadow/offline)',
  '  --budget-usd N          spend ceiling (default: WEEKLY_BUDGET_USD, then policy.budget_usd)',
  '  --fixtures <dir>        offline fixtures (default: scripts/weekly/test/fixtures/e2e)',
  '  --legacy-dir <dir>      legacy outputs to compare against (default: outputs; offline: skip unless given)',
  '  --photos-dir <dir>      photo inventory (default: the GBP photo folders from scripts/lib/gbp-paths.mjs)',
  '  --notify                shadow only: send the Hermes/SMTP attempt alert',
  '  -h, --help              this text',
].join('\n');

const noop = () => {};
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// CLI arguments and defaults (pure)
// ---------------------------------------------------------------------------

const VALUE_FLAGS = {
  '--mode': 'mode',
  '--week-of': 'weekOf',
  '--now': 'now',
  '--store': 'storeDir',
  '--out': 'outDir',
  '--budget-usd': 'budgetUsd',
  '--fixtures': 'fixturesDir',
  '--legacy-dir': 'legacyDir',
  '--photos-dir': 'photosDir',
};
const BOOL_FLAGS = { '--notify': 'notify', '--help': 'help', '-h': 'help' };

/** Parse argv (without node and the script path). Throws on an unknown or valueless flag. */
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    if (flag in BOOL_FLAGS) { out[BOOL_FLAGS[flag]] = true; continue; }
    if (!(flag in VALUE_FLAGS)) throw new Error(`unknown option ${arg}\n${USAGE}`);
    const value = eq !== -1 && arg.startsWith('--') ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) throw new Error(`${flag} needs a value\n${USAGE}`);
    out[VALUE_FLAGS[flag]] = value;
  }
  if (out.budgetUsd !== undefined) {
    const n = Number(out.budgetUsd);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--budget-usd must be a non-negative number, got ${out.budgetUsd}`);
    out.budgetUsd = n;
  }
  return out;
}

/** Fill mode-specific defaults. Throws on an unknown mode. */
export function resolveOptions(options = {}) {
  const mode = options.mode;
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')} (got ${mode === undefined ? 'nothing' : JSON.stringify(mode)})\n${USAGE}`);
  const offline = mode === 'offline';
  return {
    ...options,
    mode,
    storeDir: path.resolve(options.storeDir || (offline ? OFFLINE_STORE_DIR : STATE_DIR)),
    outDir: path.resolve(options.outDir || (offline ? OFFLINE_OUT_DIR : SHADOW_DIR)),
    fixturesDir: path.resolve(options.fixturesDir || DEFAULT_FIXTURES_DIR),
    legacyDir: options.legacyDir ? path.resolve(options.legacyDir) : (offline ? null : OUTPUTS_DIR),
    photosDir: options.photosDir ? path.resolve(options.photosDir) : null,
    notify: Boolean(options.notify),
  };
}

/** `now` as a Date: undefined → wall clock, Date/ISO pass through, junk → TypeError. */
export function resolveNow(now) {
  if (now === undefined || now === null) return new Date();
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(d.getTime())) throw new TypeError(`--now is not a valid instant: ${String(now)}`);
  return d;
}

/** Budget: explicit option, then WEEKLY_BUDGET_USD, then policy.budget_usd. Non-negative and finite. */
export function resolveBudget({ budgetUsd, env = {}, policy = {} }) {
  const candidates = [budgetUsd, env.WEEKLY_BUDGET_USD, policy.budget_usd];
  for (const c of candidates) {
    if (c === undefined || c === null || c === '') continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
    throw new Error(`budget must be a non-negative number, got ${JSON.stringify(c)}`);
  }
  return 0;
}

/**
 * The slice of the SERP query list a week may spend live calls on. With
 * `serp.rotate_weekly` the slice of `size` queries advances by `size` each ISO
 * week (wrapping), so every city/template pair is refreshed every
 * ceil(queries / size) weeks; cached hits are served regardless. Without
 * rotation, or when the list fits, the whole list is returned.
 */
export function rotateSerpQueries(queries, weekOf, size, { rotate = true } = {}) {
  const list = Array.isArray(queries) ? queries : [];
  const n = Math.floor(Number(size));
  if (!rotate || !Number.isFinite(n) || n <= 0 || list.length <= n) return list;
  const weekIndex = Math.floor(parseDate(weekOf) / (7 * 86400000));
  const start = (weekIndex * n) % list.length;
  return Array.from({ length: n }, (_, i) => list[(start + i) % list.length]);
}

/** The week's SERP queries: buildSerpQueries capped by the policy, rotated by week. */
export function serpQueriesForWeek(policy, weekOf) {
  const serp = (policy && policy.serp) || {};
  return rotateSerpQueries(buildSerpQueries(policy), weekOf, serp.max_calls, { rotate: serp.rotate_weekly !== false });
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/** Image file names in the GBP photo folders (or the given dirs), unique and sorted. */
export function listPhotoInventory({ dirs, env = process.env } = {}) {
  const searchDirs = Array.isArray(dirs) && dirs.length
    ? dirs.filter((d) => d && fs.existsSync(d))
    : existingPhotoSearchDirs(defaultGbpPhotoDirs(env));
  const names = new Set();
  for (const dir of searchDirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { entries = []; }
    for (const name of entries) if (IMAGE_RE.test(name)) names.add(name);
  }
  return [...names].sort();
}

/** Inventory minus every photo the published history already used (basename, case-insensitive). */
export function unusedPhotos(inventory, history) {
  const used = new Set();
  for (const post of (history && history.posts) || []) {
    const file = post && post.photo_file;
    if (typeof file === 'string' && file.trim()) used.add(path.basename(file.trim()).toLowerCase());
  }
  return (inventory || []).filter((name) => !used.has(path.basename(String(name)).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/** A generic `unavailable` observation for a collector that produced nothing usable. */
export function unavailableObservation({ source, scope, attemptId, retrievedAt, note }) {
  return {
    id: `${source}:unavailable`,
    attempt_id: attemptId,
    source,
    scope: scope || source,
    geography: null,
    period: null,
    status: 'unavailable',
    metric: null,
    value: null,
    raw_ref: null,
    retrieved_at: retrievedAt,
    note: note || null,
  };
}

/** Per-source counts of ok / unavailable / error observations. */
export function availabilityBySource(observations) {
  const out = {};
  for (const name of COLLECTOR_NAMES) out[name] = { ok: 0, unavailable: 0, error: 0 };
  for (const obs of observations || []) {
    if (!obs || !(obs.source in out)) continue;
    const key = obs.status === 'ok' ? 'ok' : obs.status === 'error' ? 'error' : 'unavailable';
    out[obs.source][key] += 1;
  }
  return out;
}

/** Sources that answered with nothing usable (no ok observation, at least one failure). */
export function unavailableSources(availability) {
  return COLLECTOR_NAMES.filter((name) => {
    const a = availability[name] || { ok: 0, unavailable: 0, error: 0 };
    return a.ok === 0 && (a.unavailable > 0 || a.error > 0);
  });
}

function stamp(list, { attemptId, retrievedAt }) {
  return (Array.isArray(list) ? list : []).map((obs) => ({ ...obs, attempt_id: attemptId, retrieved_at: retrievedAt }));
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

// ---------------------------------------------------------------------------
// Collectors (live and fixture-backed) — every one returns Observation[] or
// { observations, history } and never throws on a data problem.
// ---------------------------------------------------------------------------

/** Live collectors for shadow mode. `supabase` may be null (history then reports unavailable). */
export function createLiveCollectors({ policy, env = process.env, meter, supabase = null, fetchImpl } = {}) {
  return {
    search_console: ({ attemptId, now }) => collectSearchConsole({ attemptId, now, policy, env, fetchImpl }),
    facebook: ({ attemptId, now }) => collectFacebook({ attemptId, now, policy, env, fetchImpl }),
    serpapi: ({ attemptId, now, weekOf }) => collectSerp({
      attemptId, queries: serpQueriesForWeek(policy, weekOf), now, meter, policy, env, fetchImpl,
    }),
    history: ({ attemptId, now }) => collectHistory({ attemptId, supabase, now, policy }),
  };
}

/**
 * Fixture collectors for offline mode. Observation files are arrays of
 * ObservationSchema rows whose attempt_id / retrieved_at are re-stamped; the
 * history file is `{ posts, website_tasks }` and its observations are built
 * with the history collector's own builders. A missing file makes that source
 * unavailable, which is how the degraded path is exercised.
 */
export function createFixtureCollectors(fixturesDir = DEFAULT_FIXTURES_DIR) {
  const fileFor = (name) => path.join(fixturesDir, FIXTURE_FILES[name]);
  const fromFile = (source, scope) => async ({ attemptId, retrievedAt }) => {
    const rows = readJsonIfPresent(fileFor(source));
    if (!Array.isArray(rows)) {
      return [unavailableObservation({ source, scope, attemptId, retrievedAt, note: `fixture ${FIXTURE_FILES[source]} not found in ${fixturesDir}` })];
    }
    return stamp(rows, { attemptId, retrievedAt });
  };
  return {
    search_console: fromFile('search_console', 'sites'),
    facebook: fromFile('facebook', 'page'),
    serpapi: fromFile('serpapi', 'queries'),
    history: async ({ attemptId, retrievedAt, now }) => {
      const data = readJsonIfPresent(fileFor('history'));
      const history = { posts: [], website_tasks: [] };
      if (!data || typeof data !== 'object') {
        const note = `fixture ${FIXTURE_FILES.history} not found in ${fixturesDir}`;
        return {
          observations: [POSTS_TABLE, TASKS_TABLE].map((table) => historyUnavailable({ attemptId, retrievedAt, table, note: `${table} unavailable: ${note}` })),
          history,
        };
      }
      history.posts = Array.isArray(data.posts) ? data.posts : [];
      history.website_tasks = Array.isArray(data.website_tasks) ? data.website_tasks : [];
      const today = chicagoDate(now);
      const observations = [];
      history.posts.forEach((post, index) => observations.push(postObservation(post, { attemptId, retrievedAt, index })));
      observations.push(summaryObservation({ attemptId, retrievedAt, table: POSTS_TABLE, rows: history.posts.length, weeks: 8, since: addDays(today, -56), today }));
      history.website_tasks.forEach((task, index) => observations.push(taskObservation(task, { attemptId, retrievedAt, index })));
      observations.push(summaryObservation({ attemptId, retrievedAt, table: TASKS_TABLE, rows: history.website_tasks.length, weeks: 12, since: addDays(today, -84), today }));
      return { observations, history };
    },
  };
}

/** Run every collector in parallel; a thrown collector becomes one unavailable observation. */
export async function collectAll(collectors, ctx) {
  const settled = await Promise.allSettled(COLLECTOR_NAMES.map((name) => {
    const fn = collectors && collectors[name];
    if (typeof fn !== 'function') return Promise.reject(new Error(`no ${name} collector`));
    return Promise.resolve().then(() => fn(ctx));
  }));
  const observations = [];
  let history = null;
  settled.forEach((result, i) => {
    const name = COLLECTOR_NAMES[i];
    if (result.status === 'fulfilled') {
      const value = result.value;
      const list = Array.isArray(value) ? value : (value && Array.isArray(value.observations) ? value.observations : []);
      for (const obs of list) {
        const { data, issues } = parseOrIssues(ObservationSchema, obs);
        if (issues.length) {
          // A collector bug, not a data outage: keep the run going, attribute the drop to the collector.
          observations.push(unavailableObservation({
            source: name, scope: String((obs && obs.scope) || 'invalid'), attemptId: ctx.attemptId, retrievedAt: ctx.retrievedAt,
            note: `observation dropped (schema): ${issues.slice(0, 3).map((x) => `${x.path}: ${x.message}`).join('; ')}`,
          }));
        } else {
          observations.push(data);
        }
      }
      if (name === 'history' && value && value.history && typeof value.history === 'object') history = value.history;
    } else {
      const reason = result.reason;
      const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
      observations.push(unavailableObservation({
        source: name, scope: name, attemptId: ctx.attemptId, retrievedAt: ctx.retrievedAt,
        note: `collector threw: ${redactSecrets(message).slice(0, 500)}`,
      }));
    }
  });
  return { observations, history: history || { posts: [], website_tasks: [] } };
}

// ---------------------------------------------------------------------------
// Fake LLM for offline mode
// ---------------------------------------------------------------------------

/**
 * A chatJSON-compatible client that answers with the canned ModelPlan from
 * `planPath`. Like a real model it copies the winner from the request into
 * `topic` (generate.mjs rejects a plan whose topic differs from the winner), so
 * the same fixture serves whatever the selection picked. Zero-cost meter
 * entries keep the spend ledger shaped like a live run.
 */
export function createFixtureLlm({ planPath, meter = null, model = OFFLINE_MODEL } = {}) {
  const file = planPath || path.join(DEFAULT_FIXTURES_DIR, FIXTURE_FILES.plan);
  const calls = [];
  async function chatJSON({ user, schema = ModelPlanSchema, label = 'chat' } = {}) {
    const request = typeof user === 'string' ? JSON.parse(user) : (user || {});
    const original = request.original_request || request;
    const winner = original && original.topic && original.topic.winner;
    const plan = clone(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (winner && plan.topic) {
      plan.topic = {
        service_key: winner.service_key,
        service_label: winner.service_label,
        city: winner.city,
        query_family: Array.isArray(winner.query_family) ? [...winner.query_family] : [],
      };
    }
    if (plan.notes && original && original.topic && original.topic.degraded) {
      plan.notes.degraded = true;
      plan.notes.degraded_reason = plan.notes.degraded_reason || 'Search Console and SerpApi were unavailable; the topic came from policy priorities and history.';
    }
    calls.push({ label, request });
    if (meter) meter.record({ kind: 'llm', model, inputTokens: 0, outputTokens: 0, usd: 0, label });
    const raw = JSON.stringify(plan);
    const { data, issues } = schema ? parseOrIssues(schema, plan) : { data: plan, issues: [] };
    return { data, issues, usage: { input: 0, output: 0 }, model, raw };
  }
  return { chatJSON, model, endpoint: `fixture:${file}`, calls };
}

// ---------------------------------------------------------------------------
// Store selection
// ---------------------------------------------------------------------------

/**
 * offline → file store at storeDir. shadow → Supabase store when both env vars
 * are set (an injected client is used when given), else the file store with a
 * warning. Returns { store, kind, supabase }.
 */
export function selectStore({ mode, storeDir, env = process.env, deps = {}, warn = noop }) {
  if (deps.store) return { store: deps.store, kind: 'injected', supabase: deps.supabase || null };
  if (mode === 'shadow') {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_KEY;
    if (url && key) {
      const client = deps.supabase || createClient(url, key);
      return { store: createSupabaseStore(client), kind: 'supabase', supabase: client };
    }
    warn(`SUPABASE_URL / SUPABASE_SERVICE_KEY not set; shadow run uses the file store at ${storeDir}`);
  }
  return { store: createFileStore(storeDir), kind: 'file', supabase: deps.supabase || null };
}

/** Winners of the last `weeks` weeks from stored revisions (validation.ok only), newest revision per week. */
export async function priorWinners(store, weekOf, weeks = PRIOR_WINNER_WEEKS) {
  const out = [];
  for (let i = 1; i <= weeks; i += 1) {
    const week = addDays(weekOf, -7 * i);
    let revisions = [];
    try { revisions = (await store.listRevisions(week)) || []; } catch { revisions = []; }
    const good = revisions.filter((r) => r && r.validation && r.validation.ok && r.topic && r.topic.service_key);
    const latest = good[good.length - 1];
    if (latest) out.push({ week_of: week, topic: { ...latest.topic } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function pad(s, n) { return String(s).padEnd(n); }

/** One-screen text summary of a run result (also printed by the CLI). */
export function formatRunSummary(result) {
  const { attempt, weekSpec, plan, selection, validation, availability = {}, paths = {}, storeKind } = result;
  const topic = plan && plan.topic;
  const lines = [];
  lines.push(`weekly ${attempt.mode} run — week of ${attempt.week_of} (GBP from ${weekSpec ? weekSpec.gbp_start : '?'})`);
  lines.push(`${pad('attempt', 10)}${attempt.id}  status ${attempt.status}  spend $${Number(attempt.spent_usd || 0).toFixed(4)} of $${Number(attempt.budget_usd || 0).toFixed(2)}  store ${storeKind || '?'}`);
  if (attempt.error) lines.push(`${pad('error', 10)}${redactSecrets(String(attempt.error))}`);
  const sources = COLLECTOR_NAMES.map((name) => {
    const a = availability[name] || { ok: 0, unavailable: 0, error: 0 };
    const bad = a.unavailable + a.error;
    return `${name} ${a.ok} ok${bad ? ` / ${bad} unavailable` : ''}`;
  });
  lines.push(`${pad('collect', 10)}${sources.join('; ')}`);
  if (selection && selection.winner) {
    lines.push(`${pad('topic', 10)}${selection.winner.service_label} in ${selection.winner.city} (total ${Number(selection.winner.total).toFixed(3)})${selection.degraded ? '  [degraded selection]' : ''}`);
  }
  if (plan) {
    lines.push(`${pad('plan', 10)}GBP ${plan.gbp.length}, Facebook ${plan.facebook.length}, website ${plan.website_actions.length}${topic ? ` — ${topic.service_label} / ${topic.city}` : ''}${plan.notes && plan.notes.degraded ? '  [degraded]' : ''}`);
  }
  if (validation) {
    lines.push(`${pad('validate', 10)}${validation.ok ? 'ok' : 'FAILED'} — ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`);
    for (const e of validation.errors.slice(0, 5)) lines.push(`${pad('', 10)}- ${e}`);
  }
  const stages = Object.entries(attempt.stages || {}).map(([name, s]) => `${name} ${s.status}`);
  if (stages.length) lines.push(`${pad('stages', 10)}${stages.join(' · ')}`);
  const written = Object.values(paths).filter(Boolean);
  if (written.length) {
    lines.push('written');
    for (const p of written) lines.push(`  ${p}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function writeText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
}

/** The plan's degraded flag is a fact about the inputs; code owns it, the model only explains it. */
function applyDegraded(plan, selection, reason) {
  if (!plan || !plan.notes) return plan;
  if (selection && selection.degraded && !plan.notes.degraded) {
    plan.notes.degraded = true;
    plan.notes.degraded_reason = plan.notes.degraded_reason || reason;
  }
  if (plan.notes.degraded && !plan.notes.degraded_reason) plan.notes.degraded_reason = reason;
  return plan;
}

/**
 * Run one attempt. `options` are the CLI options (see USAGE); `deps` let a test
 * inject { store, supabase, llm, collectors, facts, photos, policy, env,
 * fetchImpl, clock }. Resolves with the run result on succeeded/degraded and
 * rejects on failure (the attempt is marked failed first; the error carries
 * `.attempt`). A held lease rejects with LeaseHeld and creates no attempt.
 */
export async function runWeekly(options = {}, deps = {}) {
  const opts = resolveOptions(options);
  const env = deps.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : noop;
  const warn = typeof opts.warn === 'function' ? opts.warn : log;
  const offline = opts.mode === 'offline';

  // Inputs that must exist before an attempt is worth recording.
  const now = resolveNow(opts.now);
  const fixedClock = opts.now !== undefined && opts.now !== null;
  const clock = typeof deps.clock === 'function' ? deps.clock : (fixedClock ? () => new Date(now.getTime()) : () => new Date());
  const policy = deps.policy || JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  const facts = deps.facts || loadFacts(offline ? path.join(opts.fixturesDir, FIXTURE_FILES.facts) : FACTS_PATH);
  const weekSpec = opts.weekOf ? weekSpecForWeekOf(opts.weekOf, now) : computeWeekSpec({ now });
  const budgetUsd = resolveBudget({ budgetUsd: opts.budgetUsd, env, policy });
  const meter = createCostMeter({ ceilingUsd: budgetUsd, pricing: policy.pricing || {} });
  const model = offline ? OFFLINE_MODEL : (env.WEEKLY_MODEL || (policy.models && policy.models.generate) || 'deepseek-chat');

  let llm = deps.llm || null;
  if (!llm) {
    if (offline) {
      llm = createFixtureLlm({ planPath: path.join(opts.fixturesDir, FIXTURE_FILES.plan), meter, model });
    } else {
      const apiKey = env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set; shadow mode needs the DeepSeek key (or run --mode offline)');
      llm = createLlmClient({ apiKey, model, meter, fetchImpl: deps.fetchImpl });
    }
  }

  const { store, kind: storeKind, supabase } = selectStore({ mode: opts.mode, storeDir: opts.storeDir, env, deps, warn });
  const collectors = deps.collectors
    || (offline ? createFixtureCollectors(opts.fixturesDir) : createLiveCollectors({ policy, env, meter, supabase, fetchImpl: deps.fetchImpl }));

  const attempt = await createAttempt({
    store,
    week_of: weekSpec.week_of,
    mode: opts.mode,
    now,
    gitSha: readGitSha(),
    versions: { schema: SCHEMA_VERSION, prompt: promptVersion(), policy: String(policy.version || 'unknown') },
    models: { generate: model, fallback: (policy.models && policy.models.fallback) || null },
    budgetUsd,
  });
  log(`attempt ${attempt.id} (${opts.mode}, week of ${weekSpec.week_of}, store ${storeKind}, budget $${budgetUsd})`);

  const result = {
    attempt, weekSpec, storeKind, observations: [], history: null, selection: null, plan: null,
    validation: null, revision: null, compare: null, availability: {}, paths: {}, spentUsd: 0, llmCalls: 0,
  };
  const retrievedAt = now.toISOString();
  const outPaths = exportPaths(opts.outDir);
  const mirror = {
    revision: path.join(opts.outDir, MIRROR_FILES.revision),
    observations: path.join(opts.outDir, MIRROR_FILES.observations),
    meter: path.join(opts.outDir, MIRROR_FILES.meter),
    compare: path.join(opts.outDir, MIRROR_FILES.compare),
  };

  let failure = null;
  try {
    // ── collect ──────────────────────────────────────────────────────────
    await stageStart(store, attempt, 'collect', clock());
    const collected = await collectAll(collectors, { attemptId: attempt.id, now, retrievedAt, weekOf: weekSpec.week_of, weekSpec, policy });
    result.observations = collected.observations;
    result.availability = availabilityBySource(collected.observations);
    let history = collected.history;
    if (!history.posts.length && typeof store.listPublishedHistory === 'function') {
      // Fallback for a store that knows the history when the collector did not (file store history.json).
      try {
        const rows = await store.listPublishedHistory({ weeks: 8, now });
        if (Array.isArray(rows) && rows.length) history = { ...history, posts: rows };
      } catch { /* history stays as collected */ }
    }
    history = { ...history, winners: [...((history.winners) || []), ...(await priorWinners(store, weekSpec.week_of))] };
    result.history = history;
    await store.putObservations(collected.observations);
    const missing = unavailableSources(result.availability);
    await stageEnd(store, attempt, 'collect', {}, clock());
    log(`collect: ${collected.observations.length} observation(s)${missing.length ? `; unavailable: ${missing.join(', ')}` : ''}`);

    // ── select ───────────────────────────────────────────────────────────
    await stageStart(store, attempt, 'select', clock());
    const selection = rankCandidates({ policy, observations: collected.observations, history, facts, weekSpec });
    result.selection = selection;
    await stageEnd(store, attempt, 'select', {}, clock());
    log(`select: ${selection.winner.service_label} in ${selection.winner.city}${selection.degraded ? ' (degraded)' : ''}`);

    // ── generate ─────────────────────────────────────────────────────────
    await stageStart(store, attempt, 'generate', clock());
    const inventory = deps.photos
      || (offline ? (readJsonIfPresent(path.join(opts.fixturesDir, FIXTURE_FILES.photos)) || []) : listPhotoInventory({ dirs: opts.photosDir ? [opts.photosDir] : undefined, env }));
    const photos = unusedPhotos(inventory, history);
    const degradedReason = missing.length
      ? `unavailable this run: ${missing.join(', ')}; demand and opportunity fell back to policy defaults`
      : 'selection ran on partial data';
    const input = buildGenerationInput({ facts, selection, weekSpec, photos, history, policy });
    let plan = applyDegraded(await generatePlan(input, { llm, meter, attemptId: attempt.id }), selection, degradedReason);
    result.llmCalls += 1;
    await stageEnd(store, attempt, 'generate', {}, clock());

    // ── validate (one regeneration with the errors appended) ─────────────
    await stageStart(store, attempt, 'validate', clock());
    const validateCtx = { facts, weekSpec, photos, history, policy };
    let validation = validatePlan(plan, validateCtx);
    if (!validation.ok) {
      log(`validate: ${validation.errors.length} error(s); regenerating once`);
      const retryInput = {
        ...input,
        task: `${input.task} A previous plan for this same request failed validation; every problem is listed under previous_attempt.validation_errors. Fix all of them and keep everything else within the rules.`,
        previous_attempt: { validation_errors: validation.errors, validation_warnings: validation.warnings, plan },
      };
      plan = applyDegraded(await generatePlan(retryInput, { llm, meter, attemptId: attempt.id }), selection, degradedReason);
      result.llmCalls += 1;
      validation = validatePlan(plan, validateCtx);
    }
    result.plan = plan;
    result.validation = validation;
    const validationError = validation.ok ? null : new ValidationFailed(
      `plan failed validation after one regeneration (${validation.errors.length} error(s)): ${validation.errors.slice(0, 3).join('; ')}`,
      validation.errors, validation.warnings,
    );
    await stageEnd(store, attempt, 'validate', validationError ? { error: validationError } : {}, clock());
    log(`validate: ${validation.ok ? 'ok' : 'FAILED'} (${validation.errors.length} error(s), ${validation.warnings.length} warning(s))`);

    // ── stage (a failed plan is still staged so it can be inspected) ─────
    await stageStart(store, attempt, 'stage', clock());
    const rendered = {
      gbp: renderGbpSchedule(plan, weekSpec),
      facebook: renderFacebookSchedule(plan, weekSpec, { boostWeeklyUsd: policy.boost_weekly_usd }),
      website: renderWebsiteQueue(plan),
      summary: renderPlanSummary(plan, selection, attempt),
    };
    const revision = await stagePlan({ store, attempt, plan, selection, validation, rendered, mode: opts.mode, now: clock(), outDir: opts.outDir });
    result.revision = revision;
    result.paths = { ...outPaths };
    await stageEnd(store, attempt, 'stage', {}, clock());
    log(`stage: revision ${revision.id} → ${opts.outDir}`);
    if (validationError) throw validationError;

    // ── compare (shadow; offline only when a legacy dir is named) ────────
    await stageStart(store, attempt, 'compare', clock());
    const legacyPresent = opts.legacyDir && [LEGACY_FILES.gbp, LEGACY_FILES.facebook].some((f) => fs.existsSync(path.join(opts.legacyDir, f)));
    if (legacyPresent) {
      const report = compareWithLegacy({
        shadowDir: opts.outDir, outputsDir: opts.legacyDir, facts, weekSpec, policy, attempt, spentUsd: meter.spent(), now: clock(),
      });
      await writeText(mirror.compare, report);
      result.compare = report;
      result.paths.compare = mirror.compare;
      await stageEnd(store, attempt, 'compare', {}, clock());
      log(`compare: ${mirror.compare}`);
    } else {
      await stageEnd(store, attempt, 'compare', { status: 'skipped' }, clock());
      log(`compare: skipped (${opts.legacyDir ? `no legacy schedules in ${opts.legacyDir}` : 'no legacy dir'})`);
    }
  } catch (e) {
    failure = e;
  }

  // ── finish ───────────────────────────────────────────────────────────
  result.spentUsd = meter.spent();
  const missing = unavailableSources(result.availability);
  const degraded = missing.length > 0 || Boolean(result.selection && result.selection.degraded) || Boolean(result.plan && result.plan.notes && result.plan.notes.degraded);
  const finalStatus = failure ? 'failed' : (degraded ? 'degraded' : 'succeeded');
  try {
    await finishAttempt(store, attempt, { status: finalStatus, error: failure, spentUsd: result.spentUsd }, clock());
  } catch (e) {
    // The store went away at the very end: report the original failure first, this one otherwise.
    warn(`finishAttempt failed: ${redactSecrets(errorText(e))}`);
    if (!failure) failure = e;
  }

  // Mirror the final records into --out (stage.mjs wrote the mid-run snapshot).
  try {
    if (result.revision || fs.existsSync(opts.outDir)) {
      await writeJson(outPaths.attempt, attempt);
      result.paths.attempt = outPaths.attempt;
      if (result.revision) { await writeJson(mirror.revision, result.revision); result.paths.revision = mirror.revision; }
      if (result.observations.length) {
        await writeText(mirror.observations, result.observations.map((o) => JSON.stringify(o)).join('\n') + '\n');
        result.paths.observations = mirror.observations;
      }
      await writeJson(mirror.meter, { spent_usd: result.spentUsd, ceiling_usd: budgetUsd, entries: meter.entries() });
      result.paths.meter = mirror.meter;
      if (result.plan) {
        await writeText(outPaths.summary, renderPlanSummary(result.plan, result.selection, attempt));
        result.paths.summary = outPaths.summary;
      }
    }
  } catch (e) {
    warn(`mirror to ${opts.outDir} failed: ${redactSecrets(errorText(e))}`);
  }

  if (opts.notify && opts.mode === 'shadow') {
    try {
      const message = formatAttemptMessage({ attempt, event: finalStatus, plan: result.plan, summary: { path: result.paths.summary } });
      const receipt = await notifyAttempt({ store, attempt, event: finalStatus, message, now: clock() });
      log(`notify: ${receipt.sent ? `sent via ${receipt.channel}` : `not sent (${receipt.reason})`}`);
    } catch (e) {
      warn(`notify failed: ${redactSecrets(errorText(e))}`);
    }
  }

  result.summary = formatRunSummary(result);
  if (failure) {
    failure.attempt = attempt;
    failure.result = result;
    throw failure;
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!MODES.includes(args.mode)) {
    console.error(`--mode must be one of ${MODES.join(', ')} (got ${args.mode === undefined ? 'nothing' : JSON.stringify(args.mode)})\n${USAGE}`);
    return 2;
  }
  loadEnv();
  const log = (m) => console.log(`[weekly] ${m}`);
  const warn = (m) => console.error(`[weekly] warning: ${m}`);
  try {
    const result = await runWeekly({ ...args, log, warn });
    console.log('');
    console.log(result.summary);
    return 0;
  } catch (e) {
    if (e instanceof LeaseHeld) {
      console.error(`[weekly] refused: ${e.message} (attempt ${e.attempt_id || '?'} recorded as failed)`);
      return 1;
    }
    if (e && e.result && e.result.summary) {
      console.log('');
      console.log(e.result.summary);
    }
    const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[weekly] failed: ${redactSecrets(text)}`);
    if (e && Array.isArray(e.errors) && e.errors.length) for (const line of e.errors.slice(0, 10)) console.error(`  - ${line}`);
    if (e && Array.isArray(e.issues) && e.issues.length) for (const i of e.issues.slice(0, 10)) console.error(`  - ${i.path || '(root)'}: ${i.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; });
}
