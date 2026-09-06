import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ObservationSchema, parseOrIssues } from '../lib/schemas.mjs';
import { createCostMeter } from '../lib/cost-meter.mjs';
import {
  SERPAPI_URL,
  NOTE_CAP_REACHED,
  NOTE_NO_API_KEY,
  buildSerpQueries,
  buildSerpUrl,
  cacheKey,
  cachePath,
  collectSerp,
  domainOf,
  fillTemplate,
  isErrorPayload,
  isFresh,
  isGrizzlyDomain,
  normalizeQueries,
  parseSerpResponse,
  readCacheEntry,
  redact,
  serpCities,
  writeCacheEntry,
} from '../lib/collectors/serpapi.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const rockwall = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'collect-2-serp-electrician-rockwall-tx.json'), 'utf8'));
const wylie = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'collect-2-serp-ev-charger-installation-wylie.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'weekly-policy.json'), 'utf8'));

const NOW = new Date('2026-09-06T12:00:00Z');
const ATTEMPT = 'attempt-test-collect-2';
const API_KEY = 'sk-test-secret-key-0123456789';
const LOCATION = policy.serp.location;
const DAY_MS = 24 * 60 * 60 * 1000;

const ROCKWALL_Q = { query: 'electrician Rockwall tx', service_key: 'troubleshooting', city: 'Rockwall', template: 'electrician {city} tx' };
const WYLIE_Q = { query: 'ev charger installation Wylie', service_key: 'ev_charger', city: 'Wylie', template: 'ev charger installation {city}' };
const PLANO_Q = { query: 'electrical panel upgrade Plano', service_key: 'panel_upgrade', city: 'Plano', template: 'electrical panel upgrade {city}' };

function fixtureFor(query) {
  return /rockwall/i.test(query) ? rockwall : wylie;
}

function queryOf(url) {
  return new URL(url).searchParams.get('q');
}

/** fetch stand-in: serves fixtures by query, records calls, can fail per query. */
function fakeFetch({ respond, status = 200, body = '' } = {}) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    const q = queryOf(url);
    if (respond) {
      const r = respond(q, url, options);
      if (r instanceof Error) throw r;
      if (r && typeof r.then === 'function') return r;
      if (r && typeof r.ok === 'boolean') return r;
      return jsonResponse(r);
    }
    if (status !== 200) return { ok: false, status, text: async () => body, json: async () => ({}) };
    return jsonResponse(fixtureFor(q));
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function assertValidObservation(obs) {
  const { issues } = parseOrIssues(ObservationSchema, obs);
  assert.deepEqual(issues, [], `observation ${obs.id} failed schema: ${JSON.stringify(issues)}`);
}

function meterFor(ceilingUsd = Infinity) {
  return createCostMeter({ ceilingUsd, pricing: policy.pricing });
}

