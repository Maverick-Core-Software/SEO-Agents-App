/**
 * select.mjs
 * Weekly topic selection: rank every (service × city) candidate from the
 * collected observations and the published history, pick a winner, and say
 * why. Pure functions only — no I/O, no clock, no network. Every date comes
 * from `weekSpec`.
 *
 * Contract: scripts/weekly/DESIGN.md, "select". Scores are in [0, 1]:
 *   priority     policy.services[].priority (1–5 → 0.2–1.0)
 *   demand       Search Console impressions for the family (28d) / max across
 *                candidates, +0.2 when SerpApi shows People Also Ask
 *   opportunity  1.0 when the family's average position is 8–30, 0.6 beyond
 *                30, 0.3 above 8, 0 with no data; +0.2 when the local pack for
 *                the city lacks Grizzly (capped at 1)
 *   recency      1.0 never published, 0.5 same service in the recency window,
 *                0.1 same service and city
 *   season       policy.services[].season[month] (default 0.5)
 *   performance  Facebook / Search Console engagement joined to history posts
 *                of the same service, normalized (0.5 when unknown)
 *   total        Σ weights[k] × score[k], multiplied by the city weight
 *
 * Family membership: a Search Console or SerpApi query belongs to a service
 * when it contains at least half of the tokens of one of that service's query
 * templates (or its label), generic words removed; the most specific service
 * wins (tokens shared by several services, like "electrical", weigh less than
 * tokens unique to one). A query that names no city counts for every city of
 * the service; a query that names a city counts only for that city. City
 * detection follows the collectors' rule: earliest mention wins.
 *
 * History weeks: a post belongs to a week by its own platform's calendar —
 * GBP weeks start on run_friday, Facebook weeks on week_of (the Monday), so
 * last week's Friday and Saturday Facebook posts, dated on or after this
 * run_friday, still count as last week's.
 */

/** Score keys in the order they appear in CandidateSchema. */
export const SCORE_KEYS = Object.freeze(['priority', 'demand', 'opportunity', 'recency', 'season', 'performance']);

/** Fallback weights. The live values come from policy.weights. */
export const DEFAULT_WEIGHTS = Object.freeze({
  priority: 0.25, demand: 0.2, opportunity: 0.25, recency: 0.15, season: 0.05, performance: 0.1,
});

/**
 * Thresholds from DESIGN.md. `policy.recency_weeks` always wins for
 * recency_weeks; a policy may override any other value under `policy.selection`.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  priority_min: 1,
  priority_max: 5,
  paa_bonus: 0.2,
  position_page_one_bottom: 8,
  position_page_three: 30,
  opportunity_in_range: 1.0,
  opportunity_beyond: 0.6,
  opportunity_above: 0.3,
  opportunity_no_data: 0,
  local_pack_bonus: 0.2,
  recency_same_service: 0.5,
  recency_same_service_city: 0.1,
  recency_never: 1.0,
  recency_weeks: 4,
  season_default: 0.5,
  performance_unknown: 0.5,
  degraded_fallback: 0.5,
  exclusion_weeks: 2,
  // A week's "winner" is inferred only when one service clearly dominates it:
  // at least this many posts and no other service tied. Legacy weeks rotate
  // seven GBP services and reuse up to four of them on Facebook, so any
  // service tops out at 2 there; the new pipeline puts the topic on ≥ 3 GBP
  // days plus most Facebook posts.
  exclusion_min_posts: 3,
  short_window_max_days: 35,
  default_window_days: 28,
  ctr_min_impressions: 10,
  match_min_ratio: 0.5,
});

/** Words that carry no service meaning in a query, a label, or a template. */
const GENERIC_TERMS = new Set([
  'tx', 'texas', 'near', 'me', 'in', 'the', 'a', 'an', 'and', 'for', 'of', 'to',
  'install', 'installation', 'installer', 'installers', 'home', 'house',
  'cost', 'costs', 'price', 'prices', 'best', 'top', 'local', 'service', 'services',
  'company', 'companies', 'residential',
]);

