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

// Core resolver. Env is always primary. The Hermes-owned %LOCALAPPDATA% file is
// read only on win32 and only when env leaves a value unset. Injected `readFile`
// and `platform` make the no-file-read guarantee testable on any host.
export function _resolveSlackConfig(env = process.env, platform = process.platform, readFile = () => ({})) {
  let token = env.SLACK_BOT_TOKEN || '';
  let channel = env.SLACK_ALERT_CHANNEL || '';
  if (platform === 'win32' && (!token || !channel)) {
    const fallback = readFile() || {};
    token = token || fallback.SLACK_BOT_TOKEN || '';
    channel = channel || fallback.SLACK_ALERT_CHANNEL || fallback.SLACK_HOME_CHANNEL || '';
  }
  return { enabled: Boolean(token && channel), token, channel };
}

export function getSlackConfig(env = process.env, hermesEnv = null) {
  // An injected hermesEnv is the fallback source (hermetic tests). Otherwise the
  // real Hermes file is read only for the default process.env on win32. Any other
  // env object gets no file fallback.
  if (hermesEnv) return _resolveSlackConfig(env, 'win32', () => hermesEnv);
  if (env === process.env) return _resolveSlackConfig(env, process.platform, () => readEnvFile(HERMES_ENV_PATH));
  return _resolveSlackConfig(env, 'hermetic', () => ({}));
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
