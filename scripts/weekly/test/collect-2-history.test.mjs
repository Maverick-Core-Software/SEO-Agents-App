import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObservationSchema, parseOrIssues } from '../lib/schemas.mjs';
import {
  POSTS_TABLE,
  TASKS_TABLE,
  PERF_TABLE,
  POST_COLUMNS,
  TASK_COLUMNS,
  PERF_COLUMNS,
  METRIC_POST,
  METRIC_TASK,
  METRIC_SUMMARY,
  ROW_LIMIT,
  chicagoDate,
  collectHistory,
  findCity,
  inferCity,
  normalizeLimit,
  normalizePost,
  normalizeTask,
  normalizeWeeks,
  policyCities,
  resolvePerformanceMemory,
  sinceDate,
  toIsoDate,
} from '../lib/collectors/history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'collect-2-history.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'weekly-policy.json'), 'utf8'));

const NOW = new Date('2026-09-04T17:00:00Z'); // Friday 2026-09-04, noon Chicago
const ATTEMPT = 'attempt-test-collect-2';
const READ_ONLY_OPS = new Set(['select', 'gte', 'order', 'limit', 'eq', 'await']);
/** Stored performance memory for the fixture posts, as reconcile writes it. */
const MEMORY = [
  { platform_post_id: 'fb-200', source: 'facebook', metric: 'fb_interactions', window_days: 7, value: 41, availability: 'ok', measured_at: '2026-09-02T14:00:00Z' },
  { platform_post_id: 'fb-200', source: 'facebook', metric: 'fb_interactions', window_days: 28, value: 118, availability: 'ok', measured_at: '2026-09-23T14:00:00Z' },
  { platform_post_id: 'fb-200', source: 'facebook', metric: 'fb_media_views', window_days: 28, value: null, availability: 'unavailable', measured_at: '2026-09-23T14:00:00Z' },
];

/**
 * Minimal supabase-js query-builder fake: records every call, resolves canned
 * `{ data, error }` responses keyed by table (a function receives the chain).
 * It deliberately has no insert/update/delete/upsert so any write would throw.
 */
function fakeClient(responses = {}) {
  const calls = [];
  function builder(table) {
    const chain = { table, ops: [] };
    const api = {};
    for (const op of ['select', 'gte', 'lte', 'eq', 'in', 'order', 'limit']) {
      api[op] = (...args) => { chain.ops.push([op, ...args]); return api; };
    }
    const finish = () => {
      chain.ops.push(['await']);
      calls.push(chain);
      const r = responses[table];
      return Promise.resolve(typeof r === 'function' ? r(chain) : (r || { data: [], error: null }));
    };
    api.then = (resolve, reject) => finish().then(resolve, reject);
    return api;
  }
  return {
    calls,
    from: (table) => {
      if (responses[table] instanceof Error) throw responses[table];
      return builder(table);
    },
  };
}

function fixtureClient(overrides = {}) {
  return fakeClient({
    [POSTS_TABLE]: { data: fixture.weekly_posts, error: null },
    [TASKS_TABLE]: { data: fixture.website_tasks, error: null },
    [PERF_TABLE]: { data: MEMORY, error: null },
    ...overrides,
  });
}

function assertValidObservation(obs) {
  const { issues } = parseOrIssues(ObservationSchema, obs);
  assert.deepEqual(issues, [], `observation ${obs.id} failed schema: ${JSON.stringify(issues)}`);
}

function assertReadOnly(client) {
  for (const call of client.calls) {
    for (const [op] of call.ops) assert.ok(READ_ONLY_OPS.has(op), `unexpected op ${op} on ${call.table}`);
  }
}

