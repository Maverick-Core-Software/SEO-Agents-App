// scripts/lib/slack-interactions.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac } from 'node:crypto';
import { makeAlertStore } from './alert-store.mjs';
import {
  handleSlackInteraction, parseSlackPayload, parseActionRef, isAllowedInteraction,
} from './slack-interactions.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const RUN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TASK = '11111111-2222-3333-4444-555555555555';

const sign = (secret, ts, body) =>
  'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`, 'utf8').digest('hex');
const formBody = (payload) => 'payload=' + encodeURIComponent(JSON.stringify(payload));

// Minimal in-memory supabase stand-in (same shape as slack-actions.test.mjs).
function makeSupabase(seed) {
  const tables = new Map(Object.entries(seed).map(([t, rows]) => [t, rows.map(r => ({ ...r }))]));
  const matches = (row, filters) => filters.every(([op, k, v]) =>
    op === 'eq' ? row[k] === v : op === 'in' ? v.includes(row[k]) : true);
  function makeChain(table) {
    const filters = [];
    let patch = null;
    let isUpdate = false;
    const exec = (single) => {
      const matched = (tables.get(table) || []).filter(r => matches(r, filters));
      if (isUpdate) for (const r of matched) Object.assign(r, patch);
      return Promise.resolve(single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null });
    };
    return {
      update(p) { isUpdate = true; patch = p; return this; },
      select() { return this; },
      eq(k, v) { filters.push(['eq', k, v]); return this; },
      in(k, v) { filters.push(['in', k, v]); return this; },
      maybeSingle() { return exec(true); },
      then(res, rej) { return exec(false).then(res, rej); },
    };
  }
  return { from: t => makeChain(t), tables };
}

const tmpStore = path.join(os.tmpdir(), `alerted-ixn-${Date.now()}.json`);
try { fs.rmSync(tmpStore, { force: true }); } catch {}
const alertStore = makeAlertStore(tmpStore);

const ts = String(Math.floor(Date.now() / 1000));
const nowMs = Number(ts) * 1000;
const payload = (actionId, extra = {}) => ({
  type: 'block_actions',
  user: { id: 'U123', username: 'carter' },
  actions: [{ action_id: actionId, value: 'ignored-value' }],
  ...extra,
});
const base = { supabase: makeSupabase({ seo_runs: [{ id: RUN, status: 'pending_approval', week_of: '2026-09-07' }] }), alertStore, config: { signingSecret: SECRET }, nowMs };

// ── parse helpers ──
assert.deepEqual(parseActionRef('seo_approve:abcd-1234'), { verb: 'approve', id: 'abcd-1234' });
assert.equal(parseActionRef('seo_delete:abc-123'), null);          // verb not allowlisted
assert.equal(parseActionRef('seo_approve:not a uuid!!'), null);    // id shape rejected
assert.equal(parseActionRef('approve:abc-123'), null);             // missing namespace
assert.equal(parseActionRef(null), null);
assert.equal(isAllowedInteraction({ type: 'block_actions', actions: [{}] }), true);
assert.equal(isAllowedInteraction({ type: 'block_actions', actions: [] }), false);
assert.equal(isAllowedInteraction({ type: 'view_submission' }), false);
assert.equal(parseSlackPayload('payload=' + encodeURIComponent('{"type":"block_actions"}'), 'application/x-www-form-urlencoded').type, 'block_actions');
assert.equal(parseSlackPayload('{"type":"block_actions"}', 'application/json').type, 'block_actions');
assert.equal(parseSlackPayload('garbage', 'application/x-www-form-urlencoded'), null);
assert.equal(parseSlackPayload('', 'application/x-www-form-urlencoded'), null);

// ── valid signed approve → dispatch happens ──
{
  const body = formBody(payload(`seo_approve:${RUN}`));
  const out = await handleSlackInteraction({
    ...base,
    rawBody: body,
    headers: {
      'x-slack-signature': sign(SECRET, ts, body),
      'x-slack-request-timestamp': ts,
    },
  });
  assert.equal(out.status, 200);
  assert.ok(out.body.text.includes('Approved'));
  assert.equal(base.supabase.tables.get('seo_runs')[0].status, 'approved'); // mutation ran
}