/**
 * weekly_posts statuses that mean the post never went out. The workers only
 * act on `approved` rows (gbp-runner / gbp-worker CAS on status='approved'),
 * so a past week still at `pending_approval` was never published.
 */
const UNPUBLISHED_STATUS = /^(error|failed|rejected|skipped|dismissed|validation_failed|dry_run|cancel|pending|draft|expired)/i;

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Policy constants

/** Weights and thresholds, read from policy with DESIGN.md defaults. */
export function selectionConstants(policy = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(policy.weights || {}) };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(policy.selection || {}) };
  if (Number.isFinite(policy.recency_weeks)) thresholds.recency_weeks = policy.recency_weeks;
  return { weights, thresholds };
}

/** priority 1–5 → 0.2–1.0 (clamped). */
export function priorityScore(priority, thresholds = DEFAULT_THRESHOLDS) {
  const max = thresholds.priority_max;
  const n = Number(priority);
  if (!Number.isFinite(n) || max <= 0) return thresholds.priority_min / max;
  return clamp(Math.min(Math.max(n, thresholds.priority_min), max) / max);
}

/** Opportunity from an impressions-weighted average position (null = no data). */
export function opportunityFromPosition(position, thresholds = DEFAULT_THRESHOLDS) {
  if (position == null || !Number.isFinite(position)) return thresholds.opportunity_no_data;
  if (position < thresholds.position_page_one_bottom) return thresholds.opportunity_above;
  if (position > thresholds.position_page_three) return thresholds.opportunity_beyond;
  return thresholds.opportunity_in_range;
}

