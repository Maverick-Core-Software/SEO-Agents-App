/**
 * generate.mjs — turn the week's selection, the business facts and the week
 * spec into a content plan through one metered LLM call plus at most one
 * bounded repair call.
 *
 * The model returns a ModelPlan (schemas.mjs). Code, never the model, fills
 * `attempt_id`, `week_of`, `topic` (the selection winner), every item's `date`,
 * every Facebook `contact`, `video_prompt: ''` and GBP `status`, then validates
 * the assembled object with PlanSchema. The model never computes dates: the
 * user message carries the exact date for every day slot and the model only
 * echoes day numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROMPTS_DIR } from './paths.mjs';
import { ModelPlanSchema, PlanSchema, parseOrIssues } from './schemas.mjs';
import { GenerationInvalid } from './errors.mjs';
import { parseJsonLoose } from './llm.mjs';

export const SYSTEM_PROMPT_PATH = path.join(PROMPTS_DIR, 'plan.system.md');
export const GBP_DAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const FB_DAYS = Object.freeze([1, 3, 5, 6]);
/** Media policy per Facebook day (DESIGN.md schema notes; build_facebook_crew). */
export const FB_TYPES_BY_DAY = Object.freeze({
  1: Object.freeze(['slideshow']),
  3: Object.freeze(['photo', 'carousel']),
  5: Object.freeze(['photo', 'carousel']),
  6: Object.freeze(['photo', 'text']),
});
export const MAX_BOOST_YES_ROWS = 2;
export const MAX_WEBSITE_ACTIONS = 3;
export const GBP_STATUS = 'Needs approval';
/** The fixed first-comment line the Facebook poster publishes (crew.py build_facebook_crew). */
export const CONTACT_LINE_TEMPLATE = '📲 Text us at {phone} to get a free instant quote — calls welcome too!';
export const LABELS = Object.freeze({ first: 'generate', repair: 'generate-repair' });

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_RECENT_HOOKS = 40;
const MAX_RECENT_POSTS = 40;
const MAX_WEBSITE_TASKS = 20;
const MAX_PREVIOUS_CHARS = 24000;
/** Same phone shapes facts.mjs recognises; used to keep unapproved numbers out of the model message. */
const PHONE_RE = /\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/g;
export const REDACTED_PHONE = '[phone number withheld]';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The fixed Facebook contact line, built from the customer text line in facts. */
export function contactLine(facts) {
  const phone = facts?.phones?.customer_text;
  if (!phone) throw new Error('generate: facts.phones.customer_text is required for the contact line');
  return CONTACT_LINE_TEMPLATE.replace('{phone}', phone);
}

const digitsOf = (text) => String(text ?? '').replace(/\D/g, '');

/**
 * Replace every phone number that is not one of `facts.phones.*` with a
 * placeholder. The facts file quotes numbers the model must never repeat (a
 * fake form placeholder, for example); validate.mjs fails any plan that echoes
 * them, so they never reach the model in the first place.
 */
export function redactUnknownPhones(text, facts) {
  const allowed = new Set(Object.values(facts?.phones ?? {}).map(digitsOf).filter(Boolean));
  return String(text ?? '').replace(PHONE_RE, (m) => (allowed.has(digitsOf(m)) ? m : REDACTED_PHONE));
}

/** The city in `facts.address` ("street, City, ST zip"), or null when the address is missing. */
export function homeBaseCity(facts) {
  const parts = String(facts?.address ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[1] : null;
}

/** Weekday name for a YYYY-MM-DD string, computed in UTC so it is timezone-proof. */
export function weekdayName(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate))) throw new Error(`generate: bad date ${isoDate}`);
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== isoDate) throw new Error(`generate: bad date ${isoDate}`);
  return WEEKDAYS[d.getUTCDay()];
}

/** DFW seasonal framing keyed on the posting week's month (mirrors crew.py, plus fall). */
export function seasonalHint(month) {
  const m = Number(month);
  if ([3, 4, 5].includes(m)) return 'DFW storm season (spring): emphasize generators, surge protection, storm prep.';
  if ([6, 7, 8].includes(m)) return 'DFW summer: emphasize AC-related electrical loads, EV charging, panel capacity.';
  if ([11, 12, 1, 2].includes(m)) return 'DFW winter: emphasize heating circuits, generator prep, ice storm readiness.';
  if ([9, 10].includes(m)) return 'DFW early fall: emphasize post-summer panel strain, lighting projects before the holidays, generator prep ahead of winter.';
  return '';
}

