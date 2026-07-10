// scripts/lib/gbp-runner.mjs
// Single source of truth for GBP curation + posting logic, shared by mav-bridge
// (legacy/rollback path) and gbp-worker (the user-session owner).
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

// Excel cells store dates as Date objects, serial numbers, or strings depending
// on how the workbook was written. Normalise all three to an ISO yyyy-mm-dd.
export function excelDateToIso(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = xlsx.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  return String(value || '').slice(0, 10);
}

// The driver prints a JSON result as the last stdout line. Pull it out; tolerate noise.
export function parseDriverJson(stdout) {
  try {
    const lastLine = (stdout || '').trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    return lastLine ? JSON.parse(lastLine) : {};
  } catch {
    return {};
  }
}

export function gbpNeedsVerificationMessage(parsed = {}) {
  const attempts = parsed.verificationAttempts || 5;
  const snapshot = parsed.verificationSnapshot?.textFile || parsed.verificationSnapshot?.screenshot || '';
  const suffix = snapshot ? ` Snapshot: ${snapshot}` : '';
  return `GBP post was submitted but not verified after ${attempts} 60-second snapshot checks. Check manually before retrying.${suffix}`;
}

// Map a driver exit code to the weekly_posts update intent. `archive: true` means
// the caller should also run markGbpPostedAndArchive. Exit codes (driver.mjs):
//   0 = posted+verified, 3 = submitted-unverified, 4 = approval-gate-unset, else = error.
export function gbpDailyStatusForExit(exitCode, parsed = {}) {
  if (exitCode === 0) {
    return { status: 'posted', error: null, archive: true, platform_post_id: parsed.postUrl || null };
  }
  if (exitCode === 3) {
    return { status: 'needs_verification', error: gbpNeedsVerificationMessage(parsed), archive: false, platform_post_id: null };
  }
  if (exitCode === 4) {
    return { status: 'pending_approval', error: null, archive: false, platform_post_id: null };
  }
  return { status: 'error', error: null, archive: false, platform_post_id: null };
}

// Derive the Central-time (DST-aware) date + hour from a UTC instant. Used to gate
// the daily poster to once per calendar day after 9am Central.
export function centralDateHour(nowUtc) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(nowUtc);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const todayDate = `${get('year')}-${get('month')}-${get('day')}`;
  let cstHour = parseInt(get('hour'), 10);
  if (cstHour === 24) cstHour = 0; // some ICU builds emit 24 at midnight
  return { todayDate, cstHour };
}

