// scripts/lib/bridge-bind.mjs
// Pure host/port resolution for the mav-bridge HTTP server, extracted so the
// bind default is testable without importing or starting mav-bridge (which
// loads .env and starts polling on import).
//
// MAV_BRIDGE_BIND defaults to loopback. Set it to the LXC address to accept
// connections from another host (e.g. CT 103); restrict :8790 at the firewall.

export const DEFAULT_BRIDGE_HOST = '127.0.0.1';
export const DEFAULT_BRIDGE_PORT = 8790;

export function resolveBind(env = process.env) {
  const host = (env.MAV_BRIDGE_BIND || '').trim() || DEFAULT_BRIDGE_HOST;
  const port = parseInt(env.MAV_BRIDGE_PORT || String(DEFAULT_BRIDGE_PORT), 10);
  return { host, port };
}