let cacheRoot;
let counter = 0;
function freshCacheDir() {
  const dir = path.join(cacheRoot, `c${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

before(() => {
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-2-serp-'));
});
after(() => {
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe('buildSerpQueries', () => {
  it('expands the real policy deterministically, tier-filtered, deduplicated and capped', () => {
    const queries = buildSerpQueries(policy);
    assert.equal(queries.length, policy.serp.max_queries);
    assert.deepEqual(queries, buildSerpQueries(policy), 'deterministic');
    assert.equal(new Set(queries.map((q) => q.query.toLowerCase())).size, queries.length, 'unique');
    for (const q of queries) {
      assert.deepEqual(Object.keys(q), ['query', 'service_key', 'city', 'template']);
      assert.ok(!q.query.includes('{city}'));
      assert.ok(policy.services.some((s) => s.key === q.service_key));
    }
    const allowedCities = new Set(policy.cities.filter((c) => policy.serp.city_tiers.includes(c.tier)).map((c) => c.name));
    for (const q of queries) assert.ok(allowedCities.has(q.city), `${q.city} is not a tier ${policy.serp.city_tiers} city`);
    assert.ok(!queries.some((q) => ['Fort Worth', 'Denton', 'Waxahachie'].includes(q.city)));
  });

  it('orders template rank → city (policy order) → service (policy order) so the cap keeps breadth', () => {
    const queries = buildSerpQueries(policy);
    assert.deepEqual(queries[0], {
      query: 'electrical panel upgrade Rowlett', service_key: 'panel_upgrade', city: 'Rowlett', template: 'electrical panel upgrade {city}',
    });
    const firstCity = queries.slice(0, policy.services.length);
    assert.ok(firstCity.every((q) => q.city === 'Rowlett'));
    assert.deepEqual(firstCity.map((q) => q.service_key), policy.services.map((s) => s.key));
    assert.equal(queries[policy.services.length].city, 'Rockwall');
    assert.ok(queries.every((q) => q.template === policy.services.find((s) => s.key === q.service_key).query_templates[0]),
      'the 60-cap covers only first templates');
  });

  it('handles a small custom policy: order, tiers, dedupe, cap, and missing settings', () => {
    const custom = {
      serp: { city_tiers: [1], max_queries: 10 },
      services: [
        { key: 'a', query_templates: ['electrician {city}', 'a two {City}'] },
        { key: 'b', query_templates: ['  electrician   {city} '] },
        { key: 'c', query_templates: [] },
        { key: 'd' },
      ],
      cities: [{ name: 'Rowlett', tier: 1 }, { name: 'Denton', tier: 3 }, { name: 'Plano', tier: 1 }],
    };
    assert.deepEqual(buildSerpQueries(custom), [
      { query: 'electrician Rowlett', service_key: 'a', city: 'Rowlett', template: 'electrician {city}' },
      { query: 'electrician Plano', service_key: 'a', city: 'Plano', template: 'electrician {city}' },
      { query: 'a two Rowlett', service_key: 'a', city: 'Rowlett', template: 'a two {City}' },
      { query: 'a two Plano', service_key: 'a', city: 'Plano', template: 'a two {City}' },
    ]);
    assert.equal(buildSerpQueries({ ...custom, serp: { ...custom.serp, max_queries: 3 } }).length, 3);
    assert.deepEqual(buildSerpQueries({ ...custom, serp: { ...custom.serp, max_queries: 0 } }), []);
    assert.equal(buildSerpQueries({ ...custom, serp: { max_queries: 10 } }).length, 6, 'no city_tiers → every city');
    assert.equal(buildSerpQueries({ ...custom, serp: { city_tiers: [], max_queries: 10 } }).length, 6, 'empty city_tiers → every city');
    assert.deepEqual(buildSerpQueries({}), []);
    assert.deepEqual(buildSerpQueries(null), []);
  });

  it('serpCities / fillTemplate / normalizeQueries', () => {
    assert.deepEqual(serpCities({ serp: { city_tiers: ['2'] }, cities: [{ name: 'A', tier: 1 }, { name: ' B ', tier: 2 }, { tier: 2 }] }), ['B']);
    assert.equal(fillTemplate('  ev  charger {CITY}  tx ', 'Royse City'), 'ev charger Royse City tx');
    assert.deepEqual(normalizeQueries(['  electrician  Plano ', '', null, { query: 'x', city: 'Plano' }, { query: '  ' }]), [
      { query: 'electrician Plano', service_key: null, city: null, template: null },
      { query: 'x', service_key: null, city: 'Plano', template: null },
    ]);
    assert.deepEqual(normalizeQueries(undefined), []);
  });
});

describe('cache helpers', () => {
  it('cacheKey is sha1(normalized query|location), whitespace/case-insensitive, location-sensitive', () => {
    const key = cacheKey('Electrician  Rowlett TX', LOCATION);
    assert.match(key, /^[0-9a-f]{40}$/);
    assert.equal(key, createHash('sha1').update(`electrician rowlett tx|${LOCATION}`).digest('hex'));
    assert.equal(cacheKey(' electrician rowlett tx ', LOCATION), key);
    assert.notEqual(cacheKey('electrician rowlett tx', 'Austin, Texas, United States'), key);
    assert.equal(cachePath('/tmp/x', key), path.join('/tmp/x', `${key}.json`));
  });

  it('isFresh compares fetched_at against now with cacheDays', () => {
    assert.equal(isFresh(new Date(NOW.getTime() - 2 * DAY_MS).toISOString(), { now: NOW, cacheDays: 7 }), true);
    assert.equal(isFresh(new Date(NOW.getTime() - 8 * DAY_MS).toISOString(), { now: NOW, cacheDays: 7 }), false);
    assert.equal(isFresh(new Date(NOW.getTime() - 1000).toISOString(), { now: NOW, cacheDays: 0 }), false);
    assert.equal(isFresh('not a date', { now: NOW, cacheDays: 7 }), false);
    assert.equal(isFresh(null, { now: NOW, cacheDays: 7 }), false);
    assert.equal(isFresh(new Date(NOW.getTime() + DAY_MS).toISOString(), { now: NOW, cacheDays: 7 }), true, 'clock skew tolerated');
  });

  it('writeCacheEntry / readCacheEntry round-trip the documented shape and accept raw dumps', () => {
    const dir = freshCacheDir();
    const key = cacheKey(ROCKWALL_Q.query, LOCATION);
    const file = writeCacheEntry(dir, key, { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: NOW.toISOString(), response: rockwall });
    assert.equal(file, cachePath(dir, key));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: NOW.toISOString(), response: rockwall });
    assert.deepEqual(readCacheEntry(dir, key), { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: NOW.toISOString(), response: rockwall });
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'tmp file renamed away');

    const rawKey = cacheKey('raw dump', LOCATION);
    fs.writeFileSync(cachePath(dir, rawKey), JSON.stringify(rockwall));
    const raw = readCacheEntry(dir, rawKey);
    assert.equal(raw.fetched_at, rockwall._fetched_at);
    assert.equal(raw.query, 'electrician Rockwall tx');
    assert.equal(raw.location, LOCATION);
    assert.deepEqual(raw.response, rockwall, 'the raw dump itself is the response');

    assert.equal(readCacheEntry(dir, cacheKey('missing', LOCATION)), null);
    const badKey = cacheKey('bad', LOCATION);
    fs.writeFileSync(cachePath(dir, badKey), '{not json');
    assert.equal(readCacheEntry(dir, badKey), null);
    fs.writeFileSync(cachePath(dir, badKey), JSON.stringify({ hello: 'world' }));
    assert.equal(readCacheEntry(dir, badKey), null, 'neither shape');
    fs.writeFileSync(cachePath(dir, badKey), JSON.stringify([1, 2]));
    assert.equal(readCacheEntry(dir, badKey), null);
  });
});

describe('parseSerpResponse', () => {
  it('parses the real Rockwall SERP: organic, PAA, local pack, no Grizzly', () => {
    const value = parseSerpResponse(rockwall);
    assert.deepEqual(Object.keys(value), ['organic', 'paa', 'local_pack', 'grizzly_organic_position', 'grizzly_in_local_pack']);
    assert.equal(value.organic.length, 8);
    assert.deepEqual(value.organic[0], {
      position: 1, title: 'Electrician near Rockwall, TX', link: 'https://www.bbb.org/us/tx/rockwall/category/electrician', domain: 'bbb.org',
    });
    assert.deepEqual(value.organic.map((o) => o.position), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(value.paa.length, 4);
    assert.equal(value.paa[0], 'What do electricians charge per hour in Texas?');
    assert.deepEqual(value.local_pack, [
      { title: 'Rockwall Electric Heating and Air', rating: 5, reviews: 386 },
      { title: 'Milestone Electric, A/C, & Plumbing', rating: 4.9, reviews: 1500 },
      { title: 'Revelation Electrical Services', rating: 5, reviews: 136 },
    ]);
    assert.equal(value.grizzly_organic_position, null);
    assert.equal(value.grizzly_in_local_pack, false);
  });

  it('parses the real Wylie SERP: no PAA block and no local pack', () => {
    const value = parseSerpResponse(wylie);
    assert.equal(value.organic.length, 10);
    assert.equal(value.organic[0].domain, 'callmilestone.com');
    assert.deepEqual(value.paa, []);
    assert.deepEqual(value.local_pack, []);
    assert.equal(value.grizzly_organic_position, null);
    assert.equal(value.grizzly_in_local_pack, false);
  });

  it('detects Grizzly by organic domain (incl. subdomain) and by local-pack name or website', () => {
    const organic = parseSerpResponse({
      organic_results: [
        { position: 1, title: 'Other', link: 'https://notgrizzlyelectricaltx.com.evil/' },
        { position: 2, title: 'Yelp: Grizzly Electrical Solutions', link: 'https://www.yelp.com/biz/grizzly-electrical' },
        { position: 3, title: 'EV Charger Installation | Grizzly', link: 'https://www.grizzlyelectricaltx.com/ev-charger' },
      ],
    });
    assert.equal(organic.grizzly_organic_position, 3, 'a directory page naming Grizzly is not Grizzly');
    assert.equal(parseSerpResponse({ organic_results: [{ position: 4, link: 'https://blog.grizzlyelectricaltx.com/x' }] }).grizzly_organic_position, 4);

    assert.equal(parseSerpResponse({ local_results: { places: [{ title: 'GRIZZLY Electrical Solutions', rating: 5, reviews: 12 }] } }).grizzly_in_local_pack, true);
    assert.equal(parseSerpResponse({ local_results: { places: [{ title: 'Some LLC', links: { website: 'https://grizzlyelectricaltx.com/' } }] } }).grizzly_in_local_pack, true);
    assert.equal(parseSerpResponse({ local_results: { places: [{ title: 'Bear Electric' }] } }).grizzly_in_local_pack, false);
    assert.equal(isGrizzlyDomain('grizzlyelectricaltx.com'), true);
    assert.equal(isGrizzlyDomain('grizzlyelectrical.net'), false, 'email domain is not the website');
    assert.equal(isGrizzlyDomain('x.com', ''), false);
    assert.equal(parseSerpResponse({ organic_results: [{ link: 'https://acme.com' }] }, { grizzlyDomain: 'acme.com' }).grizzly_organic_position, 1);
    assert.equal(parseSerpResponse({ local_results: [{ title: 'Acme Co' }] }, { grizzlyPattern: /acme/i }).grizzly_in_local_pack, true);
  });

  it('tolerates local_results as an array, string numbers, missing positions and junk rows', () => {
    const value = parseSerpResponse({
      organic_results: [null, { title: 'No position', link: 'not a url' }, { position: '5', title: 7, link: 'https://Example.COM/x' }],
      related_questions: [{ question: '  Why?  ' }, { question: '' }, null, { snippet: 'no question' }],
      local_results: [{ title: 'A', rating: '4.9', reviews: '1,500' }, null, { title: null, rating: 'n/a' }],
    });
    assert.deepEqual(value.organic, [
      { position: 1, title: '', link: '', domain: '' },
      { position: 2, title: 'No position', link: 'not a url', domain: '' },
      { position: 5, title: '7', link: 'https://Example.COM/x', domain: 'example.com' },
    ]);
    assert.deepEqual(value.paa, ['Why?']);
    assert.deepEqual(value.local_pack, [{ title: 'A', rating: 4.9, reviews: 1500 }, { title: '', rating: null, reviews: null }]);
    assert.deepEqual(parseSerpResponse(null), { organic: [], paa: [], local_pack: [], grizzly_organic_position: null, grizzly_in_local_pack: false });
    assert.deepEqual(parseSerpResponse('nope').organic, []);
    assert.equal(domainOf('https://www.Foo.Bar/path?x=1'), 'foo.bar');
    assert.equal(domainOf(undefined), '');
  });
});

describe('buildSerpUrl / redact', () => {
  it('sends engine=google, q, location, hl=en, gl=us, num=10 and the key', () => {
    const url = new URL(buildSerpUrl({ query: ROCKWALL_Q.query, location: LOCATION, apiKey: API_KEY }));
    assert.equal(`${url.origin}${url.pathname}`, SERPAPI_URL);
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      engine: 'google', q: ROCKWALL_Q.query, location: LOCATION, hl: 'en', gl: 'us', num: '10', api_key: API_KEY,
    });
  });
  it('redact strips every occurrence of the key and tolerates no key', () => {
    assert.equal(redact(`bad key ${API_KEY} and again ${API_KEY}`, API_KEY), 'bad key [redacted] and again [redacted]');
    assert.equal(redact('plain', null), 'plain');
    assert.equal(redact(undefined, API_KEY), '');
  });
});

describe('collectSerp (live path with injected fetchImpl)', () => {
  it('fetches each uncached query with the documented params, emits ok observations, writes cache, meters each call', async () => {
    const cacheDir = freshCacheDir();
    const fetchImpl = fakeFetch();
    const meter = meterFor();
    const observations = await collectSerp({
      attemptId: ATTEMPT, queries: [ROCKWALL_Q, WYLIE_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY,
      location: LOCATION, now: NOW, fetchImpl, meter, policy,
    });

    assert.equal(fetchImpl.calls.length, 2);
    for (const [i, entry] of [ROCKWALL_Q, WYLIE_Q].entries()) {
      const url = new URL(fetchImpl.calls[i].url);
      assert.equal(`${url.origin}${url.pathname}`, SERPAPI_URL);
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        engine: 'google', q: entry.query, location: LOCATION, hl: 'en', gl: 'us', num: '10', api_key: API_KEY,
      });
      assert.ok(fetchImpl.calls[i].options.signal instanceof AbortSignal);
    }

    assert.equal(observations.length, 2);
    observations.forEach(assertValidObservation);
    const [rock, wy] = observations;
    const rockKey = cacheKey(ROCKWALL_Q.query, LOCATION);
    assert.equal(rock.id, `serp:${rockKey.slice(0, 12)}`);
    assert.equal(rock.attempt_id, ATTEMPT);
    assert.equal(rock.source, 'serpapi');
    assert.equal(rock.scope, ROCKWALL_Q.query);
    assert.equal(rock.geography, 'Rockwall');
    assert.equal(rock.period, null);
    assert.equal(rock.status, 'ok');
    assert.equal(rock.metric, 'serp');
    assert.equal(rock.raw_ref, `serpapi:${rockKey}`);
    assert.equal(rock.retrieved_at, NOW.toISOString());
    assert.equal(rock.note, null);
    assert.equal(rock.value.query, ROCKWALL_Q.query);
    assert.equal(rock.value.service_key, 'troubleshooting');
    assert.equal(rock.value.city, 'Rockwall');
    assert.equal(rock.value.template, ROCKWALL_Q.template);
    assert.equal(rock.value.location, LOCATION);
    assert.equal(rock.value.from_cache, false);
    assert.equal(rock.value.fetched_at, NOW.toISOString());
    assert.deepEqual(
      { organic: rock.value.organic, paa: rock.value.paa, local_pack: rock.value.local_pack, grizzly_organic_position: rock.value.grizzly_organic_position, grizzly_in_local_pack: rock.value.grizzly_in_local_pack },
      parseSerpResponse(rockwall),
    );
    assert.equal(wy.geography, 'Wylie');
    assert.deepEqual(wy.value.local_pack, []);

    const cached = JSON.parse(fs.readFileSync(cachePath(cacheDir, rockKey), 'utf8'));
    assert.deepEqual(Object.keys(cached), ['query', 'location', 'fetched_at', 'response']);
    assert.equal(cached.query, ROCKWALL_Q.query);
    assert.equal(cached.location, LOCATION);
    assert.equal(cached.fetched_at, NOW.toISOString());
    assert.deepEqual(cached.response, rockwall);

    const entries = meter.entries();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => [e.kind, e.usd, e.label, e.warning]), [
      ['serpapi', policy.pricing.serpapi_per_call, ROCKWALL_Q.query, null],
      ['serpapi', policy.pricing.serpapi_per_call, WYLIE_Q.query, null],
    ]);
    assert.equal(meter.spent(), 0.02);

    const dump = JSON.stringify({ observations, entries, cached });
    assert.ok(!dump.includes(API_KEY), 'the API key never reaches observations, meter or cache');
  });

  it('accepts bare query strings and infers geography from the query text', async () => {
    const fetchImpl = fakeFetch();
    const observations = await collectSerp({
      attemptId: ATTEMPT, queries: ['  electrician   Rockwall tx ', 'ev charger installation Wylie', 'generator install'],
      cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, policy,
    });
    assert.deepEqual(observations.map((o) => [o.scope, o.geography, o.value.service_key]), [
      ['electrician Rockwall tx', 'Rockwall', null],
      ['ev charger installation Wylie', 'Wylie', null],
      ['generator install', null, null],
    ]);
  });

  it('collapses duplicate queries (case/whitespace) into one call and one observation', async () => {
    const fetchImpl = fakeFetch();
    const observations = await collectSerp({
      attemptId: ATTEMPT, queries: [ROCKWALL_Q, { query: 'ELECTRICIAN  rockwall TX' }],
      cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl,
    });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(observations.length, 1);
  });

  it('works without a meter and with an empty query list', async () => {
    const fetchImpl = fakeFetch();
    const one = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 1, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(one.length, 1);
    assert.equal(one[0].status, 'ok');
    const none = await collectSerp({ attemptId: ATTEMPT, queries: [], cacheDir: freshCacheDir(), apiKey: API_KEY, now: NOW, fetchImpl });
    assert.deepEqual(none, []);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('falls back to policy for queries, location, cache/call caps and the per-call price', async () => {
    const fetchImpl = fakeFetch();
    const meter = meterFor();
    const observations = await collectSerp({ attemptId: ATTEMPT, cacheDir: freshCacheDir(), apiKey: API_KEY, now: NOW, fetchImpl, meter, policy });
    const expected = buildSerpQueries(policy);
    assert.equal(observations.length, expected.length);
    assert.equal(fetchImpl.calls.length, Math.min(expected.length, policy.serp.max_calls));
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('location'), policy.serp.location);
    assert.deepEqual(observations.map((o) => o.scope), expected.map((q) => q.query));
    assert.deepEqual(observations.map((o) => o.geography), expected.map((q) => q.city));
    assert.ok(observations.every((o) => o.status === 'ok'));
    assert.ok(meter.entries().every((e) => e.usd === policy.pricing.serpapi_per_call && e.kind === 'serpapi'));
  });

  it('reads the API key from env.SERPAPI_API_KEY when not passed', async () => {
    const fetchImpl = fakeFetch();
    await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 1, location: LOCATION, now: NOW, fetchImpl, env: { SERPAPI_API_KEY: 'env-key' } });
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('api_key'), 'env-key');
  });
});

describe('collectSerp (cache)', () => {
  it('serves a fresh cache entry without fetching and marks raw_ref cache:<key>', async () => {
    const cacheDir = freshCacheDir();
    const key = cacheKey(ROCKWALL_Q.query, LOCATION);
    const fetchedAt = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();
    writeCacheEntry(cacheDir, key, { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: fetchedAt, response: rockwall });
    const fetchImpl = fakeFetch();
    const meter = meterFor();
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [ROCKWALL_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, meter });
    assert.equal(fetchImpl.calls.length, 0);
    assertValidObservation(obs);
    assert.equal(obs.status, 'ok');
    assert.equal(obs.raw_ref, `cache:${key}`);
    assert.equal(obs.value.from_cache, true);
    assert.equal(obs.value.fetched_at, fetchedAt);
    assert.equal(obs.value.organic.length, 8);
    assert.deepEqual(meter.entries(), []);
  });

  it('refetches a stale entry and rewrites the cache file', async () => {
    const cacheDir = freshCacheDir();
    const key = cacheKey(ROCKWALL_Q.query, LOCATION);
    const stale = new Date(NOW.getTime() - 10 * DAY_MS).toISOString();
    writeCacheEntry(cacheDir, key, { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: stale, response: { organic_results: [] } });
    const fetchImpl = fakeFetch();
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [ROCKWALL_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(obs.raw_ref, `serpapi:${key}`);
    assert.equal(obs.value.organic.length, 8);
    assert.equal(JSON.parse(fs.readFileSync(cachePath(cacheDir, key), 'utf8')).fetched_at, NOW.toISOString());
  });

  it('cacheDays 0 ignores the cache; a corrupt file is treated as a miss', async () => {
    const cacheDir = freshCacheDir();
    const key = cacheKey(ROCKWALL_Q.query, LOCATION);
    writeCacheEntry(cacheDir, key, { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: NOW.toISOString(), response: rockwall });
    const fetchImpl = fakeFetch();
    await collectSerp({ attemptId: ATTEMPT, queries: [ROCKWALL_Q], cacheDir, cacheDays: 0, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 1);

    fs.writeFileSync(cachePath(cacheDir, key), '{broken');
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [ROCKWALL_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(obs.status, 'ok');
    assert.equal(obs.raw_ref, `serpapi:${key}`);
  });

  it('accepts a raw research dump (top-level response with _fetched_at) as a cache entry', async () => {
    const cacheDir = freshCacheDir();
    const key = cacheKey(rockwall._query, LOCATION);
    fs.copyFileSync(path.join(FIXTURES, 'collect-2-serp-electrician-rockwall-tx.json'), cachePath(cacheDir, key));
    const fetchImpl = fakeFetch();
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [ROCKWALL_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(obs.raw_ref, `cache:${key}`);
    assert.equal(obs.value.fetched_at, rockwall._fetched_at);
    assert.equal(obs.value.local_pack.length, 3);
  });

  it('creates the cache directory when it does not exist', async () => {
    const cacheDir = path.join(freshCacheDir(), 'nested', 'serp-cache');
    const fetchImpl = fakeFetch();
    await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.ok(fs.existsSync(cachePath(cacheDir, cacheKey(WYLIE_Q.query, LOCATION))));
  });
});

describe('collectSerp (caps, key, budget)', () => {
  it('stops at maxCalls live calls, marks the rest unavailable "cap reached", still serves cached queries after the cap', async () => {
    const cacheDir = freshCacheDir();
    const key = cacheKey(ROCKWALL_Q.query, LOCATION);
    writeCacheEntry(cacheDir, key, { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: NOW.toISOString(), response: rockwall });
    const fetchImpl = fakeFetch();
    const meter = meterFor();
    const observations = await collectSerp({
      attemptId: ATTEMPT, queries: [WYLIE_Q, PLANO_Q, { query: 'electrician Garland tx', city: 'Garland' }, ROCKWALL_Q],
      cacheDir, cacheDays: 7, maxCalls: 1, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, meter,
    });
    assert.equal(fetchImpl.calls.length, 1);
    observations.forEach(assertValidObservation);
    assert.deepEqual(observations.map((o) => [o.scope, o.status, o.note, o.raw_ref]), [
      [WYLIE_Q.query, 'ok', null, `serpapi:${cacheKey(WYLIE_Q.query, LOCATION)}`],
      [PLANO_Q.query, 'unavailable', NOTE_CAP_REACHED, null],
      ['electrician Garland tx', 'unavailable', NOTE_CAP_REACHED, null],
      [ROCKWALL_Q.query, 'ok', null, `cache:${key}`],
    ]);
    assert.equal(observations[1].geography, 'Plano');
    assert.equal(observations[1].value, null);
    assert.equal(observations[1].metric, 'serp');
    assert.equal(meter.entries().length, 1);
  });

  it('maxCalls 0 → no live calls at all', async () => {
    const fetchImpl = fakeFetch();
    const observations = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q, PLANO_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 0, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(observations.map((o) => [o.status, o.note]), [['unavailable', NOTE_CAP_REACHED], ['unavailable', NOTE_CAP_REACHED]]);
  });

  it('missing API key → unavailable for every uncached query, no fetch; cached queries still ok', async () => {
    const cacheDir = freshCacheDir();
    const key = cacheKey(ROCKWALL_Q.query, LOCATION);
    writeCacheEntry(cacheDir, key, { query: ROCKWALL_Q.query, location: LOCATION, fetched_at: NOW.toISOString(), response: rockwall });
    const fetchImpl = fakeFetch();
    const observations = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q, ROCKWALL_Q, PLANO_Q], cacheDir, cacheDays: 7, maxCalls: 10, location: LOCATION, now: NOW, fetchImpl, env: {} });
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(observations.map((o) => [o.status, o.note]), [
      ['unavailable', NOTE_NO_API_KEY], ['ok', null], ['unavailable', NOTE_NO_API_KEY],
    ]);
    observations.forEach(assertValidObservation);
  });

  it('stops with "budget reached" when the meter ceiling would be exceeded', async () => {
    const fetchImpl = fakeFetch();
    const meter = meterFor(0.015);
    const observations = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q, PLANO_Q, ROCKWALL_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, meter, policy });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(observations[0].status, 'ok');
    assert.equal(observations[1].status, 'unavailable');
    assert.match(observations[1].note, /^budget reached: /);
    assert.match(observations[1].note, /budget ceiling \$0\.015 exceeded/);
    assert.equal(observations[2].status, 'unavailable');
    assert.equal(meter.spent(), 0.01);
    assert.ok(!JSON.stringify(observations).includes(API_KEY));
  });
});

describe('collectSerp (errors)', () => {
  it('HTTP error → error observation with the status in the note, key redacted, nothing cached or metered', async () => {
    const cacheDir = freshCacheDir();
    const fetchImpl = fakeFetch({ status: 429, body: `Rate limited for key ${API_KEY}` });
    const meter = meterFor();
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, meter });
    assertValidObservation(obs);
    assert.equal(obs.status, 'error');
    assert.equal(obs.value, null);
    assert.equal(obs.raw_ref, null);
    assert.equal(obs.geography, 'Wylie');
    assert.match(obs.note, /SerpApi HTTP 429/);
    assert.match(obs.note, /Rate limited for key \[redacted\]/);
    assert.ok(!obs.note.includes(API_KEY));
    assert.equal(fs.readdirSync(cacheDir).length, 0);
    assert.deepEqual(meter.entries(), []);
  });

  it('a rejected fetch (network) → error observation, later queries still attempted', async () => {
    const fetchImpl = fakeFetch({ respond: (q) => (/wylie/i.test(q) ? new Error('getaddrinfo ENOTFOUND serpapi.com') : rockwall) });
    const observations = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q, ROCKWALL_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.deepEqual(observations.map((o) => o.status), ['error', 'ok']);
    assert.match(observations[0].note, /ENOTFOUND/);
  });

  it('a 200 with a SerpApi error payload → error observation, metered (billed), not cached', async () => {
    const cacheDir = freshCacheDir();
    const fetchImpl = fakeFetch({ respond: () => ({ error: "Google hasn't returned any results for this query." }) });
    const meter = meterFor();
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, meter, policy });
    assert.equal(obs.status, 'error');
    assert.match(obs.note, /SerpApi error: Google hasn't returned any results/);
    assert.equal(meter.entries().length, 1);
    assert.equal(fs.readdirSync(cacheDir).length, 0);
  });

  it('a 200 whose payload carries an error but also organic results is still ok', async () => {
    const fetchImpl = fakeFetch({ respond: () => ({ ...wylie, error: 'partial' }) });
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(obs.status, 'ok');
    assert.equal(obs.value.organic.length, 10);
  });

  it('non-JSON body → error observation', async () => {
    const fetchImpl = fakeFetch({ respond: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' }) });
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(obs.status, 'error');
    assert.match(obs.note, /Unexpected token/);
  });

  it('a non-object JSON body → error observation', async () => {
    const fetchImpl = fakeFetch({ respond: () => jsonResponse('just a string') });
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(obs.status, 'error');
    assert.match(obs.note, /non-object/);
  });

  it('times out via AbortController → error observation', async () => {
    const fetchImpl = (url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, timeoutMs: 5 });
    assert.equal(obs.status, 'error');
    assert.match(obs.note, /timed out after 5 ms/);
  });

  it('failed live calls still count toward maxCalls', async () => {
    const fetchImpl = fakeFetch({ status: 500, body: 'boom' });
    const observations = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q, PLANO_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 1, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(observations.map((o) => [o.status, o.note]), [['error', 'SerpApi HTTP 500: boom'], ['unavailable', NOTE_CAP_REACHED]]);
  });

  it('no fetch implementation → error observation instead of a throw', async () => {
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl: null });
    assert.equal(obs.status, 'error');
    assert.match(obs.note, /no fetch implementation/);
  });

  it('a cache write failure keeps the ok observation and notes it', async () => {
    const dir = freshCacheDir();
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, 'not a directory');
    const fetchImpl = fakeFetch();
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: blocker, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(obs.status, 'ok');
    assert.match(obs.note, /^cache write failed: /);
    assert.equal(obs.value.organic.length, 10);
    assertValidObservation(obs);
  });
});

describe('review hardening (collect-2)', () => {
  it('redact also strips the URL-encoded form of the key', () => {
    const key = 'sk+test/key=1';
    const msg = `request to https://serpapi.com/search.json?api_key=${encodeURIComponent(key)} failed (${key})`;
    const out = redact(msg, key);
    assert.equal(out, 'request to https://serpapi.com/search.json?api_key=[redacted] failed ([redacted])');
    assert.ok(!out.includes(key) && !out.includes(encodeURIComponent(key)));
  });

  it('a fetch error that echoes the request URL never leaks the key into the note', async () => {
    const fetchImpl = async (url) => { throw new Error(`request to ${url} failed, reason: connect ECONNREFUSED`); };
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assertValidObservation(obs);
    assert.equal(obs.status, 'error');
    assert.ok(!obs.note.includes(API_KEY));
    assert.match(obs.note, /api_key=\[redacted\]/);
    assert.match(obs.note, /ECONNREFUSED/);
  });

  it('a seeded cache entry holding a SerpApi error payload is a miss and is refetched', async () => {
    const errorPayload = { search_parameters: { q: WYLIE_Q.query }, error: "Google hasn't returned any results for this query." };
    assert.equal(isErrorPayload(errorPayload), true);
    assert.equal(isErrorPayload({ ...wylie, error: 'partial' }), false, 'organic results present → not an error payload');
    assert.equal(isErrorPayload(null), false);

    const cacheDir = freshCacheDir();
    const key = cacheKey(WYLIE_Q.query, LOCATION);
    writeCacheEntry(cacheDir, key, { query: WYLIE_Q.query, location: LOCATION, fetched_at: NOW.toISOString(), response: errorPayload });
    const fetchImpl = fakeFetch();
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir, cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl });
    assert.equal(fetchImpl.calls.length, 1, 'refetched');
    assert.equal(obs.status, 'ok');
    assert.equal(obs.raw_ref, `serpapi:${key}`);
    assert.equal(obs.value.organic.length, 10);
    assert.equal(JSON.parse(fs.readFileSync(cachePath(cacheDir, key), 'utf8')).response.error, undefined, 'cache now holds the good response');
  });

  it('a fetch implementation that ignores the abort signal still times out', async () => {
    const fetchImpl = () => new Promise(() => {}); // never settles, never looks at the signal
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, timeoutMs: 5 });
    assert.equal(obs.status, 'error');
    assert.match(obs.note, /timed out after 5 ms/);
  });

  it('a hung body read (json never resolves) also times out', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), text: async () => '' });
    const [obs] = await collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), cacheDays: 7, maxCalls: 10, apiKey: API_KEY, location: LOCATION, now: NOW, fetchImpl, timeoutMs: 5 });
    assert.equal(obs.status, 'error');
    assert.match(obs.note, /timed out after 5 ms/);
  });

  it('writeCacheEntry leaves no tmp file behind when the rename fails', () => {
    const dir = freshCacheDir();
    const key = cacheKey('blocked target', LOCATION);
    fs.mkdirSync(cachePath(dir, key)); // a directory sits where the cache file must go
    assert.throws(() => writeCacheEntry(dir, key, { query: 'blocked target', location: LOCATION, fetched_at: NOW.toISOString(), response: wylie }));
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'tmp file removed after the failed rename');
  });

  it('buildSerpQueries: a service without a key yields service_key null (never undefined)', () => {
    const [q] = buildSerpQueries({ serp: { max_queries: 5 }, services: [{ query_templates: ['electrician {city}'] }], cities: [{ name: 'Plano', tier: 1 }] });
    assert.deepEqual(q, { query: 'electrician Plano', service_key: null, city: 'Plano', template: 'electrician {city}' });
    assert.ok('service_key' in q && q.service_key === null);
  });

  it('an invalid now is a caller bug and throws a clear TypeError before any I/O', async () => {
    const fetchImpl = fakeFetch();
    await assert.rejects(
      collectSerp({ attemptId: ATTEMPT, queries: [WYLIE_Q], cacheDir: freshCacheDir(), apiKey: API_KEY, now: 'garbage', fetchImpl }),
      { name: 'TypeError', message: /now is not a valid date/ },
    );
    assert.equal(fetchImpl.calls.length, 0);
  });
});
