// scripts/lib/gbp-runner.mjs
// Single source of truth for GBP curation + posting logic, shared by mav-bridge
// (legacy/rollback path) and gbp-worker (the user-session owner).
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

// Excel cells store dates as Date objects, serial numbers, or strings depending
// on how the workbook was written. Normalise all three to an ISO yyyy-mm-dd.
export function excelDateToIso(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = xlsx.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  return String(value || '').slice(0, 10);
}

// The driver prints a JSON result as the last stdout line. Pull it out; tolerate noise.
export function parseDriverJson(stdout) {
  try {
    const lastLine = (stdout || '').trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    return lastLine ? JSON.parse(lastLine) : {};
  } catch {
    return {};
  }
}

export function gbpNeedsVerificationMessage(parsed = {}) {
  const attempts = parsed.verificationAttempts || 5;
  const snapshot = parsed.verificationSnapshot?.textFile || parsed.verificationSnapshot?.screenshot || '';
  const suffix = snapshot ? ` Snapshot: ${snapshot}` : '';
  return `GBP post was submitted but not verified after ${attempts} 60-second snapshot checks. Check manually before retrying.${suffix}`;
}

// Map a driver exit code to the weekly_posts update intent. `archive: true` means
// the caller should also run markGbpPostedAndArchive. Exit codes (driver.mjs):
//   0 = posted+verified, 3 = submitted-unverified, 4 = approval-gate-unset, else = error.
export function gbpDailyStatusForExit(exitCode, parsed = {}) {
  if (exitCode === 0) {
    return { status: 'posted', error: null, archive: true, platform_post_id: parsed.postUrl || null };
  }
  if (exitCode === 3) {
    return { status: 'needs_verification', error: gbpNeedsVerificationMessage(parsed), archive: false, platform_post_id: null };
  }
  if (exitCode === 4) {
    return { status: 'pending_approval', error: null, archive: false, platform_post_id: null };
  }
  return { status: 'error', error: null, archive: false, platform_post_id: null };
}

// Derive the Central-time (DST-aware) date + hour from a UTC instant. Used to gate
// the daily poster to once per calendar day after 9am Central.
export function centralDateHour(nowUtc) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(nowUtc);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const todayDate = `${get('year')}-${get('month')}-${get('day')}`;
  let cstHour = parseInt(get('hour'), 10);
  if (cstHour === 24) cstHour = 0; // some ICU builds emit 24 at midnight
  return { todayDate, cstHour };
}
