/**
 * Meta Marketing API helpers for boosting organic Page posts.
 * Pure helpers are unit-tested; network calls are injectable via `fetchImpl`.
 *
 * Money gate stays in fb-boost-ledger.mjs — this module only talks to Graph.
 */

export const DALLAS = { lat: 32.7767, lng: -96.7970, radiusMi: 20 };
export const DEFAULT_AGES = { min: 28, max: 65 };
export const DEFAULT_INTEREST_QUERIES = [
  'home improvement',
  'Do it yourself (DIY)',
  'home renovation',
  'air conditioning',
];
export const EXCLUDE_INTEREST_QUERIES = ['electrician'];

/** Convert whole dollars to Meta account minor units (USD cents). */
export function dollarsToMinor(dollars) {
  const n = Number(dollars);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid dollar amount: ${dollars}`);
  return Math.round(n * 100);
}

/** Normalize act_ prefix on ad account ids. */
export function normalizeAdAccountId(id) {
  if (!id) return '';
  const s = String(id).trim();
  if (!s) return '';
  return s.startsWith('act_') ? s : `act_${s}`;
}

/**
 * object_story_id for an organic page post.
 * Graph published_posts already returns `PAGEID_POSTID`; accept bare post ids too.
 */
export function objectStoryId(pageId, postId) {
  if (!pageId || !postId) throw new Error('pageId and postId required for object_story_id');
  const pid = String(postId);
  if (pid.includes('_')) return pid;
  return `${pageId}_${pid}`;
}

/** Parse ages from BOOST_TARGETING prose, e.g. "homeowners 28–65". */
export function parseAgesFromTargeting(text, fallback = DEFAULT_AGES) {
  if (!text) return { ...fallback };
  const m = String(text).match(/(\d{2})\s*[–\-to]+\s*(\d{2})/);
  if (!m) return { ...fallback };
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min < 13 || max > 65 || min > max) return { ...fallback };
  return { min, max };
}

/** Caption keyword tokens for matching a schedule post to a live Graph post. */
const TOKEN_STOP = new Set([
  'your', 'youre', 'should', 'shouldn', 'would', 'could', 'that', 'this', 'with',
  'from', 'have', 'been', 'were', 'when', 'what', 'they', 'them', 'their', 'then',
  'than', 'into', 'just', 'more', 'also', 'about', 'every', 'time', 'make', 'made',
]);

export function captionMatchTokens(pick, scheduleBlock = '') {
  const raw = [
    pick?.service,
    ...(String(scheduleBlock).match(/\*\*HOOK:\*\*\s*\n([^\n*]+)/i) || []).slice(1),
    ...(String(scheduleBlock).match(/\*\*BODY:\*\*\s*\n([^\n]{0,120})/i) || []).slice(1),
  ].filter(Boolean).join(' ');
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !TOKEN_STOP.has(w))
    .slice(0, 12);
}

/**
 * Score published Graph posts for a schedule pick.
 * Prefer same calendar day (America/Chicago) + caption keyword overlap.
 */
export function scoreLivePosts(posts, { pickDate, tokens = [], pageId }) {
  const scored = [];
  for (const post of posts || []) {
    const created = post.created_time || '';
    const day = centralDateFromIso(created);
    let score = 0;
    if (pickDate && day === pickDate) score += 100;
    else if (pickDate && day) {
      const drift = Math.abs(Date.parse(`${day}T12:00:00Z`) - Date.parse(`${pickDate}T12:00:00Z`)) / 86_400_000;
      if (drift <= 1) score += 40;
      else continue; // wrong week-ish window — skip
    }
    const msg = String(post.message || '').toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      if (msg.includes(t)) hits += 1;
    }
    score += hits * 10;
    // Prefer page-post ids; demote pure photo objects without message
    if (String(post.id || '').startsWith(`${pageId}_`)) score += 5;
    if (msg.includes('(469)') || msg.includes('896-3862')) score -= 20; // first-comment body mixed in? rare
    scored.push({ post, score, day, hits });
  }
  scored.sort((a, b) => b.score - a.score || String(b.post.created_time).localeCompare(String(a.post.created_time)));
  return scored;
}

export function centralDateFromIso(iso) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

export function buildTargeting({
  ages = DEFAULT_AGES,
  lat = DALLAS.lat,
  lng = DALLAS.lng,
  radiusMi = DALLAS.radiusMi,
  interestIds = [],
  excludeInterestIds = [],
} = {}) {
  const targeting = {
    age_min: ages.min,
    age_max: ages.max,
    geo_locations: {
      custom_locations: [{
        latitude: lat,
        longitude: lng,
        radius: radiusMi,
        distance_unit: 'mile',
      }],
    },
    // Facebook + Audience Network is overkill for page boosts; FB + IG feed is enough.
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['feed', 'facebook_reels', 'story'],
    instagram_positions: ['stream', 'reels', 'story'],
    // Advantage+ audience is on by default and caps age_min at 25, which rejects our
    // 28-65 range (subcode 1870188). We want the explicit Dallas/age targeting, so opt out.
    targeting_automation: { advantage_audience: 0 },
  };
  if (interestIds.length) {
    targeting.flexible_spec = [{ interests: interestIds.map((id) => ({ id: String(id) })) }];
  }
  if (excludeInterestIds.length) {
    targeting.exclusions = { interests: excludeInterestIds.map((id) => ({ id: String(id) })) };
  }
  return targeting;
}

// Daily-budget ad sets must run ≥24h (Graph subcode 1487793). Exact 24h from
// `now` fails because start_time is already in the past by the time Meta
// receives the request, so remaining duration drops under the floor.
export const BOOST_START_PAD_MS = 2 * 60_000;
export const MIN_DAILY_BUDGET_DURATION_MS = 25 * 3_600_000;

export function buildBoostPlan({
  week,
  pick,
  pageId,
  postId,
  ages,
  interestIds = [],
  excludeInterestIds = [],
  campaignId = null,
  lat = DALLAS.lat,
  lng = DALLAS.lng,
  radiusMi = DALLAS.radiusMi,
  now = new Date(),
}) {
  const storyId = objectStoryId(pageId, postId);
  const dailyMinor = dollarsToMinor(pick.daily);
  const start = new Date(now.getTime() + BOOST_START_PAD_MS);
  const durationMs = Math.max(Number(pick.days) * 86_400_000, MIN_DAILY_BUDGET_DURATION_MS);
  const end = new Date(start.getTime() + durationMs);
  const nameBase = `SEO ${week} ${pick.key}`.slice(0, 100);
  return {
    nameBase,
    object_story_id: storyId,
    daily_budget_minor: dailyMinor,
    lifetime_estimate_minor: dailyMinor * Number(pick.days),
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    targeting: buildTargeting({ ages, lat, lng, radiusMi, interestIds, excludeInterestIds }),
    reuse_campaign_id: campaignId || null,
    objective: 'OUTCOME_ENGAGEMENT',
    optimization_goal: 'POST_ENGAGEMENT',
    // Conversion location = the post itself. Required: without it Meta cannot infer the
    // conversion location and rejects the ad set either as "performance goal isn't
    // available" (2490408) or "Tracking Pixel Required" (1487888). Matches what the
    // Boost UI sends. Verified against the working 2026-07-22 boost in this account.
    destination_type: 'ON_POST',
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    special_ad_categories: [],
  };
}

export function readBoostConfig(env = process.env) {
  const adAccountId = normalizeAdAccountId(env.FB_AD_ACCOUNT_ID || env.META_AD_ACCOUNT_ID || '');
  const token = env.FB_ADS_ACCESS_TOKEN || env.FB_PAGE_ACCESS_TOKEN || env.FB_ACCESS_TOKEN || '';
  // Page reads (/{page}/published_posts, post lookups) need a Page token; a system-user
  // ads token gets (#210) there. Fall back to `token` for the legacy single-token setup.
  const pageToken = env.FB_PAGE_ACCESS_TOKEN || env.FB_ACCESS_TOKEN || token;
  const pageId = env.FB_PAGE_ID || '';
  const apiVersion = env.FB_GRAPH_API_VERSION || 'v22.0';
  const enabled = String(env.FB_BOOST_API || '').toLowerCase() === '1'
    || String(env.FB_BOOST_API || '').toLowerCase() === 'true';
  const campaignId = env.FB_BOOST_CAMPAIGN_ID || null;
  const lat = Number(env.FB_BOOST_GEO_LAT || DALLAS.lat);
  const lng = Number(env.FB_BOOST_GEO_LNG || DALLAS.lng);
  const radiusMi = Number(env.FB_BOOST_GEO_RADIUS_MI || DALLAS.radiusMi);
  const ageMin = Number(env.FB_BOOST_AGE_MIN || DEFAULT_AGES.min);
  const ageMax = Number(env.FB_BOOST_AGE_MAX || DEFAULT_AGES.max);
  return {
    adAccountId,
    token,
    pageToken,
    pageId,
    apiVersion,
    enabled,
    campaignId,
    lat,
    lng,
    radiusMi,
    defaultAges: { min: ageMin, max: ageMax },
    ready: Boolean(adAccountId && token && pageId),
    missing: [
      !adAccountId && 'FB_AD_ACCOUNT_ID',
      !token && 'FB_ADS_ACCESS_TOKEN|FB_PAGE_ACCESS_TOKEN',
      !pageId && 'FB_PAGE_ID',
    ].filter(Boolean),
  };
}

export function createGraphClient({
  token,
  apiVersion = 'v22.0',
  fetchImpl = globalThis.fetch,
}) {
  if (!token) throw new Error('Graph token required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch not available');

  const base = `https://graph.facebook.com/${apiVersion}`;

  async function graph(method, path, params = {}) {
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    const body = { ...params, access_token: token };
    let res;
    if (method === 'GET') {
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      res = await fetchImpl(url, { method: 'GET' });
    } else {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      res = await fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const msg = json.error?.message || res.statusText || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.graph = json.error || json;
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    graph,
    async listPublishedPosts({ pageId, limit = 15 } = {}) {
      return graph('GET', `/${pageId}/published_posts`, {
        fields: 'id,message,created_time,permalink_url,attachments{media_type,type,target}',
        limit,
      });
    },
    async getObject(id, fields = 'id') {
      return graph('GET', `/${id}`, { fields });
    },
    async searchInterests(query, limit = 5) {
      const data = await graph('GET', '/search', {
        type: 'adinterest',
        q: query,
        limit,
      });
      return data.data || [];
    },
    async createCampaign(adAccountId, fields) {
      return graph('POST', `/${adAccountId}/campaigns`, fields);
    },
    async createAdSet(adAccountId, fields) {
      return graph('POST', `/${adAccountId}/adsets`, fields);
    },
    async createCreative(adAccountId, fields) {
      return graph('POST', `/${adAccountId}/adcreatives`, fields);
    },
    async createAd(adAccountId, fields) {
      return graph('POST', `/${adAccountId}/ads`, fields);
    },
  };
}

/**
 * Resolve interest name → id best-effort. Failures return [] (geo+age still valid).
 */
export async function resolveInterestIds(client, queries, { limitPer = 1 } = {}) {
  const ids = [];
  const seen = new Set();
  for (const q of queries) {
    try {
      const rows = await client.searchInterests(q, 5);
      for (const row of (rows || []).slice(0, limitPer)) {
        if (row?.id && !seen.has(String(row.id))) {
          seen.add(String(row.id));
          ids.push(String(row.id));
        }
      }
    } catch {
      // Interest search needs ads_management; skip quietly.
    }
  }
  return ids;
}

/**
 * Create campaign → ad set → creative → ad for an organic post boost.
 * Returns created ids. Throws on Graph failure (caller fails the ledger).
 */
export async function createOrganicBoost(client, {
  adAccountId,
  pageId,
  plan,
  status = 'ACTIVE',
}) {
  const account = normalizeAdAccountId(adAccountId);
  let campaignId = plan.reuse_campaign_id || null;
  const created = { campaign_id: null, adset_id: null, creative_id: null, ad_id: null };

  if (!campaignId) {
    const campaign = await client.createCampaign(account, {
      name: plan.nameBase,
      objective: plan.objective,
      status: 'ACTIVE',
      special_ad_categories: JSON.stringify(plan.special_ad_categories || []),
      is_adset_budget_sharing_enabled: false,
    });
    campaignId = campaign.id;
    created.campaign_id = campaignId;
  } else {
    created.campaign_id = campaignId;
  }

  const adset = await client.createAdSet(account, {
    name: `${plan.nameBase} adset`,
    campaign_id: campaignId,
    daily_budget: plan.daily_budget_minor,
    billing_event: plan.billing_event,
    optimization_goal: plan.optimization_goal,
    bid_strategy: plan.bid_strategy,
    targeting: JSON.stringify(plan.targeting),
    start_time: plan.start_time,
    end_time: plan.end_time,
    status,
    destination_type: plan.destination_type,
    promoted_object: JSON.stringify({ page_id: pageId }),
  });
  created.adset_id = adset.id;

  const creative = await client.createCreative(account, {
    name: `${plan.nameBase} creative`,
    object_story_id: plan.object_story_id,
  });
  created.creative_id = creative.id;

  const ad = await client.createAd(account, {
    name: `${plan.nameBase} ad`,
    adset_id: adset.id,
    creative: JSON.stringify({ creative_id: creative.id }),
    status,
  });
  created.ad_id = ad.id;
  return created;
}

/**
 * Find the best live post for a boost pick from Graph published_posts.
 * Returns { ok, post_id, post, score, reason }.
 */
export async function resolveLivePost(client, {
  pageId,
  pickDate,
  tokens = [],
  forcePostId = null,
}) {
  if (forcePostId) {
    try {
      const obj = await client.getObject(objectStoryId(pageId, forcePostId), 'id,message,created_time,permalink_url');
      return { ok: true, post_id: obj.id, post: obj, score: 999, reason: 'forced' };
    } catch (e) {
      return { ok: false, reason: `forced post not found: ${e.message}` };
    }
  }
  const listing = await client.listPublishedPosts({ pageId, limit: 20 });
  const scored = scoreLivePosts(listing.data || [], { pickDate, tokens, pageId });
  if (!scored.length || scored[0].score < 40) {
    return {
      ok: false,
      reason: scored.length
        ? `best match score ${scored[0].score} too low for date ${pickDate}`
        : `no published posts near ${pickDate}`,
      candidates: scored.slice(0, 3).map((s) => ({ id: s.post.id, score: s.score, day: s.day })),
    };
  }
  const best = scored[0];
  return {
    ok: true,
    post_id: best.post.id,
    post: best.post,
    score: best.score,
    reason: 'matched',
    candidates: scored.slice(0, 3).map((s) => ({ id: s.post.id, score: s.score, day: s.day })),
  };
}
