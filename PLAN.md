# PLAN.md - Weekly shadow pipeline: everything that must be fixed before cutover

**Status:** FINDINGS AND REQUIREMENTS. This is not an execution plan yet.
**Written:** 2026-09-13 (Sunday) by Claude, from the readout of the 2026-09-11 shadow run.
**Owner:** Carter. **Goal he set:** the shadow run is perfect by 2026-09-30 so the switchover
to `scripts/weekly` can happen the week of 2026-09-28 (rebuild plan sections 5 and 6).
**Next step:** an agent reads this file plus the files in section 0.2, then rewrites this file
in place into an execution plan that satisfies section 9.

---

## 0. How to use this document

### 0.1 What it is and is not

- It lists every defect, gap, and decision found while auditing the 2026-09-11 shadow run,
  with evidence, the code location, the required outcome, and how to verify it.
- It does not assign tasks, order work, or estimate effort. That is the execution plan's job.
- Nothing here changes the rebuild plan of record. Where this file and
  `docs/rebuild/2026-09-06-weekly-pipeline-rebuild-plan.md` disagree, say so in the execution
  plan and let Carter decide (section 7).

### 0.2 Read these before rewriting (in this order)

| File | Why |
|---|---|
| `AGENTS.md` at `D:\Workspace` (workspace root) | Carter's standing rules: Orca orchestration with cheap subagent workers, model ladder, no commits or pushes unless asked. Quoted in 0.3. |
| `docs/rebuild/2026-09-06-weekly-pipeline-rebuild-plan.md` | Plan of record. Section 5 = cutover criteria. Section 6 = S1-S7 work breakdown and dates. Section 7 = out of scope. Section 8 = the public-repo decision. |
| `scripts/weekly/DESIGN.md` | Binding module contracts, schemas, thresholds. Any change to an exported name or schema must be called out. |
| `scripts/weekly/README.md` | Modes, options, what a run writes, how to read `summary.md`, test commands. |
| `FRIDAY-RUNBOOK.md` | How the Friday run is scheduled, the wrapper, health file, watchdog, and the "Rebuilt pipeline - shadow mode" section. |
| `scripts/run-weekly-seo.py` | The scheduler wrapper. `run_shadow_pipeline()` at lines 282-321 is where the shadow launch, timeout, and health write live. |
| `scripts/weekly/run.mjs` | Orchestrator CLI. Notify block near line 734, model resolution line 557, validate/regenerate lines 641-660, entry guard lines 798-802. |
| `scripts/weekly/lib/collectors/serpapi.mjs` | The sequential SerpApi loop, lines 487-545. |
| `scripts/weekly/lib/select.mjs` | Thresholds lines 48-77, `scoreCandidate` lines 511-560, `performanceByService` lines 446-490. |
| `scripts/weekly/lib/validate.mjs` | `checkBoost` lines 520-557, text rules. |
| `scripts/weekly/lib/generate.mjs` | Single repair call, lines 410-470. |
| `scripts/weekly/lib/prompts/plan.system.md` | Editorial rules. Lines 66-68 already forbid invented stories; lines 113-135 Facebook rules; lines 150-160 boost rules. |
| `scripts/weekly/lib/reconcile.mjs`, `scripts/weekly/reconcile.mjs` | Performance memory writer. Availability rule line 47, plan-item link lines 115-118, video fallback lines 45-58 of the CLI. |
| `scripts/weekly/lib/notify.mjs` | Attempt-bound alert with receipts. Already built and tested, never invoked by the wrapper. |
| `scripts/seo-monitor.mjs`, `scripts/seo-watchdog.mjs` | Neither knows the shadow run exists. |
| `config/weekly-policy.json` | `serp`, `models`, `pricing`, `weights`, `selection` overrides. |
| `supabase/migrations/003_weekly_pipeline.sql` | The five shadow tables. |
| `C:\Workspace\Active\brain\inbox\2026-09-11-friday-seo-run-fixes.md` | What happened on 9/11, what was already fixed (commits f381214, 297bb82), and its open threads. |
| `C:\Workspace\Active\brain\inbox\2026-09-13-seo-shadow-run-readout-and-plan.md` | The readout this plan was written from. |
| `outputs/shadow/summary.md`, `outputs/shadow/compare.md`, `outputs/weekly-shadow-2026-09-11.log` | The actual artifacts of the 9/11 run (local only, `outputs/` is gitignored). |

