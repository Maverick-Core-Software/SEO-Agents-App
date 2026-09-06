/**
 * search-console.mjs
 * Pure helpers for the read-only Google Search Console probe. No I/O here —
 * callers pass in token files, site lists, API rows, dates.
 *
 * The Search Console token is minted by scripts/authorize-search-console.mjs
 * and reuses the same hermes OAuth client (and therefore the same
 * gbp-api-auth.mjs refresh machinery) as the GBP token — only the scope and
 * token file differ.
 */

export const SEARCH_CONSOLE_TOKEN_FILE_DEFAULT =
  'C:/Users/carte/gmail-multi/tokens/grizzly-search-console.json';

const GRIZZLY_SITE_PREFERENCES = [
  'sc-domain:grizzlyelectricaltx.com',
  'https://www.grizzlyelectricaltx.com/',
  'https://grizzlyelectricaltx.com/',
];

// Map a probe failure to one actionable human sentence. err is either the
// gbp-api-auth missing-token Error or a gbpFetch Error with .status/.body.
export function explainSearchConsoleError(err) {
  const status = err && err.status;
  const text = String((err && (err.body || err.message)) || err);
  if (!status && /token file not found/i.test(text)) {
    return 'run node scripts/authorize-search-console.mjs';
  }
  if (status === 401) {
    return 'token rejected; re-run authorize';
  }
  if (status === 404) {
    return 'property not found for this account';
  }
  if (status === 403) {
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(text)) {
      return 'enable the Google Search Console API in project exalted-slice-502415-s0';
    }
    if (/insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
      return 'token lacks webmasters.readonly; re-run authorize';
    }
    return 'this Google account is not a user on the Search Console property; add it under Settings > Users and permissions';
  }
  return err && err.message ? err.message : String(err);
}

// From GET https://www.googleapis.com/webmasters/v3/sites (siteEntry array),
// pick the Grizzly property by exact siteUrl, in preference order.
export function pickGrizzlyProperty(sites) {
  const byUrl = new Map((sites || []).map((s) => [s.siteUrl, s]));
  for (const pref of GRIZZLY_SITE_PREFERENCES) {
    const hit = byUrl.get(pref);
    if (hit) return { siteUrl: hit.siteUrl, permissionLevel: hit.permissionLevel };
  }
  return null;
}

// Search Console data lags ~2 days, so the range ends 2 days before `now`.
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dateRange(days, now = new Date()) {
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() - 2);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (days - 1));
  return { startDate: toISODate(startDate), endDate: toISODate(endDate) };
}

// searchAnalytics query rows carry keys/clicks/impressions/ctr/position;
// ctr is a 0..1 fraction. Flatten to display rows, best first.
export function formatQueryRows(rows) {
  return [...(rows || [])]
    .map((r) => ({
      query: r.keys && r.keys.length ? r.keys[0] : r.query,
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: `${((r.ctr ?? 0) * 100).toFixed(1)}%`,
      position: (r.position ?? 0).toFixed(1),
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}
