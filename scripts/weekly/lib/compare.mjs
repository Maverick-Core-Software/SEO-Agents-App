// scripts/weekly/lib/compare.mjs
// Shadow-vs-legacy comparison report. Reads the legacy schedules in
// `outputsDir` and the shadow exports stage.mjs wrote to `shadowDir`, parses
// both sides with the legacy parsers in scripts/supabase-sync.mjs (which proves
// the shadow files round-trip the way the poster path reads them), and returns
// one Markdown report: counts per platform, the WeekSpec date check, facts
// violations in the published copy of each side (validate.mjs text rules),
// topics side by side, and the attempt's runtime and spend.
//
// Read-only: `outputsDir` is never modified and nothing is written anywhere.
// The caller decides where the report goes.
//
// Contract: scripts/weekly/DESIGN.md, "stage".
import fs from 'node:fs';
import path from 'node:path';
import { parseFacebookSchedule, parseGbpSchedule, parseFbWeekHeader } from '../../supabase-sync.mjs';
import { parseWebsiteTasks } from '../../lib/parse-website-tasks.mjs';
import { OUTPUTS_DIR, SHADOW_DIR } from './paths.mjs';
import { textFactsErrors } from './validate.mjs';
import { weekSpecForWeekOf } from './week-spec.mjs';

export const GBP_DAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const FB_DAYS = Object.freeze([1, 3, 5, 6]);

/** Legacy files read from `outputsDir` (all optional). */
export const LEGACY_FILES = Object.freeze({
  gbp: 'gbp_posting_schedule.md',
  facebook: 'facebook_posting_schedule.md',
  queue: 'grizzly_execution_queue.md',
  finalReport: 'final_report.md',
});

/** Shadow files read from `shadowDir` (plan.json is required). */
export const SHADOW_FILES = Object.freeze({
  gbp: 'gbp_posting_schedule.md',
  facebook: 'facebook_posting_schedule.md',
  plan: 'plan.json',
  selection: 'selection.json',
  attempt: 'attempt.json',
});

/** Row fields that are published copy (the parsers put GBP HEADLINE in `hook`). */
const ROW_TEXT_FIELDS = Object.freeze(['hook', 'body', 'cta', 'hashtags']);
const CELL_MAX = 70;

const iso = (d) => new Date(d).toISOString();
const isMissing = (e) => e && e.code === 'ENOENT';

/** `now` as a Date (an ISO string is accepted); an invalid instant is refused. */
function toDate(now, label) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new TypeError(`${label}: now must be a valid Date`);
  return at;
}

function readText(dir, name) {
  try { return fs.readFileSync(path.join(dir, name), 'utf8'); }
  catch (e) { if (isMissing(e)) return null; throw e; }
}

function readJson(dir, name) {
  const text = readText(dir, name);
  return text == null ? null : JSON.parse(text);
}

/** Legacy outputs as text (null when a file is absent). Never writes. */
export function readLegacyOutputs(outputsDir = OUTPUTS_DIR) {
  const dir = path.resolve(outputsDir);
  return {
    dir,
    gbpText: readText(dir, LEGACY_FILES.gbp),
    fbText: readText(dir, LEGACY_FILES.facebook),
    queueText: readText(dir, LEGACY_FILES.queue),
    finalReportText: readText(dir, LEGACY_FILES.finalReport),
  };
}

/** Shadow exports; throws when plan.json is missing (nothing to compare). */
export function readShadowOutputs(shadowDir = SHADOW_DIR) {
  const dir = path.resolve(shadowDir);
  const plan = readJson(dir, SHADOW_FILES.plan);
  if (!plan) throw new Error(`compareWithLegacy: ${path.join(dir, SHADOW_FILES.plan)} not found; stage the plan first`);
  return {
    dir,
    gbpText: readText(dir, SHADOW_FILES.gbp),
    fbText: readText(dir, SHADOW_FILES.facebook),
    plan,
    selection: readJson(dir, SHADOW_FILES.selection),
    attempt: readJson(dir, SHADOW_FILES.attempt),
  };
}

