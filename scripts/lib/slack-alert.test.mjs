// scripts/lib/slack-alert.test.mjs
import assert from 'node:assert/strict';
import { getSlackConfig, approvalBlocks, sendSlackBlocks } from './slack-alert.mjs';

// Fail closed: every combination of missing config disables delivery.
assert.equal(getSlackConfig({}).enabled, false);
assert.equal(getSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-1' }).enabled, false);
assert.equal(getSlackConfig({ SLACK_ALERT_CHANNEL: '#seo-ops' }).enabled, false);
const full = getSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_ALERT_CHANNEL: '#seo-ops' });
assert.equal(full.enabled, true);
assert.equal(full.token, 'xoxb-1');
assert.equal(full.channel, '#seo-ops');

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

console.log('ok slack-alert');
