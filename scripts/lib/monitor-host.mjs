// scripts/lib/monitor-host.mjs
// Host-specific controls for seo-monitor: pm2 self-heal, the net use remount, and
// the GBP archive folder default. Kept out of seo-monitor.mjs because that module
// runs its poll loop at import time, and these decisions must be testable with
// injected env, platform and exec.
import { execSync as realExecSync } from 'node:child_process';

const WIN32_ARCHIVE_FOLDER = 'M:\\backups\\gbp-archive';
const POSIX_ARCHIVE_FOLDER = '/srv/seo/gbp-archive';

// SEO_MONITOR_PM2: '1' keeps pm2 self-heal, '0' is HTTP health only. Unset defaults
// to on for win32 (the Workbench) and off elsewhere (AIWA runs under systemd).
export function pm2SelfHealEnabled(env = process.env, platform = process.platform) {
  const raw = env.SEO_MONITOR_PM2;
  const value = raw === undefined || raw === '' ? (platform === 'win32' ? '1' : '0') : String(raw).trim();
  return value === '1';
}

// net use M: remount runs only on win32, and only when SEO_MONITOR_NET_USE=1.
export function netUseEnabled(env = process.env, platform = process.platform) {
  return platform === 'win32' && env.SEO_MONITOR_NET_USE === '1';
}

export function gbpArchiveFolder(env = process.env, platform = process.platform) {
  return env.GBP_ARCHIVE_FOLDER || (platform === 'win32' ? WIN32_ARCHIVE_FOLDER : POSIX_ARCHIVE_FOLDER);
}

// pm2 command surface. When disabled, no command is ever executed: list() is empty,
// restart()/resurrect() report false. A single log line says the mode once.
export function createPm2SelfHeal({
  env = process.env, platform = process.platform, exec = realExecSync, log = () => {},
} = {}) {
  const enabled = pm2SelfHealEnabled(env, platform);
  if (!enabled) {
    log('warn', 'PM2 self-heal is OFF (SEO_MONITOR_PM2=0): HTTP health checks only, no pm2 commands run');
  }
  return {
    enabled,
    list() {
      if (!enabled) return [];
      try {
        return JSON.parse(exec('pm2 jlist', { encoding: 'utf8', timeout: 10000, windowsHide: true }));
      } catch {
        return [];
      }
    },
    restart(name) {
      if (!enabled) return false;
      try {
        exec(`pm2 restart "${name}"`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
        return true;
      } catch (e) {
        log('error', `pm2 restart failed for ${name}`, { error: e.message });
        return false;
      }
    },
    // Cold-boot recovery: reload the saved dump. Tried at most once per monitor run
    // by the caller.
    resurrect() {
      if (!enabled) return false;
      try {
        exec('pm2 resurrect', { encoding: 'utf8', timeout: 30000, windowsHide: true });
        return true;
      } catch (e) {
        log('error', 'pm2 resurrect failed', { error: e.message });
        return false;
      }
    },
  };
}
