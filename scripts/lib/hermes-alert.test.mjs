// scripts/lib/hermes-alert.test.mjs
// Platform rules for the hermes CLI transport, the Hermes -> Slack -> SMTP transport
// order, and the T1 receipt contract that notify.mjs builds on top of it. exec, exists,
// fetch and slack config are all injected: nothing is spawned and nothing hits the network.
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildHermesInvocation, deliverPrimary, hermesCliExists, sendHermesAlertWith, sendSmtpAlert,
} from './hermes-alert.mjs';
import { notifyAttempt } from '../weekly/lib/notify.mjs';

const WIN32_CLI = 'C:\\Users\\carte\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe';

// Linux default: bare `hermes` on PATH. No windowsHide, no PYTHONPATH rewrite.
{
  const inv = buildHermesInvocation('msg', {}, 'linux');
  assert.equal(inv.cli, 'hermes');
  assert.deepEqual(inv.args, ['send', '--to', 'slack', '--quiet', 'msg']);
  assert.equal('windowsHide' in inv.options, false);
  assert.equal(inv.options.env.PYTHONPATH, undefined);
}

// HERMES_CLI is the primary override on any platform and may be any name.
{
  const inv = buildHermesInvocation('m', { HERMES_CLI: '/opt/hermes/venv/bin/hermes-prod', HERMES_ALERT_TO: 'sms' }, 'linux');
  assert.equal(inv.cli, '/opt/hermes/venv/bin/hermes-prod');
  assert.deepEqual(inv.args.slice(0, 3), ['send', '--to', 'sms']);
}

// win32 default: the venv path, windowsHide on, and PYTHONPATH on the derived source root.
{
  const inv = buildHermesInvocation('m', {}, 'win32');
  assert.equal(inv.cli, WIN32_CLI);
  assert.equal(inv.options.windowsHide, true);
  assert.equal(inv.options.env.PYTHONPATH, path.win32.resolve(path.win32.dirname(WIN32_CLI), '..', '..'));
}

// Missing-CLI detection is fast and never throws: a path must exist, a bare name must be on PATH.
{
  const none = () => false;
  assert.equal(hermesCliExists('/definitely/not/here/hermes', {}, 'linux', none), false);
  assert.equal(hermesCliExists('/definitely/not/here/hermes', {}, 'linux'), false, 'real fs check, no spawn');
  assert.equal(hermesCliExists('hermes', { PATH: '/usr/bin:/opt/x' }, 'linux', (p) => p === '/opt/x/hermes'), true);
  assert.equal(hermesCliExists('hermes', {}, 'linux', () => true), false, 'no PATH means no bare-name match');
  assert.equal(hermesCliExists(undefined, {}, 'linux', () => { throw new Error('boom'); }), false, 'never throws');
}

// The shared seam forwards exactly the built invocation to exec and names the channel.
{
  const seen = [];
  const res = await sendHermesAlertWith('hello', {
    env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => true, slackConfig: { enabled: false },
    exec: async (cli, args, options) => { seen.push({ cli, args, options }); },
  });
  assert.deepEqual(res, { channel: 'hermes' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cli, 'hermes');
  assert.equal(seen[0].args[4], 'hello');
}

// Receipt contract (T1). notifyAttempt returns { sent, channel, reason } and writes a
// `notify:<event>` stage { started_at, finished_at, status, error }.
function recordingStore() {
  const writes = [];
  return { writes, store: { updateAttempt: async (id, patch) => { writes.push({ id, patch }); } } };
}
const freshAttempt = () => ({ id: 'abcdef1234567890', status: 'succeeded', stages: {} });
const smtpOff = async () => ({ ok: false, reason: 'smtp not configured' });
const now = new Date('2026-10-13T00:00:00Z');
const slackOff = { enabled: false };
const noFetch = () => { throw new Error('fetch must not be called'); };
const okFetch = (calls) => async (url, opts) => { calls.push({ url, opts }); return { json: async () => ({ ok: true }) }; };
// Primary hop for notifyAttempt: Hermes CLI (exec injected), then Slack (config injected).
const primary = ({ exists = () => true, exec = async () => {}, slack = slackOff, fetchImpl = noFetch } = {}) =>
  async (message) => deliverPrimary(message, { env: { PATH: '/usr/bin' }, platform: 'linux', exists, exec, slackConfig: slack, fetchImpl });

// 1. hermes ok: channel 'hermes', receipt 'via hermes', Slack never called.
{
  const { store, writes } = recordingStore();
  const res = await notifyAttempt({ store, attempt: freshAttempt(), event: 'succeeded', message: 'x', hermes: primary(), smtp: smtpOff, now });
  assert.deepEqual(res, { sent: true, channel: 'hermes', reason: '' });
  const receipt = writes[0].patch.stages['notify:succeeded'];
  assert.deepEqual(Object.keys(receipt).sort(), ['error', 'finished_at', 'started_at', 'status']);
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.error, 'via hermes');
}

