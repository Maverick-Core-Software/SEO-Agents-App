import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObservationSchema, parseOrIssues } from '../lib/schemas.mjs';
import { summarizePost } from '../../lib/facebook-insights.mjs';
import {
  collectFacebook,
  excerpt,
  inWindow,
  postToObservation,
  scrubSecrets,
  windowFor,
} from '../lib/collectors/facebook.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'collect-1-facebook.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'weekly-policy.json'), 'utf8'));

const NOW = new Date('2026-09-04T15:00:00Z');
const ATTEMPT = 'attempt-test-0002';
const [RAW_A, RAW_B, RAW_C] = fixture.feed.data;

/** Flatten the fixture's per-metric insight payloads into summarizePost() input. */
function insightArray(postId, extra = []) {
  const entries = [];
  for (const [metric, payload] of Object.entries(fixture.insights[postId])) {
    if (Array.isArray(payload)) entries.push(...payload);
    else entries.push({ name: metric, values: [], unavailable: payload.error.message });
  }
  return [...entries, ...extra];
}

const EXTRA_A = [
  { name: 'post_impressions', period: 'lifetime', values: [{ value: 900 }] },
  { name: 'post_impressions_unique', period: 'lifetime', values: [{ value: 700 }] },
  { name: 'post_engaged_users', period: 'lifetime', values: [{ value: 50 }] },
];

const POST_A = summarizePost(RAW_A, insightArray(RAW_A.id, EXTRA_A));
const POST_B = summarizePost(RAW_B, insightArray(RAW_B.id));
const POST_C = summarizePost(RAW_C, insightArray(RAW_C.id));

function fakeClient(posts, { topPosts } = {}) {
  const calls = [];
  const refuse = (name) => async () => { throw new Error(`${name} must not be called by the collector`); };
  return {
    calls,
    topPosts: topPosts || (async (opts) => { calls.push(['topPosts', opts]); return { sampled_posts: posts.length, posts }; }),
    pageOverview: refuse('pageOverview'),
    postPerformance: refuse('postPerformance'),
    recentComments: refuse('recentComments'),
    inbox: refuse('inbox'),
  };
}

function assertValidObservation(obs) {
  const { issues } = parseOrIssues(ObservationSchema, obs);
  assert.deepEqual(issues, [], `observation ${obs.id} failed schema: ${JSON.stringify(issues)}`);
}

