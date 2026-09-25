# Weekly SEO Pipeline — Final Integrated Execution Plan

**STATUS: PROPOSED. Awaiting Carter's separate implementation approval. Nothing in this document
authorizes execution, live actions, or spend. This document itself is approved for public
publication as a sanitized plan (see 2.5); that approval does not extend to other documents.**

Drafted 2026-09-24 by Jefe (glm-4.7), then polished by replacement Jefe (gpt-6-sol), from the shared brief of the three-reviewer
session: Karen (gpt-6-astra), Darren (claude-opus-5-5), Grok (grok-4.7); the T22 timing split remains open. Inputs (evidence only,
none modified): two prior audit plans (local copies `snug-singing-scone.md`,
`snug-singing-scone-codex.md`; private paths withheld) and the root `PLAN.md` execution plan
(2026-09-13, tasks T1-T21, uncommitted). Audit baseline: HEAD `6a1aa46`, `PLAN.md` the only
modified file, the root plan reported none of T1-T21 built at its writing; this review did not re-verify that status.

---

## 0. How to use this plan

- Section 1: evidence layers and safety rules. Section 2: decisions (Carter's D1-D6 verbatim;
  root decisions 1-12 pending). Sections 4-6: Phase 0 (pre-Friday), Phase 1 (Friday), Phase 2
  (durability + media). Section 7: root task coverage T1-T21 plus new T22/T23. Section 8:
  dependency-driven schedule with one recorded split. Sections 9-11: checks, rollback,
  guardrails.
- Every task names files, one writer, dependencies, the smallest meaningful check, and its owner
  gate. A recommendation is never consent; a pending decision blocks its gated work.
- Three evidence layers stay separate throughout: (L1) previously reported live audit evidence;
  (L2) this session's read-only source review; (L3) future checks — none run yet.

## 1. Evidence layers and safety rules

1. **L1 — previously reported live evidence** (historical, not fresh fact): SerpApi free-plan
   quota exhaustion with a reported 10/5 renewal; GBP zero-of-13-days posting history and the
   S4U/DPAPI inference; the week-of-9/21 boost skip; photo-library counts (494 duplicate copies
   in 464 hash groups, 167 files under 80 KB, 168 falsely dated); 627/627 passing tests;
   historical PID and scheduler/account state. None of this is re-verified by this review.
2. **L2 — this session's source review** (read-only, repo-relative): confirmed the exit-5
   fallthrough (`scripts/lib/gbp-runner.mjs:159`); terminal session tests
   (`scripts/lib/gbp-runner.test.mjs:93,119`); the boost parser gap
   (`scripts/fb-boost-ledger.mjs:70-90`); the degraded-flag gap (`scripts/weekly/run.mjs:524-532`,
   `scripts/weekly/lib/select.mjs:653`); manifest purge and used-path key misses
   (`scripts/fb-photo-pick.mjs:317-318`, `:135,240,280`); filename-only selection
   (`scripts/lib/photo-selection.mjs:10-50`); the classifier's local-model default
   (`scripts/classify-electrical.mjs:60-67`); queued→posted mapping with no external id
   (`scripts/lib/gbp-runner.mjs:65-67`) and unconfirmed exit-0 (`:98-104`); the daily latch
   (`scripts/gbp-worker.mjs:321-329`); shadow launch without notify (`scripts/run-weekly-seo.py:296`).
3. **L3 — future checks**: every verification here is future work. No test, pipeline, probe,
   query, or live check was executed by this review. Do not cite this document as proof any
   check passed.

**Safety rules.** Repo-relative source references only; private user-directory paths, host
identifiers, business/project names, personal contact data, and secrets are omitted. Future live
sign-ins/account work, process lifecycle changes, scheduling changes, database or photo-library
writes, posting/boosting/deleting, and any paid/model/API use each require Carter's explicit
approval at that moment. Review-session sign-in authority confers no paid/API authority. No
automatic commits at session close. Credentials and auth state never enter Git, logs, or
documents.

## 2. Decisions

### 2.1 Carter's D1-D6 (recorded verbatim, 2026-09-24)

| # | Answer |
|---|---|
| D1 | Do not store the Windows password yet. Run `--auth` tonight, then the session-0 probe. If that probe fails, tomorrow's GBP worker runs in the interactive session. Playwright `storageState` is the durable fix after Friday (P2.8). |
| D2 | Accept thin SERP data tomorrow, with the legacy SerpApi tool skipped. The paid tier can wait until Carter wants it, before Oct 2. |
| D3 | Carter edits or deletes the 9/26 Facebook post himself tonight. No agent deletes through Graph. |
| D4 | Skip 9/12–9/24. Recover from 9/25. |
| D5 | gpt-4o for the Phase 2 relabel (it is already the classifier). Spot-check 50 labels before the full run. Cap the caption check at 3 candidates per post. |
| D6 | Tonight: G2, G3, G4, F1, S1, S2, S3 (as narrowed), plus the legacy SerpApi skip. **Hold G1.** |

### 2.2 Qualifications (separate from the answers; not new decisions)

- **D1**: `storageState` is the selected approach, not a proven durable fix; it must validate in
  the intended worker context (P2.8) before the interactive fallback retires.
- **D5**: GPT-4o is the chosen relabel model — not the classifier source's local default, and not
  spend authority. Pin the approved endpoint/model explicitly; the 50-label owner check gates the
  full paid run; the 3-candidate cap is per post (total), never per image.
- **D6**: the answer arrived cut off after "Hold G1". **F2 (the Hermes alert break) remains
  diagnosis-only through Phase 2** until Carter answers; the fix ships when he adds it.
- **F2 disambiguation**: root PLAN's historical finding "F2" is content-quality approval (root
  decision 12) — a different issue. This plan's "F2-alert" is the Hermes `hermes_cli` break.

### 2.3 Root decisions 1-12 (all PENDING; recommendations are not consent)

| # | Decision | Recommended default (review only) | Gates |
|---|---|---|---|
| 1 | Alert channels | Hermes only for now; revisit a backup before cutover | T1 channel |
| 2 | Review surface | Summary digest via alert; no dashboard | T1 digest |
| 3 | SerpApi numbers | Keep 80 calls / 5-day cache (60/7 changes rotation coverage) | T5 numbers, T23 |
| 4 | Model to pin | The model the API actually served, with its own pricing entry | T7 |
| 5 | Opportunity floor | Hard floor at 10 impressions on the position component | T8 |
| 6 | Performance memory | Wire into selection now; "later" makes T9 docs-only | T9 |
| 7 | Owner actions | Read-only inspection first, then scoped approved registration | T11, T17 |
| 8 | Anecdotes | Hypotheticals allowed; first-person past-tense job claims are errors | T13 |
| 9 | Carousel | Conservative downgrade to photo until a multi-photo contract is approved | T14 |
| 10 | Website drafts | Title + description only; drafts deferred as a known gap | T20 |
| 11 | Repository visibility | See 2.5 — this plan's publication approved; broader question pending | docs, T11 |
| 12 | Content approval record | One-line recorded verdict per clean-Friday audit | Friday gates |

