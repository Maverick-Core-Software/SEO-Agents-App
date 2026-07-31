# Handoff — Missed Friday SEO Run (2026-07-31)

**Written by:** a remote Claude Code session (cloud container, no access to CartersPC or the AIWA server)
**For:** a local Claude Code session that *can* reach the machines
**Branch:** `claude/seo-agents-app-status-cwntp2`

---

## Read this first

The user reported: *"The SEO agents app was supposed to run this morning. I didn't get any notifications about it."*

I investigated from a cloud container. I could read the **repo** and query **Supabase**, but I could **not** reach CartersPC, the AIWA server, Windows Task Scheduler, PM2, or the `outputs/` directory (gitignored, lives on the host). Everything below is split into **verified facts** and **unverified hypotheses**. Please don't treat the hypotheses as diagnosis — they're leads with specific commands to confirm or kill them.

**Late-breaking context from the user, received after the investigation:**
> "Some of these tasks were cut over to the aiwa server. We are working on moving a lot of processes over from my pc to the aiwa server for multiple reasons. But when I started doing that is when these issues started arising."

This context arrived after I'd done the Supabase work, and it **substantially reframes the findings**. The timeline below lines up almost exactly with a cutover window. I did not get to test the migration hypotheses — that's the main job for the local session.

---

## VERIFIED FACTS

### 1. Two consecutive Friday runs never happened

Scheduled runs fire Friday 08:30 local and write a `seo_runs` row with `week_of` = the following Monday. Full contents of `seo_runs` (only 4 rows exist):

| Friday | `week_of` row | `created_at` (UTC) | Status |
|---|---|---|---|
| Jul 3 | 2026-07-06 | 2026-07-03 20:34 | done |
| Jul 10 | 2026-07-13 | 2026-07-10 14:26 | done |
| Jul 17 | 2026-07-20 | 2026-07-17 14:20 | done |
| **Jul 24** | *(absent)* | — | **never ran** |
| **Jul 31** | *(absent)* | — | **never ran** |

Last successful scheduled run: **Friday Jul 17**.

### 2. Nothing has published since Jul 23 — 8 days dark

`run_logs` stops dead at **2026-07-23 14:12 UTC**. Prior to that it was a steady ~13 rows/day at ~14:00–14:12 UTC (09:00 Central) — the daily GBP post + verify cycle.

The mechanism is a cascade, not an independent failure: those daily posts were draining the *approved* schedule produced by the **Jul 17** run. That schedule ran out on Jul 23. Because the Jul 24 run never fired, no new approved content was ever queued, so the daily poster had nothing to do and went quiet. **Note that it went quiet without logging anything** — a poller with an empty queue looks identical to a dead poller in `run_logs`. Do not assume the GBP poster itself is broken; it may be perfectly healthy and simply starved.

### 3. The PC was up and healthy during all of this

`node_status` (node_id `homelab`) was updating **live** while I investigated — last write `2026-07-31 16:33 UTC`, i.e. minutes before this doc was written. It reported `pcUp: 1`, `serverUp: 1`, CPU ~15.9%, RAM ~41.9%, C: drive 25.8% used, all disks healthy.

**This rules out the runbook's primary hypothesis.** `FRIDAY-RUNBOOK.md` is built around "the machine rebooted overnight and nothing came back." That is not what happened. The box is up and reporting telemetry. Whatever broke is specific to the SEO scheduled tasks, not the host.

### 4. There is a stranded off-schedule run

One `seo_runs` row is anomalous — `id abcd2982-5cb6-4fda-9db0-169ed67ec631`, `week_of 2026-08-04`, created `2026-07-29 03:53 UTC` = **Tue Jul 28, 10:53 PM Central**. That is not a Friday 08:30 run.

- It produced **11 `weekly_posts`, all still `status = pending_approval`**. Never approved → never published.
- It produced **zero `website_tasks`**. Every prior run produced some; the most recent `website_tasks` row was created **Jul 17**. So this run was partial — the website phase either failed or was skipped.
- `seo_runs.status` is `pending_approval`; `approved_at` and `done_at` are both null.

**Ask the user whether this was them manually kicking off the crew to unstick things.** If so, it didn't work — it needs approval in MCC to publish anything, and it's been sitting for 3 days.

### 5. The watchdog cannot fire in the exact case it was built for

This is the answer to "why no notification," and it's a design flaw independent of the migration.

`scripts/setup-scheduled-tasks.ps1` registers the run and its monitor on the **identical** weekly trigger:

- `Grizzly SEO Photo Sync` → Friday 08:25 (`setup-scheduled-tasks.ps1:81`)
- `Grizzly SEO Weekly Run` → Friday 08:30 (`setup-scheduled-tasks.ps1:88`)
- `Grizzly SEO Monitor` → Friday 08:30 (`setup-scheduled-tasks.ps1:94`)

The no-show alarm `checkRunStarted()` lives **inside** the monitor process (`scripts/seo-monitor.mjs:487-515`). So when the failure mode is *"the scheduler didn't fire"*, the monitor doesn't start either, and the alarm built specifically to catch that case never executes. **The watchdog dies with the thing it watches.**

