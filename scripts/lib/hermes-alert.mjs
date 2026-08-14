// Push alerts via the local `hermes send` CLI (Maverick-Homelab gateway). Direct
// delivery using the gateway's platform credentials in ~/.hermes — no LLM, no agent
// loop, and no running gateway needed for bot-token platforms like Slack/SMS.
// Primary SEO path: HERMES_ALERT_TO=sms:+1… (see .env.example).
// Replaces the grizzly-hcp iMessage path, dead since spectrum-ts went away.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Env is read per-call, not at module scope: mav-bridge / supabase-sync populate
// process.env from .env AFTER imports may have been evaluated.
export async function sendHermesAlert(message) {
  const cli = process.env.HERMES_CLI
    || 'C:\\Users\\carte\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe';
  // Prefer SMS for Carter (MavH Twilio). Override via HERMES_ALERT_TO.
  const target = process.env.HERMES_ALERT_TO || 'sms:+14697169870';
  await execFileAsync(cli, ['send', '--to', target, '--quiet', message], {
    timeout: 20_000, windowsHide: true,
  });
}
