import fs from 'node:fs';

import {
  thumbtackAutomationFile,
  thumbtackAutoReplyEnabled,
  thumbtackEventsFile,
  thumbtackNativeAutoReplyDisabled,
} from './config.mjs';
import { createThumbtackApiClient } from './api.mjs';
import { extractCustomerLeadEvent, splitThumbtackAgentReply } from './lead-state.mjs';
import { generateMaverickReply } from './mav-reply.mjs';
import { notifyThumbtackOps } from './notify.mjs';
import { getThumbtackAutomationStatus, sanitizeCustomerMessage } from './policy.mjs';

let defaultApiClient = null;
function defaultSendMessage(negotiationID, text) {
  defaultApiClient ??= createThumbtackApiClient({ environment: 'production', allowWrites: true });
  return defaultApiClient.sendMessage(negotiationID, text);
}

function hasAutoSentThisEvent(automationFile, recordId) {
  if (!fs.existsSync(automationFile)) return false;
  return fs.readFileSync(automationFile, 'utf8').split(/\r?\n/).some(line => {
    try {
      const row = JSON.parse(line);
      return row.action === 'auto-sent' && row.id === recordId;
    } catch { return false; }
  });
}

function historyForNegotiation(eventsFile, negotiationID) {
  if (!fs.existsSync(eventsFile)) return [];
  const items = [];
  for (const line of fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const lead = extractCustomerLeadEvent(record);
    if (lead?.negotiationID === negotiationID && lead.text) {
      items.push({ role: 'customer', text: lead.text });
      continue;
    }
    const data = record?.payload?.data || {};
    const text = String(data.text || '').trim();
    const from = String(data.from || '');
    const neg = String(data.negotiationID || record.negotiationID || '');
    if (neg === negotiationID && text && /\bbusiness\b/i.test(from)) {
      items.push({ role: 'business', text });
    }
  }
  return items.slice(-20);
}

export function createThumbtackLeadProcessor({
  eventsFile = thumbtackEventsFile,
  automationFile = thumbtackAutomationFile,
  generateReply = generateMaverickReply,
  sendMessage = defaultSendMessage,
  notify = notifyThumbtackOps,
  outboundEnabled = getThumbtackAutomationStatus({
    autoReplyEnabled: thumbtackAutoReplyEnabled,
    nativeAutoReplyDisabled: thumbtackNativeAutoReplyDisabled,
  }).outboundEnabled,
} = {}) {
  const sendsInFlight = new Set();
  const append = entry => fs.appendFileSync(automationFile, `${JSON.stringify({ ...entry, createdAt: new Date().toISOString() })}\n`, 'utf8');
  // Operator nudges are best-effort: a notifier outage must never affect the
  // audit trail or the webhook pipeline.
  const nudge = async message => { try { await notify(message); } catch { /* best-effort only */ } };
  return {
    async process(record) {
      const lead = extractCustomerLeadEvent(record);
      if (!lead) return { action: 'ignored-noncustomer-event' };
      const result = await generateReply({
        ...lead,
        history: historyForNegotiation(eventsFile, lead.negotiationID),
      });
      if (!result?.success) {
        append({ id: record.id, operationId: lead.operationId, negotiationID: lead.negotiationID, action: 'agent-failed', error: String(result?.error || 'unknown') });
        return { action: 'agent-failed' };
      }
      const split = splitThumbtackAgentReply(result.reply);
      // A valid ready block intentionally has no visible text. Do not replace
      // that with the generic fallback because the next estimate gate owns it.
      const visible = split.visibleReply ? sanitizeCustomerMessage(split.visibleReply) : { safe: true, text: '' };
      const action = split.malformed ? 'needs-review' : split.estimateReady ? 'ready-for-estimate-review' : 'drafted-reply';
      append({ id: record.id, operationId: lead.operationId, action, replySafe: visible.safe, reply: visible.text });

      // Mav owns the thread. Auto-send every safe drafted reply, including
      // follow-ups. Dedup is per webhook event so a retry cannot double-send.
      const sendable = outboundEnabled && action === 'drafted-reply' && visible.safe && visible.text &&
        !hasAutoSentThisEvent(automationFile, record.id) && !sendsInFlight.has(lead.negotiationID);
      if (!sendable) {
        await nudge(`Thumbtack ${action} for ${lead.customerName || 'customer'} (neg ${lead.negotiationID}): ${visible.text || 'no visible text'}`);
        return { action, reply: visible.text };
      }

      sendsInFlight.add(lead.negotiationID);
      try {
        await sendMessage(lead.negotiationID, visible.text);
        append({ id: record.id, operationId: lead.operationId, negotiationID: lead.negotiationID, action: 'auto-sent', reply: visible.text });
        return { action: 'auto-sent', reply: visible.text };
      } catch (error) {
        append({ id: record.id, operationId: lead.operationId, negotiationID: lead.negotiationID, action: 'send-failed', error: error?.message || 'unknown' });
        await nudge(`Thumbtack send-failed for ${lead.customerName || 'customer'} (neg ${lead.negotiationID}): ${error?.message || 'unknown'}`);
        return { action: 'send-failed', reply: visible.text };
      } finally {
        sendsInFlight.delete(lead.negotiationID);
      }
    },
  };
}