### 2.4 F2-alert ownership

F2-alert has no lane tonight (diagnosis only). Slack `account_inactive` is a separate break with
no lane owner; it stays an owner check. Until both resolve, the Friday audit is the safety net
and alert delivery is verified by receipt **and** actual channel delivery (5.2).

### 2.5 Publication scope (narrow, resolved)

Carter approved public publication of **this sanitized document only**. The broader root decision
11 question — repository visibility for other operational documents — **remains pending**. This
approval does not authorize committing credentials, private account data, other operational
documents, or any unsanitized material.

## 3. Execution shape

Orca orchestration, max 3 workers in disjoint file lanes; a frontier coordinator plans,
serializes shared files, and reviews every diff and readback. Per-lane briefs name the only
writable files, the required outcome, the exact check commands, and a `DONE:` line; every brief
forbids other files, `.env`, network/LLM/Supabase writes, posting, pm2 CLI, commits, scheduler
changes, and printing secrets. Model ladder per workspace rules (flash tier for routine edits,
escalation only after two failed attempts). One writer per file at all times; the coordinator
serializes shared tests, docs, and runner files. No commits or pushes unless Carter asks.

## 4. Phase 0 — pre-Friday code wave (D6 scope)

### 4.0 Owner actions (Carter, each separately approved)

1. GBP sign-in at the console (`driver.mjs --auth`) — owner-only; agents never enter passwords
   or sign in to Google. Isolate the shared profile first (4.5).
2. Edit or delete the 9/26 Facebook post personally (D3); no agent deletes through Graph.
3. Answer the F2-alert scope question (ship the fix now, or keep diagnosis-only).
4. Check the Slack app/workspace behind `account_inactive` (owner check; no lane).

### 4.1 Lane G — GBP

Sole writer: `scripts/lib/gbp-runner.mjs` + test, `scripts/gbp-poster/driver.mjs`,
`scripts/gbp-worker.mjs` + test, `scripts/lib/gbp-paths.mjs` + test, `scripts/gbp-photo-pick.mjs`,
`scripts/gbp-poster/policy-check.mjs`, and a scoped update to `docs/runbooks/gbp-worker.md`.

- **G1 — HELD (D6).** `session_expired` and captcha stay terminal `error`; existing tests
  unchanged.
- **G2.** `gbpScheduleStatusForExit` (and the daily mapper if it shares the gap) maps exit 5
  `policy_violation` to `error` with the policy detail instead of falling through to `scheduled`
  (`gbp-runner.mjs:159`). The daily path already errors — preserve the detail there. Check: the
  exit-5→error mapping case in `gbp-runner.test.mjs`.
- **G3.** New `driver.mjs --check-session`: opens the existing profile, runs the existing login
  check without a schedule row and **without opening the composer**; success requires successful
  navigation plus the existing Posts/Add-update control; rejects captcha, logged-out, unknown,
  and timeout; closes the browser; prints bounded `{ok, reason}`; exits 0 or 2; API mode
  unchanged.
  Worker integration: probe at startup and daily 08:00 Central **under the existing pidfile
  helper**, with exclusive-create acquisition and owner-safe stale handling — **no new lease
  framework**. Health record `state/gbp-session-health.json` carries fresh timestamp, PID,
  worker context, and reason, so stale or foreign results cannot be mistaken for this probe.
  Failed probes send one non-fatal alert and gate approved-row claims, the daily posting path,
  and worker retries. A failed probe releases ownership **only after** browser and active work
  settle, then idles; an idle process never touches another process's lock, profile, or health
  record; resumption requires exclusive reacquisition plus a passing probe. **Fix the stuck-poll
  busy-reset**: a stuck run must not clear the busy flag while a prior pass or child may still
  be alive — fail closed, alert for operator recovery, no new pass or probe until settled. Add a
  **probe-only startup mode** that records health and exits without claims or polling.
  Checks: the exit-5 mapping case; an ownership/handoff case beyond login (failed probe →
  release → interactive takeover → background stays idle, including retries; resumption needs
  reacquisition + passing probe) in `gbp-worker.test.mjs`; a stuck-poll/busy case. No arbitrary
  one-test cap — necessary silent-failure cases are allowed.
- **G4.** Export the existing 10 KB/format policy from `scripts/gbp-poster/policy-check.mjs`
  (currently private) or a shared helper; apply it to the picker pool, configured-path and
  date-prefix resolver returns, and fallback — judging the **final resolved/converted artifact**.
  A source needing conversion qualifies only if its converted artifact passes; never copy
  unconverted HEIC bytes under a JPG name. Log every skipped file with reason and size.
  Checks: undersized-image and size-valid-but-unsupported-format fixtures through the existing
  `scripts/lib/gbp-paths.test.mjs` seam, including an existing configured path; confirm imports
  load. Broader quality cuts stay Phase 2 (P2.2).
- **Runbook update (scoped).** `docs/runbooks/gbp-worker.md` carries stale auth advice and an
  unsafe broad `--once` recommendation. A later docs writer updates only the auth, probe,
  recovery, and media sections — sanitized, no identities, no private paths copied.

### 4.2 Lane F — Facebook boosts

Sole writer: `scripts/fb-boost-ledger.mjs` + test.

- **F1.** `scheduleWeekStart` (`fb-boost-ledger.mjs:70-90`) accepts both the single-date heading
  (`## Week of <Month D, YYYY>`) and the bold `**DATE:** YYYY-MM-DD` form. Check: one focused
  table case using the real 9/18 heading shape in `fb-boost-ledger.test.mjs`.
