#!/usr/bin/env node
// Skip prior-week website_tasks still sitting at pending_approval.
// Keeps the latest run's pending rows (this week: Fix /contact/ 404).
// Does not touch waiting_on_owner. Auto-approve stays posts-only.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { shouldSkipStaleWebsitePending } from '../../scripts/lib/parse-website-tasks.mjs';

const envPath = 'C:\\Workspace\\Active\\SEO-Agents-App\\.env';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

const { data: runs, error: runsErr } = await supabase
  .from('seo_runs')
  .select('id, week_of, status')
  .order('week_of', { ascending: false })
  .limit(1);
if (runsErr) throw new Error(runsErr.message);
const latest = runs?.[0];
if (!latest) throw new Error('no seo_runs');
console.log(`latest run week_of=${latest.week_of} status=${latest.status} id=${String(latest.id).slice(0, 8)}`);

const { data: tasks, error: tasksErr } = await supabase
  .from('website_tasks')
  .select('id, run_id, status, title, priority')
  .eq('status', 'pending_approval');
if (tasksErr) throw new Error(tasksErr.message);

const stale = (tasks || []).filter((t) => shouldSkipStaleWebsitePending(t, { latestRunId: latest.id }));
const keep = (tasks || []).filter((t) => !shouldSkipStaleWebsitePending(t, { latestRunId: latest.id }));
console.log(`pending_approval=${(tasks || []).length} stale=${stale.length} keep=${keep.length}`);
for (const t of keep) {
  console.log(`KEEP ${t.priority || ''} ${String(t.title || '').slice(0, 90)}`);
}

if (!stale.length) {
  console.log('nothing to skip');
  process.exit(0);
}

const ids = stale.map((t) => t.id);
const { error: updErr } = await supabase
  .from('website_tasks')
  .update({
    status: 'skipped',
    error: 'prior-week pending backlog — skipped 2026-08-30 drain',
  })
  .in('id', ids)
  .eq('status', 'pending_approval');
if (updErr) throw new Error(updErr.message);
console.log(`skipped ${ids.length} prior-week pending_approval website task(s)`);
