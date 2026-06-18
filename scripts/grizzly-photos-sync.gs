// ─────────────────────────────────────────────────────────────────────────────
// Grizzly Photos → GBP Photos Drive Sync
// Copies new photos from the "Grizzly" Google Photos album to the
// "GBP Photos" folder in Google Drive automatically.
//
// SETUP:
//   1. Paste into script.google.com → New project
//   2. Click the gear icon (Project Settings) → check "Show appsscript.json"
//   3. In the editor, open appsscript.json and REPLACE its contents with the
//      manifest block at the bottom of this file
//   4. Run syncGrizzlyToDrive() once → click Authorize → Allow
//   5. Run setupDailyTrigger() once to set the daily auto-sync
// ─────────────────────────────────────────────────────────────────────────────

const ALBUM_NAME = 'Grizzly';
const DRIVE_FOLDER_NAME = 'GBP Photos';

function syncGrizzlyToDrive() {
  const token = ScriptApp.getOAuthToken();

  // Find the Grizzly album
  const albumId = findAlbum(token, ALBUM_NAME);
  if (!albumId) {
    console.log(`Album "${ALBUM_NAME}" not found. Make sure it exists in Google Photos.`);
    return;
  }
  console.log(`Found album: ${albumId}`);

  // Get the GBP Photos Drive folder
  const folder = getOrCreateFolder(DRIVE_FOLDER_NAME);

  // Build set of already-synced filenames
  const existingFiles = new Set();
  const files = folder.getFiles();
  while (files.hasNext()) existingFiles.add(files.next().getName());
  console.log(`Already in Drive: ${existingFiles.size} files`);

  // List all photos in the album
  const photos = listAlbumPhotos(token, albumId);
  console.log(`Photos in album: ${photos.length}`);

  let added = 0;
  let skipped = 0;

  for (const photo of photos) {
    // Skip videos
    if (!photo.mimeType || !photo.mimeType.startsWith('image/')) { skipped++; continue; }

    const filename = photo.filename;
    if (existingFiles.has(filename)) { skipped++; continue; }

    try {
      const response = UrlFetchApp.fetch(`${photo.baseUrl}=d`, {
        headers: { Authorization: `Bearer ${token}` },
        muteHttpExceptions: true
      });
      if (response.getResponseCode() !== 200) {
        console.log(`Download failed for ${filename}: HTTP ${response.getResponseCode()}`);
        continue;
      }
      const blob = response.getBlob().setName(filename);
      folder.createFile(blob);
      existingFiles.add(filename);
      added++;
      console.log(`✓ Added: ${filename}`);
    } catch (e) {
      console.log(`✗ Error downloading ${filename}: ${e.message}`);
    }
  }

  console.log(`\nSync complete — Added: ${added} | Skipped: ${skipped}`);
}

// ── Photos API helpers ────────────────────────────────────────────────────────

function findAlbum(token, name) {
  let pageToken = null;
  do {
    const url = 'https://photoslibrary.googleapis.com/v1/albums?pageSize=50' +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (data.error) { console.log('API error:', JSON.stringify(data.error)); return null; }
    for (const album of (data.albums || [])) {
      if (album.title === name) return album.id;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return null;
}

function listAlbumPhotos(token, albumId) {
  const photos = [];
  let pageToken = null;
  do {
    const body = { albumId, pageSize: 100, ...(pageToken ? { pageToken } : {}) };
    const res = UrlFetchApp.fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${token}` },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    const data = JSON.parse(res.getContentText());
    if (data.error) { console.log('API error:', JSON.stringify(data.error)); break; }
    if (data.mediaItems) photos.push(...data.mediaItems);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return photos;
}

// ── Drive helpers ─────────────────────────────────────────────────────────────

function getOrCreateFolder(name) {
  const results = DriveApp.getFoldersByName(name);
  if (results.hasNext()) return results.next();
  console.log(`Creating Drive folder: ${name}`);
  return DriveApp.createFolder(name);
}

// ── Trigger setup ─────────────────────────────────────────────────────────────

function setupDailyTrigger() {
  // Remove any existing triggers for this function
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncGrizzlyToDrive')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncGrizzlyToDrive')
    .timeBased()
    .everyDays(1)
    .atHour(3)  // 3am daily
    .create();

  console.log('Daily trigger set: syncGrizzlyToDrive runs at 3am every day.');
}


// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST — paste this into appsscript.json (replacing existing content):
//
// {
//   "timeZone": "America/Chicago",
//   "dependencies": {},
//   "exceptionLogging": "STACKDRIVER",
//   "runtimeVersion": "V8",
//   "oauthScopes": [
//     "https://www.googleapis.com/auth/photoslibrary.readonly",
//     "https://www.googleapis.com/auth/drive",
//     "https://www.googleapis.com/auth/script.external_request"
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────