- **F2-alert — diagnosis only (2.2, 2.4).** The helper default (`scripts/lib/hermes-alert.mjs:19`)
  already points at the venv Hermes executable, so re-pointing it fixes nothing. Reproduce
  `No module named 'hermes_cli'` with the exact command pm2 runs; compare the relevant
  environment (PATH, PYTHONHOME, PYTHONPATH, VIRTUAL_ENV — values except secrets) against the
  monitor/watchdog invocations that work; adopt that invocation **when Carter authorizes the
  fix**. A shipped fix must never let an alert failure kill a poll or tick; callers catch.
  Owned file when it ships: `scripts/lib/hermes-alert.mjs`, plus `ecosystem.config.cjs` env
  block only if the cause is environmental. No test.

### 4.3 Lane S — shadow/wrapper/legacy SerpApi

Temporary owner of a B/C subset, then explicit handback: `scripts/run-weekly-seo.py`,
`scripts/weekly/lib/collectors/serpapi.mjs`, `scripts/weekly/run.mjs` (the `applyDegraded`
helper **and both generation call sites**, plus minimal source-availability/quota-evidence
plumbing), `scripts/weekly/test/collect-2-serpapi.test.mjs`,
`scripts/weekly/test/e2e-offline.test.mjs` (the one quota/degraded/regeneration assertion), and
`src/seo_agents/crew.py` (build_tools only).

- **S1 — part of T1 only.** Add `--notify` to the shadow command (`run-weekly-seo.py:296`);
  notify is already non-fatal (`run.mjs:734-741`). The rest of T1 stays a root task (7.1).
- **S2.** On SerpApi's account-exhaustion 429, reuse the existing stop mechanism (`stopNote`),
  stop issuing live calls for the attempt, and record the exhausted request plus subsequent
  uncached queries as `unavailable` with a stable `quota_exhausted` marker in the existing
  observation note field — **no new availability field**. Distinguish account exhaustion from
  generic rate limiting. Preserve earlier successes and valid cache hits. Check: the existing
  collector test gains the injected-429 case (no further live calls; uncached remainder
  unavailable; valid cache hits still ok).
- **S3 (narrowed).** Quota-exhaustion evidence or a zero-ok SerpApi source flags
  `plan.notes.degraded` (with reason) at **both** generation call sites; the summary and attempt
  carry the flag. Pass source availability/quota evidence in; do not infer from selection alone.
  No "mostly error" heuristic. Check: an e2e assertion covering quota→degraded→regeneration
  behavior; the shared e2e test file is serialized by the coordinator (one writer at a time).
- **Legacy skip.** `build_tools()` (`src/seo_agents/crew.py:158-165`) stops inserting the legacy
  SerpApi tool unless `SEO_LEGACY_SERPAPI=1`; default is skip, so `.env` needs no change.
  Search Console, Facebook, and history still feed the crew. Check: the build_tools one-liner
  showing no SerpApi tool.

### 4.4 Change-set checks (coordinator, once, after assembly — all L3)