describe('collectFacebook (injected client)', () => {
  it('emits one schema-valid ok observation per post inside the window, newest first', async () => {
    const client = fakeClient([POST_B, POST_A, POST_C]); // client order is by interactions, not date
    const observations = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client, policy });

    assert.deepEqual(client.calls, [['topPosts', { limit: 25 }]]);
    assert.deepEqual(observations.map((o) => o.scope), [RAW_A.id, RAW_B.id], 'July post is outside 28 days');
    for (const obs of observations) {
      assertValidObservation(obs);
      assert.equal(obs.id, `fb:${obs.scope}`);
      assert.equal(obs.attempt_id, ATTEMPT);
      assert.equal(obs.source, 'facebook');
      assert.equal(obs.status, 'ok');
      assert.equal(obs.metric, 'post_engagement');
      assert.equal(obs.retrieved_at, NOW.toISOString());
      assert.deepEqual(obs.period, { start: '2026-08-07', end: '2026-09-04' });
    }
  });

  it('maps insights to the contract value and reports missing metrics as null, never zero', async () => {
    const observations = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([POST_A, POST_B]), policy });
    const [a, b] = observations;

    assert.deepEqual(a.value, {
      impressions: 900,
      reach: 700,
      engaged: 50,
      reactions: 12,
      comments: 3,
      shares: 2,
      clicks: 8,
      media_views: 120,
      interactions: 25,
      media_type: 'photo',
      created_time: '2026-09-01T14:05:00+0000',
      permalink_url: 'https://www.facebook.com/123456789/posts/1001',
      message_excerpt: a.value.message_excerpt,
    });
    assert.equal(a.raw_ref, 'https://www.facebook.com/123456789/posts/1001');
    assert.equal(a.note, null);

    assert.equal(b.value.impressions, null);
    assert.equal(b.value.reach, null);
    assert.equal(b.value.engaged, null);
    assert.equal(b.value.reactions, 4);
    assert.equal(b.value.comments, 1);
    assert.equal(b.value.shares, 0);
    assert.equal(b.value.media_views, 0);
    assert.equal(b.value.media_type, 'video');
    assert.equal(b.note, 'unavailable metrics: post_media_view', 'note names the metric, not the API error text');
    assert.equal(b.note.includes('not a valid insights metric'), false);
  });

  it('excerpts the message: whitespace collapsed, capped at 160 chars with an ellipsis', async () => {
    const [a, b] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([POST_A, POST_B]), policy });
    assert.ok(a.value.message_excerpt.length <= 160);
    assert.ok(a.value.message_excerpt.endsWith('…'));
    assert.equal(a.value.message_excerpt.includes('   '), false);
    assert.ok(a.value.message_excerpt.startsWith('Rockwall homeowners: is your breaker panel humming, buzzing, or warm to the touch? That sound'));
    assert.equal(b.value.message_excerpt, RAW_B.message);
  });

  it('tags geography from the post message using policy cities', async () => {
    const [a, b] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([POST_A, POST_B]), policy });
    assert.equal(a.geography, 'Rockwall');
    assert.equal(b.geography, null);

    const custom = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([POST_A]), policy: { cities: ['Gotham'] } });
    assert.equal(custom[0].geography, null);
  });

  it('reads config/weekly-policy.json when no policy is injected', async () => {
    const [a] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([POST_A]) });
    assert.equal(a.geography, 'Rockwall');
  });

  it('honours a custom days window and includes a post exactly on the boundary', async () => {
    const seven = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([POST_A, POST_B]), policy, days: 7 });
    assert.deepEqual(seven.map((o) => o.scope), [RAW_A.id]);
    assert.deepEqual(seven[0].period, { start: '2026-08-28', end: '2026-09-04' });

    const boundary = { ...POST_B, id: 'boundary', created_time: '2026-08-07T15:00:00+0000' };
    const justBefore = { ...POST_B, id: 'before', created_time: '2026-08-07T14:59:59+0000' };
    const undated = { ...POST_B, id: 'undated', created_time: null };
    const observations = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([boundary, justBefore, undated]), policy });
    assert.deepEqual(observations.map((o) => o.scope), ['boundary']);
  });

  it('returns an empty array (not unavailable) when the page has no posts in the window', async () => {
    assert.deepEqual(await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([POST_C]), policy }), []);
    assert.deepEqual(await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: fakeClient([]), policy }), []);
    const odd = fakeClient([], { topPosts: async () => ({}) });
    assert.deepEqual(await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: odd, policy }), []);
  });

  it('turns a client failure into one unavailable observation with the token scrubbed from the note', async () => {
    const token = 'EAAB-unit-test-page-token-1234567890';
    const client = fakeClient([], {
      topPosts: async () => {
        throw new Error(`Meta Graph API request to /123456789/posts failed (#190): Invalid OAuth access token (url https://graph.facebook.com/v22.0/123456789/posts?limit=25&access_token=${token})`);
      },
    });
    const observations = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client, policy, env: { FB_PAGE_ACCESS_TOKEN: token } });
    assert.equal(observations.length, 1);
    assertValidObservation(observations[0]);
    assert.equal(observations[0].status, 'unavailable');
    assert.equal(observations[0].scope, 'page');
    assert.equal(observations[0].value, null);
    assert.deepEqual(observations[0].period, { start: '2026-08-07', end: '2026-09-04' });
    assert.match(observations[0].note, /Invalid OAuth access token/);
    assert.equal(observations[0].note.includes(token), false);
    assert.match(observations[0].note, /access_token=\[redacted\]/);
  });

  it('handles non-Error throws and a hung client (timeout)', async () => {
    const thrower = fakeClient([], { topPosts: async () => { throw 'boom'; } });
    const [notError] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: thrower, policy });
    assert.equal(notError.status, 'unavailable');
    assert.equal(notError.note, 'boom');

    const hung = fakeClient([], { topPosts: () => new Promise(() => {}) });
    const [timedOut] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, client: hung, policy, timeoutMs: 20 });
    assert.equal(timedOut.status, 'unavailable');
    assert.match(timedOut.note, /timed out after 20 ms/);
  });

  it('accepts an ISO string for now', async () => {
    const [a] = await collectFacebook({ attemptId: ATTEMPT, now: NOW.toISOString(), client: fakeClient([POST_A]), policy });
    assert.equal(a.retrieved_at, NOW.toISOString());
  });
});

