// scripts/weekly/test/validate.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePlan, findPhoneNumbers, findDollarAmounts, dollarValue, findDomains, findTenureClaims,
  textFactsErrors, normalizeHook, HEADLINE_WARN_CHARS,
} from '../lib/validate.mjs';
import { parseFacts, loadFacts } from '../lib/facts.mjs';
import { weekSpecForWeekOf } from '../lib/week-spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FACTS = parseFacts(fs.readFileSync(path.join(here, 'fixtures', 'validate.facts.md'), 'utf8'));
const PLAN = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'validate.plan.json'), 'utf8'));
const WEEK = weekSpecForWeekOf('2026-09-07', new Date('2026-09-04T17:00:00Z'));
const PHOTOS = ['panel-rockwall.jpg', 'ev-charger.jpg', 'IMG_2329.JPG', 'generator-inlet.jpg', 'surge-protector.jpg'];
const HISTORY = {
  posts: [
    { platform: 'facebook', post_date: '2026-08-24', service: 'Electrical Panel Upgrade / Replacement', hook: 'Is your panel keeping up?', status: 'published' },
    { platform: 'gbp', post_date: '2026-08-28', service: 'EV Charger Installation', hook: 'Charging at home in Rowlett', status: 'published' },
    { platform: 'website', post_date: null, service: 'Recessed Lighting Installation', hook: '', status: 'queued' },
  ],
};
const POLICY = {
  boost_weekly_usd: 50,
  cities: [{ name: 'Rowlett', tier: 1 }, { name: 'Rockwall', tier: 1 }, { name: 'Garland', tier: 1 }, { name: 'Fort Worth', tier: 3 }],
};

const clone = (v) => JSON.parse(JSON.stringify(v));
/** Validate a mutated copy of the fixture plan. */
function run(mutate = () => {}, ctx = {}) {
  const plan = clone(PLAN);
  mutate(plan);
  return validatePlan(plan, { facts: FACTS, weekSpec: WEEK, photos: PHOTOS, history: HISTORY, policy: POLICY, ...ctx });
}
const has = (list, re) => list.some((m) => re.test(m));
const only = (list, re) => list.filter((m) => re.test(m));

describe('fixture facts parse the way the validator expects', () => {
  it('phones, domain, founding year, tenure phrases, approved prices', () => {
    assert.deepEqual(FACTS.phones, { customer_text: '(469) 896-3862', published_main: '(469) 863-9804' });
    assert.equal(FACTS.domain, 'grizzlyelectricaltx.com');
    assert.equal(FACTS.founded_year, 2021);
    assert.deepEqual(FACTS.tenure_phrases, ['since 2021', 'five years']);
    assert.deepEqual(FACTS.forbidden_phrases, ['over a decade', '3+ years']);
    assert.deepEqual(FACTS.approved_prices, ['Service call: $99', 'Whole-home surge protector installed from $450']);
    assert.equal(WEEK.gbp_dates[1], '2026-09-04');
    assert.equal(WEEK.fb_dates[6], '2026-09-12');
  });
});

describe('findPhoneNumbers', () => {
  it('catches every common shape and normalizes to the facts format', () => {
    const forms = ['469-896-3862', '(469) 896 3862', '4698963862', '+1 469 896 3862', '469.896.3862', '(469) 896-3862', '+1 (469) 896-3862', '1-469-896-3862'];
    for (const f of forms) assert.deepEqual(findPhoneNumbers(`call ${f} now`), ['(469) 896-3862'], f);
  });
  it('returns every occurrence in order', () => {
    assert.deepEqual(findPhoneNumbers('Text (469) 896-3862 or call 469-863-9804.'), ['(469) 896-3862', '(469) 863-9804']);
  });
  it('ignores dates, zips, amounts, years, amp ratings and mixed-separator ranges', () => {
    const text = 'Rowlett, TX 75089 on 2026-09-04. Built in 1990, 200 amp, $1,200, 100-200 3000 watts, 8902 Merritt Rd.';
    assert.deepEqual(findPhoneNumbers(text), []);
    assert.deepEqual(findPhoneNumbers('order 12345678901234'), []);
  });
  it('is safe on empty, null and array input', () => {
    assert.deepEqual(findPhoneNumbers(''), []);
    assert.deepEqual(findPhoneNumbers(null), []);
    assert.deepEqual(findPhoneNumbers(['#tag', '469-896-3862']), ['(469) 896-3862']);
  });
});

describe('findDollarAmounts / dollarValue', () => {
  it('finds $1,200, $25/day and 1200 dollars', () => {
    const found = findDollarAmounts('Panels run $1,200. Boost at $25/day. About 1200 dollars total.');
    assert.deepEqual(found, ['$1,200', '$25/day', '1200 dollars']);
    assert.deepEqual(found.map(dollarValue), [1200, 25, 1200]);
  });
  it('handles cents, k suffix, spaces and per-unit phrasing', () => {
    assert.deepEqual(findDollarAmounts('$99.99 today, $1.2k tomorrow, $ 450 per outlet'), ['$99.99', '$1.2k', '$ 450 per outlet']);
    assert.equal(dollarValue('$1.2k'), 1200);
    assert.equal(dollarValue('$ 450 per outlet'), 450);
    assert.equal(dollarValue('no number'), null);
  });
  it('ignores percentages, amp ratings, years and "free"', () => {
    assert.deepEqual(findDollarAmounts('50% off a 200 amp panel, free quote, since 2021, 25 miles'), []);
  });
});

