// scripts/lib/website-task-runner.test.mjs
import assert from 'node:assert/strict';
import {
  sortWebsiteTasks,
  executeNextWebsiteTask,
  sweepOrphanWebsiteTasks,
} from './website-task-runner.mjs';

// ── sortWebsiteTasks: priority order, created_at tie-break ──
{
  const sorted = sortWebsiteTasks([
    { id: 'a', priority: 'low', created_at: '2026-07-01' },
    { id: 'b', priority: 'critical', created_at: '2026-07-02' },
    { id: 'c', priority: 'high', created_at: '2026-07-03' },
    { id: 'd', priority: 'high', created_at: '2026-07-01' },
    { id: 'e', priority: 'bogus', created_at: '2026-07-01' },
  ]);
  assert.deepEqual(sorted.map(t => t.id), ['b', 'd', 'c', 'a', 'e']);
  console.log('ok sortWebsiteTasks');
}

// Chainable Supabase stub. `tables` maps table name → rows returned by the
// select chain (thenable at any point). update() records { table, vals } and
// returns a chain that answers .maybeSingle() with `claimRow` on the first
// claim (status:'executing') and is awaitable at .eq() for result updates.
function makeSupabaseStub({ tables = {}, claimRow = 'first' } = {}) {
  const updates = [];
  const from = (table) => {
    const rows = tables[table] || [];
    const selectChain = {
      select: () => selectChain,
      eq: () => selectChain,
      in: () => selectChain,
      or: () => selectChain,
      order: () => selectChain,
      then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
    };
    return {
      ...selectChain,
      update: (vals) => {
        updates.push({ table, vals });
        const isClaim = vals.status === 'executing';
        const chain = {
          eq: () => chain,
          select: () => chain,
          maybeSingle: async () => ({
            data: isClaim ? (claimRow === 'first' ? rows[0] || null : claimRow) : null,
            error: null,
          }),
          then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej),
        };
        return chain;
      },
    };
  };
  return { supabase: { from }, updates };
}

const baseDeps = { log: async () => {}, seoAgentsExe: 'C:/fake/seo-agents.exe', projectRoot: process.cwd() };

// ── executeNextWebsiteTask: pushed result → claim + done, one task only ──
{
  const tasks = [
    { id: 't1', run_id: 'r1', priority: 'high', created_at: '2026-07-01', title: 'Fix FAQ', description: 'Add FAQ', details: { website_action_type: 'website_faq_update' } },
    { id: 't2', run_id: 'r1', priority: 'low', created_at: '2026-07-01', title: 'Other', description: 'x', details: {} },
  ];
  const { supabase, updates } = makeSupabaseStub({ tables: { website_tasks: [tasks[0]] } });
  const calls = [];
  const execFileAsync = async (exe, args) => {
    calls.push({ exe, args });
    return { stdout: 'noise\n{"status":"pushed","url":"https://x"}' };
  };

  const claimedId = await executeNextWebsiteTask(tasks, { ...baseDeps, supabase, execFileAsync });

  assert.equal(claimedId, 't1');
  assert.equal(calls.length, 1, 'exactly one task executed per call');
  assert.deepEqual(calls[0].args, ['website', '"Fix FAQ. Add FAQ"', '--type', 'website_faq_update', '--live']);
  assert.equal(updates[0].vals.status, 'executing');
  const done = updates.find(u => u.vals.status === 'done');
  assert.ok(done, 'task marked done');
  assert.equal(done.vals.details.result.status, 'pushed');
  console.log('ok executeNextWebsiteTask pushed');
}

