import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createCostMeter, priceFor } from '../lib/cost-meter.mjs';
import { createLlmClient, parseJsonLoose, preflightModel } from '../lib/llm.mjs';
import { BudgetExceeded } from '../lib/errors.mjs';

const PRICING = { 'deepseek-chat': { input: 0.27, output: 1.1 }, serpapi_per_call: 0.01 };

describe('cost meter', () => {
  it('prices tokens from the policy table', () => {
    assert.equal(priceFor(PRICING, 'deepseek-chat', 1_000_000, 1_000_000), 1.37);
    assert.equal(priceFor(PRICING, 'unknown', 10, 10), null);
  });
  it('records, sums, and warns on unknown models', () => {
    const m = createCostMeter({ ceilingUsd: 1, pricing: PRICING });
    m.record({ kind: 'llm', model: 'deepseek-chat', inputTokens: 200_000, outputTokens: 20_000, label: 'gen' });
    m.record({ kind: 'serpapi', label: 'q1' });
    const e = m.record({ kind: 'llm', model: 'mystery', inputTokens: 5, outputTokens: 5 });
    assert.equal(e.usd, 0);
    assert.match(e.warning, /no pricing for mystery/);
    assert.equal(m.spent(), 0.086); // 0.054 + 0.022 + 0.01
    assert.deepEqual(m.warnings(), ['no pricing for mystery']);
  });
  it('prices by the served model name, then the requested one', () => {
    const m = createCostMeter({ ceilingUsd: 1, pricing: PRICING });
    const e = m.record({ kind: 'llm', model: 'deepseek-v4-flash', fallbackModel: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 0 });
    assert.equal(e.usd, 0.27);
    assert.equal(e.warning, 'served deepseek-v4-flash but requested deepseek-chat');
  });
  it('T7: records the requested and the served id, prices from the served one, warns on a mismatch', () => {
    const m = createCostMeter({ ceilingUsd: 1, pricing: { ...PRICING, 'served-model': { input: 1, output: 0 } } });
    const e = m.record({ kind: 'llm', model: 'served-model', requestedModel: 'requested-model', inputTokens: 1_000_000, outputTokens: 0 });
    assert.equal(e.model, 'served-model');
    assert.equal(e.requested_model, 'requested-model');
    assert.equal(e.usd, 1, 'priced from the served id, not the requested one');
    assert.equal(e.warning, 'served served-model but requested requested-model');
    // The pinned id serving itself is the normal case and must stay quiet.
    const pinned = m.record({ kind: 'llm', model: 'deepseek-chat', requestedModel: 'deepseek-chat', inputTokens: 0, outputTokens: 0 });
    assert.equal(pinned.warning, null);
    assert.equal(pinned.requested_model, 'deepseek-chat');
  });
  it('assertUnder throws BudgetExceeded past the ceiling', () => {
    const m = createCostMeter({ ceilingUsd: 0.05, pricing: PRICING });
    m.record({ kind: 'llm', model: 'deepseek-chat', usd: 0.04 });
    m.assertUnder(0.005);
    assert.throws(() => m.assertUnder(0.02), BudgetExceeded);
  });
});

