import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createCostMeter, priceFor } from '../lib/cost-meter.mjs';
import { createLlmClient, parseJsonLoose } from '../lib/llm.mjs';
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
    assert.equal(e.warning, null);
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
    assert.deepEqual(meter.warnings(), []);
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