Corroborating evidence: `scripts/seo-monitor.mjs:547` sends a *"SEO Monitor Started"* email unconditionally at launch, before any checks. The user received **no** notifications at all — not even that one. That is strong evidence the monitor process never reached line 547, rather than starting and failing to alert.

### 6. `.env.example` is missing the vars the monitor requires to live

`scripts/seo-monitor.mjs:62-65`:

```js
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[seo-monitor] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — exiting');
  process.exit(1);
}
```

`.env.example` contains **zero** matches for `supabase` (case-insensitive), and zero for `SEO_NO_SHOW_DEADLINE` / `SEO_RUN_DOW`. Meanwhile `.pi/AGENTS.md` lists `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` as required env vars.

So `.env.example` is not a usable template for standing this app up on a new host. Anyone who provisions a new machine by copying `.env.example` → `.env` gets a monitor that **exits instantly with code 1 and sends nothing**. The only trace is a `console.error` line in a Task Scheduler log nobody reads.

### 7. The repo has no concept of the AIWA server

`grep -rn -i "aiwa"` across all `.md`, `.mjs`, `.py`, `.json`, `.ps1`, `.cjs` files returns **nothing**. (There is a root file literally named `AIWA Demo Script`, but it's a saved Microsoft login HTML page — junk, unrelated, safe to delete.)

Every operational path is hardcoded to the Windows PC. Files containing hardcoded `C:\Workspace`, `C:\Users`, `E:\Media`, or `M:\` paths:

```
5  src/seo_agents/actions.py
4  ops/gbp-worker-launch.vbs
2  src/seo_agents/main.py
2  src/seo_agents/crew.py
2  scripts/setup-scheduled-tasks.ps1
1  tests/conftest.py
1  src/seo_agents/website.py
1  src/seo_agents/evidence.py
1  scripts/seo-monitor.mjs
1  scripts/lib/gbp-runner.mjs
1  scripts/lib/gbp-api-auth.mjs
1  scripts/gbp-worker.mjs
1  scripts/gbp-photo-pick.mjs
1  scripts/fb-photo-rewrite.mjs
1  scripts/facebook-poster.mjs
```

Plus hard Windows coupling that will not survive a move to Linux:

- `scripts/seo-monitor.mjs:151,160,174` — `execSync('pm2 jlist' | 'pm2 restart' | 'pm2 resurrect')`
- `scripts/seo-monitor.mjs:185,194` — `net use M:` and `net use M: \\192.168.1.12\Proxmox` (SMB drive mapping, Windows-only)
- `scripts/lib/hermes-alert.mjs:12-13` — default `HERMES_CLI` is a hardcoded `C:\Users\carte\AppData\Local\hermes\...\hermes.exe`
- `ecosystem.config.cjs` — PM2 app with Windows `script`/`cwd` paths
- `windowsHide: true` scattered across `mav-bridge.mjs`, `run-phase.mjs`, `hermes-alert.mjs`, etc.

---

## HYPOTHESES — ranked, with how to test each

I could not test any of these. Ranked by how well they fit the evidence.

### H1 — Migration cutover moved/disabled the scheduled tasks (STRONGEST)

The user says the cutover began right when problems started. Last good run Jul 17; first miss Jul 24. If the Friday tasks were disabled, deleted, or moved to AIWA during that window, everything above follows: no run, no monitor, no alert, no content, daily poster starves.

**Test on CartersPC:**
```powershell
Get-ScheduledTask | ? {$_.TaskName -like 'Grizzly SEO*'} |
  Get-ScheduledTaskInfo | Format-List TaskName,LastRunTime,LastTaskResult,NextRunTime
Get-ScheduledTask | ? {$_.TaskName -like 'Grizzly SEO*'} | Select TaskName,State
```
Empty result → tasks were deleted. `State = Disabled` → someone turned them off. `LastRunTime` of Jul 17 with a non-zero `LastTaskResult` → they fired and failed.

**Then on AIWA:** find out whether an equivalent job exists there at all (cron/systemd timer/PM2). Given finding #7, if someone moved the job to AIWA the code almost certainly still points at `C:\Workspace\...` paths that don't exist there.

### H2 — Job runs on AIWA but `.env` was rebuilt from `.env.example` (STRONG, explains the total silence)

Per finding #6, a new `.env` derived from `.env.example` has no Supabase creds → monitor `process.exit(1)` immediately, silently. This explains the *complete* absence of notifications better than H1 alone, including the missing "Monitor Started" email.

**Test on AIWA:** locate the app's `.env` and check for `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SMTP_APP_PASSWORD`, `HERMES_CLI`, `HERMES_ALERT_TO`. Then run `node scripts/seo-monitor.mjs --run-hours 0` by hand and watch whether it prints the exit message.

### H3 — Split-brain: run on one host, monitor on the other (PLAUSIBLE)

If the run moved to AIWA but the monitor stayed on the PC (or vice versa), the monitor's no-show check reads `outputs/weekly-runner-health.json` from its **own local** `PROJECT_ROOT` (`seo-monitor.mjs:54`). A run on AIWA writes that marker on AIWA; a monitor on the PC sees nothing and *should* have fired a no-show alarm. It didn't — so either the monitor isn't running anywhere (H1/H2), or its alerting is broken.

**Test:** check for `outputs/weekly-runner-health.json` on **both** hosts and compare dates.

### H4 — Alert transport broke in the move (PLAUSIBLE, possibly additive)

`hermes-alert.mjs` shells out to a Windows `hermes.exe` at a hardcoded path. Commit `4c52a52` ("reroute mav-bridge alerts from dead iMessage to Slack via hermes send") shows this transport has already broken once. On AIWA that path doesn't exist → alerts throw. Note this affects the *hermes* path; the monitor's own `sendAlert` uses SMTP, so both transports need checking.

**Test:** on whichever host should be alerting, run the hermes CLI manually and send a test; separately verify SMTP by triggering `sendAlert`.

### H5 — S4U principal broke (LESS LIKELY, but cheap to check)

Tasks register with `-LogonType S4U` and `$RunAsUser = "$env:USERDOMAIN\$env:USERNAME"` (`setup-scheduled-tasks.ps1:26,60`). S4U tasks fail silently if the account SID/domain changes. Doesn't explain the AIWA timing correlation, but costs one command.

**Test:** `LastTaskResult` in the H1 command — look for `0x2` / `0x41303` / logon-failure codes.

---

## SEPARATE BUG (unrelated to the outage)

`getWeekOf()` in `scripts/supabase-sync.mjs:40-50` computes next Monday from a **local-time** `Date`, then calls `.toISOString()` — which converts to UTC and rolls the date forward a day for any run after ~19:00 CDT.

That's why the Jul 28 22:53-local run is filed as `week_of 2026-08-04` (a **Tuesday**) instead of `2026-08-03`. Friday 08:30 runs never trip it, so it's latent — but `supabase-sync.mjs:285-286` upserts with `onConflict: 'week_of'`, so a misdated row won't dedupe against the correct one and you get duplicate/orphan weeks.

**Relevant to the migration:** if AIWA runs in UTC rather than America/Chicago, this bug changes behavior — and so does the no-show check at `seo-monitor.mjs:479-481`, whose `localHHMM()` carries the comment *"Monitor runs on CartersPC, so getHours() is already local (CST/CDT)."* That assumption breaks on a UTC server. `EXPECTED_RUN_DOW` and `NO_SHOW_DEADLINE` comparisons would both be wrong by 5–6 hours.

---

## SUGGESTED ORDER OF WORK

1. **Confirm where the jobs actually live now** — run the H1 commands on CartersPC, then inventory AIWA. Until this is known, everything else is guesswork. Get the user to state plainly which processes were cut over and which weren't.
2. **Restore publishing.** The business impact is 8 days of no GBP/FB posts. Fastest path is probably approving or re-running content for the current week — but first decide what to do with the stranded Jul 28 run (11 posts pending; note its `week_of` is misdated per the bug above).
3. **Fix the watchdog coupling** (finding #5). Move the no-show check out of the Friday-triggered monitor into an independent daily job, ideally on a *different* host than the run, so a dead trigger can still alert. This is the fix that would have surfaced the problem on Jul 24 instead of the user noticing on Jul 31.
4. **Add a dead-man's switch** — heartbeat to Supabase, alert from off-box, so a fully dead host can't be silent.
5. **Make `.env.example` complete** (finding #6) — it's actively dangerous during a migration.
6. **Then** tackle the portability work in finding #7 if the AIWA move is going forward.

Items 3–6 are unimplemented; I deliberately did not write code, since the user asked for findings only and the migration context changes what the right fix looks like.

---

## Things I could NOT check

- Windows Task Scheduler state / history (both hosts)
- `outputs/weekly-runner-health.json`, `outputs/run_health.json`, `outputs/weekly-runner-*.log`, `outputs/monitor-*.jsonl` — all gitignored, host-only
- `pm2 ls` / PM2 logs on either host
- Whether mav-bridge (:8790) and mav-console (:3000) are actually up
- The AIWA server in any form — its OS, scheduler, what was migrated, whether the repo is even checked out there
- The `.env` on either host
- Whether SMTP or hermes alerting works at all right now

## Reference — Supabase

Project **"SEO Agents"**, ref `tbvsycqfpkkxitdbgfsj`, region us-west-2, ACTIVE_HEALTHY.
Row counts at time of writing: `seo_runs` 4, `weekly_posts` 49, `website_tasks` 90, `run_logs` 299, `metrics` 1, `node_status` 1, `agent_checks` 0, `agent_audits` 0, `agent_remediations` 177, `agent_dry_runs` 0.

`agent_remediations` is frozen — all 177 rows are from **2026-06-30**, none since. Might be a separate dead subsystem, worth a glance but not obviously part of this outage.

`weekly_posts.scheduled_time` is null for every row across all runs — if you're looking for post dates, that column isn't it.
