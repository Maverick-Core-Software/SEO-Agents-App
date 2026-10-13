#!/usr/bin/env node
/**
 * gbp-api-poster.mjs
 * Google Business Profile API poster. Replaces the Playwright driver for live
 * posts. Reads the same workbook + config as scripts/gbp-poster/driver.mjs and
 * emits the same result JSON / exit-code contract — minus `--schedule`, which
 * the GBP API does not support. Days 2-7 are marked `scheduled` by the runner
 * and posted by the daily worker on their morning (no native scheduling).
 *
 * Photos: the local curated file is uploaded via GBP's media:startUpload +
 * raw-bytes endpoint and attached to the post via dataRef. No public URL or
 * Drive hosting required. The Drive folder (H:\My Drive\GBP Photos) stays in
 * its existing role as the photo *source* — gbp-photo-pick.mjs still mirrors
 * it to the local cache and curates per-post.
 *
 * Photo rule (G3): the image is resolved ONLY through the audited selection
 * manifest (state/photo-selection-manifest.json, written by gbp-photo-pick):
 * no `<date>-` folder scan, no curated fallback, never text-only. The bytes
 * must match the audited sha256, pass checkImagePolicy (JPG/PNG >= 10 KB; HEIC
 * is converted with heic-convert or refused), and must not collide with any
 * manifest hash inside 8 weeks. Refusals are exit 5 with `reason`
 * (image_missing | image_format | image_policy | hash_conflict | vision_*).
 * `--dry-run` prints {date,image_path,image_sha256,image_exists,manifest_ok}.
 * GBP_PHOTO_VISION_CHECK=1 adds one gpt-4o yes/no on the actual bytes.
 * On success a {postedBy:'gbp-api'} row is appended to the manifest under its lock.
 *
 * Idempotent create (G2): before creating, the location's localPosts are listed
 * (v4, paginated) and a post whose summary starts with the same first 60
 * characters (whitespace-normalised) created within the last 7 days means the
 * post is already live: exit 0 with `already_live` and its resource name, no
 * second create. A matching post Google REJECTED / took down is exit 5: a
 * re-create would be refused again and risks the profile-wide posting ban.
 *
 * Usage:
 *   node gbp-api-poster.mjs --date <yyyy-mm-dd> [--dry-run] [--config <path>] [--selfcheck]
 *
 * Exit codes (match driver.mjs so gbp-runner.mjs needs no changes):
 *   0 = posted (create succeeded; state LIVE or PROCESSING on GET-back), or
 *       already_live / already_posted (nothing created)
 *   3 = submitted but unverified (create returned a name, but GET-back failed
 *       or state was REJECTED/TAKEN_DOWN) — caller treats as "check manually";
 *       the result still carries the resource name as postUrl
 *   4 = needs_approval (workbook Status != Approved)
 *   5 = policy_violation (caption/phone/URL policy — checkPostPolicy, matches
 *       driver; or a Google-rejected duplicate)
 *   6 = api_gated (the localPosts gate (probeV4, pageSize=1) answered 404 HTML
 *       "route not served": nothing posted; the runner keeps the row
 *       `scheduled`, see EXIT_API_GATED. 200 = ok; 401/403 = exit 1 with
 *       `result: 'auth_failed'`: the runner keeps the row `scheduled` and alerts)
 *   1 = error
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import xlsx from 'xlsx';
import { fileURLToPath } from 'node:url';
import { getGbpAccessToken as realGetGbpAccessToken, gbpFetch as realGbpFetch } from './lib/gbp-api-auth.mjs';
import { isV4RouteGated, resolveGbpLocation } from './lib/gbp-location.mjs';
import { checkPostPolicy, formatViolations, checkImagePolicy, IMAGE_CONVERT_EXTS } from './gbp-poster/policy-check.mjs';
import { resolveGbpPosterConfig } from './lib/platform-defaults.mjs';
import {
  NO_REUSE_WEEKS,
  hashConflicts,
  isManifestSelectionCompatible,
  loadSelectionManifest,
  saveSelectionManifest,
  sha256Buffer,
  verifyPhotoCandidates,
  withManifestLock,
} from './lib/photo-selection.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_CONFIG = resolveGbpPosterConfig();

export const V4 = 'https://mybusiness.googleapis.com/v4';
/** Summary characters compared for the idempotent-create match (G2). */
export const SUMMARY_PREFIX_CHARS = 60;
/** Age window for the idempotent-create match (G2). */
export const DUPLICATE_WINDOW_DAYS = 7;
/** localPosts list page size (API max is 100). */
export const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 20;
/** Post states that mean "exists, do not re-create, but it is not live either". */
export const REFUSED_STATES = new Set(['REJECTED', 'TAKEN_DOWN']);
/**
 * Exit 6 = the legacy v4 API (localPosts, media) answered 404 "route not
 * served": the project is still gated for v4 (probe 2026-10-13: account
 * management v1 = 200, v4 = 404). Nothing was posted; gbp-runner maps it to
 * `scheduled` (never error/posted). Distinct from policy exit 5 on purpose.
 */
