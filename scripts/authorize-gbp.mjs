#!/usr/bin/env node
/**
 * authorize-gbp.mjs — one-shot OAuth flow to mint a GBP API refresh token under
 * the hermes-agent OAuth client. Opens a browser, you pick the Grizzly account,
 * the resulting token saves to grizzly-gbp.json. gbp-api-auth.mjs refreshes from
 * then on; you only ever run this once (or again if you revoke).
 *
 * Usage: node scripts/authorize-gbp.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { resolveGbpClientSecret, resolveGbpTokenFile } from './lib/platform-defaults.mjs';

const CLIENT_SECRET_PATH = resolveGbpClientSecret();
const TOKEN_PATH = resolveGbpTokenFile();
const SCOPES = ['https://www.googleapis.com/auth/business.manage'];

if (!fs.existsSync(CLIENT_SECRET_PATH)) {
  console.error(`Client secret not found at: ${CLIENT_SECRET_PATH}`);
  process.exit(1);
}

const cred = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf8'));
const { client_id, client_secret } = cred.installed || cred.web;

// PKCE — Google now recommends it for installed-app flows.
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

// Bind loopback on an OS-assigned port; Desktop-app clients allow any loopback port.
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1`);
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error');
  if (err) {
    console.error('OAuth error:', err);
    finish(res, 400, `<h1>Authorization failed</h1><pre>${err}</pre>`, 1);
    return;
  }
  if (!code) { res.writeHead(404); res.end(); return; }

  try {
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id, client_secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      throw new Error(`No refresh_token returned: ${JSON.stringify(tokens)}. Revoke and retry with prompt=consent.`);
    }
    const expiry_date = Date.now() + (tokens.expires_in * 1000);
    const payload = {
      token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry: new Date(expiry_date).toISOString(),
      expiry_date,
      scopes: SCOPES,
      client_id,
      client_secret,
      token_uri: 'https://oauth2.googleapis.com/token',
    };
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2));
    console.log(`Token saved to ${TOKEN_PATH}`);
    finish(res, 200, '<h1>Authorized &#10003;</h1><p>You can close this tab.</p>', 0);
  } catch (e) {
    console.error(e);
    finish(res, 500, `<h1>Token exchange failed</h1><pre>${e.message}</pre>`, 1);
  }
});

// Answer the browser, then let libuv tear the server down before exiting. A
// synchronous process.exit() inside the request handler raced the still-closing
// loopback server and crashed node on Windows ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING) ... src\win\async.c") after the token
// had already been written. Connection: close makes the socket drop on its own
// so server.close() completes; the unref'd timer is the fallback.
function finish(res, status, html, code) {
  res.writeHead(status, { 'Content-Type': 'text/html', Connection: 'close' });
  res.end(html);
  res.once('finish', () => {
    server.close(() => process.exit(code));
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    setTimeout(() => process.exit(code), 3000).unref();
  });
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const url = authUrl.toString();
  console.log('Opening browser for Grizzly login...');
  console.log(`(if it does not open, paste this URL:)`);
  console.log(url);
  console.log('');
  console.log(`Waiting for callback on ${redirectUri} ...`);
  // Best-effort browser launch; the URL is printed as fallback.
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
  exec(cmd, () => {});
});
