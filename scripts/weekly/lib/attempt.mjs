// scripts/weekly/lib/attempt.mjs
// Attempt lifecycle: one record per run with an immutable id, a per-week lease,
// stage timestamps, and a final status. Every function takes `now` so tests are
// deterministic, works against any Store that implements the DESIGN.md interface,
// and keeps the caller's in-memory `attempt` object in sync with what was persisted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LeaseHeld } from './errors.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import { AttemptSchema, SCHEMA_VERSION, parseOrIssues } from './schemas.mjs';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_ERROR_CHARS = 2000;

const iso = (d) => new Date(d).toISOString();

/** Error → short string for the record; null when there is no error. */
export function errorText(error) {
  if (error == null || error === '') return null;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : JSON.stringify(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/** `<week_of>-<compact UTC stamp>-<6 hex>` — sortable, unique, safe as a file name. */
export function makeAttemptId(week_of, now = new Date()) {
  const stamp = iso(now).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${week_of}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Current commit sha without spawning git: follows `.git` files (worktrees),
 * symbolic HEAD refs, and packed-refs. Returns 'unknown' when it cannot tell.
 */
export function readGitSha(projectRoot = PROJECT_ROOT) {
  try {
    let gitDir = path.join(projectRoot, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return 'unknown';
      gitDir = path.resolve(projectRoot, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*(.+)$/);
    if (!ref) return /^[0-9a-f]{40}$/i.test(head) ? head : 'unknown';
    const refName = ref[1].trim();
    const commonFile = path.join(gitDir, 'commondir');
    const commonDir = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
    for (const candidate of [path.join(gitDir, refName), path.join(commonDir, refName)]) {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8').trim() || 'unknown';
    }
    const packed = path.join(commonDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, 'utf8').split(/\r?\n/).find((l) => !l.startsWith('#') && l.endsWith(` ${refName}`));
      if (line) return line.split(' ')[0];
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function assertValid(attempt) {
  const { data, issues } = parseOrIssues(AttemptSchema, attempt);
  if (issues.length) {
    const detail = issues.slice(0, 5).map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
    throw new TypeError(`attempt failed schema validation: ${detail}`);
  }
  return data;
}

/**
 * Create the attempt record and take the week's lease. Throws `LeaseHeld` when
 * another attempt holds a live lease; the refusal is itself recorded as a failed
 * attempt so a watchdog can see why nothing ran.
 */
export async function createAttempt({
  store, week_of, mode, now = new Date(), gitSha, versions = {}, models = {}, budgetUsd, ttlMs = DEFAULT_TTL_MS, id,
}) {
  if (!store) throw new TypeError('createAttempt: store is required');
  if (!week_of) throw new TypeError('createAttempt: week_of is required');
  if (!mode) throw new TypeError('createAttempt: mode is required');
  if (!Number.isFinite(new Date(now).getTime())) throw new TypeError(`createAttempt: now must be a valid date; got ${JSON.stringify(now)}`);
  const attemptId = id || makeAttemptId(week_of, now);
  const base = {
    id: attemptId,
    week_of,
    mode,
    git_sha: gitSha || 'unknown',
    versions: { schema: versions.schema || SCHEMA_VERSION, prompt: versions.prompt || 'unknown', policy: versions.policy || 'unknown' },
    models: { generate: models.generate || 'unknown', fallback: models.fallback ?? null },
    started_at: iso(now),
    finished_at: null,
    stages: {},
    lease_until: null,
    budget_usd: Number.isFinite(budgetUsd) ? budgetUsd : 0,
    spent_usd: 0,
    status: 'running',
    error: null,
  };
  assertValid(base);

  const lease = await store.acquireLease({ week_of, attempt_id: attemptId, ttlMs, now });
  if (!lease.ok) {
    const message = `week ${week_of} lease held by ${lease.holder} until ${lease.lease_until}`;
    try {
      await store.createAttempt({ ...base, finished_at: iso(now), status: 'failed', error: `LeaseHeld: ${message}` });
    } catch {
      // Recording the refusal is best-effort; the refusal itself is what matters.
    }
    throw new LeaseHeld(message, { week_of, holder: lease.holder, lease_until: lease.lease_until, attempt_id: attemptId });
  }

  const attempt = { ...base, lease_until: lease.lease_until || null };
  try {
    await store.createAttempt(attempt);
  } catch (e) {
    await store.releaseLease({ week_of, attempt_id: attemptId }).catch(() => {});
    throw e;
  }
  return attempt;
}

async function persist(store, attempt, patch) {
  const updated = await store.updateAttempt(attempt.id, patch);
  Object.assign(attempt, updated);
  return attempt;
}

/** Mark a stage running. Starting a stage again overwrites its previous record. */
export async function stageStart(store, attempt, name, now = new Date()) {
  const stages = { ...attempt.stages, [name]: { started_at: iso(now), finished_at: null, status: 'running', error: null } };
  return persist(store, attempt, { stages });
}

/** Close a stage: status defaults to 'failed' when an error is given, else 'ok'. */
export async function stageEnd(store, attempt, name, { status, error } = {}, now = new Date()) {
  const previous = (attempt.stages || {})[name] || { started_at: iso(now) };
  const errText = errorText(error);
  const stage = {
    started_at: previous.started_at,
    finished_at: iso(now),
    status: status || (errText ? 'failed' : 'ok'),
    error: errText,
  };
  return persist(store, attempt, { stages: { ...attempt.stages, [name]: stage } });
}

/**
 * Finish the attempt and release its lease. Status defaults to 'failed' when an
 * error is given, else 'succeeded'. Any stage still 'running' is closed as failed
 * so a finished record never claims work in progress.
 */
export async function finishAttempt(store, attempt, { status, error, spentUsd } = {}, now = new Date()) {
  const errText = errorText(error);
  const finalStatus = status || (errText ? 'failed' : 'succeeded');
  const stages = {};
  for (const [name, stage] of Object.entries(attempt.stages || {})) {
    stages[name] = stage.status === 'running'
      ? { ...stage, finished_at: iso(now), status: 'failed', error: stage.error || `attempt finished (${finalStatus}) while stage was running` }
      : stage;
  }
  const patch = {
    stages,
    finished_at: iso(now),
    status: finalStatus,
    error: errText,
    spent_usd: Number.isFinite(spentUsd) ? spentUsd : attempt.spent_usd,
    lease_until: null,
  };
  const updated = await persist(store, attempt, patch);
  await store.releaseLease({ week_of: attempt.week_of, attempt_id: attempt.id });
  return updated;
}

export { DEFAULT_TTL_MS };
