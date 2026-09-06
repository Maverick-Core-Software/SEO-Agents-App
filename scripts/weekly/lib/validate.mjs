/**
 * validate.mjs — fail-closed checks on a generated weekly plan against the
 * business facts, the frozen WeekSpec, the photo inventory, the published
 * history and the policy. Pure functions only: no I/O, no clock, no network.
 *
 * Contract: scripts/weekly/DESIGN.md, "validate".
 *
 *   validatePlan(plan, { facts, weekSpec, photos, history, policy })
 *     → { ok, errors: string[], warnings: string[] }
 *
 * Errors (any one fails the plan): schema; a date that is not the WeekSpec
 * date for that day; a phone number other than facts.phones.*; a domain other
 * than facts.domain; a tenure claim that contradicts facts.founded_year; a
 * dollar amount in GBP/Facebook copy that is not in facts.approved_prices
 * (matched by value, and by unit too when the copy says "/day" or "per hour"); a
 * photo_file not in the inventory; Facebook boost YES rows that do not sum to
 * policy.boost_weekly_usd exactly, more than two YES rows, or a MAYBE/NO row
 * carrying dollars; a hook identical (normalized) to a published hook or to
 * another hook in the same plan (Facebook hooks, GBP headlines); a service on
 * more than 3 of the 7 GBP days; a missing or duplicated day slot; a Facebook
 * type that breaks the day rule (day 1 slideshow, 3/5 photo or carousel, 6
 * photo or text); a WeekSpec that lacks a slot date (fail closed).
 *
 * Warnings (reported, never blocking): headline over 58 chars, body under 30
 * words (Facebook also over 80), the topic city named in fewer than 3 GBP
 * posts, hashtags without a local tag, an email other than facts.email,
 * unapproved prices or external domains inside website drafts, and phones or
 * domains inside the plan notes.
 *
 * Text scanners are exported for tests and for compare.mjs:
 *   findPhoneNumbers(text)  → ['(469) 896-3862', ...]  normalized like facts.phones
 *   findDollarAmounts(text) → ['$1,200', '$25/day', '1200 dollars', ...] raw matches
 *   dollarValue(raw)        → 1200 | null
 *   findDomains(text)       → ['grizzlyelectricaltx.com', ...] hostnames, www stripped
 *   findTenureClaims(text, { places }) → [{ raw, kind, years, year }]
 *   textFactsErrors(text, { facts, weekSpec, policy, label }) → string[]  strict text rules
 *   normalizeHook(text)     → comparison key used for the history check
 */
import { PlanSchema, parseOrIssues } from './schemas.mjs';

export const HEADLINE_WARN_CHARS = 58;
export const BODY_MIN_WORDS = 30;
export const FB_BODY_MAX_WORDS = 80;
export const GBP_CITY_MIN_POSTS = 3;
export const GBP_SERVICE_MAX_DAYS = 3;
export const FB_MAX_YES_ROWS = 2;
export const GBP_DAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const FB_DAYS = Object.freeze([1, 3, 5, 6]);
export const FB_TYPE_RULES = Object.freeze({
  1: ['slideshow'],
  3: ['photo', 'carousel'],
  5: ['photo', 'carousel'],
  6: ['photo', 'text'],
});

const GBP_TEXT_FIELDS = ['topic', 'trend_tie', 'headline', 'body', 'caption', 'cta', 'hashtags'];
const FB_TEXT_FIELDS = ['hook', 'body', 'cta', 'hashtags', 'contact', 'on_screen_text', 'format', 'boost_targeting'];
const FB_COPY_FIELDS = new Set(['hook', 'body', 'cta', 'on_screen_text']);
const WEB_TEXT_FIELDS = ['title', 'target', 'description', 'draft.title', 'draft.meta_description', 'draft.html'];
const NOTE_FIELDS = ['trend_signals', 'photo_gaps', 'degraded_reason'];
const REGION_TAG_WORDS = ['dfw', 'texas', 'northtexas', 'dallasfortworth'];

// ---------------------------------------------------------------------------
// Phone numbers. NANP shapes only (area code and exchange start with 2-9), the
// three groups joined by a space, dot, ASCII or Unicode dash (or nothing), with
// an optional +1 / 1 prefix. Separators are independent so "469 896-3862" and
// "469–896–3862" (en dash) are caught; anything a reader would dial is a leak.
const SEP_SRC = '[\\s.\\-\\u2010-\\u2015\\u2212]?';
const PHONE_RE = new RegExp(`(?<!\\d)(?:\\+?1${SEP_SRC})?(?:\\(\\s*[2-9]\\d{2}\\s*\\)${SEP_SRC}[2-9]\\d{2}${SEP_SRC}\\d{4}|[2-9]\\d{2}${SEP_SRC}[2-9]\\d{2}${SEP_SRC}\\d{4})(?!\\d)`, 'g');

