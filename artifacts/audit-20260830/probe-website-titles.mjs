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

const { data: runs } = await supabase
  .from('seo_runs')
  .select('id, week_of')
  .order('week_of', { ascending: false })
  .limit(12);
const weekOf = Object.fromEntries((runs || []).map((r) => [r.id, r.week_of]));

const { data: tasks } = await supabase
  .from('website_tasks')
  .select('id, run_id, status, priority, type, title, created_at, details')
  .in('status', ['pending_approval', 'waiting_on_owner', 'error', 'failed'])
  .order('created_at', { ascending: false })
  .limit(400);

function bucketTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/gbp claim|unclaimed flag/.test(t)) return 'gbp_claim';
  if (/stat counter|homepage.*0\+|placeholder/.test(t)) return 'homepage_stats';
  if (/24\/7|emergency staffing/.test(t)) return 'emergency_staffing';
  if (/weekly blog|publish weekly blog|mandatory weekly/.test(t)) return 'weekly_blog';
  if (/research gap|owner confirmation|owner:|owner confirm/.test(t)) return 'research_gap_owner';
  if (/contact.*404/.test(t)) return 'contact_404';
  if (/federal incentive|tax cred/.test(t)) return 'federal_incentives';
  if (/commercial work percentage/.test(t)) return 'commercial_pct';
  if (/claim id collision/.test(t)) return 'claim_id_collision';
  return 'other';
}

const rows = (tasks || []).map((t) => ({
  week_of: weekOf[t.run_id] || null,
  status: t.status,
  priority: t.priority,
  type: t.type,
  platform: t.details?.platform || null,
  executable_if_approved: t.details?.platform === 'website' && t.status === 'pending_approval',
  topic: bucketTitle(t.title),
  title: String(t.title || '').replace(/\s+/g, ' ').slice(0, 100),
}));

const topicCounts = {};
for (const r of rows) {
  topicCounts[r.topic] = (topicCounts[r.topic] || 0) + 1;
}

const latestWeek = runs?.[0]?.week_of;
const thisWeek = rows.filter((r) => r.week_of === latestWeek);
const priorOpen = rows.filter((r) => r.week_of !== latestWeek);

console.log(JSON.stringify({
  open_count: rows.length,
  topic_counts: topicCounts,
  this_week: { week_of: latestWeek, count: thisWeek.length, rows: thisWeek },
  prior_open_by_week: priorOpen.reduce((acc, r) => {
    acc[r.week_of || 'none'] = (acc[r.week_of || 'none'] || 0) + 1;
    return acc;
  }, {}),
  prior_open_topics: priorOpen.reduce((acc, r) => {
    acc[r.topic] = (acc[r.topic] || 0) + 1;
    return acc;
  }, {}),
  prior_pending_sample: priorOpen.filter((r) => r.status === 'pending_approval').slice(0, 15),
}, null, 2));
