/**
 * Node test for the mav-bridge bind default (silent-failure guard).
 * Run: node --test scripts/mav-bridge.bind.test.mjs
 * Imports only the pure helper; never imports mav-bridge (which starts polling and loads .env).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBind } from './lib/bridge-bind.mjs';

describe('resolveBind', () => {
  it('defaults to loopback when MAV_BRIDGE_BIND is unset', () => {
    assert.equal(resolveBind({}).host, '127.0.0.1');
    assert.equal(resolveBind({}).port, 8790);
  });

  it('uses MAV_BRIDGE_BIND when set', () => {
    assert.equal(resolveBind({ MAV_BRIDGE_BIND: '192.168.1.50' }).host, '192.168.1.50');
  });
});
