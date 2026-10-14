#!/usr/bin/env node
// Read-only audit: do the stored photo references resolve to EXACT-case files in the library?
// Windows folders are case-insensitive, so a stored name such as IMG_1234.jpg can sit on disk as
// IMG_1234.JPG. Windows resolves it, Linux does not. Run before and after the E4 copy.
//
//   node scripts/ops/photo-case-audit.mjs --photos <libraryDir> [--manifest <json>] [--cache <json>]
//        [--workbook <xlsx>] [--scan <json>]... [--strict] [--accept-missing <file>]
//        [--today <YYYY-MM-DD>] [--json]
//
// Sources (every reference is classified exact | case | ambiguous | missing):
//   manifest.photoPath             state/photo-selection-manifest.json, every platform
//   manifest.sourcePath            provenance only: checked for existence, never gates
//   cache.key / cache.filePath    state/photo-cache.json keys (and filePath when it differs)
//   workbook.AssetIdOrDescription  the GBP schedule's photo column (every sheet)
//   scan:<file>                    image-named strings in any other JSON, e.g. state/curated-labels.json
//
// Classes (scripts/lib/photo-case-class.mjs): every reference is also forward or historical (or a
// curated-label warning). Only FORWARD references the pipeline will still read fail the default gate.
//   --strict           fail on any missing, case-only or ambiguous reference (the old behaviour)
//   --accept-missing   one basename or path per line; matching refs are Carter-approved exceptions,
//                      listed and counted separately, and excluded from both gates
//   --today            the date that separates forward from past (default: today in America/Chicago)
// Also reports same-folder collisions (names differing only by case): these fail both gates.
// Exit: 0 clean for the chosen gate; 2 findings for the chosen gate; 1 usage or read error.
// Writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';
import { buildPhotoIndex, classifyPhotoRef, PHOTO_EXT_RE, splitSegments } from '../lib/photo-case.mjs';
import {
  chicagoToday, classifyCacheRef, classifyManifestRef, classifyScanRef, classifyWorkbookRef,
  dateOnly, isPostedValue, matchAccepted, parseAcceptList,
} from '../lib/photo-case-class.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_MANIFEST = path.join(PROJECT_ROOT, 'state', 'photo-selection-manifest.json');
const DEFAULT_CACHE = path.join(PROJECT_ROOT, 'state', 'photo-cache.json');
const WORKBOOK_COLUMN = 'AssetIdOrDescription';
const SOURCE_PATH = 'manifest.sourcePath';
const STATUSES = ['exact', 'case', 'ambiguous', 'missing'];
const CLASSES = ['forward', 'historical', 'warning'];

// A scanned string counts as a photo reference when it ends in an image extension, is one line
// and is not a URL (a note that links to an image is not a library reference).
function isPhotoName(s) {
  return s.length <= 260 && !/[\r\n]/.test(s) && !s.includes('://') && PHOTO_EXT_RE.test(s);
}