### 0.3 Carter's rules that bind the execution plan

**Workers.** Execution work goes through Orca orchestration: the coordinating agent plans and
reviews, cheaper subagents do the edits. From `AGENTS.md`:

- `deepseek/deepseek-v4-flash`: small edits, docs, tests, routine execution
- `zai-code/glm-4.7` or `zai-code/glm-5.2`: normal build work
- `zai-code/glm-5.3`: harder work only
- `nvidia-nim` free models: tiny jobs only (40 requests per minute cap)
- Frontier models (Claude, GPT): reasoning, review, specs, and anything security or
  infrastructure sensitive. The reviewer of every worker's output is a frontier model.

Check `orca status --json` first. If Orca is down, say so and do not substitute a full handoff.

**Tests: only necessary ones.** Add a test only when (a) the failure it guards was, or would be,
silent in production, or (b) a contract in `DESIGN.md` changes. No tests for cosmetic changes,
logging, or docs. No new frameworks or fixture trees. Run the existing suites once per change
set: `node --test scripts/weekly/test/*.test.mjs` (627 tests on 9/11), `npm run lint`, and the
Python suite under `tests/` only when a `.py` file changes. The e2e offline run
(`node scripts/weekly/run.mjs --mode offline`) is the integration test; use it, do not duplicate it.

**Standing rules.** No commits or pushes unless Carter asks. Shadow mode never writes
`weekly_posts`, `website_tasks`, or the legacy `outputs/*.md`, and never publishes. Never print
or commit secrets. Do not bind port 8080. Do not start `local-llm`. The PC is the source of truth.
The GitHub repository is public (verified 2026-09-13): keep hostnames, project references, phone
numbers, and tokens out of committed documents.

---

## 1. Where things stand

### 1.1 Shadow attempts to date

| Week of | Attempt | How launched | Result | Runtime | Spend | Topic |
|---|---|---|---|---|---|---|
| 2026-09-07 | `...760a01` | manual, Saturday 9/06 | succeeded | 755 s (collect 734 s) | $0.82 | Electrical Troubleshooting & Repair, Rockwall |
| 2026-09-14 | `...65f703` | manual, 4th try on 9/11 | succeeded | 43 s (warm SerpApi cache) | $0.19 | Outlet, Switch & GFCI Installation, Rowlett |

There has never been an unattended scheduled shadow success. The 9/11 scheduled launch exited
without running (entry guard, fixed in f381214). Attempts 1 and 2 on 9/11 ran while the PC was on
the KB5124008 build with a jammed service layer, so their stalls are environment noise and not
counted as pipeline defects. Two real defects did surface that day and are already fixed:
content-derived observation ids colliding across weeks (297bb82) and the entry guard (f381214).
One real defect surfaced and is not fixed: boost over-allocation (D1).

### 1.2 Cutover scorecard (rebuild plan section 5: two consecutive clean shadow Fridays)

| Criterion | 9/06 week | 9/11 week | Notes |
|---|---|---|---|
| Finished under 10 minutes | no, 12.6 min | 43 s warm only | cold-cache baseline is over the limit (B1) |
| Schema-valid revision | yes | yes | |
| Passed all facts checks | yes | yes | 0 errors, 0 warnings |
| Markdown round-trips with identical row counts | yes | yes | 7 GBP, 4 FB |
| Under budget | $0.82 of $20 | $0.19 of $20 | |
| Unattended scheduled success | no | no | E1 |
| Content-quality approval from Carter | not given | not given | F2 |

Remaining shadow Fridays before the deadline: 2026-09-18 and 2026-09-25. Both must be clean.

### 1.3 What was good on 9/11 (do not break these)

All four collectors healthy (Search Console 2943 rows, Facebook 18, SerpApi 80 of 80, history 216).
Validation clean after one regeneration. Dates all on spec. No phone, domain, tenure, or price
violations. Winner service on exactly 3 of 7 GBP days. Winner city named in 6 GBP and 3 FB posts.
GBP headlines 36-42 chars; FB bodies 60-70 words; no phone in captions; every slot has a photo.
14 plan items stored. Spend metered per call.

