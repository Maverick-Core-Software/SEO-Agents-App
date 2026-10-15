/**
 * llm.mjs — one small OpenAI-compatible chat client (DeepSeek by default) that
 * returns schema-validated JSON and meters every call.
 *
 * chatJSON never throws on a validation failure: it returns { data: null,
 * issues } so the caller can run one bounded repair. It throws on transport
 * failure, HTTP errors, timeout, or a tripped budget ceiling.
 *
 * Transient failures (HTTP 5xx/429, network errors, timeouts, a body that
 * dies mid-read) are tagged `transient: true` on the thrown error; the message
 * text is unchanged.
 *
 * `preflightModel` is the T7 probe: one tiny metered call that confirms the
 * pinned model id is servable, run before an attempt is created.
 *
 * `createFallbackLlm` (WEEKLY_FALLBACK_*) wraps the pinned client with one
 * OpenAI-compatible fallback. Without it, nothing changes.
 */
import { parseOrIssues } from './schemas.mjs';
import { BudgetExceeded } from './errors.mjs';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_FALLBACK_KEY_ENV = 'OPENAI_API_KEY';
export const PREFLIGHT_LABEL = 'preflight';
export const FALLBACK_RETRY_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 60000;
export const TIMEOUT_MIN_MS = 10000;
export const TIMEOUT_MAX_MS = 180000;
const REASON_MAX = 200;

/**
 * Per-request timeout from an env var (WEEKLY_LLM_TIMEOUT_MS, WEEKLY_FALLBACK_
 * TIMEOUT_MS). Unset or blank → `fallbackMs`. A number is clamped to 10 s–180 s.
 * Anything else throws at startup rather than silently running with a default.
 */
export function timeoutMsFromEnv(env = process.env, name = 'WEEKLY_LLM_TIMEOUT_MS', fallbackMs = DEFAULT_TIMEOUT_MS) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number of milliseconds (got a non-numeric value)`);
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(n)));
}

/** Parse JSON that may be wrapped in a code fence or padded with prose. */
export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { error: 'empty response' };
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return { value: JSON.parse(unfenced) };
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return { value: JSON.parse(unfenced.slice(start, end + 1)) };
      } catch (e) {
        return { error: e.message };
      }
    }
    return { error: 'no JSON object found' };
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} [opts.baseUrl]
 * @param {function} [opts.fetchImpl]
 * @param {object} [opts.meter]      a cost meter from cost-meter.mjs
 * @param {number} [opts.timeoutMs]  default 60000
 * @param {boolean} [opts.unpricedAsNull]  record an unpriced call as usd null (not 0)
 */
export function createLlmClient({ apiKey, model, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, meter = null, timeoutMs = 60000, unpricedAsNull = false }) {
  if (!apiKey) throw new Error('llm: apiKey is required');
  if (!model) throw new Error('llm: model is required');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function chatJSON({ system = '', user = '', schema = null, maxTokens = 8000, temperature = 0.4, label = 'chat' } = {}) {
    // json_object mode requires the word "json" somewhere in the prompt.
    const userText = typeof user === 'string' ? user : JSON.stringify(user);
    if (meter) {
      // Project this call's worst case (prompt at ~4 chars/token plus the full
      // output allowance) so the ceiling cannot be overshot by one call.
      const projectedInput = Math.ceil((system.length + userText.length) / 4);
      const next = typeof meter.estimate === 'function'
        ? meter.estimate({ kind: 'llm', model, inputTokens: projectedInput, outputTokens: maxTokens })
        : 0;
      meter.assertUnder(next);
    }
    const systemText = /json/i.test(system) || /json/i.test(userText)
      ? system
      : `${system}\n\nRespond with a single JSON object.`;
    const body = {
      model,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature,
    };

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    // Rejects when the timer fires. Racing against it bounds the request and the
    // body read, so a fetch that ignores its signal, or a body that stalls after
    // the headers, still ends at the timeout instead of hanging the stage.
    const expired = new Promise((_, reject) => {
      ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    expired.catch(() => {});
    const timeoutError = () => {
      const err = new Error(`llm ${label}: request failed (timeout after ${timeoutMs} ms)`);
      err.transient = true;
      return err;
    };
    let json;
    try {
      let res;
      try {
        res = await Promise.race([
          fetchImpl(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          }),
          expired,
        ]);
      } catch (e) {
        if (timedOut) throw timeoutError();
        const err = new Error(`llm ${label}: request failed (${(e && e.message) || String(e)})`);
        err.transient = true;
        throw err;
      }

      if (!res.ok) {
        const text = await Promise.race([safeText(res), expired]).catch(() => '');
        const err = new Error(`llm ${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status;
        err.transient = res.status >= 500 || res.status === 429;
        throw err;
      }
      try {
        json = await Promise.race([res.json(), expired]);
      } catch (e) {
        if (timedOut) throw timeoutError();
        // A body that dies mid-read ("terminated") is a transport failure.
        if (e && typeof e === 'object') e.transient = true;
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
    const usage = {
      input: Number(json.usage?.prompt_tokens ?? 0),
      output: Number(json.usage?.completion_tokens ?? 0),
    };
    const usedModel = json.model || model;
    if (meter) meter.record({ kind: 'llm', model: usedModel, requestedModel: model, fallbackModel: model, inputTokens: usage.input, outputTokens: usage.output, label, unpricedAsNull });

    const content = json.choices?.[0]?.message?.content ?? '';
    const parsed = parseJsonLoose(content);
    if (parsed.error) {
      // `unparsed` lets the fallback wrapper treat an empty or non-JSON reply as
      // transient (a stalled provider), not as a prompt problem to repair.
      return { data: null, issues: [{ path: '', message: `model output is not JSON: ${parsed.error}` }], usage, model: usedModel, raw: content, unparsed: true };
    }
    const { data, issues } = schema ? parseOrIssues(schema, parsed.value) : { data: parsed.value, issues: [] };
    return { data, issues, usage, model: usedModel, raw: content };
  }

  return { chatJSON, model, endpoint };
}

