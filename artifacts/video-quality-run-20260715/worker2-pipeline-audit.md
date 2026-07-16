# Video Generation Pipeline Audit Report

**Date:** 2026-07-15  
**Auditor:** Worker 2 (Subagent)  
**Scope:** Complete flow from content scheduling → video generation → Facebook posting  

---

## 1. Complete Architecture Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PHASE 1: SCHEDULE GENERATION                        │
│                                                                             │
│  seo-agents facebook-schedule                                               │
│  ┌─────────────────────────────────────────────┐                            │
│  │ src/seo_agents/crew.py                       │                            │
│  │   build_facebook_crew()                      │                            │
│  │   - CrewAI Agent + LLM (GPT-4o family)       │                            │
│  │   - Reads: content_report.md, gbp_report.md  │                            │
│  │   - DAY_TOPIC_BINDING_RULE (line 858)        │                            │
│  │     Day N = RANK N topic from GBP REPORT     │                            │
│  │   - Days 1,4,7 = video; Day 5 = text;        │                            │
│  │     Days 2,3,6 = photo                       │                            │
│  │   - Each video day gets a VIDEO_PROMPT field  │                            │
│  │     (scene idea, NOT final generation prompt) │                            │
│  └──────────────────┬──────────────────────────┘                            │
│                     │                                                       │
│                     ▼                                                       │
│  outputs/facebook_posting_schedule.md                                       │
│  (7 day blocks, each with VIDEO_PROMPT for video days)                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PHASE 2: PIPELINE ORCHESTRATION                         │
│                                                                             │
│  scripts/mav-bridge.mjs (PM2-managed service, polls Supabase)               │
│  ┌─────────────────────────────────────────────┐                            │
│  │ executeApprovedRun(run)                      │                            │
│  │                                              │                            │
│  │ Step 0: Generate Day 1 video prompt           │                            │
│  │   generateDay1VideoPrompt() (line 164)        │                            │
│  │   - xAI Grok (grok-4.20-0309-non-reasoning)   │                            │
│  │   - Rewrites Day 1 VIDEO_PROMPT               │                            │
│  │   - 5-min approval window (dashboard)         │                            │
│  │   - Writes approved prompt back to schedule   │                            │
│  │                                              │                            │
│  │ Step 0.5: gbp-photo-pick.mjs (curated photos) │                            │
│  │ Step 0.6: fb-photo-rewrite.mjs (fix PHOTO_FILE)│                           │
│  │                                              │                            │
│  │ Step 1: Facebook posting                      │                            │
│  │   runPhase('facebook', facebook-poster.mjs)   │                            │
│  │   --schedule-all --time 09:00                 │                            │
│  │   timeout: 45 min                             │                            │
│  └──────────────────┬──────────────────────────┘                            │
└─────────────────────┼───────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   PHASE 3: VIDEO GENERATION + POSTING                      │
│                                                                             │
│  scripts/facebook-poster.mjs                                                │
│  ┌─────────────────────────────────────────────┐                            │
│  │ runWeek() → generateAllVideos(posts)          │                            │
│  │                                              │                            │
│  │ For each video post (Days 1, 4, 7):           │                            │
│  │   1. generateCinematicPrompt(post) (line 549) │                            │
│  │      - xAI Grok (grok-4.20-0309-non-reasoning)│                            │
│  │      - System prompt: "video director"        │                            │
│  │      - Rewrites schedule VIDEO_PROMPT into    │                            │
│  │        cinematic 100-140 word generation prompt│                           │
│  │      - Appends no-text enforcement tail       │                            │
│  │                                              │                            │
│  │   2. sanitizeVideoPrompt(prompt) (line 514)   │                            │
│  │      - Strips brand name → "a residential    │                            │
│  │        electrician" / "the electrician"       │                            │
│  │      - Strips phone-number patterns           │                            │
│  │                                              │                            │
│  │   3. generateVideoViaBackend() (line 525)     │                            │
│  │      - Spawns: node {backend} --prompt ...    │                            │
│  │      - Backend = xai (default) or gemini      │                            │
│  │      - Output: *-raw.mp4                      │                            │
│  │                                              │                            │
│  │   4. addBrandedEndCard(rawPath, finalPath)    │                            │
│  │      (line 429)                               │                            │
│  │      - FFmpeg concat: video + 3s still card   │                            │
│  │      - drawtext: brand name + phone overlay   │                            │
│  │      - Audio-aware (keeps/pads silence)       │                            │
│  │      - Output: final .mp4                     │                            │
│  │                                              │                            │
│  │   5. graphDispatch() → graphPostVideo()       │                            │
│  │      - Facebook Graph API video upload        │                            │
│  │      - Schedules or posts live                │                            │
│  │                                              │                            │
│  │ Fallback chain:                               │                            │
│  │   video fails → photo (curatedPhotoForDate)   │                            │
│  │   photo fails → text-only post                │                            │
│  └─────────────────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PHASE 4: ACTION DISPATCH (DASHBOARD)                   │
│                                                                             │
│  src/seo_agents/actions.py                                                  │
│  ┌─────────────────────────────────────────────┐                            │
│  │ parse_facebook_post_actions() (line 596)     │                            │
│  │   - Parses facebook_posting_schedule.md      │                            │
│  │   - Splits on --- blocks                     │                            │
│  │   - Extracts: day, date, type, service,      │                            │
│  │     hook, body, cta, hashtags, photo_file,    │                            │
│  │     video_prompt, status                     │                            │
│  │   - Creates action dicts with post payload   │                            │
│  │   - Each action: publish_facebook_post        │                            │
│  │   - Single-post mode: --payload JSON          │                            │
│  │     → runSinglePayload() in facebook-poster   │                            │
│  └─────────────────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Current Prompt Engineering Pipeline

