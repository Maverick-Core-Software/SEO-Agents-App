# Workstream: flow (status: ?)

# Production Flow Map: Weekly SEO Run End-to-End

## Findings

### 1. Scheduled Tasks / PM2 Processes / Watchdog — Owners & Triggers

| # | Name | Owner (trigger) | Schedule | File | Purpose |
|---|------|-----------------|----------|------|--------|
| 0 | Grizzly SEO Photo Sync | Windows Task Scheduler | Friday 08:25 (weekly) | `SEO-Agents-App/scripts/setup-scheduled-tasks.ps1:81` | Mirrors Google Drive photos → local cache before research |
| 1 | Grizzly SEO Weekly Run | Windows Task Scheduler | Friday 08:30 (weekly) | `SEO-Agents-App/scripts/setup-scheduled-tasks.ps1:88` | Launches `run-weekly-seo.py` → CrewAI research |
| 2 | Grizzly SEO Monitor | Windows Task Scheduler | Friday 08:30 (weekly, 14h window) | `SEO-Agents-App/scripts/setup-scheduled-tasks.ps1:94` | Watches Supabase state, PM2 health, M: drive; alerts on failure |
| 3 | Grizzly SEO Watchdog | Windows Task Scheduler | **Daily** 10:00 | `SEO-Agents-App/scripts/setup-scheduled-tasks.ps1:106-114` | Independent no-show/stale/failure detector (single-shot, exits) |
| 4 | Grizzly SEO GBP Worker | Windows Task Scheduler | Daily 08:00 + logon | `SEO-Agents-App/ops/gbp-worker-launch.vbs` → `scripts/gbp-worker.mjs` | Daily GBP poster (Supabase poll → Playwright post) |
| 5 | mav-console | PM2 (via `MCC/ecosystem.config.cjs`) | Persistent | `MCC/ecosystem.config.cjs:6-36` | MCC dashboard on :3000 — approval UI |
| 6 | mav-bridge | PM2 (via `MCC/ecosystem.config.cjs`) | Persistent | `MCC/ecosystem.config.cjs:70-86` | Supabase poller/executor on :8790 — posts FB/GBP/website |
| 7 | prometheus-sync | PM2 (via `MCC/ecosystem.config.cjs`) | Persistent | `MCC/ecosystem.config.cjs:38-48` | Metrics ingestion |
| 8 | mcc-dashboard-agent | PM2 (via `MCC/ecosystem.config.cjs`) | Persistent | `MCC/ecosystem.config.cjs:89-106` | HomeLab agent on :7331 |

**PM2 boot persistence:** `C:\Workspace\Active\MCC\scripts\setup-pm2-boot.ps1` registers a Windows boot task that runs `pm2 resurrect`. `MCC/ecosystem.config.cjs` documents this in its header comments.

All scheduled tasks use: `S4U` logon, `Run whether user is logged on or not`, `Start when available`, `Wake to run`, restart count 2 / 5 min interval (`setup-scheduled-tasks.ps1:38-42`). The watchdog is the exception: 10-minute execution time limit, no restarts (`:108-111`).

### 2. Ordered Sequence: Friday 08:25 → Verification Complete