export const EXIT_API_GATED = 6;
/** 401/403 on the gate: exit 1 with `result: 'auth_failed'` so the runner keeps the row scheduled and alerts (F4). */
export const EXIT_AUTH_FAILED = 1;
export const API_GATED_MESSAGE = 'GBP v4 API (localPosts) returned 404 "route not served": the API is still gated for this project, nothing was posted. Keep GBP_POSTER=playwright until scripts/gbp-access-probe.mjs passes.';

/** True only for the v4 "route not served" 404 (HTML), not a JSON 404 for a missing resource. */
export function isV4Gated(e) {
  return isV4RouteGated(e);
}

/**
 * THE v4 gate: one GET of the location's localPosts list (pageSize=1).
 * 200 → ok; 404 HTML → gated (exit 6 api_gated); 401/403 → auth; anything else →
 * error. `locationName` may be passed to skip the account/location lookup.
 * Never calls /v4/accounts. Used by the worker startup probe, the poster's
 * pre-create check and scripts/gbp-access-probe.mjs.
 */
export async function probeV4(rawDeps = {}) {
  const deps = resolveDeps(rawDeps);
  let locationName = rawDeps.locationName || '';
  if (!locationName) {
    try {
      ({ locationName } = await resolveLocation(deps));
    } catch (e) {
      return { ok: false, gated: false, auth: false, stage: 'resolve', status: e && e.status ? e.status : null, error: String(e && e.message || e) };
    }
  }
  try {
    const res = await deps.gbpFetch(`${V4}/${locationName}/localPosts?pageSize=1`);
    const count = Array.isArray(res?.localPosts) ? res.localPosts.length : 0;
    return { ok: true, gated: false, auth: false, stage: 'localPosts', status: 200, locationName, count, totalSize: res?.totalSize ?? null };
  } catch (e) {
    const status = e && e.status ? Number(e.status) : null;
    const htmlBody = String(e?.body ?? '').trimStart().startsWith('<');
    return {
      ok: false,
      gated: isV4Gated(e),
      auth: status === 401 || status === 403,
      stage: 'localPosts',
      status,
      bodyKind: htmlBody ? 'html' : (e?.body ? 'json' : 'none'),
      locationName,
      error: String(e && e.message || e),
    };
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

export function excelDateToIso(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const p = xlsx.SSF.parse_date_code(value);
    if (p) return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
  return String(value || '').slice(0, 10);
}

export function buildPayload(post) {
  return {
    date: excelDateToIso(post.Date || post.date),
    status: String(post.Status || '').trim(),
    topic: String(post.Topic || post.Title || '').trim(),
    caption: String(post.CaptionDraft || post.Body || post.Caption || '').trim(),
    imagePath: String(post.AssetIdOrDescription || post['Related Picture'] || '').trim(),
    posted: Boolean(post.Posted),
  };
}

// CTA resolution mirrors driver.mjs: topic beats caption (captions mention other
// services in passing), first keyword match wins.
export function resolveCtaUrl(payload, config) {
  const map = config?.cta_url_map || {};
  for (const hay of [payload.topic, payload.caption]) {
    const lower = String(hay || '').toLowerCase();
    for (const [key, url] of Object.entries(map)) {
      if (lower.includes(key)) return url;
    }
  }
  return config?.default_cta_url || null;
}

// ── Photo rule (G3, memory gbp-check-photos-before-posting, audit 5.3) ──────
//
// The image for a date is resolved ONLY through the selection manifest that
// gbp-photo-pick audited: no `<date>-` prefix scan of the curated folder, no
// curated fallback, and no text-only post. Anything short of an audited,
// present, byte-identical, policy-clean, unused image is exit 5
// policy_violation with a `reason` the runner surfaces as the row error.

/** The shared cross-platform selection manifest (same default as the pickers and the FB poster). */
export function defaultManifestPath(env = process.env) {
  return env.GBP_PHOTO_SELECTION_MANIFEST || path.join(PROJECT_ROOT, 'state', 'photo-selection-manifest.json');
}

const bareDate = (value) => String(value || '').replace(/\s*\(.*$/, '').trim();
const isGbpEntry = (e) => e && (!e.platform || e.platform === 'gbp') && e.selectedBy !== 'fb-photo-pick';

/**
 * PURE: the audited selection entry for `date`. When the workbook names a path
 * it must be the audited one (isManifestSelectionCompatible); otherwise the
 * newest gbp selection for that date is used. Entries this poster appended
 * after a post (postedBy 'gbp-api') are a record, never a selection.
 */
export function resolveManifestEntry({ date, imagePath = '', manifest = [] }) {
  const selections = manifest.filter((e) => isGbpEntry(e) && e.postedBy !== 'gbp-api' && bareDate(e.postDate) === bareDate(date));
  if (!selections.length) return { entry: null, reason: `no audited selection manifest entry for ${date} (run gbp-photo-pick first)` };
  if (imagePath) {
    const compat = isManifestSelectionCompatible({ date, photoPath: imagePath, manifest: selections });
    if (compat.ok) return { entry: compat.entry, via: 'workbook-path' };
    return { entry: null, reason: `workbook image ${imagePath} is not the audited selection for ${date}: ${compat.reason}` };
  }
  const newest = [...selections].sort((a, b) => Date.parse(b.selectedAt || 0) - Date.parse(a.selectedAt || 0))[0];
  return { entry: newest, via: 'manifest-date' };
}

/** The manifest history to check a hash against: every entry except this date's own gbp rows. */
export function reuseHistory({ date, manifest = [] }) {
  return manifest.filter((e) => !(isGbpEntry(e) && bareDate(e.postDate) === bareDate(date)));
}

let heicConvertImpl;
async function loadHeicConvert() {
  if (heicConvertImpl !== undefined) return heicConvertImpl;
  try { heicConvertImpl = (await import('heic-convert')).default; } catch { heicConvertImpl = null; }
  return heicConvertImpl;
}

/**
 * Resolve, audit and prepare the photo for `payload.date`. Returns
 * `{ ok: true, entry, imagePath, bytes, contentType, uploadName, sha256, sourceSha256, converted }`
 * or `{ ok: false, reason, detail, imagePath, sha256 }` where reason is one of
 * image_missing | image_format | image_policy | hash_conflict | vision_rejected | vision_unavailable.
 */
export async function preparePhoto({ payload, manifest, now = Date.now(), env = {}, visionClient = null, heicConvert = loadHeicConvert } = {}) {
  const fail = (reason, detail, extra = {}) => ({ ok: false, reason, detail, imagePath: extra.imagePath || null, sha256: extra.sha256 || null });

  const resolved = resolveManifestEntry({ date: payload.date, imagePath: payload.imagePath, manifest });
  if (!resolved.entry) return fail('image_missing', resolved.reason);
  const entry = resolved.entry;
  const imagePath = entry.photoPath || entry.curatedPath || '';
  if (!imagePath || !fs.existsSync(imagePath)) return fail('image_missing', `audited image for ${payload.date} is not on disk: ${imagePath || '(no path in manifest)'}`, { imagePath });

  const raw = fs.readFileSync(imagePath);
  const sourceSha256 = sha256Buffer(raw);
  const audited = String(entry.photoHash || '').toLowerCase();
  if (!audited) return fail('image_missing', `manifest entry for ${payload.date} carries no photoHash (unaudited selection)`, { imagePath, sha256: sourceSha256 });
  if (audited !== sourceSha256) return fail('image_missing', `image bytes differ from the audited selection for ${payload.date} (manifest ${audited.slice(0, 12)}, disk ${sourceSha256.slice(0, 12)})`, { imagePath, sha256: sourceSha256 });

  // HEIC/HEIF → JPEG (the uploader rejects HEIC); fail closed without a converter.
  const ext = path.extname(imagePath).toLowerCase();
  let bytes = raw;
  let uploadName = imagePath;
  let converted = false;
  if (IMAGE_CONVERT_EXTS.has(ext)) {
    const convert = await heicConvert();
    if (typeof convert !== 'function') return fail('image_format', `${ext} image needs heic-convert, which is not installed; convert ${path.basename(imagePath)} to JPEG first`, { imagePath, sha256: sourceSha256 });
    try {
      bytes = Buffer.from(await convert({ buffer: raw, format: 'JPEG', quality: 0.9 }));
    } catch (e) {
      return fail('image_format', `HEIC conversion failed for ${path.basename(imagePath)}: ${e.message}`, { imagePath, sha256: sourceSha256 });
    }
    uploadName = `${imagePath.slice(0, -ext.length)}.jpg`;
    converted = true;
  }
  const sha256 = sha256Buffer(bytes);
  const contentType = contentTypeForImage(uploadName);

  const policy = checkImagePolicy(uploadName, { sizeBytes: bytes.length });
  if (policy.length) return fail('image_policy', policy.map((v) => `[${v.rule}] ${v.detail}`).join(' '), { imagePath, sha256 });

  // 8-week cross-platform no-reuse on the final bytes (and the source bytes when
  // converted). This date's own gbp rows are the selection itself; every other
  // date, platform or earlier gbp-api post with this hash is a conflict.
  const { conflicts } = hashConflicts({ hashes: [sha256, sourceSha256], history: reuseHistory({ date: payload.date, manifest }), now, weeks: NO_REUSE_WEEKS });
  if (conflicts.length) {
    const c = conflicts[0].entry || {};
    return fail('hash_conflict', `image already used within ${NO_REUSE_WEEKS} weeks (${c.platform || 'gbp'} ${bareDate(c.postDate) || 'undated'}${c.postedBy ? `, ${c.postedBy}` : ''})`, { imagePath, sha256 });
  }

  if (String(env.GBP_PHOTO_VISION_CHECK || '') === '1') {
    const verdict = await verifyPhotoCandidates({
      candidates: [{ path: imagePath, hash: sha256 }],
      hook: payload.topic || payload.caption.slice(0, 120),
      service: entry.postService || payload.topic || '',
      platform: 'gbp',
      visionClient,
      maxCandidates: 1,
      imageLoader: () => ({ path: imagePath, hash: sha256, bytes, contentType }),
    });
    if (verdict.status !== 'passed') {
      const reason = verdict.status === 'unverified' ? 'vision_unavailable' : 'vision_rejected';
      const why = (verdict.verdicts && verdict.verdicts[0] && verdict.verdicts[0].reason) || verdict.reason || verdict.status;
      return fail(reason, `GBP_PHOTO_VISION_CHECK=1: ${why}`, { imagePath, sha256 });
    }
  }

  return { ok: true, entry, imagePath, bytes, contentType, uploadName, sha256, sourceSha256, converted };
}

/**
 * One gpt-4o yes/no on the actual bytes (the picker's check, at post time).
 * Without OPENAI_API_KEY the client reports unavailable, which fails closed.
 */
export function makeOpenAiVisionClient({ env = process.env, fetchImpl = (...a) => fetch(...a) } = {}) {
  const key = env.OPENAI_API_KEY || '';
  return async ({ image, hook, service }) => {
    if (!key) return { unavailable: true, reason: 'OPENAI_API_KEY not set' };
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 40,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Does this photo plausibly illustrate an electrician's "${service}" post with the hook "${hook}"? Answer YES or NO, then one short reason.` },
            { type: 'image_url', image_url: { url: `data:${image.contentType};base64,${image.bytes.toString('base64')}` } },
          ],
        }],
      }),
    });
    if (!res.ok) return { unavailable: true, reason: `vision HTTP ${res.status}` };
    const json = await res.json();
    const text = String(json?.choices?.[0]?.message?.content || '').trim();
    if (/^yes\b/i.test(text)) return { matches: true, model: 'gpt-4o', reason: text };
    if (/^no\b/i.test(text)) return { matches: false, model: 'gpt-4o', reason: text };
    return { matches: null, reason: `unclear verdict: ${text.slice(0, 80)}` };
  };
}