---

## 2. Findings, group A: delivery and observability (why Carter got nothing)

Each finding: **Evidence**, **Cause / anchor**, **Required outcome**, **Verify**, **Tests**.

### A1. The wrapper never asks for the alert

- **Evidence:** `outputs/weekly-shadow-2026-09-11.log` shows the launch as
  `run.mjs --mode shadow --week-of 2026-09-14`. No `--notify`. The Supabase attempt row for
  `...65f703` has no `notify:*` stage. Carter had to ask for the results two days later.
- **Cause / anchor:** `scripts/run-weekly-seo.py:296` builds the command without `--notify`.
  `run.mjs:734` only notifies when the flag is present. `lib/notify.mjs` is complete and tested.
- **Required outcome:** every shadow (and later `new`) run sends one attempt-bound alert on
  `succeeded`, `degraded`, and `failed`, carrying topic, counts, validation result, runtime,
  spend, and the summary path. Idempotent per attempt and event (the receipt mechanism exists).
- **Verify:** `seo_attempts.stages` has `notify:<event>` with `status: ok` and `error: via hermes`;
  Carter receives it on the Friday.
- **Tests:** none new; `core-3-notify-reconcile.test.mjs` already covers notify.
- **Related:** secondary channels are dead (inbox 9/11, open thread 7): SMTP returns 535 because
  `SMTP_APP_PASSWORD` is unset, direct Slack is `account_inactive`. Hermes is the only route.
  Decide whether to restore one backup channel (section 7, decision 1).

### A2. The health file cannot tell a no-op from a success

- **Evidence:** at 13:44Z on 9/11 the wrapper recorded `shadow.status = "success"` for a launch
  that ran zero stages. The field is free text and was hand-edited afterwards.
- **Cause / anchor:** `run-weekly-seo.py:312-321` derives status from the exit code alone and
  writes `{status, at, log_file}`.
- **Required outcome:** the wrapper reads `outputs/shadow/attempt.json` after the child exits
  and writes a structured block: `attempt_id`, `status` (from the attempt, not the exit code),
  `week_of`, `started_at`, `finished_at`, `runtime_s`, `spent_usd`, `summary_path`,
  `log_file`. If no attempt for the expected `week_of` was written after launch time, status is
  `failed (no attempt written)`. Never `success` without an attempt id.
- **Verify:** run `--mode offline` through the wrapper path and inspect the block; simulate a
  no-op child (exit 0, no attempt) and confirm `failed`.
- **Tests:** one Python test in `tests/test_friday_fixes.py` for the no-op case. It guards a
  silent failure, so it qualifies.

### A3. Monitor and watchdog are blind to the shadow run

- **Evidence:** `grep -i shadow scripts/seo-monitor.mjs scripts/seo-watchdog.mjs` returns
  nothing. Rebuild plan S5 said "monitor and watchdog read attempts"; that part did not land.
- **Cause / anchor:** both scripts key everything on the legacy `status` in
  `outputs/weekly-runner-health.json` (`seo-watchdog.mjs:56`, `seo-monitor.mjs:55`).
- **Required outcome:** on run day the watchdog also checks the `shadow` block from A2:
  missing after the legacy run succeeded (shadow no-show), `failed`, `running` for more than the
  wrapper timeout (hung), and success without a notify receipt (notify miss). Same alert path
  as the legacy checks. After cutover the same checks apply to the `new` mode.
- **Verify:** feed the watchdog a health file for each case and see the four alerts.
- **Tests:** the watchdog has none today; add none unless a pure function is extracted, in
  which case one table test for the four states is enough.

### A4. There is no review surface

- **Evidence:** rebuild plan section 5 says Carter reviews the shadow plan "in the Marketing
  Control dashboard or the Markdown export". Neither MCC nor `marketing-control/` reads
  `seo_attempts` or `outputs/shadow/`. The Markdown export exists but nothing points Carter at it.
- **Required outcome:** decide the review surface (section 7, decision 2). Recommended: the A1
  alert carries the summary path and a five-line digest, and `summary.md` is the review document.
  A dashboard card is out of scope per rebuild plan section 7 unless Carter says otherwise.
- **Tests:** none.

### A5. Compare report cosmetics

