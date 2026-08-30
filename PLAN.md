# PLAN.md — Grizzly Marketing Control (consolidation + first read-only slice)

**Run ID:** mktg-consolidation-20260830
**Date:** 2026-08-30
**Pipeline depth:** Full — audit (done) → plan → review → execute
**Audit evidence:** `artifacts/audit-20260830/research/{flow,data,adapters,tests,mcc,ux,secops}.md`
**Author:** Pi (orchestrator). **Executor:** Grok 4.6 (with its own subagents).
**Status:** EXECUTED 2026-08-30 — Phases 0–1 complete in this worktree (local commits only; no push).

---

## 0. Executive summary

The SEO automation is a working production system. The problem is not a missing app — it is that the workflow's operator surface is a thin proxy layer embedded in MCC, a broad homelab/agent console, while the durable record (Supabase) and the execution worker (`mav-bridge.mjs`) already do the real work.

This plan does **not** rewrite the SEO engine, migrate data, or move browser automation. It:

1. Records the current production state (Phase 0, documentation only).
2. Builds **Grizzly Marketing Control** — a focused, private, **read-only** weekly marketing dashboard reading the existing Supabase record directly (Phase 1, the immediate slice).
3. Defers the durable command path, cutover, and engine hardening to later, gated phases (Phases 2–5).

**Non-negotiables for every execution worker (carry these verbatim):**

- Read-only by default. No production post, website edit, approval, browser login, secret change, process restart, deployment, or scheduled-task alteration without direct approval.
- No `git push` / `git fetch`. All work is local.
- `git add` ONLY the files a session changed — never `git add -A` / `git add .`.
- Never print secret values. Reference `.env` keys by name only.
- The two live repos (`C:\Workspace\Active\SEO-Agents-App`, `C:\Workspace\Active\MCC`) are **out of scope for edits**. All new code lands in this worktree (`C:/Users/carte/orca/workspaces/SEO-Agents-App/cockle`) under `marketing-control/`.
- Do not restart PM2, Task Scheduler, or any running service.

---

## 1. Codebase primer (audit-grounded facts)

### 1.1 The production flow (from `flow.md`)

- Friday 08:25–08:30 Windows Task Scheduler: photo sync → `run-weekly-seo.py` (CrewAI research → schedules) → parallel `seo-monitor.mjs` (14h window).
- Crew phases write Markdown to `outputs/` (`facebook_posting_schedule.md`, `gbp_posting_schedule.md`, `grizzly_execution_queue.md`, reports).
- `supabase-sync.mjs` parses Markdown → Supabase (`seo_runs` upsert on `week_of`, `weekly_posts`, `website_tasks` — all `pending_approval`).
- Approval (MCC UI or `SEO_AUTO_APPROVE=1`) → Supabase status `approved`.
- `mav-bridge.mjs` (PM2, :8790) polls Supabase every 30s → executes approved FB/website work, reconciles, alerts.
- `gbp-worker.mjs` (user-session Scheduled Task) posts GBP daily via Playwright.
- `seo-watchdog.mjs` (daily 10:00) is the independent no-show/stale detector.

### 1.2 Durable record (from `data.md`)

- Supabase is authoritative for **status/approval/execution state**. Markdown is authoritative for **published content** (files are mutated post-sync). Boost decisions live only in Markdown.
- `seo_runs` (key `week_of`, derived from run clock — a known TZ bug), `weekly_posts` (`run_id`, `platform`, `day`, `status`, `platform_post_id`, `media_status`, `photo_file`), `website_tasks`, `run_logs`.
- The anon key is already shipped in MCC's Vite bundle and reads SEO tables. **RLS is absent from `schema.sql`** (live state unverifiable) — a Phase-2 concern, not a blocker for read-only Phase 1.

### 1.3 Adapters (from `adapters.md`)

- **Facebook** (`facebook-poster.mjs`): no create-level idempotency key; token-retry on Graph 190/102; no post-hoc read-back in-poster (reconcile in bridge). Untested crash windows: post-success-before-write, duplicate resume, stale `.lock-*` idempotency locks (Python path), `website.py:147` fence-strip bug.
- **GBP** (`gbp-poster/driver.mjs` + `gbp-worker.mjs`): strongest safety — submitted-flag (never re-post after click), exit-code contract (0/3/4/5), `needs_verification` handling. Partially-handled crash window between driver success and archive write (30-min TTL reset → duplicate risk).
- **Website** (`website.py`): no adapter-level approval (relies on `actions.py` gate); no automated retry/rollback.