/**
 * Record the post in the manifest under the shared lock so FB and next week's
 * picker see the hash. Appends one gbp row; never rewrites other platforms.
 */
export function appendPostedManifestEntry({ manifestPath, entry, photo, date, localPostName, now = Date.now() }) {
  const iso = new Date(now).toISOString();
  return withManifestLock(manifestPath, () => {
    const rows = loadSelectionManifest(manifestPath).map((e) => (
      e && e.platform ? e : { ...e, platform: e && e.selectedBy === 'fb-photo-pick' ? 'fb' : 'gbp' }
    ));
    const row = {
      platform: 'gbp',
      postedBy: 'gbp-api',
      postDate: date,
      postService: entry.postService || null,
      postServiceType: entry.postServiceType || null,
      photoPath: photo.imagePath,
      photoHash: photo.sha256,
      sourceHash: entry.sourceHash || photo.sourceSha256,
      photoServiceType: entry.photoServiceType || entry.serviceType || null,
      localPostName,
      postedAt: iso,
      selectedAt: iso,
    };
    rows.push(row);
    saveSelectionManifest(manifestPath, rows, { platform: 'gbp' });
    return row;
  });
}

/** Whitespace-normalised summary text (runs of whitespace → one space, trimmed). */
export function normalizeSummary(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** The comparable prefix of a summary: first SUMMARY_PREFIX_CHARS of the normalised text, lower-cased. */
export function summaryPrefix(text, chars = SUMMARY_PREFIX_CHARS) {
  return normalizeSummary(text).slice(0, chars).toLowerCase();
}

/**
 * PURE: find an existing localPost that matches this caption. A match is a post
 * whose normalised summary starts with the same first 60 characters and whose
 * createTime is within the last `days` days (a createTime that does not parse is
 * treated as recent: it cannot prove the post is old). Returns the first match
 * (newest first when createTime is present) or null.
 */
export function findLivePostForSummary({ posts = [], summary, now = Date.now(), days = DUPLICATE_WINDOW_DAYS, chars = SUMMARY_PREFIX_CHARS } = {}) {
  const wanted = summaryPrefix(summary, chars);
  if (!wanted) return null;
  const windowMs = Math.max(0, Number(days) || 0) * 86400000;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const matches = [];
  for (const post of posts) {
    if (!post || typeof post !== 'object') continue;
    if (summaryPrefix(post.summary, chars) !== wanted) continue;
    const created = Date.parse(post.createTime || '');
    const age = Number.isFinite(created) ? nowMs - created : 0;
    if (age > windowMs) continue;
    matches.push({ post, created: Number.isFinite(created) ? created : Infinity });
  }
  matches.sort((a, b) => b.created - a.created);
  return matches.length ? matches[0].post : null;
}

function parseArgs(argv) {
  const args = { dryRun: false, date: null, config: DEFAULT_CONFIG, selfcheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--selfcheck') args.selfcheck = true;
    else if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--config') args.config = argv[++i];
    else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
  }
  // Default to today's date in America/Chicago (the schedule's zone), not UTC:
  // a manual run after 19:00 CT used to pick tomorrow's row.
  args.date ||= chicagoDate();
  return args;
}

export function chicagoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function parseSchedule(filePath, targetDate) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
  const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  const post = data.find(row => excelDateToIso(row.Date || row.date) === targetDate);
  if (!post) throw new Error(`No post found for date: ${targetDate}`);
  return post;
}

