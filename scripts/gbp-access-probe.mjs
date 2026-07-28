/**
 * gbp-access-probe.mjs
 *
 * Read-only diagnostic: is this GCP project approved for Business Profile API access yet?
 * Makes no writes and posts nothing. Run it after Google answers the basic-access
 * application (case 2-5921000040991, filed 2026-07-27).
 *
 *   node scripts/gbp-access-probe.mjs
 *
 * How to read the output:
 *   403 SERVICE_DISABLED     API not enabled in the console for this project.
 *   429 quota_limit=0        Enabled, but the project is NOT approved. Zero quota
 *                            is an allowlist state, not a rate limit — waiting or
 *                            retrying will never clear it.
 *   404 on mybusiness/v4     The legacy host is gated off entirely. localPosts and
 *                            media upload exist ONLY on v4, so posting stays blocked
 *                            until this returns something other than 404.
 *   200                      Approved. See PLANSCOPE.MD "PICK UP HERE" for the flip.
 */
import { getGbpAccessToken } from './lib/gbp-api-auth.mjs';

const token = await getGbpAccessToken();

const ENDPOINTS = [
  ['accountmanagement v1', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts'],
  ['legacy v4 (gated)', 'https://mybusiness.googleapis.com/v4/accounts'],
  ['v4 $discovery', 'https://mybusiness.googleapis.com/$discovery/rest?version=v4'],
  ['businessinformation v1', 'https://mybusinessbusinessinformation.googleapis.com/v1/categories?regionCode=US&languageCode=en&pageSize=1'],
  ['performance v1', 'https://businessprofileperformance.googleapis.com/v1/locations/1:getDailyMetricsTimeSeries?dailyMetric=CALL_CLICKS'],
  ['qanda v1', 'https://mybusinessqanda.googleapis.com/v1/locations/1/questions'],
  ['verifications v1', 'https://mybusinessverifications.googleapis.com/v1/locations/1/verifications'],
];

let v4Alive = false;

for (const [label, url] of ENDPOINTS) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const text = await res.text();
    let reason = '';
    let quota = '';
    let msg = '';
    try {
      const json = JSON.parse(text);
      const err = json.error || {};
      msg = (err.message || '').slice(0, 90);
      const detail = (err.details || [])[0] || {};
      reason = detail.reason || err.status || '';
      quota = detail.metadata?.quota_limit_value ?? '';
    } catch {
      msg = text.trimStart().startsWith('<') ? 'HTML error page (route not served)' : text.slice(0, 90);
    }
    const quotaNote = quota !== '' ? ` quota_limit=${quota}` : '';
    console.log(`${label.padEnd(24)} ${String(res.status).padEnd(4)} ${reason.padEnd(22)}${quotaNote}`);
    if (res.ok) console.log(`${''.padEnd(24)} ^^ 200 OK: ${text.slice(0, 120)}`);
    else if (!reason) console.log(`${''.padEnd(24)} msg: ${msg}`);
    if (label.startsWith('legacy v4') && res.status !== 404) v4Alive = true;
  } catch (err) {
    console.log(`${label.padEnd(24)} ERR  ${String(err.message).slice(0, 70)}`);
  }
}

console.log('\n--- token sanity ---');
try {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const json = await res.json();
  const scopes = (json.scope || '(none)').split(' ');
  console.log('business.manage scope:', scopes.some((s) => s.endsWith('/business.manage')) ? 'yes' : 'NO — re-run scripts/authorize-gbp.mjs');
} catch (err) {
  console.log('tokeninfo err:', err.message.slice(0, 90));
}

console.log(
  v4Alive
    ? '\nVERDICT: v4 is answering — access may be approved. Do a real read before flipping GBP_POSTER=api.'
    : '\nVERDICT: still gated (v4 404s). Leave GBP_POSTER on playwright.',
);
