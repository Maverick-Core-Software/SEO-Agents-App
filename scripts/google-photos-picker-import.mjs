#!/usr/bin/env node
/**
 * Import user-selected Google Photos images into the GBP photo cache.
 *
 * Google no longer permits an unattended read of a user's entire Photos
 * library. This uses the supported Picker API flow: authorize once, open a
 * Google Photos picker session, wait for the user to select job photos, then
 * download those selected images into GBP_PHOTOS_LOCAL_CACHE.
 *
 * Usage:
 *   node scripts/google-photos-picker-import.mjs
 *
 * The script never prints tokens. OAuth credentials and the refresh token stay
 * in the paths configured below; use a separate Photos token file rather than
 * overwriting the existing GBP token.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

const API_ROOT = 'https://photospicker.googleapis.com/v1';
const PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const CLIENT_SECRET_PATH = process.env.GOOGLE_PHOTOS_CLIENT_SECRET
  || process.env.GBP_CLIENT_SECRET
  || 'C:/Users/carte/gmail-multi/client_secret_hermes_gbp.json';
const TOKEN_PATH = process.env.GOOGLE_PHOTOS_TOKEN_FILE
  || 'C:/Users/carte/gmail-multi/tokens/grizzly-google-photos-picker.json';
const TARGET_FOLDER = process.env.GOOGLE_PHOTOS_IMPORT_TARGET
  || process.env.GBP_PHOTOS_LOCAL_CACHE
  || 'C:/Workspace/Shared/Assets/Media/Grizzly/GBP Post Photos';
const STATE_PATH = process.env.GOOGLE_PHOTOS_IMPORT_STATE
  || path.join(PROJECT_ROOT, 'state', 'google-photos-import.json');
const maxItemsArg = process.argv.find(arg => arg.startsWith('--max-items='));
const MAX_ITEMS = Math.max(1, Math.min(2000, parseInt(maxItemsArg?.split('=')[1] || '100', 10) || 100));

function readCredentials() {
  if (!fs.existsSync(CLIENT_SECRET_PATH)) {
    throw new Error(`Google OAuth client secret not found at ${CLIENT_SECRET_PATH}. Set GOOGLE_PHOTOS_CLIENT_SECRET to an installed-app client JSON.`);
  }
  const credentials = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf8'));
  const client = credentials.installed;
  if (!client?.client_id || !client.client_secret) {
    throw new Error('Google Photos Picker requires an installed-app OAuth client with a loopback redirect.');
  }
  return client;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url], () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

function parseDuration(value, fallbackMs) {
  const seconds = Number.parseFloat(String(value || '').replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

async function authorize() {
  const { client_id: clientId, client_secret: clientSecret } = readCredentials();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const callback = new URL(req.url, 'http://127.0.0.1');
      const error = callback.searchParams.get('error');
      const code = callback.searchParams.get('code');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Google authorization failed. You can close this tab.');
        server.close();
        reject(new Error(`Google authorization failed: ${error}`));
        return;
      }
      if (!code) { res.writeHead(404); res.end(); return; }

      try {
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}`;
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, grant_type: 'authorization_code',
            code_verifier: verifier,
          }).toString(),
        });
        const tokens = await tokenResponse.json();
        if (!tokenResponse.ok || !tokens.access_token) {
          throw new Error(`OAuth token exchange failed (${tokenResponse.status})`);
        }
        if (!tokens.refresh_token) {
          throw new Error('Google did not return a refresh token; revoke the Photos Picker grant and authorize again.');
        }
        const expiryDate = Date.now() + ((tokens.expires_in || 3600) * 1000);
        fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
        fs.writeFileSync(TOKEN_PATH, JSON.stringify({
          token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: expiryDate,
          expiry: new Date(expiryDate).toISOString(),
          scopes: [PICKER_SCOPE],
          client_id: clientId,
          client_secret: clientSecret,
          token_uri: 'https://oauth2.googleapis.com/token',
        }, null, 2), { mode: 0o600 });
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorized</h1><p>You can close this tab.</p>');
        server.close();
        resolve(tokens.access_token);
      } catch (exchangeError) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Google authorization failed. You can close this tab.');
        server.close();
        reject(exchangeError);
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', PICKER_SCOPE);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      console.log('Opening Google Photos. Select only electrical job photos, then finish selection.');
      console.log(`If it does not open automatically, use this URL:\n${authUrl}\n`);
      openBrowser(authUrl.toString());
    });
  });
}

async function getAccessToken() {
  if (!fs.existsSync(TOKEN_PATH)) return authorize();
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const expiry = token.expiry_date || (token.expiry ? Date.parse(token.expiry) : 0);
  if (token.token && (!expiry || expiry > Date.now() + 5 * 60 * 1000)) return token.token;
  if (!token.refresh_token) return authorize();

  const client = readCredentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const refreshed = await response.json();
  if (!response.ok || !refreshed.access_token) throw new Error(`Google token refresh failed (${response.status})`);
  const expiryDate = Date.now() + ((refreshed.expires_in || 3600) * 1000);
  token.token = refreshed.access_token;
  token.expiry_date = expiryDate;
  token.expiry = new Date(expiryDate).toISOString();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
  return token.token;
}

async function pickerRequest(token, endpoint, options = {}) {
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Photos Picker API ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

function loadImportState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return { importedIds: new Set(state.importedIds || []) };
  } catch {
    return { importedIds: new Set() };
  }
}

function saveImportState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    importedIds: [...state.importedIds].sort(),
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function safeFilename(filename, id, mimeType) {
  const original = path.basename(filename || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const extension = path.extname(original) || (mimeType === 'image/png' ? '.png' : '.jpg');
  const stem = path.basename(original, path.extname(original)).slice(0, 80) || 'photo';
  const safeId = String(id || 'media').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'media';
  return `gphotos-${safeId}-${stem}${extension.toLowerCase()}`;
}

async function listSelectedMedia(token, sessionId) {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ sessionId, pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await pickerRequest(token, `/mediaItems?${params}`);
    items.push(...(page.mediaItems || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken && items.length < MAX_ITEMS);
  return items.slice(0, MAX_ITEMS);
}

async function main() {
  fs.mkdirSync(TARGET_FOLDER, { recursive: true });
  const token = await getAccessToken();
  const session = await pickerRequest(token, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ pickingConfig: { maxItemCount: String(MAX_ITEMS) } }),
  });
  const pickerUri = `${session.pickerUri}/autoclose`;
  console.log(`Picker opened for up to ${MAX_ITEMS} items.`);
  openBrowser(pickerUri);

  let status = session;
  const deadline = Date.now() + parseDuration(session.pollingConfig?.timeoutIn, 10 * 60 * 1000);
  while (!status.mediaItemsSet && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, parseDuration(status.pollingConfig?.pollInterval, 3000)));
    status = await pickerRequest(token, `/sessions/${encodeURIComponent(session.id)}`);
  }
  if (!status.mediaItemsSet) throw new Error('Google Photos selection timed out or was cancelled. No files were imported.');

  const state = loadImportState();
  const selected = await listSelectedMedia(token, session.id);
  let imported = 0;
  let skipped = 0;
  try {
    for (const item of selected) {
      const mediaFile = item.mediaFile || {};
      if (!String(mediaFile.mimeType || item.mimeType || '').startsWith('image/')) { skipped++; continue; }
      if (state.importedIds.has(item.id)) { skipped++; continue; }
      if (!mediaFile.baseUrl) { skipped++; continue; }
      const download = await fetch(`${mediaFile.baseUrl}=d`, { headers: { Authorization: `Bearer ${token}` } });
      if (!download.ok) throw new Error(`download failed (${download.status}) for selected media`);
      const destination = path.join(TARGET_FOLDER, safeFilename(mediaFile.filename, item.id, mediaFile.mimeType));
      fs.writeFileSync(destination, Buffer.from(await download.arrayBuffer()));
      state.importedIds.add(item.id);
      imported++;
      console.log(`  imported ${path.basename(destination)}`);
    }
  } finally {
    saveImportState(state);
    await pickerRequest(token, `/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  console.log(`\nGoogle Photos import complete: ${imported} added, ${skipped} skipped.`);
  console.log(`Target folder: ${TARGET_FOLDER}`);
  console.log('Next: run node scripts/verify-photo-ingestion.mjs, then the normal GBP/FB photo picker.');
}

main().catch(error => { console.error(error.message || error); process.exit(1); });
