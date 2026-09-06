import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.mjs';

/**
 * Load the repository .env into process.env without overriding values that are
 * already set (same behaviour as the other scripts in this repo). Returns
 * process.env for convenience. Never logs values.
 */
export function loadEnv(projectRoot = PROJECT_ROOT) {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return process.env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
  return process.env;
}
