// scripts/lib/photo-name.test.mjs
// Stored photo paths are written by the Windows PC and read on Linux, so every case
// must hold regardless of the host separator (the helpers never call path.*).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { photoBasename, photoFilesIn, photoKey, samePhotoName } from './photo-name.mjs';

describe('photoBasename', () => {
  it('takes the last segment of a Windows absolute path', () => {
    assert.equal(photoBasename('C:\\photos\\a.JPG'), 'a.JPG');
  });

  it('takes the last segment of a POSIX path', () => {
    assert.equal(photoBasename('/srv/seo/photos/b.jpg'), 'b.jpg');
  });

  it('handles mixed separators and spaces in folder names', () => {
    assert.equal(photoBasename('C:\\GBP Post Photos/Curated\\c.png'), 'c.png');
  });

  it('returns a bare name unchanged and empty input as empty', () => {
    assert.equal(photoBasename('d.jpg'), 'd.jpg');
    assert.equal(photoBasename(''), '');
    assert.equal(photoBasename(null), '');
    assert.equal(photoBasename(undefined), '');
  });
});

describe('samePhotoName', () => {
  it('matches a Windows path to a bare name regardless of case', () => {
    assert.equal(samePhotoName('C:\\photos\\a.JPG', 'A.jpg'), true);
  });

  it('matches a POSIX path to a Windows path with different case', () => {
    assert.equal(samePhotoName('/srv/photos/a.jpg', 'C:\\photos\\A.JPG'), true);
  });

  it('compares Unicode-normalized names', () => {
    assert.equal(samePhotoName('Caf\u00e9.jpg', 'Cafe\u0301.jpg'), true);
  });

  it('rejects different names and never matches empty values', () => {
    assert.equal(samePhotoName('a.jpg', 'b.jpg'), false);
    assert.equal(samePhotoName('', ''), false);
    assert.equal(samePhotoName(null, 'a.jpg'), false);
  });
});

describe('photoKey and photoFilesIn', () => {
  it('keys a stored path by its lower-cased basename', () => {
    assert.equal(photoKey('D:\\Workspace\\Photos\\X.JPG'), 'x.jpg');
  });

  it('splits multi-file photo_file values the way facebook-poster does', () => {
    assert.deepEqual(photoFilesIn('a.jpg, C:\\p\\b.jpg | c.jpg'), ['a.jpg', 'C:\\p\\b.jpg', 'c.jpg']);
    assert.deepEqual(photoFilesIn(null), []);
    assert.deepEqual(photoFilesIn('  '), []);
  });
});
