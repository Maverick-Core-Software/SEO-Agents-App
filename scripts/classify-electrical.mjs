#!/usr/bin/env node
/**
 * classify-electrical.mjs — electrical-only photo filter (LOCAL vision model).
 *
 * Modes:
 *   default (weekly): scan SOURCE for NEW photos since last run, normal threshold,
 *                     copy approved electrical to the GBP cache.
 *   --backfill      : scan EVERYTHING (ignore manifest), LOWER threshold, copy to a
 *                     staging folder (no delete). One-time catch-up for the whole album.
 *   --delete        : after processing, DELETE the source file (approved are moved to
 *                     dest first, non-approved are just deleted). Drains the source.
 *   --source <dir>  : override source folder.
 *   --dest <dir>    : override destination folder.
 *   --rescan        : reprocess everything in source (ignore "done" manifest).
 *   --dry-run       : no copy, no delete.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defaultGbpPhotoDirs } from './lib/gbp-paths.mjs';
import { serviceSlug } from './lib/photo-selection.mjs';

const require = createRequire(import.meta.url);
let heicConvert = null;
try { const mod = require('heic-convert'); heicConvert = mod.default || mod; }
catch { heicConvert = null; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ── flags ────────────────────────────────────────────────────────────────
const backfill = process.argv.includes('--backfill');
const doDelete = process.argv.includes('--delete');
const dryRun = process.argv.includes('--dry-run');
const rescan = process.argv.includes('--rescan');
const curate = process.argv.includes('--curate');
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : null;
}
const sourceOverride = argValue('--source');
const destOverride = argValue('--dest');
const sinceArg = argValue('--since');
const sinceMs = sinceArg ? new Date(sinceArg + 'T00:00:00Z').getTime() : 0;
const CONCURRENCY = parseInt(argValue('--concurrency', '1'), 10);
const MAX_DIM = parseInt(process.env.ELECTRICAL_MAX_DIM || '768', 10);
const urlOverride = argValue('--url');
const modelOverride = argValue('--model');

// ── config ────────────────────────────────────────────────────────────────
const VISION_URL = (urlOverride || process.env.ELECTRICAL_VISION_URL || 'http://127.0.0.1:8082/v1').replace(/\/$/, '');
const VISION_MODEL = modelOverride || process.env.ELECTRICAL_VISION_MODEL || 'gemma-3-12b-it';
// Set ELECTRICAL_VISION_API_KEY to talk to a hosted OpenAI-compatible endpoint
// (e.g. ELECTRICAL_VISION_URL=https://api.openai.com/v1, MODEL=gpt-4o). Unset for
// a local server, which needs no auth.
const VISION_API_KEY = process.env.ELECTRICAL_VISION_API_KEY
  || (/api\.openai\.com/.test(VISION_URL) ? process.env.OPENAI_API_KEY : '')
  || '';
const ICLOUD_DIR = process.env.ICLOUD_PHOTOS_DIR || 'C:\\Users\\carte\\Pictures\\iCloud Photos';
const BACKFILL_DIR = process.env.ELECTRICAL_BACKFILL_DIR || 'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\Backfill';
const { localCache: GBP_CACHE } = defaultGbpPhotoDirs(process.env);
const weeklyThreshold = parseInt(process.env.ELECTRICAL_MIN_SCORE || '60', 10);
const backfillThreshold = parseInt(process.env.ELECTRICAL_BACKFILL_MIN_SCORE || '40', 10);
const MIN_SCORE = backfill ? backfillThreshold : weeklyThreshold;
const SOURCE = sourceOverride || ICLOUD_DIR;
const DEST = destOverride || (backfill ? BACKFILL_DIR : GBP_CACHE);
const MANIFEST = process.env.ELECTRICAL_MANIFEST || path.join(PROJECT_ROOT, 'state', backfill ? 'electrical-backfill.json' : 'electrical-classified.json');
const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const SKIP_EXTS = new Set(['.mov', '.mp4', '.avi', '.gif']);

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}
function saveManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

// Many files in the library carry a .heic extension but hold JPEG bytes (67 of the
// first 176 scanned on 2026-08-29). Trust the magic bytes, not the extension --
// heic-convert throws 'input buffer is not a HEIC image' on those otherwise.
function isKnownRaster(buf) {
  return (buf[0] === 0x89 && buf[1] === 0x50)
    || (buf[0] === 0xFF && buf[1] === 0xD8)
    || (buf[0] === 0x52 && buf[1] === 0x49);
}
function isHeicBuffer(buf) {
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  return /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis|hevm|hevs)$/
    .test(buf.toString('ascii', 8, 12));
}
function needsHeicDecode(buf, ext) {
  return isHeicBuffer(buf) || (/^\.hei[cf]$/i.test(ext) && !isKnownRaster(buf));
}

function detectMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

function discoverPhotos(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { recursive: true, withFileTypes: false })
    .map((f) => path.join(folder, f.toString()))
    .filter((f) => {
      try {
        if (!fs.statSync(f).isFile()) return false;
        const ext = path.extname(f).toLowerCase();
        if (SKIP_EXTS.has(ext)) return false;
        return SUPPORTED_EXTS.has(ext);
      } catch { return false; }
    });
}

// Takeout writes "<filename>.json" (or "<basename>.json") alongside each item with
// photoTakenTime.timestamp (unix seconds). Fall back to null when absent.
function photoTakenMs(filePath) {
  const candidates = [
    filePath + '.json',
    filePath + '.supplemental-metadata.json',
    path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '.json'),
    path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '.supplemental-metadata.json'),
  ];
  for (const c of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      const t = j.photoTakenTime && j.photoTakenTime.timestamp || j.creationTime && j.creationTime.timestamp;
      if (t) {
        const n = parseInt(t, 10);
        return n > 1e12 ? n : n * 1000;
      }
    } catch { /* no metadata file */ }
  }
  return null;
}

