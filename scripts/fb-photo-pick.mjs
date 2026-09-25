#!/usr/bin/env node
/**
 * fb-photo-pick.mjs
 *
 * WHY THIS EXISTS
 *   fb-photo-rewrite.mjs' own header says it: "GBP doesn't have this problem
 *   because gbp-photo-pick service-matches with GPT-4o vision; FB has no
 *   equivalent step." This is that step.
 *
 *   fb-photo-rewrite only handles TYPE: photo days, and only by looking for a
 *   same-date curated file that gbp-photo-pick happened to produce for GBP.
 *   Slideshow/carousel days (the majority) got whatever filenames the research
 *   crew guessed, which is why Facebook photos did not match their captions.
 *
 * WHAT IT DOES
 *   For every photo-bearing day in outputs/facebook_posting_schedule.md:
 *     - derive the post's service type (panel / ev-charger / generator / ...)
 *     - pick the highest-scoring photos of THAT service type from the
 *       classify-electrical.mjs manifests
 *     - copy them into GBP_CURATED_FOLDER as ${date}-${serviceSlug}-${n}.jpg
 *       (HEIC is converted to JPEG), which is exactly what facebook-poster's
 *       curatedPhotosForPost() looks for
 *     - rewrite PHOTO_FILE: to the absolute curated paths
 *     - record the choice in state/photo-selection-manifest.json so the
 *       selection is auditable, same as the GBP path
 *
 *   No photo is used twice in the same week, and a photo is recognised by ALL
 *   of its paths (source, classifier copy, curated copy) so a re-run cannot
 *   re-pick one that was already used.
 *
 *   The selection manifest is shared with GBP, so the re-run purge touches only
 *   entries this picker owns (platform: facebook) — a date purge must never drop
 *   a GBP selection for the same date.
 *
 * USAGE
 *   node scripts/fb-photo-pick.mjs              Pick and write.
 *   node scripts/fb-photo-pick.mjs --dry-run    Show choices, change nothing.
 *   node scripts/fb-photo-pick.mjs --min 50     Score floor (default 60).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultGbpPhotoDirs } from './lib/gbp-paths.mjs';
import { derivePostServiceType, serviceSlug, loadSelectionManifest, saveSelectionManifest, selectionIdentityKeys } from './lib/photo-selection.mjs';

let heicConvert = null;
try { heicConvert = (await import('heic-convert')).default; } catch { /* optional */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const dryRun = process.argv.includes('--dry-run');
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : null;
}
const MIN_SCORE = parseInt(argValue('--min') || process.env.FB_PHOTO_MIN_SCORE || '60', 10);

const { curatedPreferred: CURATED_FOLDER } = defaultGbpPhotoDirs(process.env);
const SCHEDULE = process.env.FB_SCHEDULE_PATH
  || path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const SELECTION_MANIFEST = process.env.GBP_PHOTO_SELECTION_MANIFEST
  || path.join(PROJECT_ROOT, 'state', 'photo-selection-manifest.json');
// Classified-photo pools. FB_PHOTO_POOLS (comma-separated) is the isolated-test
// seam; production always reads the classifier's two manifests.
const POOLS = (process.env.FB_PHOTO_POOLS
  ? process.env.FB_PHOTO_POOLS.split(',')
  : [
    path.join(PROJECT_ROOT, 'state', 'electrical-classified.json'),
    path.join(PROJECT_ROOT, 'state', 'electrical-backfill.json'),
  ]).map((p) => p.trim()).filter(Boolean);

// How many photos each post type wants.
const WANTED = { slideshow: 4, carousel: 3, photo: 1 };

