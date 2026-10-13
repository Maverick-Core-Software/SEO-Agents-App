// Focused check for the P2.5 poster guard in facebook-poster.mjs: an explicit
// PHOTO_FILE is published only when the selection manifest audits that exact
// file for the post's date + service. The crew's guessed filenames (IMG_####.JPG
// and other raw paths) have no entry and are rejected.
// Isolated os.tmpdir fixtures; no posting, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-poster-guard-'));
const DATE = '2001-01-01'; // a date no real curated file can carry
const SERVICE = 'Panel Replacement';

const guessed = path.join(tmp, 'IMG_2402.JPG');       // crew guess, never picked
const audited = path.join(tmp, `${DATE}-panel-replacement-1.jpg`);
fs.writeFileSync(guessed, 'fixture');
fs.writeFileSync(audited, 'fixture');

const manifestPath = path.join(tmp, 'photo-selection-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify([{
  platform: 'facebook',
  postDate: DATE,
  postService: SERVICE,
  postServiceType: 'panel',
  photoServiceType: 'panel',
  photoPath: audited,
  sourcePath: path.join(tmp, 'panel-src.jpg'),
  selectedBy: 'fb-photo-pick',
}], null, 2));

// The module reads .env then this env var for the manifest path, so it must be
// set before the (dynamic) import.
process.env.GBP_PHOTO_SELECTION_MANIFEST = manifestPath;
const { auditPhotosInManifest, resolvePhotoPath } = await import('../scripts/facebook-poster.mjs');

try {
  // ── Decision level ────────────────────────────────────────────────────────
  const guessedAudit = auditPhotosInManifest({ date: DATE, service: SERVICE, photoPath: guessed });
  assert.equal(guessedAudit.ok, false, 'guessed IMG_ file has no audited entry');
  assert.match(guessedAudit.reason, /no audited selection manifest entry/);

  // Default manifest argument is the module-level one — proves the env seam
  // pointed the module at this fixture manifest.
  assert.equal(auditPhotosInManifest({ date: DATE, service: SERVICE, photoPath: audited }).ok, true, 'audited pick passes');

  // No manifest at all keeps the pre-manifest trust boundary.
  assert.equal(auditPhotosInManifest({ date: DATE, service: SERVICE, photoPath: guessed, manifest: [] }).ok, true);

  // ── Schedule path (resolvePhotoPath) ──────────────────────────────────────
  const rejected = resolvePhotoPath({ date: DATE, service: SERVICE, type: 'photo', photo_file: guessed });
  assert.equal(rejected, null, `guessed photo must not resolve, got ${rejected}`);

  const accepted = resolvePhotoPath({ date: DATE, service: SERVICE, type: 'photo', photo_file: audited });
  assert.equal(accepted, audited, 'manifest-audited photo still resolves');

  // A post whose service does not match the entry is rejected too.
  assert.equal(
    resolvePhotoPath({ date: DATE, service: 'EV Charger Installation', type: 'photo', photo_file: audited }),
    null,
    'audited photo for a different service must not resolve',
  );

  console.log('ok facebook-poster photo guard');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