describe('geography helpers', () => {
  it('policyCities reads names from a policy object or a bare list', () => {
    assert.ok(policyCities(policy).includes('Rowlett'));
    assert.deepEqual(policyCities(['Plano', { name: ' Frisco ' }, { name: '' }, null, 7]), ['Plano', 'Frisco']);
    assert.deepEqual(policyCities(null), []);
  });

  it('findCity matches whole words case-insensitively and ignores punctuation', () => {
    assert.equal(findCity('ELECTRICIAN rowlett, TX', policy), 'Rowlett');
    assert.equal(findCity('/fort-worth-electrician/', policy), 'Fort Worth');
    assert.equal(findCity('#RowlettElectrician', policy), null, 'no word boundary inside a hashtag');
    assert.equal(findCity('', policy), null);
    assert.equal(findCity(null, policy), null);
    assert.equal(findCity('Nothing here', policy), null);
  });

  it('findCity takes the earliest mention and the longer name on a tie', () => {
    assert.equal(findCity('Serving Garland and Rowlett', policy), 'Garland');
    assert.equal(findCity('Fort Worth crews', ['Fort', 'Fort Worth']), 'Fort Worth');
  });

  it('inferCity scans texts in order (hook before body)', () => {
    assert.equal(inferCity(['no city here', 'body mentions Plano'], policy), 'Plano');
    assert.equal(inferCity(['Wylie first', 'Plano second'], policy), 'Wylie');
    assert.equal(inferCity([null, undefined, ''], policy), null);
  });
});

describe('pure helpers', () => {
  it('sinceDate subtracts whole weeks from the Chicago calendar date and falls back to 8 weeks', () => {
    assert.equal(sinceDate(NOW, 8), '2026-07-10');
    assert.equal(sinceDate(NOW, 12), '2026-06-12');
    assert.equal(sinceDate(NOW, 2), '2026-08-21');
    assert.equal(sinceDate(NOW, 0), '2026-07-10');
    assert.equal(sinceDate(NOW, 'x'), '2026-07-10');
    assert.equal(sinceDate('2026-09-04T17:00:00Z', 1), '2026-08-28');
  });

  it('toIsoDate normalizes dates, timestamps and Date objects', () => {
    assert.equal(toIsoDate('2026-08-24'), '2026-08-24');
    assert.equal(toIsoDate('2026-08-24T00:00:00'), '2026-08-24');
    assert.equal(toIsoDate(new Date('2026-08-24T12:00:00Z')), '2026-08-24');
    assert.equal(toIsoDate(null), null);
    assert.equal(toIsoDate(''), null);
    assert.equal(toIsoDate('garbage'), null);
  });

  it('normalizePost trims, nulls empties, infers city from hook before body', () => {
    const [ev, panel, skipped, lighting] = fixture.weekly_posts.map((row) => normalizePost(row, policy));
    assert.deepEqual(ev, {
      platform: 'gbp', post_date: '2026-08-28', service: 'EV Charger Installation',
      hook: 'Charging at home in Rowlett just got easier', status: 'posted', platform_post_id: 'gbp-100',
      photo_file: 'ev-charger-garage.jpg', city: 'Rowlett', type: null, day: null,
    });
    assert.equal(panel.city, 'Garland', 'no city in hook → first city in body');
    assert.equal(panel.type, 'photo');
    assert.equal(panel.day, 3);
    assert.deepEqual(skipped, {
      platform: 'facebook', post_date: '2026-08-24', service: 'Generator Inlet, Interlock & Installation',
      hook: null, status: 'skipped', platform_post_id: null, photo_file: null, city: null, type: 'video', day: 1,
    });
    assert.equal(lighting.city, 'Fort Worth', 'hook wins over body');
    assert.deepEqual(normalizePost(null, policy).platform, null);
  });

  it('normalizeTask keeps the four contract fields', () => {
    assert.deepEqual(normalizeTask(fixture.website_tasks[0]), {
      title: 'Add EV charger FAQ section', type: 'blog_post', status: 'done', updated_at: '2026-08-30T10:00:00+00:00',
    });
    assert.deepEqual(normalizeTask(fixture.website_tasks[2]), { title: null, type: 'alert', status: 'skipped', updated_at: null });
    assert.deepEqual(normalizeTask(undefined), { title: null, type: null, status: null, updated_at: null });
  });
});

