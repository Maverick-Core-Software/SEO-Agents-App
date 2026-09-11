// pm2 entry point for the GBP worker (2026-09-11).
//
// gbp-worker.mjs is import-safe: it only starts polling when process.argv[1] is
// its own path, so tests can import its helpers. pm2's fork wrapper
// (ProcessContainerFork.js) imports the script instead of running it as the main
// module, the guard concluded it was being imported, and the app sat "online"
// doing nothing with empty logs. This launcher sets argv[1] to the worker path
// before importing it, so the worker behaves exactly as when Task Scheduler ran
// `node gbp-worker.mjs` directly.
import { fileURLToPath } from 'node:url';

const worker = new URL('./gbp-worker.mjs', import.meta.url);
process.argv[1] = fileURLToPath(worker);
await import(worker.href);
