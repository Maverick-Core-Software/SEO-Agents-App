// scripts/lib/gbp-mode.mjs
// The single GBP_POSTER default. mav-bridge.mjs and gbp-worker.mjs both read it
// from here; neither may carry its own literal, or the two engines can disagree
// about which poster a fresh install runs.
export const DEFAULT_GBP_POSTER = 'playwright';

export function resolveGbpMode(env = process.env) {
  return String(env.GBP_POSTER || DEFAULT_GBP_POSTER).toLowerCase();
}
