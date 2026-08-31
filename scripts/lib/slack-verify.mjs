// scripts/lib/slack-verify.mjs
// HMAC-SHA256 "v0" request verification for Slack's signed payloads.
// https://api.slack.com/authentication/verifying-requests-from-slack
// Fail closed: any missing/odd input is rejected, never trusted.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Slack recommends rejecting timestamps more than 5 minutes old (replay window).
export const SLACK_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify a Slack request signature over the RAW body bytes.
 * @param {object} o
 * @param {string} o.signature  value of X-Slack-Signature ("v0=…")
 * @param {string} o.timestamp  value of X-Slack-Request-Timestamp (unix seconds)
 * @param {string} o.body       raw request body, byte-for-byte as received
 * @param {string} o.secret     Slack app signing secret
 * @param {number} [o.nowMs]    injectable clock for tests
 */
export function verifySlackSignature({ signature, timestamp, body, secret, nowMs = Date.now() }) {
  if (!secret) return false;
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)) return false;
  const tsMs = Number(timestamp) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  if (Math.abs(nowMs - tsMs) > SLACK_MAX_SKEW_MS) return false; // stale => replay
  const expected = 'v0=' + createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`, 'utf8')
    .digest('hex');
  // Constant-time compare; length check first because timingSafeEqual throws on
  // mismatched lengths. Expected length (4+64) is public, so no leak.
  const a = Buffer.from(signature || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
