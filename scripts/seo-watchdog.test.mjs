/** Last-week silent success must not look Healthy. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatchdog, evaluatePipelineWatchdog } from './seo-watchdog.mjs';

function fridayTen() {
  // 2026-08-28 is a Friday. Local 10:00 — past the 09:00 deadline.
  return new Date(2026, 7, 28, 10, 0, 0);
}

describe('evaluateWatchdog', () => {
  it('NOTIFY MISS: success + empty notify at Friday 10:00 (last week)', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: {
        status: 'success',
        date: '2026-08-28',
        at: new Date(2026, 7, 28, 8, 30, 0).toISOString(),
      },
      notify: null,
    });
    assert.ok(problems.some((p) => p.startsWith('NOTIFY MISS')), problems.join('\n'));
  });

  it('green when success and notify.sent true', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: {
        status: 'success',
        date: '2026-08-28',
        at: new Date(2026, 7, 28, 8, 30, 0).toISOString(),
      },
      notify: { sent: true, channel: 'hermes' },
    });
    assert.deepEqual(problems, []);
  });

  it('HUNG when still started after 90 min', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: {
        status: 'started',
        date: '2026-08-28',
        at: new Date(2026, 7, 28, 8, 30, 0).toISOString(),
      },
      notify: null,
    });
    assert.ok(problems.some((p) => p.startsWith('HUNG')), problems.join('\n'));
  });

  it('NO-SHOW when marker missing on run day past deadline', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: null,
      notify: null,
    });
    assert.ok(problems.some((p) => p.startsWith('NO-SHOW')), problems.join('\n'));
  });

  it('RUN FAILED when today failed', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: { status: 'failed', date: '2026-08-28', error: 'crew exit 1', at: new Date().toISOString() },
      notify: null,
    });
    assert.ok(problems.some((p) => p.startsWith('RUN FAILED')), problems.join('\n'));
  });

  it('AUTO-APPROVE DID NOT TAKE when flag on and run still pending', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: {
        status: 'success',
        date: '2026-08-28',
        at: new Date(2026, 7, 28, 8, 30, 0).toISOString(),
      },
      notify: { sent: true },
      autoApprove: true,
      latestRun: { id: 'r1', status: 'pending_approval' },
    });
    assert.ok(problems.some((p) => p.startsWith('AUTO-APPROVE DID NOT TAKE')), problems.join('\n'));
  });

  it('does not flag AUTO-APPROVE when notify.autoApprove true', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: {
        status: 'success',
        date: '2026-08-28',
        at: new Date(2026, 7, 28, 8, 30, 0).toISOString(),
      },
      notify: { sent: true, autoApprove: true },
      autoApprove: true,
    });
    assert.deepEqual(problems, []);
  });

  it('AUTO-APPROVE DID NOT TAKE inferred from notify.autoApprove false (no supabase)', () => {
    const problems = evaluateWatchdog({
      now: fridayTen(),
      health: {
        status: 'success',
        date: '2026-08-28',
        at: new Date(2026, 7, 28, 8, 30, 0).toISOString(),
      },
      notify: { sent: true, autoApprove: false },
      autoApprove: true,
    });
    assert.ok(problems.some((p) => p.startsWith('AUTO-APPROVE DID NOT TAKE')), problems.join('\n'));
  });
});

// ── T3: the shadow/new pipeline block ────────────────────────────────────────
describe('evaluatePipelineWatchdog', () => {
  const missingReceipt = {
    event: 'succeeded', sent: false, status: 'missing',
    error: 'no notify:<event> receipt on the attempt record',
  };
  const deliveredReceipt = { event: 'succeeded', sent: true, status: 'ok', channel: 'hermes+smtp' };
  const freshReconcile = { status: 'ok', last_success_at: new Date(2026, 7, 28, 10, 10, 0).toISOString() };

  function shadow(status, extra = {}, at = new Date(2026, 7, 28, 8, 30, 0)) {
    return {
      status, mode: 'shadow', at: at.toISOString(), launched_at: at.toISOString(),
      week_of: '2026-08-31', log_file: 'outputs/weekly-shadow-2026-08-28.log',
      notify: missingReceipt, ...extra,
    };
  }

  function evaluate(block, { now = fridayTen(), pipelineMode = 'shadow', reconcile = freshReconcile } = {}) {
    return evaluatePipelineWatchdog({
      now,
      pipelineMode,
      health: { status: 'success', date: '2026-08-28', shadow: block },
      reconcile,
    });
  }

  const cases = [
    ['still running past the hung threshold', shadow('running'), /^PIPELINE HUNG/],
    ['failed attempt', shadow('failed', { error: 'collect: facebook unavailable' }), /^PIPELINE FAILED/],
    ['failed (stale attempt)', shadow('failed (stale attempt)'), /^PIPELINE FAILED/],
    ['failed (no attempt written)', shadow('failed (no attempt written)'), /^PIPELINE FAILED/],
    ['failed (killed at the deadline)', shadow('failed (killed at the deadline)'), /^PIPELINE FAILED/],
    ['succeeded with a delivered receipt', shadow('succeeded', { notify: deliveredReceipt }), null],
    ['degraded with a delivered receipt', shadow('degraded', { notify: deliveredReceipt }), null],
    ['succeeded with no receipt', shadow('succeeded'), /^PIPELINE NOTIFY MISS/],
    ['succeeded with an undelivered receipt', shadow('succeeded', {
      notify: { event: 'succeeded', sent: false, status: 'failed', error: 'all channels failed' },
    }), /^PIPELINE NOTIFY MISS/],
    ['no shadow block at all', null, /^PIPELINE NO-SHOW/],
    ['shadow block from last Friday', shadow('succeeded', { notify: deliveredReceipt }, new Date(2026, 7, 21, 8, 30, 0)), /^PIPELINE NO-SHOW/],
  ];

  for (const [name, block, expected] of cases) {
    it(`${name} -> ${expected ? expected.source : 'no problems'}`, () => {
      const problems = evaluate(block);
      if (expected) assert.ok(problems.some((p) => expected.test(p)), problems.join('\n'));
      else assert.deepEqual(problems, []);
    });
  }

  it('stale reconcile freshness is a problem even when the Friday attempt was clean', () => {
    const problems = evaluate(shadow('succeeded', { notify: deliveredReceipt }), {
      reconcile: { status: 'failed', last_success_at: new Date(2026, 7, 23, 10, 10, 0).toISOString() },
    });
    assert.deepEqual(problems.map((p) => p.split(':')[0]), ['RECONCILE STALE']);
    assert.match(problems[0], /last_success_at/);
  });

  it('a never-written reconcile health file is stale, not healthy', () => {
    const problems = evaluate(shadow('succeeded', { notify: deliveredReceipt }), { reconcile: null });
    assert.ok(problems.some((p) => p.startsWith('RECONCILE STALE')), problems.join('\n'));
  });

  it('new mode does not depend on a legacy success', () => {
    // Legacy says success; the rebuild failed. The rebuilt attempt wins.
    const problems = evaluate(shadow('failed'), { pipelineMode: 'new' });
    assert.ok(problems.some((p) => p.startsWith('PIPELINE FAILED')), problems.join('\n'));
    // Legacy says failed; the rebuild is clean and delivered. Nothing new to report.
    const clean = evaluatePipelineWatchdog({
      now: fridayTen(),
      pipelineMode: 'new',
      health: { status: 'failed', date: '2026-08-28', shadow: shadow('succeeded', { notify: deliveredReceipt }) },
      reconcile: freshReconcile,
    });
    assert.deepEqual(clean, []);
  });

  it('legacy mode watches nothing new', () => {
    const stale = { status: 'failed', last_success_at: null };
    for (const mode of ['legacy', '', 'Legacy', 'offline']) {
      assert.deepEqual(evaluate(shadow('failed'), { pipelineMode: mode, reconcile: stale }), []);
    }
  });

  it('only checks the run day once the deadline has passed', () => {
    const saturday = new Date(2026, 7, 29, 10, 0, 0);
    assert.deepEqual(evaluate(shadow('failed'), { now: saturday }), []);
    const beforeDeadline = new Date(2026, 7, 28, 8, 45, 0);
    assert.deepEqual(evaluate(shadow('failed'), { now: beforeDeadline }), []);
  });
});
