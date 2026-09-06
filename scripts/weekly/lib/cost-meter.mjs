/**
 * cost-meter.mjs — records every paid call (model tokens, search calls) and
 * enforces the attempt's dollar ceiling. Pricing comes from
 * config/weekly-policy.json `pricing` (USD per 1M tokens per model, plus
 * `serpapi_per_call`); when a model has no pricing the entry is kept with a
 * warning and costs 0, so a missing price is visible rather than silent.
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

  function record({ kind = 'llm', model = null, inputTokens = 0, outputTokens = 0, usd, label = '' } = {}) {
    let cost = usd;
    let warning = null;
    if (cost === undefined || cost === null) {
      const est = kind === 'serpapi'
        ? (typeof pricing.serpapi_per_call === 'number' ? pricing.serpapi_per_call : null)
        : priceFor(pricing, model, inputTokens, outputTokens);
      if (est === null) {
        cost = 0;
        warning = `no pricing for ${model || kind}`;
      } else {
        cost = est;
      }
    }
    const entry = { kind, model, inputTokens, outputTokens, usd: round6(cost), label, warning };
    entries.push(entry);
    return entry;
  }

  return {
    ceilingUsd,
    record,
    spent,
    entries: () => entries.map((e) => ({ ...e })),
    warnings: () => entries.filter((e) => e.warning).map((e) => e.warning),
    assertUnder,
  };
}