### 1.4 Test coverage (from `tests.md`)

- **Covered:** engine idempotency, evidence/claims, dispatch gates, failure classification, dry-run isolation, run locks, LLM failover, GBP runner/exit-codes, website task runner/parser, FB media selection, name guard, run-status mapping.
- **Untested (high severity):** `seo-monitor.mjs` + `seo-watchdog.mjs` (the 2026-07-24 no-show incident chain), `supabase-sync.mjs` (contains the known `getWeekOf` TZ bug), `run-weekly-seo.py`. `tests/conftest.py` output-path fixture is a no-op. No `npm test` script, no CI.

### 1.5 MCC decomposition (from `mcc.md`)

- SEO approval in MCC is a **thin proxy**: `SEOApprovalPage.jsx` → `routes/seo.mjs` → `lib/models.mjs::callSeoApp()` → `http://127.0.0.1:8790` (mav-bridge). No AI, no file I/O, no DB writes in the SEO path itself.
- SEO-essential: `SEOApprovalPage.jsx`, `seoRules.js`, `routes/seo.mjs`, `lib/http.mjs`, `lib/load-env.mjs`, plus `callSeoApp`/`logSeoEvent`/`seoAppUrl` splinters of `models.mjs`/`state.mjs`/`config.mjs`.
- RETIRE (independent of SEO): `chat.mjs`, `exec.mjs`, `prompts.mjs`, `self-improve.mjs`, `llama-status`, `zai-status`, `memory`, `extract`, `ops-notify`, `thumbtack-*` (5), `orchestrator.mjs`, `build.mjs`, `HomePage.jsx`, `MaverickPage.jsx`, etc.

### 1.6 Security (from `secops.md`)

- **Critical:** `/api/build/apply` (MCC) accepts arbitrary absolute paths + runs `pm2` with no auth, on `0.0.0.0:3000`, with CORS granted to any `*.vercel.app`/`*.ts.net`. **Out of scope for this slice's edits** (MCC is not edited), but flagged as the reason MCC must not become the marketing control plane.
- **High:** CORS wildcard; secrets duplicated into PM2 `env:` block.
- **Positive patterns to reuse:** bearer-gated photo upload, fail-closed Thumbtack config, `alertOnce` dedup, dual-channel alerts, double-trigger watchdog design.

### 1.7 UX (from `ux.md`)

- Today's whole marketing UI is one page (`SEOApprovalPage.jsx`). Performance data is collected (`facebook_engagement_report.md`, boost ledger, baselines) but **never surfaced** — MCC's metrics are homelab infra only.
- Derived IA: 7 screens (Today/This Week, Content Calendar, Approval Inbox, Content Detail, Website Tasks, Performance, Operations) + a first-class "Needs recovery" zone.
- The read-only slice is implementable entirely against existing Supabase reads + GET endpoints (`/seo/status`, `/seo/actions`, `/seo/posts/week`) + file outputs — **no backend work required**.

---

## 2. Target architecture

```
                    Grizzly Marketing Control
                 (private, read-only operator app)
                              |
              authenticated reads, zero writes (Phase 1)
                              |
                         Supabase
       runs | posts | tasks | commands | events | metrics | artifacts
                              |
                      local SEO worker
          planning | adapters | media | verification | health
                              |
                  Facebook | GBP | website | media sources
```

Phase 1 is **read-only**: the app reads Supabase directly (anon key, SELECT only) and renders. It issues zero POST calls. Write buttons are rendered disabled with a "read-only slice" tooltip.

---

## 3. Phase plan

| Phase | Goal | In this run? |
|---|---|---|
| **0 — Protect production** | Write current-state inventory, commit audit evidence. No code changes to live repos. | **YES** |
| **1 — Read-only dashboard** | Private weekly marketing dashboard: posts, status, approvals, faults, run health, performance signals. | **YES (the main build)** |
| 2 — Durable command path | command/attempt model in Supabase; worker lease; one low-risk action end-to-end. | Deferred (gated) |
| 3 — Controlled cutover | Move approvals/retries/dismissals into the app; retire MCC SEO proxy after one full cycle. | Deferred (gated) |
| 4 — Engine hardening | Extract module boundaries; single schedule parser; targeted regression tests. | Deferred (gated) |
| 5 — Decide MCC future | Narrow/retire MCC independently. | Deferred (gated) |

---

## 4. Execution waves (this run)

Executor: **Grok 4.6** + subagents. Sessions are file-disjoint within a wave. All work is in this worktree.

### Wave 0 — Documentation (1 session)

