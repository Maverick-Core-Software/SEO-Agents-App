// scripts/lib/curated-photo.test.mjs
// Verifies the curated-by-date selection rule used by facebook-poster's
// video-day fallback: pick the first image whose name starts with `${date}-`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curated-'));
fs.writeFileSync(path.join(dir, '2026-06-26-panel-upgrade.jpg'), 'x');
fs.writeFileSync(path.join(dir, '2026-06-26-ac-tuneup.png'), 'x');
fs.writeFileSync(path.join(dir, '2026-06-27-other.jpg'), 'x');
fs.writeFileSync(path.join(dir, '2026-06-26-notes.txt'), 'x'); // not an image

function curatedPhotoForDate(date, folder) {
  if (!date) return null;
  try {
    const hit = fs.readdirSync(folder)
      .filter(f => f.startsWith(`${date}-`) && /\.(jpe?g|png|webp)$/i.test(f))
      .sort()[0];
    return hit ? path.join(folder, hit) : null;
  } catch { return null; }
}

assert.equal(path.basename(curatedPhotoForDate('2026-06-26', dir)), '2026-06-26-ac-tuneup.png'); // sorts first
assert.equal(path.basename(curatedPhotoForDate('2026-06-27', dir)), '2026-06-27-other.jpg');
assert.equal(curatedPhotoForDate('2026-06-28', dir), null); // no match
assert.equal(curatedPhotoForDate('', dir), null);
assert.equal(curatedPhotoForDate('2026-06-26', '/no/such/dir/xyz'), null); // missing dir => null

fs.rmSync(dir, { recursive: true, force: true });
console.log('ok curated-photo');
