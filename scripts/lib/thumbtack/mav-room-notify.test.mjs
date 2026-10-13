import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatLeadNotice, notifyMavRoomLead } from './mav-room-notify.mjs';

// The module reads its token from MAV_ROOM_ENV_FILE (default: the PC's Mav-Room
// runtime.env). The test points it at a throwaway file with a fake token and
// clears the process-level overrides, so it passes on any host.
const ENV_KEYS = ['MAV_ROOM_ENV_FILE', 'MAV_FABRIC_MAVH_CREDENTIAL', 'MAV_FABRIC_URL', 'MAV_ROOM_ID'];

function withFakeRuntimeEnv(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mav-room-notify-'));
  const file = path.join(dir, 'runtime.env');
  fs.writeFileSync(file, 'MAV_FABRIC_MAVH_CREDENTIAL=fake-test-token\nMAV_ROOM_ID=mav-room\n');
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.MAV_ROOM_ENV_FILE = file;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('formats a lead notice without dumping a novel', () => {
  const text = formatLeadNotice({
    concern: 'Pool pump on 240V, one side dead',
    reply: 'Thanks — can you send a photo of the breaker?',
  });
  assert.match(text, /New Thumbtack lead: Pool pump on 240V/);
  assert.match(text, /Mav replied: Thanks/);
});

test('posts to the fabric events URL as a message', () => withFakeRuntimeEnv(async () => {
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
  assert.equal(calls[0].opts.headers.authorization, 'Bearer fake-test-token');
}));
