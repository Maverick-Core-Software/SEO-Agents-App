// scripts/lib/photo-selection.mjs
//
// The ONE selection path for GBP and Facebook photos (PLAN 6 P2.3), plus the
// hash/label plumbing the pickers need (P2.2, P2.4).
//
// Contract for callers (gbp-photo-pick.mjs, fb-photo-pick.mjs):
//   labels   = loadCuratedLabels(state/curated-labels.json)   // missing => filename fallback, flagged unverified
//   alowlist = loadCompatAllowlist(state/photo-compat-allowlist.json) // empty/missing => cross-topic blocked
//   manifest = loadSelectionManifest(file, { platform })      // array | platform-keyed file
//   pick post = selectPhotoCandidatesForPost({ post, pool, history, labels, allowlist, ... })
//   verify   = verifyPhotoCandidates({ candidates, hook, service, visionClient, allowlistPhoto })
//   write    = saveSelectionManifest / reservePhotoHashes     // platform-keyed, locked, atomic
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared, deterministic rules for photo-to-post compatibility.
 *
 * The vision model may suggest candidates, but downstream publishers only
 * trust a photo that gbp-photo-pick recorded in the selection manifest.
 *
 * P2.3 rules enforced here: a structured service key decided title-first, an
 * allowed-label table per key, no silent cross-topic fallback (only Carter's
 * allowlist file may name a pair), commercial context as an explicit tag, and
 * content-hash no-reuse for 8 weeks with unknown history reported explicitly.
 */

export const SERVICE_TYPE_KEYWORDS = {
  // More specific terms come first so "generator panel" is not classified as
  // a generic panel post.
  generator: ['generator', 'standby', 'backup power', 'transfer switch', 'inlet box', 'interlock', 'whole-home generator'],
  'ev-charger': ['ev', 'charger', 'electric vehicle', 'level 2', 'charging station', 'tesla'],
  lighting: ['light', 'fixture', 'recessed', 'ceiling fan', 'dimmer', 'lamp', 'led', 'illuminat'],
  wiring: ['wiring', 'wire', 'conduit', 'romex', 'junction', 'rewir'],
  outlet: ['outlet', 'gfci', 'receptacle', 'plug', 'usb', 'dedicated circuit'],
  surge: ['surge', 'whole-home surge', 'surge protector'],
  'smoke-co': ['smoke detector', 'smoke alarm', 'carbon monoxide', 'smoke-co', 'co detector'],
  panel: ['panel', 'breaker', 'main panel', 'subpanel', 'electrical panel', 'box'],
};

/** The taxonomy PLAN 6 P2.1 uses for labels. Only these keys are comparable. */
export const SERVICE_KEYS = ['panel', 'generator', 'ev-charger', 'lighting', 'outlet', 'wiring', 'surge', 'smoke-co', 'other'];

/**
 * Which curated label keys may illustrate which service key. Same key only:
 * every cross-topic pair must be named in state/photo-compat-allowlist.json.
 * An unlabeled ("other") photo is cross-topic for a typed post on purpose.
 */
export const ALLOWED_LABELS = {
  panel: ['panel'],
  generator: ['generator'],
  'ev-charger': ['ev-charger'],
  lighting: ['lighting'],
  outlet: ['outlet'],
  wiring: ['wiring'],
  surge: ['surge'],
  'smoke-co': ['smoke-co'],
  other: [],
};

/** Caption-photo check budget: 3 candidates TOTAL per post (PLAN 6 P2.4). */
export const CAPTION_CHECK_MAX_CANDIDATES = 3;

export const NO_REUSE_WEEKS = 8;

export const EMPTY_LABELS = { present: false, byHash: new Map(), byPath: new Map(), byFilename: new Map(), size: 0 };
export const EMPTY_ALLOWLIST = { present: false, pairs: new Set(), raw: [] };

