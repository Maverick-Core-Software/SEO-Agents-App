# Validated Research Package: Video Quality Improvement

**Run ID:** video-quality-run-20260715  
**Date:** 2026-07-15  
**Pipeline Depth:** Research + Plan (stop after PLAN.md)  
**Status:** ✅ Research Complete — Planning Phase

---

## Research Workers Dispatched and Completed

| Worker | Scope | Status | Report Path |
|--------|-------|--------|-------------|
| 1 | Video Generation API Landscape | ✅ Complete | `worker1-video-api-landscape.md` |
| 2 | Current Pipeline Audit | ✅ Complete | `worker2-pipeline-audit.md` |
| 3 | AI Video Quality Best Practices | ✅ Complete | `worker3-quality-best-practices.md` |
| 4 | Facebook Reel Requirements & Content Strategy | ✅ Complete | `worker4-facebook-reel-strategy.md` |

---

## Cross-Validated Key Findings

### 1. Current Backend is Already the Best — But Not Optimally Configured

**Finding (Worker 1 + Worker 2):** xAI Grok Imagine Video 1.5 ranks #1 on both text-to-video (Elo 1,245) and image-to-video (Elo 1,336) leaderboards. The current default backend choice is correct. However:

- **Wrong model:** Code uses `grok-imagine-video` (v1, text-to-video), NOT `grok-imagine-video-1.5` (which is image-to-video only). The v1 model is lower quality.
- **Wrong resolution:** Default is `720p`. Facebook Reels recommends `1080×1920` minimum. Simple env var change: `GROK_VIDEO_RESOLUTION=1080p`.
- **No image-to-video path:** Grok Imagine 1.5 is #1 at I2V — the pipeline is pure text-to-video, missing the highest-impact quality improvement available.

### 2. Prompt Engineering is the Primary Cause of "AI Slop"

**Finding (Worker 2 + Worker 3):** The current prompt system actively causes artifacts:

- **"3-4 fast cuts in 8 seconds"** — Worker 3 confirms: "One shot per clip is ideal. Multi-shot prompts cause transition artifacts, temporal drift, and jump cuts." The current instruction to pack 3-4 cuts into 8 seconds is the #1 driver of AI slop.
- **Dynamic camera instructions** ("whip pans, crash zooms, hard push-ins") — Worker 3 confirms: "Static shot or slow dolly-in for maximum consistency. Avoid complex multi-axis movements."
- **Faces and human stakes** — Worker 3: "Avoid faces — show hands, tools, panels, and environments instead." Current prompts ask for "worried faces" and "family reactions."
- **Double rewriting for Day 1** — mav-bridge rewrites Day 1 with a weaker system prompt, then facebook-poster rewrites again with a stronger one. Days 4/7 only get the stronger rewrite. Inconsistent.

### 3. Image-to-Video is the Highest-Impact Quality Fix

**Finding (Worker 1 + Worker 3, strongly correlated):**

- Worker 3: "Image-to-video is the single most effective technique for reducing AI video artifacts. A reference image anchors character identity, object positions, scene geometry, and lighting. Expected artifact reduction: 60-80%."
- Worker 1: "Grok Imagine Video 1.5 ranks #1 on image-to-video leaderboard (Elo 1,336)."
- Worker 2: "No mechanism exists to use a real Grizzly project photo as a video starting frame."
- **Recommendation:** Generate or curate a clean reference image first, then use image-to-video to animate it. This is more impactful than switching models.

### 4. Post-Processing Pipeline is Minimal

**Finding (Worker 2 + Worker 3):**

- Current: Only FFmpeg end card (3s static image with drawtext). No denoise, no sharpen, no color grade, no trim.
- Worker 3 recommends: Trim 0.5s from start/end → denoise (hqdn3d) → sharpen (unsharp) → color grade → film grain → encode.
- End card is a hard cut to a static still — jarring in Reels feed. Should add fade transition.
- No quality validation: only `fs.existsSync(videoPath)` checks that the file exists.

### 5. Facebook Reel Technical Gaps

**Finding (Worker 2 + Worker 4):**

- **Resolution:** 720p vs recommended 1080×1920. Easy fix.
- **Duration:** 8s is in the sweet spot (7-15s optimal for completion rate). Keep.
- **Audio:** Preserved from raw video — good. But no sound design strategy (Meta says audio+visual = 2x brand interest).
- **Text overlays:** Only on end card. Meta recommends brand+message in first 5 seconds = 1.7x top-20% likelihood.
- **Safe zone:** End card text at 72%/80% height — within safe zone but close to bottom edge.

### 6. Content Topic Improvements

**Finding (Worker 4 + Worker 2):**

- Topics are bound by `DAY_TOPIC_BINDING_RULE` (GBP report rank → day number). This is structurally sound.
- **Missing content types:** Before/after transformations (#1 performing format for trades) not in current schedule. Problem→Solution format underutilized.
- **Seasonal opportunities:** DFW storm season, summer ERCOT grid stress — not explicitly factored into topic selection.
- **CTA improvement:** Current CTAs are phone-call focused. DM-based CTAs ("DM 'PANEL' for a free quote") outperform on Reels.
- **DFW competitive gap:** Most DFW electricians are NOT using Reels — first-mover advantage.

### 7. Pricing — No New Subscription Required

**Finding (Worker 1):**

| Model | Cost per 8s Reel | Current Status |
|-------|-----------------|----------------|
| xAI Grok Imagine | $0.64–$2.00 | ✅ API key active |
| Google Veo 3.1 (Lite) | $0.24–$0.80 | ✅ API key active |
| Google Veo 3.1 (Standard) | $6.00 | ✅ API key active |
| Kling 3.0 (optional add) | $0.72–$1.12 | ❌ Would need API key |

**Verdict:** No new subscription required for quality improvement. The existing xAI + Google setup is sufficient. Kling 3.0 is optional as a third backend ($0.72–$1.12/video) but not necessary. The quality issues are in prompt engineering and pipeline configuration, not model selection.

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| I2V workflow adds latency (image gen + video gen) | High | Medium | Generate images in parallel; cache reference images |
| Prompt changes reduce "excitement" of videos | Medium | Medium | A/B test old vs new prompt style; keep "drama" but reduce cuts |
| Veo 3.1 text hallucination returns if used as primary | Low | High | Keep xAI as default; use Veo for I2V only |
| End card redesign breaks FFmpeg pipeline | Low | Low | Test in isolation before deploying |
| Content topic changes conflict with GBP topic binding | Medium | Low | Modify crew.py instructions, not the binding rule itself |

---

## Research Package Accepted

All 4 workers completed. Reports contain evidence URLs, specific code references, and actionable recommendations. No contradictions found between workers — findings are complementary and cross-validating.

**Proceeding to Phase 2: Planning.**
