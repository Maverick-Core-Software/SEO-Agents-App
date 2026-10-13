/**
 * Node test for the shared import-safe entry guard.
 * Run: node --test scripts/lib/entry.test.mjs
 *
 * The junction case is the one that matters: the PC scheduler launches scripts
 * through the C:\Workspace junction while Node resolves them to D:\Workspace.
 * On Windows we create a real directory junction (no admin needed); on other
 * platforms fs.symlinkSync ignores the 'junction' type and makes a symlink.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './entry.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entry-guard-'));
}

// Remove only the alias link itself, never recurse into its target.
function removeLink(link) {
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link);
  }
}

describe('isMainModule', () => {
  it('is true when argv[1] is the module path itself', () => {
    const dir = makeTempDir();
    try {
      const mod = path.join(dir, 'worker.mjs');
      fs.writeFileSync(mod, 'export {};\n');
      assert.equal(isMainModule(pathToFileURL(mod).href, mod), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is true when argv[1] is a junction alias of the module directory', () => {
    const dir = makeTempDir();
    const alias = `${dir}-alias`;
    try {
      const realDir = path.join(dir, 'real');
      fs.mkdirSync(realDir);
      const mod = path.join(realDir, 'worker.mjs');
      fs.writeFileSync(mod, 'export {};\n');
      fs.symlinkSync(realDir, alias, 'junction');
      try {
        assert.equal(isMainModule(pathToFileURL(mod).href, path.join(alias, 'worker.mjs')), true);
      } finally {
        removeLink(alias);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false for a different file', () => {
    const dir = makeTempDir();
    try {
      const mod = path.join(dir, 'worker.mjs');
      const other = path.join(dir, 'other.mjs');
      fs.writeFileSync(mod, 'export {};\n');
      fs.writeFileSync(other, 'export {};\n');
      assert.equal(isMainModule(pathToFileURL(mod).href, other), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false when there is no argv[1] (imported, not run)', () => {
    // null/'' (not undefined: that would fall back to the default process.argv[1]).
    assert.equal(isMainModule(import.meta.url, null), false);
    assert.equal(isMainModule(import.meta.url, ''), false);
  });
});
