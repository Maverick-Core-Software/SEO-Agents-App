#!/usr/bin/env node
// Approve a pending_approval seo_run from the CLI (same transition as the MCC
// Approve button / mav-bridge POST /seo/actions/approve). Website tasks are
// left pending_approval.
//   node scripts/approve-run.mjs <run_id>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const runId = process.argv[2];
if (!runId) { console.error('usage: approve-run.mjs <run_id>'); process.exit(2); }
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
const now = new Date().toISOString();
const { data: run, error: runErr } = await supabase.from('seo_runs')
  .update({ status: 'approved', approved_at: now })
  .eq('id', runId).eq('status', 'pending_approval').select().maybeSingle();
if (runErr) { console.error(runErr.message); process.exit(1); }
if (!run) { console.error('Run not found or not pending_approval'); process.exit(1); }
const { data: posts, error: postsErr } = await supabase.from('weekly_posts')
  .update({ status: 'approved', approved_at: now })
  .eq('run_id', runId).eq('status', 'pending_approval').select('id,platform');
if (postsErr) { console.error(postsErr.message); process.exit(1); }
console.log(`Approved run ${runId} (week_of ${run.week_of}); posts approved: ${posts.length} (${posts.filter(p=>p.platform==='facebook').length} fb, ${posts.filter(p=>p.platform==='gbp').length} gbp)`);