function safeWebsiteTasks(queueText, finalReportText) {
  if (!queueText && !finalReportText) return [];
  try { return parseWebsiteTasks(queueText || '', finalReportText || '') || []; }
  catch { return []; }
}

/** Parse one side with the legacy parsers. */
export function parseSide({ gbpText, fbText, queueText, finalReportText } = {}) {
  return {
    gbp: gbpText ? parseGbpSchedule(gbpText) : [],
    facebook: fbText ? parseFacebookSchedule(fbText) : [],
    website: safeWebsiteTasks(queueText, finalReportText),
    fbWeekOf: parseFbWeekHeader(fbText || '') || null,
  };
}

/**
 * Compare parsed rows with the WeekSpec dates for `days`.
 * → { slots: [{ day, expected, actual, duplicates, ok }], missing, extra, offSpec }
 * `offSpec` counts the expected slots that are wrong, missing or duplicated;
 * days outside `days` are listed in `extra` and never counted as slots.
 */
export function checkDates(rows, expectedByDay, days) {
  const byDay = new Map();
  for (const row of rows || []) {
    const day = Number(row.day);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row.post_date || null);
  }
  const slots = days.map((day) => {
    const expected = (expectedByDay && expectedByDay[day]) || null;
    const found = byDay.get(day) || [];
    const actual = found[0] || null;
    const duplicates = found.length > 1;
    return { day, expected, actual, duplicates, ok: Boolean(expected && actual && actual === expected && !duplicates) };
  });
  const extra = [...byDay.keys()].filter((d) => !days.includes(d)).sort((a, b) => a - b);
  const missing = slots.filter((s) => !s.actual).map((s) => s.day);
  return { slots, extra, missing, offSpec: slots.filter((s) => !s.ok).length };
}

/** validate.mjs text rules (phones, domain, tenure, prices) over each row's published copy. */
export function factsViolations(side, { facts, weekSpec, policy }) {
  const out = [];
  for (const [platform, rows] of [['GBP', side.gbp], ['Facebook', side.facebook]]) {
    for (const row of rows || []) {
      const text = ROW_TEXT_FIELDS.map((f) => row[f]).filter((v) => typeof v === 'string' && v.trim()).join('\n');
      if (!text) continue;
      out.push(...textFactsErrors(text, { facts, weekSpec, policy, label: `${platform} day ${row.day}` }));
    }
  }
  return out;
}

/** Service label → row count, most frequent first. */
export function serviceCounts(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const key = String(row.service || '').trim() || '(none)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const usd = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : '—');

function cell(value, max = CELL_MAX) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || '—';
}

function mark(ok) { return ok ? '✓' : '✗'; }

