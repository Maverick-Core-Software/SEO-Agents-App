// Push alerts via the local `hermes send` CLI (Maverick-Homelab gateway). Direct
// delivery using the gateway's platform credentials in ~/.hermes — no LLM, no agent
// loop, and no running gateway needed for bot-token platforms like Slack/SMS.
// Primary SEO compatibility path: HERMES_ALERT_TO=slack (see .env.example).
//
// ONE-WAY COMPATIBILITY PATH: HERMES_ALERT_TO=slack still routes through this CLI
// to Slack's home channel and is unchanged. The optional DIRECT Slack path (Block
// Kit cards with Approve/Dismiss/Retry buttons) lives in slack-alert.mjs + the
// /slack/interactions endpoint in mav-bridge.mjs and is activated by SLACK_BOT_TOKEN
// + SLACK_ALERT_CHANNEL + SLACK_SIGNING_SECRET (see docs/runbooks/slack-alerts.md).
// Replaces the grizzly-hcp iMessage path, dead since spectrum-ts went away.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Env is read per-call, not at module scope: mav-bridge / supabase-sync populate
// process.env from .env AFTER imports may have been evaluated.
export async function sendHermesAlert(message) {
  const cli = process.env.HERMES_CLI
    || 'C:\\Users\\carte\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe';
  // Slack is the no-cost default. An explicit HERMES_ALERT_TO may still select
  // an alternate route for a deliberate fallback.
  const target = process.env.HERMES_ALERT_TO || 'slack';
  await execFileAsync(cli, ['send', '--to', target, '--quiet', message], {
    timeout: 20_000, windowsHide: true,
  });
}
