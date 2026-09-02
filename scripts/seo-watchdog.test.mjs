/** Last-week silent success must not look Healthy. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatchdog } from './seo-watchdog.mjs';

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
