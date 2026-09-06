// scripts/lib/gbp-paths.mjs
// Resolve GBP photo folders without requiring E: or H: to be mounted.
import fs from 'node:fs';
import path from 'node:path';
import { derivePostServiceType, SERVICE_TYPE_KEYWORDS } from './photo-selection.mjs';

export const DEFAULT_GBP_LOCAL_CACHE =
  'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos';
// Curated lives under the local cache; E: was a drive letter that no longer exists
// on this box (2026-08-29). Keep it as a last-resort path if it ever remounts.
export const DEFAULT_GBP_CURATED_FOLDER = path.join(DEFAULT_GBP_LOCAL_CACHE, 'Curated');
export const LEGACY_GBP_CURATED_FOLDER = 'E:\\Media\\Grizzly\\Curated';

const IMAGE_NAME_RE = /\.(jpe?g|png|webp)$/i;

export function firstExistingDir(candidates = [], existsSync = (dir) => fs.existsSync(dir)) {
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return dir;
  }
  return '';
}

export function defaultGbpPhotoDirs(env = process.env) {
  const localCache = firstExistingDir([
    env.GBP_PHOTOS_LOCAL_CACHE,
    DEFAULT_GBP_LOCAL_CACHE,
  ]) || env.GBP_PHOTOS_LOCAL_CACHE || DEFAULT_GBP_LOCAL_CACHE;

  const curatedPreferred = firstExistingDir([
    env.GBP_CURATED_FOLDER,
    DEFAULT_GBP_CURATED_FOLDER,
    localCache ? path.join(localCache, 'Curated') : '',
    LEGACY_GBP_CURATED_FOLDER,
  ]) || env.GBP_CURATED_FOLDER || DEFAULT_GBP_CURATED_FOLDER;

  return { localCache, curatedPreferred };
}

// Config may still name the dead E: folder. Prefer any folder that actually
// exists; E: wins only when it is mounted.
export function resolveConfiguredCuratedFolder(configFolder, env = process.env) {
  const dirs = defaultGbpPhotoDirs(env);
  return firstExistingDir([
    configFolder,
    env.GBP_CURATED_FOLDER,
    dirs.curatedPreferred,
    dirs.localCache ? path.join(dirs.localCache, 'Curated') : '',
    DEFAULT_GBP_CURATED_FOLDER,
    LEGACY_GBP_CURATED_FOLDER,
  ]) || dirs.curatedPreferred;
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
    DEFAULT_GBP_CURATED_FOLDER,
    LEGACY_GBP_CURATED_FOLDER,
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

function listImageNames(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => IMAGE_NAME_RE.test(f)).sort();
  } catch {
    return [];
  }
}

function stablePick(files, seed) {
  if (!files.length) return '';
  const s = String(seed || '0');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return files[h % files.length];
}

function filenameMatchesService(filename, serviceType) {
  if (!filename || !serviceType || serviceType === 'other') return false;
  const low = filename.toLowerCase();
  if (low.includes(serviceType)) return true;
  const keywords = SERVICE_TYPE_KEYWORDS[serviceType] || [];
  return keywords.some((keyword) => {
    const token = String(keyword || '').toLowerCase().trim();
    if (token.length < 4) return false;
    return low.includes(token) || low.includes(token.replace(/\s+/g, '-'));
  });
}

// When the workbook path is a renamed/missing file, pick a real curated still.
// Prefer a service match from the topic/caption; otherwise any unused image.
export function pickCuratedFallbackPhoto({
  date,
  topic,
  caption,
  service,
  curatedDir,
  localCache,
  curatedPreferred,
  usedPaths = [],
} = {}) {
  const used = new Set(
    (usedPaths || []).map((p) => path.basename(String(p || '')).toLowerCase()).filter(Boolean),
  );
  const serviceType = derivePostServiceType({
    service: service || '',
    topic: topic || '',
    headline: topic || '',
    body: caption || '',
  });
  const dirs = existingPhotoSearchDirs({ curatedDir, localCache, curatedPreferred });
  const curatedDirs = dirs.filter((dir) => /(^|[\\/])Curated$/i.test(dir));
  const scanDirs = curatedDirs.length ? curatedDirs : dirs;
  const matched = [];
  const any = [];
  for (const dir of scanDirs) {
    for (const name of listImageNames(dir)) {
      if (used.has(name.toLowerCase())) continue;
      const full = path.join(dir, name);
      any.push(full);
      if (filenameMatchesService(name, serviceType)) matched.push(full);
    }
  }
  const seed = date || topic || caption || 'gbp';
  return stablePick(matched, seed) || stablePick(any, seed) || '';
}

export function resolveGbpImagePath(imagePath, {
  date,
  topic,
  caption,
  service,
  curatedDir,
  localCache,
  curatedPreferred,
  usedPaths,
} = {}) {
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
      const hit = listImageNames(dir)
        .filter((f) => f.toLowerCase().startsWith(prefix))[0];
      if (hit) return path.join(dir, hit);
    }
  }
  const fallback = pickCuratedFallbackPhoto({
    date, topic, caption, service, curatedDir, localCache, curatedPreferred, usedPaths,
  });
  if (fallback) return fallback;
  return imagePath || '';
}
