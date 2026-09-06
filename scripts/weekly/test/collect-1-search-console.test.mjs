import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ObservationSchema, parseOrIssues } from '../lib/schemas.mjs';
import { dateRange, SEARCH_CONSOLE_TOKEN_FILE_DEFAULT } from '../../lib/search-console.mjs';
import {
  SITES_URL,
  PULLS,
  buildQueryUrl,
  collectSearchConsole,
  findCity,
  loadSearchConsoleFetch,
  normalizeDays,
  resolveTokenFile,
  rowsToObservations,
} from '../lib/collectors/search-console.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'collect-1-search-console.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'weekly-policy.json'), 'utf8'));

const NOW = new Date(2026, 8, 4, 12, 0, 0); // Friday 2026-09-04 local noon
const ATTEMPT = 'attempt-test-0001';
const GRIZZLY_SITE = 'sc-domain:grizzlyelectricaltx.com';
const DAY_MS = 24 * 60 * 60 * 1000;

function fixtureRows(key) {
  return fixture.pulls[key].rows;
}

function pullKey(body) {
  const days = Math.round((Date.parse(body.endDate) - Date.parse(body.startDate)) / DAY_MS) + 1;
  return `${days}:${body.dimensions.join(',')}`;
}

/** gbpFetch stand-in: serves the fixture, records calls, optionally fails one pull. */
function fakeGbpFetch({ sites = fixture.sites, failAt = null, pulls = fixture.pulls } = {}) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === SITES_URL) return sites;
    const body = JSON.parse(options.body);
    const key = pullKey(body);
    if (failAt && failAt.key === key) throw failAt.error;
    return pulls[key] || { rows: [] };
  };
  fn.calls = calls;
  return fn;
}

function apiError(status, body) {
  const e = new Error(`Search Console API error [${status}]: ${body}`);
  e.status = status;
  e.body = body;
  return e;
}

function assertValidObservation(obs) {
  const { issues } = parseOrIssues(ObservationSchema, obs);
  assert.deepEqual(issues, [], `observation ${obs.id} failed schema: ${JSON.stringify(issues)}`);
}

