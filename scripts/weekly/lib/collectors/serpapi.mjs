/**
 * collectors/serpapi.mjs
 * SerpApi (engine=google) collector for the weekly pipeline.
 *
 * `buildSerpQueries(policy)` expands `services[].query_templates × cities`
 * (cities filtered by `serp.city_tiers`) into a deterministic, deduplicated
 * list capped at `serp.max_queries`. Order is template rank → city (policy
 * order) → service (policy order), so the cap keeps breadth: with the default
 * cap of 60 every service gets its first template for the first five cities
 * instead of one service getting every city.
 *
 * `collectSerp` serves each query from `<cacheDir>/<sha1>.json` when the entry
 * is younger than `cacheDays`, otherwise makes a live call (until `maxCalls`
 * live calls, the meter's budget ceiling, or a missing API key stops it) and
 * writes the cache entry `{ query, location, fetched_at, response }`. Raw
 * SerpApi dumps like state/weekly/research/serp/*.json (response at top level
 * with `_fetched_at`) are also accepted as cache entries so research pulls can
 * be seeded into the cache.
 *
 * One `serpapi` observation per query: `ok` with the parsed SERP value,
 * `unavailable` (cap / budget / key) or `error` (HTTP, timeout, SerpApi
 * error payload). Never throws. The API key is never placed on an
 * observation, a note, a cache file or a meter entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { SERP_CACHE_DIR } from '../paths.mjs';
import { findCity, policyCities, readPolicy } from './history.mjs';

export const SOURCE = 'serpapi';
export const METRIC = 'serp';
export const SERPAPI_URL = 'https://serpapi.com/search.json';
export const DEFAULT_LOCATION = 'Dallas-Fort Worth, Texas, United States';
export const DEFAULT_CACHE_DAYS = 7;
export const DEFAULT_MAX_CALLS = 60;
export const DEFAULT_MAX_QUERIES = 60;
export const DEFAULT_NUM = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** The only website domain (knowledge/baselines/grizzly-business-facts.md). */
export const GRIZZLY_DOMAIN = 'grizzlyelectricaltx.com';
export const GRIZZLY_NAME_PATTERN = /grizzly/i;
export const NOTE_CAP_REACHED = 'cap reached';
export const NOTE_NO_API_KEY = 'SERPAPI_API_KEY not configured';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Query building ─────────────────────────────────────────────────────────

export function normalizeQuery(query) {
  return String(query || '').replace(/\s+/g, ' ').trim();
}

export function fillTemplate(template, city) {
  return normalizeQuery(String(template || '').replace(/\{city\}/gi, city));
}

/** Policy city names whose tier is in `serp.city_tiers` (all when unset/empty). */
export function serpCities(policy) {
  const serp = (policy && policy.serp) || {};
  const tiers = new Set((Array.isArray(serp.city_tiers) ? serp.city_tiers : []).map(Number));
  const cities = (policy && Array.isArray(policy.cities)) ? policy.cities : [];
  return cities
    .filter((c) => c && typeof c.name === 'string' && c.name.trim() !== '')
    .filter((c) => tiers.size === 0 || tiers.has(Number(c.tier)))
    .map((c) => c.name.trim());
}

/**
 * A cap: finite non-negative numbers are floored (1.9 → 1), anything else
 * (undefined, NaN, negative, Infinity) is the fallback. Never rounds a cap up.
 */
function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Accept a RegExp or a string for the local-pack name pattern; drop the `g`
 * and `y` flags, whose `lastIndex` state would make repeated `.test` calls
 * alternate between true and false.
 */
export function normalizePattern(pattern, fallback = GRIZZLY_NAME_PATTERN) {
  if (pattern instanceof RegExp) return /[gy]/.test(pattern.flags) ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')) : pattern;
  if (typeof pattern === 'string' && pattern.trim() !== '') return new RegExp(pattern, 'i');
  return fallback;
}

const CITY_PLACEHOLDER = /\{city\}/i;

/**
 * buildSerpQueries(policy) → [{ query, service_key, city, template }]
 * Deterministic: template rank, then city (policy order, tier-filtered), then
 * service (policy order). Duplicate query strings (case-insensitive) drop.
 * Capped to `serp.max_queries`. A template without a `{city}` placeholder is
 * not city-specific: it is emitted once with `city: null`.
 */
