/** America/Chicago calendar date. UTC midnight is 19:00 CT and must not roll "today". */
export function chicagoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function utcMidnight(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIsoDate(dt) {
  return dt.toISOString().slice(0, 10);
}

export function addDays(isoDate, n) {
  const dt = utcMidnight(isoDate);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toIsoDate(dt);
}

/** Sunday of the week containing isoDate (Sunday-start week). */
export function sundayOfWeek(isoDate) {
  const dt = utcMidnight(isoDate);
  const dow = dt.getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -dow);
}

/** Saturday of the same Sunday-start week (Sunday + 6). */
export function saturdayOfWeek(isoDate) {
  return addDays(sundayOfWeek(isoDate), 6);
}
