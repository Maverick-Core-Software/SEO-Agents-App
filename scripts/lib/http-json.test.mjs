/**
 * Node test for http-json pure helpers.
 * Run: node --test scripts/lib/http-json.test.mjs
 * Must never import mav-bridge — only the pure helper.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonBody, MAX_JSON_BODY_BYTES } from './http-json.mjs';

describe('parseJsonBody', () => {
  it('parses normal JSON objects unchanged', () => {
    const r = parseJsonBody('{"actionId":"abc","scope":"run_all"}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { actionId: 'abc', scope: 'run_all' });
  });

  it('empty body yields {} (backwards-compatible)', () => {
    assert.deepEqual(parseJsonBody(''), { ok: true, data: {} });
    assert.deepEqual(parseJsonBody(undefined), { ok: true, data: {} });
  });

  it('valid non-object JSON passes through (arrays, primitives)', () => {
    assert.deepEqual(parseJsonBody('[1,2]'), { ok: true, data: [1, 2] });
    assert.deepEqual(parseJsonBody('42'), { ok: true, data: 42 });
    assert.deepEqual(parseJsonBody('"hi"'), { ok: true, data: 'hi' });
  });

  it('malformed JSON returns client 400, not a throw', () => {
    const r = parseJsonBody('{"actionId":');
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.ok(r.error);
  });

  it('whitespace-only body is malformed → 400', () => {
    const r = parseJsonBody('   \n\t  ');
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it('oversized body returns 413', () => {
    const big = JSON.stringify({ pad: 'x'.repeat(MAX_JSON_BODY_BYTES) });
    const r = parseJsonBody(big);
    assert.equal(r.ok, false);
    assert.equal(r.status, 413);
    assert.ok(r.error.includes(String(MAX_JSON_BODY_BYTES)));
  });

  it('body at the limit parses fine', () => {
    // Exactly at the byte cap: valid JSON must still parse.
    // `{"pad":"` (8) + pad + `"}` (2) = 10 bytes of framing overhead.
    const payload = '{"pad":"' + 'x'.repeat(MAX_JSON_BODY_BYTES - 10) + '"}';
    const r = parseJsonBody(payload);
    assert.equal(r.ok, true);
  });

  it('byte-counts multibyte UTF-8 so emoji cannot exceed the cap', () => {
    // 24K emoji = 96KB UTF-8 but only 24K code units.
    const body = '"' + '😀'.repeat(24 * 1024) + '"';
    assert.ok(body.length < MAX_JSON_BODY_BYTES); // would pass a code-unit cap...
    const r = parseJsonBody(body);
    assert.equal(r.ok, false);
    assert.equal(r.status, 413); // ...but is rejected by the byte cap
  });
});