const PROMPT = [
  'Score this photo 0-100 for use as a Google Business Profile post for an electrical contractor.',
  '',
  'HARD RULES (apply first):',
  '- If the photo shows any person or face, or is NOT electrical work (family, selfie, food, landscape, screenshot, receipt, document), score it 0-20 and set service_type to "other".',
  '- Only score 40+ when electrical work is clearly the main subject: panels, wiring, conduit, breakers, EV chargers, fixtures, completed installs.',
  '- A person in the frame, even with wiring visible behind them, is NOT an electrical-work photo — reject it.',
  '',
  'High (70-100): professional electrical work — panels, wiring, conduit, EV chargers, fixtures, completed installs. Clean, well-lit, no faces.',
  'Medium (40-69): electrical work but partially obscured, cluttered, or poorly lit.',
  'Low (0-39): not electrical work, has faces/PII, screenshot, receipt, personal photo, unrelated.',
  '',
  'Set service_type to ONE of: panel, ev-charger, lighting, wiring, outlet, generator, other',
  '',
  'Tags — pick all that apply:',
  '  panel-upgrade, panel-replacement, main-panel, subpanel, breaker-box, breaker-replacement,',
  '  ev-charger, ev-charging-station, level-2-charger, ev-outlet,',
  '  lighting-fixture, recessed-lighting, outdoor-lighting, ceiling-fan, light-switch, dimmer,',
  '  wiring, wire-run, conduit, romex, junction-box,',
  '  outlet-installation, gfci-outlet, usb-outlet, dedicated-circuit,',
  '  generator, generator-installation, generator-inlet, transfer-switch, standby-generator,',
  '  electrical-safety, smoke-detector, whole-home, service-upgrade',
  '',
  'Reply ONLY with JSON: {"score":<0-100>,"service_type":"<type>","tags":["tag1"],"reject_reason":"<blank if score>=60>"}'
].join('\n');

async function resizeJpeg(buf) {
  // Downscale to speed the vision tower (no recall loss at 768px).
  // Gracefully returns the original buffer if sharp is unavailable.
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buf)
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch { return buf; }
}

