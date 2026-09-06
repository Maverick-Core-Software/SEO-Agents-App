#!/usr/bin/env node
/**
 * Self-check for driver.mjs classifyFailure (ponytail rule: one runnable check).
 * No frameworks — plain asserts. Run: node driver.selfcheck.mjs
 * Pins the precedence that matters: human-blocking reasons (session/captcha) must
 * win over the generic timeout bucket, since their messages can contain timeout-ish
 * words once Playwright wraps them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, UPLOAD_PREVIEW_SELECTOR, resolveWorkbookPath, requireExistingImage } from './driver.mjs';

assert.equal(classifyFailure('GBP session expired (redirected to Google sign-in)'), 'session_expired', 'session redirect');
assert.equal(classifyFailure('Sign in button visible'), 'session_expired', 'logged out');
assert.equal(classifyFailure('GBP session expired (logged-out Business Profile marketing page shown). Re-authenticate with: node driver.mjs --auth'), 'session_expired', 'marketing page');
assert.equal(classifyFailure('CAPTCHA challenge detected on the page'), 'captcha', 'captcha');
assert.equal(classifyFailure('Google anti-bot challenge detected ("unusual traffic")'), 'captcha', 'unusual traffic');
assert.equal(classifyFailure('interstitial from Google (url: https://www.google.com/sorry/index)'), 'captcha', 'sorry page');
assert.equal(classifyFailure('Post image not found: E:\\x.jpg'), 'data', 'missing image');
assert.equal(classifyFailure('Post image is required for 2026-09-05; refusing to publish a text-only GBP post.'), 'data', 'image required');
assert.equal(classifyFailure('Image upload preview did not appear before timeout; refusing to post without photo.'), 'ui_changed_or_timeout', 'upload preview timeout');
assert.ok(UPLOAD_PREVIEW_SELECTOR.includes('blob:'), 'upload preview selector includes local upload state');
assert.ok(UPLOAD_PREVIEW_SELECTOR.includes('googleusercontent.com'), 'upload preview selector includes persisted Google media');
assert.equal(classifyFailure('Post 2026-06-23 is not Approved. Current status: Draft'), 'data', 'not approved');
assert.equal(classifyFailure('Could not find posts button. Tried: ...'), 'ui_changed_or_timeout', 'selector miss');
assert.equal(classifyFailure('locator.waitFor: Timeout 20000ms exceeded'), 'ui_changed_or_timeout', 'timeout');
assert.equal(classifyFailure('Caption text did not register in the composer description field.'), 'ui_changed_or_timeout', 'fill failed');
assert.equal(classifyFailure('disk is on fire'), 'unknown', 'unrecognized');

{
  const exists = new Set(['C:\\Workspace\\Shared\\Operations\\Grizzly\\GBP\\Grizzly GBP Schedule.xlsx']);
  const found = resolveWorkbookPath({
    config_dir: 'C:\\Workspace\\Shared\\Operations\\Grizzly\\GBP',
    workbook_path: 'Grizzly GBP Schedule.xlsx',
  }, { existsSync: (p) => exists.has(p) });
  assert.equal(found, 'C:\\Workspace\\Shared\\Operations\\Grizzly\\GBP\\Grizzly GBP Schedule.xlsx');

  const fallback = resolveWorkbookPath({
    config_dir: 'C:\\missing',
    workbook_path: 'nope.xlsx',
  }, { existsSync: (p) => p.endsWith('gbp_posting_schedule.xlsx') });
  assert.ok(fallback.endsWith('gbp_posting_schedule.xlsx'), 'missing workbook falls back to outputs copy');

  assert.throws(
    () => resolveWorkbookPath({ config_dir: '', workbook_path: '' }, { existsSync: () => false }),
    /Workbook not found/,
  );
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-img-'));
  const photo = path.join(tmp, 'panel.jpg');
  fs.writeFileSync(photo, 'x');
  assert.equal(requireExistingImage(photo, '2026-09-09'), photo);
  assert.throws(() => requireExistingImage('', '2026-09-09'), /Post image is required/);
  assert.throws(() => requireExistingImage(path.join(tmp, 'missing.jpg'), '2026-09-09'), /Post image not found/);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('gbp-driver self-check: all assertions passed ✓');
