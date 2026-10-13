// Push alerts via the local `hermes send` CLI (Maverick-Homelab gateway). Direct
// delivery using the gateway's platform credentials in ~/.hermes — no LLM, no agent
// loop, and no running gateway needed for bot-token platforms like Slack/SMS.
// Primary SEO compatibility path: HERMES_ALERT_TO=slack (see .env.example).
//
// ONE-WAY COMPATIBILITY PATH: HERMES_ALERT_TO=slack still routes through this CLI
// to Slack's home channel and is unchanged. Block Kit approvals use the existing
// Hermes Slack credentials for delivery and Hermes Socket Mode for clicks; see
// docs/runbooks/slack-alerts.md.
// Replaces the grizzly-hcp iMessage path, dead since spectrum-ts went away.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const WIN32_DEFAULT_CLI = 'C:\\Users\\carte\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe';

// HERMES_CLI is the primary override: an absolute path, any file name. The
// platform default is the Windows venv on win32 and `hermes` on PATH elsewhere.
export function resolveHermesCli(env = process.env, platform = process.platform) {
  return env.HERMES_CLI || (platform === 'win32' ? WIN32_DEFAULT_CLI : 'hermes');
}

// Pure builder for the CLI invocation so the platform rules are testable without
// spawning anything. Returns { cli, args, options }.
export function buildHermesInvocation(message, env = process.env, platform = process.platform) {
  const cli = resolveHermesCli(env, platform);
  // Slack is the no-cost default. An explicit HERMES_ALERT_TO may still select
  // an alternate route for a deliberate fallback.
  const target = env.HERMES_ALERT_TO || 'slack';
  const options = { timeout: 20_000, env: { ...env } };
  if (platform === 'win32') {
    // The venv's editable-install finder has failed under pm2/session-0 with
    // "No module named 'hermes_cli'" while working interactively; put the source
    // root on PYTHONPATH so the import does not depend on that finder. Windows only:
    // the root is derived from the Windows venv layout (<root>\venv\Scripts\hermes.exe).
    const root = path.win32.resolve(path.win32.dirname(cli), '..', '..');
    options.env.PYTHONPATH = [root, env.PYTHONPATH].filter(Boolean).join(path.win32.delimiter);
    options.windowsHide = true;
  }
  return { cli, args: ['send', '--to', target, '--quiet', message], options };
}

// Injectable seam: `exec` defaults to execFile. Resolves undefined on success and
// rejects with the execFile error on failure (the notify.mjs receipt depends on that).
export async function sendHermesAlertWith(message, { env = process.env, platform = process.platform, exec = execFileAsync } = {}) {
  const { cli, args, options } = buildHermesInvocation(message, env, platform);
  await exec(cli, args, options);
}

// Env is read per-call, not at module scope: mav-bridge / supabase-sync populate
// process.env from .env AFTER imports may have been evaluated.
export async function sendHermesAlert(message) {
  return sendHermesAlertWith(message);
}
