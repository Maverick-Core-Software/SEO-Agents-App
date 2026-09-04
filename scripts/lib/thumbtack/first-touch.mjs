import { CUSTOMER_FALLBACK, sanitizeCustomerMessage } from './policy.mjs';

const OFFICE_PHONE = '(469) 863-9804';

function firstName(customerName) {
  const token = String(customerName || '').trim().split(/\s+/)[0];
  return token && token.length <= 40 ? token : '';
}

function scopingQuestion(lead) {
  const text = String(lead?.text || '').toLowerCase();
  if (/\bev\b|charger|tesla/.test(text)) return 'Is this for a new EV charger circuit, or is something already in place that is not working?';
  if (/panel|breaker|fuse/.test(text)) return 'Are you looking to replace the panel, add capacity, or troubleshoot a tripped breaker?';
  if (/outlet|receptacle|plug/.test(text)) return 'Is this a new outlet install, or is an existing one not working?';
  if (/light|fan|fixture/.test(text)) return 'Is this a new fixture install, or is an existing light or fan acting up?';
  if (/generator|transfer/.test(text)) return 'Is this a standby generator / transfer-switch install, or service on existing equipment?';
  return 'Can you tell me a bit more about the electrical work you need at the house?';
}

export function generateFirstTouchReply(lead = {}) {
  const name = firstName(lead.customerName);
  const hello = name ? `Hi ${name}` : 'Hi';
  const category = String(lead.category || '').trim();
  const about = category ? ` about your ${category} request` : '';
  const text = [
    `${hello} — this is Jaime with Grizzly Electrical Solutions. I received your Thumbtack request${about}.`,
    scopingQuestion(lead),
    `If it is easier to talk it through, call us at ${OFFICE_PHONE}.`,
  ].join(' ');
  const sanitized = sanitizeCustomerMessage(text);
  if (!sanitized.safe || !sanitized.text) {
    return { success: true, reply: CUSTOMER_FALLBACK, source: 'first-touch-fallback' };
  }
  return { success: true, reply: sanitized.text, source: 'first-touch' };
}
