import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEngagementMarkdown,
  summarizeBoostLedger,
  reviewCountComparison,
  outputsDirNote,
  formatCents,
  PHASE2_TREND_NOTE,
} from './performance.js';
import { FIXTURE_ENGAGEMENT_MD, FIXTURE_BOOST_LEDGER } from '../fixtures/performance.js';

describe('parseEngagementMarkdown', () => {
  it('does not throw on bad input', () => {
    for (const bad of [null, undefined, '', 12, {}, [], true, 'not markdown\n|||']) {
      const out = parseEngagementMarkdown(bad);
      assert.equal(typeof out.title, 'string');
      assert.ok(Array.isArray(out.rows));
      assert.equal(typeof out.raw, 'string');
    }
  });

  it('pulls title, **key**: value bullets, and table rows from fixture md', () => {
    const out = parseEngagementMarkdown(FIXTURE_ENGAGEMENT_MD);
    assert.match(out.title, /Facebook Engagement Report/);
    assert.equal(out.raw, FIXTURE_ENGAGEMENT_MD);
    const byLabel = Object.fromEntries(out.rows.filter((r) => r.value).map((r) => [r.label, r.value]));
    assert.equal(byLabel.Reach, '890');
    assert.equal(byLabel.Likes, '41');
    assert.ok(out.rows.some((r) => /panel upgrade/i.test(`${r.label} ${r.value}`)));
    assert.ok(out.rows.some((r) => r.label === 'Double down on'));
  });
});

describe('summarizeBoostLedger', () => {
  it('computes remaining from cap and spent (fixture $50 cap, $0 spent)', () => {
    const s = summarizeBoostLedger(FIXTURE_BOOST_LEDGER);
    assert.equal(s.week, '2026-08-24');
    assert.equal(s.capCents, 5000);
    assert.equal(s.spentCents, 0);
    assert.equal(s.remainingCents, 5000);
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0].status, 'skipped');
    assert.equal(s.entries[0].decision, 'conditional');
  });

  it('computes remainingCents as cap minus spent', () => {
    const s = summarizeBoostLedger({
      week: '2026-08-24',
      capCents: 5000,
      spentCents: 1500,
      entries: [],
    });
    assert.equal(s.remainingCents, 3500);
    assert.equal(formatCents(s.remainingCents), '$35.00');
  });

  it('maps missing numbers to null and does not throw', () => {
    const empty = summarizeBoostLedger(null);
    assert.equal(empty.week, null);
    assert.equal(empty.spentCents, null);
    assert.equal(empty.capCents, null);
    assert.equal(empty.remainingCents, null);
    assert.deepEqual(empty.entries, []);

    const partial = summarizeBoostLedger({ week: '2026-08-24', capCents: 5000 });
    assert.equal(partial.spentCents, null);
    assert.equal(partial.remainingCents, null);
  });
});

describe('reviewCountComparison', () => {
  it('reports ours − competitor gap and the Phase-2 note', () => {
    const c = reviewCountComparison(154, 1500);
    assert.equal(c.ours, 154);
    assert.equal(c.competitor, 1500);
    assert.equal(c.gap, -1346);
    assert.match(c.note, /1346 reviews behind/);
    assert.match(c.note, /Phase-2 structured store/);
  });
});

describe('outputsDirNote', () => {
  it('documents bundled fixtures (no client fs)', () => {
    const note = outputsDirNote();
    assert.match(note, /bundled fixtures/);
    assert.equal(note.includes(PHASE2_TREND_NOTE.split('.')[0]), true);
  });
});
