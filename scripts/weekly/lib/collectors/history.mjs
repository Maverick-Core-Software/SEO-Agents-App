/**
 * collectors/history.mjs
 * Read-only history collector for the weekly pipeline.
 *
 * Reads what the legacy pipeline already published or queued so selection can
 * apply recency penalties and generation can avoid recent hooks:
 *   - `weekly_posts`   (last `weeks` weeks by post_date, default 8)
 *   - `website_tasks`  (last 12 weeks by updated_at)
 * Both are plain selects through the injected supabase-js client; nothing in
 * this module ever writes, and it never creates a client or reads .env (the
 * caller passes a client, tests pass a fake whose chain resolves fixtures).
 *
 * Output is `{ observations, history }`: one `history` observation per row
 * plus one `history_summary` per table (so "collected fine but empty" is
 * distinguishable from "not collected"), and the compact `history` object the
 * select/generate/validate stages consume. `city` on each post is inferred
 * from its text against config/weekly-policy.json cities.
 *
 * Never throws: a failing table becomes one `unavailable` observation for that
 * table and an empty list in `history`; the other table is still read.
 *
 * Geography helpers (`policyCities`, `findCity`) live here and are shared with
 * collectors/serpapi.mjs.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { POLICY_PATH } from '../paths.mjs';

export const SOURCE = 'history';
export const POSTS_TABLE = 'weekly_posts';
export const TASKS_TABLE = 'website_tasks';
export const POST_COLUMNS = 'platform,day,post_date,type,service,hook,body,hashtags,status,platform_post_id,photo_file';
export const TASK_COLUMNS = 'title,type,status,updated_at';
export const METRIC_POST = 'history_post';
export const METRIC_TASK = 'history_task';
export const METRIC_SUMMARY = 'history_summary';
export const DEFAULT_WEEKS = 8;
export const TASK_WEEKS = 12;
export const ROW_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

// ── Policy / geography ─────────────────────────────────────────────────────

export function readPolicy(policyPath = POLICY_PATH) {
  return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
}

/** City names from a policy object (or a bare array of names/objects). */
export function policyCities(policy) {
  const list = Array.isArray(policy) ? policy : (policy && policy.cities) || [];
  return list
    .map((c) => (typeof c === 'string' ? c : c && c.name))
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim());
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * First policy city named in `text` (case-insensitive, whole words; any
 * punctuation counts as a space so "Rowlett," and "/fort-worth/" both match).
 * Earliest mention wins; ties go to the longer name. null when none match.
 */
export function findCity(text, cities) {
  const haystack = normalizeText(text);
  if (!haystack) return null;
  let best = null;
  for (const name of policyCities(cities)) {
    const needle = normalizeText(name);
    if (!needle) continue;
    const idx = haystack.search(new RegExp(`\\b${escapeRegExp(needle)}\\b`));
    if (idx === -1) continue;
    if (!best || idx < best.idx || (idx === best.idx && needle.length > best.needle.length)) {
      best = { idx, needle, name };
    }
  }
  return best ? best.name : null;
}

