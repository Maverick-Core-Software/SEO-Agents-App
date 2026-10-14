import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rekeyPath, rekeyCache, rekeyManifest, runRekey } from './rekey-state.mjs';
import { runAudit } from './photo-case-audit.mjs';

const OLD_ROOT = 'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos';
const NEW_ROOT = '/srv/seo/photos';
const OLD_FWD = 'C:/Workspace/Shared/Assets/Media/Grizzly/GBP Post Photos';
const SIBLING = 'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos2\\x.jpg';
const NOW = new Date('2026-10-13T12:00:00.000Z');

const K_CURATED = `${OLD_ROOT}\\Curated\\a.jpg`;
const K_ARCHIVE = `${OLD_ROOT}\\Archive\\b.jpg`;
const K_REVIEW = `${OLD_ROOT}\\Unused Review\\c.heic`;
const K_POSIX = '/srv/seo/photos/Curated/already.jpg';

let root;

function fixtureCache() {
  const v = (filePath, score, hash) => ({
    filePath,
    filename: path.basename(filePath.replace(/\\/g, '/')),
    score,
    service_type: 'gbp',
    tags: ['storefront'],
    hash,
  });
  return {
    [K_CURATED]: v(K_CURATED, 7.5, 'aaa111'),
    [K_ARCHIVE]: v(K_ARCHIVE, 3, 'bbb222'),
    [K_REVIEW]: v(K_REVIEW, 0.25, 'ccc333'),
    [SIBLING]: v(SIBLING, 9, 'ddd444'),
    [K_POSIX]: v(K_POSIX, 8, 'eee555'),
  };
}

function fixtureManifest() {
  return {
    version: 1,
    platforms: {
      gbp: [
        { photoPath: K_CURATED, photoHash: 'aaa111', sourceHash: 'aaa111', date: '2026-10-16', score: 7.5 },
      ],
      fb: [
        { photoPath: `${OLD_FWD}/Archive/b.jpg`, photoHash: 'bbb222', selectedAt: '2026-10-09T12:00:00Z' },
        { photoPath: 'relative/x.jpg', photoHash: 'ccc333' },
      ],
    },
  };
}

