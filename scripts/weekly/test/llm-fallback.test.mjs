import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createCostMeter } from '../lib/cost-meter.mjs';
import { createLlmClient, createFallbackLlm, fallbackFromEnv } from '../lib/llm.mjs';
import { BudgetExceeded } from '../lib/errors.mjs';
import { formatAttemptMessage } from '../lib/notify.mjs';
import { AttemptSchema } from '../lib/schemas.mjs';

// Silent-failure guards for the LLM fallback. Every network call is injected.
const PRICING = { 'deepseek-chat': { input: 0.27, output: 1.1 } };
const Schema = z.object({ topic: z.string() });
const FB = { endpoint: 'https://fallback.example/v1', model: 'gpt-4o-mini', apiKey: 'fb-test-key' };

/** Scripted fetch: each step is a response object or an Error to throw, in order. */
function scripted(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra fetch');
    if (step instanceof Error) throw step;
    return step;
  };
  impl.calls = calls;
  return impl;
}

function httpError(status, text = '') {
  return { ok: false, status, text: async () => text, json: async () => ({}) };
}

function okResponse(content, model = 'deepseek-chat') {
  return { ok: true, status: 200, json: async () => ({ model, usage: { prompt_tokens: 100, completion_tokens: 50 }, choices: [{ message: { content } }] }) };
}

function build({ fetchImpl, meter = createCostMeter({ ceilingUsd: 5, pricing: PRICING }), sleeps = [] }) {
  const primary = createLlmClient({ apiKey: 'k', model: 'deepseek-chat', fetchImpl, meter });
  const fallback = createLlmClient({ apiKey: FB.apiKey, model: FB.model, baseUrl: FB.endpoint, fetchImpl, meter, unpricedAsNull: true });
  const llm = createFallbackLlm({ primary, fallback, sleep: async (ms) => { sleeps.push(ms); } });
  return { llm, meter, primary, fallback };
}

