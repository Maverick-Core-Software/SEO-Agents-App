// scripts/lib/http-json.mjs
// Pure JSON request-body parsing for the bridge HTTP server, extracted so the
// parser hardening (size cap, malformed body → client 4xx) is testable without
// importing or starting mav-bridge. parseJsonBody never throws; callers map the
// { ok:false, status, error } result onto an HTTP error.

export const MAX_JSON_BODY_BYTES = 64 * 1024;

// Parse a raw request-body string. Returns { ok: true, data } for valid JSON
// (empty body → {}), or { ok: false, status, error } for malformed JSON (400)
// or an oversized body (413). Byte-counted so multibyte UTF-8 can't sneak past
// the cap by using fewer code units.
export function parseJsonBody(raw) {
  const text = raw || '';
  if (Buffer.byteLength(text) > MAX_JSON_BODY_BYTES) {
    return { ok: false, status: 413, error: `Request body exceeds ${MAX_JSON_BODY_BYTES} byte limit` };
  }
  if (text === '') return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }
}
