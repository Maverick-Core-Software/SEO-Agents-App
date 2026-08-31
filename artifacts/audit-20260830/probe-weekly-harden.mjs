import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../marketing-control/.env');
const env = {};
for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
}
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

function clip(v, n = 90) {
  return String(v || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim().slice(0, n);
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const k = keyFn(row);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function titleKey(title) {
  return clip(title, 80).toLowerCase();
}

const { data: runs, error: runsErr } = await supabase
  .from('seo_runs')
  .select('id, week_of, status, error, created_at, approved_at, done_at, updated_at')
  .order('week_of', { ascending: false })
  .limit(12);
if (runsErr) throw new Error(`seo_runs: ${runsErr.message}`);

const runIds = (runs || []).map((r) => r.id);
const { data: posts, error: postsErr } = await supabase
  .from('weekly_posts')
  .select('id, run_id, platform, day, post_date, status, media_status, type, error, posted_at, platform_post_id, service, hook, updated_at')
  .in('run_id', runIds)
  .order('post_date');
if (postsErr) throw new Error(`weekly_posts: ${postsErr.message}`);

const { data: gbpOpen, error: gbpErr } = await supabase
  .from('weekly_posts')
  .select('id, run_id, platform, day, post_date, status, error, posted_at, platform_post_id, service, updated_at')
  .eq('platform', 'gbp')
  .in('status', ['error', 'needs_verification', 'posting'])
  .order('post_date', { ascending: false })
  .limit(40);
if (gbpErr) throw new Error(`gbp open: ${gbpErr.message}`);

const { data: tasks, error: tasksErr } = await supabase
  .from('website_tasks')
  .select('id, run_id, status, priority, type, title, error, created_at, updated_at, completed_at, details')
  .order('created_at', { ascending: false })
  .limit(400);
if (tasksErr) throw new Error(`website_tasks: ${tasksErr.message}`);

const { count: logsCount } = await supabase
  .from('run_logs')
  .select('id', { count: 'exact', head: true });

const postsByRun = {};
for (const p of posts || []) {
  (postsByRun[p.run_id] ||= []).push(p);
}

const runSummaries = (runs || []).map((r) => {
  const rp = postsByRun[r.id] || [];
  return {
    week_of: r.week_of,
    frozen: r.status,
    created_at: r.created_at,
    done_at: r.done_at,
    error: r.error ? clip(r.error, 120) : null,
    posts: rp.length,
    post_status: countBy(rp, (p) => `${p.platform}:${p.status}`),
    date_span: rp.length
      ? `${rp.map((p) => p.post_date).sort()[0]}..${rp.map((p) => p.post_date).sort().at(-1)}`
      : null,
  };
});

const gbpErrorRows = (gbpOpen || []).map((p) => ({
  post_date: p.post_date,
  status: p.status,
  posted_at: p.posted_at,
  has_id: Boolean(p.platform_post_id),
  id_kind: p.platform_post_id
    ? (/^https?:/.test(p.platform_post_id) ? 'url' : clip(p.platform_post_id, 40))
    : null,
  service: clip(p.service, 50),
  error: p.error ? clip(p.error, 140) : null,
  updated_at: p.updated_at,
  week_of: (runs || []).find((r) => r.id === p.run_id)?.week_of || null,
  false_fail_candidate: Boolean(p.posted_at) || Boolean(p.platform_post_id),
}));

const recessed = (posts || [])
  .filter((p) => p.platform === 'gbp' && /recessed/i.test(String(p.service || p.hook || '')))
  .map((p) => ({
    post_date: p.post_date,
    status: p.status,
    posted_at: p.posted_at,
    has_id: Boolean(p.platform_post_id),
    platform_post_id: p.platform_post_id ? clip(p.platform_post_id, 80) : null,
    service: clip(p.service, 50),
    error: p.error ? clip(p.error, 140) : null,
    hook: clip(p.hook, 80),
  }));

const taskStatus = countBy(tasks || [], (t) => t.status || 'null');
const taskType = countBy(tasks || [], (t) => t.type || 'null');
const taskPriority = countBy(tasks || [], (t) => t.priority || 'null');
const taskPlatform = countBy(tasks || [], (t) => t.details?.platform || 'unset');
const taskByRun = countBy(tasks || [], (t) => {
  const week = (runs || []).find((r) => r.id === t.run_id)?.week_of || 'no-run';
  return `${week}:${t.status}`;
});

const pending = (tasks || []).filter((t) => t.status === 'pending_approval');
const ownerWait = (tasks || []).filter((t) => t.status === 'waiting_on_owner');
const taskErrors = (tasks || []).filter((t) => ['error', 'failed'].includes(t.status));

const pendingDupes = {};
for (const t of pending) {
  const k = titleKey(t.title);
  pendingDupes[k] = (pendingDupes[k] || 0) + 1;
}
const dupeTitles = Object.entries(pendingDupes)
  .filter(([, n]) => n > 1)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .map(([title, n]) => ({ n, title }));

const researchGapish = (tasks || []).filter((t) =>
  /research.?gap|owner confirm|waiting_on_owner|homepage stats|gbp claim|weekly blog/i.test(
    `${t.title} ${t.type} ${t.status} ${JSON.stringify(t.details || {})}`,
  ),
);

function summarizeTask(t) {
  return {
    status: t.status,
    priority: t.priority,
    type: t.type,
    platform: t.details?.platform || null,
    action: t.details?.website_action_type || null,
    week_of: (runs || []).find((r) => r.id === t.run_id)?.week_of || null,
    created_at: String(t.created_at || '').slice(0, 10),
    title: clip(t.title, 90),
    error: t.error ? clip(t.error, 120) : (t.details?.result?.message ? clip(t.details.result.message, 120) : null),
  };
}

const out = {
  probed_at: new Date().toISOString(),
  run_logs_count: logsCount ?? null,
  seo_runs: runSummaries,
  gbp_open: {
    count: gbpErrorRows.length,
    false_fail_candidates: gbpErrorRows.filter((r) => r.false_fail_candidate).length,
    rows: gbpErrorRows,
  },
  recessed_lighting: recessed,
  latest_run_posts: ((postsByRun[runs?.[0]?.id]) || []).map((p) => ({
    platform: p.platform,
    day: p.day,
    post_date: p.post_date,
    status: p.status,
    posted_at: p.posted_at,
    has_id: Boolean(p.platform_post_id),
    service: clip(p.service, 40),
    error: p.error ? clip(p.error, 120) : null,
  })),
  website_tasks: {
    fetched: (tasks || []).length,
    by_status: taskStatus,
    by_type: taskType,
    by_priority: taskPriority,
    by_platform: taskPlatform,
    by_run_status: taskByRun,
    pending_dupes: dupeTitles,
    pending_sample: pending.slice(0, 25).map(summarizeTask),
    owner_wait: ownerWait.map(summarizeTask),
    errors: taskErrors.map(summarizeTask),
    research_gapish_count: researchGapish.length,
    research_gapish: researchGapish.slice(0, 20).map(summarizeTask),
  },
};

console.log(JSON.stringify(out, null, 2));
