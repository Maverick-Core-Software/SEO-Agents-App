/**
 * One-shot: mark errored Facebook posts as 'posted' for dates where posting actually succeeded.
 * Use when a run left stale error rows in weekly_posts but the posts did go live.
 * Usage: node scripts/reset-facebook-posted.mjs 2026-06-15 2026-06-16 2026-06-17
 */
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

const dates = process.argv.slice(2);
if (!dates.length) {
  console.error('Usage: node reset-facebook-posted.mjs <date1> [date2] ...');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data, error } = await supabase
  .from('weekly_posts')
  .update({ status: 'posted', error: null })
  .in('post_date', dates)
  .eq('platform', 'facebook')
  .eq('status', 'error')
  .select('id, post_date, status');

if (error) {
  console.error('Supabase error:', error.message);
  process.exit(1);
}

console.log(`Updated ${data.length} row(s):`);
for (const row of data) {
  console.log(`  ${row.post_date} → ${row.status}`);
}
