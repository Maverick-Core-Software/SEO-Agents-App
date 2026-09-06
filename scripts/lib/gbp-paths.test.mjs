import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import {
  resolveWritableCuratedFolder,
  resolveGbpImagePath,
  resolveConfiguredCuratedFolder,
  existingPhotoSearchDirs,
  firstExistingDir,
  pickCuratedFallbackPhoto,
  DEFAULT_GBP_CURATED_FOLDER,
  LEGACY_GBP_CURATED_FOLDER,
} from './gbp-paths.mjs';

{
  const calls = [];
  const dir = resolveWritableCuratedFolder({
    curatedPreferred: 'E:\\Media\\Grizzly\\Curated',
    localCache: 'C:\\cache',
    mkdirSync: (d) => {
      calls.push(d);
      if (String(d).startsWith('E:')) {
        const err = new Error(`ENOENT: no such file or directory, mkdir '${d}'`);
        err.code = 'ENOENT';
        throw err;
      }
    },
  });
  assert.equal(dir, path.join('C:\\cache', 'Curated'));
  assert.equal(calls[0], 'E:\\Media\\Grizzly\\Curated');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-paths-'));
  const cache = path.join(tmp, 'cache');
  const curated = path.join(cache, 'Curated');
  fs.mkdirSync(curated, { recursive: true });
  fs.writeFileSync(path.join(cache, 'IMG_2402.JPG'), 'x');
  fs.writeFileSync(path.join(cache, '2026-08-21-panel.jpg'), 'y');
  fs.writeFileSync(path.join(curated, '2023-10-11-panel-1.jpg'), 'z');
  fs.writeFileSync(path.join(curated, '2018-08-17-lighting-1.jpg'), 'l');

  const byName = resolveGbpImagePath('IMG_2402.JPG', { date: '2026-08-21', localCache: cache });
  assert.equal(byName, path.join(cache, 'IMG_2402.JPG'));

  const missingName = resolveGbpImagePath('nope.jpg', { date: '2026-08-21', localCache: cache });
  assert.equal(missingName, path.join(cache, '2026-08-21-panel.jpg'));

  const abs = resolveGbpImagePath(path.join(cache, 'IMG_2402.JPG'), { localCache: cache });
  assert.equal(abs, path.join(cache, 'IMG_2402.JPG'));

  assert.ok(existingPhotoSearchDirs({ localCache: cache }).includes(cache));

  // Dead E: path still finds curated files under the local cache.
  const viaDeadE = resolveGbpImagePath(
    'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos\\old-long-name.jpg',
    {
      date: '2026-09-09',
      topic: 'Panel upgrade',
      caption: 'Replace the main electrical panel',
      curatedPreferred: 'E:\\Media\\Grizzly\\Curated',
      localCache: cache,
    },
  );
  assert.match(path.basename(viaDeadE), /panel/i, 'missing workbook basename falls back to service-matched curated file');
  assert.ok(viaDeadE.toLowerCase().includes('curated'), 'fallback must come from the curated folder');

  // Post-date prefix is not the only fallback: 2026-09-10 has no 2026-09-10-*.jpg.
  const lighting = resolveGbpImagePath('missing-fluorescent-t12.jpg', {
    date: '2026-09-10',
    topic: 'LED retrofit lighting',
    caption: 'Replace fluorescent T12 lamps with LED fixtures',
    curatedPreferred: curated,
    localCache: cache,
  });
  assert.equal(path.basename(lighting), '2018-08-17-lighting-1.jpg');

  // Require-photo still blocks empty path when no images exist.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-empty-'));
  const none = resolveGbpImagePath('', { date: '2026-09-09', localCache: empty, curatedPreferred: empty });
  assert.equal(none, '');
  fs.rmSync(empty, { recursive: true, force: true });

  // Any unused curated still when the topic has no service keywords.
  const anyStill = pickCuratedFallbackPhoto({
    date: '2026-09-11',
    topic: 'Electrical safety reminder',
    caption: 'Stay safe this storm season',
    curatedPreferred: curated,
    localCache: cache,
  });
  assert.ok(anyStill && fs.existsSync(anyStill), 'no service match still picks a curated still');

  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-cfg-'));
  const curated = path.join(tmp, 'Curated');
  fs.mkdirSync(curated, { recursive: true });
  const hit = resolveConfiguredCuratedFolder('E:\\Media\\Grizzly\\Curated', {
    GBP_CURATED_FOLDER: curated,
    GBP_PHOTOS_LOCAL_CACHE: tmp,
  });
  assert.equal(hit, curated);
  assert.notEqual(hit, LEGACY_GBP_CURATED_FOLDER);
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const exists = new Set(['C:\\real\\Curated']);
  assert.equal(
    firstExistingDir(['E:\\Media\\Grizzly\\Curated', 'C:\\real\\Curated'], (d) => exists.has(d)),
    'C:\\real\\Curated',
  );
  const skipped = resolveConfiguredCuratedFolder('E:\\Media\\Grizzly\\Curated', {});
  assert.notEqual(skipped, 'E:\\Media\\Grizzly\\Curated');
  assert.ok(skipped === DEFAULT_GBP_CURATED_FOLDER || fs.existsSync(skipped));
}

console.log('ok gbp-paths');