describe('LLM fallback', () => {
  it('primary 503 twice: retries once after 5 s, then the attempt is served by the fallback', async () => {
    const sleeps = [];
    const fetchImpl = scripted([httpError(503, 'Service is too busy'), httpError(503, 'Service is too busy'), okResponse('{"topic":"ok"}', FB.model)]);
    const { llm, meter, primary } = build({ fetchImpl, sleeps });

    const out = await llm.chatJSON({ system: 'json', user: 'x', schema: Schema, label: 'generate' });

    assert.deepEqual(out.data, { topic: 'ok' });
    assert.deepEqual(sleeps, [5000]);
    assert.deepEqual(fetchImpl.calls.map((c) => c.url), [`${primary.endpoint}`, `${primary.endpoint}`, `${FB.endpoint}/chat/completions`]);
    assert.deepEqual(llm.status(), {
      primary: 'deepseek-chat',
      fallback: FB.model,
      fallback_used: true,
      reason: 'deepseek-chat: HTTP 503 Service is too busy',
    });
    // Failed primary calls are never billed; only the fallback call is in the ledger.
    assert.equal(meter.entries().length, 1);
    const entry = meter.entries()[0];
    assert.deepEqual([entry.model, entry.requested_model, entry.usd], [FB.model, FB.model, null]);
    assert.match(entry.warning, /no pricing for gpt-4o-mini: usd recorded as null/);
  });

  it('once switched, later calls in the attempt go straight to the fallback', async () => {
    const sleeps = [];
    const fetchImpl = scripted([httpError(503), httpError(503), okResponse('{"topic":"a"}', FB.model), okResponse('{"topic":"b"}', FB.model)]);
    const { llm } = build({ fetchImpl, sleeps });
    await llm.chatJSON({ system: 'json', user: 'x', schema: Schema, label: 'generate' });
    const second = await llm.chatJSON({ system: 'json', user: 'x', schema: Schema, label: 'repair' });
    assert.deepEqual(second.data, { topic: 'b' });
    assert.equal(fetchImpl.calls.length, 4);
    assert.deepEqual(sleeps, [5000]);
  });

  it('primary ok: the fallback is never called and the route records no fallback', async () => {
    const sleeps = [];
    const fetchImpl = scripted([okResponse('{"topic":"ok"}')]);
    const { llm } = build({ fetchImpl, sleeps });
    const out = await llm.chatJSON({ system: 'json', user: 'x', schema: Schema, label: 'generate' });
    assert.deepEqual(out.data, { topic: 'ok' });
    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(llm.status().fallback_used, false);
    assert.equal(llm.status().reason, null);
  });

  it('no fallback configured: a primary 503 fails with the existing error text and no retry', async () => {
    const fetchImpl = scripted([httpError(503, 'Service is too busy')]);
    const primary = createLlmClient({ apiKey: 'k', model: 'deepseek-chat', fetchImpl });
    await assert.rejects(
      () => primary.chatJSON({ system: 'json', user: 'x', label: 'generate' }),
      { message: 'llm generate: HTTP 503 Service is too busy' },
    );
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('primary 503 and fallback 500: the attempt fails naming both providers and both reasons', async () => {
    const fetchImpl = scripted([httpError(503, 'Service is too busy'), httpError(503, 'Service is too busy'), httpError(500, 'boom')]);
    const { llm } = build({ fetchImpl });
    await assert.rejects(
      () => llm.chatJSON({ system: 'json', user: 'x', label: 'generate' }),
      {
        message: 'llm generate: fallback gpt-4o-mini failed (HTTP 500 boom); primary deepseek-chat failed first (deepseek-chat: HTTP 503 Service is too busy)',
      },
    );
  });

  it('a transport "terminated" on the primary is transient: retried, then the fallback serves', async () => {
    const sleeps = [];
    const fetchImpl = scripted([new TypeError('terminated'), new TypeError('terminated'), okResponse('{"topic":"ok"}', FB.model)]);
    const { llm } = build({ fetchImpl, sleeps });
    const out = await llm.chatJSON({ system: 'json', user: 'x', schema: Schema, label: 'generate' });
    assert.deepEqual(out.data, { topic: 'ok' });
    assert.equal(llm.status().reason, 'deepseek-chat: request failed (terminated)');
  });

  it('a non-transient primary error (HTTP 400) propagates unchanged: no retry, no fallback', async () => {
    const sleeps = [];
    const fetchImpl = scripted([httpError(400, 'bad request')]);
    const { llm } = build({ fetchImpl, sleeps });
    await assert.rejects(() => llm.chatJSON({ system: 'json', user: 'x', label: 'generate' }), { message: 'llm generate: HTTP 400 bad request' });
    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(llm.status().fallback_used, false);
  });

  it('a failing preflight probe of any kind triggers the same retry and switch', async () => {
    const sleeps = [];
    const fetchImpl = scripted([httpError(400, 'model not found'), httpError(400, 'model not found'), okResponse('{"ok":true}', FB.model)]);
    const { llm } = build({ fetchImpl, sleeps });
    const out = await llm.chatJSON({ system: 'You are a health check.', user: '{}', label: 'preflight', maxTokens: 16 });
    assert.equal(out.model, FB.model);
    assert.deepEqual(sleeps, [5000]);
    assert.equal(llm.status().reason, 'deepseek-chat: HTTP 400 model not found');
  });

  it('the fallback client respects the budget ceiling before it calls out', async () => {
    const meter = createCostMeter({ ceilingUsd: 0.01, pricing: PRICING });
    meter.record({ kind: 'llm', model: 'deepseek-chat', usd: 0.02 });
    const fetchImpl = scripted([]);
    const fallback = createLlmClient({ apiKey: FB.apiKey, model: FB.model, baseUrl: FB.endpoint, fetchImpl, meter, unpricedAsNull: true });
    await assert.rejects(() => fallback.chatJSON({ system: 'json', user: 'x' }), BudgetExceeded);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('WEEKLY_FALLBACK_* parsing: unset means off, half-set fails loudly, the key is read by name', () => {
    assert.equal(fallbackFromEnv({}), null);
    assert.throws(() => fallbackFromEnv({ WEEKLY_FALLBACK_MODEL: 'gpt-4o-mini' }), /both be set/);
    assert.throws(() => fallbackFromEnv({ WEEKLY_FALLBACK_ENDPOINT: FB.endpoint, WEEKLY_FALLBACK_MODEL: FB.model }), /OPENAI_API_KEY, which is not set/);
    const spec = fallbackFromEnv({ WEEKLY_FALLBACK_ENDPOINT: FB.endpoint, WEEKLY_FALLBACK_MODEL: FB.model, OPENAI_API_KEY: FB.apiKey });
    assert.deepEqual(spec, { endpoint: FB.endpoint, model: FB.model, apiKey: FB.apiKey, keyVar: 'OPENAI_API_KEY' });
    const named = fallbackFromEnv({ WEEKLY_FALLBACK_ENDPOINT: FB.endpoint, WEEKLY_FALLBACK_MODEL: FB.model, WEEKLY_FALLBACK_API_KEY: 'MY_KEY', MY_KEY: 'v' });
    assert.equal(named.keyVar, 'MY_KEY');
    assert.throws(() => fallbackFromEnv({ WEEKLY_FALLBACK_ENDPOINT: FB.endpoint, WEEKLY_FALLBACK_MODEL: FB.model, WEEKLY_FALLBACK_API_KEY: 'not a name' }), /must name an environment variable/);
  });

  it('the attempt schema keeps the llm route (the file store validates through it and would drop an unknown key)', () => {
    const attempt = {
      id: 'a1', week_of: '2026-10-16', mode: 'new', git_sha: 'x', versions: { schema: 's', prompt: 'p', policy: 'q' },
      models: { generate: 'deepseek-chat', fallback: null }, started_at: '2026-10-16T13:00:00.000Z', finished_at: null,
      stages: {}, lease_until: null, budget_usd: 1, spent_usd: 0, status: 'running', error: null,
      llm: { primary: 'deepseek-chat', fallback: FB.model, fallback_used: true, reason: 'deepseek-chat: HTTP 503' },
    };
    const parsed = AttemptSchema.parse(attempt);
    assert.deepEqual(parsed.llm, attempt.llm);
    assert.ok(AttemptSchema.safeParse({ ...attempt, llm: undefined }).success);
  });

  it('the notify text carries the fallback line only when it was used', () => {
    const base = { mode: 'new', week_of: '2026-10-16', id: 'a1', status: 'succeeded' };
    const used = formatAttemptMessage({
      attempt: { ...base, llm: { primary: 'deepseek-chat', fallback: FB.model, fallback_used: true, reason: 'deepseek-chat: HTTP 503 Service is too busy' } },
      event: 'succeeded',
    });
    assert.match(used, /^LLM fallback used: gpt-4o-mini \(deepseek-chat: HTTP 503 Service is too busy\)$/m);
    const unused = formatAttemptMessage({ attempt: { ...base, llm: { primary: 'deepseek-chat', fallback: FB.model, fallback_used: false, reason: null } }, event: 'succeeded' });
    assert.doesNotMatch(unused, /LLM fallback/);
  });
});