/** Normalize a photo list (strings or objects) to sorted, unique filenames. */
export function photoFilenames(photos) {
  const names = [];
  for (const p of Array.isArray(photos) ? photos : []) {
    const name = typeof p === 'string' ? p : (p && (p.file ?? p.filename ?? p.name));
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return [...new Set(names)].sort();
}

function sameCandidate(a, b) {
  return Boolean(a && b) && a.service_key === b.service_key && a.city === b.city;
}

function candidateSummary(c) {
  return {
    service_key: c.service_key,
    service_label: c.service_label,
    city: c.city,
    query_family: Array.isArray(c.query_family) ? [...c.query_family] : [],
    total: Number.isFinite(c.total) ? Math.round(c.total * 1000) / 1000 : null,
    reasons: Array.isArray(c.reasons) ? [...c.reasons] : [],
  };
}

/** The next `n` ranked candidates that are not the winner. */
export function pickSupporting(selection, n = 2) {
  const winner = selection?.winner;
  const ranked = Array.isArray(selection?.ranked) ? selection.ranked : [];
  return ranked.filter((c) => !sameCandidate(c, winner)).slice(0, n);
}

function normalizeHook(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function recentHistory(history) {
  const posts = Array.isArray(history?.posts) ? [...history.posts] : [];
  posts.sort((a, b) => String(b.post_date ?? '').localeCompare(String(a.post_date ?? '')));
  const seen = new Set();
  const hooks = [];
  for (const p of posts) {
    const hook = String(p.hook ?? '').trim();
    if (!hook) continue;
    const key = normalizeHook(hook);
    if (seen.has(key)) continue;
    seen.add(key);
    hooks.push(hook);
    if (hooks.length >= MAX_RECENT_HOOKS) break;
  }
  const recent_posts = posts.slice(0, MAX_RECENT_POSTS).map((p) => ({
    platform: p.platform ?? null,
    post_date: p.post_date ?? null,
    service: p.service ?? null,
    city: p.city ?? null,
  }));
  // history.mjs passes `status` through as free text, so no filtering here: the
  // model sees each task with its status and is told to skip duplicates of open ones.
  const tasks = Array.isArray(history?.website_tasks) ? history.website_tasks : [];
  const recent_website_tasks = tasks.slice(0, MAX_WEBSITE_TASKS).map((t) => ({
    title: t.title ?? null,
    type: t.type ?? null,
    status: t.status ?? null,
  }));
  return { recent_hooks_to_avoid: hooks, recent_posts, recent_website_tasks };
}

// ---------------------------------------------------------------------------
// User message
// ---------------------------------------------------------------------------

/**
 * Build the user-message JSON: every fact the model needs and nothing it must
 * compute. Pure and deterministic for the same inputs.
 */
export function buildGenerationInput({ facts, selection, weekSpec, photos = [], history = null, policy = {} }) {
  if (!facts) throw new Error('generate: facts are required');
  if (!selection?.winner) throw new Error('generate: selection.winner is required');
  if (!weekSpec?.week_of || !weekSpec.gbp_dates || !weekSpec.fb_dates) throw new Error('generate: weekSpec is required');

  const gbp = GBP_DAYS.map((day) => {
    const date = weekSpec.gbp_dates[day];
    if (!date) throw new Error(`generate: weekSpec.gbp_dates missing day ${day}`);
    return { day, date, weekday: weekdayName(date) };
  });
  const facebook = FB_DAYS.map((day) => {
    const date = weekSpec.fb_dates[day];
    if (!date) throw new Error(`generate: weekSpec.fb_dates missing day ${day}`);
    return { day, date, weekday: weekdayName(date), allowed_types: [...FB_TYPES_BY_DAY[day]] };
  });

  const winner = candidateSummary(selection.winner);
  const supporting = pickSupporting(selection, 2).map(candidateSummary);
  const supporting_cities = [...new Set(supporting.map((c) => c.city).filter((c) => c && c !== winner.city))];
  // A machine spends this money; a missing budget fails closed rather than becoming $0.
  const weeklyUsd = policy?.boost_weekly_usd;
  if (typeof weeklyUsd !== 'number' || !Number.isFinite(weeklyUsd) || weeklyUsd < 0) {
    throw new Error('generate: policy.boost_weekly_usd must be a non-negative number');
  }
  // Free-text fact lists may quote numbers the model must never repeat.
  const textList = (list) => (Array.isArray(list) ? list.map((t) => redactUnknownPhones(t, facts)) : []);

  return {
    task: 'Write the weekly content plan for the business below. Reply with one JSON object in the shape described in the system prompt.',
    week_of: weekSpec.week_of,
    schedule: { gbp, facebook },
    business: {
      name: facts.business_name ?? null,
      founded_year: facts.founded_year ?? null,
      tenure_phrase: facts.tenure_phrase ?? null,
      forbidden_tenure_phrases: Array.isArray(facts.forbidden_phrases) ? [...facts.forbidden_phrases] : [],
      address: facts.address ?? null,
      home_base: homeBaseCity(facts),
      service_area: textList(facts.service_area),
      domain: facts.domain ?? null,
      website_url: facts.website_url ?? null,
      email: facts.email ?? null,
      phones: {
        customer_text: facts.phones?.customer_text ?? null,
        published_main: facts.phones?.published_main ?? null,
      },
      hours: textList(facts.hours),
      platform_notes: textList(facts.platform_notes),
      existing_pages: Array.isArray(facts.existing_pages) ? [...facts.existing_pages] : [],
      existing_blog_slugs: Array.isArray(facts.existing_blog_slugs) ? [...facts.existing_blog_slugs] : [],
      priority_services: textList(facts.priority_services),
      known_issues: textList(facts.known_issues),
      approved_prices: Array.isArray(facts.approved_prices) ? [...facts.approved_prices] : [],
    },
    contact_line: contactLine(facts),
    topic: {
      winner,
      supporting,
      supporting_cities,
      rationale: selection.rationale ?? '',
      degraded: Boolean(selection.degraded),
    },
    seasonal_context: seasonalHint(Number(weekSpec.week_of.slice(5, 7))),
    photos: photoFilenames(photos),
    history: recentHistory(history),
    boost: {
      weekly_usd: weeklyUsd,
      max_yes_rows: MAX_BOOST_YES_ROWS,
      allowed_decisions: ['YES', 'MAYBE', 'NO'],
    },
    constraints: {
      gbp_posts: GBP_DAYS.length,
      facebook_posts: FB_DAYS.length,
      winner_city_min_gbp_mentions: 3,
      winner_city_min_facebook_mentions: 2,
      max_gbp_days_per_service: 3,
      website_actions_max: MAX_WEBSITE_ACTIONS,
    },
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** Read the system prompt. Throws when the file is missing (the prompt is mandatory). */
export function loadSystemPrompt(file = SYSTEM_PROMPT_PATH) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/json/i.test(text)) throw new Error('generate: system prompt must say the response is a JSON object');
  return text;
}

/**
 * Short content hash of the prompt for attempt.versions.prompt. Line endings
 * are normalised first so a CRLF checkout reports the same version as LF.
 */
export function promptVersion(text = loadSystemPrompt()) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Shape checks the schema cannot express and assembly depends on
// ---------------------------------------------------------------------------

function dayList(items) {
  return (Array.isArray(items) ? items : []).map((i) => i?.day);
}

function sameSet(a, b) {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/**
 * Issues in a schema-valid ModelPlan that would break assembly or the topic
 * binding: day sets, Facebook media type per day, and the winner topic.
 */
export function planShapeIssues(modelPlan, input) {
  const issues = [];
  if (!modelPlan) return [{ path: '', message: 'no plan object' }];

  const gbpDays = dayList(modelPlan.gbp);
  if (!sameSet(gbpDays, GBP_DAYS)) {
    issues.push({ path: 'gbp', message: `gbp days must be exactly 1..7 with no repeats (got ${JSON.stringify(gbpDays)})` });
  }
  const fbDays = dayList(modelPlan.facebook);
  if (!sameSet(fbDays, FB_DAYS)) {
    issues.push({ path: 'facebook', message: `facebook days must be exactly [1,3,5,6] with no repeats (got ${JSON.stringify(fbDays)})` });
  }
  (Array.isArray(modelPlan.facebook) ? modelPlan.facebook : []).forEach((item, i) => {
    const allowed = FB_TYPES_BY_DAY[item?.day];
    if (allowed && !allowed.includes(item.type)) {
      issues.push({ path: `facebook[${i}].type`, message: `day ${item.day} must be ${allowed.join(' or ')} (got ${item.type})` });
    }
  });

  const winner = input?.topic?.winner;
  if (winner && modelPlan.topic) {
    if (modelPlan.topic.service_key !== winner.service_key || modelPlan.topic.city !== winner.city) {
      issues.push({
        path: 'topic',
        message: `topic must copy the winner exactly: service_key ${winner.service_key}, city ${winner.city} (got ${modelPlan.topic.service_key}, ${modelPlan.topic.city})`,
      });
    }
  }
  return issues;
}

function collectIssues(result, input) {
  if (Array.isArray(result?.issues) && result.issues.length) return result.issues;
  return planShapeIssues(result?.data, input);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function dateForDay(input, platform, day) {
  const slot = (input.schedule?.[platform] ?? []).find((s) => s.day === day);
  if (!slot) throw new GenerationInvalid(`generate: no ${platform} date for day ${day}`, [{ path: `${platform}`, message: `no date for day ${day}` }]);
  return slot.date;
}

/** The plan's topic is the selection winner, byte for byte (the model's copy is only checked, never stored). */
function topicFromWinner(input) {
  const w = input?.topic?.winner;
  if (!w) return null;
  return {
    service_key: w.service_key,
    service_label: w.service_label,
    city: w.city,
    query_family: Array.isArray(w.query_family) ? [...w.query_family] : [],
  };
}

/**
 * Fill the code-owned fields into a ModelPlan. Overwrites anything the model
 * may have written for them. Returns a plain object (validate with PlanSchema).
 */
export function assemblePlan(modelPlan, input, attemptId) {
  const gbp = [...modelPlan.gbp]
    .sort((a, b) => a.day - b.day)
    .map((item) => ({ ...item, date: dateForDay(input, 'gbp', item.day), status: GBP_STATUS }));
  const facebook = [...modelPlan.facebook]
    .sort((a, b) => a.day - b.day)
    .map((item) => ({
      ...item,
      date: dateForDay(input, 'facebook', item.day),
      contact: input.contact_line,
      video_prompt: '',
    }));
  return {
    attempt_id: attemptId,
    week_of: input.week_of,
    topic: topicFromWinner(input) ?? modelPlan.topic,
    gbp,
    facebook,
    website_actions: modelPlan.website_actions ?? [],
    notes: modelPlan.notes,
  };
}

// ---------------------------------------------------------------------------
// Repair message
// ---------------------------------------------------------------------------

function previousResponse(result) {
  if (result?.data) return result.data;
  const parsed = parseJsonLoose(result?.raw);
  if (!parsed.error) return parsed.value;
  return String(result?.raw ?? '').slice(0, MAX_PREVIOUS_CHARS);
}

/** The user message for the single repair call: issues, previous JSON, original request. */
export function buildRepairMessage(input, result, issues) {
  return {
    task: 'REPAIR: your previous JSON response failed validation. Fix every listed issue, keep everything else identical, and reply with the complete corrected JSON object in the same shape (not a diff, not prose).',
    issues,
    previous_response: previousResponse(result),
    original_request: input,
  };
}

// ---------------------------------------------------------------------------
// I/O entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} input   from buildGenerationInput
 * @param {object} opts
 * @param {object} opts.llm            client with chatJSON (llm.mjs)
 * @param {object} [opts.meter]        cost meter; checked before each call
 * @param {string} opts.attemptId
 * @param {string} [opts.systemPrompt] override (tests); default reads plan.system.md
 * @returns {Promise<object>} a PlanSchema-valid plan
 * @throws {GenerationInvalid} when the repair call still fails or assembly fails PlanSchema
 */
export async function generatePlan(input, { llm, meter = null, attemptId, systemPrompt = null, maxTokens = 8000, temperature = 0.4 } = {}) {
  if (!llm || typeof llm.chatJSON !== 'function') throw new Error('generatePlan: llm client with chatJSON is required');
  if (typeof attemptId !== 'string' || !attemptId) throw new Error('generatePlan: attemptId (non-empty string) is required');
  if (!input?.schedule || !input.week_of || !input.contact_line || !input.topic?.winner) throw new Error('generatePlan: input must come from buildGenerationInput');

  const system = systemPrompt ?? loadSystemPrompt();
  const common = { system, schema: ModelPlanSchema, maxTokens, temperature };

  if (meter) meter.assertUnder(0);
  const first = await llm.chatJSON({ ...common, user: input, label: LABELS.first });
  let issues = collectIssues(first, input);
  let modelPlan = first.data;

  if (issues.length) {
    if (meter) meter.assertUnder(0);
    const repairUser = buildRepairMessage(input, first, issues);
    const second = await llm.chatJSON({ ...common, user: repairUser, label: LABELS.repair });
    issues = collectIssues(second, input);
    if (issues.length) {
      throw new GenerationInvalid(`generate: plan still invalid after one repair (${issues.length} issue(s))`, issues);
    }
    modelPlan = second.data;
  }

  const assembled = assemblePlan(modelPlan, input, attemptId);
  const { data, issues: finalIssues } = parseOrIssues(PlanSchema, assembled);
  if (finalIssues.length) throw new GenerationInvalid('generate: assembled plan failed PlanSchema', finalIssues);
  return data;
}
