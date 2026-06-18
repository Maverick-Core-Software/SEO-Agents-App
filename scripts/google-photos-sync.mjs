#!/usr/bin/env node
/**
 * google-photos-sync.mjs
 * Download photos from a Google Photos album to the GBP inbox for scanning.
 *
 * Commands:
 *   list-albums                  List all albums to find the right one
 *   sync --album <id>            Download all photos from album to inbox
 *   sync-ev                      Sync the Grizzly album then scan for EV charger photos
 *   auth                         Interactive OAuth flow to get a refresh token
 *
 * Env vars (from .env):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_PHOTOS_REFRESH_TOKEN  (or falls back to GOOGLE_REFRESH_TOKEN)
 *   GBP_INBOX_FOLDER             (default: E:\Media\Grizzly\Inbox)
 *   GOOGLE_PHOTOS_ALBUM          (optional: album title to auto-match)
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Load .env ──────────────────────────────────────────────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const CLIENT_ID = process.env.GOOGLE_PHOTOS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_PHOTOS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.GOOGLE_PHOTOS_REFRESH_TOKEN || '';
const INBOX_FOLDER = process.env.GBP_INBOX_FOLDER || 'E:\\Media\\Grizzly\\Inbox';
const ALBUM_TITLE_FILTER = process.env.GOOGLE_PHOTOS_ALBUM || 'Grizzly';

const PHOTOS_SCOPE = 'https://www.googleapis.com/auth/photoslibrary.readonly';
const AUTH_PORT = 8765;

// ── OAuth helpers ──────────────────────────────────────────────────────────

async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error('Missing credentials. Need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PHOTOS_REFRESH_TOKEN in .env');
    console.error('Run: node google-photos-sync.mjs auth   to get a refresh token');
    process.exit(1);
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    console.error('Failed to get access token:', JSON.stringify(data));
    console.error('The refresh token may be expired. Run: node google-photos-sync.mjs auth');
    process.exit(1);
  }
  return data.access_token;
}

// ── Google Photos API helpers ──────────────────────────────────────────────

async function listAlbums(accessToken) {
  const albums = [];
  let pageToken = null;

  do {
    const url = new URL('https://photoslibrary.googleapis.com/v1/albums');
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    if (data.albums) albums.push(...data.albums);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return albums;
}

async function getAlbumPhotos(accessToken, albumId) {
  const items = [];
  let pageToken = null;

  do {
    const res = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        albumId,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    if (data.mediaItems) items.push(...data.mediaItems);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${path.basename(destPath)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

// ── Commands ───────────────────────────────────────────────────────────────

async function cmdListAlbums() {
  console.log('\nFetching access token...');
  const token = await getAccessToken();
  console.log('Listing albums...\n');
  const albums = await listAlbums(token);

  if (!albums.length) {
    console.log('No albums found.');
    return;
  }

  albums.forEach(a => {
    const match = a.title?.toLowerCase().includes(ALBUM_TITLE_FILTER.toLowerCase()) ? ' ← MATCH' : '';
    console.log(`  ${a.id}  "${a.title}"  (${a.mediaItemsCount || '?'} items)${match}`);
  });
  console.log(`\nTotal: ${albums.length} albums`);
  console.log(`\nTo sync an album: node google-photos-sync.mjs sync --album <id>`);
  console.log(`Or set GOOGLE_PHOTOS_ALBUM in .env to auto-match by title.`);
}

async function cmdSync(albumId) {
  console.log('\nFetching access token...');
  const token = await getAccessToken();

  if (!albumId) {
    console.log(`Looking for album matching "${ALBUM_TITLE_FILTER}"...`);
    const albums = await listAlbums(token);
    const match = albums.find(a => a.title?.toLowerCase().includes(ALBUM_TITLE_FILTER.toLowerCase()));
    if (!match) {
      console.error(`No album found matching "${ALBUM_TITLE_FILTER}". Run list-albums to see all albums.`);
      process.exit(1);
    }
    albumId = match.id;
    console.log(`Found: "${match.title}" (${match.mediaItemsCount || '?'} items)`);
  }

  console.log(`\nFetching photo list from album...`);
  const items = await getAlbumPhotos(token, albumId);
  console.log(`Found ${items.length} photos\n`);

  fs.mkdirSync(INBOX_FOLDER, { recursive: true });

  // Only download images (skip videos)
  const images = items.filter(item => item.mimeType?.startsWith('image/'));
  const skipped = items.length - images.length;
  console.log(`Images: ${images.length} | Videos skipped: ${skipped}`);

  // Check which are already downloaded
  const existingFiles = new Set(fs.readdirSync(INBOX_FOLDER));
  const toDownload = images.filter(item => !existingFiles.has(item.filename));
  console.log(`Already in inbox: ${images.length - toDownload.length} | New to download: ${toDownload.length}\n`);

  if (!toDownload.length) {
    console.log('All photos already in inbox. Run photo-scanner to process them:');
    console.log('  node photo-scanner.mjs scan');
    return;
  }

  let downloaded = 0;
  let failed = 0;

  for (const item of toDownload) {
    const destPath = path.join(INBOX_FOLDER, item.filename);
    process.stdout.write(`  Downloading ${item.filename}... `);
    try {
      // =d downloads at original quality
      const downloadUrl = `${item.baseUrl}=d`;
      await downloadFile(downloadUrl, destPath);
      process.stdout.write('✓\n');
      downloaded++;
    } catch (e) {
      process.stdout.write(`✗ ${e.message}\n`);
      failed++;
    }
  }

  console.log(`\n✓ Sync complete`);
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Inbox: ${INBOX_FOLDER}`);
  console.log(`\nNext: score and index new photos:`);
  console.log(`  node photo-scanner.mjs scan`);
}

async function cmdSyncEV() {
  console.log('=== Syncing Grizzly album to find EV charger photos ===\n');
  await cmdSync(null);
  console.log('\n=== Now running photo-scanner to score and tag new photos ===\n');
  const { execSync } = await import('node:child_process');
  try {
    execSync('node photo-scanner.mjs scan', { cwd: __dirname, stdio: 'inherit' });
  } catch {
    // photo-scanner exits with non-zero on no new photos; that's fine
  }
}

async function cmdAuth() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Need GOOGLE_PHOTOS_CLIENT_ID and GOOGLE_PHOTOS_CLIENT_SECRET in .env.');
    console.error('Get the client secret from:');
    console.error('  https://console.cloud.google.com/auth/clients?project=gen-lang-client-0205768752');
    console.error('  → click "Grizzly Photos Local" → copy Client Secret');
    process.exit(1);
  }

  const redirectUri = `http://localhost:${AUTH_PORT}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', PHOTOS_SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('\n=== Google Photos OAuth Setup ===\n');

  // Start a temporary localhost server to capture the redirect
  const { createServer } = await import('node:http');
  let resolveCode;
  const codePromise = new Promise(r => { resolveCode = r; });

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${AUTH_PORT}`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>✓ Authorization successful! You can close this tab.</h2></body></html>');
      resolveCode({ code });
    } else {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h2>Error: ${error || 'unknown'}</h2></body></html>`);
      resolveCode({ error: error || 'unknown' });
    }
    server.close();
  });

  server.listen(AUTH_PORT, () => {
    console.log(`Listening on http://localhost:${AUTH_PORT} for Google's redirect...\n`);
    console.log('1. Open this URL in your browser (sign in as barnscarter@gmail.com):');
    console.log('\n   ' + authUrl.toString() + '\n');
    console.log('2. Grant access — the page will redirect back automatically.\n');
  });

  const { code, error } = await codePromise;
  if (error) { console.error('Auth failed:', error); process.exit(1); }

  console.log('Got authorization code. Exchanging for tokens...');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const data = await res.json();
  if (!data.refresh_token) {
    console.error('\nFailed to get refresh token:', JSON.stringify(data));
    process.exit(1);
  }

  console.log('\n✓ Success! Add this to your .env:\n');
  console.log(`GOOGLE_PHOTOS_REFRESH_TOKEN=${data.refresh_token}`);
  console.log('\nThen run: node google-photos-sync.mjs list-albums');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '';
  const albumFlag = args.indexOf('--album');
  const albumId = albumFlag >= 0 ? args[albumFlag + 1] : null;

  if (command === 'list-albums') {
    await cmdListAlbums();
  } else if (command === 'sync') {
    await cmdSync(albumId);
  } else if (command === 'sync-ev') {
    await cmdSyncEV();
  } else if (command === 'auth') {
    await cmdAuth();
  } else {
    console.log('Usage:');
    console.log('  node google-photos-sync.mjs list-albums           List all Google Photos albums');
    console.log('  node google-photos-sync.mjs sync                  Sync album matching GOOGLE_PHOTOS_ALBUM env var');
    console.log('  node google-photos-sync.mjs sync --album <id>     Sync a specific album by ID');
    console.log('  node google-photos-sync.mjs sync-ev               Sync + auto-run photo-scanner');
    console.log('  node google-photos-sync.mjs auth                  Get a new refresh token via OAuth');
    console.log('');
    console.log(`Album filter: "${ALBUM_TITLE_FILTER}" (set GOOGLE_PHOTOS_ALBUM to change)`);
    console.log(`Inbox folder: ${INBOX_FOLDER}`);
    process.exit(0);
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