function formatPhone(raw) {
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return String(raw).trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Every phone number in `text`, normalized to `(AAA) BBB-CCCC` (the facts.phones format). */
export function findPhoneNumbers(text) {
  return [...textOf(text).matchAll(PHONE_RE)].map((m) => formatPhone(m[0]));
}

// ---------------------------------------------------------------------------
// Dollar amounts: "$1,200", "$25/day", "$99.99", "$1.2k", "$5 million",
// "1200 dollars", "US$50". A range "$99–149" also yields "$149" so the upper
// bound is price-checked too.
const AMOUNT_SRC = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
// The multiplier alternation ends with a bare word boundary so "$99 today" stops at "99".
const MULT_SRC = '(?:\\s?[kKmM]\\b|\\s+(?:thousand|million|billion)\\b|\\b)';
const UNIT_SRC = '(?:\\s?(?:\\/|per\\s+)\\s?(?:day|hour|hr|week|month|year|visit|outlet|fixture|panel|charger|sq\\s?ft|foot|ft))?';
const DOLLAR_SIGN_RE = new RegExp(`(?<!\\$)\\$\\s?${AMOUNT_SRC}${MULT_SRC}${UNIT_SRC}`, 'g');
const DOLLAR_WORD_RE = new RegExp(`(?<![\\w$.,])${AMOUNT_SRC}${MULT_SRC}\\s?(?:dollars?|bucks|usd)\\b`, 'gi');
const RANGE_TAIL_RE = new RegExp(`^\\s?[-\\u2013\\u2014]\\s?(${AMOUNT_SRC}${MULT_SRC})`);

/** Every dollar amount in `text` as the raw matched phrase (trimmed). */
export function findDollarAmounts(text) {
  const t = textOf(text);
  const found = [];
  for (const m of t.matchAll(DOLLAR_SIGN_RE)) {
    found.push({ index: m.index, raw: m[0].trim() });
    const range = t.slice(m.index + m[0].length).match(RANGE_TAIL_RE);
    if (range) found.push({ index: m.index + m[0].length, raw: `$${range[1].trim()}` });
  }
  for (const m of t.matchAll(DOLLAR_WORD_RE)) found.push({ index: m.index, raw: m[0].trim() });
  return found.sort((a, b) => a.index - b.index).map((f) => f.raw);
}

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, billion: 1e9 };

