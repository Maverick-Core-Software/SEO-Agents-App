/**
 * cost-meter.mjs — records every paid call (model tokens, search calls) and
 * enforces the attempt's dollar ceiling. Pricing comes from
 * config/weekly-policy.json `pricing` (USD per 1M tokens per servable model id,
 * plus `serpapi_per_call`); when a model has no pricing the entry is kept with a
 * warning and costs 0, so a missing price is visible rather than silent. Each
 * entry keeps the requested and the served model id and is priced from the
 * served one, warning when the two differ (T7).
 */
import { BudgetExceeded } from './errors.mjs';

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function priceFor(pricing, model, inputTokens = 0, outputTokens = 0) {
  const p = pricing && model ? pricing[model] : null;
  if (!p || typeof p.input !== 'number' || typeof p.output !== 'number') return null;
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.ceilingUsd=Infinity]
 * @param {object} [opts.pricing={}]
 */
export function createCostMeter({ ceilingUsd = Infinity, pricing = {} } = {}) {
  const entries = [];

  function spent() {
    return round6(entries.reduce((sum, e) => sum + e.usd, 0));
  }

  function assertUnder(nextUsd = 0) {
    const projected = spent() + (nextUsd || 0);
    if (projected > ceilingUsd) {
      throw new BudgetExceeded(
        `budget ceiling $${ceilingUsd} exceeded: spent $${spent()} + next $${nextUsd}`,
        { ceilingUsd, spentUsd: spent(), nextUsd },
      );
    }
  }

  function record({ kind = 'llm', model = null, requestedModel = null, fallbackModel = null, inputTokens = 0, outputTokens = 0, usd, label = '', warning: given = null } = {}) {
    // `model` is the served id, `requestedModel` the one that was asked for.
    const requested = requestedModel ?? fallbackModel ?? null;
    const notes = given ? [given] : [];
    let cost = usd;
    if (cost === undefined || cost === null) {
      // Price by the served name first, then by the requested one, so an
      // unpriced served id still has a rate to fall back on.
      const est = kind === 'serpapi'
        ? (typeof pricing.serpapi_per_call === 'number' ? pricing.serpapi_per_call : null)
        : (priceFor(pricing, model, inputTokens, outputTokens) ?? priceFor(pricing, requested, inputTokens, outputTokens));
      if (est === null) {
        cost = 0;
        notes.push(`no pricing for ${model || kind}`);
      } else {
        cost = est;
      }
    }
    // T7: the served model is pinned, so a mismatch means the provider swapped
    // models under us and the price (and the attempt's record) may be wrong.
    if (requested && model && requested !== model) notes.push(`served ${model} but requested ${requested}`);
    const entry = { kind, model, requested_model: requested, inputTokens, outputTokens, usd: round6(cost), label, warning: notes.length ? notes.join('; ') : null };
    entries.push(entry);
    return entry;
  }

  /** Projected cost of a call that has not happened yet (0 when unpriced). */
  function estimate({ kind = 'llm', model = null, fallbackModel = null, inputTokens = 0, outputTokens = 0 } = {}) {
    if (kind === 'serpapi') return typeof pricing.serpapi_per_call === 'number' ? pricing.serpapi_per_call : 0;
    return priceFor(pricing, model, inputTokens, outputTokens) ?? priceFor(pricing, fallbackModel, inputTokens, outputTokens) ?? 0;
  }

  return {
    ceilingUsd,
    record,
    estimate,
    spent,
    entries: () => entries.map((e) => ({ ...e })),
    warnings: () => entries.filter((e) => e.warning).map((e) => e.warning),
    assertUnder,
  };
}