- **Evidence:** `outputs/shadow/compare.md` says the attempt is `running` and "not finished at
  compare time" because compare runs before finish (`run.mjs` order), and "Legacy runtime and
  spend: not recorded by the legacy pipeline" even though the wrapper logs the research duration
  (678 s on 9/11).
- **Anchor:** `lib/compare.mjs:220-238`.
- **Required outcome:** compare renders after the attempt is finalized, or the attempt section
  is re-rendered at finish. The wrapper passes the legacy research duration (and spend if known)
  so the comparison is two-sided.
- **Tests:** none new; `stage.compare.test.mjs` exists, adjust only if its assertions change.

---

## 3. Findings, group B: runtime and cost

### B1. Cold-cache SerpApi collect alone exceeds the 10-minute criterion

- **Evidence:** week 1 (healthy PC, cold cache): collect 734 s of a 755 s run, 79 live calls.
  9/11 attempt 4 collected in 14 s only because attempts 2 and 3 had warmed the cache.
  `config/weekly-policy.json`: `serp.max_calls` 80, `cache_days` 5 (so every Friday is cold by
  design), `rotate_weekly` true. Rebuild plan section 4 said 60 calls and a 7-day cache.
- **Cause / anchor:** `lib/collectors/serpapi.mjs:487-545` awaits each call in series;
  `DEFAULT_TIMEOUT_MS` 30 s (line 40). Worst case 80 x 30 s = 40 min, over the wrapper's 30-min
  kill (`run-weekly-seo.py:308`).
- **Required outcome:** collect finishes in under 3 minutes on a cold cache with a healthy
  network. Bounded concurrency (4 to 6 in flight), the same per-call timeout, plus a total
  collect deadline after which remaining queries are recorded `unavailable` with a note and the
  run continues `degraded`. Cache and cap semantics unchanged (a live call is metered when the
  2xx arrives, cached hits never count).
- **Verify:** one live shadow run on a cold cache shows `collect` under 3 min in
  `attempt.json.stages`; the rotation still covers every query every 3 weeks.
- **Tests:** the collector has unit tests with an injected `fetchImpl`; extend one to assert
  the in-flight bound and the deadline. That is a contract change, so it qualifies.
- **Decision:** whether to move to the section 4 numbers (60 calls, 7-day cache) or keep
  80 and 5 (decision 3).

### B2. A killed run leaves the attempt `running` and the lease held

- **Evidence:** attempt `...329070` on 9/11 was killed by hand at 34 min and had to be marked
  failed by hand in Supabase; its `collect` stage still says `running`. The wrapper's 30-min
  timeout would do the same to a scheduled run.
- **Anchor:** `run-weekly-seo.py:308-314` (timeout kills the child), `run.mjs` has no signal
  handler; `lib/attempt.mjs` `finishAttempt` is only reached on the normal path.
- **Required outcome:** on SIGTERM/SIGINT/timeout the orchestrator finalizes the attempt as
  `failed` with the reason and releases the lease; if the child cannot, the wrapper patches the
  attempt record itself. The 30-min lease TTL already bounds the damage but the record must be
  truthful.
- **Verify:** start an offline run, kill it mid-collect, confirm the file-store attempt says
  `failed` and the lease file is gone.
- **Tests:** one e2e-offline case for the kill path if a handler is added (silent failure guard).

### B3. Model identity is not pinned and the served model is not what was requested

- **Evidence:** `WEEKLY_MODEL` is not set in `.env`. `run.mjs:557` falls back to
  `policy.models.generate` = `deepseek-chat`. The API response reported `deepseek-flash`
  (`outputs/shadow/meter.json` entries), and `policy.pricing` has no `deepseek-flash` entry, so
  the meter priced it through the fallback model. Rebuild plan section 4 requires an explicit
  model id in `.env` verified by a one-token probe in preflight; there is no probe today (only a
  key-presence check).
- **Required outcome:** `WEEKLY_MODEL` set explicitly; pricing entries for every model the API
  can report; the meter records both requested and served model and warns when they differ;
  the wrapper preflight makes one tiny metered call and fails the run early on auth or model
  errors. Which model to pin is decision 4.
- **Verify:** `meter.json` entries show requested and served ids; preflight log line.
- **Tests:** `cost-meter` has tests; extend one for the served-model pricing path only if the
  record shape changes.