- `node --test scripts/weekly/test/*.test.mjs scripts/lib/gbp-runner.test.mjs
  scripts/gbp-worker.test.mjs scripts/fb-boost-ledger.test.mjs` (single assembled command, plus
  G4's fixture cases). Any change set that touches the watchdog adds `scripts/seo-watchdog.test.mjs`
  to the same command (root `PLAN.md` §0.3 rule, T3).
- `npm run lint`
- venv py_compile of `scripts/run-weekly-seo.py` and `src/seo_agents/crew.py`; pytest
  `tests/test_friday_fixes.py` (a `.py` file changed)
- The wrapper `preflight()` one-liner and the `build_tools()` one-liner
- `node scripts/weekly/run.mjs --mode offline` with isolated out/store paths
- **Not a check**: `scripts/gbp-photo-pick.mjs --dry-run` — the picker's dry-run currently
  syncs, scores, and cache-writes, so it is not a no-write preview until the P-lane preview fix
  lands (6). (The driver's own dry-run returns before browser launch — `driver.mjs:588` onward —
  and is not the side-effect source.)

### 4.5 Live steps — each needs Carter's yes at that moment (all L3)

1. Confirm no other process uses the shared profile; set `MAV_BRIDGE_GBP` off; then the owner
   runs interactive `--check-session` after 4.0-1. Record the result.
2. Before any approved restart: freshly resolve the worker's PID, command line, owner, session,
   and pidfile (historical PIDs are evidence, never action targets); inspect pending approved
   rows and retries read-only. **A normal worker restart can post — it is not a probe-only
   action.**
3. The real session-0 probe uses G3's probe-only startup under the documented intended-identity
   invocation, with separate launch-configuration/lifecycle approval. Never guess a task; never
   the pm2 CLI from an agent shell. A passing session-0 probe supports a context-specific
   difference; it does **not** uniquely prove the S4U/DPAPI theory.
4. Production pause/resume is separately approved. Before the Friday run, with approval to
   resume, start the selected worker (session-0 if validated, otherwise the hidden interactive
   launcher) and verify exclusive ownership; the competing worker stays gated. Never launch a
   probe while a worker owns the profile.
5. F1 needs no restart if the bridge spawns the boost ledger by path (`scripts/mav-bridge.mjs:89`);
   confirm read-only. Any restart is its own approved action.
6. Nothing is reset tonight (D4). Nothing is posted tonight. If probe-only loading cannot
   preserve that boundary, defer normal worker activation to the approved Friday resume step.

## 5. Phase 1 — Friday run, audit, recovery

### 5.1 Expected timeline (estimates; verify actual completion)

08:25 photo sync · 08:30 legacy run (no legacy SerpApi tool) and monitor · ~08:40 bridge: GBP
day 1 live, days 2-7 `scheduled_native`, 4 FB posts scheduled · ~08:45 shadow run with
`--notify` · 09:30 boost tick · 10:00 watchdog · audit **after fresh completion**.

### 5.2 Friday audit (read-only; root `PLAN.md` §6 checklist governs)

1. `outputs/weekly-runner-health.json`: today's legacy success plus a fresh `shadow` block
   matching this attempt — distinguish running, failed, and stale prior-week evidence.
2. `outputs/shadow/attempt.json` for the expected `week_of`, correlated with observations and
   the model plan; SerpApi rows carry `quota_exhausted` after observed exhaustion; degraded
   flags set in plan, summary, and attempt; inspect the `notify:*` receipt **and** the actual
   delivery channel — a CLI receipt alone is not delivery.
3. `weekly_posts` for the expected window: GBP day 1 `posted`, days 2-7 `scheduled_native`; FB
   posts scheduled with media. **Database status is not external proof**: queued→posted mapping
   carries no external id (`gbp-runner.mjs:65-67`) and exit-0 can remain unconfirmed
   (`:98-104`). Corroborate with driver/listing/reference evidence; ambiguous stays
   unconfirmed; no blind retry. `scheduled_native` is not guaranteed external delivery.
4. The legacy crew log shows no SerpApi calls.
5. Every chosen photo opened against its caption; mismatches flagged (Phase 2 baseline).
6. The boost parser resolves the current week-of and the tick's eligibility decision is correct
   for today's date; future posts stay ineligible; no next-week ledger entries expected before
   eligibility. Reservation/publication is verified on an actually eligible day.
7. New FB copy contains no invented job anecdotes or price claims.
8. Which alerts actually arrived, per channel.

### 5.3 GBP recovery (D4 verbatim: "Skip 9/12–9/24. Recover from 9/25.")

- Initial exact recovery covers **9/25 only**; any other date is Carter's call.
- The existing reset script filters only platform and date — unsafe as-is. Recovery is an
  approved operator procedure: identify the exact row/run; conditional update from expected
  `error` to `scheduled` guarded by id + run + expected status; exactly one affected row;
  before-image preserved. Never reset a posted or ambiguous row.
- Account for the daily latch (`gbp-worker.mjs:321-329`): a same-morning reset alone will not
  re-run today's daily pass. Use the approved same-day procedure under exclusive ownership with
  a fresh passing probe; broad `--once` or a restart has whole-queue effects and is not a
  single-row recovery. **No new recovery CLI is presumed**; if one is justified it is a separate
  reviewed, approved task. Verify the external result before any further retry.
- FB media missing → the existing fix-scheduled-photo script. Boost skipped → Carter boosts
  manually. Both approval-gated.

### 5.4 Deliverable

Readout to Carter plus a handoff note; alert delivery stated per channel with receipt evidence.

## 6. Phase 2 — GBP durability and media integrity (lanes L/P/F)

Lanes (exact file lists): **L** — `scripts/classify-electrical.mjs` plus new test
`scripts/lib/classify-electrical.test.mjs` (one label-schema rejection case); label data
artifact `state/curated-labels.json`. **P** — `scripts/lib/photo-selection.mjs` + existing
`scripts/lib/photo-selection.test.mjs`; `scripts/lib/gbp-paths.mjs` + existing
`scripts/lib/gbp-paths.test.mjs`; `scripts/gbp-photo-pick.mjs`; `scripts/sync-photos-from-drive.mjs`
(only if hash ingestion requires it); `scripts/mav-bridge.mjs` (photo block only);
`scripts/gbp-worker.mjs` (media-preservation block only, after G3 handback).
`scripts/gbp-media-sync.mjs` is **read-only inspection** unless its GBP gallery upload contract
is separately approved for change; it does not rename/archive files. **F** —
`scripts/fb-photo-pick.mjs`; `scripts/facebook-poster.mjs`; `scripts/fb-photo-rewrite.mjs`;
`scripts/fb-boost-ledger.mjs` + existing `scripts/fb-boost-ledger.test.mjs`;
new focused `scripts/fb-photo-pick.test.mjs`, `scripts/facebook-poster.test.mjs`, and
`scripts/fb-photo-rewrite.test.mjs` only for behaviors not covered by existing tests. The bridge photo edit has exactly one media writer (P).
Sequence schema/history migration before picker/poster consumers. Library changes are
logged, reversible moves after Carter reviews a dry run; code-worker scope never authorizes
library moves or paid vision execution.

- **P2.1 Content labels.** `classify-electrical.mjs --relabel-curated` reuses the existing
  transport with an extended prompt/schema/token allowance; **explicitly selects the approved
  GPT-4o endpoint/model** (the source defaults to a local model — never silently started);
  records requested/reported model without secrets; rejects malformed/unknown labels;
  checkpoints by hash so interrupted relabels resume. Output `state/curated-labels.json` keyed
  by sha256: filenames, service_type, subtype, tags, one-sentence "what is visible", quality
  (ok | tiny | logo_or_graphic | non_electrical | people), score, model, date. Taxonomy: panel
  (upgrade/replacement/subpanel/meter-service), generator (standby/inlet-interlock/
  transfer-switch), ev-charger, lighting (recessed/ceiling-fan/outdoor/fixture), outlet
  (gfci/standard), wiring (rewire/conduit/junction), surge, smoke-co, other. **Carter
  spot-checks 50 labels before any full paid run.**
- **P2.2 Library hygiene (ordered).** Build a path→sha256 index and migrate existing
  selection/history references to hashes **first**; deploy hash-aware readers before any move;
  preserve eight weeks of known usage, marking missing history unknown; protect media referenced
  by pending schedules/rows, or migrate-and-verify those references first. Inspect the known archive caller before assigning a move: `markGbpPostedAndArchive`
  in `scripts/lib/gbp-runner.mjs:230-278` renames the workbook-selected photo after posting;
  `scripts/sync-gbp-schedule.mjs:130-141,179-190` resolves workbook media paths.
  `scripts/gbp-media-sync.mjs` is gallery upload, **not** the archive-rename mechanism;
  `scripts/sync-photos-from-drive.mjs` is additive cache ingestion. The picker already excludes
  the library `Archive` directory (`scripts/gbp-photo-pick.mjs:104-105`). Scope any archive
  change only after checking this known caller and approved consumer contracts. P owns
  conditional media-only edits to `scripts/lib/gbp-runner.mjs` and
  `scripts/sync-gbp-schedule.mjs`, with `scripts/lib/gbp-runner.test.mjs` and
  `scripts/sync-gbp-schedule.test.mjs` checks, after G handback and Carter's approval.
  No whole-library work before the 50-label check. Then: collapse the 494 duplicate copies; stop caption-renamed
  picker copies re-entering Curated (the manifest records source path + hash instead); move
  tiny/graphic/non-electrical files to review; re-date the 168 false-dated files only where
  valid EXIF supports it, else an explicit unknown-date marker. Moves only, hash move log, no
  deletes.
- **P2.3 One shared selection path** in `photo-selection.mjs` for GBP and FB: SERVICE →
  structured service key with a fixed title-first fallback; validated allowed-label table per
  key, **no silent cross-topic fallback**: a cross-topic pair is eligible only when Carter's
  approved compatibility allowlist explicitly names that pair; otherwise block or use text-only;
  commercial context as an explicit tag + matching rule, not keyword order; content-hash
  no-reuse across platforms, 8 weeks, backed by migrated history with unknown history explicit;
  platform-keyed manifest so the FB date purge cannot drop GBP entries; FB used-path keys
  fixed. **Concurrency**: worker and bridge call pickers independently, so add one small local
  manifest reservation lock with atomic temp/rename writes — or demonstrate every caller is
  already serialized. No database, queue, or new package.
- **P2.4 Caption-photo check.** One GPT-4o yes/no call sees the actual image plus hook and
  service. On "no", the next candidate — **3 candidates total per post** — then the allowlist
  photo (GBP) or text-only (FB). Recommended default pending Carter's multi-image decision: one
  passing photo, or text-only if none passes; the cap is never reinterpreted per image. An
  unavailable vision service leaves the image unverified, not passed. Verdicts and candidate
  hashes recorded.
- **P2.5 Poster guard.** `scripts/facebook-poster.mjs` rejects photos that fail the manifest
  audit, including guessed `IMG_` files; `scripts/fb-photo-rewrite.mjs` and
  `scripts/sync-photos-from-drive.mjs` consumers preserve selected identity. Cover rejection
  and rewrite with the focused FB tests listed above; use isolated fixtures, no live write.
- **P2.6 → root T22** (7.4).
- **P2.7 ffmpeg + classify task.** Reuse `scripts/lib/ffmpeg-bin.mjs`; diagnose the pm2-session
  resolution failure and fix by configuration only. Inspect the no-op classify scheduled task,
  then repair or retire under separate approval. Slideshows fall back to a single photo
  (nonblocking contract) pending the multi-image decision. If configuration-only diagnosis
  cannot fix resolution, return to Carter rather than changing `scripts/lib/ffmpeg-bin.mjs`
  without a separately scoped approval.
- **P2.8 GBP durable auth (D1; G owns `scripts/gbp-poster/driver.mjs`,
  `scripts/gbp-worker.mjs`, `scripts/gbp-worker.test.mjs`, auth/probe cases in
  `scripts/lib/gbp-runner.test.mjs`, and auth/probe/recovery sections of
  `docs/runbooks/gbp-worker.md`; P's later worker edit is media-only after G handback).** `--auth` exports Playwright `storageState` under Carter's
  profile; the worker launches a non-persistent context from it and refreshes atomically under
  exclusive ownership; ACL-restricted, outside Git and logs. Acceptance: fresh export validated
  under the intended worker identity, then again from a later fresh context — **before** the
  working interactive fallback retires. The session probe remains the gate. **F2-alert is still
  gated even in Phase 2**: diagnose only until Carter answers the D6 scope question, and obtain
  separate approval to ship a fix; Slack remains a separate owner check (2.2, 2.4).
- **Archive safety prerequisite (recorded dissent).** Before eliminating copies, verify the
  `scripts/lib/gbp-runner.mjs` workbook-photo rename cannot move a canonical source. P may edit
  that media-only block + `scripts/lib/gbp-runner.test.mjs`, and the media-path consumer
  `scripts/sync-gbp-schedule.mjs` + `scripts/sync-gbp-schedule.test.mjs`, **only after G handback
  and Carter's archive/consumer approval**; G retains runner auth/status ownership until then.
  Choose a safe disposable
  artifact outside Curated or an owner-approved archive-consumer adaptation. Grok opposes an
  unconditional archive rewrite; the mechanism is owner-gated, not presumed implementation.
- **Allowlist.** An owner-approved compatibility/brand allowlist governs cross-topic pairs for
  both GBP and FB and replaces GBP's "any curated still" fallback; an empty or non-qualifying
  allowlist **blocks** the photo for review or uses an approved text-only fallback, never
  silently reverts to arbitrary imagery. Reuse and vision-fallback exceptions are
  recorded in the manifest.
- **Acceptance.** A picker dry-run that is **truly no-write and no-network** — fix
  `scripts/gbp-photo-pick.mjs --dry-run` (it currently syncs, scores, and cache-writes) or use
  isolated fixtures. Non-fallback
  images match service keys with passing verdicts; allowlist and text-only/downgraded exceptions
  explicit; no repeats against migrated 8-week history, or the unverified-history gap reported;
  pending media paths still resolve; competing selections never reserve the same hash. Carter
  eyeballs one week.

## 7. Root task coverage — T1-T21 preserved, plus T22/T23

### 7.1 Task matrix (key contracts kept; root acceptance subtleties not dropped)

| Task | Required outcome (contract) | Files → owner | Depends | Smallest check | Gate |
|---|---|---|---|---|---|
| T1 | Every shadow (later `new`) attempt sends one idempotent attempt-bound alert on succeeded/degraded/failed via the existing `notify:<event>` receipt; message carries topic, counts, **validation result + runtime**, spend, summary path; receipt visible to the health/watchdog read path. S1 covers only the `--notify` wiring. | `scripts/run-weekly-seo.py` → A; `scripts/weekly/run.mjs`, `scripts/weekly/lib/notify.mjs` → B | T2; S1 | `scripts/weekly/test/core-3-notify-reconcile.test.mjs` receipt and `tests/test_friday_fixes.py` health visibility; separately confirm channel delivery | Decisions 1-2 (channel/surface) |
| T2 | Health file states what happened: structured `shadow` block from the attempt record (never exit code); fresh + matching week_of or `failed (stale/no attempt)`; pre-launch `running` marker; legacy keys preserved. | `scripts/run-weekly-seo.py` → A | — | pytest case in `tests/test_friday_fixes.py`: no-op child → `failed (no attempt written)` | — |
| T3 | Watchdog/monitor see shadow: config-gated on `SEO_PIPELINE`; no-show / failed / hung / notify-miss / reconcile-stale alerts; **`new`-mode parity** (no "legacy succeeded" dependency); reconcile freshness from `last_success_at`, never table rows. | `scripts/seo-watchdog.mjs`, `scripts/seo-monitor.mjs` → A | T2; T11 health writer | Table case in `scripts/seo-watchdog.test.mjs` (4 states + stale) | — |
| T4 | `compare.md` renders a finished attempt (status, finished_at, runtime, spend) and a two-sided legacy comparison; runbook names `compare.md`. | `scripts/weekly/lib/compare.mjs`, `scripts/weekly/run.mjs` → B; `scripts/run-weekly-seo.py`, `FRIDAY-RUNBOOK.md` → A | — | Offline run shows finished attempt + legacy runtime | — |
| T5 | SerpApi collect: 4-6 in flight, same per-call timeout, cache/cap semantics; reserve maxCalls slot **and** worst-case price before dispatch so in-flight calls cannot overshoot either limit. On account-quota exhaustion stop dispatching new live work immediately (already-sent requests may settle), preserve valid cache hits; hard collect deadline marks remainder `unavailable`; cold collect < 3 min. **Code/offline proceed now; live capped run waits for T23.** | `scripts/weekly/lib/collectors/serpapi.mjs`, `scripts/weekly/DESIGN.md` → B (DESIGN handed to A sole writer); `config/weekly-policy.json` → B only if approved | T23 (live run) | Injected `fetchImpl` in `scripts/weekly/test/collect-2-serpapi.test.mjs`: peak in-flight bounded; cap/budget reservations never exceeded; quota stop dispatches no more live calls, cache still ok; deadline remainder unavailable | Decision 3 (numbers) |
| T6 | Kill/timeout finalizes the attempt `failed` and releases the lease; wrapper patch guarded by the **current attempt identity** (published early, refreshed); never patches a foreign attempt. | `scripts/weekly/run.mjs`, `scripts/weekly/lib/attempt.mjs` → B; `scripts/run-weekly-seo.py` → A | — | Kill case in `scripts/weekly/test/e2e-offline.test.mjs`: failed + lease released + identity guard | — |
| T7 | Pin the served model explicitly; pricing entry per servable id; meter records requested **and** served, priced from served, warns on mismatch; one tiny metered preflight call before attempt creation, recorded even on failure. | `scripts/weekly/run.mjs`, `scripts/weekly/lib/llm.mjs`, `scripts/weekly/lib/cost-meter.mjs`, `config/weekly-policy.json` → B; private configuration → Carter only | Decision 4 (id) | Meter-record case in `scripts/weekly/test/core-2-cost-llm.test.mjs` | Decision 4 |
| T8 | `opportunity_min_impressions` floor (default 10) on the position component only → `opportunity_no_data` + rationale; local-pack bonus preserved either way. | `scripts/weekly/lib/select.mjs` → C; `scripts/weekly/DESIGN.md` → A after C handoff | Decision 5 (style) | Case in `scripts/weekly/test/select.test.mjs`: below-floor + bonus intact | Decision 5 |
| T9 | Performance memory into selection: matured rows only; one window per post (28-day else 7-day, latest measured_at); availability ok-only (unavailable absent, never 0 → `performance_unknown` 0.5); replaces the live FB join in-window; rationale names the source. | `scripts/weekly/lib/collectors/history.mjs`, `scripts/weekly/lib/select.mjs` → C | T10 mapping; **Decision 6 hard gate** | Fixture case in `scripts/weekly/test/collect-2-history.test.mjs`: precedence + unavailable-not-zero | Decision 6 |
| T10 | Every published post yields reach/impressions + one engagement metric or `unavailable` with the precise reason; verified Graph id normalization (never fabricate); video fallback uses a readable field; **FB keys split by source** `(platform_post_id, metric, window)` vs Search Console daily history preserved; retry updates atomically (upsert, no dupes); migration only if unavoidable, owner-gated. | `scripts/lib/facebook-insights.mjs`, `scripts/weekly/lib/reconcile.mjs`, `scripts/weekly/reconcile.mjs` → C | — | Retry-replaces-unavailable case in `scripts/weekly/test/core-3-notify-reconcile.test.mjs` (no dupes, SC intact) | Migration apply = owner |
| T11 | Read-only inspection of the task-registration script (it re-registers unrelated tasks), scoped action list for Carter; reconcile CLI writes health with `last_success_at` separate from `last_attempt_at`/`status`. | `scripts/setup-scheduled-tasks.ps1` inspect-only → A report; `scripts/weekly/reconcile.mjs` → C | — | Read-only report + health-file fields | Decision 7 (owner actions) |
| T12 | Deterministic boost normalizer before **both** validations and render. Preserve exactly the model's YES choices: never invent, drop or pick rows. Normalize arithmetic **only for 1–2 YES rows**: `days=1`, integer-cent equal split (odd cent to first YES), exact `policy.boost_weekly_usd` total; clear MAYBE/NO allocations; warn in summary. Zero or >2 YES fails unchanged; any residual overbudget fails, never silently accepted. | `scripts/weekly/lib/validate.mjs` → C; `scripts/weekly/run.mjs` call site → B; `scripts/weekly/DESIGN.md` → A after C/B handoff | — | `scripts/weekly/test/validate.test.mjs`: raw $90 plan → $50 total (two YES at $25 each) + warning; odd-cent split, zero or >2 YES fail unchanged; residual overbudget fails | — |
| T13 | Prompt names the anecdote pattern with forbidden/allowed examples; validator errors on first-person past-tense job claims and "Before:" without two photos; optional LLM judge stays off. | `scripts/weekly/lib/prompts/plan.system.md`, `scripts/weekly/lib/validate.mjs` → C | Decision 8 (voice) | Combined table case with T14 in `scripts/weekly/test/validate.test.mjs` | Decision 8 |
| T14 | Every `carousel` conservatively downgraded to `photo` with warning (singular-photo schema cannot prove two attached); deterministic normalization before render+validate; multi-photo schema deferred until approved. | `scripts/weekly/lib/validate.mjs` (downgrade + validator) → C; `scripts/weekly/run.mjs` (normalization call site) → B; `scripts/weekly/DESIGN.md` → A after handoff | Decision 9 | Combined table case with T13 in `scripts/weekly/test/validate.test.mjs` | Decision 9 |
| T15 | Boost radius centers on the city named in the post (winner city when none). Prompt-only. | `scripts/weekly/lib/prompts/plan.system.md` → C | — | Prompt readback | — |
| T16 | Prove the scheduler path: e2e case spawns offline through the real junction alias while the module resolves to the real path; wrapper gains an injectable offline seam (isolated store/out/health, never the legacy main path); runbook documents the rehearsal command + health block. | `scripts/weekly/test/e2e-offline.test.mjs` → B; `scripts/run-weekly-seo.py`, `FRIDAY-RUNBOOK.md` → A | — | Junction-path case writes an attempt | — |
| T17 | Read-only confirmation of the scheduled task's action path / working dir / principal (task XML or CIM; sandbox-safe); report only. | `scripts/setup-scheduled-tasks.ps1` inspect-only → A report | — | Handoff-note record | — |
| T18 | Freeze between qualifying Fridays: bug fixes only; every post-freeze change recorded with reason, reviewer, comparability note; same discipline at the cutover boundary. | `FRIDAY-RUNBOOK.md` freeze section → A | — | Note lists each change | — |
| T19 | Projection links by `weekly_posts` row id (source wins over the old finding prose); platform id kept separately; website items join through the inserted row/target; GBP metrics stay conditional — absent, never zero-filled. | `scripts/weekly/lib/project.mjs`, `scripts/weekly/test/project.test.mjs`, `scripts/weekly/run.mjs` → B; `scripts/weekly/lib/reconcile.mjs` → C | Cutover session | Fixture case in `scripts/weekly/test/project.test.mjs`: ref survives reconcile + website join | Owner cutover approval |
| T20 | Website drafts at projection: title+description default; drafts only if Decision 10 requires; budget recheck if added. | `scripts/weekly/lib/project.mjs` → B; conditional `scripts/weekly/lib/prompts/plan.system.md`, `scripts/weekly/lib/schemas.mjs`, `scripts/weekly/lib/validate.mjs` → C | Decision 10 | Test only if drafts required; else none — never TBD | Decision 10 |
| T21 | Cutover: budget to $5, `--pipeline new`, projection applied, legacy research crews disabled; **gates layer retired one session later** (S7), not in the cutover session; notify/health/watchdog `new`-mode parity verified in the same session; offline refusal path exercised. | `scripts/run-weekly-seo.py`, `FRIDAY-RUNBOOK.md` → A; `scripts/weekly/run.mjs`, `scripts/weekly/lib/project.mjs`, `config/weekly-policy.json` → B; private configuration → Carter only | T19-T20; owner cutover approval | Offline ceiling refusal; parity checks | Owner cutover approval |

### 7.2 Key dependencies (root order, re-dated)

T2 before T3 and before T1's visibility half · T1/T2 before the first audited Friday · T12/T13
before output-affecting Fridays · T5 code before the freeze, T5 live after T23 · T6/T7 before the
first audited Friday · T16's seam before T2's offline acceptance · T11's health writer before
T3's integration · T10's mapping before T9 · T18 freeze after the assembled integration pass ·
T9 hard-gated on Decision 6 · T19-T21 only in the approved cutover session.

### 7.3 Ownership map (exact; one writer per file, explicit phase handback)

- **Lane A** (root): `scripts/run-weekly-seo.py`, `scripts/seo-watchdog.mjs`,
  `scripts/seo-monitor.mjs`, `scripts/seo-watchdog.test.mjs`, `tests/test_friday_fixes.py`, `FRIDAY-RUNBOOK.md`,
  `scripts/weekly/DESIGN.md` (sole writer; B/C hand over interface notes).
- **Lane B** (root): `scripts/weekly/run.mjs`, `scripts/weekly/lib/notify.mjs`,
  `scripts/weekly/lib/collectors/serpapi.mjs`, `scripts/weekly/lib/attempt.mjs`,
  `scripts/weekly/lib/llm.mjs`, `scripts/weekly/lib/cost-meter.mjs`,
  `scripts/weekly/lib/compare.mjs`, `config/weekly-policy.json` (sole writer),
  `scripts/weekly/test/e2e-offline.test.mjs`, `scripts/weekly/test/collect-2-serpapi.test.mjs`,
  `scripts/weekly/test/core-2-cost-llm.test.mjs`, `scripts/weekly/lib/project.mjs`,
  `scripts/weekly/test/project.test.mjs`.
- **Lane C** (root): `scripts/weekly/lib/validate.mjs`, `scripts/weekly/lib/schemas.mjs`,
  `scripts/weekly/lib/select.mjs`, `scripts/weekly/lib/collectors/history.mjs`,
  `scripts/weekly/lib/reconcile.mjs`, `scripts/weekly/reconcile.mjs`,
  `scripts/lib/facebook-insights.mjs`, `scripts/weekly/lib/prompts/plan.system.md`,
  `scripts/weekly/test/validate.test.mjs`, `scripts/weekly/test/select.test.mjs`,
  `scripts/weekly/test/collect-2-history.test.mjs`,
  `scripts/weekly/test/core-3-notify-reconcile.test.mjs` (B gets a serialized T1 handoff).
- **Phase 0**: lane G owns its GBP file set (4.1); lane F owns the boost ledger; lane S
  temporarily owns its B/C subset (4.3) and hands back before the root-task waves (7.1).
- **Phase 2**: L = `scripts/classify-electrical.mjs` (+ its new test); P =
  `scripts/lib/photo-selection.mjs`(+test), `scripts/lib/gbp-paths.mjs`(+test),
  `scripts/gbp-photo-pick.mjs`, `scripts/sync-photos-from-drive.mjs` if ingestion changes,
  `scripts/mav-bridge.mjs` photo block, `scripts/gbp-worker.mjs` media block after G handback;
  `scripts/gbp-media-sync.mjs` inspect-only (gallery upload, not archive rename);
  conditional P archive/planned-media consumer scope after G handback and Carter approval:
  `scripts/lib/gbp-runner.mjs` (`markGbpPostedAndArchive` media block) +
  `scripts/lib/gbp-runner.test.mjs`, `scripts/sync-gbp-schedule.mjs` media-path block +
  `scripts/sync-gbp-schedule.test.mjs`; G retains status/auth paths. F = `scripts/fb-photo-pick.mjs`,
  `scripts/facebook-poster.mjs`, `scripts/fb-photo-rewrite.mjs`, `scripts/fb-boost-ledger.mjs`(+test).
  Root `run.mjs`, prompt, and validator stay under B/C even for T22 work. Coordinator serializes
  shared tests/docs/runner.

### 7.4 T22 — label-aware shadow media (complete task)

- **Outcome:** the shadow plan prompt sees label descriptions; the validator checks
  label/service compatibility; after cutover the bridge/worker preserve shadow-planned media
  instead of overwriting. No silent auto-enable of optional labels.
- **Files → owner:** `scripts/weekly/lib/prompts/plan.system.md` + `scripts/weekly/lib/validate.mjs` → C; `scripts/mav-bridge.mjs` photo block and `scripts/gbp-worker.mjs` media-preservation block → P after G handback (one writer each); `scripts/weekly/run.mjs` inventory plumbing → B; C owns `scripts/weekly/test/validate.test.mjs`, B owns `scripts/weekly/test/e2e-offline.test.mjs`, P owns `scripts/gbp-worker.test.mjs` and `scripts/lib/photo-selection.test.mjs` (serialize shared tests).
- **Depends on:** accepted P2.1 labels + P2.3 selectors; T13/T14 validation rules.
- **Checks:** `scripts/weekly/test/validate.test.mjs` label/service incompatibility;
  `scripts/weekly/test/e2e-offline.test.mjs` planned-media inventory/preservation;
  `scripts/gbp-worker.test.mjs` worker preservation and `scripts/lib/photo-selection.test.mjs`
  quality, unknown-history, fallback and reservation cases. Include
  `scripts/seo-watchdog.test.mjs` in the assembled Node check if watchdog is touched.
- **Gate:** owner approval; timing per 8.1 split recommendation.

### 7.5 T23 — sustainable quota/capacity owner gate (complete task)

- **Outcome:** a live-run gate coupled to pending Decision 3 and D2: before any live run, check
  fresh remaining quota, valid cache, and planned consumption against the forecast (80 calls ×
  4-5 attempts/month exceeds the 250 free plan, plus every live rehearsal/probe). Optional
  policy edits are lane B's file only. **No implied purchase authority; the paid tier is
  Carter's decision.** The reported 10/5 renewal alone cannot fund a 10/2 run.
- **Files → owner:** `FRIDAY-RUNBOOK.md` capacity check → A;
  `config/weekly-policy.json` optional approved policy edit → B. No new runtime service.
- **Depends on:** S2/S3 quota evidence; Decision 3.
- **Checks:** the pre-live quota/capacity readback recorded before each live run.
- **Gate:** owner approval for any live run and any paid tier.
- **T5 live acceptance:** reuse the first candidate cold-Friday collect as the live acceptance
  when all invariants are observed (no publish, no warm-cache reuse); **no extra 80-call
  rehearsal by default**.

## 8. Schedule — dependency-driven, with one recorded split

### 8.1 T22 timing — a NEW Carter decision; the team records a split, not a default

- **Position A (Karen + Darren):** finish and freeze T22 **before** the two qualifying Fridays
  and cutover, so the pair exercises the final media contract.
- **Position B (Grok):** carry the current filename-based contract to cutover as an explicit
  known gap, unless Carter requires labels at cutover.
- Both are proposals; **Carter chooses before cutover.** All three reviewers agree on what
  surrounds the choice:
  - The actual photo contract to be used at cutover is **frozen before the first qualifying
    Friday**.
  - A later material generation/validation/media change **resets the clean-Friday pair**;
    compatible bugfixes continue only with a recorded comparability note and targeted checks.
  - Baseline Fridays never grandfather untested final behavior.

### 8.2 Dates follow completion, not the calendar

- No promised 9/28-30 completion; the original wave dates are aspirational and overloaded.
  Priority: safety first, then dependency-complete root/auth/media waves (max 3 disjoint
  workers). Real accepted completion + freeze + capacity control set the dates.
- **10/2 + 10/9** is the earliest *illustrative* clean pair, only if both Fridays are ready and
  healthy; otherwise **10/9 + 10/16 or later**, same gates. Historical quota exhaustion is not a
  guaranteed 10/2 failure, and a no-purchase decision is not a categorical degraded verdict —
  each Friday is judged on fresh quota, valid caches, and the full required-source gate (T23).
- **First production Friday is derived from the actual approved cutover**, not from a stale
  10/2 date.

### 8.3 Clean-Friday definition (unchanged gate, never bent)

Two consecutive genuinely clean Fridays, each requiring: every required source present with
**at least one `ok` observation** — a source with zero rows is not health — and no
`unavailable`/`error` rows · attempt `status: succeeded` with `finished_at` set, no stage left
`running`, lease released · runtime < 600 s and collect < 180 s · validation 0 errors with
warnings read · exact 7 GBP / 4 FB counts at the actual Friday-derived dates (the week_of
Monday table) with identical round-trip · under budget with requested=served model · health
block valid and fresh · alert delivered (receipt + channel) · memory freshness (`last_success_at`
< 2 days) · **Carter's recorded content verdict (root decision 12)**. A `degraded` attempt is
never clean. Missing-attempt and pending-approval are different states; only approval pauses.

## 9. Verification (all future/L3; nothing has run)

- Per change set: the assembled single Node command (4.4) + `npm run lint` + Python checks when
  a `.py` file changed + one offline run with isolated out/store paths. No new frameworks; no
  fixture trees.
- G3: ownership/handoff coverage **beyond login** (release → takeover → idle → gated resumption),
  plus the stuck-poll/busy case.
- Media: concurrency (no double reservation), idempotent reruns, 8-week no-reuse across
  platforms, hash migration, archive-rename safety, pending-reference protection — cases in
  `scripts/lib/photo-selection.test.mjs` plus the G4 fixtures in `scripts/lib/gbp-paths.test.mjs`.
- T22: targeted final-contract acceptance once the cutover photo contract is frozen.
- `scripts/gbp-photo-pick.mjs --dry-run` is **not called safe** until the no-write/no-network
  preview fix lands; the driver dry-run is unaffected (returns before browser launch).
- Alert checks assert receipt **and** delivery.

## 10. Rollback

- **Code:** scope rollback to the reviewed patch per lane or an explicit fix-SHA allowlist;
  preserve pre-existing work and root-plan fixes (the entry-guard and observation-id fixes are
  never reverted). No blanket `git checkout` of files; no range reverts that mix unrelated
  commits. After commit, revert only the identified lane commit under normal approval
  boundaries. Disk rollback does not reload workers — any reload is a separate approved live
  step.
- **GBP:** owner-safe handoff — settle active work, stop the verified instance with lifecycle
  approval, confirm ownership released; the other worker exclusively reacquires, passes a probe,
  and is approved to resume. `MAV_BRIDGE_GBP` off during recovery. Never probe concurrently.
- **Database:** before-images and conditional-update evidence retained; restoring a status does
  **not** undo an external post — verify external results before rollback/retry; ambiguous
  outcomes get review, never an automatic reset.
- **Legacy SerpApi:** `SEO_LEGACY_SERPAPI=1` restores the tool.
- **Media:** reverse moves from the hash move log (moves only, no deletes).
- **Credentials/state:** never committed; any exposure is an immediate owner escalation.

## 11. Guardrails

- The legacy claims/gates/observability layer stays frozen until its own retirement session
  (S7). No new frameworks. `local-llm` never started; port 8080 never bound; no AIWA/Proxmox
  work. Agents never enter passwords or sign in to Google. No posting, deleting, boosting, or
  row resets without Carter's yes for that specific action. No pm2 CLI from agent shells. No
  commits or pushes unless Carter asks; session close is not commit authority.

---

**Final status: PROPOSED — integrated plan for Carter's review. Implementation requires his
separate explicit approval. Inputs unmodified; no checks executed; all verification in this
document is future work.**
