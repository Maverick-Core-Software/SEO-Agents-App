// scripts/weekly/lib/render.mjs
// Render a validated Plan into the legacy Markdown schedules plus the human-facing
// website queue and plan summary. Pure functions; no I/O.
//
// The GBP and Facebook layouts are load-bearing. They are parsed by
// scripts/supabase-sync.mjs, scripts/facebook-poster.mjs, scripts/fb-boost-ledger.mjs,
// scripts/fb-boost-api.mjs (via lib/fb-boost-marketing.mjs), scripts/fb-photo-pick.mjs,
// scripts/fb-photo-rewrite.mjs, scripts/gbp-photo-pick.mjs, scripts/sync-gbp-schedule.mjs,
// scripts/mav-bridge.mjs, scripts/facebook-insights-collector.mjs and
// src/seo_agents/actions.py. Rules those parsers impose:
//   - every post block starts with a `**DAY:** N` line; blocks are separated by a line
//     that is exactly `---` (gbp-photo-pick splits on /^---$/m, mav-bridge on `---`);
//   - Facebook blocks also carry a `## DAY N` heading (fb-photo-pick, fb-boost-ledger
//     and fb-boost-api split on it);
//   - Facebook HOOK / BODY / CTA go on the line *after* their bold header
//     (fb-boost-marketing matches `**HOOK:**\n<text>`); every other field is inline
//     `**KEY:** value` because several getters only read the header line;
//   - the BOOST BUDGET SUMMARY table is fb-boost-ledger's authoritative allocation:
//     Post cell `Day N`, decision exactly YES / MAYBE / NO, daily budget `$N/day`,
//     duration `N day(s)`, `—` in the budget cells of non-YES rows, and no
//     conditional wording ("whichever", "— OR —", "hold the boost", ...) anywhere in
//     the section, because the ledger treats that as "human review required".

const BRAND = 'Grizzly Electrical Solutions';
const DASH = '—';
const STATUS = 'Needs approval';
const DEFAULT_BOOST_WEEKLY_USD = 50;
const DEFAULT_CITY = 'Rowlett';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Lines the legacy following-line getters treat as the end of a value.
const FIELD_HEADER_RE = /^\*{0,2}[A-Z_]+:/;
const HEADING_RE = /^#{1,6}\s/;
const RULE_RE = /^-{3,}$/;

// ─────────────────────────────────────────────
// Small formatters (exported for tests)
// ─────────────────────────────────────────────

/** Parse YYYY-MM-DD without timezone drift. Returns null for anything else. */
export function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay() };
}

/** 'Monday, September 7, 2026' */
export function formatLongDate(iso) {
  const p = parseIsoDate(iso);
  if (!p) return String(iso || '');
  return `${WEEKDAYS[p.dow]}, ${MONTHS[p.month]} ${p.day}, ${p.year}`;
}

/** 'Mon 9/7' — the Day cell of the boost table. */
export function formatShortDay(iso) {
  const p = parseIsoDate(iso);
  if (!p) return String(iso || '');
  return `${WEEKDAYS[p.dow].slice(0, 3)} ${p.month + 1}/${p.day}`;
}

/** 'September 4–10, 2026' | 'August 31 – September 6, 2026' | 'December 30, 2026 – January 5, 2027' */
export function formatDateRange(startIso, endIso) {
  const a = parseIsoDate(startIso);
  const b = parseIsoDate(endIso);
  if (!a || !b) return [startIso, endIso].filter(Boolean).join(' – ');
  if (a.year === b.year && a.month === b.month && a.day === b.day) return `${MONTHS[a.month]} ${a.day}, ${a.year}`;
  if (a.year === b.year && a.month === b.month) return `${MONTHS[a.month]} ${a.day}–${b.day}, ${a.year}`;
  if (a.year === b.year) return `${MONTHS[a.month]} ${a.day} – ${MONTHS[b.month]} ${b.day}, ${a.year}`;
  return `${MONTHS[a.month]} ${a.day}, ${a.year} – ${MONTHS[b.month]} ${b.day}, ${b.year}`;
}