/** First city found scanning the given texts in order (hook before body). */
export function inferCity(texts, cities) {
  for (const text of texts) {
    const city = findCity(text, cities);
    if (city) return city;
  }
  return null;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function toDate(now) {
  return now instanceof Date ? now : new Date(now);
}

const CHICAGO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * Calendar date (YYYY-MM-DD) of the instant in America/Chicago, the timezone
 * every post_date in weekly_posts is written in (DESIGN.md week rule).
 */
export function chicagoDate(now) {
  const parts = Object.fromEntries(CHICAGO_FMT.formatToParts(toDate(now)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Positive finite week count, else the default. */
export function normalizeWeeks(weeks, fallback = DEFAULT_WEEKS) {
  const n = Number(weeks);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Positive integer row limit (floored), else the default; never passes 0/NaN/negative to `.limit()`. */
export function normalizeLimit(limit, fallback = ROW_LIMIT) {
  const n = Number(limit);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Chicago calendar date of `now` minus `weeks*7` days, as YYYY-MM-DD. */
export function sinceDate(now, weeks) {
  const w = normalizeWeeks(weeks);
  const todayMs = Date.parse(`${chicagoDate(now)}T00:00:00Z`);
  return new Date(todayMs - w * 7 * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD from a date string / timestamp / Date, else null. */
export function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (ISO_DATE.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/** One weekly_posts row → the compact history post (city inferred from text). */
export function normalizePost(row, cities) {
  const r = row && typeof row === 'object' ? row : {};
  const hook = textOrNull(r.hook);
  return {
    platform: textOrNull(r.platform),
    post_date: toIsoDate(r.post_date),
    service: textOrNull(r.service),
    hook,
    status: textOrNull(r.status),
    platform_post_id: textOrNull(r.platform_post_id),
    photo_file: textOrNull(r.photo_file),
    city: inferCity([hook, r.body, r.hashtags], cities),
    type: textOrNull(r.type),
    day: intOrNull(r.day),
  };
}

/** One website_tasks row → the compact history task. */
export function normalizeTask(row) {
  const r = row && typeof row === 'object' ? row : {};
  const updated = r.updated_at === null || r.updated_at === undefined ? null : String(r.updated_at);
  return {
    title: textOrNull(r.title),
    type: textOrNull(r.type),
    status: textOrNull(r.status),
    updated_at: updated,
  };
}

function shortHash(parts) {
  return createHash('sha1').update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|')).digest('hex').slice(0, 12);
}

export function postObservation(post, { attemptId, retrievedAt, index }) {
  const date = post.post_date;
  return {
    id: `hist:post:${shortHash([index, post.platform, date, post.platform_post_id, post.hook])}`,
    attempt_id: attemptId,
    source: SOURCE,
    scope: post.platform_post_id || `${post.platform || 'unknown'}:${date || 'undated'}:${index}`,
    geography: post.city,
    period: date ? { start: date, end: date } : null,
    status: 'ok',
    metric: METRIC_POST,
    value: post,
    raw_ref: `supabase:${POSTS_TABLE}:${post.platform_post_id || ''}`,
    retrieved_at: retrievedAt,
    note: null,
  };
}

export function taskObservation(task, { attemptId, retrievedAt, index }) {
  return {
    id: `hist:task:${shortHash([index, task.title, task.updated_at])}`,
    attempt_id: attemptId,
    source: SOURCE,
    scope: task.title || `task:${index}`,
    geography: null,
    period: null,
    status: 'ok',
    metric: METRIC_TASK,
    value: task,
    raw_ref: `supabase:${TASKS_TABLE}`,
    retrieved_at: retrievedAt,
    note: null,
  };
}

export function summaryObservation({ attemptId, retrievedAt, table, rows, weeks, since, today }) {
  return {
    id: `hist:summary:${table}`,
    attempt_id: attemptId,
    source: SOURCE,
    scope: table,
    geography: null,
    period: { start: since, end: today },
    status: 'ok',
    metric: METRIC_SUMMARY,
    value: { table, rows, weeks, since },
    raw_ref: `supabase:${table}`,
    retrieved_at: retrievedAt,
    note: null,
  };
}

export function unavailableObservation({ attemptId, retrievedAt, table, note }) {
  return {
    id: `hist:unavailable:${table}`,
    attempt_id: attemptId,
    source: SOURCE,
    scope: table,
    geography: null,
    period: null,
    status: 'unavailable',
    metric: METRIC_SUMMARY,
    value: null,
    raw_ref: null,
    retrieved_at: retrievedAt,
    note,
  };
}

// ── Supabase read ──────────────────────────────────────────────────────────

/**
 * The exact chain used for both tables (tests mock precisely this):
 *   from(table).select(columns).gte(column, since).order(column, { ascending: false }).limit(limit)
 * Throws on a supabase error result or a client without the chain.
 */
export async function selectRows(supabase, { table, columns, column, since, limit = ROW_LIMIT }) {
  if (!supabase || typeof supabase.from !== 'function') throw new Error('no supabase client');
  const result = await supabase
    .from(table)
    .select(columns)
    .gte(column, since)
    .order(column, { ascending: false })
    .limit(limit);
  if (result && result.error) {
    throw new Error(result.error.message || String(result.error));
  }
  return Array.isArray(result && result.data) ? result.data : [];
}

// ── I/O entry point ────────────────────────────────────────────────────────

/**
 * collectHistory({ attemptId, supabase, now, weeks = 8 }) → { observations, history }
 *
 * Extra optional inputs: `policy` (parsed weekly-policy; read from disk when
 * absent, used only for city names), `taskWeeks` (default 12), `limit` rows
 * per table (default 500).
 */
export async function collectHistory({
  attemptId,
  supabase,
  now = new Date(),
  weeks = DEFAULT_WEEKS,
  policy,
  taskWeeks = TASK_WEEKS,
  limit = ROW_LIMIT,
} = {}) {
  const nowDate = toDate(now);
  if (Number.isNaN(nowDate.getTime())) throw new TypeError(`collectHistory: now is not a valid date (${String(now)})`);
  const retrievedAt = nowDate.toISOString();
  const today = chicagoDate(nowDate);
  const observations = [];
  const history = { posts: [], website_tasks: [] };

  let cities = [];
  try {
    cities = policyCities(policy ?? readPolicy());
  } catch {
    cities = [];
  }

  const rowLimit = normalizeLimit(limit, ROW_LIMIT);
  const postWeeks = normalizeWeeks(weeks, DEFAULT_WEEKS);
  const postsSince = sinceDate(nowDate, postWeeks);
  try {
    const rows = await selectRows(supabase, {
      table: POSTS_TABLE, columns: POST_COLUMNS, column: 'post_date', since: postsSince, limit: rowLimit,
    });
    history.posts = rows.map((row) => normalizePost(row, cities));
    history.posts.forEach((post, index) => observations.push(postObservation(post, { attemptId, retrievedAt, index })));
    observations.push(summaryObservation({
      attemptId, retrievedAt, table: POSTS_TABLE, rows: history.posts.length, weeks: postWeeks, since: postsSince, today,
    }));
  } catch (err) {
    observations.push(unavailableObservation({
      attemptId, retrievedAt, table: POSTS_TABLE, note: `${POSTS_TABLE} unavailable: ${err && err.message ? err.message : String(err)}`,
    }));
  }

  const taskWeeksN = normalizeWeeks(taskWeeks, TASK_WEEKS);
  const tasksSince = sinceDate(nowDate, taskWeeksN);
  try {
    const rows = await selectRows(supabase, {
      table: TASKS_TABLE, columns: TASK_COLUMNS, column: 'updated_at', since: tasksSince, limit: rowLimit,
    });
    history.website_tasks = rows.map((row) => normalizeTask(row));
    history.website_tasks.forEach((task, index) => observations.push(taskObservation(task, { attemptId, retrievedAt, index })));
    observations.push(summaryObservation({
      attemptId, retrievedAt, table: TASKS_TABLE, rows: history.website_tasks.length, weeks: taskWeeksN, since: tasksSince, today,
    }));
  } catch (err) {
    observations.push(unavailableObservation({
      attemptId, retrievedAt, table: TASKS_TABLE, note: `${TASKS_TABLE} unavailable: ${err && err.message ? err.message : String(err)}`,
    }));
  }

  return { observations, history };
}
