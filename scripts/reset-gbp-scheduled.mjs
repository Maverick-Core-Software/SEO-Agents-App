/**
 * Guarded single-row recovery: reset ONE errored GBP post back to 'scheduled'.
 * Usage: node scripts/reset-gbp-scheduled.mjs <YYYY-MM-DD>            (dry run, writes nothing)
 *        node scripts/reset-gbp-scheduled.mjs <YYYY-MM-DD> --apply    (perform the reset)
 * Guards: exactly one date; only rows currently status='error'; refuses unless exactly one
 * row matches; before-image saved to state/ before writing; the update is conditional on
 * id + expected status, so a posted/ambiguous row is never touched.
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dates = args.filter((a) => a !== '--apply');
if (dates.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(dates[0])) {
  console.error('Usage: node reset-gbp-scheduled.mjs <YYYY-MM-DD> [--apply]  (exactly one date)');
  process.exit(1);
}
const [date] = dates;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const { data: rows, error: readErr } = await supabase
  .from('weekly_posts')
  .select('*')
  .eq('post_date', date)
  .eq('platform', 'gbp');
if (readErr) {
  console.error('Supabase read error:', readErr.message);
  process.exit(1);
}

console.log(`${rows.length} gbp row(s) on ${date}:`);
for (const r of rows) console.log(`  id=${r.id} status=${r.status} topic=${r.topic ?? ''}`);

const errored = rows.filter((r) => r.status === 'error');
if (errored.length !== 1) {
  console.error(`Refusing: need exactly one status='error' row, found ${errored.length}. Nothing changed.`);
  process.exit(1);
}
const target = errored[0];
console.log(`Target: id=${target.id} error=${JSON.stringify(target.error ?? null)}`);

if (!apply) {
  console.log('Dry run: nothing written. Re-run with --apply to reset this one row.');
  process.exit(0);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state');
fs.mkdirSync(dir, { recursive: true });
const beforePath = path.join(dir, `gbp-reset-before-${date}-${Date.now()}.json`);
fs.writeFileSync(beforePath, JSON.stringify(target, null, 2));
console.log(`Before-image: ${beforePath}`);

const { data, error } = await supabase
  .from('weekly_posts')
  .update({ status: 'scheduled', error: null })
  .eq('id', target.id)
  .eq('status', 'error')
  .select('id, post_date, status');
if (error) {
  console.error('Supabase update error:', error.message);
  process.exit(1);
}
if (data.length !== 1) {
  console.error(`Expected 1 updated row, got ${data.length}. Verify before retrying.`);
  process.exit(1);
}
console.log(`Reset: id=${data[0].id} ${data[0].post_date} -> ${data[0].status}`);
