#!/usr/bin/env node
// One-shot listing check for the six posted_at+error GBP rows. No compose, no re-post.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(here, '../..');
const envPath = 'C:\\Workspace\\Active\\SEO-Agents-App\\.env';
const env = { ...process.env };
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].trim();
}

const dates = '2026-08-15,2026-08-16,2026-08-17,2026-08-19,2026-08-20,2026-08-29';
const child = spawn(
  process.execPath,
  [path.join(worktreeRoot, 'scripts', 'verify-gbp-posts.mjs'), '--date', dates, '--headless', '--once'],
  { env, cwd: worktreeRoot, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
