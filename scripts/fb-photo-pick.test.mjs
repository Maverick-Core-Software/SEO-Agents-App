// Focused checks for fb-photo-pick.mjs (P2.5):
//   1. used-path keys  — a photo already used under ANY of its paths is not picked again
//   2. manifest purge  — re-picking a date drops this picker's FB entries only,
//                        never the GBP selections sharing the same manifest
// Runs the real script in a subprocess against isolated os.tmpdir fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSelectionManifest } from './lib/photo-selection.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fb-photo-pick.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-photo-pick-'));
const curated = path.join(tmp, 'curated');
const photos = path.join(tmp, 'photos');
fs.mkdirSync(curated, { recursive: true });
fs.mkdirSync(photos, { recursive: true });

const DATE = '2026-09-18';
const SERVICE = 'Panel Replacement';

// Two panel photos; A scores higher, so pre-fix code (which missed A's alias)
// would hand A out again.
const photoA = path.join(photos, 'photoA-src.jpg');
const photoACopy = path.join(photos, 'photoA-copy.jpg');
const photoB = path.join(photos, 'photoB-src.jpg');
const photoBCopy = path.join(photos, 'photoB-copy.jpg');
for (const f of [photoA, photoACopy, photoB, photoBCopy]) fs.writeFileSync(f, 'fixture');

const poolPath = path.join(tmp, 'pool.json');
fs.writeFileSync(poolPath, JSON.stringify({
  [photoA]: { status: 'done', score: 90, service_type: 'panel', tags: ['panel'], copiedTo: photoACopy },
  [photoB]: { status: 'done', score: 80, service_type: 'panel', tags: ['panel'], copiedTo: photoBCopy },
}, null, 2));

const gbpEntry = (photoPath) => ({
  platform: 'gbp', postDate: DATE, postService: SERVICE,
  postServiceType: 'panel', photoServiceType: 'panel', photoPath,
});
const fbEntry = (extra) => ({
  selectedBy: 'fb-photo-pick', postService: SERVICE,
  postServiceType: 'panel', photoServiceType: 'panel', ...extra,
});

const manifestPath = path.join(tmp, 'manifest.json');
const gbpKept = path.join(curated, `${DATE}-panel-replacement.JPG`);
const legacyKept = path.join(curated, `${DATE}-panel-legacy.jpg`);
const staleFb = path.join(curated, `${DATE}-panel-replacement-1.jpg`);
fs.writeFileSync(manifestPath, JSON.stringify([
  gbpEntry(gbpKept),
  // Pre-platform GBP entry (no platform, no selectedBy) — also foreign to us.
  { postDate: DATE, postService: SERVICE, postServiceType: 'panel', photoServiceType: 'panel', photoPath: legacyKept },
  // A previous FB run for this date: replaced, not stacked.
  fbEntry({ postDate: DATE, photoPath: staleFb, sourcePath: path.join(photos, 'stale-fb.jpg') }),
  // Older FB entries stored DATE with its human parenthetical — same day.
  fbEntry({ postDate: `${DATE} (Friday, September 18, 2026)`, photoPath: path.join(curated, 'old-parenthetical.jpg') }),
  // A previous FB run that used photoA under its SOURCE path while the pool
  // exposes the classifier's COPY path.
  fbEntry({ postDate: '2026-09-11', photoPath: path.join(curated, '2026-09-11-panel-replacement-1.jpg'), sourcePath: photoA }),
], null, 2));

const schedulePath = path.join(tmp, 'facebook_posting_schedule.md');
fs.writeFileSync(schedulePath, [
  `## Week of September 21, 2026`,
  '',
  '## DAY 1',
  '',
  `**DAY:** 1`,
  `**DATE:** ${DATE} (Friday, September 18, 2026)`,
  '**TYPE:** photo',
  `**SERVICE:** ${SERVICE}`,
  '**PHOTO_FILE:**',
  '',
].join('\n'));

try {
  const stdout = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FB_SCHEDULE_PATH: schedulePath,
      GBP_PHOTO_SELECTION_MANIFEST: manifestPath,
      GBP_CURATED_FOLDER: curated,
      FB_PHOTO_POOLS: poolPath,
      FB_PHOTO_MIN_SCORE: '60',
    },
  });

  // ── 1. used-path keys: photoA is used, so the lower-scoring photoB is picked.
  assert.match(stdout, /photoB-src\.jpg/, `expected photoB to be picked:\n${stdout}`);
  assert.doesNotMatch(stdout, /photoA-src\.jpg/, `photoA was already used:\n${stdout}`);

  const schedule = fs.readFileSync(schedulePath, 'utf8');
  const expected = path.join(curated, `${DATE}-panel-replacement-1.jpg`);
  assert.ok(schedule.includes(`**PHOTO_FILE:** ${expected}`), `schedule PHOTO_FILE:\n${schedule}`);

  // ── 2. platform-scoped purge, platform-keyed write.
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(!Array.isArray(raw) && raw.platforms?.facebook && raw.platforms?.gbp, 'manifest written platform-keyed');

  const manifest = loadSelectionManifest(manifestPath);
  const bare = (v) => String(v || '').replace(/\s*\(.*$/, '').trim();
  const today = manifest.filter((e) => bare(e.postDate) === DATE);
  assert.ok(today.some((e) => e.photoPath === gbpKept), 'GBP selection survived the FB re-run');
  assert.ok(today.some((e) => e.photoPath === legacyKept), 'legacy (unplatformed) selection survived');
  const fbToday = today.filter((e) => e.selectedBy === 'fb-photo-pick');
  assert.equal(today.length, 3, `no entries lost or duplicated: ${JSON.stringify(today.map((e) => e.photoPath))}`);
  assert.equal(fbToday.length, 1, 'stale FB entries replaced, not stacked (incl. a parenthetical date)');

  const picked = fbToday[0];
  assert.equal(picked.platform, 'facebook', 'new entries are platform-keyed');
  assert.equal(picked.photoPath, expected);
  assert.equal(picked.sourcePath, photoB, 'picked photo recorded with its source identity');

  console.log('ok fb-photo-pick');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
