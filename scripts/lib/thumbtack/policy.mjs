// Customer-facing Thumbtack automation policy. This is intentionally separate
// from Hermes so a new channel cannot alter the existing customer SMS service.

const INTERNAL_LANGUAGE = [
  /\b(?:housecall\s*pro|\bhcp\b|api|database|endpoint|webhook|token)\b/i,
  /\b(?:customer|address|estimate)\s*(?:id|record)\b/i,
  /\b(?:cus|adr|est)_[a-z0-9_-]+\b/i,
  /\b(?:tool call|tool result|internal diagnostic|system prompt)\b/i,
  /<\/?(?:think|analysis|tool)[^>]*>/i,
];

export const CUSTOMER_FALLBACK = "I'm sorry — I'm having trouble on my end right now. Please give our office a call at (469) 863-9804 and we'll take care of you from there.";

export function getThumbtackAutomationStatus({
  autoReplyEnabled,
  nativeAutoReplyDisabled,
  hcpWritesEnabled,
} = {}) {
  const outboundEnabled = Boolean(autoReplyEnabled && nativeAutoReplyDisabled);
  return {
    mode: outboundEnabled ? 'outbound-enabled' : 'shadow',
    outboundEnabled,
    hcpWritesEnabled: Boolean(outboundEnabled && hcpWritesEnabled),
    reasons: outboundEnabled
      ? []
      : [
        !autoReplyEnabled && 'THUMBTACK_AUTO_REPLY_ENABLED is not true',
        !nativeAutoReplyDisabled && 'THUMBTACK_NATIVE_AUTO_REPLY_DISABLED is not true',
      ].filter(Boolean),
  };
}

export function sanitizeCustomerMessage(text) {
  const message = String(text || '').trim();
  if (!message || message.length > 1_000 || INTERNAL_LANGUAGE.some((pattern) => pattern.test(message))) {
    return { safe: false, text: CUSTOMER_FALLBACK };
  }
  return { safe: true, text: message };
}

export function canCreateHcpEstimate({ explicitEstimateConsent, customerName, serviceAddress, automation }) {
  return Boolean(
    automation?.outboundEnabled &&
    automation?.hcpWritesEnabled &&
    explicitEstimateConsent === true &&
    String(customerName || '').trim() &&
    String(serviceAddress || '').trim(),
  );
}
