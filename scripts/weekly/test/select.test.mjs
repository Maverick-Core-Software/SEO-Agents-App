import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CandidateSchema, SelectionSchema, parseOrIssues } from '../lib/schemas.mjs';
import { addDays, computeWeekSpec } from '../lib/week-spec.mjs';
import {
  DEFAULT_THRESHOLDS,
  SCORE_KEYS,
  buildCandidates,
  createServiceMatcher,
  detectCity,
  opportunityFromPosition,
  priorityScore,
  rankCandidates,
  selectionConstants,
} from '../lib/select.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'weekly-policy.json'), 'utf8'));
const scFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'collect-1-search-console.json'), 'utf8'));

// Friday 2026-09-04 at noon Chicago: run_friday 2026-09-04, week_of 2026-09-07 (month 9, no season entries).
const NOW = new Date('2026-09-04T17:00:00Z');
const RETRIEVED = NOW.toISOString();
const ATTEMPT = 'attempt-select-0001';
const weekSpec = computeWeekSpec({ anchor: '2026-09-04', now: NOW });
const CITY_WEIGHT = new Map(policy.cities.map((c) => [c.name, c.weight]));
const { weights: WEIGHTS } = selectionConstants(policy);

let seq = 0;

// ── Observation builders in the shapes the collectors emit ──────────────────

/** Search Console periods end two days before the run (the collector's lag). */
function scPeriod(days) {
  const end = addDays(weekSpec.run_friday, -2);
  return { start: addDays(end, -(days - 1)), end };
}

function scObs({ query, page, impressions = 0, clicks = 0, position, days = 28 }) {
  const dimensions = [query !== undefined && 'query', page !== undefined && 'page'].filter(Boolean);
  const value = { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position, window_days: days, dimensions };
  if (query !== undefined) value.query = query;
  if (page !== undefined) value.page = page;
  const scope = query !== undefined ? query : page;
  return {
    id: `sc:${days}d:${dimensions.join('+')}:${++seq}`,
    attempt_id: ATTEMPT,
    source: 'search_console',
    scope,
    geography: detectCity(scope, policy.cities),
    period: scPeriod(days),
    status: 'ok',
    metric: 'search_analytics',
    value,
    raw_ref: `search_console:sc-domain:grizzlyelectricaltx.com:${days}d`,
    retrieved_at: RETRIEVED,
    note: null,
  };
}

function serpObs({ query, service_key, city, paa = [], local_pack = [], grizzly_in_local_pack = false, grizzly_organic_position = null }) {
  return {
    id: `serp:${++seq}`,
    attempt_id: ATTEMPT,
    source: 'serpapi',
    scope: query,
    geography: city,
    period: null,
    status: 'ok',
    metric: 'serp',
    value: {
      query, service_key, city, template: '', location: policy.serp.location, from_cache: false, fetched_at: RETRIEVED,
      organic: [], paa, local_pack, grizzly_organic_position, grizzly_in_local_pack,
    },
    raw_ref: `cache:${seq}`,
    retrieved_at: RETRIEVED,
    note: null,
  };
}

function fbObs({ id, impressions = null, reach = null, engaged = null, reactions = 0, comments = 0, shares = 0, message = '' }) {
  return {
    id: `fb:${id}`,
    attempt_id: ATTEMPT,
    source: 'facebook',
    scope: id,
    geography: detectCity(message, policy.cities),
    period: scPeriod(28),
    status: 'ok',
    metric: 'post_engagement',
    value: { impressions, reach, engaged, reactions, comments, shares, created_time: '2026-08-26T15:00:00+0000', message_excerpt: message },
    raw_ref: `graph:${id}`,
    retrieved_at: RETRIEVED,
    note: null,
  };
}

function unavailable(source, note) {
  const metric = { search_console: 'search_analytics', serpapi: 'serp', facebook: 'post_engagement' }[source];
  return {
    id: `${source}:unavailable`,
    attempt_id: ATTEMPT,
    source,
    scope: source === 'search_console' ? 'sites' : 'page',
    geography: null,
    period: null,
    status: 'unavailable',
    metric,
    value: null,
    raw_ref: null,
    retrieved_at: RETRIEVED,
    note,
  };
}

/** Every pull of the collect-1 fixture as ok observations (query, page and query+page rows). */
function fixtureObservations(fixture) {
  const out = [];
  for (const [key, pull] of Object.entries(fixture.pulls)) {
    const [days, dims] = key.split(':');
    const dimensions = dims.split(',');
    for (const row of pull.rows) {
      const query = dimensions.includes('query') ? row.keys[dimensions.indexOf('query')] : undefined;
      const page = dimensions.includes('page') ? row.keys[dimensions.indexOf('page')] : undefined;
      out.push(scObs({ query, page, impressions: row.impressions, clicks: row.clicks, position: row.position, days: Number(days) }));
    }
  }
  return out;
}

/** A history post in collectHistory's shape. `city` is only present when given. */
function post({ platform = 'gbp', post_date, service, hook = '', status = 'posted', platform_post_id = null, photo_file = null, city }) {
  const row = { platform, post_date, service, hook, status, platform_post_id, photo_file };
  if (city !== undefined) row.city = city;
  return row;
}

// ── Assertion helpers ───────────────────────────────────────────────────────

function rank(overrides = {}) {
  return rankCandidates({ policy, observations: [], history: { posts: [], website_tasks: [] }, facts: null, weekSpec, ...overrides });
}

function pick(selection, key, city) {
  const all = [...selection.ranked, ...selection.excluded.map((e) => e.candidate)];
  const found = all.find((c) => c.service_key === key && c.city === city);
  assert.ok(found, `candidate ${key}/${city} is present`);
  return found;
}

