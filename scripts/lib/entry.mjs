// scripts/lib/entry.mjs
// Import-safe entry guard. True only when this module is the process entry point.
//
// realpath both sides: the scheduler/pm2 may launch a script through the
// C:\Workspace junction while Node resolves the module to D:\Workspace, and a
// plain path compare silently skips main() (see weekly/run.mjs, gbp-worker.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return fs.realpathSync.native(fileURLToPath(importMetaUrl))
    === fs.realpathSync.native(path.resolve(argv1));
}