export function buildSerpQueries(policy) {
  const services = (policy && Array.isArray(policy.services)) ? policy.services : [];
  const cities = serpCities(policy);
  const maxQueries = nonNegativeInt(policy && policy.serp && policy.serp.max_queries, DEFAULT_MAX_QUERIES);
  if (maxQueries === 0) return [];
  const templateCounts = services.map((s) => (s && Array.isArray(s.query_templates) ? s.query_templates.length : 0));
  const maxTemplates = templateCounts.length ? Math.max(...templateCounts) : 0;
  const seen = new Set();
  const out = [];
  for (let rank = 0; rank < maxTemplates; rank++) {
    for (const city of cities) {
      for (const service of services) {
        const template = service && Array.isArray(service.query_templates) ? service.query_templates[rank] : undefined;
        if (typeof template !== 'string' || template.trim() === '') continue;
        const query = fillTemplate(template, city);
        if (!query || seen.has(query.toLowerCase())) continue;
        seen.add(query.toLowerCase());
        out.push({ query, service_key: service.key ?? null, city: CITY_PLACEHOLDER.test(template) ? city : null, template });
        if (out.length >= maxQueries) return out;
      }
    }
  }
  return out;
}

/** A non-empty trimmed string, else null (descriptor fields feed `geography`, which must be string|null). */
function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' ? null : s;
}

/** Accept strings or descriptors; drop empties; non-string descriptor fields become null. */
export function normalizeQueries(queries) {
  return (Array.isArray(queries) ? queries : [])
    .map((q) => (typeof q === 'string' ? { query: q } : q))
    .filter((q) => q && typeof q === 'object' && normalizeQuery(q.query) !== '')
    .map((q) => ({
      query: normalizeQuery(q.query),
      service_key: stringOrNull(q.service_key),
      city: stringOrNull(q.city),
      template: stringOrNull(q.template),
    }));
}

// ── Cache ──────────────────────────────────────────────────────────────────

/** sha1 of the normalized query and the location. */
export function cacheKey(query, location) {
  return createHash('sha1')
    .update(`${normalizeQuery(query).toLowerCase()}|${String(location || '').trim()}`)
    .digest('hex');
}

export function cachePath(cacheDir, key) {
  return path.join(cacheDir, `${key}.json`);
}

/**
 * Read one cache entry: the documented wrapper `{ query, location, fetched_at,
 * response }`, or a raw SerpApi dump (`_fetched_at` at top level). null when
 * missing, unparsable, or neither shape.
 */
export function readCacheEntry(cacheDir, key) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath(cacheDir, key), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.response && typeof parsed.response === 'object') {
    return { query: parsed.query ?? null, location: parsed.location ?? null, fetched_at: parsed.fetched_at ?? null, response: parsed.response };
  }
  if (Array.isArray(parsed.organic_results) || (parsed.search_parameters && typeof parsed.search_parameters === 'object')) {
    const params = parsed.search_parameters || {};
    return {
      query: parsed._query ?? params.q ?? null,
      location: params.location_requested ?? null,
      fetched_at: parsed._fetched_at ?? null,
      response: parsed,
    };
  }
  return null;
}

/** true when `fetchedAt` is parsable and at most `cacheDays` days before `now`. */
export function isFresh(fetchedAt, { now, cacheDays }) {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return false;
  const days = Number(cacheDays);
  if (!Number.isFinite(days) || days <= 0) return false;
  return now.getTime() - t <= days * DAY_MS;
}

/**
 * A SerpApi payload that carries `error` and no organic results (e.g. "Google
 * hasn't returned any results for this query."). Never cached by collectSerp,
 * and a seeded dump of one is treated as a miss so it is refetched.
 */
export function isErrorPayload(response) {
  return !!(response && typeof response === 'object' && response.error && !Array.isArray(response.organic_results));
}

let tmpCounter = 0;

