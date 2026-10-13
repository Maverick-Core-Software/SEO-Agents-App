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
 *   1 = error
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import xlsx from 'xlsx';
import { fileURLToPath } from 'node:url';
import { getGbpAccessToken as realGetGbpAccessToken, gbpFetch as realGbpFetch } from './lib/gbp-api-auth.mjs';
import { checkPostPolicy, formatViolations } from './gbp-poster/policy-check.mjs';
import { resolveGbpPosterConfig } from './lib/platform-defaults.mjs';

const __filename = fileURLToPath(import.meta.url);
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

// Curated-folder fallback: gbp-photo-pick.mjs only writes the curated name into
// the markdown schedule, not the workbook, so the workbook path can lag.
export function resolveImagePath(payload, config) {
  if (payload.imagePath && fs.existsSync(payload.imagePath)) return payload.imagePath;
  const curatedDir = config.curated_photo_folder || '';
  if (curatedDir && fs.existsSync(curatedDir)) {
    const prefix = `${payload.date}-`;
    const hit = fs.readdirSync(curatedDir)
      .filter(f => f.toLowerCase().startsWith(prefix.toLowerCase()))
      .sort()[0];
    if (hit) return path.join(curatedDir, hit);
  }
  return payload.imagePath || null;
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
  args.date ||= new Date().toISOString().slice(0, 10);
  return args;
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

export async function resolveLocation({ gbpFetch }) {
  const acct = await gbpFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  if (!acct.accounts?.length) throw new Error('No GBP accounts found for this token.');
  const accountName = acct.accounts[0].name; // accounts/{id}
  const locs = await gbpFetch(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`,
  );
  if (!locs.locations?.length) throw new Error(`No GBP locations under ${accountName}.`);
  // location.name from the v1 businessinformation API is typically the full
  // resource path ("accounts/{aid}/locations/{lid}"). Guard against the bare
  // "locations/{lid}" form so the localPosts URL below is always well-formed.
  const locName = locs.locations[0].name;
  const fullLocName = locName.startsWith('accounts/') ? locName : `${accountName}/${locName}`;
  return { accountName, locationName: fullLocName };
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
  // Env overrides let a host point at its own workbook and photo mounts without
  // editing the checked-in config (which carries the PC's Windows paths).
  if (env.GBP_CURATED_FOLDER) config.curated_photo_folder = env.GBP_CURATED_FOLDER;
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

  payload.imagePath = resolveImagePath(payload, config);

  const preview = {
    date: payload.date,
    status: payload.status,
    topic: payload.topic,
    caption_chars: payload.caption.length,
    image_path: payload.imagePath,
    image_exists: payload.imagePath ? fs.existsSync(payload.imagePath) : false,
    cta: payload.ctaUrl || null,
  };
  print(JSON.stringify({ mode: args.dryRun ? 'dry-run' : 'live', payload: preview }, null, 2));

  if (args.dryRun) {
    emit({ result: 'dry_run', date: payload.date, verified: false, postUrl: null });
    return 0;
  }

  const { locationName } = await resolveLocation(deps);

  // G2: idempotent create. List first; a listing failure propagates (exit 1)
  // rather than creating blind, which is the duplicate this guard exists for.
  const existing = await listLocalPosts(locationName, deps);
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

  let mediaRef = null;
  if (payload.imagePath && fs.existsSync(payload.imagePath)) {
    mediaRef = await uploadMedia(locationName, { buffer: fs.readFileSync(payload.imagePath), contentType: contentTypeForImage(payload.imagePath) }, deps);
    log(`Media uploaded: ${mediaRef}`);
  } else {
    log(`No image for ${args.date} — posting text-only.`);
  }

  const created = await createLocalPost(locationName, payload, payload.ctaUrl, mediaRef, deps);
  const postName = created.name;
  if (!postName) {
    throw new Error(`Create returned no post name: ${JSON.stringify(created)}`);
  }

  const verified = await verifyPost(postName, deps);
  // platform_post_id = the localPost resource name (stable, GET-able for later
  // verification). searchUri is a nicer human link but isn't always present.
  // The name is reported on exit 3 too: the post exists, so the runner closes
  // the workbook Posted gate (G1) and nothing creates it a second time.
  const postUrl = created.name;
  if (verified) {
    emit({ result: 'posted', date: payload.date, verified: true, postUrl, name: postName, verificationAttempts: 1 });
    log(`Post created and LIVE: ${postName}`);
    return 0;
  }
  emit({ result: 'posted', date: payload.date, verified: false, postUrl, name: postName, verificationAttempts: 1 });
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
