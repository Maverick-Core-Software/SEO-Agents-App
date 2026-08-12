import fs from 'node:fs';

/**
 * Shared, deterministic rules for photo-to-post compatibility.
 *
 * The vision model may suggest candidates, but downstream publishers only
 * trust a photo that gbp-photo-pick recorded in the selection manifest.
 */

export const SERVICE_TYPE_KEYWORDS = {
  // More specific terms come first so "generator panel" is not classified as
  // a generic panel post.
  generator: ['generator', 'standby', 'backup power', 'transfer switch', 'inlet box', 'interlock', 'whole-home generator'],
  'ev-charger': ['ev', 'charger', 'electric vehicle', 'level 2', 'charging station', 'tesla'],
  lighting: ['light', 'fixture', 'recessed', 'ceiling fan', 'dimmer', 'lamp', 'led', 'illuminat'],
  wiring: ['wiring', 'wire', 'conduit', 'romex', 'junction', 'rewir'],
  outlet: ['outlet', 'gfci', 'receptacle', 'plug', 'usb', 'dedicated circuit'],
  panel: ['panel', 'breaker', 'main panel', 'subpanel', 'electrical panel', 'box'],
};

export function derivePostServiceType(post = {}) {
  const text = `${post.service || ''} ${post.topic || ''} ${post.headline || ''} ${post.body || ''}`.toLowerCase();
  for (const [type, keywords] of Object.entries(SERVICE_TYPE_KEYWORDS)) {
    if (keywords.some(keyword => text.includes(keyword))) return type;
  }
  return 'other';
}

export function serviceSlug(service) {
  return (service || 'electrical')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function comparablePath(filePath) {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function loadPhotoSelectionManifest(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.selections) ? parsed.selections : []);
  } catch {
    return [];
  }
}

export function findPhotoSelection(filePath, manifest = []) {
  const wanted = comparablePath(filePath);
  if (!wanted) return null;
  return manifest.find(entry =>
    comparablePath(entry.photoPath) === wanted
    || comparablePath(entry.curatedPath) === wanted
  ) || null;
}

export function isManifestSelectionCompatible({ date, service, photoPath, manifest = [] }) {
  const entry = findPhotoSelection(photoPath, manifest);
  if (!entry) return { ok: false, reason: 'photo has no audited selection manifest entry' };
  if (date && entry.postDate !== date) {
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
