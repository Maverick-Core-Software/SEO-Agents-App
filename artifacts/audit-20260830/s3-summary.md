# S3 summary — Today / This Week screen

**Run:** mktg-consolidation-20260830
**Session:** S3
**Date:** 2026-08-30
**Scope:** `marketing-control/src/pages/TodayPage.jsx`, `src/fixtures/week.js`, `src/fixtures/week.test.mjs`, this summary. Did not edit App.jsx, styles.css, supabase.js, package.json, docs, other pages, or any `src/lib/*` file.

## Done

- Replaced the S1 stub with a week-anchored Today / This Week screen. Heading is **This Week** plus `week_start – week_end` (hook week when live posts exist, else fixture week `2026-08-24 – 2026-08-30`).
- Summary strip: `pending_approval` count (posts + tasks), latest run health (`health.live` + `health.bucket`), adapter-readiness dots (Facebook `live_ready`, GBP `worker`, Website `live_ready`).
- Alerts/faults strip for `error` | `needs_verification` | stuck `posting` (`status === 'posting'` and no `posted_at`). Hidden when empty.
- First-class **Needs recovery** zone (below summary, above the grid). Cards show reason text plus disabled `ReadOnlyButton` Retry / Skip / Ack (default tooltip `write action — read-only slice`). Empty → `No items need recovery.`
- Platform tabs Facebook | Google Business with posted/total counts; GBP also shows `scheduled_native` count.
- Mon–Sun list per tab: day label, `post_date`, service/hook with `**` stripped, `StatusChip` from `chipForPost`, `media_status`, `postHealth` state.
- `chipForPost(post, today)` in `fixtures/week.js` (MCC `WeekPostsSection` order): `scheduled` + today → POST TODAY (amber); `scheduled` + past → OVERDUE (red); `scheduled_native` never overdue/today (AUTO 9AM / `native`); `postHealth` red → CHECK (red) wins; else `POST_STATUS_LABEL` / `POST_STATUS_COLOR`.
- Live vs fixtures: `configured && posts.length` uses hook `posts` / `health` / `tasks` and `data.today` (`chicagoToday()`). Not configured **or** live posts empty → fixtures so the screen is never a blank stub. Fixture chips compare against `FIXTURE_TODAY` (`2026-08-30`). Adapters always come from `FIXTURE_ADAPTERS` (hook has none).

## Verification

| Command | Cwd | Exit |
|---|---|---|
| `npm test` | `marketing-control/` | 0 |
| `node --test src/fixtures/week.test.mjs` | `marketing-control/` | 0 |
| `npm run build` | `marketing-control/` | 0 |

`npm test`: 35 pass, 0 fail, 12 suites (S1 scaffold + S2 lib + parallel-session lib tests already in the glob). S1's test script does **not** include `src/fixtures/*.test.mjs`, so chip cases were run separately:

`node --test src/fixtures/week.test.mjs`: 6 pass, 0 fail, 2 suites.

| File | Tests |
|---|---|
| `fixtures/week.test.mjs` | 6 (scheduled+today POST TODAY; scheduled+past OVERDUE; scheduled_native+past AUTO 9AM / native; posted+downgraded CHECK; posted healthy POSTED/green; FIXTURE_TODAY matches a fixture date) |

Vite production build: 91 modules, `dist/index.html` + CSS `index-BI1sOukU.css` (unchanged; styles.css not edited) + JS `index-CaLvKQyG.js`.

Node v24 / npm from S1. Did not git add / commit / push / fetch. Did not restart PM2, Task Scheduler, or any service. Did not edit `C:\Workspace\Active\SEO-Agents-App` or `C:\Workspace\Active\MCC` (read-only `SEOApprovalPage.jsx` `WeekPostsSection` for the chip port).

## Files created / edited

| Bytes | Path |
|------:|---|
|  11676 | `marketing-control/src/pages/TodayPage.jsx` |
|   7195 | `marketing-control/src/fixtures/week.js` |
|   2064 | `marketing-control/src/fixtures/week.test.mjs` |

## Deviations

1. `today` is `usingFixtures ? FIXTURE_TODAY : data.today`, not only `configured ? data.today : FIXTURE_TODAY`. When Supabase is configured but this week's posts are empty, fixtures still pin chips to `FIXTURE_TODAY` so POST TODAY / OVERDUE / native demo chips stay deterministic.
2. `chipForPost` tests live at the specified `src/fixtures/week.test.mjs`. `npm test` (S1-owned `package.json`) globs only `src/lib/*.test.mjs` and `src/pages/*.test.mjs`, so those 6 cases are not in `npm test` until a later session expands the glob. They pass under `node --test src/fixtures/week.test.mjs`.
3. Extra fixture exports used by the page: `cleanCopy`, `dayLabelFor`, `isRecoveryItem`, `FIXTURE_TASKS`, `FIXTURE_WEEK_START` / `FIXTURE_WEEK_END`. Spec required `chipForPost`, `FIXTURE_TODAY`, `FIXTURE_ADAPTERS`, `FIXTURE_HEALTH`, and the post mix.
4. One extra assertion that `FIXTURE_TODAY` matches a fixture `post_date`.
5. Adapter dots always render `FIXTURE_ADAPTERS` — `useMarketingData` does not return adapters, matching "from fixture adapters if live data has none".
6. `npm test` reported 35 tests / 12 suites (S2 was 28 / 8). The extra suites are parallel-session lib tests already on disk (`parseEngagementMarkdown`, boost ledger, etc.). This session did not add or edit them.