/** '25' | '12.5' | '16.67' — no currency symbol, no trailing zeros. */
export function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Collapse a value onto one line (inline `**KEY:** value` fields). */
export function inlineText(value) {
  return String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Keep line breaks for following-line fields unless one of the lines would be read by
 * the legacy getters as a new field / heading / rule, in which case collapse to one line.
 */
export function multilineText(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  const unsafe = text.split('\n').some((line) => {
    const t = line.trim();
    return FIELD_HEADER_RE.test(t) || HEADING_RE.test(t) || RULE_RE.test(t);
  });
  return unsafe ? inlineText(text) : text;
}

/** ['#A', 'b'] → '#A #b'. Blank tags are dropped; internal whitespace removed. */
export function formatHashtags(list) {
  return (Array.isArray(list) ? list : [])
    .map((t) => String(t ?? '').trim().replace(/^#+/, '').replace(/\s+/g, ''))
    .filter(Boolean)
    .map((t) => `#${t}`)
    .join(' ');
}

/** Markdown table cell: no pipes, no line breaks. */
function cell(value) {
  return inlineText(value).replace(/\|/g, '/') || DASH;
}

function fieldLine(key, value) {
  const v = inlineText(value);
  return v ? `**${key}:** ${v}` : `**${key}:**`;
}

/** `**KEY:**` then the value on the following line(s); inline when the first line is unsafe. */
function followingLineField(key, value) {
  const text = multilineText(value);
  if (!text) return `**${key}:**`;
  const first = text.split('\n')[0].trim();
  if (FIELD_HEADER_RE.test(first) || HEADING_RE.test(first) || RULE_RE.test(first)) return fieldLine(key, text);
  return `**${key}:**\n${text}`;
}

/** A backtick fence longer than any backtick run inside the fenced content. */
function codeFence(content) {
  const longest = Math.max(0, ...[...String(content).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function bullets(list, empty) {
  const items = (Array.isArray(list) ? list : []).map(inlineText).filter(Boolean);
  return items.length ? items.map((s) => `- ${s}`).join('\n') : `- ${empty}`;
}

const byDay = (a, b) => a.day - b.day;
const sortedGbp = (plan) => [...(plan?.gbp || [])].sort(byDay);
const sortedFb = (plan) => [...(plan?.facebook || [])].sort(byDay);
const gbpDate = (item, weekSpec) => weekSpec?.gbp_dates?.[item.day] || item.date || '';
const fbDate = (item, weekSpec) => weekSpec?.fb_dates?.[item.day] || item.date || '';
const topicLabel = (plan) => {
  const t = plan?.topic || {};
  return [t.service_label, t.city].filter(Boolean).join(' — ') || '(no topic)';
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ─────────────────────────────────────────────
// Photo and boost field values (exported for tests)
// ─────────────────────────────────────────────

/** GBP: filename or the `NEEDS PHOTO` placeholder (normalizePhotoFile maps it to ''). */
export function gbpPhotoField(item) {
  return inlineText(item?.photo_file) || 'NEEDS PHOTO';
}

/** Facebook: filename, blank for text posts, `NEEDS PHOTO` for photo-type posts without one. */
export function fbPhotoField(item) {
  const file = inlineText(item?.photo_file);
  if (file) return file;
  return item?.type === 'text' ? '' : 'NEEDS PHOTO';
}

/** Per-post BOOST fields plus the numbers the summary table needs. */
export function boostFields(item) {
  const boost = item?.boost || {};
  const decision = ['YES', 'MAYBE', 'NO'].includes(String(boost.decision).toUpperCase())
    ? String(boost.decision).toUpperCase() : 'NO';
  const daily = Number.isFinite(boost.daily_usd) && boost.daily_usd > 0 ? boost.daily_usd : null;
  const days = Number.isInteger(boost.days) && boost.days > 0 ? boost.days : null;
  const funded = decision === 'YES' && daily !== null && days !== null;
  const targeting = inlineText(item?.boost_targeting);
  return {
    decision,
    daily: funded ? daily : null,
    days: funded ? days : null,
    total: funded ? daily * days : 0,
    boost: decision === 'YES' ? (funded ? `yes:$${formatUsd(daily)}` : 'yes') : decision.toLowerCase(),
    amount: funded ? `$${formatUsd(daily)}` : DASH,
    duration: funded ? plural(days, 'day') : DASH,
    targeting: decision !== 'NO' && targeting ? targeting : DASH,
  };
}

/** One row per Facebook post, in day order, for the BOOST BUDGET SUMMARY table. */
export function boostSummaryRows(plan, weekSpec) {
  return sortedFb(plan).map((item) => {
    const date = fbDate(item, weekSpec);
    return {
      day: item.day,
      date,
      dateShort: formatShortDay(date),
      service: cell(item.service),
      type: item.type,
      post_goal: item.post_goal,
      ...boostFields(item),
    };
  });
}

/** The funded YES row with the largest total (earliest day on ties), or null. */
export function pickPriorityRow(rows) {
  return rows
    .filter((r) => r.decision === 'YES' && r.total > 0)
    .sort((a, b) => b.total - a.total || a.day - b.day)[0] || null;
}

// ─────────────────────────────────────────────
// GBP schedule
// ─────────────────────────────────────────────

function renderGbpBlock(item, weekSpec) {
  return [
    `**DAY:** ${item.day}`,
    fieldLine('DATE', gbpDate(item, weekSpec)),
    fieldLine('SERVICE', item.service),
    fieldLine('TOPIC', item.topic),
    fieldLine('TREND_TIE', item.trend_tie),
    fieldLine('HEADLINE', item.headline),
    fieldLine('BODY', item.body),
    fieldLine('CAPTION', item.caption),
    `**PHOTO_FILE:** ${gbpPhotoField(item)}`,
    fieldLine('CTA', item.cta),
    fieldLine('HASHTAGS', formatHashtags(item.hashtags)),
    `**STATUS:** ${STATUS}`,
  ].join('\n');
}

function renderGbpPhotoGaps(items, weekSpec, notes) {
  const missing = items.filter((item) => !inlineText(item.photo_file));
  const out = ['## Photo Gaps', ''];
  if (missing.length) {
    out.push('The following days have no photo assigned. The posting script will not attach a photo until the owner supplies one and updates PHOTO_FILE.', '');
    out.push('| Day | Date | Service | Assigned Photo | Concern |');
    out.push('|-----|------|---------|---------------|---------|');
    for (const item of missing) {
      out.push(`| **Day ${item.day}** | ${gbpDate(item, weekSpec)} | ${cell(item.service)} | \`NEEDS PHOTO\` | No matching photo in the available library — owner to supply one before approving |`);
    }
  } else {
    out.push('No photo gaps: every day has an assigned photo from the available library. Owner should still open each file and confirm it matches the post topic.');
  }
  const planner = (notes.photo_gaps || []).map(inlineText).filter(Boolean);
  if (planner.length) out.push('', '### Notes from the planner', '', bullets(planner));
  return out.join('\n');
}

function renderTrendSummary(plan, attemptId) {
  const notes = plan.notes || {};
  const t = plan.topic || {};
  const family = (t.query_family || []).map(inlineText).filter(Boolean);
  const out = [
    '## Trend Summary This Week',
    '',
    `*Source: scripts/weekly collectors (Search Console, Facebook Insights, SerpApi, publish history) for attempt ${attemptId}.*`,
    '',
    `**Selected topic:** ${topicLabel(plan)}${family.length ? ` (query family: ${family.join(', ')})` : ''}.`,
    '',
    bullets(notes.trend_signals, 'No trend signals recorded this week.'),
  ];
  if (notes.degraded) out.push('', `**Degraded run:** ${inlineText(notes.degraded_reason) || 'one or more collectors were unavailable'}.`);
  return out.join('\n');
}

function renderGbpOwnerNotes(plan, items, weekSpec) {
  const notes = plan.notes || {};
  const missing = items.filter((item) => !inlineText(item.photo_file));
  const actions = plan.website_actions || [];
  const gated = actions.filter((a) => a.owner_gate).length;
  const lines = [
    '## Owner Notes',
    '',
    '**Review required before the posting script runs. Nothing in this schedule is marked ready to post.**',
    '',
    '1. **Visually verify every photo assignment.** Photos were matched from the available library by filename; the posting script cannot confirm photo content. Open each file and confirm it shows the correct service before approving the post.',
    `2. **Photos still needed:** ${missing.length
      ? missing.map((item) => `Day ${item.day} (${gbpDate(item, weekSpec)}, ${inlineText(item.service)})`).join('; ')
      : 'none — every day has a photo assigned'}.`,
    `3. **Website actions:** ${actions.length
      ? `${plural(actions.length, 'action')} queued in website_queue.md (${gated} owner-gated); nothing on the website changes without approval`
      : 'none queued this week'}.`,
  ];
  if (notes.degraded) {
    lines.push(`4. **Degraded run.** ${inlineText(notes.degraded_reason) || 'One or more data sources were unavailable'}; topic selection leaned on policy priorities and history. Review the topic choice with extra care.`);
  }
  return lines.join('\n');
}

/**
 * Markdown in the exact block layout of outputs/gbp_posting_schedule.md.
 * @param {object} plan PlanSchema
 * @param {object} weekSpec WeekSpecSchema (dates win over item.date)
 * @param {object} [options] { preparedBy }
 */
export function renderGbpSchedule(plan, weekSpec, options = {}) {
  const items = sortedGbp(plan);
  const notes = plan.notes || {};
  const attemptId = plan.attempt_id || 'unknown';
  const preparedBy = inlineText(options.preparedBy) || `scripts/weekly (attempt ${attemptId})`;
  const first = items[0] ? gbpDate(items[0], weekSpec) : weekSpec?.gbp_start || '';
  const last = items.length ? gbpDate(items[items.length - 1], weekSpec) : '';
  const signalCount = (notes.trend_signals || []).length;
  const trendSource = [
    `> **Trend Source:** scripts/weekly collectors (Search Console, Facebook Insights, SerpApi, publish history). Selected topic: ${topicLabel(plan)}. ${plural(signalCount, 'trend signal')} recorded — see Trend Summary This Week.`,
    notes.degraded ? ` Degraded run: ${inlineText(notes.degraded_reason) || 'one or more collectors were unavailable'}.` : '',
  ].join('');

  const parts = [
    `# ${BRAND} — 7-Day GBP Posting Schedule`,
    `**Schedule Period: ${formatDateRange(first, last)} | Prepared by ${preparedBy}**`,
    '',
    '---',
    '',
    trendSource,
    '',
    '---',
    '',
    '## 7-Day GBP Post Schedule',
    '',
    '---',
    '',
  ];
  for (const item of items) parts.push(renderGbpBlock(item, weekSpec), '', '---', '');
  parts.push(renderGbpPhotoGaps(items, weekSpec, notes), '', '---', '');
  parts.push(renderTrendSummary(plan, attemptId), '', '---', '');
  parts.push(renderGbpOwnerNotes(plan, items, weekSpec), '');
  return parts.join('\n');
}

// ─────────────────────────────────────────────
// Facebook schedule
// ─────────────────────────────────────────────

function renderFbBlock(item, weekSpec) {
  const date = fbDate(item, weekSpec);
  const b = boostFields(item);
  return [
    `## DAY ${item.day}`,
    '',
    `**DAY:** ${item.day}`,
    date ? `**DATE:** ${date} (${formatLongDate(date)})` : '**DATE:**',
    fieldLine('TYPE', item.type),
    fieldLine('SERVICE', item.service),
    fieldLine('POST_GOAL', item.post_goal),
    fieldLine('FORMAT', item.format),
    '',
    followingLineField('HOOK', item.hook),
    '',
    followingLineField('BODY', item.body),
    '',
    followingLineField('CTA', item.cta),
    '',
    fieldLine('HASHTAGS', formatHashtags(item.hashtags)),
    '',
    fieldLine('CONTACT', item.contact),
    '',
    `**PHOTO_FILE:** ${fbPhotoField(item)}`.trimEnd(),
    '',
    fieldLine('VIDEO_PROMPT', ''),
    '',
    followingLineField('ON_SCREEN_TEXT', item.on_screen_text),
    '',
    `**BOOST:** ${b.boost}`,
    `**BOOST_AMOUNT:** ${b.amount}`,
    `**BOOST_DURATION:** ${b.duration}`,
    `**BOOST_TARGETING:** ${b.targeting}`,
    `**STATUS:** ${STATUS}`,
  ].join('\n');
}

function renderFbContentNotes(plan, items, weekSpec) {
  const notes = plan.notes || {};
  const out = [
    '## CONTENT NOTES',
    '',
    '### Trend Signals Used',
    '',
    bullets(notes.trend_signals, 'No trend signals recorded this week.'),
    '',
    '### Photo Gaps Identified',
    '',
    bullets(notes.photo_gaps, 'None recorded by the planner.'),
    '',
    '### Content Format Rotation',
    '',
    '| Day | Date | Type | Format | Post Goal |',
    '|-----|------|------|--------|-----------|',
  ];
  for (const item of items) {
    out.push(`| Day ${item.day} | ${fbDate(item, weekSpec)} | ${cell(item.type)} | ${cell(item.format)} | ${cell(item.post_goal)} |`);
  }
  out.push(
    '',
    '### General Notes',
    '',
    `- **Selected topic:** ${topicLabel(plan)}.`,
    '- **Contact info policy:** the CONTACT line is posted by the poster script as the first comment. It is not part of the caption, and no phone number appears in any hook, body, or CTA.',
    '- **Photos:** PHOTO_FILE names come from the available library; the curation step may refine them before posting.',
  );
  if (notes.degraded) out.push(`- **Degraded run:** ${inlineText(notes.degraded_reason) || 'one or more collectors were unavailable'}.`);
  return out.join('\n');
}

/**
 * The BOOST BUDGET SUMMARY section. fb-boost-ledger.mjs parses it as the authoritative
 * allocation, so every value here is deterministic and free of conditional wording.
 */
export function renderBoostSummary(plan, weekSpec, options = {}) {
  const weeklyUsd = Number.isFinite(options.boostWeeklyUsd) ? options.boostWeeklyUsd : DEFAULT_BOOST_WEEKLY_USD;
  const rows = boostSummaryRows(plan, weekSpec);
  const boosted = rows.filter((r) => r.decision === 'YES' && r.total > 0);
  const total = boosted.reduce((sum, r) => sum + r.total, 0);
  const priority = pickPriorityRow(rows);
  const city = inlineText(plan?.topic?.city) || DEFAULT_CITY;

  const out = [
    '## BOOST BUDGET SUMMARY',
    '',
    `### Weekly Budget: $${formatUsd(weeklyUsd)}`,
    '',
    '| Post | Day | Service | Boost Decision | Daily Budget | Duration | Total |',
    '|------|-----|---------|---------------|-------------|----------|-------|',
  ];
  for (const r of rows) {
    const funded = r.decision === 'YES' && r.total > 0;
    out.push(`| Day ${r.day} | ${r.dateShort} | ${r.service} | ${r.decision} | ${funded ? `$${formatUsd(r.daily)}/day` : DASH} | ${funded ? plural(r.days, 'day') : DASH} | $${formatUsd(r.total)} |`);
  }
  out.push(
    '',
    `- **Posts boosted:** ${boosted.length} of ${rows.length}`,
    `- **TOTAL SPEND:** $${formatUsd(total)}`,
    `- **Priority post (boost first):** ${priority
      ? `Day ${priority.day} - ${priority.service}, ${priority.post_goal} ${priority.type} post on ${priority.dateShort} with the largest allocation ($${formatUsd(priority.daily)}/day x ${plural(priority.days, 'day')} = $${formatUsd(priority.total)}). It runs first; any second YES row runs alongside it.`
      : 'None - no post is funded this week.'}`,
    `- **Expected weekly reach from boosts:** ${boosted.length ? '~3,000–7,000 additional impressions' : '~0 additional impressions (no paid reach this week)'}`,
    `- **Expected weekly engagement from boosts:** ${boosted.length ? '~50–120 additional engagements' : '~0 additional engagements (no paid reach this week)'}`,
    `- **Boost targeting:** 15mi radius from ${city} TX, homeowners 28–65, home improvement / DIY / real estate interests. Exclude electrician interest (that is competitors). Use Advantage+ Audience for AI optimization.`,
  );
  return out.join('\n');
}

/**
 * Markdown in the exact block layout of outputs/facebook_posting_schedule.md.
 * @param {object} plan PlanSchema
 * @param {object} weekSpec WeekSpecSchema (dates win over item.date)
 * @param {object} [options] { boostWeeklyUsd = 50, preparedBy }
 */
export function renderFacebookSchedule(plan, weekSpec, options = {}) {
  const items = sortedFb(plan);
  const attemptId = plan.attempt_id || 'unknown';
  const preparedBy = inlineText(options.preparedBy) || `scripts/weekly (attempt ${attemptId})`;
  const weekOf = weekSpec?.week_of || plan.week_of || (items[0] ? fbDate(items[0], weekSpec) : '');
  const first = items[0] ? fbDate(items[0], weekSpec) : weekOf;
  const last = items.length ? fbDate(items[items.length - 1], weekSpec) : weekOf;

  const parts = [
    `# ${BRAND} — Facebook Content Schedule`,
    `## Week of ${weekOf}`,
    `**Start Date:** ${weekOf} | **Schedule Period:** ${formatDateRange(first, last)} | Prepared by ${preparedBy}`,
    '',
    '---',
    '',
  ];
  for (const item of items) parts.push(renderFbBlock(item, weekSpec), '', '---', '');
  parts.push(renderFbContentNotes(plan, items, weekSpec), '', '---', '');
  parts.push(renderBoostSummary(plan, weekSpec, options), '');
  return parts.join('\n');
}

// ─────────────────────────────────────────────
// Website queue (human-only; nothing parses it)
// ─────────────────────────────────────────────

export function renderWebsiteQueue(plan) {
  const actions = plan?.website_actions || [];
  const out = [
    `# Website Queue — Week of ${plan?.week_of || 'unknown'}`,
    '',
    `**Topic:** ${topicLabel(plan)} | **Attempt:** ${plan?.attempt_id || 'unknown'}`,
    '',
  ];
  if (!actions.length) {
    out.push('No website actions this week.', '');
    return out.join('\n');
  }
  const gated = actions.filter((a) => a.owner_gate).length;
  out.push(`${plural(actions.length, 'action')} queued (${gated} owner-gated). Nothing here is executed automatically; every item needs approval before it touches the site.`, '');
  actions.forEach((a, i) => {
    out.push(
      `## ${i + 1}. ${inlineText(a.title) || '(untitled)'}`,
      '',
      `- **Type:** ${a.type || DASH}`,
      `- **Target:** ${inlineText(a.target) || DASH}`,
      `- **Priority:** ${a.priority || DASH}`,
      `- **Owner gate:** ${a.owner_gate ? 'yes — owner must confirm before this is worked' : 'no'}`,
      `- **Description:** ${inlineText(a.description) || DASH}`,
      `- **Sources:** ${(a.source_ids || []).map(inlineText).filter(Boolean).join(', ') || DASH}`,
    );
    if (a.draft) {
      const html = String(a.draft.html ?? '').replace(/\r\n?/g, '\n').trim();
      const fence = codeFence(html);
      out.push(
        `- **Draft title:** ${inlineText(a.draft.title) || DASH}`,
        `- **Draft meta description:** ${inlineText(a.draft.meta_description) || DASH}`,
        '',
        `${fence}html`,
        html,
        fence,
      );
    } else {
      out.push('- **Draft:** none');
    }
    out.push('');
  });
  return out.join('\n');
}

// ─────────────────────────────────────────────
// Plan summary (human-only)
// ─────────────────────────────────────────────

function durationBetween(startIso, endIso) {
  const a = Date.parse(startIso || '');
  const b = Date.parse(endIso || '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return DASH;
  return `${((b - a) / 1000).toFixed(1)}s`;
}

function candidateLabel(c) {
  return `${inlineText(c?.service_label) || c?.service_key || '?'} — ${inlineText(c?.city) || '?'}`;
}

function renderAttemptSection(attempt) {
  if (!attempt) return ['## Attempt', '', '- No attempt record supplied.'].join('\n');
  const stages = Object.entries(attempt.stages || {});
  const out = [
    '## Attempt',
    '',
    `- **ID:** ${attempt.id || DASH}`,
    `- **Mode / status:** ${attempt.mode || DASH} / ${attempt.status || DASH}${attempt.error ? ` — ${inlineText(attempt.error)}` : ''}`,
    `- **Started:** ${attempt.started_at || DASH} | **Finished:** ${attempt.finished_at || 'not finished'} | **Runtime:** ${durationBetween(attempt.started_at, attempt.finished_at)}`,
    `- **Git SHA:** ${attempt.git_sha || DASH}`,
    `- **Models:** ${attempt.models?.generate || DASH} (fallback: ${attempt.models?.fallback || 'none'})`,
    `- **Spend:** $${Number(attempt.spent_usd || 0).toFixed(2)} of $${Number(attempt.budget_usd || 0).toFixed(2)} budget`,
    `- **Versions:** schema ${attempt.versions?.schema || DASH}, prompt ${attempt.versions?.prompt || DASH}, policy ${attempt.versions?.policy || DASH}`,
  ];
  if (stages.length) {
    out.push('', '### Stages', '', '| Stage | Status | Duration | Error |', '|-------|--------|----------|-------|');
    for (const [name, s] of stages) {
      out.push(`| ${name} | ${s?.status || DASH} | ${durationBetween(s?.started_at, s?.finished_at)} | ${cell(s?.error || '')} |`);
    }
  }
  return out.join('\n');
}

function renderSelectionSection(plan, selection) {
  const out = ['## Topic', '', `- **Winner:** ${topicLabel(plan)}`];
  const family = (plan?.topic?.query_family || []).map(inlineText).filter(Boolean);
  if (family.length) out.push(`- **Query family:** ${family.join(', ')}`);
  if (!selection) {
    out.push('- **Selection:** no selection record supplied.');
    return out.join('\n');
  }
  const w = selection.winner || {};
  out.push(
    `- **Score:** ${Number(w.total || 0).toFixed(3)}${selection.degraded ? ' (degraded selection — Search Console and SerpApi were both unavailable)' : ''}`,
    `- **Rationale:** ${inlineText(selection.rationale) || DASH}`,
  );
  const scores = w.scores || {};
  const keys = ['priority', 'demand', 'opportunity', 'recency', 'season', 'performance'];
  out.push('', '### Winner scores', '', `| ${keys.join(' | ')} |`, `|${keys.map(() => '---').join('|')}|`,
    `| ${keys.map((k) => Number(scores[k] ?? 0).toFixed(2)).join(' | ')} |`);
  if (Array.isArray(w.reasons) && w.reasons.length) out.push('', bullets(w.reasons));
  const runners = (selection.ranked || [])
    .filter((c) => !(c.service_key === w.service_key && c.city === w.city))
    .slice(0, 3);
  if (runners.length) {
    out.push('', '### Runners-up', '');
    runners.forEach((c, i) => out.push(`${i + 1}. ${candidateLabel(c)} (${Number(c.total || 0).toFixed(3)})`));
  }
  const excluded = selection.excluded || [];
  if (excluded.length) {
    out.push('', '### Excluded', '');
    for (const e of excluded) out.push(`- ${candidateLabel(e.candidate)}: ${inlineText(e.reason) || DASH}`);
  }
  return out.join('\n');
}

/**
 * Human summary of the whole run. `selection` and `attempt` may be null.
 */
export function renderPlanSummary(plan, selection, attempt) {
  const gbp = sortedGbp(plan);
  const fb = sortedFb(plan);
  const actions = plan?.website_actions || [];
  const notes = plan?.notes || {};
  const out = [
    `# Weekly Plan Summary — Week of ${plan?.week_of || attempt?.week_of || 'unknown'}`,
    '',
    renderAttemptSection(attempt),
    '',
    renderSelectionSection(plan, selection),
    '',
    `## GBP posts (${gbp.length})`,
    '',
    '| Day | Date | Service | Headline | Photo |',
    '|-----|------|---------|----------|-------|',
  ];
  for (const item of gbp) {
    out.push(`| ${item.day} | ${item.date || DASH} | ${cell(item.service)} | ${cell(item.headline)} | ${cell(item.photo_file || 'NEEDS PHOTO')} |`);
  }
  out.push('', `## Facebook posts (${fb.length})`, '', '| Day | Date | Type | Service | Hook | Photo | Boost |', '|-----|------|------|---------|------|-------|-------|');
  for (const item of fb) {
    const b = boostFields(item);
    const boostCell = b.decision === 'YES' && b.total > 0 ? `YES $${formatUsd(b.daily)}/day x ${plural(b.days, 'day')} = $${formatUsd(b.total)}` : b.decision;
    out.push(`| ${item.day} | ${item.date || DASH} | ${cell(item.type)} | ${cell(item.service)} | ${cell(item.hook)} | ${cell(fbPhotoField(item))} | ${boostCell} |`);
  }
  out.push('', `## Website actions (${actions.length})`, '');
  if (actions.length) {
    for (const a of actions) out.push(`- [${a.priority || DASH}] ${a.type || DASH} — ${inlineText(a.title) || '(untitled)'}${a.owner_gate ? ' (owner gate)' : ''}`);
  } else {
    out.push('- none');
  }
  out.push(
    '',
    '## Notes',
    '',
    `- **Degraded:** ${notes.degraded ? `yes — ${inlineText(notes.degraded_reason) || 'reason not given'}` : 'no'}`,
    '- **Trend signals:**',
    bullets(notes.trend_signals, 'none').replace(/^/gm, '  '),
    '- **Photo gaps:**',
    bullets(notes.photo_gaps, 'none').replace(/^/gm, '  '),
    '',
  );
  return out.join('\n');
}
