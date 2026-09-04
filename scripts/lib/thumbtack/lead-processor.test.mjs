import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { createThumbtackLeadProcessor } from './lead-processor.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function makeNewLeadFixture({ priorAutomation = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-thumbtack-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.jsonl');
  const automationFile = path.join(dir, 'automation.jsonl');
  const record = {
    id: 'a'.repeat(64),
    eventType: 'NegotiationCreatedV4',
    negotiationID: 'neg-1',
    payload: {
      data: {
        negotiationID: 'neg-1',
        customer: { displayName: 'Sam' },
        request: { description: 'Need an EV charger', category: { name: 'Electrician' } },
      },
    },
  };
  fs.writeFileSync(eventsFile, `${JSON.stringify(record)}\n`);
  if (priorAutomation.length) fs.writeFileSync(automationFile, priorAutomation.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { eventsFile, automationFile, record };
}

function makeMessageFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-thumbtack-'));
  dirs.push(dir);
  const eventsFile = path.join(dir, 'events.jsonl');
  const automationFile = path.join(dir, 'automation.jsonl');
  const record = {
    id: 'a'.repeat(64),
    eventType: 'MessageCreatedV4',
    negotiationID: 'neg-1',
    payload: { data: { from: 'customer', messageID: 'm-1', negotiationID: 'neg-1', text: 'Need an EV charger', customer: { displayName: 'Sam' } } },
  };
  fs.writeFileSync(eventsFile, `${JSON.stringify(record)}\n`);
  return { eventsFile, automationFile, record };
}

test('auto-sends a new-lead first-touch when outbound is enabled', async () => {
  const { eventsFile, automationFile, record } = makeNewLeadFixture();
  const sent = [];
  const processor = createThumbtackLeadProcessor({
    eventsFile, automationFile, outboundEnabled: true,
    generateReply: async () => ({ success: true, reply: 'What amperage charger are you planning for?' }),
    sendMessage: async (negotiationID, text) => { sent.push({ negotiationID, text }); },
    notify: async () => {},
  });
  const result = await processor.process(record);
  assert.equal(result.action, 'auto-sent');
  assert.deepEqual(sent, [{ negotiationID: 'neg-1', text: 'What amperage charger are you planning for?' }]);
});

test('auto-sends a customer follow-up when Mav returns a safe reply', async () => {
  const { eventsFile, automationFile, record } = makeMessageFixture();
  const sent = [];
  const processor = createThumbtackLeadProcessor({
    eventsFile, automationFile, outboundEnabled: true,
    generateReply: async input => {
      assert.equal(input.kind, 'customer-message');
      return { success: true, reply: 'Is this a new charger circuit?' };
    },
    sendMessage: async (negotiationID, text) => { sent.push({ negotiationID, text }); },
    notify: async () => {},
  });
  const result = await processor.process(record);
  assert.equal(result.action, 'auto-sent');
  assert.deepEqual(sent, [{ negotiationID: 'neg-1', text: 'Is this a new charger circuit?' }]);
});

test('does not auto-send when outbound is disabled', async () => {
  const { eventsFile, automationFile, record } = makeNewLeadFixture();
  const sent = [];
  const processor = createThumbtackLeadProcessor({
    eventsFile, automationFile, outboundEnabled: false,
    generateReply: async () => ({ success: true, reply: 'What amperage charger are you planning for?' }),
    sendMessage: async (...args) => { sent.push(args); },
    notify: async () => {},
  });
  assert.equal((await processor.process(record)).action, 'drafted-reply');
  assert.deepEqual(sent, []);
});

test('nudges on send-failed', async () => {
  const { eventsFile, automationFile, record } = makeNewLeadFixture();
  const nudges = [];
  const processor = createThumbtackLeadProcessor({
    eventsFile, automationFile, outboundEnabled: true,
    generateReply: async () => ({ success: true, reply: 'What amperage charger are you planning for?' }),
    sendMessage: async () => { throw new Error('Thumbtack API error (HTTP 500)'); },
    notify: async message => { nudges.push(message); },
  });
  assert.equal((await processor.process(record)).action, 'send-failed');
  assert.equal(nudges.length, 1);
  assert.match(nudges[0], /send-failed/);
});
