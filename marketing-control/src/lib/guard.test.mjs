import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  wrapReadOnly,
  READ_ONLY,
  MUTATION_METHODS,
  assertReadOnlySource,
} from './guard.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POST_METHOD = /method:\s*['"]POST['"]/i;

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function isAllowlisted(file) {
  const base = file.split(/[/\\]/).pop();
  return base === 'guard.js' || base.endsWith('.test.mjs');
}

describe('wrapReadOnly', () => {
  it('allows select on a fake', () => {
    let selected = false;
    const wrapped = wrapReadOnly({
      select() {
        selected = true;
        return 'ok';
      },
    });
    assert.equal(wrapped.select(), 'ok');
    assert.equal(selected, true);
  });

  it('throws READ_ONLY on insert/update/delete/upsert/rpc', () => {
    const wrapped = wrapReadOnly({});
    for (const method of MUTATION_METHODS) {
      assert.throws(() => wrapped[method], { message: READ_ONLY });
    }
  });

  it('from().insert throws and the insert function never runs', () => {
    let inserted = false;
    const client = wrapReadOnly({
      from() {
        return {
          insert() {
            inserted = true;
            return 'wrote';
          },
          select() {
            return 'ok';
          },
        };
      },
    });
    assert.throws(() => client.from('x').insert(), { message: READ_ONLY });
    assert.equal(inserted, false);
    assert.equal(client.from('x').select(), 'ok');
  });

  it('passes primitives through', () => {
    assert.equal(wrapReadOnly(null), null);
    assert.equal(wrapReadOnly(undefined), undefined);
    assert.equal(wrapReadOnly('ok'), 'ok');
    assert.equal(wrapReadOnly(1), 1);
  });
});

describe('assertReadOnlySource', () => {
  it('returns mutation call needles found in source text', () => {
    assert.deepEqual(assertReadOnlySource('db.from("t").insert({})'), ['.insert(']);
    assert.deepEqual(
      assertReadOnlySource('row.update(); row.delete(); row.upsert(); row.rpc()'),
      ['.update(', '.delete(', '.upsert(', '.rpc('],
    );
    assert.deepEqual(assertReadOnlySource('select only'), []);
  });

  it('ignores the MUTATION_METHODS string list (not a call)', () => {
    const list = "export const MUTATION_METHODS = ['insert', 'update', 'delete', 'upsert', 'rpc'];";
    assert.deepEqual(assertReadOnlySource(list), []);
  });
});

describe('src walk — no mutation calls outside allowlist', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('finds js/jsx/mjs under src/', () => {
    assert.ok(files.length > 0);
  });

  it('production sources have no .insert/.update/.delete/.upsert/.rpc calls', () => {
    const hits = [];
    for (const file of files) {
      if (isAllowlisted(file)) continue;
      const found = assertReadOnlySource(readFileSync(file, 'utf8'));
      if (found.length) hits.push(`${relative(SRC_ROOT, file)}: ${found.join(', ')}`);
    }
    assert.deepEqual(hits, []);
  });

  it('production sources have no fetch POST', () => {
    const hits = [];
    for (const file of files) {
      if (isAllowlisted(file)) continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('fetch(')) continue;
      if (POST_METHOD.test(src)) hits.push(relative(SRC_ROOT, file));
    }
    assert.deepEqual(hits, []);
  });
});