### 2.1 Three-Stage Prompt Pipeline

The video prompt goes through **three distinct rewriting stages** before reaching the video generation API:

#### Stage 1: CrewAI Schedule Writer (crew.py, lines 1029-1048)
- **Who:** CrewAI "Grizzly Facebook Content Agent" 
- **Model:** `build_exec_llm()` — typically GPT-4o family
- **What:** Writes a raw `VIDEO_PROMPT` scene idea for each video day
- **Instructions (lines 1041-1049):**
  - "VIDEO_PROMPT is a scene idea for an attention-grabbing vertical Reel (a director step rewrites it before generation)"
  - "Make it DRAMATIC and fast-paced: open on the electrical problem at its scariest"
  - "3-4 quick cuts, human stakes, end with the electrician arriving or power triumphantly restored"
  - Example provided (lines 1045-1047)
  - "NEVER put the business name, any logo, any phone number, or any readable text/signage in VIDEO_PROMPT"

#### Stage 2a: mav-bridge Day 1 Pre-Generation (mav-bridge.mjs, lines 164-201)
- **Who:** `generateDay1VideoPrompt()` — runs BEFORE facebook-poster
- **Model:** xAI Grok `grok-4.20-0309-non-reasoning` (max_tokens: 300)
- **Scope:** Day 1 ONLY (not Days 4, 7)
- **What:** Rewrites the Day 1 VIDEO_PROMPT using service/hook/caption context
- **Instructions (line 190):**
  - "Opens with an establishing shot that sets a relatable scene"
  - "Builds tension around an electrical problem"
  - "Includes a dramatic visual moment"
  - "Feels like a mini movie trailer"
  - "Ends with: Photorealistic, cinematic, 4K, dramatic atmosphere, no text overlays"
- **Approval:** 5-minute dashboard approval window; auto-proceeds if timeout
- **Note:** Writes the approved/generated prompt back into the schedule file (line 260), overwriting the original

#### Stage 2b: facebook-poster Cinematic Rewrite (facebook-poster.mjs, lines 549-581)
- **Who:** `generateCinematicPrompt(post)` — runs for ALL video days
- **Model:** xAI Grok `grok-4.20-0309-non-reasoning` (max_tokens: 320)
- **What:** Rewrites the schedule's VIDEO_PROMPT into a final cinematic generation prompt
- **System prompt (line 565, ~500 chars visible, truncated):**
  - "Write a single vivid, cinematic prompt (100-140 words)"
  - "OPENS ON THE DRAMA — the spark, the arc flash, the plunge into darkness"
  - "Packs 3-4 fast cuts into 8 seconds"
  - "Uses dynamic camera energy: whip pans, crash zooms, hard push-ins"
  - "Includes real spectacle scaled to the topic"
  - "Shows human stakes and ends on the electrician arriving or power surging back"
  - "Calls for punchy diegetic AUDIO but no dialogue"
  - Strict no-text rules: no business name, no logos, no on-screen captions
- **Post-processing (line 577-578):** If output lacks "no visible text", appends enforcement tail
- **Fallback (line 555-556):** If no XAI_API_KEY, uses schedule prompt as-is

