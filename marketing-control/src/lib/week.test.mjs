import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chicagoToday, mondayOfWeek, sundayOfWeek, addDays } from './week.js';

describe('chicagoToday', () => {
  it('stays on the CT date when UTC has already rolled after 19:00 CT', () => {
    // CDT = UTC-5 in August: 2026-08-14T02:00:00Z is 2026-08-13 21:00 CT.
    const now = new Date('2026-08-14T02:00:00Z');
    assert.equal(now.toISOString().slice(0, 10), '2026-08-14');
    assert.equal(chicagoToday(now), '2026-08-13');
  });
});

describe('week bounds', () => {
  it('a Wednesday yields that week\'s Monday–Sunday', () => {
    // 2026-08-12 is a Wednesday.
    assert.equal(mondayOfWeek('2026-08-12'), '2026-08-10');
    assert.equal(sundayOfWeek('2026-08-12'), '2026-08-16');
  });

  it('Sunday belongs to the week that started the previous Monday', () => {
    assert.equal(mondayOfWeek('2026-08-16'), '2026-08-10');
    assert.equal(sundayOfWeek('2026-08-16'), '2026-08-16');
  });

  it('addDays crosses month bounds on calendar dates', () => {
    assert.equal(addDays('2026-08-12', 1), '2026-08-13');
    assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  });
});