**S0 — Current-state inventory + audit archive.**
- Write `marketing-control/docs/CURRENT-STATE-INVENTORY.md` (services, owners, startup paths, state writes, side effects, recovery paths — condensed from `flow.md` + `secops.md`).
- Write `marketing-control/docs/AUDIT-FINDINGS.md` (condensed from the 7 research reports, facts vs inference separated, severity-ranked).
- Copy the 7 research reports into `marketing-control/docs/audit/` (they are already at `artifacts/audit-20260830/research/`).
- **Verification:** `node -e` lint-free is N/A (docs); confirm files exist and are non-empty; confirm no file outside `marketing-control/` was touched.
- **Commit:** `docs: current-state inventory and audit findings (marketing-control)`

### Wave 1 — App scaffold + data layer (2 sessions, file-disjoint)

**S1 — Scaffold `marketing-control/` Vite+React app.**
- `package.json` (React 19 + Vite, matching MCC stack), `vite.config.js`, `index.html`, `src/main.jsx`, `src/styles.css`, `.gitignore` (ignore `node_modules`, `.env*`), `.env.example` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` placeholders only).
- Supabase client `src/supabase.js` reading `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- A minimal layout shell with the **7-screen** nav (Today, Calendar, Approval Inbox, Content Detail, Website Tasks, Performance, Operations) + "read-only" banner.
- Stub `src/pages/{Today,Calendar,ApprovalInbox,ContentDetail,WebsiteTasks,Performance,Operations}Page.jsx` so later sessions replace page bodies only (they must not edit `App.jsx` / `main.jsx`).
- Shared `src/components/ReadOnlyButton.jsx` (disabled + tooltip) and hash/view-state routing in `App.jsx` (no react-router).
- `package.json` `"test"` script: `node --test src/**/*.test.mjs` so S7 does not need to own `package.json`.
- **Verification:** `npm install` (no network for private deps — use npm registry), `npm run build` succeeds.
- **Commit:** `feat(marketing-control): scaffold read-only dashboard app`

**S2 — Data layer + status derivation.**
- `src/lib/status.js`: port `liveRunStatus` semantics from `SEO-Agents-App/scripts/lib/seo-run-status.mjs` (read-only; copy + adapt, do not import across repos). Status → display bucket mapping (pending_approval/approved/scheduled/scheduled_native/posted/needs_verification/error/skipped/...).
- `src/lib/postHealth.js`: port `postHealth()` from MCC `src/lib/seoRules.js` (RED/GREEN/neutral).
- `src/lib/api.js`: read-only Supabase query functions — `fetchRuns()`, `fetchPosts(weekStart, weekEnd)`, `fetchWebsiteTasks()`, `fetchRunLogs()`, `fetchLatestRunHealth()`. `fetchLatestRunHealth()` derives from `seo_runs` + `weekly_posts` via `liveRunStatus` (there is **no** `run_health` table; `outputs/run_health.json` is a local file and mav-bridge currently returns `runHealth: null`). SELECT only; a guard rejects any `.insert/.update/.delete/.upsert/.rpc` (throw `READ_ONLY`).
- `src/lib/week.js`: America/Chicago calendar date + Mon–Sun week bounds (UTC midnight falsely marks tomorrow as today after 19:00 CT).
- Optional worker probe: GET `import.meta.env.VITE_SEO_STATUS_URL` (default unset). If unset or the GET fails, Operations shows "worker unreachable" — never POST.
- **Verification:** `node --test` on `src/lib/status.test.mjs` + `postHealth.test.mjs` (port the existing assertions from `seo-run-status.test.mjs` / `seoRules.js`).
- **Commit:** `feat(marketing-control): read-only data layer and status derivation`

### Wave 2 — Screens (3 sessions, file-disjoint)

**S3 — Today / This Week screen.**
- `src/pages/TodayPage.jsx` only (replace the S1 stub). Week-anchored Mon–Sun grid × Facebook/GBP, health chips (from `postHealth`), POST TODAY / OVERDUE / CHECK chips (`scheduled` + date vs America/Chicago today; `scheduled_native` is not overdue), pending count, alerts/faults strip, adapter-readiness dots, latest run health, and a first-class **Needs recovery** zone (`error` / `needs_verification` / stuck `posting`). Retry/Skip/Ack buttons disabled via `ReadOnlyButton`.
- **Verification:** component renders with fixture data (no live Supabase needed); `npm run build`.
- **Commit:** `feat(marketing-control): today/this-week screen`

