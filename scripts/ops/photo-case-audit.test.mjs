import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAudit, manifestRefs, cacheRefs, scanRefs } from './photo-case-audit.mjs';
import { buildPhotoIndex, classifyPhotoRef, indexFromDirs } from '../lib/photo-case.mjs';

const MARK = 'GBP Post Photos';
const OLD = 'D:\\Old\\GBP Post Photos';
let root;
let lib;

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-case-audit-'));
  lib = path.join(root, MARK);
  write(path.join(lib, 'Curated', 'IMG_1234.JPG'), 'x');
  write(path.join(lib, 'Curated', 'exact.jpg'), 'x');
  write(path.join(lib, 'Archive', 'Old Shot.heic'), 'x');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('classifies rooted references: exact, case-only with the on-disk name, missing', () => {
  const index = buildPhotoIndex(lib);
  assert.deepEqual(classifyPhotoRef(index, `${OLD}\\Curated\\exact.jpg`, MARK),
    { status: 'exact', rel: 'Curated/exact.jpg', mode: 'rooted' });
  assert.deepEqual(classifyPhotoRef(index, `${OLD}\\Curated\\IMG_1234.jpg`, MARK),
    { status: 'case', rel: 'Curated/IMG_1234.JPG', mode: 'rooted' });
  assert.deepEqual(classifyPhotoRef(index, `${OLD}\\Curated\\nope.jpg`, MARK),
    { status: 'missing', rel: null, mode: 'rooted' });
});

test('unrooted paths match by tail; bare names match anywhere in the tree', () => {
  const index = buildPhotoIndex(lib);
  assert.deepEqual(classifyPhotoRef(index, 'E:\\Media\\Grizzly\\Curated\\IMG_1234.jpg', MARK),
    { status: 'case', rel: 'Curated/IMG_1234.JPG', mode: 'suffix' });
  assert.deepEqual(classifyPhotoRef(index, 'IMG_1234.jpg', MARK),
    { status: 'case', rel: 'Curated/IMG_1234.JPG', mode: 'basename' });
  assert.deepEqual(classifyPhotoRef(index, 'Old Shot.heic', MARK),
    { status: 'exact', rel: 'Archive/Old Shot.heic', mode: 'basename' });
});

test('a folder with two names differing only by case is a collision; a case-ambiguous ref is ambiguous', () => {
  const dirs = new Map([
    ['', [{ name: 'Dup', isDir: true }]],
    ['Dup', [{ name: 'Same.jpg', isDir: false }, { name: 'SAME.jpg', isDir: false }]],
  ]);
  const index = indexFromDirs(dirs);
  assert.equal(index.collisions.length, 1);
  assert.equal(index.collisions[0].dir, 'Dup');
  assert.equal(index.collisions[0].names.length, 2);
  assert.equal(classifyPhotoRef(index, 'Dup/sAME.jpg', MARK).status, 'ambiguous');
  assert.equal(classifyPhotoRef(index, 'Dup/Same.jpg', MARK).status, 'exact');
});

test('reference collectors read manifest photoPath, cache keys and filePath, and image-named strings only', () => {
  const manifest = {
    version: 1,
    platforms: { gbp: [{ photoPath: `${OLD}\\Curated\\exact.jpg` }, { photoPath: '' }], fb: [] },
  };
  assert.deepEqual(manifestRefs(manifest).map((r) => r.source), ['manifest.photoPath']);
  const cache = {
    [`${OLD}\\Curated\\exact.jpg`]: { filePath: `${OLD}\\Curated\\exact.jpg` },
    [`${OLD}\\Curated\\other.jpg`]: { filePath: `${OLD}\\Curated\\renamed.jpg` },
  };
  assert.deepEqual(cacheRefs(cache).map((r) => r.source), ['cache.key', 'cache.key', 'cache.filePath']);
  const scanned = scanRefs({ labels: { a: { filenames: ['IMG_1234.jpg'] } }, note: 'see https://x.test/a.jpg', n: 3 }, 'labels.json');
  assert.deepEqual(scanned.map((r) => r.ref), ['IMG_1234.jpg']);
});

test('runAudit over mixed sources: counts by source, findings, exit 2', () => {
  const dir = fs.mkdtempSync(path.join(root, 'state-'));
  const manifest = path.join(dir, 'manifest.json');
  const cache = path.join(dir, 'cache.json');
  const scan = path.join(dir, 'labels.json');
  fs.writeFileSync(manifest, JSON.stringify({
    version: 1,
    platforms: {
      gbp: [{ photoPath: `${OLD}\\Curated\\IMG_1234.jpg` }, { photoPath: `${OLD}\\Curated\\exact.jpg` }],
      fb: [{ photoPath: 'E:\\Media\\Grizzly\\Curated\\gone.jpg' }],
    },
  }));
  fs.writeFileSync(cache, JSON.stringify({
    [`${OLD}\\Curated\\exact.jpg`]: { filePath: `${OLD}\\Curated\\exact.jpg` },
    [`${OLD}\\Curated\\deleted.jpg`]: { filePath: `${OLD}\\Curated\\deleted.jpg` },
  }));
  fs.writeFileSync(scan, JSON.stringify({ a: { filenames: ['IMG_1234.jpg', 'exact.jpg'] } }));

  const report = runAudit({ photos: lib, manifest, cache, scan: [scan] });
  assert.deepEqual(report.sources['manifest.photoPath'],
    { total: 3, exact: 1, case: 1, ambiguous: 0, missing: 1, unrooted: 1 });
  assert.deepEqual(report.sources['cache.key'],
    { total: 2, exact: 1, case: 0, ambiguous: 0, missing: 1, unrooted: 0 });
  assert.deepEqual(report.sources['scan:labels.json'],
    { total: 2, exact: 1, case: 1, ambiguous: 0, missing: 0, unrooted: 2 });
  assert.equal(report.totals.case, 2);
  assert.equal(report.totals.missing, 2);
  assert.equal(report.collisions.length, 0);
  assert.equal(report.exit, 2);
  const caseFinding = report.findings.find((f) => f.status === 'case' && f.source === 'manifest.photoPath');
  assert.equal(caseFinding.suggested, 'Curated/IMG_1234.JPG');
});

test('runAudit exits 0 when every reference is exact', () => {
  const dir = fs.mkdtempSync(path.join(root, 'clean-'));
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify([{ photoPath: `${OLD}\\Curated\\exact.jpg` }]));
  const report = runAudit({ photos: lib, manifest });
  assert.equal(report.totals.exact, 1);
  assert.equal(report.exit, 0);
  assert.deepEqual(report.findings, []);
});

test('a library that cannot be read is an error, not a clean report', () => {
  assert.throws(() => runAudit({ photos: path.join(root, 'no-such-library') }), /not readable/);
});
