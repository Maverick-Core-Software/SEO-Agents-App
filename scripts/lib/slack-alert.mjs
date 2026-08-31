// scripts/lib/slack-alert.mjs
// Fail-closed direct Slack delivery (Block Kit) via chat.postMessage. Optional
// ADDITIVE channel on top of the hermes path: only active when SLACK_BOT_TOKEN
// and SLACK_ALERT_CHANNEL are configured. Absent config = silent no-op, so all
// existing alerting behavior (hermes SMS + SMTP) is preserved untouched.

const SLACK_API = 'https://slack.com/api/chat.postMessage';

export function getSlackConfig(env = process.env) {
  const token = env.SLACK_BOT_TOKEN || '';
  const channel = env.SLACK_ALERT_CHANNEL || '';
  return { enabled: Boolean(token && channel), token, channel };
}

const BUTTON_LABELS = {
  approve: '✅ Approve',
  dismiss: 'Dismiss',
  retry: '↻ Retry',
};

// Block Kit card: one section + one action row. Button action_ids are
// namespaced `seo_<verb>:<actionId>`; the interaction endpoint allowlists the
// verb and validates the id (see slack-interactions.mjs).
export function approvalBlocks({ title, detail, actionId, buttons = [] }) {
  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: detail ? `*${title}*\n${detail}` : `*${title}*` },
  }];
  if (buttons.length && actionId) {
    blocks.push({
      type: 'actions',
      elements: buttons.map(verb => ({
        type: 'button',
        text: { type: 'plain_text', text: BUTTON_LABELS[verb] || verb },
        action_id: `seo_${verb}:${actionId}`,
        value: actionId,
      })),
    });
  }
  return blocks;
}

// Post blocks to the configured channel. Never throws — alerting must not break
// the poll loop; failures are logged and reported as false.
export async function sendSlackBlocks({ blocks, text, config, fetchImpl = fetch }) {
  if (!config?.enabled) return false;
  try {
    const res = await fetchImpl(SLACK_API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channel: config.channel, blocks, text: text || '' }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[slack-alert] chat.postMessage failed: ${json.error}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[slack-alert] send failed: ${e.message}`);
    return false;
  }
}

// Plain text alert (no buttons) — the direct-Slack analogue of the hermes path.
export async function sendSlackTextAlert(message, config, fetchImpl = fetch) {
  return sendSlackBlocks({
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }],
    text: message, config, fetchImpl,
  });
}
