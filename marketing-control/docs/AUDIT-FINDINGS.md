# AUDIT-FINDINGS

**Run:** mktg-consolidation-20260830
**Date:** 2026-08-30
**Sources:** `artifacts/audit-20260830/research/{flow,data,adapters,tests,mcc,ux,secops}.md` (archived at `marketing-control/docs/audit/`)
**Checked against live copies in this worktree / MCC checkout:** `scripts/lib/seo-run-status.mjs`, `supabase/schema.sql`, `src/seo_agents/website.py`, `scripts/supabase-sync.mjs`, MCC `src/lib/seoRules.js`, MCC `package.json`

How to read this document:

- **FACT** — observed in code, schema, or a dated incident write-up.
- **INFERENCE** — risk, likely impact, or recommended later phase. Not a live proof.

Phase 1 (this run) is read-only. Findings marked **out of scope for this slice** must not be “fixed” by editing MCC or the live SEO engine.

---

## Severity index

| Sev | ID | Finding | Phase |
|---|---|---|---|
| **Critical** | C1 | MCC `/api/build/apply` unauthenticated file-write + PM2 exec on `0.0.0.0:3000` | Out of scope (MCC not edited) |
| **High** | H1 | CORS wildcard `*.vercel.app` / `*.ts.net` on the same listener | Out of scope |
| **High** | H2 | Secrets duplicated into PM2 `env:` / `dump.pm2` | Out of scope |
| **High** | H3 | `seo-monitor.mjs` + `seo-watchdog.mjs` untested (2026-07-24 no-show chain) | Phase 4 |
| **High** | H4 | `supabase-sync.mjs` untested; `getWeekOf` TZ / clock-keying bug | Phase 4 |
| **High** | H5 | `run-weekly-seo.py` untested | Phase 4 |
| **High** | H6 | Parser fan-out (6+ FB schedule grammars) | Phase 4 |
| **High** | H7 | Mutate-after-sync: DB snapshot ≠ posted content | Phase 4 |
| **High** | H8 | `week_of` derived from run clock, not schedule content | Phase 4 |
| **High** | H9 | `website.py:147` fence-strip `TypeError` | Phase 4 |
| **High** | H10 | GBP crash-window duplicate risk (driver success → archive write) | Phase 4 |
| **High** | H11 | Anon-key write/delete risk **if live RLS is off** | **Phase-2 prerequisite** |
| **Medium** | M1 | No RLS in `schema.sql` or migrations (live state unverifiable) | Phase-2 prerequisite |
| **Medium** | M2 | Dual dashboard status derivations | Phase 1 picks `liveRunStatus`; MCC leftover is out of scope |
| **Medium** | M3 | Performance data collected but never surfaced | Phase 1 surfaces fixtures/reports |
| **Medium** | M4 | Re-sync clobber (run reset to `pending_approval`; duplicate day rows) | Phase 4 |
| **Medium** | M5 | Status vocabulary drift (11+ live vs 7 documented) | Phase 4 |
| **Medium** | M6 | Boost money lives only in markdown | Phase 2+ |
| **Medium** | M7 | Shared `SUPABASE_SERVICE_KEY` across 2 repos / 4+ processes | Phase 2+ |
| **Medium** | M8 | Stale `.env.bak-*` files keep rotated secrets | Ops |
| **Medium** | M9 | Monitor coverage: console only 14h/week; 3 PM2 apps unwatched | Ops |
| **Medium** | M10 | `tests/conftest.py` output-path fixture is a no-op | Phase 4 |
| **Medium** | M11 | No `npm test`, no CI, mixed mjs conventions | Phase 1 adds `node --test` for the new app only |
| **Medium** | M12 | Facebook: no Graph-create idempotency; post-success-before-write; duplicate week resume | Phase 4 |
| **Medium** | M13 | Python `.lock-{action_id}` stale locks have no TTL | Phase 4 |
| **Medium** | M14 | `POST /api/realtime-token` unauthenticated | Out of scope |
| **Low** | L1 | Hard-coded `C:\Workspace`, `M:\`, `H:\`, `192.168.1.12` | Migration / Phase 5 |
| **Low** | L2 | `.env.example` incomplete + contains PII placeholders | Ops |
| **Low** | L3 | `reset-gbp-scheduled.mjs` has no status guard | Phase 4 |
| **Low** | L4 | Two `gbp-poster/driver.mjs` copies (repo vs `~/.claude/skills`) | Phase 4 |
| **Low** | L5 | Local op-state (`approval-notified.json`) not in Supabase | Phase 2 |
| **Low** | L6 | T10 “watchdog” pytest is tautological | Phase 4 |
| **Low** | L7 | Repo noise (`CWorkspaceActive…` dir, `nul`, `logs.txt`) | Cleanup |

---

## Critical

### C1 — MCC `/api/build/apply` unauthenticated write + PM2 exec

**Severity:** Critical. **Out of scope for this slice** (MCC is not edited). This is why MCC must not become the marketing control plane.

**FACTS** (`secops.md`):

- `POST /api/build/apply` (`MCC/routes/build.mjs`) accepts absolute paths that survive `resolveSafePath` (`MCC/lib/exec.mjs`). The blocklist covers system dirs / `.git` / `.env` only — not the rest of `C:`.
- The handler overwrites or deletes the target, then `execSync`s `pm2 start` / `pm2 restart`.
- Same listener: `server.mjs` binds `0.0.0.0:3000`. No auth on this route.
- CORS grants browser-callable access when `origin.endsWith('.vercel.app')` or `origin.endsWith('.ts.net')` (`server.mjs`), bypassing `ALLOWED_ORIGINS`.
- Sibling unauthenticated mutating routes on the same port include `/api/list-dirs` (defaults to `C:\`), `/api/workflows/seo/actions/{approve,run,dismiss,retry,clear-fault}`, `/api/orchestrator/*`, `/api/chat`, `/api/build-chat`, `/api/extract-file`.

**INFERENCE:** Any LAN host, or any `*.vercel.app` page visited by a browser that can reach :3000, can rewrite a script a scheduled task or PM2 will run and then restart processes. CORS is not authentication; non-browser callers on the LAN are unblocked even without the wildcard.

**Do not fix in Phases 0–1.** Flag only.

---

## High

### H1 — CORS wildcard

**FACTS:** `origin.endsWith('.vercel.app') \|\| origin.endsWith('.ts.net')` on MCC `server.mjs`. `ALLOWED_ORIGINS` exists but is bypassed.

**INFERENCE:** An attacker’s Vercel app or any Tailscale host gets browser access to C1 and the SEO action proxies.

**Out of scope** (MCC).

### H2 — Secrets in PM2 `env:` block

**FACTS:** MCC `ecosystem.config.cjs` copies `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_NIM_API_KEY`, `SUPABASE_SERVICE_KEY`, `THUMBTACK_WEBHOOK_SECRET` into the `mav-console` `env:` block. After `pm2 save` these persist in `~/.pm2/dump.pm2`. Sibling apps already use `env_file`.

**INFERENCE:** Key material is visible to `pm2 jlist` / `pm2 describe` and to anyone who can read the dump. Prefer `env_file` / in-process dotenv.

**Out of scope.**

### H3 — Untested `seo-monitor.mjs` + `seo-watchdog.mjs`

**FACTS** (`tests.md`, `flow.md`):

- Zero automated tests for `seo-monitor.mjs` (no-show alarm, cold-boot `pm2 resurrect`, missing-env `process.exit(1)` with no alert) and all of `seo-watchdog.mjs`.
- `lib/hermes-alert.mjs` untested.
- `test_research_regression.py` T10 constructs `ExecutionTask` objects and asserts fields just set — it never calls the JS watchdogs.
- 2026-07-24 silent miss: monitor shared the Friday trigger with the run it watched.

**INFERENCE:** A regression reintroduces a silent missed week. **Severity: High.**

**Phase 4.** Do not start in this run.

### H4 — Untested `supabase-sync.mjs` and `getWeekOf` TZ / clock-keying bug

**FACTS:**

- `scripts/supabase-sync.mjs` has no tests (`tests.md`).
- `seo_runs.week_of` is unique and is the upsert `onConflict` key.
- `getWeekOf()` computes **next Monday from run clock**, not from schedule headers (`data.md` F3; `scripts/supabase-sync.mjs`). `_run_supabase_sync()` in `main.py` passes **no `--week-of`**.
- Incident: HANDOFF-2026-07-31 “SEPARATE BUG” — a 2026-07-28 22:53 manual run used `.toISOString()` on a local `Date`, rolled the calendar date after ~19:00 CDT, and filed `week_of` as **2026-08-04** (a Tuesday). Posts were stranded under a week no other query looked at.
- Observed content mismatch: `gbp_posting_schedule.md` Start Date **2026-08-28** vs `facebook_posting_schedule.md` Week of **August 31**, both under one `week_of`.
- **Live source in this worktree (2026-08-30):** `getWeekOf()` (`scripts/supabase-sync.mjs:43-55`) formats with local `getFullYear` / `getMonth` / `getDate` and no longer calls `.toISOString()`. The comment documents the 2026-07-28 incident. The function remains clock-derived and untested.

**INFERENCE:** The original UTC rollover is not present in current source. Residual risk: host TZ ≠ America/Chicago; off-schedule runs still key the week from the clock; two schedule files can disagree under one unique key; a regression of `.toISOString()` would not be caught.

**Phase 4** (engine). Phase 1 dashboard uses America/Chicago date math in `week.js` (PLAN §9.9) and does not call `getWeekOf`.

### H5 — Untested `run-weekly-seo.py`

**FACTS:** Friday entry point that writes `weekly-runner-health.json` (the no-show marker) has no tests. Engine-side failure classification is tested; the wrapper that maps phase failures onto that marker is not.

**INFERENCE:** Health-marker contract can drift without failing CI (there is no CI).

### H6 — Parser fan-out

**FACTS** (`data.md` F4): `facebook_posting_schedule.md` is parsed by at least six independent implementations:

1. `facebook-poster.mjs` `parseScheduleText` (canonical; ~18 fields)
2. `supabase-sync.mjs` (hand-mirrored subset — **drops 8 fields**)
3. `facebook-insights-collector.mjs` (copy)
4. `fb-boost-api.mjs` `scheduleBlockForPick`
5. `fb-boost-ledger.mjs` `scheduleWeekStart` + `parseSummary` (BOOST BUDGET SUMMARY table)
6. `fb-photo-pick.mjs` / `fb-photo-rewrite.mjs` / `slideshow-reel.mjs` / `fix-empty-caption-week.mjs` / `fb-fix-scheduled-photo.mjs`

GBP: `parseGbpSchedule` drops `CAPTION` / `TOPIC` / `TREND_TIE`. Website: `parse-website-tasks.mjs` uses defensive heuristics (`isFormatInstructionTitle`) after repeated format breakage.

Silent loss: `parseFacebookSchedule` drops posts whose DATE/DAY fail `day > 0 && /^\d{4}-\d{2}-\d{2}$/` with only “No Facebook posts found”.

**INFERENCE:** A format change breaks parsers independently and silently. Highest-leverage schema/parser cleanup; **not this slice**.

### H7 — Mutate-after-sync

**FACTS:** Content flows file → DB once. Before posting, mav-bridge runs `gbp-photo-pick.mjs` then `fb-photo-rewrite.mjs` on the markdown. `facebook-poster.mjs` reads the **mutated file**, not the DB. `weekly_posts` hook/body/`photo_file` are a pre-mutation snapshot.

**INFERENCE:** When DB and file disagree about what was posted, the file (plus `run_logs` + `platform_post_id`) wins. A read-only dashboard on Supabase shows the snapshot, not necessarily the posted caption/photo.

### H8 — `week_of` keying

Covered under H4. Ranked High because it is the unique key and has a documented incident.

### H9 — `website.py:147` fence-strip bug

**FACTS** (`adapters.md`; confirmed `src/seo_agents/website.py:143-148`):

```python
stripped = re.sub(r"\s*```\s*$", "", "", stripped)
```

The third argument to `re.sub` is `count`. Passing `stripped` (a `str`) raises `TypeError` whenever input starts with a code fence. `apply_edit` calls `strip_fences` on HTML and on blog body. LLM website edits are frequently fenced. The exception is not caught in `run_action` → unstructured crash, not an `adapter_failed` record (lock released in `enforce_idempotency` `finally`).

**INFERENCE:** A routine LLM formatting quirk crashes the live website path.

**Phase 4.** Do not edit `website.py` in this run.

### H10 — GBP crash-window duplicate risk

**FACTS** (`adapters.md`):

- Clean path is strong: workbook `Posted` gate, `submitted` flag (never re-click Post), exit-code contract 0/3/4/5, exit-3 never maps to `scheduled`.
- Between driver success and `applyDriverResult` / `markGbpPostedAndArchive`, neither Supabase nor the workbook is updated.
- mav-bridge 30-min TTL resets `posting` → `error`.
- Dashboard GBP retry sets `scheduled`; same-day daily cron re-runs.
- Driver does **no** pre-submit “already visible today” check. Human-facing strings say “check before retry”.

**INFERENCE:** Crash in that window + retry → **duplicate GBP post**. Partially handled, not closed.

**Phase 4.**

### H11 — Anon-key write risk if live RLS is off (Phase-2 prerequisite)

**FACTS:**

- MCC Vite bundle ships `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (`secops.md`, `data.md` F1). Anon client already reads SEO tables (`useMetrics.js` fallback).
- `supabase/schema.sql` and `supabase/migrations/` (`001_unique_week_of.sql`, `002_add_media_status.sql`) contain **no** `ENABLE ROW LEVEL SECURITY` and **no** policies. Live RLS state is unverifiable from the repo.
- Service-role key is used by workers for all writes.

**INFERENCE:** If live RLS is disabled (schema never enables it), the anon key that Phase 1 will also ship can INSERT/UPDATE/DELETE SEO tables from any browser that has the bundle. A client-side mutation guard (throw on `.insert/.update/.delete/.upsert/.rpc`) is **required and not sufficient**. Enabling RLS (or confirming it is already on, SELECT-only for anon) is a **Phase-2 prerequisite**, not a Phase-1 blocker — Phase 1 still issues zero mutation calls.

See also M1.

---

## Medium

### M1 — No RLS in `schema.sql`

**FACTS:** Full read of `supabase/schema.sql` (tables, indexes, `set_updated_at` triggers, realtime publication). Zero RLS. Migrations 001–002 do not add it.

**INFERENCE:** Repo cannot prove what the hosted project enforces. Treat as unverified. Pairs with H11.

### M2 — Dual dashboard derivations

**FACTS** (`data.md` F6; `seo-run-status.mjs`):

- mav-bridge `GET /seo/status` uses `liveRunStatus(run, weekly_posts)` with a 28-day window. Terminal posts (`skipped` / `rejected` / `scheduled_native` / …) count as finished; frozen `rejected` ≠ executing.
- MCC fallback `fetchSeoFromSupabase` buckets **raw `seo_runs.status`** (`done`→complete, `posting|posted`→partial, …) — different algorithm, no window, no post-level derivation.
- There is **no** `run_health` table. `outputs/run_health.json` is a local file. mav-bridge currently returns `runHealth: null`.

**INFERENCE:** Same MCC page, two answers depending on whether the proxy is up.

**Phase 1:** Marketing Control copies `liveRunStatus` and derives `fetchLatestRunHealth()` from `seo_runs` + `weekly_posts`. It does not reimplement the MCC fallback.

### M3 — Performance data collected but never surfaced

**FACTS** (`ux.md`):

- Collectors exist: `facebook-insights-collector.mjs` → `outputs/facebook_engagement_report.md`; `gbp-analytics-collector.mjs`; `fb-boost-api.mjs` + `fb-boost-ledger.mjs`; weekly baselines under `knowledge/baselines/`.
- MCC `src/config/metrics.js` is homelab infra only (CPU/RAM/GPU/disk/network). No marketing KPI is rendered.

**INFERENCE:** The Learn step of the weekly loop is invisible to the operator.

**Phase 1 S6** surfaces fixture copies / optional `VITE_OUTPUTS_DIR` reads. Week-over-week trends need a structured store (Phase 2).

### M4 — Re-sync clobber

**FACTS:** Non-`--tasks-only` `supabase-sync.mjs` upserts `{status:'pending_approval', execute_completed_at:now}` on `week_of`. Re-running sync for a week already `done`/`posted` resets the run row and re-inserts pending posts alongside posted rows for the same days (delete only removes `status='pending_approval'`). FB re-exec is partly guarded by `platform_post_id`; GBP relies on worker CAS.

### M5 — Status vocabulary drift

**FACTS:** Schema comments list ~7 statuses. Live code uses `needs_verification`, `scheduled_native`, `rejected`, `dismissed`, `cancelled`, `awaiting_prompt` (none in schema comments). Text columns; nothing enforces the enum. `weekly_posts.type` comment is `'video'|'photo'|'text'`; live files use `slideshow` / `carousel`. `day` comment says “null for GBP”; `parseGbpSchedule` writes 1–7.

### M6 — Boost money in markdown only

**FACTS:** `$50/wk` cap and BOOST BUDGET SUMMARY live in `facebook_posting_schedule.md`. `weekly_posts` has no boost columns. Ledger eligibility parses that prose (`fb-boost-ledger.mjs`). Comment on the table: some rows are “conditional … not machine-decidable”.

**INFERENCE:** Supabase cannot answer “what did we plan to spend”.

### M7 — Shared service-role key

**FACTS:** One `SUPABASE_SERVICE_KEY` consumed by seo-monitor, mav-bridge, prometheus-sync, and mav-console.

**INFERENCE:** prometheus-sync only needs `INSERT` into metrics. Least privilege = separate roles. Phase 2+.

### M8 — Stale `.env.bak-*`

**FACTS:** 6 SEO + 2 MCC gitignored backups. MCC `.gitignore` comment: they “hold old secrets”.

**INFERENCE:** Rotated credentials remain on disk.

### M9 — Monitor coverage gaps

**FACTS:** seo-monitor watches `mav-bridge` / `mav-console` / `prometheus-sync` during the Friday 14h window only. Not watched: `downloads-watcher`, `mcc-dashboard-agent`, `fb-comment-agent`. Watchdog does not HTTP-probe those either.

### M10 — `tests/conftest.py` no-op fixture

**FACTS:** `fix_output_dir` docstring claims it patches writers to a test output dir. Body sets `test_output = real_output` and patches nothing. Protection is per-test `tmp_path` / monkeypatch only.

**INFERENCE:** Safety net is illusory; a new test that forgets to patch writes to real `outputs/`.

### M11 — No test wiring in the SEO app

**FACTS:** SEO `package.json` has `lint` only — no `test` script. No `.github/workflows`. `pyproject.toml` has no pytest config. Mixed `node:test` vs bare-assert selfchecks. `facebook-poster.selfcheck.mjs` is outside the `*.test.mjs` glob.

**Phase 1** adds `node --test src/**/*.test.mjs` on the **new** app only. Do not add CI to the live SEO repo.

### M12 — Facebook adapter crash windows

**FACTS** (`adapters.md`):

- No Graph-create idempotency key; no “already posted today” pre-check. First-comment is the only idempotent Graph write.
- Token retry once on Graph 190/102. Main post dispatch has no retry. No in-poster read-back; reconcile is in mav-bridge and only inspects **scheduled** rows by post id.
- Post-success-before-write: Graph create succeeds, process dies before Supabase / run record → re-run duplicates. `FACEBOOK_POSTER_TIMEOUT_S=900` vs up-to-13-min video + comments is tight; exit 124 classifies as `transient_retry`.
- `runWeek` claims all days to `posting` before the batch; mid-batch crash → TTL → retry re-posts live days.
- Parse-failure path in mav-bridge can mark **all** `posting` rows `posted` (false-positive; reconcile never rechecks those).

### M13 — Stale Python idempotency locks

**FACTS:** `enforce_idempotency` uses `O_CREAT|O_EXCL` `outputs/action_runs/.lock-{action_id}`. No TTL, no cleanup, no test. Hard crash during live `run_action` leaves the lock forever → later live calls return `concurrent_retry`.

### M14 — Unauthenticated `/api/realtime-token`

**FACTS:** MCC mints an OpenAI Realtime session with server-side `OPENAI_REALTIME_KEY` / `OPENAI_API_KEY` and returns the ephemeral `client_secret` to any caller.

**Out of scope.**

---

## Low

### L1 — Hard-coded topology

`\\192.168.1.12\Proxmox`, `192.168.1.12:9090/8181/4000`, absolute `C:\Users\carte\…` and `C:\Workspace\…` in both ecosystems, `config.mjs`, `setup-scheduled-tasks.ps1`. Windows-only; zero AIWA awareness.

### L2 — `.env.example` incomplete

Missing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SEO_NO_SHOW_DEADLINE`, `SEO_RUN_DOW`, and other monitor-required vars. New host → monitor exits instantly with no alert (HANDOFF #6). Example also contains a real SMS number and gmail address (PII).

### L3 — `reset-gbp-scheduled.mjs`

No status filter (can reset `posted` rows → re-post risk). Logs `row.topic` which is not in the `.select()`.

### L4 — Driver path drift

`actions.py` GBP defaults to skill/plugin copies outside the repo; `gbp-worker` uses the repo `scripts/gbp-poster/driver.mjs`.

### L5 — Local op-state

`approval-notified.json` loss → duplicate SMS. `alerted.json` loss is handled by cold-start baseline. MCC `seoTaskLog` is a single-node file, lost on MCC reinstall; Supabase `run_logs` records pipeline events, not approvals.

### L6 — Tautological T10 tests

Apparent watchdog coverage that does not call production watchdog code.

### L7 — Repo noise

Mangled directory `CWorkspaceActiveSEO-Agents-Apptestsfixturesresearchartifacts/`, a `nul` file, `logs.txt`.

---

## Adapter / engine facts (not extra severities)

| Adapter | Approval | Idempotency | Verify | Retry / rollback |
|---|---|---|---|---|
| Facebook `facebook-poster.mjs` | Weekly: `--dry-run` + upstream CAS on `approved`. Python: dispatch gate | None at Graph-create; first-comment state file | Graph id on create; scheduled reconcile in bridge | Token 190/102 once; no unpost |
| GBP `gbp-poster/driver.mjs` + `gbp-worker.mjs` | Workbook `Approved` else exit 4; policy exit 5; CAS `approved→posting` | `Posted` + `submitted` flag | Inline verify; retro `verify-gbp-posts.mjs`; exit 3 = unverified | Pre-submit only, max 2, `ui_changed_or_timeout` only. No unpost |
| Website `website.py` | None in adapter; `actions.py` gate | None. Identical blog re-run → `git commit` fails → `adapter_failed` | Pre-commit `validate_index`; no post-push deploy check | Manual git revert |

`gbp-post-once.mjs` is a hardcoded one-shot: no approval, no policy, prints `{verified:true}` with no verification.

Python dispatch gate: 12 checks before every adapter call (`tests/test_dispatch_gate.py` covers this). **Covered:** engine idempotency, evidence/claims, failure classification, dry-run isolation, run lock, LLM failover, GBP runner exit codes, website task runner/parser, FB media selection, name guard, `liveRunStatus` mapping.

**Untested (high):** H3, H4, H5, plus `mav-bridge.mjs` top-level, `gbp-worker.mjs` poller, video generators, alert transports, scheduled-task scripts.

---

## MCC decomposition (facts)

SEO approval in MCC is a **thin proxy**: `SEOApprovalPage.jsx` → `src/lib/api.js` → `server.mjs` `/api/workflows/seo/*` → `routes/seo.mjs` → `lib/models.mjs::callSeoApp()` → `http://127.0.0.1:8790`. No AI, no file I/O, no DB writes on the SEO path itself.

**SEO-essential:** `SEOApprovalPage.jsx`, `seoRules.js` (`postHealth`), `routes/seo.mjs`, `lib/http.mjs`, `lib/load-env.mjs`, plus splinters `callSeoApp` / `logSeoEvent` / `seoAppUrl`.

**RETIRE (independent of SEO):** `chat.mjs`, `exec.mjs`, `prompts.mjs`, `self-improve.mjs`, `llama-status`, `zai-status`, `memory`, `extract`, `ops-notify`, `thumbtack-*` (5), `orchestrator.mjs`, `build.mjs`, `HomePage.jsx`, `MaverickPage.jsx`, etc.

Two bridges: live path is SEO `mav-bridge.mjs`. MCC `ops/windows-bridge/mav-repo-bridge.mjs` is a file-scan + CLI leftover (no dismiss/retry/posts/week).

---

## UX facts that bind Phase 1 IA

Today’s whole marketing UI is one page (`SEOApprovalPage.jsx`). Derived IA — **7 screens** + a first-class **Needs recovery** zone:

1. Today / This Week
2. Content Calendar
3. Approval Inbox
4. **Content Detail** (seventh; not optional)
5. Website Tasks
6. Performance
7. Operations

`postHealth()` (MCC `src/lib/seoRules.js`): RED if `media_status` is `downgraded|none`, or `platform_post_id` is null on a `posted` row, or `type === 'video'` but media isn’t; GREEN only when `status === 'posted'` with none of those; else neutral.

Read-only slice is implementable against existing Supabase SELECTs + GET `/seo/status`, `/seo/actions`, `/seo/posts/week`. This worktree has no `outputs/`; Performance ships fixtures.

MCC `package.json`: React `^19.2.1`, Vite `^7.2.7`, `@supabase/supabase-js` `^2.108.1`. `seoRules.test.js` uses vitest `expect` (vitest is a MCC devDependency). SEO `seo-run-status.test.mjs` uses `node:test` + `node:assert/strict`.

---

## Positive patterns to reuse (not findings)

- Bearer-gated photo upload, fail-closed if token unset.
- Thumbtack config fail-closed.
- `alertOnce` dedup + dual-channel alerts + explicit all-channels-failed line.
- Double-trigger watchdog (daily, independent of Friday).
- Ecosystem comments documenting retired processes.
- GBP submitted-flag + exit-code contract.
- Python dispatch gate + `live_unverified` never auto-retried on GBP exit 3.

---

## Phase mapping for this run

| Do now (Phases 0–1) | Do not start |
|---|---|
| Archive these findings; inventory; 7-screen read-only dashboard; `liveRunStatus` + `postHealth` ports; America/Chicago `week.js`; client mutation guard; surface performance fixtures; Needs recovery zone | C1/H1/H2/M14 MCC hardening; RLS enablement (document as Phase-2 prerequisite, H11/M1); engine parser/sync/adapter/watchdog tests (Phase 4); command queue (Phase 2); MCC cutover (Phase 3); MCC retire (Phase 5) |
