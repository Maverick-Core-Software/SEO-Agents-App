import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import xlsx from 'xlsx';
import {
  parseGbpScheduleMarkdown,
  captionForGbpPost,
  syncGbpScheduleToWorkbook,
  markGbpDatesApproved,
  gbpPostToScheduleMarkdown,
  GBP_WORKBOOK_HEADERS,
} from './sync-gbp-schedule.mjs';

const md = `# Schedule
**DAY:** 1
**DATE:** 2026-08-21
**SERVICE:** Panel Replacement
**TOPIC:** Panel Upgrade
**TREND_TIE:** tax credit
**HEADLINE:** Is Your Panel Ready?
**BODY:** Texas homes are pushing older panels hard. Call 214-555-0100 if needed.
**CAPTION:** Clean 200-amp panel.
**PHOTO_FILE:** IMG_2402.JPG **[CONFIRM: panel]**
**CTA:** Use the Call button
**STATUS:** Needs approval
`;

const posts = parseGbpScheduleMarkdown(md);
assert.equal(posts.length, 1);
assert.equal(posts[0].date, '2026-08-21');
assert.equal(posts[0].photo_file, 'IMG_2402.JPG');
assert.ok(!captionForGbpPost(posts[0]).includes('214'));
assert.ok(captionForGbpPost(posts[0]).includes('Is Your Panel Ready?'));
assert.ok(captionForGbpPost(posts[0]).includes('Use the Call button'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-sync-'));
const cache = path.join(tmp, 'photos');
fs.mkdirSync(cache);
fs.writeFileSync(path.join(cache, 'IMG_2402.JPG'), 'x');
const wbPath = path.join(tmp, 'schedule.xlsx');
const sheet = xlsx.utils.aoa_to_sheet([GBP_WORKBOOK_HEADERS]);
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, sheet, 'Posts');
xlsx.writeFile(wb, wbPath);

const synced = syncGbpScheduleToWorkbook({
  scheduleText: md,
  workbookPath: wbPath,
  localCache: cache,
  curatedPreferred: path.join(tmp, 'missing-curated'),
  now: () => '2026-08-21T12:00:00Z',
});
assert.equal(synced.posts_found, 1);
assert.equal(synced.updates[0].new, true);
assert.ok(synced.backup_path && fs.existsSync(synced.backup_path));

const after = xlsx.utils.sheet_to_json(xlsx.readFile(wbPath).Sheets.Posts, { defval: '' });
assert.equal(after.length, 1);
assert.equal(String(after[0].Date).slice(0, 10), '2026-08-21');
assert.equal(after[0].Status, 'Needs approval');
assert.equal(after[0].AssetIdOrDescription, path.join(cache, 'IMG_2402.JPG'));
assert.ok(String(after[0].CaptionDraft).includes('Texas homes'));

const approved = markGbpDatesApproved({
  workbookPath: wbPath,
  dates: ['2026-08-21', '2026-08-99'],
  now: () => '2026-08-21T13:00:00Z',
});
assert.deepEqual(approved.approved, ['2026-08-21']);
assert.deepEqual(approved.skipped, ['2026-08-99']);
const stamped = xlsx.utils.sheet_to_json(xlsx.readFile(wbPath).Sheets.Posts, { defval: '' });
assert.equal(stamped[0].Status, 'Approved');

// --- shifted-schedule recovery: a weekly_posts row round-trips through the
// markdown builder and syncs a NEW workbook row (Approved, Posted=false) ---
const dbRow = {
  id: 'p1', run_id: 'r1', day: 4, post_date: '2026-08-31',
  service: 'Generator Interlock / Inlet',
  hook: 'Portable Generator + Interlock = Real Backup Power',
  body: 'A portable generator with a proper interlock kit is a fraction of the cost.',
  cta: 'Request service for a free generator interlock quote.',
  photo_file: 'IMG_4931.JPG',
};
const rebuilt = parseGbpScheduleMarkdown(gbpPostToScheduleMarkdown(dbRow));
assert.equal(rebuilt.length, 1);
assert.equal(rebuilt[0].date, '2026-08-31');
assert.equal(rebuilt[0].headline, 'Portable Generator + Interlock = Real Backup Power');
assert.equal(rebuilt[0].photo_file, 'IMG_4931.JPG');
assert.equal(rebuilt[0].status, 'Approved');

const recovery = syncGbpScheduleToWorkbook({
  scheduleText: gbpPostToScheduleMarkdown(dbRow),
  workbookPath: wbPath,
  localCache: cache,
  curatedPreferred: path.join(tmp, 'missing-curated'),
  now: () => '2026-08-31T09:00:00Z',
});
assert.equal(recovery.updates[0].new, true, 'shifted row must be inserted as a new workbook row');
assert.equal(recovery.updates[0].date, '2026-08-31');
const rowsAfter = xlsx.utils.sheet_to_json(xlsx.readFile(wbPath).Sheets.Posts, { defval: '' });
assert.equal(rowsAfter.length, 2);
const shifted = rowsAfter.find(r => String(r.Date).slice(0, 10) === '2026-08-31');
assert.ok(shifted, 'workbook must contain the shifted date after recovery sync');
assert.equal(shifted.Status, 'Approved');
assert.equal(shifted.Posted, false, 'Posted lock must stay false for a restored row');
assert.ok(String(shifted.CaptionDraft).includes('Portable Generator + Interlock'));
assert.equal(shifted.AssetIdOrDescription, path.join(cache, 'IMG_4931.JPG'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok sync-gbp-schedule');
