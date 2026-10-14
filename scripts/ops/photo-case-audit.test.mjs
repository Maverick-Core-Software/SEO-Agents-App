import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import { runAudit, manifestRefs, cacheRefs, scanRefs } from './photo-case-audit.mjs';
import { buildPhotoIndex, classifyPhotoRef, indexFromDirs } from '../lib/photo-case.mjs';
import { parseAcceptList } from '../lib/photo-case-class.mjs';

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
  // Undated manifest refs are forward (cannot be proven historical): the manifest case and missing
  // refs and the labels.json case ref fail the default gate. The cache miss is historical.
  assert.equal(report.gates.default.failing, 3);
  assert.equal(report.gates.strict.failing, 4);
  assert.equal(report.exit, 2);
  assert.equal(runAudit({ photos: lib, manifest, cache, scan: [scan], strict: true }).exit, 2);
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

const TODAY = '2026-10-13';
const GONE = 'E:/Media/Grizzly/Curated';
const writeManifest = (dir, body) => {
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

test('default gate: a missing past-dated manifest entry is historical (exit 0); strict still fails on it', () => {
  const dir = fs.mkdtempSync(path.join(root, 'past-'));
  const manifest = writeManifest(dir, { version: 1, platforms: { gbp: [{ postDate: '2026-08-14 (Friday)', photoPath: `${GONE}/old.jpg` }] } });
  const def = runAudit({ photos: lib, manifest, today: TODAY });
  assert.equal(def.exit, 0);
  assert.equal(def.classes.historical.missing, 1);
  assert.equal(def.classes.forward.missing, 0);
  const strict = runAudit({ photos: lib, manifest, today: TODAY, strict: true });
  assert.equal(strict.exit, 2);
  assert.equal(strict.gates.strict.failing, 1);
});

test('default gate: a future-dated missing manifest entry is forward and fails', () => {
  const dir = fs.mkdtempSync(path.join(root, 'future-'));
  const manifest = writeManifest(dir, { version: 1, platforms: { gbp: [{ postDate: '2026-10-19 (Monday)', photoPath: `${GONE}/next.jpg` }] } });
  const report = runAudit({ photos: lib, manifest, today: TODAY });
  assert.equal(report.exit, 2);
  assert.equal(report.classes.forward.missing, 1);
  assert.equal(report.findings[0].class, 'forward');
  assert.equal(report.findings[0].reason, 'unposted-future');
});

test('workbook rows: posted and past-dated unposted rows are historical; an unposted future row is forward', () => {
  const dir = fs.mkdtempSync(path.join(root, 'wb-'));
  const book = path.join(dir, 'schedule.xlsx');
  const ws = xlsx.utils.aoa_to_sheet([
    ['Date', 'Status', 'Posted', 'AssetIdOrDescription'],
    ['2026-08-14', 'Approved', true, `${GONE}/a.jpg`],
    ['2026-08-15', 'Approved', false, `${GONE}/b.jpg`],
    ['2026-10-13', 'Approved', false, `${GONE}/c.jpg`],
    ['2026-10-14', 'Approved', false, ''],
  ]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Posts');
  xlsx.writeFile(wb, book);
  const report = runAudit({ photos: lib, workbook: book, today: TODAY });
  assert.deepEqual(report.sources['workbook.AssetIdOrDescription'], { total: 3, exact: 0, case: 0, ambiguous: 0, missing: 3, unrooted: 3 });
  assert.equal(report.classes.forward.missing, 1);
  assert.equal(report.classes.historical.missing, 2);
  assert.equal(report.findings.find((f) => f.ref.endsWith('a.jpg')).reason, 'posted');
  assert.equal(report.findings.find((f) => f.ref.endsWith('b.jpg')).reason, 'past-unposted');
  assert.equal(report.gates.default.failing, 1);
});

test('manifest: a gbp entry the workbook marks posted is historical; a facebook entry is judged by date alone', () => {
  const dir = fs.mkdtempSync(path.join(root, 'plat-'));
  const book = path.join(dir, 'schedule.xlsx');
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([
    ['Date', 'Posted', 'AssetIdOrDescription'],
    ['2026-08-14', true, `${GONE}/posted.jpg`],
  ]), 'Posts');
  xlsx.writeFile(wb, book);
  const manifest = writeManifest(dir, { version: 1, platforms: {
    gbp: [{ postDate: '2026-08-14 (Friday)', photoPath: `${GONE}/posted.jpg` }],
    facebook: [{ postDate: '2026-10-20 (Tuesday)', photoPath: `${GONE}/fb.jpg` }],
  } });
  const report = runAudit({ photos: lib, manifest, workbook: book, today: TODAY });
  const gbp = report.findings.find((f) => f.ref.endsWith('posted.jpg') && f.source === 'manifest.photoPath');
  assert.equal(gbp.class, 'historical');
  assert.equal(gbp.reason, 'posted');
  const fb = report.findings.find((f) => f.ref.endsWith('fb.jpg'));
  assert.equal(fb.class, 'forward');
  assert.equal(report.exit, 2);
});

test('manifest sourcePath is provenance: checked for existence, historical, never fails either gate', () => {
  const dir = fs.mkdtempSync(path.join(root, 'src-'));
  const manifest = writeManifest(dir, { version: 1, platforms: { gbp: [{ postDate: '2026-10-19', sourcePath: 'C:/Users/carte/Pictures/gone.jpg' }] } });
  const missing = runAudit({ photos: lib, manifest, today: TODAY, strict: true, exists: () => false });
  assert.equal(missing.sources['manifest.sourcePath'].missing, 1);
  assert.equal(missing.classes.historical.missing, 1);
  assert.equal(missing.exit, 0);
  const present = runAudit({ photos: lib, manifest, today: TODAY, exists: () => true });
  assert.equal(present.sources['manifest.sourcePath'].exact, 1);
  assert.equal(present.exit, 0);
});

test('accept list: a Carter-approved forward miss is counted separately and clears both gates; unused entries are listed', () => {
  const dir = fs.mkdtempSync(path.join(root, 'acc-'));
  const manifest = writeManifest(dir, { version: 1, platforms: { gbp: [{ postDate: '2026-10-19 (Monday)', photoPath: `${GONE}/next.jpg` }] } });
  const accept = parseAcceptList('# Carter 2026-10-13\nNEXT.jpg\n\nnothing-here.jpg\n');
  const report = runAudit({ photos: lib, manifest, today: TODAY, accept });
  assert.equal(report.exit, 0);
  assert.equal(report.gates.default.failing, 0);
  assert.equal(report.gates.strict.failing, 0);
  assert.equal(report.accepted.length, 1);
  assert.equal(report.classes.forward.accepted, 1);
  assert.deepEqual(report.unusedAccept, ['nothing-here.jpg']);
  assert.equal(runAudit({ photos: lib, manifest, today: TODAY, accept, strict: true }).exit, 0);
});
