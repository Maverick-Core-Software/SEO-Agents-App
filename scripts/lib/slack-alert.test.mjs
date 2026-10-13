// scripts/lib/slack-alert.test.mjs
import assert from 'node:assert/strict';
import { getSlackConfig, approvalBlocks, sendSlackBlocks, _resolveSlackConfig } from './slack-alert.mjs';

// Fail closed: every combination of missing config disables delivery.
assert.equal(getSlackConfig({}).enabled, false);
assert.equal(getSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-1' }).enabled, false);
assert.equal(getSlackConfig({ SLACK_ALERT_CHANNEL: '#seo-ops' }).enabled, false);
const full = getSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_ALERT_CHANNEL: '#seo-ops' });
assert.equal(full.enabled, true);
assert.equal(full.token, 'xoxb-1');
assert.equal(full.channel, '#seo-ops');

// Hermes-owned credentials are a fallback only; explicit SEO env still wins.
const hermes = getSlackConfig({}, { SLACK_BOT_TOKEN: 'xoxb-hermes', SLACK_HOME_CHANNEL: 'C123' });
assert.equal(hermes.enabled, true);
assert.equal(hermes.token, 'xoxb-hermes');
assert.equal(hermes.channel, 'C123');
const explicit = getSlackConfig(
  { SLACK_BOT_TOKEN: 'xoxb-local', SLACK_ALERT_CHANNEL: 'C-local' },
  { SLACK_BOT_TOKEN: 'xoxb-hermes', SLACK_HOME_CHANNEL: 'C-hermes' },
);
assert.equal(explicit.token, 'xoxb-local');
assert.equal(explicit.channel, 'C-local');

// approvalBlocks: section + allowlisted action_ids; no buttons => section only
{
  const blocks = approvalBlocks({ title: 'Failed: X', detail: 'boom', actionId: 'abc-123', buttons: ['approve', 'retry'] });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'section');
  assert.ok(blocks[0].text.text.includes('boom'));
  const elements = blocks[1].elements;
  assert.equal(elements[0].action_id, 'seo_approve:abc-123');
  assert.equal(elements[1].action_id, 'seo_retry:abc-123');
  assert.equal(elements[0].value, 'abc-123');
}
{
  const blocks = approvalBlocks({ title: 'T', actionId: 'abc-123', buttons: [] });
  assert.equal(blocks.length, 1);
}
{
  const blocks = approvalBlocks({ title: 'T', actionId: 'abc-123', buttons: ['bogus-verb'] });
  assert.equal(blocks[1].elements[0].action_id, 'seo_bogus-verb:abc-123'); // builder is permissive; allowlist lives on the handler
}

// sendSlackBlocks: correct wire format via injected fetch
{
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { json: async () => ({ ok: true }) };
  };
  const ok = await sendSlackBlocks({ blocks: approvalBlocks({ title: 'T', actionId: 'x', buttons: ['approve'] }), text: 'T', config: full, fetchImpl });
  assert.equal(ok, true);
  assert.equal(captured.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(captured.opts.headers.authorization, 'Bearer xoxb-1');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.channel, '#seo-ops');
  assert.equal(body.blocks[0].type, 'section');
}

// send failure (Slack error) => false, no throw
{
  const fetchImpl = async () => ({ json: async () => ({ ok: false, error: 'invalid_auth' }) });
  assert.equal(await sendSlackBlocks({ blocks: [], text: 'T', config: full, fetchImpl }), false);
}
// network failure => false, no throw
{
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  assert.equal(await sendSlackBlocks({ blocks: [], text: 'T', config: full, fetchImpl }), false);
}
// disabled config => no network call at all
{
  let called = false;
  const fetchImpl = async () => { called = true; return { json: async () => ({ ok: true }) }; };
  const disabled = getSlackConfig({});
  assert.equal(await sendSlackBlocks({ blocks: [], text: 'T', config: disabled, fetchImpl }), false);
  assert.equal(called, false);
}

// Linux with env token+channel: the %LOCALAPPDATA% Hermes file is never read, and
// the resolved config is exactly the env values.
{
  let reads = 0;
  const readFile = () => { reads += 1; return { SLACK_BOT_TOKEN: 'xoxb-file', SLACK_ALERT_CHANNEL: 'C-file' }; };
  const cfg = _resolveSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-env', SLACK_ALERT_CHANNEL: '#env' }, 'linux', readFile);
  assert.deepEqual(cfg, { enabled: true, token: 'xoxb-env', channel: '#env' });
  assert.equal(reads, 0);
}

// Linux with only the token set: still no file read, and delivery stays disabled.
{
  let reads = 0;
  const cfg = _resolveSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-env' }, 'linux', () => { reads += 1; return { SLACK_ALERT_CHANNEL: 'C-file' }; });
  assert.equal(cfg.enabled, false);
  assert.equal(reads, 0);
}

// Linux with everything unset: a disabled no-op. No throw, no network call.
{
  let reads = 0;
  const cfg = _resolveSlackConfig({}, 'linux', () => { reads += 1; return {}; });
  assert.deepEqual(cfg, { enabled: false, token: '', channel: '' });
  assert.equal(reads, 0);
  let called = false;
  const fetchImpl = async () => { called = true; return { json: async () => ({ ok: true }) }; };
  assert.equal(await sendSlackBlocks({ blocks: [], text: 'T', config: cfg, fetchImpl }), false);
  assert.equal(called, false);
}

// win32 with the channel unset: the Hermes file fills only the gap, and env still wins per field.
{
  const cfg = _resolveSlackConfig({ SLACK_ALERT_CHANNEL: '#env' }, 'win32', () => ({ SLACK_BOT_TOKEN: 'xoxb-file', SLACK_HOME_CHANNEL: 'C-file' }));
  assert.deepEqual(cfg, { enabled: true, token: 'xoxb-file', channel: '#env' });
}

console.log('ok slack-alert');
