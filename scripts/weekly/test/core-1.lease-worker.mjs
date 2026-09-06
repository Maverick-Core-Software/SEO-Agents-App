// scripts/weekly/test/core-1.lease-worker.mjs
// Child process used by core-1.store.test.mjs to race acquireLease across OS
// processes (the in-process queue cannot help there). Prints the result as JSON.
//   node core-1.lease-worker.mjs <dir> <week_of> <attempt_id> <now ISO> <ttlMs> [gateFile]
// With a gate file the worker signals readiness (`<gate>.ready.<attempt_id>`) and
// spins until the gate exists, so every racer starts within a millisecond of the others.
import fs from 'node:fs';
import { createFileStore } from '../lib/store.mjs';

const [dir, week_of, attempt_id, nowIso, ttl, gate] = process.argv.slice(2);

if (gate) {
  fs.writeFileSync(`${gate}.ready.${attempt_id}`, '');
  const deadline = Date.now() + 15_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(gate) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 1);
}

try {
  const store = createFileStore(dir);
  const result = await store.acquireLease({ week_of, attempt_id, ttlMs: Number(ttl) || undefined, now: new Date(nowIso) });
  process.stdout.write(JSON.stringify({ attempt_id, ...result }));
} catch (e) {
  process.stdout.write(JSON.stringify({ attempt_id, ok: false, error: String(e && e.message) }));
  process.exitCode = 1;
}
