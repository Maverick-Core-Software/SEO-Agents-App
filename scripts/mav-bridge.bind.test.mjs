/**
 * Node test for the mav-bridge bind default (silent-failure guard) and the
 * F13 hardening: 0.0.0.0 refused unless MAV_BRIDGE_ALLOW_ANY=1, loud warning
 * for any non-loopback bind.
 * Run: node --test scripts/mav-bridge.bind.test.mjs
 * Imports only the pure helper; never imports mav-bridge (which starts polling and loads .env).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBind, describeBind, bindWarning, isLoopbackHost } from './lib/bridge-bind.mjs';

describe('resolveBind', () => {
  it('defaults to loopback when MAV_BRIDGE_BIND is unset', () => {
    assert.equal(resolveBind({}).host, '127.0.0.1');
    assert.equal(resolveBind({}).port, 8790);
    assert.equal(resolveBind({}).loopback, true);
    assert.equal(bindWarning(resolveBind({})), null, 'loopback: no warning');
  });

  it('uses MAV_BRIDGE_BIND when set and warns loudly for a non-loopback address', () => {
    const bind = resolveBind({ MAV_BRIDGE_BIND: '192.168.1.50' });
    assert.equal(bind.host, '192.168.1.50');
    assert.equal(bind.loopback, false);
    assert.equal(bind.unspecified, false);
    assert.match(bindWarning(bind), /WARNING: mav-bridge is binding a non-loopback address \(192\.168\.1\.50\)/);
    assert.match(bindWarning(bind), /firewall/);
  });

  it('refuses 0.0.0.0 and :: unless MAV_BRIDGE_ALLOW_ANY=1 (F13)', () => {
    for (const host of ['0.0.0.0', '::', '[::]']) {
      assert.throws(() => resolveBind({ MAV_BRIDGE_BIND: host }), /MAV_BRIDGE_ALLOW_ANY=1/);
      assert.throws(() => resolveBind({ MAV_BRIDGE_BIND: host, MAV_BRIDGE_ALLOW_ANY: '0' }), /every interface/);
    }
    const bind = resolveBind({ MAV_BRIDGE_BIND: '0.0.0.0', MAV_BRIDGE_ALLOW_ANY: '1' });
    assert.equal(bind.host, '0.0.0.0');
    assert.equal(bind.unspecified, true);
    assert.match(bindWarning(bind), /EVERY interface/);
  });

  it('describeBind never throws (the monitor reads it to find the health URL)', () => {
    const d = describeBind({ MAV_BRIDGE_BIND: '0.0.0.0', MAV_BRIDGE_PORT: '8791' });
    assert.deepEqual(d, { host: '0.0.0.0', port: 8791, loopback: false, unspecified: true });
  });

  it('isLoopbackHost', () => {
    for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ['0.0.0.0', '192.168.1.5', '10.0.0.1', '']) assert.equal(isLoopbackHost(h), false, h);
  });
});
