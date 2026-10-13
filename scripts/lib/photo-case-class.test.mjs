// scripts/lib/photo-case-class.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chicagoToday, addDays, noReuseWindowStart, dateOnly, isPostedValue,
  classifyManifestRef, classifyWorkbookRef, classifyCacheRef, classifyScanRef,
  parseAcceptList, matchAccepted, normalizeRefKey,
} from './photo-case-class.mjs';

const TODAY = '2026-10-13';

test('chicagoToday follows America/Chicago, not UTC: 04:30Z on Oct 13 is still Oct 12 in Chicago', () => {
  assert.equal(chicagoToday(new Date('2026-10-13T04:30:00Z')), '2026-10-12');
  assert.equal(chicagoToday(new Date('2026-10-13T05:30:00Z')), '2026-10-13');
});

test('the no-reuse window is 8 weeks of calendar days ending on today', () => {
  assert.equal(addDays('2026-10-13', -56), '2026-08-18');
  assert.equal(noReuseWindowStart(TODAY), '2026-08-18');
  assert.equal(noReuseWindowStart(TODAY, 1), '2026-10-06');
});

test('dateOnly reads YYYY-MM-DD from strings, prefixes and Date objects; anything else is empty', () => {
  assert.equal(dateOnly('2026-08-31 (Monday, August 31, 2026)'), '2026-08-31');
  assert.equal(dateOnly('2026-10-13'), '2026-10-13');
  assert.equal(dateOnly(new Date('2026-10-13T12:00:00Z')), '2026-10-13');
  assert.equal(dateOnly('Monday'), '');
  assert.equal(dateOnly(undefined), '');
});

test('isPostedValue: boolean true and text yes/true/1 are posted; false, blank and other text are not', () => {
  for (const v of [true, 'TRUE', 'true', 'Yes', 'y', '1']) assert.equal(isPostedValue(v), true, String(v));
  for (const v of [false, 'FALSE', '', null, undefined, 'Approved', 0]) assert.equal(isPostedValue(v), false, String(v));
});

test('manifest photoPath: forward only when unposted and dated today or later', () => {
  const posted = new Set(['2026-08-14']);
  assert.deepEqual(classifyManifestRef({ date: '2026-10-14', platform: 'gbp', postedDates: posted, today: TODAY }),
    { class: 'forward', reason: 'unposted-future' });
  assert.deepEqual(classifyManifestRef({ date: '2026-08-14', platform: 'gbp', postedDates: posted, today: TODAY }),
    { class: 'historical', reason: 'posted' });
  assert.deepEqual(classifyManifestRef({ date: '2026-08-18', platform: 'gbp', postedDates: posted, today: TODAY }),
    { class: 'historical', reason: 'past-dated' });
  assert.deepEqual(classifyManifestRef({ date: '', platform: 'gbp', postedDates: posted, today: TODAY }),
    { class: 'forward', reason: 'undated' });
});

test('manifest facebook (or unknown platform) ignores the GBP workbook: date alone decides', () => {
  const posted = new Set(['2026-10-20']);
  assert.equal(classifyManifestRef({ date: '2026-10-20', platform: 'facebook', postedDates: posted, today: TODAY }).class, 'forward');
  assert.equal(classifyManifestRef({ date: '2026-10-20', platform: null, postedDates: posted, today: TODAY }).class, 'forward');
  assert.equal(classifyManifestRef({ date: '2026-10-01', platform: 'fb', postedDates: new Set(), today: TODAY }).class, 'historical');
});

test('workbook row: forward iff not Posted and dated today or later', () => {
  assert.deepEqual(classifyWorkbookRef({ date: '2026-10-13', posted: false, today: TODAY }),
    { class: 'forward', reason: 'unposted-future' });
  assert.deepEqual(classifyWorkbookRef({ date: '2026-10-12', posted: false, today: TODAY }),
    { class: 'historical', reason: 'past-unposted' });
  assert.deepEqual(classifyWorkbookRef({ date: '2026-10-20', posted: true, today: TODAY }),
    { class: 'historical', reason: 'posted' });
  assert.deepEqual(classifyWorkbookRef({ date: '', posted: false, today: TODAY }),
    { class: 'forward', reason: 'undated' });
});

test('cache keys are always historical: the cache re-scores a missing file', () => {
  assert.deepEqual(classifyCacheRef(), { class: 'historical', reason: 'cache-rescores-on-miss' });
});

test('curated labels: forward when the label file is in the library, a warning when it is not; other scans are forward', () => {
  assert.equal(classifyScanRef({ name: 'curated-labels.json', status: 'exact' }).class, 'forward');
  assert.equal(classifyScanRef({ name: 'curated-labels.json', status: 'case' }).class, 'forward');
  assert.deepEqual(classifyScanRef({ name: 'curated-labels.json', status: 'missing' }),
    { class: 'warning', reason: 'label-unpickable' });
  assert.equal(classifyScanRef({ name: 'labels.json', status: 'missing' }).class, 'forward');
});

test('accept list: blank lines and comments are skipped; entries match a full path or a basename, case-insensitively', () => {
  const keys = parseAcceptList('# approved\n\nE:\\Media\\Grizzly\\Curated\\Old.JPG\nnext.jpg\n');
  assert.deepEqual([...keys].sort(), ['e:/media/grizzly/curated/old.jpg', 'next.jpg']);
  assert.equal(matchAccepted('E:/Media/Grizzly/Curated/old.jpg', keys), 'e:/media/grizzly/curated/old.jpg');
  assert.equal(matchAccepted('C:\\Work\\NEXT.JPG', keys), 'next.jpg');
  assert.equal(matchAccepted('C:\\Work\\other.jpg', keys), null);
  assert.equal(matchAccepted('next.jpg', null), null);
  assert.equal(normalizeRefKey(' A\\B\\C.jpg '), 'a/b/c.jpg');
});