// ---------------------------------------------------------------------------
// Text helpers

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function clamp(n) {
  return Math.min(1, Math.max(0, n));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A Search Console position as a number, or null when there is none. Google
 * positions start at 1; the collector writes 0 when the API omitted the field,
 * so a non-positive value is "no position data", not "top of page 1".
 */
function positionOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function cityNames(cities) {
  return (cities || []).map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
}

/**
 * First policy city named in `text` (whole words; punctuation counts as a
 * space) or null. Earliest mention wins, ties go to the longer name — the same
 * rule as `findCity` in the collectors, so a city inferred here agrees with
 * the `geography` a collector would have tagged.
 */
export function detectCity(text, cities = []) {
  const hay = ` ${tokens(text).join(' ')} `;
  let best = null;
  for (const name of cityNames(cities)) {
    const needle = ` ${tokens(name).join(' ')} `;
    if (!needle.trim()) continue;
    const idx = hay.indexOf(needle);
    if (idx === -1) continue;
    if (!best || idx < best.idx || (idx === best.idx && needle.length > best.needle.length)) best = { idx, needle, name };
  }
  return best ? best.name : null;
}

/**
 * Map free text (a search query, a history post's service label, a hook) to a
 * policy service key. Each service owns a set of token "cores" built from its
 * label and query templates; the core with the most matched tokens wins, ties
 * broken by token specificity (a token found in the cores of n services
 * weighs 1/n, so "commercial" outranks "electrical"), then match ratio, then
 * policy order.
 */
export function createServiceMatcher(policy = {}, thresholds = DEFAULT_THRESHOLDS) {
  const cityTokens = new Set(cityNames(policy.cities).flatMap(tokens));
  const minRatio = thresholds.match_min_ratio;
  const services = (policy.services || []).map((s) => {
    const seen = new Set();
    const cores = [];
    for (const phrase of [s.label, ...(s.query_templates || [])]) {
      const core = tokens(String(phrase || '').replace(/\{city\}/gi, ' ')).filter((t) => !GENERIC_TERMS.has(t));
      const sig = core.join(' ');
      if (!core.length || seen.has(sig)) continue;
      seen.add(sig);
      cores.push(core);
    }
    return { key: s.key, cores };
  });
  const keys = new Set(services.map((s) => s.key));
  const serviceCount = new Map(); // token → number of services whose cores use it
  for (const s of services) {
    for (const t of new Set(s.cores.flat())) serviceCount.set(t, (serviceCount.get(t) || 0) + 1);
  }
  const specificity = (t) => 1 / (serviceCount.get(t) || 1);

  function match(text) {
    const present = new Set(tokens(text).filter((t) => !cityTokens.has(t) && !GENERIC_TERMS.has(t)));
    if (!present.size) return null;
    let best = null;
    for (const s of services) {
      for (const core of s.cores) {
        const matched = core.filter((t) => present.has(t));
        const hits = matched.length;
        const ratio = hits / core.length;
        if (!hits || ratio < minRatio) continue;
        const weight = matched.reduce((acc, t) => acc + specificity(t), 0);
        if (!best || hits > best.hits
          || (hits === best.hits && (weight > best.weight || (weight === best.weight && ratio > best.ratio)))) {
          best = { key: s.key, hits, weight, ratio };
        }
      }
    }
    return best ? best.key : null;
  }

  return { match, isKey: (k) => keys.has(k) };
}

// ---------------------------------------------------------------------------
// Date helpers (UTC day arithmetic on YYYY-MM-DD strings; no clock)

function parseDay(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? parseDay(value.toISOString()) : null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function daysBetween(fromMs, toMs) {
  return Math.round((toMs - fromMs) / DAY_MS);
}

function periodDays(period) {
  if (!period) return null;
  const start = parseDay(period.start);
  const end = parseDay(period.end);
  if (start == null || end == null) return null;
  return daysBetween(start, end) + 1;
}

// ---------------------------------------------------------------------------
// Candidates

function queryFamily(service, city) {
  const out = [];
  for (const template of service.query_templates || []) {
    const q = String(template).replace(/\{city\}/gi, city).toLowerCase().replace(/\s+/g, ' ').trim();
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

/**
 * Candidate skeletons for services × cities. `cityTiers` (an array of tier
 * numbers) limits the cities; default: `policy.selection.city_tiers` if set,
 * otherwise every city in the policy. Tiers are compared numerically and an
 * empty list means no filter, the same reading as `serp.city_tiers` in the
 * SerpApi collector.
 */
export function buildCandidates(policy = {}, { cityTiers = null } = {}) {
  const { thresholds } = selectionConstants(policy);
  const tiers = [cityTiers, policy.selection && policy.selection.city_tiers]
    .map((list) => (Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : []))
    .find((list) => list.length) || null;
  const allowed = tiers ? new Set(tiers) : null;
  const cities = (policy.cities || []).filter((c) => c && c.name && (!allowed || allowed.has(Number(c.tier))));
  const out = [];
  for (const service of policy.services || []) {
    if (!service || !service.key) continue;
    for (const city of cities) {
      out.push({
        service_key: service.key,
        service_label: service.label || service.key,
        city: city.name,
        query_family: queryFamily(service, city.name),
        scores: {
          priority: priorityScore(service.priority, thresholds),
          demand: 0,
          opportunity: 0,
          recency: thresholds.recency_never,
          season: thresholds.season_default,
          performance: thresholds.performance_unknown,
        },
        total: 0,
        reasons: [],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Observation and history indexes

function indexObservations(observations, policy, matcher, thresholds) {
  const sources = { search_console: false, serpapi: false, facebook: false };
  const scPure = [];
  const scPage = [];
  const serp = [];
  const facebook = new Map();

  for (const obs of observations || []) {
    if (!obs || typeof obs !== 'object' || !(obs.source in sources)) continue;
    if (obs.status !== 'ok') continue;
    const value = obs.value && typeof obs.value === 'object' ? obs.value : {};

    if (obs.source === 'search_console') {
      if (obs.metric && obs.metric !== 'search_analytics') continue;
      sources.search_console = true;
      const query = typeof value.query === 'string' ? value.query : obs.scope;
      if (!query || /^https?:\/\//i.test(query)) continue; // page-dimension rows
      const service = matcher.match(query);
      if (!service) continue;
      const row = {
        query,
        service,
        city: typeof obs.geography === 'string' && obs.geography ? obs.geography : detectCity(query, policy.cities),
        days: periodDays(obs.period),
        impressions: num(value.impressions),
        clicks: num(value.clicks),
        position: positionOrNull(value.position),
      };
      (value.page ? scPage : scPure).push(row);
    } else if (obs.source === 'serpapi') {
      if (obs.metric && obs.metric !== 'serp') continue;
      sources.serpapi = true;
      const query = typeof value.query === 'string' ? value.query : obs.scope;
      const service = typeof value.service_key === 'string' && matcher.isKey(value.service_key)
        ? value.service_key
        : matcher.match(query);
      const city = (typeof obs.geography === 'string' && obs.geography)
        || (typeof value.city === 'string' && value.city)
        || detectCity(query, policy.cities);
      const paa = Array.isArray(value.paa) && value.paa.length > 0;
      const packLacksGrizzly = value.grizzly_in_local_pack === false
        && !(Array.isArray(value.local_pack) && value.local_pack.length === 0);
      serp.push({ query, service, city, paa, packLacksGrizzly });
    } else if (obs.source === 'facebook') {
      sources.facebook = true;
      if (obs.scope) facebook.set(String(obs.scope), value);
    }
  }

  // Pure query rows are preferred; query+page rows would double count.
  const sc = scPure.length ? scPure : scPage;
  const isShort = (r) => r.days == null || r.days <= thresholds.short_window_max_days;
  const demandRows = sc.some(isShort) ? sc.filter(isShort) : sc;
  const windowDays = demandRows.reduce((max, r) => Math.max(max, r.days || 0), 0) || thresholds.default_window_days;
  return { sources, sc, demandRows, windowDays, serp, facebook };
}

/**
 * Published history posts with `daysBefore` counted back from the start of
 * this week's slots on the post's own platform: Facebook weeks start on
 * `week_of` (Monday), everything else on `run_friday` (GBP day 1). A post on
 * or after that start belongs to this week (or a re-run of it) and is ignored.
 */
function indexHistory(history, policy, matcher, { runFridayMs, weekOfMs }) {
  const posts = [];
  for (const post of (history && history.posts) || []) {
    if (!post || typeof post !== 'object') continue;
    if (UNPUBLISHED_STATUS.test(String(post.status || ''))) continue;
    const dayMs = parseDay(post.post_date);
    if (dayMs == null) continue;
    const platform = String(post.platform || '').toLowerCase();
    const daysBefore = daysBetween(dayMs, platform === 'facebook' ? weekOfMs : runFridayMs);
    if (daysBefore <= 0) continue; // this week's own slots or later
    const service = typeof post.service_key === 'string' && matcher.isKey(post.service_key)
      ? post.service_key
      : matcher.match(post.service) || matcher.match(post.hook);
    if (!service) continue;
    const city = (typeof post.city === 'string' && post.city)
      || detectCity(`${post.service || ''} ${post.hook || ''}`, policy.cities);
    posts.push({
      service,
      city,
      daysBefore,
      post_date: new Date(dayMs).toISOString().slice(0, 10),
      platform,
      platform_post_id: post.platform_post_id ? String(post.platform_post_id) : null,
    });
  }
  return posts;
}

/**
 * Services that "won" one of the last `exclusion_weeks` weeks: the single
 * most-posted service of that week when it has at least
 * `exclusion_min_posts` and no other service ties it (a legacy week rotates
 * seven GBP services and reuses some on Facebook, so it infers nothing), plus
 * any explicit `history.winners` in the window: `[{ week_of, service_key }]`
 * or a prior revision's `{ week_of, topic: { service_key } }` (`service_key`
 * may also be a service label).
 */
function recentWinners(posts, history, weekSpec, matcher, thresholds) {
  const winners = new Map(); // service → evidence text
  const weeks = thresholds.exclusion_weeks;
  const byWeek = new Map();
  for (const p of posts) {
    const idx = Math.floor((p.daysBefore - 1) / 7);
    if (idx >= weeks) continue;
    if (!byWeek.has(idx)) byWeek.set(idx, new Map());
    const counts = byWeek.get(idx);
    const entry = counts.get(p.service) || { n: 0, latest: p.post_date };
    entry.n += 1;
    if (p.post_date > entry.latest) entry.latest = p.post_date;
    counts.set(p.service, entry);
  }
  for (const counts of byWeek.values()) {
    const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
    const [service, top] = ranked[0];
    if (top.n < thresholds.exclusion_min_posts) continue;
    if (ranked[1] && ranked[1][1].n === top.n) continue; // no single topic that week
    if (!winners.has(service)) winners.set(service, `${top.n} posts, last ${top.latest}`);
  }
  const weekOfMs = parseDay(weekSpec.week_of);
  for (const w of (history && history.winners) || []) {
    if (!w || typeof w !== 'object') continue;
    const ms = parseDay(w.week_of);
    // A prior revision's topic: { service_key } or { topic: { service_key } }; a label is accepted too.
    const raw = [w.service_key, w.topic && w.topic.service_key, w.service_label, w.service]
      .find((v) => typeof v === 'string' && v.trim()) || '';
    const service = matcher.isKey(raw) ? raw : matcher.match(raw);
    if (ms == null || !service) continue;
    const d = daysBetween(ms, weekOfMs);
    if (d > 0 && d <= weeks * 7 && !winners.has(service)) winners.set(service, `selected for week of ${w.week_of}`);
  }
  return winners;
}

/**
 * Per-service performance: Facebook engagement rate joined by platform post id,
 * and Search Console CTR for the family when the service was posted inside the
 * window. Each part is normalized by the best service; parts are averaged.
 */
function performanceByService(posts, index, thresholds) {
  const fbRates = new Map();
  for (const p of posts) {
    if (!p.platform_post_id || (p.platform && p.platform !== 'facebook')) continue;
    const v = index.facebook.get(p.platform_post_id);
    if (!v) continue;
    const reach = Math.max(num(v.reach), num(v.impressions));
    if (reach <= 0) continue;
    const engaged = num(v.engaged) > 0 ? num(v.engaged) : num(v.reactions) + num(v.comments) + num(v.shares);
    if (!fbRates.has(p.service)) fbRates.set(p.service, []);
    fbRates.get(p.service).push(engaged / reach);
  }
  const fbMean = new Map();
  for (const [service, rates] of fbRates) fbMean.set(service, rates.reduce((a, b) => a + b, 0) / rates.length);
  const maxFb = Math.max(0, ...fbMean.values());

  const ctr = new Map();
  const postedRecently = new Set(posts.filter((p) => p.daysBefore <= index.windowDays).map((p) => p.service));
  for (const service of postedRecently) {
    const rows = index.demandRows.filter((r) => r.service === service);
    const impressions = rows.reduce((a, r) => a + r.impressions, 0);
    if (impressions < thresholds.ctr_min_impressions) continue;
    ctr.set(service, rows.reduce((a, r) => a + r.clicks, 0) / impressions);
  }
  const maxCtr = Math.max(0, ...ctr.values());

  const out = new Map();
  for (const service of new Set([...fbMean.keys(), ...ctr.keys()])) {
    const parts = [];
    const notes = [];
    if (fbMean.has(service)) {
      const norm = maxFb > 0 ? fbMean.get(service) / maxFb : 0;
      parts.push(norm);
      notes.push(`Facebook engagement ${(fbMean.get(service) * 100).toFixed(1)}% (${norm.toFixed(2)} of best)`);
    }
    if (ctr.has(service)) {
      const norm = maxCtr > 0 ? ctr.get(service) / maxCtr : 0;
      parts.push(norm);
      notes.push(`search CTR ${(ctr.get(service) * 100).toFixed(1)}% (${norm.toFixed(2)} of best)`);
    }
    out.set(service, { score: clamp(parts.reduce((a, b) => a + b, 0) / parts.length), note: notes.join('; ') });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring

function weightedPosition(rows) {
  let impressions = 0;
  let sum = 0;
  for (const r of rows) {
    if (r.position == null || r.impressions <= 0) continue;
    impressions += r.impressions;
    sum += r.position * r.impressions;
  }
  return impressions > 0 ? { position: sum / impressions, impressions } : null;
}

function describePosition(position, T) {
  if (position < T.position_page_one_bottom) return 'already high on page 1';
  if (position > T.position_page_three) return 'beyond page 3';
  return 'page 1 bottom to page 3';
}

function scoreCandidate(candidate, ctx) {
  const { T, weights, degraded, index, posts, perf, month, serviceByKey, cityWeight, impressionsByCandidate, maxImpressions } = ctx;
  const service = serviceByKey.get(candidate.service_key) || {};
  const key = candidate.service_key;
  const city = candidate.city;
  const scores = { ...candidate.scores };
  const why = { priority: [], demand: [], opportunity: [], recency: [], season: [], performance: [] };

  scores.priority = priorityScore(service.priority, T);
  why.priority.push(`${Number.isFinite(Number(service.priority)) ? service.priority : T.priority_min}/${T.priority_max}`);

  if (degraded) {
    scores.demand = T.degraded_fallback;
    scores.opportunity = T.degraded_fallback;
    why.demand.push(`Search Console and SerpApi unavailable; defaulted to ${T.degraded_fallback.toFixed(2)}`);
    why.opportunity.push(`Search Console and SerpApi unavailable; defaulted to ${T.degraded_fallback.toFixed(2)}`);
  } else {
    const inFamily = (r) => r.service === key && (r.city == null || r.city === city);
    const famRows = index.demandRows.filter(inFamily);
    const impressions = impressionsByCandidate.get(candidate);
    const base = maxImpressions > 0 ? impressions / maxImpressions : 0;
    const serpFamily = index.serp.filter((r) => r.service === key && r.city === city);
    const serpService = serpFamily.length ? serpFamily : index.serp.filter((r) => r.service === key);
    const paaRow = serpService.find((r) => r.paa);
    scores.demand = clamp(base + (paaRow ? T.paa_bonus : 0));
    why.demand.push(impressions > 0
      ? `${index.windowDays}d impressions ${impressions} (${base.toFixed(2)} of max)`
      : 'no Search Console impressions for the family');
    if (paaRow) why.demand.push(`+${T.paa_bonus} People Also Ask on "${paaRow.query || 'the family'}"`);

    const posRows = weightedPosition(famRows) ? famRows : index.sc.filter(inFamily);
    const pos = weightedPosition(posRows);
    let opportunity = opportunityFromPosition(pos ? pos.position : null, T);
    why.opportunity.push(pos
      ? `avg position ${pos.position.toFixed(1)} across ${pos.impressions} impressions (${describePosition(pos.position, T)})`
      : 'no Search Console position data');
    const packRows = serpFamily.length ? serpFamily : index.serp.filter((r) => r.city === city);
    if (packRows.some((r) => r.packLacksGrizzly)) {
      opportunity += T.local_pack_bonus;
      why.opportunity.push(`+${T.local_pack_bonus} local pack in ${city} lacks Grizzly`);
    }
    scores.opportunity = clamp(opportunity);
  }

  const windowDays = T.recency_weeks * 7;
  const recent = posts.filter((p) => p.service === key && p.daysBefore <= windowDays);
  const sameCity = recent.filter((p) => p.city === city);
  const latest = (list) => list.map((p) => p.post_date).sort().pop();
  if (sameCity.length) {
    scores.recency = T.recency_same_service_city;
    why.recency.push(`same service and city posted ${latest(sameCity)}`);
  } else if (recent.length) {
    scores.recency = T.recency_same_service;
    why.recency.push(`same service posted ${latest(recent)} (${recent.map((p) => p.city).filter(Boolean)[0] || 'no city'})`);
  } else {
    scores.recency = T.recency_never;
    why.recency.push(`not published in the last ${T.recency_weeks} weeks`);
  }

  const seasonValue = service.season ? Number(service.season[String(month)]) : NaN;
  if (Number.isFinite(seasonValue)) {
    scores.season = clamp(seasonValue);
    why.season.push(`month ${month} weight ${scores.season.toFixed(2)}`);
  } else {
    scores.season = T.season_default;
    why.season.push(`no seasonal weight for month ${month} (${T.season_default.toFixed(2)})`);
  }

  const p = perf.get(key);
  scores.performance = p ? p.score : T.performance_unknown;
  why.performance.push(p ? p.note : `no performance data (${T.performance_unknown.toFixed(2)})`);

  const base = SCORE_KEYS.reduce((acc, k) => acc + (Number(weights[k]) || 0) * scores[k], 0);
  const total = round4(base * cityWeight);
  const reasons = SCORE_KEYS.map((k) => `${k}: ${why[k].join('; ')}`);
  reasons.push(`total: ${base.toFixed(3)} × city weight ${cityWeight} = ${total}`);
  return { ...candidate, scores, total, reasons, _why: why };
}

function reasonFor(candidate, key) {
  const text = candidate.reasons.find((r) => r.startsWith(`${key}: `));
  return text ? text.slice(key.length + 2) : '';
}

function buildRationale({ winner, runnerUp, weights, excludedServices, exclusionSkipped, degraded, sources, T }) {
  const drivers = SCORE_KEYS
    .map((k) => ({ k, contribution: (Number(weights[k]) || 0) * winner.scores[k] }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2)
    .map((d) => `${d.k} ${winner.scores[d.k].toFixed(2)} (${reasonFor(winner, d.k)})`);
  const parts = [
    `Winner: ${winner.service_label} in ${winner.city} (total ${winner.total.toFixed(3)}).`,
    `Top drivers: ${drivers.join('; ')}.`,
    runnerUp
      ? `Runner-up: ${runnerUp.service_label} in ${runnerUp.city} (total ${runnerUp.total.toFixed(3)}).`
      : 'No runner-up: only one candidate remained.',
  ];
  if (excludedServices.length) {
    parts.push(`Excluded because the service was the winner in the last ${T.exclusion_weeks} weeks: ${excludedServices.join(', ')}.`);
  }
  if (exclusionSkipped.length) {
    parts.push(`Exclusion skipped for ${exclusionSkipped.join(', ')} because it would have removed every candidate.`);
  }
  if (degraded) {
    parts.push(`Search Console and SerpApi were both unavailable, so demand and opportunity defaulted to ${T.degraded_fallback.toFixed(2)} for every candidate (degraded selection).`);
  } else {
    const missing = [];
    if (!sources.search_console) missing.push('Search Console');
    if (!sources.serpapi) missing.push('SerpApi');
    if (missing.length) parts.push(`${missing.join(' and ')} unavailable; the other search source carried demand and opportunity.`);
  }
  if (!sources.facebook) parts.push('Facebook insights unavailable; performance rests on Search Console CTR where posts exist, else 0.50.');
  return parts.join(' ');
}

/**
 * Rank candidates and pick the week's topic.
 * @param {object} args
 * @param {object} args.policy       config/weekly-policy.json
 * @param {object[]} args.observations  ObservationSchema rows from every collector
 * @param {object} [args.history]    { posts, website_tasks, winners? } from collectHistory
 * @param {object} [args.facts]      loadFacts() output (accepted; policy carries the priorities)
 * @param {object} args.weekSpec     WeekSpec (run_friday and week_of are required)
 * @param {object[]} [args.candidates]  pre-built candidates (default buildCandidates(policy))
 * @param {number[]} [args.cityTiers]   passed to buildCandidates
 * @returns {object} Selection
 */
export function rankCandidates({ policy, observations = [], history = null, facts = null, weekSpec, candidates = null, cityTiers = null } = {}) {
  if (!policy || !Array.isArray(policy.services) || !Array.isArray(policy.cities)) {
    throw new TypeError('rankCandidates: policy with services[] and cities[] is required');
  }
  const runFridayMs = weekSpec && parseDay(weekSpec.run_friday);
  const weekOfMs = weekSpec && parseDay(weekSpec.week_of);
  if (runFridayMs == null || weekOfMs == null) {
    throw new TypeError('rankCandidates: weekSpec with run_friday and week_of (YYYY-MM-DD) is required');
  }
  void facts; // priorities live in policy; the facts loader is accepted for interface parity

  const { weights, thresholds: T } = selectionConstants(policy);
  const matcher = createServiceMatcher(policy, T);
  const index = indexObservations(observations, policy, matcher, T);
  const posts = indexHistory(history, policy, matcher, { runFridayMs, weekOfMs });
  const degraded = !index.sources.search_console && !index.sources.serpapi;
  const perf = performanceByService(posts, index, T);
  const winners = recentWinners(posts, history, weekSpec, matcher, T);
  const month = Number(String(weekSpec.week_of).slice(5, 7));
  const serviceByKey = new Map(policy.services.map((s) => [s.key, s]));
  const cityWeights = new Map(policy.cities.map((c) => [c.name, Number.isFinite(Number(c.weight)) ? Number(c.weight) : 1]));

  const skeletons = candidates || buildCandidates(policy, { cityTiers });
  const impressionsByCandidate = new Map();
  let maxImpressions = 0;
  for (const c of skeletons) {
    const sum = index.demandRows
      .filter((r) => r.service === c.service_key && (r.city == null || r.city === c.city))
      .reduce((a, r) => a + r.impressions, 0);
    impressionsByCandidate.set(c, sum);
    if (sum > maxImpressions) maxImpressions = sum;
  }

  const scored = skeletons.map((c) => scoreCandidate(c, {
    T, weights, degraded, index, posts, perf, month, serviceByKey,
    cityWeight: cityWeights.has(c.city) ? cityWeights.get(c.city) : 1,
    impressionsByCandidate, maxImpressions,
  }));

  const byTotal = (a, b) => b.total - a.total
    || b.scores.priority - a.scores.priority
    || (cityWeights.get(b.city) || 1) - (cityWeights.get(a.city) || 1);
  const strip = ({ _why, ...rest }) => rest;

  let excludedRaw = scored.filter((c) => winners.has(c.service_key));
  let rankedRaw = scored.filter((c) => !winners.has(c.service_key));
  const exclusionSkipped = [];
  if (!rankedRaw.length && excludedRaw.length) {
    exclusionSkipped.push(...[...winners.keys()].map((k) => (serviceByKey.get(k) || {}).label || k));
    rankedRaw = scored;
    excludedRaw = [];
  }
  const ranked = rankedRaw.map(strip).sort(byTotal);
  const excluded = excludedRaw.map(strip).sort(byTotal).map((candidate) => ({
    candidate,
    reason: `service was the winner in the last ${T.exclusion_weeks} weeks (${winners.get(candidate.service_key)})`,
  }));
  if (!ranked.length) throw new Error('rankCandidates: no candidates (policy has no services or cities)');

  const excludedServices = [...new Set(excludedRaw.map((c) => c.service_label))];
  const rationale = buildRationale({
    winner: ranked[0], runnerUp: ranked[1] || null, weights, excludedServices, exclusionSkipped,
    degraded, sources: index.sources, T,
  });
  return { winner: ranked[0], ranked, excluded, rationale, degraded };
}