#### Stage 3: Sanitization (facebook-poster.mjs, lines 514-523)
- **Who:** `sanitizeVideoPrompt(prompt)` — runs right before backend spawn
- **What:** Regex-based stripping of:
  - "Grizzly Electrical Solutions" → "a residential electrician"
  - "Grizzly" → "the electrician"
  - Phone number patterns (XXX-XXX-XXXX, etc.)
  - Extra whitespace normalization

### 2.2 Prompt Flow Summary

```
crew.py (CrewAI/GPT-4o) → VIDEO_PROMPT in schedule.md
                                    │
                    ┌───────────────┴───────────────┐
                    │ (Day 1 only)                    │
                    ▼                                 │
         mav-bridge.mjs                        (Days 4, 7 skip)
         generateDay1VideoPrompt()
         Grok rewrite + approval
         Writes back to schedule.md
                    │
                    └───────────┬───────────────────┘
                                ▼
              facebook-poster.mjs
              generateCinematicPrompt() [ALL video days]
              Grok rewrite → cinematic prompt
                                │
                                ▼
              sanitizeVideoPrompt()
              Strip brand/phone
                                │
                                ▼
              Video backend (xAI Grok Imagine or Google Veo 3.1)
```

**Key observation:** Day 1's prompt is rewritten TWICE by Grok (once in mav-bridge, once in facebook-poster), while Days 4 and 7 are rewritten only once (in facebook-poster). This is an inconsistency.

---

## 3. Video Generation Parameters

### 3.1 Backend Selection
- **Default backend:** `xai` (Grok Imagine) — set at `facebook-poster.mjs:88`
- **Configurable via:** `FB_VIDEO_BACKEND` env var (`'xai'` or `'gemini'`)
- **Reason for xAI default (comment lines 84-87):** "Veo 3 was rendering brand text and phone numbers directly into the frame with garbled spelling"

### 3.2 xAI Grok Imagine (xai-video-generator.mjs)

| Parameter | Value | Source |
|-----------|-------|--------|
| Model | `grok-imagine-video` | line 36 |
| Aspect ratio | `9:16` (vertical) | line 44 (default) |
| Duration | `8` seconds | line 44 (default) |
| Resolution | `720p` | line 37 |
| Poll interval | 5000ms | line 38 |
| Max poll attempts | 144 (12 min) | line 41 |
| API endpoint | `https://api.x.ai/v1/videos/generations` | line 88 |

**Note (lines 34-36):** `grok-imagine-video-1.5` is image-to-video ONLY. Text-to-video requires `grok-imagine-video`. The code defaults to the text-to-video model.

**Env vars:**
- `XAI_API_KEY` / `GROK_API_KEY` — API key (required)
- `GROK_VIDEO_MODEL` — override model (default: `grok-imagine-video`)
- `GROK_VIDEO_RESOLUTION` — override resolution (default: `720p`)

### 3.3 Google Veo 3.1 (gemini-video-generator.mjs)

| Parameter | Value | Source |
|-----------|-------|--------|
| Model | `veo-3.1-generate-preview` | line 34 |
| Aspect ratio | `9:16` (vertical) | line 43 (default) |
| Duration | `8` seconds | line 43 (default) |
| Sample count | 1 | line 90 |
| Poll interval | 8000ms | line 35 |
| Max poll attempts | 90 (12 min) | line 40 |
| API endpoint | `generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning` | line 83 |

**Note (lines 32-33):** `veo-3.0-generate-001` is deprecated and returns 404.

