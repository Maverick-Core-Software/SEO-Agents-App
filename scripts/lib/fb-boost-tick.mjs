// Pure helpers for the mav-bridge Facebook boost tick. No I/O in this module —
// the bridge owns execFile and logging so these stay trivially testable.

// "09:30" -> { hour: 9, minute: 30 }. Invalid or empty input returns the parsed
// fallback (default '09:30'). Accepts H:MM and HH:MM, 24h.
export function parseAfterTime(text, fallback = '09:30') {
  const parse = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
  };
  return parse(text) || parse(fallback) || { hour: 9, minute: 30 };
}

// True when the Central clock is at or past `after` and no tick has run today.
export function shouldRunFbBoostTick({ todayDate, cstHour, cstMinute, lastTickDate, after }) {
  if (lastTickDate === todayDate) return false;
  const { hour, minute } = after || { hour: 9, minute: 30 };
  return cstHour > hour || (cstHour === hour && cstMinute >= minute);
}

// Whether the bridge should launch `fb-boost-api.mjs run` given the parsed
// output of `fb-boost-ledger.mjs eligible`.
//   eligible === true                        -> { launch: true,  reason: 'eligible' }
//   reason matches /human review required/i  -> { launch: true,  reason }
//   anything else                            -> { launch: false, reason: json?.reason || 'not eligible' }
export function decideBoostLaunch(eligibleJson) {
  if (eligibleJson?.eligible === true) return { launch: true, reason: 'eligible' };
  const reason = eligibleJson?.reason || '';
  if (/human review required/i.test(reason)) return { launch: true, reason };
  return { launch: false, reason: reason || 'not eligible' };
}

// Parse the booster's stdout. It pretty-prints one JSON object. Try JSON.parse
// on the trimmed payload; if that fails, try the substring from the first '{'
// to the last '}'. Return the object or null.
export function parseBoostResult(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* brace scan below */ }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try { return JSON.parse(raw.slice(first, last + 1)); } catch { return null; }
}

// Turn a finished booster invocation into one log line.
// Input: { stdout, stderr, exitCode, error } where exitCode is a number
// (0 on success) and error is the execFile error message if any.
// Output: { level: 'info' | 'warn' | 'error', line: string, result: object|null }
export function summarizeBoostRun({ stdout, stderr, exitCode, error }) {
  const result = parseBoostResult(stdout);
  if (!result) {
    const src = String(error || stderr || stdout || '').slice(0, 300);
    return { level: 'error', line: `failed: exit ${exitCode} ${src}`, result: null };
  }
  let level;
  let line;
  if (result.boost_applied === true) {
    level = 'info';
    line = `applied ${result.pick?.key} ad=${result.created?.ad_id} total=$${result.pick?.total}`;
  } else if (result.ok === false) {
    level = 'error';
    line = `failed at ${result.stage}: ${result.error || result.detail || result.reason}`;
  } else if (result.stage === 'eligible' && result.eligible === false) {
    level = 'info';
    line = `skip: ${result.reason} (not eligible)`;
  } else if (result.stage === 'resolve') {
    level = 'warn';
    line = `pending: post not live for ${result.pick?.key} (${result.reason}); next attempt tomorrow`;
    if (result.escalate === true) line += ' ESCALATED';
  } else if (result.stage === 'config') {
    level = 'warn';
    line = `skip: ${result.reason}`;
  } else {
    level = 'info';
    line = `${result.stage}: ${result.reason || 'ok'}`;
  }
  // Node 24 on Windows can abort during exit AFTER the result was printed; a
  // non-zero exit with a good result must not be logged as a failure.
  if (exitCode !== 0 && result.ok !== false) line += ` (exit ${exitCode} after result; ignored)`;
  return { level, line, result };
}