// ── GBP API calls (every network call goes through deps so tests inject) ────

function resolveDeps(deps = {}) {
  return {
    gbpFetch: deps.gbpFetch || realGbpFetch,
    getGbpAccessToken: deps.getGbpAccessToken || realGetGbpAccessToken,
    fetchImpl: deps.fetchImpl || ((...a) => fetch(...a)),
    now: deps.now || (() => Date.now()),
    emit: deps.emit || ((result) => console.log(JSON.stringify(result))),
    log: deps.log || ((line) => console.error(line)),
    print: deps.print || ((line) => console.log(line)),
    env: deps.env || process.env,
  };
}

/**
 * Account/location for the posts: GBP_ACCOUNT_ID + GBP_LOCATION_ID (numeric or
 * full names) from env, else a v1 lookup (see lib/gbp-location.mjs). No v4 call.
 */
export async function resolveLocation({ gbpFetch, env = process.env } = {}) {
  return resolveGbpLocation({ gbpFetch, env });
}

/**
 * List every localPost of the location (v4, pageSize 100, follows nextPageToken).
 * A listing failure propagates: the caller must not create blind.
 */
export async function listLocalPosts(locationName, { gbpFetch, pageSize = LIST_PAGE_SIZE, maxPages = LIST_MAX_PAGES } = {}) {
  const posts = [];
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const url = `${V4}/${locationName}/localPosts?pageSize=${pageSize}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await gbpFetch(url);
    posts.push(...(Array.isArray(res?.localPosts) ? res.localPosts : []));
    pageToken = res?.nextPageToken || '';
    if (!pageToken) break;
  }
  return posts;
}

// Upload a local image via GBP's two-step media upload. Returns the dataRef
// resourceName to attach to the localPost. Throws on any non-2xx.
export async function uploadMedia(locationName, { buffer, contentType }, { gbpFetch, getGbpAccessToken, fetchImpl }) {
  const token = await getGbpAccessToken();

  // 1. startUpload → MediaDataRef { resourceName }
  const start = await gbpFetch(`${V4}/${locationName}/media:startUpload`, { method: 'POST', body: '{}' });
  const resourceName = start.mediaDataRef?.resourceName || start.resourceName;
  if (!resourceName) {
    throw new Error(`media:startUpload returned no resourceName: ${JSON.stringify(start)}`);
  }

  // 2. raw-bytes upload to the resumable endpoint.
  const upRes = await fetchImpl(
    `https://mybusiness.googleapis.com/upload/v1/media/${resourceName}?upload_type=media`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
      },
      body: buffer,
    },
  );
  if (!upRes.ok) {
    const txt = await upRes.text();
    throw new Error(`Media upload failed [${upRes.status}]: ${txt}`);
  }
  return resourceName;
}

