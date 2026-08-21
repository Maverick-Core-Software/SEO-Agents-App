#!/usr/bin/env node
/**
 * sync-gbp-schedule.mjs
 * Node port of seo-agents `sync-gbp-schedule` + `mark-gbp-approved`.
 * Writes outputs/gbp_posting_schedule.md into the Excel workbook the Playwright
 * driver reads. Independent of the Python CLI / pydantic / crewai stack.
 *
 *   node scripts/sync-gbp-schedule.mjs
 *   node scripts/sync-gbp-schedule.mjs --dry-run
 *   node scripts/sync-gbp-schedule.mjs --approve-dates 2026-08-21 2026-08-22
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';
import { excelDateToIso } from './lib/gbp-runner.mjs';
import { defaultGbpPhotoDirs, resolveGbpImagePath } from './lib/gbp-paths.mjs';
import { normalizePhotoFile } from './lib/schedule-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(PROJECT_ROOT, 'config', 'gbp-poster.config.json');
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'gbp_posting_schedule.md');

export const GBP_WORKBOOK_HEADERS = [
  'Date',
  'PostType',
  'Topic',
  'AssetSource',
  'AssetIdOrDescription',
  'CTA',
  'Status',
  'CaptionDraft',
  'ImageLink',
  'Posted',
  'PostedAt',
  'GBPPostUrl',
  'Notes',
];

function loadEnv(root = PROJECT_ROOT) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseGbpScheduleMarkdown(text) {
  const starts = [...text.matchAll(/^\*{0,2}DAY:/gim)].map((m) => m.index);
  const posts = [];
  for (let i = 0; i < starts.length; i++) {
    const block = text.slice(starts[i], starts[i + 1] ?? text.length).replace(/\*\*/g, '');
    if (!/HEADLINE:/i.test(block)) continue;
    const get = (label) => {
      const m = block.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'im'));
      if (!m) return '';
      return (m[1] || '').trim();
    };
    posts.push({
      date: get('DATE').slice(0, 10),
      day: get('DAY'),
      service: get('SERVICE'),
      topic: get('TOPIC'),
      trend_tie: get('TREND_TIE'),
      headline: get('HEADLINE'),
      body: get('BODY'),
      caption: get('CAPTION'),
      photo_file: normalizePhotoFile(get('PHOTO_FILE')),
      cta: get('CTA'),
      status: get('STATUS'),
    });
  }
  return posts;
}

export function captionForGbpPost(post) {
  const clean = (value) => String(value || '')
    .replace(/\+?1?[\s.-]*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.!?,])/g, '$1')
    .trim();
  return [post.headline, post.body, post.cta].map(clean).filter(Boolean).join('\n\n');
}

function headerIndex(headerRow) {
  const header = (headerRow || []).map((h) => String(h || '').trim());
  const columns = {};
  for (const name of GBP_WORKBOOK_HEADERS) {
    columns[name] = header.indexOf(name);
  }
  return { header, columns };
}

function findRowByDate(rows, dateCol, dateValue) {
  for (let i = 1; i < rows.length; i++) {
    if (excelDateToIso(rows[i][dateCol]) === dateValue) return i;
  }
  return -1;
}

function setCell(sheet, r, c, cell) {
  if (c < 0) return;
  sheet[xlsx.utils.encode_cell({ r, c })] = cell;
}

function photoPathForPost(post, { curatedPreferred, localCache }) {
  if (!post.photo_file) return '';
  const resolved = resolveGbpImagePath(post.photo_file, {
    date: post.date,
    curatedPreferred,
    localCache,
  });
  if (resolved && fs.existsSync(resolved)) return resolved;
  const base = path.basename(post.photo_file);
  if (localCache) return path.join(localCache, base);
  if (curatedPreferred) return path.join(curatedPreferred, base);
  return post.photo_file;
}

