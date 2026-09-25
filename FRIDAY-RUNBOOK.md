# Friday SEO Run — Runbook & Recovery

The weekly SEO workflow has **two independent persistence layers**, and they fail
in different ways. Most "Friday morning, nothing happened" incidents are a reboot
the night before, because neither layer survives a Windows reboot by default.

```
Layer 1 — Windows Task Scheduler        Layer 2 — PM2
  • Grizzly SEO Weekly Run (Fri 8:30)     • mav-console (MCC dashboard :3000)
  • Grizzly SEO Monitor   (Fri 8:30)      • mav-bridge  (:8790, executes approved runs)
        |                                  • prometheus-sync, etc.
        v
  run-weekly-seo.py --> seo-agents research <topic>
        --> outputs/ --> supabase-sync --> Supabase seo_runs (pending_approval)
                                              ^ mav-bridge polls this every 30s
```

MCC does **not** trigger the Friday run — it only displays/approves it. So "MCC is
down" and "the run didn't fire" are *separate* symptoms that often share one cause:
**the reboot.**

## One-time setup (makes it survive reboot)

Run both from an **elevated** PowerShell, after starting your PM2 apps once:

```powershell
pm2 start C:\Workspace\Active\MCC\ecosystem.config.cjs ; pm2 save
powershell -ExecutionPolicy Bypass -File C:\Workspace\Active\MCC\scripts\setup-pm2-boot.ps1
powershell -ExecutionPolicy Bypass -File C:\Workspace\Active\SEO-Agents-App\scripts\setup-scheduled-tasks.ps1
```

- `setup-pm2-boot.ps1` registers a boot task that runs `pm2 resurrect` (PM2's own
  `pm2 startup` is a no-op on Windows).
- `setup-scheduled-tasks.ps1` registers the weekly run + monitor with *run-whether-
  logged-on-or-not*, *run-if-missed*, and *wake-to-run* all enabled.
- Re-run `pm2 save` whenever you add/remove a PM2 app.

## 2-minute triage when Friday is dead

```powershell
# A) Did the scheduler even fire the jobs?
Get-ScheduledTask | ? {$_.TaskName -like 'Grizzly SEO*'} |
  Get-ScheduledTaskInfo | Format-List TaskName,LastRunTime,LastTaskResult,NextRunTime

# B) Did the wrapper start? (written the instant run-weekly-seo.py launches)
Get-Content C:\Workspace\Active\SEO-Agents-App\outputs\weekly-runner-health.json
Get-Content C:\Workspace\Active\SEO-Agents-App\outputs\weekly-runner-*.log -Tail 40

# C) Per-phase crew health, and is PM2 even alive?
Get-Content C:\Workspace\Active\SEO-Agents-App\outputs\run_health.json
pm2 ls
Get-Content "$env:USERPROFILE\.pm2\logs\mav-console-error.log" -Tail 40
```

Interpretation:

| Symptom | Cause | Fix |
|---|---|---|
| `LastRunTime` blank/old, no `weekly-runner-health.json` for today | Task never fired (reboot / logged-on-only) | re-run `setup-scheduled-tasks.ps1` |
| `weekly-runner-health.json` shows `failed`, log says "seo-agents not found" | crew not installed where task's Python can see it | `.\.venv\Scripts\Activate.ps1; pip install -e .` |
| `run_health.json` research = `failed` | crew ran and errored (API key, network) | read its `error`; check DEEPSEEK_API_KEY and ANTHROPIC_API_KEY in `.env` |
| `weekly-runner-health.json` shows `failed`, error says `Anthropic native provider not available` (or any `ImportError` under `crewai/llms/providers`) | venv was re-synced (`uv sync`) and a provider SDK that wasn't pinned got dropped (2026-09-04) | `uv sync` (the `crewai[anthropic]` extra is now pinned in `pyproject.toml`). Verify with `.\.venv\Scripts\python.exe -c "from seo_agents.crew import build_exec_llm; build_exec_llm()"`, then `Start-ScheduledTask -TaskName 'Grizzly SEO Weekly Run'` |
| crew log says `Could not acquire run lock: Another run is active: unknown` but no `seo-agents` process exists | an earlier crew died before releasing `outputs/lock.lock.json` (hard kill, or any pre-kickoff crash before the 2026-09-04 fix) | confirm nothing is running: `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'seo_agents|seo-agents' }`, then delete `outputs\lock.lock.json` and restart the task. Each failed attempt also appends to `state/topic-history.json`; trim those entries so the rotation is not skewed |
| `weekly-runner-health.json` shows `failed`, error starts `preflight: crew preflight failed` | The wrapper's pre-launch probe caught what Friday would have hit: a syntax error in `src/seo_agents`, the CLI dropping the research topic, or an LLM tier that cannot be constructed (missing SDK, bad model prefix). Nothing was launched. (2026-09-05) | Read the rest of the error line; it is the last lines of the probe's traceback. Reproduce with `.\.venv\Scripts\python.exe -c "import importlib.util as u; s=u.spec_from_file_location('r','scripts/run-weekly-seo.py'); m=u.module_from_spec(s); s.loader.exec_module(m); print(m.preflight())"`, fix, re-run the task |
| `weekly-runner-health.json` shows `failed`, error says `crew timed out after 150 min and was killed` | One attempt exceeded `SEO_CREW_TIMEOUT_MIN` (default 150). The wrapper killed `python -m seo_agents.main` directly and cleared `outputs/lock.lock.json` itself. (2026-09-05) | Read `outputs/weekly-crew-*.log` for where it stalled (usually a provider hanging). Re-run the task; no lock cleanup needed |
| Crew log says `Executor crew skipped — 0 of N queued tasks are executable` | Not a failure. Every queued task was blocked or waiting on the owner, so the executor crew did not run; GBP and Facebook schedules and the Supabase sync still ran. (2026-09-05) | Approve or resolve the owner-gated website tasks in MCC if you want them executed next week |
| `weekly-runner-health.json` shows `started` still set at 10:00 | Crew hung or wrapper never finished | Watchdog now SMS `HUNG` (≥90 min). Check `outputs/weekly-crew-*.log` |
| health `success` but no ping, MCC still pending | Hermes notify died (2026-08-28) | Watchdog SMS `NOTIFY MISS`. Look at `outputs/approval-notify.json` |
| Auto-approve on but run still `pending_approval` | `SEO_AUTO_APPROVE` didn't take (zero posts / CAS) | Watchdog SMS `AUTO-APPROVE DID NOT TAKE` |
| health `shadow.status` is `failed (...)` | The rebuilt pipeline's attempt record failed, was never written, or is a stale attempt from an earlier run | Watchdog/monitor SMS `PIPELINE FAILED`; read the log named in the block (`shadow.log_file`) |
| health `shadow.notify.sent` is not `true` after `succeeded`/`degraded` | The attempt finished but its alert was never confirmed delivered | Watchdog/monitor SMS `PIPELINE NOTIFY MISS`; the receipt names the channel or the failure |
| `outputs/reconcile-health.json` `last_success_at` older than `SEO_RECONCILE_STALE_HOURS` (48) | The daily memory pass is not advancing; selection would run on stale performance data | Watchdog/monitor SMS `RECONCILE STALE`; check the 'Grizzly SEO Reconcile' task |

`SEO_AUTO_APPROVE` lives in `.env` for `supabase-sync.mjs`, **not** in the watchdog. Default in `.env.example` is `0`. Saturday approve shifting GBP dates is fixed by `WeekSpec` (most recent Friday), not by the flag.


## Rebuilt pipeline (scripts/weekly) — shadow mode

