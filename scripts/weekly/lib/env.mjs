import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.mjs';

/**
 * Load the repository .env into process.env without overriding values that are
 * already set (same behaviour as the other scripts in this repo). Returns
 * process.env for convenience. Never logs values.
 *
 * Opt-out: when process.env.WEEKLY_SKIP_DOTENV === '1' no .env file is read at
 * all. Hermetic callers (the weekly e2e tests spawn run.mjs with an explicit
 * env) set it so a checkout's real .env cannot leak live credentials into the
 * run. supabase-sync.mjs, which loads .env on import, honours the same switch.
 */
export function loadEnv(projectRoot = PROJECT_ROOT) {
  if (process.env.WEEKLY_SKIP_DOTENV === '1') return process.env;
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return process.env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
  return process.env;
}