**Env vars:**
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` — API key (required)
- `GEMINI_VEO_MODEL` — override model (default: `veo-3.1-generate-preview`)

### 3.4 Parent Process Timeout
- `facebook-poster.mjs:113`: `VIDEO_GEN_TIMEOUT_MS = 13 * 60 * 1000` (13 minutes)
- Must exceed both backends' 12-minute poll ceilings
- `mav-bridge.mjs:333`: Facebook phase timeout = `45 * 60 * 1000` (45 min, for 3 video renders + uploads)

### 3.5 Neither backend receives aspect-ratio or duration from facebook-poster

**Critical finding:** `generateVideoViaBackend()` (line 530) spawns the backend with only `--prompt` and `--output`:
```javascript
const out = execFileSync('node', [VIDEO_GEN_SCRIPT, '--prompt', cleanPrompt, '--output', rawPath], {
  timeout: VIDEO_GEN_TIMEOUT_MS,
  encoding: 'utf8',
});
```
Both backends default to `9:16` and `8s` internally, but facebook-poster never explicitly passes these parameters. They rely entirely on the backends' built-in defaults.

---

## 4. Post-Processing Pipeline (FFmpeg End Card)

### 4.1 addBrandedEndCard() — facebook-poster.mjs lines 429-507

**Purpose:** Append a 3-second branded still image to the end of each generated video with brand name + phone number overlaid via FFmpeg drawtext.

**Flow:**
1. **FFmpeg check** (line 135-141): One-time availability check at module load. If FFmpeg missing, end cards are silently skipped for all videos.
2. **Card source** (line 434): Uses `GRIZZLY_ENDCARD_PATH` (default: `assets/grizzly-endcard.jpg`), falls back to `GRIZZLY_LOGO_PATH` (default: `assets/grizzly-logo.png`)
3. **Video probe** (lines 440-448): `ffprobe` to get width, height, frame rate of the raw video
   - Defaults if probe fails: 720×1280, 24fps
4. **Audio detection** (lines 465-472): `ffprobe` to check for audio stream
5. **Card preparation** (line 474): Scale endcard image to video width, pad to video dimensions, apply drawtext overlays:
   - Brand name: centered, 72% height, font size = H/30
   - Phone: centered, 80% height, font size = H/22
   - Shadow: black@0.9, offset 3px
6. **Concatenation** (lines 476-501):
   - **With audio:** Concatenates video+audio from raw clip with 3s silent card (anullsrc), maps both `[out]` and `[outa]`
   - **Without audio:** Concatenates video only, discards audio (`-an`)
7. **Encoding:** libx264, preset fast, CRF 22, AAC 128k (if audio)
8. **Cleanup:** Deletes raw video file (line 502)

**FFmpeg escape function** (lines 421-427): Escapes `\`, `:`, `'`, `%` for drawtext safety.

### 4.2 End Card Configuration

| Config | Default | Env Var |
|--------|---------|---------|
| End card image | `assets/grizzly-endcard.jpg` | `GRIZZLY_ENDCARD_PATH` |
| Logo image (fallback) | `assets/grizzly-logo.png` | `GRIZZLY_LOGO_PATH` |
| Brand name | "Grizzly Electrical Solutions" | `GRIZZLY_BRAND_NAME` |
| Brand phone | "(469) 863-9804" | `GRIZZLY_BRAND_PHONE` |
| Brand location | "Rowlett, TX" | `GRIZZLY_BRAND_LOCATION` |
| Font (Windows) | `C\:/Windows/Fonts/arialbd.ttf` | `GRIZZLY_ENDCARD_FONT` |
| Font (Linux) | `/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf` | `GRIZZLY_ENDCARD_FONT` |

### 4.3 Audio Handling

- Raw video audio is **preserved** if present (both Grok Imagine and Veo 3.1 can produce audio)
- End card gets **3 seconds of silence** (anullsrc, stereo, 48kHz) when audio is present
- If no audio track: entire output is silent (`-an` flag)
- Audio codec: AAC, 128k bitrate

---

## 5. Fallback Logic

### 5.1 Video Generation Failure → Photo → Text

The fallback chain is implemented in `graphDispatch()` (lines 397-414):

```
Video post + video file exists?
  ├── YES → graphPostVideo() → media='video', fallback=null
  └── NO  → resolvePhotoPath(post)
             ├── Photo found? → graphPostPhoto() → media='photo', fallback='video→photo'
             └── No photo?    → graphPostText()  → media='text', fallback='video→text'
```

### 5.2 Video Generation Failures in generateAllVideos() (lines 585-636)

- **Gemini pre-flight check** (lines 595-609): If `VIDEO_BACKEND === 'gemini'`, probes Gemini API for `RESOURCE_EXHAUSTED` (429). If depleted, skips ALL video generation and sets `geminiCreditsDepletedFlag = true`.
- **Per-video catch** (lines 626-634): On failure, logs warning and continues. The post will fall through to photo/text fallback at posting time.
- **Gemini credits depleted detection** (line 628): Regex matches "prepayment credits", "credits are depleted", "RESOURCE_EXHAUSTED"
- **mav-bridge alert** (lines 348-354): If `gemini_credits_depleted` flag is set in the result, sends an email alert to re-enable Gemini credits.

### 5.3 Photo Fallback Resolution

`resolvePhotoPath()` (lines 209-222):
1. Check `post.photo_file` — resolve absolute or relative to GBP_PHOTO_PATH / outputs/
2. If no explicit photo: `curatedPhotoForDate(date, service)` — looks in `GBP_CURATED_FOLDER` for date-prefixed files

`curatedPhotoForDate()` (lines 189-207):
- Scans `E:\Media\Grizzly\Curated` for files matching `{date}-*.{jpg|png|webp}`
- Prefers files whose slug matches the post's service type
- Falls back to first match by date