// ── payload `token` field is NEVER trusted ──
{
  // valid signature + bogus token => still processed (auth is the signature)
  const body = formBody(payload(`seo_approve:${TASK}`, { token: 'attacker-controlled' }));
  const sb = makeSupabase({ website_tasks: [{ id: TASK, run_id: RUN, status: 'pending_approval', title: 'Fix meta' }] });
  const out = await handleSlackInteraction({
    supabase: sb, alertStore, config: { signingSecret: SECRET }, nowMs,
    rawBody: body,
    headers: { 'x-slack-signature': sign(SECRET, ts, body), 'x-slack-request-timestamp': ts },
  });
  assert.equal(out.status, 200);
  assert.equal(sb.tables.get('website_tasks')[0].status, 'approved');

  // forged-looking token + bad signature => rejected (token buys nothing)
  const body2 = formBody(payload(`seo_approve:${TASK}`, { token: SECRET }));
  const sb2 = makeSupabase({ website_tasks: [{ id: TASK, run_id: RUN, status: 'pending_approval', title: 'Fix meta' }] });
  const out2 = await handleSlackInteraction({
    supabase: sb2, alertStore, config: { signingSecret: SECRET }, nowMs,
    rawBody: body2,
    headers: { 'x-slack-signature': 'v0:' + '0'.repeat(64), 'x-slack-request-timestamp': ts },
  });
  assert.equal(out2.status, 401);
  assert.equal(sb2.tables.get('website_tasks')[0].status, 'pending_approval'); // untouched
}

// ── bad signature → 401, no DB touch ──
{
  const body = formBody(payload(`seo_approve:${RUN}`));
  const sb = makeSupabase({ seo_runs: [{ id: RUN, status: 'pending_approval' }] });
  const out = await handleSlackInteraction({
    supabase: sb, alertStore, config: { signingSecret: SECRET }, nowMs,
    rawBody: body,
    headers: { 'x-slack-signature': sign(SECRET, ts, body + 'tampered'), 'x-slack-request-timestamp': ts },
  });
  assert.equal(out.status, 401);
  assert.equal(sb.tables.get('seo_runs')[0].status, 'pending_approval');
}

// ── genuinely stale timestamp (replay) → 401 ──
{
  const staleTs = String(Math.floor((nowMs - 10 * 60 * 1000) / 1000));
  const body = formBody(payload(`seo_approve:${RUN}`));
  const out = await handleSlackInteraction({
    supabase: base.supabase, alertStore, config: { signingSecret: SECRET }, nowMs,
    rawBody: body,
    headers: {
      'x-slack-signature': sign(SECRET, staleTs, body),
      'x-slack-request-timestamp': staleTs,
    },
  });
  assert.equal(out.status, 401);
}

// ── no signing secret configured → fail closed 401 ──
{
  const body = formBody(payload(`seo_approve:${RUN}`));
  const sb = makeSupabase({ seo_runs: [{ id: RUN, status: 'pending_approval' }] });
  const out = await handleSlackInteraction({
    supabase: sb, alertStore, config: { signingSecret: '' }, nowMs,
    rawBody: body,
    headers: { 'x-slack-signature': sign(SECRET, ts, body), 'x-slack-request-timestamp': ts },
  });
  assert.equal(out.status, 401);
  assert.equal(sb.tables.get('seo_runs')[0].status, 'pending_approval');
}

// ── non-allowlisted / malformed action → 400, no DB touch ──
for (const bad of ['seo_delete:abc', 'seo_approve:%%%', 'totally-unknown']) {
  const body = formBody(payload(bad));
  const sb = makeSupabase({ seo_runs: [{ id: RUN, status: 'pending_approval' }] });
  const out = await handleSlackInteraction({
    supabase: sb, alertStore, config: { signingSecret: SECRET }, nowMs,
    rawBody: body,
    headers: { 'x-slack-signature': sign(SECRET, ts, body), 'x-slack-request-timestamp': ts },
  });
  assert.equal(out.status, 400, `expected 400 for ${bad}`);
  assert.equal(sb.tables.get('seo_runs')[0].status, 'pending_approval');
}

// ── dismiss via Slack → shared dismissAction runs ──
{
  const body = formBody(payload(`seo_dismiss:${TASK}`));
  const sb = makeSupabase({ website_tasks: [{ id: TASK, run_id: RUN, status: 'error', title: 'Fix meta' }] });
  const out = await handleSlackInteraction({
    supabase: sb, alertStore, config: { signingSecret: SECRET }, nowMs,
    rawBody: body,
    headers: { 'x-slack-signature': sign(SECRET, ts, body), 'x-slack-request-timestamp': ts },
  });
  assert.equal(out.status, 200);
  assert.ok(out.body.text.includes('Task skipped.'));
  assert.equal(sb.tables.get('website_tasks')[0].status, 'skipped');
}

// ── action not found → 404, no crash ──
{
  const body = formBody(payload(`seo_approve:${TASK}`));
  const sb = makeSupabase({ seo_runs: [{ id: RUN, status: 'done' }] });
  const out = await handleSlackInteraction({
    supabase: sb, alertStore, config: { signingSecret: SECRET }, nowMs,
    rawBody: body,
    headers: { 'x-slack-signature': sign(SECRET, ts, body), 'x-slack-request-timestamp': ts },
  });
  assert.equal(out.status, 404);
}

fs.rmSync(tmpStore, { force: true });
console.log('ok slack-interactions');
