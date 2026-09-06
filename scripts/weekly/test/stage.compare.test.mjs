// scripts/weekly/test/stage.compare.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareWithLegacy, buildCompareReport, parseSide, checkDates, factsViolations, serviceCounts, formatDuration,
  readLegacyOutputs, readShadowOutputs, LEGACY_FILES, GBP_DAYS, FB_DAYS,
} from '../lib/compare.mjs';
import { stagePlan } from '../lib/stage.mjs';
import { createFileStore } from '../lib/store.mjs';
import { parseFacts } from '../lib/facts.mjs';
import { parseGbpSchedule, parseFacebookSchedule, resolveWeekOf } from '../../supabase-sync.mjs';
import { NOW, WEEK, ATTEMPT_ID, makePlan } from './stage.helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FACTS = parseFacts(fs.readFileSync(path.join(here, 'fixtures', 'stage.facts.md'), 'utf8'));
const LATER = new Date('2026-09-04T21:03:12.000Z');
const POLICY = { boost_weekly_usd: 50, cities: [{ name: 'Rowlett', tier: 1 }, { name: 'Rockwall', tier: 1 }] };

function makeAttempt(overrides = {}) {
  const iso = NOW.toISOString();
  return {
    id: ATTEMPT_ID, week_of: '2026-09-07', mode: 'shadow', git_sha: 'abc123',
    versions: { schema: '2026-09-06.1', prompt: 'p1', policy: '2026-09-06.1' },
    models: { generate: 'deepseek-chat', fallback: null },
    started_at: iso, finished_at: null,
    stages: {
      collect: { started_at: iso, finished_at: '2026-09-04T21:00:40.000Z', status: 'ok', error: null },
      stage: { started_at: '2026-09-04T21:02:00.000Z', finished_at: null, status: 'running', error: null },
    },
    lease_until: null, budget_usd: 20, spent_usd: 0.42, status: 'running', error: null,
    ...overrides,
  };
}

const candidate = {
  service_key: 'panel_upgrade', service_label: 'Electrical Panel Upgrade / Replacement', city: 'Rockwall', query_family: ['electrical panel upgrade rockwall'],
  scores: { priority: 1, demand: 0.5, opportunity: 0.6, recency: 1, season: 0.5, performance: 0.5 }, total: 0.7, reasons: ['priority 5'],
};
const SELECTION = { winner: candidate, ranked: [candidate], excluded: [], rationale: 'Panel upgrade in Rockwall leads on priority and opportunity; EV charger is the runner-up.', degraded: false };
const VALID = { ok: true, errors: [], warnings: [] };

// ── minimal renderers in the DESIGN.md block layout (render.mjs belongs to another group) ──

function renderGbp(plan) {
  const blocks = plan.gbp.map((p) => [
    '---', '', `**DAY:** ${p.day}`, `**DATE:** ${p.date}`, `**SERVICE:** ${p.service}`, `**TOPIC:** ${p.topic}`, `**TREND_TIE:** ${p.trend_tie}`,
    `**HEADLINE:** ${p.headline}`, `**BODY:** ${p.body}`, `**CAPTION:** ${p.caption}`, `**PHOTO_FILE:** ${p.photo_file || 'NEEDS PHOTO'}`, `**CTA:** ${p.cta}`,
    `**HASHTAGS:** ${p.hashtags.join(' ')}`, '**STATUS:** Needs approval', '',
  ].join('\n'));
  return `# Grizzly Electrical Solutions — 7-Day GBP Posting Schedule\n**Schedule Period: ${plan.gbp[0].date} to ${plan.gbp[6].date}**\n\n${blocks.join('\n')}\n## Photo Gaps\n\n- none\n`;
}