/** Numeric value of a raw dollar phrase ("$1,200" → 1200, "$1.2k" → 1200, "$5 million" → 5e6); null when unparseable. */
export function dollarValue(raw) {
  const m = String(raw).replace(/,/g, '').match(/(\d+(?:\.\d+)?)(?:\s?([kKmM])\b|\s+(thousand|million|billion)\b)?/i);
  if (!m) return null;
  const word = (m[2] || m[3] || '').toLowerCase();
  const value = Number(m[1]) * (word ? MULTIPLIERS[word] : 1);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Domains. Labels of 2+ chars starting alphanumeric so "e.g." never matches.
// Anything behind an explicit "https://" or "www." counts whatever its TLD;
// a bare hostname needs a TLD from the list so a run-on like "Rowlett.TX"
// does not. Emails are stripped first (their domain is not a website).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LABELS_SRC = '(?:[a-z0-9][a-z0-9-]*[a-z0-9]\\.)+';
// Bare-hostname TLDs. Short business-name suffixes (.inc, .llc, .me) are left out on
// purpose: "Solutions.Inc" in a run-on would fail a plan for nothing.
const TLD_SRC = 'com|net|org|io|co|us|biz|gov|edu|info|pro|tv|app|dev|site|online|xyz|solutions|services|tech|energy|repair|contractors|lighting';
const DOMAIN_RE = new RegExp(`(?<![\\w@.])(?:(?:https?:\\/\\/|www\\.)(${LABELS_SRC}[a-z]{2,})|(?:https?:\\/\\/)?(?:www\\.)?(${LABELS_SRC}(?:${TLD_SRC})))(?![\\w-])`, 'gi');

/** Every website hostname in `text`, lowercased with `www.` stripped, deduplicated. */
export function findDomains(text) {
  const t = textOf(text).replace(EMAIL_RE, ' ');
  return unique([...t.matchAll(DOMAIN_RE)].map((m) => (m[1] || m[2]).toLowerCase().replace(/^www\./, '')));
}

// ---------------------------------------------------------------------------
// Tenure claims. The owner's rule: "since 2021" or "five years"; never
// "over a decade", never "3+ years". Warranty and equipment-age phrases
// ("25-year warranty", "panels over 20 years old") are not tenure claims.
const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUM_WORDS = Object.fromEntries([
  ...ONES.map((w, i) => [w, i + 1]),
  ...TEENS.map((w, i) => [w, i + 10]),
  ...TENS.map((w, i) => [w, (i + 2) * 10]),
  ['dozen', 12],
]);
// Compound tens first ("twenty-five") so the scan cannot settle for the trailing "five".
const NUM_SRC = `(\\d{1,2}|(?:${TENS.join('|')})(?:[-\\s](?:${ONES.join('|')}))?|${[...TEENS, ...ONES, 'dozen'].join('|')})`;
const YRS_SRC = "(?:years?|yrs?)\\b'?";
const EXPERIENCE_SRC = '(?:(?:combined|hands-on|professional|industry|field|electrical|real-world|proven|solid)\\s+)?(?:experience|expertise)';
const TENURE_TAIL_SRC = `(?:of\\s+)?(?:${EXPERIENCE_SRC}|in\\s+business|in\\s+the\\s+(?:trade|industry|business)|serving|of\\s+service|strong|and\\s+counting|as\\b|helping|keeping|running|proudly)`;
const DECADE_SRC = '\\b(?:(?:over|more than|nearly|almost|about|a|an|two|three|several|the past|the last)\\s+){0,2}decades?\\b';
const REGION_SRC = 'dfw|north\\s+texas|texas|the\\s+(?:dfw\\s+)?(?:metroplex|area)|dallas|fort\\s+worth';
const TENURE_PATTERNS = [
  // "decades-old wiring" is equipment age; "a decade ago" is only a claim about the business with a cue.
  { kind: 'decade', re: new RegExp(`${DECADE_SRC}(?![\\s-]+old\\b)(?!\\s+ago\\b)`, 'gi') },
  { kind: 'decade', re: new RegExp(`${DECADE_SRC}\\s+ago\\b`, 'gi'), needsCue: true },
  { kind: 'plus', re: new RegExp(`\\b${NUM_SRC}\\s*(?:\\+|-?plus)\\s*${YRS_SRC}(?!\\s+old\\b)`, 'gi') },
  { kind: 'tenure', re: new RegExp(`\\b${NUM_SRC}(?:\\s*-\\s*|\\s+)${YRS_SRC}\\s+${TENURE_TAIL_SRC}`, 'gi') },
  { kind: 'tenure', re: new RegExp(`\\b${NUM_SRC}\\s*-\\s*year\\s+(?:track\\s+record|veteran|history|legacy|tradition|reputation|run)\\b`, 'gi') },
  { kind: 'tenure', re: new RegExp(`\\b(?:for|over|more\\s+than|nearly|almost|about|celebrating)\\s+${NUM_SRC}\\s+${YRS_SRC}\\b(?!\\s+old\\b)`, 'gi'), needsCue: true },
  { kind: 'since', re: /\bsince\s+((?:19|20)\d{2})\b/gi },
  { kind: 'founded', re: /\b(?:established|est\.?|founded|opened|started|in\s+business)\s+(?:in\s+)?((?:19|20)\d{2})\b/gi },
];
// Words that make "for over N years" a claim about the business rather than about
// wiring or a warranty. "wiring"/"lighting" are left out: "copper wiring lasts for
// over 40 years" is equipment talk.
const BUSINESS_CUE_RE = /\b(?:we|we've|we're|our|us|grizzly|team|crew|company|family[- ]owned|locally[- ]owned|owner[- ]operated|trusted|licensed|serving|served|electricians?|business|experience|expertise|proudly|keeping|helping|powering)\b/i;

/** "N years in DFW" / "N years across Rowlett": the region list plus any `places` the caller knows. */
function placePattern(places) {
  const extra = list(places).map((p) => normalizeSpace(String(p))).filter(Boolean).map((p) => escapeRe(p).replace(/ /g, '\\s+'));
  const src = [REGION_SRC, ...extra].join('|');
  return { kind: 'tenure', re: new RegExp(`\\b${NUM_SRC}(?:\\s*-\\s*|\\s+)${YRS_SRC}\\s+(?:in|across|around|throughout)\\s+(?:the\\s+)?(?:${src})\\b`, 'gi') };
}

function sentenceAround(text, start, end) {
  const before = text.slice(0, start);
  const s = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1;
  const rel = text.slice(end).search(/[.!?\n]/);
  return text.slice(s, rel < 0 ? text.length : end + rel);
}

/** "12" → 12, "fifteen" → 15, "twenty-five" / "twenty five" → 25; null for anything else. */
function toYears(token) {
  const t = String(token).toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  let total = 0;
  for (const part of t.split(/[-\s]+/)) {
    if (!(part in NUM_WORDS)) return null;
    total += NUM_WORDS[part];
  }
  return total;
}

/**
 * Tenure claims in `text`: [{ raw, kind: 'decade'|'plus'|'tenure'|'since'|'founded', years, year }].
 * Overlapping matches collapse to the earliest one. `places` (city names) extends
 * the "N years in <place>" rule beyond the built-in DFW/Texas region words.
 */
export function findTenureClaims(text, { places = [] } = {}) {
  const t = textOf(text);
  const hits = [];
  for (const { kind, re, needsCue } of [...TENURE_PATTERNS, placePattern(places)]) {
    for (const m of t.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (needsCue && !BUSINESS_CUE_RE.test(sentenceAround(t, start, end))) continue;
      const claim = { raw: m[0], kind, years: null, year: null, start, end };
      if (kind === 'since' || kind === 'founded') claim.year = Number(m[1]);
      else if (kind !== 'decade') claim.years = toYears(m[1]);
      hits.push(claim);
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start < lastEnd) continue;
    lastEnd = h.end;
    out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Facts context shared by every text check.

function normalizePhoneLike(value) {
  const found = findPhoneNumbers(value);
  return found.length ? found[0] : String(value).trim();
}

// Per-unit suffixes ("$25/day", "$99 per hour") are part of the price: an approved
// bare "$99" does not approve "$99/hour". Units are normalized so "/hr" and
// "per hour" agree.
const UNIT_ALIASES = { hr: 'hour', hrs: 'hour', hours: 'hour', ft: 'foot', feet: 'foot', sqft: 'sq ft', 'sq. ft': 'sq ft' };
const UNIT_RE = /(?:\/|\bper\s+)\s?([a-z]+(?:\.?\s?ft)?)\s*$/i;

/** The per-unit word of a raw dollar phrase ("$25/day" → "day", "$99 per hr" → "hour"), or null. */
function unitOf(raw) {
  const m = String(raw).match(UNIT_RE);
  if (!m) return null;
  const unit = normalizeSpace(m[1]).toLowerCase();
  return UNIT_ALIASES[unit] || unit;
}

/** Key for value+unit lookups: "99" for a bare amount, "99|day" for "$99/day". */
function priceKey(raw) {
  const v = dollarValue(raw);
  if (v == null) return null;
  const unit = unitOf(raw);
  return unit ? `${v}|${unit}` : String(v);
}

function approvedPrices(list) {
  const values = new Set();
  const keys = new Set();
  const raw = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    const s = String(entry);
    raw.add(normalizeSpace(s).toLowerCase());
    for (const amount of findDollarAmounts(s)) {
      raw.add(normalizeSpace(amount).toLowerCase());
      const v = dollarValue(amount);
      if (v != null) values.add(v);
      const key = priceKey(amount);
      if (key != null) keys.add(key);
    }
  }
  return { values, keys, raw };
}

function cityNames(policy) {
  return list(policy && policy.cities).map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean).map(String);
}

function factsContext(facts, weekSpec, policy) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const phones = Object.values(f.phones || {}).filter(Boolean).map(normalizePhoneLike);
  const foundedYear = Number.isInteger(f.founded_year) ? f.founded_year : null;
  const weekOf = weekSpec && weekSpec.week_of ? String(weekSpec.week_of) : '';
  const weekYear = /^\d{4}-/.test(weekOf) ? Number(weekOf.slice(0, 4)) : null;
  const tenurePhrases = [...(Array.isArray(f.tenure_phrases) ? f.tenure_phrases : []), f.tenure_phrase]
    .filter(Boolean).map((s) => normalizeSpace(String(s)).toLowerCase());
  const forbiddenPhrases = (Array.isArray(f.forbidden_phrases) ? f.forbidden_phrases : [])
    .filter(Boolean).map((s) => normalizeSpace(String(s)).toLowerCase());
  const approved = approvedPrices(f.approved_prices);
  const phrase = phraseNumbers(unique(tenurePhrases));
  return {
    phraseYears: phrase.years,
    phraseSinceYears: phrase.sinceYears,
    phones: new Set(phones),
    knownIssuePhones: new Set(findPhoneNumbers(textOf(f.known_issues))),
    domain: f.domain ? String(f.domain).toLowerCase().replace(/^www\./, '') : null,
    email: f.email ? String(f.email).toLowerCase() : null,
    foundedYear,
    expectedYears: foundedYear != null && weekYear != null ? weekYear - foundedYear : null,
    tenurePhrases: unique(tenurePhrases),
    forbiddenPhrases: unique(forbiddenPhrases),
    approvedValues: approved.values,
    approvedKeys: approved.keys,
    approvedRaw: approved.raw,
    places: unique([...cityNames(policy), ...list(f.service_area).map(String)]),
  };
}

