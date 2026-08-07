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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const OUTPUTS = path.join(PROJECT_ROOT, 'outputs');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function getWeekOf() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--week-of');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  // Default: next Monday, formatted in LOCAL time. toISOString() converts to
  // UTC first, so any run after ~19:00 CDT rolled the date forward a day —
  // that's how the 2026-07-28 22:53 manual run got filed as week_of 2026-08-04
  // (a Tuesday), stranding its posts under a week no other query looked at.
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
      post_date: get('DATE'),
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
  }).filter(p => p.day > 0 && p.post_date);
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
      post_date: get('DATE'),
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
  }).filter(p => p.day > 0 && p.post_date);
}

// ─────────────────────────────────────────────
// Parse website tasks from execution queue + reports
// ─────────────────────────────────────────────

function stripCodeFence(text) {
  // Remove leading/trailing ```markdown or ``` wrappers the LLM sometimes adds
  return text.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

function parseWebsiteTasks(executionQueueText, finalReportText) {
  const tasks = [];
  const seenTitles = new Set();

  // From final_report.md — incomplete tasks become pending website tasks
  if (finalReportText) {
    const clean = stripCodeFence(finalReportText);

    // Format A: markdown table rows  | T001 | Title | Missing | Next |
    const incompleteSection = clean.match(/##\s+Incomplete[^#]*([\s\S]*?)(?=\n##|$)/i)?.[1] || '';
    const tableRows = [...incompleteSection.matchAll(/\|\s*(T\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/g)];
    for (const [, id, title, missing, next] of tableRows) {
      const t = title.trim();
      if (!t || seenTitles.has(t)) continue;
      seenTitles.add(t);
      tasks.push({
        type: 'seo_fix',
        priority: 'high',
        title: t,
        description: `Missing: ${missing.trim()}\nNext step: ${next.trim()}`,
        details: mergeClassification({ task_id: id.trim(), source: 'final_report' }, { title: t, description: `Missing: ${missing.trim()}\nNext step: ${next.trim()}` }),
        status: 'pending_approval',
      });
    }

    // Format B: ### Task N: Title header blocks with bullet fields
    // Matches blocks starting at "### Task" up to the next "###" or "##" or end
    const headerBlocks = [...clean.matchAll(/###\s+Task\s+\d+[:\s]+([^\n]+)([\s\S]*?)(?=\n###|\n##|$)/gi)];
    for (const [, headerTitle, body] of headerBlocks) {
      const getBullet = key => {
        const m = body.match(new RegExp(`\\*{0,2}${key}\\*{0,2}\\s*:\\s*(.+)`, 'i'));
        return m ? m[1].replace(/\*{0,2}$/, '').trim() : '';
      };
      const taskId = getBullet('Task ID') || getBullet('Task Id') || '';
      const title = (getBullet('Task Title') || headerTitle).trim();
      const missing = getBullet('What was missing') || getBullet('Missing') || '';
      const next = getBullet('Recommended Next Step') || getBullet('Next Step') || '';
      if (!title || seenTitles.has(title)) continue;
      seenTitles.add(title);
      tasks.push({
        type: 'seo_fix',
        priority: 'high',
        title,
        description: [missing && `Missing: ${missing}`, next && `Next step: ${next}`].filter(Boolean).join('\n'),
        details: mergeClassification({ task_id: taskId, source: 'final_report' }, { title, description: [missing && `Missing: ${missing}`, next && `Next step: ${next}`].filter(Boolean).join('\n') }),
        status: 'pending_approval',
      });
    }

    // Format C: "### 🟡 T-GES-20260731-001 — PARTIAL" status blocks with
    // **Title:** / **Blocker:** / **Recommended Next Step:** fields. Only
    // non-complete statuses become pending tasks.
    const statusBlocks = [...clean.matchAll(/###[^\n]*?\b(T[A-Z0-9-]*\d)\b[^\n]*?[—–-]\s*(PARTIAL|INCOMPLETE|BLOCKED|NOT[ _]?DONE|FAILED)[^\n]*\n([\s\S]*?)(?=\n###|\n##(?!#)|$)/gi)];
    for (const [, taskId, , body] of statusBlocks) {
      const title = boldField(body, 'Title');
      const blocker = boldField(body, 'Blocker');
      const next = boldField(body, 'Recommended Next Step') || boldField(body, 'Next Step');
      if (!title || seenTitles.has(title)) continue;
      seenTitles.add(title);
      const description = [blocker && `Blocker: ${blocker}`, next && `Next step: ${next}`].filter(Boolean).join('\n');
      tasks.push({
        type: mapTaskType(title),
        priority: 'high',
        title,
        description,
        details: mergeClassification({ task_id: taskId, source: 'final_report' }, { title, description }),
        status: 'pending_approval',
      });
    }
  }

  // From grizzly_execution_queue.md
  if (executionQueueText) {
    const clean = stripCodeFence(executionQueueText);

    // Format A: blocks separated by --- horizontal rule
    const hrBlocks = clean.split(/\n\s*---\s*\n/).filter(b => /Task\s+(ID|Title)/i.test(b));

    // Format B: blocks separated by ## Task N: headers (most common in this pipeline)
    const headerMatches = [...clean.matchAll(/##\s+Task\s+\d+[:\s]+[^\n]+([\s\S]*?)(?=\n##|\n#|$)/gi)];
    const headerBlocks = headerMatches.map(m => m[0]);

    const allBlocks = hrBlocks.length ? hrBlocks : headerBlocks;

    for (const block of allBlocks) {
      const getField = key => {
        // Handles: "**Task Title**: value", "Task Title: value", "1) **Task Title**: value"
        const m = block.match(new RegExp(`\\*{0,2}${key}\\*{0,2}\\s*:(?:\\*{0,2})?\\s*(.+)`, 'i'));
        return m ? m[1].replace(/\*{0,2}$/, '').trim() : '';
      };
      const title = getField('Task Title') || getField('TASK_TITLE') || getField('Title');
      if (!title || seenTitles.has(title)) continue;
      seenTitles.add(title);
      const rawPriority = getField('Priority') || getField('PRIORITY') || '';
      const type = getField('Type') || getField('TYPE') || '';
      const taskId = getField('Task ID') || getField('Task Id') || '';
      tasks.push({
        type: mapTaskType(type || title),
        priority: mapPriority(rawPriority),
        title,
        description: getField('Description') || getField('DESCRIPTION') || '',
        details: mergeClassification({ task_id: taskId, source: 'execution_queue' }, { title, description: getField('Description') || getField('DESCRIPTION') || '' }),
        status: 'pending_approval',
      });
    }

    // Format C: "### T-GES-20260731-001" ID-header blocks with **Title:** /
    // **Status:** / **Task Type:** fields. Completed tasks are skipped.
    const idBlocks = [...clean.matchAll(/###\s+(T[A-Z0-9-]*\d)\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/g)];
    for (const [, taskId, body] of idBlocks) {
      const title = boldField(body, 'Title');
      if (!title || seenTitles.has(title)) continue;
      const status = boldField(body, 'Status').replace(/`/g, '');
      if (/complete|done|verified|shipped/i.test(status)) continue;
      seenTitles.add(title);
      const steps = body.match(/\*{0,2}Exact Action Steps:?\*{0,2}:?\s*\n([\s\S]*?)(?=\n\*\*[A-Z]|$)/i)?.[1].trim() || '';
      const description = [status && `Status: ${status}`, steps].filter(Boolean).join('\n');
      tasks.push({
        type: mapTaskType(boldField(body, 'Task Type').replace(/`/g, '') || title),
        priority: mapPriority(boldField(body, 'Priority')),
        title,
        description,
        details: mergeClassification({ task_id: taskId, source: 'execution_queue' }, { title, description }),
        status: 'pending_approval',
      });
    }
  }

  return tasks;
}

// Matches "**Key:** value", "**Key**: value", and plain "Key: value" lines.
function boldField(body, key) {
  const m = body.match(new RegExp(`\\*{0,2}${key}:?\\*{0,2}:?\\s*(.+)`, 'i'));
  return m ? m[1].trim() : '';
}

function mapTaskType(raw) {
  const r = raw.toLowerCase();
  if (r.includes('blog')) return 'blog_post';
  if (r.includes('service')) return 'service_update';
  if (r.includes('promo')) return 'promotion';
  if (r.includes('alert') || r.includes('broken') || r.includes('fix')) return 'alert';
  return 'seo_fix';
}

function mapPriority(raw) {
  const r = raw.toLowerCase();
  if (r.includes('critical') || /\bp0\b/.test(r)) return 'critical';
  if (r.includes('high') || /\bp1\b/.test(r)) return 'high';
  if (r.includes('low') || /\bp[34]\b/.test(r)) return 'low';
  return 'medium';
}

// ─────────────────────────────────────────────
// Platform & action-type classification (CONTRACT)
// ─────────────────────────────────────────────

function classifyTask(title, description) {
  const text = `${title} ${description}`.toLowerCase();

  let platform = 'other';
  if (/google|business profile|gbp|google my business/.test(text)) platform = 'gbp';
  else if (/facebook|instagram|post to|social media|tiktok|linkedin/.test(text)) platform = 'social';
  else if (/citation|directory|yelp|bbb|angies|yellow pages|listings?/.test(text)) platform = 'directory';
  else if (/page|blog|meta|title tag|schema|sitemap|robots|homepage|faq|content|home page|index\.|edit|update|service/.test(text)) platform = 'website';

  let website_action_type = null;
  if (platform === 'website') {
    if (/blog/.test(text)) website_action_type = 'website_blog_post';
    else if (/service/.test(text)) website_action_type = 'website_service_page_update';
    else if (/faq/.test(text)) website_action_type = 'website_faq_update';
    else if (/hour/.test(text)) website_action_type = 'website_hours_update';
    else if (/contact.?form|phone|email/.test(text)) website_action_type = 'website_contact_form_update';
    else if (/gallery/.test(text)) website_action_type = 'website_gallery_update';
    else if (/nav|layout|header|footer|sitemap|robots/.test(text)) website_action_type = 'website_layout_update';
    else website_action_type = 'website_copy_update';
  }

  return { platform, website_action_type };
}

function mergeClassification(details, task) {
  const classified = classifyTask(task.title, task.description || '');
  const merged = { ...details };
  merged.platform = classified.platform;
  if (classified.website_action_type) merged.website_action_type = classified.website_action_type;
  return merged;
}

// ─────────────────────────────────────────────
// Main sync
// ─────────────────────────────────────────────

async function main() {
  // --tasks-only: re-sync website_tasks for an existing run without touching
  // weekly_posts or the run's approval status (safe after posts are approved).
  const tasksOnly = process.argv.includes('--tasks-only');
  const weekOf = getWeekOf();
  console.log(`Syncing week of ${weekOf} to Supabase...${tasksOnly ? ' (website tasks only)' : ''}`);

  let runId;
  if (tasksOnly) {
    const { data: runData, error: runError } = await supabase
      .from('seo_runs').select('id').eq('week_of', weekOf).single();
    if (runError || !runData) { console.error(`No existing seo_run for week ${weekOf}:`, runError?.message || 'not found'); process.exit(1); }
    runId = runData.id;
    console.log(`Run ID: ${runId}`);
    await supabase.from('website_tasks').delete().eq('run_id', runId).eq('status', 'pending_approval');
  } else {
    // Upsert seo_run row
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
    const { error } = await supabase.from('website_tasks').insert(tasks.map(t => ({ ...t, run_id: runId })));
    if (error) console.error('Website tasks insert error:', error.message);
    else console.log(`Synced ${tasks.length} website tasks`);
  }

  console.log(`\nSync complete. Run ${runId} is pending_approval in Supabase.`);
  console.log('Open the MCC dashboard to review and approve.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