export function manifestRefs(manifest) {
  const refs = [];
  const visit = (entry, platform) => {
    if (!entry || typeof entry !== 'object') return;
    const date = dateOnly(entry.postDate);
    if (typeof entry.photoPath === 'string' && entry.photoPath !== '') {
      refs.push({ source: 'manifest.photoPath', ref: entry.photoPath, date, platform });
    }
    if (typeof entry.sourcePath === 'string' && entry.sourcePath !== '') {
      refs.push({ source: SOURCE_PATH, ref: entry.sourcePath, date, platform });
    }
  };
  if (Array.isArray(manifest)) {
    // Platform unknown: the GBP posted check is skipped, so only the date decides.
    manifest.forEach((e) => visit(e, null));
  } else if (manifest && typeof manifest === 'object' && manifest.platforms && typeof manifest.platforms === 'object') {
    for (const [platform, list] of Object.entries(manifest.platforms)) {
      [].concat(list || []).forEach((e) => visit(e, platform));
    }
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

const pad2 = (n) => String(n).padStart(2, '0');

function dateFromCell(value) {
  if (typeof value === 'number') {
    const q = xlsx.SSF.parse_date_code(value);
    return q ? `${q.y}-${pad2(q.m)}-${pad2(q.d)}` : '';
  }
  return dateOnly(value);
}

/** Every row of every sheet that has a photo column: { sheet, date, posted, photo }. */
export function workbookRows(workbookPath) {
  const wb = xlsx.readFile(workbookPath, { cellDates: false });
  const rows = [];
  for (const name of wb.SheetNames) {
    const aoa = xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    if (!aoa.length) continue;
    const header = aoa[0].map((h) => String(h).trim());
    const photoCol = header.indexOf(WORKBOOK_COLUMN);
    if (photoCol < 0) continue;
    const dateCol = header.indexOf('Date');
    const postedCol = header.indexOf('Posted');
    for (const row of aoa.slice(1)) {
      rows.push({
        sheet: name,
        date: dateCol >= 0 ? dateFromCell(row[dateCol]) : '',
        posted: postedCol >= 0 && isPostedValue(row[postedCol]),
        photo: String(row[photoCol] ?? '').trim(),
      });
    }
  }
  return rows;
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

function emptyCounts() {
  return { total: 0, exact: 0, case: 0, ambiguous: 0, missing: 0, accepted: 0 };
}

function classify(r, status, ctx) {
  if (r.source === 'manifest.photoPath') {
    return classifyManifestRef({ date: r.date, platform: r.platform, postedDates: ctx.postedDates, today: ctx.today });
  }
  if (r.source.startsWith('workbook.')) return classifyWorkbookRef({ date: r.date, posted: r.posted, today: ctx.today });
  if (r.source.startsWith('cache.')) return classifyCacheRef();
  if (r.source.startsWith('scan:')) return classifyScanRef({ name: r.source.slice(5), status });
  return { class: 'forward', reason: 'unknown-source' };
}

/**
 * Audits the references against the library at `photos`. Pass null for any source you do not
 * want. `strict` picks the gate that sets the exit code; both gate counts are always returned.
 * `accept` is a Set of normalised keys from parseAcceptList; `exists` checks sourcePath.
 */
export function runAudit({
  photos, manifest = null, cache = null, workbook = null, scan = [],
  strict = false, accept = null, today = chicagoToday(), exists = (p) => fs.existsSync(p),
}) {
  const index = buildPhotoIndex(photos);
  if (!index.exists) throw new Error(`photo library is not readable: ${photos}`);
  const marker = splitSegments(photos).pop() || '';

  const refs = [];
  let postedDates = new Set();
  if (workbook) {
    const rows = workbookRows(workbook);
    postedDates = new Set(rows.filter((r) => r.posted && r.date).map((r) => r.date));
    for (const r of rows) {
      if (r.photo !== '') refs.push({ source: `workbook.${WORKBOOK_COLUMN}`, ref: r.photo, date: r.date, posted: r.posted });
    }
  }
  if (manifest) refs.push(...manifestRefs(readJson(manifest)));
  if (cache) refs.push(...cacheRefs(readJson(cache)));
  for (const file of scan) refs.push(...scanRefs(readJson(file), path.basename(file)));

  const acceptKeys = accept instanceof Set ? accept : null;
  const acceptUsed = new Set();
  const sources = {};
  const classes = { forward: emptyCounts(), historical: emptyCounts(), warning: emptyCounts() };
  const findings = [];
  const accepted = [];
  const ctx = { today, postedDates };

  for (const r of refs) {
    let status;
    let rel = null;
    let mode = null;
    let cls;
    if (r.source === SOURCE_PATH) {
      status = exists(r.ref) ? 'exact' : 'missing';
      cls = { class: 'historical', reason: 'provenance-only' };
    } else {
      const res = classifyPhotoRef(index, r.ref, marker);
      status = res.status;
      rel = res.rel;
      mode = res.mode;
      cls = classify(r, status, ctx);
    }
    const acceptKey = status !== 'exact' ? matchAccepted(r.ref, acceptKeys) : null;
    if (acceptKey) acceptUsed.add(acceptKey);
    const isAccepted = acceptKey !== null;

    if (!sources[r.source]) sources[r.source] = { total: 0, exact: 0, case: 0, ambiguous: 0, missing: 0, unrooted: 0 };
    const s = sources[r.source];
    s.total += 1;
    s[status] += 1;
    if (mode === 'suffix' || mode === 'basename') s.unrooted += 1;

    const c = classes[cls.class];
    c.total += 1;
    c[status] += 1;
    if (isAccepted) c.accepted += 1;

    if (status !== 'exact') {
      const rec = {
        source: r.source, ref: r.ref, status, class: cls.class, reason: cls.reason,
        accepted: isAccepted, suggested: rel,
      };
      if (isAccepted) accepted.push(rec);
      else findings.push(rec);
    }
  }

  const totals = emptyCounts();
  delete totals.accepted;
  totals.unrooted = 0;
  for (const s of Object.values(sources)) {
    for (const k of ['total', ...STATUSES, 'unrooted']) totals[k] = (totals[k] || 0) + s[k];
  }
  const totalsByClass = Object.fromEntries(CLASSES.map((k) => [k, classes[k]]));
  const collisions = index.collisions;

  // Source audit of the gateable sources only: sourcePath is provenance and never gates.
  const gateable = (f) => f.source !== SOURCE_PATH;
  const failing = (f) => f.status !== 'exact';
  const failDefault = findings.filter((f) => gateable(f) && f.class === 'forward' && failing(f)).length;
  const failStrict = findings.filter((f) => gateable(f) && failing(f)).length;
  const gated = strict ? failStrict : failDefault;
  const exit = gated + collisions.length > 0 ? 2 : 0;
  const unusedAccept = acceptKeys ? [...acceptKeys].filter((k) => !acceptUsed.has(k)) : [];

  return {
    photos,
    today,
    mode: strict ? 'strict' : 'default',
    library: { files: index.files.length },
    collisions,
    sources,
    totals,
    classes: totalsByClass,
    gates: { default: { failing: failDefault }, strict: { failing: failStrict } },
    findings,
    accepted,
    unusedAccept,
    exit,
  };
}

function parseArgs(argv) {
  const args = {
    photos: '', manifest: null, cache: null, workbook: null, scan: [], json: false,
    strict: false, acceptFile: null, today: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--photos') args.photos = argv[++i] || '';
    else if (a === '--manifest') args.manifest = argv[++i] || '';
    else if (a === '--cache') args.cache = argv[++i] || '';
    else if (a === '--workbook') args.workbook = argv[++i] || '';
    else if (a === '--scan') args.scan.push(argv[++i] || '');
    else if (a === '--accept-missing') args.acceptFile = argv[++i] || '';
    else if (a === '--today') args.today = argv[++i] || '';
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.photos) {
    throw new Error('usage: photo-case-audit.mjs --photos <dir> [--manifest <json>] [--cache <json>] [--workbook <xlsx>] [--scan <json>]... [--strict] [--accept-missing <file>] [--today <YYYY-MM-DD>] [--json]');
  }
  if (args.today !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.today)) throw new Error(`--today must be YYYY-MM-DD: ${args.today}`);
  // The state files default to the project's state/ folder when they exist; explicit paths must exist.
  if (args.manifest === null && fs.existsSync(DEFAULT_MANIFEST)) args.manifest = DEFAULT_MANIFEST;
  if (args.cache === null && fs.existsSync(DEFAULT_CACHE)) args.cache = DEFAULT_CACHE;
  for (const f of [args.manifest, args.cache, args.workbook, args.acceptFile, ...args.scan]) {
    if (f && !fs.existsSync(f)) throw new Error(`file not found: ${f}`);
  }
  return args;
}

function table(head, rows) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  return [line(head), ...rows.map(line)];
}

function printTable(report) {
  const head = ['source', 'refs', 'exact', 'case-only', 'missing', 'ambig', 'unrooted'];
  const rows = Object.entries(report.sources).map(([name, s]) => [name, s.total, s.exact, s.case, s.missing, s.ambiguous, s.unrooted]);
  rows.push(['TOTAL', report.totals.total, report.totals.exact, report.totals.case, report.totals.missing, report.totals.ambiguous, report.totals.unrooted]);
  console.log(`photo-case-audit: library ${report.photos} (${report.library.files} files), today=${report.today} (America/Chicago), mode=${report.mode}`);
  for (const line of table(head, rows)) console.log(line);

  const classRows = CLASSES.map((k) => {
    const c = report.classes[k];
    return [k, c.total, c.exact, c.case, c.missing, c.ambiguous, c.accepted];
  });
  console.log('');
  for (const line of table(['class', 'refs', 'exact', 'case-only', 'missing', 'ambig', 'accepted'], classRows)) console.log(line);

  console.log('');
  console.log(`gate default (fail on forward refs):      ${report.gates.default.failing} failing`);
  console.log(`gate --strict (fail on any non-exact):    ${report.gates.strict.failing} failing`);
  console.log(`collisions (same folder, names differ only by case): ${report.collisions.length}`);
  for (const c of report.collisions.slice(0, 5)) console.log(`  [collision] ${c.dir}: ${c.names.join(' | ')}`);

  const forwardFail = report.findings.filter((f) => f.class === 'forward' && f.source !== SOURCE_PATH);
  console.log(`forward, not exact (${forwardFail.length}):`);
  for (const f of forwardFail.slice(0, 30)) {
    const fix = f.suggested ? ` -> ${f.suggested}` : '';
    console.log(`  [forward ${f.status}] ${f.source}: ${f.ref}${fix}`);
  }
  const warnings = report.findings.filter((f) => f.class !== 'forward');
  console.log(`historical or warning, not exact (${warnings.length}, reported only):`);
  const byReason = {};
  for (const w of warnings) {
    const k = `${w.source} | ${w.class} | ${w.reason} | ${w.status}`;
    byReason[k] = (byReason[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(byReason)) console.log(`  ${n} x ${k}`);
  if (report.accepted.length) {
    console.log(`accepted (Carter-approved, excluded from both gates): ${report.accepted.length}`);
    for (const a of report.accepted) console.log(`  [accepted ${a.class} ${a.status}] ${a.source}: ${a.ref}`);
  }
  for (const k of report.unusedAccept) console.log(`  [accept-list entry matched nothing] ${k}`);
  const gate = report.mode;
  const failing = report.gates[gate === 'strict' ? 'strict' : 'default'].failing;
  console.log(report.exit === 0
    ? `result: ${gate} gate clean (exit 0)`
    : `result: ${gate} gate FAILS: ${failing} failing reference(s)${report.collisions.length ? ` + ${report.collisions.length} collision(s)` : ''} (exit ${report.exit})`);
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
    const accept = args.acceptFile ? parseAcceptList(fs.readFileSync(args.acceptFile, 'utf8')) : null;
    const report = runAudit({
      photos: args.photos,
      manifest: args.manifest,
      cache: args.cache,
      workbook: args.workbook,
      scan: args.scan,
      strict: args.strict,
      accept,
      today: args.today || chicagoToday(),
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printTable(report);
    process.exitCode = report.exit;
  } catch (err) {
    console.error(`photo-case-audit failed: ${err.message}`);
    process.exitCode = 1;
  }
}