// When the library has no photo of the post's own service type, fall back to a
// type that still illustrates the copy. The EV posts are the reason this exists:
// Grizzly has zero EV-charger photos, but those posts are about whether your
// PANEL can carry a charger ("send us a photo of your panel"), so panel imagery
// is correct rather than merely tolerable. Pass --no-fallback to disable.
const FALLBACK_TYPES = {
  'ev-charger': ['panel'],
  generator: ['panel'],
  outlet: ['wiring', 'panel'],
  wiring: ['panel'],
  // Generic posts (pricing, emergency service, "electrical repair") have no
  // service type of their own; the classifier's "other" bucket is small and
  // low-scoring, so fall back to the core trade imagery rather than text-only.
  other: ['panel', 'wiring', 'lighting'],
};
const allowFallback = !process.argv.includes('--no-fallback');

// The Curated folder is the classifier's surviving output: the Takeout sources and
// the Backfill copies recorded in electrical-qwen-takeout.json are gone, but every
// approved photo was renamed YYYY-MM-DD-<service_type>[-n].ext into Curated. Read
// that classification back from the filename (2026-09-11).
const CURATED_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(panel|lighting|wiring|ev-charger|outlet|generator)(?:-\d+)?\.(?:jpe?g|png|webp)$/i;
const CURATED_SEED_SCORE = parseInt(process.env.FB_CURATED_SEED_SCORE || process.env.GBP_CURATED_SEED_SCORE || '70', 10);

// One photo can sit at several paths (classified source, the classifier's
// converted copy) and is known to the manifest by any of them. The used-set used
// to be keyed on the pool's copy path while the manifest recorded the source
// path, so a photo was handed out twice (2026-09-25). Key every pool entry by all
// of its identities via the shared contract.
function poolIdentityKeys({ srcPath, usable }) {
  return selectionIdentityKeys({
    sourcePath: srcPath,
    photoPath: usable,
    sourceFilename: srcPath ? path.basename(srcPath) : '',
    photoFilename: usable ? path.basename(usable) : '',
  });
}

function curatedPool(seen) {
  const out = [];
  let names;
  try { names = fs.readdirSync(CURATED_FOLDER); } catch { return out; }
  const stems = new Set();
  for (const name of names) {
    const m = CURATED_NAME_RE.exec(name);
    if (!m) continue;
    // The library holds the same shot in several formats (x.jpg / x.jpeg / x.png);
    // one per stem, or a carousel ends up showing one photo three times.
    const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
    if (stems.has(stem)) continue;
    stems.add(stem);
    const full = path.join(CURATED_FOLDER, name);
    const keys = poolIdentityKeys({ srcPath: full, usable: full });
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push({
      srcPath: full,
      usable: full,
      keys,
      score: CURATED_SEED_SCORE,
      serviceType: m[2].toLowerCase(),
      tags: [m[2].toLowerCase()],
      photoDate: Date.parse(m[1] + 'T12:00:00Z') || 0,
    });
  }
  // Newest first within the seeded tier so recent jobs surface before 2018 shots.
  return out.sort((a, b) => b.photoDate - a.photoDate);
}

