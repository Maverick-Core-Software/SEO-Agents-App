// scripts/lib/monitor-host.test.mjs
// seo-monitor host controls. The pm2 decision and the exec seam are tested here
// because seo-monitor.mjs runs its poll loop at import time.
import assert from 'node:assert/strict';
import { pm2SelfHealEnabled, netUseEnabled, gbpArchiveFolder, createPm2SelfHeal, resolveMonitorProbes } from './monitor-host.mjs';

// F6: health probes follow the bridge bind and MCC_HEALTH_URL, not a fixed loopback.
assert.deepEqual(resolveMonitorProbes({}), {
  bridgeHealthUrl: 'http://127.0.0.1:8790/health', mccHealthUrl: 'http://127.0.0.1:3000/health',
}, 'PC defaults: loopback for both');
assert.equal(resolveMonitorProbes({ MAV_BRIDGE_BIND: '192.168.1.60', MAV_BRIDGE_PORT: '8791' }).bridgeHealthUrl,
  'http://192.168.1.60:8791/health', 'AIWA: the probe follows the LXC bind');
assert.equal(resolveMonitorProbes({ MAV_BRIDGE_BIND: '0.0.0.0' }).bridgeHealthUrl,
  'http://127.0.0.1:8790/health', 'an unspecified bind is probed on loopback');
assert.equal(resolveMonitorProbes({ MAV_BRIDGE_BIND: '192.168.1.60', MAV_BRIDGE_HEALTH_URL: 'http://seo-prod:8790/health' }).bridgeHealthUrl,
  'http://seo-prod:8790/health', 'explicit MAV_BRIDGE_HEALTH_URL wins');
assert.equal(resolveMonitorProbes({ MCC_HEALTH_URL: 'http://192.168.1.103:3000' }).mccHealthUrl,
  'http://192.168.1.103:3000/health', 'MCC origin gets /health appended');
assert.equal(resolveMonitorProbes({ MCC_HEALTH_URL: 'http://192.168.1.103:3000/health' }).mccHealthUrl,
  'http://192.168.1.103:3000/health', 'a full MCC health URL is kept');
assert.equal(resolveMonitorProbes({ MCC_PORT: '3100' }).mccHealthUrl, 'http://127.0.0.1:3100/health', 'MCC_PORT still honoured');

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

// net use is win32-only; unset defaults ON for win32 (F12, like pm2), '0' disables.
assert.equal(netUseEnabled({}, 'win32'), true, 'win32 default is on (no .env line needed)');
assert.equal(netUseEnabled({ SEO_MONITOR_NET_USE: '' }, 'win32'), true);
assert.equal(netUseEnabled({ SEO_MONITOR_NET_USE: '0' }, 'win32'), false, 'explicit 0 disables');
assert.equal(netUseEnabled({ SEO_MONITOR_NET_USE: '1' }, 'win32'), true);
assert.equal(netUseEnabled({}, 'linux'), false);
assert.equal(netUseEnabled({ SEO_MONITOR_NET_USE: '1' }, 'linux'), false, 'never on linux');

// Archive folder: env first, then the platform default.
assert.equal(gbpArchiveFolder({}, 'linux'), '/srv/seo/gbp-archive');
assert.equal(gbpArchiveFolder({ GBP_ARCHIVE_FOLDER: '/mnt/archive' }, 'linux'), '/mnt/archive');
assert.equal(gbpArchiveFolder({}, 'win32'), 'M:\\backups\\gbp-archive');

console.log('ok monitor-host');
