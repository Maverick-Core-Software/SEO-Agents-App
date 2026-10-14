// scripts/lib/photo-case.mjs
// Case-exact resolution of stored photo references against the on-disk photo library.
// The library was written on Windows (case-insensitive), so a stored name can differ in
// case from the file on disk; Linux (case-sensitive) then fails an exact fs lookup.
// The index is built once from a walk, so every lookup after that is pure and cheap.
import fs from 'node:fs';
import path from 'node:path';

export const PHOTO_EXT_RE = /\.(jpe?g|png|heic|heif|webp|gif|tiff?)$/i;

/** Comparison key used for case-insensitive matching (NFC, lower-cased). */
export function caseKey(name) {
  return String(name).normalize('NFC').toLowerCase();
}

/** Segments of a stored path, splitting on either separator. */
export function splitSegments(p) {
  return String(p ?? '').split(/[\\/]+/).filter(Boolean);
}

/**
 * Walks `root` once. Returns:
 *   exists      false when root is missing or unreadable (index is empty)
 *   dirs        Map<relDir, Array<{name, isDir}>>; relDir is '/'-joined, '' for the root
 *   files       Array<relFile>
 *   byBase      Map<caseKey(basename), relFile[]>
 *   collisions  [{ dir, names }]: names in one folder that differ only by case
 */
export function buildPhotoIndex(root) {
  const dirs = new Map();
  let exists = true;
  const walk = (rel) => {
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      if (rel === '') exists = false;
      dirs.set(rel, []);
      return;
    }
    dirs.set(rel, entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })));
    for (const e of entries) {
      if (e.isDirectory()) walk(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk('');
  return indexFromDirs(dirs, exists);
}

/**
 * Index from a plain folder map: dirs is Map<relDir, Array<{name, isDir}>> with '' for the root.
 * buildPhotoIndex walks the disk into this shape; tests can pass a hand-made map.
 */
export function indexFromDirs(dirs, exists = true) {
  const files = [];
  for (const [dir, entries] of dirs) {
    for (const e of entries) {
      if (!e.isDir) files.push(dir ? `${dir}/${e.name}` : e.name);
    }
  }

  const byBase = new Map();
  for (const rel of files) {
    const key = caseKey(rel.split('/').pop());
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(rel);
  }

  const collisions = [];
  for (const [dir, entries] of dirs) {
    const groups = new Map();
    for (const e of entries) {
      const key = caseKey(e.name);
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(e.name);
    }
    for (const names of groups.values()) {
      if (names.size > 1) collisions.push({ dir: dir || '.', names: [...names].sort() });
    }
  }

  return { exists, dirs, files, byBase, collisions };
}

/**
 * Resolves path segments inside the index, one folder at a time.
 * Returns { status: 'exact'|'case'|'ambiguous'|'missing', rel }, where rel is the on-disk
 * '/'-joined path (exact casing) when the status is 'exact' or 'case'.
 */
export function resolveInIndex(index, segs) {
  if (!segs.length) return { status: 'missing', rel: null };
  let dir = '';
  const onDisk = [];
  let inexact = false;
  for (let i = 0; i < segs.length; i += 1) {
    const isLast = i === segs.length - 1;
    const entries = index.dirs.get(dir) || [];
    const typeOk = (e) => (isLast ? !e.isDir : e.isDir);
    let hit = entries.find((e) => e.name === segs[i] && typeOk(e));
    if (!hit) {
      const cands = entries.filter((e) => caseKey(e.name) === caseKey(segs[i]) && typeOk(e));
      if (cands.length > 1) return { status: 'ambiguous', rel: null };
      if (cands.length === 1) {
        [hit] = cands;
        inexact = true;
      }
    }
    if (!hit) return { status: 'missing', rel: null };
    onDisk.push(hit.name);
    dir = dir ? `${dir}/${hit.name}` : hit.name;
  }
  return { status: inexact ? 'case' : 'exact', rel: onDisk.join('/') };
}

function basenameLookup(index, name) {
  const hits = index.byBase.get(caseKey(name)) || [];
  const exact = hits.filter((rel) => rel.split('/').pop() === name);
  if (exact.length) return { status: 'exact', rel: exact[0] };
  if (hits.length === 1) return { status: 'case', rel: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', rel: null };
  return { status: 'missing', rel: null };
}

/**
 * Classifies one stored photo reference (any path or bare file name) against the index.
 *   marker  the library folder's own name (e.g. "GBP Post Photos"); when a reference contains
 *           it, the part after its last occurrence is resolved strictly under the library root.
 * `mode` says how the reference was matched: 'rooted' (marker found), 'suffix' (no marker; the
 * longest resolvable tail was used), or 'basename' (a bare file name, found anywhere in the tree).
 */
export function classifyPhotoRef(index, ref, marker = '') {
  const segs = splitSegments(ref);
  if (!segs.length) return { status: 'missing', rel: null, mode: 'empty' };
  if (segs.length === 1) return { ...basenameLookup(index, segs[0]), mode: 'basename' };

  if (marker) {
    for (let i = segs.length - 2; i >= 0; i -= 1) {
      if (caseKey(segs[i]) === caseKey(marker)) {
        return { ...resolveInIndex(index, segs.slice(i + 1)), mode: 'rooted' };
      }
    }
  }

  let caseHit = null;
  let ambiguous = false;
  for (let k = 0; k < segs.length - 1; k += 1) {
    const r = resolveInIndex(index, segs.slice(k));
    if (r.status === 'exact') return { ...r, mode: 'suffix' };
    if (r.status === 'case' && !caseHit) caseHit = r;
    if (r.status === 'ambiguous') ambiguous = true;
  }
  if (caseHit) return { ...caseHit, mode: 'suffix' };
  return { status: ambiguous ? 'ambiguous' : 'missing', rel: null, mode: 'suffix' };
}

/**
 * Builds a resolver for rekey --apply: given a rewritten path under `root` (as a posix-style
 * string), returns the same path with the on-disk casing when only the case differs,
 * otherwise null (already exact, missing, or ambiguous). `root` may not exist yet.
 */
export function makeCaseFixer(root) {
  const index = buildPhotoIndex(root);
  const base = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  return (p) => {
    if (typeof p !== 'string' || !index.exists) return null;
    const v = p.replace(/\\/g, '/');
    if (v.slice(0, base.length) !== base || v[base.length] !== '/') return null;
    const rest = splitSegments(v.slice(base.length));
    const r = resolveInIndex(index, rest);
    if (r.status !== 'case') return null;
    return `${base}/${r.rel}`;
  };
}