// Keyword hit with word boundaries. Short keywords ("ev", "led", "box") must be
// whole words — a plain substring test made "level", "prevent", "installed"
// and "every" count as EV-charger or lighting hits, which on 2026-09-11 typed a
// Federal Pacific panel post as ev-charger and handed it an EV photo. Longer
// keywords keep a leading boundary only so stems like "illuminat"/"rewir" work.
function hasKeyword(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = keyword.length <= 3
    ? `(^|[^a-z0-9])${escaped}($|[^a-z0-9])`
    : `(^|[^a-z0-9])${escaped}`;
  return new RegExp(pattern).test(text);
}

function typeFromText(text) {
  for (const [type, keywords] of Object.entries(SERVICE_TYPE_KEYWORDS)) {
    if (keywords.some(keyword => hasKeyword(text, keyword))) return type;
  }
  return 'other';
}

/**
 * The structured service key for a post: the title fields name the service; the
 * body mentions everything (a panel post discusses EV chargers). Title first,
 * body/caption only as the fixed fallback.
 */
export function serviceKeyForPost(post = {}) {
  const title = `${post.service || ''} ${post.topic || ''} ${post.headline || ''}`.toLowerCase();
  const fromTitle = typeFromText(title);
  if (fromTitle !== 'other') return { key: fromTitle, source: 'title' };
  const fromBody = typeFromText(`${title} ${post.body || ''} ${post.caption || ''}`.toLowerCase());
  if (fromBody !== 'other') return { key: fromBody, source: 'body' };
  return { key: 'other', source: 'none' };
}

export function derivePostServiceType(post = {}) {
  return serviceKeyForPost(post).key;
}

