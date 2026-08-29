# iCloud Photos → Electrical Filter — Setup & Runbook

Automatically pull electrical job photos from the iPhone, keep ONLY those on the
PC (never the full album), and feed them into the GBP pipeline — using a local
Gemma 3 vision model. Three phases: **backfill** (one-time catch-up), **curation**
(keep the good ones), **weekly** (incremental).

## Workflow

| Phase | Command | What it does |
|---|---|---|
| **Backfill** (one-time) | `powershell -File scripts/run-electrical-classify.ps1 -Backfill` | Loads Gemma, **low threshold (40)**, scans the WHOLE library, copies every likely-electrical photo to `Shared\Assets\Media\Grizzly\Backfill` (no delete). |
| **Curation** (after backfill) | `node scripts/classify-electrical.mjs --curate` | Uses the stored scores: keeps score ≥ 60 → `GBP Post Photos` cache, **removes the rest** from staging. No model call. |
| **Weekly** (scheduled) | `run-electrical-classify.ps1` (Mon 02:00) | Scans ONLY new photos, normal threshold (60), copies approved → GBP cache. |

Add `-Delete` to the weekly run to also delete the non-approved source photos
(see the note at the bottom before enabling).

## What is already done

| Piece | Location |
|---|---|
| Classifier (backfill / curate / delete / weekly) | `scripts/classify-electrical.mjs` |
| 2 AM job (stop GLM → load Gemma → classify → restore GLM) | `scripts/run-electrical-classify.ps1` |
| Gemma 3 12B model + vision projector | `Infrastructure/llama-cpp-server/models/` |
| iCloud for Windows (Store app) | installed — `AppleInc.iCloud 15.9.60.0` |
| Scheduled task | `Grizzly-Electrical-Classify` — weekly, Monday 02:00 |

## What YOU must do (2 manual steps)

1. **PC — iCloud app:** sign in → turn on **iCloud Photos** → set to **download originals**.
   Note the folder (default `C:\Users\carte\Pictures\iCloud Photos`); if different,
   set `ICLOUD_PHOTOS_DIR` in `.env`.
2. **iPhone:** Settings → your name → iCloud → Photos → **Sync this iPhone** → **Download and Keep Originals**.

## Backfill — where do the 2.5 years live? (decide before running)

- If the **iPhone still holds the full-res album** → enabling iCloud Photos uploads it
  all → run `-Backfill` against the iCloud folder. ✅
- If the **originals are only in Google Photos** (phone was "optimized") → do a one-time
  **Google Takeout** export into a temp folder, then
  `node scripts/classify-electrical.mjs --backfill --source <takeout-folder>`,
  then delete the temp folder after curation.

## ⚠️ Before enabling weekly `-Delete` (important)

Deleting a file from the iCloud for Windows **Photos folder may also delete it from
iCloud and all devices** (not just the PC). Verify this once with a throwaway photo:
1. Note a junk photo in the iCloud folder.
2. `powershell -File scripts/run-electrical-classify.ps1 -Delete` (or delete it manually in File Explorer).
3. Check whether it disappeared from iCloud.com / the iPhone.

- If it deletes **only from the PC** → enable `-Delete` in the scheduled task.
- If it deletes **from iCloud too** → keep the scheduled task copy-only, and instead
  periodically clear the local folder manually, or switch iCloud to "Optimize PC storage"
  (keeps only placeholders locally) and re-download originals on demand.

## Tuning

- `ELECTRICAL_BACKFILL_MIN_SCORE` (default 40) — backfill recall threshold.
- `ELECTRICAL_MIN_SCORE` (default 60) — weekly/curation keep threshold.
- Model quant: Q4_K_M by default; `Q6_K` (~11 GB) available for higher quality.
