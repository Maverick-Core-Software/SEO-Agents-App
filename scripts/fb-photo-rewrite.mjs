#!/usr/bin/env node
/**
 * fb-photo-rewrite.mjs
 * Deterministic photo matcher for the Facebook schedule.
 *
 * WHY THIS EXISTS
 *   build_facebook_crew() in src/seo_agents/crew.py asks the LLM to pick a
 *   photo filename from a raw list, with NO constraint that the photo match
 *   the post's service. The LLM picks by keyword — so an EV Charger post can
 *   ship with "2026-04-30-financing-available.JPG" (real example from the
 *   2026-07-03 schedule). GBP doesn't have this problem because gbp-photo-pick
 *   service-matches with GPT-4o vision; FB has no equivalent step.
 *
 * WHAT IT DOES
 *   Runs AFTER gbp-photo-pick.mjs has populated GBP_CURATED_FOLDER with
 *   ${date}-${serviceSlug}.<ext> winners. For each TYPE:photo day in
 *   facebook_posting_schedule.md:
 *     - Look up the same-date curated photo whose slug matches the post's SERVICE.
 *     - Match   → overwrite PHOTO_FILE: with the absolute curated path.
 *     - No match → blank PHOTO_FILE: AND switch TYPE: photo → text, so the post
 *       ships text-only rather than with an off-topic image. (Text-only posts
 *       perform well per the FB report — this is a safe fallback.)
 *   Video days (TYPE: video) and existing text days are untouched.
 *
 * USAGE
 *   node scripts/fb-photo-rewrite.mjs            Rewrite the live schedule.
 *   node scripts/fb-photo-rewrite.mjs --dry-run  Show decisions, change nothing.
 *
 * Env (from .env):
 *   GBP_CURATED_FOLDER   Where gbp-photo-pick copies winners (default E:\Media\Grizzly\Curated)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePhotoFile } from './lib/schedule-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// .env loader — .env wins over any inherited PM2 env (mirrors facebook-poster.mjs).
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const CURATED_FOLDER = process.env.GBP_CURATED_FOLDER || 'E:\\Media\\Grizzly\\Curated';
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

const dryRun = process.argv.includes('--dry-run');

// ── serviceSlug — IDENTICAL to gbp-photo-pick.mjs:287-293 ───────────────────
// The picker names winners ${date}-${slug}<ext> using this exact transform, so
// the lookup key here MUST match byte-for-byte or the search will miss.
function serviceSlug(service) {
  return (service || 'electrical')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// Find the curated photo for a given (date, service): a file in CURATED_FOLDER
// whose name starts with `${date}-${slug}` and has an image extension. Case-
// insensitive — the picker preserves original extension case from the source
// photo (e.g. .JPG vs .jpg), so we can't assume lowercase.
function findCuratedPhoto(date, service) {
  if (!date || !service) return null;
  const slug = serviceSlug(service);
  if (!slug) return null;
  const prefix = `${date}-${slug}`.toLowerCase();
  let files;
  try { files = fs.readdirSync(CURATED_FOLDER); } catch { return null; }
  return files
    .filter(f => f.toLowerCase().startsWith(prefix) && IMAGE_EXT_RE.test(f))
    .sort()[0] || null;
}

// ── Schedule rewrite ────────────────────────────────────────────────────────
// Walk the file line by line, tracking which DAY block we're inside. When we
// hit a TYPE:/PHOTO_FILE: line in a photo block, rewrite it in place. Same
// block-tracking pattern as gbp-photo-pick.mjs updateSchedulePhotoFile (172-186),
// extended to also flip TYPE on no-match days.

function rewriteSchedule(text) {
  const lines = text.split('\n');
  const decisions = [];
  let inPhotoBlock = false;     // inside a TYPE: photo day block
  let blockStartIdx = -1;       // where the current day block began
  let blockDate = '';
  let blockService = '';
  let photoLineIdx = -1;
  let typeLineIdx = -1;
  let changedAny = false;

  function flushBlock() {
    if (!inPhotoBlock) return;
    const curated = findCuratedPhoto(blockDate, blockService);
    if (curated) {
      const abs = path.join(CURATED_FOLDER, curated);
      if (photoLineIdx >= 0 && normalizePhotoFile(lines[photoLineIdx]) !== abs) {
        if (!dryRun) lines[photoLineIdx] = `PHOTO_FILE: ${abs}`;
        changedAny = true;
      }
      decisions.push({ date: blockDate, service: blockService, status: 'matched', photo: curated });
    } else {
      // No service-matched curated photo. Strip the PHOTO_FILE and flip TYPE
      // to text so facebook-poster posts text-only instead of an off-topic photo.
      if (photoLineIdx >= 0 && normalizePhotoFile(lines[photoLineIdx]) !== '') {
        if (!dryRun) lines[photoLineIdx] = 'PHOTO_FILE:';
        changedAny = true;
      }
      if (typeLineIdx >= 0 && !/^text/i.test(lines[typeLineIdx].replace(/^\*{0,2}TYPE:\*{0,2}\s*/i, '').trim())) {
        if (!dryRun) lines[typeLineIdx] = 'TYPE: text';
        changedAny = true;
      }
      decisions.push({ date: blockDate, service: blockService, status: 'text_only' });
    }
    inPhotoBlock = false;
    blockStartIdx = -1;
    blockDate = '';
    blockService = '';
    photoLineIdx = -1;
    typeLineIdx = -1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A new DAY: line starts a fresh block (flush previous if any). The leading
    // "DAY:" (with optional markdown bolding) marks a day block start.
    if (/^\*{0,2}DAY:\*{0,2}\s*\d/i.test(line)) {
      flushBlock();
      inPhotoBlock = false; // not known until we see TYPE:
      blockStartIdx = i;
      blockDate = '';
      blockService = '';
      photoLineIdx = -1;
      typeLineIdx = -1;
      continue;
    }
    if (line.trim() === '---') { flushBlock(); continue; }
    if (blockStartIdx >= 0) {
      // Capture fields as we encounter them — order is not guaranteed.
      const dm = line.match(/^\*{0,2}DATE:\*{0,2}\s*(.+?)\s*$/i);
      if (dm) blockDate = dm[1].trim();
      const sm = line.match(/^\*{0,2}SERVICE:\*{0,2}\s*(.+?)\s*$/i);
      if (sm) blockService = sm[1].trim();
      const tm = line.match(/^\*{0,2}TYPE:\*{0,2}\s*(.+?)\s*$/i);
      if (tm) {
        const t = tm[1].trim().toLowerCase();
        if (t === 'photo') { inPhotoBlock = true; typeLineIdx = i; }
        else { inPhotoBlock = false; } // video/text days — leave alone
      }
      if (inPhotoBlock && /^\*{0,2}PHOTO_FILE:\*{0,2}\s*/i.test(line)) {
        photoLineIdx = i;
      }
    }
  }
  flushBlock(); // tail block (no trailing ---)

  return { rewritten: lines.join('\n'), decisions, changedAny };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    console.error(`Schedule not found: ${SCHEDULE_FILE}`);
    console.error('Run the Facebook crew first (seo-agents facebook-schedule).');
    process.exit(1);
  }
  if (!fs.existsSync(CURATED_FOLDER)) {
    console.error(`Curated folder not found: ${CURATED_FOLDER}`);
    console.error('Run gbp-photo-pick.mjs first to populate it.');
    process.exit(1);
  }

  const original = fs.readFileSync(SCHEDULE_FILE, 'utf8');
  const { rewritten, decisions, changedAny } = rewriteSchedule(original);

  console.log(`\n=== FB Photo Rewrite ${dryRun ? '(dry run)' : ''} ===`);
  console.log(`Curated folder: ${CURATED_FOLDER}\n`);
  for (const d of decisions) {
    if (d.status === 'matched') {
      console.log(`  ${d.date} [${d.service}] → ${d.photo} ✓`);
    } else {
      console.log(`  ${d.date} [${d.service}] → no curated match, switching to text-only`);
    }
  }

  const matched = decisions.filter(d => d.status === 'matched').length;
  const textOnly = decisions.filter(d => d.status === 'text_only').length;
  console.log(`\n${matched} matched, ${textOnly} switched to text-only.`);

  if (dryRun) {
    console.log('(dry run — schedule unchanged)');
  } else if (changedAny) {
    fs.writeFileSync(SCHEDULE_FILE, rewritten);
    console.log('✓ Schedule updated.');
  } else {
    console.log('No changes needed — every photo day already correct.');
  }
}

main();