export function serviceSlug(service) {
  return (service || 'electrical')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

export function normalizeServiceKey(value) {
  const v = String(value || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
  if (!v) return 'other';
  if (SERVICE_KEYS.includes(v)) return v;
  if (v === 'ev' || v === 'evcharger' || v === 'charger' || v === 'ev-charging') return 'ev-charger';
  if (v === 'smoke' || v === 'co' || v === 'smoke-co-detector') return 'smoke-co';
  if (v === 'surge-protection') return 'surge';
  return 'other';
}

export function normalizePathKey(filePath) {
  if (!filePath) return '';
  return String(filePath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function comparablePath(filePath) {
  return normalizePathKey(filePath);
}

// ── Content hashes (P2.2) ───────────────────────────────────────────────────

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ponytail: whole-file sha256 in memory; switch to a streaming hash if the
// library ever holds files big enough to matter (photos are MBs, not GBs).
export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function hashOfEntry(entry = {}) {
  const h = entry.sourceHash || entry.photoHash || entry.hash || '';
  return String(h || '').toLowerCase();
}

/**
 * path → sha256 index. Callers build it once (hashFile is injectable so this
 * stays testable without touching disk); missing/unreadable files are reported
 * rather than silently dropped.
 */
export function pathToHashIndex(paths = [], { hashFile = sha256File } = {}) {
  const index = new Map();
  const errors = [];
  for (const p of paths) {
    if (!p) continue;
    const key = normalizePathKey(p);
    if (!key || index.has(key)) continue;
    try {
      index.set(key, String(hashFile(p)).toLowerCase());
    } catch (e) {
      errors.push({ path: p, error: e.message });
    }
  }
  return { index, errors };
}

/**
 * PURE history migration: rewrite path-based history references to hashes using
 * a prebuilt index. Entries whose paths are not in the index are left alone and
 * counted — that is the "unknown history" the caller must report, never hide.
 */
export function migrateHistoryToHashes(entries = [], { index = new Map() } = {}) {
  const migrated = [];
  const unresolved = [];
  let changed = 0;
  for (const entry of entries) {
    const next = { ...entry };
    for (const field of ['sourcePath', 'photoPath', 'curatedPath']) {
      const key = normalizePathKey(next[field]);
      if (!key) continue;
      const hash = index.get(key);
      if (hash) {
        if (field === 'sourcePath') next.sourceHash = hash;
        else next.photoHash = next.photoHash || hash;
        changed += 1;
      }
    }
    if (!next.sourceHash && !next.photoHash && (next.sourcePath || next.photoPath)) unresolved.push(next);
    migrated.push(next);
  }
  return { entries: migrated, unresolved, changed, unknownHistory: unresolved.length > 0 };
}

/**
 * Every identity key a selection is known by. The FB purge used to miss the
 * used-path keys (source path vs photo path vs filename), so a photo already
 * shipped could be handed out again; callers must check all of them.
 */
export function selectionIdentityKeys(entry = {}) {
  const keys = [];
  for (const value of [
    entry.sourcePath, entry.photoPath, entry.curatedPath,
    entry.sourceFilename, entry.photoFilename, entry.filename,
    entry.sourceHash, entry.photoHash, entry.hash,
  ]) {
    if (!value) continue;
    const key = String(value).includes('/') || String(value).includes('\\')
      ? normalizePathKey(value)
      : String(value).toLowerCase();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * 8-week, cross-platform content-hash no-reuse. Entries lacking any hash are
 * UNKNOWN, not free: they are counted and reported so the caller can say the
 * history is unverified instead of claiming a clean no-reuse check.
 */
export function hashConflicts({ hashes = [], history = [], now = Date.now(), weeks = NO_REUSE_WEEKS } = {}) {
  const windowMs = Math.max(0, Number(weeks) || 0) * 7 * 86400000;
  const conflicts = [];
  let noHash = 0;
  let noDate = 0;
  let considered = 0;
  for (const entry of history) {
    const hash = hashOfEntry(entry);
    if (!hash) { noHash += 1; continue; }
    const stamp = Date.parse(entry.selectedAt || entry.postDate || '') || 0;
    // No date cannot prove age: treat it as inside the window (conservative).
    if (!stamp) noDate += 1;
    if (stamp && now - stamp > windowMs) continue;
    considered += 1;
    if (hashes.map((h) => String(h).toLowerCase()).includes(hash)) conflicts.push({ hash, entry });
  }
  return {
    conflicts,
    considered,
    windowDays: Math.round(windowMs / 86400000),
    unknown: { noHash, noDate, unverifiedHistory: noHash > 0 },
  };
}

// ── Labels (P2.1 output, read side) ────────────────────────────────────────

function normalizeLabel(hash, item = {}) {
  const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t).toLowerCase()) : [];
  const declaredContext = String(item.context || '').toLowerCase();
  const context = declaredContext === 'commercial' || tags.includes('commercial') || tags.includes('business')
    ? 'commercial'
    : (declaredContext === 'residential' || tags.includes('residential') ? 'residential' : 'unknown');
  return {
    hash: hash ? String(hash).toLowerCase() : '',
    key: normalizeServiceKey(item.service_type || item.serviceType || item.type),
    subtype: item.subtype ? String(item.subtype).toLowerCase() : '',
    quality: item.quality ? String(item.quality).toLowerCase() : '',
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
    tags,
    context,
    filenames: [].concat(item.filenames || item.filename || []).filter(Boolean).map((f) => String(f).toLowerCase()),
    visible: item.visible ? String(item.visible) : '',
    model: item.model ? String(item.model) : '',
    date: item.date ? String(item.date) : '',
  };
}

/**
 * Read state/curated-labels.json. Accepts the P2.1 shape ({ "<sha256>": {...} }),
 * a { labels: {...} } wrapper, or an array of entries carrying their own hash.
 * A missing/malformed file is NOT an error: callers fall back to filenames and
 * flag every pick unverified.
 */
export function loadCuratedLabels(filePath, { readFile = (p) => fs.readFileSync(p, 'utf8'), parse = JSON.parse } = {}) {
  const out = { present: false, byHash: new Map(), byPath: new Map(), byFilename: new Map(), size: 0 };
  let raw;
  try { raw = parse(readFile(filePath)); } catch { return out; }
  if (!raw || typeof raw !== 'object') return out;
  const source = Array.isArray(raw) ? raw : (raw.labels && typeof raw.labels === 'object' ? raw.labels : raw);
  const add = (hash, item) => {
    const label = normalizeLabel(hash, item);
    out.size += 1;
    if (label.hash) out.byHash.set(label.hash, label);
    for (const key of [hash, item && item.path, item && item.sourcePath, item && item.photoPath]) {
      // A shippable key may be a sha256 or (tolerated) a path.
      if (!key || !String(key).match(/[/\\]/)) continue;
      const k = normalizePathKey(key);
      if (k && !out.byPath.has(k)) out.byPath.set(k, label);
    }
    for (const name of label.filenames) if (!out.byFilename.has(name)) out.byFilename.set(name, label);
  };
  if (Array.isArray(source)) {
    for (const item of source) if (item && typeof item === 'object') add(item.hash || item.sha256, item);
  } else {
    for (const [hash, item] of Object.entries(source)) if (item && typeof item === 'object') add(hash, item);
  }
  out.present = out.size > 0;
  return out;
}

export function keyFromFilename(filename) {
  const name = String(filename || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[._-]+/g, ' ');
  if (!name.trim()) return 'other';
  return typeFromText(name);
}

/**
 * The label a photo is judged by. Curated labels win; otherwise the filename
 * decides and the pick is flagged unverified (never silently trusted).
 */
export function labelForPhoto(entry = {}, labels = EMPTY_LABELS) {
  const hash = hashOfEntry(entry);
  const names = [entry.filename, entry.sourceFilename, entry.path && path.basename(String(entry.path))]
    .filter(Boolean).map((n) => String(n).toLowerCase());
  if (labels && labels.present) {
    const found = (hash && labels.byHash.get(hash))
      || [entry.path, entry.sourcePath, entry.photoPath, entry.curatedPath]
        .map(normalizePathKey).filter(Boolean).map((k) => labels.byPath.get(k)).find(Boolean)
      || names.map((n) => labels.byFilename.get(n)).find(Boolean);
    if (found) {
      return { ...found, source: 'curated-labels', unverified: false };
    }
  }
  const named = keyFromFilename(names[0] || '');
  return {
    key: named,
    source: named === 'other' ? 'none' : 'filename',
    unverified: true,
    quality: '',
    context: 'unknown',
    subtype: '',
    hash,
    tags: [],
  };
}

// ── Compatibility allowlist (Carter's file, empty = block) ─────────────────

export function pairKey(a, b) {
  return [normalizeServiceKey(a), normalizeServiceKey(b)].sort().join('|');
}

export function loadCompatAllowlist(filePath, { readFile = (p) => fs.readFileSync(p, 'utf8'), parse = JSON.parse } = {}) {
  const out = { present: false, pairs: new Set(), raw: [] };
  let raw;
  try { raw = parse(readFile(filePath)); } catch { return out; }
  const list = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.pairs) ? raw.pairs
      : (raw && Array.isArray(raw.allow) ? raw.allow
        : (raw && Array.isArray(raw.allowed) ? raw.allowed
          : (raw && typeof raw === 'object' ? Object.entries(raw).flatMap(([from, to]) => [].concat(to || []).map((t) => [from, t])) : []))));
  for (const item of list) {
    const pair = Array.isArray(item) ? item
      : (item && typeof item === 'object' && item.from && item.to ? [item.from, item.to]
        : String(item || '').split(/[|>]|->/));
    const [a, b] = pair.map((v) => String(v || '').trim()).filter(Boolean);
    if (!a || !b) continue;
    out.raw.push(`${a}|${b}`);
    out.pairs.add(pairKey(a, b));
  }
  out.present = out.pairs.size > 0;
  return out;
}

export function allowlistAllows(allowlist = EMPTY_ALLOWLIST, postKey, photoKey) {
  const a = normalizeServiceKey(postKey);
  const b = normalizeServiceKey(photoKey);
  if (a === b) return true;
  const table = ALLOWED_LABELS[a] || [];
  if (table.includes(b)) return true;
  return Boolean(allowlist && allowlist.pairs && allowlist.pairs.has(pairKey(a, b)));
}

// ── Commercial context as an explicit tag ─────────────────────────────────

export function postContextOf(post = {}) {
  const declared = String(post.context || post.photoContext || '').toLowerCase();
  const tags = [].concat(post.tags || []).map((t) => String(t).toLowerCase());
  if (post.commercial === true || declared === 'commercial' || tags.includes('commercial') || tags.includes('business')) return 'commercial';
  if (declared === 'residential' || tags.includes('residential')) return 'residential';
  return 'unknown';
}

export function contextMatches(postContext, labelContext) {
  if (!postContext || !labelContext || postContext === 'unknown' || labelContext === 'unknown') {
    return { ok: true, unverified: true };
  }
  return { ok: postContext === labelContext, unverified: false };
}

// ── The one shared selection path ─────────────────────────────────────────

export function normalizePoolEntry(raw = {}) {
  return {
    path: raw.path || raw.usable || raw.srcPath || raw.filePath || '',
    filename: raw.filename || (raw.path || raw.usable || raw.srcPath || raw.filePath ? path.basename(String(raw.path || raw.usable || raw.srcPath || raw.filePath)) : ''),
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
    serviceType: normalizeServiceKey(raw.serviceType || raw.service_type),
    tags: [].concat(raw.tags || []),
    photoDate: Number(raw.photoDate) || 0,
    hash: raw.hash || raw.sourceHash || raw.photoHash || '',
    sourcePath: raw.sourcePath || '',
    context: raw.context || '',
    raw,
  };
}

/**
 * Rank the eligible photos for one post. Returns at most `maxCandidates`
 * candidates (default 3 = the caption-check budget) in the pool's own order,
 * plus every rejection with a reason so the choice is auditable.
 */
export function selectPhotoCandidatesForPost({
  post = {},
  pool = [],
  history = [],
  platform = 'gbp',
  now = Date.now(),
  noReuseWeeks = NO_REUSE_WEEKS,
  maxCandidates = CAPTION_CHECK_MAX_CANDIDATES,
  allowlist = EMPTY_ALLOWLIST,
  labels = EMPTY_LABELS,
  usedHashes = [],
  usedPaths = [],
  minScore = 0,
} = {}) {
  const { key: serviceKey, source: serviceFrom } = serviceKeyForPost(post);
  const postContext = postContextOf(post);
  const reserved = new Set([].concat(usedHashes || []).map((h) => String(h).toLowerCase()).filter(Boolean));
  // Paths already handed out by this run: a caller without hashes (the GBP pool
  // is seeded from filenames) still must not offer the same file twice, and the
  // filter has to happen BEFORE the candidate cap or later posts starve.
  const takenPaths = new Set([].concat(usedPaths || []).map(normalizePathKey).filter(Boolean));
  const accepted = [];
  const rejected = [];
  const allHistory = [].concat(history || []);
  const flags = {
    labelUnverified: false,
    contextUnverified: false,
    // Legacy history without hashes cannot prove no-reuse: say so up front.
    unverifiedHistory: allHistory.some((entry) => !hashOfEntry(entry)),
    allowlistExceptions: [],
    unhashed: [],
  };

  for (const raw of pool) {
    const entry = normalizePoolEntry(raw);
    const label = labelForPhoto(entry, labels);
    const hash = label.hash || hashOfEntry(entry);
    const reject = (reason) => rejected.push({ path: entry.path, filename: entry.filename, reason });

    if (minScore && entry.score < minScore) { reject(`score ${entry.score} below floor ${minScore}`); continue; }
    if (takenPaths.has(normalizePathKey(entry.path))) { reject('file already used by an earlier post in this run'); continue; }
    if (label.quality && label.quality !== 'ok') { reject(`label quality "${label.quality}" is not shippable`); continue; }
    if (hash && reserved.has(hash)) { reject('content hash already used in this run'); continue; }

    const sameTopic = label.key === serviceKey;
    let allowlistPair = null;
    if (!sameTopic) {
      if (!allowlistAllows(allowlist, serviceKey, label.key)) {
        reject(`cross-topic: post key "${serviceKey}" vs photo label "${label.key}" is not in the approved allowlist`);
        continue;
      }
      allowlistPair = pairKey(serviceKey, label.key);
      flags.allowlistExceptions.push(allowlistPair);
    }

    const context = contextMatches(postContext, label.context);
    if (!context.ok) { reject(`commercial/residential context mismatch (post ${postContext}, photo ${label.context})`); continue; }
    if (context.unverified) flags.contextUnverified = true;
    if (label.unverified) flags.labelUnverified = true;

    if (hash) {
      const { conflicts } = hashConflicts({ hashes: [hash], history, now, weeks: noReuseWeeks });
      if (conflicts.length) { reject(`content hash reused within ${noReuseWeeks} weeks (${conflicts[0].entry && conflicts[0].entry.postDate})`); continue; }
    } else {
      flags.unhashed.push(entry.path);
    }

    accepted.push({
      path: entry.path,
      filename: entry.filename,
      hash,
      sourcePath: entry.sourcePath,
      score: entry.score,
      photoDate: entry.photoDate,
      label,
      serviceType: label.key,
      labelSource: label.source,
      unverified: Boolean(label.unverified),
      context: label.context,
      allowlistPair,
      platform,
      entry: raw,
    });
  }

  return {
    platform,
    serviceKey,
    serviceFrom,
    postContext,
    status: accepted.length ? 'ok' : 'blocked',
    candidates: accepted.slice(0, Math.max(0, maxCandidates)),
    rejected,
    flags,
  };
}

// ── Caption-photo check (P2.4) ────────────────────────────────────────────

/**
 * One yes/no vision call sees the actual image plus hook and service. On "no"
 * the next candidate is tried, 3 candidates TOTAL per post, then the allowlist
 * photo (GBP) or text-only (FB). A vision service that is down leaves the image
 * UNVERIFIED, never passed. Verdicts carry the candidate hashes.
 *
 * `visionClient({ image, hook, service, platform })` is injected:
 *   -> { matches: true|false, model?, reason? } for a verdict
 *   -> { matches: null } / { unavailable: true } or a thrown error for "unavailable"
 */
export async function verifyPhotoCandidates({
  candidates = [],
  hook = '',
  service = '',
  platform = 'gbp',
  visionClient,
  allowlistPhoto = null,
  maxCandidates = CAPTION_CHECK_MAX_CANDIDATES,
  imageLoader = (candidate) => ({ path: candidate.path, hash: candidate.hash }),
} = {}) {
  const verdicts = [];
  const limit = Math.max(0, Number(maxCandidates) || 0);
  const attempts = candidates.slice(0, limit);
  const fallback = () => (allowlistPhoto
    ? { status: 'allowlist-photo', chosen: allowlistPhoto }
    : { status: 'text-only', chosen: null });
  if (typeof visionClient !== 'function') {
    return { status: 'unverified', reason: 'no vision client injected', chosen: null, verdicts, attempts: 0 };
  }
  for (const candidate of attempts) {
    let verdict;
    try {
      verdict = await visionClient({ image: imageLoader(candidate), hook, service, platform });
    } catch (e) {
      verdicts.push({ hash: candidate.hash || '', path: candidate.path || '', verdict: 'unverified', reason: e.message });
      return { status: 'unverified', reason: `vision unavailable: ${e.message}`, chosen: null, verdicts, attempts: verdicts.length };
    }
    if (!verdict || verdict.unavailable || verdict.matches === null || verdict.matches === undefined) {
      verdicts.push({ hash: candidate.hash || '', path: candidate.path || '', verdict: 'unverified', reason: (verdict && verdict.reason) || 'vision unavailable' });
      return { status: 'unverified', reason: (verdict && verdict.reason) || 'vision unavailable', chosen: null, verdicts, attempts: verdicts.length };
    }
    if (verdict.matches === true) {
      verdicts.push({ hash: candidate.hash || '', path: candidate.path || '', verdict: 'yes', model: verdict.model || '', reason: verdict.reason || '' });
      return { status: 'passed', chosen: candidate, verdicts, attempts: verdicts.length };
    }
    verdicts.push({ hash: candidate.hash || '', path: candidate.path || '', verdict: 'no', reason: verdict.reason || 'vision said no', model: verdict.model || '' });
  }
  return { ...fallback(), verdicts, attempts: verdicts.length };
}

// ── Manifest: platform-keyed, locked, atomic (P2.2/P2.3) ──────────────────

export function emptyManifest() {
  return { version: 1, platforms: {} };
}

/** Legacy array files are still readable; platform-keyed files are the target. */
export function manifestIsKeyed(manifest) {
  return Boolean(manifest && !Array.isArray(manifest) && manifest.platforms && typeof manifest.platforms === 'object');
}

/**
 * Read a manifest. Without `platform` every platform is flattened (legacy
 * callers keep working); with `platform` only that platform's entries return,
 * tagged with their platform.
 */
export function loadSelectionManifest(filePath, { platform, readFile = (p) => fs.readFileSync(p, 'utf8'), parse = JSON.parse } = {}) {
  let parsed;
  try { parsed = parse(readFile(filePath)); } catch { return []; }
  if (Array.isArray(parsed)) return platform ? parsed.filter((e) => !e.platform || e.platform === platform) : parsed;
  if (!manifestIsKeyed(parsed)) return [];
  const out = [];
  for (const [key, entries] of Object.entries(parsed.platforms)) {
    if (platform && key !== platform) continue;
    for (const entry of [].concat(entries || [])) out.push({ platform: key, ...entry });
  }
  return out;
}

/** Backwards-compatible alias: the pre-P2.3 name returned a plain array. */
export function loadPhotoSelectionManifest(filePath, options) {
  return loadSelectionManifest(filePath, options);
}

function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, filePath);
}