The replacement for the CrewAI chain lives in `scripts/weekly/` (contract: `scripts/weekly/DESIGN.md`,
plan: `docs/rebuild/2026-09-06-weekly-pipeline-rebuild-plan.md`). Until cutover it runs in **shadow
mode**: same week, real collectors and one DeepSeek generation, but it writes only to the new Supabase
tables from migration 003 (`seo_attempts`, `research_observations`, `plan_revisions`, `plan_items`,
`performance_observations`) and to `outputs/shadow/`. It never touches `weekly_posts`, `website_tasks`,
or the legacy `outputs/*.md`, and it never publishes.

| Switch / command | Effect |
|---|---|
| `SEO_PIPELINE=shadow` in `.env` | `run-weekly-seo.py` launches the shadow run after a successful legacy run; result lands in `outputs/weekly-runner-health.json` under `shadow` and in `outputs/weekly-shadow-<date>.log`. Default `legacy` = nothing new runs. |
| `node scripts/weekly/run.mjs --mode shadow [--week-of YYYY-MM-DD]` | Manual shadow run for a week (Monday). Prints a one-screen summary; files under `outputs/shadow/`. |
| `node scripts/weekly/run.mjs --mode offline [--store <dir> --out <dir>]` | No network; fixture inputs and a canned plan. This is the end-to-end test and the pre-Friday rehearsal. |
| `run-weekly-seo.py --rehearsal` | The offline pipeline through the wrapper's own launch seam, in isolation (see below). No preflight, no legacy crew, no network, no alert channel. Exit 0 only when the attempt record says `succeeded` or `degraded`. |
| `SEO_SHADOW_TIMEOUT_MIN` | Minutes the wrapper gives one shadow/rehearsal attempt (default 30). A child killed at the deadline is reported, and the attempt it was on is marked `failed` with its lease released. |
| `node scripts/weekly/reconcile.mjs` | Daily memory pass: 7/28-day Facebook metrics per published post and page-level Search Console metrics into `performance_observations`; publish status copied to plan items. Idempotent. Registered as 'Grizzly SEO Reconcile' (daily 10:10) by `setup-scheduled-tasks.ps1`. |
| `WEEKLY_MODEL`, `WEEKLY_BUDGET_USD` | Generation model id (default `deepseek-chat`) and per-attempt ceiling (default 20). An attempt refuses to start past the ceiling. |

Compare a shadow week with the legacy output in `outputs/shadow/compare.md`: the finished attempt (status,
`finished_at`, runtime, spend) beside a two-sided legacy comparison (topic, counts, dates, facts
violations in the legacy copy). Cutover criteria are in the rebuild plan section 5.

### Offline rehearsal (before Friday, or after any wrapper change)

Run the offline pipeline through the wrapper's own launch seam, isolated under `SEO_REHEARSAL_DIR`
(`outputs/rehearsal` by default) so it cannot touch the legacy crew, the real shadow exports, or the
Friday health marker:

```powershell
$env:SEO_REHEARSAL_DIR = "$env:TEMP\seo-rehearsal"
.\.venv\Scripts\python.exe scripts\run-weekly-seo.py --rehearsal
```

It prints the `shadow` health block and writes the same block to
`$env:SEO_REHEARSAL_DIR\weekly-runner-health.json`:

| `shadow.status` | Means |
|---|---|
| `running` | The wrapper wrote the pre-launch marker / read the record before it finished |
| `succeeded` / `degraded` | The attempt record finished; rehearsal passes (exit 0) |
| `failed` | The attempt record says the run failed |
| `failed (no attempt written)` | The child exited without writing any attempt for this launch |
| `failed (stale attempt)` | Only an earlier attempt for this week exists — not this run's evidence |
| `failed (killed at the deadline)` | The wrapper killed the child at `SEO_SHADOW_TIMEOUT_MIN` |

`status` is always read from the attempt record (or from the engine's published
`outputs/shadow/current-attempt.json` when the store is remote), never from the child's exit code — the
exit code is carried only as `child.returncode` context. On a kill the wrapper finalizes the attempt
named in `current-attempt.json` (marked `failed`, running stages closed, lease released) and never
patches a foreign attempt.

## What the monitor now catches