describe('collectHistory (injected supabase client)', () => {
  it('issues exactly the documented read-only chains for all three tables', async () => {
    const client = fixtureClient();
    await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });

    assert.equal(client.calls.length, 3);
    assert.equal(client.calls[0].table, POSTS_TABLE);
    assert.deepEqual(client.calls[0].ops, [
      ['select', POST_COLUMNS],
      ['gte', 'post_date', '2026-07-10'],
      ['order', 'post_date', { ascending: false }],
      ['limit', ROW_LIMIT],
      ['await'],
    ]);
    assert.equal(client.calls[1].table, TASKS_TABLE);
    assert.deepEqual(client.calls[1].ops, [
      ['select', TASK_COLUMNS],
      ['gte', 'updated_at', '2026-06-12'],
      ['order', 'updated_at', { ascending: false }],
      ['limit', ROW_LIMIT],
      ['await'],
    ]);
    assert.equal(client.calls[2].table, PERF_TABLE);
    assert.deepEqual(client.calls[2].ops, [
      ['select', PERF_COLUMNS],
      ['eq', 'source', 'facebook'],
      ['gte', 'measured_at', '2026-07-10'],
      ['order', 'measured_at', { ascending: false }],
      ['limit', ROW_LIMIT],
      ['await'],
    ]);
    assertReadOnly(client);
  });

  it('honours weeks, taskWeeks and limit', async () => {
    const client = fixtureClient();
    await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy, weeks: 2, taskWeeks: 4, limit: 50 });
    assert.deepEqual(client.calls[0].ops[1], ['gte', 'post_date', '2026-08-21']);
    assert.deepEqual(client.calls[0].ops[3], ['limit', 50]);
    assert.deepEqual(client.calls[1].ops[1], ['gte', 'updated_at', '2026-08-07']);
    assert.deepEqual(client.calls[1].ops[3], ['limit', 50]);
    assert.deepEqual(client.calls[2].ops[2], ['gte', 'measured_at', '2026-08-21']);
    assert.deepEqual(client.calls[2].ops[4], ['limit', 50]);
  });

  it('returns the compact history object from the fixture rows', async () => {
    const { history } = await collectHistory({ attemptId: ATTEMPT, supabase: fixtureClient(), now: NOW, policy });
    assert.equal(history.posts.length, 4);
    assert.deepEqual(history.posts.map((p) => p.city), ['Rowlett', 'Garland', null, 'Fort Worth']);
    assert.deepEqual(history.posts.map((p) => p.post_date), ['2026-08-28', '2026-08-26', '2026-08-24', '2026-07-20']);
    for (const post of history.posts) {
      assert.deepEqual(
        Object.keys(post).sort(),
        ['city', 'day', 'hook', 'photo_file', 'platform', 'platform_post_id', 'post_date', 'service', 'status', 'type'],
      );
    }
    assert.equal(history.website_tasks.length, 3);
    assert.deepEqual(history.website_tasks[1], {
      title: 'Fix footer phone number', type: 'seo_fix', status: 'waiting_on_owner', updated_at: '2026-07-01T10:00:00+00:00',
    });
    assert.deepEqual(history.performance, [
      { platform_post_id: 'fb-200', window_days: 28, metric: 'fb_interactions', value: 118, measured_at: '2026-09-23T14:00:00Z' },
    ]);
  });

  it('emits one schema-valid observation per row plus a summary per table', async () => {
    const { observations } = await collectHistory({ attemptId: ATTEMPT, supabase: fixtureClient(), now: NOW, policy });
    assert.equal(observations.length, 4 + 1 + 3 + 1 + 1);
    observations.forEach(assertValidObservation);
    assert.equal(new Set(observations.map((o) => o.id)).size, observations.length, 'ids are unique');
    assert.ok(observations.every((o) => o.source === 'history' && o.status === 'ok' && o.attempt_id === ATTEMPT));
    assert.ok(observations.every((o) => o.retrieved_at === NOW.toISOString()));

    const posts = observations.filter((o) => o.metric === METRIC_POST);
    assert.equal(posts.length, 4);
    assert.equal(posts[0].scope, 'gbp-100');
    assert.equal(posts[0].geography, 'Rowlett');
    assert.deepEqual(posts[0].period, { start: '2026-08-28', end: '2026-08-28' });
    assert.equal(posts[0].raw_ref, `supabase:${POSTS_TABLE}:gbp-100`);
    assert.equal(posts[0].value.hook, 'Charging at home in Rowlett just got easier');
    assert.equal(posts[2].scope, 'facebook:2026-08-24:2', 'no platform_post_id → synthetic scope');
    assert.equal(posts[2].geography, null);

    const tasks = observations.filter((o) => o.metric === METRIC_TASK);
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].scope, 'Add EV charger FAQ section');
    assert.equal(tasks[2].scope, 'task:2');
    assert.equal(tasks[0].period, null);

    const summaries = observations.filter((o) => o.metric === METRIC_SUMMARY);
    assert.deepEqual(summaries.map((o) => o.scope), [POSTS_TABLE, TASKS_TABLE, PERF_TABLE]);
    assert.deepEqual(summaries[0].value, { table: POSTS_TABLE, rows: 4, weeks: 8, since: '2026-07-10' });
    assert.deepEqual(summaries[0].period, { start: '2026-07-10', end: '2026-09-04' });
    assert.deepEqual(summaries[1].value, { table: TASKS_TABLE, rows: 3, weeks: 12, since: '2026-06-12' });
  });

  it('undated post → period null', async () => {
    const client = fakeClient({
      [POSTS_TABLE]: { data: [{ platform: 'gbp', post_date: null, service: 'X', hook: 'y', status: 'posted' }], error: null },
    });
    const { observations, history } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });
    const post = observations.find((o) => o.metric === METRIC_POST);
    assert.equal(post.period, null);
    assert.equal(post.scope, 'gbp:undated:0');
    assert.equal(history.posts[0].post_date, null);
    assertValidObservation(post);
  });

  it('empty tables → empty history and three ok summaries with rows 0', async () => {
    const client = fakeClient();
    const { observations, history } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });
    assert.deepEqual(history, { posts: [], website_tasks: [], performance: [] });
    assert.deepEqual(observations.map((o) => [o.metric, o.status, o.value.rows]), [
      [METRIC_SUMMARY, 'ok', 0], [METRIC_SUMMARY, 'ok', 0], [METRIC_SUMMARY, 'ok', 0],
    ]);
  });

  it('a supabase error on weekly_posts → unavailable for that table only', async () => {
    const client = fixtureClient({ [POSTS_TABLE]: { data: null, error: { message: 'permission denied for table weekly_posts' } } });
    const { observations, history } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });
    assert.deepEqual(history.posts, []);
    assert.equal(history.website_tasks.length, 3);
    const unavailable = observations.filter((o) => o.status === 'unavailable');
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0].scope, POSTS_TABLE);
    assert.equal(unavailable[0].id, `hist:unavailable:${POSTS_TABLE}`);
    assert.match(unavailable[0].note, /permission denied/);
    assert.equal(unavailable[0].value, null);
    assertValidObservation(unavailable[0]);
    assert.equal(observations.length, 1 + 3 + 1 + 1);
    assert.ok(observations.some((o) => o.metric === METRIC_SUMMARY && o.scope === TASKS_TABLE && o.status === 'ok'));
  });

  it('a thrown client error on website_tasks → unavailable for that table only', async () => {
    const client = fixtureClient({ [TASKS_TABLE]: new Error('connection reset') });
    const { observations, history } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });
    assert.equal(history.posts.length, 4);
    assert.deepEqual(history.website_tasks, []);
    const unavailable = observations.filter((o) => o.status === 'unavailable');
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0].scope, TASKS_TABLE);
    assert.match(unavailable[0].note, /connection reset/);
  });

  it('a rejected chain → unavailable, never a throw', async () => {
    const client = fixtureClient({ [POSTS_TABLE]: () => Promise.reject(new Error('fetch failed')) });
    // fakeClient wraps function responses in Promise.resolve; a rejected promise propagates through then()
    const { observations } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });
    const unavailable = observations.find((o) => o.status === 'unavailable');
    assert.equal(unavailable.scope, POSTS_TABLE);
    assert.match(unavailable.note, /fetch failed/);
  });

  it('no supabase client → all three tables unavailable, empty history', async () => {
    const { observations, history } = await collectHistory({ attemptId: ATTEMPT, now: NOW, policy });
    assert.deepEqual(history, { posts: [], website_tasks: [], performance: [] });
    assert.deepEqual(observations.map((o) => [o.scope, o.status]), [
      [POSTS_TABLE, 'unavailable'], [TASKS_TABLE, 'unavailable'], [PERF_TABLE, 'unavailable'],
    ]);
    observations.forEach(assertValidObservation);
    assert.match(observations[0].note, /no supabase client/);
  });

  it('reads city names from config/weekly-policy.json when no policy is passed', async () => {
    const { history } = await collectHistory({ attemptId: ATTEMPT, supabase: fixtureClient(), now: NOW });
    assert.equal(history.posts[0].city, 'Rowlett');
  });

  it('a custom policy changes inference; a broken policy falls back to no cities', async () => {
    const custom = await collectHistory({ attemptId: ATTEMPT, supabase: fixtureClient(), now: NOW, policy: { cities: [{ name: 'Rockwall' }] } });
    assert.deepEqual(custom.history.posts.map((p) => p.city), ['Rockwall', null, null, null]);
    const none = await collectHistory({ attemptId: ATTEMPT, supabase: fixtureClient(), now: NOW, policy: { cities: 'nope' } });
    assert.deepEqual(none.history.posts.map((p) => p.city), [null, null, null, null]);
  });

  it('accepts now as an ISO string', async () => {
    const client = fixtureClient();
    const { observations } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: '2026-09-04T17:00:00Z', policy });
    assert.equal(observations[0].retrieved_at, '2026-09-04T17:00:00.000Z');
    assert.deepEqual(client.calls[0].ops[1], ['gte', 'post_date', '2026-07-10']);
  });
});