/** Atomic write (tmp + rename) of the documented cache shape; no tmp file survives a failure. */
export function writeCacheEntry(cacheDir, key, { query, location, fetched_at, response }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = cachePath(cacheDir, key);
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ query, location, fetched_at, response }, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return file;
}

// ── Response parsing ───────────────────────────────────────────────────────

export function domainOf(link) {
  try {
    return new URL(String(link)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Numeric value from a number or a string like "4.9" / "1,500"; null when no digits. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const digits = value.replace(/[^0-9.-]/g, '');
    if (!/\d/.test(digits)) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `local_results` is `{ places: [...] }` on most SERPs; tolerate a bare array. */
export function localPlaces(localResults) {
  if (Array.isArray(localResults)) return localResults.filter((p) => p && typeof p === 'object');
  if (localResults && Array.isArray(localResults.places)) return localResults.places.filter((p) => p && typeof p === 'object');
  return [];
}

export function isGrizzlyDomain(domain, grizzlyDomain = GRIZZLY_DOMAIN) {
  const d = String(domain || '').toLowerCase();
  const g = String(grizzlyDomain || '').toLowerCase();
  return g !== '' && (d === g || d.endsWith(`.${g}`));
}

/**
 * SerpApi JSON → the observation value:
 * { organic: [{ position, title, link, domain }], paa: string[],
 *   local_pack: [{ title, rating, reviews }], grizzly_organic_position, grizzly_in_local_pack }
 * Organic detection is by website domain; local-pack detection by place name
 * or the place's website link.
 */
export function parseSerpResponse(response, { grizzlyDomain = GRIZZLY_DOMAIN, grizzlyPattern = GRIZZLY_NAME_PATTERN } = {}) {
  const r = response && typeof response === 'object' ? response : {};
  const pattern = normalizePattern(grizzlyPattern);
  const organic = (Array.isArray(r.organic_results) ? r.organic_results : [])
    .map((row, i) => {
      const o = row && typeof row === 'object' ? row : {};
      const link = typeof o.link === 'string' ? o.link : '';
      const position = toNumber(o.position);
      return { position: position === null ? i + 1 : position, title: String(o.title || ''), link, domain: domainOf(link) };
    });
  const paa = (Array.isArray(r.related_questions) ? r.related_questions : [])
    .map((q) => (q && typeof q.question === 'string' ? q.question.trim() : ''))
    .filter((q) => q !== '');
  const places = localPlaces(r.local_results);
  const localPack = places.map((p) => ({ title: String(p.title || ''), rating: toNumber(p.rating), reviews: toNumber(p.reviews) }));
  const hit = organic.find((o) => isGrizzlyDomain(o.domain, grizzlyDomain));
  const inLocalPack = places.some((p) => pattern.test(String(p.title || ''))
    || isGrizzlyDomain(domainOf(p.links && p.links.website), grizzlyDomain));
  return {
    organic,
    paa,
    local_pack: localPack,
    grizzly_organic_position: hit ? hit.position : null,
    grizzly_in_local_pack: inLocalPack,
  };
}

// ── Observations ───────────────────────────────────────────────────────────

function observationId(key) {
  return `serp:${key.slice(0, 12)}`;
}

export function okObservation({ attemptId, retrievedAt, entry, key, geography, location, response, rawRef, fetchedAt, fromCache, grizzlyDomain, grizzlyPattern }) {
  return {
    id: observationId(key),
    attempt_id: attemptId,
    source: SOURCE,
    scope: entry.query,
    geography,
    period: null,
    status: 'ok',
    metric: METRIC,
    value: {
      query: entry.query,
      service_key: entry.service_key,
      city: entry.city,
      template: entry.template,
      location,
      from_cache: fromCache,
      fetched_at: fetchedAt,
      ...parseSerpResponse(response, { grizzlyDomain, grizzlyPattern }),
    },
    raw_ref: rawRef,
    retrieved_at: retrievedAt,
    note: null,
  };
}

export function failedObservation({ attemptId, retrievedAt, entry, key, geography, status, note }) {
  return {
    id: observationId(key),
    attempt_id: attemptId,
    source: SOURCE,
    scope: entry.query,
    geography,
    period: null,
    status,
    metric: METRIC,
    value: null,
    raw_ref: null,
    retrieved_at: retrievedAt,
    note,
  };
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export function buildSerpUrl({ query, location, apiKey, num = DEFAULT_NUM }) {
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    location,
    hl: 'en',
    gl: 'us',
    num: String(num),
    api_key: apiKey,
  });
  return `${SERPAPI_URL}?${params.toString()}`;
}

/**
 * Strip the key from anything that could land in a note: the raw key, its
 * `encodeURIComponent` form, and its form-encoded form (what `buildSerpUrl`
 * actually puts in the URL via URLSearchParams — space → `+`, `~!'()*`
 * percent-encoded), since an error message may echo the request URL.
 */
export function redact(text, apiKey) {
  let s = String(text || '');
  if (!apiKey) return s;
  const key = String(apiKey);
  const needles = new Set([key, encodeURIComponent(key), new URLSearchParams([['k', key]]).toString().slice(2)]);
  for (const needle of needles) {
    if (needle) s = s.split(needle).join('[redacted]');
  }
  return s;
}

/**
 * GET the URL and parse JSON. The timeout aborts through the signal and also
 * races the request, so a fetch implementation that ignores `signal` cannot
 * hang the collector. `onResponse(response)` runs once a 2xx has arrived and
 * before the body is read (SerpApi bills the search at that point, whatever
 * the body turns out to be); it is skipped for a response that lands after
 * the timeout has already settled the call.
 */
export async function fetchSerpJson({ url, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, onResponse }) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const controller = new AbortController();
  const { signal } = controller;
  let settled = false;
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`SerpApi request timed out after ${timeoutMs} ms`)), timeoutMs)
    : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  let onAbort = null;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('SerpApi request aborted'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {}); // observed by the race below; never an unhandled rejection
  const request = (async () => {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal });
    if (!response || typeof response !== 'object') throw new Error('fetch returned no response');
    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch { body = ''; }
      const error = new Error(`SerpApi HTTP ${response.status}: ${String(body).slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    if (!settled && typeof onResponse === 'function') onResponse(response);
    return await response.json();
  })();
  try {
    return await Promise.race([request, aborted]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    request.catch(() => {}); // a late failure after the race has settled is not unhandled
  }
}

// ── I/O entry point ────────────────────────────────────────────────────────

/**
 * collectSerp({ attemptId, queries, cacheDir = SERP_CACHE_DIR, cacheDays, maxCalls, apiKey, location, now, fetchImpl, meter })
 *   → Observation[]
 *
 * Extra optional inputs: `policy` (parsed weekly-policy; read from disk when
 * absent — supplies queries, serp defaults, city names and the per-call
 * price), `env` (defaults to process.env; only SERPAPI_API_KEY is read),
 * `timeoutMs`, `pricePerCall`, `grizzlyDomain`, `grizzlyPattern`.
 *
 * Cached hits never count toward `maxCalls` and are still served after the
 * cap. Live calls are sequential (deterministic order, gentle on the API).
 * A live call is recorded in the meter as `kind: 'serpapi'` on every HTTP
 * 2xx (SerpApi bills those; failed requests are not billed).
 */
export async function collectSerp({
  attemptId,
  queries,
  cacheDir = SERP_CACHE_DIR,
  cacheDays,
  maxCalls,
  apiKey,
  location,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  meter,
  policy,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pricePerCall,
  grizzlyDomain = GRIZZLY_DOMAIN,
  grizzlyPattern = GRIZZLY_NAME_PATTERN,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new TypeError(`collectSerp: now is not a valid date (${String(now)})`);
  const retrievedAt = nowDate.toISOString();
  const observations = [];

  let pol = policy;
  if (!pol) {
    try {
      pol = readPolicy();
    } catch (err) {
      pol = {};
      if (queries === undefined) {
        observations.push(failedObservation({
          attemptId, retrievedAt, entry: { query: 'policy' }, key: createHash('sha1').update('policy').digest('hex'),
          geography: null, status: 'unavailable', note: `policy unreadable: ${err && err.message ? err.message : String(err)}`,
        }));
        return observations;
      }
    }
  }
  const serp = pol.serp || {};
  const rawKey = apiKey ?? (env && env.SERPAPI_API_KEY) ?? null;
  const settings = {
    cacheDays: cacheDays ?? serp.cache_days ?? DEFAULT_CACHE_DAYS,
    maxCalls: nonNegativeInt(maxCalls ?? serp.max_calls, DEFAULT_MAX_CALLS),
    location: String(location ?? serp.location ?? DEFAULT_LOCATION),
    pricePerCall: pricePerCall ?? (pol.pricing && typeof pol.pricing.serpapi_per_call === 'number' ? pol.pricing.serpapi_per_call : undefined),
    // A blank or whitespace-only key is "not configured", not a key to send.
    apiKey: rawKey === null || rawKey === undefined ? null : (String(rawKey).trim() || null),
  };
  const cities = policyCities(pol);
  const list = normalizeQueries(queries === undefined ? buildSerpQueries(pol) : queries);

  const seen = new Set();
  let liveCalls = 0;
  let stopNote = null;
  for (const entry of list) {
    const key = cacheKey(entry.query, settings.location);
    if (seen.has(key)) continue;
    seen.add(key);
    const base = { attemptId, retrievedAt, entry, key, geography: entry.city || findCity(entry.query, cities) };

    const cached = readCacheEntry(cacheDir, key);
    if (cached && !isErrorPayload(cached.response) && isFresh(cached.fetched_at, { now: nowDate, cacheDays: settings.cacheDays })) {
      // Never throw out of a collector: a cache entry that cannot be turned
      // into an observation is reported as an error, not refetched (the
      // failure is in parsing, not in the data, so a live call would not help).
      try {
        observations.push(okObservation({
          ...base, location: settings.location, response: cached.response, rawRef: `cache:${key}`,
          fetchedAt: cached.fetched_at, fromCache: true, grizzlyDomain, grizzlyPattern,
        }));
      } catch (err) {
        observations.push(failedObservation({
          ...base, status: 'error', note: redact(`cache entry unusable: ${err && err.message ? err.message : String(err)}`, settings.apiKey),
        }));
      }
      continue;
    }

    if (!stopNote && !settings.apiKey) stopNote = NOTE_NO_API_KEY;
    if (!stopNote && liveCalls >= settings.maxCalls) stopNote = NOTE_CAP_REACHED;
    if (!stopNote && meter && typeof meter.assertUnder === 'function') {
      try {
        meter.assertUnder(settings.pricePerCall ?? 0);
      } catch (err) {
        stopNote = `budget reached: ${err && err.message ? err.message : String(err)}`;
      }
    }
    if (stopNote) {
      observations.push(failedObservation({ ...base, status: 'unavailable', note: stopNote }));
      continue;
    }

    liveCalls += 1;
    try {
      const url = buildSerpUrl({ query: entry.query, location: settings.location, apiKey: settings.apiKey });
      const response = await fetchSerpJson({
        url, fetchImpl, timeoutMs,
        // Metered as soon as the 2xx arrives: SerpApi bills it even when the body is unusable.
        onResponse: () => {
          if (meter && typeof meter.record === 'function') {
            meter.record({ kind: 'serpapi', model: null, usd: settings.pricePerCall, label: entry.query });
          }
        },
      });
      if (!response || typeof response !== 'object') throw new Error('SerpApi returned a non-object response');
      if (isErrorPayload(response)) throw new Error(`SerpApi error: ${response.error}`);
      let cacheNote = null;
      try {
        writeCacheEntry(cacheDir, key, { query: entry.query, location: settings.location, fetched_at: retrievedAt, response });
      } catch (err) {
        cacheNote = `cache write failed: ${err && err.message ? err.message : String(err)}`;
      }
      const obs = okObservation({
        ...base, location: settings.location, response, rawRef: `serpapi:${key}`,
        fetchedAt: retrievedAt, fromCache: false, grizzlyDomain, grizzlyPattern,
      });
      if (cacheNote) obs.note = redact(cacheNote, settings.apiKey);
      observations.push(obs);
    } catch (err) {
      observations.push(failedObservation({
        ...base, status: 'error', note: redact(err && err.message ? err.message : String(err), settings.apiKey),
      }));
    }
  }
  return observations;
}
