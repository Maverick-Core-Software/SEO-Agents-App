#!/usr/bin/env node
/**
 * verify-photo-ingestion.mjs
 * Read-only health check for the phone → Drive → cache ingestion path.
 *
 * Reports:
 *   - Photo counts in Drive folder vs local cache (detects stale sync)
 *   - 5 most-recently-added cache files (confirm Shortcut uploads landed)
 *   - HEIC presence + heic-convert availability (silent score-0 risk)
 *
 * No writes. No network. Safe to run anytime.
 *
 * Usage:
 *   node scripts/verify-photo-ingestion.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Load .env ──────────────────────────────────────────────────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const DRIVE_FOLDER = process.env.GBP_PHOTOS_FOLDER || 'H:\\My Drive\\GBP Photos';
const LOCAL_CACHE = process.env.GBP_PHOTOS_LOCAL_CACHE
  || 'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos';
const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

let warnings = 0;
let errors = 0;

function info(msg) { console.log(`  ${msg}`); }
function warn(msg) { warnings++; console.log(`  ⚠️  ${msg}`); }
function err(msg) { errors++; console.log(`  ❌ ${msg}`); }

// ── Scan a folder for supported image files ───────────────────────────────────

function scanFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return { exists: false, files: [] };

  const files = fs.readdirSync(folderPath, { recursive: true, withFileTypes: false })
    .map(f => path.join(folderPath, f.toString()))
    .filter(f => {
      try {
        if (!fs.statSync(f).isFile()) return false;
        const ext = path.extname(f).toLowerCase();
        return SUPPORTED_EXTS.has(ext);
      } catch { return false; }
    })
    .map(f => {
      try {
        const stat = fs.statSync(f);
        return { filePath: f, filename: path.basename(f), size: stat.size, mtime: stat.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean);

  return { exists: true, files };
}

// ── Check heic-convert availability ───────────────────────────────────────────

function checkHeicConvert() {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('heic-convert');
    return { available: true, version: mod.version || 'unknown' };
  } catch {
    return { available: false };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== GBP Photo Ingestion Health Check ===\n`);

// 1. Drive folder
console.log(`Source (Google Drive): ${DRIVE_FOLDER}`);
const drive = scanFolder(DRIVE_FOLDER);
if (!drive.exists) {
  err(`Drive folder not found — Drive for Desktop may not be mounted.`);
  info(`Photos uploaded via the iOS Shortcut will not sync until Drive remounts.`);
} else {
  info(`${drive.files.length} photo(s) in Drive folder`);
}

// 2. Local cache
console.log(`\nCache (pipeline input): ${LOCAL_CACHE}`);
const cache = scanFolder(LOCAL_CACHE);
if (!cache.exists) {
  err(`Local cache folder not found — the photo picker will fail entirely.`);
} else {
  info(`${cache.files.length} photo(s) in local cache`);
}

// 3. Delta
if (drive.exists && cache.exists) {
  const driveNames = new Set(drive.files.map(f => `${f.filename}:${f.size}`));
  const cacheNames = new Set(cache.files.map(f => `${f.filename}:${f.size}`));
  const inDriveOnly = drive.files.filter(f => !cacheNames.has(`${f.filename}:${f.size}`));
  const inCacheOnly = cache.files.filter(f => !driveNames.has(`${f.filename}:${f.size}`));

  if (inDriveOnly.length === 0 && inCacheOnly.length === 0) {
    info(`Drive and cache are in sync.`);
  } else {
    if (inDriveOnly.length > 0) {
      warn(`${inDriveOnly.length} photo(s) in Drive but NOT in cache (sync needed)`);
    }
    if (inCacheOnly.length > 0) {
      info(`${inCacheOnly.length} photo(s) in cache but not in Drive (deleted from Drive or pre-existing)`);
    }
  }
}

// 4. Most recent cache files
if (cache.exists && cache.files.length > 0) {
  console.log(`\n5 most recent cache files:`);
  const recent = [...cache.files].sort((a, b) => b.mtime - a.mtime).slice(0, 5);
  for (const f of recent) {
    const ageHours = Math.round((Date.now() - f.mtime) / 3600000);
    const ageLabel = ageHours < 1 ? 'just now'
      : ageHours < 24 ? `${ageHours}h ago`
      : `${Math.round(ageHours / 24)}d ago`;
    info(`${f.filename}  (${(f.size / 1024).toFixed(0)} KB, ${ageLabel})`);
  }
}

// 5. HEIC check
const heicFiles = cache.exists ? cache.files.filter(f => {
  const ext = path.extname(f.filename).toLowerCase();
  return ext === '.heic' || ext === '.heif';
}) : [];

if (heicFiles.length > 0) {
  console.log(`\nHEIC photos: ${heicFiles.length} file(s) in cache`);
  const hc = checkHeicConvert();
  if (hc.available) {
    info(`heic-convert available (v${hc.version}) — HEIC photos will be scored normally.`);
  } else {
    warn(`heic-convert NOT installed — HEIC photos will silently score 0 and be excluded from picks.`);
    info(`Fix: npm install heic-convert  (in this project root)`);
  }
}

// 6. Summary
console.log(`\n${'─'.repeat(50)}`);
if (errors > 0) {
  console.log(`Result: ${errors} error(s), ${warnings} warning(s)`);
  process.exitCode = 1;
} else if (warnings > 0) {
  console.log(`Result: OK with ${warnings} warning(s)`);
} else {
  console.log(`Result: All clear ✓`);
}
console.log();
