import { supabase, isSupabaseAvailable } from '../supabase.js';
import { liveRunStatus, bucketStatusCount } from './status.js';
import { wrapReadOnly, READ_ONLY } from './guard.js';

export { wrapReadOnly, READ_ONLY };

const EMPTY_HEALTH = { run: null, posts: [], live: 'idle', bucket: 'incomplete' };

export function readFrom(table) {
  if (!supabase) throw new Error('NOT_CONFIGURED');
  return wrapReadOnly(supabase.from(table));
}

function queryError(err, fallback) {
  return new Error(String(err?.message || err?.code || fallback).slice(0, 180));
}

async function selectRows(builder, fallback) {
  try {
    const { data, error } = await builder;
    if (error) throw queryError(error, fallback);
    return data || [];
  } catch (err) {
    throw queryError(err, fallback);
  }
}

export async function fetchRuns() {
  if (!isSupabaseAvailable) return [];
  return selectRows(
    readFrom('seo_runs').select('*').order('week_of', { ascending: false }).limit(50),
    'seo_runs query failed',
  );
}

export async function fetchPosts(weekStart, weekEnd) {
  if (!isSupabaseAvailable) return [];
  return selectRows(
    readFrom('weekly_posts')
      .select('*')
      .gte('post_date', weekStart)
      .lte('post_date', weekEnd)
      .order('post_date')
      .order('platform'),
    'weekly_posts query failed',
  );
}

export async function fetchWebsiteTasks() {
  if (!isSupabaseAvailable) return [];
  return selectRows(
    readFrom('website_tasks').select('*').order('created_at', { ascending: false }).limit(200),
    'website_tasks query failed',
  );
}

export async function fetchRunLogs(runId) {
  if (!isSupabaseAvailable) return [];
  let query = readFrom('run_logs').select('*');
  if (runId) query = query.eq('run_id', runId);
  return selectRows(
    query.order('created_at', { ascending: false }).limit(200),
    'run_logs query failed',
  );
}

export async function fetchLatestRunHealth() {
  if (!isSupabaseAvailable) return { ...EMPTY_HEALTH };
  const runs = await selectRows(
    readFrom('seo_runs').select('*').order('week_of', { ascending: false }).limit(1),
    'seo_runs query failed',
  );
  const run = runs[0] || null;
  if (!run) return { ...EMPTY_HEALTH };
  const posts = await selectRows(
    readFrom('weekly_posts').select('*').eq('run_id', run.id),
    'weekly_posts query failed',
  );
  const live = liveRunStatus(run, posts);
  return { run, posts, live, bucket: bucketStatusCount(live) };
}

export async function fetchPostById(id) {
  if (!isSupabaseAvailable || !id) return null;
  const rows = await selectRows(
    readFrom('weekly_posts').select('*').eq('id', id).limit(1),
    'weekly_posts query failed',
  );
  return rows[0] || null;
}

export async function fetchWorkerStatus() {
  const url = import.meta.env?.VITE_SEO_STATUS_URL;
  if (!url) return { ok: false, unreachable: true };
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return { ok: false, unreachable: true };
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: true, unreachable: false, data };
  } catch {
    return { ok: false, unreachable: true };
  }
}
