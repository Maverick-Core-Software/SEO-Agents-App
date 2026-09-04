// Thumbtack webhook intake. Every authenticated event is persisted before any
// agent workflow runs; the lead processor may auto-send a first-touch reply
// only when the outbound policy gate is fully enabled.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  thumbtackAutoReplyEnabled,
  thumbtackAutomationFile,
  thumbtackEventsFile,
  thumbtackHcpWritesEnabled,
  thumbtackNativeAutoReplyDisabled,
  thumbtackWebhookSecret,
} from './config.mjs';
import { readJsonBody, sendJson } from './http.mjs';
import { extractCustomerLeadEvent } from './lead-state.mjs';
import { createThumbtackLeadProcessor } from './lead-processor.mjs';
import { getThumbtackAutomationStatus } from './policy.mjs';

const loadedEventIds = new Map();
const leadProcessor = createThumbtackLeadProcessor();

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(req, secret) {
  const custom = headerValue(req.headers, 'x-maverick-webhook-token');
  if (secureEqual(custom, secret)) return true;
  const authorization = String(headerValue(req.headers, 'authorization') || '');
  if (!authorization.toLowerCase().startsWith('basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8'); } catch { return false; }
  const sep = decoded.indexOf(':');
  const password = sep >= 0 ? decoded.slice(sep + 1) : decoded;
  return secureEqual(password, secret) || secureEqual(decoded, secret);
}

function getEventIds(eventsFile) {
  const resolved = path.resolve(eventsFile);
  if (loadedEventIds.has(resolved)) return loadedEventIds.get(resolved);

  const ids = new Set();
  try {
    if (fs.existsSync(resolved)) {
      for (const line of fs.readFileSync(resolved, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record?.id) ids.add(record.id);
        } catch {
          // Preserve intake availability if one historical line is malformed.
        }
      }
    }
  } catch (error) {
    console.error(`[thumbtack] failed to load event IDs: ${error.message}`);
  }
  loadedEventIds.set(resolved, ids);
  return ids;
}

function eventSummary(payload) {
  const data = payload?.data || payload?.event?.data || {};
  return {
    eventType: payload?.eventType || payload?.type || payload?.event?.eventType || payload?.event?.type || 'unknown',
    messageID: payload?.messageID || data?.messageID || null,
    negotiationID: payload?.negotiationID || data?.negotiationID || null,
  };
}

export function createThumbtackWebhookHandler({
  secret = thumbtackWebhookSecret,
  eventsFile = thumbtackEventsFile,
  automationFile = thumbtackAutomationFile,
  automation = getThumbtackAutomationStatus({
    autoReplyEnabled: thumbtackAutoReplyEnabled,
    nativeAutoReplyDisabled: thumbtackNativeAutoReplyDisabled,
    hcpWritesEnabled: thumbtackHcpWritesEnabled,
  }),
  processor = leadProcessor,
} = {}) {
  return async function handleThumbtackWebhook(req, res) {
    if (!secret) {
      sendJson(res, 503, { error: 'Thumbtack webhook is not configured.' });
      return;
    }

    if (!isAuthorized(req, secret)) {
      console.warn('[thumbtack] unauthorized webhook (missing header or basic auth)');
      sendJson(res, 401, { error: 'Unauthorized.' });
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(req, 1_000_000);
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        throw new Error('Webhook payload must be a JSON object.');
      }
    } catch (error) {
      const tooLarge = /too large/i.test(error.message);
      sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'Request body too large.' : 'Invalid JSON payload.' });
      return;
    }

    const payloadJson = JSON.stringify(payload);
    const id = crypto.createHash('sha256').update(payloadJson).digest('hex');
    const ids = getEventIds(eventsFile);
    if (ids.has(id)) {
      sendJson(res, 200, { received: true, duplicate: true, mode: automation.mode });
      return;
    }

    const record = {
      id,
      receivedAt: new Date().toISOString(),
      ...eventSummary(payload),
      payload,
    };

    const lead = extractCustomerLeadEvent(record);
    try {
      fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
      fs.appendFileSync(eventsFile, `${JSON.stringify(record)}\n`, 'utf8');
      // Shadow records form an auditable queue for the lead-state engine. They
      // never include a generated response, invoke HCP, or send Thumbtack API writes.
      fs.appendFileSync(automationFile, `${JSON.stringify({
        id,
        receivedAt: record.receivedAt,
        eventType: record.eventType,
        negotiationID: record.negotiationID,
        messageID: record.messageID,
        mode: automation.mode,
        action: lead ? 'awaiting-qualification' : 'ignored-noncustomer-event',
        ...(lead ? { operationId: lead.operationId } : {}),
      })}\n`, 'utf8');
      ids.add(id);
    } catch (error) {
      console.error(`[thumbtack] failed to persist webhook: ${error.message}`);
      sendJson(res, 500, { error: 'Failed to persist webhook.' });
      return;
    }

    console.log(`[thumbtack] captured ${record.eventType} negotiation=${record.negotiationID || '-'} message=${record.messageID || '-'}`);
    if (lead) setImmediate(() => { void processor.process(record).catch(error => console.error(`[thumbtack] lead processor failed: ${error?.message || error}`)); });
    sendJson(res, 202, { received: true, duplicate: false, mode: automation.mode });
  };
}

export const handleThumbtackWebhook = createThumbtackWebhookHandler();

export function getThumbtackWebhookStatus(_req, res) {
  const automation = getThumbtackAutomationStatus({
    autoReplyEnabled: thumbtackAutoReplyEnabled,
    nativeAutoReplyDisabled: thumbtackNativeAutoReplyDisabled,
    hcpWritesEnabled: thumbtackHcpWritesEnabled,
  });
  let lastEventAt = null;
  try {
    if (fs.existsSync(thumbtackEventsFile)) {
      lastEventAt = fs.statSync(thumbtackEventsFile).mtime.toISOString();
    }
  } catch {
    lastEventAt = null;
  }
  sendJson(res, 200, {
    state: thumbtackWebhookSecret ? 'ready' : 'not-configured',
    mode: automation.mode,
    outboundEnabled: automation.outboundEnabled,
    hcpWritesEnabled: automation.hcpWritesEnabled,
    reasons: automation.reasons,
    lastEventAt,
  });
}