export function syncGbpScheduleToWorkbook({
  scheduleText,
  workbookPath,
  curatedPreferred,
  localCache,
  dryRun = false,
  now = nowIso,
}) {
  if (!workbookPath || !fs.existsSync(workbookPath)) {
    throw new Error(`GBP workbook not found: ${workbookPath || '(missing path)'}`);
  }
  const posts = parseGbpScheduleMarkdown(scheduleText).filter((p) => p.date);
  const workbook = xlsx.readFile(workbookPath, { cellDates: true });
  const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (!rows.length) throw new Error('GBP workbook is empty');
  const { columns } = headerIndex(rows[0]);
  const missing = GBP_WORKBOOK_HEADERS.filter((h) => columns[h] < 0);
  if (missing.length) throw new Error(`GBP workbook missing headers: ${missing.join(', ')}`);

  const dateCol = columns.Date;
  const updates = [];
  let nextNewRow = rows.length;

  for (const post of posts) {
    let row = findRowByDate(rows, dateCol, post.date);
    const isNew = row === -1;
    if (isNew) {
      row = nextNewRow;
      nextNewRow += 1;
      rows[row] = [];
    }
    const existingStatus = String(rows[row][columns.Status] || '').trim();
    const existingPosted = Boolean(rows[row][columns.Posted]);
    const photoPath = photoPathForPost(post, { curatedPreferred, localCache });
    const status = existingStatus === 'Approved' || existingStatus === 'Posted'
      ? existingStatus
      : (post.status || 'Needs approval');
    updates.push({ date: post.date, row: row + 1, new: isNew, title: post.headline || '' });
    if (dryRun) continue;

    setCell(sheet, row, columns.Date, { t: 's', v: post.date });
    setCell(sheet, row, columns.PostType, { t: 's', v: 'STANDARD' });
    setCell(sheet, row, columns.Topic, { t: 's', v: post.topic || post.service || post.headline || '' });
    setCell(sheet, row, columns.AssetSource, { t: 's', v: 'Workspace Shared' });
    setCell(sheet, row, columns.AssetIdOrDescription, { t: 's', v: photoPath });
    setCell(sheet, row, columns.CTA, { t: 's', v: post.cta || '' });
    setCell(sheet, row, columns.Status, { t: 's', v: status });
    setCell(sheet, row, columns.CaptionDraft, { t: 's', v: captionForGbpPost(post) });
    setCell(sheet, row, columns.Posted, { t: 'b', v: existingPosted });
    if (columns.ImageLink >= 0 && rows[row][columns.ImageLink] != null && rows[row][columns.ImageLink] !== '') {
      // keep existing ImageLink / PostedAt / GBPPostUrl
    }
    setCell(sheet, row, columns.Notes, {
      t: 's',
      v: `Synced from SEO Agents action queue at ${now()}; ${post.trend_tie || ''}`,
    });
    // Keep PostedAt / ImageLink / GBPPostUrl as they were (not overwritten).
  }

  let backupPath = null;
  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '');
    backupPath = workbookPath.replace(/(\.xlsx?)$/i, `.backup-seo-sync-${stamp}$1`);
    fs.copyFileSync(workbookPath, backupPath);
    if (sheet['!ref']) {
      const range = xlsx.utils.decode_range(sheet['!ref']);
      range.e.r = Math.max(range.e.r, nextNewRow - 1);
      range.e.c = Math.max(range.e.c, GBP_WORKBOOK_HEADERS.length - 1);
      sheet['!ref'] = xlsx.utils.encode_range(range);
    }
    xlsx.writeFile(workbook, workbookPath);
  }

  return {
    workbook_path: workbookPath,
    backup_path: backupPath,
    dry_run: dryRun,
    posts_found: posts.length,
    updates,
  };
}

export function markGbpDatesApproved({ workbookPath, dates, now = nowIso }) {
  if (!workbookPath || !fs.existsSync(workbookPath)) {
    throw new Error(`GBP workbook not found: ${workbookPath || '(missing path)'}`);
  }
  const workbook = xlsx.readFile(workbookPath, { cellDates: true });
  const sheetName = workbook.SheetNames.includes('Posts') ? 'Posts' : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const { columns } = headerIndex(rows[0] || []);
  if (columns.Date < 0 || columns.Status < 0) {
    throw new Error('GBP workbook missing Date or Status column');
  }
  const approved = [];
  const skipped = [];
  for (const dateValue of dates) {
    if (!dateValue) continue;
    const row = findRowByDate(rows, columns.Date, dateValue);
    if (row === -1) {
      skipped.push(dateValue);
      continue;
    }
    const existing = String(rows[row][columns.Status] || '').trim();
    if (existing === 'Posted') {
      skipped.push(dateValue);
      continue;
    }
    setCell(sheet, row, columns.Status, { t: 's', v: 'Approved' });
    setCell(sheet, row, columns.Notes, { t: 's', v: `Approved (weekly) at ${now()}` });
    approved.push(dateValue);
  }
  if (approved.length) xlsx.writeFile(workbook, workbookPath);
  return { workbook_path: workbookPath, approved, skipped };
}

function parseCli(argv) {
  const args = { dryRun: false, approveDates: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--approve-dates') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.approveDates.push(argv[++i]);
    } else if (argv[i] === '--config') args.config = argv[++i];
  }
  return args;
}

function workbookFromConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    config,
    workbookPath: process.env.GBP_WORKBOOK_PATH
      || path.join(config.config_dir, config.workbook_path),
    curatedPreferred: process.env.GBP_CURATED_FOLDER || config.curated_photo_folder,
    localCache: defaultGbpPhotoDirs(process.env).localCache,
  };
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  loadEnv();
  const args = parseCli(process.argv.slice(2));
  const { workbookPath, curatedPreferred, localCache } = workbookFromConfig(args.config || DEFAULT_CONFIG);
  try {
    if (args.approveDates.length) {
      const result = markGbpDatesApproved({ workbookPath, dates: args.approveDates });
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (!fs.existsSync(SCHEDULE_FILE)) {
        throw new Error(`Schedule not found: ${SCHEDULE_FILE}`);
      }
      const result = syncGbpScheduleToWorkbook({
        scheduleText: fs.readFileSync(SCHEDULE_FILE, 'utf8'),
        workbookPath,
        curatedPreferred,
        localCache,
        dryRun: args.dryRun,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
