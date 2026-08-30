/**
 * Read-only probe: live week shape vs dashboard queries. Never prints secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../marketing-control/.env');

function loadEnv(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function chicagoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function addDays(isoDate, n) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function sundayOfWeek(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return addDays(isoDate, -dt.getUTCDay());
}

function saturdayOfWeek(isoDate) {
  return addDays(sundayOfWeek(isoDate), 6);
}

function mondayOfWeek(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(isoDate, offset);
}

function statusCounts(rows) {
  const c = {};
  for (const r of rows || []) {
    const s = r.status || '(null)';
    c[s] = (c[s] || 0) + 1;
  }
  return c;
}

const env = loadEnv(envPath);
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log(JSON.stringify({ ok: false, reason: 'missing env' }));
  process.exit(1);
}

const supabase = createClient(url, key);
const today = chicagoToday();
const sunStart = sundayOfWeek(today);
const satEnd = saturdayOfWeek(today);
const monStart = mondayOfWeek(today);
const sunEnd = addDays(monStart, 6);

const { data: runs, error: runErr } = await supabase
  .from('seo_runs')
  .select('id, week_of, status, error, created_at')
  .order('week_of', { ascending: false })
  .limit(8);

const { data: allPosts, error: postErr } = await supabase
  .from('weekly_posts')
  .select('id, run_id, platform, day, post_date, status, media_status, error, posted_at, platform_post_id, type')
  .order('post_date', { ascending: false })
  .limit(400);

const { data: tasks, error: taskErr } = await supabase
  .from('website_tasks')
  .select('id, status, priority, type, error, created_at, title')
  .order('created_at', { ascending: false })
  .limit(200);

const posts = allPosts || [];
const dates = posts.map((p) => p.post_date).filter(Boolean).sort();
const inSunSat = posts.filter((p) => p.post_date >= sunStart && p.post_date <= satEnd);
const inMonSun = posts.filter((p) => p.post_date >= monStart && p.post_date <= sunEnd);
const latestRun = (runs || [])[0] || null;
const latestRunPosts = latestRun ? posts.filter((p) => p.run_id === latestRun.id) : [];
const recovery = (row) => {
  const s = String(row.status || '');
  return s === 'error' || s === 'needs_verification' || (s === 'posting' && !row.posted_at);
};

let worker = { ok: false };
try {
  const res = await fetch(env.VITE_SEO_STATUS_URL || 'http://127.0.0.1:8790/seo/status', { method: 'GET' });
  const data = await res.json();
  worker = {
    http: res.status,
    keys: data && typeof data === 'object' ? Object.keys(data) : [],
    state: data?.state ?? data?.status ?? null,
    runHealth: data?.runHealth ?? null,
    statusCounts: data?.statusCounts ?? null,
  };
} catch (e) {
  worker = { ok: false, error: String(e.message || e).slice(0, 80) };
}

let weekEndpoint = null;
try {
  const res = await fetch('http://127.0.0.1:8790/seo/posts/week', { method: 'GET' });
  const data = await res.json();
  weekEndpoint = {
    http: res.status,
    week_start: data.week_start,
    week_end: data.week_end,
    run_status: data.run_status,
    fb: (data.facebook || []).length,
    gbp: (data.gbp || []).length,
    fb_dates: [...new Set((data.facebook || []).map((p) => p.post_date))].sort(),
    gbp_dates: [...new Set((data.gbp || []).map((p) => p.post_date))].sort(),
    statuses: statusCounts([...(data.facebook || []), ...(data.gbp || [])]),
  };
} catch (e) {
  weekEndpoint = { error: String(e.message || e).slice(0, 80) };
}

const out = {
  today,
  dashboardSundayWeek: { start: sunStart, end: satEnd, postCount: inSunSat.length, statuses: statusCounts(inSunSat) },
  productionMondayWeek: { start: monStart, end: sunEnd, postCount: inMonSun.length, statuses: statusCounts(inMonSun) },
  postDateMin: dates[0] || null,
  postDateMax: dates[dates.length - 1] || null,
  postCount: posts.length,
  postStatuses: statusCounts(posts),
  platforms: statusCounts(posts.map((p) => ({ status: p.platform }))),
  recoveryPosts: posts.filter(recovery).map((p) => ({
    post_date: p.post_date, platform: p.platform, status: p.status, inSundayWeek: p.post_date >= sunStart && p.post_date <= satEnd,
  })),
  runs: (runs || []).map((r) => ({ week_of: r.week_of, status: r.status, error: r.error, created_at: r.created_at })),
  runErr: runErr?.message || null,
  postErr: postErr?.message || null,
  taskErr: taskErr?.message || null,
  latestRunPosts: {
    count: latestRunPosts.length,
    dates: [...new Set(latestRunPosts.map((p) => p.post_date))].sort(),
    statuses: statusCounts(latestRunPosts),
  },
  tasks: {
    count: (tasks || []).length,
    statuses: statusCounts(tasks),
    recovery: (tasks || []).filter(recovery).map((t) => ({
      created_at: String(t.created_at || '').slice(0, 10),
      status: t.status,
      title: String(t.title || '').slice(0, 60),
    })),
  },
  worker,
  weekEndpoint,
};

console.log(JSON.stringify(out, null, 2));
