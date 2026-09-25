import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ALLOWED_LABELS,
  CAPTION_CHECK_MAX_CANDIDATES,
  allowlistAllows,
  derivePostServiceType,
  hashConflicts,
  isManifestSelectionCompatible,
  labelForPhoto,
  loadCompatAllowlist,
  loadCuratedLabels,
  loadSelectionManifest,
  manifestIsKeyed,
  migrateHistoryToHashes,
  normalizeServiceKey,
  pathToHashIndex,
  reservePhotoHashes,
  saveSelectionManifest,
  selectionIdentityKeys,
  selectPhotoCandidatesForPost,
  serviceKeyForPost,
  serviceSlug,
  sha256File,
  verifyPhotoCandidates,
  withManifestLock,
} from './photo-selection.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'photo-selection-'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
function writeFile(text, ext = '.jpg') {
  const file = path.join(tmpDir(), `fixture-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(file, Buffer.alloc(64, text.charCodeAt(0) || 0x41));
  return file;
}

const labelsFile = (labels) => {
  const file = path.join(tmpDir(), 'curated-labels.json');
  writeJson(file, labels);
  return file;
};

test('specific service terms win over generic panel wording', () => {
  assert.equal(derivePostServiceType({ service: 'Generator Installation', topic: 'generator panel' }), 'generator');
  assert.equal(derivePostServiceType({ service: 'Panel Upgrades' }), 'panel');
});

test('a photo must have an audited, same-service manifest entry', () => {
  const post = { service: 'Panel Upgrades' };
  const manifest = [{
    postDate: '2026-08-09',
    postService: 'Panel Upgrades',
    postServiceType: 'panel',
    photoPath: 'E:/Media/Grizzly/Curated/2026-08-09-panel-upgrades.jpg',
    photoServiceType: 'panel',
  }];

  assert.equal(isManifestSelectionCompatible({
    date: '2026-08-09', service: post.service,
    photoPath: 'e:\\media\\grizzly\\curated\\2026-08-09-panel-upgrades.jpg', manifest,
  }).ok, true);
  assert.equal(isManifestSelectionCompatible({
    date: '2026-08-09', service: post.service,
    photoPath: 'E:/Media/Grizzly/Curated/2026-08-09-panel-upgrades.jpg',
    manifest: [{ ...manifest[0], photoServiceType: 'generator' }],
  }).ok, false);
  assert.equal(isManifestSelectionCompatible({
    date: '2026-08-09', service: post.service,
    photoPath: 'E:/Media/Grizzly/Curated/2026-08-09-panel-upgrades.jpg', manifest: [],
  }).ok, false);
});

test('structured service key is decided from the title, body only as fallback', () => {
  assert.deepEqual(serviceKeyForPost({ service: 'EV Charger Install', body: 'we replaced the panel' }), { key: 'ev-charger', source: 'title' });
  assert.deepEqual(serviceKeyForPost({ service: 'Emergency electrician', body: 'a burnt breaker box' }), { key: 'panel', source: 'body' });
  assert.deepEqual(serviceKeyForPost({ service: 'Cost transparency' }), { key: 'other', source: 'none' });
  assert.equal(normalizeServiceKey('Smoke_Co'), 'smoke-co');
  assert.equal(derivePostServiceType({ service: 'Whole-Home Surge Protection' }), 'surge');
});

test('allowed-label table has no silent cross-topic fallback', () => {
  assert.deepEqual(ALLOWED_LABELS.panel, ['panel']);
  assert.equal(allowlistAllows({ pairs: new Set() }, 'panel', 'panel'), true);
  assert.equal(allowlistAllows({ pairs: new Set() }, 'ev-charger', 'panel'), false);
  assert.equal(allowlistAllows({ pairs: new Set(['ev-charger|panel']) }, 'ev-charger', 'panel'), true);
  assert.equal(allowlistAllows({ pairs: new Set(['ev-charger|panel']) }, 'generator', 'panel'), false);
});

test('allowlist file: missing/empty blocks, named pairs allow (all shapes)', () => {
  const missing = loadCompatAllowlist(path.join(tmpDir(), 'nope.json'));
  assert.equal(missing.present, false);
  assert.equal(allowlistAllows(missing, 'generator', 'panel'), false);

  const empty = loadCompatAllowlist(labelsFile([]));
  assert.equal(empty.present, false);
  assert.equal(allowlistAllows(empty, 'generator', 'panel'), false);

  for (const shape of [['generator|panel'], [['generator', 'panel']], { pairs: [{ from: 'generator', to: 'panel' }] }]) {
    const loaded = loadCompatAllowlist(labelsFile(shape));
    assert.equal(loaded.present, true, JSON.stringify(shape));
    assert.equal(allowlistAllows(loaded, 'generator', 'panel'), true);
  }
});

test('selection path: same-topic passes, cross-topic needs the allowlist', () => {
  const panel = { path: 'C:/curated/2026-09-01-panel-1.jpg', serviceType: 'panel', score: 90, hash: 'hh-panel' };
  const generator = { path: 'C:/curated/2026-09-01-generator-1.jpg', serviceType: 'generator', score: 95, hash: 'hh-gen' };
  const labels = loadCuratedLabels(labelsFile({
    'hh-gen': { service_type: 'generator', quality: 'ok', tags: ['generator'] },
  }));

  const sameTopic = selectPhotoCandidatesForPost({
    post: { service: 'Generator Installation' }, pool: [generator], labels,
  });
  assert.equal(sameTopic.status, 'ok');
  assert.equal(sameTopic.candidates[0].serviceType, 'generator');
  assert.equal(sameTopic.candidates[0].labelSource, 'curated-labels');

  const crossTopic = selectPhotoCandidatesForPost({
    post: { service: 'Generator Installation' }, pool: [panel], labels,
  });
  assert.equal(crossTopic.status, 'blocked');
  assert.match(crossTopic.rejected[0].reason, /cross-topic: post key "generator" vs photo label "panel"/);
  assert.equal(crossTopic.rejected[0].filename, '2026-09-01-panel-1.jpg');

  const allowed = selectPhotoCandidatesForPost({
    post: { service: 'Generator Installation' },
    pool: [generator, panel],
    labels,
    allowlist: loadCompatAllowlist(labelsFile(['generator|panel'])),
  });
  assert.equal(allowed.status, 'ok');
  assert.deepEqual(allowed.candidates.map((c) => c.serviceType), ['generator', 'panel']);
  assert.equal(allowed.candidates[1].allowlistPair, 'generator|panel');
  assert.deepEqual(allowed.flags.allowlistExceptions, ['generator|panel']);
});

test('selection path: photos already handed out this run are skipped before the cap', () => {
  const pool = [
    { path: 'C:/curated/2026-09-01-panel-1.jpg', serviceType: 'panel', score: 90 },
    { path: 'C:/curated/2026-09-01-panel-2.jpg', serviceType: 'panel', score: 88 },
    { path: 'C:/curated/2026-09-01-panel-3.jpg', serviceType: 'panel', score: 86 },
    { path: 'C:/curated/2026-09-01-panel-4.jpg', serviceType: 'panel', score: 84 },
  ];
  const first = selectPhotoCandidatesForPost({ post: { service: 'Panel Upgrade' }, pool, maxCandidates: 1 });
  assert.equal(first.candidates[0].filename, '2026-09-01-panel-1.jpg');

  const second = selectPhotoCandidatesForPost({
    post: { service: 'Panel Upgrade' }, pool, maxCandidates: 1,
    usedPaths: ['C:\\curated\\2026-09-01-panel-1.jpg'],
  });
  assert.equal(second.candidates[0].filename, '2026-09-01-panel-2.jpg', 'the cap must not starve later posts');
  assert.ok(second.rejected.some((r) => /already used by an earlier post/.test(r.reason)));

  const none = selectPhotoCandidatesForPost({
    post: { service: 'Panel Upgrade' }, pool,
    usedPaths: pool.map((p) => p.path),
  });
  assert.equal(none.status, 'blocked');
});

test('unshippable label quality is rejected; missing labels fall back to filename, flagged unverified', () => {
  const photo = { path: 'C:/curated/2026-09-02-panel-1.jpg', serviceType: 'panel', score: 80, hash: 'hash-people' };
  const withLabels = selectPhotoCandidatesForPost({
    post: { service: 'Panel Upgrade' },
    pool: [photo],
    labels: loadCuratedLabels(labelsFile({ 'hash-people': { service_type: 'panel', quality: 'people' } })),
  });
  assert.equal(withLabels.status, 'blocked');
  assert.match(withLabels.rejected[0].reason, /quality "people"/);

  const unlabeled = selectPhotoCandidatesForPost({ post: { service: 'Panel Upgrade' }, pool: [photo] });
  assert.equal(unlabeled.status, 'ok');
  assert.equal(unlabeled.candidates[0].labelSource, 'filename');
  assert.equal(unlabeled.candidates[0].unverified, true);
  assert.equal(unlabeled.flags.labelUnverified, true);

  const noHint = selectPhotoCandidatesForPost({ post: { service: 'Panel Upgrade' }, pool: [{ path: 'C:/curated/IMG_1234.jpg' }] });
  assert.equal(noHint.status, 'blocked', 'an un-typed photo is cross-topic, never a silent fallback');
});

test('commercial context is an explicit tag, not keyword order', () => {
  const commercialPhoto = { path: 'C:/curated/2026-09-03-panel-1.jpg', serviceType: 'panel', score: 80 };
  const labelFile = labelsFile({
    'C:/curated/2026-09-03-panel-1.jpg': { service_type: 'panel', quality: 'ok', context: 'residential' },
  });
  const labels = loadCuratedLabels(labelFile);

  const clash = selectPhotoCandidatesForPost({
    post: { service: 'Panel Upgrade', commercial: true }, pool: [commercialPhoto], labels,
  });
  assert.equal(clash.status, 'blocked');
  assert.match(clash.rejected[0].reason, /context mismatch/);

  const match = selectPhotoCandidatesForPost({
    post: { service: 'Panel Upgrade', tags: ['commercial'] },
    pool: [commercialPhoto],
    labels: loadCuratedLabels(labelsFile({ 'C:/curated/2026-09-03-panel-1.jpg': { service_type: 'panel', quality: 'ok', context: 'commercial' } })),
  });
  assert.equal(match.status, 'ok');

  const unknown = selectPhotoCandidatesForPost({ post: { service: 'Panel Upgrade' }, pool: [commercialPhoto], labels });
  assert.equal(unknown.status, 'ok');
  assert.equal(unknown.flags.contextUnverified, true);
});

test('content-hash no-reuse spans platforms and 8 weeks, unknown history explicit', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const history = [
    { platform: 'fb', photoHash: 'reused-hash', selectedAt: '2026-09-20T12:00:00Z' },
    { platform: 'gbp', sourceHash: 'old-hash', selectedAt: '2026-05-01T12:00:00Z' },
    { platform: 'gbp', sourcePath: 'C:/old/photo.jpg' },
  ];
  const inWindow = hashConflicts({ hashes: ['reused-hash'], history, now });
  assert.equal(inWindow.conflicts.length, 1);
  assert.equal(inWindow.windowDays, 56);

  const expired = hashConflicts({ hashes: ['old-hash'], history, now });
  assert.equal(expired.conflicts.length, 0);

  const unknown = hashConflicts({ hashes: ['reused-hash'], history, now });
  assert.equal(unknown.unknown.noHash, 1);
  assert.equal(unknown.unknown.unverifiedHistory, true);

  const pick = selectPhotoCandidatesForPost({
    post: { service: 'Panel Upgrade' },
    pool: [{ path: 'C:/curated/2026-09-24-panel-1.jpg', hash: 'reused-hash', score: 80 }],
    history, now,
  });
  assert.equal(pick.status, 'blocked');
  assert.match(pick.rejected[0].reason, /reused within 8 weeks/);
  assert.equal(pick.flags.unverifiedHistory, true, 'unknown history is reported, not hidden');
});

test('history migration is pure: paths resolve through the index, the rest stay unknown', () => {
  const a = writeFile('aaa');
  const b = writeFile('bbb');
  const { index } = pathToHashIndex([a, b], { hashFile: () => 'deadbeef' });
  assert.equal(index.size, 2);

  const { entries, unresolved, changed, unknownHistory } = migrateHistoryToHashes([
    { postDate: '2026-08-01', photoPath: a, sourcePath: b },
    { postDate: '2026-08-02', photoPath: 'C:/gone/missing.jpg' },
  ], { index });
  assert.equal(changed, 2);
  assert.equal(entries[0].photoHash, 'deadbeef');
  assert.equal(entries[0].sourceHash, 'deadbeef');
  assert.equal(entries[1].photoHash, undefined);
  assert.equal(unresolved.length, 1);
  assert.equal(unknownHistory, true);
});

test('identity keys include hashes and both path shapes (FB used-path misses)', () => {
  const keys = selectionIdentityKeys({
    sourcePath: 'C:\\Curated\\IMG_1.JPG',
    photoPath: 'C:/shipped/2026-09-01-panel.jpg',
    sourceHash: 'ABCD',
  });
  assert.ok(keys.includes('c:/curated/img_1.jpg'));
  assert.ok(keys.includes('c:/shipped/2026-09-01-panel.jpg'));
  assert.ok(keys.includes('abcd'));
});

test('platform-keyed manifest keeps GBP entries when FB rewrites its own', () => {
  const file = path.join(tmpDir(), 'manifest.json');
  saveSelectionManifest(file, [
    { postDate: '2026-09-20', photoPath: 'C:/gbp/a.jpg', postService: 'Panel Upgrade' },
    { postDate: '2026-09-21', photoPath: 'C:/fb/b.jpg', platform: 'fb' },
  ], { platform: 'gbp' });

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifestIsKeyed(raw), true);
  assert.deepEqual(Object.keys(raw.platforms).sort(), ['fb', 'gbp']);

  // FB purges/replaces only its own bucket.
  const fbOnly = loadSelectionManifest(file, { platform: 'fb' });
  assert.equal(fbOnly.length, 1);
  saveSelectionManifest(file, { version: 1, platforms: { ...raw.platforms, fb: [...fbOnly, { postDate: '2026-09-22', photoPath: 'C:/fb/c.jpg' }] } });

  const gbp = loadSelectionManifest(file, { platform: 'gbp' });
  assert.equal(gbp.length, 1, 'GBP entries survive an FB-only rewrite');
  assert.equal(gbp[0].photoPath, 'C:/gbp/a.jpg');
  assert.equal(loadSelectionManifest(file).length, 3, 'the flattened read still sees every platform');
});

test('reservation lock: same hash cannot be reserved twice, different hashes can', () => {
  const file = path.join(tmpDir(), 'manifest.json');
  const first = reservePhotoHashes({
    manifestPath: file, platform: 'gbp', hashes: ['hash-1'],
    meta: { postDate: '2026-09-25', photoPath: 'C:/curated/a.jpg' },
    now: Date.parse('2026-09-25T12:00:00Z'),
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.reserved, ['hash-1']);

  const second = reservePhotoHashes({
    manifestPath: file, platform: 'fb', hashes: ['hash-1'],
    meta: { postDate: '2026-09-25', photoPath: 'C:/curated/b.jpg' },
    now: Date.parse('2026-09-25T12:00:00Z'),
  });
  assert.equal(second.ok, false, 'the bridge and the worker cannot reserve the same hash');
  assert.equal(second.conflicts.length, 1);

  const other = reservePhotoHashes({
    manifestPath: file, platform: 'fb', hashes: ['hash-2'],
    meta: { postDate: '2026-09-25', photoPath: 'C:/curated/c.jpg' },
    now: Date.parse('2026-09-25T12:00:00Z'),
  });
  assert.equal(other.ok, true);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'lock released');
  assert.equal(loadSelectionManifest(file).length, 2);
});

test('manifest lock: a held lock blocks, a stale lock is reclaimed', () => {
  const file = path.join(tmpDir(), 'manifest.json');
  const lockPath = `${file}.lock`;
  fs.writeFileSync(lockPath, 'other-process');

  let ticks = 0;
  assert.throws(() => withManifestLock(file, () => 'never', {
    timeoutMs: 50, sleepMs: 5, now: () => (ticks += 1000),
    fsImpl: { ...fs, mkdirSync: fs.mkdirSync, openSync: fs.openSync, writeSync: fs.writeSync, closeSync: fs.closeSync, statSync: fs.statSync, unlinkSync: fs.unlinkSync },
  }), /manifest lock busy/);

  const stale = Date.now() - 10 * 60 * 1000;
  fs.utimesSync(lockPath, new Date(stale), new Date(stale));
  assert.equal(withManifestLock(file, () => 'reclaimed', { staleMs: 60000 }), 'reclaimed');
  assert.equal(fs.existsSync(lockPath), false);
});

test('caption-photo check: 3 candidates max, then allowlist photo or text-only', async () => {
  const seen = [];
  const noThenYes = async ({ image }) => { seen.push(image.hash); return { matches: seen.length === 2, reason: seen.length === 2 ? 'panel matches' : 'wrong service' }; };
  const candidates = [
    { path: 'C:/curated/a.jpg', hash: 'h1' },
    { path: 'C:/curated/b.jpg', hash: 'h2' },
    { path: 'C:/curated/c.jpg', hash: 'h3' },
    { path: 'C:/curated/d.jpg', hash: 'h4' },
  ];
  const passed = await verifyPhotoCandidates({ candidates, hook: 'panel swap', service: 'Panel Upgrade', visionClient: noThenYes });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.chosen.hash, 'h2');
  assert.equal(seen.length, 2);
  assert.deepEqual(passed.verdicts.map((v) => v.verdict), ['no', 'yes']);
  assert.deepEqual(passed.verdicts.map((v) => v.hash), ['h1', 'h2']);

  const allNo = await verifyPhotoCandidates({
    candidates, hook: 'x', service: 'Panel Upgrade',
    visionClient: async () => ({ matches: false }),
    allowlistPhoto: { path: 'C:/curated/allowlisted.jpg', hash: 'h-allow' },
  });
  assert.equal(allNo.status, 'allowlist-photo');
  assert.equal(allNo.attempts, CAPTION_CHECK_MAX_CANDIDATES);
  assert.equal(allNo.chosen.hash, 'h-allow');

  const textOnly = await verifyPhotoCandidates({ candidates, hook: 'x', service: 'Panel Upgrade', visionClient: async () => ({ matches: false }) });
  assert.equal(textOnly.status, 'text-only');
  assert.equal(textOnly.chosen, null);

  const noCandidates = await verifyPhotoCandidates({ candidates: [], hook: 'x', service: 'Panel Upgrade', visionClient: async () => ({ matches: true }) });
  assert.equal(noCandidates.status, 'text-only');
});

test('caption-photo check: an unavailable vision service is unverified, never passed', async () => {
  const thrown = await verifyPhotoCandidates({
    candidates: [{ path: 'C:/curated/a.jpg', hash: 'h1' }], hook: 'x', service: 'Panel Upgrade',
    visionClient: async () => { throw new Error('429 rate limited'); },
  });
  assert.equal(thrown.status, 'unverified');
  assert.equal(thrown.chosen, null);
  assert.equal(thrown.verdicts[0].verdict, 'unverified');

  const nullish = await verifyPhotoCandidates({
    candidates: [{ path: 'C:/curated/b.jpg', hash: 'h2' }], hook: 'x', service: 'Panel Upgrade',
    visionClient: async () => ({ matches: null, reason: 'vision offline' }),
  });
  assert.equal(nullish.status, 'unverified');
  assert.equal(nullish.reason, 'vision offline');

  const noClient = await verifyPhotoCandidates({ candidates: [{ path: 'C:/curated/c.jpg' }], visionClient: null });
  assert.equal(noClient.status, 'unverified');
});

test('label readers tolerate the P2.1 shapes and the missing file', () => {
  assert.equal(loadCuratedLabels(path.join(tmpDir(), 'missing.json')).present, false);

  const keyed = loadCuratedLabels(labelsFile({
    'sha-1': { service_type: 'ev-charger', subtype: 'level-2', tags: ['commercial'], quality: 'ok', filenames: ['IMG_1.HEIC'] },
  }));
  assert.equal(keyed.present, true);
  assert.equal(keyed.byHash.get('sha-1').key, 'ev-charger');
  assert.equal(keyed.byHash.get('sha-1').context, 'commercial');
  assert.equal(keyed.byFilename.get('img_1.heic').key, 'ev-charger');

  const wrapped = loadCuratedLabels(labelsFile({ labels: { 'sha-2': { service_type: 'panel', quality: 'ok' } } }));
  assert.equal(wrapped.byHash.get('sha-2').key, 'panel');

  const arrayed = loadCuratedLabels(labelsFile([{ hash: 'sha-3', service_type: 'surge', quality: 'ok' }]));
  assert.equal(arrayed.byHash.get('sha-3').key, 'surge');

  assert.equal(labelForPhoto({ hash: 'sha-1' }, keyed).source, 'curated-labels');
  assert.equal(labelForPhoto({ path: 'C:/curated/2026-09-13-ev-charger-1.jpg' }, keyed).key, 'ev-charger');
  assert.equal(labelForPhoto({ path: 'C:/curated/2026-09-13-ev-charger-1.jpg' }, keyed).unverified, true);
});

test('manifest hash lookup keeps the publisher audit working after migration', () => {
  const b = writeFile('bbb');
  const hash = sha256File(b);
  const manifest = [{ postDate: '2026-09-25', postService: 'Panel Upgrades', postServiceType: 'panel', photoPath: '', photoHash: hash, photoServiceType: 'panel' }];
  const ok = isManifestSelectionCompatible({ date: '2026-09-25', service: 'Panel Upgrades', photoPath: '', photoHash: hash, manifest });
  assert.equal(ok.ok, true);
  assert.equal(isManifestSelectionCompatible({ date: '2026-09-25', service: 'Panel Upgrades', photoPath: '', photoHash: 'other', manifest }).ok, false);
});

assert.equal(serviceSlug('Panel Upgrades'), 'panel-upgrades');
console.log('ok photo-selection');