describe('findDomains', () => {
  it('extracts hostnames from URLs and bare domains, stripping www', () => {
    assert.deepEqual(findDomains('See https://www.grizzlyelectricaltx.com/panel-upgrades/ or grizzlyelectricaltx.com.'), ['grizzlyelectricaltx.com']);
    assert.deepEqual(findDomains('Visit GrizzlyElectricalSolutions.com today'), ['grizzlyelectricalsolutions.com']);
  });
  it('does not treat email domains, abbreviations or state codes as websites', () => {
    assert.deepEqual(findDomains('Email contactus@grizzlyelectrical.net, e.g. in Rowlett, TX. Call us.'), []);
    assert.deepEqual(findDomains('IMG_2329.JPG and sitemap.xml and 404.html'), []);
  });
});

describe('findTenureClaims', () => {
  it('catches decade, N+ years, since YYYY and "years of experience"', () => {
    const claims = findTenureClaims('Over a decade of service. 10+ years in the trade. Since 2019. Fifteen years of experience. 3+ years strong.');
    assert.deepEqual(claims.map((c) => [c.kind, c.raw, c.years, c.year]), [
      ['decade', 'Over a decade', null, null],
      ['plus', '10+ years', 10, null],
      ['since', 'Since 2019', null, 2019],
      ['tenure', 'Fifteen years of experience', 15, null],
      ['plus', '3+ years', 3, null],
    ]);
  });
  it('catches "for over N years" only with a business cue in the sentence', () => {
    assert.equal(findTenureClaims("We've served Rowlett for over 12 years.").length, 1);
    assert.equal(findTenureClaims('Copper wiring lasts for over 40 years.').length, 0);
  });
  it('ignores warranty and equipment-age phrasing', () => {
    assert.deepEqual(findTenureClaims('A 25-year warranty. Panels over 30 years old fail. Homes 10+ years old need checks. Built in 1990.'), []);
  });
  it('is quiet on the fixture plan copy', () => {
    for (const item of PLAN.gbp) assert.ok(findTenureClaims(item.body).every((c) => c.kind === 'since' && c.year === 2021), item.headline);
  });
});