**S4 — Content Calendar + Approval Inbox (read-only).**
- `src/pages/CalendarPage.jsx`: 2–4 week grid, status colors, per-week counts, click-through placeholder to detail.
- `src/pages/ApprovalInboxPage.jsx`: grouped queue (run/post/website_task) with priority/risk/confidence/status; Approve/Skip buttons rendered **disabled** with tooltip.
- **Verification:** fixtures render; buttons are `disabled` and issue no network call when clicked (assert via test spy).
- **Commit:** `feat(marketing-control): content calendar and read-only approval inbox`

**S5 — Content Detail + Website Tasks + Operations.**
- `src/pages/ContentDetailPage.jsx`: full copy fields, approval scaffolding (steps, deps, verification checklist, rollback, confidence, idempotency key), run history. Read-only.
- `src/pages/WebsiteTasksPage.jsx`: priority list + capability + preview path. Read-only.
- `src/pages/OperationsPage.jsx`: adapter readiness, run history + `run_logs`, fault ack state, run-health phase flags, worker health (`/seo/status` GET only), task event log.
- **Verification:** fixtures render; `npm run build`.
- **Commit:** `feat(marketing-control): content detail, website tasks, operations screens`

### Wave 3 — Performance + guardrails + final verification (2 sessions, sequential)

**S6 — Performance screen (surfacing what already exists).**
- `src/pages/PerformancePage.jsx` only + `src/lib/performance.js` + `src/fixtures/performance.js`. Render fixture copies of the engagement report / boost ledger / baseline excerpts shipped in-repo (this worktree has no `outputs/`). Optional `VITE_OUTPUTS_DIR` file read if set; never write outside `marketing-control/`. Label "week-over-week trends require Phase-2 structured store" where a number is unavailable.
- **Verification:** fixtures render; `npm run build`.
- **Commit:** `feat(marketing-control): performance screen from existing reports`

**S7 — Read-only guardrail audit + final verification.**
- Add a hard read-only guard: a single wrapper module (`src/lib/guard.js`) that every mutation-capable call must route through; assert in tests that zero `.insert/.update/.delete/.upsert` reach the client.
- `npm run build` + `npm test` (wire a `test` script in `package.json` running `node --test` on `src/lib/*.test.mjs`).
- Write `marketing-control/README.md` (run instructions, read-only guarantee, Phase-2 roadmap pointer).
- **Verification:** `npm test` passes; `npm run build` passes; grep confirms no `fetch`/`supabase.from(...).insert|update|delete` mutation path in `src/`.
- **Commit:** `test(marketing-control): read-only guardrail, test wiring, README`

### Dependency graph (after review)

```
S0
 └── S1 (scaffold + stubs + test script + ReadOnlyButton)
      └── S2 (data layer)
           ├── S3  TodayPage.jsx
           ├── S4  CalendarPage.jsx + ApprovalInboxPage.jsx
           ├── S5  ContentDetail + WebsiteTasks + Operations
           └── S6  PerformancePage.jsx
                └── S7  guard.js + README + final verify
```

S3–S6 are parallel after S2 (file-disjoint page/fixture ownership). S7 is last. Subagents **do not commit**; the executor commits with explicit path lists after each session (or after a parallel wave). No cycles.

### File ownership (do not cross)

| Session | Owns |
|---|---|
| S0 | `marketing-control/docs/**` |
| S1 | `package.json`, `vite.config.js`, `index.html`, `.gitignore`, `.env.example`, `src/main.jsx`, `src/App.jsx`, `src/styles.css`, `src/supabase.js`, `src/components/**`, stub `src/pages/*Page.jsx` |
| S2 | `src/lib/status.js`, `status.test.mjs`, `postHealth.js`, `postHealth.test.mjs`, `api.js`, `week.js`, `useMarketingData.js` |
| S3 | `src/pages/TodayPage.jsx`, `src/fixtures/week.js` |
| S4 | `src/pages/CalendarPage.jsx`, `src/pages/ApprovalInboxPage.jsx`, `src/fixtures/approval.js`, `src/pages/ApprovalInboxPage.test.mjs` |
| S5 | `src/pages/ContentDetailPage.jsx`, `WebsiteTasksPage.jsx`, `OperationsPage.jsx`, `src/fixtures/detail.js` |
| S6 | `src/pages/PerformancePage.jsx`, `src/lib/performance.js`, `src/fixtures/performance.js` |
| S7 | `src/lib/guard.js`, `src/lib/guard.test.mjs`, `marketing-control/README.md` |

---

## 5. Acceptance criteria (this run)

