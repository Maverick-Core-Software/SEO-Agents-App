// scripts/weekly/test/render.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderGbpSchedule, renderFacebookSchedule, renderWebsiteQueue, renderPlanSummary, renderBoostSummary,
  boostFields, boostSummaryRows, pickPriorityRow, gbpPhotoField, fbPhotoField,
  formatLongDate, formatShortDay, formatDateRange, formatUsd, formatHashtags, inlineText, multilineText,
} from '../lib/render.mjs';
import { weekSpecForWeekOf } from '../lib/week-spec.mjs';
import { parseOrIssues, PlanSchema } from '../lib/schemas.mjs';
// Legacy consumers. supabase-sync.mjs and facebook-poster.mjs guard main() with an
// invokedDirectly check; importing them only reads .env into process.env (no network).
import { parseGbpSchedule, parseFacebookSchedule, resolveWeekOf } from '../../supabase-sync.mjs';
import { parseScheduleText } from '../../facebook-poster.mjs';
import { normalizePhotoFile } from '../../lib/schedule-text.mjs';
import { captionMatchTokens } from '../../lib/fb-boost-marketing.mjs';
// sync-gbp-schedule.mjs guards its CLI with invokedDirectly; importing it only defines
// constants (xlsx and lib/gbp-runner load but run nothing).
import { parseGbpScheduleMarkdown } from '../../sync-gbp-schedule.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAN = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'render.plan.json'), 'utf8'));
const WEEK = weekSpecForWeekOf('2026-09-07', new Date('2026-09-04T17:00:00Z'));
const clone = (v) => JSON.parse(JSON.stringify(v));

const GBP = renderGbpSchedule(PLAN, WEEK);
const FB = renderFacebookSchedule(PLAN, WEEK);

// ── Copies of the legacy CLI parsers that cannot be imported (their modules run
// command dispatch at top level). Each mirrors the named script line for line.

/** scripts/fb-boost-ledger.mjs parseSummary — the money gate's authoritative read. */
function ledgerParseSummary(text, cap = 50) {
  const secM = text.match(/##\s*BOOST BUDGET SUMMARY([\s\S]*?)(?=\n## |\n?$)/i);
  if (!secM) return { present: false, rows: new Map(), conditional: false };
  const section = secM[1];
  const rows = new Map();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const dayM = cells.find((c) => /^\**Day\s+\d+/i.test(c))?.match(/Day\s+(\d+)/i);
    if (!dayM) continue;
    const day = Number(dayM[1]);
    const joined = cells.join(' | ');
    let decision = null;
    if (/\bNO\b/.test(joined.replace(/\bNOTE\b/gi, ''))) decision = 'no';
    if (/\bMAYBE\b/i.test(joined)) decision = 'maybe';
    if (/\bYES\b/i.test(joined)) decision = 'yes';
    if (!decision) continue;
    const dailyM = joined.match(/\$(\d+(?:\.\d+)?)\s*\/?\s*day/i);
    const daysM = joined.match(/(\d+)\s*days?\b/i);
    rows.set(day, { decision, daily: dailyM ? Number(dailyM[1]) : null, days: daysM ? Number(daysM[1]) : null });
  }
  const yesTotal = [...rows.values()]
    .filter((r) => r.decision === 'yes' && r.daily && r.days)
    .reduce((sum, r) => sum + r.daily * r.days, 0);
  const conditional = /—\s*OR\s*—|\bOR\b\s*—|whichever|if .* underperform|shift the \$|hold .* boost|only one boost/i
    .test(section) || yesTotal > cap;
  return { present: true, rows, conditional, yesTotal, section };
}

/** scripts/fb-boost-ledger.mjs `eligible` per-post block read. */
function ledgerPostBlocks(text) {
  return text.split(/\n(?=## DAY \d)/).map((block) => {
    const dateM = block.match(/\*{0,2}DATE:\*{0,2}\s*(\d{4}-\d{2}-\d{2})/);
    const boostM = block.match(/\*{0,2}BOOST:\*{0,2}\s*yes:\$?(\d+)/i);
    const dayM = block.match(/\*{0,2}DAY:\*{0,2}\s*(\d+)/);
    const durM = block.match(/\*{0,2}BOOST_DURATION:\*{0,2}\s*(\d+)\s*days?/i);
    return { date: dateM?.[1] || null, day: dayM ? Number(dayM[1]) : null, yesDaily: boostM ? Number(boostM[1]) : null, days: durM ? Number(durM[1]) : null };
  }).filter((b) => b.date);
}

