/**
 * gbp-access-probe.mjs
 *
 * Read-only diagnostic: can this project post through the GBP v4 API yet?
 * Makes only GET calls and posts nothing.
 *
 *   node scripts/gbp-access-probe.mjs
 *
 * Gate (the verdict): v1 account list → v1 location list → GET v4
 * {account}/{location}/localPosts?pageSize=1. The same gate the poster and the
 * worker use (probeV4 in gbp-api-poster.mjs). The account/location come from
 * GBP_ACCOUNT_ID / GBP_LOCATION_ID, else the v1 lookup, which picks the location
 * by GBP_LOCATION_TITLE (default "Grizzly Electrical") or the only location.
 *
 * How to read the gate line:
 *   200                      localPosts reachable: API posting possible.
 *   404 HTML                 route not served: v4 is gated for this project.
 *   401 / 403                auth problem (refresh the token), not a gate result.
 *
 * The other checks (business information, performance, Q&A, verifications) are
 * informational only.
 */
import { getGbpAccessToken, gbpFetch } from './lib/gbp-api-auth.mjs';
import { resolveGbpLocation } from './lib/gbp-location.mjs';
import { probeV4 } from './gbp-api-poster.mjs';

const INFO_ENDPOINTS = [
  ['businessinformation v1', 'https://mybusinessbusinessinformation.googleapis.com/v1/categories?regionCode=US&languageCode=en&pageSize=1'],
  ['performance v1', 'https://businessprofileperformance.googleapis.com/v1/locations/1:getDailyMetricsTimeSeries?dailyMetric=CALL_CLICKS'],
  ['qanda v1', 'https://mybusinessqanda.googleapis.com/v1/locations/1/questions'],
  ['verifications v1', 'https://mybusinessverifications.googleapis.com/v1/locations/1/verifications'],
];

const row = (label, status, note = '') => console.log(`${label.padEnd(26)} ${String(status).padEnd(5)} ${note}`);

/** Status and first-line message of a failed gbpFetch (the body is never printed). */
function failure(e) {
  const status = e && e.status ? e.status : 'ERR';
  const html = String(e?.body ?? '').trimStart().startsWith('<');
  return { status, note: html ? 'HTML error page (route not served)' : String(e?.message || e).slice(0, 110) };
}

let resolved = null;
try {
  resolved = await resolveGbpLocation({ gbpFetch, env: process.env });
  row('v1 accounts + locations', 200, `account ${resolved.accountName}`);
  row('location', '', `${resolved.locationName}${resolved.title ? ` "${resolved.title}"` : ''}`);
} catch (e) {
  const f = failure(e);
  row('v1 accounts + locations', f.status, f.note);
}

let verdict;
if (!resolved) {
  verdict = '\nVERDICT: not determined — account/location lookup failed (see above). Fix GBP_ACCOUNT_ID / GBP_LOCATION_ID or the v1 access, then re-run.';
} else {
  const gate = await probeV4({ gbpFetch, env: process.env, locationName: resolved.locationName });
  if (gate.ok) {
    row('v4 localPosts (gate)', 200, `count=${gate.count}${gate.totalSize != null ? ` totalSize=${gate.totalSize}` : ''}`);
    verdict = '\nVERDICT: v4 localPosts reachable — API posting possible';
  } else {
    const note = gate.gated ? 'HTML 404: route not served' : gate.bodyKind === 'html' ? 'HTML error page' : String(gate.error || '').slice(0, 110);
    row('v4 localPosts (gate)', gate.status ?? 'ERR', note);
    verdict = gate.gated
      ? '\nVERDICT: gated'
      : `\nVERDICT: not determined — v4 localPosts returned ${gate.status ?? 'no status'} (${gate.auth ? 'auth, refresh the token' : 'not a 200 and not the gate'}).`;
  }
}

for (const [label, url] of INFO_ENDPOINTS) {
  try {
    const token = await getGbpAccessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const text = await res.text();
    const html = text.trimStart().startsWith('<');
    row(label, res.status, html ? 'HTML error page' : (res.ok ? '' : text.slice(0, 90).replace(/\s+/g, ' ')));
  } catch (e) {
    row(label, 'ERR', String(e.message).slice(0, 90));
  }
}

console.log('\n--- token sanity ---');
try {
  const token = await getGbpAccessToken();
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const json = await res.json();
  const scopes = (json.scope || '(none)').split(' ');
  console.log('business.manage scope:', scopes.some((s) => s.endsWith('/business.manage')) ? 'yes' : 'NO — re-run scripts/authorize-gbp.mjs');
} catch (err) {
  console.log('tokeninfo err:', err.message.slice(0, 90));
}

console.log(verdict);
process.exitCode = verdict.includes('reachable') ? 0 : 1;
