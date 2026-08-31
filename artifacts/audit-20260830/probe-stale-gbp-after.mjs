import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const envPath = 'C:\\Workspace\\Active\\SEO-Agents-App\\.env';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const dates = ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-19', '2026-08-20', '2026-08-29'];
const { data, error } = await supabase
  .from('weekly_posts')
  .select('post_date,status,posted_at,platform_post_id,error,service')
  .eq('platform', 'gbp')
  .in('post_date', dates)
  .order('post_date');
if (error) throw new Error(error.message);
for (const row of data || []) {
  console.log(JSON.stringify({
    post_date: row.post_date,
    status: row.status,
    has_id: Boolean(row.platform_post_id),
    id_kind: row.platform_post_id ? (/^https?:/.test(row.platform_post_id) ? 'url' : String(row.platform_post_id).slice(0, 40)) : null,
    service: String(row.service || '').slice(0, 40),
    error: row.error ? String(row.error).slice(0, 80) : null,
  }));
}
void path;
void fileURLToPath;
