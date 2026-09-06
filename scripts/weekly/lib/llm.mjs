/**
 * llm.mjs — one small OpenAI-compatible chat client (DeepSeek by default) that
 * returns schema-validated JSON and meters every call.
 *
 * chatJSON never throws on a validation failure: it returns { data: null,
 * issues } so the caller can run one bounded repair. It throws on transport
 * failure, HTTP errors, timeout, or a tripped budget ceiling.
 */
import { parseOrIssues } from './schemas.mjs';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

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
 */
export function createLlmClient({ apiKey, model, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, meter = null, timeoutMs = 60000 }) {
  if (!apiKey) throw new Error('llm: apiKey is required');
  if (!model) throw new Error('llm: model is required');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function chatJSON({ system = '', user = '', schema = null, maxTokens = 8000, temperature = 0.4, label = 'chat' } = {}) {
    if (meter) meter.assertUnder(0);
    // json_object mode requires the word "json" somewhere in the prompt.
    const userText = typeof user === 'string' ? user : JSON.stringify(user);
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
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const why = e && e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : (e && e.message) || String(e);
      throw new Error(`llm ${label}: request failed (${why})`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`llm ${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const usage = {
      input: Number(json.usage?.prompt_tokens ?? 0),
      output: Number(json.usage?.completion_tokens ?? 0),
    };
    const usedModel = json.model || model;
    if (meter) meter.record({ kind: 'llm', model: usedModel, inputTokens: usage.input, outputTokens: usage.output, label });

    const content = json.choices?.[0]?.message?.content ?? '';
    const parsed = parseJsonLoose(content);
    if (parsed.error) {
      return { data: null, issues: [{ path: '', message: `model output is not JSON: ${parsed.error}` }], usage, model: usedModel, raw: content };
    }
    const { data, issues } = schema ? parseOrIssues(schema, parsed.value) : { data: parsed.value, issues: [] };
    return { data, issues, usage, model: usedModel, raw: content };
  }

  return { chatJSON, model, endpoint };
}
