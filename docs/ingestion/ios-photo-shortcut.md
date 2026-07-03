# iOS Photo Ingestion Shortcut — Build Guide

One-tap shortcut that uploads job-site photos from your iPhone into the GBP pipeline's
Google Drive source folder (`H:\My Drive\GBP Photos`). The existing Friday 08:25 sync
(`sync-photos-from-drive.mjs`) pulls them into the local cache; `gbp-photo-pick.mjs`
scores and picks them for weekly GBP posts.

**Replaces:** the manual "open Drive app, upload photos to GBP Photos folder" step.

## Prerequisites

1. **Google Drive app** installed on your iPhone and signed into the same Google
   account that mounts `H:\My Drive\GBP Photos` on your PC.
2. **"GBP Photos" folder exists in Google Drive.** Open the Drive app on your phone,
   navigate to My Drive, and create a folder named exactly `GBP Photos` if it doesn't
   already exist. (The pipeline creates it server-side when auto-curating albums, but
   the Shortcut needs it as a Files.app destination.)
3. **iOS Shortcuts app** (built-in on all iPhones running iOS 16+).

## Build the Shortcut

Open the **Shortcuts** app → tap **+** (new shortcut) → add each action in order:

| # | Action | Settings |
|---|--------|----------|
| 1 | **Select Photos** | Set Selection → **Select Multiple**. Tap the info (i) and disable "Show in Share Sheet." |
| 2 | **Repeat with Each** (in Repeat Item) | Automatically receives the selected photos. |
| 3 | **Get Name of File** | Input: the Repeat Item (the photo). This gets the original filename (e.g. `IMG_0532.HEIC`). |
| 4 | **Set Variable** | Name: `OriginalName`. Value: result of step 3. |
| 5 | **Format Date** | Date: **Current Date**. Format: **Custom** → `yyyy-MM-dd-HHmmss`. |
| 6 | **Set Variable** | Name: `Timestamp`. Value: result of step 5. |
| 7 | **Text** | Content: `{Timestamp}_{OriginalName}`. Insert both variables by tapping the Variables button below the keyboard. |
| 8 | **Set Variable** | Name: `FinalName`. Value: result of step 7. |
| 9 | **Save File** | Service: **Google Drive**. Destination path: **My Drive/GBP Photos**. File Name: the `FinalName` variable (tap → Select Variable → FinalName). **Overwrite: OFF** (should be default). |

The Shortcut name should be something you'll remember: **"Log Job Photos"** works well.

### Why this filename pattern?

`2026-07-01-143022_IMG_0532.HEIC` — the timestamp prefix guarantees unique filenames
so the pipeline's dedup (which matches on basename + byte size) never clobbers two
different photos. Re-uploading the exact same photo produces the same bytes and gets
skipped — safe and idempotent.

### HEIC stays raw

Do NOT add a "Convert Image" step. The pipeline accepts `.heic`/`.heif` natively and
converts in-memory at scoring time via `heic-convert`. Pre-converting to JPEG on the
phone would create a second file under a different name and waste cache space.

## Install to Home Screen

1. In Shortcuts, long-press the shortcut → **Details**.
2. Tap **Add to Home Screen**.
3. Choose an icon and color (a camera or bolt icon, amber/orange to match the Grizzly brand).
4. Tap **Add**.

### Siri phrase (optional)

1. In the shortcut's **Details**, tap **Add to Siri**.
2. Set phrase to: **"Log job photos"** or **"Upload job photos."**
3. Now you can trigger it hands-free after a messy job.

## Test It

### Quick smoke test (on phone)

1. Take 2 test photos of anything (they don't need to be electrical).
2. Tap the "Log Job Photos" shortcut.
3. Select the 2 test photos.
4. The Shortcut should complete with no errors. Open the Google Drive app → My Drive → GBP Photos → confirm 2 new files appeared with timestamp-prefixed names.

### End-to-end pipeline test (on PC)

From the SEO-Agents-App project root:

    # 1. Sync from Drive → local cache
    node scripts/sync-photos-from-drive.mjs

    # Confirm: "Drive X photos → added/updated 2, unchanged N"

    # 2. Verify discovery
    node scripts/verify-photo-ingestion.mjs

    # Confirm: cache count rose by 2, new files listed

    # 3. Dry-run the picker (won't copy or post, just shows what would match)
    node scripts/gbp-photo-pick.mjs --dry-run

    # Confirm: your 2 test photos appear as discovered (they may score low
    # since they're not electrical work — that's fine, this proves ingestion).

### Clean up test photos

Delete the 2 test photos from:
- Google Drive → My Drive → GBP Photos
- `C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos` (local cache)

## Daily Workflow

After completing an electrical job:

1. Take job-site photos as normal (iPhone camera).
2. Back at the truck / office: tap **Log Job Photos**.
3. Select today's job photos (multi-select → tap all relevant ones).
4. Done. They'll appear in the Drive folder; the Friday 08:25 sync picks them up.

**Re-running on the same photos is safe.** The pipeline deduplicates by filename + byte
size — identical re-uploads are skipped. If you re-edited a photo on your phone and
re-upload, it will have a different timestamp prefix (and likely different byte size), so
it lands as a new file — the old version stays cached until you clean it up.

## Troubleshooting

### "Save File" doesn't show Google Drive as a destination

- Open the **Files** app → Browse → verify Google Drive appears in the Locations list.
- If missing: open the **Google Drive app** → tap the account avatar → ensure the
  account is signed in. Sometimes toggling "Show in Files app" in Drive app settings
  helps.
- After an iOS major update, you may need to re-grant Files access: Settings → your
  Google account → Files and Folders → enable Google Drive.

### Shortcut finishes but photos don't appear in Drive

- Check the Drive app's **Recent** view — large HEIC files may take 30–60 seconds to
  upload on cellular. The Shortcut returns before the upload finishes in some iOS
  versions; verify by checking the Drive folder after a minute.
- On Wi-Fi, uploads should be near-instant for 5–15 MP photos.

### Photos not appearing in the pipeline

- Run `node scripts/verify-photo-ingestion.mjs` on the PC to check if the cache is
  in sync with the Drive folder.
- The most common cause: **Drive for Desktop is not running** on the PC. The 08:25
  sync reads from `H:\My Drive\GBP Photos` (the Drive mount). Open Drive for Desktop
  or wait for it to auto-start, then re-run `sync-photos-from-drive.mjs`.

## Upgrade Path

If the Files → Google Drive integration proves unreliable after iOS updates, or you
want richer features (job tagging, preview before upload, direct upload to the cache
over Tailscale cutting the Drive-for-Desktop dependency), a native iOS app built with
Xcode and distributed via TestFlight is a clean upgrade. The pipeline doesn't care how
photos arrive in the Drive folder — only that they do.

Talk to Carter about building a `GrizzlyField` Swift app (repo exists at
`github.com/barnscarter-ops/MaverickField`) that could absorb this as a photo-upload
module.