/** Error text without the leading "llm <label>: " prefix, for embedding in a reason. */
function bareReason(e) {
  const text = String(e instanceof Error ? e.message : e).replace(/^llm [^:]*: /, '');
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap the pinned primary client with one fallback client (WEEKLY_FALLBACK_*).
 *
 * A call that fails transiently on the primary (HTTP 5xx/429, network, timeout),
 * and a failing preflight probe of any kind, is retried once on the primary
 * after `retryDelayMs`. A second failure switches the rest of the attempt to the
 * fallback. Other errors and budget refusals propagate unchanged. A failing
 * fallback throws one error that names both providers and both reasons.
 *
 * `status()` reports the route for the attempt record and the notify text.
 */
export function createFallbackLlm({ primary, fallback, retryDelayMs = FALLBACK_RETRY_MS, sleep = defaultSleep } = {}) {
  if (!primary || typeof primary.chatJSON !== 'function') throw new Error('createFallbackLlm: a primary llm client is required');
  if (!fallback || typeof fallback.chatJSON !== 'function') throw new Error('createFallbackLlm: a fallback llm client is required');
  let route = { fallback_used: false, reason: null };

  const eligible = (e, label) => {
    if (e instanceof BudgetExceeded) return false;
    return label === PREFLIGHT_LABEL || (e !== null && typeof e === 'object' && e.transient === true);
  };

  async function callFallback(opts, label) {
    try {
      return await fallback.chatJSON(opts);
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      throw new Error(`llm ${label}: fallback ${fallback.model} failed (${bareReason(e)}); primary ${primary.model} failed first (${route.reason})`);
    }
  }

  // An empty or non-JSON reply from the primary is transient for this purpose:
  // it is a stalled or broken provider, not a prompt problem, so it gets the
  // retry and the switch instead of the single prompt repair.
  async function primaryCall(opts) {
    const out = await primary.chatJSON(opts);
    if (out && out.unparsed) {
      const err = new Error(`llm ${opts.label || 'chat'}: ${out.issues?.[0]?.message || 'model output is not JSON'}`);
      err.transient = true;
      throw err;
    }
    return out;
  }

  async function chatJSON(opts = {}) {
    const label = opts.label || 'chat';
    if (route.fallback_used) return callFallback(opts, label);
    try {
      return await primaryCall(opts);
    } catch (first) {
      if (!eligible(first, label)) throw first;
    }
    await sleep(retryDelayMs);
    try {
      return await primaryCall(opts);
    } catch (second) {
      if (!eligible(second, label)) throw second;
      route = { fallback_used: true, reason: `${primary.model}: ${bareReason(second)}` };
    }
    return callFallback(opts, label);
  }

  function status() {
    return { primary: primary.model, fallback: fallback.model, fallback_used: route.fallback_used, reason: route.reason };
  }

  return { chatJSON, model: primary.model, endpoint: primary.endpoint, status };
}

/**
 * Read the optional fallback config. Returns null when neither WEEKLY_FALLBACK_
 * ENDPOINT nor WEEKLY_FALLBACK_MODEL is set. Setting only one of the two throws,
 * so a half-written fallback fails at startup instead of silently not falling
 * back. WEEKLY_FALLBACK_API_KEY names the env var that holds the key (default
 * OPENAI_API_KEY); the key value is never returned in an error message.
 */
export function fallbackFromEnv(env = process.env, primaryTimeoutMs = DEFAULT_TIMEOUT_MS) {
  const endpoint = String(env.WEEKLY_FALLBACK_ENDPOINT || '').trim();
  const model = String(env.WEEKLY_FALLBACK_MODEL || '').trim();
  if (!endpoint && !model) return null;
  if (!endpoint || !model) throw new Error('WEEKLY_FALLBACK_ENDPOINT and WEEKLY_FALLBACK_MODEL must both be set to enable the LLM fallback');
  const keyVar = String(env.WEEKLY_FALLBACK_API_KEY || DEFAULT_FALLBACK_KEY_ENV).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyVar)) throw new Error('WEEKLY_FALLBACK_API_KEY must name an environment variable, e.g. OPENAI_API_KEY');
  const apiKey = env[keyVar];
  if (!apiKey) throw new Error(`WEEKLY_FALLBACK_API_KEY names ${keyVar}, which is not set`);
  // WEEKLY_FALLBACK_TIMEOUT_MS defaults to the primary's effective timeout.
  const timeoutMs = timeoutMsFromEnv(env, 'WEEKLY_FALLBACK_TIMEOUT_MS', primaryTimeoutMs);
  return { endpoint, model, apiKey, keyVar, timeoutMs };
}