function renderFacebook(plan) {
  const blocks = plan.facebook.map((p) => [
    '---', '', `**DAY:** ${p.day}`, `**DATE:** ${p.date}`, `**TYPE:** ${p.type}`, `**SERVICE:** ${p.service}`, `**POST_GOAL:** ${p.post_goal}`, `**FORMAT:** ${p.format}`,
    `**HOOK:** ${p.hook}`, `**BODY:** ${p.body}`, `**CTA:** ${p.cta}`, `**HASHTAGS:** ${p.hashtags.join(' ')}`, `**CONTACT:** ${p.contact}`,
    `**PHOTO_FILE:** ${p.photo_file || 'NEEDS PHOTO'}`, '**VIDEO_PROMPT:**', `**ON_SCREEN_TEXT:** ${p.on_screen_text}`, `**BOOST:** ${p.boost.decision}`,
    `**BOOST_AMOUNT:** ${p.boost.daily_usd == null ? '—' : `$${p.boost.daily_usd}`}`, `**BOOST_DURATION:** ${p.boost.days == null ? '—' : `${p.boost.days} days`}`,
    `**BOOST_TARGETING:** ${p.boost_targeting}`, '**STATUS:** Needs approval', '',
  ].join('\n'));
  return `# Grizzly Electrical Solutions — Facebook Content Schedule\n## Week of ${plan.week_of}\n\n${blocks.join('\n')}\n## CONTENT NOTES\n\n- none\n`;
}

// ── legacy-style files with deliberate defects ──

function legacyGbp({ day3Date = '2026-09-07', badPhone = true, decade = true, price = true } = {}) {
  const dates = { ...WEEK.gbp_dates, 3: day3Date };
  const bodies = {
    1: 'Texas storms can send surges through your wiring. Contact Grizzly to talk through surge protection.',
    2: `Breakers tripping? Call us at ${badPhone ? '(214) 555-0100' : '(469) 863-9804'} for a same-day look.`,
    3: `We have served DFW ${decade ? 'for over a decade' : 'since 2021'} with honest panel work.`,
    4: `Level 2 charger installs start at ${price ? '$1,500' : '$450'} for most homes.`,
    5: 'Recessed lighting brightens a kitchen without the clutter of fixtures.',
    6: 'A generator interlock keeps your fridge running when the grid does not.',
    7: 'GFCI outlets belong anywhere water is near power. We add them fast.',
  };
  const services = { 1: 'Whole-home surge protection', 2: 'Electrical Troubleshooting & Repair', 3: 'Electrical Panel Upgrade / Replacement', 4: 'EV Charger Installation', 5: 'Recessed Lighting Installation', 6: 'Generator Inlet, Interlock & Installation', 7: 'Outlet, Switch & GFCI Installation' };
  const blocks = [1, 2, 3, 4, 5, 6, 7].map((d) => [
    '---', '', `**DAY:** ${d}`, `**DATE:** ${dates[d]}`, `**SERVICE:** ${services[d]}`, `**TOPIC:** Legacy topic ${d}`, '**TREND_TIE:** "surge protector installation Dallas" — W3 Electric at callw3.com has a page.',
    `**HEADLINE:** Legacy headline ${d}`, `**BODY:** ${bodies[d]}`, `**CAPTION:** Caption ${d}`, `**PHOTO_FILE:** IMG_${2700 + d}.JPG`, '**CTA:** Use the Call button',
    '**HASHTAGS:** #RowlettElectrician #DFWElectrician #GrizzlyElectrical', '**STATUS:** Needs approval', '',
  ].join('\n'));
  return `# Grizzly Electrical Solutions — 7-Day GBP Posting Schedule\n**Schedule Period: September 4–10, 2026 | Prepared by GBP Poster Agent**\n\n${blocks.join('\n')}`;
}