1. `marketing-control/` builds (`npm run build`) and `npm test` passes.
2. The app is **read-only**: grep/audit proves no Supabase mutation call reaches the client; all write buttons are disabled with an explanatory tooltip.
3. The app renders, against live Supabase (anon key), at minimum: this week's posts with status, approval queue, active faults, latest run health, and basic performance signals.
4. No file outside `marketing-control/` in this worktree was modified. The two live repos are untouched.
5. Audit evidence is committed under `marketing-control/docs/`.
6. No `git push`/`git fetch`; commits are file-scoped.

---

## 6. Non-goals (this run)

- Editing the live SEO engine or MCC (no file in `C:\Workspace\Active\*` changes).
- New write endpoints, command queue, or worker lease (Phase 2).
- Facebook/GBP/website automation changes.
- Combining homelab/agent/estimate features into the marketing app.
- Autonomous live publishing beyond existing policy.
- Migrating Supabase data or adding RLS (flag as Phase-2 prerequisite; read-only Phase 1 does not require it).

---

## 7. Deferred roadmap (gated — do NOT execute this run)

- **Phase 2:** `commands`/`command_attempts` tables; worker claims one command via lease; `marketing-control` submits validated commands (not direct HTTP to mav-bridge); start with one low-risk action type; MCC path stays as fallback.
- **Phase 3:** cutover approvals/retries/dismissals; retire MCC SEO proxy after one full weekly cycle with rollback.
- **Phase 4:** extract stable interfaces (planning, scheduling, adapters, persistence, command execution, observability); single schedule parser consumed by sync/insights/boost; regression tests for the untested transitions (no-show watchdog, `getWeekOf` TZ bug, crash-after-claim, post-success-before-write, stale idempotency locks, `website.py:147` fence bug).
- **Phase 5:** MCC's independent future (narrow to infra / maintenance / retire).

---

## 8. Rollback / contingency

- Every session is a separate commit; `git revert <sha>` undoes any slice.
- The live SEO workflow, MCC, PM2, and Task Scheduler are never touched — production behavior is unaffected by any failure in this run.
- If the app cannot reach Supabase (missing anon key), it degrades to a clear "not configured" state with `.env.example` guidance — never a crash.

---

## 9. Review notes (Grok 4.6, 2026-08-30)

Reviewed against `artifacts/audit-20260830/research/{flow,data,adapters,tests,mcc,ux,secops}.md` plus live copies of `scripts/lib/seo-run-status.mjs`, MCC `src/lib/seoRules.js`, `supabase/schema.sql`, and MCC `package.json` (React 19.2 / Vite 7 / `@supabase/supabase-js` ^2.108.1).

**Verdict:** Execute Phases 0–1. The slice is the right cut: no engine rewrite, no MCC edits, no writes. The audit supports a read-only operator surface against existing Supabase SELECTs.

**Plan errors corrected above (do not re-litigate):**

1. S1 nav listed 6 screens; UX §7 requires Content Detail as the seventh. Stubs + routing land in S1.
2. `fetchLatestRunHealth()` is not a table. Derive from `seo_runs` + `weekly_posts` + `liveRunStatus`. Optional GET to mav-bridge; degrade if down.
3. Wave-2 `──` looked sequential while the comment said parallel. Graph + ownership table now make that explicit.
4. Parallel page sessions would collide on `App.jsx` unless S1 owns the router and stubs. Ownership table forbids later sessions from touching S1 files.
5. This worktree has no `outputs/`. Performance ships fixtures; optional `VITE_OUTPUTS_DIR`; never read/write `C:\Workspace\Active\*`.
6. MCC `postHealth` tests use vitest `expect`; port them to `node:test` + `node:assert/strict` to match `seo-run-status.test.mjs`.
7. Subagent git commits on one branch race. Executor commits with explicit paths. Still no `git add -A`, no `git push`/`git fetch`.
8. Anon key is already in MCC's Vite bundle; `schema.sql` has no RLS. Client-side mutation guard is required and **not sufficient** if live RLS is off — Phase-2 prerequisite, documented in AUDIT-FINDINGS. Phase 1 still issues zero mutation calls.
9. America/Chicago date math is load-bearing (UTC rollover after 19:00 CT). Port the MCC `en-CA` + `America/Chicago` today helper into `week.js`.
10. Needs-recovery is first-class in UX; S3 must render it, not only POST TODAY chips.

**Non-goals remain gated.** Do not start Phases 2–5.

**Live env:** `marketing-control/.env` is gitignored. Executor may copy `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from MCC's existing Vite env **without printing values**. Missing env → "not configured" UI, not a crash.