describe('review hardening (collect-2)', () => {
  it('sinceDate and the summary period use the Chicago calendar date, not the UTC date', async () => {
    const lateEvening = new Date('2026-09-05T03:30:00Z'); // Fri 2026-09-04 22:30 in Chicago (CDT); already 09-05 in UTC
    assert.equal(chicagoDate(lateEvening), '2026-09-04');
    assert.equal(sinceDate(lateEvening, 8), '2026-07-10');
    const winterNight = new Date('2026-01-10T05:30:00Z'); // Fri 2026-01-09 23:30 in Chicago (CST)
    assert.equal(chicagoDate(winterNight), '2026-01-09');
    assert.equal(sinceDate(winterNight, 1), '2026-01-02');
    assert.equal(sinceDate('2026-09-05T03:30:00Z', 12), '2026-06-12');

    const client = fixtureClient();
    const { observations } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: lateEvening, policy });
    assert.deepEqual(client.calls[0].ops[1], ['gte', 'post_date', '2026-07-10']);
    assert.deepEqual(client.calls[1].ops[1], ['gte', 'updated_at', '2026-06-12']);
    const summary = observations.find((o) => o.metric === METRIC_SUMMARY);
    assert.deepEqual(summary.period, { start: '2026-07-10', end: '2026-09-04' });
    assert.equal(summary.retrieved_at, '2026-09-05T03:30:00.000Z', 'retrieved_at stays the true instant');
  });

  it('normalizeWeeks and the summaries report the effective window when the input falls back', async () => {
    assert.equal(normalizeWeeks(0), 8);
    assert.equal(normalizeWeeks('x'), 8);
    assert.equal(normalizeWeeks(-3, 12), 12);
    assert.equal(normalizeWeeks('2'), 2);
    const client = fixtureClient();
    const { observations } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy, weeks: 0, taskWeeks: 'x' });
    const [posts, tasks] = observations.filter((o) => o.metric === METRIC_SUMMARY);
    assert.deepEqual([posts.value.weeks, posts.value.since], [8, '2026-07-10']);
    assert.deepEqual([tasks.value.weeks, tasks.value.since], [12, '2026-06-12']);
    assert.deepEqual(client.calls[0].ops[1], ['gte', 'post_date', '2026-07-10']);
    assert.deepEqual(client.calls[1].ops[1], ['gte', 'updated_at', '2026-06-12']);
  });

  it('an invalid now is a caller bug and throws a clear TypeError before any query', async () => {
    const client = fixtureClient();
    await assert.rejects(
      collectHistory({ attemptId: ATTEMPT, supabase: client, now: 'garbage', policy }),
      { name: 'TypeError', message: /now is not a valid date/ },
    );
    assert.equal(client.calls.length, 0);
  });
});

