#!/usr/bin/env node
/**
 * Self-check for driver.mjs classifyFailure (ponytail rule: one runnable check).
 * No frameworks — plain asserts. Run: node driver.selfcheck.mjs
 * Pins the precedence that matters: human-blocking reasons (session/captcha) must
 * win over the generic timeout bucket, since their messages can contain timeout-ish
 * words once Playwright wraps them.
 */
import assert from 'node:assert/strict';
import { classifyFailure } from './driver.mjs';

assert.equal(classifyFailure('GBP session expired (redirected to Google sign-in)'), 'session_expired', 'session redirect');
assert.equal(classifyFailure('Sign in button visible'), 'session_expired', 'logged out');
assert.equal(classifyFailure('GBP session expired (logged-out Business Profile marketing page shown). Re-authenticate with: node driver.mjs --auth'), 'session_expired', 'marketing page');
assert.equal(classifyFailure('CAPTCHA challenge detected on the page'), 'captcha', 'captcha');
assert.equal(classifyFailure('Google anti-bot challenge detected ("unusual traffic")'), 'captcha', 'unusual traffic');
assert.equal(classifyFailure('interstitial from Google (url: https://www.google.com/sorry/index)'), 'captcha', 'sorry page');
assert.equal(classifyFailure('Post image not found: E:\\x.jpg'), 'data', 'missing image');
assert.equal(classifyFailure('Post 2026-06-23 is not Approved. Current status: Draft'), 'data', 'not approved');
assert.equal(classifyFailure('Could not find posts button. Tried: ...'), 'ui_changed_or_timeout', 'selector miss');
assert.equal(classifyFailure('locator.waitFor: Timeout 20000ms exceeded'), 'ui_changed_or_timeout', 'timeout');
assert.equal(classifyFailure('Caption text did not register in the composer description field.'), 'ui_changed_or_timeout', 'fill failed');
assert.equal(classifyFailure('disk is on fire'), 'unknown', 'unrecognized');

console.log('gbp-driver self-check: all assertions passed ✓');