/**
 * T7: one tiny metered probe of the pinned model, run before the attempt record
 * exists so a pinned id the provider no longer serves is visible up front. Never
 * throws — the outcome is returned — and a failed probe is still recorded in the
 * meter (cost 0, the reason as the entry's warning) so it cannot vanish.
 *
 * @returns {Promise<{ ok: boolean, requested: string|null, served: string|null,
 *   issues: Array, usage: { input: number, output: number }, error: string|null }>}
 */
export async function preflightModel({ llm, meter = null, label = PREFLIGHT_LABEL, maxTokens = 16 } = {}) {
  if (!llm || typeof llm.chatJSON !== 'function') throw new Error('preflightModel: an llm client is required');
  const requested = llm.model || null;
  try {
    const out = await llm.chatJSON({
      system: 'You are a health check. Reply with a single JSON object: {"ok":true}.',
      user: '{"preflight":true}',
      maxTokens,
      temperature: 0,
      label,
    });
    return { ok: true, requested, served: out.model || requested, issues: out.issues || [], usage: out.usage || { input: 0, output: 0 }, error: null };
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (meter && typeof meter.record === 'function') {
      // The request never returned, so nothing was billed; the entry exists so
      // the failed probe shows up in the attempt's ledger.
      meter.record({ kind: 'llm', model: requested, requestedModel: requested, usd: 0, label, warning: `preflight failed: ${error}` });
    }
    return { ok: false, requested, served: null, issues: [], usage: { input: 0, output: 0 }, error };
  }
}