function freshDir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'photo-cache.json'), JSON.stringify(fixtureCache(), null, 2));
  fs.writeFileSync(path.join(dir, 'photo-selection-manifest.json'), `${JSON.stringify(fixtureManifest(), null, 2)}\n`);
  return dir;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listBackups(dir) {
  return fs.readdirSync(dir).filter((f) => f.includes('.bak-')).sort();
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-state-test-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('rekeyPath maps only true children of the old root, not siblings', () => {
  assert.equal(rekeyPath(K_CURATED, OLD_ROOT, NEW_ROOT), '/srv/seo/photos/Curated/a.jpg');
  assert.equal(rekeyPath(`${OLD_FWD}/Archive/b.jpg`, OLD_ROOT, NEW_ROOT), '/srv/seo/photos/Archive/b.jpg');
  assert.equal(rekeyPath(SIBLING, OLD_ROOT, NEW_ROOT), null);
  assert.equal(rekeyPath(K_POSIX, OLD_ROOT, NEW_ROOT), null);
  assert.equal(rekeyPath('', OLD_ROOT, NEW_ROOT), null);
  assert.equal(rekeyPath(undefined, OLD_ROOT, NEW_ROOT), null);
});

test('dry-run reports counts and writes nothing', () => {
  const dir = freshDir('dry');
  const snapshot = {
    cache: fs.readFileSync(path.join(dir, 'photo-cache.json'), 'utf8'),
    manifest: fs.readFileSync(path.join(dir, 'photo-selection-manifest.json'), 'utf8'),
  };
  const report = runRekey({ stateDir: dir, from: OLD_ROOT, to: NEW_ROOT, apply: false, now: NOW });
  assert.equal(report.cache.total, 5);
  assert.equal(report.cache.rewritten, 3);
  assert.equal(report.cache.unchanged, 2);
  assert.equal(report.manifest.rewritten, 2);
  assert.equal(report.manifest.unchanged, 1);
  assert.equal(report.changes, 8);
  assert.deepEqual(report.written, []);
  assert.deepEqual(listBackups(dir), []);
  assert.equal(fs.readFileSync(path.join(dir, 'photo-cache.json'), 'utf8'), snapshot.cache);
  assert.equal(fs.readFileSync(path.join(dir, 'photo-selection-manifest.json'), 'utf8'), snapshot.manifest);
});

test('apply keeps key count, hashes and scores; leaves no old-root keys; writes backups', () => {
  const dir = freshDir('apply');
  const originalCache = fs.readFileSync(path.join(dir, 'photo-cache.json'), 'utf8');
  const originalManifest = fs.readFileSync(path.join(dir, 'photo-selection-manifest.json'), 'utf8');
  const beforeCache = readJson(path.join(dir, 'photo-cache.json'));
  const beforeManifest = readJson(path.join(dir, 'photo-selection-manifest.json'));

  const report = runRekey({ stateDir: dir, from: OLD_ROOT, to: NEW_ROOT, apply: true, now: NOW });
  assert.equal(report.written.length, 2);
  assert.equal(report.backups.length, 2);

  const afterCache = readJson(path.join(dir, 'photo-cache.json'));
  const afterManifest = readJson(path.join(dir, 'photo-selection-manifest.json'));

  // Key count unchanged.
  assert.equal(Object.keys(afterCache).length, Object.keys(beforeCache).length);

  // Each rewritten key carries the same hash and score; only filePath changed.
  assert.equal(afterCache['/srv/seo/photos/Curated/a.jpg'].hash, 'aaa111');
  assert.equal(afterCache['/srv/seo/photos/Curated/a.jpg'].score, 7.5);
  assert.equal(afterCache['/srv/seo/photos/Curated/a.jpg'].filePath, '/srv/seo/photos/Curated/a.jpg');
  assert.equal(afterCache['/srv/seo/photos/Archive/b.jpg'].hash, 'bbb222');
  assert.equal(afterCache['/srv/seo/photos/Unused Review/c.heic'].score, 0.25);
  assert.equal(afterCache[K_CURATED], undefined);

  // Untouched entries stay identical (sibling directory and already-posix key).
  assert.deepEqual(afterCache[SIBLING], beforeCache[SIBLING]);
  assert.deepEqual(afterCache[K_POSIX], beforeCache[K_POSIX]);

  // No old-root key remains; the only Windows-style key left is the sibling directory.
  const winKeys = Object.keys(afterCache).filter((k) => /^[A-Za-z]:[\\/]/.test(k));
  assert.deepEqual(winKeys, [SIBLING]);
  assert.equal(fs.readFileSync(path.join(dir, 'photo-cache.json'), 'utf8').includes('GBP Post Photos2'), true,
    'the sibling-directory entry survives untouched');

  // Manifest photoPath rewritten; hash fields byte-identical in value.
  const gbp = afterManifest.platforms.gbp[0];
  assert.equal(gbp.photoPath, '/srv/seo/photos/Curated/a.jpg');
  assert.equal(gbp.photoHash, 'aaa111');
  assert.equal(gbp.sourceHash, 'aaa111');
  assert.equal(gbp.score, 7.5);
  assert.equal(afterManifest.platforms.fb[0].photoPath, '/srv/seo/photos/Archive/b.jpg');
  assert.equal(afterManifest.platforms.fb[0].photoHash, 'bbb222');
  assert.equal(afterManifest.platforms.fb[1].photoPath, 'relative/x.jpg');
  for (const platform of Object.keys(beforeManifest.platforms)) {
    beforeManifest.platforms[platform].forEach((e, i) => {
      assert.equal(afterManifest.platforms[platform][i].photoHash, e.photoHash);
    });
  }

  // Backups hold the exact original bytes; trailing newline style preserved.
  const backups = listBackups(dir);
  assert.equal(backups.length, 2);
  const cacheBackup = backups.find((b) => b.startsWith('photo-cache.json.bak-'));
  const manifestBackup = backups.find((b) => b.startsWith('photo-selection-manifest.json.bak-'));
  assert.equal(fs.readFileSync(path.join(dir, cacheBackup), 'utf8'), originalCache);
  assert.equal(fs.readFileSync(path.join(dir, manifestBackup), 'utf8'), originalManifest);
  assert.equal(fs.readFileSync(path.join(dir, 'photo-selection-manifest.json'), 'utf8').endsWith('\n'), true);
});

test('second apply is idempotent: zero changes, no new backups, bytes unchanged', () => {
  const dir = freshDir('idem');
  runRekey({ stateDir: dir, from: OLD_ROOT, to: NEW_ROOT, apply: true, now: NOW });
  const cacheAfterFirst = fs.readFileSync(path.join(dir, 'photo-cache.json'), 'utf8');
  const manifestAfterFirst = fs.readFileSync(path.join(dir, 'photo-selection-manifest.json'), 'utf8');
  const backupsAfterFirst = listBackups(dir);

  const second = runRekey({ stateDir: dir, from: OLD_ROOT, to: NEW_ROOT, apply: true, now: new Date(NOW.getTime() + 60000) });
  assert.equal(second.changes, 0);
  assert.deepEqual(second.written, []);
  assert.deepEqual(listBackups(dir), backupsAfterFirst);
  assert.equal(fs.readFileSync(path.join(dir, 'photo-cache.json'), 'utf8'), cacheAfterFirst);
  assert.equal(fs.readFileSync(path.join(dir, 'photo-selection-manifest.json'), 'utf8'), manifestAfterFirst);
});

test('collision: an existing new-root key is never overwritten', () => {
  const cache = fixtureCache();
  cache[`${NEW_ROOT}/Curated/a.jpg`] = { filePath: `${NEW_ROOT}/Curated/a.jpg`, hash: 'NEWHASH', score: 1 };
  const { out, stats } = rekeyCache(cache, OLD_ROOT, NEW_ROOT);
  assert.equal(stats.collisions, 1);
  assert.equal(out[`${NEW_ROOT}/Curated/a.jpg`].hash, 'NEWHASH');
  assert.equal(out[K_CURATED].hash, 'aaa111', 'old key kept rather than dropped');
});

test('unknown manifest shape is rejected', () => {
  assert.throws(() => rekeyManifest({ nope: true }, OLD_ROOT, NEW_ROOT), /unrecognized shape/);
});

test('missing state files fail loudly', () => {
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => runRekey({ stateDir: empty, from: OLD_ROOT, to: NEW_ROOT, apply: false }), /no photo-cache\.json/);
});