### 5.4 Single-Post Mode Fallback (lines 916-928)

In `runSinglePayload()`, if video generation fails:
```javascript
try {
  generateGeminiVideo(prompt, videoPath);
} catch (e) {
  hopLog('facebook-poster→gemini', 'warn', `video generation failed — will fall back to photo/text`);
  videoPath = null;
}
```
Then `graphDispatch()` handles the photo/text fallback.

### 5.5 End Card FFmpeg Failure (lines 503-506)

If FFmpeg end card processing fails:
```javascript
hopLog('facebook-poster→ffmpeg', 'warn', `end card failed — using raw video`);
if (fs.existsSync(rawPath)) fs.renameSync(rawPath, finalPath);
```
The raw video (without branding) is used as the final output.

---

## 6. Known Issues Visible in Code Comments

### 6.1 Veo 3 Text Hallucination (facebook-poster.mjs, lines 84-87)
```javascript
// Veo 3 was renderering brand text and phone numbers directly into the frame
// with garbled spelling ("Eleecrtral Sollutions", "(169) 865-9804") because
// video models can't reliably draw text on curved surfaces. Grok Imagine is
// the current default; we composite the real brand + phone via ffmpeg after.
```

### 6.2 Stale GEMINI_API_KEY from PM2 (facebook-poster.mjs, lines 58-62)
```javascript
// FORCE-OVERRIDE: this script is spawned by mav-bridge, which inherits its env
// from PM2. PM2's ecosystem.config.cjs loads MCC's .env first (line 1), whose
// keys can differ from this repo's .env (notably GEMINI_API_KEY — a stale value
// there caused 401 auth failures on every Veo generation). .env here wins.
```
Same issue documented in `gemini-video-generator.mjs` (lines 16-22).

### 6.3 Graph API Video Upload (facebook-poster.mjs, lines 370-375)
```javascript
// The older resumable/chunked (upload_phase start→transfer→finish) path returns
// {"success":true} with no video id on current Graph API versions — the video
// object is never created, so the post silently never appears.
```

### 6.4 Video Day Fallback Photo Gap (mav-bridge.mjs, lines 279-286)
```javascript
// Previously the picker only ran inside the GBP phase — AFTER Facebook had
// already posted — so video days had no curated fallback and posted as
// text-only. Run it here, before FB, so the fallback resolves.
```

### 6.5 FB Photo Filename Mismatch (mav-bridge.mjs, lines 293-299)
```javascript
// The FB crew's LLM picks photo filenames by keyword with no service constraint,
// so an EV-charger post can ship with "financing-available.JPG".
```

### 6.6 xAI Model Confusion (xai-video-generator.mjs, lines 34-36)
```javascript
// grok-imagine-video-1.5 is image-to-video ONLY (HTTP 400 "Text-to-video is
// not supported for this model"). Text-to-video requires grok-imagine-video.
```

### 6.7 Veo Model Deprecation (gemini-video-generator.mjs, lines 32-33)
```javascript
// Veo 3.0 (veo-3.0-generate-001) is deprecated and returns 404.
```

---

## 7. Configuration Knobs

### 7.1 Environment Variables

