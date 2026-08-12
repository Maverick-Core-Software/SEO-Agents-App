# Google Photos → GBP electrical photo import

The old Google Photos album-to-Drive integration cannot be restored: Google
removed the broad `photoslibrary.readonly`/album access scopes and restricted
the Library API to app-created media. The supported replacement is the Google
Photos Picker API, which lets Carter select job photos in Google Photos and
then downloads those selected images into the existing GBP photo cache.

This is intentionally user-assisted. Google does not provide an approved API
for an unattended “scan my entire library and find electrical photos” job.
After import, `gbp-photo-pick.mjs` still uses vision scoring and service-type
matching, so unrelated selected images are rejected or left unused.

## One-time setup

1. In the Google Cloud project used for this integration, enable the **Google
   Photos Picker API**.
2. Use an **installed-app OAuth client**. Do not paste its client secret or a
   token into chat. Keep the JSON at the existing local credential path, or set
   `GOOGLE_PHOTOS_CLIENT_SECRET` in `.env`.
3. The first run opens Google consent. The separate refresh token is saved to
   `GOOGLE_PHOTOS_TOKEN_FILE` (default:
   `C:\Users\carte\gmail-multi\tokens\grizzly-google-photos-picker.json`).

## Import workflow

From the repository root:

    node scripts/google-photos-picker-import.mjs --max-items=100

The script opens a Picker session. Select only electrical job photos, finish
the selection, and wait for the import summary. Files are added to
`GBP_PHOTOS_LOCAL_CACHE` (the same folder the weekly picker scans) with unique
`gphotos-...` names. The import state file makes reruns idempotent.

Then verify ingestion:

    node scripts/verify-photo-ingestion.mjs
    node scripts/gbp-photo-pick.mjs --dry-run

The scheduled Friday Drive sync remains available for the existing iPhone →
Google Drive shortcut. The Picker import is the supported Google Photos path
when the originals are still only in the Photos library.

References:

- https://developers.google.com/photos/support/updates
- https://developers.google.com/photos/picker/guides/get-started-picker
- https://developers.google.com/photos/picker/guides/media-items