function legacyFacebook() {
  const posts = [
    [1, 'slideshow', 'Whole-Home Surge Protection', 'That thunderstorm last night? It may have hit your outlets.'],
    [3, 'carousel', 'Electrical Panel Upgrade / Replacement', 'Before and after: a 200 amp panel in Rockwall.'],
    [5, 'photo', 'Electrical Troubleshooting', 'What is the one outlet in your house that never worked?'],
    [6, 'photo', 'Recessed Lighting', 'Six can lights, one afternoon, zero drywall patches.'],
  ];
  const blocks = posts.map(([d, type, service, hook]) => [
    `## DAY ${d}`, '', `**DAY:** ${d}`, `**DATE:** ${WEEK.fb_dates[d]} (${['', 'Monday', '', 'Wednesday', '', 'Friday', 'Saturday'][d]}, September ${7 + d - 1}, 2026)`, `**TYPE:** ${type}`,
    `**SERVICE:** ${service}`, '**POST_GOAL:** education', '**FORMAT:** Educational/How-To', '', '**HOOK:**', hook, '', '**BODY:**',
    'Most DFW homeowners do not think about this until something expensive stops working. We see it every week and it is fixable.', '',
    '**CTA:**', 'Save this post before the next storm rolls through DFW.', '', '**HASHTAGS:** #DFWElectrician #SurgeProtection', '',
    '**CONTACT:** 📲 Text us at (469) 896-3862 to get a free instant quote — *posted as first comment, not in caption*', '',
    `**PHOTO_FILE:** IMG_${3400 + d}.JPG`, '', '**VIDEO_PROMPT:**', '', '**ON_SCREEN_TEXT:**', '- **[0:00–0:03]** "Storm hit more than your yard."', '',
    `**BOOST:** ${d === 1 || d === 3 ? 'YES' : 'NO'}`, `**BOOST_AMOUNT:** ${d === 1 || d === 3 ? '$25' : '—'}`, `**BOOST_DURATION:** ${d === 1 || d === 3 ? '1 day' : '—'}`,
    '**BOOST_TARGETING:** 15mi radius from Rowlett TX', '**STATUS:** Needs approval', '', '---', '',
  ].join('\n'));
  return `# Grizzly Electrical Solutions — Facebook Content Schedule\n## Week of September 7–12, 2026\n\n---\n\n${blocks.join('\n')}## BOOST BUDGET SUMMARY\n\n### Weekly Budget: $50\n`;
}

let root;
let counter = 0;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-compare-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

function dirs() {
  const base = path.join(root, `case-${++counter}`);
  const outputsDir = path.join(base, 'outputs');
  const shadowDir = path.join(base, 'shadow');
  fs.mkdirSync(outputsDir, { recursive: true });
  return { base, outputsDir, shadowDir, store: createFileStore(path.join(base, 'store')) };
}

function writeLegacy(outputsDir, { gbp = legacyGbp(), facebook = legacyFacebook() } = {}) {
  if (gbp != null) fs.writeFileSync(path.join(outputsDir, LEGACY_FILES.gbp), gbp, 'utf8');
  if (facebook != null) fs.writeFileSync(path.join(outputsDir, LEGACY_FILES.facebook), facebook, 'utf8');
}

async function stageShadow({ store, shadowDir }, { plan = makePlan(), attempt = makeAttempt(), validation = VALID } = {}) {
  const rendered = { gbp: renderGbp(plan), facebook: renderFacebook(plan), website: '# Website queue\n\n- Refresh panel page\n', summary: '# Summary\n' };
  await stagePlan({ store, attempt, plan, selection: SELECTION, validation, rendered, mode: 'shadow', now: NOW, outDir: shadowDir });
  return plan;
}

function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
}

