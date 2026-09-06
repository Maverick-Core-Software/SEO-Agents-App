import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (scripts/weekly/lib → three levels up). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
export const OUTPUTS_DIR = path.join(PROJECT_ROOT, 'outputs');
/** Shadow-mode exports. The legacy pipeline never reads this directory. */
export const SHADOW_DIR = path.join(OUTPUTS_DIR, 'shadow');
/** File-store root for attempts, leases, observations, revisions, items. */
export const STATE_DIR = path.join(PROJECT_ROOT, 'state', 'weekly');
export const SERP_CACHE_DIR = path.join(STATE_DIR, 'serp-cache');
export const POLICY_PATH = path.join(PROJECT_ROOT, 'config', 'weekly-policy.json');
export const FACTS_PATH = path.join(PROJECT_ROOT, 'knowledge', 'baselines', 'grizzly-business-facts.md');
export const PROMPTS_DIR = path.join(__dirname, 'prompts');
