// scripts/lib/slack-interactions.mjs
// Signed Slack interactive-button entry point. Verifies the HMAC v0 signature
// over the RAW body, enforces a replay window, allowlists action verbs, and
// dispatches to the shared action implementations (slack-actions.mjs) — the
// same ones the MCC HTTP routes use. Fail closed: bad/missing signature, stale
// timestamp, unknown action, or malformed payload => error status, no DB touch.
import { verifySlackSignature } from './slack-verify.mjs';
import { approveAction, dismissAction, retryAction } from './slack-actions.mjs';

// Allowlist: verb -> shared mutation. Anything else is rejected before dispatch.
export const SLACK_BUTTON_VERBS = { approve: approveAction, dismiss: dismissAction, retry: retryAction };

// Slack interactive payloads arrive as form-encoded `payload=<urlencoded JSON>`.
export function parseSlackPayload(rawBody, contentType = '') {
  if (!rawBody) return null;
  if (contentType.includes('application/json')) {
    try { return JSON.parse(rawBody); } catch { return null; }
  }
  const m = String(rawBody).match(/^payload=([\s\S]*)$/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

// action_id is `seo_<verb>:<id>`; the id must be UUID-shaped so it can never
// smuggle a query fragment into the shared action ops.
export function parseActionRef(actionId) {
  const m = /^seo_(approve|dismiss|retry):([0-9a-fA-F-]{8,64})$/.exec(actionId || '');
  if (!m) return null;
  return { verb: m[1], id: m[2] };
}

export function isAllowedInteraction(payload) {
  return Boolean(payload && payload.type === 'block_actions' && Array.isArray(payload.actions) && payload.actions.length);
}

function outcomeText(verb, outcome) {
  if (outcome.message) return outcome.message;
  const label = { approve: 'Approved', dismiss: 'Dismissed', retry: 'Re-queued' }[verb] || verb;
  const id = String(outcome.id || '').slice(0, 8);
  return `✅ ${label} ${outcome.type || 'action'}${id ? ` ${id}` : ''}.`;
}

/**
 * Verify + dispatch one Slack interaction. Returns { status, body } where body
 * is the JSON Slack renders as the message replacement.
 * The legacy `token` field in the payload is deliberately ignored — only the
 * HMAC signature is trusted for authentication.
 */
export async function handleSlackInteraction({
  rawBody, contentType = '', headers = {},
  supabase, alertStore, config, nowMs = Date.now(),
}) {
  const sig = headers['x-slack-signature'];
  const ts = headers['x-slack-request-timestamp'];
  if (!verifySlackSignature({
    signature: sig, timestamp: ts, body: rawBody,
    secret: config?.signingSecret, nowMs,
  })) {
    return { status: 401, body: { text: 'Invalid or stale signature.' } };
  }

  const payload = parseSlackPayload(rawBody, contentType);
  if (!isAllowedInteraction(payload)) {
    return { status: 400, body: { text: 'Unsupported payload.' } };
  }

  const ref = parseActionRef(payload.actions[0].action_id);
  if (!ref) {
    return { status: 400, body: { text: 'Unknown action.' } };
  }

  let outcome;
  try {
    outcome = await SLACK_BUTTON_VERBS[ref.verb]({ supabase, alertStore, actionId: ref.id });
  } catch (e) {
    console.error(`[slack-interactions] ${ref.verb} ${ref.id} failed: ${e.message}`);
    return { status: 500, body: { text: 'Action failed — see bridge logs.' } };
  }
  if (outcome.notFound) {
    return { status: 404, body: { text: 'Action not found or no longer in a valid state.' } };
  }
  return { status: 200, body: { text: outcomeText(ref.verb, outcome) } };
}
