# PLANSCOPE.MD — Official Google Business Profile API Master Plan

## 📌 Executive Summary & Objective

This document outlines the complete scope for upgrading `SEO-Agents-App` from legacy Playwright browser automation to official **Google Business Profile REST APIs**. 

By leveraging project **`Hermes Agent`** (`exalted-slice-502415-s0` / `1084301840332`) and the multi-account token manager (`gmail-multi`), `SEO-Agents-App` will achieve 100% API reliability, real-time performance analytics feedback, automated reputation management, instant Q&A responses, and automated job-site photo gallery synchronization.

---

## 🟡 STILL GATED — status as of 2026-08-09 (correcting the 8/06 entry)

**The 8/06 claim that the project was "already on the allowlist" was a misreading of Google support's reply.** Support said there was *already a project* (associated with the account/case) — a project existing is not API approval. `node scripts/gbp-access-probe.mjs` on 2026-08-09 shows the project is still not approved:

| surface | result | meaning |
|---|---|---|
| accountmanagement / businessinformation / performance / qanda / verifications v1 | 429 `quota_limit=0` | enabled in console, unapproved |
| `mybusiness.googleapis.com/v4` (incl. `$discovery`) | **404** | gated — not allowlisted |

### Actual status
* `GBP_POSTER` still defaults to **`playwright`** (`scripts/gbp-worker.mjs:47`) and must stay there until a live v4 call returns 200. The 8/06 "default switched to api / Playwright decommissioned" bullets were aspirational — neither is true in code, and `scripts/gbp-poster/driver.mjs` remains the active engine.
* Progress since 7/27: performance / qanda / verifications moved from `403 SERVICE_DISABLED` to `429 quota=0`, i.e. all five APIs are now **enabled in the console**. Enabling is self-serve; it is not approval. Local Posts exist only on legacy v4, which still 404s.
* Basic-access application: case **`2-5921000040991`** (filed 2026-07-27). If the "already a project" reply was support's *answer* to that case rather than a side remark, the case may be effectively closed without a grant — worth a follow-up asking explicitly for **basic access approval for project #1084301840332**, since quota remains 0.
* Re-check with `node scripts/gbp-access-probe.mjs`; flip `GBP_POSTER=api` only after it verdicts approved.

---

## 🎯 Architecture & New Modules Overview

```
                                  ┌────────────────────────────────────────────────────────┐
                                  │      GCP Project: Hermes Agent (exalted-slice-502415-s0)│
                                  │      Tokens: C:\Users\carte\gmail-multi\tokens         │
                                  └───────────────────────────┬────────────────────────────┘
                                                              │
                    ┌─────────────────────────────────────────┴─────────────────────────────────────────┐
                    │                                                                                   │
                    ▼                                                                                   ▼
┌───────────────────────────────────────┐                                           ┌───────────────────────────────────────┐
│     MODULE 1: API POSTING ENGINE      │                                           │     MODULE 2: PERFORMANCE ANALYTICS   │
│  (scripts/gbp-api-poster.mjs)         │                                           │  (scripts/gbp-analytics-collector.mjs)│
│  • Direct REST API posting            │                                           │  • Impressions (Search & Maps)        │
│  • Zero Playwright browser dependency │                                           │  • Calls, Directions & Web Clicks     │
│  • Inline photo attachment            │                                           │  • Feedback loop to run-weekly-seo.py │
└───────────────────────────────────────┘                                           └───────────────────────────────────────┘
                    │                                                                                   │
                    ▼                                                                                   ▼
┌───────────────────────────────────────┐                                           ┌───────────────────────────────────────┐
│     MODULE 3: REVIEWS AGENT           │                                           │     MODULE 4: Q&A AUTO-RESPONDER    │
│  (scripts/gbp-review-agent.mjs)       │                                           │  (scripts/gbp-qanda-agent.mjs)        │
│  • Auto-reply to 4/5★ reviews         │                                           │  • Real-time customer question polling│
│  • SMS/Slack alert for 1-3★ reviews   │                                           │  • AI knowledge-base answer generation│
└───────────────────────────────────────┘                                           └───────────────────────────────────────┘
                    │                                                                                   │
                    ▼                                                                                   ▼
┌───────────────────────────────────────┐                                           ┌───────────────────────────────────────┐
│     MODULE 5: MEDIA & PHOTO SYNC      │                                           │     MODULE 6: SPECIAL HOURS SYNC      │
│  (scripts/gbp-media-sync.mjs)         │                                           │  (scripts/gbp-hours-sync.mjs)         │
│  • Auto-upload job site photos        │                                           │  • Holiday & emergency hours sync     │
│  • Categorized gallery tagging        │                                           │  • Zero manual browser login needed   │
└───────────────────────────────────────┘                                           └───────────────────────────────────────┘
```

---

## 🛠️ Module Breakdown & Implementation Details