function tenureGuidance(ctx) {
  if (ctx.tenurePhrases.length) return `say ${ctx.tenurePhrases.map((p) => `"${p}"`).join(' or ')}`;
  return ctx.foundedYear != null ? `founded ${ctx.foundedYear}` : 'founding year unknown';
}

const PHRASE_YEARS_RE = new RegExp(`^${NUM_SRC}\\s*(?:\\+|-?plus)?\\s*${YRS_SRC}`, 'i');
const PHRASE_SINCE_RE = /\b(?:since|est\.?|established|founded)\s+((?:19|20)\d{2})\b/i;

/** The numbers the owner's tenure phrases encode: "five years" → years 5, "since 2021" → year 2021. */
function phraseNumbers(phrases) {
  const years = new Set();
  const sinceYears = new Set();
  for (const p of phrases) {
    const y = p.match(PHRASE_YEARS_RE);
    if (y && toYears(y[1]) != null) years.add(toYears(y[1]));
    const s = p.match(PHRASE_SINCE_RE);
    if (s) sinceYears.add(Number(s[1]));
  }
  return { years, sinceYears };
}

/**
 * The claim starts with the owner phrase as whole words ("five years of
 * experience"), not merely contains it: "twenty-five years" is not "five years".
 */
function startsWithPhrase(raw, phrase) {
  return raw === phrase || raw.startsWith(`${phrase} `);
}