describe('collectFacebook (shared client built from env, injected fetchImpl)', () => {
  const TOKEN = 'unit-test-fb-token-abcdefghij';
  const env = { FB_PAGE_ID: fixture.page_id, FB_PAGE_ACCESS_TOKEN: TOKEN };

  function graphResponse(payload, ok = true) {
    return { ok, status: ok ? 200 : 400, statusText: ok ? 'OK' : 'Bad Request', json: async () => payload };
  }

  function fakeGraphFetch() {
    const calls = [];
    const fn = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const [, , node, edge] = url.pathname.split('/');
      if (node === fixture.page_id && edge === 'posts') return graphResponse(fixture.feed);
      if (edge === 'insights') {
        const payload = fixture.insights[node] && fixture.insights[node][url.searchParams.get('metric')];
        if (!payload) return graphResponse({ error: { code: 100, message: 'unknown metric' } }, false);
        return Array.isArray(payload) ? graphResponse({ data: payload }) : graphResponse(payload, false);
      }
      return graphResponse({ error: { code: 803, message: `unexpected node ${url.pathname}` } }, false);
    };
    fn.calls = calls;
    return fn;
  }

  it('creates the client from env, reads the feed and insights through fetchImpl, and never leaks the token', async () => {
    const fetchImpl = fakeGraphFetch();
    const observations = await collectFacebook({ attemptId: ATTEMPT, now: NOW, env, fetchImpl, policy });

    assert.deepEqual(observations.map((o) => o.scope), [RAW_A.id, RAW_B.id]);
    observations.forEach(assertValidObservation);
    const feedCall = fetchImpl.calls[0];
    assert.equal(feedCall.pathname, `/v22.0/${fixture.page_id}/posts`);
    assert.equal(feedCall.searchParams.get('limit'), '25');
    assert.ok(fetchImpl.calls.every((u) => u.searchParams.get('access_token') === TOKEN), 'the page token is what reaches the Graph API');
    assert.equal(fetchImpl.calls.length, 1 + 3 * 4, 'one feed call plus four lifetime metrics per post');

    const [a, b] = observations;
    assert.equal(a.value.reactions, 12);
    assert.equal(a.value.clicks, 8);
    assert.equal(a.value.impressions, null, 'the shared client does not request post_impressions');
    assert.equal(b.note, 'unavailable metrics: post_media_view');
    assert.equal(JSON.stringify(observations).includes(TOKEN), false);
  });

  it('respects FB_GRAPH_API_VERSION and the FB_ACCESS_TOKEN fallback', async () => {
    const fetchImpl = fakeGraphFetch();
    await collectFacebook({
      attemptId: ATTEMPT, now: NOW, fetchImpl, policy,
      env: { FB_PAGE_ID: fixture.page_id, FB_ACCESS_TOKEN: TOKEN, FB_GRAPH_API_VERSION: 'v22.0' },
    });
    assert.equal(fetchImpl.calls[0].pathname, `/v22.0/${fixture.page_id}/posts`);
    assert.equal(fetchImpl.calls[0].searchParams.get('access_token'), TOKEN);
  });

  it('reports missing credentials as unavailable without touching fetch', async () => {
    const fetchImpl = async () => { throw new Error('fetch must not be called'); };
    const [noPage] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, env: {}, fetchImpl, policy });
    assert.equal(noPage.status, 'unavailable');
    assert.match(noPage.note, /FB_PAGE_ID is not set/);

    const [noToken] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, env: { FB_PAGE_ID: '1' }, fetchImpl, policy });
    assert.equal(noToken.status, 'unavailable');
    assert.match(noToken.note, /FB_PAGE_ACCESS_TOKEN is not set/);
  });

  it('surfaces a Graph API error on the feed as unavailable with the token scrubbed', async () => {
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      return graphResponse({ error: { code: 190, message: `Error validating access token for ${url.search}` } }, false);
    };
    const [obs] = await collectFacebook({ attemptId: ATTEMPT, now: NOW, env, fetchImpl, policy });
    assert.equal(obs.status, 'unavailable');
    assert.match(obs.note, /\(#190\)/);
    assert.equal(obs.note.includes(TOKEN), false);
  });
});

