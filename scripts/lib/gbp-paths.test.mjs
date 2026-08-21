import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import {
  resolveWritableCuratedFolder,
  resolveGbpImagePath,
  existingPhotoSearchDirs,
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
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'IMG_2402.JPG'), 'x');
  fs.writeFileSync(path.join(cache, '2026-08-21-panel.jpg'), 'y');

  const byName = resolveGbpImagePath('IMG_2402.JPG', { date: '2026-08-21', localCache: cache });
  assert.equal(byName, path.join(cache, 'IMG_2402.JPG'));

  const missingName = resolveGbpImagePath('nope.jpg', { date: '2026-08-21', localCache: cache });
  assert.equal(missingName, path.join(cache, '2026-08-21-panel.jpg'));

  const abs = resolveGbpImagePath(path.join(cache, 'IMG_2402.JPG'), { localCache: cache });
  assert.equal(abs, path.join(cache, 'IMG_2402.JPG'));

  assert.ok(existingPhotoSearchDirs({ localCache: cache }).includes(cache));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('ok gbp-paths');
