#!/usr/bin/env node
/**
 * supabase-sync.mjs
 * Parses agent output files and syncs them into Supabase.
 * Run automatically after `seo-agents execute` completes.
 *
 * Usage:
 *   node scripts/supabase-sync.mjs [--week-of YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { normalizePhotoFile } from './lib/schedule-text.mjs';
import { sendHermesAlert } from './lib/hermes-alert.mjs';
import { parseWebsiteTasks, stripCodeFence, isDuplicateOwnerWaitTopic } from './lib/parse-website-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const APPROVAL_NOTIFY_STATE = path.join(PROJECT_ROOT, 'state', 'approval-notified.json');
const APPROVAL_NOTIFY_RESULT = path.join(PROJECT_ROOT, 'outputs', 'approval-notify.json');

// Load .env
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// Import-safe: tests import this module for autoApproveRun, so the Supabase
// client and the CLI entrypoint only exist when invoked directly
// (node scripts/supabase-sync.mjs). createClient throws on empty URL, hence the
// conditional.
const invokedDirectly = process.argv[1]
  && fs.realpathSync.native(fileURLToPath(import.meta.url))
    === fs.realpathSync.native(path.resolve(process.argv[1]));

const supabase = invokedDirectly
  ? createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '')
  : null;

const OUTPUTS = path.join(PROJECT_ROOT, 'outputs');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

export function parseFbWeekHeader(text) {
  if (!text) return '';
  const m = String(text).match(/week of\s+(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : '';
}

export function resolveWeekOf({ argv = process.argv.slice(2), fbText = '' } = {}) {
  const idx = argv.indexOf('--week-of');
  const fromArg = (idx !== -1 && argv[idx + 1]) ? argv[idx + 1] : '';
  const fromHeader = parseFbWeekHeader(fbText);
  if (fromArg && fromHeader && fromArg !== fromHeader) {
    throw new Error(`week_of disagree: --week-of ${fromArg} vs FB header ${fromHeader}`);
  }
  const weekOf = fromArg || fromHeader;
  if (!weekOf || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
    throw new Error('week_of required: pass --week-of YYYY-MM-DD or write a "week of YYYY-MM-DD" FB header');
  }
  return weekOf;
}

function getWeekOf() {
  // Clock fallback is gone. Kept as a thin wrapper so older comments/tests
  // that mention getWeekOf still have a name to grep.
  return resolveWeekOf({
    argv: process.argv.slice(2),
    fbText: readFile('facebook_posting_schedule.md') || '',
  });
}

function readFile(filename) {
  const p = path.join(OUTPUTS, filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// ─────────────────────────────────────────────
// Parse facebook_posting_schedule.md
// ─────────────────────────────────────────────

function stripMd(str) {
  // Remove **bold** markers and trim
  return (str || '').replace(/\*\*/g, '').trim();
}