```
T+0m  (Fri 08:25)  ── PHOTO SYNC ──────────────────────────────────────────
  Owner: Task Scheduler → sync-photos-from-drive.mjs
  State write: copies H:\My Drive\GBP Photos → C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos
  Side effect: local filesystem only (additive, idempotent)

T+5m  (Fri 08:30)  ── WRAPPER STARTS ──────────────────────────────────────
  Owner: Task Scheduler → run-weekly-seo.py
  State write: outputs/weekly-runner-health.json → { status: "started", date: today }
  State write: outputs/weekly-runner-YYYY-MM-DD.log (append)
  Side effect: none yet

T+5m  (Fri 08:30)  ── MONITOR STARTS (parallel) ───────────────────────────
  Owner: Task Scheduler → seo-monitor.mjs
  State write: outputs/monitor-YYYY-MM-DD.jsonl (append per poll)
  Side effect: sends "SEO Monitor Started" alert via hermes SMS + Gmail SMTP
  Auto-fix capability: pm2 restart, pm2 resurrect (once), M: drive remount
  Polls every 30s for 14 hours, then exits with final summary

T+5m  (Fri 08:30)  ── TOPIC SELECTION ──────────────────────────────────────
  Owner: run-weekly-seo.py → pytrends (Google Trends API, US-TX, 7-day)
  State write: state/topic-history.json (append, dedup last 4 weeks)
  Side effect: Google Trends API call (batches of 5 keywords)
  Fallback: ISO week number rotation if pytrends fails

T+~6m  (Fri ~08:36) ── CREW LAUNCH: seo-agents research <topic> ─────────────
  Owner: run-weekly-seo.py → subprocess → .venv/Scripts/seo-agents.exe (or -m fallback)
  State write: outputs/weekly-crew-YYYY-MM-DD.log (stdout/stderr stream)
  State write: outputs/run_health.json (phase-by-phase health)
  Side effects:
    • LLM calls to DEEPSEEK_API_KEY / ANTHROPIC_API_KEY (via CrewAI)
    • Website scrape of grizzlyelectrical.com
    • File outputs: outputs/seo_research_report.md, outputs/manager_plan.md,
      outputs/grizzly_execution_queue.md, outputs/baselines/
    • Archival: outputs/archive/YYYY-MM-DD_HHMMSS/

  Sub-phases inside the crew (main.py:652-930):
    Phase 1: Research crew (build_seo_crew → kickoff)
      → outputs/seo_research_report.md
      → outputs/manager_plan.md
      → write_run_health("research", "success")

    Phase 1.5: finalize_run (claims, evidence package)
      → outputs/run-manifest.json
      → outputs/evidence-package.json

    Phase 2: Executor crew (build_executor_crew → kickoff)
      → reads grizzly_execution_queue.md
      → writes website edits, task completions
      → outputs/final_report.md
      → write_run_health("execute", "success")

    Phase 3: GBP Poster crew (build_poster_crew → kickoff)
      → outputs/gbp_posting_schedule.md (7-day schedule)
      → write_run_health("post_schedule", "success")

    Phase 4: Facebook Schedule crew (build_facebook_crew → kickoff)
      → outputs/facebook_posting_schedule.md (7-day schedule)
      → write_run_health("facebook_schedule", "success")

    Phase 5: Supabase sync (subprocess: node scripts/supabase-sync.mjs)
      → SUPABASE: UPSERT seo_runs (week_of, status: pending_approval)
      → SUPABASE: INSERT weekly_posts (FB + GBP, status: pending_approval)
      → SUPABASE: INSERT website_tasks (status: pending_approval)
      → HERMES SMS: approval notification to Carter (deduped by run_id+counts)
      → If SEO_AUTO_APPROVE=1: auto-approves run + posts, sends different SMS

T+~25m (Fri ~08:55) ── WRAPPER COMPLETES ──────────────────────────────────
  Owner: run-weekly-seo.py
  State write: outputs/weekly-runner-health.json → { status: "success" or "failed" }
  Side effect: exit code 0 or non-zero to Task Scheduler

  If SEO_AUTO_APPROVE ≠ 1:
    → Run sits at pending_approval in Supabase
    → Monitor detects new run, logs transition
    → Approval SMS sent (from supabase-sync.mjs)

T+varies (user action) ── APPROVAL ────────────────────────────────────────
  Owner: Carter in MCC dashboard (:3000), or auto-approve
  State write: SUPABASE seo_runs.status → "approved", approved_at = now
  State write: SUPABASE weekly_posts.status → "approved" (all for this run_id)
  Side effect: mav-bridge picks up on next 30s poll

  Or: POST /seo/actions/approve to mav-bridge (:8790)
  Or: POST /seo/actions/live-approve (auto-approve with prompt approval)

T+varies (mav-bridge poll) ── EXECUTION PIPELINE ────────────────────────
  Owner: mav-bridge.mjs (PM2) → executeApprovedRun()
  State write: SUPABASE seo_runs.status → "executing"

  Sub-phase 0.5: Photo curation
    → node scripts/gbp-photo-pick.mjs (8 min timeout)
    → copies curated photos to GBP_CURATED_FOLDER with date prefixes

  Sub-phase 1: Facebook posting
    → SUPABASE weekly_posts (FB) status → "posting" (CAS: only unposted rows)
    → node scripts/facebook-poster.mjs --schedule-all --time 09:00
      → Facebook Graph API (FB_PAGE_ACCESS_TOKEN, v22.0)
      → Veo 3 video renders for video-type posts (up to 45 min timeout)
      → Photo uploads for photo-type posts
      → Scheduled posts or immediate publish
      → First comments (phone numbers) via postFirstComment()
    → SUPABASE weekly_posts (FB) status → "posted", platform_post_id set
    → SUPABASE run_logs INSERT (per-post execution logs)
    → On failure: status → "error", error text stored

  Sub-phase 2: GBP posting (only if MAV_BRIDGE_GBP=on, default OFF)
    → Usually owned by gbp-worker (separate scheduled task)
    → If bridge runs it: CAS on status="approved" to avoid double-post

  Sub-phase 3: Website tasks (if MAV_WEBSITE_AUTO_EXEC=1, default ON)
    → fetchApprovedWebsiteTasks() → executeNextWebsiteTask()
    → Calls seo-agents.exe for website edits
    → SUPABASE website_tasks.status transitions: approved → executing → done/error
    → Orphan sweep: picks up tasks approved after run settles

  State write: SUPABASE seo_runs.status → "done" (or "error")
  State write: SUPABASE seo_runs.done_at = now
  Side effect: Monitor logs final transition, sends completion summary alert

T+daily 09:00+ ── GBP DAILY POSTING (days 2-7) ────────────────────────────
  Owner: gbp-worker.mjs (Windows Scheduled Task, runs as carte)
  State write: SUPABASE weekly_posts (GBP) status → "posting" → "posted"/"error"
  Side effects:
    → gbp-photo-pick.mjs (curates photo for today)
    → Playwright browser (chromium) → Google Business Profile
    → Post creation + photo upload
    → Verification: re-reads GBP to confirm post appeared
    → If unverified: status → "needs_verification" (alert sent)
    → M: drive archive copy (\backups\gbp-archive)

T+daily (mav-bridge poll) ── FACEBOOK RECONCILE + BOOST ────────────────────
  Owner: mav-bridge.mjs daily tick
  Side effects:
    → Reconciles FB scheduled posts → marks posted
    → FB Marketing API boost check (if FB_BOOST_API=1, ledger-gated)
    → First-comment drain for posts published since last check

T+daily 10:00 ── WATCHDOG (independent) ───────────────────────────────────
  Owner: Task Scheduler → seo-watchdog.mjs (single-shot)
  Checks: (1) run-day no-show past 09:00, (2) run-day failure, (3) staleness >8 days
  State write: outputs/watchdog.jsonl
  Side effect: hermes SMS + Gmail SMTP if problem detected
  Exit code 1 if all alert channels fail (Task Scheduler LastTaskResult becomes signal)

T+14h (Fri ~22:30) ── MONITOR SHUTDOWN ────────────────────────────────────
  Owner: seo-monitor.mjs self-terminates after RUN_DURATION_HOURS
  State write: final summary log entry
  Side effect: sends "SEO Monitor Done" alert with run status + post counts
```

