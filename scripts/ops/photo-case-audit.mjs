#!/usr/bin/env node
// Read-only audit: do the stored photo references resolve to EXACT-case files in the library?
// Windows folders are case-insensitive, so a stored name such as IMG_1234.jpg can sit on disk as
// IMG_1234.JPG. Windows resolves it, Linux does not. Run before and after the E4 copy.
//
//   node scripts/ops/photo-case-audit.mjs --photos <libraryDir> [--manifest <json>] [--cache <json>]
//        [--workbook <xlsx>] [--scan <json>]... [--json]
//
// Sources (every reference is classified exact | case | ambiguous | missing):
//   manifest.photoPath             state/photo-selection-manifest.json, every platform
//   cache.key / cache.filePath    state/photo-cache.json keys (and filePath when it differs)
//   workbook.AssetIdOrDescription  the GBP schedule's photo column (every sheet)
//   scan:<file>                    image-named strings in any other JSON, e.g. state/curated-labels.json
// Also reports same-folder collisions: two library names that differ only by case.
// `unrooted` counts references with no GBP-Post-Photos root in the stored path (matched by tail).
// Exit: 0 clean; 2 findings (case-only, ambiguous or missing reference, or a collision); 1 usage or read error.
// Writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';
import { buildPhotoIndex, classifyPhotoRef, PHOTO_EXT_RE, splitSegments } from '../lib/photo-case.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_MANIFEST = path.join(PROJECT_ROOT, 'state', 'photo-selection-manifest.json');
const DEFAULT_CACHE = path.join(PROJECT_ROOT, 'state', 'photo-cache.json');
const WORKBOOK_COLUMN = 'AssetIdOrDescription';
const STATUSES = ['exact', 'case', 'ambiguous', 'missing'];

// A scanned string counts as a photo reference when it ends in an image extension, is one line
// and is not a URL (a note that links to an image is not a library reference).
function isPhotoName(s) {
  return s.length <= 260 && !/[\r\n]/.test(s) && !s.includes('://') && PHOTO_EXT_RE.test(s);
}

export function manifestRefs(manifest) {
  const refs = [];
  const visit = (entry) => {
    if (entry && typeof entry === 'object' && typeof entry.photoPath === 'string' && entry.photoPath !== '') {
      refs.push({ source: 'manifest.photoPath', ref: entry.photoPath });
    }
  };
  if (Array.isArray(manifest)) {
    manifest.forEach(visit);
  } else if (manifest && typeof manifest === 'object' && manifest.platforms && typeof manifest.platforms === 'object') {
    for (const list of Object.values(manifest.platforms)) [].concat(list || []).forEach(visit);
  } else {
    throw new Error('manifest has an unrecognized shape (expected an array or { platforms: {...} })');
  }
  return refs;
}

export function cacheRefs(cache) {
  const refs = [];
  for (const [key, value] of Object.entries(cache || {})) {
    refs.push({ source: 'cache.key', ref: key });
    if (value && typeof value === 'object' && typeof value.filePath === 'string' && value.filePath !== key) {
      refs.push({ source: 'cache.filePath', ref: value.filePath });
    }
  }
  return refs;
}

export function workbookRefs(workbookPath) {
  const wb = xlsx.readFile(workbookPath, { cellDates: false });
  const refs = [];
  for (const name of wb.SheetNames) {
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    if (!rows.length) continue;
    const col = rows[0].map((h) => String(h).trim()).indexOf(WORKBOOK_COLUMN);
    if (col < 0) continue;
    for (const row of rows.slice(1)) {
      const v = String(row[col] ?? '').trim();
      if (v !== '') refs.push({ source: `workbook.${WORKBOOK_COLUMN}`, ref: v });
    }
  }
  return refs;
}