describe('review hardening 2 (collect-2, adversarial)', () => {
  it('normalizeLimit never sends 0 / NaN / negative / fractional to .limit()', async () => {
    assert.equal(normalizeLimit(0), ROW_LIMIT);
    assert.equal(normalizeLimit(-5), ROW_LIMIT);
    assert.equal(normalizeLimit('x'), ROW_LIMIT);
    assert.equal(normalizeLimit(null), ROW_LIMIT);
    assert.equal(normalizeLimit(Infinity), ROW_LIMIT);
    assert.equal(normalizeLimit('25'), 25);
    assert.equal(normalizeLimit(7.9), 7);
    const client = fixtureClient();
    await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy, limit: 0 });
    assert.deepEqual(client.calls[0].ops[3], ['limit', ROW_LIMIT]);
    assert.deepEqual(client.calls[1].ops[3], ['limit', ROW_LIMIT]);
    const client2 = fixtureClient();
    await collectHistory({ attemptId: ATTEMPT, supabase: client2, now: NOW, policy, limit: '25' });
    assert.deepEqual(client2.calls[0].ops[3], ['limit', 25]);
  });

  it('a client whose from() returns an object without the query chain → all three tables unavailable, no throw', async () => {
    const { observations, history } = await collectHistory({ attemptId: ATTEMPT, supabase: { from: () => ({}) }, now: NOW, policy });
    assert.deepEqual(history, { posts: [], website_tasks: [], performance: [] });
    assert.deepEqual(observations.map((o) => [o.scope, o.status]), [
      [POSTS_TABLE, 'unavailable'], [TASKS_TABLE, 'unavailable'], [PERF_TABLE, 'unavailable'],
    ]);
    observations.forEach(assertValidObservation);
    assert.match(observations[0].note, /not a function/);
  });

  it('the selected columns exist in schema.sql or the weekly migration for all three tables', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'schema.sql'), 'utf8');
    const migration = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', '003_weekly_pipeline.sql'), 'utf8');
    const columnsOf = (source, table) => {
      const block = source.match(new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`))[1];
      return new Set(block.split('\n').map((l) => l.trim().match(/^([a-z_]+)\s/)).filter(Boolean).map((m) => m[1]));
    };
    const posts = columnsOf(schema, POSTS_TABLE);
    for (const col of POST_COLUMNS.split(',')) assert.ok(posts.has(col), `${POSTS_TABLE}.${col} missing from schema.sql`);
    const tasks = columnsOf(schema, TASKS_TABLE);
    for (const col of TASK_COLUMNS.split(',')) assert.ok(tasks.has(col), `${TASKS_TABLE}.${col} missing from schema.sql`);
    const perf = columnsOf(migration, PERF_TABLE);
    for (const col of PERF_COLUMNS.split(',')) assert.ok(perf.has(col), `${PERF_TABLE}.${col} missing from the weekly migration`);
  });

  it('a date-only since value is never affected by the host timezone (UTC arithmetic on the Chicago calendar date)', () => {
    // 2026-03-08 is the US DST switch; a week ending on it still subtracts exactly 7 calendar days.
    assert.equal(sinceDate(new Date('2026-03-09T02:00:00Z'), 1), '2026-03-01'); // Sun 2026-03-08 21:00 Chicago (CDT)
    assert.equal(sinceDate(new Date('2026-11-02T04:30:00Z'), 1), '2026-10-25'); // Sun 2026-11-01 23:30 Chicago (CDT → CST that day)
  });
});

// ── T9: the durable performance memory selection reads ────────────────────

describe('performance memory (T9)', () => {
  const row = (over = {}) => ({
    platform_post_id: 'p1', source: 'facebook', metric: 'fb_interactions', window_days: 7,
    value: 10, availability: 'ok', measured_at: '2026-09-02T00:00:00Z', ...over,
  });

  it('resolves one window per post: the 28-day row when it exists, else 7-day, newest measured_at first', () => {
    assert.deepEqual(resolvePerformanceMemory([
      row({ window_days: 7, value: 41, measured_at: '2026-09-02T00:00:00Z' }),
      row({ window_days: 28, value: 118, measured_at: '2026-09-23T00:00:00Z' }),
      row({ platform_post_id: 'p2', window_days: 7, value: 7, measured_at: '2026-09-02T00:00:00Z' }),
      row({ platform_post_id: 'p2', window_days: 7, value: 9, measured_at: '2026-09-09T00:00:00Z' }),
    ]), [
      { platform_post_id: 'p1', window_days: 28, metric: 'fb_interactions', value: 118, measured_at: '2026-09-23T00:00:00Z' },
      { platform_post_id: 'p2', window_days: 7, metric: 'fb_interactions', value: 9, measured_at: '2026-09-09T00:00:00Z' },
    ]);
  });

  it('treats an unavailable window as absent, never as zero engagement, and keeps a real zero', () => {
    assert.deepEqual(resolvePerformanceMemory([
      row({ window_days: 28, value: null, availability: 'unavailable' }),
      row({ window_days: 7, value: null, availability: 'unavailable' }),
      row({ platform_post_id: 'p2', window_days: 28, metric: 'fb_media_views', value: 0 }),
    ]), [{ platform_post_id: 'p2', window_days: 28, metric: 'fb_media_views', value: 0, measured_at: '2026-09-02T00:00:00Z' }]);
    assert.deepEqual(resolvePerformanceMemory([]), []);
    assert.deepEqual(resolvePerformanceMemory(null), []);
    assert.deepEqual(resolvePerformanceMemory([null, 'x', {}, row({ window_days: 14 }), row({ metric: 'fb_likes' })]), [], 'unknown windows and metrics are not evidence');
  });

  it('ignores Search Console rows and prefers interactions to media views inside one window', () => {
    const resolved = resolvePerformanceMemory([
      row({ source: 'search_console', metric: 'sc_clicks', window_days: 28, value: 3 }),
      row({ metric: 'fb_media_views', window_days: 28, value: 900 }),
      row({ metric: 'fb_interactions', window_days: 28, value: 12 }),
    ]);
    assert.deepEqual(resolved.map((r) => [r.metric, r.value]), [['fb_interactions', 12]]);
    // No source column (older rows): still Facebook memory, not silently dropped.
    assert.equal(resolvePerformanceMemory([row({ source: undefined })]).length, 1);
  });

  it('collectHistory reads the Facebook memory rows and exposes them on history.performance', async () => {
    const client = fixtureClient();
    const { history, observations } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });
    assert.deepEqual(history.performance, [
      { platform_post_id: 'fb-200', window_days: 28, metric: 'fb_interactions', value: 118, measured_at: '2026-09-23T14:00:00Z' },
    ]);
    const summary = observations.find((o) => o.metric === METRIC_SUMMARY && o.scope === PERF_TABLE);
    assert.deepEqual(summary.value, { table: PERF_TABLE, rows: MEMORY.length, weeks: 8, since: '2026-07-10' });
    assert.deepEqual(summary.period, { start: '2026-07-10', end: '2026-09-04' });
    assertValidObservation(summary);
    assertReadOnly(client);
  });

  it('a failing memory read is unavailable for that table only and never throws', async () => {
    const client = fixtureClient({ [PERF_TABLE]: { data: null, error: { message: 'permission denied for table performance_observations' } } });
    const { history, observations } = await collectHistory({ attemptId: ATTEMPT, supabase: client, now: NOW, policy });
    assert.deepEqual(history.performance, []);
    assert.equal(history.posts.length, 4);
    assert.equal(history.website_tasks.length, 3);
    const unavailable = observations.filter((o) => o.status === 'unavailable');
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0].scope, PERF_TABLE);
    assert.equal(unavailable[0].id, `hist:unavailable:${PERF_TABLE}`);
    assert.match(unavailable[0].note, /permission denied/);
    assertValidObservation(unavailable[0]);
  });
});
