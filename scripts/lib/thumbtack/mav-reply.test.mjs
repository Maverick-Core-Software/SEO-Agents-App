import assert from 'node:assert/strict';
import test from 'node:test';

import { generateMaverickReply } from './mav-reply.mjs';

test('uses Mav when the loopback reply succeeds', async () => {
  const result = await generateMaverickReply(
    { customerName: 'Sam', text: 'Need an EV charger' },
    {
      timeoutMs: 1000,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ success: true, reply: 'Is this a new charger circuit?' }),
      }),
    },
  );
  assert.equal(result.source, 'mav');
  assert.match(result.reply, /charger/i);
});

test('falls back to first-touch when Mav times out', async () => {
  const result = await generateMaverickReply(
    { customerName: 'Sam', text: 'Need an EV charger' },
    {
      timeoutMs: 20,
      fetchImpl: async (_url, opts) => {
        await new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      },
    },
  );
  assert.equal(result.source, 'first-touch');
  assert.equal(result.mavError, 'Agent timed out.');
  assert.match(result.reply, /Jaime/);
});
