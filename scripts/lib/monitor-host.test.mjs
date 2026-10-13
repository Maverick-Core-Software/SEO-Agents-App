// scripts/lib/monitor-host.test.mjs
// seo-monitor host controls. The pm2 decision and the exec seam are tested here
// because seo-monitor.mjs runs its poll loop at import time.
import assert from 'node:assert/strict';
import { pm2SelfHealEnabled, netUseEnabled, gbpArchiveFolder, createPm2SelfHeal } from './monitor-host.mjs';

// Decision defaults: on for win32, off elsewhere. An explicit SEO_MONITOR_PM2 wins.
assert.equal(pm2SelfHealEnabled({}, 'win32'), true);
assert.equal(pm2SelfHealEnabled({}, 'linux'), false);
assert.equal(pm2SelfHealEnabled({ SEO_MONITOR_PM2: '0' }, 'win32'), false);
assert.equal(pm2SelfHealEnabled({ SEO_MONITOR_PM2: '1' }, 'linux'), true);

// SEO_MONITOR_PM2=0: no pm2 command runs through exec, and there is one clear log line.
{
  const execCalls = [];
  const exec = (cmd) => { execCalls.push(cmd); return '[]'; };
  const logs = [];
  const pm2 = createPm2SelfHeal({ env: { SEO_MONITOR_PM2: '0' }, platform: 'linux', exec, log: (level, message) => logs.push({ level, message }) });
  assert.equal(pm2.enabled, false);
  assert.deepEqual(pm2.list(), []);
  assert.equal(pm2.restart('mav-bridge'), false);
  assert.equal(pm2.resurrect(), false);
  assert.deepEqual(execCalls, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /SEO_MONITOR_PM2=0/);
}

// Enabled: list, restart and resurrect go through the injected exec.
{
  const execCalls = [];
  const exec = (cmd) => { execCalls.push(cmd); return cmd === 'pm2 jlist' ? '[{"name":"mav-bridge"}]' : ''; };
  const pm2 = createPm2SelfHeal({ env: {}, platform: 'win32', exec });
  assert.equal(pm2.enabled, true);
  assert.deepEqual(pm2.list(), [{ name: 'mav-bridge' }]);
  assert.equal(pm2.restart('mav-bridge'), true);
  assert.equal(pm2.resurrect(), true);
  assert.deepEqual(execCalls, ['pm2 jlist', 'pm2 restart "mav-bridge"', 'pm2 resurrect']);
}

// net use runs only on win32 with SEO_MONITOR_NET_USE=1.
assert.equal(netUseEnabled({}, 'win32'), false);
assert.equal(netUseEnabled({ SEO_MONITOR_NET_USE: '1' }, 'linux'), false);
assert.equal(netUseEnabled({ SEO_MONITOR_NET_USE: '1' }, 'win32'), true);

// Archive folder: env first, then the platform default.
assert.equal(gbpArchiveFolder({}, 'linux'), '/srv/seo/gbp-archive');
assert.equal(gbpArchiveFolder({ GBP_ARCHIVE_FOLDER: '/mnt/archive' }, 'linux'), '/mnt/archive');
assert.equal(gbpArchiveFolder({}, 'win32'), 'M:\\backups\\gbp-archive');

console.log('ok monitor-host');
