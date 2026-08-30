import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postHealth, healthReason } from './postHealth.js';

describe('postHealth', () => {
  it('returns neutral for non-posted statuses', () => {
    assert.deepEqual(postHealth({ status: 'scheduled' }), { state: 'neutral', reason: null });
    assert.deepEqual(postHealth({ status: 'pending_approval' }), { state: 'neutral', reason: null });
    assert.deepEqual(postHealth({ status: 'approved' }), { state: 'neutral', reason: null });
  });

  it('returns neutral for null/undefined', () => {
    assert.deepEqual(postHealth(null), { state: 'neutral', reason: null });
    assert.deepEqual(postHealth(undefined), { state: 'neutral', reason: null });
  });

  it('returns green for a fully-verified posted video', () => {
    assert.deepEqual(postHealth({
      status: 'posted', type: 'video', media_status: 'video', platform_post_id: 'fb_123',
    }), { state: 'green', reason: null });
  });

  it('returns green for a posted photo with platform_post_id', () => {
    assert.deepEqual(postHealth({
      status: 'posted', type: 'photo', media_status: 'photo', platform_post_id: 'fb_456',
    }), { state: 'green', reason: null });
  });

  it('returns red when media downgraded (video → photo)', () => {
    const h = postHealth({
      status: 'posted', type: 'video', media_status: 'downgraded', platform_post_id: 'fb_1',
    });
    assert.equal(h.state, 'red');
    assert.equal(h.reason, 'VIDEO → PHOTO');
  });

  it('returns red when media is none', () => {
    const h = postHealth({
      status: 'posted', type: 'video', media_status: 'none', platform_post_id: 'fb_1',
    });
    assert.equal(h.state, 'red');
    assert.equal(h.reason, 'NO MEDIA');
  });

  it('returns red when platform_post_id is null on a posted row', () => {
    const h = postHealth({
      status: 'posted', type: 'video', media_status: 'video', platform_post_id: null,
    });
    assert.equal(h.state, 'red');
    assert.equal(h.reason, 'NO POST ID');
  });

  it('returns red when type=video but media_status is photo (mismatch)', () => {
    const h = postHealth({
      status: 'posted', type: 'video', media_status: 'photo', platform_post_id: 'fb_1',
    });
    assert.equal(h.state, 'red');
    assert.equal(h.reason, 'TYPE MISMATCH');
  });

  it('downgraded reason takes precedence over missing post id', () => {
    const h = postHealth({
      status: 'posted', type: 'video', media_status: 'downgraded', platform_post_id: null,
    });
    assert.equal(h.state, 'red');
    assert.equal(h.reason, 'VIDEO → PHOTO');
  });
});

describe('healthReason', () => {
  it('returns the reason for red rows', () => {
    assert.equal(healthReason({
      status: 'posted', type: 'video', media_status: 'none', platform_post_id: 'fb_1',
    }), 'NO MEDIA');
  });

  it('returns null for green / neutral rows', () => {
    assert.equal(healthReason({
      status: 'posted', type: 'video', media_status: 'video', platform_post_id: 'fb_1',
    }), null);
    assert.equal(healthReason({ status: 'scheduled' }), null);
  });
});
