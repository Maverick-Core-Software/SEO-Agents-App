# S4 summary — Content Calendar + Approval Inbox (read-only)

**Run:** mktg-consolidation-20260830
**Session:** S4
**Date:** 2026-08-30
**Scope:** `marketing-control/src/pages/CalendarPage.jsx`, `ApprovalInboxPage.jsx`, `ApprovalInboxPage.test.mjs`, `src/fixtures/approval.js`, and this summary. Did not edit App.jsx, main.jsx, styles.css, supabase.js, package.json, docs, `src/lib/*`, or Today / Content Detail / Website Tasks / Operations / Performance pages.

## Done

- Replaced Calendar and Approval Inbox stubs. First paint is fixtures; never remains "Stub — later session".
- **Calendar:** 4-week grid = current Chicago week plus the previous 3 weeks. Facebook + GBP rows, website_tasks as a per-week badge **and** a third per-day count row. Status colors/labels from `POST_STATUS_COLOR` / `POST_STATUS_LABEL`. Per-week pending / posted / error pills. Post click writes `sessionStorage['mc.detailPost']` then `#/detail` (does not import ContentDetailPage).
- **Live data:** `fetchPosts(addDays(mondayOfWeek(today), -21), sundayOfWeek(addDays(today, 21)))` plus `fetchWebsiteTasks()` (SELECT/GET only). Empty or unconfigured → `FIXTURE_CALENDAR_POSTS` / `FIXTURE_CALENDAR_TASKS`.
- **Approval Inbox:** grouped `seo_run` / `weekly_post` / `website_task`. Fields: type, title, priority (P1–P3), risk, confidence, due, media_status, status, error. Live rows filtered to `pending_approval` and `needs_approval`. Empty or unconfigured → `FIXTURE_QUEUE`.
- Per item `ReadOnlyButton` Approve / Skip: `disabled`, `title="write action — read-only slice"`. No `onClick`, no approve APIs, no `fetch` POST, no `.insert/.update/.delete/.upsert`.
- `attemptApprove()` / `attemptSkip()` live in `fixtures/approval.js` and throw `Error('READ_ONLY')`. Buttons do not call them.

## Verification

| Command | Cwd | Exit |
|---|---|---|
| `npm test` | `marketing-control/` | 0 |
| `npm run build` | `marketing-control/` | 0 |

`npm test`: 37 pass, 0 fail, 13 suites, ~86ms.

S4 added 2 cases in `ApprovalInboxPage.test.mjs` (UTF-8 source scan of the JSX; fetch spy around dynamic import of `attemptApprove` / `attemptSkip`).

Vite production build: 92 modules, `dist/index.html` + CSS `index-BI1sOukU.css` (unchanged; styles.css not edited) + JS `index-DlP_AZ7e.js` (474.71 kB).

Did not git add / commit / push / fetch. Did not restart PM2, Task Scheduler, or any service. Did not edit `C:\Workspace\Active\SEO-Agents-App` or `C:\Workspace\Active\MCC`.

## Files created / edited

| Bytes | Path |
|------:|---|
|   8989 | `marketing-control/src/pages/CalendarPage.jsx` (replaced stub) |
|   7551 | `marketing-control/src/pages/ApprovalInboxPage.jsx` (replaced stub) |
|   8261 | `marketing-control/src/fixtures/approval.js` |
|   1455 | `marketing-control/src/pages/ApprovalInboxPage.test.mjs` |

## Deviations

1. Display window is **current week + previous 3 weeks** (history). Fetch still uses the specified `monday-21` … `sundayOfWeek(today+21)` range (includes future weeks that are not rendered).
2. Extra export `FIXTURE_CALENDAR_TASKS` so the website third-row/badge has fixture dates when posts fall back to fixtures.
3. Website tasks appear as both a week-level count pill and a third row of per-day counts (spec allowed either).
4. Live approval rows are filtered to `pending_approval` / `needs_approval`; fixtures are already in those statuses and go through the same `normalizeItem` path.
5. Initial React state is fixtures so the first paint is never blank/stub; live rows replace fixtures only when the SELECT returns at least one post (calendar) or pending item (inbox).