/** scripts/fb-boost-ledger.mjs scheduleWeekStart — Start Date wins. */
function ledgerWeekStart(text) {
  const m = text.match(/\*\*Start Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** scripts/gbp-photo-pick.mjs parseSchedule — splits on bare `---` lines. */
function gbpPhotoPickParse(text) {
  const posts = [];
  for (const block of text.split(/^---$/m).map((b) => b.trim()).filter(Boolean)) {
    const get = (key) => {
      const m = block.match(new RegExp(`^\\*{0,2}${key}:\\*{0,2}\\s*(.+?)\\s*$`, 'im'));
      return m ? m[1].trim() : '';
    };
    const date = get('DATE');
    if (!date || date.toLowerCase().includes('day')) continue;
    posts.push({ date, day: get('DAY'), headline: get('HEADLINE'), photo_file: normalizePhotoFile(get('PHOTO_FILE')) });
  }
  return posts;
}

/** scripts/fb-photo-pick.mjs parseSchedule — bold-only getters inside `## DAY ` blocks. */
function fbPhotoPickParse(text) {
  const posts = [];
  for (const block of text.split(/^## DAY /m).slice(1)) {
    const get = (field) => {
      const m = block.match(new RegExp('^\\*\\*' + field + ':\\*\\*[ \\t]*(.*)$', 'm'));
      return m ? m[1].trim() : '';
    };
    const dateOnly = get('DATE').replace(/\s*\(.*$/, '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) continue;
    posts.push({ day: parseInt(get('DAY'), 10) || 0, date: dateOnly, type: get('TYPE').toLowerCase(), photoFile: get('PHOTO_FILE') });
  }
  return posts;
}

/** scripts/mav-bridge.mjs / facebook-insights-collector.mjs — split on `---`, inline getters. */
function dashSplitBlocks(text) {
  return text.split(/\n\s*---\s*\n/).filter((b) => b.includes('DAY:'));
}

/** scripts/fb-boost-api.mjs scheduleBlockForPick + targetingTextForPick (ledger key → block). */
function boostApiTargeting(text, key) {
  const dayNum = String(key || '').match(/^day(\d+)/i)?.[1];
  if (!dayNum) return { block: '', targeting: '' };
  const blocks = text.split(/\n(?=## DAY \d)/);
  const block = blocks.find((b) => new RegExp(`\\*\\*DAY:\\*\\*\\s*${dayNum}\\b`).test(b) || b.startsWith(`## DAY ${dayNum}`)) || '';
  const m = block.match(/\*{0,2}BOOST_TARGETING:\*{0,2}\s*(.+)/i);
  return { block, targeting: m?.[1]?.trim() || '' };
}

/** scripts/fb-photo-rewrite.mjs rewriteSchedule — the line-walker's block/field detection. */
function photoRewriteBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^\*{0,2}DAY:\*{0,2}\s*\d/i.test(line)) { if (cur) blocks.push(cur); cur = { date: '', service: '', type: '', photoLine: null }; continue; }
    if (line.trim() === '---') { if (cur) blocks.push(cur); cur = null; continue; }
    if (!cur) continue;
    const dm = line.match(/^\*{0,2}DATE:\*{0,2}\s*(.+?)\s*$/i);
    if (dm) cur.date = dm[1].trim();
    const sm = line.match(/^\*{0,2}SERVICE:\*{0,2}\s*(.+?)\s*$/i);
    if (sm) cur.service = sm[1].trim();
    const tm = line.match(/^\*{0,2}TYPE:\*{0,2}\s*(.+?)\s*$/i);
    if (tm) cur.type = tm[1].trim().toLowerCase();
    if (/^\*{0,2}PHOTO_FILE:\*{0,2}\s*/i.test(line)) cur.photoLine = line;
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** src/seo_agents/actions.py _block_field (both inline and following-line values). */
function pyBlockField(cleaned, label) {
  const match = cleaned.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'));
  if (!match) return null;
  const inline = match[1].trim();
  if (inline) return inline;
  const following = cleaned.slice(match.index + match[0].length).split('\n').slice(1);
  const lines = [];
  for (const line of following) {
    const s = line.trim();
    if (/^[A-Z_]+:/.test(s) || /^#{1,6}\s/.test(s) || /^-{3,}$/.test(s)) break;
    lines.push(line);
  }
  return lines.join('\n').trim() || null;
}

describe('fixture', () => {
  it('is a schema-valid plan whose dates match the week spec', () => {
    const { issues } = parseOrIssues(PlanSchema, PLAN);
    assert.deepEqual(issues, []);
    for (const g of PLAN.gbp) assert.equal(g.date, WEEK.gbp_dates[g.day]);
    for (const f of PLAN.facebook) assert.equal(f.date, WEEK.fb_dates[f.day]);
  });
});

describe('formatters', () => {
  it('formats long and short dates without timezone drift', () => {
    assert.equal(formatLongDate('2026-09-07'), 'Monday, September 7, 2026');
    assert.equal(formatShortDay('2026-09-07'), 'Mon 9/7');
    assert.equal(formatShortDay('2026-12-25'), 'Fri 12/25');
    assert.equal(formatLongDate('garbage'), 'garbage');
  });
  it('formats date ranges within a month, across months and across years', () => {
    assert.equal(formatDateRange('2026-09-04', '2026-09-10'), 'September 4–10, 2026');
    assert.equal(formatDateRange('2026-08-31', '2026-09-06'), 'August 31 – September 6, 2026');
    assert.equal(formatDateRange('2026-12-30', '2027-01-05'), 'December 30, 2026 – January 5, 2027');
    assert.equal(formatDateRange('2026-09-07', '2026-09-07'), 'September 7, 2026');
  });
  it('formats dollars without trailing zeros', () => {
    assert.equal(formatUsd(25), '25');
    assert.equal(formatUsd(12.5), '12.5');
    assert.equal(formatUsd(16.666), '16.67');
    assert.equal(formatUsd(null), '0');
  });
  it('normalizes hashtags to a single #-prefixed space-separated line', () => {
    assert.equal(formatHashtags(['#A', 'b', '  ', '##c d']), '#A #b #cd');
    assert.equal(formatHashtags([]), '');
    assert.equal(formatHashtags(null), '');
  });
  it('inlineText collapses line breaks; multilineText keeps safe paragraphs only', () => {
    assert.equal(inlineText('a\r\n  b\n\nc '), 'a b c');
    assert.equal(multilineText('one\n\ntwo'), 'one\n\ntwo');
    assert.equal(multilineText('one\nNOTE: two'), 'one NOTE: two');
    assert.equal(multilineText('one\n---\ntwo'), 'one --- two');
    assert.equal(multilineText('one\n## two'), 'one ## two');
    assert.equal(multilineText(null), '');
  });
});

describe('boost field helpers', () => {
  it('YES rows carry yes:$N, $N and N day(s); MAYBE/NO rows carry — and no dollars', () => {
    const yes = boostFields(PLAN.facebook[0]);
    assert.deepEqual([yes.decision, yes.boost, yes.amount, yes.duration, yes.total], ['YES', 'yes:$10', '$10', '3 days', 30]);
    const yes2 = boostFields(PLAN.facebook[2]);
    assert.deepEqual([yes2.boost, yes2.duration, yes2.total], ['yes:$10', '2 days', 20]);
    const maybe = boostFields(PLAN.facebook[1]);
    assert.deepEqual([maybe.decision, maybe.boost, maybe.amount, maybe.duration, maybe.total], ['MAYBE', 'maybe', '—', '—', 0]);
    const no = boostFields(PLAN.facebook[3]);
    assert.deepEqual([no.boost, no.amount, no.duration, no.targeting], ['no', '—', '—', '—']);
  });
  it('a YES row with no dollars renders yes with — cells and contributes $0', () => {
    const b = boostFields({ boost: { decision: 'YES', daily_usd: null, days: null }, boost_targeting: 'x' });
    assert.deepEqual([b.boost, b.amount, b.duration, b.total, b.targeting], ['yes', '—', '—', 0, 'x']);
    const single = boostFields({ boost: { decision: 'YES', daily_usd: 50, days: 1 } });
    assert.equal(single.duration, '1 day');
  });
  it('unknown decisions fall back to NO; targeting is kept for MAYBE', () => {
    assert.equal(boostFields({ boost: { decision: 'sure' } }).decision, 'NO');
    assert.equal(boostFields({ boost: { decision: 'MAYBE' }, boost_targeting: 'Rowlett homeowners' }).targeting, 'Rowlett homeowners');
  });
  it('priority row is the largest funded YES, earliest day on ties', () => {
    const rows = boostSummaryRows(PLAN, WEEK);
    assert.deepEqual(rows.map((r) => r.day), [1, 3, 5, 6]);
    assert.equal(pickPriorityRow(rows).day, 1);
    const tied = rows.map((r) => ({ ...r, decision: 'YES', total: 25, daily: 25, days: 1 }));
    assert.equal(pickPriorityRow(tied.reverse()).day, 1);
    assert.equal(pickPriorityRow(rows.map((r) => ({ ...r, decision: 'NO', total: 0 }))), null);
  });
  it('photo fields: NEEDS PHOTO for GBP nulls and photo-type FB nulls, blank for text posts', () => {
    assert.equal(gbpPhotoField(PLAN.gbp[0]), 'panel-rockwall.jpg');
    assert.equal(gbpPhotoField(PLAN.gbp[6]), 'NEEDS PHOTO');
    assert.equal(fbPhotoField(PLAN.facebook[3]), '');
    assert.equal(fbPhotoField({ type: 'photo', photo_file: null }), 'NEEDS PHOTO');
    assert.equal(fbPhotoField({ type: 'carousel', photo_file: ' a.jpg ' }), 'a.jpg');
  });
});

describe('renderGbpSchedule', () => {
  it('reproduces the legacy header, block layout, and trailing sections in order', () => {
    const lines = GBP.split('\n');
    assert.equal(lines[0], '# Grizzly Electrical Solutions — 7-Day GBP Posting Schedule');
    assert.equal(lines[1], '**Schedule Period: September 4–10, 2026 | Prepared by scripts/weekly (attempt att_render_fixture)**');
    assert.match(GBP, /^> \*\*Trend Source:\*\* /m);
    assert.match(GBP, /^## 7-Day GBP Post Schedule$/m);
    const expectedDay1 = [
      '**DAY:** 1',
      '**DATE:** 2026-09-04',
      '**SERVICE:** Electrical Panel Upgrade / Replacement',
      '**TOPIC:** Signs a panel is at capacity',
      '**TREND_TIE:** Fall appliance loads',
      '**HEADLINE:** Is Your Rockwall Panel Ready for Fall?',
      `**BODY:** ${PLAN.gbp[0].body}`,
      '**CAPTION:** Panel upgrade in progress in Rockwall',
      '**PHOTO_FILE:** panel-rockwall.jpg',
      '**CTA:** Text us a photo for a free quote',
      '**HASHTAGS:** #RockwallElectrician #PanelUpgrade #DFWElectrician',
      '**STATUS:** Needs approval',
      '',
      '---',
      '',
      '**DAY:** 2',
    ].join('\n');
    assert.ok(GBP.includes(expectedDay1), 'day 1 block must match the legacy field order exactly');
    const order = ['## 7-Day GBP Post Schedule', '**DAY:** 7', '## Photo Gaps', '## Trend Summary This Week', '## Owner Notes'];
    const idx = order.map((s) => GBP.indexOf(s));
    assert.ok(idx.every((i) => i >= 0), `all sections present: ${idx}`);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'sections in the legacy order');
    assert.equal((GBP.match(/^\*\*STATUS:\*\* Needs approval$/gm) || []).length, 7);
  });

  it('renders NEEDS PHOTO for a null photo and lists the gap for the owner', () => {
    assert.match(GBP, /^\*\*PHOTO_FILE:\*\* NEEDS PHOTO$/m);
    assert.match(GBP, /\| \*\*Day 7\*\* \| 2026-09-10 \| Recessed Lighting Installation \| `NEEDS PHOTO` \|/);
    assert.match(GBP, /Photos still needed:\*\* Day 7 \(2026-09-10, Recessed Lighting Installation\)/);
    assert.match(GBP, /- GBP day 7 recessed lighting needs a photo/);
  });

  it('owner notes read cleanly with and without website actions (no doubled punctuation)', () => {
    assert.match(GBP, /^3\. \*\*Website actions:\*\* 2 actions queued in website_queue\.md \(1 owner-gated\); nothing on the website changes without approval\.$/m);
    assert.match(renderGbpSchedule({ ...PLAN, website_actions: [] }, WEEK), /^3\. \*\*Website actions:\*\* none queued this week\.$/m);
    assert.ok(!/\.\.$/m.test(GBP), 'no line ends with a doubled period');
    assert.ok(!/ $/m.test(GBP), 'no trailing whitespace anywhere in the GBP schedule');
    assert.ok(!/ $/m.test(FB), 'no trailing whitespace anywhere in the Facebook schedule');
  });

  it('round-trips through parseGbpSchedule: 7 rows, platform gbp, WeekSpec dates, content intact', () => {
    const rows = parseGbpSchedule(GBP);
    assert.equal(rows.length, 7);
    rows.forEach((row, i) => {
      const item = PLAN.gbp[i];
      assert.equal(row.platform, 'gbp');
      assert.equal(row.day, item.day);
      assert.equal(row.post_date, WEEK.gbp_dates[item.day]);
      assert.equal(row.hook, item.headline);
      assert.equal(row.body, item.body);
      assert.equal(row.service, item.service);
      assert.equal(row.cta, item.cta);
      assert.equal(row.photo_file, item.photo_file);
      assert.equal(row.status, 'pending_approval');
    });
  });

  it('normalizePhotoFile accepts every rendered PHOTO_FILE', () => {
    const rendered = [...GBP.matchAll(/^\*\*PHOTO_FILE:\*\* (.*)$/gm)].map((m) => m[1]);
    assert.equal(rendered.length, 7);
    rendered.forEach((v, i) => assert.equal(normalizePhotoFile(v), PLAN.gbp[i].photo_file || ''));
  });

  it('gbp-photo-pick (split on bare ---) sees exactly the 7 dated blocks', () => {
    const posts = gbpPhotoPickParse(GBP);
    assert.deepEqual(posts.map((p) => p.date), Object.values(WEEK.gbp_dates));
    assert.equal(posts[6].photo_file, '');
    assert.equal(posts[0].headline, PLAN.gbp[0].headline);
  });

  it('actions.py field reader gets every label from every block', () => {
    const starts = [...GBP.matchAll(/^\*{0,2}DAY:/gm)].map((m) => m.index);
    assert.equal(starts.length, 7);
    const blocks = starts.map((s, i) => GBP.slice(s, starts[i + 1] ?? GBP.length).replace(/\*\*/g, ''));
    for (const [i, block] of blocks.entries()) {
      for (const label of ['DAY', 'DATE', 'SERVICE', 'TOPIC', 'TREND_TIE', 'HEADLINE', 'BODY', 'CAPTION', 'PHOTO_FILE', 'CTA', 'STATUS']) {
        assert.ok(pyBlockField(block, label), `${label} on day ${i + 1}`);
      }
      assert.equal(pyBlockField(block, 'BODY'), PLAN.gbp[i].body);
    }
  });

  it('collapses multi-line GBP copy onto the field line so inline parsers keep all of it', () => {
    const plan = clone(PLAN);
    plan.gbp[1].body = 'First line.\n\nSecond line.';
    plan.gbp[1].caption = 'Cap\nline';
    const text = renderGbpSchedule(plan, WEEK);
    assert.match(text, /^\*\*BODY:\*\* First line\. Second line\.$/m);
    assert.equal(parseGbpSchedule(text)[1].body, 'First line. Second line.');
    assert.equal(gbpPhotoPickParse(text).length, 7);
  });

  it('uses WeekSpec dates over item dates, and item dates when no WeekSpec is given', () => {
    const plan = clone(PLAN);
    plan.gbp[0].date = '1999-01-01';
    assert.equal(parseGbpSchedule(renderGbpSchedule(plan, WEEK))[0].post_date, WEEK.gbp_dates[1]);
    const rows = parseGbpSchedule(renderGbpSchedule(plan, null));
    assert.equal(rows[0].post_date, '1999-01-01');
    assert.equal(rows.length, 7);
  });

  it('sorts blocks by day regardless of plan order and flags degraded runs', () => {
    const plan = clone(PLAN);
    plan.gbp.reverse();
    plan.notes.degraded = true;
    plan.notes.degraded_reason = 'Search Console token expired';
    const text = renderGbpSchedule(plan, WEEK);
    assert.deepEqual(parseGbpSchedule(text).map((r) => r.day), [1, 2, 3, 4, 5, 6, 7]);
    assert.match(text, /Degraded run: Search Console token expired\./);
    assert.match(text, /^\*\*Degraded run:\*\* Search Console token expired\.$/m);
    assert.match(text, /^4\. \*\*Degraded run\.\*\* Search Console token expired;/m);
  });

  it('never emits a stray DAY: line outside the 7 post blocks (main.py counts them)', () => {
    const count = GBP.split('\n').filter((l) => l.startsWith('DAY:') || l.startsWith('**DAY:')).length;
    assert.equal(count, 7);
  });
});

describe('renderFacebookSchedule', () => {
  it('reproduces the legacy header, ## DAY headings, and per-post field layout', () => {
    const lines = FB.split('\n');
    assert.equal(lines[0], '# Grizzly Electrical Solutions — Facebook Content Schedule');
    assert.equal(lines[1], '## Week of 2026-09-07');
    assert.equal(lines[2], '**Start Date:** 2026-09-07 | **Schedule Period:** September 7–12, 2026 | Prepared by scripts/weekly (attempt att_render_fixture)');
    const expectedDay1 = [
      '## DAY 1',
      '',
      '**DAY:** 1',
      '**DATE:** 2026-09-07 (Monday, September 7, 2026)',
      '**TYPE:** slideshow',
      '**SERVICE:** Electrical Panel Upgrade / Replacement',
      '**POST_GOAL:** education',
      '**FORMAT:** slideshow, 5 slides',
      '',
      '**HOOK:**',
      'Your breaker panel is quietly telling you something.',
      '',
      '**BODY:**',
      PLAN.facebook[0].body,
      '',
      '**CTA:**',
      'Comment the age of your home',
      '',
      '**HASHTAGS:** #RockwallTX #PanelUpgrade',
      '',
      '**CONTACT:** Text a photo for a free quote: (469) 896-3862',
      '',
      '**PHOTO_FILE:** panel-rockwall.jpg',
      '',
      '**VIDEO_PROMPT:**',
      '',
      '**ON_SCREEN_TEXT:**',
      PLAN.facebook[0].on_screen_text,
      '',
      '**BOOST:** yes:$10',
      '**BOOST_AMOUNT:** $10',
      '**BOOST_DURATION:** 3 days',
      '**BOOST_TARGETING:** Homeowners 30-65 within 15 miles of Rockwall',
      '**STATUS:** Needs approval',
      '',
      '---',
      '',
      '## DAY 3',
    ].join('\n');
    assert.ok(FB.includes(expectedDay1), 'day 1 block must match the legacy field order exactly');
    assert.deepEqual([...FB.matchAll(/^## DAY (\d)$/gm)].map((m) => Number(m[1])), [1, 3, 5, 6]);
    const order = ['## DAY 6', '## CONTENT NOTES', '## BOOST BUDGET SUMMARY'];
    const idx = order.map((s) => FB.indexOf(s));
    assert.deepEqual([...idx].sort((a, b) => a - b), idx);
    assert.ok(idx.every((i) => i >= 0));
  });

  it('renders MAYBE and NO posts with — budget cells and a blank photo on the text post', () => {
    assert.match(FB, /\*\*BOOST:\*\* maybe\n\*\*BOOST_AMOUNT:\*\* —\n\*\*BOOST_DURATION:\*\* —\n\*\*BOOST_TARGETING:\*\* —\n/);
    assert.match(FB, /\*\*BOOST:\*\* no\n\*\*BOOST_AMOUNT:\*\* —\n\*\*BOOST_DURATION:\*\* —\n\*\*BOOST_TARGETING:\*\* —\n/);
    assert.match(FB, /\*\*BOOST:\*\* yes:\$10\n\*\*BOOST_AMOUNT:\*\* \$10\n\*\*BOOST_DURATION:\*\* 2 days\n\*\*BOOST_TARGETING:\*\* Homeowners within 20 miles of Rowlett\n/);
    const day6 = FB.slice(FB.indexOf('## DAY 6'), FB.indexOf('## CONTENT NOTES'));
    assert.match(day6, /^\*\*PHOTO_FILE:\*\*$/m);
    assert.match(day6, /^\*\*HASHTAGS:\*\*$/m);
    assert.match(day6, /^\*\*ON_SCREEN_TEXT:\*\*$/m);
    assert.ok(!/ $/m.test(day6), 'no trailing whitespace on blank fields');
  });

  it('round-trips through parseFacebookSchedule: 4 rows, days 1/3/5/6, WeekSpec dates, content intact', () => {
    const rows = parseFacebookSchedule(FB);
    assert.deepEqual(rows.map((r) => r.day), [1, 3, 5, 6]);
    rows.forEach((row, i) => {
      const item = PLAN.facebook[i];
      assert.equal(row.platform, 'facebook');
      assert.equal(row.post_date, WEEK.fb_dates[item.day]);
      assert.equal(row.type, item.type);
      assert.equal(row.hook, item.hook);
      assert.equal(row.body, item.body);
      assert.equal(row.cta, item.cta);
      assert.equal(row.service, item.service);
      assert.equal(row.photo_file, item.photo_file);
      assert.equal(row.video_prompt, null);
    });
    assert.equal(rows[1].hashtags, '#EVCharger #DFW');
    assert.equal(rows[3].hashtags, null);
  });

  it('resolveWeekOf reads week_of from the rendered header', () => {
    assert.equal(resolveWeekOf({ argv: [], fbText: FB }), WEEK.week_of);
    assert.equal(resolveWeekOf({ argv: ['--week-of', WEEK.week_of], fbText: FB }), WEEK.week_of);
    assert.throws(() => resolveWeekOf({ argv: ['--week-of', '2026-09-14'], fbText: FB }), /disagree/);
  });

  it('round-trips through facebook-poster parseScheduleText with matching type, hook and boost fields', () => {
    const posts = parseScheduleText(FB);
    assert.deepEqual(posts.map((p) => p.day), [1, 3, 5, 6]);
    posts.forEach((post, i) => {
      const item = PLAN.facebook[i];
      const b = boostFields(item);
      assert.equal(post.date, WEEK.fb_dates[item.day]);
      assert.equal(post.type, item.type);
      assert.equal(post.hook, item.hook);
      assert.equal(post.body, item.body);
      assert.equal(post.cta, item.cta);
      assert.equal(post.post_goal, item.post_goal);
      assert.equal(post.contact, item.contact);
      assert.equal(post.boost, b.boost);
      assert.equal(post.boost_amount, b.amount);
      assert.equal(post.boost_duration, b.duration);
      assert.equal(post.boost_targeting, b.targeting);
      assert.equal(post.status, 'Needs approval');
      assert.equal(post.video_prompt, '');
      assert.equal(post.photo_file, item.photo_file || '');
    });
    assert.equal(posts[0].on_screen_text, PLAN.facebook[0].on_screen_text.replace(/\*\*/g, ''));
    assert.equal(posts[1].on_screen_text, PLAN.facebook[1].on_screen_text);
    assert.equal(posts[3].on_screen_text, '');
  });

  it('normalizePhotoFile accepts every rendered PHOTO_FILE', () => {
    const rendered = [...FB.matchAll(/^\*\*PHOTO_FILE:\*\*(.*)$/gm)].map((m) => m[1]);
    assert.equal(rendered.length, 4);
    rendered.forEach((v, i) => assert.equal(normalizePhotoFile(v), PLAN.facebook[i].photo_file || ''));
    const plan = clone(PLAN);
    plan.facebook[1].photo_file = null;
    const text = renderFacebookSchedule(plan, WEEK);
    assert.match(text, /^\*\*PHOTO_FILE:\*\* NEEDS PHOTO$/m);
    assert.equal(parseFacebookSchedule(text)[1].photo_file, null);
  });

  it('satisfies fb-photo-pick (bold-only getters, ## DAY split) and fb-boost-marketing caption tokens', () => {
    const picks = fbPhotoPickParse(FB);
    assert.deepEqual(picks.map((p) => [p.day, p.date, p.type]), PLAN.facebook.map((f) => [f.day, WEEK.fb_dates[f.day], f.type]));
    assert.equal(picks[0].photoFile, 'panel-rockwall.jpg');
    const block = FB.split(/\n(?=## DAY \d)/).find((b) => b.startsWith('## DAY 1'));
    const tokens = captionMatchTokens({ service: PLAN.facebook[0].service }, block);
    assert.ok(tokens.includes('breaker'), `hook words reach the caption matcher: ${tokens}`);
    assert.ok(tokens.includes('flickering'), `body words reach the caption matcher: ${tokens}`);
  });

  it('satisfies the --- splitters (mav-bridge, facebook-insights-collector) with exactly 4 blocks', () => {
    const blocks = dashSplitBlocks(FB);
    assert.equal(blocks.length, 4);
    blocks.forEach((b, i) => assert.match(b, new RegExp(`^\\*\\*DAY:\\*\\* ${PLAN.facebook[i].day}$`, 'm')));
  });

  it('actions.py field reader gets hook and body from the following-line layout', () => {
    const starts = [...FB.matchAll(/^\*{0,2}DAY:/gm)].map((m) => m.index);
    assert.equal(starts.length, 4);
    const blocks = starts.map((s, i) => FB.slice(s, starts[i + 1] ?? FB.length).replace(/\*\*/g, ''));
    blocks.forEach((block, i) => {
      assert.equal(pyBlockField(block, 'HOOK'), PLAN.facebook[i].hook);
      assert.equal(pyBlockField(block, 'BODY'), PLAN.facebook[i].body);
      assert.equal(pyBlockField(block, 'TYPE'), PLAN.facebook[i].type);
    });
  });

  it('renders a hook or body whose first line looks like a field header inline, and it still parses', () => {
    const plan = clone(PLAN);
    plan.facebook[0].hook = 'PSA: turn the breaker off first.';
    plan.facebook[2].body = 'NOTE: this is line one.\nLine two.';
    const text = renderFacebookSchedule(plan, WEEK);
    assert.match(text, /^\*\*HOOK:\*\* PSA: turn the breaker off first\.$/m);
    assert.match(text, /^\*\*BODY:\*\* NOTE: this is line one\. Line two\.$/m);
    const rows = parseFacebookSchedule(text);
    assert.equal(rows[0].hook, 'PSA: turn the breaker off first.');
    assert.equal(rows[2].body, 'NOTE: this is line one. Line two.');
    assert.equal(parseScheduleText(text)[0].hook, 'PSA: turn the breaker off first.');
  });

  it('uses WeekSpec dates over item dates, sorts by day, and falls back without a WeekSpec', () => {
    const plan = clone(PLAN);
    plan.facebook[0].date = '1999-01-01';
    plan.facebook.reverse();
    assert.deepEqual(parseFacebookSchedule(renderFacebookSchedule(plan, WEEK)).map((r) => [r.day, r.post_date]),
      [[1, WEEK.fb_dates[1]], [3, WEEK.fb_dates[3]], [5, WEEK.fb_dates[5]], [6, WEEK.fb_dates[6]]]);
    const text = renderFacebookSchedule(plan, null);
    assert.equal(parseFacebookSchedule(text)[0].post_date, '1999-01-01');
    assert.equal(resolveWeekOf({ argv: [], fbText: text }), PLAN.week_of);
  });

  it('CONTENT NOTES carries the signals, photo gaps, rotation table and degraded flag', () => {
    const notes = FB.slice(FB.indexOf('## CONTENT NOTES'), FB.indexOf('## BOOST BUDGET SUMMARY'));
    assert.match(notes, /^- Search Console: panel upgrade queries up in Rockwall over 28 days$/m);
    assert.match(notes, /^- SerpApi: People Also Ask shows panel cost questions for Rockwall$/m);
    assert.match(notes, /^- GBP day 7 recessed lighting needs a photo$/m);
    assert.match(notes, /^\| Day 1 \| 2026-09-07 \| slideshow \| slideshow, 5 slides \| education \|$/m);
    assert.match(notes, /^\| Day 6 \| 2026-09-12 \| text \| text post \| entertainment \|$/m);
    assert.ok(!/Degraded run/.test(notes));
    const plan = clone(PLAN);
    plan.notes = { trend_signals: [], photo_gaps: [], degraded: true, degraded_reason: null };
    const degraded = renderFacebookSchedule(plan, WEEK);
    assert.match(degraded, /^- No trend signals recorded this week\.$/m);
    assert.match(degraded, /^- None recorded by the planner\.$/m);
    assert.match(degraded, /^- \*\*Degraded run:\*\* one or more collectors were unavailable\.$/m);
  });
});

describe('BOOST BUDGET SUMMARY', () => {
  it('has the exact table shape, YES/MAYBE/NO decisions, — for non-YES budget cells, and the summary lines', () => {
    const section = FB.slice(FB.indexOf('## BOOST BUDGET SUMMARY'));
    const lines = section.split('\n');
    assert.equal(lines[2], '### Weekly Budget: $50');
    assert.equal(lines[4], '| Post | Day | Service | Boost Decision | Daily Budget | Duration | Total |');
    assert.equal(lines[5], '|------|-----|---------|---------------|-------------|----------|-------|');
    assert.equal(lines[6], '| Day 1 | Mon 9/7 | Electrical Panel Upgrade / Replacement | YES | $10/day | 3 days | $30 |');
    assert.equal(lines[7], '| Day 3 | Wed 9/9 | EV Charger Installation | MAYBE | — | — | $0 |');
    assert.equal(lines[8], '| Day 5 | Fri 9/11 | Generator Inlet, Interlock & Installation | YES | $10/day | 2 days | $20 |');
    assert.equal(lines[9], '| Day 6 | Sat 9/12 | Electrical Troubleshooting & Repair | NO | — | — | $0 |');
    assert.equal(lines[11], '- **Posts boosted:** 2 of 4');
    assert.equal(lines[12], '- **TOTAL SPEND:** $50');
    assert.match(lines[13], /^- \*\*Priority post \(boost first\):\*\* Day 1 - Electrical Panel Upgrade \/ Replacement, education slideshow post on Mon 9\/7 with the largest allocation \(\$10\/day x 3 days = \$30\)\./);
    assert.equal(lines[14], '- **Expected weekly reach from boosts:** ~3,000–7,000 additional impressions');
    assert.equal(lines[15], '- **Expected weekly engagement from boosts:** ~50–120 additional engagements');
    assert.equal(lines[16], '- **Boost targeting:** 15mi radius from Rockwall TX, homeowners 28–65, home improvement / DIY / real estate interests. Exclude electrician interest (that is competitors). Use Advantage+ Audience for AI optimization.');
    assert.equal(renderBoostSummary(PLAN, WEEK), section.trimEnd());
  });

  it('is read by the fb-boost-ledger parser as an unconditional $50 allocation with amounts', () => {
    const summary = ledgerParseSummary(FB);
    assert.equal(summary.present, true);
    assert.equal(summary.conditional, false);
    assert.equal(summary.yesTotal, 50);
    assert.deepEqual([...summary.rows.entries()], [
      [1, { decision: 'yes', daily: 10, days: 3 }],
      [3, { decision: 'maybe', daily: null, days: null }],
      [5, { decision: 'yes', daily: 10, days: 2 }],
      [6, { decision: 'no', daily: null, days: null }],
    ]);
    // The ledger's per-post read agrees with the summary and its week key is the Monday.
    const blocks = ledgerPostBlocks(FB);
    assert.deepEqual(blocks.map((b) => [b.day, b.date, b.yesDaily, b.days]), [
      [1, '2026-09-07', 10, 3], [3, '2026-09-09', null, null], [5, '2026-09-11', 10, 2], [6, '2026-09-12', null, null],
    ]);
    assert.equal(ledgerWeekStart(FB), WEEK.week_of);
  });

  it('honors the policy weekly budget option and the plan topic city', () => {
    const plan = clone(PLAN);
    plan.topic.city = 'Frisco';
    const text = renderFacebookSchedule(plan, WEEK, { boostWeeklyUsd: 75 });
    assert.match(text, /^### Weekly Budget: \$75$/m);
    assert.match(text, /^- \*\*Boost targeting:\*\* 15mi radius from Frisco TX,/m);
  });

  it('renders a week with no funded boosts honestly and still parses unconditionally', () => {
    const plan = clone(PLAN);
    for (const f of plan.facebook) f.boost = { decision: f.day === 3 ? 'MAYBE' : 'NO', daily_usd: null, days: null };
    const text = renderFacebookSchedule(plan, WEEK);
    assert.match(text, /^- \*\*Posts boosted:\*\* 0 of 4$/m);
    assert.match(text, /^- \*\*TOTAL SPEND:\*\* \$0$/m);
    assert.match(text, /^- \*\*Priority post \(boost first\):\*\* None - no post is funded this week\.$/m);
    assert.match(text, /^- \*\*Expected weekly reach from boosts:\*\* ~0 additional impressions \(no paid reach this week\)$/m);
    const summary = ledgerParseSummary(text);
    assert.equal(summary.conditional, false);
    assert.equal([...summary.rows.values()].filter((r) => r.decision === 'yes').length, 0);
    assert.equal(ledgerPostBlocks(text).filter((b) => b.yesDaily).length, 0);
  });

  it('renders a single $50 x 1 day boost and fractional dailies the ledger can read', () => {
    const plan = clone(PLAN);
    plan.facebook[0].boost = { decision: 'YES', daily_usd: 50, days: 1 };
    plan.facebook[2].boost = { decision: 'NO', daily_usd: null, days: null };
    let summary = ledgerParseSummary(renderFacebookSchedule(plan, WEEK));
    assert.deepEqual(summary.rows.get(1), { decision: 'yes', daily: 50, days: 1 });
    assert.equal(summary.yesTotal, 50);
    plan.facebook[0].boost = { decision: 'YES', daily_usd: 12.5, days: 4 };
    const text = renderFacebookSchedule(plan, WEEK);
    assert.match(text, /^\| Day 1 \| Mon 9\/7 \| .* \| YES \| \$12\.5\/day \| 4 days \| \$50 \|$/m);
    summary = ledgerParseSummary(text);
    assert.deepEqual(summary.rows.get(1), { decision: 'yes', daily: 12.5, days: 4 });
    assert.equal(summary.conditional, false);
  });

  it('never contains the ledger\'s conditional trigger phrases even with awkward service labels', () => {
    const plan = clone(PLAN);
    plan.facebook[0].service = 'Household Panel | Rewire';
    plan.facebook[0].boost_targeting = 'whichever neighborhood performs better — OR — hold the boost';
    const text = renderFacebookSchedule(plan, WEEK);
    const summary = ledgerParseSummary(text);
    assert.equal(summary.conditional, false, 'per-post targeting prose must not leak into the summary');
    assert.match(text, /^\| Day 1 \| Mon 9\/7 \| Household Panel \/ Rewire \| YES \|/m);
    assert.equal(summary.rows.get(1).decision, 'yes');
  });
});

describe('remaining legacy consumers', () => {
  it('sync-gbp-schedule parseGbpScheduleMarkdown (workbook sync) reads all 7 posts with normalized photos', () => {
    const posts = parseGbpScheduleMarkdown(GBP);
    assert.equal(posts.length, 7);
    posts.forEach((p, i) => {
      const item = PLAN.gbp[i];
      assert.equal(p.date, WEEK.gbp_dates[item.day]);
      assert.equal(p.day, String(item.day));
      assert.equal(p.service, item.service);
      assert.equal(p.topic, item.topic);
      assert.equal(p.headline, item.headline);
      assert.equal(p.body, item.body);
      assert.equal(p.caption, item.caption);
      assert.equal(p.cta, item.cta);
      assert.equal(p.photo_file, item.photo_file || '');
      assert.equal(p.status, 'Needs approval');
    });
  });

  it('fb-boost-api finds each day block by its ledger key and reads BOOST_TARGETING from it', () => {
    for (const item of PLAN.facebook) {
      const key = `day${item.day}-${item.service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      const { block, targeting } = boostApiTargeting(FB, key);
      assert.ok(block.startsWith(`## DAY ${item.day}`), `block for ${key}`);
      assert.equal(targeting, boostFields(item).targeting);
    }
    assert.equal(boostApiTargeting(FB, 'day2-nothing').block, '');
  });

  it('fb-photo-rewrite sees TYPE and PHOTO_FILE on their own lines in every block and reads NEEDS PHOTO as empty', () => {
    const plan = clone(PLAN);
    plan.facebook[1].photo_file = null;
    const blocks = photoRewriteBlocks(renderFacebookSchedule(plan, WEEK));
    assert.deepEqual(blocks.map((b) => b.type), ['slideshow', 'photo', 'carousel', 'text']);
    assert.deepEqual(blocks.map((b) => b.date), Object.values(WEEK.fb_dates).map((d) => `${d} (${formatLongDate(d)})`));
    assert.deepEqual(blocks.map((b) => b.service), plan.facebook.map((f) => f.service));
    assert.ok(blocks.every((b) => b.photoLine !== null), 'every block has a PHOTO_FILE line');
    assert.equal(blocks[1].photoLine, '**PHOTO_FILE:** NEEDS PHOTO');
    assert.equal(normalizePhotoFile(blocks[1].photoLine.replace(/^\*{0,2}PHOTO_FILE:\*{0,2}\s*/i, '')), '');
    assert.equal(normalizePhotoFile(blocks[0].photoLine.replace(/^\*{0,2}PHOTO_FILE:\*{0,2}\s*/i, '')), 'panel-rockwall.jpg');
  });

  it('fb-photo-pick can anchor its PHOTO_FILE rewrite on a photo-type post that has no photo yet', () => {
    // fb-photo-pick replaces the literal line `**PHOTO_FILE:** <parsed value>`; a blank value
    // would leave a trailing space it can never find, so photo-type gaps must be non-blank.
    const plan = clone(PLAN);
    plan.facebook[1].photo_file = null;
    const text = renderFacebookSchedule(plan, WEEK);
    for (const pick of fbPhotoPickParse(text).filter((p) => p.type !== 'text')) {
      assert.ok(text.includes(`**PHOTO_FILE:** ${pick.photoFile}`), `rewrite anchor for day ${pick.day}`);
    }
  });
});

describe('edge cases', () => {
  it('renders a bare **DATE:** when neither the WeekSpec nor the item has a date, and parsers drop that post', () => {
    const plan = clone(PLAN);
    plan.facebook[1].date = '';
    plan.gbp[2].date = '';
    const fb = renderFacebookSchedule(plan, null);
    const gbp = renderGbpSchedule(plan, null);
    assert.match(fb, /^\*\*DATE:\*\*$/m);
    assert.ok(!/\*\*DATE:\*\*\s*\(/.test(fb), 'no empty parenthetical');
    assert.match(gbp, /^\*\*DATE:\*\*$/m);
    assert.deepEqual(parseFacebookSchedule(fb).map((r) => r.day), [1, 5, 6]);
    assert.deepEqual(parseScheduleText(fb).map((p) => p.day), [1, 3, 5, 6]);
    assert.deepEqual(parseGbpSchedule(gbp).map((r) => r.day), [1, 2, 4, 5, 6, 7]);
    assert.equal(fbPhotoPickParse(fb).length, 3);
    // gbp-photo-pick's getter (`DATE:\*{0,2}\s*(.+?)`) lets `\s*` cross the newline, so a bare
    // `**DATE:**` makes it read the next line as the date. The six dated posts stay intact;
    // the seventh carries the leaked SERVICE line (consumer quirk, not fixable in render).
    const picks = gbpPhotoPickParse(gbp);
    assert.deepEqual(picks.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date)).map((p) => p.date),
      [1, 2, 4, 5, 6, 7].map((d) => PLAN.gbp[d - 1].date));
    assert.equal(picks.length, 7);
    assert.match(picks.find((p) => !/^\d{4}-\d{2}-\d{2}$/.test(p.date)).date, /^\*\*SERVICE:\*\*/);
    // With a WeekSpec the missing item dates are filled in.
    assert.deepEqual(parseFacebookSchedule(renderFacebookSchedule(plan, WEEK)).map((r) => r.post_date), Object.values(WEEK.fb_dates));
  });

  it('keeps preparedBy on one header line', () => {
    const gbp = renderGbpSchedule(PLAN, WEEK, { preparedBy: 'Weekly\nPipeline' });
    assert.equal(gbp.split('\n')[1], '**Schedule Period: September 4–10, 2026 | Prepared by Weekly Pipeline**');
    const fb = renderFacebookSchedule(PLAN, WEEK, { preparedBy: 'Weekly\r\nPipeline' });
    assert.match(fb.split('\n')[2], / \| Prepared by Weekly Pipeline$/);
    assert.equal(parseGbpSchedule(gbp).length, 7);
  });

  it('website queue fences a draft that itself contains triple backticks', () => {
    const plan = clone(PLAN);
    plan.website_actions[0].draft.html = '<pre>```js\nlet x = 1;\n```</pre>';
    const text = renderWebsiteQueue(plan);
    assert.match(text, /^````html\n<pre>```js\nlet x = 1;\n```<\/pre>\n````$/m);
    assert.match(renderWebsiteQueue(PLAN), /^```html\n<h2>/m);
  });
});

describe('renderWebsiteQueue', () => {
  it('lists every action with its gate, sources and draft', () => {
    const text = renderWebsiteQueue(PLAN);
    assert.match(text, /^# Website Queue — Week of 2026-09-07$/m);
    assert.match(text, /^2 actions queued \(1 owner-gated\)\./m);
    assert.match(text, /^## 1\. Add a panel upgrade FAQ to \/panel-upgrades\/$/m);
    assert.match(text, /^- \*\*Owner gate:\*\* no$/m);
    assert.match(text, /^- \*\*Sources:\*\* obs-1$/m);
    assert.match(text, /^- \*\*Draft meta description:\*\* Answers about panel upgrades/m);
    assert.match(text, /```html\n<h2>Panel upgrade FAQ<\/h2>[\s\S]*\n```/);
    assert.match(text, /^## 2\. Confirm holiday hours on the contact page$/m);
    assert.match(text, /^- \*\*Owner gate:\*\* yes — owner must confirm before this is worked$/m);
    assert.match(text, /^- \*\*Sources:\*\* —$/m);
    assert.match(text, /^- \*\*Draft:\*\* none$/m);
  });
  it('says so when there are no actions', () => {
    const text = renderWebsiteQueue({ ...PLAN, website_actions: [] });
    assert.match(text, /^No website actions this week\.$/m);
    assert.ok(!text.includes('## 1.'));
  });
});

describe('renderPlanSummary', () => {
  const SELECTION = {
    winner: {
      service_key: 'panel_upgrade', service_label: 'Electrical Panel Upgrade / Replacement', city: 'Rockwall',
      query_family: PLAN.topic.query_family, total: 0.8123,
      scores: { priority: 1, demand: 0.6, opportunity: 1, recency: 1, season: 0.9, performance: 0.5 },
      reasons: ['top priority service', 'page-2 impressions in Rockwall'],
    },
    ranked: [
      { service_key: 'panel_upgrade', service_label: 'Electrical Panel Upgrade / Replacement', city: 'Rockwall', total: 0.8123, scores: {}, query_family: [], reasons: [] },
      { service_key: 'ev_charger', service_label: 'EV Charger Installation', city: 'Wylie', total: 0.79, scores: {}, query_family: [], reasons: [] },
      { service_key: 'generator', service_label: 'Generator Inlet, Interlock & Installation', city: 'Garland', total: 0.7, scores: {}, query_family: [], reasons: [] },
    ],
    excluded: [{ candidate: { service_key: 'surge_protection', service_label: 'Whole-Home Surge Protection', city: 'Rowlett' }, reason: 'winner two weeks ago' }],
    rationale: 'Panel upgrades in Rockwall lead on priority and opportunity; EV charger in Wylie is the runner-up.',
    degraded: false,
  };
  const ATTEMPT = {
    id: 'att_render_fixture', week_of: '2026-09-07', mode: 'shadow', git_sha: 'abc1234',
    versions: { schema: '2026-09-06.1', prompt: 'p1', policy: '2026-09-06.1' },
    models: { generate: 'deepseek-chat', fallback: null },
    started_at: '2026-09-04T17:00:00.000Z', finished_at: '2026-09-04T17:02:30.000Z',
    stages: {
      collect: { started_at: '2026-09-04T17:00:00.000Z', finished_at: '2026-09-04T17:00:40.000Z', status: 'ok', error: null },
      generate: { started_at: '2026-09-04T17:00:40.000Z', finished_at: '2026-09-04T17:02:00.000Z', status: 'ok', error: null },
      compare: { started_at: '2026-09-04T17:02:00.000Z', finished_at: null, status: 'skipped', error: 'no legacy outputs' },
    },
    lease_until: null, budget_usd: 20, spent_usd: 0.1234, status: 'succeeded', error: null,
  };

  it('summarizes attempt, selection, schedules, website actions and notes', () => {
    const text = renderPlanSummary(PLAN, SELECTION, ATTEMPT);
    assert.match(text, /^# Weekly Plan Summary — Week of 2026-09-07$/m);
    assert.match(text, /^- \*\*ID:\*\* att_render_fixture$/m);
    assert.match(text, /^- \*\*Mode \/ status:\*\* shadow \/ succeeded$/m);
    assert.match(text, /\*\*Runtime:\*\* 150\.0s$/m);
    assert.match(text, /^- \*\*Spend:\*\* \$0\.12 of \$20\.00 budget$/m);
    assert.match(text, /^\| collect \| ok \| 40\.0s \| — \|$/m);
    assert.match(text, /^\| compare \| skipped \| — \| no legacy outputs \|$/m);
    assert.match(text, /^- \*\*Winner:\*\* Electrical Panel Upgrade \/ Replacement — Rockwall$/m);
    assert.match(text, /^- \*\*Score:\*\* 0\.812$/m);
    assert.match(text, /^\| 1\.00 \| 0\.60 \| 1\.00 \| 1\.00 \| 0\.90 \| 0\.50 \|$/m);
    assert.match(text, /^1\. EV Charger Installation — Wylie \(0\.790\)$/m);
    assert.match(text, /^2\. Generator Inlet, Interlock & Installation — Garland \(0\.700\)$/m);
    assert.ok(!/^\d\. Electrical Panel Upgrade \/ Replacement — Rockwall/m.test(text), 'winner is not listed as a runner-up');
    assert.match(text, /^- Whole-Home Surge Protection — Rowlett: winner two weeks ago$/m);
    assert.match(text, /^## GBP posts \(7\)$/m);
    assert.match(text, /^\| 7 \| 2026-09-10 \| Recessed Lighting Installation \| Brighter Kitchens Start With a Lighting Plan \| NEEDS PHOTO \|$/m);
    assert.match(text, /^## Facebook posts \(4\)$/m);
    assert.match(text, /^\| 1 \| 2026-09-07 \| slideshow \| .* \| YES \$10\/day x 3 days = \$30 \|$/m);
    assert.match(text, /^\| 3 \| 2026-09-09 \| photo \| .* \| MAYBE \|$/m);
    assert.match(text, /^- \[low\] website_hours_update — Confirm holiday hours on the contact page \(owner gate\)$/m);
    assert.match(text, /^- \*\*Degraded:\*\* no$/m);
    assert.match(text, /^  - Search Console: panel upgrade queries up in Rockwall over 28 days$/m);
  });

  it('tolerates a missing selection and attempt, and reports degraded runs', () => {
    const plan = clone(PLAN);
    plan.notes.degraded = true;
    plan.notes.degraded_reason = 'SerpApi cap reached';
    const text = renderPlanSummary(plan, null, null);
    assert.match(text, /^- No attempt record supplied\.$/m);
    assert.match(text, /^- \*\*Selection:\*\* no selection record supplied\.$/m);
    assert.match(text, /^- \*\*Degraded:\*\* yes — SerpApi cap reached$/m);
    const degradedSel = renderPlanSummary(PLAN, { ...SELECTION, degraded: true }, { ...ATTEMPT, status: 'failed', error: 'boom', finished_at: null });
    assert.match(degradedSel, /degraded selection — Search Console and SerpApi were both unavailable/);
    assert.match(degradedSel, /^- \*\*Mode \/ status:\*\* shadow \/ failed — boom$/m);
    assert.match(degradedSel, /\*\*Finished:\*\* not finished \| \*\*Runtime:\*\* —$/m);
  });
});