describe('pure helpers', () => {
  it('windowFor spans days back from now in UTC dates and falls back to 28 on junk', () => {
    assert.deepEqual(windowFor(28, NOW), { since: new Date('2026-08-07T15:00:00Z'), start: '2026-08-07', end: '2026-09-04' });
    assert.equal(windowFor('x', NOW).start, '2026-08-07');
    assert.equal(windowFor(0, NOW).start, '2026-08-07');
    assert.equal(windowFor(1, '2026-01-01T00:00:00Z').start, '2025-12-31');
  });

  it('inWindow needs a parseable created_time at or after since', () => {
    const since = new Date('2026-08-07T15:00:00Z');
    assert.equal(inWindow({ created_time: '2026-08-07T15:00:00+0000' }, since), true);
    assert.equal(inWindow({ created_time: '2026-08-07T14:59:59+0000' }, since), false);
    assert.equal(inWindow({ created_time: 'nope' }, since), false);
    assert.equal(inWindow({}, since), false);
    assert.equal(inWindow(null, since), false);
  });

  it('excerpt collapses whitespace and caps length', () => {
    assert.equal(excerpt('  a \n\n b\tc  '), 'a b c');
    assert.equal(excerpt(''), '');
    assert.equal(excerpt(null), '');
    const long = 'word '.repeat(50);
    const out = excerpt(long, 20);
    assert.equal(out.length, 20);
    assert.ok(out.endsWith('…'));
    assert.equal(excerpt('exactly-twenty-chars', 20), 'exactly-twenty-chars');
  });

  it('scrubSecrets removes token values and access_token params, ignoring trivially short secrets', () => {
    assert.equal(scrubSecrets('x access_token=ABC123&y=1 z', []), 'x access_token=[redacted]&y=1 z');
    assert.equal(scrubSecrets('token SECRETVALUE99 here', ['SECRETVALUE99']), 'token [redacted] here');
    assert.equal(scrubSecrets('has a "quoted" bit', ['a']), 'has a "quoted" bit');
    assert.equal(scrubSecrets(undefined, ['SECRETVALUE99']), '');
    assert.equal(scrubSecrets('no secrets', [undefined, null, 42]), 'no secrets');
  });

  it('postToObservation copes with a bare summarizePost shape', () => {
    const obs = postToObservation(
      { id: 42, message: '', reactions: '3', comments: undefined, shares: NaN, interactions: 3 },
      { attemptId: ATTEMPT, retrievedAt: NOW.toISOString(), period: { start: '2026-08-07', end: '2026-09-04' }, cities: policy.cities },
    );
    assertValidObservation(obs);
    assert.equal(obs.id, 'fb:42');
    assert.equal(obs.scope, '42');
    assert.equal(obs.raw_ref, 'graph:42');
    assert.equal(obs.geography, null);
    assert.deepEqual(obs.value, {
      impressions: null, reach: null, engaged: null, reactions: 3, comments: 0, shares: 0, clicks: 0, media_views: 0,
      interactions: 3, media_type: 'text', created_time: null, permalink_url: null, message_excerpt: '',
    });
  });
});