describe('collectSearchConsole (injected gbpFetchImpl)', () => {
  it('lists sites once, then pulls query / page / query+page for 28 and 90 days with the documented row limits', async () => {
    const gbpFetchImpl = fakeGbpFetch();
    await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl, policy });

    assert.equal(gbpFetchImpl.calls.length, 7);
    assert.equal(gbpFetchImpl.calls[0].url, SITES_URL);
    const expectedUrl = buildQueryUrl(GRIZZLY_SITE);
    assert.ok(expectedUrl.includes(encodeURIComponent(GRIZZLY_SITE)), 'site URL is percent-encoded');

    const expected = [];
    for (const days of [28, 90]) {
      for (const pull of PULLS) expected.push({ days, ...pull });
    }
    gbpFetchImpl.calls.slice(1).forEach((call, i) => {
      const { days, dimensions, rowLimit } = expected[i];
      const { startDate, endDate } = dateRange(days, NOW);
      assert.equal(call.url, expectedUrl);
      assert.equal(call.options.method, 'POST');
      assert.deepEqual(JSON.parse(call.options.body), { startDate, endDate, dimensions, rowLimit });
    });
  });

  it('emits one schema-valid ok observation per row', async () => {
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: fakeGbpFetch(), policy });
    const totalRows = Object.values(fixture.pulls).reduce((n, p) => n + p.rows.length, 0);
    assert.equal(observations.length, totalRows);
    for (const obs of observations) {
      assertValidObservation(obs);
      assert.equal(obs.attempt_id, ATTEMPT);
      assert.equal(obs.source, 'search_console');
      assert.equal(obs.status, 'ok');
      assert.equal(obs.metric, 'search_analytics');
      assert.equal(obs.retrieved_at, NOW.toISOString());
      assert.equal(obs.note, null);
      assert.match(obs.raw_ref, /^search_console:sc-domain:grizzlyelectricaltx\.com:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}:(query|page|query,page)$/);
    }
    assert.equal(new Set(observations.map((o) => o.id)).size, observations.length, 'ids are unique');
  });

  it('reads config/weekly-policy.json for city tagging when no policy is injected', async () => {
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: fakeGbpFetch() });
    const rowlett = observations.find((o) => o.scope === 'electrician rowlett tx' && o.value.window_days === 28 && o.value.dimensions.length === 1);
    assert.equal(rowlett.geography, 'Rowlett');
  });

  it('tags geography from the query, or from the page URL for page rows, and honours an injected policy', async () => {
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: fakeGbpFetch(), policy });
    const byScope = (scope, dims) => observations.find((o) => o.scope === scope && o.value.dimensions.join(',') === dims && o.value.window_days === 28);

    assert.equal(byScope('electrician rowlett tx', 'query').geography, 'Rowlett');
    assert.equal(byScope('panel upgrade fort worth', 'query').geography, 'Fort Worth');
    assert.equal(byScope('ev charger installation royse city', 'query').geography, 'Royse City');
    assert.equal(byScope('heather lighting ideas', 'query').geography, null, 'Heath must not match inside "heather"');
    assert.equal(byScope('electrician in Dallas-Fort Worth', 'query').geography, 'Dallas', 'earliest mention wins');
    assert.equal(byScope('https://www.grizzlyelectricaltx.com/panel-upgrades/', 'page').geography, null);
    assert.equal(byScope('https://www.grizzlyelectricaltx.com/blog/how-much-does-an-electrician-cost-in-dallas', 'page').geography, 'Dallas');

    const custom = await collectSearchConsole({
      attemptId: ATTEMPT, now: NOW, gbpFetchImpl: fakeGbpFetch(), policy: { cities: [{ name: 'Gotham' }] },
    });
    assert.ok(custom.every((o) => o.geography === null), 'policy cities replace the defaults');
  });

  it('keeps numeric metrics, the page key on page rows, and query+page pairs', async () => {
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: fakeGbpFetch(), policy });
    const { startDate, endDate } = dateRange(28, NOW);

    const queryRow = observations.find((o) => o.scope === 'electrician rowlett tx' && o.value.dimensions.join() === 'query' && o.value.window_days === 28);
    assert.deepEqual(queryRow.value, {
      clicks: 12, impressions: 340, ctr: 0.0353, position: 4.21, window_days: 28, dimensions: ['query'], query: 'electrician rowlett tx',
    });
    assert.deepEqual(queryRow.period, { start: startDate, end: endDate });

    const pageRow = observations.find((o) => o.value.dimensions.join() === 'page' && o.scope.endsWith('/panel-upgrades/'));
    assert.equal(pageRow.value.page, 'https://www.grizzlyelectricaltx.com/panel-upgrades/');
    assert.equal('query' in pageRow.value, false);
    assert.equal(typeof pageRow.value.position, 'number');

    const pair = observations.find((o) => o.value.dimensions.join() === 'query,page' && o.scope === 'panel upgrade fort worth');
    assert.equal(pair.value.query, 'panel upgrade fort worth');
    assert.equal(pair.value.page, 'https://www.grizzlyelectricaltx.com/panel-upgrades/');
    assert.equal(pair.geography, 'Fort Worth');
  });

  it('orders rows best-first within a pull (clicks, then impressions)', async () => {
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: fakeGbpFetch(), policy });
    const first28Query = observations.filter((o) => o.value.window_days === 28 && o.value.dimensions.join() === 'query');
    assert.deepEqual(first28Query.map((o) => o.scope), [
      'electrician rowlett tx',
      'ev charger installation royse city',
      'electrician in Dallas-Fort Worth',
      'panel upgrade fort worth',
      'heather lighting ideas',
    ]);
    assert.equal(observations[0].scope, 'electrician rowlett tx', 'the 28d query pull comes first');
  });

  it('returns exactly one unavailable observation when the Grizzly property is missing, without querying analytics', async () => {
    const gbpFetchImpl = fakeGbpFetch({ sites: { siteEntry: [{ siteUrl: 'https://other.example/', permissionLevel: 'siteOwner' }] } });
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl, policy });
    assert.equal(observations.length, 1);
    assertValidObservation(observations[0]);
    assert.equal(observations[0].status, 'unavailable');
    assert.equal(observations[0].scope, 'property');
    assert.equal(observations[0].value, null);
    assert.equal(observations[0].note, 'Grizzly property not found among the sites for this account');
    assert.equal(gbpFetchImpl.calls.length, 1);
  });

  it('maps auth and HTTP failures to the probe\'s one-line instructions', async () => {
    const cases = [
      [new Error('GBP token file not found at: C:/x/grizzly-search-console.json. Run setup_account.py grizzly1 first.'), 'run node scripts/authorize-search-console.mjs'],
      [apiError(401, 'unauthorized'), 'token rejected; re-run authorize'],
      [apiError(403, '{"error":{"errors":[{"reason":"accessNotConfigured"}]}}'), 'enable the Google Search Console API in project exalted-slice-502415-s0'],
      [apiError(403, '{"error":{"message":"Request had insufficient authentication scopes."}}'), 'token lacks webmasters.readonly; re-run authorize'],
      [apiError(404, 'not found'), 'property not found for this account'],
      ['boom', 'boom'],
    ];
    for (const [error, note] of cases) {
      const observations = await collectSearchConsole({
        attemptId: ATTEMPT, now: NOW, policy, gbpFetchImpl: async () => { throw error; },
      });
      assert.equal(observations.length, 1);
      assert.equal(observations[0].status, 'unavailable');
      assert.equal(observations[0].scope, 'sites');
      assert.equal(observations[0].period, null);
      assert.equal(observations[0].note, note);
    }
  });

  it('keeps rows fetched before a mid-run failure, adds one unavailable marker, and stops calling', async () => {
    const gbpFetchImpl = fakeGbpFetch({ failAt: { key: '90:query', error: apiError(429, 'rate limited') } });
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl, policy });

    const okRows = observations.filter((o) => o.status === 'ok');
    const unavailable = observations.filter((o) => o.status === 'unavailable');
    const rows28 = ['28:query', '28:page', '28:query,page'].reduce((n, k) => n + fixtureRows(k).length, 0);
    assert.equal(okRows.length, rows28);
    assert.ok(okRows.every((o) => o.value.window_days === 28));
    assert.equal(unavailable.length, 1);
    assert.equal(observations.at(-1).status, 'unavailable');
    assert.equal(unavailable[0].scope, '90d:query');
    const { startDate, endDate } = dateRange(90, NOW);
    assert.deepEqual(unavailable[0].period, { start: startDate, end: endDate });
    assert.match(unavailable[0].note, /\[429\]/);
    assert.equal(gbpFetchImpl.calls.length, 1 + 3 + 1, 'no calls after the failure');
  });

  it('accepts a single number for days, dedupes, and falls back to the default on junk', async () => {
    const single = fakeGbpFetch();
    await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: single, policy, days: 28 });
    assert.equal(single.calls.length, 1 + 3);

    const deduped = fakeGbpFetch();
    await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: deduped, policy, days: [90, 90, 0, -3, 'x'] });
    assert.equal(deduped.calls.length, 1 + 3);
    assert.equal(pullKey(JSON.parse(deduped.calls[1].options.body)), '90:query');

    assert.deepEqual(normalizeDays([]), [28, 90]);
    assert.deepEqual(normalizeDays(undefined), [28, 90]);
    assert.deepEqual(normalizeDays([7, 28]), [7, 28]);
    assert.deepEqual(normalizeDays('14'), [14]);
  });

  it('treats a pull with no rows as data-free, not unavailable', async () => {
    const empty = fakeGbpFetch({ pulls: {} });
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, gbpFetchImpl: empty, policy });
    assert.deepEqual(observations, []);
    assert.equal(empty.calls.length, 7);
  });

  it('accepts an ISO string for now', async () => {
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW.toISOString(), gbpFetchImpl: fakeGbpFetch(), policy });
    assert.equal(observations[0].retrieved_at, NOW.toISOString());
  });
});

