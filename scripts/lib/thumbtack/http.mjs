export function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

export function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

export async function readJsonBody(req, maxSize = 512_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxSize) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}
