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
| `pm2 ls` empty after reboot | PM2 didn't resurrect | `pm2 resurrect` (or `setup-pm2-boot.ps1` for next time) |

## What the monitor now catches

`seo-monitor.mjs` (brand new, still growing toward self-healing) now also:
- **No-show alarm** — emails you if no run started by `SEO_NO_SHOW_DEADLINE`
  (default 09:00 local) on the run day. Previously a run that never started was
  completely silent; it only alerted on runs that started and *then* failed.
- **Cold-boot recovery** — if core PM2 processes are missing entirely (not just
  stopped), it runs `pm2 resurrect` once before falling back to `pm2 restart`.

Tunables (in `.env`): `SEO_NO_SHOW_DEADLINE` (HH:mm), `SEO_RUN_DOW` (0=Sun…5=Fri).

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
