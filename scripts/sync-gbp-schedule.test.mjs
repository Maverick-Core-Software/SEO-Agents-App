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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok sync-gbp-schedule');