describe('findCity', () => {
  const cities = policy.cities;
  it('matches whole words case-insensitively and returns the canonical policy name', () => {
    assert.equal(findCity('ELECTRICIAN ROWLETT TX', cities), 'Rowlett');
    assert.equal(findCity('best electrician in rockwall', cities), 'Rockwall');
    assert.equal(findCity('royse city panel upgrade', cities), 'Royse City');
  });
  it('treats URL separators as word breaks', () => {
    assert.equal(findCity('https://www.grizzlyelectricaltx.com/fort-worth-electrician/', cities), 'Fort Worth');
    assert.equal(findCity('https://www.grizzlyelectricaltx.com/service-areas/#mckinney', cities), 'McKinney');
  });
  it('does not match inside longer words', () => {
    assert.equal(findCity('heather lighting ideas', cities), null);
    assert.equal(findCity('fatemeh electrician', cities), null);
    assert.equal(findCity('allentown pa electrician', cities), null);
  });
  it('picks the earliest mention, breaking ties by the longer name', () => {
    assert.equal(findCity('dallas fort worth electrician', cities), 'Dallas');
    assert.equal(findCity('fort worth and dallas electrician', cities), 'Fort Worth');
    assert.equal(findCity('x', [{ name: 'Fort' }, { name: 'Fort Worth' }]), null);
    assert.equal(findCity('fort worth', [{ name: 'Fort' }, { name: 'Fort Worth' }]), 'Fort Worth');
  });
  it('accepts a policy object, plain names, and empty inputs', () => {
    assert.equal(findCity('garland tx', policy), 'Garland');
    assert.equal(findCity('garland tx', ['Garland']), 'Garland');
    assert.equal(findCity('', cities), null);
    assert.equal(findCity(undefined, cities), null);
    assert.equal(findCity('rowlett', []), null);
    assert.equal(findCity('rowlett', undefined), null);
  });
});

