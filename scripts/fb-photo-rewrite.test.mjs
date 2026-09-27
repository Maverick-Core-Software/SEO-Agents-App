// Focused checks for fb-photo-rewrite.mjs (P2.5): the rewrite keeps the photo
// the day already selected when that file is an audited manifest selection, and
// still replaces a crew guess / demotes a day with no audited match.
// Isolated os.tmpdir fixtures; the schedule text is passed in memory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewriteSchedule } from './fb-photo-rewrite.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-photo-rewrite-'));
const curated = path.join(tmp, 'Curated');
fs.mkdirSync(curated, { recursive: true });

const DATE = '2026-09-18';
const SERVICE = 'Panel Replacement';
// fb-photo-pick writes -1/-2/…; gbp-photo-pick writes the bare name. Both can
// exist for one date+service, and "-1" sorts before the bare name.
const first = path.join(curated, `${DATE}-panel-replacement-1.jpg`);
const second = path.join(curated, `${DATE}-panel-replacement-2.jpg`);
fs.writeFileSync(first, 'fixture');
fs.writeFileSync(second, 'fixture');

const entries = [first, second].map((photoPath) => ({
  platform: 'facebook',
  postDate: DATE,
  postService: SERVICE,
  postServiceType: 'panel',
  photoServiceType: 'panel',
  photoPath,
  sourcePath: path.join(tmp, 'panel-src.jpg'),
  selectedBy: 'fb-photo-pick',
}));

function dayBlock({ day, date, service, type, photoFile }) {
  return [
    `## DAY ${day}`,
    '',
    `**DAY:** ${day}`,
    `**DATE:** ${date}`,
    `**TYPE:** ${type}`,
    `**SERVICE:** ${service}`,
    `**PHOTO_FILE:**${photoFile ? ` ${photoFile}` : ''}`,
    '',
    '---',
    '',
  ].join('\n');
}

try {
  // ── 1. Selected identity preserved: -2 stays -2 even though -1 sorts first.
  assert.ok(path.basename(first) < path.basename(second), 'premise: the other file is the sort-first candidate');
  const kept = rewriteSchedule(dayBlock({ day: 1, date: DATE, service: SERVICE, type: 'photo', photoFile: second }), entries, { curatedFolder: curated, dryRun: false });
  assert.equal(kept.decisions[0].status, 'matched');
  assert.equal(kept.decisions[0].photo, path.basename(second), 'kept the day\'s own selection');
  assert.ok(kept.rewritten.includes(second), 'PHOTO_FILE still names the selected photo');
  assert.ok(!kept.rewritten.includes(path.basename(first)), 'did not swap to the sort-first file');

  // ── 2. A crew guess is replaced by the audited curated file.
  const replaced = rewriteSchedule(dayBlock({ day: 2, date: DATE, service: SERVICE, type: 'photo', photoFile: 'IMG_2402.JPG' }), entries, { curatedFolder: curated, dryRun: false });
  assert.equal(replaced.decisions[0].status, 'matched');
  assert.ok(replaced.rewritten.includes(first), 'guessed IMG_ filename replaced with the curated pick');
  assert.ok(!replaced.rewritten.includes('IMG_2402.JPG'), 'guess is gone');

  // ── 3. No audited match → text-only (never an unvetted photo).
  const noMatch = path.join(curated, '2026-09-19-outlet-1.jpg');
  fs.writeFileSync(noMatch, 'fixture');
  const demoted = rewriteSchedule(dayBlock({ day: 3, date: '2026-09-19', service: 'Outlet Installation', type: 'photo', photoFile: noMatch }), entries, { curatedFolder: curated, dryRun: false });
  assert.equal(demoted.decisions[0].status, 'text_only');
  assert.match(demoted.rewritten, /^\*{0,2}PHOTO_FILE:\*{0,2}[ \t]*$/m, 'PHOTO_FILE blanked');
  assert.match(demoted.rewritten, /^\*{0,2}TYPE:\*{0,2}[ \t]*text[ \t]*$/im, 'day switched to text');

  console.log('ok fb-photo-rewrite');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
