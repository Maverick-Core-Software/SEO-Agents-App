import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLeadNotice, notifyMavRoomLead } from './mav-room-notify.mjs';

test('formats a lead notice without dumping a novel', () => {
  const text = formatLeadNotice({
    concern: 'Pool pump on 240V, one side dead',
    reply: 'Thanks — can you send a photo of the breaker?',
  });
  assert.match(text, /New Thumbtack lead: Pool pump on 240V/);
  assert.match(text, /Mav replied: Thanks/);
});

test('posts to the fabric events URL as a message', async () => {
  const calls = [];
  const result = await notifyMavRoomLead({
    concern: 'Need an EV charger',
    reply: 'Is this a new circuit?',
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/rooms\/mav-room\/events$/);
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.type, 'message');
  assert.match(body.payload.text, /EV charger/);
  assert.match(String(calls[0].opts.headers.authorization), /^Bearer /);
});
