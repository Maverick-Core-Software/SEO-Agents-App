#!/usr/bin/env node
// Rekey SEO state files from an old (Windows) photo root to a new (posix) root.
//
//   node scripts/ops/rekey-state.mjs --from 'C:\Workspace\...\GBP Post Photos' --to /srv/seo/photos [--apply] [--state-dir <dir>]
//
// Rewrites:
//   - state/photo-cache.json: object keys (file paths) under --from become --to
//     (inside each value, a string `filePath` under --from is rewritten too).
//   - state/photo-selection-manifest.json: `photoPath` on every entry under --from.
// Case fix: after a path is rewritten under --to (or already is), if the exact-case file is
// missing but a case-only match exists on disk under --to, the path takes the on-disk casing
// ("case-fixed"). Windows names can differ in case from the Linux files; see photo-case-audit.mjs.
// Never touches hash, score or any other field.
// Dry-run by default. --apply writes <file>.bak-<ts> before replacing a file that
// has changes. Idempotent: a second --apply finds nothing to change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCaseFixer } from '../lib/photo-case.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const CACHE_NAME = 'photo-cache.json';
const MANIFEST_NAME = 'photo-selection-manifest.json';

export function normalizeSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

function trimTrailingSlashes(p) {
  return p.replace(/\/+$/, '');
}

/**
 * Returns `value` with the `fromRoot` prefix replaced by `toRoot`, or null when
 * `value` is not a path under `fromRoot`. Comparison is on backslash-normalized
 * strings and case-insensitive (Windows). A sibling such as "GBP Post Photos2"
 * is not a match.
 */
export function rekeyPath(value, fromRoot, toRoot) {
  if (typeof value !== 'string' || value === '') return null;
  const from = trimTrailingSlashes(normalizeSlashes(fromRoot));
  const to = trimTrailingSlashes(normalizeSlashes(toRoot));
  const v = normalizeSlashes(value);
  if (from === '' || v.length < from.length) return null;
  if (v.slice(0, from.length).toLowerCase() !== from.toLowerCase()) return null;
  const rest = v.slice(from.length);
  if (rest !== '' && rest[0] !== '/') return null;
  return to + rest;
}

/**
 * Target for one stored path: rekeyed under toRoot when it is under fromRoot, kept when it is
 * already under toRoot, otherwise null. fixCase (optional) then applies the on-disk casing.
 * Returns { path, moved, caseFixed } or null.
 */
export function retarget(p, fromRoot, toRoot, fixCase = null) {
  if (typeof p !== 'string' || p === '') return null;
  let next = rekeyPath(p, fromRoot, toRoot);
  const moved = next !== null;
  if (!moved) {
    const to = trimTrailingSlashes(normalizeSlashes(toRoot));
    const v = normalizeSlashes(p);
    if (to === '' || v.slice(0, to.length) !== to || v[to.length] !== '/') return null;
    next = p;
  }
  const fixed = fixCase ? fixCase(next) : null;
  const caseFixed = fixed !== null && fixed !== next;
  return { path: caseFixed ? fixed : next, moved, caseFixed };
}

function emptyStats() {
  return { total: 0, rewritten: 0, unchanged: 0, collisions: 0, valueFilePaths: 0, caseFixed: 0, changed: 0 };
}

/**
 * Rekeys a photo-cache object. Returns { out, stats, samples }. Input is not mutated.
 * stats.changed counts renamed keys plus rewritten value.filePath fields (case fixes included).
 */
export function rekeyCache(cache, fromRoot, toRoot, fixCase = null) {
  const stats = emptyStats();
  const samples = [];
  const out = {};
  const entries = Object.entries(cache || {});
  stats.total = entries.length;
  for (const [key, value] of entries) {
    let nextValue = value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const file = retarget(value.filePath, fromRoot, toRoot, fixCase);
      if (file && file.path !== value.filePath) {
        nextValue = { ...value, filePath: file.path };
        stats.changed += 1;
        if (file.moved) stats.valueFilePaths += 1;
        if (file.caseFixed) stats.caseFixed += 1;
      }
    }
    const target = retarget(key, fromRoot, toRoot, fixCase);
    const newKey = target ? target.path : key;
    if (newKey === key) {
      out[key] = nextValue;
      stats.unchanged += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(cache, newKey) || Object.prototype.hasOwnProperty.call(out, newKey)) {
      // Target key already exists: keep the old key untouched rather than overwrite data.
      out[key] = nextValue;
      stats.collisions += 1;
      continue;
    }
    out[newKey] = nextValue;
    stats.changed += 1;
    if (target.moved) stats.rewritten += 1;
    if (target.caseFixed) stats.caseFixed += 1;
    if (samples.length < 3) samples.push({ from: key, to: newKey });
  }
  return { out, stats, samples };
}

