# Slideshow bed audio (local)

Used by `scripts/slideshow-reel.mjs` when building Facebook Reels.

## Default

- `upbeat-1.mp3` — default bed (`FB_SLIDESHOW_AUDIO` override supported)

## Library

| File | Source | Notes |
|------|--------|--------|
| `upbeat-1.mp3` | SoundHelix example Song 1 | Free example music; swap anytime |
| `upbeat-2.mp3` | SoundHelix example Song 2 | Alternate energy |
| `calm-1.mp3` | SoundHelix example Song 8 | Softer |
| `drive-1.mp3` | SoundHelix example Song 16 | Higher energy |

Facebook’s in-app music library is **not** available via Graph video upload — audio must be baked into the MP4 (or added later in Creator Studio UI).

To pick a different default for a run:

```powershell
$env:FB_SLIDESHOW_AUDIO = "C:\Workspace\Active\SEO-Agents-App\assets\audio\drive-1.mp3"
```
