// scripts/lib/website-task-runner.mjs
// Single source of truth for approved-website-task execution, shared by
// mav-bridge's run-scoped path (executeApprovedRun §3) and the poll-loop
// orphan sweep (tasks approved in MCC after their run already settled).
//
// deps: { supabase, log, execFileAsync, seoAgentsExe, projectRoot }

import { isWebsiteTaskExecutable } from './parse-website-tasks.mjs';

export const PRIORITY_MAP = { critical: 0, high: 1, medium: 2, low: 3 };
export { isWebsiteTaskExecutable };

// Only tasks classified for the website executor are auto-run. supabase-sync
// stamps details.platform on every task (CONTRACT in supabase-sync.mjs);
// null covers legacy rows that predate classification. `->>` (text) is
// required here: `->` makes PostgREST parse the comparison value as JSON and
// the bare word `website` fails with "invalid input syntax for type json".
// The previous filter (`.is('details->platform', null)` ANDed with
// `.or('details->platform.eq.website')`) hit exactly that — the query errored
// on every poll and the ignored error read as "no tasks".
const PLATFORM_FILTER = 'details->>platform.is.null,details->>platform.eq.website';

export function sortWebsiteTasks(tasks) {
  // Priority (critical→low), tie-break oldest created_at first. DB-side
  // .order('priority') is alphabetical on the text column, so sort here.
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_MAP[a.priority] ?? 4;
    const pb = PRIORITY_MAP[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    return new Date(a.created_at) < new Date(b.created_at) ? -1 : 1;
  });
}

export function fetchApprovedWebsiteTasks(supabase, { runId } = {}) {
  let q = supabase
    .from('website_tasks')
    .select('*')
    .eq('status', 'approved')
    .or(PLATFORM_FILTER)
    .order('priority');
  if (runId) q = q.eq('run_id', runId);
  return q;
}

// The CLI prints its real failure to STDOUT ("❌ Website Manager crew
// failed: ..."), while execFile errors carry only stderr in e.message —
// during the 2026-08-01 live test that left tasks stored as an opaque
// "exit code 1". Surface the last ❌ line, or failing that the stdout tail.
function describeExecError(e) {
  const stdout = (e.stdout || '').trim();
  if (!stdout) return e.message;
  const failLines = stdout.split(/\r?\n/).filter(l => l.trimStart().startsWith('❌'));
  const detail = failLines.length ? failLines[failLines.length - 1].trim() : stdout.slice(-500);
  return `${e.message} — stdout: ${detail}`;
}

