// scripts/weekly/test/hermetic-env.mjs
// Environment hygiene for the weekly e2e tests. A checkout's real .env must
// never reach a test: the spawned run.mjs child gets an explicit allowlisted
// env with WEEKLY_SKIP_DOTENV=1, and the test process itself scrubs the
// credential keys (imports of supabase-sync.mjs / facebook-poster.mjs read .env
// at load time). Not a *.test.mjs file, so the test glob does not run it.

/** The only process variables a spawned weekly child inherits. */
export const CHILD_ENV_ALLOWLIST = [
  'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'NODE_OPTIONS',
];

/** Credential keys a live run would pick up; removed from the test process. */
export const CREDENTIAL_KEYS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY', 'DEEPSEEK_API_KEY', 'SERPAPI_API_KEY', 'OPENAI_API_KEY',
];

/**
 * Explicit env for a spawned weekly child: the allowlist from this process,
 * WEEKLY_SKIP_DOTENV=1, then the test's own vars (fakes only).
 */
export function hermeticChildEnv(extra = {}) {
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, WEEKLY_SKIP_DOTENV: '1', ...extra };
}

/**
 * Scrub credentials and set WEEKLY_SKIP_DOTENV=1 for this process. Returns a
 * function that restores the previous values.
 */
export function scrubProcessEnv() {
  const saved = {};
  for (const key of [...CREDENTIAL_KEYS, 'WEEKLY_SKIP_DOTENV']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.WEEKLY_SKIP_DOTENV = '1';
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