describe('pure helpers', () => {
  it('resolveTokenFile prefers the explicit path, then SEARCH_CONSOLE_TOKEN_FILE, then the default', () => {
    assert.equal(resolveTokenFile({ tokenFile: 'C:/t/a.json', env: { SEARCH_CONSOLE_TOKEN_FILE: 'C:/t/b.json' } }), 'C:/t/a.json');
    assert.equal(resolveTokenFile({ env: { SEARCH_CONSOLE_TOKEN_FILE: 'C:/t/b.json' } }), 'C:/t/b.json');
    assert.equal(resolveTokenFile({ env: {} }), SEARCH_CONSOLE_TOKEN_FILE_DEFAULT);
  });
  it('rowsToObservations tolerates missing fields and does not mutate its input', () => {
    const rows = [{ keys: ['b'], clicks: 1 }, { keys: ['a'], impressions: 5 }, {}];
    const copy = JSON.parse(JSON.stringify(rows));
    const out = rowsToObservations(rows, {
      attemptId: ATTEMPT, retrievedAt: NOW.toISOString(), days: 7, dimensions: ['query'],
      period: { start: '2026-08-27', end: '2026-09-02' }, siteUrl: GRIZZLY_SITE, cities: policy.cities,
    });
    assert.deepEqual(rows, copy);
    assert.deepEqual(out.map((o) => o.scope), ['b', 'a', '']);
    assert.deepEqual(out[2].value, { clicks: 0, impressions: 0, ctr: 0, position: 0, window_days: 7, dimensions: ['query'], query: '' });
    out.forEach(assertValidObservation);
  });
});

