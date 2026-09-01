import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fb-boost-ledger.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-boost-ledger-'));
const schedulePath = path.join(tempDir, 'facebook_posting_schedule.md');

const cases = [
  ['## Week of August 31 – September 5, 2026', '2026-08-31'], // cross-month heading
  ['## Week of August 17–22, 2026', '2026-08-17'],            // same-month heading
  ['**Week of August 17–22, 2026**', '2026-08-17'],           // bold form
];

try {
  for (const [heading, expected] of cases) {
    fs.writeFileSync(schedulePath, `${heading}\n`);
    const output = execFileSync(process.execPath, [script, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, FB_SCHEDULE_PATH: schedulePath },
    });

    assert.equal(JSON.parse(output).week, expected, heading);
  }
  console.log('ok fb-boost-ledger');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
