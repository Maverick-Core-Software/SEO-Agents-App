// scripts/lib/child-env.mjs
// Environment for a child process that is (or may spawn) Windows CPython.
//
// Windows CPython reads TZ itself: with TZ=America/Chicago in the environment a
// child `seo-agents.exe` treats UTC as local time (reproduced 2026-10-13 from
// PowerShell: parent 15:18 CDT, child 21:18, time.timezone == 0). mav-bridge and
// gbp-worker load .env into process.env and hand it to their children, so an
// accidental TZ line in the PC .env would silently shift every date the Python
// adapters stamp. On win32 the child never sees TZ. On posix (AIWA) TZ is kept:
// it is how the systemd units and pm2 pin America/Chicago.
export function pythonChildEnv(env = process.env, platform = process.platform) {
  const out = { ...env };
  if (platform === 'win32') delete out.TZ;
  return out;
}
