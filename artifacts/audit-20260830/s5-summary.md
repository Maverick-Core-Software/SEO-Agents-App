# S5 summary — Content Detail + Website Tasks + Operations

**Run:** mktg-consolidation-20260830
**Session:** S5
**Date:** 2026-08-30
**Scope:** `marketing-control/src/pages/{ContentDetail,WebsiteTasks,Operations}Page.jsx`, `marketing-control/src/fixtures/detail.js`, plus this summary. Did not edit App.jsx, main.jsx, styles.css, supabase.js, package.json, docs, `src/lib/*`, or Today/Calendar/ApprovalInbox/Performance pages.

## Done

- `fixtures/detail.js`: `FIXTURE_DETAIL_POST` (full copy + action_queue scaffolding), `FIXTURE_TASKS` (4 rows, mixed priority/status), `FIXTURE_ADAPTERS` (Facebook live_ready / GBP missing / Website live_ready), `FIXTURE_WEBSITE_ADAPTER` (8 capabilities: blog_post, contact_form, copy, faq, gallery, hours, layout, service_page), `FIXTURE_RUNS`, `FIXTURE_LOGS`.
- `ContentDetailPage.jsx`: loads `sessionStorage['mc.detailPost']` JSON, else the fixture. Renders platform, day, date, service, topic, trend_tie, headline/hook, body, caption, cta, hashtags, photo_file (notes `[CONFIRM]`), type, media_status, status, posted_at, platform_post_id, error. Approval scaffolding rows that are missing on the object render "—" plus "approval scaffolding from action_queue — not in weekly_posts (Phase 2)". Run history table. ReadOnlyButton Approve / Skip / Run / Retry / Edit note. No POST.
- `WebsiteTasksPage.jsx`: live `website_tasks` via `useMarketingData` when configured, else `FIXTURE_TASKS`. Sort critical > high > medium > low. Title, priority, status, error, type/capability, site section (`details.section` or `details.site_section`), preview path (`details.preview_path` or `outputs/website_preview/` on dry-run/preview). Per-row ReadOnlyButton Approve / Skip / Retry. Adapter capability chips from `FIXTURE_WEBSITE_ADAPTER`.
- `OperationsPage.jsx`: adapter cards from `FIXTURE_ADAPTERS` (live health overlay when configured). Latest run health: `health.live`, `health.bucket`, `run.week_of`, `run.status`, `run.error`. Run history uses `liveRunStatus` when posts are available, else frozen `run.status`. `run_logs` table. Fault ack copy: "acks are local to MCC (state/fault-acks.json) — not in Supabase. Phase 2." Worker health: `fetchWorkerStatus()` GET in `useEffect`; unreachable → "worker unreachable" (no crash); secrets redacted in the JSON summary. Task event log: "Task activity log lives in MCC memory — not in Supabase." ReadOnlyButton Clear lock / Ack faults.

When Supabase is not configured, all three screens render fixtures (not stubs). Never POST. Never supabase insert/update/delete.

## Verification

| Command | Cwd | Exit |
|---|---|---|
| `npm test` | `marketing-control/` | 0 |
| `npm run build` | `marketing-control/` | 0 |

`npm test`: 35 pass, 0 fail, 12 suites, ~89ms (`node --test` on `src/lib/*.test.mjs` and `src/pages/*.test.mjs`). S5 did not add page tests (not in ownership). Extra suites vs S2 are from parallel S6 `performance` tests.

Vite production build: 91 modules, `dist/index.html` + CSS + JS (`index-CaLvKQyG.js`, 459.88 kB).

Did not git add / commit / push / fetch. Did not restart PM2, Task Scheduler, or any service. Did not edit `C:\Workspace\Active\SEO-Agents-App` or `C:\Workspace\Active\MCC`.

## Files created / edited

| Bytes | Path |
|------:|---|
|   7355 | `marketing-control/src/fixtures/detail.js` |
|   8396 | `marketing-control/src/pages/ContentDetailPage.jsx` |
|   6082 | `marketing-control/src/pages/WebsiteTasksPage.jsx` |
|  11302 | `marketing-control/src/pages/OperationsPage.jsx` |
|   (this) | `artifacts/audit-20260830/s5-summary.md` |

## Deviations

1. No S5 page unit tests — ownership list did not include `*.test.mjs`; verification is fixtures render + existing `npm test` + `npm run build`.
2. Calendar click-through into `mc.detailPost` is S4's job; this session only reads that key (fixture fallback if absent/invalid JSON).
3. Adapter cards always come from S5 `FIXTURE_ADAPTERS`. Live health is an overlay (`health.live` / `health.bucket` / `week_of`) because `/seo/status` does not return per-adapter readiness and mav-bridge `runHealth` is null.
4. Worker JSON is summarized (`state`, `statusCounts`, `faults`, `updatedAt`, `activeWorkflow`, `runHealth`) and keys matching token/secret/password/api-key/etc. are replaced with `[redacted]`.
5. Website-task sort tie-breaks on `created_at` (same idea as `scripts/lib/website-task-runner.mjs` `PRIORITY_MAP`).
6. S3 `fixtures/week.js` also exports `FIXTURE_TASKS` / `FIXTURE_ADAPTERS`. S5 keeps its own copies in `fixtures/detail.js` per file ownership; pages here do not import `week.js`.
