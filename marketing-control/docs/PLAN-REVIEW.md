# PLAN-REVIEW

**Subject:** `PLAN.md` — Grizzly Marketing Control (run `mktg-consolidation-20260830`)
**Reviewer:** Grok 4.6
**Date:** 2026-08-30
**Status:** REVIEWED — execute Phases 0–1 only

---

## Evidence reviewed

Seven research reports (2026-08-30 audit):

| Report | Path |
|---|---|
| flow | `artifacts/audit-20260830/research/flow.md` |
| data | `artifacts/audit-20260830/research/data.md` |
| adapters | `artifacts/audit-20260830/research/adapters.md` |
| tests | `artifacts/audit-20260830/research/tests.md` |
| mcc | `artifacts/audit-20260830/research/mcc.md` |
| ux | `artifacts/audit-20260830/research/ux.md` |
| secops | `artifacts/audit-20260830/research/secops.md` |

Plus live copies (read, not edited):

| File | What was checked |
|---|---|
| `scripts/lib/seo-run-status.mjs` | `liveRunStatus` is a pure derivation from a run row + `weekly_posts`. No `run_health` table. `TERMINAL_*` sets include `scheduled_native` / `skipped` / `rejected`. 28-day `countRunStatuses` window. |
| `scripts/lib/seo-run-status.test.mjs` | `node:test` + `node:assert/strict` (the convention Phase 1 tests must match). |
| MCC `src/lib/seoRules.js` | `postHealth()` RED/GREEN/neutral rules as UX/PLAN describe. |
| MCC `src/lib/seoRules.test.js` | vitest `expect(…).toEqual(…)` — not portable as-is. |
| `supabase/schema.sql` | Tables `seo_runs`, `weekly_posts`, `website_tasks`, `run_logs`. **No RLS**, no policies. Status comments are a subset of live vocabulary. |
| MCC `package.json` | `react` `^19.2.1`, `vite` `^7.2.7`, `@supabase/supabase-js` `^2.108.1`, vitest in `devDependencies`. Stack match for S1. |

---

## Verdict

**Execute Phases 0–1 only.**

The slice is the right cut: no engine rewrite, no MCC edits, no writes, no live-repo changes. The audit supports a private read-only operator surface against existing Supabase SELECTs plus optional GET to mav-bridge.

**Do not start Phases 2–5** in this run. Non-goals remain gated: command/attempt model, worker lease, cutover, engine hardening, MCC retire, RLS migration.

---

## Confirmed plan facts (post-correction)

- Phase 1 is read-only. Write buttons render disabled. Zero POST calls. Client guard rejects `.insert/.update/.delete/.upsert/.rpc`.
- All new code lands under `marketing-control/` in this worktree. Live repos (`C:\Workspace\Active\SEO-Agents-App`, `C:\Workspace\Active\MCC`) are out of scope for edits.
- Nav is **7 screens**: Today, Calendar, Approval Inbox, Content Detail, Website Tasks, Performance, Operations.
- `fetchLatestRunHealth()` is **derived**, not a table. Optional GET `VITE_SEO_STATUS_URL`; degrade if unset/down. mav-bridge currently returns `runHealth: null`.
- S3–S6 are **parallel** after S2 (file-disjoint). S1 owns router + stubs. S7 last.
- Subagents do **not** commit. Executor commits with explicit paths. No `git add -A`, no `git push` / `git fetch`.
- This worktree has no `outputs/`. Performance uses fixtures; optional `VITE_OUTPUTS_DIR`; never read/write `C:\Workspace\Active\*`.
- Port `postHealth` tests to `node:test` + `node:assert/strict`, not vitest.
- America/Chicago date math is load-bearing (UTC midnight falsely marks tomorrow as today after 19:00 CT).
- Needs recovery is first-class on Today (`error` / `needs_verification` / stuck `posting`).
- Anon key is already in MCC’s Vite bundle; `schema.sql` has no RLS. Client guard is required and **not sufficient** if live RLS is off — documented in `AUDIT-FINDINGS.md` (H11 / M1) as a Phase-2 prerequisite. Phase 1 still issues zero mutation calls.

---

## The 10 corrections now in PLAN.md §9

These were plan errors found in review. They are already applied in `PLAN.md`. Do not re-litigate.

1. **Content Detail is the 7th screen.** S1 nav listed 6 screens; UX §7 requires Content Detail as the seventh. Stubs + routing land in S1.
2. **`fetchLatestRunHealth` is derived, not a table.** Derive from `seo_runs` + `weekly_posts` + `liveRunStatus`. Optional GET to mav-bridge; degrade if down. There is no `run_health` table; `outputs/run_health.json` is a local file.
3. **Wave 2 is parallel.** Wave-2 `──` looked sequential while the comment said parallel. Graph + ownership table now make that explicit. S3–S6 are file-disjoint after S2.
4. **S1 owns router/stubs.** Parallel page sessions would collide on `App.jsx` unless S1 owns the router and stubs. Ownership table forbids later sessions from touching S1 files.
5. **Fixtures, not Active outputs.** This worktree has no `outputs/`. Performance ships fixtures; optional `VITE_OUTPUTS_DIR`; never read/write `C:\Workspace\Active\*`.
6. **`node:test`, not vitest.** MCC `postHealth` tests use vitest `expect`; port them to `node:test` + `node:assert/strict` to match `seo-run-status.test.mjs`.
7. **Executor commits.** Subagent git commits on one branch race. Executor commits with explicit paths. Still no `git add -A`, no `git push` / `git fetch`.
8. **RLS client guard is insufficient.** Anon key is already in MCC’s Vite bundle; `schema.sql` has no RLS. Client-side mutation guard is required and **not sufficient** if live RLS is off — Phase-2 prerequisite, documented in `AUDIT-FINDINGS.md`. Phase 1 still issues zero mutation calls.
9. **America/Chicago dates.** UTC rollover after 19:00 CT. Port the MCC `en-CA` + `America/Chicago` today helper into `week.js`.
10. **Needs recovery on Today.** First-class in UX; S3 must render it, not only POST TODAY chips.

---

## Out of scope (reaffirmed)

| Item | Why gated |
|---|---|
| MCC `/api/build/apply` unauth (Critical) | MCC not edited this run |
| Enable / verify live RLS | Phase-2 prerequisite; not required for read-only SELECTs |
| Fix `getWeekOf`, `website.py:147`, GBP crash window, parser fan-out | Phase 4 engine |
| Tests for seo-monitor / seo-watchdog / supabase-sync | Phase 4 |
| Command queue, approvals, retries | Phase 2–3 |
| MCC retire / split | Phase 5 |

---

## Execution contract for remaining sessions

File ownership is in `PLAN.md` §4. S0 owns `marketing-control/docs/**` only. Later sessions must not edit S0 files except S7’s README (outside `docs/`).