### B4. Budget after cutover

- **Evidence:** rebuild plan section 4: `WEEKLY_BUDGET_USD` 20 during shadow, 5 after cutover.
  Actual spend is $0.19 to $0.82. No defect; the execution plan should schedule the change of
  ceiling for the cutover session and confirm the refusal-to-start path is exercised offline.

---

## 4. Findings, group C: selection quality

### C1. The winner was chosen on a single impression

- **Evidence:** `outputs/shadow/summary.md`, winner scores: demand 0.20 (all of it the
  People-Also-Ask bonus; 1 impression in 28 days against a max of 485), opportunity 1.00 (one
  impression at position 11, plus the local-pack bonus). 103 of 250 candidates had 10 or more
  impressions; the runner-up had 32.
- **Cause / anchor:** `lib/select.mjs:541-543` computes opportunity from the impressions-weighted
  position with no minimum sample; `opportunityFromPosition` (line 116) is a step function
  (1.0 / 0.6 / 0.3 / 0). The only minimum-impressions threshold in the file is
  `ctr_min_impressions: 10` (line 75) and it applies to performance, not opportunity.
- **Required outcome:** a new threshold `opportunity_min_impressions` (default 10, overridable
  under `policy.selection`) below which the position evidence is treated as no data (score
  `opportunity_no_data`, rationale says "insufficient impressions"). Consider scaling the
  in-range score by sample size instead of a hard step; the execution plan may propose either,
  Carter picks (decision 5). The rationale text must state the sample size, as it does today.
- **Verify:** re-rank the 9/11 inputs offline (`outputs/shadow/observations.jsonl` and
  `selection.json` are on disk; `rankCandidates` is pure) and show the new top 5 next to the old.
- **Tests:** `select` has fixture tests; one case for the floor. Contract change, qualifies.

### C2. The performance signal is a constant for most candidates

- **Evidence:** performance = 0.50 ("no performance data") for the winner and 150 of 250
  candidates. `performance_observations` has 884 rows written by reconcile and nothing reads
  them: `grep -rl performance_observations scripts src` returns only the reconcile files and
  their test. Selection instead joins the live 28-day Facebook collector (18 posts) to history
  by `platform_post_id` and uses Search Console CTR (`select.mjs:446-490`).
- **Required outcome:** decide (decision 6) between (a) the history collector also reading
  matured 7/28-day rows from `performance_observations` so selection uses the memory layer the
  rebuild built, or (b) declaring the table post-cutover only and documenting that. Recommended: (a),
  because it is the only path by which "did last week's post help" reaches next week's choice.
- **Tests:** if (a), one history-collector fixture case.

### C3. Facebook insights are unavailable for most posts

- **Evidence:** in `performance_observations`, 12 of 19 Facebook posts are `unavailable` for
  every metric. All 12 have bare numeric ids; all 7 `ok` posts have the `pageid_postid` form.
  The 9/11 reconcile log: `video fields failed (400): (#100) Tried accessing nonexisting field
  (views)`.
- **Cause / anchor:** `weekly_posts.platform_post_id` stores a video id for video rows (the
  bridge stores it that way, inbox 9/11) and the client requests `{id}/insights` with post
  metrics (`scripts/lib/facebook-insights.mjs:172,191`); the video fallback in
  `scripts/weekly/reconcile.mjs:48-58` asks for a field the Graph version rejects.
- **Required outcome:** every published post yields at least reach/impressions and one
  engagement metric: use the `pageid_id` form where a bare id is stored, and a video insights
  path that the page token can read (or record `not_mature`/`unavailable` with the precise
  reason). Then `node scripts/weekly/reconcile.mjs --retry-unavailable` backfills.
- **Verify:** after the backfill, `unavailable` rows for the 12 posts are replaced by values.
- **Tests:** `core-3-notify-reconcile.test.mjs` covers the reconcile writer; add one case only
  if the id-normalization is a new pure function.

### C4. Plan items never link to performance (post-cutover contract)

- **Evidence:** every `performance_observations.plan_item_id` is null. By design pre-cutover:
  reconcile links by `plan_items.projected_ref` (`lib/reconcile.mjs:115-118`) and shadow never
  projects. Search Console rows are always null (`lib/reconcile.mjs:174`).