`seo-monitor.mjs` (brand new, still growing toward self-healing) now also:
- **No-show alarm** — emails you if no run started by `SEO_NO_SHOW_DEADLINE`
  (default 09:00 local) on the run day. Previously a run that never started was
  completely silent; it only alerted on runs that started and *then* failed.
- **Cold-boot recovery** — if core PM2 processes are missing entirely (not just
  stopped), it runs `pm2 resurrect` once before falling back to `pm2 restart`.
- **Rebuilt-pipeline alarms (T3)** — the daily watchdog *and* the monitor read the same
  attempt-derived `shadow` block (and `outputs/reconcile-health.json`) and raise the same
  problems, so `new` mode needs no "legacy succeeded" dependency:

| Problem | Raised when |
|---|---|
| `PIPELINE NO-SHOW` | On the run day past `SEO_NO_SHOW_DEADLINE` there is no `shadow` block written today |
| `PIPELINE FAILED` | `shadow.status` reads `failed`, `failed (no attempt written)`, `failed (stale attempt)` or `failed (killed at the deadline)` |
| `PIPELINE HUNG` | `shadow.status` is still `running` `SEO_WATCHDOG_HUNG_MINUTES` (default 90) after the block was written |
| `PIPELINE NOTIFY MISS` | The attempt finished `succeeded`/`degraded` but `shadow.notify.sent` is not `true` |
| `RECONCILE STALE` | `outputs/reconcile-health.json` `last_success_at` is older than `SEO_RECONCILE_STALE_HOURS` (default 48), or was never written. Freshness is read from `last_success_at` only — never from table rows |

These checks are config-gated on `SEO_PIPELINE`: `shadow`/`new` are watched, `legacy`
(the default) adds nothing. Reconcile freshness is checked every day; the run-day checks
follow the same run-day/deadline gate as the legacy ones.

Tunables (in `.env`): `SEO_NO_SHOW_DEADLINE` (HH:mm), `SEO_RUN_DOW` (0=Sun…5=Fri),
`SEO_PIPELINE` (`legacy`|`shadow`|`new`), `SEO_RECONCILE_STALE_HOURS`, and the wrapper's
`SEO_SHADOW_TIMEOUT_MIN`. `shadow.notify` carries the attempt's `notify:<event>` receipt
(outcome, channel, timestamp) so a failed alert is visible without opening the alert body.

## Freeze between qualifying Fridays (T18)

The clean-Friday pair is only comparable if nothing material changes between the two
Fridays. **Between qualifying Fridays — and across the cutover boundary — the pipeline is
frozen: bug fixes only.** Every fix that does land is recorded here *before* the next
Friday, with a reviewer and an explicit comparability note.

| Date | File | Change | Reason | Reviewer | Comparability note |
|---|---|---|---|---|---|
| | | | | | |

- A change to generation, validation, media selection or scheduling is not a bug fix: it
  **resets the clean-Friday pair** (PLAN 8.1) — the two Fridays start again.
- The comparability note says whether the two Fridays can still be compared, and if not,
  what to compare them against instead.
- Same discipline at cutover: freeze the approved pipeline before the first production
  Friday, then keep the table current.

## Pre-live capacity check (T23)

A live run with no capacity left is not a degraded verdict — it is a wasted attempt. Before
**any** live collect (the Friday run, a live rehearsal, or a probe) read back all four rows
below and record the result, then decide. **The paid tier is Carter's decision; nothing here
implies purchase authority.**

| # | Read back | Where | Must be |
|---|---|---|---|
| 1 | Remaining SerpApi calls in the current plan window | SerpApi account usage page | > the planned calls for this attempt (plus any live rehearsal in the same window) |
| 2 | Valid cache coverage | `state/weekly/serp-cache` (key = sha1(query+location), `serp.cache_days`) | every planned query, or a miss count that fits row 1 |
| 3 | Planned consumption for this attempt | `policy.serp.max_calls` × planned queries | see the forecast below |
| 4 | Renewal date and allowance | SerpApi plan page | the renewal must cover the attempts before it |