| Variable | Default | File | Purpose |
|----------|---------|------|---------|
| `FB_VIDEO_BACKEND` | `xai` | facebook-poster.mjs:88 | Video backend: `xai` or `gemini` |
| `FB_VIDEO_OUTPUT_DIR` | `outputs/fb-videos` | facebook-poster.mjs:82 | Video output directory |
| `GEMINI_VIDEO_GENERATOR` | `scripts/gemini-video-generator.mjs` | facebook-poster.mjs:89-90 | Path to Veo generator script |
| `XAI_VIDEO_GENERATOR` | `scripts/xai-video-generator.mjs` | facebook-poster.mjs:91-92 | Path to Grok generator script |
| `XAI_API_KEY` / `GROK_API_KEY` | (none) | facebook-poster.mjs:109 | xAI API key for prompt + video gen |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | (none) | gemini-video-generator.mjs:31 | Google API key for Veo |
| `GEMINI_VEO_MODEL` | `veo-3.1-generate-preview` | gemini-video-generator.mjs:34 | Veo model override |
| `GROK_VIDEO_MODEL` | `grok-imagine-video` | xai-video-generator.mjs:36 | Grok video model override |
| `GROK_VIDEO_RESOLUTION` | `720p` | xai-video-generator.mjs:37 | Grok video resolution |
| `GBP_PHOTO_PATH` | `C:\Workspace\Shared\...\GBP Post Photos` | facebook-poster.mjs:94-95 | Fallback photo directory |
| `GBP_CURATED_FOLDER` | `E:\Media\Grizzly\Curated` | facebook-poster.mjs:187 | Curated photo folder for date-matched fallback |
| `GRIZZLY_LOGO_PATH` | `assets/grizzly-logo.png` | facebook-poster.mjs:97 | Logo for end card fallback |
| `GRIZZLY_ENDCARD_PATH` | `assets/grizzly-endcard.jpg` | facebook-poster.mjs:98 | End card still image |
| `GRIZZLY_BRAND_NAME` | `Grizzly Electrical Solutions` | facebook-poster.mjs:102 | Brand name for drawtext overlay |
| `GRIZZLY_BRAND_PHONE` | `(469) 863-9804` | facebook-poster.mjs:103 | Phone for drawtext overlay |
| `GRIZZLY_BRAND_LOCATION` | `Rowlett, TX` | facebook-poster.mjs:104 | Brand location (currently unused in code) |
| `GRIZZLY_ENDCARD_FONT` | Platform-specific | facebook-poster.mjs:105-108 | Font file for drawtext |
| `FB_PAGE_ID` | (none, required) | facebook-poster.mjs:74 | Facebook Page ID |
| `FB_PAGE_ACCESS_TOKEN` | (none, required) | facebook-poster.mjs:75 | FB Page Access Token |
| `FB_GRAPH_API_VERSION` | `v22.0` | facebook-poster.mjs:76 | Graph API version |
| `FB_USE_PLAYWRIGHT` | `0` | facebook-poster.mjs:77 | Use Playwright instead of Graph API |
| `MAV_BRIDGE_POLL_MS` | `30000` | mav-bridge.mjs:46 | Supabase poll interval |
| `MAV_BRIDGE_PORT` | `8790` | mav-bridge.mjs:47 | Bridge HTTP port |

### 7.2 Hardcoded Defaults (not env-configurable)

| Value | Location | Notes |
|-------|----------|-------|
| `VIDEO_GEN_TIMEOUT_MS = 13 min` | facebook-poster.mjs:113 | Must exceed backend poll ceilings |
| End card duration = 3s | facebook-poster.mjs:479 | Hardcoded `-t 3` |
| CRF 22, preset fast | facebook-poster.mjs:487 | FFmpeg encoding quality |
| AAC 128k audio | facebook-poster.mjs:488 | Audio bitrate |
| Grok prompt model = `grok-4.20-0309-non-reasoning` | facebook-poster.mjs:563, mav-bridge.mjs:188 | Hardcoded in both files |
| Grok prompt max_tokens = 320 / 300 | facebook-poster.mjs:563 / mav-bridge.mjs:188 | Inconsistent between files |
| Aspect ratio = 9:16 | Both generators | Default in CLI parser |
| Duration = 8s | Both generators | Default in CLI parser |
| xAI resolution = 720p | xai-video-generator.mjs:37 | Not 1080p |

---

## 8. Topic Selection and Flow to Video Generation

### 8.1 Topic Origin

The post topic for each day is determined by the **GBP REPORT** (`outputs/gbp_report.md`), which contains a "## RECOMMENDED POST TOPIC QUEUE" section ranked 1-7.

### 8.2 DAY_TOPIC_BINDING_RULE (crew.py, lines 858-868)

```python
DAY_TOPIC_BINDING_RULE = (
    "DAY→TOPIC BINDING (MANDATORY ...):\n"
    "Use the '## RECOMMENDED POST TOPIC QUEUE' in the GBP REPORT as the single source "
    "of truth for which topic goes on which day. Assign strictly in rank order:\n"
    "  Day 1 = RANK 1 topic, Day 2 = RANK 2, Day 3 = RANK 3, ... Day 7 = RANK 7.\n"
    "Do NOT reorder, swap, re-rank, or skip topics. ...\n"
)
```

This rule is injected into both the GBP crew and Facebook crew task descriptions, ensuring both platforms use the same topic on the same day.

### 8.3 Topic Flow

