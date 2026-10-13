/**
 * gbp-location.mjs
 * Shared GBP account/location resolution and the v4 localPosts gate predicate.
 * Used by gbp-api-poster.mjs (posting + probeV4), gbp-worker.mjs (startup probe)
 * and gbp-access-probe.mjs (read-only diagnostic). Every network call goes
 * through the injected gbpFetch so tests never reach Google.
 *
 * Resolution order (env first, v1 lookup as the fallback):
 *   account:  GBP_ACCOUNT_ID (numeric id or accounts/{id}); else the first account
 *             from the v1 account-management list.
 *   location: GBP_LOCATION_ID (numeric id, locations/{id} or the full
 *             accounts/{a}/locations/{l}); else the v1 locations list under the
 *             account, picked by GBP_LOCATION_TITLE (case-insensitive substring,
 *             default "Grizzly Electrical"); else the only location. Several
 *             locations with no title match is an error, never a guess.
 *
 * Only v1 endpoints are used for lookups. The v4 /accounts and /locations/{id}
 * routes were removed by Google (2026-10-13 probe); only v4 localPosts, media and
 * reviews remain.
 */

export const V1_ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
export const V1_BUSINESS_INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
export const DEFAULT_LOCATION_TITLE = 'Grizzly Electrical';
const LOCATIONS_MAX_PAGES = 20;

const FULL_LOCATION = /^accounts\/[^/]+\/locations\/[^/]+$/;

/** `accounts/{id}` from a numeric id or a resource name; '' when unset. */
export function accountResourceName(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^accounts\/[^/]+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return `accounts/${v}`;
  throw new Error('GBP_ACCOUNT_ID must be a numeric id or accounts/{id}');
}

/** The last path segment of a location value (`accounts/a/locations/l`, `locations/l`, or `l`). */
export function locationIdSegment(value) {
  return String(value || '').trim().split('/').pop();
}

/** `accounts/{a}/locations/{l}` for a numeric id, `locations/{l}` or the full name. */
export function locationResourceName(value, accountName) {
  const v = String(value || '').trim();
  if (FULL_LOCATION.test(v)) return v;
  if (/^locations\/[^/]+$/.test(v)) return `${accountName}/${v}`;
  if (/^\d+$/.test(v)) return `${accountName}/locations/${v}`;
  throw new Error('GBP_LOCATION_ID must be a numeric id, locations/{id} or accounts/{a}/locations/{l}');
}

/**
 * PURE: pick one location. Explicit id wins; else the single title match; else
 * the only location. Several title matches, or several locations with no match,
 * throw (the caller must set GBP_LOCATION_ID rather than post to a guess).
 */
export function pickLocation(locations = [], { id = '', title = DEFAULT_LOCATION_TITLE } = {}) {
  if (!locations.length) throw new Error('No GBP locations listed for this account.');
  if (id) {
    const want = locationIdSegment(id);
    const hit = locations.find((l) => locationIdSegment(l.name) === want);
    if (!hit) throw new Error(`GBP_LOCATION_ID ${want} is not among the ${locations.length} listed locations`);
    return hit;
  }
  const wanted = String(title || DEFAULT_LOCATION_TITLE).toLowerCase();
  const matches = locations.filter((l) => String(l.title || '').toLowerCase().includes(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`${matches.length} locations match title "${title}"; set GBP_LOCATION_ID`);
  if (locations.length === 1) return locations[0];
  throw new Error(`${locations.length} locations and none match title "${title}"; set GBP_LOCATION_ID`);
}

/**
 * Resolve { accountName, locationName } for the configured account and location.
 * Makes no v4 call. With both env ids set it makes no lookup at all.
 */
export async function resolveGbpLocation({ gbpFetch, env = process.env } = {}) {
  let accountName = accountResourceName(env.GBP_ACCOUNT_ID);
  const locId = String(env.GBP_LOCATION_ID || '').trim();
  if (FULL_LOCATION.test(locId)) {
    const fromId = locId.split('/locations/')[0];
    if (accountName && accountName !== fromId) throw new Error('GBP_ACCOUNT_ID does not match the account in GBP_LOCATION_ID');
    return { accountName: fromId, locationName: locId };
  }
  if (accountName && locId) {
    return { accountName, locationName: locationResourceName(locId, accountName) };
  }
  if (!accountName) {
    const acct = await gbpFetch(V1_ACCOUNTS_URL);
    if (!acct.accounts?.length) throw new Error('No GBP accounts found for this token.');
    accountName = accountResourceName(acct.accounts[0].name);
  }
  const locations = [];
  let pageToken = '';
  for (let page = 0; page < LOCATIONS_MAX_PAGES; page++) {
    const url = `${V1_BUSINESS_INFO}/${accountName}/locations?readMask=name,title${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await gbpFetch(url);
    locations.push(...(res.locations || []));
    pageToken = res.nextPageToken || '';
    if (!pageToken) break;
  }
  const picked = pickLocation(locations, { id: locId, title: env.GBP_LOCATION_TITLE || DEFAULT_LOCATION_TITLE });
  return {
    accountName,
    locationName: locationResourceName(picked.name, accountName),
    title: picked.title || null,
  };
}

/**
 * PURE: is this error the v4 "route not served" gate? Google answers the gated
 * legacy host with an HTML 404 page. A JSON 404 names a missing resource (wrong
 * location id) and is an error, not the gate. An empty body is treated as gated.
 */
export function isV4RouteGated(e) {
  if (!e || Number(e.status) !== 404) return false;
  const body = String(e.body ?? '').trimStart();
  return body === '' || body.startsWith('<');
}