describe('collectSearchConsole (real auth module, throwaway token file, injected fetchImpl)', () => {
  const TOKEN = 'unit-test-access-token-0123456789';
  let tmpDir;
  let tokenFile;
  let savedEnv;

  function jsonResponse(payload) {
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  }

  function fakeFetch({ fail = null } = {}) {
    const calls = [];
    const fn = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (fail) return fail;
      if (String(url) === SITES_URL) return jsonResponse(fixture.sites);
      return jsonResponse(fixture.pulls[pullKey(JSON.parse(options.body))] || { rows: [] });
    };
    fn.calls = calls;
    return fn;
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-1-sc-'));
    tokenFile = path.join(tmpDir, 'search-console-token.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ token: TOKEN, refresh_token: 'unit-test-refresh', expiry_date: Date.parse('2099-01-01T00:00:00Z') }));
    savedEnv = process.env.GBP_TOKEN_FILE;
  });

  after(() => {
    if (savedEnv === undefined) delete process.env.GBP_TOKEN_FILE;
    else process.env.GBP_TOKEN_FILE = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends the token as a Bearer header through fetchImpl, restores GBP_TOKEN_FILE, and never leaks the token', async () => {
    process.env.GBP_TOKEN_FILE = 'C:/sentinel/grizzly-gbp.json';
    const fetchImpl = fakeFetch();
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, tokenFile, fetchImpl, policy });

    assert.equal(process.env.GBP_TOKEN_FILE, 'C:/sentinel/grizzly-gbp.json', 'env swap is scoped to the import');
    assert.equal(fetchImpl.calls.length, 7);
    for (const call of fetchImpl.calls) {
      assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(call.options.headers.Accept, 'application/json');
      assert.ok(call.options.signal instanceof AbortSignal, 'requests carry an abort signal');
    }
    assert.equal(fetchImpl.calls[1].options.method, 'POST');
    assert.ok(observations.length > 0);
    assert.ok(observations.every((o) => o.status === 'ok'));
    assert.equal(JSON.stringify(observations).includes(TOKEN), false, 'token never appears in observations');
  });

  it('leaves GBP_TOKEN_FILE unset when it was unset before', async () => {
    delete process.env.GBP_TOKEN_FILE;
    await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, tokenFile, fetchImpl: fakeFetch(), policy });
    assert.equal('GBP_TOKEN_FILE' in process.env, false);
  });

  it('honours SEARCH_CONSOLE_TOKEN_FILE from env when tokenFile is not passed', async () => {
    const fetchImpl = fakeFetch();
    const observations = await collectSearchConsole({
      attemptId: ATTEMPT, now: NOW, fetchImpl, policy, env: { SEARCH_CONSOLE_TOKEN_FILE: tokenFile },
    });
    assert.ok(observations.every((o) => o.status === 'ok'));
    assert.equal(fetchImpl.calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it('maps a non-2xx response through explainSearchConsoleError', async () => {
    const fetchImpl = fakeFetch({
      fail: { ok: false, status: 403, text: async () => '{"error":{"code":403,"message":"forbidden"}}', json: async () => ({}) },
    });
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, tokenFile, fetchImpl, policy });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 'unavailable');
    assert.equal(observations[0].note, 'this Google account is not a user on the Search Console property; add it under Settings > Users and permissions');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('aborts a hung request after timeoutMs and reports it as unavailable', async () => {
    const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
    const observations = await collectSearchConsole({ attemptId: ATTEMPT, now: NOW, tokenFile, fetchImpl, policy, timeoutMs: 20 });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 'unavailable');
    assert.match(observations[0].note, /timed out after 20 ms/);
  });

  it('turns a missing token file into the authorize instruction without calling fetch', async () => {
    const fetchImpl = fakeFetch();
    const observations = await collectSearchConsole({
      attemptId: ATTEMPT, now: NOW, tokenFile: path.join(tmpDir, 'missing-token.json'), fetchImpl, policy,
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 'unavailable');
    assert.equal(observations[0].note, 'run node scripts/authorize-search-console.mjs');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('loadSearchConsoleFetch yields a gbpFetch-shaped function that parses JSON and throws status-bearing errors', async () => {
    const scFetch = await loadSearchConsoleFetch({ tokenFile, fetchImpl: fakeFetch() });
    assert.deepEqual(await scFetch(SITES_URL), fixture.sites);

    const failing = await loadSearchConsoleFetch({
      tokenFile,
      fetchImpl: fakeFetch({ fail: { ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) } }),
    });
    await assert.rejects(failing(SITES_URL), (err) => err.status === 401 && err.body === 'unauthorized' && !err.message.includes(TOKEN));
  });
});
