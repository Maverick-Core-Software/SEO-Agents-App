import { sendHermesAlert } from '../hermes-alert.mjs';
import { getSlackConfig, sendSlackTextAlert } from '../slack-alert.mjs';

const OPS_SMS_MAX_CHARS = 320;

async function sendOpsSms(body, { fetchImpl = fetch } = {}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const from = process.env.OPS_SMS_FROM || process.env.TWILIO_PHONE_NUMBER || '';
  const to = process.env.OPS_SMS_TO || '';
  if (!accountSid || !authToken || !from || !to) return { sent: false, reason: 'not-configured' };
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: String(body || '').slice(0, OPS_SMS_MAX_CHARS),
    }),
  });
  if (!response.ok) throw new Error(`Twilio SMS failed (HTTP ${response.status})`);
  return { sent: true };
}

// Slack first (SEO's existing ops path). Hermes CLI is the compatibility
// fallback. Twilio 1546 is last-resort only if both Slack paths no-op.
export async function notifyThumbtackOps(message) {
  const slack = getSlackConfig();
  if (slack.enabled) {
    const posted = await sendSlackTextAlert(`Thumbtack: ${message}`, slack);
    if (posted) return { sent: true, channel: 'slack' };
  }
  try {
    await sendHermesAlert(`Thumbtack: ${message}`);
    return { sent: true, channel: 'hermes' };
  } catch {
    const sms = await sendOpsSms(message);
    return { ...sms, channel: sms.sent ? 'twilio' : 'none' };
  }
}
