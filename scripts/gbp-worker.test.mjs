/**
 * Node test for gbp-worker's Grok-verdict decision policy and the G3 session
 * ownership/handoff + stuck-pass guard.
 * The Grok bot writes one verdict file per post-date (state/gbp-grok/<date>.json);
 * the worker applies each verdict to weekly_posts. The no-repost rule: a not_found
 * verdict triggers exactly one retry, then needs_verification (never an infinite
 * retry loop, never 'error' just because a live post wasn't found).
 * Run: node --test scripts/gbp-worker.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  grokVerdictDecision,
  acquireGbpWorkerLock,
  gbpWorkerProcessExists,
  createGbpSessionState,
  createGbpPollGuard,
  parseSessionProbe,
} from './gbp-worker.mjs';

describe('grokVerdictDecision (Grok-verdict reconciliation policy)', () => {
  it('confirms a live verdict', () => {
    assert.equal(grokVerdictDecision({ verdict: 'live', alreadyRetried: false }), 'confirm');
    assert.equal(grokVerdictDecision({ verdict: 'live', alreadyRetried: true }), 'confirm');
    assert.equal(grokVerdictDecision({ verdict: 'LIVE', alreadyRetried: false }), 'confirm');
  });

  it('retries once on the first not_found', () => {
    assert.equal(grokVerdictDecision({ verdict: 'not_found', alreadyRetried: false }), 'retry');
  });

  it('gives up (needs_verification) on a second not_found after retry', () => {
    assert.equal(grokVerdictDecision({ verdict: 'not_found', alreadyRetried: true }), 'give_up');
  });

  it('ignores unrecognized verdicts', () => {
    assert.equal(grokVerdictDecision({ verdict: 'scheduled', alreadyRetried: false }), 'ignore');
    assert.equal(grokVerdictDecision({ verdict: '', alreadyRetried: false }), 'ignore');
  });
});

describe('acquireGbpWorkerLock (single-instance)', () => {
  it('takes over a stale pidfile when the previous process is dead', () => {
    const files = { '/tmp/gbp-worker.pid': '4321' };
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 99,
      isAlive: () => false,
      readFile: (p) => files[p],
      writeFile: (p, c) => { files[p] = c; },
    });
    assert.equal(lock.ok, true);
    assert.equal(files['/tmp/gbp-worker.pid'], '99');
  });

  it('refuses to start when another gbp-worker pid is still alive', () => {
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 99,
      isAlive: (pid) => pid === 4321,
      readFile: () => '4321',
      writeFile: () => { throw new Error('must not overwrite a live lock'); },
    });
    assert.equal(lock.ok, false);
    assert.equal(lock.existingPid, 4321);
  });

  it('treats the current pid as the owner', () => {
    const files = {};
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 7,
      isAlive: () => true,
      readFile: () => '7',
      writeFile: (p, c) => { files[p] = c; },
    });
    assert.equal(lock.ok, true);
    assert.equal(files['/tmp/gbp-worker.pid'], '7');
  });

  it('refuses when a concurrent starter won the exclusive create', () => {
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 99,
      isAlive: (pid) => pid === 555,
      readFile: () => '555',
      writeFile: () => { const e = new Error('EEXIST: file already exists'); e.code = 'EEXIST'; throw e; },
    });
    assert.equal(lock.ok, false);
    assert.equal(lock.existingPid, 555);
  });

  it('takes over a stale pidfile that raced the exclusive create', () => {
    let content = '4321';
    const lock = acquireGbpWorkerLock({
      pidPath: '/tmp/gbp-worker.pid',
      pid: 99,
      isAlive: () => false,
      readFile: () => content,
      unlink: () => { content = ''; },
      writeFile: (p, c) => {
        if (content) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e; }
        content = c;
      },
    });
    assert.equal(lock.ok, true);
    assert.equal(content, '99');
  });
});

describe('gbpWorkerProcessExists', () => {
  it('returns true for this process', () => {
    assert.equal(gbpWorkerProcessExists(process.pid), true);
  });
  it('returns false for pid 0 / garbage', () => {
    assert.equal(gbpWorkerProcessExists(0), false);
    assert.equal(gbpWorkerProcessExists('nope'), false);
  });
});

describe('parseSessionProbe (driver --check-session contract)', () => {
  it('accepts only a bounded ok:true result', () => {
    assert.deepEqual(parseSessionProbe({ exitCode: 0, stdout: 'noise\n{"ok":true,"reason":"ok"}\n' }),
      { ok: true, reason: 'ok' });
  });
  it('passes the failure reason through', () => {
    assert.deepEqual(parseSessionProbe({ exitCode: 2, stdout: '{"ok":false,"reason":"captcha"}\n' }),
      { ok: false, reason: 'captcha' });
  });
  it('never treats a crash, silence, or a live-post result as a pass', () => {
    assert.deepEqual(parseSessionProbe({ exitCode: 1, stdout: '' }), { ok: false, reason: 'unknown' });
    assert.deepEqual(parseSessionProbe({ exitCode: 1, stdout: '{"result":"failed"}' }), { ok: false, reason: 'unknown' });
    assert.deepEqual(parseSessionProbe(undefined), { ok: false, reason: 'unknown' });
  });
});

// The handoff under test: failed probe → release → interactive takeover → background
// stays idle (including retries) → resumption needs exclusive reacquisition PLUS a
// passing probe. `tick` mirrors one poll pass with every side effect recorded.
function makeSessionHarness({ probeResult, pid = 4242, startClock = 1_700_000_000_000 }) {
  const health = [];
  const released = [];
  const alerts = [];
  const probeCalls = [];
  const state = { holder: null, probe: probeResult, clock: startClock };
  const session = createGbpSessionState({
    pid,
    acquire: () => (state.holder
      ? { ok: false, existingPid: state.holder }
      : { ok: true, existingPid: null }),
    release: () => { released.push(state.clock); },
    probe: async (context) => { probeCalls.push(context); return state.probe(); },
    recordHealth: (record) => { health.push(record); },
    alert: async (reason) => { alerts.push(reason); },
    log: async () => {},
    now: () => state.clock,
    backoffMs: 15 * 60 * 1000,
  });
  const tick = async () => {
    if (!session.owned) {
      const lock = await session.tryAcquire();
      if (!lock?.ok) return { idle: true, posted: false };
    }
    const ctx = session.probeDue({ cstHour: 9, todayDate: '2026-09-26' });
    if (ctx) await session.runProbe(ctx, '2026-09-26');
    const posted = session.canPost();
    await session.settle();   // the worker releases here, after the pass settles
    return { idle: false, posted };
  };
  return { session, tick, health, released, alerts, probeCalls, state };
}

describe('gbp session handoff (G3)', () => {
  it('failed probe: alerts once, releases after the pass settles, records health', async () => {
    const h = makeSessionHarness({ probeResult: () => ({ ok: false, reason: 'logged_out' }) });
    const first = await h.tick();

    assert.equal(first.posted, false, 'a failed probe must not post');
    assert.equal(h.released.length, 1, 'ownership is released after the pass settles');
    assert.equal(h.alerts.length, 1, 'one alert per failure episode');
    assert.equal(h.health.length, 1, 'health recorded once');
    const record = h.health[0];
    assert.equal(record.ok, false);
    assert.equal(record.reason, 'logged_out');
    assert.equal(record.pid, 4242, 'health carries the probing PID');
    assert.equal(record.context, 'daily', 'health carries the worker context');
    assert.equal(record.mode, 'playwright');
    assert.equal(record.ts, new Date(1_700_000_000_000).toISOString(), 'health carries a fresh timestamp');
  });

  it('idle forever while an interactive session holds the lock (including retries)', async () => {
    const h = makeSessionHarness({ probeResult: () => ({ ok: false, reason: 'logged_out' }) });
    await h.tick();
    h.state.holder = 7777;   // interactive takeover: a live pid owns the pidfile

    for (let i = 0; i < 3; i++) {
      h.state.clock += 20 * 60 * 1000;
      const t = await h.tick();
      assert.deepEqual(t, { idle: true, posted: false });
    }

    assert.equal(h.probeCalls.length, 1, 'an idle process never reopens the profile');
    assert.equal(h.health.length, 1, "an idle process never writes another owner's health record");
    assert.equal(h.released.length, 1, "an idle process never touches a lock it does not own");
    assert.equal(h.alerts.length, 1, 'retries do not re-alert while still broken');
  });

  it('resumption needs exclusive reacquisition AND a passing probe', async () => {
    const h = makeSessionHarness({ probeResult: () => ({ ok: false, reason: 'logged_out' }) });
    await h.tick();
    h.state.holder = 7777;
    h.state.clock += 20 * 60 * 1000;
    assert.equal((await h.tick()).idle, true);

    // The interactive session ends: the pidfile is free again.
    h.state.holder = null;
    h.state.clock += 20 * 60 * 1000;
    const reacquired = await h.tick();
    assert.equal(reacquired.idle, false, 'reacquires the pidfile exclusively');
    assert.equal(reacquired.posted, false, 'reacquisition alone must not post (probe still fails)');
    assert.equal(h.released.length, 2, 'the still-failing probe releases ownership again');

    // The session is fixed: the next pass probes, passes, and may post.
    h.state.probe = () => ({ ok: true, reason: 'ok' });
    h.state.clock += 20 * 60 * 1000;
    const resumed = await h.tick();
    assert.equal(resumed.posted, true, 'posting resumes only after a passing probe');
    assert.equal(h.released.length, 2, 'a passing probe keeps ownership');
  });

  it('solo worker with a failing session probes once per backoff, not once per tick', async () => {
    // F-1: a failing probe releases ownership, and the next ~30s tick used to
    // reacquire, reset lastProbeAt, and relaunch Chromium — forever.
    const h = makeSessionHarness({ probeResult: () => ({ ok: false, reason: 'logged_out' }) });
    for (let i = 0; i < 6; i++) {
      if (i) h.state.clock += 30 * 1000;   // POLL_INTERVAL_MS ticks
      const t = await h.tick();
      assert.equal(t.posted, false);
    }
    assert.equal(h.probeCalls.length, 1, 'six 30s ticks must launch one Chromium probe, not six');
    assert.equal(h.released.length, 1, 'ownership is released once, after the failing pass settle');
    assert.equal(h.health.length, 1, 'health is recorded once per probe (one alert episode)');
    assert.equal(h.alerts.length, 1);

    // The retry cadence is the backoff, not the poll interval.
    h.state.clock += 15 * 60 * 1000;
    await h.tick();
    assert.equal(h.probeCalls.length, 2, 'the next attempt happens once the backoff has elapsed');
    assert.equal(h.probeCalls.filter((c) => c).length, 2, 'probes stay ownership-gated');
  });

  it('does not probe in API mode (GBP_POSTER=api is unchanged)', async () => {
    const session = createGbpSessionState({
      supported: false,
      acquire: () => ({ ok: true, existingPid: null }),
      probe: async () => { throw new Error('must not probe'); },
      log: async () => {},
    });
    await session.tryAcquire();
    assert.equal(session.probeDue({ cstHour: 9, todayDate: '2026-09-26' }), null);
    assert.equal(session.canPost(), true, 'API mode posts without a browser session');
  });
});

describe('createGbpPollGuard (stuck pass fails closed)', () => {
  it('never clears the busy flag while a pass is stuck', async () => {
    let clock = 1000;
    const stuck = [];
    const guard = createGbpPollGuard({
      now: () => clock,
      stuckMs: 20 * 60 * 1000,
      onStuck: async (since) => { stuck.push(since); },
    });

    assert.equal(await guard.begin(), true, 'the first pass may run');
    clock += 60 * 1000;
    assert.equal(await guard.begin(), false, 'a running pass blocks a second one');
    assert.equal(guard.busy, true);

    // Past the ceiling the old code cleared `busy` "so 9am posts can resume" while
    // the browser/child could still be alive — that is the double-post regression.
    clock += 20 * 60 * 1000;
    assert.equal(await guard.begin(), false);
    assert.equal(guard.busy, true, 'a stuck pass must NOT clear busy');
    assert.equal(stuck.length, 1, 'the operator is alerted once');
    assert.equal(stuck[0], 1000, 'the alert names when the stuck pass began');

    clock += 60 * 60 * 1000;
    assert.equal(await guard.begin(), false);
    assert.equal(stuck.length, 1, 'no repeat alert while it stays stuck');
    assert.equal(guard.busy, true);

    guard.end();   // the pass finally settled
    assert.equal(guard.busy, false);
    assert.equal(await guard.begin(), true, 'a settled pass allows the next one');
  });
});