describe('the shadow exports round-trip through the legacy parsers', () => {
  it('7 GBP rows and 4 Facebook rows with the WeekSpec dates; FB header resolves week_of', async () => {
    const ctx = dirs();
    const plan = await stageShadow(ctx);
    const files = readShadowOutputs(ctx.shadowDir);
    const gbp = parseGbpSchedule(files.gbpText);
    assert.equal(gbp.length, 7);
    assert.deepEqual(gbp.map((r) => r.post_date), GBP_DAYS.map((d) => WEEK.gbp_dates[d]));
    assert.ok(gbp.every((r) => r.platform === 'gbp'));
    const fb = parseFacebookSchedule(files.fbText);
    assert.deepEqual(fb.map((r) => r.day), [...FB_DAYS]);
    assert.deepEqual(fb.map((r) => r.post_date), FB_DAYS.map((d) => WEEK.fb_dates[d]));
    assert.deepEqual(fb.map((r) => r.type), plan.facebook.map((p) => p.type));
    assert.equal(resolveWeekOf({ argv: [], fbText: files.fbText }), '2026-09-07');
    assert.deepEqual(files.plan, plan);
    assert.equal(files.attempt.id, ATTEMPT_ID);
  });
});

describe('compareWithLegacy', () => {
  it('reports counts, dates, facts violations, topics and the attempt, and never modifies outputsDir', async () => {
    const ctx = dirs();
    writeLegacy(ctx.outputsDir);
    await stageShadow(ctx);
    const before = snapshot(ctx.outputsDir);
    const beforeMtimes = fs.readdirSync(ctx.outputsDir).map((n) => fs.statSync(path.join(ctx.outputsDir, n)).mtimeMs);

    const report = compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, facts: FACTS, weekSpec: WEEK, policy: POLICY, now: LATER });

    assert.deepEqual(snapshot(ctx.outputsDir), before);
    assert.deepEqual(fs.readdirSync(ctx.outputsDir).map((n) => fs.statSync(path.join(ctx.outputsDir, n)).mtimeMs), beforeMtimes);
    assert.deepEqual(fs.readdirSync(ctx.shadowDir).filter((n) => /compare|report/i.test(n)), []);

    assert.match(report, /^# Shadow comparison — week of 2026-09-07/);
    assert.match(report, /Generated 2026-09-04T21:03:12\.000Z/);
    assert.match(report, /\| GBP \| 7 \| 7 \| 7 \|/);
    assert.match(report, /\| Facebook \| 4 \| 4 \| 4 \|/);
    assert.match(report, /\| Website \| — \| 0 \| 2 \|/);
    assert.match(report, /gbp_posting_schedule\.md present, facebook_posting_schedule\.md present, grizzly_execution_queue\.md missing, final_report\.md missing/);

    assert.match(report, /\| GBP \| 3 \| 2026-09-06 \| 2026-09-07 ✗ \| 2026-09-06 ✓ \|/);
    assert.match(report, /\| GBP \| 1 \| 2026-09-04 \| 2026-09-04 ✓ \| 2026-09-04 ✓ \|/);
    assert.match(report, /\| Facebook \| 6 \| 2026-09-12 \| 2026-09-12 ✓ \| 2026-09-12 ✓ \|/);
    assert.match(report, /Legacy: 1 of 11 slots off-spec\./);
    assert.match(report, /Shadow: 0 of 11 slots off-spec\./);
    assert.match(report, /legacy → no ISO "week of" date \(legacy sync needs --week-of\); shadow → 2026-09-07 ✓/);

    const legacySection = report.split('### Legacy copy')[1].split('### Shadow copy')[0];
    assert.match(legacySection, /- GBP day 2: phone \(214\) 555-0100 is not a business number/);
    assert.match(legacySection, /- GBP day 3: .*over a decade/);
    assert.match(legacySection, /- GBP day 4: price \$1,500 is not an approved price/);
    assert.doesNotMatch(legacySection, /callw3\.com/, 'trend notes are not published copy');
    assert.doesNotMatch(legacySection, /phone \(469\) 8(?:96-3862|63-9804) is not/, 'the business numbers are allowed');
    assert.equal(legacySection.match(/^- /gm).length, 3, 'exactly the three planted defects');
    const shadowSection = report.split('### Shadow copy')[1].split('## Topics')[0];
    assert.match(shadowSection, /_None\._/);

    assert.match(report, /\| GBP 1 \| Whole-home surge protection \| Legacy headline 1 \| Electrical Panel Upgrade \/ Replacement \| Headline 1 in Rockwall \|/);
    assert.match(report, /\| Facebook 3 \| Electrical Panel Upgrade \/ Replacement \| Before and after: a 200 amp panel in Rockwall\. \| EV Charger Installation \| Hook 3 \|/);
    assert.match(report, /- Legacy lead service: Electrical Panel Upgrade \/ Replacement \(2 of 11 posts\)/);
    assert.match(report, /- Shadow topic: Electrical Panel Upgrade \/ Replacement in Rockwall \(winner total 0\.700\)/);
    assert.match(report, /- Shadow rationale: Panel upgrade in Rockwall leads/);
    assert.match(report, /- Services on both sides: Electrical Panel Upgrade \/ Replacement, Electrical Troubleshooting & Repair/);
    assert.match(report, /### Shadow website actions\n\n- website_service_page_update — Refresh panel page\n- website_blog_post — Panel upgrade cost in Rockwall \(owner gate\)/);

    assert.match(report, new RegExp(`- Attempt \`${ATTEMPT_ID}\` — mode shadow, status running`));
    assert.match(report, /not finished at compare time; runtime 3m 12s so far/);
    assert.match(report, /- Spend \$0\.42 of \$20\.00 budget/);
    assert.match(report, /\| collect \| ok \| 40s \| — \|/);
    assert.match(report, /\| stage \| running \| 1m 12s \(running\) \| — \|/);
    assert.match(report, /Legacy runtime and spend: not recorded by the legacy pipeline/);
  });

  it('tolerates missing legacy files and derives the WeekSpec from the shadow plan', async () => {
    const ctx = dirs();
    await stageShadow(ctx);
    const report = compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, facts: FACTS, policy: POLICY, now: LATER });
    assert.match(report, /week of 2026-09-07/);
    assert.match(report, /\| GBP \| 7 \| 0 \| 7 \|/);
    assert.match(report, /gbp_posting_schedule\.md missing, facebook_posting_schedule\.md missing/);
    assert.match(report, /\| GBP \| 1 \| 2026-09-04 \| missing ✗ \| 2026-09-04 ✓ \|/);
    assert.match(report, /Legacy: 11 of 11 slots off-spec \(missing GBP 1, GBP 2, GBP 3, GBP 4, GBP 5, GBP 6, GBP 7, FB 1, FB 3, FB 5, FB 6\)\./);
    assert.match(report, /- Legacy lead service: none parsed/);
    assert.match(report, /- Services on both sides: none/);
  });

  it('prefers the live attempt and meter total over the exported snapshot', async () => {
    const ctx = dirs();
    writeLegacy(ctx.outputsDir);
    await stageShadow(ctx);
    const live = makeAttempt({ status: 'succeeded', finished_at: '2026-09-04T21:05:00.000Z', spent_usd: 1.5 });
    const report = compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, facts: FACTS, weekSpec: WEEK, policy: POLICY, attempt: live, spentUsd: 2.25, now: LATER });
    assert.match(report, /status succeeded/);
    assert.match(report, /finished 2026-09-04T21:05:00\.000Z; runtime 5m 0s\n/);
    assert.match(report, /- Spend \$2\.25 of \$20\.00 budget \(live meter\)/);
  });

  it('skips the facts rules when no facts are given', async () => {
    const ctx = dirs();
    writeLegacy(ctx.outputsDir);
    await stageShadow(ctx);
    const report = compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, weekSpec: WEEK, now: LATER });
    assert.match(report, /_Facts not provided; text rules skipped\._/);
    assert.doesNotMatch(report, /555-0100/);
  });

  it('flags shadow copy with the same rules as legacy copy', async () => {
    const ctx = dirs();
    writeLegacy(ctx.outputsDir, { gbp: legacyGbp({ day3Date: WEEK.gbp_dates[3], badPhone: false, decade: false, price: false }) });
    const plan = makePlan();
    plan.gbp[4].body = 'Call (972) 555-0199 today; see grizzlyelectricalsolutions.com for details.';
    await stageShadow(ctx, { plan, validation: { ok: false, errors: ['GBP day 5: phone'], warnings: [] } });
    const report = compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, facts: FACTS, weekSpec: WEEK, policy: POLICY, now: LATER });
    const shadowSection = report.split('### Shadow copy')[1].split('## Topics')[0];
    assert.match(shadowSection, /- GBP day 5: phone \(972\) 555-0199 is not a business number/);
    assert.match(shadowSection, /- GBP day 5: domain grizzlyelectricalsolutions\.com is not grizzlyelectricaltx\.com/);
    const legacySection = report.split('### Legacy copy')[1].split('### Shadow copy')[0];
    assert.match(legacySection, /_None\._/);
    assert.match(report, /Legacy: 0 of 11 slots off-spec\./);
  });

  it('throws when the shadow plan is missing', () => {
    const ctx = dirs();
    assert.throws(() => compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, weekSpec: WEEK, now: LATER }), /plan\.json not found; stage the plan first/);
  });
});

