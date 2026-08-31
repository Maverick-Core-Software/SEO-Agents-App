// scripts/lib/slack-alert.mjs
// Fail-closed Slack delivery (Block Kit) via chat.postMessage. The preferred
// configuration stays inside the local Hermes runtime; the bridge reads only
// the existing bot token and home channel when its own env does not define
// them. No credential is copied into this repository or sent anywhere except
// Slack's API. Absent config = silent no-op, so Hermes CLI + SMTP remain safe
// fallback paths.

import fs from 'node:fs';
import path from 'node:path';

const SLACK_API = 'https://slack.com/api/chat.postMessage';

const HERMES_ENV_PATH = path.join(
  process.env.LOCALAPPDATA || 'C:\\Users\\carte\\AppData\\Local',
  'hermes',
  '.env',
);

function readEnvFile(filePath) {
  try {
    const values = {};
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) values[match[1]] = match[2].trim();
    }
    return values;
  } catch {
    return {};
  }
}

export function getSlackConfig(env = process.env, hermesEnv = null) {
  // Passing an env object is deliberately hermetic for tests/callers. Runtime
  // bridge calls use the default process.env and may read Hermes' local config.
  const fallback = hermesEnv ?? (env === process.env ? readEnvFile(HERMES_ENV_PATH) : {});
  const token = env.SLACK_BOT_TOKEN || fallback.SLACK_BOT_TOKEN || '';
  const channel = env.SLACK_ALERT_CHANNEL || fallback.SLACK_ALERT_CHANNEL || fallback.SLACK_HOME_CHANNEL || '';
  return { enabled: Boolean(token && channel), token, channel };
}

const BUTTON_LABELS = {
  approve: '✅ Approve',
  dismiss: 'Dismiss',
  retry: '↻ Retry',
};

// Block Kit card: one section + one action row. Button action_ids are
// namespaced `seo_<verb>:<actionId>`; the Hermes Socket Mode plugin allowlists
// the verb and validates the id before it calls the loopback bridge.
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