function claimIsConsistent(claim, ctx) {
  const raw = normalizeSpace(claim.raw).toLowerCase();
  if (ctx.tenurePhrases.some((p) => startsWithPhrase(raw, p))) return true;
  if (claim.kind === 'decade') return false;
  if (claim.kind === 'since' || claim.kind === 'founded') {
    return (ctx.foundedYear != null && claim.year === ctx.foundedYear) || ctx.phraseSinceYears.has(claim.year);
  }
  if (claim.years == null) return false;
  return (ctx.expectedYears != null && claim.years === ctx.expectedYears) || ctx.phraseYears.has(claim.years);
}

/** Tenure violations in `text` as messages (no label). */
function tenureViolations(text, ctx) {
  const t = textOf(text);
  if (!t) return [];
  const claims = findTenureClaims(t, { places: ctx.places });
  const out = [];
  for (const claim of claims) {
    if (claimIsConsistent(claim, ctx)) continue;
    const why = ctx.foundedYear == null ? 'founding year is not in the facts' : `business founded ${ctx.foundedYear}`;
    out.push(`tenure claim "${claim.raw}" contradicts the facts (${why}; ${tenureGuidance(ctx)})`);
  }
  const lower = t.toLowerCase();
  for (const phrase of ctx.forbiddenPhrases) {
    let idx = lower.indexOf(phrase);
    while (idx >= 0) {
      const end = idx + phrase.length;
      const covered = claims.some((c) => c.start < end && c.end > idx);
      if (!covered) out.push(`forbidden phrase "${phrase}" (${tenureGuidance(ctx)})`);
      idx = lower.indexOf(phrase, end);
    }
  }
  return unique(out);
}

function isApprovedAmount(raw, ctx) {
  if (ctx.approvedRaw.has(normalizeSpace(raw).toLowerCase())) return true;
  const v = dollarValue(raw);
  if (v == null || !ctx.approvedValues.has(v)) return false;
  // A bare amount matches any approved entry with that value; a per-unit amount
  // must match an approved entry carrying the same unit.
  return unitOf(raw) == null || ctx.approvedKeys.has(priceKey(raw));
}

/** Raw violations found in one text blob; each list holds strings. */
function scanText(text, ctx, { allowKnownIssuePhones = false } = {}) {
  const t = textOf(text);
  if (!t) return { phones: [], domains: [], emails: [], tenure: [], dollars: [] };
  const emails = unique([...t.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()));
  const stripped = t.replace(EMAIL_RE, ' ');
  return {
    phones: unique(findPhoneNumbers(stripped)).filter((p) => !ctx.phones.has(p) && !(allowKnownIssuePhones && ctx.knownIssuePhones.has(p))),
    domains: findDomains(stripped).filter((d) => d !== ctx.domain),
    emails: emails.filter((e) => e !== ctx.email),
    tenure: tenureViolations(t, ctx),
    dollars: unique(findDollarAmounts(t)).filter((raw) => !isApprovedAmount(raw, ctx)),
  };
}

const DEFAULT_MODE = Object.freeze({ phones: 'error', domains: 'error', tenure: 'error', dollars: 'error', emails: 'warn' });

/** Turn a scan into labelled messages, pushing into errors/warnings per `mode`. */
function reportScan(found, ctx, label, mode, errors, warnings) {
  const prefix = label ? `${label}: ` : '';
  const sink = (level) => (level === 'error' ? errors : level === 'warn' ? warnings : null);
  const push = (level, msg) => { const list = sink(level); if (list) list.push(prefix + msg); };
  const allowed = [...ctx.phones].join(', ') || 'none in facts';
  for (const p of found.phones) push(mode.phones, `phone ${p} is not a business number (allowed: ${allowed})`);
  for (const d of found.domains) {
    const msg = ctx.domain ? `domain ${d} is not ${ctx.domain}` : `domain ${d} (facts list no website domain)`;
    if (mode.domains === 'lenient') push(d.includes('grizzly') ? 'error' : 'warn', d.includes('grizzly') ? msg : `external domain ${d}`);
    else push(mode.domains, msg);
  }
  for (const e of found.emails) push(mode.emails, ctx.email ? `email ${e} is not ${ctx.email}` : `email ${e} (facts list no email)`);
  for (const t of found.tenure) push(mode.tenure, t);
  for (const raw of found.dollars) push(mode.dollars, `price ${raw} is not an approved price`);
}