- **Required outcome:** the S7 projection must write `projected_ref` in the exact form the
  reconcile join expects (the Facebook Graph post id as stored by the bridge, the GBP post id
  once the poster reports one). Search Console page rows should link to website items by
  `target` URL. This is a cutover-session requirement, not a shadow fix; the execution plan
  records it so S7 does not miss it.

### C5. Reconcile is not scheduled

- **Evidence:** `outputs/weekly-reconcile-2026-09-11.log`: "manual reconcile (task not
  registered)". `scripts/setup-scheduled-tasks.ps1:121` registers 'Grizzly SEO Reconcile' but
  must be run from an elevated shell by Carter.
- **Required outcome:** Carter runs the setup script once (owner action, decision 7 lists it);
  until then the execution plan schedules a manual daily run and the watchdog (A3) alerts when
  the last reconcile is older than 2 days.

---

## 5. Findings, group D: generation and validation quality

### D1. Boost over-allocation fails the week instead of being corrected

- **Evidence:** 9/11 attempt 3 failed: "boost YES rows total $90 (day 1 $10x5 + day 5 $40x1),
  must equal $50" after the single regeneration. The prompt already spells out the arithmetic
  (`plan.system.md:150-153`). Attempt 4 happened to comply.
- **Cause / anchor:** the only correction path is one model regeneration (`run.mjs:641-660`,
  `generate.mjs:453-463`). Money arithmetic is left to the model.
- **Required outcome:** code owns the arithmetic. A deterministic normalizer runs before
  `validatePlan`: keep the model's YES decisions (at most `FB_MAX_YES_ROWS`), then set
  `daily_usd` and `days` so the YES rows sum exactly to `policy.boost_weekly_usd` (for n YES
  rows: `budget / n` per day for 1 day, or an allocation table in policy); clear dollars on
  MAYBE/NO rows; write a validation warning "boost normalized from $X" so the summary shows it
  happened. The validator stays as the backstop. Regeneration is reserved for non-arithmetic
  errors.
- **Verify:** feed the attempt-3 plan (`plan_revisions` `...fbeb8b-r1`) through the normalizer
  offline and confirm it validates.
- **Tests:** one unit case for the normalizer with the $90 example (silent-failure guard:
  without it a whole Friday is lost). Qualifies.

### D2. Invented job anecdotes in Facebook copy

- **Evidence:** 9/11 plan, FB day 3 hook: "We opened a panel in Rowlett last week and found
  three breakers labeled with nothing but a Sharpie squiggle." FB day 5 hook: "Before: a
  Garland bedroom with one outlet behind the dresser. After: outlets where the furniture
  actually goes." Neither job exists in the facts or the photos. `plan.system.md:66-68`
  already forbids "we just finished" stories the photos do not show, so this is a compliance
  failure, not a missing rule.