// Retry wrapper for Excel file operations. Excel workbooks can be transiently
// locked (open in Excel, or held by another process); retry with a delay instead
// of failing the whole run outright.
async function withExcelRetry(filePath, fn, { maxRetries = 6, delayMs = 5000, log, runId } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLock = /EBUSY|EPERM|locked|sharing violation/i.test(e.message);
      if (!isLock || attempt === maxRetries) throw e;
      if (log) await log(runId, 'gbp', 'warn', `Excel file locked (attempt ${attempt}/${maxRetries}), retrying in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Called only after the driver verifies the post (exit 0): set Posted=TRUE in the
// Excel workbook and move the photo to the dated archive folder. deps: { env, log }.
export async function markGbpPostedAndArchive({ postDate, exitCode, runId, env, log }) {
  if (exitCode !== 0) return;
  const GBP_WORKBOOK_PATH = env.GBP_WORKBOOK_PATH || '';
  const GBP_ARCHIVE_FOLDER = env.GBP_ARCHIVE_FOLDER || 'M:\\backups\\gbp-archive';
  if (!GBP_WORKBOOK_PATH) { await log(runId, 'gbp', 'info', 'GBP_WORKBOOK_PATH not set — skipping Excel update'); return; }
  if (!fs.existsSync(GBP_WORKBOOK_PATH)) { await log(runId, 'gbp', 'warn', `GBP workbook not found: ${GBP_WORKBOOK_PATH}`); return; }

  try {
    let photoPath = '';
    await withExcelRetry(GBP_WORKBOOK_PATH, async () => {
      const workbook = xlsx.readFile(GBP_WORKBOOK_PATH);
      const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (!rows.length) return;

      const header = rows[0].map(h => String(h).trim());
      const dateCol = header.findIndex(h => h.toLowerCase() === 'date');
      const postedCol = header.findIndex(h => h.toLowerCase() === 'posted');
      const photoCol = header.findIndex(h =>
        h === 'AssetIdOrDescription' || h === 'Related Picture' || h.toLowerCase().includes('asset'));

      if (dateCol === -1) { await log(runId, 'gbp', 'warn', 'GBP workbook: Date column not found'); return; }

      let targetRow = -1;
      for (let i = 1; i < rows.length; i++) {
        if (excelDateToIso(rows[i][dateCol]) === postDate) {
          targetRow = i;
          if (photoCol >= 0) photoPath = String(rows[i][photoCol] || '').trim();
          break;
        }
      }
      if (targetRow === -1) { await log(runId, 'gbp', 'warn', `GBP workbook: no row found for ${postDate}`); return; }

      if (postedCol >= 0) {
        sheet[xlsx.utils.encode_cell({ r: targetRow, c: postedCol })] = { t: 'b', v: true };
        xlsx.writeFile(workbook, GBP_WORKBOOK_PATH);
        await log(runId, 'gbp', 'info', `Excel Posted=TRUE set for ${postDate}`);
      }
    }, { log, runId });

    if (photoPath && fs.existsSync(photoPath)) {
      const monthDir = path.join(GBP_ARCHIVE_FOLDER, postDate.slice(0, 7));
      fs.mkdirSync(monthDir, { recursive: true });
      fs.renameSync(photoPath, path.join(monthDir, path.basename(photoPath)));
      await log(runId, 'gbp', 'info', `Photo archived: ${path.basename(photoPath)} → ${monthDir}`);
    }
  } catch (e) {
    await log(runId, 'gbp', 'warn', `markGbpPostedAndArchive error: ${e.message}`);
  }
}

// Apply a driver result to one weekly_posts row (shared by run + daily paths).
async function applyDriverResult({ supabase, post, result, env, log }) {
  const parsed = parseDriverJson(result.stdout);
  const map = gbpDailyStatusForExit(result.exitCode, parsed);
  const update = { status: map.status, error: map.error };
  if (map.status === 'posted') {
    update.posted_at = new Date().toISOString();
    update.platform_post_id = map.platform_post_id;
  }
  if (map.status === 'error') {
    update.error = (result.stderr || result.error || 'GBP poster failed').slice(0, 300);
  }
  await supabase.from('weekly_posts').update(update).eq('id', post.id);
  if (map.archive) {
    await markGbpPostedAndArchive({ postDate: post.post_date, exitCode: result.exitCode, runId: post.run_id, env, log });
  }
  return map.status;
}

// Run-time GBP for a freshly-approved run: curate photos (H:->E:), sync the Excel
// workbook, stamp the approval gate for all days, post Day 1 immediately, mark
// Days 2-7 scheduled.
// deps: { supabase, runPhase, log, env, projectRoot, paths }
//   paths: { photoPick, gbpPoster, seoAgentsExe }
export async function runGbpForApprovedRun({ runId, gbpPosts, deps }) {
  const { supabase, runPhase, log, env, projectRoot, paths } = deps;

  // 0. Curate (reads H:\, writes E:\, rewrites PHOTO_FILE in the schedule).
  if (fs.existsSync(paths.photoPick)) {
    const r = await runPhase(runId, 'gbp', 'node', [paths.photoPick], projectRoot);
    if (!r.ok) await log(runId, 'gbp', 'warn', `gbp-photo-pick failed (continuing): ${r.error}`);
    else await log(runId, 'gbp', 'info', 'Photo curation complete');
  }

  // 1. Sync schedule -> Excel workbook.
  const sync = await runPhase(runId, 'gbp', paths.seoAgentsExe, ['sync-gbp-schedule'], projectRoot);
  if (!sync.ok) {
    await log(runId, 'gbp', 'error', `sync-gbp-schedule failed: ${sync.error}`);
    await supabase.from('weekly_posts').update({ status: 'error', error: sync.error })
      .eq('run_id', runId).eq('platform', 'gbp').eq('status', 'posting');
    return;
  }

  // 2. Propagate the weekly approval into the workbook gate for ALL days, including
  // Day 1 — sync-gbp-schedule writes "Needs approval" for un-posted rows, so without
  // this the Day-1 driver exits 4 (pending_approval) every time.
  const dateArgs = gbpPosts.map(p => p.post_date).filter(Boolean).flatMap(d => ['--date', d]);
  if (dateArgs.length) {
    const appr = await runPhase(runId, 'gbp', paths.seoAgentsExe, ['mark-gbp-approved', ...dateArgs], projectRoot);
    if (!appr.ok) await log(runId, 'gbp', 'warn', `mark-gbp-approved failed (posts may block on approval gate): ${appr.error}`);
  }

  // 3. Post Day 1 now.
  const day1 = gbpPosts.find(p => p.day === 1);
  if (day1) {
    await log(runId, 'gbp', 'info', 'Posting Day 1 GBP immediately...');
    const r = await runPhase(runId, 'gbp', 'node', [paths.gbpPoster, '--date', day1.post_date], projectRoot);
    const status = await applyDriverResult({ supabase, post: day1, result: r, env, log });
    await log(runId, 'gbp', status === 'posted' ? 'info' : 'warn', `Day 1 GBP → ${status} (exit ${r.exitCode})`);
  }

  // 4. Mark Days 2-7 scheduled (approval already stamped above).
  const later = gbpPosts.filter(p => p.day > 1);
  if (later.length) {
    await supabase.from('weekly_posts').update({ status: 'scheduled' })
      .eq('run_id', runId).eq('platform', 'gbp').gt('day', 1);
    await log(runId, 'gbp', 'info', 'Days 2-7 marked scheduled + approved in workbook');
  }
}

// Daily poster: post today's scheduled GBP rows. Caller gates this to once/day >=9am
// Central using centralDateHour(). deps inline: { supabase, runPhase, log, env, todayDate, gbpPosterPath, projectRoot }
export async function runDailyGbp({ supabase, runPhase, log, env, todayDate, gbpPosterPath, projectRoot }) {
  const { data: todayGbp } = await supabase
    .from('weekly_posts')
    .select('id, run_id, post_date, photo_file')
    .eq('platform', 'gbp')
    .eq('status', 'scheduled')
    .eq('post_date', todayDate)
    .order('post_date', { ascending: true });

  for (const post of todayGbp || []) {
    await log(post.run_id, 'gbp', 'info', `Posting scheduled GBP for ${post.post_date}`);
    const result = await runPhase(post.run_id, 'gbp', 'node', [gbpPosterPath, '--date', post.post_date], projectRoot);
    const status = await applyDriverResult({ supabase, post, result, env, log });
    await log(post.run_id, 'gbp', status === 'error' ? 'error' : 'info', `Daily GBP ${post.post_date} → ${status} (exit ${result.exitCode})`);
  }
}
