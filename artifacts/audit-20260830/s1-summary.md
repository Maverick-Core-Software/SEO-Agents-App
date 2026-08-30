# S1 summary — scaffold Grizzly Marketing Control

**Run:** mktg-consolidation-20260830
**Session:** S1
**Date:** 2026-08-30
**Scope:** `marketing-control/` app scaffold only (plus this summary). Did not edit `marketing-control/docs/**`.

## Done

- Scaffolded a Vite + React 19 app at `marketing-control/` matching MCC caret versions (`react`/`react-dom` `^19.2.1`, `vite` `^7.2.7`, `@vitejs/plugin-react` `^5.1.1`, `@supabase/supabase-js` `^2.108.1`).
- Hash/view-state routing in `src/App.jsx` (no react-router). Default `#/today`. Nav order: Today, Calendar, Approval Inbox, Content Detail, Website Tasks, Performance, Operations.
- Persistent banner: `Read-only slice — writes are disabled.`
- Non-crashing Supabase-not-configured notice when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are empty; shell + current stub still render.
- Stub pages accept optional `props`. `ReadOnlyButton` is disabled and drops `onClick`. `StatusChip` is presentational.
- `src/lib/scaffold.test.mjs` is the only test file this session (1+1===2). Did not create `status.js`, `api.js`, `postHealth.js`, or `week.js`.

## Verification

| Command | Cwd | Exit |
|---|---|---|
| `npm install` | `marketing-control/` | 0 |
| `npm run build` | `marketing-control/` | 0 |
| `npm test` | `marketing-control/` | 0 |

Vite production build: 80 modules, `dist/index.html` + CSS + JS. Test: 1 pass, 0 fail.

Node v24.19.0, npm 11.17.0. Public registry only. No `.env` created.

Did not git add / commit / push / fetch. Did not restart PM2, Task Scheduler, or any service. Did not touch `C:\Workspace\Active\SEO-Agents-App` or `C:\Workspace\Active\MCC` (read-only `package.json` + `src/supabase.js` for version/pattern match).

## Resolved versions (caret ranges in package.json)

| Package | Range | Resolved |
|---|---|---|
| react | ^19.2.1 | 19.2.8 |
| react-dom | ^19.2.1 | 19.2.8 |
| vite | ^7.2.7 | 7.3.6 |
| @vitejs/plugin-react | ^5.1.1 | 5.2.0 |
| @supabase/supabase-js | ^2.108.1 | 2.112.4 |

## Files created

| Bytes | Path |
|------:|---|
|    496 | `marketing-control/package.json` |
|  64166 | `marketing-control/package-lock.json` |
|    136 | `marketing-control/vite.config.js` |
|    312 | `marketing-control/index.html` |
|     44 | `marketing-control/.gitignore` |
|     86 | `marketing-control/.env.example` |
|    161 | `marketing-control/src/main.jsx` |
|   2836 | `marketing-control/src/App.jsx` |
|   2431 | `marketing-control/src/styles.css` |
|    291 | `marketing-control/src/supabase.js` |
|    403 | `marketing-control/src/components/ReadOnlyButton.jsx` |
|    160 | `marketing-control/src/components/StatusChip.jsx` |
|    183 | `marketing-control/src/pages/TodayPage.jsx` |
|    189 | `marketing-control/src/pages/CalendarPage.jsx` |
|    200 | `marketing-control/src/pages/ApprovalInboxPage.jsx` |
|    200 | `marketing-control/src/pages/ContentDetailPage.jsx` |
|    198 | `marketing-control/src/pages/WebsiteTasksPage.jsx` |
|    195 | `marketing-control/src/pages/PerformancePage.jsx` |
|    193 | `marketing-control/src/pages/OperationsPage.jsx` |
|    138 | `marketing-control/src/lib/scaffold.test.mjs` |

`node_modules/` and `dist/` exist locally; both are gitignored.

## Deviations

1. `ReadOnlyButton` matches the specified disabled/`title`/`aria-disabled`/`data-readonly` API, but strips `onClick` (destructured, not spread) so a live handler cannot be attached. Also always includes class `readonlyBtn` so the CSS rule applies without callers remembering it.
2. First `npm install` ran at the worktree root by mistake and renamed tracked `package-lock.json` `"name"` from `SEO-Agents-App` to `cockle`. Restored immediately with `git restore -- package-lock.json`. No remaining tracked diffs outside `marketing-control/` (plus this summary under `artifacts/audit-20260830/`).
3. `npm install` in `marketing-control/` warned that `esbuild@0.28.2` postinstall is not in npm `allowScripts`; `npm run build` still succeeded.
4. No echarts, no react-router, no MCC `/api` Vite proxy, no fetch POST, no `supabase.from()` writes.