// Field getter tolerant of both executor-model output styles:
// inline `**KEY:** value` and following-line `**KEY:**\nvalue` (value on the
// next line(s), read until the next field header or markdown heading).
// Mirrors parseScheduleText in facebook-poster.mjs.
function makeFieldGetter(block) {
  return key => {
    const m = block.match(new RegExp(`^\\*{0,2}${key}:\\*{0,2}[ \\t]*(.*)$`, 'm'));
    if (!m) return '';
    const inline = stripMd(m[1]);
    if (inline) return inline;
    const following = block.slice(m.index + m[0].length).split('\n').slice(1);
    const lines = [];
    for (const line of following) {
      if (/^\*{0,2}[A-Z_]+:/.test(line.trim()) || /^#{1,6}\s/.test(line.trim()) || /^-{3,}$/.test(line.trim())) break;
      lines.push(line);
    }
    return stripMd(lines.join('\n').trim());
  };
}

// Split schedule text into one block per post, anchored on `DAY:` field lines.
// Splitting on `---` is unsafe: executor models sometimes put a `---` INSIDE a
// day block (between the metadata fields and HOOK/BODY), which orphans the
// content from its DAY marker. Mirrors parseScheduleText in facebook-poster.mjs.
function splitDayBlocks(text) {
  const starts = [];
  const dayRe = /^\*{0,2}DAY:/gm;
  let m;
  while ((m = dayRe.exec(text)) !== null) starts.push(m.index);
  return starts.map((s, i) => text.slice(s, i + 1 < starts.length ? starts[i + 1] : text.length));
}

function normalizePostDate(raw) {
  // Models sometimes emit "2026-08-17 (Monday, August 17, 2026)" — keep ISO date only.
  const s = stripMd(raw || '').trim();
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function parseFacebookSchedule(text) {
  if (!text) return [];
  // Strip leading ```markdown code fence the LLM sometimes adds
  text = stripCodeFence(text);
  const blocks = splitDayBlocks(text);
  return blocks.map(block => {
    const get = makeFieldGetter(block);
    return {
      platform: 'facebook',
      day: parseInt(get('DAY')) || 0,
      post_date: normalizePostDate(get('DATE')),
      type: get('TYPE').toLowerCase(),
      service: stripMd(get('SERVICE')),
      hook: stripMd(get('HOOK')),
      body: stripMd(get('BODY')),
      cta: stripMd(get('CTA')),
      hashtags: get('HASHTAGS') || null,
      photo_file: normalizePhotoFile(get('PHOTO_FILE')) || null,
      video_prompt: get('VIDEO_PROMPT') || null,
      status: 'pending_approval',
    };
  }).filter(p => p.day > 0 && p.post_date && /^\d{4}-\d{2}-\d{2}$/.test(p.post_date));
}

// ─────────────────────────────────────────────
// Parse gbp_posting_schedule.md
// ─────────────────────────────────────────────

function parseGbpSchedule(text) {
  if (!text) return [];
  const blocks = splitDayBlocks(text);
  return blocks.map(block => {
    const get = makeFieldGetter(block);
    return {
      platform: 'gbp',
      day: parseInt(get('DAY')) || 0,
      post_date: normalizePostDate(get('DATE')),
      type: 'photo',
      service: get('SERVICE'),
      hook: get('HEADLINE'),
      body: get('BODY'),
      cta: get('CTA'),
      hashtags: null,
      photo_file: normalizePhotoFile(get('PHOTO_FILE')) || null,
      video_prompt: null,
      status: 'pending_approval',
    };
  }).filter(p => p.day > 0 && p.post_date && /^\d{4}-\d{2}-\d{2}$/.test(p.post_date));
}

// Website-task parsing: scripts/lib/parse-website-tasks.mjs
// (title extraction no longer mistakes TITLE:/EXCERPT:/TAGS: for a Title field;
//  waiting_on_owner / blocked queue rows stay non-executable.)

// ─────────────────────────────────────────────
// Main sync
// ─────────────────────────────────────────────

function loadApprovalNotifyState() {
  try {
    return JSON.parse(fs.readFileSync(APPROVAL_NOTIFY_STATE, 'utf8'));
  } catch {
    return {};
  }
}

function writeNotifyResult(payload) {
  try {
    fs.mkdirSync(path.dirname(APPROVAL_NOTIFY_RESULT), { recursive: true });
    fs.writeFileSync(
      APPROVAL_NOTIFY_RESULT,
      JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2) + '\n',
      'utf8',
    );
  } catch (err) {
    console.error(`Could not write approval-notify.json: ${err.message || err}`);
  }
}

async function sendDualAlert(message) {
  let hermesOk = false;
  let smtpOk = false;
  let reason = '';
  try {
    await sendHermesAlert(message);
    hermesOk = true;
  } catch (err) {
    reason = String(err.message || err);
    console.error(`Hermes alert failed (non-fatal so far): ${reason}`);
  }
  const smtpPass = process.env.SMTP_APP_PASSWORD || '';
  const smtpFrom = process.env.SMTP_FROM || process.env.SMTP_FROM_EMAIL || 'barnscarter@gmail.com';
  const smtpTo = process.env.SMTP_TO || process.env.SMTP_TO_EMAIL || 'barnscarter@gmail.com';
  if (smtpPass) {
    try {
      const { createTransport } = await import('nodemailer');
      const transport = createTransport({ service: 'gmail', auth: { user: smtpFrom, pass: smtpPass } });
      await transport.sendMail({ from: smtpFrom, to: smtpTo, subject: message.split('\n')[0].slice(0, 80), text: message });
      smtpOk = true;
    } catch (err) {
      console.error(`SMTP alert failed: ${err.message || err}`);
      if (!reason) reason = String(err.message || err);
    }
  }
  const sent = hermesOk || smtpOk;
  const channel = [hermesOk && 'hermes', smtpOk && 'smtp'].filter(Boolean).join('+') || 'none';
  return { sent, channel, reason: sent ? '' : (reason || 'all_channels_failed') };
}

function markApprovalNotified(dedupeKey, meta) {
  const state = loadApprovalNotifyState();
  state[dedupeKey] = { at: new Date().toISOString(), ...meta };
  fs.mkdirSync(path.dirname(APPROVAL_NOTIFY_STATE), { recursive: true });
  fs.writeFileSync(APPROVAL_NOTIFY_STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Fire Carter SMS when a run lands at the MCC approval gate with posts waiting.
 * In-process (not a cron): called only from this sync path after pending_approval
 * posts are written. Dedupes by run_id + post counts so re-syncs do not spam.
 */
async function notifyApprovalGate({ runId, weekOf, fbCount, gbpCount, taskCount }) {
  const totalPosts = (fbCount || 0) + (gbpCount || 0);
  if (totalPosts <= 0) {
    console.log('No pending weekly posts — skipping approval SMS');
    const result = { sent: false, reason: 'no_posts', runId, weekOf, autoApprove: false };
    writeNotifyResult(result);
    return result;
  }
  const dedupeKey = `${runId}:fb${fbCount}:gbp${gbpCount}`;
  const state = loadApprovalNotifyState();
  if (state[dedupeKey]) {
    console.log(`Approval SMS already sent for ${dedupeKey} at ${state[dedupeKey].at} — skip`);
    const result = { sent: true, reason: 'already_notified', dedupeKey, runId, weekOf, autoApprove: false };
    writeNotifyResult(result);
    return result;
  }

  const shortId = String(runId).slice(0, 8);
  const message = [
    'SEO approval needed',
    `Week of ${weekOf}`,
    `Run ${shortId}`,
    `GBP posts: ${gbpCount}`,
    `Facebook posts: ${fbCount}`,
    taskCount ? `Website tasks: ${taskCount}` : null,
    'Open MCC → approve posts (nothing publishes until you approve).',
  ].filter(Boolean).join('\n');

  const delivery = await sendDualAlert(message);
  if (delivery.sent) {
    markApprovalNotified(dedupeKey, { runId, weekOf, fbCount, gbpCount, taskCount });
    console.log(`Approval notice sent via ${delivery.channel}`);
  } else {
    console.error(`Approval notice failed on all channels: ${delivery.reason}`);
  }
  const result = { ...delivery, dedupeKey, runId, weekOf, autoApprove: false, fbCount, gbpCount };
  writeNotifyResult(result);
  return result;
}

/**
 * Same transition as mav-bridge POST /seo/actions/approve, minus the HTTP hop.
 *
 * Safe against partial run/post transitions: the run's pending posts are
 * approved FIRST, then the seo_run row (CAS on pending_approval). Nothing
 * publishes from the posts step alone — mav-bridge only executes runs whose
 * seo_runs row is 'approved' and gbp-worker claims posts only after that gate —
 * and if the run CAS fails the posts are rolled back to pending_approval, so
 * neither side is ever left approved alone. Approving with zero pending posts
 * is an invalid execution condition (mav-bridge would execute an empty run and
 * mark it done with nothing published): refuse, leave the run at the MCC gate,
 * and report. Returns { ok, reason, count }.
 */
export async function autoApproveRun(runId, client = supabase) {
  const now = new Date().toISOString();

  // 1. Approve this run's pending posts first. Nothing publishes yet: mav-bridge
  //    only executes seo_runs that are 'approved', and gbp-worker claims posts
  //    only after the run gate is passed.
  const { data: posts, error: postsErr } = await client.from('weekly_posts')
    .update({ status: 'approved', approved_at: now })
    .eq('run_id', runId).eq('status', 'pending_approval')
    .select('id');
  if (postsErr) {
    console.error(`Auto-approve weekly_posts error: ${postsErr.message}`);
    return { ok: false, reason: 'posts_error' };
  }
  if (!posts?.length) {
    console.error(`Auto-approve refused for run ${runId}: zero pending_approval posts — invalid zero-post execution, leaving at the MCC gate`);
    return { ok: false, reason: 'zero_posts' };
  }

  // 2. Now the run itself (CAS on pending_approval). If the CAS loses or errors,
  //    roll the posts back so the run cannot execute against an approved post
  //    set it does not own.
  const { data: run, error: runErr } = await client.from('seo_runs')
    .update({ status: 'approved', approved_at: now })
    .eq('id', runId).eq('status', 'pending_approval')
    .select().maybeSingle();
  if (runErr) {
    const rolled = await rollbackApprovedPosts(runId, client);
    console.error(`Auto-approve seo_run error: ${runErr.message}; posts ${rolled ? 'rolled back to pending_approval' : 'ROLLBACK FAILED — check MCC'}`);
    return { ok: false, reason: rolled ? 'run_update_error' : 'rollback_failed' };
  }
  if (!run) {
    // CAS lost — the run left pending_approval between our two updates. If a
    // concurrent actor already approved it, posts being approved is the same
    // intent; otherwise put the posts back behind the gate.
    const { data: cur } = await client.from('seo_runs').select('status').eq('id', runId).maybeSingle();
    if (cur?.status === 'approved') {
      console.log(`Auto-approve: run ${runId} already approved by another actor — ${posts.length} post(s) stay approved`);
      return { ok: true, count: posts.length, reason: 'already_approved' };
    }
    const rolled = await rollbackApprovedPosts(runId, client);
    console.error(`Auto-approve: run ${runId} was not pending_approval (status=${cur?.status || '?'}); posts ${rolled ? 'rolled back to pending_approval' : 'ROLLBACK FAILED — check MCC'}`);
    return { ok: false, reason: rolled ? 'run_not_pending' : 'rollback_failed' };
  }

  console.log(`Auto-approve: ${posts.length} post(s) approved for run ${String(runId).slice(0, 8)}`);
  return { ok: true, count: posts.length };
}

// CAS on status='approved' so only the rows this sync approved are rolled back
// (rows already claimed/posted by a worker are left alone). Returns true if the
// rollback landed.
async function rollbackApprovedPosts(runId, client) {
  const { error } = await client.from('weekly_posts')
    .update({ status: 'pending_approval', approved_at: null })
    .eq('run_id', runId).eq('status', 'approved');
  return !error;
}

async function notifyAutoApproved({ runId, weekOf, fbCount, gbpCount, taskCount }) {
  const message = [
    'SEO week auto-approved',
    `Week of ${weekOf}`,
    `Run ${String(runId).slice(0, 8)}`,
    `GBP posts: ${gbpCount}`,
    `Facebook posts: ${fbCount}`,
    taskCount ? `Website tasks awaiting approval in MCC: ${taskCount}` : null,
    'Publishing via mav-bridge — no action needed.',
  ].filter(Boolean).join('\n');
  const delivery = await sendDualAlert(message);
  if (delivery.sent) {
    console.log(`Auto-approve notice sent via ${delivery.channel}`);
  } else {
    console.error(`Auto-approve notice failed on all channels: ${delivery.reason}`);
  }
  writeNotifyResult({ ...delivery, runId, weekOf, autoApprove: true, fbCount, gbpCount });
  return delivery;
}

async function main() {
  // --tasks-only: re-sync website_tasks for an existing run without touching
  // weekly_posts or the run's approval status (safe after posts are approved).
  const tasksOnly = process.argv.includes('--tasks-only');
  let weekOf;
  try {
    weekOf = getWeekOf();
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
  console.log(`Syncing week of ${weekOf} to Supabase...${tasksOnly ? ' (website tasks only)' : ''}`);

  let runId;
  let fbCount = 0;
  let gbpCount = 0;
  if (tasksOnly) {
    const { data: runData, error: runError } = await supabase
      .from('seo_runs').select('id').eq('week_of', weekOf).single();
    if (runError || !runData) { console.error(`No existing seo_run for week ${weekOf}:`, runError?.message || 'not found'); process.exit(1); }
    runId = runData.id;
    console.log(`Run ID: ${runId}`);
    await supabase.from('website_tasks').delete().eq('run_id', runId).eq('status', 'pending_approval');
  } else {
    // Upsert seo_run row — this is the approval gate transition.
    const { data: runData, error: runError } = await supabase
      .from('seo_runs')
      .upsert({ week_of: weekOf, status: 'pending_approval', execute_completed_at: new Date().toISOString() },
        { onConflict: 'week_of' })
      .select()
      .single();

    if (runError) { console.error('Failed to upsert seo_run:', runError.message); process.exit(1); }
    runId = runData.id;
    console.log(`Run ID: ${runId}`);

    // Clear existing pending posts for this run (allow re-sync)
    await supabase.from('weekly_posts').delete().eq('run_id', runId).eq('status', 'pending_approval');
    await supabase.from('website_tasks').delete().eq('run_id', runId).eq('status', 'pending_approval');

    // Parse and insert Facebook posts
    const fbText = readFile('facebook_posting_schedule.md');
    const fbPosts = parseFacebookSchedule(fbText);
    fbCount = fbPosts.length;
    if (fbPosts.length) {
      const { error } = await supabase.from('weekly_posts').insert(fbPosts.map(p => ({ ...p, run_id: runId })));
      if (error) console.error('FB posts insert error:', error.message);
      else console.log(`Synced ${fbPosts.length} Facebook posts`);
    } else {
      console.log('No Facebook posts found');
    }

    // Parse and insert GBP posts
    const gbpText = readFile('gbp_posting_schedule.md');
    const gbpPosts = parseGbpSchedule(gbpText);
    gbpCount = gbpPosts.length;
    if (gbpPosts.length) {
      const { error } = await supabase.from('weekly_posts').insert(gbpPosts.map(p => ({ ...p, run_id: runId })));
      if (error) console.error('GBP posts insert error:', error.message);
      else console.log(`Synced ${gbpPosts.length} GBP posts`);
    } else {
      console.log('No GBP posts found');
    }
  }

  // Parse and insert website tasks
  const queueText = readFile('grizzly_execution_queue.md');
  const reportText = readFile('final_report.md');
  const tasks = parseWebsiteTasks(queueText, reportText);
  if (tasks.length) {
    const { data: existingTasks } = await supabase
      .from('website_tasks')
      .select('id,title,status,run_id')
      .in('status', ['waiting_on_owner', 'pending_approval', 'approved']);
    const fresh = tasks.filter((t) => !isDuplicateOwnerWaitTopic(t, existingTasks || []));
    const skipped = tasks.length - fresh.length;
    if (skipped) console.log(`Skipped ${skipped} website task(s) already open (topic fingerprint)`);
    if (fresh.length) {
      const { error } = await supabase.from('website_tasks').insert(fresh.map(t => ({ ...t, run_id: runId })));
      if (error) console.error('Website tasks insert error:', error.message);
      else console.log(`Synced ${fresh.length} website tasks`);
    }
  }

  // SEO_AUTO_APPROVE=1: skip the MCC gate for posts. Mirrors POST /seo/actions/approve
  // in mav-bridge (seo_runs -> approved, this run's pending weekly_posts -> approved).
  // Website tasks stay pending_approval — they still need a human in MCC.
  const autoApprove = !tasksOnly && /^(1|true|yes)$/i.test(process.env.SEO_AUTO_APPROVE || '');
  if (autoApprove) {
    const outcome = await autoApproveRun(runId);
    if (outcome.ok) {
      console.log(`\nSync complete. Run ${runId} AUTO-APPROVED (SEO_AUTO_APPROVE=1) — mav-bridge will publish.`);
      await notifyAutoApproved({ runId, weekOf, fbCount, gbpCount, taskCount: tasks.length });
      return;
    }
    if (outcome.reason === 'zero_posts' || outcome.reason === 'rollback_failed') {
      // Invalid execution condition or an inconsistent DB state — a human must
      // look at the MCC gate; do not let this pass silently.
      const why = outcome.reason === 'zero_posts'
        ? 'zero posts to approve (empty week?)'
        : 'post rollback failed after a partial transition (check MCC consistency)';
      await sendDualAlert(
        `SEO auto-approve SKIPPED for run ${String(runId).slice(0, 8)}: ${why}. Run left pending_approval — inspect the weekly sync output.`,
      );
    }
    console.error('Auto-approve failed — leaving run at the MCC approval gate.');
  }
  console.log(`\nSync complete. Run ${runId} is pending_approval in Supabase.`);
  console.log('Open the MCC dashboard to review and approve.');

  // In-process approval notification (not a cron/watchdog).
  if (!tasksOnly) {
    await notifyApprovalGate({
      runId,
      weekOf,
      fbCount,
      gbpCount,
      taskCount: tasks.length,
    });
  }
}

if (invokedDirectly) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