/**
 * Write a manifest atomically. Accepts a platform-keyed object, a plain array
 * (stored under `platform`), or a flat list of entries that already carry
 * `platform` keys — the last shape is what the FB date purge produces, and it
 * must NOT drop the other platform's entries.
 */
export function saveSelectionManifest(filePath, manifest, { platform = 'gbp' } = {}) {
  let keyed;
  if (manifestIsKeyed(manifest)) {
    keyed = { version: manifest.version || 1, platforms: { ...manifest.platforms } };
  } else {
    keyed = emptyManifest();
    for (const entry of [].concat(manifest || [])) {
      const bucket = entry && entry.platform ? entry.platform : platform;
      keyed.platforms[bucket] = keyed.platforms[bucket] || [];
      const rest = { ...(entry || {}) };
      delete rest.platform;
      keyed.platforms[bucket].push(rest);
    }
  }
  for (const key of Object.keys(keyed.platforms)) keyed.platforms[key] = [].concat(keyed.platforms[key] || []);
  atomicWrite(filePath, `${JSON.stringify(keyed, null, 2)}\n`);
  return keyed;
}

/**
 * Identity of the lock file as it exists right now: stat fields plus the pid
 * written inside it. A reclaim unlinks exactly one snapshot, so a waiter that
 * measured the dead lock cannot delete the fresh one the winner just created.
 */
