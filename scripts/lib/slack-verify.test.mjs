// scripts/lib/slack-verify.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySlackSignature, SLACK_MAX_SKEW_MS } from './slack-verify.mjs';

const SECRET = '8f742231b10e8888abcd99c1c9d4c90e';
// Known-answer vector (computed independently at authoring time):
const TS = '1531420618';
const BODY = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
const SIG = 'v0=95ed708e32517ea2fb8bdd6fba5ceda944a3cc843517110084b536048d575843';
const NOW = Number(TS) * 1000;

// valid signature passes
assert.equal(verifySlackSignature({ signature: SIG, timestamp: TS, body: BODY, secret: SECRET, nowMs: NOW }), true);

// tampered body => fail
assert.equal(verifySlackSignature({ signature: SIG, timestamp: TS, body: BODY + 'x', secret: SECRET, nowMs: NOW }), false);

// wrong secret => fail
assert.equal(verifySlackSignature({ signature: SIG, timestamp: TS, body: BODY, secret: 'wrong-secret', nowMs: NOW }), false);

// stale timestamp (replay) => fail
assert.equal(verifySlackSignature({ signature: SIG, timestamp: TS, body: BODY, secret: SECRET, nowMs: NOW + 10 * 60 * 1000 }), false);
// future timestamp => fail
assert.equal(verifySlackSignature({ signature: SIG, timestamp: TS, body: BODY, secret: SECRET, nowMs: NOW - 10 * 60 * 1000 }), false);
// exactly at the window edge passes (skew is `>` the limit)
assert.equal(verifySlackSignature({ signature: SIG, timestamp: TS, body: BODY, secret: SECRET, nowMs: NOW + SLACK_MAX_SKEW_MS }), true);

// fail closed: no secret, garbage inputs
assert.equal(verifySlackSignature({ signature: SIG, timestamp: TS, body: BODY, secret: '', nowMs: NOW }), false);
assert.equal(verifySlackSignature({ signature: SIG, timestamp: 'not-a-timestamp', body: BODY, secret: SECRET, nowMs: NOW }), false);
assert.equal(verifySlackSignature({ signature: 'v0:short', timestamp: TS, body: BODY, secret: SECRET, nowMs: NOW }), false);
assert.equal(verifySlackSignature({ signature: undefined, timestamp: TS, body: BODY, secret: SECRET, nowMs: NOW }), false);

// second vector, computed in-test with node:crypto (cross-checks the algorithm)
{
  const ts = String(Math.floor(Date.now() / 1000));
  const body = 'payload=%7B%22type%22%3A%22block_actions%22%2C%22actions%22%3A%5B%5D%7D';
  const sig = 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`, 'utf8').digest('hex');
  assert.equal(verifySlackSignature({ signature: sig, timestamp: ts, body, secret: SECRET, nowMs: Number(ts) * 1000 }), true);
  assert.equal(verifySlackSignature({ signature: sig, timestamp: ts, body: body.replace('%7B', '%7C'), secret: SECRET, nowMs: Number(ts) * 1000 }), false);
}

console.log('ok slack-verify');
