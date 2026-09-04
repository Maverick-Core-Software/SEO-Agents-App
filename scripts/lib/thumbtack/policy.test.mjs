import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOMER_FALLBACK,
  canCreateHcpEstimate,
  getThumbtackAutomationStatus,
  sanitizeCustomerMessage,
} from './policy.mjs';

test('stays in shadow mode until both auto-reply controls are set', () => {
  assert.equal(getThumbtackAutomationStatus({ autoReplyEnabled: true, nativeAutoReplyDisabled: false }).mode, 'shadow');
  assert.equal(getThumbtackAutomationStatus({ autoReplyEnabled: true, nativeAutoReplyDisabled: true }).outboundEnabled, true);
});

test('HCP estimate creation stays gated', () => {
  const automation = getThumbtackAutomationStatus({ autoReplyEnabled: true, nativeAutoReplyDisabled: true, hcpWritesEnabled: true });
  assert.equal(canCreateHcpEstimate({ explicitEstimateConsent: false, customerName: 'Sam', serviceAddress: '123 Main St', automation }), false);
  assert.equal(canCreateHcpEstimate({ explicitEstimateConsent: true, customerName: 'Sam', serviceAddress: '123 Main St', automation }), true);
});

test('sanitizer replaces internal language', () => {
  assert.deepEqual(sanitizeCustomerMessage('I created your HCP customer record.'), { safe: false, text: CUSTOMER_FALLBACK });
  assert.equal(sanitizeCustomerMessage('What kind of electrical work can we help with?').safe, true);
});