export function contentTypeForImage(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

export async function createLocalPost(locationName, payload, ctaUrl, mediaRef, { gbpFetch }) {
  const body = {
    languageCode: 'en-US',
    topicType: 'STANDARD',
    summary: payload.caption,
  };
  if (ctaUrl) body.callToAction = { actionType: 'LEARN_MORE', url: ctaUrl };
  if (mediaRef) body.media = [{ mediaFormat: 'PHOTO', dataRef: { resourceName: mediaRef } }];
  return gbpFetch(`${V4}/${locationName}/localPosts`, { method: 'POST', body: JSON.stringify(body) });
}

// GET-back to confirm the post is live. The create response already carries the
// state, but a fresh GET catches immediate takedowns the create call missed.
export async function verifyPost(postName, { gbpFetch }) {
  try {
    const got = await gbpFetch(`${V4}/${postName}`);
    return got.state === 'LIVE' || got.state === 'PROCESSING';
  } catch {
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Run one post for `args.date`. Never calls process.exit: returns the exit code
 * after emitting the result JSON through deps.emit. Every network call goes
 * through deps (gbpFetch, getGbpAccessToken, fetchImpl) so tests run the whole
 * live path against mocks.
 */
export async function runPoster(args, rawDeps = {}) {
  const deps = resolveDeps(rawDeps);
  const { emit, log, print, env } = deps;
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  // Env overrides let a host point at its own workbook without editing the
  // checked-in config (which carries the PC's Windows paths). The curated folder
  // is no longer consulted here: the image comes from the manifest only (G3).
  const workbookDir = env.GBP_WORKBOOK_DIR || config.config_dir || '';
  const workbookPath = env.GBP_WORKBOOK_PATH || path.join(workbookDir, config.workbook_path || '');
  if (!workbookPath || !fs.existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath || '(missing workbook_path)'}`);
  }

  const post = parseSchedule(workbookPath, args.date);
  const payload = buildPayload(post);
  payload.ctaUrl = resolveCtaUrl(payload, config);

  if (!payload.caption) throw new Error(`Post ${args.date} has no caption/body text.`);

  // Content-policy gate — the same hard stop as the Playwright driver
  // (policy-check.mjs). Phone numbers (including the retired main number) are
  // never allowed in a GBP caption: Google auto-rejects them and disables
  // posting profile-wide. Exit 5 = policy_violation.
  const policyViolations = checkPostPolicy({ caption: payload.caption });
  if (policyViolations.length > 0) {
    const message = `Post ${payload.date} violates GBP content policy:\n${formatViolations(policyViolations)}`;
    emit({ result: 'policy_violation', date: payload.date, verified: false, postUrl: null, error: message, violations: policyViolations });
    log(message);
    return 5;
  }

  // Approval gate (exit 4) — matches driver so the runner records needs_approval.
  if (!args.dryRun && payload.status !== 'Approved') {
    emit({
      result: 'needs_approval', date: payload.date, verified: false, postUrl: null,
      error: `Post ${args.date} is not Approved (status: ${payload.status || '(blank)'}).`,
    });
    log(`Post ${args.date} not Approved — exiting without API call.`);
    return 4;
  }

  // Idempotent guard: a row already marked Posted means a prior run succeeded.
  // Re-posting would create a duplicate. Treat as success and exit 0.
  if (!args.dryRun && payload.posted) {
    emit({ result: 'already_posted', date: payload.date, verified: true, postUrl: null });
    log(`Post ${args.date} already marked Posted — skipping (no API call).`);
    return 0;
  }

  // G3: the photo comes from the audited selection manifest or the post does
  // not happen. The dry-run row is printed first so the operator gate ("view
  // each one") has the resolved path and hash even when the check refuses.
  const manifestPath = rawDeps.manifestPath || defaultManifestPath(env);
  const manifest = loadSelectionManifest(manifestPath);
  const photo = await preparePhoto({
    payload, manifest, now: deps.now(), env,
    visionClient: rawDeps.visionClient || (String(env.GBP_PHOTO_VISION_CHECK || '') === '1' ? makeOpenAiVisionClient({ env, fetchImpl: deps.fetchImpl }) : null),
    heicConvert: rawDeps.heicConvert || loadHeicConvert,
  });
  const dryRow = {
    date: payload.date,
    image_path: photo.imagePath,
    image_sha256: photo.sha256,
    image_exists: Boolean(photo.imagePath && fs.existsSync(photo.imagePath)),
    manifest_ok: photo.ok,
    ...(photo.ok ? {} : { reason: photo.reason, detail: photo.detail }),
  };
  print(JSON.stringify({ mode: args.dryRun ? 'dry-run' : 'live', topic: payload.topic, caption_chars: payload.caption.length, cta: payload.ctaUrl || null, ...dryRow }));

  if (!photo.ok) {
    const message = `Post ${payload.date} photo rule (${photo.reason}): ${photo.detail}`;
    emit({ result: 'policy_violation', status: 'policy_violation', reason: photo.reason, date: payload.date, verified: false, postUrl: null, error: message, ...dryRow });
    log(message);
    return 5;
  }

  if (args.dryRun) {
    emit({ result: 'dry_run', date: payload.date, verified: false, postUrl: null, ...dryRow });
    return 0;
  }

  const { locationName } = await resolveLocation(deps);

  // Gated v4 (404 route not served): fail closed with its own exit code so the
  // runner leaves the row `scheduled`, never error or posted.
  const gated = () => {
    emit({ result: 'api_gated', status: 'api_gated', reason: 'v4_gated', date: payload.date, verified: false, postUrl: null, error: API_GATED_MESSAGE, ...dryRow });
    log(API_GATED_MESSAGE);
    return EXIT_API_GATED;
  };

  // The gate is the localPosts list (pageSize=1) for this account+location,
  // checked before anything is listed, uploaded or created. 401/403 is an auth
  // problem (throw → exit 1, nothing posted), never a gate result.
  const gate = await probeV4({ ...deps, locationName });
  if (gate.gated) return gated();
  if (gate.auth) {
    // Structured so the runner can keep the row `scheduled` and alert (F4):
    // a dead token is an operator problem, not a reason to flip the row to error.
    const message = `GBP v4 localPosts auth failed [${gate.status}]; refresh the GBP token (scripts/authorize-gbp.mjs). Nothing was posted.`;
    emit({ result: 'auth_failed', status: 'auth_failed', reason: 'v4_auth', statusCode: gate.status, date: payload.date, verified: false, postUrl: null, error: message, ...dryRow });
    log(message);
    return EXIT_AUTH_FAILED;
  }
  if (!gate.ok) throw new Error(`GBP v4 localPosts gate failed: ${gate.error}`);

  // G2: idempotent create. List first; a listing failure propagates (exit 1)
  // rather than creating blind, which is the duplicate this guard exists for.
  let existing;
  try {
    existing = await listLocalPosts(locationName, deps);
  } catch (e) {
    if (isV4Gated(e)) return gated();
    throw e;
  }
  const live = findLivePostForSummary({ posts: existing, summary: payload.caption, now: deps.now() });
  if (live) {
    const state = String(live.state || '').toUpperCase();
    if (REFUSED_STATES.has(state)) {
      const message = `Post ${payload.date} already exists on the listing as ${state} (${live.name}); not re-creating a post Google refused.`;
      emit({ result: 'policy_violation', status: 'policy_violation', reason: 'google_rejected', date: payload.date, verified: false, postUrl: null, name: live.name, state, error: message });
      log(message);
      return 5;
    }
    emit({ result: 'already_live', status: 'already_live', date: payload.date, verified: true, postUrl: live.name, name: live.name, state: state || null, createTime: live.createTime || null });
    log(`Post ${payload.date} already live on the listing as ${live.name} (${state || 'state unknown'}) — no create.`);
    return 0;
  }

  // The photo is mandatory (G3): preparePhoto returned ok, so the upload always
  // runs and a create without media cannot be reached from here.
  let mediaRef;
  let created;
  try {
    mediaRef = await uploadMedia(locationName, { buffer: photo.bytes, contentType: photo.contentType }, deps);
    log(`Media uploaded: ${mediaRef} (${path.basename(photo.imagePath)}${photo.converted ? ', HEIC→JPEG' : ''}, sha256 ${photo.sha256.slice(0, 12)})`);
    created = await createLocalPost(locationName, payload, payload.ctaUrl, mediaRef, deps);
  } catch (e) {
    if (isV4Gated(e)) return gated();
    throw e;
  }
  const postName = created.name;
  if (!postName) {
    throw new Error(`Create returned no post name: ${JSON.stringify(created)}`);
  }

  // The post exists from here on: record the hash before the verify GET so a
  // crash between create and verify still leaves the manifest truthful.
  let manifestAppendError = null;
  try {
    appendPostedManifestEntry({ manifestPath, entry: photo.entry, photo, date: payload.date, localPostName: postName, now: deps.now() });
  } catch (e) {
    // The post exists; the hash is not recorded, so the 8-week no-reuse check is
    // weaker for this image. Said in the result (the runner stores it as the
    // row error text is not touched, but the log and JSON carry it), not only here.
    manifestAppendError = `manifest append failed (${manifestPath}): ${e.message}`;
    log(`WARNING: post ${postName} created but the ${manifestAppendError}`);
  }

  const verified = await verifyPost(postName, deps);
  // platform_post_id = the localPost resource name (stable, GET-able for later
  // verification). searchUri is a nicer human link but isn't always present.
  // The name is reported on exit 3 too: the post exists, so the runner closes
  // the workbook Posted gate (G1) and nothing creates it a second time.
  const postUrl = created.name;
  const extra = manifestAppendError ? { manifestAppendError, image_sha256: photo.sha256 } : {};
  if (verified) {
    emit({ result: 'posted', date: payload.date, verified: true, postUrl, name: postName, verificationAttempts: 1, ...extra });
    log(`Post created and LIVE: ${postName}`);
    return 0;
  }
  emit({ result: 'posted', date: payload.date, verified: false, postUrl, name: postName, verificationAttempts: 1, ...extra });
  log(`Post created (${postName}) but state not confirmed LIVE on GET-back — treat as posted-but-unverified.`);
  return 3;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = await runPoster(args);
  if (code) process.exitCode = code;
}

// ── Ponytail self-check ────────────────────────────────────────────────────

function runSelfcheck() {
  const assert = (cond, msg) => { if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); } };

  // excelDateToIso: all three input shapes → ISO.
  assert(excelDateToIso(new Date('2026-07-15T12:00:00Z')) === '2026-07-15', 'Date obj → ISO');
  assert(excelDateToIso(46448) === '2027-03-02', `serial number → ISO (got ${excelDateToIso(46448)})`);
  assert(excelDateToIso('2026-07-15') === '2026-07-15', 'string passthrough');
  assert(excelDateToIso('') === '', 'empty → empty');

  // resolveCtaUrl: topic beats caption, first-key match wins, default fallback.
  const cfg = {
    cta_url_map: { panel: '/panel', breaker: '/panel', charger: '/ev' },
    default_cta_url: '/home',
  };
  assert(resolveCtaUrl({ topic: 'Panel Upgrade', caption: '' }, cfg) === '/panel', 'topic match');
  assert(resolveCtaUrl({ topic: '', caption: 'our charger install' }, cfg) === '/ev', 'caption fallback');
  assert(resolveCtaUrl({ topic: 'panel upgrade', caption: '' }, cfg) === '/panel', 'topic beats caption: panel keyword in topic');
  assert(resolveCtaUrl({ topic: 'general update', caption: '' }, cfg) === '/home', 'default fallback');
  assert(resolveCtaUrl({ topic: '', caption: '' }, {}) === null, 'no config → null');

  // buildPayload: field aliasing.
  const p = buildPayload({
    Date: '2026-07-15', Status: 'Approved', Topic: 'EV Charger',
    CaptionDraft: 'Install today', AssetIdOrDescription: 'C:\\pic.jpg', Posted: false,
  });
  assert(p.date === '2026-07-15' && p.topic === 'EV Charger' && p.caption === 'Install today'
    && p.imagePath === 'C:\\pic.jpg' && p.status === 'Approved' && p.posted === false,
    'buildPayload field mapping');

  // Content-policy gate: phone numbers in captions are rejected — retired and new alike.
  assert(checkPostPolicy({ caption: 'Call (469) 863-9804 today' }).some(v => v.rule === 'phone-number'),
    'retired phone in caption rejected');
  assert(checkPostPolicy({ caption: 'Call (469) 716-9870 today' }).some(v => v.rule === 'phone-number'),
    'new main phone in caption rejected');
  assert(checkPostPolicy({ caption: 'Breakers tripping? We can help.' }).length === 0,
    'clean caption passes policy');

  // G2: summary-prefix duplicate match.
  const live = { name: 'accounts/1/locations/2/localPosts/3', summary: 'Breakers  tripping?\nWe can help today.', createTime: '2026-10-12T14:00:00Z', state: 'LIVE' };
  assert(findLivePostForSummary({ posts: [live], summary: 'Breakers tripping? We can help today.', now: Date.parse('2026-10-14T00:00:00Z') }) === live,
    'whitespace-normalised prefix matches');
  assert(findLivePostForSummary({ posts: [live], summary: 'Breakers tripping? We can help today.', now: Date.parse('2026-11-14T00:00:00Z') }) === null,
    'a post older than 7 days is not a duplicate');
  assert(findLivePostForSummary({ posts: [live], summary: 'Panel upgrades done right.', now: Date.parse('2026-10-14T00:00:00Z') }) === null,
    'a different caption is not a duplicate');

  console.log('ok gbp-api-poster selfcheck');
}

// ── Entry ───────────────────────────────────────────────────────────────────

// realpath so a junction/symlinked checkout (C:\Workspace → D:\Workspace) still
// matches: path.resolve alone kept argv[1] on the alias drive while __filename
// resolved to the real drive, silently disabling the CLI (and --selfcheck).
const invokedDirectly = process.argv[1] &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(path.resolve(__filename));

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck')) {
    runSelfcheck();
    process.exit(0);
  }
  main().catch(e => {
    console.log(JSON.stringify({ result: 'failed', error: String(e.message || e) }));
    console.error(`Error: ${e.message || e}`);
    process.exit(1);
  });
}
