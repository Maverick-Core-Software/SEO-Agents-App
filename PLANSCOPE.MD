# PLANSCOPE.MD — Official Google Business Profile API Master Plan

## 📌 Executive Summary & Objective

This document outlines the complete scope for upgrading `SEO-Agents-App` from legacy Playwright browser automation to official **Google Business Profile REST APIs**. 

By leveraging project **`Hermes Agent`** (`exalted-slice-502415-s0` / `1084301840332`) and the multi-account token manager (`gmail-multi`), `SEO-Agents-App` will achieve 100% API reliability, real-time performance analytics feedback, automated reputation management, instant Q&A responses, and automated job-site photo gallery synchronization.

---

## 🛑 PICK UP HERE — status as of 2026-07-27

**The code below is written and shipped, but the feature is DORMANT and must stay that way until Google approves API access. Read this section before touching anything else in this file.**

### Where we are

* Modules 1, 2, 3, 5, 6 are committed in **`b7b6007`**. Module 4 (`gbp-qanda-agent.mjs`) was never written.
* `gbp-worker.mjs` reads `GBP_POSTER`, which **defaults to `playwright`**. Runtime behaviour is unchanged from before the commit; nothing was restarted.
* Every GBP endpoint is blocked. Not a rate limit — the project has never been allowlisted:

  | surface | result | meaning |
  |---|---|---|
  | `mybusinessaccountmanagement/v1` | 429 `quota_limit=0` | enabled, unapproved |
  | `mybusinessbusinessinformation/v1` | 429 `quota_limit=0` | enabled, unapproved |
  | `businessprofileperformance/v1` | 403 SERVICE_DISABLED | not enabled in console |
  | `mybusinessqanda/v1` | 403 SERVICE_DISABLED | not enabled in console |
  | `mybusinessverifications/v1` | 403 SERVICE_DISABLED | not enabled in console |
  | `mybusiness.googleapis.com/v4` | **404** (incl. `$discovery`) | gated — not allowlisted |

* **Second blocker:** `gbp-api-poster.mjs` builds Local Posts and media upload on **legacy v4** (`/v4/{location}/localPosts`, `media:startUpload`). That host 404s entirely for this project. Local Posts exist **only** on v4 — there is no v1 equivalent — so no amount of code work routes around approval.
* Enabling an API in the console is **not** approval. Account Management and Business Information are self-serve and can be enabled by anyone; the gated legacy API is the one still 404ing.

### The application

Basic-access application filed **2026-07-27**, case **`2-5921000040991`**, from **carterbarns@grizzlyelectrical.net** (the account that manages the verified listing), as business owner, single location, not an agency. Project number `1084301840332`, website `https://www.grizzlyelectricaltx.com`. Google quoted **7–10 business days** → decision expected **~Aug 5–10, 2026**.

Prior quota-increase requests were denied three times (2026-04-30, 07-22, 07-23) because they used the **wrong form** — quota increases are step two and are auto-denied until basic access is granted.

### What to do when the decision lands

1. Run the probe:

   ```bash
   node scripts/gbp-access-probe.mjs
   ```

2. If it still says *still gated*, stop — nothing to do, the approval hasn't propagated.
3. If v4 answers, enable the three `SERVICE_DISABLED` APIs in the console, re-run the probe, and do one real read before writing anything.
4. Only then set `GBP_POSTER=api` (env var, not a code change — the default stays `playwright` as the rollback path).
5. Post to a real listing exactly once and verify it on the live profile before letting the worker run unattended.

### If it's denied again

Read the denial text carefully — a second denial on the *basic access* form means something in the application itself (use case, ownership, or the project/account mismatch) is the problem, not the form choice. Do not file another quota request.

### Set aside, not lost

An uncommitted change to `lib/gbp-runner.mjs` removed native Day 2–7 GBP scheduling in *both* modes, reasoning that the REST API has no scheduling endpoint. It was reverted before commit — `mav-bridge.mjs` still hardcodes `driver.mjs`, so native scheduling works today and dropping it while the API is dead would regress the 7/11 feature for no gain. The diff is preserved at `C:\Workspace\Active\brain\projects\gbp-runner-drop-native-scheduling.patch`; re-apply it only if the API is approved and posting actually moves to `api` mode.

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