### 3. Failure Points & Recovery Paths

| Failure | Detection | Recovery | Source |
|---------|-----------|----------|--------|
| Task Scheduler never fires run | Watchdog (daily 10:00) reads weekly-runner-health.json; no entry for today → alert | Re-run `setup-scheduled-tasks.ps1` | `HANDOFF-2026-07-31-missed-run.md` finding #5; watchdog now fixes the old design flaw |
| PM2 processes missing after reboot | Monitor: `checkPM2Processes` → missing core → `pm2 resurrect` (once) | `pm2 resurrect` or `setup-pm2-boot.ps1` for permanent fix | `seo-monitor.mjs:195-230`; `FRIDAY-RUNBOOK.md:12-15` |
| M: drive unmounted | Monitor: `checkMDrive` → `net use M: \\192.168.1.12\Proxmox` | Auto-remount; if fails → alert | `seo-monitor.mjs:188-194` |
| Python/venv broken | Wrapper: `resolve_seo_agents_cmd()` tries 4 paths, falls back to `-m` | `pip install -e .` in venv | `run-weekly-seo.py:64-79` |
| LLM API failure (402, timeout) | Crew exits non-zero → wrapper writes health="failed" with tail | Monitor alerts on run error; retry via MCC dashboard | `run-weekly-seo.py:126-140`; `seo-monitor.mjs:350-360` |
| Supabase sync fails | supabase-sync.mjs exits 1 → wrapper propagates exit code | Re-run `node scripts/supabase-sync.mjs --week-of YYYY-MM-DD` | `supabase-sync.mjs:277` |
| Facebook token stale | mav-bridge validates token before pipeline (`checkFacebookToken`) | Re-auth; bridge alerts on failure | `mav-bridge.mjs:256-268` |
| Run stuck in "executing" >30min | Monitor: `checkRunStatus` → alert | `pm2 restart mav-bridge` | `seo-monitor.mjs:365-376` |
| Post stuck in "posting" >30min | mav-bridge fault detection: TTL sweep resets to "error" | Retry via MCC `/seo/actions/retry` | `mav-bridge.mjs:699-710` |
| GBP post needs_verification | Monitor alerts; manual verify in GBP dashboard | Mark as "posted" in MCC | `seo-monitor.mjs:400-410` |
| Run stranded in "executing" (crash) | `executeApprovedRunSafe` wrapper catches unhandled error → marks "error" | Retry via MCC | `mav-bridge.mjs:450-458` |
| All alert channels down | Watchdog exits code 1 → Task Scheduler LastTaskResult = 1 (visible signal) | Check `outputs/watchdog.jsonl` | `seo-watchdog.mjs:46-47` |
| `.env` incomplete on new host | Monitor exits immediately (missing SUPABASE_URL) — **silent** | `.env.example` is incomplete per HANDOFF finding #6 | `HANDOFF-2026-07-31-missed-run.md` finding #6 |
| `getWeekOf()` timezone bug | `supabase-sync.mjs:40-50`: `.toISOString()` on local Date rolls date forward after ~19:00 CDT → wrong `week_of` → orphan row | Use explicit date arithmetic without `.toISOString()` | `HANDOFF-2026-07-31-missed-run.md` "SEPARATE BUG" section |
| GBP worker console closed | 2026-07-10 incident: user closed console window → exit 0xC000013A | VBS hidden launcher (`gbp-worker-launch.vbs`) prevents this | `ops/gbp-worker-launch.vbs:3-5` |
| Schedule starves (no new run) | Daily GBP poster polls Supabase, finds nothing → silent idle | `run_logs` shows no activity; indistinguishable from healthy idle | `HANDOFF-2026-07-31-missed-run.md:40-45` |