// 2. hermes throws, smtp off, slack off: sent false, every reason named, no throw.
{
  const { store, writes } = recordingStore();
  const res = await notifyAttempt({
    store, attempt: freshAttempt(), event: 'failed', message: 'x',
    hermes: primary({ exec: async () => { throw new Error('boom'); } }), smtp: smtpOff, now,
  });
  assert.deepEqual(res, { sent: false, channel: 'none', reason: 'hermes: boom; slack: not configured; smtp not configured' });
  const receipt = writes[0].patch.stages['notify:failed'];
  assert.deepEqual(Object.keys(receipt).sort(), ['error', 'finished_at', 'started_at', 'status']);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error, 'hermes: boom; slack: not configured; smtp not configured');
}

// 3. hermes missing + slack ok: channel 'slack', sent true, exec never called.
{
  const exec = async () => { throw new Error('exec must not be called'); };
  const calls = [];
  const slack = { enabled: true, token: 'xoxb-test', channel: '#seo-ops' };
  const res = await deliverPrimary('m', { env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => false, exec, slackConfig: slack, fetchImpl: okFetch(calls) });
  assert.deepEqual(res, { ok: true, channel: 'slack' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(JSON.parse(calls[0].opts.body).channel, '#seo-ops');

  const { store, writes } = recordingStore();
  const r = await notifyAttempt({
    store, attempt: freshAttempt(), event: 'succeeded', message: 'x',
    hermes: primary({ exists: () => false, slack, fetchImpl: okFetch([]) }), smtp: smtpOff, now,
  });
  assert.deepEqual(r, { sent: true, channel: 'slack', reason: '' });
  assert.equal(writes[0].patch.stages['notify:succeeded'].error, 'via slack');
}

// 4. hermes missing + slack missing + smtp missing: sent false with all three reasons, no throw.
{
  const { store } = recordingStore();
  const exec = async () => { throw new Error('exec must not be called'); };
  const r = await notifyAttempt({
    store, attempt: freshAttempt(), event: 'failed', message: 'x',
    hermes: primary({ exists: () => false, exec, slack: slackOff }),
    smtp: (m) => sendSmtpAlert(m, { env: {} }), now,
  });
  assert.equal(r.sent, false);
  assert.equal(r.channel, 'none');
  assert.match(r.reason, /hermes: CLI not found \(hermes\)/);
  assert.match(r.reason, /slack: not configured/);
  assert.match(r.reason, /smtp not configured/);
}

// 5. Shared path: same three-way failure rejects with the joined reasons.
{
  await assert.rejects(
    () => sendHermesAlertWith('m', { env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => false, slackConfig: slackOff, exec: async () => {} }),
    /hermes: CLI not found \(hermes\); slack: not configured; smtp not configured/,
  );
}

// 6. Shared path: hermes missing, slack ok -> { channel: 'slack' }, no SMTP call.
{
  const calls = [];
  const res = await sendHermesAlertWith('m', {
    env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => false,
    slackConfig: { enabled: true, token: 'xoxb-test', channel: '#seo-ops' }, fetchImpl: okFetch(calls),
  });
  assert.deepEqual(res, { channel: 'slack' });
  assert.equal(calls.length, 1);
}

console.log('ok hermes-alert');
