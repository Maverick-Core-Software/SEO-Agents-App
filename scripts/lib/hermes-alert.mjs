// Push alerts. Transport order for the shared alert path (sendHermesAlert):
//   1. Hermes CLI `hermes send` — when HERMES_CLI resolves to an existing executable
//      (or `hermes` is on PATH). Direct delivery using the gateway's platform credentials
//      in ~/.hermes — no LLM, no agent loop. Primary SEO path: HERMES_ALERT_TO=slack.
//   2. Slack direct chat.postMessage via slack-alert.mjs — when SLACK_BOT_TOKEN and
//      SLACK_ALERT_CHANNEL resolve. The AIWA LXC has no Hermes CLI, so this is its default.
//   3. Gmail SMTP via nodemailer — when SMTP_APP_PASSWORD is set.
// The first hop that delivers wins; each hop is best-effort and never throws. The shared
// path throws only when every configured hop failed, with the reasons joined by '; '.
// The weekly notify receipt (scripts/weekly/lib/notify.mjs) uses deliverPrimary() for hops
// 1-2 and sends SMTP as its own best-effort hop, so its receipt can read `via hermes+smtp`.
// See docs/runbooks/slack-alerts.md for the Block Kit approval path (unchanged).
// Replaces the grizzly-hcp iMessage path, dead since spectrum-ts went away.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getSlackConfig, sendSlackTextAlert } from './slack-alert.mjs';

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

// Fast, never-throwing check that the CLI can be spawned at all. A path (absolute or
// relative) must exist on disk; a bare name must be on PATH. A host without the Hermes
// CLI (the AIWA LXC) is detected here instead of waiting on an execFile failure.
export function hermesCliExists(cli, env = process.env, platform = process.platform, exists = fs.existsSync) {
  try {
    if (cli.includes('/') || cli.includes('\\') || path.isAbsolute(cli)) return Boolean(exists(cli));
    const win = platform === 'win32';
    const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
    const exts = win ? ['', '.exe', '.cmd', '.bat'] : [''];
    const join = win ? path.win32.join : path.posix.join;
    return dirs.some(dir => exts.some(ext => exists(join(dir, cli + ext))));
  } catch {
    return false;
  }
}

// Hops 1-2: Hermes CLI, then Slack direct. Resolves { ok: true, channel: 'hermes' | 'slack' }
// on the first delivery, or { ok: false, reason } with every attempted hop's reason joined
// by '; '. Never throws. `exec`, `exists`, `fetchImpl` and `slackConfig` are injectable seams.
export async function deliverPrimary(message, {
  env = process.env, platform = process.platform, exec = execFileAsync,
  exists = fs.existsSync, fetchImpl, slackConfig,
} = {}) {
  const reasons = [];
  const { cli, args, options } = buildHermesInvocation(message, env, platform);
  if (!hermesCliExists(cli, env, platform, exists)) {
    reasons.push(`hermes: CLI not found (${cli})`);
  } else {
    try {
      await exec(cli, args, options);
      return { ok: true, channel: 'hermes' };
    } catch (e) {
      reasons.push(`hermes: ${e.message || e}`);
    }
  }
  const cfg = slackConfig ?? getSlackConfig(env);
  if (!cfg.enabled) {
    reasons.push('slack: not configured');
  } else if (await sendSlackTextAlert(message, cfg, fetchImpl)) {
    return { ok: true, channel: 'slack' };
  } else {
    reasons.push('slack: chat.postMessage failed');
  }
  return { ok: false, reason: reasons.join('; ') };
}

// Hop 3: Gmail SMTP. Resolves { ok: true } or { ok: false, reason }; never throws.
// Env is read per-call, not at module scope: mav-bridge / supabase-sync populate
// process.env from .env AFTER imports may have been evaluated.
export async function sendSmtpAlert(message, { env = process.env } = {}) {
  const pass = env.SMTP_APP_PASSWORD || '';
  if (!pass) return { ok: false, reason: 'smtp not configured' };
  const from = env.SMTP_FROM || env.SMTP_FROM_EMAIL || 'barnscarter@gmail.com';
  const to = env.SMTP_TO || env.SMTP_TO_EMAIL || 'barnscarter@gmail.com';
  try {
    const { createTransport } = await import('nodemailer');
    const transport = createTransport({ service: 'gmail', auth: { user: from, pass } });
    await transport.sendMail({ from, to, subject: message.split('\n')[0].slice(0, 80), text: message });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `smtp: ${e.message || e}` };
  }
}

// The shared alert path: primary hops, then SMTP as a fallback. Resolves { channel } on
// delivery ('hermes' | 'slack' | 'smtp'); throws only when every configured hop failed.
export async function sendHermesAlertWith(message, { env = process.env, ...seams } = {}) {
  const primary = await deliverPrimary(message, { env, ...seams });
  if (primary.ok) return { channel: primary.channel };
  const mail = await sendSmtpAlert(message, { env });
  if (mail.ok) return { channel: 'smtp' };
  throw new Error([primary.reason, mail.reason].join('; '));
}

export async function sendHermesAlert(message) {
  return sendHermesAlertWith(message);
}