describe('parseJsonLoose', () => {
  it('accepts fenced and padded JSON', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```').value, { a: 1 });
    assert.deepEqual(parseJsonLoose('Here you go: {"a":[1,2]} thanks').value, { a: [1, 2] });
    assert.ok(parseJsonLoose('nothing here').error);
    assert.ok(parseJsonLoose('').error);
  });
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    return handler(calls[calls.length - 1]);
  };
  impl.calls = calls;
  return impl;
}

function okResponse(content, usage = { prompt_tokens: 100, completion_tokens: 50 }, model = 'deepseek-chat') {
  return { ok: true, status: 200, json: async () => ({ model, usage, choices: [{ message: { content } }] }) };
}

describe('llm client', () => {
  const Schema = z.object({ topic: z.string(), n: z.number() });

  it('requires apiKey and model', () => {
    assert.throws(() => createLlmClient({ model: 'x' }), /apiKey/);
    assert.throws(() => createLlmClient({ apiKey: 'k' }), /model/);
  });

  it('posts json_object mode, validates, and meters usage', async () => {
    const meter = createCostMeter({ ceilingUsd: 5, pricing: PRICING });
    const fetchImpl = fakeFetch(() => okResponse('{"topic":"panel","n":2}'));
    const llm = createLlmClient({ apiKey: 'k', model: 'deepseek-chat', fetchImpl, meter });
    const out = await llm.chatJSON({ system: 'You write plans as JSON.', user: { week: 1 }, schema: Schema, label: 'gen' });
    assert.deepEqual(out.data, { topic: 'panel', n: 2 });
    assert.deepEqual(out.issues, []);
    assert.deepEqual(out.usage, { input: 100, output: 50 });
    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(call.init.headers.authorization, 'Bearer k');
    assert.deepEqual(call.init.body.response_format, { type: 'json_object' });
    assert.equal(call.init.body.messages[1].content, '{"week":1}');
    assert.equal(meter.entries().length, 1);
    assert.equal(meter.entries()[0].label, 'gen');
  });

  it('meters a served model name that differs from the requested one', async () => {
    const meter = createCostMeter({ ceilingUsd: 5, pricing: PRICING });
    const fetchImpl = fakeFetch(() => okResponse('{"topic":"a","n":1}', { prompt_tokens: 1_000_000, completion_tokens: 0 }, 'served-name'));
    const llm = createLlmClient({ apiKey: 'k', model: 'deepseek-chat', fetchImpl, meter });
    const out = await llm.chatJSON({ system: 'json', user: 'x', schema: Schema });
    assert.equal(out.model, 'served-name');
    assert.equal(meter.spent(), 0.27);
    assert.deepEqual(meter.warnings(), ['served served-name but requested deepseek-chat']);
    assert.deepEqual(
      { model: meter.entries()[0].model, requested: meter.entries()[0].requested_model },
      { model: 'served-name', requested: 'deepseek-chat' },
    );
  });

  it('T7: prices a pinned request from the served id, not from the requested one', async () => {
    const meter = createCostMeter({ ceilingUsd: 5, pricing: { ...PRICING, 'deepseek-v4-flash': { input: 0.44, output: 1.32 } } });
    const fetchImpl = fakeFetch(() => okResponse('{"topic":"a","n":1}', { prompt_tokens: 1_000_000, completion_tokens: 0 }, 'deepseek-v4-flash'));
    const llm = createLlmClient({ apiKey: 'k', model: 'deepseek-v4-flash', fetchImpl, meter });
    await llm.chatJSON({ system: 'json', user: 'x', schema: Schema });
    const [entry] = meter.entries();
    assert.equal(entry.usd, 0.44);
    assert.deepEqual(entry.warning, null, 'the pinned id serving itself is not a mismatch');
  });

  it('appends a JSON instruction when the prompt never says json', async () => {
    const fetchImpl = fakeFetch(() => okResponse('{"topic":"a","n":1}'));
    const llm = createLlmClient({ apiKey: 'k', model: 'm', fetchImpl });
    await llm.chatJSON({ system: 'Plain words.', user: 'go', schema: Schema });
    assert.match(fetchImpl.calls[0].init.body.messages[0].content, /JSON object/);
  });

  it('returns issues instead of throwing on schema mismatch or non-JSON', async () => {
    const llm1 = createLlmClient({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(() => okResponse('{"topic":"a"}')) });
    const r1 = await llm1.chatJSON({ system: 'json', user: 'x', schema: Schema });
    assert.equal(r1.data, null);
    assert.equal(r1.issues[0].path, 'n');
    const llm2 = createLlmClient({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(() => okResponse('sorry, no')) });
    const r2 = await llm2.chatJSON({ system: 'json', user: 'x', schema: Schema });
    assert.equal(r2.data, null);
    assert.match(r2.issues[0].message, /not JSON/);
  });

  it('throws on HTTP errors with the status', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 429, text: async () => 'slow down' }));
    const llm = createLlmClient({ apiKey: 'k', model: 'm', fetchImpl });
    await assert.rejects(() => llm.chatJSON({ system: 'json', user: 'x' }), /HTTP 429 slow down/);
  });

  it('aborts on timeout', async () => {
    const fetchImpl = async (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    const llm = createLlmClient({ apiKey: 'k', model: 'm', fetchImpl, timeoutMs: 20 });
    await assert.rejects(() => llm.chatJSON({ system: 'json', user: 'x' }), /timeout after 20 ms/);
  });

  it('refuses a call whose projected cost would cross the ceiling', async () => {
    // 0.004 spent; ceiling 0.005; a call with maxTokens 8000 on deepseek-chat projects
    // ~0.0088 of output alone, so it must be refused before any request is made.
    const meter = createCostMeter({ ceilingUsd: 0.005, pricing: PRICING });
    meter.record({ kind: 'llm', model: 'deepseek-chat', usd: 0.004 });
    const fetchImpl = fakeFetch(() => okResponse('{}'));
    const llm = createLlmClient({ apiKey: 'k', model: 'deepseek-chat', fetchImpl, meter });
    await assert.rejects(() => llm.chatJSON({ system: 'json', user: 'x', maxTokens: 8000 }), BudgetExceeded);
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(meter.estimate({ kind: 'serpapi' }), 0.01);
  });

  it('refuses to call when the budget is already exhausted', async () => {
    const meter = createCostMeter({ ceilingUsd: 0.01, pricing: PRICING });
    meter.record({ kind: 'llm', model: 'deepseek-chat', usd: 0.02 });
    const llm = createLlmClient({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(() => okResponse('{}')), meter });
    await assert.rejects(() => llm.chatJSON({ system: 'json', user: 'x' }), BudgetExceeded);
  });
});

describe('preflight (T7)', () => {
  it('makes one tiny metered call and reports the served id', async () => {
    const meter = createCostMeter({ ceilingUsd: 5, pricing: PRICING });
    const fetchImpl = fakeFetch(() => okResponse('{"ok":true}', { prompt_tokens: 12, completion_tokens: 3 }, 'deepseek-chat'));
    const llm = createLlmClient({ apiKey: 'k', model: 'deepseek-chat', fetchImpl, meter });
    const pre = await preflightModel({ llm, meter });
    assert.deepEqual(pre, {
      ok: true, requested: 'deepseek-chat', served: 'deepseek-chat', issues: [], usage: { input: 12, output: 3 }, error: null,
    });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].init.body.max_tokens, 16, 'the probe is tiny');
    assert.equal(fetchImpl.calls[0].init.body.temperature, 0);
    assert.equal(meter.entries().length, 1);
    assert.deepEqual(
      { label: meter.entries()[0].label, model: meter.entries()[0].model, requested: meter.entries()[0].requested_model, warning: meter.entries()[0].warning },
      { label: 'preflight', model: 'deepseek-chat', requested: 'deepseek-chat', warning: null },
    );
  });

  it('a failed probe is recorded in the meter and never throws', async () => {
    const meter = createCostMeter({ ceilingUsd: 5, pricing: PRICING });
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, text: async () => 'model not found' }));
    const llm = createLlmClient({ apiKey: 'k', model: 'pinned-model', fetchImpl, meter });
    const pre = await preflightModel({ llm, meter });
    assert.equal(pre.ok, false);
    assert.equal(pre.requested, 'pinned-model');
    assert.equal(pre.served, null);
    assert.match(pre.error, /HTTP 400 model not found/);
    const [entry] = meter.entries();
    assert.deepEqual([entry.kind, entry.model, entry.requested_model, entry.usd, entry.label], ['llm', 'pinned-model', 'pinned-model', 0, 'preflight']);
    assert.match(entry.warning, /^preflight failed: Error: llm preflight: HTTP 400 model not found$/);
  });

  it('an unusable body still proves the id is servable; issues are reported, not thrown', async () => {
    const llm = { model: 'pinned-model', chatJSON: async () => ({ data: null, issues: [{ path: '', message: 'not JSON' }], usage: { input: 5, output: 2 }, model: 'pinned-model' }) };
    const pre = await preflightModel({ llm, maxTokens: 8 });
    assert.equal(pre.ok, true);
    assert.equal(pre.issues.length, 1);
    assert.deepEqual(pre.usage, { input: 5, output: 2 });
  });

  it('refuses without an llm client', async () => {
    await assert.rejects(() => preflightModel({}), /llm client/);
  });
});