Forecast to check against: **80 calls × 4-5 attempts/month = 320-400 calls**, which exceeds
the **250-call free plan**; the reported 10/5 renewal alone cannot fund a 10/2 run. The
options are Carter's — fewer calls (`config/weekly-policy.json`, lane B's file only), a
longer cache, or the paid tier. Decision 3 currently keeps **80 calls / 5-day cache**.

T5's live acceptance reuses the first candidate cold-Friday collect (no extra 80-call
rehearsal by default), so this check is the gate that decides whether that collect may run
live at all.

## Clean Fridays — the gate (T23 / PLAN 8.3)

Two **consecutive** genuinely clean Fridays. Each one requires:

- every required source present with **at least one `ok` observation** — a source with zero
  rows is not health — and no `unavailable`/`error` rows;
- attempt `status: succeeded` with `finished_at` set, no stage left `running`, lease released;
- runtime < 600 s and collect < 180 s;
- validation 0 errors, with warnings read;
- exact 7 GBP / 4 FB counts at the actual Friday-derived dates (the week_of Monday table),
  with an identical round-trip;
- under budget, with requested model = served model;
- health block valid and fresh, alert delivered (receipt + channel), and memory freshness
  (`last_success_at` < 2 days);
- **Carter's one-line content verdict, recorded below** (root decision 12).

A `degraded` attempt is never clean. Missing-attempt and pending-approval are different
states; only approval pauses. A later material change to generation, validation, media or
scheduling resets the pair (see the freeze section above) — that is why every such change is
recorded there.

| Friday | Attempt | Clean? (Y/N + failing line) | Content verdict (Carter, decision 12) |
|---|---|---|---|
| | | | |

## Facebook Engagement Pipeline (new — July 2026)

The Facebook schedule now generates **4 posts/week** (Mon, Wed, Fri, Sat) instead of 7. Every post uses engagement-focused CTAs (save, tag, vote, comment) instead of phone numbers. Phone numbers are posted as the **first comment** to avoid algorithm suppression.

### Key changes in the schedule format

| Field | Purpose |
|---|---|
| `POST_GOAL` | `education`, `social_proof`, `engagement`, or `entertainment` |
| `CTA` | Engagement invitation only — no phone numbers |
| `CONTACT` | Phone number (posted as first comment, not in caption) |
| `ON_SCREEN_TEXT` | Text overlays for video Reels |
| `BOOST` | `yes:$N`, `maybe`, or `no` |
| `BOOST_AMOUNT` | Daily budget for this post ($N) |
| `BOOST_DURATION` | Days to run boost (2, 3, 5, or 7) |
| `BOOST_TARGETING` | Targeting hint (e.g. "15mi Rowlett, homeowners 28-65") |

### Boost strategy ($50/week)

The CrewAI agent distributes $50/week across 1-3 posts. The schedule includes a **BOOST BUDGET SUMMARY** section at the bottom with allocation details. To boost:

1. Find posts with `BOOST: yes:$N` in the schedule
2. Open Facebook Page → Boost Post
3. Set daily budget to `BOOST_AMOUNT`, duration to `BOOST_DURATION`
4. Targeting: 15mi radius Rowlett, homeowners 28-65, home improvement/DIY/real estate interests. EXCLUDE "electrician" interest (that's competitors). Use Advantage+ Audience.

### Analytics feedback loop

`facebook-insights-collector.mjs` reads post performance and writes `facebook_engagement_report.md`. Run it manually before the Friday crew to feed last week's data into the content generator:

```bash
node scripts/facebook-insights-collector.mjs --days 7 --output outputs/facebook_engagement_report.md
```

### Manual organic reach tactics

These are NOT automated — do them yourself or delegate:
- Join 10-15 DFW community Facebook Groups as your Page
- Create a 5-10 person "seed network" (staff, family, past customers) who like+comment within the first hour of posting
- Reply to every comment within 15 minutes
- Post 1-2 Stories/day with interactive stickers (polls, questions)