/** Credential shapes that must never reach the report: key=value params, bearer tokens, sk-/rk- keys, JWTs. */
const SECRET_PATTERNS = Object.freeze([
  [/\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd|authorization))=([^&\s"'`]+)/gi, '$1=[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]'],
]);

/**
 * Mask credential-shaped substrings in free text. Attempt and stage error
 * messages are written by every collector and the LLM client, and the report
 * is shared Markdown, so a key that slipped into an error message is masked
 * here as a last line of defence (the collectors redact their own keys first).
 */
export function redactSecrets(text) {
  let s = String(text == null ? '' : text);
  for (const [re, sub] of SECRET_PATTERNS) s = s.replace(re, sub);
  return s;
}

function dateCell(slot) {
  if (!slot.actual) return 'missing ✗';
  return `${slot.actual} ${mark(slot.ok)}${slot.duplicates ? ' (duplicate day)' : ''}`;
}

function datesLine(label, gbp, fb) {
  const total = gbp.slots.length + fb.slots.length;
  const notes = [];
  const missing = [...gbp.missing.map((d) => `GBP ${d}`), ...fb.missing.map((d) => `FB ${d}`)];
  const extra = [...gbp.extra.map((d) => `GBP ${d}`), ...fb.extra.map((d) => `FB ${d}`)];
  if (missing.length) notes.push(`missing ${missing.join(', ')}`);
  if (extra.length) notes.push(`unexpected day ${extra.join(', ')}`);
  return `${label}: ${gbp.offSpec + fb.offSpec} of ${total} slots off-spec${notes.length ? ` (${notes.join('; ')})` : ''}.`;
}

function rowFor(rows, day) {
  return (rows || []).find((r) => Number(r.day) === day) || null;
}

function attemptLines(attempt, { now, spentUsd }) {
  if (!attempt) return ['- Attempt record not found in the shadow directory.'];
  const started = Date.parse(attempt.started_at);
  const finished = attempt.finished_at ? Date.parse(attempt.finished_at) : NaN;
  const running = Number.isNaN(finished);
  const end = running ? now.getTime() : finished;
  const spent = spentUsd != null ? spentUsd : attempt.spent_usd;
  const lines = [
    `- Attempt \`${attempt.id}\` — mode ${attempt.mode || 'unknown'}, status ${attempt.status || 'unknown'}${attempt.error ? ` (${cell(redactSecrets(attempt.error), 160)})` : ''}`,
    `- Started ${attempt.started_at || '—'}; ${running ? 'not finished at compare time' : `finished ${attempt.finished_at}`}; runtime ${formatDuration(end - started)}${running ? ' so far' : ''}`,
    `- Spend ${usd(spent)} of ${usd(attempt.budget_usd)} budget${spentUsd != null ? ' (live meter)' : ''}`,
    `- Models: ${attempt.models && attempt.models.generate ? attempt.models.generate : 'unknown'}; git ${attempt.git_sha || 'unknown'}`,
  ];
  const stages = Object.entries(attempt.stages || {});
  if (stages.length) {
    lines.push('', '| Stage | Status | Duration | Error |', '|---|---|---|---|');
    for (const [name, stage] of stages) {
      const s = Date.parse(stage.started_at);
      const e = stage.finished_at ? Date.parse(stage.finished_at) : now.getTime();
      lines.push(`| ${cell(name)} | ${cell(stage.status)} | ${formatDuration(e - s)}${stage.finished_at ? '' : ' (running)'} | ${cell(redactSecrets(stage.error), 120)} |`);
    }
  }
  lines.push('', '- Legacy runtime and spend: not recorded by the legacy pipeline.');
  return lines;
}

/**
 * Build the Markdown report from parsed sides. Pure.
 *
 * @param {object} ctx
 *   legacy: parseSide() result plus `files: { [name]: boolean }`
 *   shadow: parseSide() result plus `plan`, `selection`, `attempt`, `website` (plan.website_actions)
 *   weekSpec, facts (optional), policy (optional), attempt (overrides shadow.attempt),
 *   spentUsd (live meter, optional), now: Date, shadowDir, outputsDir
 */
export function buildCompareReport({ legacy, shadow, weekSpec, facts, policy, attempt, spentUsd, now = new Date(), shadowDir = '', outputsDir = '' }) {
  if (!weekSpec) throw new TypeError('buildCompareReport: weekSpec is required');
  const at = toDate(now, 'buildCompareReport');
  const lines = [];
  const push = (...l) => lines.push(...l);
  const legacyGbp = checkDates(legacy.gbp, weekSpec.gbp_dates, GBP_DAYS);
  const legacyFb = checkDates(legacy.facebook, weekSpec.fb_dates, FB_DAYS);
  const shadowGbp = checkDates(shadow.gbp, weekSpec.gbp_dates, GBP_DAYS);
  const shadowFb = checkDates(shadow.facebook, weekSpec.fb_dates, FB_DAYS);
  const shadowWebsite = shadow.website || (shadow.plan && shadow.plan.website_actions) || [];

  push(`# Shadow comparison — week of ${weekSpec.week_of}`, '');
  push(`Generated ${iso(at)}. Legacy outputs: \`${outputsDir}\`. Shadow outputs: \`${shadowDir}\`. Read-only: neither directory was modified.`, '');

  push('## Counts', '', '| Platform | Expected | Legacy | Shadow |', '|---|---|---|---|');
  push(`| GBP | ${GBP_DAYS.length} | ${legacy.gbp.length} | ${shadow.gbp.length} |`);
  push(`| Facebook | ${FB_DAYS.length} | ${legacy.facebook.length} | ${shadow.facebook.length} |`);
  push(`| Website | — | ${legacy.website.length} | ${shadowWebsite.length} |`, '');
  const files = Object.entries(legacy.files || {});
  if (files.length) push(`Legacy files: ${files.map(([name, present]) => `${name} ${present ? 'present' : 'missing'}`).join(', ')}.`, '');

  push(`## Dates (WeekSpec: GBP starts ${weekSpec.gbp_start}, week of ${weekSpec.week_of})`, '');
  push('| Platform | Day | Expected | Legacy | Shadow |', '|---|---|---|---|---|');
  for (let i = 0; i < GBP_DAYS.length; i++) {
    push(`| GBP | ${GBP_DAYS[i]} | ${legacyGbp.slots[i].expected || '—'} | ${dateCell(legacyGbp.slots[i])} | ${dateCell(shadowGbp.slots[i])} |`);
  }
  for (let i = 0; i < FB_DAYS.length; i++) {
    push(`| Facebook | ${FB_DAYS[i]} | ${legacyFb.slots[i].expected || '—'} | ${dateCell(legacyFb.slots[i])} | ${dateCell(shadowFb.slots[i])} |`);
  }
  push('', datesLine('Legacy', legacyGbp, legacyFb), datesLine('Shadow', shadowGbp, shadowFb));
  const planWeek = shadow.plan && shadow.plan.week_of;
  if (planWeek && planWeek !== weekSpec.week_of) {
    push(`Shadow plan week_of ${planWeek} does not match the WeekSpec week ${weekSpec.week_of} ✗ (the shadow dates above are checked against the WeekSpec).`);
  }
  const shadowHeaderOk = shadow.fbWeekOf === weekSpec.week_of;
  push(`Facebook week header: legacy → ${legacy.fbWeekOf ? `${legacy.fbWeekOf} ${mark(legacy.fbWeekOf === weekSpec.week_of)}` : 'no ISO "week of" date (legacy sync needs --week-of)'}; shadow → ${shadow.fbWeekOf ? `${shadow.fbWeekOf} ${mark(shadowHeaderOk)}` : 'missing ✗'}.`, '');

  push('## Facts violations (validate.mjs text rules: phones, domain, tenure, prices)', '');
  if (!facts) {
    push('_Facts not provided; text rules skipped._', '');
  } else {
    for (const [label, side] of [['Legacy copy', legacy], ['Shadow copy', shadow]]) {
      const found = factsViolations(side, { facts, weekSpec, policy });
      push(`### ${label}`, '');
      if (found.length) push(...found.map((v) => `- ${v}`), '');
      else push('_None._', '');
    }
  }

  push('## Topics side by side', '', '| Slot | Legacy service | Legacy hook | Shadow service | Shadow hook |', '|---|---|---|---|---|');
  for (const day of GBP_DAYS) {
    const l = rowFor(legacy.gbp, day);
    const s = rowFor(shadow.gbp, day);
    push(`| GBP ${day} | ${cell(l && l.service)} | ${cell(l && l.hook)} | ${cell(s && s.service)} | ${cell(s && s.hook)} |`);
  }
  for (const day of FB_DAYS) {
    const l = rowFor(legacy.facebook, day);
    const s = rowFor(shadow.facebook, day);
    push(`| Facebook ${day} | ${cell(l && l.service)} | ${cell(l && l.hook)} | ${cell(s && s.service)} | ${cell(s && s.hook)} |`);
  }
  push('');
  const legacyLead = serviceCounts([...legacy.gbp, ...legacy.facebook]);
  push(`- Legacy lead service: ${legacyLead.length ? `${legacyLead[0][0]} (${legacyLead[0][1]} of ${legacy.gbp.length + legacy.facebook.length} posts)` : 'none parsed'}`);
  const topic = (shadow.plan && shadow.plan.topic) || null;
  const winner = shadow.selection && shadow.selection.winner;
  push(`- Shadow topic: ${topic ? `${topic.service_label} in ${topic.city}` : 'unknown'}${winner ? ` (winner total ${Number(winner.total).toFixed(3)}${shadow.selection.degraded ? ', degraded selection' : ''})` : ''}`);
  if (shadow.selection && shadow.selection.rationale) push(`- Shadow rationale: ${cell(shadow.selection.rationale, 600)}`);
  const legacyServices = new Set(legacyLead.map(([s]) => s.toLowerCase()));
  const shadowServices = serviceCounts([...shadow.gbp, ...shadow.facebook]).map(([s]) => s);
  const common = shadowServices.filter((s) => legacyServices.has(s.toLowerCase()));
  push(`- Services on both sides: ${common.length ? common.join(', ') : 'none'}`);
  if (shadowWebsite.length) {
    push('', '### Shadow website actions', '');
    for (const action of shadowWebsite) push(`- ${cell(action.type)} — ${cell(action.title, 120)}${action.owner_gate ? ' (owner gate)' : ''}`);
  }
  if (legacy.website.length) {
    push('', '### Legacy website tasks', '');
    for (const task of legacy.website.slice(0, 20)) push(`- ${cell(task.type)} — ${cell(task.title, 120)}${task.status ? ` [${cell(task.status)}]` : ''}`);
    if (legacy.website.length > 20) push(`- … ${legacy.website.length - 20} more`);
  }
  push('');

  push('## Attempt', '', ...attemptLines(attempt || shadow.attempt || null, { now: at, spentUsd }), '');
  return lines.join('\n');
}

/**
 * Read both sides and build the report. Read-only. `weekSpec` defaults to the
 * spec for the shadow plan's week; `attempt` and `spentUsd` let the caller pass
 * the live attempt record and meter total when compare runs before finish.
 */
export function compareWithLegacy({
  shadowDir = SHADOW_DIR, outputsDir = OUTPUTS_DIR, facts, weekSpec, policy, attempt, spentUsd, now = new Date(),
} = {}) {
  const at = toDate(now, 'compareWithLegacy');
  const legacyFiles = readLegacyOutputs(outputsDir);
  const shadowFiles = readShadowOutputs(shadowDir);
  const spec = weekSpec || weekSpecForWeekOf(shadowFiles.plan.week_of, at);
  const legacy = {
    ...parseSide(legacyFiles),
    files: {
      [LEGACY_FILES.gbp]: legacyFiles.gbpText != null,
      [LEGACY_FILES.facebook]: legacyFiles.fbText != null,
      [LEGACY_FILES.queue]: legacyFiles.queueText != null,
      [LEGACY_FILES.finalReport]: legacyFiles.finalReportText != null,
    },
  };
  const shadow = {
    ...parseSide({ gbpText: shadowFiles.gbpText, fbText: shadowFiles.fbText }),
    website: Array.isArray(shadowFiles.plan.website_actions) ? shadowFiles.plan.website_actions : [],
    plan: shadowFiles.plan,
    selection: shadowFiles.selection,
    attempt: shadowFiles.attempt,
  };
  return buildCompareReport({
    legacy, shadow, weekSpec: spec, facts, policy, attempt, spentUsd, now: at,
    shadowDir: shadowFiles.dir, outputsDir: legacyFiles.dir,
  });
}
