/**
 * One-shot: reset errored/overdue GBP posts back to 'scheduled' so the daily cron retries them.
 * Usage: node scripts/reset-gbp-scheduled.mjs 2026-06-15 2026-06-16
 */
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

const dates = process.argv.slice(2);
if (!dates.length) {
  console.error('Usage: node reset-gbp-scheduled.mjs <date1> [date2] ...');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from('weekly_posts')
  .update({ status: 'scheduled', error: null })
  .in('post_date', dates)
  .eq('platform', 'gbp')
  .select('id, post_date, status');

if (error) {
  console.error('Supabase error:', error.message);
  process.exit(1);
}

console.log(`Reset ${data.length} row(s):`);
for (const row of data) {
  console.log(`  ${row.post_date} — ${row.topic} → ${row.status}`);
}
