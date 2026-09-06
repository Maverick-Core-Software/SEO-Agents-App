/**
 * week-spec.mjs — the frozen posting-week identity, ported from
 * src/seo_agents/week_spec.py and fb_week_dates in src/seo_agents/crew.py.
 *
 * Rule (America/Chicago):
 *   run_friday = most recent Friday on or before the anchor (Friday stays Friday;
 *                Saturday/Sunday/Monday rewind to the previous Friday)
 *   week_of    = Monday on or after run_friday (seo_runs unique key)
 *   gbp_start  = run_friday; GBP day N = gbp_start + (N - 1)   (Fri..Thu)
 *   fb_dates   = Mon (1), Wed (3), Fri (5), Sat (6) of the week_of week
 *
 * All date math is on YYYY-MM-DD strings via UTC epoch days so the host
 * timezone never leaks in; only "today" is derived from the Chicago clock.
 */
import { WeekSpecSchema } from './schemas.mjs';

export const CHICAGO_TZ = 'America/Chicago';
const DAY_MS = 86400000;
const FB_DAY_OFFSET = { 1: 0, 3: 2, 5: 4, 6: 5 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(s) {
  if (!DATE_RE.test(String(s))) throw new Error(`week-spec: not a YYYY-MM-DD date: ${s}`);
  const [y, m, d] = s.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new Error(`week-spec: invalid calendar date: ${s}`);
  }
  return ms;
}

export function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(s, days) {
  return formatDate(parseDate(s) + days * DAY_MS);
}

/** Python-style weekday: Monday = 0 ... Sunday = 6. */
export function weekday(s) {
  return (new Date(parseDate(s)).getUTCDay() + 6) % 7;
}

/** Today's calendar date in Chicago for the given instant. */
export function chicagoToday(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Friday on or before the anchor. Monday goes back to the previous Friday. */
export function mostRecentFriday(anchor) {
  const back = (((weekday(anchor) - 4) % 7) + 7) % 7;
  return addDays(anchor, -back);
}

/** Monday on or after the anchor; a Monday anchor stays that Monday. */
export function mondayOnOrAfter(anchor) {
  return addDays(anchor, (7 - weekday(anchor)) % 7);
}

export function gbpDates(gbpStart, days = 7) {
  const out = {};
  for (let d = 1; d <= days; d += 1) out[d] = addDays(gbpStart, d - 1);
  return out;
}

export function fbDates(weekOf) {
  const out = {};
  for (const [day, offset] of Object.entries(FB_DAY_OFFSET)) out[day] = addDays(weekOf, offset);
  return out;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.anchor]  YYYY-MM-DD; defaults to Chicago today for `now`
 * @param {Date}   [opts.now]     instant used for the anchor default and computed_at
 */
export function computeWeekSpec({ anchor, now = new Date() } = {}) {
  const a = anchor || chicagoToday(now);
  const runFriday = mostRecentFriday(a);
  const weekOf = mondayOnOrAfter(runFriday);
  const spec = {
    run_friday: runFriday,
    week_of: weekOf,
    gbp_start: runFriday,
    computed_at: now.toISOString(),
    gbp_dates: gbpDates(runFriday),
    fb_dates: fbDates(weekOf),
  };
  const result = WeekSpecSchema.safeParse(spec);
  if (!result.success) throw new Error(`week-spec: internal error: ${result.error.issues[0].message}`);
  return result.data;
}

/** WeekSpec for a given week_of Monday (used when the wrapper passes --week-of). */
export function weekSpecForWeekOf(weekOf, now = new Date()) {
  if (weekday(weekOf) !== 0) throw new Error(`week-spec: --week-of must be a Monday, got ${weekOf}`);
  // The run Friday for a Monday week_of is the Friday three days before it.
  return computeWeekSpec({ anchor: addDays(weekOf, -3), now });
}
