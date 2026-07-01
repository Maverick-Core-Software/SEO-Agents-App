#!/usr/bin/env node
/**
 * sync-photos-from-drive.mjs
 * ----------------------------------------------------------------------------
 * Pre-run photo sync: mirrors the Google Drive "GBP Photos" folder into the
 * always-available local cache, so the Friday 8:30 research run and the later
 * photo-pick both see the FULL library — not just whatever Drive had mounted
 * the last time someone ran the picker.
 *
 * WHY THIS IS A SEPARATE TASK: Google Drive only mounts H: while its desktop
 * app is running. The picker's built-in sync runs at *approval* time (whenever
 * you click approve — could be hours after 8:30), so photos added between
 * Friday morning and your approval were a roll of the dice. This task fires at
 * 08:25, five minutes before the research run, guaranteeing a fresh cache with
 * Friday-morning photos already in it. It's idempotent and additive (never
 * deletes), so running it again later (the picker also syncs) is harmless.
 *
 * Registered by setup-scheduled-tasks.ps1 alongside the weekly run + monitor.
 * Safe to run manually any time:  node scripts/sync-photos-from-drive.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Load .env (force-override — see gbp-photo-pick.mjs for the same rationale).
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

function log(msg) {
  console.log(`[photo-sync ${new Date().toISOString()}] ${msg}`);
}

function isImage(f) {
  const ext = path.extname(f).toLowerCase();
  if (SUPPORTED_EXTS.has(ext)) return true;
  // Drive sometimes strips extensions — accept obvious image names as a fallback.
  if (ext === '') return /\.(jpe?g|png|heic|heif|webp)$/i.test(f);
  return false;
}

function main() {
  if (!fs.existsSync(DRIVE_FOLDER)) {
    // Not fatal — the cache from last sync still exists. The picker will use it.
    log(`Drive not mounted (${DRIVE_FOLDER}) — skipping sync, local cache unchanged.`);
    log(`Open Google Drive for Desktop to re-mount, then re-run.`);
    return;
  }
  fs.mkdirSync(LOCAL_CACHE, { recursive: true });

  const driveFiles = fs.readdirSync(DRIVE_FOLDER, { recursive: true, withFileTypes: false })
    .map(f => path.join(DRIVE_FOLDER, f.toString()))
    .filter(f => { try { return fs.statSync(f).isFile() && isImage(f); } catch { return false; } });

  let added = 0, updated = 0, skipped = 0;
  for (const src of driveFiles) {
    const name = path.basename(src);
    const dest = path.join(LOCAL_CACHE, name);
    try {
      const srcSize = fs.statSync(src).size;
      if (fs.existsSync(dest) && fs.statSync(dest).size === srcSize) { skipped++; continue; }
      fs.copyFileSync(src, dest);
      if (fs.existsSync(dest) && fs.statSync(dest).size === srcSize) {
        // Was it new or an update? Approximate by prior existence.
        updated++; // counted as updated for simplicity; new vs updated distinction isn't actionable here
      } else { added++; }
    } catch (e) {
      log(`skip ${name}: ${e.message}`);
    }
  }
  const totalLocal = fs.readdirSync(LOCAL_CACHE).filter(f => isImage(f)).length;
  log(`Drive ${driveFiles.length} photos → added/updated ${added + updated}, unchanged ${skipped}. Local cache now ${totalLocal} photos.`);
}

try { main(); } catch (e) { log(`FATAL: ${e.message}`); process.exit(1); }
