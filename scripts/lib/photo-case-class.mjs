// scripts/lib/photo-case-class.mjs
// Forward vs historical classes for the photo-case audit (E4 gate).
//
//   forward     the pipeline will still read this file: an unposted GBP slot whose date is today or
//               later, a future manifest selection, or a curated label that can be picked.
//               Only forward references fail the default gate.
//   historical  already posted, past-dated, a cache key (the cache re-scores on a miss) or a
//               manifest sourcePath (provenance only). Reported as warnings.
//   warning     a curated label whose file is not in the library: it can never be picked, so it is
//               reported and does not fail the default gate. --strict still fails on it.
//
// Pure functions only; the audit script does the I/O.
import { NO_REUSE_WEEKS } from './photo-selection.mjs';

const DAY_MS = 86400000;

/** Today's calendar date in America/Chicago, as YYYY-MM-DD. */
export function chicagoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Adds whole days to a YYYY-MM-DD date (calendar arithmetic, no time zone involved). */
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first date still inside the no-reuse window ending on `today`. */
export function noReuseWindowStart(today, weeks = NO_REUSE_WEEKS) {
  return addDays(today, -7 * weeks);
}

/** YYYY-MM-DD from a Date or a string that starts with a date; '' when there is none. */
export function dateOnly(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim());
  return m ? m[1] : '';
}

/** A workbook Posted cell is true when it is the boolean true or a text meaning yes. */
export function isPostedValue(value) {
  if (value === true) return true;
  return /^(true|yes|y|1)$/i.test(String(value ?? '').trim());
}

/**
 * Manifest photoPath. Forward only when the slot is still unposted and not in the past: the GBP
 * workbook says it is not Posted, and the date is today or later. A past-dated unposted slot is
 * never republished by the pipeline, so its file is needed only to hash the row for the no-reuse
 * check, which the selector treats as unverified rather than blocking. Facebook entries cannot be
 * checked against the GBP workbook, so for them only the date decides.
 */
export function classifyManifestRef({ date, platform = 'gbp', postedDates = new Set(), today }) {
  // An undated entry cannot be proven historical, so it stays forward (fails the gate).
  if (!date) return { class: 'forward', reason: 'undated' };
  if (platform === 'gbp' && postedDates.has(date)) return { class: 'historical', reason: 'posted' };
  if (date >= today) return { class: 'forward', reason: 'unposted-future' };
  return { class: 'historical', reason: 'past-dated' };
}

/** Workbook photo cell. Forward iff the row is not Posted and its date is today or later. */
export function classifyWorkbookRef({ date, posted, today }) {
  if (!date) return { class: 'forward', reason: 'undated' };
  if (posted) return { class: 'historical', reason: 'posted' };
  return date >= today
    ? { class: 'forward', reason: 'unposted-future' }
    : { class: 'historical', reason: 'past-unposted' };
}

/** Cache key or cache filePath. Always historical: the cache re-scores a missing file on a miss. */
export function classifyCacheRef() {
  return { class: 'historical', reason: 'cache-rescores-on-miss' };
}

/**
 * Scanned strings. A curated-labels file is forward when the label's file is in the library, and
 * a warning when it is not (a label whose file is gone can never be picked). Any other scanned
 * file is forward by default, so an unknown source fails the gate rather than being waved through.
 */
export function classifyScanRef({ name, status }) {
  if (/curated-labels/i.test(name)) {
    return status === 'missing'
      ? { class: 'warning', reason: 'label-unpickable' }
      : { class: 'forward', reason: 'label-used-for-selection' };
  }
  return { class: 'forward', reason: 'scanned-reference' };
}

/** Normalises a reference or accept-list entry for matching: forward slashes, lower case. */
export function normalizeRefKey(value) {
  return String(value ?? '').trim().split('\\').join('/').toLowerCase();
}

/** Parses an --accept-missing file: one basename or path per line; blanks and # comments ignored. */
export function parseAcceptList(text) {
  const keys = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    keys.add(normalizeRefKey(t));
  }
  return keys;
}

/** Returns the accept-list key that matches this reference (full path or basename), or null. */
export function matchAccepted(ref, acceptKeys) {
  if (!acceptKeys || acceptKeys.size === 0) return null;
  const full = normalizeRefKey(ref);
  if (acceptKeys.has(full)) return full;
  const base = full.split('/').pop();
  return acceptKeys.has(base) ? base : null;
}
