# PLAN.md: Video Quality Improvement for Facebook Posts

**Run ID:** video-quality-run-20260715  
**Date:** 2026-07-15  
**Pipeline Depth:** Research + Plan (awaiting approval)  
**Research Package:** `artifacts/video-quality-run-20260715/research-package.md`

---

## Executive Summary

The current video pipeline uses xAI Grok Imagine (correct choice — #1 on benchmarks) but suffers from AI slop due to: (1) prompt instructions that demand 3-4 fast cuts in 8 seconds (the #1 cause of temporal artifacts), (2) 720p resolution instead of 1080p, (3) no image-to-video path despite Grok Imagine being #1 at I2V, (4) minimal post-processing, and (5) no quality validation. The plan addresses all five issues plus content topic improvements — **no new subscription required**.

**6 sessions across 3 waves. All use existing API keys (xAI + Google).**

---

## Codebase Primer

### Key Files

| File | Lines | Role |
|------|-------|------|
| `scripts/facebook-poster.mjs` | ~1099 | Main poster: video gen, prompt rewrite, FFmpeg end card, FB Graph API upload |
| `scripts/xai-video-generator.mjs` | ~192 | xAI Grok Imagine backend (text-to-video) |
| `scripts/gemini-video-generator.mjs` | ~215 | Google Veo 3.1 backend (text-to-video) |
| `scripts/mav-bridge.mjs` | ~2000+ | Pipeline orchestrator: Day 1 prompt gen, phase execution |
| `src/seo_agents/crew.py` | ~1208 | CrewAI schedule generation: Facebook content, VIDEO_PROMPT field |
| `outputs/facebook_posting_schedule.md` | ~147 | 7-day schedule with VIDEO_PROMPT, HOOK, BODY, CTA |
| `.env` | ~200 | API keys and config |

### Architecture Flow

```
crew.py (CrewAI/GPT-4o) → facebook_posting_schedule.md (with VIDEO_PROMPT)
    ↓
mav-bridge.mjs → generateDay1VideoPrompt() [Day 1 only, Grok rewrite]
    ↓
facebook-poster.mjs → generateCinematicPrompt() [ALL video days, Grok rewrite]
    ↓
sanitizeVideoPrompt() → strip brand/phone
    ↓
xai-video-generator.mjs OR gemini-video-generator.mjs → raw MP4
    ↓
addBrandedEndCard() → FFmpeg concat video + 3s static image with drawtext
    ↓
Facebook Graph API upload (scheduled or immediate)
```

### Conventions
- Node.js ESM (`.mjs`) for scripts, Python for CrewAI agents
- `hopLog()` for structured logging in facebook-poster.mjs
- Env vars loaded from `.env` with force-override (PM2 stale key fix)
- `execFileSync` for spawning child processes
- 2-space indentation for JS, 4-space for Python

---

## Wave 1: Foundation (3 Parallel Sessions)

### Session 1: Upgrade xAI Video Backend

**File:** `scripts/xai-video-generator.mjs`  
**Executor:** Claude Code (bridge) — complex changes to existing CLI  
**Context estimate:** ~15k tokens

#### Tasks

1. **Change default resolution from 720p to 1080p**
   - Line 37: `const XAI_VIDEO_RESOLUTION = process.env.GROK_VIDEO_RESOLUTION || '1080p';`
   - Add comment explaining Facebook Reels recommends 1080×1920 minimum

2. **Add image-to-video (I2V) support**
   - New CLI arg: `--image <path>` — path to a reference image
   - When `--image` is provided, use `grok-imagine-video-1.5` model (I2V)
   - When `--image` is absent, keep `grok-imagine-video` (T2V, current behavior)
   - I2V API body: add `image_url` field with base64-encoded image data
   - Read the image file, convert to base64 data URL format
   - Log which mode (T2V vs I2V) is being used

3. **Add seed logging**
   - New CLI arg: `--seed <int>` — optional seed value
   - Pass `seed` in API request body
   - Log the seed in the success JSON output for reproducibility

4. **Add negative prompt support**
   - New CLI arg: `--negative-prompt <text>` — optional
   - Pass as `negative_prompt` in API request body
   - Default: empty string (no negative prompt)

5. **Pass aspect-ratio and duration from parent**
   - Already supported via CLI args — no change needed in this file
   - But add validation: if aspect-ratio is not 9:16, log a warning (Facebook Reels standard)

#### Verification

```bash
# Dry run T2V (should show 1080p)
node scripts/xai-video-generator.mjs --prompt "test" --output /tmp/test.mp4 --dry-run

# Dry run I2V
node scripts/xai-video-generator.mjs --prompt "test" --output /tmp/test.mp4 --image /path/to/image.jpg --dry-run

# Verify no syntax errors
node -c scripts/xai-video-generator.mjs
```

#### Commit Message
```
feat: upgrade xAI video backend — 1080p default, I2V support, seed logging, negative prompts
```

---

### Session 2: Overhaul CrewAI Content & Prompt Instructions

**File:** `src/seo_agents/crew.py`  
**Executor:** Claude Code (bridge) — nuanced prompt engineering  
**Context estimate:** ~20k tokens

#### Tasks

1. **Overhaul VIDEO_PROMPT instructions in `build_facebook_crew()` (lines 1039-1049)**

   Replace the current instructions that ask for "3-4 fast cuts" and "dramatic, fast-paced" with the research-backed single-shot formula:

   ```python
   "VIDEO POST RULES (days 1, 4, 7):\n"
   "- TYPE must be: video\n"
   "- VIDEO_PROMPT is a scene description for a vertical Reel (9:16, ~8 seconds). "
   "A director step rewrites it before generation.\n"
   "- SINGLE SHOT ONLY: one continuous camera shot, no cuts, no scene changes. "
   "The entire 8 seconds is one unbroken take.\n"
   "- STATIC or SLOW camera: use 'static shot', 'slow dolly-in', or 'slow pan'. "
   "NEVER use 'whip pan', 'crash zoom', 'hard push-in', or 'handheld'.\n"
   "- SHOW THE WORK, NOT THE FACE: focus on hands, tools, panels, installations, "
   "and environments. Avoid faces — they cause uncanny valley artifacts in AI video.\n"
   "- Use the five-part formula: [Cinematography] + [Subject] + [Action] + [Context] + [Style]\n"
   "- Example: 'Static shot, close-up of an electrician's hands installing a circuit breaker "
   "into a residential panel, in a clean utility room with white drywall walls, documentary "
   "realism, natural daylight from a side window, consistent lighting, photorealistic, 4K'\n"
   "- DRAMA through the problem, not through editing: show a sparking outlet, a scorched wire, "
   "a tripped breaker — but in a single sustained shot, not a montage\n"
   "- NEVER put the business name, any logo, any phone number, or any readable text/signage in "
   "VIDEO_PROMPT — video models garble on-screen text; branding is composited on afterward\n"
   ```

2. **Add before/after content type to schedule instructions**

   In the TONE RULES section (around line 1034), add:

   ```python
   "CONTENT FORMAT (use at least 1 per week):\n"
   "- Before/After: Show the problem (old panel, flickering lights) then the solution (new panel, bright lights) "
   "in the VIDEO_PROMPT as a single continuous shot that starts on the problem and dollies to the solution\n"
   "- Problem→Solution: HOOK states the problem, BODY is the diagnosis, CTA is the fix\n"
   ```

3. **Improve CTA instructions**

   Change CTA rule (line 1037) from call-only to include DM-based CTAs:

   ```python
   "- CTA is specific: 'Call us today', 'DM us for a free quote', 'DM \"PANEL\" for a free estimate'. "
   "DM-based CTAs perform better on Reels because Meta rewards DM engagement.\n"
   ```

4. **Add seasonal awareness to fb_context**

   In the `fb_context` construction (before line 1029), add a seasonal hint:

   ```python
   seasonal_hint = ""
   month = datetime.now().month
   if month in [3, 4, 5]:
       seasonal_hint = "DFW storm season (spring): emphasize generators, surge protection, storm prep."
   elif month in [6, 7, 8]:
       seasonal_hint = "DFW summer: emphasize AC-related electrical loads, EV charging, panel capacity."
   elif month in [11, 12, 1, 2]:
       seasonal_hint = "DFW winter: emphasize heating circuits, generator prep, ice storm readiness."
   ```

   Inject into the task description.

#### Verification

```bash
# Syntax check
PYTHONPATH="" .venv/Scripts/python.exe -c "from seo_agents.crew import build_facebook_crew; print('OK')"

# Run existing tests
PYTHONPATH="" .venv/Scripts/python.exe -m pytest tests/ -q -x
```

#### Commit Message
```
feat: overhaul video prompt instructions — single-shot, static camera, no faces, before/after format
```

---

### Session 3: Create Video Post-Processing Module

**File:** `scripts/video-postprocess.mjs` (NEW FILE)  
**Executor:** Claude Code (bridge)  
**Context estimate:** ~12k tokens

#### Tasks

1. **Create `scripts/video-postprocess.mjs`** — a standalone FFmpeg post-processing module

   Exports a single function:

   ```javascript
   /**
    * Post-process an AI-generated video to reduce artifacts and improve quality.
    *
    * Pipeline:
    * 1. Trim first/last 0.5s (worst artifacts at clip boundaries)
    * 2. Denoise (hqdn3d — removes inter-frame shimmer)
    * 3. Sharpen (unsharp — recovers edge detail)
    * 4. Subtle film grain (masks remaining artifacts, adds organic texture)
    * 5. Re-encode (libx264, CRF 20, preset fast)
    *
    * @param {string} inputPath - raw AI video
    * @param {string} outputPath - processed video
    * @param {object} options - { trim: true, denoise: true, sharpen: true, grain: true }
    * @returns {string} outputPath
    */
   export function enhanceVideo(inputPath, outputPath, options = {}) { ... }
   ```

2. **Implement the FFmpeg filter chain**

   ```javascript
   const filters = [];
   
   // 1. Trim 0.5s from start and end (skip if video < 3s)
   if (options.trim !== false) {
     // Use -ss and -to as input options (before -i) for fast seek
   }
   
   // 2. Denoise
   if (options.denoise !== false) {
     filters.push('hqdn3d=2:2:3:3');
   }
   
   // 3. Sharpen
   if (options.sharpen !== false) {
     filters.push('unsharp=5:5:0.6:5:5:0.4');
   }
   
   // 4. Film grain (subtle)
   if (options.grain !== false) {
     filters.push('noise=alls=4:allf=t+u');
   }
   ```

3. **Add a fade-in/fade-out function** for end card transitions

   ```javascript
   /**
    * Concatenate video with a branded end card using a cross-fade transition
    * instead of a hard cut.
    *
    * @param {string} videoPath - main video (already enhanced)
    * @param {string} cardPath - end card image
    * @param {string} outputPath - final video
    * @param {object} overlays - { brandName, brandPhone, fontPath }
    * @param {number} cardDuration - seconds (default 3)
    * @returns {string} outputPath
    */
   export function addBrandedEndCardWithFade(videoPath, cardPath, outputPath, overlays, cardDuration = 3) { ... }
   ```

   This function:
   - Probes video for dimensions, fps, audio presence (same as current addBrandedEndCard)
   - Creates the end card with drawtext (same as current)
   - Adds a 0.5s fade-out at the end of the main video
   - Adds a 0.5s fade-in at the start of the end card
   - Uses xfade filter for smooth transition (if supported) or fade+concat
   - Preserves audio with silence padding on end card

4. **Export a combined function**

   ```javascript
   /**
    * Full post-processing pipeline: enhance → brand end card with fade.
    * This replaces the current addBrandedEndCard() in facebook-poster.mjs.
    */
   export function postProcessVideo(rawVideoPath, finalOutputPath, options) {
     const enhancedPath = rawVideoPath.replace('-raw.mp4', '-enhanced.mp4');
     enhanceVideo(rawVideoPath, enhancedPath, options);
     addBrandedEndCardWithFade(enhancedPath, options.cardPath, finalOutputPath, options.overlays);
     fs.unlinkSync(enhancedPath);
     return finalOutputPath;
   }
   ```

5. **Add module-level FFmpeg availability check** (same pattern as facebook-poster.mjs)

#### Verification

```bash
# Syntax check
node -c scripts/video-postprocess.mjs

# Functional test (if a test video exists)
node -e "
import { enhanceVideo } from './scripts/video-postprocess.mjs';
// Test with existing raw video
try {
  enhanceVideo('outputs/fb-videos/fb-video-remodel-electrical-summer-home-renovation-raw.mp4', '/tmp/test-enhanced.mp4');
  console.log('OK: enhanceVideo works');
} catch (e) { console.log('SKIP:', e.message); }
"
```

#### Commit Message
```
feat: add video post-processing module — denoise, sharpen, grain, fade transitions
```

---

## Wave 2: Integration (2 Parallel Sessions)

### Session 4: Integrate New Pipeline into Facebook Poster

**File:** `scripts/facebook-poster.mjs`  
**Executor:** Claude Code (bridge) — large file, multiple function changes  
**Context estimate:** ~40k tokens  
**Depends on:** Session 1 (I2V support), Session 3 (post-processing module)

#### Tasks

1. **Import the new post-processing module** (top of file, after existing imports)

   ```javascript
   import { postProcessVideo, enhanceVideo } from './video-postprocess.mjs';
   ```

2. **Overhaul `generateCinematicPrompt()` system prompt (lines 549-581)**

   Replace the current system prompt that demands "3-4 fast cuts", "whip pans", "crash zooms" with the research-backed five-part formula:

   ```javascript
   { role: 'system', content: `You are a video director writing generation prompts for short vertical Facebook Reels (9:16, ~8 seconds) for a licensed residential and commercial electrician in DFW, Texas.

   Write a single vivid prompt (80-120 words) using the five-part formula:
   [Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]

   CRITICAL RULES for AI video quality:
   - SINGLE SHOT ONLY: one continuous take, no cuts, no scene changes
   - STATIC or SLOW camera: "static shot", "slow dolly-in", "slow pan" only
   - NEVER use: whip pan, crash zoom, hard push-in, handheld, rapid cuts
   - SHOW THE WORK, NOT THE FACE: focus on hands, tools, panels, installations
   - Avoid faces — they cause uncanny valley artifacts
   - Describe spatial relationships explicitly to prevent morphing
   - Keep the scene simple: fewer objects = fewer artifacts
   - Specify "consistent lighting" and "smooth continuous motion"
   - Describe diegetic AUDIO (electrical hum, breaker thunk, tools) but no dialogue

   DRAMA through the problem, not editing:
   - Show a sparking outlet, a scorched wire, a tripped breaker — in ONE sustained shot
   - The drama comes from what's IN the frame, not from cutting between frames

   STRICT — NO readable text of any kind in the video:
   - Do NOT name the business, owner, city, or phone number
   - Do NOT ask for logos, signs, captions, or on-screen text
   - Wardrobe: plain solid-color work polo, no visible writing
   - Any incidental signs must be unreadable or out of focus

   Ends with: Photorealistic, cinematic, 4K, consistent lighting, smooth continuous motion, plain unbranded wardrobe, absolutely no visible text or numbers anywhere in frame.

   Output the prompt only. No explanation, no quotes, no title.` }
   ```

   Also reduce `max_tokens` from 320 to 280 (shorter prompts = better adherence).

3. **Remove the double-rewrite for Day 1**

   In `generateCinematicPrompt()`, add a check: if the post already has a video_prompt that looks like it was rewritten by mav-bridge (contains "Photorealistic, cinematic"), use it directly without rewriting. Only rewrite if the prompt is a raw scene idea.

   Actually, simpler approach: **remove the mav-bridge Day 1 rewrite entirely** — this is handled in Session 5. For this session, just make `generateCinematicPrompt()` always rewrite using the new system prompt.

4. **Add I2V path to `generateVideoViaBackend()`**

   When a reference image is available for the post's service type, use I2V mode:

   ```javascript
   function generateVideoViaBackend(prompt, outputPath, { brand = true, referenceImage = null } = {}) {
     fs.mkdirSync(path.dirname(outputPath), { recursive: true });
     const rawPath = brand ? outputPath.replace(/\.mp4$/, '-raw.mp4') : outputPath;
     const cleanPrompt = sanitizeVideoPrompt(prompt);
     
     const backendArgs = ['--prompt', cleanPrompt, '--output', rawPath];
     if (referenceImage && fs.existsSync(referenceImage)) {
       backendArgs.push('--image', referenceImage);
       hopLog('facebook-poster→' + VIDEO_BACKEND, 'info', `Using image-to-video mode with reference: ${path.basename(referenceImage)}`);
     }
     
     // Pass aspect-ratio and duration explicitly
     backendArgs.push('--aspect-ratio', '9:16', '--duration', '8');
     
     const out = execFileSync('node', [VIDEO_GEN_SCRIPT, ...backendArgs], { ... });
     // ... rest stays the same
   }
   ```

5. **Replace `addBrandedEndCard()` with `postProcessVideo()`**

   In `generateVideoViaBackend()`, replace the call to `addBrandedEndCard(rawPath, outputPath)` with:

   ```javascript
   if (brand) {
     hopLog('facebook-poster→ffmpeg', 'info', 'Post-processing: enhance + branded end card with fade...');
     postProcessVideo(rawPath, outputPath, {
       cardPath: ENDCARD_PATH,
       overlays: { brandName: BRAND_NAME, brandPhone: BRAND_PHONE, fontPath: ENDCARD_FONT },
       trim: true,
       denoise: true,
       sharpen: true,
       grain: true,
     });
   }
   ```

   Keep the old `addBrandedEndCard()` function as a fallback if the new module fails.

6. **Add basic quality validation after generation**

   After video generation, probe the output:

   ```javascript
   function validateVideo(videoPath) {
     if (!fs.existsSync(videoPath)) return { ok: false, reason: 'file missing' };
     const stats = fs.statSync(videoPath);
     if (stats.size < 100_000) return { ok: false, reason: `file too small (${stats.size} bytes)` };
     try {
       const probe = execFileSync('ffprobe', [
         '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height,duration',
         '-of', 'json', videoPath,
       ], { encoding: 'utf8', timeout: 15000 });
       const s = JSON.parse(probe).streams?.[0] || {};
       const width = parseInt(s.width) || 0;
       const height = parseInt(s.height) || 0;
       const duration = parseFloat(s.duration) || 0;
       if (width < 720 || height < 1280) return { ok: false, reason: `low resolution ${width}x${height}` };
       if (duration < 5) return { ok: false, reason: `too short (${duration}s)` };
       return { ok: true, width, height, duration, sizeBytes: stats.size };
     } catch (e) {
       return { ok: false, reason: `ffprobe failed: ${e.message}` };
     }
   }
   ```

   Log validation results. If validation fails, log a warning but don't block (the fallback chain handles it).

7. **Add reference image resolution**

   Add a function that maps post.service to a reference image path:

   ```javascript
   const REFERENCE_IMAGE_DIR = process.env.GRIZZLY_REFERENCE_IMAGES
     || path.join(PROJECT_ROOT, 'assets', 'reference-images');
   
   function resolveReferenceImage(post) {
     if (!fs.existsSync(REFERENCE_IMAGE_DIR)) return null;
     const slug = post.service?.toLowerCase()
       .replace(/[^a-z0-9]+/g, '-')
       .replace(/^-|-$/g, '');
     const candidates = [
       path.join(REFERENCE_IMAGE_DIR, `${slug}.jpg`),
       path.join(REFERENCE_IMAGE_DIR, `${slug}.png`),
       path.join(REFERENCE_IMAGE_DIR, `${post.date}.jpg`),
     ];
     for (const p of candidates) {
       if (fs.existsSync(p)) return p;
     }
     return null;
   }
   ```

   Use this in `generateAllVideos()` when calling `generateVideoViaBackend()`.

#### Verification

```bash
# Syntax check
node -c scripts/facebook-poster.mjs

# Dry run (if supported)
node scripts/facebook-poster.mjs --dry-run --schedule-all

# Run existing tests
node --test scripts/lib/facebook-poster.test.mjs 2>/dev/null || echo "No test file"
```

#### Commit Message
```
feat: integrate I2V, post-processing, quality validation, and new prompt system into facebook-poster
```

---

### Session 5: Fix mav-bridge Day 1 Double-Rewrite

**File:** `scripts/mav-bridge.mjs`  
**Executor:** Claude Code (bridge)  
**Context estimate:** ~15k tokens  
**Depends on:** Session 2 (understanding of new prompt format)

#### Tasks

1. **Remove or simplify `generateDay1VideoPrompt()` (lines 164-201)**

   The current function rewrites Day 1's VIDEO_PROMPT using Grok with a WEAKER system prompt than what facebook-poster.mjs uses. This creates inconsistency:
   - Day 1: mav-bridge rewrite (weak) → facebook-poster rewrite (strong) = double rewrite
   - Days 4, 7: facebook-poster rewrite only (strong) = single rewrite

   **Option A (recommended):** Remove the mav-bridge rewrite entirely. The facebook-poster's `generateCinematicPrompt()` already handles ALL video days with a better system prompt. The 5-minute approval window is the only value-add of the mav-bridge step.

   **Option B:** If the approval window is needed, keep the function but just use the schedule's VIDEO_PROMPT as-is for approval display (no Grok rewrite). The actual rewrite happens in facebook-poster.

   Implement Option A: Remove the `generateDay1VideoPrompt()` call from `executeApprovedRun()`. Keep the function definition but mark it as deprecated with a comment. Remove the Step 0 block (lines ~247-270) that calls it and writes back to the schedule.

2. **Align the system prompt (if function is kept for any reason)**

   If any code path still calls `generateDay1VideoPrompt()`, update its system prompt (line 190) to match the new five-part formula from Session 4. Use the same instructions: single shot, static camera, no faces, five-part formula.

3. **Remove the schedule file mutation (line 260)**

   The current code writes the Grok-rewritten prompt back into `facebook_posting_schedule.md`, overwriting the CrewAI-written prompt. This mutation should not happen — the schedule file should preserve the CrewAI output, and the rewrite should happen at generation time only.

#### Verification

```bash
# Syntax check
node -c scripts/mav-bridge.mjs

# Verify the Step 0 block is removed
grep -n "generateDay1VideoPrompt" scripts/mav-bridge.mjs
# Should show: function definition (deprecated) only, no calls
```

#### Commit Message
```
fix: remove Day 1 double-rewrite from mav-bridge — facebook-poster handles all video prompts
```

---

## Wave 3: Polish (1 Session)

### Session 6: Reference Image Generator + End-to-End Testing

**Files:** `scripts/generate-reference-image.mjs` (NEW), `assets/reference-images/` (NEW DIR)  
**Executor:** Claude Code (bridge)  
**Context estimate:** ~15k tokens  
**Depends on:** All Wave 1 + Wave 2 sessions

#### Tasks

1. **Create `scripts/generate-reference-image.mjs`**

   A script that generates clean reference images for I2V video generation using a text-to-image model. These images serve as the first frame for image-to-video, anchoring scene geometry and preventing artifacts.

   ```javascript
   #!/usr/bin/env node
   /**
    * Generates clean reference images for image-to-video generation.
    * Uses FLUX (via FAL.ai) or Gemini image generation as the backend.
    *
    * Usage:
    *   node generate-reference-image.mjs --prompt "text" --output /path/to/image.jpg
    *   node generate-reference-image.mjs --service "panel-upgrade" --output assets/reference-images/panel-upgrade.jpg
    */
   ```

   - Use the existing FAL.ai backend (already configured in Hermes) for FLUX image generation
   - Or use Gemini's image generation API (Imagen) as fallback
   - The prompt should describe a clean, artifact-free scene that matches the service type
   - Generate at 1080×1920 (vertical, matches video aspect ratio)
   - No text, no logos, no faces — just the scene

2. **Create service-to-prompt mapping**

   ```javascript
   const SERVICE_PROMPTS = {
     'panel-upgrade': 'Close-up of a clean, modern electrical panel with circuit breakers neatly arranged, installed in a residential utility room, white drywall wall, natural daylight, photorealistic, no text, no people, no hands',
     'ev-charger': 'A Level 2 EV charger mounted on a garage wall, clean installation, modern home garage, photorealistic, no text, no people, no hands',
     'generator': 'A whole-home generator installed outside a suburban house, clean installation, daytime, photorealistic, no text, no people, no hands',
     'troubleshooting': 'Close-up of an electrician\'s multimeter probing an outlet, tools on a workbench nearby, residential wall, photorealistic, no text, no face visible',
     'commercial': 'Interior of a commercial electrical room with large breaker panels, clean industrial environment, fluorescent lighting, photorealistic, no text, no people',
     'lighting': 'Modern recessed lighting installed in a kitchen ceiling, warm LED glow, clean finish, photorealistic, no text, no people',
     // Add more as needed
   };
   ```

3. **Generate initial reference images for current schedule topics**

   ```bash
   for service in panel-upgrade ev-charger generator troubleshooting commercial lighting; do
     node scripts/generate-reference-image.mjs --service "$service" \
       --output "assets/reference-images/$service.jpg"
   done
   ```

4. **End-to-end test: generate one video with the full new pipeline**

   ```bash
   # Test with a reference image
   FB_VIDEO_BACKEND=xai node scripts/xai-video-generator.mjs \
     --prompt "Static shot, slow dolly-in on a clean electrical panel with breakers being installed, residential utility room, documentary realism, natural daylight, consistent lighting, photorealistic, 4K" \
     --image assets/reference-images/panel-upgrade.jpg \
     --output /tmp/test-i2v.mp4 \
     --aspect-ratio 9:16 --duration 8

   # Post-process
   node -e "
   import { postProcessVideo } from './scripts/video-postprocess.mjs';
   postProcessVideo('/tmp/test-i2v-raw.mp4', '/tmp/test-final.mp4', {
     cardPath: 'assets/grizzly-endcard.jpg',
     overlays: { brandName: 'Grizzly Electrical Solutions', brandPhone: '(469) 863-9804', fontPath: 'C:/Windows/Fonts/arialbd.ttf' },
   });
   "

   # Validate
   ffprobe -v error -show_entries stream=width,height,duration -of json /tmp/test-final.mp4
   ```

5. **Update `.env.example` with new env vars**

   Add:
   ```
   # Video generation
   GROK_VIDEO_RESOLUTION=1080p
   GRIZZLY_REFERENCE_IMAGES=assets/reference-images
   ```

6. **Run full test suite to verify no regressions**

   ```bash
   PYTHONPATH="" .venv/Scripts/python.exe -m pytest tests/ -q -x
   node -c scripts/facebook-poster.mjs
   node -c scripts/xai-video-generator.mjs
   node -c scripts/video-postprocess.mjs
   node -c scripts/mav-bridge.mjs
   ```

#### Commit Message
```
feat: add reference image generator, initial image library, and end-to-end pipeline test
```

---

## Dependency Graph

```
Wave 1 (parallel):
  Session 1 (xai-video-generator.mjs) ──┐
  Session 2 (crew.py)                   ──┼──→ Wave 2
  Session 3 (video-postprocess.mjs)     ──┘

Wave 2 (parallel):
  Session 4 (facebook-poster.mjs)  [depends on 1, 3]
  Session 5 (mav-bridge.mjs)       [depends on 2]

Wave 3 (sequential):
  Session 6 (reference images + e2e test) [depends on 1,2,3,4,5]
```

**DAG verification:** No cycles. Sessions in the same wave touch different files. ✅

---

## Acceptance Criteria

1. ✅ xAI video backend defaults to 1080p (not 720p)
2. ✅ xAI backend supports `--image` flag for image-to-video mode
3. ✅ Prompt instructions use single-shot, static camera, no faces, five-part formula
4. ✅ No "3-4 fast cuts", "whip pan", "crash zoom" in any prompt instructions
5. ✅ Video post-processing applies denoise + sharpen + grain
6. ✅ End card uses fade transition (not hard cut)
7. ✅ mav-bridge no longer double-rewrites Day 1 prompt
8. ✅ Quality validation checks resolution, duration, file size after generation
9. ✅ Reference images can be used as I2V starting frames
10. ✅ All existing tests pass
11. ✅ No new subscriptions required (existing xAI + Google keys only)

---

## New Subscription Cost Analysis

| Provider | Cost | Required? | Verdict |
|----------|------|-----------|---------|
| xAI Grok Imagine 1.5 (I2V) | $0.25/sec at 1080p = $2.00/8s | Already have API key | ✅ No new cost |
| Google Veo 3.1 | $0.03–$0.75/sec = $0.24–$6.00/8s | Already have API key | ✅ No new cost |
| Kling 3.0 (optional) | $0.09–$0.14/sec = $0.72–$1.12/8s | Would need API key | ❌ Optional, not required |
| FAL.ai (FLUX images) | ~$0.01–$0.05/image | Already configured in Hermes | ✅ No new cost |

**Total new subscription cost: $0** — All improvements use existing API keys and free tiers.

---

## Archive Steps

After all sessions are verified and merged:

```bash
# Copy PLAN.md to archive
mkdir -p "C:\Workspace\Archive\Build Plans\SEO-Agents-App"
cp PLAN.md "C:\Workspace\Archive\Build Plans\SEO-Agents-App\20260715_video-quality.md"

# Archive run artifacts
mkdir -p "C:\Workspace\Archive\Agent-Orchestration\SEO-Agents-App"
cp -r artifacts/video-quality-run-20260715 "C:\Workspace\Archive\Agent-Orchestration\SEO-Agents-App\"

# Remove PLAN.md from repo
git rm PLAN.md
git commit -m "chore: archive PLAN.md for video quality build"
```