/** Rekeys manifest `photoPath` fields. Accepts {version, platforms:{...}} or a plain array. */
export function rekeyManifest(manifest, fromRoot, toRoot, fixCase = null) {
  const stats = { entries: 0, rewritten: 0, unchanged: 0, caseFixed: 0, changed: 0 };
  const samples = [];
  const next = JSON.parse(JSON.stringify(manifest));
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    stats.entries += 1;
    const target = retarget(entry.photoPath, fromRoot, toRoot, fixCase);
    if (target === null || target.path === entry.photoPath) {
      stats.unchanged += 1;
      return;
    }
    if (samples.length < 3) samples.push({ from: entry.photoPath, to: target.path });
    entry.photoPath = target.path;
    stats.changed += 1;
    if (target.moved) stats.rewritten += 1;
    if (target.caseFixed) stats.caseFixed += 1;
  };
  if (Array.isArray(next)) {
    next.forEach(visit);
  } else if (next && typeof next === 'object' && next.platforms && typeof next.platforms === 'object') {
    for (const list of Object.values(next.platforms)) [].concat(list || []).forEach(visit);
  } else {
    throw new Error('manifest has an unrecognized shape (expected an array or { platforms: {...} })');
  }
  return { out: next, stats, samples };
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { data: JSON.parse(raw), trailingNewline: raw.endsWith('\n') };
}

function serialize(data, trailingNewline) {
  return JSON.stringify(data, null, 2) + (trailingNewline ? '\n' : '');
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function stampFor(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Runs the rekey over <stateDir>. Returns a report; writes only when apply=true
 * and a file has changes. Throws on unreadable JSON or unknown manifest shape.
 */
export function runRekey({ stateDir, from, to, apply = false, now = new Date() }) {
  if (!from || !to) throw new Error('--from and --to are required');
  const report = { apply, changes: 0, cache: null, manifest: null, written: [], backups: [] };
  const cacheFile = path.join(stateDir, CACHE_NAME);
  const manifestFile = path.join(stateDir, MANIFEST_NAME);
  const plans = [];
  const fixCase = makeCaseFixer(to);

  if (fs.existsSync(cacheFile)) {
    const { data, trailingNewline } = readJson(cacheFile);
    const result = rekeyCache(data, from, to, fixCase);
    const changed = result.stats.changed;
    report.cache = { ...result.stats, samples: result.samples };
    report.changes += changed;
    if (changed > 0) plans.push({ file: cacheFile, data: result.out, trailingNewline });
  }

  if (fs.existsSync(manifestFile)) {
    const { data, trailingNewline } = readJson(manifestFile);
    const result = rekeyManifest(data, from, to, fixCase);
    report.manifest = { ...result.stats, samples: result.samples };
    report.changes += result.stats.changed;
    if (result.stats.changed > 0) plans.push({ file: manifestFile, data: result.out, trailingNewline });
  }

  if (!report.cache && !report.manifest) {
    throw new Error(`no ${CACHE_NAME} or ${MANIFEST_NAME} under ${stateDir}`);
  }

  if (apply) {
    for (const plan of plans) {
      const backup = `${plan.file}.bak-${stampFor(now)}`;
      fs.copyFileSync(plan.file, backup);
      report.backups.push(backup);
      writeAtomic(plan.file, serialize(plan.data, plan.trailingNewline));
      report.written.push(plan.file);
    }
  }
  return report;
}

function parseArgs(argv) {
  const args = { from: '', to: '', apply: false, stateDir: path.join(PROJECT_ROOT, 'state') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--from') args.from = argv[++i] || '';
    else if (a === '--to') args.to = argv[++i] || '';
    else if (a === '--state-dir') args.stateDir = argv[++i] || '';
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.from || !args.to) throw new Error('usage: rekey-state.mjs --from <oldRoot> --to <newRoot> [--apply] [--state-dir <dir>]');
  return args;
}

function printReport(report) {
  const mode = report.apply ? 'APPLY' : 'DRY-RUN (no files written; pass --apply)';
  console.log(`rekey-state ${mode}`);
  if (report.cache) {
    const c = report.cache;
    console.log(`photo-cache.json: keys=${c.total} rewritten=${c.rewritten} unchanged=${c.unchanged} collisions=${c.collisions} value.filePath=${c.valueFilePaths} case-fixed=${c.caseFixed}`);
  }
  if (report.manifest) {
    const m = report.manifest;
    console.log(`photo-selection-manifest.json: entries=${m.entries} photoPath rewritten=${m.rewritten} unchanged=${m.unchanged} case-fixed=${m.caseFixed}`);
  }
  console.log(`total changes=${report.changes}`);
  for (const b of report.backups) console.log(`backup: ${b}`);
  for (const w of report.written) console.log(`written: ${w}`);
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
    process.exit(2);
  }
  try {
    printReport(runRekey({ stateDir: args.stateDir, from: args.from, to: args.to, apply: args.apply }));
  } catch (err) {
    console.error(`rekey-state failed: ${err.message}`);
    process.exit(1);
  }
}