describe('pure helpers', () => {
  it('checkDates finds mismatches, missing, duplicate and unexpected days', () => {
    const rows = [
      { day: 1, post_date: '2026-09-04' }, { day: 2, post_date: '2026-09-06' }, { day: 4, post_date: '2026-09-07' }, { day: 4, post_date: '2026-09-07' },
      { day: 5, post_date: '2026-09-08' }, { day: 6, post_date: '2026-09-09' }, { day: 7, post_date: '2026-09-10' }, { day: 9, post_date: '2026-09-12' },
    ];
    const out = checkDates(rows, WEEK.gbp_dates, GBP_DAYS);
    assert.deepEqual(out.slots.map((s) => s.ok), [true, false, false, false, true, true, true]);
    assert.equal(out.slots[3].duplicates, true);
    assert.deepEqual(out.missing, [3]);
    assert.deepEqual(out.extra, [9]);
    assert.equal(out.offSpec, 3, 'unexpected days are listed in extra, not counted as slots');
    assert.equal(checkDates([], null, FB_DAYS).offSpec, 4);
    const allExtra = checkDates([{ day: 8, post_date: '2026-09-11' }, { day: 9, post_date: '2026-09-12' }], WEEK.gbp_dates, GBP_DAYS);
    assert.equal(allExtra.offSpec, 7);
    assert.deepEqual(allExtra.extra, [8, 9]);
  });
  it('the dates line never reports more off-spec slots than there are slots', () => {
    const gbp = GBP_DAYS.map((day) => ({ day, post_date: WEEK.gbp_dates[day] })).concat([{ day: 8, post_date: '2026-09-11' }, { day: 9, post_date: '2026-09-12' }]);
    const fb = FB_DAYS.map((day) => ({ day, post_date: WEEK.fb_dates[day] })).concat([{ day: 2, post_date: '2026-09-08' }]);
    const report = buildCompareReport({ legacy: { gbp, facebook: fb, website: [], fbWeekOf: null, files: {} }, shadow: { ...parseSide({}), plan: null, selection: null, attempt: null }, weekSpec: WEEK, now: LATER });
    assert.match(report, /Legacy: 0 of 11 slots off-spec \(unexpected day GBP 8, GBP 9, FB 2\)\./);
    assert.match(report, /Shadow: 11 of 11 slots off-spec/);
  });
  it('flags a shadow plan whose week_of differs from the WeekSpec used for the date check', () => {
    const shadow = { ...parseSide({}), plan: { ...makePlan(), week_of: '2026-09-14' }, selection: null, attempt: null };
    const report = buildCompareReport({ legacy: { ...parseSide({}), files: {} }, shadow, weekSpec: WEEK, now: LATER });
    assert.match(report, /Shadow plan week_of 2026-09-14 does not match the WeekSpec week 2026-09-07 ✗/);
    const same = buildCompareReport({ legacy: { ...parseSide({}), files: {} }, shadow: { ...shadow, plan: makePlan() }, weekSpec: WEEK, now: LATER });
    assert.doesNotMatch(same, /does not match the WeekSpec week/);
  });
  it('accepts now as an ISO string (Generated line and runtime) and rejects an invalid now', async () => {
    const shadow = { ...parseSide({}), plan: null, selection: null, attempt: makeAttempt() };
    const report = buildCompareReport({ legacy: { ...parseSide({}), files: {} }, shadow, weekSpec: WEEK, now: LATER.toISOString() });
    assert.match(report, /Generated 2026-09-04T21:03:12\.000Z/);
    assert.match(report, /runtime 3m 12s so far/);
    assert.throws(() => buildCompareReport({ legacy: parseSide({}), shadow, weekSpec: WEEK, now: 'yesterday' }), /now must be a valid Date/);
    const ctx = dirs();
    await stageShadow(ctx);
    const viaEntry = compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, now: LATER.toISOString() });
    assert.match(viaEntry, /Generated 2026-09-04T21:03:12\.000Z/);
    assert.match(viaEntry, /week of 2026-09-07/);
    assert.throws(() => compareWithLegacy({ shadowDir: ctx.shadowDir, outputsDir: ctx.outputsDir, now: 'yesterday' }), /now must be a valid Date/);
  });
  it('parseSide handles absent text and reads the ISO week header', () => {
    assert.deepEqual(parseSide({}), { gbp: [], facebook: [], website: [], fbWeekOf: null });
    const side = parseSide({ fbText: '## Week of 2026-09-07\n\n**DAY:** 1\n**DATE:** 2026-09-07\n**TYPE:** photo\n**HOOK:** hi\n' });
    assert.equal(side.fbWeekOf, '2026-09-07');
    assert.equal(side.facebook.length, 1);
  });
  it('factsViolations labels rows by platform and day and skips empty rows', () => {
    const side = { gbp: [{ day: 2, hook: 'Call (214) 555-0100', body: '', cta: '' }, { day: 3, hook: '', body: '', cta: '' }], facebook: [{ day: 1, body: 'We charge $2,000 flat.' }] };
    const found = factsViolations(side, { facts: FACTS, weekSpec: WEEK, policy: POLICY });
    assert.deepEqual(found.map((f) => f.split(':')[0]), ['GBP day 2', 'Facebook day 1']);
  });
  it('serviceCounts orders by count then name; formatDuration formats', () => {
    assert.deepEqual(serviceCounts([{ service: 'B' }, { service: 'A' }, { service: 'B' }, { service: '' }]), [['B', 2], ['(none)', 1], ['A', 1]]);
    assert.equal(formatDuration(3723000), '1h 2m 3s');
    assert.equal(formatDuration(500), '1s');
    assert.equal(formatDuration(NaN), '—');
    assert.equal(formatDuration(-5), '—');
  });
  it('buildCompareReport requires a weekSpec and reads legacy outputs without throwing on an empty dir', () => {
    assert.throws(() => buildCompareReport({ legacy: parseSide({}), shadow: parseSide({}) }), /weekSpec is required/);
    const ctx = dirs();
    const legacy = readLegacyOutputs(ctx.outputsDir);
    assert.equal(legacy.gbpText, null);
    assert.equal(legacy.fbText, null);
    const report = buildCompareReport({ legacy: { ...parseSide(legacy), files: {} }, shadow: { ...parseSide({}), plan: null, selection: null, attempt: null }, weekSpec: WEEK, now: LATER });
    assert.match(report, /Attempt record not found/);
    assert.match(report, /- Shadow topic: unknown/);
    assert.doesNotMatch(report, /Legacy files:/);
  });
});