- **Required outcome:** (a) the prompt names the pattern explicitly with a forbidden and an
  allowed example ("We opened a panel in Rowlett last week..." forbidden; "When a panel has
  breakers labeled with a Sharpie squiggle..." allowed), and states that Before/After format
  requires photos that show before and after; (b) `validate.mjs` gains a text rule that flags
  first-person past-tense job claims ("we opened", "we found", "we added", "last week",
  "yesterday", "Before:" without two photos) as an error, so the regeneration path corrects it;
  (c) optional and off by default: a cheap LLM-judge pass. Whether any anecdote is ever
  acceptable voice is decision 8.
- **Verify:** the 9/11 plan fails the new rule on days 3 and 5; the 9/06 plan is checked too.
- **Tests:** one table test for the new text rule (it is a validator contract). Qualifies.

### D3. Carousel with a single photo

- **Evidence:** FB day 5 is `carousel` with one `photo_file`. `FbItemSchema` allows only one
  photo; the prompt says carousel "when the topic plausibly has 2 or more related job photos"
  (`plan.system.md:114-115`).
- **Required outcome:** decision 9: either the validator downgrades `carousel` to `photo` when
  the inventory has fewer than 2 photos of the service (a warning, not an error), or the schema
  gains `photo_files[]` for carousels and the cutover projection maps them for
  `fb-photo-pick.mjs`. Recommended: the downgrade now, the schema later if wanted.
- **Tests:** covered by the D2 validator table test if implemented as a text/structure rule.

### D4. Website actions ship without drafts and without a blog post

- **Evidence:** all 3 website actions on 9/11 have `draft: null`; legacy produced a blog draft
  the same week. `WebsiteActionSchema` allows null drafts.
- **Required outcome:** decision 10: what the projection into `website_tasks` needs at cutover
  (title and description only, or a draft for `website_blog_post` and
  `website_service_page_update`). If drafts are required, the prompt must ask for them and the
  budget ceiling checked, since drafts add output tokens.

### D5. Boost targeting radius ignores the post's city

- **Evidence:** FB day 5 targets Garland in the copy; `boost_targeting` says "15mi Rowlett".
  The prompt (`plan.system.md:157-159`) says to center on the winner city.
- **Required outcome:** rule reads "center on the city named in the post; winner city when the
  post names none". Prompt-only change. No test.

---

## 6. Findings, group E: scheduler path and rehearsal

### E1. The scheduled path has never succeeded, and the guard fix has no automated check

- **Evidence:** both successful attempts were manual. The 9/11 no-op was silent for 8 minutes
  and would have been silent all week without a human reading the log.
- **Anchor:** `run.mjs:798-802` now realpaths both sides. No test executes `run.mjs` through an
  alternate path.
- **Required outcome:** one e2e-offline case spawns `run.mjs --mode offline` via a path that
  differs from its realpath (a junction or a relative path with `..` segments works on Windows
  without admin rights) and asserts an attempt was written. Qualifies: it guards a silent
  Friday failure. Plus a pre-Friday rehearsal step in the runbook: Thursday, run the wrapper's
  shadow function in `offline` mode via the `C:\Workspace` path the scheduler uses, and read the
  A2 health block.

### E2. Confirm the scheduled task's action path

- The task launches via `C:\Workspace\Active\SEO-Agents-App` (junction). After A2 and E1 this
  is safe, but the execution plan should include one read-only check of the registered action
  (use `Get-CimInstance`-based queries or the task XML; `schtasks` and `Get-ScheduledTask` hang
  from sandboxed shells, see memory `gbp-driver-needs-unlocked-desktop-or-session0`).

### E3. Freeze window

- After the fixes land for 9/18, only bug fixes until 9/25 so the two Fridays measure the same
  pipeline. Any change between the two runs is listed in the handoff note with its reason.

---

## 7. Decisions needed from Carter

1. **Alert channels.** Hermes only, or also restore one backup (SMTP app password, or a working
   Slack route)? Hermes-only means a Hermes outage equals silence.
2. **Review surface.** Markdown summary delivered by alert (recommended), or a dashboard card in
   Marketing Control (out of scope per rebuild plan section 7).
3. **SerpApi numbers.** Keep policy (80 calls, 5-day cache) or move to rebuild section 4
   (60 calls, 7-day cache)?
4. **Model to pin.** `deepseek-chat` as requested, the `deepseek-flash` the API actually served,
   or `deepseek-v4-flash` (already priced in policy)? Quality of the two 9/11 plans came from the
   served model.
5. **Opportunity floor.** Hard floor at 10 impressions, or sample-size scaling?
6. **Performance memory.** Wire `performance_observations` into selection now (recommended) or
   post-cutover?
7. **Owner actions.** Run `scripts\setup-scheduled-tasks.ps1` elevated to register 'Grizzly SEO
   Reconcile'; confirm 'Grizzly SEO GBP Worker' is disabled; the GBP re-auth noted in the 9/12
   inbox.
8. **Anecdotes.** Never, or allowed when phrased as hypothetical ("When we open a panel and
   find...")?
9. **Carousel.** Downgrade to photo when fewer than 2 photos (recommended now), or multi-photo
   schema?
10. **Website drafts.** Required at projection or not?
11. **Repository visibility.** Rebuild plan section 8.3 asked for private before S4. It is
    still public. Make it private, or keep operational documents (including this one) out.
12. **Content approval mechanism.** How Carter records "approved" for a shadow week: a reply to
    the alert, a field on `seo_attempts`, or a line in the handoff note. The cutover criterion
    needs a record.

---

## 8. Proposed timeline anchors (for the execution plan to refine)

| Date | What |
|---|---|
| Mon 9/14 to Wed 9/16 | All group A, B, D, E fixes and C1, C3 landed and reviewed. C2 if decision 6 says now. |
| Thu 9/17 | Offline rehearsal via the scheduler path (E1); reconcile backfill (C3); freeze. |
| Fri 9/18 08:30 | Scheduled legacy run then shadow run, unattended. Alert arrives (A1). Carter reviews `summary.md`, records approval (decision 12). |
| 9/19 to 9/24 | Bug fixes only. Handoff note lists every change. |
| Fri 9/25 08:30 | Second clean Friday. Same review. |
| Week of 9/28 | Cutover session per rebuild plan S7 (projection, `--pipeline new`, legacy crews disabled, budget ceiling to $5, docs). First production run Fri 10/2. |

If 9/18 is not clean, 9/25 and 10/2 become the pair and cutover slips one week. Say so in the
handoff note rather than bending the criterion.

---

## 9. What the execution plan must contain (instructions for the rewriting agent)

Rewrite this file in place. Keep sections 1 and 7 as reference (they are the evidence and the
open decisions). Replace sections 2 to 6 and 8 with:

1. **A task list**, one task per finding or per coherent group of findings, each with: id,
   the finding ids it closes, files to change, the exact required outcome copied or tightened
   from here, acceptance check, worker model tier from 0.3, reviewer (frontier), and whether a
   test is added under the 0.3 test rule (name the test file and the single case).
2. **Dependencies and order.** A2 before A3; A1 before the 9/18 run; D1 and D2 before 9/18
   because they change plan output; B1 before 9/18 because runtime is a criterion; C2 only if
   decision 6 says now; C4 and D4 go to the cutover session.
3. **The decisions block** with Carter's answers filled in once given. Tasks blocked on a
   decision say so and carry the recommended default so work can start.
4. **Orca run shape**: how many workers, which terminals, what the coordinator reviews, and the
   single test command per change set. Check `orca status --json` before dispatch.
5. **Verification for each Friday** (a checklist an agent can execute Friday 09:30): alert
   received, health block valid, attempt `succeeded` under 10 min, validation clean, counts 7/4,
   spend, `compare.md` present, no `unavailable` sources, approval recorded.
6. **Rollback**: every change is on `main` behind `SEO_PIPELINE=shadow`; the legacy chain is
   untouched until S7; list the commit range to revert if 9/18 regresses.
7. **Out of scope** restated: GBP poster session and photo problems, Facebook publisher
   internals, boosting execution, Thumbtack, dashboards, hosting (rebuild plan section 7).

Do not start execution while rewriting. Do not commit or push unless Carter asks.

---

## Appendix: evidence pointers

- Attempt ids (Supabase `seo_attempts`, week 2026-09-14): `2026-09-14-20260911T135204Z-329070`
  (killed), `2026-09-14-20260911T143357Z-f258a6` (duplicate id), `2026-09-14-20260911T154352Z-fbeb8b`
  (boost validation), `2026-09-14-20260911T155500Z-65f703` (succeeded, git 297bb82).
  Week 2026-09-07: `2026-09-07-20260906T115708Z-760a01`.
- Revisions: `...fbeb8b-r1` (validation.ok false, the $90 boost plan), `...65f703-r2` (ok).
- Observations for `...65f703`: search_console 2943, facebook 18, serpapi 80, history 216, all ok.
- `performance_observations`: 884 rows on 2026-09-13; Facebook 7 ok / 12 unavailable posts;
  Search Console 70 pages (7d) and 88 pages (28d); `plan_item_id` null on every row.
- Local artifacts (gitignored): `outputs/shadow/{summary,compare}.md`, `plan.json`,
  `selection.json`, `revision.json`, `observations.jsonl`, `meter.json`;
  `outputs/weekly-shadow-2026-09-11.log`; `outputs/weekly-runner-health.json`.
- Memory notes: `scheduled-node-scripts-c-vs-d-junction-guard`,
  `gbp-driver-needs-unlocked-desktop-or-session0`, `seo-shadow-friday-report-expected`,
  `workbench-per-user-services-crash-on-session-handoff` (why 9/11 attempts 1-2 stalled).