async function classifyPhoto(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  let buf = fs.readFileSync(imagePath);
  let mime = detectMime(buf);

  if (needsHeicDecode(buf, ext)) {
    if (!heicConvert) throw new Error('heic-convert not installed');
    buf = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.85 }));
    mime = 'image/jpeg';
  }

  const resized = await resizeJpeg(buf);
  if (resized !== buf) { buf = resized; mime = 'image/jpeg'; }

  const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');

  const res = await fetch(VISION_URL + '/chat/completions', {
    method: 'POST',
    headers: VISION_API_KEY
      ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + VISION_API_KEY }
      : { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 200,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('vision endpoint ' + res.status + ': ' + body.slice(0, 200));
  }
  const data = await res.json();
  let text = data.choices?.[0]?.message?.content?.trim() || '{}';
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) text = text.slice(s, e + 1);
  try {
    return JSON.parse(text);
  } catch {
    return { score: 0, service_type: 'other', tags: [], reject_reason: 'parse error' };
  }
}

function uniqueDest(relPath, destDir) {
  const ext = path.extname(relPath).toLowerCase();
  const isHeic = /^\.hei[cf]$/i.test(ext);
  const base = path.basename(relPath, path.extname(relPath));
  const target = isHeic ? base + '.jpg' : base + ext;
  let candidate = path.join(destDir, target);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, base + '-' + n + (isHeic ? '.jpg' : ext));
    n++;
  }
  return candidate;
}

async function curateStaging() {
  // Curation pass: filter the backfill results into Curated (score >= threshold) or
  // Unused Review (borderline / false positives), renamed YYYY-MM-DD-service.ext using
  // the real capture date. Reads straight from the original Takeout paths (src).
  const bfFile = process.env.ELECTRICAL_MANIFEST || path.join(PROJECT_ROOT, 'state', 'electrical-backfill.json');
  let bf;
  try { bf = JSON.parse(fs.readFileSync(bfFile, 'utf8')); } catch { bf = {}; }
  const threshold = parseInt(process.env.ELECTRICAL_MIN_SCORE || '60', 10);
  const { localCache } = defaultGbpPhotoDirs(process.env);
  const CURATED = path.join(localCache, 'Curated');
  const UNUSED = path.join(localCache, 'Unused Review');
  let kept = 0, unused = 0, skipped = 0;
  console.log('=== Curation (-> Curated / Unused Review, threshold ' + threshold + ') ===');
  for (const [src, entry] of Object.entries(bf)) {
    if (!entry || entry.status !== 'done' || !entry.approved) { skipped++; continue; }
    if (!fs.existsSync(src)) { skipped++; continue; }
    const good = (entry.score >= threshold) && (entry.service_type && entry.service_type !== 'other');
    const takenMs = photoTakenMs(src) ?? entry.mtime ?? fs.statSync(src).mtimeMs;
    const dateStr = new Date(takenMs).toISOString().slice(0, 10);
    const slug = serviceSlug(entry.service_type || 'other');
    const srcExt = path.extname(src).toLowerCase();
    const targetDir = good ? CURATED : UNUSED;
    if (!dryRun) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
        const srcBuf = fs.readFileSync(src);
        if (needsHeicDecode(srcBuf, srcExt)) {
          if (!heicConvert) throw new Error('heic-convert unavailable');
          const jpeg = Buffer.from(await heicConvert({ buffer: srcBuf, format: 'JPEG', quality: 0.9 }));
          const dest = uniqueDest(dateStr + '-' + slug + '.jpg', targetDir);
          fs.writeFileSync(dest, jpeg);
        } else {
          const dest = uniqueDest(dateStr + '-' + slug + srcExt, targetDir);
          fs.copyFileSync(src, dest);
        }
        if (good) kept++; else unused++;
      } catch (e) { console.log('  ' + path.basename(src) + ' ERROR: ' + e.message); }
    }
  }
  console.log('Curation done. Curated: ' + kept + ' | Unused Review: ' + unused + ' | skipped: ' + skipped);
}

