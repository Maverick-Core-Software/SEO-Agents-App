# Run Manifest: Video Quality Improvement for Facebook Posts

**Run ID:** video-quality-run-20260715  
**Date:** 2026-07-15  
**Pipeline Depth:** Research + Plan (stop after PLAN.md, wait for approval)  
**Status:** Research Phase — In Progress

## Core Goal
Create better quality videos for scheduled Facebook posts — reel-optimized, topic-matched, realistic (no AI slop: walking through walls, missing fingers, bad edits). Also research the best video generation models/qualities available, including pricing for any new subscriptions required.

## MVP Scope
1. Better video generation quality (no AI artifacts)
2. Video content follows the post topic accurately
3. Reel/Facebook-optimized format (9:16 vertical, correct duration, audio)
4. Best-in-class video generation model research with pricing verification
5. Post topic/content improvements (changing the actual post topic)

## Out of Scope
- Complete rewrite of the SEO pipeline
- Changing the Facebook posting schedule cadence
- GBP (Google Business Profile) video generation

## Constraints
- Node.js (.mjs) for video generation scripts
- Python (CrewAI) for content/schedule generation
- Existing API keys: xAI (Grok), Google (Gemini/Veo), OpenAI, DeepSeek, Anthropic
- Banned: OpenRouter, LiteLLM
- Direct API keys only for any new providers
- FFmpeg available for post-processing
- Must integrate with existing facebook-poster.mjs → video-generator.mjs architecture

## Current Architecture
- **Video backends:** xAI Grok Imagine (default) → `xai-video-generator.mjs`
- **Video backends:** Google Veo 3.1 (alternative) → `gemini-video-generator.mjs`
- **Prompt generation:** Grok 4.20 writes cinematic prompts, sanitizes brand tokens
- **Post-processing:** FFmpeg adds branded end card with phone overlay
- **Schedule generation:** CrewAI `crew.py` generates 7-day schedule with VIDEO_PROMPT fields
- **Pipeline flow:** mav-bridge.mjs → facebook-poster.mjs → video-generator.mjs → FFmpeg

## Assumptions
- User wants to evaluate ALL major video generation APIs (not just xAI + Google)
- User is willing to add new subscriptions if quality justifies cost
- "Changing the post topic" means improving content quality/relevance, not the scheduling system
- Vertical 9:16 format is correct for Facebook Reels

## Research Workers
1. **Worker 1: Video Generation API Landscape** — All major text-to-video APIs, quality comparisons, pricing, features
2. **Worker 2: Current Pipeline Audit** — Codebase analysis of video generation flow, prompt engineering, post-processing
3. **Worker 3: AI Video Quality Best Practices** — Prompt engineering for realistic video, avoiding AI artifacts, reel optimization
4. **Worker 4: Facebook Reel Requirements & Content Strategy** — FB Reel specs, algorithm preferences, topic matching strategies