```
gbp_report.md → "RECOMMENDED POST TOPIC QUEUE" (RANK 1-7)
         │
         ▼
crew.py build_facebook_crew()
   DAY_TOPIC_BINDING_RULE → CrewAI LLM writes schedule
   Day 1 = RANK 1 topic, SERVICE field = topic name
         │
         ▼
facebook_posting_schedule.md
   DAY: 1, SERVICE: "Panel Upgrade / Replacement", VIDEO_PROMPT: "..."
         │
         ▼
mav-bridge.mjs generateDay1VideoPrompt()
   Reads SERVICE, HOOK, BODY, CTA, HASHTAGS from Day 1 block
   Passes to Grok for rewrite → only Day 1
         │
         ▼
facebook-poster.mjs generateCinematicPrompt(post)
   Reads post.service, post.hook, post.video_prompt
   Passes to Grok for cinematic rewrite → ALL video days
         │
         ▼
Video backend receives final prompt
```

### 8.4 Current Schedule Example (outputs/facebook_posting_schedule.md)

| Day | Date | Type | Service/Topic |
|-----|------|------|---------------|
| 1 | 2026-07-10 | video | Panel Upgrade / Replacement |
| 2 | 2026-07-11 | photo | Generator Inlet & Interlock Installation |
| 3 | 2026-07-12 | photo | EV Charger Installation |
| 4 | 2026-07-13 | video | Electrical Troubleshooting |
| 5 | 2026-07-14 | text | Federal Pacific / Zinsco Panel Replacement |
| 6 | 2026-07-15 | text | Recessed Lighting Installation |
| 7 | 2026-07-16 | video | Commercial Electrical Services |

---

## 9. Existing Video Files

Directory: `outputs/fb-videos/`

| File | Size | Date | Notes |
|------|------|------|-------|
| `fb-video-2026-07-03.mp4` | 3.3 MB | Jul 3 | Generated video (with end card) |
| `fb-video-2026-07-06.mp4` | 1.6 MB | Jul 3 | Generated video (with end card) |
| `fb-video-2026-07-09.mp4` | 2.5 MB | Jul 9 | Generated video (with end card) |
| `fb-video-2026-07-10.mp4` | 4.1 MB | Jul 10 | Day 1, current schedule |
| `fb-video-2026-07-13.mp4` | 2.7 MB | Jul 10 | Day 4, current schedule |
| `fb-video-2026-07-16.mp4` | 3.9 MB | Jul 10 | Day 7, current schedule |
| `fb-video-remodel-electrical-summer-home-renovation.mp4` | 2.7 MB | Jun 30 | With end card |
| `fb-video-remodel-electrical-summer-home-renovation-raw.mp4` | 3.5 MB | Jun 30 | Raw (pre-end-card) |
| `test-director.mp4` | 7.5 MB | Jul 9 | Test file |
| `test-director-branded.mp4` | 4.4 MB | Jul 9 | Test file (with end card) |
| `test-xai.mp4` | 3.6 MB | Jul 9 | xAI test file |

**Observations:**
- Current schedule (Jul 10-16) has all 3 videos generated successfully
- Video sizes range from 1.6 MB to 4.1 MB — consistent with 8s 720p vertical clips
- Raw video (`-raw.mp4`) is larger than branded version, as expected (end card adds compression)
- File naming: `fb-video-{date}.mp4` derived from `resolveVideoPath()` using post.date

---

## 10. Quality-Related Limitations

### 10.1 Resolution Capped at 720p
- xAI Grok Imagine default: `720p` (env: `GROK_VIDEO_RESOLUTION`)
- Veo 3.1: No explicit resolution parameter sent (model decides)
- No 1080p option is configured or tested
- Facebook Reels supports 1080×1920; 720p is sub-optimal for Reels quality

### 10.2 Duration Fixed at 8 Seconds
- Both backends default to 8 seconds
- `facebook-poster.mjs` never passes `--duration` or `--aspect-ratio` to the backend
- 8 seconds is very short for Reels; Facebook Reels can be up to 90 seconds
- The prompt engineering asks for "3-4 fast cuts" in 8 seconds, which is extremely fast-paced

### 10.3 Double Prompt Rewriting for Day 1
- Day 1 prompt is rewritten by Grok twice:
  1. `mav-bridge.mjs:generateDay1VideoPrompt()` (weaker system prompt, 300 tokens)
  2. `facebook-poster.mjs:generateCinematicPrompt()` (stronger system prompt, 320 tokens)
- The mav-bridge rewrite uses a **weaker, less specific** system prompt (establishing shot, build tension) compared to the facebook-poster rewrite (opens on drama, crash zooms, whip pans)
- Days 4 and 7 only get the stronger rewrite
- This creates inconsistent prompt quality between Day 1 and Days 4/7

### 10.4 Prompt System Message Truncation
- `facebook-poster.mjs:565`: The system prompt for `generateCinematicPrompt()` appears truncated in the source (`[truncated]` marker in read output). The full system prompt includes detailed no-text rules that may be cut off.
- If the system prompt is actually truncated at runtime, the model may not receive complete instructions.