describe('textFactsErrors (strict text rules, used by compare)', () => {
  const opts = { facts: FACTS, weekSpec: WEEK };
  it('accepts copy that follows the facts', () => {
    assert.deepEqual(textFactsErrors('Call (469) 863-9804 or text (469) 896-3862. Five years serving Rowlett since 2021. grizzlyelectricaltx.com. Service call $99.', opts), []);
  });
  it('flags a phone that is not a business number', () => {
    const errors = textFactsErrors('Call 214-555-0100 today', { ...opts, label: 'legacy gbp' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^legacy gbp: phone \(214\) 555-0100 is not a business number/);
    assert.match(errors[0], /\(469\) 896-3862, \(469\) 863-9804/);
  });
  it('flags a domain other than the website domain, including the nonexistent one', () => {
    const errors = textFactsErrors('Visit grizzlyelectricalsolutions.com and www.grizzlyelectricaltx.com', opts);
    assert.deepEqual(errors, ['domain grizzlyelectricalsolutions.com is not grizzlyelectricaltx.com']);
  });
  it('flags every tenure contradiction exactly once, including the forbidden phrases', () => {
    for (const bad of ['over a decade', '10+ years', '3+ years', 'since 2019', 'established in 2019', '12 years of experience', 'four years in business']) {
      const errors = textFactsErrors(`Grizzly: ${bad}.`, opts);
      assert.equal(errors.length, 1, bad);
      assert.match(errors[0], /founded 2021|forbidden phrase/, bad);
      assert.match(errors[0], /say "since 2021" or "five years"/, bad);
    }
  });
  it('accepts the tenure phrase and the exact tenure number', () => {
    assert.deepEqual(textFactsErrors('five years of experience, 5 years in business, 5+ years strong, since 2021', opts), []);
  });
  it('flags prices that are not approved and accepts the approved ones by value', () => {
    assert.deepEqual(textFactsErrors('Panel upgrades from $1,200', opts), ['price $1,200 is not an approved price']);
    assert.deepEqual(textFactsErrors('Surge protector from $450, service call 99 dollars', opts), []);
  });
  it('fails closed when the facts lack a founding year or a domain', () => {
    const bare = { ...FACTS, founded_year: null, tenure_phrases: [], tenure_phrase: null, forbidden_phrases: [], domain: null };
    const errors = textFactsErrors('12 years of experience at grizzlyelectricaltx.com', { facts: bare, weekSpec: WEEK });
    assert.ok(has(errors, /founding year is not in the facts/));
    assert.ok(has(errors, /domain grizzlyelectricaltx\.com \(facts list no website domain\)/));
  });
  it('flags an email other than the business email as an error in strict mode', () => {
    assert.deepEqual(textFactsErrors('Write to info@grizzlyelectricaltx.com', opts), ['email info@grizzlyelectricaltx.com is not contactus@grizzlyelectrical.net']);
  });
});

describe('validatePlan: the fixture plan is clean', () => {
  it('returns ok with no errors and no warnings', () => {
    const result = run();
    assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
  });
  it('also passes against the real facts file (phones, domain and tenure match the business truth)', () => {
    const result = run(() => {}, { facts: loadFacts() });
    assert.deepEqual(result.errors, []);
  });
  it('does not throw on garbage input and reports schema errors only', () => {
    for (const bad of [null, undefined, 'plan', 42, []]) {
      const result = validatePlan(bad, { facts: FACTS, weekSpec: WEEK });
      assert.equal(result.ok, false);
      assert.ok(result.errors.length >= 1);
      assert.ok(result.errors.every((e) => e.startsWith('schema:')), JSON.stringify(result.errors));
    }
  });
});

describe('validatePlan: schema and slots', () => {
  it('reports schema issues with their path', () => {
    const result = run((p) => { p.gbp[0].status = 'Approved'; p.facebook[1].hashtags = ['a', 'b', 'c', 'd']; });
    assert.ok(has(result.errors, /^schema: gbp\[0\]\.status/));
    assert.ok(has(result.errors, /^schema: facebook\[1\]\.hashtags/));
    assert.equal(result.ok, false);
  });
  it('reports a missing GBP day and a duplicated one', () => {
    const result = run((p) => { p.gbp[3] = { ...p.gbp[2] }; });
    assert.ok(has(result.errors, /^gbp: missing day 4$/));
    assert.ok(has(result.errors, /^gbp: day 3 appears 2 times$/));
  });
  it('reports a missing Facebook day', () => {
    const result = run((p) => { p.facebook[3] = { ...p.facebook[0] }; });
    assert.ok(has(result.errors, /^facebook: missing day 6$/));
    assert.ok(has(result.errors, /^facebook: day 1 appears 2 times$/));
  });
  it('enforces the Facebook type-per-day rule', () => {
    const result = run((p) => { p.facebook[0].type = 'photo'; p.facebook[3].type = 'carousel'; });
    assert.ok(has(result.errors, /^facebook day 1: type must be slideshow \(got photo\)$/));
    assert.ok(has(result.errors, /^facebook day 6: type must be photo or text \(got carousel\)$/));
    assert.equal(run((p) => { p.facebook[1].type = 'carousel'; p.facebook[3].type = 'photo'; p.facebook[3].photo_file = 'ev-charger.jpg'; }).ok, true);
  });
});

describe('validatePlan: dates', () => {
  it('rejects a week_of that is not the WeekSpec week', () => {
    const result = run((p) => { p.week_of = '2026-09-14'; });
    assert.deepEqual(only(result.errors, /week_of/), ['week_of 2026-09-14 is not the WeekSpec week_of 2026-09-07']);
  });
  it('rejects a GBP or Facebook date that is not the WeekSpec date for that day', () => {
    const result = run((p) => { p.gbp[2].date = '2026-09-05'; p.facebook[2].date = '2026-09-12'; });
    assert.ok(has(result.errors, /^gbp day 3: date 2026-09-05, expected 2026-09-06$/));
    assert.ok(has(result.errors, /^facebook day 5: date 2026-09-12, expected 2026-09-11$/));
  });
  it('fails closed without a weekSpec', () => {
    const result = run(() => {}, { weekSpec: undefined });
    assert.ok(has(result.errors, /^weekSpec missing/));
  });
});

describe('validatePlan: phones, domains, tenure, prices', () => {
  it('rejects a phone other than the two business numbers anywhere in copy', () => {
    const result = run((p) => { p.gbp[1].body += ' Or call 214-555-0100.'; p.facebook[0].on_screen_text = 'Call 469 555 0123'; });
    assert.ok(has(result.errors, /^gbp day 2 body: phone \(214\) 555-0100 is not a business number/));
    assert.ok(has(result.errors, /^facebook day 1 on_screen_text: phone \(469\) 555-0123 is not a business number/));
  });
  it('accepts both business numbers in any shape', () => {
    assert.equal(run((p) => { p.gbp[6].body += ' Call +1 469 863 9804 or text 4698963862.'; }).ok, true);
  });
  it('rejects a domain other than the website domain in GBP and Facebook copy', () => {
    const result = run((p) => { p.gbp[0].caption = 'More at grizzlyelectricalsolutions.com'; p.facebook[1].body += ' Details at www.grizzlyelectrical.net.'; });
    assert.ok(has(result.errors, /^gbp day 1 caption: domain grizzlyelectricalsolutions\.com is not grizzlyelectricaltx\.com$/));
    assert.ok(has(result.errors, /^facebook day 3 body: domain grizzlyelectrical\.net is not grizzlyelectricaltx\.com$/));
  });
  it('rejects tenure claims that contradict the founding year', () => {
    const result = run((p) => {
      p.facebook[0].hook = 'Over a decade of keeping Rockwall lit.';
      p.gbp[3].body += ' Trusted for 10+ years.';
      p.gbp[4].trend_tie = 'Serving DFW since 2019';
      p.facebook[3].body += ' Our team brings 3+ years of experience.';
    });
    assert.ok(has(result.errors, /^facebook day 1 hook: tenure claim "Over a decade"/));
    assert.ok(has(result.errors, /^gbp day 4 body: tenure claim "10\+ years"/));
    assert.ok(has(result.errors, /^gbp day 5 trend_tie: tenure claim "since 2019"/));
    assert.ok(has(result.errors, /^facebook day 6 body: tenure claim "3\+ years/));
    assert.equal(only(result.errors, /tenure|forbidden/).length, 4);
  });
  it('rejects unapproved dollar amounts in GBP and Facebook copy but accepts approved ones', () => {
    const result = run((p) => { p.gbp[0].body += ' Upgrades start at $1,200.'; p.facebook[2].body += ' Boosted at $25/day.'; p.gbp[5].body += ' Installed from $450.'; });
    assert.ok(has(result.errors, /^gbp day 1 body: price \$1,200 is not an approved price$/));
    assert.ok(has(result.errors, /^facebook day 5 body: price \$25\/day is not an approved price$/));
    assert.ok(!has(result.errors, /\$450/));
  });
  it('does not price-check Facebook targeting or format fields', () => {
    const result = run((p) => { p.facebook[0].boost_targeting = 'Homeowners, $10/day cap'; p.facebook[0].format = 'slideshow ($0 production)'; });
    assert.ok(!has(result.errors, /price/), JSON.stringify(result.errors));
  });
  it('treats website drafts leniently: prices and external links warn, a grizzly look-alike domain errors', () => {
    const result = run((p) => {
      p.website_actions[0].draft.html += '<p>Upgrades from $1,800. Source: <a href="https://www.nfpa.org/">NFPA</a>. Old site: grizzlyelectricalsolutions.com</p>';
    });
    assert.ok(has(result.warnings, /^website\[0\] draft\.html: price \$1,800 is not an approved price$/));
    assert.ok(has(result.warnings, /^website\[0\] draft\.html: external domain nfpa\.org$/));
    assert.ok(has(result.errors, /^website\[0\] draft\.html: domain grizzlyelectricalsolutions\.com is not grizzlyelectricaltx\.com$/));
  });
  it('lets a website action mention a known-issue phone but never published copy', () => {
    const known = run((p) => { p.website_actions[0].description = 'Replace the placeholder (469) 555-0123 with the main number.'; });
    assert.ok(!has(known.errors, /555-0123/), JSON.stringify(known.errors));
    const leaked = run((p) => { p.gbp[0].cta = 'Call (469) 555-0123'; });
    assert.ok(has(leaked.errors, /^gbp day 1 cta: phone \(469\) 555-0123/));
  });
  it('warns, not errors, on phones and domains inside the plan notes', () => {
    const result = run((p) => { p.notes.trend_signals.push('Competitor angi.com ranks with 972-555-0199'); });
    assert.equal(result.ok, true);
    assert.ok(has(result.warnings, /^notes\.trend_signals: domain angi\.com/));
    assert.ok(has(result.warnings, /^notes\.trend_signals: phone \(972\) 555-0199/));
  });
  it('warns on an email other than the business email', () => {
    const result = run((p) => { p.gbp[0].body += ' Email info@grizzlyelectricaltx.com.'; });
    assert.equal(result.ok, true);
    assert.ok(has(result.warnings, /^gbp day 1 body: email info@grizzlyelectricaltx\.com is not contactus@grizzlyelectrical\.net$/));
  });
});

describe('validatePlan: photos', () => {
  it('rejects a photo_file that is not in the inventory', () => {
    const result = run((p) => { p.gbp[0].photo_file = 'nope.jpg'; p.facebook[1].photo_file = 'missing.png'; });
    assert.ok(has(result.errors, /^gbp day 1: photo_file nope\.jpg is not in the photo inventory$/));
    assert.ok(has(result.errors, /^facebook day 3: photo_file missing\.png is not in the photo inventory$/));
  });
  it('fails closed when no inventory is supplied', () => {
    const result = run(() => {}, { photos: [] });
    // 6 GBP photos (day 7 is null) + 3 Facebook photos (day 6 is a text post).
    assert.equal(only(result.errors, /photo inventory/).length, 9);
    assert.equal(run(() => {}, { photos: undefined }).ok, false);
  });
  it('accepts inventory entries as objects or paths', () => {
    const objects = PHOTOS.map((name) => ({ name, path: `photos/${name}` }));
    assert.equal(run(() => {}, { photos: objects }).ok, true);
    assert.equal(run(() => {}, { photos: PHOTOS.map((n) => `C:\\photos\\${n}`) }).ok, true);
  });
  it('null photo_file is always fine', () => {
    assert.equal(run((p) => { for (const g of p.gbp) g.photo_file = null; for (const f of p.facebook) f.photo_file = null; }, { photos: [] }).ok, true);
  });
});

describe('validatePlan: boost allocation', () => {
  it('rejects YES rows that do not sum to the weekly budget', () => {
    const result = run((p) => { p.facebook[2].boost.days = 3; });
    assert.deepEqual(only(result.errors, /boost/), ['facebook: boost YES rows total $60 (day 1 $10×3 + day 5 $10×3), must equal $50']);
  });
  it('accepts a single YES row carrying the whole budget', () => {
    assert.equal(run((p) => { p.facebook[0].boost = { decision: 'YES', daily_usd: 12.5, days: 4 }; p.facebook[2].boost = { decision: 'MAYBE', daily_usd: null, days: null }; }).ok, true);
  });
  it('rejects more than two YES rows', () => {
    const result = run((p) => { p.facebook[1].boost = { decision: 'YES', daily_usd: 10, days: 1 }; p.facebook[2].boost.days = 1; });
    assert.ok(has(result.errors, /^facebook: 3 boost YES rows \(max 2\)$/));
  });
  it('rejects a YES row without positive daily_usd and days', () => {
    const result = run((p) => { p.facebook[0].boost = { decision: 'YES', daily_usd: null, days: 3 }; });
    assert.ok(has(result.errors, /^facebook day 1: YES boost row needs positive daily_usd and days/));
    assert.ok(!has(result.errors, /must equal/));
  });
  it('rejects MAYBE or NO rows carrying dollars', () => {
    const result = run((p) => { p.facebook[1].boost = { decision: 'MAYBE', daily_usd: 5, days: null }; p.facebook[3].boost = { decision: 'NO', daily_usd: null, days: 2 }; });
    assert.ok(has(result.errors, /^facebook day 3: MAYBE boost row carries dollars \(daily_usd=5, days=null\)$/));
    assert.ok(has(result.errors, /^facebook day 6: NO boost row carries dollars \(daily_usd=null, days=2\)$/));
  });
  it('rejects a week with no YES row while budget is set', () => {
    const result = run((p) => { for (const f of p.facebook) f.boost = { decision: 'NO', daily_usd: null, days: null }; });
    assert.ok(has(result.errors, /^facebook: no boost YES row; \$50 weekly budget is unallocated$/));
  });
  it('fails closed when the policy has no boost budget', () => {
    const result = run(() => {}, { policy: { cities: POLICY.cities } });
    assert.ok(has(result.errors, /^policy\.boost_weekly_usd missing/));
  });
});

describe('validatePlan: history hooks and service spread', () => {
  it('rejects a Facebook hook identical to a published hook after normalization', () => {
    const result = run((p) => { p.facebook[0].hook = '  IS your PANEL keeping up?!'; });
    assert.ok(has(result.errors, /^facebook day 1: hook repeats a published facebook hook on 2026-08-24: "  IS your PANEL keeping up\?!"$/));
  });
  it('rejects a GBP headline identical to a published hook', () => {
    const result = run((p) => { p.gbp[1].headline = 'Charging at home in Rowlett'; });
    assert.ok(has(result.errors, /^gbp day 2: headline repeats a published gbp hook on 2026-08-28/));
  });
  it('tolerates missing or malformed history', () => {
    assert.equal(run(() => {}, { history: null }).ok, true);
    assert.equal(run(() => {}, { history: { posts: [null, {}, { hook: null }] } }).ok, true);
  });
  it('rejects a service on more than 3 of the 7 GBP days', () => {
    const result = run((p) => { p.gbp[1].service = 'electrical panel upgrade / replacement'; });
    assert.ok(has(result.errors, /^gbp: service "electrical panel upgrade \/ replacement" on 4 of 7 days \(max 3\)$/));
  });
  it('normalizeHook strips case, punctuation and spacing', () => {
    assert.equal(normalizeHook('  Is your PANEL keeping up?!  '), 'is your panel keeping up');
    assert.equal(normalizeHook(null), '');
  });
});

describe('validatePlan: warnings', () => {
  it('warns on a headline over 58 chars', () => {
    const long = 'x'.repeat(HEADLINE_WARN_CHARS + 1);
    const result = run((p) => { p.gbp[0].headline = long; });
    assert.equal(result.ok, true);
    assert.ok(has(result.warnings, /^gbp day 1: headline is 59 chars \(over 58\)$/));
  });
  it('warns on a body under 30 words (GBP and Facebook) and a Facebook body over 80', () => {
    const result = run((p) => { p.gbp[2].body = 'Short body.'; p.facebook[1].body = 'Too short.'; p.facebook[3].body = 'word '.repeat(85).trim(); });
    assert.ok(has(result.warnings, /^gbp day 3: body is 2 words \(under 30\)$/));
    assert.ok(has(result.warnings, /^facebook day 3: body is 2 words \(under 30\)$/));
    assert.ok(has(result.warnings, /^facebook day 6: body is 85 words \(target 30–80\)$/));
  });
  it('warns when the topic city is named in fewer than 3 GBP posts', () => {
    const result = run((p) => { for (const g of p.gbp) { g.body = g.body.replace(/Rockwall/g, 'Sachse'); g.headline = g.headline.replace(/Rockwall/g, 'Sachse'); g.caption = g.caption.replace(/Rockwall/g, 'Sachse'); } });
    assert.ok(has(result.warnings, /^gbp: topic city Rockwall is named in 0 of 7 posts \(want at least 3\)$/));
  });
  it('falls back to any policy city when the plan has no topic city', () => {
    const result = run((p) => { p.topic.city = ''; });
    assert.ok(!has(result.warnings, /city/), JSON.stringify(result.warnings));
  });
  it('warns on hashtags without a local tag (Facebook only when it has hashtags)', () => {
    const result = run((p) => { p.gbp[0].hashtags = ['#Panel', '#Electric', '#Safety']; p.facebook[0].hashtags = ['#Panel']; });
    assert.ok(has(result.warnings, /^gbp day 1: hashtags have no local tag$/));
    assert.ok(has(result.warnings, /^facebook day 1: hashtags have no local tag$/));
    assert.ok(!has(result.warnings, /facebook day 6: hashtags/));
  });
  it('recognises city names, DFW, Texas and TX suffixes as local tags', () => {
    const ok = run((p) => {
      p.gbp[0].hashtags = ['#a', '#b', '#FortWorthElectrician'];
      p.gbp[1].hashtags = ['#a', '#b', '#Texas'];
      p.gbp[2].hashtags = ['#a', '#b', '#SachseTX'];
      p.gbp[3].hashtags = ['#a', '#b', '#dfw'];
    });
    assert.ok(!has(ok.warnings, /hashtags/), JSON.stringify(ok.warnings));
  });
});

// Review findings: regexes that missed real leaks, lenient inputs that read as
// "$0 budget" or "no dates to check", and within-plan repetition.
describe('review: phone shapes with Unicode dashes and mixed separators', () => {
  it('catches en dash, Unicode minus, non-breaking space and mixed separators', () => {
    const forms = ['469–896–3862', '469−896−3862', '(469) 896‑3862', '469 896-3862', '469-896 3862', '469.896-3862'];
    for (const f of forms) assert.deepEqual(findPhoneNumbers(`call ${f} now`), ['(469) 896-3862'], JSON.stringify(f));
  });
  it('still ignores dates, zips and amp ratings', () => {
    assert.deepEqual(findPhoneNumbers('Rowlett, TX 75089 on 2026-09-04 – 200 amp, 100-200 3000 watts'), []);
  });
  it('fails a plan whose copy hides a foreign number behind an en dash', () => {
    const result = run((p) => { p.facebook[0].body += ' Call 214–555–0100.'; });
    assert.ok(has(result.errors, /^facebook day 1 body: phone \(214\) 555-0100 is not a business number/), JSON.stringify(result.errors));
  });
});

describe('review: dollar ranges, currency prefixes and word multipliers', () => {
  it('finds US$50 and both ends of a $99-149 range', () => {
    assert.deepEqual(findDollarAmounts('US$50 fee'), ['$50']);
    assert.deepEqual(findDollarAmounts('from $99–149'), ['$99', '$149']);
    assert.deepEqual(findDollarAmounts('from $99-149'), ['$99', '$149']);
    assert.deepEqual(findDollarAmounts('from $1,500–$2,000'), ['$1,500', '$2,000']);
    // "to N" is not a range tail: "$99 to 3 days" must not invent a $3 price.
    assert.deepEqual(findDollarAmounts('$99 to 3 days'), ['$99']);
  });
  it('keeps "$5 million" whole and values it', () => {
    assert.deepEqual(findDollarAmounts('a $5 million project'), ['$5 million']);
    assert.equal(dollarValue('$5 million'), 5e6);
    assert.equal(dollarValue('$1.2k'), 1200);
    assert.equal(dollarValue('$450 monthly'), 450);
    assert.deepEqual(findDollarAmounts('$450 monthly, $99 today'), ['$450', '$99']);
  });
  it('flags the unapproved upper bound of a range whose lower bound is approved', () => {
    const result = run((p) => { p.gbp[0].body += ' Service calls run $99–149.'; });
    assert.deepEqual(only(result.errors, /price/), ['gbp day 1 body: price $149 is not an approved price']);
  });
});

describe('review: domains behind explicit URLs or with newer TLDs', () => {
  it('counts any TLD behind https:// or www., and bare .info/.solutions/.services', () => {
    assert.deepEqual(findDomains('see www.grizzlyelectrical.solutions'), ['grizzlyelectrical.solutions']);
    assert.deepEqual(findDomains('see http://example.xyz/path'), ['example.xyz']);
    assert.deepEqual(findDomains('grizzlyelectrical.info or grizzly.services'), ['grizzlyelectrical.info', 'grizzly.services']);
  });
  it('returns a clean hostname after a leading hyphen and still ignores run-ons and abbreviations', () => {
    assert.deepEqual(findDomains('-example.com'), ['example.com']);
    assert.deepEqual(findDomains('Rowlett.TX e.g. i.e. U.S. IMG_2329.JPG Grizzly Electrical Solutions.Inc'), []);
  });
  it('fails a plan that links a look-alike .solutions domain', () => {
    const result = run((p) => { p.facebook[1].cta = 'More at www.grizzlyelectrical.solutions'; });
    assert.ok(has(result.errors, /^facebook day 3 cta: domain grizzlyelectrical\.solutions is not grizzlyelectricaltx\.com$/), JSON.stringify(result.errors));
  });
});

describe('review: tenure phrasing that is equipment age, and claims tied to a place', () => {
  it('does not treat "decades-old wiring" or an uncued "a decade ago" as a tenure claim', () => {
    assert.deepEqual(findTenureClaims('Decades-old wiring and panels installed a decade ago need a look.'), []);
    assert.equal(run((p) => { p.gbp[0].body += ' Decades-old wiring is a fire risk.'; }).ok, true);
  });
  it('still flags "a decade ago" about the business and "over a decade"', () => {
    assert.equal(findTenureClaims('We started a decade ago.').length, 1);
    assert.equal(findTenureClaims('Over a decade of service.').length, 1);
  });
  it('catches "N-year track record" and "N years in DFW"', () => {
    assert.deepEqual(findTenureClaims('A 10-year track record. 12 years in DFW. 8 years across North Texas.').map((c) => c.years), [10, 12, 8]);
    assert.deepEqual(findTenureClaims('We see panels fail after 25 years in this climate.'), []);
  });
  it('uses the places option (policy cities through validatePlan) for "N years in Rockwall"', () => {
    assert.equal(findTenureClaims('10 years in Rockwall').length, 0);
    assert.equal(findTenureClaims('10 years in Rockwall', { places: ['Rockwall'] }).length, 1);
    assert.equal(findTenureClaims('10 years in Royse City', { places: ['Royse City'] }).length, 1);
    const result = run((p) => { p.gbp[1].body += ' Ten years in Rockwall and counting.'; });
    assert.ok(has(result.errors, /^gbp day 2 body: tenure claim "Ten years in Rockwall"/), JSON.stringify(result.errors));
    assert.deepEqual(textFactsErrors('Five years in Rockwall', { facts: FACTS, weekSpec: WEEK, policy: POLICY }), []);
  });
});

describe('review: boost budget and WeekSpec inputs fail closed', () => {
  it('treats a null, string or boolean boost budget as missing, never as $0', () => {
    for (const bad of [null, '50', true, NaN, -50]) {
      const result = run(() => {}, { policy: { cities: POLICY.cities, boost_weekly_usd: bad } });
      assert.ok(has(result.errors, /^policy\.boost_weekly_usd missing/), JSON.stringify([bad, result.errors]));
      assert.ok(!has(result.errors, /must equal \$0|must equal \$1\b/), JSON.stringify([bad, result.errors]));
    }
  });
  it('rejects a WeekSpec that lacks slot dates instead of skipping the date check', () => {
    const noDates = run(() => {}, { weekSpec: { week_of: '2026-09-07' } });
    assert.ok(has(noDates.errors, /^weekSpec\.gbp_dates missing day 1, 2, 3, 4, 5, 6, 7: cannot verify GBP dates$/), JSON.stringify(noDates.errors));
    assert.ok(has(noDates.errors, /^weekSpec\.fb_dates missing day 1, 3, 5, 6: cannot verify Facebook dates$/));
    const oneDay = run(() => {}, { weekSpec: { ...WEEK, fb_dates: { ...WEEK.fb_dates, 5: undefined } } });
    assert.deepEqual(only(oneDay.errors, /weekSpec/), ['weekSpec.fb_dates missing day 5: cannot verify Facebook dates']);
  });
});

describe('review: repetition inside the plan and history shapes', () => {
  it('rejects the same Facebook hook or GBP headline twice in one week', () => {
    const result = run((p) => { p.facebook[2].hook = p.facebook[0].hook.toUpperCase(); p.gbp[4].headline = `${p.gbp[0].headline}!!`; });
    assert.ok(has(result.errors, /^facebook day 5: hook duplicates day 1: /), JSON.stringify(result.errors));
    assert.ok(has(result.errors, /^gbp day 5: headline duplicates day 1: /), JSON.stringify(result.errors));
    assert.equal(only(result.errors, /duplicates/).length, 2);
  });
  it('accepts history passed as a bare posts array and names the platform without a stray space', () => {
    const result = run(() => {}, { history: [{ platform: 'facebook', post_date: '2026-08-10', hook: PLAN.facebook[0].hook }, { hook: PLAN.gbp[0].headline }] });
    assert.ok(has(result.errors, /^facebook day 1: hook repeats a published facebook hook on 2026-08-10: /), JSON.stringify(result.errors));
    assert.ok(has(result.errors, /^gbp day 1: headline repeats a published hook: /), JSON.stringify(result.errors));
  });
  it('does not confuse a Facebook hook with a GBP headline', () => {
    assert.equal(run((p) => { p.facebook[0].hook = p.gbp[0].headline; }).ok, true);
  });
});

// Second review: bypasses in the tenure scanner, per-unit prices approved by
// bare value, substring hashtag matches, and the real policy file.
describe('review 2: compound number words cannot hide behind their last word', () => {
  it('reads "twenty-five years of experience" as 25, not 5', () => {
    assert.deepEqual(findTenureClaims('Twenty-five years of experience.').map((c) => [c.raw, c.years]), [['Twenty-five years of experience', 25]]);
    assert.deepEqual(findTenureClaims('Sixty five years of experience').map((c) => c.years), [65]);
    assert.deepEqual(findTenureClaims('a dozen years of experience').map((c) => c.years), [12]);
  });
  it('fails a plan that claims twenty-five years even though "five years" is the owner phrase', () => {
    for (const bad of ['twenty-five years of experience', 'twenty five years of experience', 'Twenty-Five Years in business']) {
      const result = run((p) => { p.facebook[1].body += ` Our team brings ${bad}.`; });
      assert.ok(has(result.errors, /^facebook day 3 body: tenure claim "twenty.five years/i), JSON.stringify([bad, result.errors]));
    }
  });
  it('still accepts the owner phrase at the head of a claim and its number anywhere', () => {
    const opts = { facts: FACTS, weekSpec: WEEK };
    assert.deepEqual(textFactsErrors('Five years of experience. We have served Rockwall for five years. 5+ years strong.', opts), []);
    // The phrase keeps working through its number when the calendar year moves on.
    const later = weekSpecForWeekOf('2027-09-06', new Date('2027-09-03T17:00:00Z'));
    assert.deepEqual(textFactsErrors('five years of experience, since 2021', { facts: FACTS, weekSpec: later }), []);
    assert.equal(textFactsErrors('6 years of experience', { facts: FACTS, weekSpec: later }).length, 0);
    assert.equal(textFactsErrors('4 years of experience', { facts: FACTS, weekSpec: later }).length, 1);
  });
});

describe('review 2: "combined" / "hands-on" experience and uncued business sentences', () => {
  it('catches N years of combined or hands-on experience', () => {
    assert.deepEqual(findTenureClaims('Our team has 20 years of combined experience.').map((c) => c.years), [20]);
    assert.deepEqual(findTenureClaims('15 years of hands-on experience').map((c) => c.years), [15]);
    assert.deepEqual(textFactsErrors('Grizzly: 20 years of combined experience.', { facts: FACTS, weekSpec: WEEK }).length, 1);
    assert.deepEqual(textFactsErrors('five years of combined experience', { facts: FACTS, weekSpec: WEEK }), []);
  });
  it('treats "keeping the lights on for over N years" as a business claim but leaves equipment alone', () => {
    assert.equal(findTenureClaims('Keeping the lights on in Rowlett for over 10 years.').length, 1);
    assert.equal(findTenureClaims('Proudly powering DFW for more than 12 years.').length, 1);
    assert.equal(findTenureClaims('Copper wiring lasts for over 40 years.').length, 0);
    assert.equal(findTenureClaims('LED lighting lasts for over 20 years.').length, 0);
    const result = run((p) => { p.gbp[3].cta = 'Keeping the lights on for over 10 years.'; });
    assert.ok(has(result.errors, /^gbp day 4 cta: tenure claim "over 10 years"/), JSON.stringify(result.errors));
  });
});

describe('review 2: a per-unit price is not approved by its bare value', () => {
  const opts = { facts: FACTS, weekSpec: WEEK };
  it('rejects $99/hour when only a bare $99 is approved', () => {
    assert.deepEqual(textFactsErrors('Service calls are $99/hour.', opts), ['price $99/hour is not an approved price']);
    assert.deepEqual(textFactsErrors('$450 per outlet', opts), ['price $450 per outlet is not an approved price']);
  });
  it('accepts a per-unit price when an approved entry carries the same unit, and a bare amount either way', () => {
    const facts = { ...FACTS, approved_prices: ['Boost at $25 per day', 'Service call: $99/hr'] };
    assert.deepEqual(textFactsErrors('$25/day and $99 per hour and $25 flat', { facts, weekSpec: WEEK }), []);
    assert.deepEqual(textFactsErrors('$25/week', { facts, weekSpec: WEEK }), ['price $25/week is not an approved price']);
  });
  it('fails a plan whose GBP copy turns the approved service call into an hourly rate', () => {
    const result = run((p) => { p.gbp[0].body += ' Service call $99 per hour.'; });
    assert.deepEqual(only(result.errors, /price/), ['gbp day 1 body: price $99 per hour is not an approved price']);
    assert.equal(run((p) => { p.gbp[0].body += ' Service call $99.'; }).ok, true);
  });
});

describe('review 2: hashtag locality needs the place at an edge, not buried in a word', () => {
  const allen = { ...POLICY, cities: [...POLICY.cities, { name: 'Allen', tier: 2 }] };
  it('does not count #ChallengeAccepted as an Allen tag', () => {
    const result = run((p) => { p.gbp[0].hashtags = ['#ChallengeAccepted', '#Panel', '#Safety']; }, { policy: allen });
    assert.ok(has(result.warnings, /^gbp day 1: hashtags have no local tag$/), JSON.stringify(result.warnings));
  });
  it('still accepts a city at the start, the end, or followed by TX', () => {
    const result = run((p) => {
      p.gbp[0].hashtags = ['#a', '#b', '#AllenElectrician'];
      p.gbp[1].hashtags = ['#a', '#b', '#GrizzlyRockwall'];
      p.gbp[2].hashtags = ['#a', '#b', '#ServingAllenTX'];
    }, { policy: allen });
    assert.ok(!has(result.warnings, /hashtags/), JSON.stringify(result.warnings));
  });
});

describe('review 2: the fixture plan against the real policy file and the real facts', () => {
  it('is clean with all 24 policy cities and the owner facts (no false tenure or hashtag hits)', () => {
    const policy = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'config', 'weekly-policy.json'), 'utf8'));
    const result = run(() => {}, { facts: loadFacts(), policy });
    assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
  });
});
