// scripts/lib/gbp-paths.mjs
// Resolve GBP photo folders without requiring E: or H: to be mounted.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_GBP_LOCAL_CACHE =
  'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos';
// Curated lives under the local cache; E: was a drive letter that no longer exists
// on this box (2026-08-29). resolveWritableCuratedFolder still falls back if absent.
export const DEFAULT_GBP_CURATED_FOLDER = path.join(DEFAULT_GBP_LOCAL_CACHE, 'Curated');

export function defaultGbpPhotoDirs(env = process.env) {
  return {
    localCache: env.GBP_PHOTOS_LOCAL_CACHE || DEFAULT_GBP_LOCAL_CACHE,
    curatedPreferred: env.GBP_CURATED_FOLDER || DEFAULT_GBP_CURATED_FOLDER,
  };
}

// mkdir recursive still throws ENOENT when the drive letter does not exist.
export function resolveWritableCuratedFolder({
  curatedPreferred,
  localCache,
  mkdirSync = (dir, opts) => fs.mkdirSync(dir, opts),
} = {}) {
  const fallbacks = [
    curatedPreferred,
    localCache ? path.join(localCache, 'Curated') : '',
    localCache,
  ].filter(Boolean);
  const errors = [];
  for (const dir of fallbacks) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch (e) {
      errors.push(`${dir}: ${e.message}`);
    }
  }
  throw new Error(`No writable GBP photo folder. Tried: ${errors.join('; ')}`);
}

export function existingPhotoSearchDirs({ curatedDir, localCache, curatedPreferred } = {}) {
  const dirs = [curatedDir, curatedPreferred, localCache && path.join(localCache, 'Curated'), localCache];
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (fs.existsSync(dir)) out.push(dir);
  }
  return out;
}

const IMAGE_NAME_RE = /\.(jpe?g|png|webp)$/i;

export function resolveGbpImagePath(imagePath, { date, curatedDir, localCache, curatedPreferred } = {}) {
  const candidates = [];
  if (imagePath) {
    candidates.push(imagePath);
    const base = path.basename(imagePath);
    for (const dir of existingPhotoSearchDirs({ curatedDir, localCache, curatedPreferred })) {
      candidates.push(path.join(dir, base));
    }
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  if (date) {
    const prefix = `${date}-`.toLowerCase();
    for (const dir of existingPhotoSearchDirs({ curatedDir, localCache, curatedPreferred })) {
      try {
        const hit = fs.readdirSync(dir)
          .filter((f) => f.toLowerCase().startsWith(prefix) && IMAGE_NAME_RE.test(f))
          .sort()[0];
        if (hit) return path.join(dir, hit);
      } catch { /* unreadable dir */ }
    }
  }
  return imagePath || '';
}
