import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chipForPost, FIXTURE_TODAY, FIXTURE_POSTS } from './week.js';

const TODAY = '2026-08-30';

describe('chipForPost', () => {
  it('scheduled + today → POST TODAY', () => {
    const chip = chipForPost({ status: 'scheduled', post_date: TODAY }, TODAY);
    assert.equal(chip.label, 'POST TODAY');
    assert.equal(chip.kind, 'today');
    assert.equal(chip.color, '#f59e0b');
  });

  it('scheduled + past → OVERDUE', () => {
    const chip = chipForPost({ status: 'scheduled', post_date: '2026-08-26' }, TODAY);
    assert.equal(chip.label, 'OVERDUE');
    assert.equal(chip.kind, 'overdue');
    assert.equal(chip.color, '#ef4444');
  });

  it('scheduled_native + past is not overdue (AUTO 9AM / native)', () => {
    const chip = chipForPost({ status: 'scheduled_native', post_date: '2026-08-25' }, TODAY);
    assert.notEqual(chip.kind, 'overdue');
    assert.notEqual(chip.label, 'OVERDUE');
    assert.notEqual(chip.label, 'POST TODAY');
    assert.equal(chip.kind, 'native');
    assert.equal(chip.label, 'AUTO 9AM');
  });

  it('posted + downgraded → CHECK', () => {
    const chip = chipForPost({
      status: 'posted',
      type: 'video',
      media_status: 'downgraded',
      platform_post_id: 'fb_1',
      post_date: TODAY,
    }, TODAY);
    assert.equal(chip.label, 'CHECK');
    assert.equal(chip.kind, 'check');
    assert.equal(chip.color, '#ef4444');
  });

  it('posted healthy → POSTED / green', () => {
    const chip = chipForPost({
      status: 'posted',
      type: 'video',
      media_status: 'video',
      platform_post_id: 'fb_1',
      post_date: '2026-08-24',
    }, TODAY);
    assert.equal(chip.label, 'POSTED');
    assert.equal(chip.kind, 'posted');
    assert.equal(chip.color, '#10b981');
  });
});

describe('fixture week chips', () => {
  it('uses FIXTURE_TODAY matching a fixture date', () => {
    assert.equal(FIXTURE_TODAY, TODAY);
    assert.ok(FIXTURE_POSTS.some((p) => p.post_date === FIXTURE_TODAY));
  });
});
