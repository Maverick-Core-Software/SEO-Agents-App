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
 *   No photo is used twice in the same week.
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
import { derivePostServiceType, serviceSlug } from './lib/photo-selection.mjs';

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
const SCHEDULE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const SELECTION_MANIFEST = path.join(PROJECT_ROOT, 'state', 'photo-selection-manifest.json');
const POOLS = [
  path.join(PROJECT_ROOT, 'state', 'electrical-classified.json'),
  path.join(PROJECT_ROOT, 'state', 'electrical-backfill.json'),
];

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
};
const allowFallback = !process.argv.includes('--no-fallback');

// The Curated folder is the classifier's surviving output: the Takeout sources and
// the Backfill copies recorded in electrical-qwen-takeout.json are gone, but every
// approved photo was renamed YYYY-MM-DD-<service_type>[-n].ext into Curated. Read
// that classification back from the filename (2026-09-11).
const CURATED_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(panel|lighting|wiring|ev-charger|outlet|generator)(?:-\d+)?\.(?:jpe?g|png|webp)$/i;
const CURATED_SEED_SCORE = parseInt(process.env.FB_CURATED_SEED_SCORE || process.env.GBP_CURATED_SEED_SCORE || '70', 10);

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
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      srcPath: full,
      usable: full,
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
      const key = usable.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        srcPath,
        usable,
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
  try {
    for (const e of JSON.parse(fs.readFileSync(SELECTION_MANIFEST, 'utf8'))) {
      for (const k of [e.sourcePath, e.photoPath]) if (k) used.add(String(k).toLowerCase());
    }
  } catch { /* no manifest yet */ }
  const selections = [];
  let matched = 0, short = 0;

  for (const post of posts) {
    const want = WANTED[post.type];
    if (!want) { console.log(`  ${post.date} [${post.type}] — not a photo day, skipped`); continue; }
    const wantType = derivePostServiceType({ service: post.service, topic: post.service });
    const slug = serviceSlug(post.service);

    const pickFor = (type) => pool
      .filter((p) => p.score >= MIN_SCORE && p.serviceType === type && !used.has(p.usable.toLowerCase()))
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
      used.add(pick.usable.toLowerCase());
      const destName = `${post.date}-${slug}-${i + 1}${extFor(pick.usable)}`;
      const destPath = path.join(CURATED_FOLDER, destName);
      if (!dryRun) {
        fs.mkdirSync(CURATED_FOLDER, { recursive: true });
        await copyInto(pick.usable, destPath);
      }
      destPaths.push(destPath);
      selections.push({
        postDate: post.dateRaw,
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

  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(SELECTION_MANIFEST, 'utf8')); } catch { manifest = []; }
  // Drop prior entries for the same dates so re-runs do not stack up.
  const dates = new Set(selections.map((s) => s.postDate));
  manifest = manifest.filter((e) => !dates.has(e.postDate));
  manifest.push(...selections);
  fs.mkdirSync(path.dirname(SELECTION_MANIFEST), { recursive: true });
  fs.writeFileSync(SELECTION_MANIFEST, JSON.stringify(manifest, null, 2));

  console.log(`\n${matched} day(s) updated, ${short} short of the ideal count.`);
  console.log(`Schedule rewritten: ${SCHEDULE}`);
  console.log(`Selection manifest: ${SELECTION_MANIFEST}`);
}

await main();
