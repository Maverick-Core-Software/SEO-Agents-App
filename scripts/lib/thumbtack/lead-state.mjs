// Pure intake classification for the Thumbtack customer channel. It does not
// call an LLM, send a message, or initiate any HCP workflow.

const CUSTOMER_SENDER = /\bcustomer\b/i;
const READY_BLOCK = /\[THUMBTACK_ESTIMATE_READY\]([\s\S]*?)\[\/THUMBTACK_ESTIMATE_READY\]/g;

function eventType(payload) {
  return payload?.eventType || payload?.type || payload?.event?.eventType || payload?.event?.type || 'unknown';
}

function displayName(customer) {
  const nested = String(customer?.displayName || '').trim();
  if (nested) return nested;
  return `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim();
}

function leadTextFromRequest(request) {
  const description = String(request?.description || '').trim();
  const details = Array.isArray(request?.details)
    ? request.details
      .map((item) => {
        const question = String(item?.question || '').trim();
        const answer = String(item?.answer || '').trim();
        if (!question && !answer) return '';
        return [question, answer].filter(Boolean).join(': ');
      })
      .filter(Boolean)
    : [];
  const category = String(request?.category?.name || '').trim();
  return [category && `Category: ${category}`, description, ...details].filter(Boolean).join('\n');
}

export function extractCustomerLeadEvent(record) {
  const payload = record?.payload;
  const data = payload?.data || payload?.event?.data || {};
  const evtType = record?.eventType || eventType(payload);
  if (!record?.id) return null;

  if (evtType === 'NegotiationCreatedV4') {
    const negotiationID = String(data.negotiationID || record.negotiationID || '').trim();
    const text = leadTextFromRequest(data.request || data);
    if (!negotiationID || !text) return null;
    return {
      kind: 'new-lead',
      operationId: `thumbtack-${record.id}`,
      negotiationID,
      messageID: String(data.messageID || `lead-${negotiationID}`).trim(),
      customerName: displayName(data.customer),
      category: String(data.request?.category?.name || data.category?.name || '').trim(),
      text,
    };
  }

  if (evtType === 'MessageCreatedV4' && CUSTOMER_SENDER.test(String(data.from || ''))) {
    const negotiationID = String(data.negotiationID || '').trim();
    const messageID = String(data.messageID || '').trim();
    const text = String(data.text || '').trim();
    if (!negotiationID || !messageID || !text) return null;
    return {
      kind: 'customer-message',
      operationId: `thumbtack-${record.id}`,
      negotiationID,
      messageID,
      customerName: displayName(data.customer),
      category: '',
      text,
    };
  }

  return null;
}

/** Removes internal handoff content before any customer-facing message can be sent. */
export function splitThumbtackAgentReply(reply) {
  const text = String(reply || '');
  const blocks = [...text.matchAll(READY_BLOCK)];
  if (blocks.length > 1) return { visibleReply: '', estimateReady: null, malformed: true };
  if (blocks.length === 0) return { visibleReply: text.trim(), estimateReady: null, malformed: false };

  let estimateReady = null;
  try {
    const candidate = JSON.parse(blocks[0][1]);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) estimateReady = candidate;
  } catch {
    return { visibleReply: '', estimateReady: null, malformed: true };
  }
  return {
    visibleReply: text.replace(READY_BLOCK, '').trim(),
    estimateReady,
    malformed: false,
  };
}