### Module 1: Direct API Posting Engine (`scripts/gbp-api-poster.mjs`)
* **Replaces**: `gbp-profile-adapter.mjs`, `gbp-post-once.mjs`, `gbp-poster/driver.mjs`
* **What it does**: Posts promotional updates, service offers, and event announcements directly to Grizzly Electrical Solutions' Google Business Profile via HTTP REST calls.
* **Why we are adding it**: 
  - Eliminates Playwright browser session timeouts, selector breaks, and desktop window popups.
  - Guarantees 100% posting success rate with structured JSON responses.

### Module 2: Performance Analytics Collector & Strategy Optimizer (`scripts/gbp-analytics-collector.mjs`)
* **API Endpoint**: `mybusinessperformance.googleapis.com/v1/locations/{locationId}:fetchMultiDailyMetricsTimeSeries`
* **What it does**: 
  - Pulls daily and weekly performance metrics: Search Impressions, Maps Impressions, Phone Call Clicks, Driving Directions, and Website Clicks.
  - Feeds analytics into `run-weekly-seo.py` to calculate keyword and service conversion performance.
* **Why we are adding it**: 
  - Enables data-driven content generation. If "Panel Upgrades" or "Generator Interlocks" generate 3x more phone calls than generic topics, the SEO agent automatically prioritizes high-converting electrical topics for upcoming weeks.

### Module 3: AI Review Monitoring & Auto-Response Agent (`scripts/gbp-review-agent.mjs`)
* **API Endpoint**: `mybusinessreviews.googleapis.com/v1/accounts/{accountId}/locations/{locationId}/reviews`
* **What it does**: 
  - Monitors incoming customer reviews every 30 minutes.
  - Uses AI to craft personalized, professional thank-you replies for 4-star and 5-star reviews and posts them via API.
  - Triggers an instant SMS/Slack notification for 1-3 star reviews so management can reach out immediately.
* **Why we are adding it**: 
  - Google's Local 3-Pack algorithm heavily ranks businesses that respond quickly to reviews.

### Module 4: Customer Q&A Monitor & Auto-Responder (`scripts/gbp-qanda-agent.mjs`)
* **API Endpoint**: Google Business Profile Q&A API
* **What it does**: 
  - Detects new customer questions asked on Grizzly's Google listing (e.g. *"Do you offer 200A panel upgrades in Plano?"*).
  - Generates an authoritative, helpful response based on Grizzly's service knowledge base and posts it automatically.
* **Why we are adding it**: 
  - Immediate answers build instant customer trust and increase conversion from search impressions to calls.

### Module 5: Job-Site Photo Gallery Sync (`scripts/gbp-media-sync.mjs`)
* **API Endpoint**: `mybusinessbusinessinformation.googleapis.com/v1/locations/{locationId}/media`
* **What it does**: 
  - Automatically syncs job-site photos from Google Drive / Housecall Pro / photo ingestion directories straight to Grizzly's Google Business Profile gallery under categories (`AT_WORK`, `EXTERIOR`, `INTERIOR`).
* **Why we are adding it**: 
  - Listings with regular, fresh photo uploads receive up to 42% more requests for driving directions and 35% more website clicks.

### Module 6: Special & Holiday Hours Auto-Sync (`scripts/gbp-hours-sync.mjs`)
* **API Endpoint**: `mybusinessbusinessinformation.googleapis.com/v1/locations/{locationId}`
* **What it does**: 
  - Manages holiday hours (Thanksgiving, Christmas, 4th of July, weather emergency service) dynamically via API.
* **Why we are adding it**: 
  - Prevents customer confusion during holidays and guarantees accurate business hours across Google Maps.

---

## 🚦 Execution Roadmap

1. **Phase 1: Basic API Access Approval** ← *blocked here, see "PICK UP HERE" above*
   - Waiting on case `2-5921000040991` (filed 2026-07-27, decision ~Aug 5–10 2026).
   - ~~Background monitor `task-529` watching for a *quota* approval email~~ — that email will never arrive; quota requests are auto-denied until basic access is granted.
   - Confirm with `node scripts/gbp-access-probe.mjs`, not with a quota email.

2. **Phase 2: Core Posting Engine Swap**
   - Deploy `scripts/gbp-api-poster.mjs` using `gmail-multi` tokens.
   - Deprecate Playwright dependencies in `gbp-profile-adapter.mjs` and `gbp-post-once.mjs`.

3. **Phase 3: Analytics & Strategy Optimizer Integration**
   - Deploy `scripts/gbp-analytics-collector.mjs`.
   - Update `run-weekly-seo.py` to incorporate analytics metrics into topic selection.

4. **Phase 4: Review, Q&A, and Media Agents**
   - Deploy `gbp-review-agent.mjs`, `gbp-qanda-agent.mjs`, and `gbp-media-sync.mjs`.
