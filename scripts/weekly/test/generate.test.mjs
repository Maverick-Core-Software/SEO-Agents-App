import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelPlanSchema, PlanSchema, parseOrIssues } from '../lib/schemas.mjs';
import { GenerationInvalid, BudgetExceeded } from '../lib/errors.mjs';
import { createCostMeter } from '../lib/cost-meter.mjs';
import { parseJsonLoose } from '../lib/llm.mjs';
import { loadFacts } from '../lib/facts.mjs';
import {
  buildGenerationInput,
  generatePlan,
  assemblePlan,
  planShapeIssues,
  buildRepairMessage,
  collectIssues,
  contactLine,
  redactUnknownPhones,
  homeBaseCity,
  weekdayName,
  seasonalHint,
  photoFilenames,
  pickSupporting,
  loadSystemPrompt,
  promptVersion,
  SYSTEM_PROMPT_PATH,
  REDACTED_PHONE,
  LABELS,
  FB_TYPES_BY_DAY,
} from '../lib/generate.mjs';

// Every NANP shape validate.mjs findPhoneNumbers flags; anything it would catch must be absent here.
const SEP = '[\\s.\\-\\u2010-\\u2015\\u2212]?';
const PHONE_SHAPE = new RegExp(`(?<!\\d)(?:\\+?1${SEP})?(?:\\(\\s*[2-9]\\d{2}\\s*\\)${SEP}[2-9]\\d{2}${SEP}\\d{4}|[2-9]\\d{2}${SEP}[2-9]\\d{2}${SEP}\\d{4})(?!\\d)`, 'g');
const hookKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (t) => String(t ?? '').trim().split(/\s+/).filter(Boolean).length;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'generate.model-plan.json');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const facts = loadFacts();

const WEEK_SPEC = {
  run_friday: '2026-09-04',
  week_of: '2026-09-07',
  gbp_start: '2026-09-04',
  computed_at: '2026-09-04T12:00:00.000Z',
  gbp_dates: { 1: '2026-09-04', 2: '2026-09-05', 3: '2026-09-06', 4: '2026-09-07', 5: '2026-09-08', 6: '2026-09-09', 7: '2026-09-10' },
  fb_dates: { 1: '2026-09-07', 3: '2026-09-09', 5: '2026-09-11', 6: '2026-09-12' },
};

const POLICY = {
  boost_weekly_usd: 50,
  cities: [{ name: 'Rowlett', tier: 1, weight: 0.9 }, { name: 'Rockwall', tier: 1, weight: 1.05 }, { name: 'Garland', tier: 1, weight: 1.05 }],
};

function candidate(service_key, service_label, city, total, reasons = []) {
  return {
    service_key,
    service_label,
    city,
    query_family: [`${service_label.toLowerCase()} ${city.toLowerCase()}`],
    scores: { priority: 1, demand: 0.5, opportunity: 1, recency: 1, season: 0.5, performance: 0.5 },
    total,
    reasons,
  };
}

const WINNER = candidate('panel_upgrade', 'Electrical Panel Upgrade / Replacement', 'Rockwall', 0.9123456, ['position 12 for the family', 'never published']);
const SELECTION = {
  winner: WINNER,
  ranked: [
    WINNER,
    candidate('ev_charger', 'EV Charger Installation', 'Garland', 0.81),
    candidate('troubleshooting', 'Electrical Troubleshooting & Repair', 'Rowlett', 0.77),
    candidate('generator', 'Generator Inlet, Interlock & Installation', 'Wylie', 0.6),
  ],
  excluded: [],
  rationale: 'Panel upgrade in Rockwall wins on opportunity and priority; EV charger in Garland is the runner-up.',
  degraded: false,
};

const PHOTOS = [
  'panel-upgrade-rockwall-200a.jpg',
  'ev-charger-garage-garland.jpg',
  'panel-open-before.jpg',
  'ev-charger-install-2.jpg',
  'before-after-panel-rockwall.jpg',
  'generator-inlet-install.jpg',
];

const HISTORY = {
  posts: [
    { platform: 'facebook', post_date: '2026-08-24', service: 'EV Charger Installation', hook: 'Thinking about an EV? Read this first.', status: 'posted', platform_post_id: '1', photo_file: null, city: 'Rowlett' },
    { platform: 'facebook', post_date: '2026-08-31', service: 'Generator', hook: 'Storm season is not over yet.', status: 'posted', platform_post_id: '2', photo_file: null },
    { platform: 'gbp', post_date: '2026-08-28', service: 'Generator', hook: '', status: 'posted', platform_post_id: '3', photo_file: 'x.jpg' },
    { platform: 'facebook', post_date: '2026-08-17', service: 'Panel', hook: '  storm season is NOT over yet. ', status: 'posted', platform_post_id: '4', photo_file: null },
  ],
  website_tasks: [{ title: 'Fix /contact/ 404', type: 'website_layout_update', status: 'open', updated_at: '2026-08-01T00:00:00Z' }],
};

function loadModelPlan() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function makeInput(overrides = {}) {
  return buildGenerationInput({ facts, selection: SELECTION, weekSpec: WEEK_SPEC, photos: PHOTOS, history: HISTORY, policy: POLICY, ...overrides });
}

/**
 * A fake llm client that behaves like llm.mjs chatJSON: parses the canned
 * response loosely, validates it with the schema it was handed, never throws
 * on validation failure, and (like the real client) records usage in a meter
 * when given one. Responses are consumed in order; the last one repeats.
 */