## Analysis

### Architecture Summary

The system has two independent persistence layers that fail independently:

1. **Windows Task Scheduler** — owns the Friday 08:30 kickoff, monitor, watchdog, photo sync, and GBP daily worker. All use S4U logon (no stored password) with reboot-proof settings.

2. **PM2** — owns the always-on services: mav-bridge (executor), mav-console (approval UI), prometheus-sync, mcc-dashboard-agent. Survives reboots only if `setup-pm2-boot.ps1` has been run (registers a boot task for `pm2 resurrect`).

The critical handoff point is **Supabase**: the research crew writes markdown files locally, then `supabase-sync.mjs` parses them and upserts into Supabase (`seo_runs` → `weekly_posts` → `website_tasks`). This is the approval gate. After approval, `mav-bridge` (PM2) polls Supabase every 30s and executes the approved content.

### Key Design Decisions

- **Watchdog independence**: The watchdog (`seo-watchdog.mjs`, daily 10:00) was created specifically because the original monitor shared the Friday trigger with the run it watched — if Task Scheduler misfired, both died silently (the Jul 24 failure mode). The watchdog has its own daily trigger and reads only the local health marker file.
- **Platform split**: GBP posting is owned by `gbp-worker.mjs` (user-session Scheduled Task) for Playwright browser access, while Facebook + website + orchestration live in `mav-bridge` (PM2, LocalSystem). The bridge has a `MAV_BRIDGE_GBP=off` default to prevent double-posting.
- **Photo sync pre-run**: The 08:25 photo sync task exists because Google Drive only mounts while its desktop app is running. Without this, photos added between sync and approval would be missed.
- **Auto-approve option**: `SEO_AUTO_APPROVE=1` bypasses the MCC approval gate for posts (website tasks still need manual approval). This was added for hands-off operation.

### Residual Risks

1. **Windows-only coupling**: 18+ files hardcode `C:\Workspace`, `M:\`, `H:\`, or Windows-specific APIs (`net use`, `pm2 jlist`, `hermes.exe`). Any migration to AIWA (Linux) will break every operational path. The repo has zero AIWA awareness (`HANDOFF-2026-07-31-missed-run.md` finding #7).
2. **Silent schedule starvation**: When the weekly run doesn't fire, the daily GBP poster goes silent without logging anything — an empty queue looks identical to a dead process in `run_logs`. Only the watchdog catches this.
3. **`.env.example` incomplete**: Missing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SEO_NO_SHOW_DEADLINE`, `SEO_RUN_DOW`, and other vars the monitor requires. Provisioning a new host from this template produces a monitor that exits instantly with no alert (`HANDOFF` finding #6).
4. **`getWeekOf()` timezone bug**: Latent for Friday 08:30 runs but triggers for off-schedule runs after ~19:00 local, producing orphaned `week_of` values that don't dedupe correctly.
5. **No cross-host monitoring**: All monitoring runs on the same machine as the run. If the host is down, no alert fires. No dead-man's-switch heartbeat to Supabase from an external monitor.