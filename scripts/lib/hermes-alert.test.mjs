// scripts/lib/hermes-alert.test.mjs
// Platform rules for the hermes CLI transport, and the T1 receipt contract that
// notify.mjs builds on top of it. Exec is injected, so nothing is spawned.
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildHermesInvocation, sendHermesAlertWith } from './hermes-alert.mjs';
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

// The seam forwards exactly the built invocation to exec.
{
  const seen = [];
  await sendHermesAlertWith('hello', { env: {}, platform: 'linux', exec: async (cli, args, options) => { seen.push({ cli, args, options }); } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cli, 'hermes');
  assert.equal(seen[0].args[4], 'hello');
}

// Receipt contract (T1). notifyAttempt returns { sent, channel, reason } and writes a
// `notify:<event>` stage { started_at, finished_at, status, error }. The hermes
// wrapper mirrors notify.mjs defaultHermes: resolve becomes { ok: true }.
function recordingStore() {
  const writes = [];
  return { writes, store: { updateAttempt: async (id, patch) => { writes.push({ id, patch }); } } };
}
const freshAttempt = () => ({ id: 'abcdef1234567890', status: 'succeeded', stages: {} });
const smtpOff = async () => ({ ok: false, reason: 'smtp not configured' });
const now = new Date('2026-10-13T00:00:00Z');
const viaHermes = (exec) => async (message) => {
  await sendHermesAlertWith(message, { env: {}, platform: 'linux', exec });
  return { ok: true };
};

{
  const { store, writes } = recordingStore();
  const res = await notifyAttempt({ store, attempt: freshAttempt(), event: 'succeeded', message: 'x', hermes: viaHermes(async () => {}), smtp: smtpOff, now });
  assert.deepEqual(res, { sent: true, channel: 'hermes', reason: '' });
  const receipt = writes[0].patch.stages['notify:succeeded'];
  assert.deepEqual(Object.keys(receipt).sort(), ['error', 'finished_at', 'started_at', 'status']);
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.error, 'via hermes');
}

{
  const { store, writes } = recordingStore();
  const res = await notifyAttempt({
    store, attempt: freshAttempt(), event: 'failed', message: 'x',
    hermes: viaHermes(async () => { throw new Error('boom'); }), smtp: smtpOff, now,
  });
  assert.deepEqual(res, { sent: false, channel: 'none', reason: 'hermes: boom' });
  const receipt = writes[0].patch.stages['notify:failed'];
  assert.deepEqual(Object.keys(receipt).sort(), ['error', 'finished_at', 'started_at', 'status']);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error, 'hermes: boom');
}

console.log('ok hermes-alert');