### 10.5 No Negative Prompt Support
- xAI backend: No negative prompt parameter sent (the API supports it per tool docs, but the code doesn't use it)
- Veo backend: No negative prompt concept in the Gemini API
- The only "negative" guidance is via the system prompt text instructions ("no visible text", "no logos")

### 10.6 No Seed Control
- Neither backend receives a seed parameter
- No reproducibility for video generation
- Failed generations cannot be retried with the same visual parameters

### 10.7 No Quality Validation
- No post-generation quality check (resolution verification, duration check, audio check)
- No visual quality assessment (is the video actually good? does it match the prompt?)
- The only validation is file existence (`fs.existsSync(videoPath)`)

### 10.8 End Card Is a Static Image
- The end card is a 3-second static still image with drawtext overlay
- No motion, no animation, no transition fade
- Hard cut from the video to the still card
- This looks jarring in a Reels feed where motion is expected

### 10.9 Brand Location Unused
- `BRAND_LOCATION = 'Rowlett, TX'` is defined (line 104) but never used in any drawtext or overlay
- The end card only shows brand name + phone, not the service area

### 10.10 No Image-to-Video Path
- The current pipeline is purely text-to-video
- `grok-imagine-video-1.5` supports image-to-video (animate a still image)
- No mechanism exists to use a real Grizzly project photo as a video starting frame
- This could significantly improve brand relevance and visual quality

### 10.11 Prompt Sanitization Is Regex-Only
- `sanitizeVideoPrompt()` uses simple regex replacement
- It can miss variations: "Grizzly Electrical" without "Solutions", "Grizzly Electric", misspellings
- Phone numbers in non-standard formats (e.g., "469.863.9804") may slip through depending on regex coverage
- The regex does handle `XXX-XXX-XXXX` and `1-XXX-XXX-XXXX` patterns

### 10.12 No Retry on Video Generation Failure
- If video generation fails, it falls through to photo/text immediately
- No retry with a different prompt, different seed, or backend fallback
- A single API hiccup degrades the post to a photo for the entire week

### 10.13 Gemini Pre-flight Only for Gemini Backend
- The credit depletion check (lines 595-609) only runs when `VIDEO_BACKEND === 'gemini'`
- xAI has no equivalent pre-flight check; failures are caught per-video
- xAI rate limits or quota issues are not detected until a generation attempt fails

### 10.14 mav-bridge Day 1 Prompt Overwrites Schedule
- `mav-bridge.mjs:260`: The generated/approved Day 1 prompt is written back into `facebook_posting_schedule.md`, overwriting the CrewAI-written prompt
- This means the schedule file is mutated during pipeline execution
- If the pipeline is re-run, the original CrewAI prompt is lost
- Only Day 1 is overwritten; Days 4 and 7 keep their original CrewAI prompts

### 10.15 Graph API Video Upload Is Single-Request
- `graphPostVideo()` (line 370) uses single-request multipart upload
- Comment notes the resumable/chunked path is broken on current API versions
- Large videos (>1GB) would fail, though current 8s clips are well under that limit

---

## 11. Summary of Key Findings

| Area | Status | Key Issue |
|------|--------|-----------|
| **Prompt Engineering** | ⚠️ Functional but inconsistent | Day 1 double-rewritten with weaker first pass; system prompt may be truncated |
| **Video Backend** | ✅ Working (xAI default) | Veo 3.1 text hallucination caused switch to Grok; both functional |
| **Resolution** | ⚠️ 720p only | Sub-optimal for Reels; no 1080p configured |
| **Duration** | ⚠️ Fixed 8s | Very short; no flexibility; no parameter passed from poster |
| **End Card** | ⚠️ Static + jarring | Hard cut to still image; no fade/motion transition |
| **Fallback** | ✅ Robust | Video→photo→text chain works; curated photo matching by date+service |
| **Audio** | ✅ Preserved | Audio kept from raw video; silence padded on end card |
| **Brand Safety** | ✅ Defense in depth | System prompt + regex sanitization + FFmpeg drawtext overlay |
| **Quality Validation** | ❌ None | No post-generation checks for resolution, duration, or visual quality |
| **Reproducibility** | ❌ None | No seed control; no retry with same parameters |
| **Topic Flow** | ✅ Correct | GBP report → DAY_TOPIC_BINDING_RULE → CrewAI → schedule → video prompt |

---

*End of Audit Report*