async function main() {
  const mode = backfill ? 'BACKFILL (low threshold, whole library)' : 'WEEKLY (new only)';
  console.log('=== Electrical photo filter ===');
  console.log('Mode:        ' + mode);
  console.log('Source:      ' + SOURCE);
  console.log('Destination: ' + DEST);
  console.log('Vision:      ' + VISION_MODEL + ' @ ' + VISION_URL + (VISION_API_KEY ? ' (authenticated)' : ''));
  console.log('Min score:   ' + MIN_SCORE);
  console.log('Delete src:  ' + (doDelete ? 'YES' : 'no'));
  if (dryRun) console.log('(dry run — no copy, no delete)\n');

  const files = discoverPhotos(SOURCE);
  console.log('Found ' + files.length + ' photos in source folder');

  if (!files.length) { console.log('Nothing to do.'); return; }

  const m = (rescan && !backfill) ? {} : loadManifest();
  const toProcess = [];
  let skippedOld = 0;
  for (const f of files) {
    const mtime = fs.statSync(f).mtimeMs;
    if (sinceMs) {
      const taken = photoTakenMs(f) ?? mtime;
      if (taken < sinceMs) { skippedOld++; continue; }
    }
    const prev = m[f];
    if (prev && prev.mtime === mtime && prev.status === 'done') continue;
    toProcess.push({ f, mtime });
  }

  if (sinceMs) console.log('Skipped (older than --since): ' + skippedOld);
  console.log('To classify: ' + toProcess.length);

  let kept = 0, deleted = 0, errors = 0;
  const concurrency = Math.max(1, CONCURRENCY);
  let cursor = 0;

  async function processOne(f, mtime) {
    const name = path.basename(f);
    try {
      const r = await classifyPhoto(f);
      const approved = (r.score >= MIN_SCORE) && (r.service_type && r.service_type !== 'other');
      console.log('  ' + name + ': ' + (approved
        ? 'OK ' + r.score + ' [' + r.service_type + ']'
        : 'skip ' + r.score + ' (' + (r.reject_reason || 'not electrical') + ')'));

      m[f] = {
        mtime,
        score: r.score,
        service_type: r.service_type || 'other',
        tags: r.tags || [],
        reject_reason: r.reject_reason || '',
        approved,
        classifiedAt: new Date().toISOString(),
        status: 'done',
      };

      if (approved && !dryRun) {
        fs.mkdirSync(DEST, { recursive: true });
        const dest = uniqueDest(f, DEST);
        const srcExt = path.extname(f).toLowerCase();
        const srcBuf = fs.readFileSync(f);
        if (needsHeicDecode(srcBuf, srcExt)) {
          if (!heicConvert) throw new Error('heic-convert unavailable for copy');
          const jpeg = Buffer.from(await heicConvert({ buffer: srcBuf, format: 'JPEG', quality: 0.9 }));
          fs.writeFileSync(dest, jpeg);
        } else {
          fs.copyFileSync(f, dest);
        }
        m[f].copiedTo = dest;
        kept++;
        console.log('    -> ' + path.basename(dest));
      }

      if (doDelete && !dryRun) {
        fs.unlinkSync(f);
        m[f].deleted = true;
        deleted++;
      }
    } catch (e) {
      console.log('  ' + name + ' ERROR: ' + e.message);
      m[f] = { mtime, status: 'error', error: e.message };
      errors++;
    }
  }

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= toProcess.length) break;
      const item = toProcess[idx];
      await processOne(item.f, item.mtime);
      if ((idx + 1) % 25 === 0) saveManifest(m);
    }
  }

  console.log('Concurrency: ' + concurrency);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  saveManifest(m);

  console.log('\nDone. Approved: ' + kept + ' | deleted from source: ' + deleted + ' | errors: ' + errors);
  if (!dryRun) {
    console.log('Manifest: ' + MANIFEST);
    if (!backfill) console.log('Next (Friday run picks these up): node scripts/gbp-photo-pick.mjs');
  }
}

if (curate) {
  curateStaging().catch((e) => { console.error(e.message || e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