test('case-fix: a rewritten path takes the on-disk casing; dry-run matches apply; audit is clean after', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-case-'));
  try {
    const photos = path.join(tmp, 'photos');
    fs.mkdirSync(path.join(photos, 'Curated'), { recursive: true });
    fs.writeFileSync(path.join(photos, 'Curated', 'IMG_1234.JPG'), 'x');
    fs.writeFileSync(path.join(photos, 'Curated', 'exact.jpg'), 'x');
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir);
    const cacheFile = path.join(stateDir, 'photo-cache.json');
    const manifestFile = path.join(stateDir, 'photo-selection-manifest.json');
    const k1 = `${OLD_ROOT}\\Curated\\IMG_1234.jpg`;
    const k2 = `${OLD_ROOT}\\Curated\\exact.jpg`;
    fs.writeFileSync(cacheFile, JSON.stringify({
      [k1]: { filePath: k1, hash: 'aaa', score: 4 },
      [k2]: { filePath: k2, hash: 'bbb', score: 5 },
    }, null, 2));
    fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, platforms: { gbp: [{ photoPath: k1, photoHash: 'aaa' }] } }, null, 2));

    const pre = runAudit({ photos, cache: cacheFile, manifest: manifestFile });
    assert.equal(pre.totals.case, 2, 'before rekey the Windows-cased reference is case-only in both files');
    assert.equal(pre.exit, 2);

    const dry = runRekey({ stateDir, from: OLD_ROOT, to: photos, apply: false, now: NOW });
    assert.equal(dry.cache.rewritten, 2);
    assert.equal(dry.cache.caseFixed, 2, 'key and filePath of the case-only entry');
    assert.equal(dry.manifest.caseFixed, 1);
    assert.equal(dry.changes, 5);
    assert.deepEqual(dry.written, []);

    const applied = runRekey({ stateDir, from: OLD_ROOT, to: photos, apply: true, now: NOW });
    assert.equal(applied.changes, 5);
    assert.equal(applied.written.length, 2);

    const fixedKey = `${photos.replace(/\\/g, '/')}/Curated/IMG_1234.JPG`;
    const afterCache = readJson(cacheFile);
    assert.equal(afterCache[fixedKey].filePath, fixedKey);
    assert.equal(afterCache[fixedKey].hash, 'aaa');
    assert.equal(afterCache[k1], undefined);
    assert.equal(readJson(manifestFile).platforms.gbp[0].photoPath, fixedKey);

    const post = runAudit({ photos, cache: cacheFile, manifest: manifestFile });
    assert.equal(post.totals.case, 0);
    assert.equal(post.exit, 0);

    const again = runRekey({ stateDir, from: OLD_ROOT, to: photos, apply: true, now: new Date(NOW.getTime() + 60000) });
    assert.equal(again.changes, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
