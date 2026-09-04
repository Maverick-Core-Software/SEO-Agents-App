import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, test } from 'node:test';

import { createThumbtackWebhookHandler } from './webhook.mjs';

const tempDirs = [];
afterEach(() => tempDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function makeRequest(payload, token = 'test-secret') {
  const req = Readable.from([typeof payload === 'string' ? payload : JSON.stringify(payload)]);
  req.headers = token === null ? {} : { 'x-maverick-webhook-token': token };
  return req;
}

function makeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function makeHandler(secret = 'test-secret') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-thumbtack-'));
  tempDirs.push(dir);
  const eventsFile = path.join(dir, 'events.jsonl');
  const automationFile = path.join(dir, 'automation.jsonl');
  return {
    handler: createThumbtackWebhookHandler({
      secret,
      eventsFile,
      automationFile,
      automation: { mode: 'outbound-enabled', outboundEnabled: true, hcpWritesEnabled: false, reasons: [] },
      processor: { process: async () => ({ action: 'test' }) },
    }),
    eventsFile,
  };
}

test('rejects missing webhook token', async () => {
  const { handler } = makeHandler();
  const res = makeResponse();
  await handler(makeRequest({ eventType: 'NegotiationCreatedV4' }, null), res);
  assert.equal(res.status, 401);
});

test('accepts HTTP Basic auth using the webhook secret as the password', async () => {
  const { handler, eventsFile } = makeHandler();
  const req = makeRequest({ event: { eventType: 'NegotiationCreatedV4' }, data: { negotiationID: 'neg-2' } }, null);
  req.headers.authorization = `Basic ${Buffer.from('thumbtack:test-secret').toString('base64')}`;
  const res = makeResponse();
  await handler(req, res);
  assert.equal(res.status, 202);
  assert.equal(fs.existsSync(eventsFile), true);
});

test('persists an authenticated event once and recognizes a retry', async () => {
  const { handler, eventsFile } = makeHandler();
  const payload = { event: { eventType: 'MessageCreatedV4' }, data: { from: 'Customer', messageID: 'msg-1', negotiationID: 'neg-1', text: 'hi' } };
  const first = makeResponse();
  await handler(makeRequest(payload), first);
  assert.equal(first.status, 202);
  const second = makeResponse();
  await handler(makeRequest(payload), second);
  assert.equal(second.status, 200);
  assert.match(second.body, /"duplicate":true/);
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split(/\n/);
  assert.equal(lines.length, 1);
});