function lockSnapshot(fsImpl, lockPath) {
  try {
    const st = fsImpl.statSync(lockPath);
    let owner = '';
    try { owner = String(fsImpl.readFileSync(lockPath, 'utf8')).trim(); } catch { /* unreadable owner */ }
    return { mtimeMs: st.mtimeMs, size: st.size, owner };
  } catch { return null; }
}

function sameLock(a, b) {
  return Boolean(a && b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.owner === b.owner);
}

/**
 * Small local reservation lock: worker and bridge call the pickers
 * independently, so the manifest read-check-write must be serialized. The lock
 * is a 'wx' sentinel next to the manifest, holding the owner pid; a stale one
 * (dead process, >staleMs) is reclaimed owner-checked. fs is injectable for tests.
 */
export function withManifestLock(manifestPath, fn, {
  timeoutMs = 5000,
  staleMs = 60000,
  sleepMs = 25,
  now = () => Date.now(),
  fsImpl = fs,
} = {}) {
  const lockPath = `${manifestPath}.lock`;
  const sleep = (ms) => { const end = now() + ms; while (now() < end) { /* spin */ } };
  fsImpl.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const deadline = now() + timeoutMs;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fsImpl.openSync(lockPath, 'wx');
      fsImpl.writeSync(fd, String(process.pid));
      fsImpl.closeSync(fd);
      acquired = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const snapshot = lockSnapshot(fsImpl, lockPath);
      if (!snapshot) continue; // lock vanished between open and stat: retry now
      if (now() - snapshot.mtimeMs > staleMs) {
        // Reclaim the lock we measured and nothing else: a fresh lock created in
        // the meantime has a different owner pid/mtime, and unlinking it would
        // leave two holders.
        if (sameLock(snapshot, lockSnapshot(fsImpl, lockPath))) {
          try { fsImpl.unlinkSync(lockPath); } catch { /* raced */ }
        }
        continue;
      }
      if (now() > deadline) throw new Error(`manifest lock busy: ${lockPath}`);
      sleep(sleepMs);
    }
  }
  try {
    return fn();
  } finally {
    try { fsImpl.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/**
 * Claim content hashes in the manifest before any copy happens. Writes inside
 * the lock, so two callers can never reserve the same hash; the check spans
 * every platform and the 8-week window.
 */
export function reservePhotoHashes({
  manifestPath,
  platform = 'gbp',
  hashes = [],
  meta = {},
  now = Date.now(),
  weeks = NO_REUSE_WEEKS,
  lock = {},
} = {}) {
  const wanted = [].concat(hashes || []).map((h) => String(h || '').toLowerCase()).filter(Boolean);
  if (!wanted.length) return { ok: true, reserved: [], conflicts: [], unknownHistory: false };
  return withManifestLock(manifestPath, () => {
    const history = loadSelectionManifest(manifestPath);
    const { conflicts, unknown } = hashConflicts({ hashes: wanted, history, now, weeks });
    if (conflicts.length) return { ok: false, reserved: [], conflicts, unknownHistory: unknown.unverifiedHistory };
    // Re-key through saveSelectionManifest so a legacy flat-array file keeps its
    // rows instead of being rewritten as an empty keyed manifest, and a keyed
    // file keeps every other platform's bucket. Legacy rows carry no platform,
    // so tag them the way the pickers do before re-keying.
    const rows = history.map((entry) => (
      entry && entry.platform
        ? entry
        : { ...entry, platform: entry && entry.selectedBy === 'fb-photo-pick' ? 'fb' : platform }
    ));
    rows.push({ ...meta, photoHash: wanted[0], sourceHash: meta.sourceHash || wanted[0], reservedAt: new Date(now).toISOString() });
    saveSelectionManifest(manifestPath, rows, { platform });
    return { ok: true, reserved: wanted, conflicts: [], unknownHistory: unknown.unverifiedHistory };
  }, lock);
}

// ── Compatibility checks used by the publishers ───────────────────────────

export function findPhotoSelection(photoPath, manifest = [], photoHash = '') {
  const wanted = comparablePath(photoPath);
  const hash = String(photoHash || '').toLowerCase();
  return manifest.find((entry) => {
    if (hash && hashOfEntry(entry) === hash) return true;
    return wanted && (comparablePath(entry.photoPath) === wanted || comparablePath(entry.curatedPath) === wanted);
  }) || null;
}

export function isManifestSelectionCompatible({ date, service, photoPath, photoHash, manifest = [] }) {
  const entry = findPhotoSelection(photoPath, manifest, photoHash);
  if (!entry) return { ok: false, reason: 'photo has no audited selection manifest entry' };
  // Compare bare dates: callers may pass the schedule's raw DATE line
  // ("2026-09-18 (Friday, ...)") and older manifest entries stored it that way.
  const bareDate = (value) => String(value || '').replace(/\s*\(.*$/, '').trim();
  if (date && bareDate(entry.postDate) !== bareDate(date)) {
    return { ok: false, reason: `manifest date ${entry.postDate || '(blank)'} does not match ${date}`, entry };
  }
  if (service && serviceSlug(entry.postService) !== serviceSlug(service)) {
    return { ok: false, reason: `manifest service ${entry.postService || '(blank)'} does not match ${service}`, entry };
  }

  const expected = derivePostServiceType({ service, topic: service });
  const photoType = entry.photoServiceType || entry.serviceType || 'other';
  const postType = entry.postServiceType || expected;
  if (expected !== 'other' && postType !== expected) {
    return { ok: false, reason: `manifest post type ${postType} does not match ${expected}`, entry };
  }
  if (expected !== 'other' && photoType !== expected) {
    return { ok: false, reason: `photo type ${photoType} does not match ${expected}`, entry };
  }
  return { ok: true, entry };
}
