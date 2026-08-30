# S2 summary — read-only data layer + status derivation

**Run:** mktg-consolidation-20260830
**Session:** S2
**Date:** 2026-08-30
**Scope:** `marketing-control/src/lib/**` (plus optional chaining in `src/supabase.js` and this summary). Did not edit pages, App.jsx, docs, or package.json.

## Done

- `status.js`: copy+adapt of `scripts/lib/seo-run-status.mjs` (`STATUS_COUNTS_WINDOW_MS`, `TERMINAL_*`, `FROZEN_*`, `liveRunStatus`, `bucketStatusCount`, `countRunStatuses`) plus MCC `POST_STATUS_COLOR` / `POST_STATUS_LABEL`. ESM exports. No `import.meta.env`.
- `postHealth.js`: copy+adapt of MCC `postHealth` / `healthReason` with identical control flow (fallback media → no post id → type mismatch).
- `week.js`: `chicagoToday` (America/Chicago `en-CA` parts), `mondayOfWeek` / `sundayOfWeek` / `addDays` on YYYY-MM-DD via `Date.UTC` (Monday start, Sunday = Monday+6).
- `api.js`: SELECT-only fetchers; `wrapReadOnly` Proxy throws `Error('READ_ONLY')` on `insert|update|delete|upsert|rpc` and wraps `.from` / builder returns; `fetchWorkerStatus` GET-only. Unconfigured → empty/null, no throw. Supabase errors rethrown as short `Error` messages (no secrets).
- `useMarketingData.js`: React hook loads runs/posts/tasks/logs/health for the Chicago Mon–Sun week; `partitionPosts(posts)` → `{ facebook, gbp }`.
- `src/supabase.js`: `import.meta.env?.VITE_*` so `node --test` can import the data layer. Only S1 file touched.

Did not create `guard.js`. Did not implement page UIs. Did not hit live Supabase.

## Verification

| Command | Cwd | Exit |
|---|---|---|
| `npm test` | `marketing-control/` | 0 |
| `npm run build` | `marketing-control/` | 0 |

`npm test`: 28 pass, 0 fail, 8 suites, ~430ms.

| File | Tests |
|---|---|
| `status.test.mjs` | 7 (frozen rejected, skipped finished, scheduled_native finished, dismissed, in-flight partial, error/blocked, 28d window) |
| `postHealth.test.mjs` | 11 (non-posted/null neutral; green video; green photo; red downgraded; red none; red no post id; red type mismatch; downgraded precedence; healthReason red vs null) |
| `week.test.mjs` | 4 (UTC-after-19:00-CT stays on CT date; Wednesday → Mon–Sun; Sunday of same week; addDays month roll) |
| `api.test.mjs` | 5 (`select` allowed; mutations throw `READ_ONLY`; top-level `from().insert` throws and does not call insert; fetchers degrade; worker probe unreachable when URL unset) |
| `scaffold.test.mjs` | 1 (S1) |

Vite production build: 80 modules, `dist/index.html` + CSS + JS (`index-BM7XI_c7.js`). New lib modules are not yet imported by App/pages (S3+), so they are not in the client graph.

Node v24 / npm from S1. Did not git add / commit / push / fetch. Did not restart PM2, Task Scheduler, or any service. Did not edit `C:\Workspace\Active\SEO-Agents-App` or `C:\Workspace\Active\MCC` (read-only `seoRules.js` / `seoRules.test.js` / `SEOApprovalPage.jsx` for the port).

## Files created / edited

| Bytes | Path |
|------:|---|
|   4690 | `marketing-control/src/lib/status.js` |
|   3321 | `marketing-control/src/lib/status.test.mjs` |
|   1471 | `marketing-control/src/lib/postHealth.js` |
|   3109 | `marketing-control/src/lib/postHealth.test.mjs` |
|   1262 | `marketing-control/src/lib/week.js` |
|   1176 | `marketing-control/src/lib/week.test.mjs` |
|   3445 | `marketing-control/src/lib/api.js` |
|   2000 | `marketing-control/src/lib/api.test.mjs` |
|   2344 | `marketing-control/src/lib/useMarketingData.js` |
|    293 | `marketing-control/src/supabase.js` (optional chaining only) |

## Deviations

1. `useMarketingData` also returns `facebook` / `gbp` (via `partitionPosts`) in addition to the specified `{ configured, loading, error, weekStart, weekEnd, today, runs, posts, tasks, logs, health, reload }`. Helper is exported either way for S3.
2. `api.test.mjs` adds unconfigured-degrade and `fetchWorkerStatus` assertions (no live network). Spec required only wrapReadOnly cases.
3. `week.test.mjs` also covers Sunday-of-week and `addDays` month rollover, beyond the two required cases.
4. `fetchWorkerStatus` success shape is `{ ok: true, unreachable: false, data }` — spec only defined the failure shape `{ ok: false, unreachable: true }`.
5. `selectRows` re-wraps thrown errors as short `Error(message)` (≤180 chars) so network/RLS failures never include URLs or keys.
6. New lib files are unused by the Vite entry in this session; build still exits 0. Pages stay stubs until S3–S6.