function loadPool() {
  const out = [];
  const seen = new Set();
  for (const p of POOLS) {
    let m;
    try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    for (const [srcPath, e] of Object.entries(m)) {
      if (!e || e.status !== 'done') continue;
      // Prefer the already-converted copy the classifier made; fall back to source.
      const usable = e.copiedTo && fs.existsSync(e.copiedTo) ? e.copiedTo : srcPath;
      if (!fs.existsSync(usable)) continue;
      // Both paths, so a manifest that recorded either one still blocks the photo.
      const keys = poolIdentityKeys({ srcPath, usable });
      if (keys.some((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      out.push({
        srcPath,
        usable,
        keys,
        score: Number(e.score) || 0,
        serviceType: e.service_type || 'other',
        tags: e.tags || [],
      });
    }
  }
  const classified = out.sort((a, b) => b.score - a.score);
  return classified.concat(curatedPool(seen));
}

function parseSchedule(text) {
  const posts = [];
  // Headers are "## POST n OF m" in the current crew output (older files used
  // "## DAY n"). fb-photo-rewrite strips the bold markers from the TYPE: and
  // PHOTO_FILE: lines it flips to text-only, so the markers are optional and a
  // marker-less "TYPE: text" with no PHOTO_FILE is recognised as a photo day
  // that was only demoted for lack of a match (2026-09-11).
  const blocks = text.split(/^## (?:POST|DAY) /m).slice(1);
  for (const block of blocks) {
    const get = (field) => {
      const m = block.match(new RegExp('^\\*{0,2}' + field + ':\\*{0,2}[ \\t]*(.*)$', 'm'));
      return m ? m[1].trim() : '';
    };
    const dateRaw = get('DATE');
    const dateOnly = dateRaw.replace(/\s*\(.*$/, '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) continue;
    let type = get('TYPE').toLowerCase();
    const photoFile = get('PHOTO_FILE');
    let demoted = false;
    if (type === 'text' && !photoFile && /^TYPE:[ \t]*text[ \t]*$/m.test(block)) {
      type = 'photo';
      demoted = true;
    }
    posts.push({
      day: parseInt(get('DAY'), 10) || 0,
      dateRaw,
      date: dateOnly,
      type,
      demoted,
      service: get('SERVICE'),
      photoFile,
    });
  }
  return posts;
}

function extFor(p) {
  const e = path.extname(p).toLowerCase();
  return /^\.hei[cf]$/.test(e) ? '.jpg' : (e || '.jpg');
}

async function copyInto(src, destPath) {
  const srcExt = path.extname(src).toLowerCase();
  if (/^\.hei[cf]$/.test(srcExt)) {
    if (!heicConvert) throw new Error('heic-convert unavailable');
    const jpeg = Buffer.from(await heicConvert({ buffer: fs.readFileSync(src), format: 'JPEG', quality: 0.9 }));
    fs.writeFileSync(destPath, jpeg);
  } else {
    fs.copyFileSync(src, destPath);
  }
}

async function main() {
  if (!fs.existsSync(SCHEDULE)) { console.error(`No FB schedule at ${SCHEDULE}`); process.exit(1); }
  const pool = loadPool();
  console.log('=== FB Photo Pick' + (dryRun ? ' (dry run)' : '') + ' ===');
  console.log('Curated folder: ' + CURATED_FOLDER);
  console.log('Classified pool: ' + pool.length + ' photos (min score ' + MIN_SCORE + ')');
  if (!pool.length) {
    console.error('Pool is empty — run classify-electrical.mjs first.');
    process.exit(1);
  }

  const byType = {};
  for (const p of pool) byType[p.serviceType] = (byType[p.serviceType] || 0) + 1;
  console.log('By service type: ' + JSON.stringify(byType));
  console.log('');

  let text = fs.readFileSync(SCHEDULE, 'utf8');
  const posts = parseSchedule(text);
  const used = new Set();
  // Never hand out a photo that an earlier week already used (GBP or FB).
  for (const e of loadSelectionManifest(SELECTION_MANIFEST)) {
    for (const k of selectionIdentityKeys(e)) used.add(k);
  }
  const selections = [];
  let matched = 0, short = 0;

  for (const post of posts) {
    const want = WANTED[post.type];
    if (!want) { console.log(`  ${post.date} [${post.type}] — not a photo day, skipped`); continue; }
    const wantType = derivePostServiceType({ service: post.service, topic: post.service });
    const slug = serviceSlug(post.service);

    const pickFor = (type) => pool
      .filter((p) => p.score >= MIN_SCORE && p.serviceType === type && !p.keys.some((k) => used.has(k)))
      .slice(0, want);

    let picks = pickFor(wantType);
    let usedType = wantType;
    if (!picks.length && allowFallback) {
      for (const alt of (FALLBACK_TYPES[wantType] || [])) {
        picks = pickFor(alt);
        if (picks.length) { usedType = alt; break; }
      }
      if (picks.length) {
        console.log(`      (no ${wantType} photos in the library — falling back to ${usedType})`);
      }
    }

    if (!picks.length) {
      console.log(`  ${post.date} [${post.type}] ${post.service} → NO ${wantType} photos available, leaving as-is`);
      short++;
      continue;
    }
    if (picks.length < want) short++;

    const destPaths = [];
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i];
      for (const k of pick.keys) used.add(k);
      const destName = `${post.date}-${slug}-${i + 1}${extFor(pick.usable)}`;
      const destPath = path.join(CURATED_FOLDER, destName);
      if (!dryRun) {
        fs.mkdirSync(CURATED_FOLDER, { recursive: true });
        await copyInto(pick.usable, destPath);
      }
      destPaths.push(destPath);
      selections.push({
        // This picker owns `platform: facebook` entries only; the purge below
        // keys off it so GBP selections survive an FB re-run.
        platform: 'facebook',
        // Bare YYYY-MM-DD, same as gbp-photo-pick: fb-photo-rewrite and
        // facebook-poster compare manifest dates against the parsed day date.
        postDate: post.date,
        postService: post.service,
        postServiceType: wantType,
        photoPath: destPath,
        sourcePath: pick.srcPath,
        sourceFilename: path.basename(pick.srcPath),
        photoServiceType: pick.serviceType,
        fallbackFrom: usedType === wantType ? null : wantType,
        score: pick.score,
        tags: pick.tags,
        selectedAt: new Date().toISOString(),
        selectedBy: 'fb-photo-pick',
      });
    }

    console.log(`  ${post.date} [${post.type}] ${post.service} → ${picks.length}/${want} ${usedType} photos${usedType === wantType ? '' : ' (fallback)'}`);
    for (const pick of picks) console.log(`      ${pick.score}  ${path.basename(pick.srcPath)}`);
    matched++;

    // Rewrite PHOTO_FILE for this day, scoped to the day's block. The marker may
    // have lost its bold asterisks (or the day its TYPE) when fb-photo-rewrite
    // demoted it to text-only on an earlier pass; restore both.
    const newLine = `**PHOTO_FILE:** ${destPaths.join(', ')}`;
    const blockStart = text.indexOf(`**DATE:** ${post.dateRaw}`);
    const head = blockStart >= 0 ? text.slice(0, blockStart) : '';
    let tail = blockStart >= 0 ? text.slice(blockStart) : text;
    tail = tail.replace(/^\*{0,2}PHOTO_FILE:\*{0,2}[ \t]*.*$/m, newLine);
    if (post.demoted) tail = tail.replace(/^TYPE:[ \t]*text[ \t]*$/m, '**TYPE:** photo');
    text = head + tail;
  }

  if (dryRun) {
    console.log(`\n(dry run — nothing written) ${matched} day(s) would be updated.`);
    return;
  }

  fs.writeFileSync(SCHEDULE, text);

  // Drop prior FB entries for the same dates so re-runs do not stack up. Scoped
  // to this picker's own entries: an unscoped date purge also dropped the GBP
  // selection for that date, and GBP then posted with an unaudited photo. Older
  // FB entries stored DATE with its human parenthetical, so compare bare dates.
  const bareDate = (value) => String(value || '').replace(/\s*\(.*$/, '').trim();
  const dates = new Set(selections.map((s) => bareDate(s.postDate)));
  const ownsEntry = (e) => e && (e.platform === 'facebook' || e.selectedBy === 'fb-photo-pick');
  const manifest = loadSelectionManifest(SELECTION_MANIFEST)
    .filter((e) => !(ownsEntry(e) && dates.has(bareDate(e.postDate))))
    // Pre-platform FB entries live in the legacy flat array; tag them before the
    // keyed write or they would land in the GBP bucket.
    .map((e) => ({ ...e, platform: e.platform || (ownsEntry(e) ? 'facebook' : 'gbp') }))
    .concat(selections);
  saveSelectionManifest(SELECTION_MANIFEST, manifest, { platform: 'facebook' });

  console.log(`\n${matched} day(s) updated, ${short} short of the ideal count.`);
  console.log(`Schedule rewritten: ${SCHEDULE}`);
  console.log(`Selection manifest: ${SELECTION_MANIFEST}`);
}

await main();