function reason(candidate, key) {
  return candidate.reasons.find((r) => r.startsWith(`${key}: `)) || '';
}

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message || 'value'}: expected ${expected}, got ${actual}`);
}

function assertSelection(selection) {
  const { issues } = parseOrIssues(SelectionSchema, selection);
  assert.deepEqual(issues, [], `selection failed schema: ${JSON.stringify(issues.slice(0, 5))}`);
}

function weightedSum(candidate) {
  return SCORE_KEYS.reduce((acc, k) => acc + WEIGHTS[k] * candidate.scores[k], 0);
}

// ── buildCandidates ─────────────────────────────────────────────────────────

describe('buildCandidates', () => {
  it('builds one schema-valid skeleton per service × city with the family filled from the templates', () => {
    const candidates = buildCandidates(policy);
    assert.equal(candidates.length, policy.services.length * policy.cities.length);
    assert.equal(new Set(candidates.map((c) => `${c.service_key}|${c.city}`)).size, candidates.length, 'pairs are unique');
    for (const c of candidates) {
      const { issues } = parseOrIssues(CandidateSchema, c);
      assert.deepEqual(issues, [], `${c.service_key}/${c.city}: ${JSON.stringify(issues)}`);
    }
    const wylie = candidates.find((c) => c.service_key === 'ev_charger' && c.city === 'Wylie');
    assert.equal(wylie.service_label, 'EV Charger Installation');
    assert.deepEqual(wylie.query_family, [
      'ev charger installation wylie',
      'tesla charger installer wylie tx',
      'level 2 charger install wylie',
    ]);
    assert.deepEqual(wylie.scores, { priority: 1, demand: 0, opportunity: 0, recency: 1, season: 0.5, performance: 0.5 });
    assert.equal(wylie.total, 0);
    assert.deepEqual(wylie.reasons, []);
  });

  it('maps priority 1–5 onto 0.2–1.0 and clamps anything else', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map((p) => priorityScore(p)), [0.2, 0.4, 0.6, 0.8, 1]);
    assert.equal(priorityScore(9), 1);
    assert.equal(priorityScore(0), 0.2);
    assert.equal(priorityScore('n/a'), 0.2);
    const smoke = buildCandidates(policy).find((c) => c.service_key === 'smoke_co');
    assert.equal(smoke.scores.priority, 0.4);
  });

  it('limits cities by tier when asked, from the option or policy.selection.city_tiers', () => {
    const tierOne = buildCandidates(policy, { cityTiers: [1] });
    const tierOneCities = policy.cities.filter((c) => c.tier === 1).length;
    assert.equal(tierOne.length, policy.services.length * tierOneCities);
    assert.ok(!tierOne.some((c) => c.city === 'Plano'), 'tier 2 city is excluded');

    const fromPolicy = buildCandidates({ ...policy, selection: { city_tiers: [1, 2] } });
    const tierTwoCities = policy.cities.filter((c) => c.tier <= 2).length;
    assert.equal(fromPolicy.length, policy.services.length * tierTwoCities);
    assert.ok(!fromPolicy.some((c) => c.city === 'Denton'), 'tier 3 city is excluded');
  });
});

// ── Service and city matching ───────────────────────────────────────────────

describe('createServiceMatcher / detectCity', () => {
  it('maps queries, labels and hooks to the most specific service, ignoring city and filler words', () => {
    const { match, isKey } = createServiceMatcher(policy, DEFAULT_THRESHOLDS);
    assert.equal(match('electrician rowlett tx'), 'troubleshooting');
    assert.equal(match('panel upgrade fort worth'), 'panel_upgrade');
    assert.equal(match('ev charger installation royse city'), 'ev_charger');
    assert.equal(match('generator interlock wylie tx'), 'generator');
    assert.equal(match('EV Charger Installation'), 'ev_charger');
    assert.equal(match('Electrical Panel Upgrade / Replacement'), 'panel_upgrade');
    assert.equal(match('rowlett tx'), null, 'a city alone names no service');
    assert.equal(match(''), null);
    assert.ok(isKey('generator'));
    assert.ok(!isKey('EV Charger Installation'));
  });

  it('prefers the service whose matched tokens are specific to it when hit counts tie', () => {
    const { match } = createServiceMatcher(policy, DEFAULT_THRESHOLDS);
    // "electrical" belongs to panel, troubleshooting and inspection; "commercial" only to commercial.
    assert.equal(match('Commercial electrical'), 'commercial');
    assert.equal(match('commercial electrical rowlett'), 'commercial');
    assert.equal(match('Light Commercial Electrical'), 'commercial');
    assert.equal(match('electrical repair garland'), 'troubleshooting');
    assert.equal(match('electrical'), 'troubleshooting', 'a lone weak token still falls to the first eligible service');
    assert.equal(match('ev charger electrician plano'), 'ev_charger', 'two hits beat one specific hit');
  });

  it('maps the legacy schedules\' service labels to policy keys', () => {
    const { match } = createServiceMatcher(policy, DEFAULT_THRESHOLDS);
    const legacy = {
      'Whole-home surge protection': 'surge_protection',
      'Panel upgrade / replacement': 'panel_upgrade',
      'EV charger installation': 'ev_charger',
      'Generator inlet / interlock installation': 'generator',
      'Electrical troubleshooting / repair': 'troubleshooting',
      'Recessed lighting installation': 'recessed_lighting',
      'Commercial electrical': 'commercial',
    };
    for (const [label, key] of Object.entries(legacy)) assert.equal(match(label), key, label);
  });

  it('detects whole-word policy cities, earliest mention first (the collectors\' rule), ties to the longer name', () => {
    assert.equal(detectCity('electrician in Dallas-Fort Worth', policy.cities), 'Dallas', 'collect-1 tags this query Dallas; select must agree');
    assert.equal(detectCity('Rowlett to Fort Worth, we have you covered', policy.cities), 'Rowlett');
    assert.equal(detectCity('fort worth electrician', [{ name: 'Fort' }, { name: 'Fort Worth' }]), 'Fort Worth', 'same start: longer name wins');
    assert.equal(detectCity('ev charger installation royse city', policy.cities), 'Royse City');
    assert.equal(detectCity('/fort-worth-electrician/', policy.cities), 'Fort Worth', 'URL separators count as spaces');
    assert.equal(detectCity('heather lighting ideas', policy.cities), null, 'Heath must not match inside "heather"');
    assert.equal(detectCity('', policy.cities), null);
  });
});

// ── Opportunity from Search Console position ────────────────────────────────

describe('rankCandidates: opportunity from Search Console position', () => {
  it('scores positions 5, 12 and 40 as 0.3, 1.0 and 0.6 for three different query families, and 0 with no data', () => {
    const observations = [
      scObs({ query: 'electrician rowlett tx', impressions: 340, clicks: 12, position: 5 }),
      scObs({ query: 'electrical panel upgrade garland', impressions: 120, clicks: 3, position: 12 }),
      scObs({ query: 'generator interlock wylie tx', impressions: 70, clicks: 1, position: 40 }),
    ];
    const selection = rank({ observations });
    assertSelection(selection);
    assert.equal(selection.degraded, false);

    const troubleshooting = pick(selection, 'troubleshooting', 'Rowlett');
    assert.equal(troubleshooting.scores.opportunity, 0.3);
    assert.match(reason(troubleshooting, 'opportunity'), /avg position 5\.0 .*already high on page 1/);

    const panel = pick(selection, 'panel_upgrade', 'Garland');
    assert.equal(panel.scores.opportunity, 1);
    assert.match(reason(panel, 'opportunity'), /avg position 12\.0 .*page 1 bottom to page 3/);

    const generator = pick(selection, 'generator', 'Wylie');
    assert.equal(generator.scores.opportunity, 0.6);
    assert.match(reason(generator, 'opportunity'), /avg position 40\.0 .*beyond page 3/);

    const noData = pick(selection, 'surge_protection', 'Plano');
    assert.equal(noData.scores.opportunity, 0);
    assert.match(reason(noData, 'opportunity'), /no Search Console position data/);
  });

  it('treats the 8–30 band as inclusive', () => {
    assert.equal(opportunityFromPosition(8), 1);
    assert.equal(opportunityFromPosition(30), 1);
    assert.equal(opportunityFromPosition(7.99), 0.3);
    assert.equal(opportunityFromPosition(30.01), 0.6);
    assert.equal(opportunityFromPosition(null), 0);
    assert.equal(opportunityFromPosition(Number.NaN), 0);
  });

  it('keeps a city-specific query inside its city and lets a city-less query count for every city of the service', () => {
    const observations = [
      scObs({ query: 'electrician rowlett tx', impressions: 200, clicks: 5, position: 15 }),
      scObs({ query: 'electrical panel upgrade', impressions: 100, clicks: 2, position: 20 }),
    ];
    const selection = rank({ observations });
    assert.equal(pick(selection, 'troubleshooting', 'Rowlett').scores.opportunity, 1);
    assert.equal(pick(selection, 'troubleshooting', 'Garland').scores.opportunity, 0, 'Rowlett data does not leak into Garland');
    assert.equal(pick(selection, 'panel_upgrade', 'Plano').scores.opportunity, 1);
    assert.equal(pick(selection, 'panel_upgrade', 'Denton').scores.opportunity, 1);
    near(pick(selection, 'panel_upgrade', 'Plano').scores.demand, 0.5, 'city-less impressions count for every city');
  });
});

// ── Demand from Search Console impressions ──────────────────────────────────

describe('rankCandidates: demand from the collect-1 Search Console fixture', () => {
  const observations = fixtureObservations(scFixture);
  const selection = rank({ observations });

  it('normalizes 28-day impressions by the max across candidates', () => {
    assertSelection(selection);
    assert.equal(selection.degraded, false);
    const rowlett = pick(selection, 'troubleshooting', 'Rowlett');
    assert.equal(rowlett.scores.demand, 1);
    assert.match(reason(rowlett, 'demand'), /28d impressions 340 \(1\.00 of max\)/);
    near(pick(selection, 'panel_upgrade', 'Fort Worth').scores.demand, 80 / 340, 'panel upgrade Fort Worth');
    near(pick(selection, 'ev_charger', 'Royse City').scores.demand, 45 / 340, 'ev charger Royse City');
    near(pick(selection, 'troubleshooting', 'Dallas').scores.demand, 60 / 340, 'Dallas-Fort Worth query lands in Dallas, as collect-1 tags it');
    assert.equal(pick(selection, 'troubleshooting', 'Fort Worth').scores.demand, 0, 'no family rows for Fort Worth');
    assert.equal(pick(selection, 'surge_protection', 'Plano').scores.demand, 0);
  });

  it('does not double count query+page rows or page-only rows', () => {
    const rowlett = pick(selection, 'troubleshooting', 'Rowlett');
    assert.match(reason(rowlett, 'demand'), /impressions 340 /, 'the 300-impression query+page row is not added');
    assert.match(reason(rowlett, 'opportunity'), /across 340 impressions/);
  });

  it('keeps the 90-day window out of demand but uses it for position when the 28-day window has none', () => {
    const generator = pick(selection, 'generator', 'Wylie');
    assert.equal(generator.scores.demand, 0);
    assert.match(reason(generator, 'demand'), /no Search Console impressions/);
    assert.equal(generator.scores.opportunity, 0.3);
    assert.match(reason(generator, 'opportunity'), /avg position 6\.9 across 70 impressions/);
  });

  it('carries the real fixture to a winner with page 1–3 opportunity and a runner-up', () => {
    // troubleshooting/Dallas: priority 1, position 12.3 (opportunity 1), 60 impressions, city weight 1.1.
    assert.equal(selection.winner.service_key, 'troubleshooting');
    assert.equal(selection.winner.city, 'Dallas');
    assert.equal(selection.winner.scores.opportunity, 1);
    assert.equal(selection.ranked[1].service_key, 'ev_charger');
    assert.equal(selection.ranked[1].city, 'Royse City');
    assert.ok(selection.winner.total > selection.ranked[1].total);
    assert.match(selection.rationale, /SerpApi unavailable/);
  });
});

// ── SerpApi signals ─────────────────────────────────────────────────────────

describe('rankCandidates: SerpApi local pack and People Also Ask', () => {
  it('adds 0.2 opportunity when the local pack for the city lacks Grizzly, capped at 1, and says so', () => {
    const competitors = [
      { title: 'Ace Electric', rating: 4.8, reviews: 120 },
      { title: 'Volt Pros', rating: 4.6, reviews: 80 },
      { title: 'Bright Spark Electricians', rating: 4.9, reviews: 45 },
    ];
    const observations = [
      scObs({ query: 'ev charger installation wylie', impressions: 100, clicks: 4, position: 5 }),
      scObs({ query: 'electrical panel upgrade wylie', impressions: 90, clicks: 2, position: 12 }),
      serpObs({ query: 'ev charger installation wylie', service_key: 'ev_charger', city: 'Wylie', local_pack: competitors, grizzly_in_local_pack: false }),
      serpObs({ query: 'electrical panel upgrade wylie', service_key: 'panel_upgrade', city: 'Wylie', local_pack: competitors, grizzly_in_local_pack: false }),
      serpObs({ query: 'ev charger installation murphy', service_key: 'ev_charger', city: 'Murphy', local_pack: [competitors[0], { title: 'Grizzly Electrical Solutions', rating: 5, reviews: 60 }], grizzly_in_local_pack: true }),
      serpObs({ query: 'ev charger installation sachse', service_key: 'ev_charger', city: 'Sachse', local_pack: [], grizzly_in_local_pack: false }),
    ];
    const selection = rank({ observations });
    assertSelection(selection);
    assert.equal(selection.degraded, false);

    const wylie = pick(selection, 'ev_charger', 'Wylie');
    near(wylie.scores.opportunity, 0.5, 'position 5 (0.3) + local pack bonus');
    assert.match(reason(wylie, 'opportunity'), /\+0\.2 local pack in Wylie lacks Grizzly/);

    const capped = pick(selection, 'panel_upgrade', 'Wylie');
    assert.equal(capped.scores.opportunity, 1, 'position 12 already scores 1.0; the bonus cannot exceed it');
    assert.match(reason(capped, 'opportunity'), /lacks Grizzly/);

    const murphy = pick(selection, 'ev_charger', 'Murphy');
    assert.equal(murphy.scores.opportunity, 0, 'Grizzly is in the Murphy pack');
    assert.doesNotMatch(reason(murphy, 'opportunity'), /lacks Grizzly/);

    const sachse = pick(selection, 'ev_charger', 'Sachse');
    assert.equal(sachse.scores.opportunity, 0, 'an empty local pack is not evidence of absence');

    const plano = pick(selection, 'ev_charger', 'Plano');
    assert.equal(plano.scores.opportunity, 0, 'the Wylie pack says nothing about Plano');
  });

  it('adds 0.2 demand when SerpApi shows People Also Ask for the family, capped at 1', () => {
    const observations = [
      scObs({ query: 'ev charger installation wylie', impressions: 100, clicks: 4, position: 15 }),
      scObs({ query: 'tesla charger installer plano tx', impressions: 50, clicks: 1, position: 15 }),
      scObs({ query: 'home generator installation plano', impressions: 40, clicks: 1, position: 15 }),
      serpObs({ query: 'ev charger installation wylie', service_key: 'ev_charger', city: 'Wylie', paa: ['How much does it cost to install an EV charger in Wylie?'] }),
      serpObs({ query: 'ev charger installation plano', service_key: 'ev_charger', city: 'Plano', paa: ['Do I need a permit for a Level 2 charger?'] }),
      serpObs({ query: 'home generator installation plano', service_key: 'generator', city: 'Plano', paa: [] }),
    ];
    const selection = rank({ observations });
    assertSelection(selection);
    const wylie = pick(selection, 'ev_charger', 'Wylie');
    assert.equal(wylie.scores.demand, 1, '1.0 + 0.2 caps at 1');
    assert.match(reason(wylie, 'demand'), /\+0\.2 People Also Ask on "ev charger installation wylie"/);
    near(pick(selection, 'ev_charger', 'Plano').scores.demand, 0.5 + 0.2, 'Plano gets base 0.5 plus PAA');
    near(pick(selection, 'generator', 'Plano').scores.demand, 0.4, 'no PAA, no bonus');
    assert.doesNotMatch(reason(pick(selection, 'generator', 'Plano'), 'demand'), /People Also Ask/);
  });

  it('is not degraded when only SerpApi answered, and the rationale names the missing source', () => {
    const observations = [
      unavailable('search_console', 'Search Console token refresh failed'),
      serpObs({ query: 'electrician rockwall tx', service_key: 'troubleshooting', city: 'Rockwall', local_pack: [{ title: 'Ace Electric', rating: 4.8, reviews: 120 }], grizzly_in_local_pack: false, paa: ['How much does an electrician cost?'] }),
    ];
    const selection = rank({ observations });
    assertSelection(selection);
    assert.equal(selection.degraded, false);
    const rockwall = pick(selection, 'troubleshooting', 'Rockwall');
    near(rockwall.scores.demand, 0.2, 'PAA only');
    near(rockwall.scores.opportunity, 0.2, 'local pack only');
    assert.equal(pick(selection, 'troubleshooting', 'Denton').scores.demand, 0.2, 'PAA for the service carries to cities without their own SERP');
    assert.equal(pick(selection, 'surge_protection', 'Denton').scores.opportunity, 0, 'no fallback to 0.5 outside the degraded path');
    assert.match(selection.rationale, /Search Console unavailable/);
    assert.doesNotMatch(selection.rationale, /degraded/);
  });
});

// ── Recency from history ────────────────────────────────────────────────────

describe('rankCandidates: recency from history', () => {
  it('scores a recent same-service post 0.5, same service and city 0.1, and never published 1.0', () => {
    const history = {
      posts: [
        post({ post_date: '2026-08-28', service: 'EV Charger Installation', hook: 'Charging at home in Rowlett just got easier', platform_post_id: 'gbp-100', photo_file: 'ev-charger-garage.jpg', city: 'Rowlett' }),
        post({ post_date: '2026-07-20', service: 'Recessed Lighting Installation', hook: 'Brighter kitchens in Fort Worth homes', platform_post_id: 'gbp-90', city: 'Fort Worth' }),
      ],
      website_tasks: [],
    };
    const selection = rank({ history });
    assertSelection(selection);

    const sameCity = pick(selection, 'ev_charger', 'Rowlett');
    assert.equal(sameCity.scores.recency, 0.1);
    assert.match(reason(sameCity, 'recency'), /same service and city posted 2026-08-28/);

    const sameService = pick(selection, 'ev_charger', 'Garland');
    assert.equal(sameService.scores.recency, 0.5);
    assert.match(reason(sameService, 'recency'), /same service posted 2026-08-28 \(Rowlett\)/);

    const never = pick(selection, 'generator', 'Rowlett');
    assert.equal(never.scores.recency, 1);
    assert.match(reason(never, 'recency'), /not published in the last 4 weeks/);

    const outsideWindow = pick(selection, 'recessed_lighting', 'Fort Worth');
    assert.equal(outsideWindow.scores.recency, 1, '46 days ago is outside policy.recency_weeks');
  });

  it('infers the city from the hook, ignores posts that never went out, and ignores this week\'s slots per platform', () => {
    const history = {
      posts: [
        post({ platform: 'facebook', post_date: '2026-08-26', service: 'Electrical Panel Upgrade / Replacement', hook: 'Is your panel keeping up? Garland homeowners ask us every week', platform_post_id: 'fb-200' }),
        post({ platform: 'facebook', post_date: '2026-08-24T00:00:00', service: 'Generator Inlet, Interlock & Installation', status: 'skipped' }),
        // GBP day 1 is run_friday: this week's slot.
        post({ post_date: weekSpec.run_friday, service: 'Whole-Home Surge Protection', hook: 'Storm season is here, Plano', city: 'Plano' }),
        // Facebook weeks start on week_of: last week's Friday post is dated run_friday and still counts.
        post({ platform: 'facebook', post_date: weekSpec.run_friday, service: 'Ceiling Fan Installation', hook: 'Cooler rooms in Sachse', city: 'Sachse' }),
        post({ platform: 'facebook', post_date: addDays(weekSpec.run_friday, 1), service: 'Ceiling Fan Installation', hook: 'Saturday fan swap in Wylie', city: 'Wylie' }),
        // This week's Monday Facebook slot.
        post({ platform: 'facebook', post_date: weekSpec.week_of, service: 'Smoke & CO Detector Installation', city: 'Sachse' }),
      ],
      website_tasks: [],
    };
    const selection = rank({ history });
    assert.equal(pick(selection, 'panel_upgrade', 'Garland').scores.recency, 0.1);
    assert.equal(pick(selection, 'panel_upgrade', 'Sachse').scores.recency, 0.5);
    assert.equal(pick(selection, 'generator', 'Rowlett').scores.recency, 1, 'a skipped post never went out');
    assert.equal(pick(selection, 'surge_protection', 'Plano').scores.recency, 1, 'a GBP post dated on run_friday belongs to this week');
    assert.equal(pick(selection, 'ceiling_fan', 'Sachse').scores.recency, 0.1, 'last week\'s Friday Facebook post counts');
    assert.equal(pick(selection, 'ceiling_fan', 'Wylie').scores.recency, 0.1, 'last week\'s Saturday Facebook post counts');
    assert.match(reason(pick(selection, 'ceiling_fan', 'Wylie'), 'recency'), new RegExp(`posted ${addDays(weekSpec.run_friday, 1)}`));
    assert.equal(pick(selection, 'smoke_co', 'Sachse').scores.recency, 1, 'a Facebook post dated week_of is this week\'s slot');
  });

  it('honours policy.recency_weeks', () => {
    const history = { posts: [post({ post_date: '2026-08-14', service: 'EV Charger Installation', city: 'Rowlett' })], website_tasks: [] };
    assert.equal(pick(rank({ history }), 'ev_charger', 'Rowlett').scores.recency, 0.1, '21 days is inside 4 weeks');
    assert.equal(pick(rank({ history, policy: { ...policy, recency_weeks: 2 } }), 'ev_charger', 'Rowlett').scores.recency, 1, '21 days is outside 2 weeks');
  });
});

// ── Exclusion of recent winners ─────────────────────────────────────────────

describe('rankCandidates: exclusion of the last two weeks\' winners', () => {
  it('excludes every city of a service that dominated a recent week, with a reason, and mentions it in the rationale', () => {
    const history = {
      posts: [
        post({ post_date: '2026-08-31', service: 'EV Charger Installation', city: 'Rowlett' }),
        post({ post_date: '2026-09-01', service: 'EV Charger Installation', city: 'Rockwall' }),
        post({ post_date: '2026-09-02', service: 'EV Charger Installation', city: 'Wylie' }),
        post({ post_date: '2026-09-01', service: 'Electrical Panel Upgrade / Replacement', city: 'Garland' }),
      ],
      website_tasks: [],
    };
    const selection = rank({ history });
    assertSelection(selection);
    assert.equal(selection.excluded.length, policy.cities.length);
    assert.ok(selection.excluded.every((e) => e.candidate.service_key === 'ev_charger'));
    assert.ok(!selection.ranked.some((c) => c.service_key === 'ev_charger'));
    assert.match(selection.excluded[0].reason, /winner in the last 2 weeks \(3 posts, last 2026-09-02\)/);
    assert.notEqual(selection.winner.service_key, 'ev_charger');
    assert.match(selection.rationale, /Excluded because the service was the winner in the last 2 weeks: EV Charger Installation\./);
    assert.equal(pick(selection, 'panel_upgrade', 'Garland').scores.recency, 0.1, 'a single post is not a winner but still counts for recency');
  });

  it('does not infer a winner from a legacy week that rotates one service per day', () => {
    const services = ['EV Charger Installation', 'Electrical Panel Upgrade / Replacement', 'Generator Inlet, Interlock & Installation', 'Recessed Lighting Installation', 'Whole-Home Surge Protection'];
    const posts = services.map((service, i) => post({ post_date: addDays('2026-08-29', i), service, city: 'Rowlett' }));
    const selection = rank({ history: { posts, website_tasks: [] } });
    assert.deepEqual(selection.excluded, []);
    assert.doesNotMatch(selection.rationale, /Excluded/);
  });

  it('does not infer a winner from a real legacy week: 7 rotating GBP services plus 4 Facebook posts that reuse them', () => {
    // Shape of outputs/gbp_posting_schedule.md and facebook_posting_schedule.md for the week before run_friday.
    const gbpStart = addDays(weekSpec.run_friday, -7);
    const fbWeekOf = addDays(weekSpec.week_of, -7);
    const gbp = ['Whole-home surge protection', 'Panel upgrade / replacement', 'EV charger installation', 'Generator inlet / interlock installation', 'Electrical troubleshooting / repair', 'Recessed lighting installation', 'Commercial electrical']
      .map((service, i) => post({ post_date: addDays(gbpStart, i), service, hook: `Day ${i + 1} in Rowlett` }));
    const fb = [
      post({ platform: 'facebook', post_date: fbWeekOf, service: 'Whole-Home Surge Protection', hook: 'Storm season prep for Garland homes' }),
      post({ platform: 'facebook', post_date: addDays(fbWeekOf, 2), service: 'Electrical Panel Upgrade / Replacement', hook: 'Is your panel keeping up?' }),
      post({ platform: 'facebook', post_date: addDays(fbWeekOf, 4), service: 'Electrical Troubleshooting / Repair', hook: 'Flickering lights in Rockwall?' }),
      post({ platform: 'facebook', post_date: addDays(fbWeekOf, 5), service: 'Recessed Lighting Installation', hook: 'Weekend kitchen glow-up' }),
    ];
    assert.equal(addDays(fbWeekOf, 4), weekSpec.run_friday, 'the legacy Friday Facebook post is dated on run_friday');
    const selection = rank({ history: { posts: [...gbp, ...fb], website_tasks: [] } });
    assertSelection(selection);
    assert.deepEqual(selection.excluded, [], 'four services with two posts each is a rotation, not a winner');
    assert.doesNotMatch(selection.rationale, /Excluded/);
    assert.equal(pick(selection, 'troubleshooting', 'Rockwall').scores.recency, 0.1, 'the Friday Facebook post still counted for recency');
    assert.equal(pick(selection, 'troubleshooting', 'Garland').scores.recency, 0.5);
    assert.equal(pick(selection, 'ceiling_fan', 'Rowlett').scores.recency, 1);
  });

  it('infers the winner of a new-pipeline week, counting last week\'s Friday and Saturday Facebook posts', () => {
    const gbpStart = addDays(weekSpec.run_friday, -7);
    const fbWeekOf = addDays(weekSpec.week_of, -7);
    const gbp = ['EV Charger Installation', 'Electrical Panel Upgrade / Replacement', 'EV Charger Installation', 'Generator Inlet, Interlock & Installation', 'Whole-Home Surge Protection', 'EV Charger Installation', 'Recessed Lighting Installation']
      .map((service, i) => post({ post_date: addDays(gbpStart, i), service, city: 'Wylie' }));
    const fb = [0, 2, 4, 5].map((offset) => post({ platform: 'facebook', post_date: addDays(fbWeekOf, offset), service: 'EV Charger Installation', city: 'Wylie' }));
    const selection = rank({ history: { posts: [...gbp, ...fb], website_tasks: [] } });
    assertSelection(selection);
    assert.ok(selection.excluded.length > 0);
    assert.ok(selection.excluded.every((e) => e.candidate.service_key === 'ev_charger'));
    assert.match(selection.excluded[0].reason, new RegExp(`\\(7 posts, last ${addDays(fbWeekOf, 5)}\\)`), 'three GBP days plus all four Facebook posts, the last on Saturday after run_friday');
    assert.ok(!selection.ranked.some((c) => c.service_key === 'ev_charger'));
  });

  it('infers nothing when two services tie for the most posts in a week', () => {
    const gbpStart = addDays(weekSpec.run_friday, -7);
    const posts = ['EV Charger Installation', 'Electrical Panel Upgrade / Replacement', 'EV Charger Installation', 'Electrical Panel Upgrade / Replacement', 'EV Charger Installation', 'Electrical Panel Upgrade / Replacement', 'Generator Inlet, Interlock & Installation']
      .map((service, i) => post({ post_date: addDays(gbpStart, i), service, city: 'Wylie' }));
    const selection = rank({ history: { posts, website_tasks: [] } });
    assert.deepEqual(selection.excluded, []);
    assert.equal(pick(selection, 'ev_charger', 'Wylie').scores.recency, 0.1, 'recency still sees the posts');
  });

  it('honours explicit history.winners inside the window and ignores older ones', () => {
    const history = {
      posts: [],
      website_tasks: [],
      winners: [
        { week_of: '2026-08-31', service_key: 'generator' },
        { week_of: '2026-08-03', service_key: 'panel_upgrade' },
      ],
    };
    const selection = rank({ history });
    assert.ok(selection.excluded.length > 0);
    assert.ok(selection.excluded.every((e) => e.candidate.service_key === 'generator'));
    assert.match(selection.excluded[0].reason, /selected for week of 2026-08-31/);
    assert.ok(selection.ranked.some((c) => c.service_key === 'panel_upgrade'), 'five weeks ago is outside the window');
  });

  it('accepts a service label in history.winners and ignores entries it cannot read', () => {
    const history = {
      posts: [],
      website_tasks: [],
      winners: [
        { week_of: '2026-08-31', service_key: 'EV Charger Installation' },
        { week_of: '2026-08-24', service_key: 'not a service' },
        { week_of: '2026-09-07', service_key: 'generator' },
        null,
        { week_of: 'garbage', service_key: 'panel_upgrade' },
      ],
    };
    const selection = rank({ history });
    assertSelection(selection);
    assert.ok(selection.excluded.length > 0);
    assert.ok(selection.excluded.every((e) => e.candidate.service_key === 'ev_charger'), 'the label maps to ev_charger');
    assert.ok(selection.ranked.some((c) => c.service_key === 'generator'), 'this week\'s own winner (a re-run) is not excluded');
    assert.ok(selection.ranked.some((c) => c.service_key === 'panel_upgrade'));
  });
});

// ── Degraded path ───────────────────────────────────────────────────────────

describe('rankCandidates: degraded selection', () => {
  it('falls back to 0.5 demand and opportunity when Search Console and SerpApi are both unavailable, and says so', () => {
    const observations = [
      unavailable('search_console', 'Search Console token refresh failed (401)'),
      unavailable('serpapi', 'SERPAPI_API_KEY not configured'),
      unavailable('facebook', 'FB_PAGE_TOKEN expired'),
    ];
    const selection = rank({ observations });
    assertSelection(selection);
    assert.equal(selection.degraded, true);
    for (const c of selection.ranked) {
      assert.equal(c.scores.demand, 0.5, `${c.service_key}/${c.city} demand`);
      assert.equal(c.scores.opportunity, 0.5, `${c.service_key}/${c.city} opportunity`);
      assert.match(reason(c, 'demand'), /Search Console and SerpApi unavailable; defaulted to 0\.50/);
    }
    assert.match(selection.rationale, /Search Console and SerpApi were both unavailable, so demand and opportunity defaulted to 0\.50/);
    assert.match(selection.rationale, /degraded selection/);
    assert.match(selection.rationale, /Facebook insights unavailable/);
    assert.match(selection.rationale, /^Winner: /);
  });

  it('treats an empty observation list as degraded and still ranks on priority, recency, season and city weight', () => {
    const selection = rank();
    assert.equal(selection.degraded, true);
    assert.equal(selection.ranked.length, policy.services.length * policy.cities.length);
    assert.equal(selection.winner.scores.priority, 1);
    assert.equal(selection.winner.city, 'Frisco', 'the heaviest city wins on equal evidence');
  });

  it('is not degraded when Search Console answered, even if SerpApi did not', () => {
    const observations = [
      scObs({ query: 'electrician rowlett tx', impressions: 300, clicks: 10, position: 4 }),
      unavailable('serpapi', 'cap reached'),
    ];
    const selection = rank({ observations });
    assert.equal(selection.degraded, false);
    assert.equal(pick(selection, 'surge_protection', 'Plano').scores.demand, 0, 'no 0.5 fallback');
  });
});

// ── City weight and total ───────────────────────────────────────────────────

describe('rankCandidates: city weight multiplies the total', () => {
  it('sets total = round4(Σ weights × scores × city weight) for every candidate and says so in the reasons', () => {
    const observations = [...fixtureObservations(scFixture), fbObs({ id: 'fb-200', reach: 1000, engaged: 80 })];
    const history = {
      posts: [
        post({ post_date: '2026-08-28', service: 'EV Charger Installation', city: 'Rowlett' }),
        post({ platform: 'facebook', post_date: '2026-08-26', service: 'Electrical Panel Upgrade / Replacement', platform_post_id: 'fb-200', city: 'Garland' }),
      ],
      website_tasks: [],
    };
    const selection = rank({ observations, history });
    assertSelection(selection);
    const all = [...selection.ranked, ...selection.excluded.map((e) => e.candidate)];
    assert.equal(all.length, policy.services.length * policy.cities.length);
    for (const c of all) {
      const weight = CITY_WEIGHT.get(c.city);
      const expected = Math.round(weightedSum(c) * weight * 10000) / 10000;
      near(c.total, expected, `${c.service_key}/${c.city} total`);
      assert.match(reason(c, 'total'), new RegExp(`× city weight ${String(weight).replace('.', '\\.')} = `));
    }
  });

  it('ranks the same service higher in a heavier city when the evidence is equal', () => {
    const selection = rank();
    const frisco = pick(selection, 'ev_charger', 'Frisco');
    const murphy = pick(selection, 'ev_charger', 'Murphy');
    const rowlett = pick(selection, 'ev_charger', 'Rowlett');
    assert.deepEqual(frisco.scores, murphy.scores);
    near(frisco.total / murphy.total, CITY_WEIGHT.get('Frisco') / CITY_WEIGHT.get('Murphy'), 'Frisco / Murphy');
    near(rowlett.total / murphy.total, CITY_WEIGHT.get('Rowlett') / CITY_WEIGHT.get('Murphy'), 'Rowlett / Murphy');
    assert.ok(frisco.total > murphy.total && murphy.total > rowlett.total);
    for (let i = 1; i < selection.ranked.length; i += 1) {
      assert.ok(selection.ranked[i - 1].total >= selection.ranked[i].total, 'ranked is sorted by total, descending');
    }
  });

  it('applies a changed city weight from the policy', () => {
    const heavyRowlett = { ...policy, cities: policy.cities.map((c) => (c.name === 'Rowlett' ? { ...c, weight: 2 } : c)) };
    const selection = rank({ policy: heavyRowlett });
    assert.equal(selection.winner.city, 'Rowlett');
    near(selection.winner.total, Math.round(weightedSum(selection.winner) * 2 * 10000) / 10000, 'doubled');
  });
});

// ── Performance ─────────────────────────────────────────────────────────────

describe('rankCandidates: performance from Facebook insights joined to history', () => {
  it('normalizes engagement by the best service and leaves unknown services at 0.5', () => {
    const observations = [
      fbObs({ id: 'fb-1', reach: 1000, engaged: 100, message: 'Level 2 charger install in Wylie' }),
      fbObs({ id: 'fb-2', reach: 1000, engaged: 25, message: 'Panel upgrade day in Garland' }),
      fbObs({ id: 'fb-orphan', reach: 5000, engaged: 4000 }),
    ];
    const history = {
      posts: [
        post({ platform: 'facebook', post_date: '2026-08-26', service: 'EV Charger Installation', platform_post_id: 'fb-1', city: 'Wylie' }),
        post({ platform: 'facebook', post_date: '2026-08-26', service: 'Electrical Panel Upgrade / Replacement', platform_post_id: 'fb-2', city: 'Garland' }),
      ],
      website_tasks: [],
    };
    const selection = rank({ observations, history });
    assertSelection(selection);
    const ev = pick(selection, 'ev_charger', 'Plano');
    assert.equal(ev.scores.performance, 1);
    assert.match(reason(ev, 'performance'), /Facebook engagement 10\.0% \(1\.00 of best\)/);
    near(pick(selection, 'panel_upgrade', 'Plano').scores.performance, 0.25, '2.5% is a quarter of the best');
    assert.equal(pick(selection, 'generator', 'Plano').scores.performance, 0.5);
    assert.match(reason(pick(selection, 'generator', 'Plano'), 'performance'), /no performance data \(0\.50\)/);
    assert.doesNotMatch(selection.rationale, /Facebook insights unavailable/);
  });
});

// ── Rationale ───────────────────────────────────────────────────────────────

describe('rankCandidates: rationale', () => {
  it('is one short paragraph naming the winner, its two strongest drivers, and the runner-up', () => {
    const observations = [
      ...fixtureObservations(scFixture),
      serpObs({ query: 'ev charger installation wylie', service_key: 'ev_charger', city: 'Wylie', paa: ['Is a Level 2 charger worth it?'], local_pack: [{ title: 'Ace Electric', rating: 4.8, reviews: 120 }], grizzly_in_local_pack: false }),
    ];
    const selection = rank({ observations });
    assertSelection(selection);
    const { winner, ranked, rationale } = selection;
    assert.deepEqual(ranked[0], winner);
    assert.ok(rationale.startsWith(`Winner: ${winner.service_label} in ${winner.city} (total ${winner.total.toFixed(3)}).`), rationale);
    assert.ok(rationale.includes(`Runner-up: ${ranked[1].service_label} in ${ranked[1].city} (total ${ranked[1].total.toFixed(3)}).`), rationale);
    assert.notEqual(`${winner.service_key}|${winner.city}`, `${ranked[1].service_key}|${ranked[1].city}`);

    const drivers = SCORE_KEYS
      .map((k) => ({ k, contribution: WEIGHTS[k] * winner.scores[k] }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 2);
    const sentence = /Top drivers: (.*?)\. Runner-up:/.exec(rationale);
    assert.ok(sentence, 'rationale has a "Top drivers" sentence before the runner-up');
    for (const d of drivers) {
      assert.ok(sentence[1].includes(`${d.k} ${winner.scores[d.k].toFixed(2)}`), `driver ${d.k} named: ${sentence[1]}`);
    }
    assert.doesNotMatch(rationale, /\n/, 'single paragraph');
    assert.ok(rationale.length < 800, `short: ${rationale.length} chars`);
  });

  it('notes when only one candidate remained', () => {
    const tiny = { ...policy, services: [policy.services[0]], cities: [policy.cities[0]] };
    const selection = rank({ policy: tiny });
    assert.equal(selection.ranked.length, 1);
    assert.match(selection.rationale, /No runner-up: only one candidate remained\./);
  });

  it('skips the exclusion rather than return nothing when every candidate would be excluded, and says so', () => {
    const tiny = { ...policy, services: [policy.services.find((s) => s.key === 'ev_charger')] };
    const history = { posts: [], website_tasks: [], winners: [{ week_of: '2026-08-31', service_key: 'ev_charger' }] };
    const selection = rank({ policy: tiny, history });
    assertSelection(selection);
    assert.equal(selection.winner.service_key, 'ev_charger');
    assert.deepEqual(selection.excluded, []);
    assert.match(selection.rationale, /Exclusion skipped for EV Charger Installation/);
  });
});

// ── Inputs ──────────────────────────────────────────────────────────────────

describe('rankCandidates: inputs', () => {
  it('requires a policy with services and cities, and a weekSpec with run_friday and week_of', () => {
    assert.throws(() => rankCandidates({ observations: [], weekSpec }), TypeError);
    assert.throws(() => rankCandidates({ policy: { services: [] }, weekSpec }), TypeError);
    assert.throws(() => rankCandidates({ policy, observations: [] }), TypeError);
    assert.throws(() => rankCandidates({ policy, observations: [], weekSpec: { week_of: '2026-09-07' } }), TypeError);
  });

  it('accepts pre-built candidates and a facts object without changing the contract shape', () => {
    const candidates = buildCandidates(policy, { cityTiers: [1] });
    const facts = { business_name: 'Grizzly Electrical Solutions', priority_services: ['EV Charger Installation'] };
    const selection = rank({ candidates, facts });
    assertSelection(selection);
    assert.equal(selection.ranked.length, candidates.length);
    assert.ok(selection.ranked.every((c) => policy.cities.find((x) => x.name === c.city).tier === 1));
    assert.deepEqual(Object.keys(selection).sort(), ['degraded', 'excluded', 'ranked', 'rationale', 'winner']);
  });

  it('ignores observations that are not ok, not from a scored source, or malformed', () => {
    const observations = [
      { ...scObs({ query: 'electrician rowlett tx', impressions: 300, clicks: 10, position: 12 }), status: 'error', note: 'boom' },
      { ...scObs({ query: 'electrician rockwall tx', impressions: 300, clicks: 10, position: 12 }), metric: 'something_else' },
      null,
      'not an observation',
      { id: 'x', source: 'trends', status: 'ok', scope: 'electrician rowlett tx', value: { impressions: 9999 } },
    ];
    const selection = rank({ observations });
    assert.equal(selection.degraded, true, 'nothing usable arrived');
    assert.equal(pick(selection, 'troubleshooting', 'Rowlett').scores.demand, 0.5);
  });
});
