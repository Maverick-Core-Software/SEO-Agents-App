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
 * Usage:
 *   node gbp-api-poster.mjs --date <yyyy-mm-dd> [--dry-run] [--config <path>] [--selfcheck]
 *
 * Exit codes (match driver.mjs so gbp-runner.mjs needs no changes):
 *   0 = posted (create succeeded; state LIVE or PROCESSING on GET-back)
 *   3 = submitted but unverified (create returned a name, but GET-back failed
 *       or state was REJECTED/TAKEN_DOWN) — caller treats as "check manually"
 *   4 = needs_approval (workbook Status != Approved)
 *   1 = error
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import xlsx from 'xlsx';
import { fileURLToPath } from 'node:url';
import { getGbpAccessToken, gbpFetch } from './lib/gbp-api-auth.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_CONFIG = 'C:\\Workspace\\Active\\SEO-Agents-App\\config\\gbp-poster.config.json';

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

function parseSchedule(filePath, targetDate) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
  const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  const post = data.find(row => excelDateToIso(row.Date || row.date) === targetDate);
  if (!post) throw new Error(`No post found for date: ${targetDate}`);
  return post;
}

function emit(result) { console.log(JSON.stringify(result)); }

// ── GBP API calls ──────────────────────────────────────────────────────────

// Cached per-process so a retry doesn't re-list.
let _loc;
async function resolveLocation() {
  if (_loc) return _loc;
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
  _loc = { accountName, locationName: fullLocName };
  return _loc;
}

// Upload a local image via GBP's two-step media upload. Returns the dataRef
// resourceName to attach to the localPost. Throws on any non-2xx.
async function uploadMedia(locationName, imagePath) {
  const token = await getGbpAccessToken();
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const contentType =
    ext === '.png' ? 'image/png' :
    ext === '.webp' ? 'image/webp' : 'image/jpeg';

  // 1. startUpload → MediaDataRef { resourceName }
  const start = await gbpFetch(
    `https://mybusiness.googleapis.com/v4/${locationName}/media:startUpload`,
    { method: 'POST', body: '{}' },
  );
  const resourceName = start.mediaDataRef?.resourceName || start.resourceName;
  if (!resourceName) {
    throw new Error(`media:startUpload returned no resourceName: ${JSON.stringify(start)}`);
  }

  // 2. raw-bytes upload to the resumable endpoint.
  const upRes = await fetch(
    `https://mybusiness.googleapis.com/upload/v1/media/${resourceName}?upload_type=media`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': String(buf.length),
      },
      body: buf,
    },
  );
  if (!upRes.ok) {
    const txt = await upRes.text();
    throw new Error(`Media upload failed [${upRes.status}]: ${txt}`);
  }
  return resourceName;
}

async function createLocalPost(locationName, payload, ctaUrl, mediaRef) {
  const body = {
    languageCode: 'en-US',
    topicType: 'STANDARD',
    summary: payload.caption,
  };
  if (ctaUrl) body.callToAction = { actionType: 'LEARN_MORE', url: ctaUrl };
  if (mediaRef) body.media = [{ mediaFormat: 'PHOTO', dataRef: { resourceName: mediaRef } }];
  return gbpFetch(`https://mybusiness.googleapis.com/v4/${locationName}/localPosts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// GET-back to confirm the post is live. The create response already carries the
// state, but a fresh GET catches immediate takedowns the create call missed.
async function verifyPost(postName) {
  try {
    const got = await gbpFetch(`https://mybusiness.googleapis.com/v4/${postName}`);
    return got.state === 'LIVE' || got.state === 'PROCESSING';
  } catch {
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));

  const workbookPath = path.join(config.config_dir || '', config.workbook_path || '');
  if (!workbookPath || !fs.existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath || '(missing workbook_path)'}`);
  }

  const post = parseSchedule(workbookPath, args.date);
  const payload = buildPayload(post);
  payload.ctaUrl = resolveCtaUrl(payload, config);

  if (!payload.caption) throw new Error(`Post ${args.date} has no caption/body text.`);

  // Approval gate (exit 4) — matches driver so the runner records needs_approval.
  if (!args.dryRun && payload.status !== 'Approved') {
    emit({
      result: 'needs_approval', date: payload.date, verified: false, postUrl: null,
      error: `Post ${args.date} is not Approved (status: ${payload.status || '(blank)'}).`,
    });
    console.error(`Post ${args.date} not Approved — exiting without API call.`);
    process.exit(4);
  }

  // Idempotent guard: a row already marked Posted means a prior run succeeded.
  // Re-posting would create a duplicate. Treat as success and exit 0.
  if (!args.dryRun && payload.posted) {
    emit({ result: 'already_posted', date: payload.date, verified: true, postUrl: null });
    console.error(`Post ${args.date} already marked Posted — skipping (no API call).`);
    process.exit(0);
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
  console.log(JSON.stringify({ mode: args.dryRun ? 'dry-run' : 'live', payload: preview }, null, 2));

  if (args.dryRun) {
    emit({ result: 'dry_run', date: payload.date, verified: false, postUrl: null });
    return;
  }

  const { locationName } = await resolveLocation();

  let mediaRef = null;
  if (payload.imagePath && fs.existsSync(payload.imagePath)) {
    mediaRef = await uploadMedia(locationName, payload.imagePath);
    console.error(`Media uploaded: ${mediaRef}`);
  } else {
    console.error(`No image for ${args.date} — posting text-only.`);
  }

  const created = await createLocalPost(locationName, payload, payload.ctaUrl, mediaRef);
  const postName = created.name;
  if (!postName) {
    throw new Error(`Create returned no post name: ${JSON.stringify(created)}`);
  }

  const verified = await verifyPost(postName);
  // platform_post_id = the localPost resource name (stable, GET-able for later
  // verification). searchUri is a nicer human link but isn't always present.
  const postUrl = created.name;
  if (verified) {
    emit({ result: 'posted', date: payload.date, verified: true, postUrl, verificationAttempts: 1 });
    console.error(`Post created and LIVE: ${postName}`);
  } else {
    emit({ result: 'posted', date: payload.date, verified: false, postUrl: null, verificationAttempts: 1 });
    console.error(`Post created (${postName}) but state not confirmed LIVE on GET-back — treat as posted-but-unverified.`);
    process.exitCode = 3;
  }
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

  console.log('ok gbp-api-poster selfcheck');
}

// ── Entry ───────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck')) {
    runSelfcheck();
    process.exit(0);
  }
  main().catch(e => {
    emit({ result: 'failed', error: String(e.message || e) });
    console.error(`Error: ${e.message || e}`);
    process.exit(1);
  });
}