// ── executeNextWebsiteTask: non-pushed result → status error, mapped message ──
{
  const task = { id: 't1', run_id: 'r1', priority: 'high', created_at: '2026-07-01', title: 'T', description: 'D', details: {} };
  const { supabase, updates } = makeSupabaseStub({ tables: { website_tasks: [task] } });
  const execFileAsync = async () => ({ stdout: '{"status":"validation_failed","message":"bad html"}' });

  await executeNextWebsiteTask([task], { ...baseDeps, supabase, execFileAsync });

  const err = updates.find(u => u.vals.status === 'error');
  assert.ok(err, 'task marked error');
  assert.deepEqual(err.vals.details.result, { status: 'validation_failed', message: 'bad html' });
  console.log('ok executeNextWebsiteTask non-pushed');
}

// ── executeNextWebsiteTask: subprocess throw → never stuck in executing ──
{
  const task = { id: 't1', run_id: 'r1', priority: 'high', created_at: '2026-07-01', title: 'T', description: 'D', details: {} };
  const { supabase, updates } = makeSupabaseStub({ tables: { website_tasks: [task] } });
  const execFileAsync = async () => { throw new Error('boom'); };

  await executeNextWebsiteTask([task], { ...baseDeps, supabase, execFileAsync });

  const err = updates.find(u => u.vals.status === 'error');
  assert.ok(err, 'task marked error after throw');
  assert.equal(err.vals.details.result.message, 'boom');
  console.log('ok executeNextWebsiteTask throw');
}

// ── executeNextWebsiteTask: claim lost (another worker) → no execution ──
{
  const task = { id: 't1', run_id: 'r1', priority: 'high', created_at: '2026-07-01', title: 'T', description: 'D', details: {} };
  const { supabase } = makeSupabaseStub({ tables: { website_tasks: [] }, claimRow: null });
  let ran = false;
  const execFileAsync = async () => { ran = true; return { stdout: '{"status":"pushed"}' }; };

  const claimedId = await executeNextWebsiteTask([task], { ...baseDeps, supabase, execFileAsync });

  assert.equal(claimedId, null);
  assert.equal(ran, false, 'lost claim must not execute');
  console.log('ok executeNextWebsiteTask lost claim');
}

// ── sweepOrphanWebsiteTasks: only tasks with settled runs execute ──
{
  const orphan = { id: 'orphan', run_id: 'r-done', priority: 'high', created_at: '2026-07-01', title: 'Orphan', description: 'D', details: { platform: 'website' } };
  const inFlight = { id: 'live', run_id: 'r-approved', priority: 'critical', created_at: '2026-07-01', title: 'Live', description: 'D', details: { platform: 'website' } };
  const { supabase, updates } = makeSupabaseStub({
    tables: {
      website_tasks: [orphan, inFlight],
      seo_runs: [{ id: 'r-done', status: 'done' }, { id: 'r-approved', status: 'approved' }],
    },
    claimRow: orphan,
  });
  const calls = [];
  const execFileAsync = async (exe, args) => { calls.push(args); return { stdout: '{"status":"pushed"}' }; };

  const claimedId = await sweepOrphanWebsiteTasks({ ...baseDeps, supabase, execFileAsync });

  assert.equal(claimedId, 'orphan', 'sweep picks the task whose run is done, not the in-flight one');
  assert.equal(calls.length, 1);
  assert.equal(updates[0].table, 'website_tasks');
  console.log('ok sweepOrphanWebsiteTasks settled-run gate');
}

// ── sweepOrphanWebsiteTasks: nothing eligible → no claims ──
{
  const inFlight = { id: 'live', run_id: 'r-approved', priority: 'high', created_at: '2026-07-01', title: 'Live', description: 'D', details: {} };
  const { supabase, updates } = makeSupabaseStub({
    tables: { website_tasks: [inFlight], seo_runs: [{ id: 'r-approved', status: 'approved' }] },
  });
  const execFileAsync = async () => { throw new Error('must not run'); };

  const claimedId = await sweepOrphanWebsiteTasks({ ...baseDeps, supabase, execFileAsync });

  assert.equal(claimedId, null);
  assert.equal(updates.length, 0, 'no claim attempted when every run is in-flight');
  console.log('ok sweepOrphanWebsiteTasks no-op');
}

console.log('ok website-task-runner');