export function scanRefs(json, name) {
  const refs = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      if (isPhotoName(v)) refs.push({ source: `scan:${name}`, ref: v });
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(json);
  return refs;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Audits the references against the library at `photos`. Pass null for any source you do not
 * want. Returns the report; the caller decides how to print it and which exit code to use.
 */
export function runAudit({ photos, manifest = null, cache = null, workbook = null, scan = [] }) {
  const index = buildPhotoIndex(photos);
  if (!index.exists) throw new Error(`photo library is not readable: ${photos}`);
  const marker = splitSegments(photos).pop() || '';

  const refs = [];
  if (manifest) refs.push(...manifestRefs(readJson(manifest)));
  if (cache) refs.push(...cacheRefs(readJson(cache)));
  if (workbook) refs.push(...workbookRefs(workbook));
  for (const file of scan) refs.push(...scanRefs(readJson(file), path.basename(file)));

  const sources = {};
  const findings = [];
  for (const { source, ref } of refs) {
    const r = classifyPhotoRef(index, ref, marker);
    if (!sources[source]) sources[source] = { total: 0, exact: 0, case: 0, ambiguous: 0, missing: 0, unrooted: 0 };
    const s = sources[source];
    s.total += 1;
    s[r.status] += 1;
    if (r.mode === 'suffix' || r.mode === 'basename') s.unrooted += 1;
    if (r.status !== 'exact') findings.push({ source, ref, status: r.status, suggested: r.rel });
  }

  const totals = { total: 0, exact: 0, case: 0, ambiguous: 0, missing: 0, unrooted: 0 };
  for (const s of Object.values(sources)) for (const k of Object.keys(totals)) totals[k] += s[k];
  const collisions = index.collisions;
  const exit = totals.case + totals.ambiguous + totals.missing + collisions.length > 0 ? 2 : 0;
  return { photos, library: { files: index.files.length }, collisions, sources, totals, findings, exit };
}

function parseArgs(argv) {
  const args = { photos: '', manifest: null, cache: null, workbook: null, scan: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--photos') args.photos = argv[++i] || '';
    else if (a === '--manifest') args.manifest = argv[++i] || '';
    else if (a === '--cache') args.cache = argv[++i] || '';
    else if (a === '--workbook') args.workbook = argv[++i] || '';
    else if (a === '--scan') args.scan.push(argv[++i] || '');
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.photos) {
    throw new Error('usage: photo-case-audit.mjs --photos <dir> [--manifest <json>] [--cache <json>] [--workbook <xlsx>] [--scan <json>]... [--json]');
  }
  // The state files default to the project's state/ folder when they exist; explicit paths must exist.
  if (args.manifest === null && fs.existsSync(DEFAULT_MANIFEST)) args.manifest = DEFAULT_MANIFEST;
  if (args.cache === null && fs.existsSync(DEFAULT_CACHE)) args.cache = DEFAULT_CACHE;
  for (const f of [args.manifest, args.cache, args.workbook, ...args.scan]) {
    if (f && !fs.existsSync(f)) throw new Error(`file not found: ${f}`);
  }
  return args;
}

function printTable(report) {
  const head = ['source', 'refs', 'exact', 'case-only', 'missing', 'ambig', 'unrooted'];
  const rows = Object.entries(report.sources).map(([name, s]) => [name, s.total, s.exact, s.case, s.missing, s.ambiguous, s.unrooted]);
  rows.push(['TOTAL', report.totals.total, report.totals.exact, report.totals.case, report.totals.missing, report.totals.ambiguous, report.totals.unrooted]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  console.log(`photo-case-audit: library ${report.photos} (${report.library.files} files)`);
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  console.log(`collisions (same folder, names differ only by case): ${report.collisions.length}`);
  for (const c of report.collisions.slice(0, 5)) console.log(`  [collision] ${c.dir}: ${c.names.join(' | ')}`);
  for (const status of ['case', 'ambiguous', 'missing']) {
    const hits = report.findings.filter((f) => f.status === status).slice(0, 5);
    for (const f of hits) {
      const fix = f.suggested ? ` -> ${f.suggested}` : '';
      console.log(`  [${status}] ${f.source}: ${f.ref}${fix}`);
    }
  }
  console.log(report.exit === 0 ? 'result: clean (exit 0)' : `result: findings remain (exit ${report.exit})`);
}

function isMain() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  try {
    const report = runAudit(args);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printTable(report);
    process.exitCode = report.exit;
  } catch (err) {
    console.error(`photo-case-audit failed: ${err.message}`);
    process.exitCode = 1;
  }
}
