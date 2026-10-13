// scripts/lib/bridge-bind.mjs
// Pure host/port resolution for the mav-bridge HTTP server, extracted so the
// bind default is testable without importing or starting mav-bridge (which
// loads .env and starts polling on import).
//
// MAV_BRIDGE_BIND defaults to loopback. Set it to the LXC address to accept
// connections from another host (e.g. CT 103); restrict :8790 at the firewall
// (RUNBOOK-AIWA section 3a, a hard E3 gate). The bridge's mutating routes
// (approve/retry/clear-lock/run/new-schedule) have no auth of their own, so an
// unspecified address (0.0.0.0 / ::) is refused unless MAV_BRIDGE_ALLOW_ANY=1
// says it is deliberate, and any non-loopback bind is logged loudly (rc1 F13).

export const DEFAULT_BRIDGE_HOST = '127.0.0.1';
export const DEFAULT_BRIDGE_PORT = 8790;
export const UNSPECIFIED_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
}

// What the env asks for, without enforcing anything (the monitor uses this to
// find the bridge's health URL even when the bind itself would be refused).
export function describeBind(env = process.env) {
  const host = (env.MAV_BRIDGE_BIND || '').trim() || DEFAULT_BRIDGE_HOST;
  const port = parseInt(env.MAV_BRIDGE_PORT || String(DEFAULT_BRIDGE_PORT), 10);
  return { host, port, loopback: isLoopbackHost(host), unspecified: UNSPECIFIED_HOSTS.has(host) };
}

// The bind mav-bridge may actually use. Throws on an unspecified address unless
// MAV_BRIDGE_ALLOW_ANY=1; the caller logs bindWarning() for anything non-loopback.
export function resolveBind(env = process.env) {
  const bind = describeBind(env);
  if (bind.unspecified && String(env.MAV_BRIDGE_ALLOW_ANY || '').trim() !== '1') {
    throw new Error(
      `MAV_BRIDGE_BIND=${bind.host} would expose the unauthenticated bridge routes on every interface. ` +
      `Set it to one address (the LXC address for CT 103) and restrict :${bind.port} at the firewall, ` +
      `or set MAV_BRIDGE_ALLOW_ANY=1 to accept that deliberately.`,
    );
  }
  return bind;
}

export function bindWarning({ host, port, loopback, unspecified } = describeBind()) {
  if (loopback) return null;
  const where = unspecified ? `EVERY interface (${host}, MAV_BRIDGE_ALLOW_ANY=1)` : `a non-loopback address (${host})`;
  return `WARNING: mav-bridge is binding ${where} on port ${port}. The approve/retry/clear-lock/run routes have no auth: ` +
    `:${port} MUST be restricted at the firewall to CT 103 only (RUNBOOK-AIWA 3a, gate E3).`;
}
