// scripts/weekly/lib/store.mjs
// File-backed Store for the weekly pipeline (attempts, leases, observations,
// revisions, items). Layout under `dir`:
//   attempts/<id>.json   leases/<week_of>.json   observations/<attempt_id>.jsonl
//   revisions/<id>.json  items/<revision_id>.jsonl   history.json (optional, read-only)
// Every write is tmp + rename so a crash never leaves a half-written record, and
// writes to the same path are serialised in-process so parallel collectors can
// append observations for one attempt without losing lines. Lease changes also take
// a transient `leases/<week_of>.json.lock` (O_EXCL) so two pipeline processes cannot
// both be admitted for the same week. Records are validated
// against lib/schemas.mjs on the way in; a schema-invalid record is a bug upstream
// and is refused rather than persisted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AttemptSchema,
  ObservationSchema,
  PlanItemSchema,
  RevisionSchema,
  parseOrIssues,
} from './schemas.mjs';

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** How long acquire/release wait for another process's lease lock, and when a lock counts as abandoned. */
const DEFAULT_LOCK_WAIT_MS = 10 * 1000;
const DEFAULT_LOCK_STALE_MS = 30 * 1000;

let tmpCounter = 0;
const queues = new Map();
const noop = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` after every earlier job queued under `key` has settled. Returns fn's promise. */
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(noop, noop).then(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return run;
}

/** Names become file names; refuse anything that could leave the directory. */
function safeName(value, label) {
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) {
    throw new TypeError(`${label} must match ${SAFE_NAME_RE}; got ${JSON.stringify(value)}`);
  }
  return value;
}

function validate(schema, value, label) {
  const { data, issues } = parseOrIssues(schema, value);
  if (issues.length) {
    const detail = issues.slice(0, 5).map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
    throw new TypeError(`${label} failed schema validation: ${detail}`);
  }
  return data;
}

const isMissing = (e) => e && e.code === 'ENOENT';

/** Windows can refuse to rename over a file an indexer/AV has briefly open; retry a few times. */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try { await fs.rename(from, to); return; }
    catch (e) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(25 * attempt);
    }
  }
}

async function writeAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  try { await renameWithRetry(tmp, filePath); }
  catch (e) { await fs.rm(tmp, { force: true }).catch(noop); throw e; }
}

/** Create `filePath` only if it does not exist yet (O_EXCL). False when another writer got there first. */
async function writeExclusive(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try { await fs.writeFile(filePath, text, { encoding: 'utf8', flag: 'wx' }); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (e) { if (isMissing(e)) return null; throw e; }
}

async function readJsonl(filePath) {
  let text;
  try { text = await fs.readFile(filePath, 'utf8'); }
  catch (e) { if (isMissing(e)) return []; throw e; }
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const pretty = (obj) => JSON.stringify(obj, null, 2) + '\n';

function groupBy(list, keyOf, label) {
  const groups = new Map();
  for (const item of list) {
    const key = safeName(keyOf(item), label);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/** Lease expiry as epoch ms; NaN (missing/invalid) counts as already expired so a bad lease can never block forever. */
function leaseExpiry(lease) {
  const t = lease && typeof lease.lease_until === 'string' ? Date.parse(lease.lease_until) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

const isLease = (value) => Boolean(value) && typeof value === 'object' && typeof value.attempt_id === 'string';

/** Read a lease file as { present, lease }; unparseable content is present garbage (lease: null). */
async function readLease(filePath) {
  try { return { present: true, lease: JSON.parse(await fs.readFile(filePath, 'utf8')) }; }
  catch (e) {
    if (isMissing(e)) return { present: false, lease: null };
    if (e instanceof SyntaxError) return { present: true, lease: null };
    throw e;
  }
}

const isStale = (st, staleMs, nowMs) => nowMs - st.mtimeMs > staleMs;

/**
 * Run `fn` while holding `lockPath`, an O_EXCL lock file that serialises the
 * read-check-write of a lease across OS processes (the in-process queue cannot).
 * A busy lock is polled for up to `waitMs`. A lock older than `staleMs` belongs to
 * a holder that died inside the (millisecond-long) critical section: it is moved
 * aside with a rename only one process can win, then re-checked so a lock that was
 * refreshed under us is put back rather than broken.
 */
async function withFileLock(lockPath, { waitMs, staleMs }, fn) {
  const token = `${process.pid}.${++tmpCounter}.${Math.random().toString(16).slice(2, 10)}`;
  const deadline = Date.now() + waitMs;
  while (!(await writeExclusive(lockPath, `${token}\n`))) {
    let stale;
    try { stale = isStale(await fs.stat(lockPath), staleMs, Date.now()); }
    catch (e) { if (!isMissing(e)) throw e; continue; } // released between our attempts: try again now
    if (stale) {
      const aside = `${lockPath}.${token}.stale`;
      try {
        await fs.rename(lockPath, aside);
        if (isStale(await fs.stat(aside), staleMs, Date.now())) await fs.rm(aside, { force: true });
        else await fs.rename(aside, lockPath).catch(noop); // a live lock got under our rename: restore it
      } catch (e) { if (!isMissing(e)) throw e; }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`lease lock busy for ${waitMs} ms: ${lockPath}`);
    await sleep(5 + Math.floor(Math.random() * 10));
  }
  try { return await fn(); }
  finally { await fs.rm(lockPath, { force: true }).catch(noop); }
}

export function createFileStore(dir, { lockWaitMs = DEFAULT_LOCK_WAIT_MS, lockStaleMs = DEFAULT_LOCK_STALE_MS } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('createFileStore(dir): dir is required');
  const root = path.resolve(dir);
  const lockOptions = { waitMs: lockWaitMs, staleMs: lockStaleMs };
  const attemptPath = (id) => path.join(root, 'attempts', `${safeName(id, 'attempt id')}.json`);
  const leasePath = (weekOf) => path.join(root, 'leases', `${safeName(weekOf, 'week_of')}.json`);
  const observationsPath = (attemptId) => path.join(root, 'observations', `${safeName(attemptId, 'attempt_id')}.jsonl`);
  const revisionPath = (id) => path.join(root, 'revisions', `${safeName(id, 'revision id')}.json`);
  const itemsPath = (revisionId) => path.join(root, 'items', `${safeName(revisionId, 'revision_id')}.jsonl`);
  const historyPath = path.join(root, 'history.json');

  async function readAttempt(id) {
    return readJson(attemptPath(id));
  }

  return {
    dir: root,

    async createAttempt(attempt) {
      const data = validate(AttemptSchema, attempt, 'attempt');
      const file = attemptPath(data.id);
      return serialize(file, async () => {
        if (await readJson(file)) throw new Error(`attempt ${data.id} already exists`);
        await writeAtomic(file, pretty(data));
        return data;
      });
    },

    async getAttempt(id) {
      return readAttempt(id);
    },

    async updateAttempt(id, patch) {
      const file = attemptPath(id);
      return serialize(file, async () => {
        const current = await readJson(file);
        if (!current) throw new Error(`attempt ${id} not found`);
        const merged = validate(AttemptSchema, { ...current, ...patch, id: current.id }, 'attempt');
        await writeAtomic(file, pretty(merged));
        return merged;
      });
    },

    /**
     * Take or renew the per-week lease. Succeeds when no lease exists, the existing
     * lease has expired (lease_until < now), or the same attempt already holds it.
     * The read-check-write runs under `leases/<week_of>.json.lock` so two runs of the
     * pipeline in different processes cannot both be admitted.
     */
    async acquireLease({ week_of, attempt_id, ttlMs = DEFAULT_LEASE_TTL_MS, now = new Date() }) {
      const file = leasePath(week_of);
      safeName(attempt_id, 'attempt_id');
      const nowMs = new Date(now).getTime();
      if (!Number.isFinite(nowMs)) throw new TypeError(`acquireLease: now must be a valid date; got ${JSON.stringify(now)}`);
      if (!(Number.isFinite(ttlMs) && ttlMs > 0)) throw new TypeError(`acquireLease: ttlMs must be a positive number; got ${JSON.stringify(ttlMs)}`);
      const lease = { attempt_id, lease_until: new Date(nowMs + ttlMs).toISOString(), acquired_at: new Date(nowMs).toISOString() };
      return serialize(file, () => withFileLock(`${file}.lock`, lockOptions, async () => {
        const { lease: existing } = await readLease(file);
        if (isLease(existing) && existing.attempt_id !== attempt_id && leaseExpiry(existing) >= nowMs) {
          return { ok: false, holder: existing.attempt_id, lease_until: existing.lease_until };
        }
        await writeAtomic(file, pretty(lease));
        return { ok: true, lease_until: lease.lease_until };
      }));
    },

    /** Drop the lease if `attempt_id` holds it (or nobody can: unreadable). A lease held by another attempt is left alone. */
    async releaseLease({ week_of, attempt_id }) {
      const file = leasePath(week_of);
      return serialize(file, () => withFileLock(`${file}.lock`, lockOptions, async () => {
        const { present, lease: existing } = await readLease(file);
        if (!present) return { ok: true };
        if (isLease(existing) && existing.attempt_id !== attempt_id) {
          return { ok: false, holder: existing.attempt_id, lease_until: existing.lease_until ?? null };
        }
        await fs.rm(file, { force: true });
        return { ok: true };
      }));
    },

    async getLease(week_of) {
      return readJson(leasePath(week_of));
    },

    /** Append observations to `observations/<attempt_id>.jsonl` (grouped by attempt). */
    async putObservations(list) {
      const rows = list.map((o, i) => validate(ObservationSchema, o, `observation[${i}]`));
      for (const [attemptId, group] of groupBy(rows, (o) => o.attempt_id, 'observation.attempt_id')) {
        const file = observationsPath(attemptId);
        await serialize(file, async () => {
          const existing = await readJsonl(file);
          await writeAtomic(file, toJsonl(existing.concat(group)));
        });
      }
      return { count: rows.length };
    },

    async listObservations(attempt_id) {
      return readJsonl(observationsPath(attempt_id));
    },

    async putRevision(rev) {
      const data = validate(RevisionSchema, rev, 'revision');
      const file = revisionPath(data.id);
      await serialize(file, () => writeAtomic(file, pretty(data)));
      return data;
    },

    async getRevision(id) {
      return readJson(revisionPath(id));
    },

    /** Upsert items by id into `items/<revision_id>.jsonl` (grouped by revision). */
    async putItems(list) {
      const rows = list.map((it, i) => validate(PlanItemSchema, it, `item[${i}]`));
      for (const [revisionId, group] of groupBy(rows, (it) => it.revision_id, 'item.revision_id')) {
        const file = itemsPath(revisionId);
        await serialize(file, async () => {
          const byId = new Map((await readJsonl(file)).map((it) => [it.id, it]));
          for (const it of group) byId.set(it.id, it);
          await writeAtomic(file, toJsonl([...byId.values()]));
        });
      }
      return { count: rows.length };
    },

    async listItems(revision_id) {
      return readJsonl(itemsPath(revision_id));
    },

    /** Revisions for a week, ordered by revision number then id. */
    async listRevisions(week_of) {
      const folder = path.join(root, 'revisions');
      let names;
      try { names = await fs.readdir(folder); }
      catch (e) { if (isMissing(e)) return []; throw e; }
      const out = [];
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const rev = await readJson(path.join(folder, name));
        if (rev && rev.week_of === week_of) out.push(rev);
      }
      return out.sort((a, b) => (a.revision - b.revision) || String(a.id).localeCompare(String(b.id)));
    },

    /**
     * Published history for selection. The file store reads `<dir>/history.json`
     * (an array of posts, or `{ posts: [...] }`) when present, else []. Posts dated
     * more than `weeks` weeks before `now` are dropped (undated posts are kept) — the
     * same window the Supabase store applies. `weeks: 0` returns everything.
     */
    async listPublishedHistory({ weeks = 8, now = new Date() } = {}) {
      const parsed = await readJson(historyPath);
      const posts = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.posts) ? parsed.posts : [];
      if (!(Number.isFinite(weeks) && weeks > 0)) return posts;
      const nowMs = new Date(now).getTime();
      if (!Number.isFinite(nowMs)) throw new TypeError(`listPublishedHistory: now must be a valid date; got ${JSON.stringify(now)}`);
      const cutoff = nowMs - weeks * 7 * 24 * 60 * 60 * 1000;
      return posts.filter((p) => {
        const t = p && p.post_date ? Date.parse(p.post_date) : NaN;
        return Number.isNaN(t) || t >= cutoff;
      });
    },
  };
}

export { DEFAULT_LEASE_TTL_MS };