// Claim and execute at most ONE task per call via compare-and-swap, so a poll
// cycle never runs two 20-minute website builds back to back. Returns the
// claimed task id, or null if nothing was claimed.
export async function executeNextWebsiteTask(tasks, deps) {
  const { supabase, log, execFileAsync, seoAgentsExe, projectRoot } = deps;

  for (const task of sortWebsiteTasks(tasks)) {
    const runId = task.run_id || null;

    // Hard gate: never live-execute owner-wait / blocked / format-instruction garbage.
    // Tasks from fetchApprovedWebsiteTasks are approved; default status for the gate.
    const gateTask = { ...task, status: task.status || 'approved' };
    if (!isWebsiteTaskExecutable(gateTask)) {
      await log(
        runId,
        'website',
        'info',
        `Skipping non-executable website task ${task.id}: status=${task.status} queue_status=${task.details?.queue_status || ''} title=${String(task.title || '').slice(0, 80)}`,
      );
      // If wrongly approved while still owner-wait, park so the poll does not loop.
      if (String(gateTask.status).toLowerCase() === 'approved') {
        const qs = task.details?.queue_status || 'waiting_on_owner';
        await supabase
          .from('website_tasks')
          .update({
            status: 'waiting_on_owner',
            details: {
              ...task.details,
              execution_blocked: true,
              execution_blocked_reason: `queue_status=${qs}`,
            },
          })
          .eq('id', task.id)
          .eq('status', 'approved');
      }
      continue;
    }

    const { data: claimed, error: claimErr } = await supabase
      .from('website_tasks')
      .update({ status: 'executing' })
      .eq('id', task.id)
      .eq('status', 'approved')
      .select('*')
      .maybeSingle();

    if (claimErr) {
      await log(runId, 'website', 'error', `Claim failed: ${claimErr.message}`);
      return null;
    }
    if (!claimed) {
      // Another worker took it — skip this cycle
      return null;
    }

    await log(runId, 'website', 'info', `Claimed task ${task.id}: ${task.title}`);

    const actionType = task.details?.website_action_type || 'website_copy_update';
    const command = `seo-agents website "${task.title}. ${task.description}" --type ${actionType} --live`;

    try {
      await log(runId, 'website', 'info', `Executing: ${command}`);
      const { stdout } = await execFileAsync(seoAgentsExe, [
        'website',
        `"${task.title}. ${task.description}"`,
        '--type', actionType,
        '--live',
      ], { cwd: projectRoot, timeout: 20 * 60 * 1000, encoding: 'utf8', windowsHide: true });

      // Parse the last JSON object on stdout
      const output = (stdout || '').trim();
      const jsonMatch = output.match(/({\s*[\s\S]*?})\s*$/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[1]);
        if (result.status === 'pushed') {
          await supabase
            .from('website_tasks')
            .update({
              status: 'done',
              details: { ...task.details, result },
              completed_at: new Date().toISOString(),
            })
            .eq('id', task.id);
          await log(runId, 'website', 'info', `Task done: ${task.title}`);
        } else {
          const statusMap = { preview: 'preview', validation_failed: 'validation_failed', error: 'error', push_failed: 'push_failed' };
          const errStatus = statusMap[result.status] || result.status;
          await supabase
            .from('website_tasks')
            .update({
              status: 'error',
              details: { ...task.details, result: { status: errStatus, message: result.message || result.status } },
            })
            .eq('id', task.id);
          await log(runId, 'website', 'warn', `Task failed: ${task.title} — ${result.status}`);
        }
      } else {
        throw new Error('No JSON result found in stdout');
      }
    } catch (e) {
      // Never leave a task stuck in 'executing'
      const message = describeExecError(e);
      await supabase
        .from('website_tasks')
        .update({
          status: 'error',
          details: { ...task.details, result: { status: 'error', message } },
        })
        .eq('id', task.id);
      await log(runId, 'website', 'error', `Task error: ${task.title} — ${message}`);
    }
    // Only process one task per cycle
    return task.id;
  }
  return null;
}

// Poll-loop pass for tasks the run-scoped path can never see: executeApprovedRun
// only fires while the parent seo_run is 'approved', so a task approved after
// the run settled ('done'/'error') would otherwise sit in 'approved' forever
// (2026-07-31: run bc9f900f, week 2026-08-03 — tasks approved post-run never
// executed). Tasks whose run is still in-flight ('approved'/'executing'/
// 'awaiting_prompt') are left alone — executeApprovedRun owns those; the CAS
// claim in executeNextWebsiteTask makes an overlap harmless anyway.
export async function sweepOrphanWebsiteTasks(deps) {
  const { supabase, log } = deps;

  const { data: tasks, error: tasksErr } = await fetchApprovedWebsiteTasks(supabase);
  if (tasksErr) {
    await log(null, 'website', 'error', `Orphan sweep task query failed: ${tasksErr.message}`);
    return null;
  }
  if (!tasks?.length) return null;

  const runIds = [...new Set(tasks.map(t => t.run_id).filter(Boolean))];
  let settledRuns = new Set();
  if (runIds.length) {
    const { data: runs, error: runsErr } = await supabase
      .from('seo_runs')
      .select('id,status')
      .in('id', runIds);
    if (runsErr) {
      await log(null, 'website', 'error', `Orphan sweep run query failed: ${runsErr.message}`);
      return null;
    }
    settledRuns = new Set((runs || [])
      .filter(r => ['done', 'error'].includes(r.status))
      .map(r => r.id));
  }

  // No run_id ⇒ nothing else will ever execute it — treat as orphaned.
  const eligible = tasks.filter(t => !t.run_id || settledRuns.has(t.run_id));
  if (!eligible.length) return null;

  return executeNextWebsiteTask(eligible, deps);
}
