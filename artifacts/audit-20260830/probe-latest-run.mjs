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

const { data: run } = await supabase
  .from('seo_runs')
  .select('id, week_of, status, error, created_at')
  .order('week_of', { ascending: false })
  .limit(1)
  .maybeSingle();

const { data: posts } = await supabase
  .from('weekly_posts')
  .select('platform, day, post_date, status, media_status, type, error, posted_at, platform_post_id, service')
  .eq('run_id', run.id)
  .order('post_date')
  .order('platform');

const { data: failedTasks } = await supabase
  .from('website_tasks')
  .select('id, status, priority, type, title, error, created_at')
  .in('status', ['error', 'failed', 'waiting_on_owner', 'needs_verification'])
  .order('created_at', { ascending: false })
  .limit(20);

console.log(JSON.stringify({
  run: { week_of: run.week_of, status: run.status, error: run.error },
  posts: (posts || []).map((p) => ({
    platform: p.platform,
    day: p.day,
    post_date: p.post_date,
    status: p.status,
    media: p.media_status,
    type: p.type,
    posted_at: p.posted_at,
    has_id: Boolean(p.platform_post_id),
    error: p.error ? String(p.error).slice(0, 120) : null,
    service: String(p.service || '').replace(/\*/g, '').slice(0, 40),
  })),
  failedTasks: (failedTasks || []).map((t) => ({
    status: t.status,
    priority: t.priority,
    type: t.type,
    created_at: String(t.created_at || '').slice(0, 10),
    title: String(t.title || '').slice(0, 70),
    error: t.error ? String(t.error).slice(0, 120) : null,
  })),
}, null, 2));