function fakeLlm(responses, { meter = null } = {}) {
  const calls = [];
  async function chatJSON(args) {
    calls.push(args);
    const canned = responses[Math.min(calls.length - 1, responses.length - 1)];
    const raw = typeof canned === 'string' ? canned : JSON.stringify(canned);
    const usage = { input: 1000, output: 500 };
    if (meter) meter.record({ kind: 'llm', model: 'fake', inputTokens: usage.input, outputTokens: usage.output, label: args.label });
    const parsed = parseJsonLoose(raw);
    if (parsed.error) {
      return { data: null, issues: [{ path: '', message: `model output is not JSON: ${parsed.error}` }], usage, model: 'fake', raw };
    }
    const { data, issues } = args.schema ? parseOrIssues(args.schema, parsed.value) : { data: parsed.value, issues: [] };
    return { data, issues, usage, model: 'fake', raw };
  }
  return { chatJSON, calls };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('generate helpers', () => {
  it('contactLine is the fixed crew.py first-comment line built from facts', () => {
    assert.equal(contactLine(facts), '📲 Text us at (469) 896-3862 to get a free instant quote — calls welcome too!');
    assert.throws(() => contactLine({ phones: {} }), /customer_text/);
  });

  it('weekdayName is timezone-proof and rejects impossible dates', () => {
    assert.equal(weekdayName('2026-09-07'), 'Monday');
    assert.equal(weekdayName('2026-09-04'), 'Friday');
    assert.equal(weekdayName('2026-09-12'), 'Saturday');
    assert.equal(weekdayName('2028-02-29'), 'Tuesday');
    assert.throws(() => weekdayName('9/7/2026'), /bad date/);
    assert.throws(() => weekdayName('2026-13-45'), /bad date/);
    assert.throws(() => weekdayName('2026-02-30'), /bad date/);
    assert.throws(() => weekdayName(undefined), /bad date/);
  });

  it('redactUnknownPhones keeps the two approved numbers and withholds every other one', () => {
    const text = 'Text (469) 896-3862 or call 469-863-9804; the form placeholder is (469) 555-0123 and 214.555.0199.';
    const out = redactUnknownPhones(text, facts);
    assert.equal(out, `Text (469) 896-3862 or call 469-863-9804; the form placeholder is ${REDACTED_PHONE} and ${REDACTED_PHONE}.`);
    assert.equal(redactUnknownPhones('no numbers here', facts), 'no numbers here');
    assert.equal(redactUnknownPhones(null, facts), '');
    assert.equal(redactUnknownPhones('(469) 896-3862', { phones: {} }), REDACTED_PHONE);
  });

  it('redactUnknownPhones catches every shape validate.mjs would flag, not only "(AAA) BBB-CCCC"', () => {
    const R = REDACTED_PHONE;
    const loose = 'Try 469 555 0123, 4695550123, +1 469-555-0123, 1-469-555-0123, (469)555-0123, ( 469 ) 555 0123, 469–555–0123 or 469 896 3862.';
    assert.equal(redactUnknownPhones(loose, facts), `Try ${R}, ${R}, ${R}, ${R}, ${R}, ${R}, ${R} or 469 896 3862.`);
    assert.equal(redactUnknownPhones('+1 (469) 896-3862 is approved', facts), '+1 (469) 896-3862 is approved');
    const plain = 'Rowlett, TX 75089, founded 2021, a 200-amp panel at 8902 Merritt Rd., 2026-09-04, [0:00-0:03].';
    assert.equal(redactUnknownPhones(plain, facts), plain, 'zips, years, amperage, dates and time stamps are not phones');
  });

  it('homeBaseCity reads the city out of the facts address', () => {
    assert.equal(homeBaseCity(facts), 'Rowlett');
    assert.equal(homeBaseCity({ address: '1 Main St, Plano, TX 75023' }), 'Plano');
    assert.equal(homeBaseCity({ address: 'Rowlett' }), null);
    assert.equal(homeBaseCity({}), null);
  });

  it('seasonalHint covers every month', () => {
    for (let m = 1; m <= 12; m += 1) assert.ok(seasonalHint(m).length > 0, `month ${m}`);
    assert.match(seasonalHint(4), /storm season/);
    assert.match(seasonalHint(7), /summer/);
    assert.match(seasonalHint(1), /winter/);
    assert.equal(seasonalHint(13), '');
  });

  it('photoFilenames accepts strings and objects, dedupes and sorts', () => {
    const out = photoFilenames(['b.jpg', { file: 'a.jpg' }, { filename: 'c.jpg' }, { name: 'b.jpg' }, '', null, { nope: 1 }]);
    assert.deepEqual(out, ['a.jpg', 'b.jpg', 'c.jpg']);
    assert.deepEqual(photoFilenames(undefined), []);
  });

  it('pickSupporting skips the winner and caps at n', () => {
    const two = pickSupporting(SELECTION, 2);
    assert.deepEqual(two.map((c) => c.service_key), ['ev_charger', 'troubleshooting']);
    assert.deepEqual(pickSupporting({ winner: WINNER, ranked: [WINNER] }), []);
  });
});

// ---------------------------------------------------------------------------
// buildGenerationInput
// ---------------------------------------------------------------------------

describe('buildGenerationInput', () => {
  it('carries the exact WeekSpec dates so the model never computes them', () => {
    const input = makeInput();
    assert.equal(input.week_of, '2026-09-07');
    assert.deepEqual(input.schedule.gbp.map((d) => d.date), Object.values(WEEK_SPEC.gbp_dates));
    assert.deepEqual(input.schedule.gbp.map((d) => d.day), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(input.schedule.gbp[0].weekday, 'Friday');
    assert.deepEqual(input.schedule.facebook.map((d) => [d.day, d.date]), [[1, '2026-09-07'], [3, '2026-09-09'], [5, '2026-09-11'], [6, '2026-09-12']]);
    assert.deepEqual(input.schedule.facebook.map((d) => d.allowed_types), [['slideshow'], ['photo', 'carousel'], ['photo', 'carousel'], ['photo', 'text']]);
  });

  it('carries the business facts the prompt rules refer to, and nothing bulky', () => {
    const { business } = makeInput();
    assert.equal(business.name, 'Grizzly Electrical Solutions');
    assert.equal(business.founded_year, 2021);
    assert.equal(business.tenure_phrase, 'since 2021');
    assert.deepEqual(business.forbidden_tenure_phrases, ['over a decade', '3+ years']);
    assert.deepEqual(business.phones, { customer_text: '(469) 896-3862', published_main: '(469) 863-9804' });
    assert.equal(business.domain, 'grizzlyelectricaltx.com');
    assert.ok(business.existing_pages.includes('/panel-upgrades/'));
    assert.ok(business.existing_blog_slugs.includes('recessed-lighting-cost-dfw'));
    assert.ok(business.priority_services.length > 0);
    assert.ok(Array.isArray(business.approved_prices));
    assert.equal(business.home_base, 'Rowlett');
    assert.equal(business.raw, undefined);
    assert.equal(JSON.stringify(makeInput()).includes(facts.raw.slice(0, 200)), false);
  });

  it('carries no phone number other than facts.phones.* (the facts file quotes a fake placeholder)', () => {
    // Guard: the real facts file must still contain the number this test exists for.
    assert.match(facts.raw, /555-0123/, 'facts file no longer quotes the placeholder; update this test');
    const input = makeInput();
    const found = JSON.stringify(input).match(PHONE_SHAPE) ?? [];
    const allowed = new Set([facts.phones.customer_text, facts.phones.published_main]);
    assert.ok(found.length >= 2, 'both approved numbers are still passed');
    assert.deepEqual(found.filter((p) => !allowed.has(p)), []);
    assert.ok(input.business.known_issues.some((k) => k.includes(REDACTED_PHONE)));
    assert.doesNotMatch(JSON.stringify(input), /555-0123/);
  });

  it('fixes the contact line, the boost budget and the constraints', () => {
    const input = makeInput();
    assert.equal(input.contact_line, contactLine(facts));
    assert.deepEqual(input.boost, { weekly_usd: 50, max_yes_rows: 2, allowed_decisions: ['YES', 'MAYBE', 'NO'] });
    assert.equal(input.constraints.gbp_posts, 7);
    assert.equal(input.constraints.facebook_posts, 4);
    assert.equal(input.constraints.winner_city_min_gbp_mentions, 3);
    assert.equal(input.constraints.winner_city_min_facebook_mentions, 2);
    assert.equal(makeInput({ policy: { boost_weekly_usd: 0 } }).boost.weekly_usd, 0, 'an explicit zero budget is allowed');
    assert.throws(() => makeInput({ policy: {} }), /boost_weekly_usd/, 'a missing budget fails closed, never becomes $0');
    assert.throws(() => makeInput({ policy: { boost_weekly_usd: '50' } }), /boost_weekly_usd/, 'strings are not silently coerced');
    assert.throws(() => makeInput({ policy: { boost_weekly_usd: -5 } }), /boost_weekly_usd/);
  });

  it('names the winner, two supporting candidates and their cities', () => {
    const { topic } = makeInput();
    assert.equal(topic.winner.service_key, 'panel_upgrade');
    assert.equal(topic.winner.city, 'Rockwall');
    assert.equal(topic.winner.total, 0.912);
    assert.deepEqual(topic.winner.reasons, WINNER.reasons);
    assert.equal(topic.winner.scores, undefined);
    assert.deepEqual(topic.supporting.map((c) => [c.service_key, c.city]), [['ev_charger', 'Garland'], ['troubleshooting', 'Rowlett']]);
    assert.deepEqual(topic.supporting_cities, ['Garland', 'Rowlett']);
    assert.equal(topic.rationale, SELECTION.rationale);
    assert.equal(topic.degraded, false);
  });

  it('lists photos and recent hooks to avoid, newest first, deduped', () => {
    const input = makeInput();
    assert.deepEqual(input.photos, [...PHOTOS].sort());
    assert.deepEqual(input.history.recent_hooks_to_avoid, ['Storm season is not over yet.', 'Thinking about an EV? Read this first.']);
    assert.equal(input.history.recent_posts[0].post_date, '2026-08-31');
    assert.deepEqual(input.history.recent_posts[1], { platform: 'gbp', post_date: '2026-08-28', service: 'Generator', city: null });
    assert.deepEqual(input.history.recent_website_tasks, [{ title: 'Fix /contact/ 404', type: 'website_layout_update', status: 'open' }]);
  });

  it('keeps website tasks of every status, with the status attached, rather than pretending they are all open', () => {
    const history = { posts: [], website_tasks: [
      { title: 'Done thing', type: 'website_copy_update', status: 'done', updated_at: '2026-08-01T00:00:00Z' },
      { title: 'Open thing', type: 'website_faq_update', status: 'open', updated_at: '2026-08-02T00:00:00Z' },
    ] };
    const input = makeInput({ history });
    assert.deepEqual(input.history.recent_website_tasks.map((t) => [t.title, t.status]), [['Done thing', 'done'], ['Open thing', 'open']]);
    assert.equal(input.history.open_website_tasks, undefined);
  });

  it('passes every distinct recent hook (validate rejects a repeat of any of them), deduped the way validate compares', () => {
    const posts = [];
    for (let i = 0; i < 90; i += 1) {
      posts.push({ platform: i % 2 ? 'gbp' : 'facebook', post_date: `2026-0${1 + (i % 8)}-0${1 + (i % 9)}`, service: 's', hook: `Hook number ${i}` });
    }
    posts.push({ platform: 'facebook', post_date: '2026-08-31', service: 's', hook: 'HOOK NUMBER 1!' });
    posts.push({ platform: 'facebook', post_date: '2026-08-30', service: 's', hook: 'Hook, number 1' });
    const input = makeInput({ history: { posts, website_tasks: [] } });
    const hooks = input.history.recent_hooks_to_avoid;
    assert.equal(hooks.length, 90, 'an 8-week history (~90 posts) is passed whole, not truncated to 40');
    assert.equal(hooks[0], 'HOOK NUMBER 1!', 'newest first');
    assert.equal(hooks.filter((h) => hookKey(h) === 'hook number 1').length, 1, 'punctuation and case variants collapse to one entry');
    assert.equal(new Set(hooks.map(hookKey)).size, hooks.length);
  });

  it('tolerates a missing history and no photos', () => {
    const input = makeInput({ history: null, photos: undefined });
    assert.deepEqual(input.history, { recent_hooks_to_avoid: [], recent_posts: [], recent_website_tasks: [] });
    assert.deepEqual(input.photos, []);
  });

  it('is deterministic and JSON-safe', () => {
    const a = JSON.stringify(makeInput());
    const b = JSON.stringify(makeInput());
    assert.equal(a, b);
    assert.deepEqual(JSON.parse(a), makeInput());
    assert.match(makeInput().task, /JSON/);
    assert.equal(makeInput().seasonal_context, seasonalHint(9));
  });

  it('rejects missing inputs loudly', () => {
    assert.throws(() => buildGenerationInput({ selection: SELECTION, weekSpec: WEEK_SPEC }), /facts/);
    assert.throws(() => buildGenerationInput({ facts, selection: {}, weekSpec: WEEK_SPEC }), /winner/);
    assert.throws(() => buildGenerationInput({ facts, selection: SELECTION, weekSpec: { week_of: '2026-09-07' } }), /weekSpec/);
    const partial = { ...WEEK_SPEC, gbp_dates: { ...WEEK_SPEC.gbp_dates, 7: undefined } };
    assert.throws(() => buildGenerationInput({ facts, selection: SELECTION, weekSpec: partial }), /gbp_dates missing day 7/);
  });
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe('plan.system.md', () => {
  const text = loadSystemPrompt();

  it('exists, says the response is a JSON object, and carries the editorial rules', () => {
    assert.ok(fs.existsSync(SYSTEM_PROMPT_PATH));
    assert.match(text, /exactly one JSON object/);
    assert.match(text, /license number/i);
    assert.match(text, /30 to 80 words/);
    assert.match(text, /day 1 `type` is "slideshow"/);
    assert.match(text, /sum\(daily_usd x days\) == boost\.weekly_usd/);
    assert.match(text, /at least 3 of the 7 GBP posts/);
    assert.match(text, /at least 2 of the 4 Facebook posts/);
    assert.match(text, /tenure_phrase/);
    assert.match(text, /approved_prices/);
    assert.match(text, /Do not output `date`, `status`, `contact`, `video_prompt`/);
    assert.match(text, /Never compute or mention calendar dates/);
    assert.match(text, /do not write the email address/);
    assert.match(text, /history\.recent_website_tasks/);
    assert.match(text, /\[phone number withheld\]/);
    assert.doesNotMatch(text, PHONE_SHAPE, 'no phone numbers hard-coded in the prompt');
  });

  it('asks for what validate.mjs checks: new hooks AND headlines, unique within the plan, a local tag on every GBP post, 30+ word bodies', () => {
    assert.match(text, /## Hooks and headlines must be new/);
    assert.match(text, /every GBP `headline` in this plan must differ from every entry/);
    assert.match(text, /from each other within this plan/);
    assert.match(text, /ignoring case\s+and punctuation/);
    assert.match(text, /Every post carries at least one local tag/);
    assert.match(text, /`body`: 30 to 50 words/);
  });

  it('keeps business truth in the facts file: no city names, addresses, domains or emails hard-coded', () => {
    assert.match(text, /`business\.home_base`/);
    for (const city of ['Rowlett', 'Rockwall', 'Garland', 'Plano', 'Dallas']) assert.doesNotMatch(text, new RegExp(city), `city ${city} hard-coded`);
    assert.doesNotMatch(text, /Merritt|75089/);
    assert.doesNotMatch(text, /grizzlyelectrical(tx)?\.(com|net)|@/);
  });

  it('promptVersion is a stable 12-hex content hash that ignores line-ending style', () => {
    assert.match(promptVersion(text), /^[0-9a-f]{12}$/);
    assert.equal(promptVersion(text), promptVersion());
    assert.notEqual(promptVersion(text), promptVersion(`${text}\n`));
    assert.equal(promptVersion(text.replace(/\n/g, '\r\n')), promptVersion(text));
    assert.equal(promptVersion('a\r\nb'), promptVersion('a\nb'));
  });

  it('loadSystemPrompt refuses a prompt that never mentions JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-prompt-'));
    const tmp = path.join(dir, 'prompt.md');
    fs.writeFileSync(tmp, 'Write a plan.\n');
    try {
      assert.throws(() => loadSystemPrompt(tmp), /JSON/);
      assert.throws(() => loadSystemPrompt(path.join(dir, 'missing.md')), /ENOENT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// planShapeIssues and assemblePlan
// ---------------------------------------------------------------------------

describe('planShapeIssues', () => {
  it('passes the canned plan', () => {
    const input = makeInput();
    const { data, issues } = parseOrIssues(ModelPlanSchema, loadModelPlan());
    assert.deepEqual(issues, []);
    assert.deepEqual(planShapeIssues(data, input), []);
  });

  it('flags duplicate or missing days on either platform', () => {
    const plan = loadModelPlan();
    plan.gbp[6].day = 1;
    plan.facebook[3].day = 5;
    plan.facebook[3].type = 'photo'; // valid on day 5, so only the day-set issue fires
    const issues = planShapeIssues(plan, makeInput());
    assert.deepEqual(issues.map((i) => i.path), ['gbp', 'facebook']);
    assert.match(issues[0].message, /got \[1,2,3,4,5,6,1\]/);
  });

  it('flags a Facebook type the day does not allow', () => {
    const plan = loadModelPlan();
    plan.facebook[0].type = 'photo';
    plan.facebook[3].type = 'carousel';
    const issues = planShapeIssues(plan, makeInput());
    assert.deepEqual(issues.map((i) => i.path), ['facebook[0].type', 'facebook[3].type']);
    assert.match(issues[0].message, /day 1 must be slideshow/);
    assert.match(issues[1].message, /day 6 must be photo or text/);
    for (const [day, types] of Object.entries(FB_TYPES_BY_DAY)) assert.ok(types.length >= 1, `day ${day}`);
  });

  it('flags a topic that drifted from the winner', () => {
    const plan = loadModelPlan();
    plan.topic.city = 'Rowlett';
    const issues = planShapeIssues(plan, makeInput());
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'topic');
    assert.match(issues[0].message, /city Rockwall/);
    assert.deepEqual(planShapeIssues(null, makeInput()).map((i) => i.message), ['no plan object']);
  });
});

describe('assemblePlan', () => {
  it('fills the code-owned fields and sorts by day', () => {
    const input = makeInput();
    const plan = loadModelPlan();
    plan.gbp.reverse();
    const out = assemblePlan(plan, input, 'att-1');
    assert.equal(out.attempt_id, 'att-1');
    assert.equal(out.week_of, '2026-09-07');
    assert.deepEqual(out.gbp.map((g) => g.day), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(out.gbp.map((g) => g.date), Object.values(WEEK_SPEC.gbp_dates));
    assert.ok(out.gbp.every((g) => g.status === 'Needs approval'));
    assert.deepEqual(out.facebook.map((f) => f.date), ['2026-09-07', '2026-09-09', '2026-09-11', '2026-09-12']);
    assert.ok(out.facebook.every((f) => f.contact === input.contact_line && f.video_prompt === ''));
    assert.deepEqual(parseOrIssues(PlanSchema, out).issues, []);
  });

  it('binds topic to the selection winner even when the model paraphrased the label or query family', () => {
    const input = makeInput();
    const plan = loadModelPlan();
    plan.topic.service_label = 'Panel Upgrades';
    plan.topic.query_family = ['something the model made up'];
    const out = assemblePlan(plan, input, 'att-1');
    assert.deepEqual(out.topic, {
      service_key: 'panel_upgrade',
      service_label: 'Electrical Panel Upgrade / Replacement',
      city: 'Rockwall',
      query_family: WINNER.query_family,
    });
    assert.notEqual(out.topic.query_family, WINNER.query_family, 'copied, not aliased');
    assert.deepEqual(parseOrIssues(PlanSchema, out).issues, []);
  });

  it('throws GenerationInvalid when a day has no date in the schedule', () => {
    const input = makeInput();
    const plan = loadModelPlan();
    plan.facebook[0].day = 2;
    assert.throws(() => assemblePlan(plan, input, 'att-1'), (e) => e instanceof GenerationInvalid && /facebook date for day 2/.test(e.message));
  });
});

// ---------------------------------------------------------------------------
// generatePlan
// ---------------------------------------------------------------------------

describe('generatePlan', () => {
  it('returns a PlanSchema-valid plan from one call and overrides any code-owned fields the model wrote', async () => {
    const canned = loadModelPlan();
    canned.gbp[0].date = '1999-01-01';
    canned.gbp[0].status = 'Ready';
    canned.facebook[0].date = '1999-01-01';
    canned.facebook[0].contact = 'call my cell';
    canned.facebook[0].video_prompt = 'cinematic drone shot';
    const input = makeInput();
    const meter = createCostMeter({ ceilingUsd: 5, pricing: { fake: { input: 1, output: 1 } } });
    const llm = fakeLlm([canned]);

    const plan = await generatePlan(input, { llm, meter, attemptId: 'att-1' });

    assert.equal(llm.calls.length, 1);
    assert.deepEqual(parseOrIssues(PlanSchema, plan).issues, []);
    assert.equal(plan.attempt_id, 'att-1');
    assert.equal(plan.week_of, '2026-09-07');
    assert.equal(plan.gbp[0].date, '2026-09-04');
    assert.equal(plan.gbp[0].status, 'Needs approval');
    assert.equal(plan.facebook[0].date, '2026-09-07');
    assert.equal(plan.facebook[0].contact, input.contact_line);
    assert.equal(plan.facebook[0].video_prompt, '');
    assert.equal(plan.topic.city, 'Rockwall');
    assert.equal(plan.facebook.filter((f) => f.boost.decision === 'YES').reduce((s, f) => s + f.boost.daily_usd * f.boost.days, 0), 50);

    const call = llm.calls[0];
    assert.equal(call.label, LABELS.first);
    assert.equal(call.schema, ModelPlanSchema);
    assert.match(call.system, /JSON/);
    assert.equal(call.user, input);
    assert.equal(call.maxTokens, 8000);
    assert.equal(call.temperature, 0.4);
  });

  it('repairs once when the first response fails the schema, and the repair message carries the issues and the previous JSON', async () => {
    const broken = loadModelPlan();
    broken.gbp.pop();
    broken.facebook[1].hashtags = ['#a', '#b', '#c', '#d'];
    const input = makeInput();
    const llm = fakeLlm([broken, loadModelPlan()]);

    const plan = await generatePlan(input, { llm, attemptId: 'att-2', systemPrompt: 'Reply with a JSON object.' });

    assert.equal(llm.calls.length, 2);
    assert.equal(plan.gbp.length, 7);
    const repair = llm.calls[1];
    assert.equal(repair.label, LABELS.repair);
    assert.equal(repair.system, 'Reply with a JSON object.');
    assert.match(repair.user.task, /REPAIR/);
    assert.ok(repair.user.issues.length >= 2);
    assert.ok(repair.user.issues.some((i) => i.path === 'gbp'));
    assert.ok(repair.user.issues.some((i) => i.path === 'facebook[1].hashtags'));
    assert.equal(repair.user.previous_response.gbp.length, 6);
    assert.equal(repair.user.original_request, input);
  });

  it('repairs when the schema passes but the shape is wrong (duplicate day, wrong day-1 type)', async () => {
    const shaped = loadModelPlan();
    shaped.facebook[0].type = 'photo';
    shaped.gbp[1].day = 1;
    const llm = fakeLlm([shaped, loadModelPlan()]);

    const plan = await generatePlan(makeInput(), { llm, attemptId: 'att-3', systemPrompt: 'JSON please.' });

    assert.equal(llm.calls.length, 2);
    assert.equal(plan.facebook[0].type, 'slideshow');
    const { issues, previous_response } = llm.calls[1].user;
    assert.deepEqual(issues.map((i) => i.path), ['gbp', 'facebook[0].type']);
    assert.equal(previous_response.facebook[0].type, 'photo');
  });

  it('sends schema and shape issues together in the one repair call when the first reply fails both', async () => {
    const broken = loadModelPlan();
    broken.gbp.pop(); // schema: gbp must hold exactly 7 items
    broken.facebook[0].type = 'photo'; // shape: day 1 must be a slideshow
    broken.topic.city = 'Garland'; // shape: topic drifted from the winner
    const llm = fakeLlm([broken, loadModelPlan()]);

    await generatePlan(makeInput(), { llm, attemptId: 'att-11', systemPrompt: 'JSON please.' });

    assert.equal(llm.calls.length, 2);
    const { issues } = llm.calls[1].user;
    const paths = issues.map((i) => i.path);
    assert.ok(paths.includes('gbp'), 'schema issue kept');
    assert.ok(paths.includes('facebook[0].type'), 'shape issue found on the unparsed reply');
    assert.ok(paths.includes('topic'), 'topic drift found on the unparsed reply');
    assert.equal(new Set(issues.map((i) => `${i.path} ${i.message}`)).size, issues.length, 'no duplicate issues');
  });

  it('uses the raw text as previous_response when the first reply was not JSON', async () => {
    const llm = fakeLlm(['Sorry, I cannot do that.', loadModelPlan()]);
    await generatePlan(makeInput(), { llm, attemptId: 'att-4', systemPrompt: 'JSON please.' });
    assert.equal(llm.calls.length, 2);
    assert.equal(llm.calls[1].user.previous_response, 'Sorry, I cannot do that.');
    assert.match(llm.calls[1].user.issues[0].message, /not JSON/);
  });

  it('throws GenerationInvalid with the issues when the repair also fails, after exactly two calls', async () => {
    const broken = loadModelPlan();
    broken.gbp.pop();
    const stillBroken = loadModelPlan();
    stillBroken.facebook[0].boost.decision = 'SURE';
    const llm = fakeLlm([broken, stillBroken]);

    await assert.rejects(
      () => generatePlan(makeInput(), { llm, attemptId: 'att-5', systemPrompt: 'JSON please.' }),
      (e) => {
        assert.ok(e instanceof GenerationInvalid);
        assert.equal(e.name, 'GenerationInvalid');
        assert.match(e.message, /after one repair/);
        assert.ok(e.issues.some((i) => i.path === 'facebook[0].boost.decision'));
        return true;
      },
    );
    assert.equal(llm.calls.length, 2);
  });

  it('throws GenerationInvalid when the repair passes the model schema but drifts in shape', async () => {
    const drift = loadModelPlan();
    drift.topic.service_key = 'ev_charger';
    const llm = fakeLlm([drift, drift]);
    await assert.rejects(
      () => generatePlan(makeInput(), { llm, attemptId: 'att-6', systemPrompt: 'JSON please.' }),
      (e) => e instanceof GenerationInvalid && e.issues.length === 1 && e.issues[0].path === 'topic',
    );
    assert.equal(llm.calls.length, 2);
  });

  it('lets a tripped budget surface before any call', async () => {
    const meter = createCostMeter({ ceilingUsd: 0.01, pricing: { fake: { input: 1, output: 1 } } });
    meter.record({ kind: 'llm', model: 'fake', usd: 0.02 });
    const llm = fakeLlm([loadModelPlan()]);
    await assert.rejects(() => generatePlan(makeInput(), { llm, meter, attemptId: 'att-7', systemPrompt: 'JSON please.' }), BudgetExceeded);
    assert.equal(llm.calls.length, 0);
  });

  it('checks the budget again before the repair call, so a first call that spends the ceiling stops the repair', async () => {
    // 1000 in + 500 out at $1/M each = $0.0015 per call. assertUnder(0) compares what is
    // already spent against the ceiling, so after the first call $0.0015 > $0.001 trips it.
    const meter = createCostMeter({ ceilingUsd: 0.001, pricing: { fake: { input: 1, output: 1 } } });
    const broken = loadModelPlan();
    broken.gbp.pop();
    const llm = fakeLlm([broken, loadModelPlan()], { meter });
    await assert.rejects(() => generatePlan(makeInput(), { llm, meter, attemptId: 'att-7b', systemPrompt: 'JSON please.' }), BudgetExceeded);
    assert.equal(llm.calls.length, 1);
    assert.equal(meter.entries().length, 1);
    assert.equal(meter.entries()[0].label, LABELS.first);
  });

  it('never writes secrets or the raw facts file into the model messages', async () => {
    const llm = fakeLlm([loadModelPlan()]);
    await generatePlan(makeInput(), { llm, attemptId: 'att-8', systemPrompt: 'JSON please.' });
    const text = JSON.stringify(llm.calls[0].user);
    assert.doesNotMatch(text, /Bearer|sk-|api[_-]?key/i);
    assert.equal(text.includes('Reviewed by the owner'), false);
  });

  it('rejects a bad llm, a missing attemptId, or an input that did not come from buildGenerationInput', async () => {
    await assert.rejects(() => generatePlan(makeInput(), { llm: {}, attemptId: 'x' }), /chatJSON/);
    await assert.rejects(() => generatePlan(makeInput(), { llm: fakeLlm([loadModelPlan()]) }), /attemptId/);
    await assert.rejects(() => generatePlan(makeInput(), { llm: fakeLlm([loadModelPlan()]), attemptId: 42 }), /attemptId/);
    await assert.rejects(() => generatePlan({ week_of: '2026-09-07' }, { llm: fakeLlm([loadModelPlan()]), attemptId: 'x' }), /buildGenerationInput/);
    const { topic: _dropped, ...noTopic } = makeInput();
    await assert.rejects(() => generatePlan(noTopic, { llm: fakeLlm([loadModelPlan()]), attemptId: 'x' }), /buildGenerationInput/);
  });

  it('returns the winner topic and strips unknown keys the model added', async () => {
    const canned = loadModelPlan();
    canned.topic.service_label = 'Panels!';
    canned.extra_top_level = 'ignored';
    canned.gbp[2].internal_note = 'ignored';
    const llm = fakeLlm([canned]);
    const plan = await generatePlan(makeInput(), { llm, attemptId: 'att-10', systemPrompt: 'JSON please.' });
    assert.equal(llm.calls.length, 1, 'label drift alone is not worth a paid repair call');
    assert.equal(plan.topic.service_label, WINNER.service_label);
    assert.equal(plan.extra_top_level, undefined);
    assert.equal(plan.gbp[2].internal_note, undefined);
  });

  it('reads plan.system.md by default', async () => {
    const llm = fakeLlm([loadModelPlan()]);
    await generatePlan(makeInput(), { llm, attemptId: 'att-9' });
    assert.equal(llm.calls[0].system, loadSystemPrompt());
  });
});

describe('collectIssues', () => {
  it('reports "no plan object" for an empty result, schema plus shape for a failed parse, shape only for a passing one', () => {
    const input = makeInput();
    assert.deepEqual(collectIssues(undefined, input), [{ path: '', message: 'no plan object' }]);
    assert.deepEqual(collectIssues({ data: null, issues: [], raw: '' }, input), [{ path: '', message: 'no plan object' }]);
    const notJson = { data: null, issues: [{ path: '', message: 'model output is not JSON: x' }], raw: 'nope' };
    assert.deepEqual(collectIssues(notJson, input), notJson.issues, 'nothing to shape-check when the reply is not JSON');
    const broken = loadModelPlan();
    broken.facebook[0].type = 'photo';
    const failed = { data: null, issues: [{ path: 'gbp', message: 'bad' }], raw: `\`\`\`json\n${JSON.stringify(broken)}\n\`\`\`` };
    assert.deepEqual(collectIssues(failed, input).map((i) => i.path), ['gbp', 'facebook[0].type']);
    const arrayReply = { data: null, issues: [{ path: '', message: 'Expected object, received array' }], raw: '[]' };
    assert.deepEqual(collectIssues(arrayReply, input), arrayReply.issues);
    assert.deepEqual(collectIssues(parseOrIssues(ModelPlanSchema, loadModelPlan()), input), []);
  });
});

describe('buildRepairMessage', () => {
  it('prefers parsed data, then loosely parsed raw, then the raw string', () => {
    const input = makeInput();
    const issues = [{ path: 'gbp', message: 'x' }];
    assert.deepEqual(buildRepairMessage(input, { data: { a: 1 }, raw: '{"a":1}' }, issues).previous_response, { a: 1 });
    assert.deepEqual(buildRepairMessage(input, { data: null, raw: '```json\n{"b":2}\n```' }, issues).previous_response, { b: 2 });
    assert.equal(buildRepairMessage(input, { data: null, raw: 'nope' }, issues).previous_response, 'nope');
    assert.equal(buildRepairMessage(input, { data: null, raw: undefined }, issues).previous_response, '');
  });
});

// ---------------------------------------------------------------------------
// The canned plan: the offline e2e feeds it to validate.mjs, so every rule the
// prompt states and validate enforces must hold in it, not just the schema.
// ---------------------------------------------------------------------------

describe('generate.model-plan.json obeys the rules it is meant to demonstrate', () => {
  const plan = loadModelPlan();
  const text = JSON.stringify(plan);
  const mentions = (t, city) => new RegExp(`\\b${city}\\b`, 'i').test(String(t ?? ''));

  it('is a valid ModelPlan with no shape issues against the test selection', () => {
    assert.deepEqual(parseOrIssues(ModelPlanSchema, plan).issues, []);
    assert.deepEqual(planShapeIssues(plan, makeInput()), []);
  });

  it('names the winner city in at least 3 GBP posts and 2 Facebook posts', () => {
    const gbpHits = plan.gbp.filter((g) => mentions([g.headline, g.body, g.caption, g.topic].join(' '), WINNER.city)).length;
    const fbHits = plan.facebook.filter((f) => mentions([f.hook, f.body].join(' '), WINNER.city)).length;
    assert.ok(gbpHits >= 3, `winner city in ${gbpHits} GBP posts`);
    assert.ok(fbHits >= 2, `winner city in ${fbHits} Facebook posts`);
  });

  it('carries no phone number, dollar amount, domain, email, license number, forbidden tenure phrase or stray year', () => {
    assert.deepEqual(text.match(PHONE_SHAPE) ?? [], []);
    assert.doesNotMatch(text, /\$\s?\d/);
    assert.doesNotMatch(text, /https?:\/\/|www\.|\.(?:com|net|org)\b|@/i);
    assert.doesNotMatch(text, /licen[cs]e\s*(?:#|no\.?|number)/i);
    for (const phrase of facts.forbidden_phrases) assert.equal(text.toLowerCase().includes(phrase.toLowerCase()), false, `forbidden: ${phrase}`);
    assert.match(text, new RegExp(facts.tenure_phrase), 'uses the tenure phrase');
    const years = [...new Set(text.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
    assert.deepEqual(years, [String(facts.founded_year)], 'the only year mentioned is the founding year');
  });

  it('uses only listed photos, lists every gap, and puts a local tag on every GBP post', () => {
    const photoSet = new Set(PHOTOS);
    const items = [...plan.gbp, ...plan.facebook];
    for (const item of items) {
      if (item.photo_file !== null) assert.ok(photoSet.has(item.photo_file), `unknown photo ${item.photo_file}`);
    }
    assert.equal(plan.notes.photo_gaps.length, items.filter((i) => i.photo_file === null).length);
    for (const g of plan.gbp) {
      assert.ok(g.hashtags.length >= 3 && g.hashtags.length <= 5, `day ${g.day} hashtag count`);
      assert.ok(g.hashtags.some((h) => /tx$/i.test(h) || /dfw/i.test(h)), `day ${g.day} lacks a local tag`);
      assert.ok(g.headline.length <= 58, `day ${g.day} headline ${g.headline.length} chars`);
      assert.ok(words(g.body) >= 30, `day ${g.day} body ${words(g.body)} words`);
    }
  });

  it('spreads services (max 3 GBP days each, never two days running) and keeps every hook and headline new and unique', () => {
    const counts = {};
    plan.gbp.forEach((g, i) => {
      counts[g.service] = (counts[g.service] ?? 0) + 1;
      if (i > 0) assert.notEqual(g.service, plan.gbp[i - 1].service, `day ${g.day} repeats the service of day ${plan.gbp[i - 1].day}`);
    });
    for (const [service, n] of Object.entries(counts)) assert.ok(n <= 3, `${service} on ${n} days`);
    const keys = [...plan.gbp.map((g) => hookKey(g.headline)), ...plan.facebook.map((f) => hookKey(f.hook))];
    assert.equal(new Set(keys).size, keys.length, 'hooks and headlines are unique within the plan');
    const past = new Set(HISTORY.posts.map((p) => hookKey(p.hook)).filter(Boolean));
    assert.deepEqual(keys.filter((k) => past.has(k)), [], 'no hook repeats history');
    plan.facebook.forEach((f, i) => { if (i > 0) assert.notEqual(f.format, plan.facebook[i - 1].format, 'format rotates'); });
    const week = new Set([WINNER.service_label, ...SELECTION.ranked.map((c) => c.service_label)]);
    for (const f of plan.facebook) assert.ok(week.has(f.service) || facts.priority_services.length > 0, `facebook service ${f.service}`);
  });

  it('boosts by the rules and keeps the Facebook media policy', () => {
    const yes = plan.facebook.filter((f) => f.boost.decision === 'YES');
    assert.ok(yes.length >= 1 && yes.length <= 2, `${yes.length} YES rows`);
    assert.equal(yes.reduce((s, f) => s + f.boost.daily_usd * f.boost.days, 0), POLICY.boost_weekly_usd);
    for (const f of plan.facebook.filter((r) => r.boost.decision !== 'YES')) assert.deepEqual([f.boost.daily_usd, f.boost.days], [null, null]);
    for (const f of plan.facebook) {
      assert.ok(FB_TYPES_BY_DAY[f.day].includes(f.type), `day ${f.day} type ${f.type}`);
      if (f.day === 1) assert.ok(f.on_screen_text.split('|').length >= 3 && /\[\d:\d\d-\d:\d\d\]/.test(f.on_screen_text), 'slideshow beats');
      else assert.equal(f.on_screen_text, '');
      const n = words(f.body);
      assert.ok(n >= 30 && n <= 80, `day ${f.day} body ${n} words`);
      assert.ok(f.hashtags.length <= 3);
    }
  });

  it('proposes website actions only against existing pages, with drafts only for blog posts', () => {
    assert.ok(plan.website_actions.length >= 1 && plan.website_actions.length <= 3);
    for (const a of plan.website_actions) {
      if (a.type !== 'website_blog_post') assert.ok(facts.existing_pages.includes(a.target), `${a.target} is not an existing page`);
      assert.equal(a.draft === null, a.type !== 'website_blog_post');
      assert.doesNotMatch(JSON.stringify(a), /wordpress|cms|plugin/i);
    }
  });
});
