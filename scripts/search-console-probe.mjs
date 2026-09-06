#!/usr/bin/env node
/**
 * search-console-probe.mjs — read-only Google Search Console access check.
 *
 * Lists the sites the token can see and, if the Grizzly property is among
 * them, fetches its top-25 queries for the last N days (default 28). Makes
 * no writes except the optional outputs/search-console-latest.json cache
 * behind --json. Never posts to Search Console; read-only scope only.
 *
 * The token must exist first — run scripts/authorize-search-console.mjs once
 * as the Google account that owns the property. Until then this probe prints
 * a one-line instruction and exits 1.
 *
 *   node scripts/search-console-probe.mjs [--days N] [--json]
 *
 * Exit codes: 0 = success; 1 = any failure (missing token, API error, or no
 * Grizzly property on the account).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEARCH_CONSOLE_TOKEN_FILE_DEFAULT,
  explainSearchConsoleError,
  pickGrizzlyProperty,
  dateRange,
  formatQueryRows,
} from './lib/search-console.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Load .env (same small loader as seo-watchdog.mjs) ───────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// Route the shared GBP auth module at the Search Console token BEFORE it
// loads, so the real GBP token file is never read or refreshed.
process.env.GBP_TOKEN_FILE =
  process.env.SEARCH_CONSOLE_TOKEN_FILE || SEARCH_CONSOLE_TOKEN_FILE_DEFAULT;

const { gbpFetch } = await import('./lib/gbp-api-auth.mjs');

const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

function parseArgs(argv) {
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx !== -1 && argv[daysIdx + 1] ? parseInt(argv[daysIdx + 1], 10) : 28;
  return { days: Number.isFinite(days) && days > 0 ? days : 28, json: argv.includes('--json') };
}

function printTable(rows) {
  const qw = Math.max(4, ...rows.map((r) => r.query.length));
  console.log('top queries by clicks:');
  const row = (cells) => console.log(cells.join(' '));
  row(['query'.padEnd(qw), 'clicks'.padStart(6), 'impressions'.padStart(11), 'ctr'.padStart(7), 'position'.padStart(8)]);
  for (const r of rows) {
    const q = r.query.length > qw ? `${r.query.slice(0, qw - 1)}…` : r.query;
    row([q.padEnd(qw), String(r.clicks).padStart(6), String(r.impressions).padStart(11), r.ctr.padStart(7), r.position.padStart(8)]);
  }
}

async function main() {
  const { days, json } = parseArgs(process.argv.slice(2));

  const sites = await gbpFetch(SITES_URL);
  const entries = sites.siteEntry || [];
  console.log(`Sites visible to this token (${entries.length}):`);
  for (const s of entries) {
    console.log(`  ${s.siteUrl}  (${s.permissionLevel})`);
  }

  const prop = pickGrizzlyProperty(entries);
  if (!prop) {
    throw new Error('Grizzly property not found among the sites for this account');
  }
  console.log(`\nGrizzly property: ${prop.siteUrl} (${prop.permissionLevel})`);

  const { startDate, endDate } = dateRange(days);
  const queryUrl = `${SITES_URL}/${encodeURIComponent(prop.siteUrl)}/searchAnalytics/query`;
  const result = await gbpFetch(queryUrl, {
    method: 'POST',
    body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 25 }),
  });

  const rows = formatQueryRows(result.rows || []);
  console.log(`\n${startDate} → ${endDate} (last ${days} days):`);
  if (rows.length === 0) {
    console.log('No query data in range.');
  } else {
    printTable(rows);
  }

  if (json) {
    const out = path.join(PROJECT_ROOT, 'outputs', 'search-console-latest.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(
      { fetched_at: new Date().toISOString(), siteUrl: prop.siteUrl, startDate, endDate, rows },
      null, 2,
    ));
    console.log(`\nWrote ${out}`);
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(explainSearchConsoleError(err));
  process.exit(1);
}
