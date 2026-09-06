import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, chicagoToday, computeWeekSpec, fbDates, gbpDates, mondayOnOrAfter, mostRecentFriday, parseDate, weekday, weekSpecForWeekOf,
} from '../lib/week-spec.mjs';

describe('date helpers', () => {
  it('weekday is Monday-based like Python', () => {
    assert.equal(weekday('2026-09-07'), 0); // Monday
    assert.equal(weekday('2026-09-04'), 4); // Friday
    assert.equal(weekday('2026-09-06'), 6); // Sunday
  });
  it('rejects malformed and impossible dates', () => {
    assert.throws(() => parseDate('2026-9-4'), /not a YYYY-MM-DD/);
    assert.throws(() => parseDate('2026-02-30'), /invalid calendar date/);
  });
  it('addDays crosses month and year boundaries', () => {
    assert.equal(addDays('2026-12-30', 3), '2027-01-02');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});

describe('most recent Friday / Monday on or after (mirrors tests/test_week_spec.py)', () => {
  const table = [
    // anchor, run_friday, week_of
    ['2026-09-04', '2026-09-04', '2026-09-07'], // Friday stays Friday
    ['2026-09-05', '2026-09-04', '2026-09-07'], // Saturday rewinds
    ['2026-09-06', '2026-09-04', '2026-09-07'], // Sunday rewinds
    ['2026-09-07', '2026-09-04', '2026-09-07'], // Monday goes back, week_of stays that Monday
    ['2026-09-10', '2026-09-04', '2026-09-07'], // Thursday still previous Friday
    ['2026-09-11', '2026-09-11', '2026-09-14'], // next Friday replaces
    ['2026-08-29', '2026-08-28', '2026-08-31'], // the 2026-08-29 Saturday incident
  ];
  for (const [anchor, friday, monday] of table) {
    it(`${anchor} -> run_friday ${friday}, week_of ${monday}`, () => {
      assert.equal(mostRecentFriday(anchor), friday);
      assert.equal(mondayOnOrAfter(friday), monday);
    });
  }
});

describe('computeWeekSpec', () => {
  it('GBP dates run Friday through Thursday and Facebook lands Mon/Wed/Fri/Sat', () => {
    const spec = computeWeekSpec({ anchor: '2026-09-04', now: new Date('2026-09-04T13:30:00Z') });
    assert.equal(spec.gbp_start, '2026-09-04');
    assert.deepEqual(gbpDates('2026-09-04'), { 1: '2026-09-04', 2: '2026-09-05', 3: '2026-09-06', 4: '2026-09-07', 5: '2026-09-08', 6: '2026-09-09', 7: '2026-09-10' });
    assert.deepEqual(spec.gbp_dates, gbpDates('2026-09-04'));
    assert.deepEqual(spec.fb_dates, { 1: '2026-09-07', 3: '2026-09-09', 5: '2026-09-11', 6: '2026-09-12' });
    assert.deepEqual(fbDates('2026-09-14'), { 1: '2026-09-14', 3: '2026-09-16', 5: '2026-09-18', 6: '2026-09-19' });
    assert.equal(spec.computed_at, '2026-09-04T13:30:00.000Z');
  });

  it('derives the anchor from the Chicago calendar, not UTC', () => {
    // 2026-09-05T04:30Z is still Friday 2026-09-04 23:30 in Chicago (CDT, UTC-5).
    const now = new Date('2026-09-05T04:30:00Z');
    assert.equal(chicagoToday(now), '2026-09-04');
    const spec = computeWeekSpec({ now });
    assert.equal(spec.run_friday, '2026-09-04');
    assert.equal(spec.week_of, '2026-09-07');
  });

  it('winter offset (CST, UTC-6) also resolves to the Chicago date', () => {
    const now = new Date('2026-01-10T05:30:00Z'); // Fri 2026-01-09 23:30 CST
    assert.equal(chicagoToday(now), '2026-01-09');
  });

  it('weekSpecForWeekOf accepts a Monday and rejects other days', () => {
    const spec = weekSpecForWeekOf('2026-09-14', new Date('2026-09-06T06:00:00Z'));
    assert.equal(spec.run_friday, '2026-09-11');
    assert.equal(spec.week_of, '2026-09-14');
    assert.throws(() => weekSpecForWeekOf('2026-09-11'), /must be a Monday/);
  });
});