/**
 * Strict text rules for one blob of copy (phones, domain, tenure, prices), as
 * error strings. Used by compare.mjs on the legacy schedules.
 */
export function textFactsErrors(text, { facts, weekSpec, policy, label = '' } = {}) {
  const ctx = factsContext(facts, weekSpec, policy);
  const errors = [];
  const warnings = [];
  reportScan(scanText(text, ctx), ctx, label, { ...DEFAULT_MODE, emails: 'error' }, errors, warnings);
  return unique(errors);
}

// ---------------------------------------------------------------------------
// Plan-level checks.

/** Comparison key for hooks/headlines: lowercase, letters and digits only, single spaces. */
export function normalizeHook(text) {
  return textOf(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function checkDates({ plan, gbp, fb, weekSpec }, errors) {
  if (!weekSpec || typeof weekSpec !== 'object') { errors.push('weekSpec missing: cannot verify dates'); return; }
  if (plan.week_of !== weekSpec.week_of) errors.push(`week_of ${plan.week_of} is not the WeekSpec week_of ${weekSpec.week_of}`);
  // Fail closed: a WeekSpec that lacks a slot date cannot vouch for that slot.
  const gbpDates = isObject(weekSpec.gbp_dates) ? weekSpec.gbp_dates : {};
  const fbDates = isObject(weekSpec.fb_dates) ? weekSpec.fb_dates : {};
  const missingGbp = GBP_DAYS.filter((d) => !gbpDates[d]);
  const missingFb = FB_DAYS.filter((d) => !fbDates[d]);
  if (missingGbp.length) errors.push(`weekSpec.gbp_dates missing day ${missingGbp.join(', ')}: cannot verify GBP dates`);
  if (missingFb.length) errors.push(`weekSpec.fb_dates missing day ${missingFb.join(', ')}: cannot verify Facebook dates`);
  for (const item of gbp) {
    const want = gbpDates[item.day];
    if (want && item.date !== want) errors.push(`gbp day ${item.day}: date ${item.date}, expected ${want}`);
  }
  for (const item of fb) {
    const want = fbDates[item.day];
    if (want && item.date !== want) errors.push(`facebook day ${item.day}: date ${item.date}, expected ${want}`);
  }
}

function checkSlots({ gbp, fb }, errors) {
  const gbpSeen = countBy(gbp, (i) => i.day);
  for (const d of GBP_DAYS) if (!gbpSeen.has(d)) errors.push(`gbp: missing day ${d}`);
  for (const [d, n] of gbpSeen) if (n > 1) errors.push(`gbp: day ${d} appears ${n} times`);
  const fbSeen = countBy(fb, (i) => i.day);
  for (const d of FB_DAYS) if (!fbSeen.has(d)) errors.push(`facebook: missing day ${d}`);
  for (const [d, n] of fbSeen) if (n > 1) errors.push(`facebook: day ${d} appears ${n} times`);
  for (const item of fb) {
    const allowed = FB_TYPE_RULES[item.day];
    if (allowed && !allowed.includes(item.type)) errors.push(`facebook day ${item.day}: type must be ${allowed.join(' or ')} (got ${item.type})`);
  }
}

function checkCopy({ gbp, fb, web, notes, ctx }, errors, warnings) {
  for (const item of gbp) {
    for (const field of GBP_TEXT_FIELDS) {
      reportScan(scanText(item[field], ctx), ctx, `gbp day ${dayLabel(item)} ${field}`, DEFAULT_MODE, errors, warnings);
    }
  }
  for (const item of fb) {
    for (const field of FB_TEXT_FIELDS) {
      const mode = FB_COPY_FIELDS.has(field) ? DEFAULT_MODE : { ...DEFAULT_MODE, dollars: 'skip' };
      reportScan(scanText(item[field], ctx), ctx, `facebook day ${dayLabel(item)} ${field}`, mode, errors, warnings);
    }
  }
  const webMode = { ...DEFAULT_MODE, dollars: 'warn', domains: 'lenient' };
  web.forEach((action, i) => {
    for (const field of WEB_TEXT_FIELDS) {
      const value = getPath(action, field);
      reportScan(scanText(value, ctx, { allowKnownIssuePhones: true }), ctx, `website[${i}] ${field}`, webMode, errors, warnings);
    }
  });
  const noteMode = { phones: 'warn', domains: 'warn', tenure: 'skip', dollars: 'skip', emails: 'skip' };
  for (const field of NOTE_FIELDS) {
    reportScan(scanText(notes[field], ctx, { allowKnownIssuePhones: true }), ctx, `notes.${field}`, noteMode, errors, warnings);
  }
}

function photoInventory(photos) {
  const names = new Set();
  for (const p of Array.isArray(photos) ? photos : []) {
    const name = typeof p === 'string' ? p : p && (p.name || p.file || p.filename || p.path);
    if (!name) continue;
    names.add(String(name));
    names.add(basename(name));
  }
  return names;
}

function checkPhotos({ gbp, fb, photos }, errors) {
  const known = photoInventory(photos);
  const check = (platform, item) => {
    if (item.photo_file == null) return;
    const name = String(item.photo_file);
    if (!known.has(name) && !known.has(basename(name))) {
      errors.push(`${platform} day ${dayLabel(item)}: photo_file ${name} is not in the photo inventory`);
    }
  };
  for (const item of gbp) check('gbp', item);
  for (const item of fb) check('facebook', item);
}

function checkBoost({ fb, policy }, errors) {
  // A real non-negative number only: null, '', true and NaN are "missing", not $0.
  const rawBudget = isObject(policy) ? policy.boost_weekly_usd : undefined;
  const budget = isNum(rawBudget) && rawBudget >= 0 ? rawBudget : null;
  if (budget == null) errors.push('policy.boost_weekly_usd missing: cannot verify the boost allocation');
  const yes = [];
  for (const item of fb) {
    const boost = item.boost && typeof item.boost === 'object' ? item.boost : {};
    const daily = boost.daily_usd;
    const days = boost.days;
    if (boost.decision === 'YES') {
      yes.push({ item, daily, days });
      continue;
    }
    if ((isNum(daily) && daily !== 0) || (isNum(days) && days !== 0)) {
      errors.push(`facebook day ${dayLabel(item)}: ${boost.decision || 'non-YES'} boost row carries dollars (daily_usd=${daily}, days=${days})`);
    }
  }
  if (yes.length > FB_MAX_YES_ROWS) errors.push(`facebook: ${yes.length} boost YES rows (max ${FB_MAX_YES_ROWS})`);
  let total = 0;
  let computable = true;
  for (const { item, daily, days } of yes) {
    if (!isNum(daily) || !isNum(days) || daily <= 0 || days <= 0) {
      errors.push(`facebook day ${dayLabel(item)}: YES boost row needs positive daily_usd and days (got daily_usd=${daily}, days=${days})`);
      computable = false;
      continue;
    }
    total += daily * days;
  }
  if (budget == null) return;
  if (yes.length === 0) {
    if (budget > 0) errors.push(`facebook: no boost YES row; $${budget} weekly budget is unallocated`);
    return;
  }
  if (computable && Math.abs(total - budget) > 0.005) {
    const parts = yes.map(({ item, daily, days }) => `day ${dayLabel(item)} $${daily}×${days}`).join(' + ');
    errors.push(`facebook: boost YES rows total $${round2(total)} (${parts}), must equal $${budget}`);
  }
}

function checkHooks({ gbp, fb, history }, errors) {
  const past = new Map();
  for (const post of Array.isArray(history) ? history : list(history && history.posts)) {
    const key = normalizeHook(post && post.hook);
    if (key && !past.has(key)) past.set(key, post);
  }
  const check = (platform, items, field) => {
    const seen = new Map();
    for (const item of items) {
      const key = normalizeHook(item[field]);
      if (!key) continue;
      if (past.has(key)) {
        const prior = past.get(key);
        const who = prior.platform ? `${prior.platform} ` : '';
        const when = prior.post_date ? ` on ${prior.post_date}` : '';
        errors.push(`${platform} day ${dayLabel(item)}: ${field} repeats a published ${who}hook${when}: "${item[field]}"`);
      }
      // The same hook twice in one week is as stale as a repeat from history.
      if (seen.has(key)) errors.push(`${platform} day ${dayLabel(item)}: ${field} duplicates day ${dayLabel(seen.get(key))}: "${item[field]}"`);
      else seen.set(key, item);
    }
  };
  check('facebook', fb, 'hook');
  check('gbp', gbp, 'headline');
}

function checkServiceSpread(gbp, errors) {
  const counts = countBy(gbp.filter((i) => i.service), (i) => normalizeSpace(String(i.service)).toLowerCase());
  for (const [service, n] of counts) {
    if (n > GBP_SERVICE_MAX_DAYS) errors.push(`gbp: service "${service}" on ${n} of 7 days (max ${GBP_SERVICE_MAX_DAYS})`);
  }
}

function mentionsCity(text, city) {
  if (!city) return false;
  return new RegExp(`\\b${escapeRe(city)}\\b`, 'i').test(textOf(text));
}

function localTagWords(policy, topicCity) {
  const words = [...cityNames(policy), topicCity].filter(Boolean).map((c) => String(c).toLowerCase().replace(/[^a-z0-9]/g, ''));
  return unique([...words.filter((w) => w.length >= 4), ...REGION_TAG_WORDS]);
}

/**
 * A tag is local when a city or region word starts or ends it, or is followed by
 * "tx" inside it ("#RockwallElectrician", "#ServingAllenTX"). A bare substring is
 * not enough: "#ChallengeAccepted" is not an Allen tag.
 */
function hasLocalTag(hashtags, words) {
  return list(hashtags).some((tag) => {
    const t = String(tag).toLowerCase().replace(/[^a-z0-9]/g, '');
    return words.some((w) => t.startsWith(w) || t.endsWith(w) || t.includes(`${w}tx`)) || /^tx/.test(t) || /tx$/.test(t);
  });
}

function checkQuality({ plan, gbp, fb, policy }, warnings) {
  for (const item of gbp) {
    const headline = textOf(item.headline);
    if (headline.length > HEADLINE_WARN_CHARS) warnings.push(`gbp day ${dayLabel(item)}: headline is ${headline.length} chars (over ${HEADLINE_WARN_CHARS})`);
    const words = wordCount(item.body);
    if (words < BODY_MIN_WORDS) warnings.push(`gbp day ${dayLabel(item)}: body is ${words} words (under ${BODY_MIN_WORDS})`);
  }
  for (const item of fb) {
    const words = wordCount(item.body);
    if (words < BODY_MIN_WORDS) warnings.push(`facebook day ${dayLabel(item)}: body is ${words} words (under ${BODY_MIN_WORDS})`);
    else if (words > FB_BODY_MAX_WORDS) warnings.push(`facebook day ${dayLabel(item)}: body is ${words} words (target ${BODY_MIN_WORDS}–${FB_BODY_MAX_WORDS})`);
  }

  const topicCity = plan.topic && plan.topic.city ? String(plan.topic.city) : '';
  const gbpText = (item) => [item.headline, item.body, item.caption, item.topic].map(textOf).join(' ');
  if (gbp.length) {
    if (topicCity) {
      const n = gbp.filter((item) => mentionsCity(gbpText(item), topicCity)).length;
      if (n < GBP_CITY_MIN_POSTS) warnings.push(`gbp: topic city ${topicCity} is named in ${n} of ${gbp.length} posts (want at least ${GBP_CITY_MIN_POSTS})`);
    } else {
      const best = Math.max(0, ...cityNames(policy).map((c) => gbp.filter((item) => mentionsCity(gbpText(item), c)).length));
      if (best < GBP_CITY_MIN_POSTS) warnings.push(`gbp: no city is named in at least ${GBP_CITY_MIN_POSTS} posts`);
    }
  }

  const words = localTagWords(policy, topicCity);
  for (const item of gbp) {
    if (!hasLocalTag(item.hashtags, words)) warnings.push(`gbp day ${dayLabel(item)}: hashtags have no local tag`);
  }
  for (const item of fb) {
    if (list(item.hashtags).length && !hasLocalTag(item.hashtags, words)) warnings.push(`facebook day ${dayLabel(item)}: hashtags have no local tag`);
  }
}

/**
 * Validate a generated plan. Never throws on bad input: a non-object plan
 * returns the schema errors only. `photos` is the inventory of filenames
 * (strings, or objects with name/file/filename/path); `history.posts` carries
 * the published hooks; `policy` supplies boost_weekly_usd and cities.
 */
export function validatePlan(plan, { facts, weekSpec, photos = [], history = null, policy = {} } = {}) {
  const errors = [];
  const warnings = [];
  const { issues } = parseOrIssues(PlanSchema, plan);
  for (const issue of issues) errors.push(`schema: ${issue.path || '(root)'}: ${issue.message}`);
  if (!isObject(plan) || Array.isArray(plan)) return finish(errors, warnings);

  const ctx = factsContext(facts, weekSpec, policy);
  const gbp = list(plan.gbp).filter(isObject);
  const fb = list(plan.facebook).filter(isObject);
  const web = list(plan.website_actions).filter(isObject);
  const notes = isObject(plan.notes) ? plan.notes : {};

  checkDates({ plan, gbp, fb, weekSpec }, errors);
  checkSlots({ gbp, fb }, errors);
  checkCopy({ gbp, fb, web, notes, ctx }, errors, warnings);
  checkPhotos({ gbp, fb, photos }, errors);
  checkBoost({ fb, policy }, errors);
  checkHooks({ gbp, fb, history }, errors);
  checkServiceSpread(gbp, errors);
  checkQuality({ plan, gbp, fb, policy }, warnings);
  return finish(errors, warnings);
}

// ---------------------------------------------------------------------------
// Small helpers.

function finish(errors, warnings) {
  const e = unique(errors);
  return { ok: e.length === 0, errors: e, warnings: unique(warnings) };
}
function textOf(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');
  return typeof value === 'object' ? '' : String(value);
}
function list(value) { return Array.isArray(value) ? value : []; }
function isObject(value) { return Boolean(value) && typeof value === 'object'; }
function isNum(value) { return typeof value === 'number' && Number.isFinite(value); }
function unique(values) { return [...new Set(values)]; }
function normalizeSpace(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function wordCount(text) { return textOf(text).split(/\s+/).filter(Boolean).length; }
function round2(n) { return Math.round(n * 100) / 100; }
function basename(p) { return String(p).split(/[\\/]/).pop(); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function dayLabel(item) { return item.day == null ? '?' : String(item.day); }
function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), obj);
}
function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key == null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
