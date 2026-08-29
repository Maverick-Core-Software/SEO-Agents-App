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
  return out.sort((a, b) => b.score - a.score);
}

function parseSchedule(text) {
  const posts = [];
  const blocks = text.split(/^## DAY /m).slice(1);
  for (const block of blocks) {
    const get = (field) => {
      const m = block.match(new RegExp('^\\*\\*' + field + ':\\*\\*[ \\t]*(.*)$', 'm'));
      return m ? m[1].trim() : '';
    };
    const dateRaw = get('DATE');
    const dateOnly = dateRaw.replace(/\s*\(.*$/, '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) continue;
    posts.push({
      day: parseInt(get('DAY'), 10) || 0,
      dateRaw,
      date: dateOnly,
      type: get('TYPE').toLowerCase(),
      service: get('SERVICE'),
      photoFile: get('PHOTO_FILE'),
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
  const selections = [];
  let matched = 0, short = 0;

  for (const post of posts) {
    const want = WANTED[post.type];
    if (!want) { console.log(`  ${post.date} [${post.type}] — not a photo day, skipped`); continue; }
    const wantType = derivePostServiceType({ service: post.service, topic: post.service });
    const slug = serviceSlug(post.service);

    const picks = pool
      .filter((p) => p.score >= MIN_SCORE && p.serviceType === wantType && !used.has(p.usable.toLowerCase()))
      .slice(0, want);

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
        score: pick.score,
        tags: pick.tags,
        selectedAt: new Date().toISOString(),
        selectedBy: 'fb-photo-pick',
      });
    }

    console.log(`  ${post.date} [${post.type}] ${post.service} → ${picks.length}/${want} ${wantType} photos`);
    for (const pick of picks) console.log(`      ${pick.score}  ${path.basename(pick.srcPath)}`);
    matched++;

    // Rewrite PHOTO_FILE for this day.
    const oldLine = `**PHOTO_FILE:** ${post.photoFile}`;
    const newLine = `**PHOTO_FILE:** ${destPaths.join(', ')}`;
    if (text.includes(oldLine)) text = text.replace(oldLine, newLine);
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
