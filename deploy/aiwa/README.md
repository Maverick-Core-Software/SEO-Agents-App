# deploy/aiwa: AIWA SEO host artifacts (cutover B4)

Target: Debian 12 LXC `seo-prod`, app root `/opt/seo`, photo library `/srv/seo/photos`. The full procedure is
`docs/cutover/RUNBOOK-AIWA.md`. Every live step there needs Carter's approval.

## Contents

| File | What |
|---|---|
| `ecosystem.linux.config.cjs` | pm2 apps: mav-bridge, gbp-worker (via `gbp-worker-service.mjs`), fb-comment-agent. Logs to `/opt/seo/logs/<app>.log`. No secrets. |
| `systemd/*.service`, `systemd/*.timer` | seo-photo-sync (Fri 08:25, rclone then cache sync), seo-weekly-run (Fri 08:30), seo-monitor (Fri 08:30, 14 h), seo-watchdog (daily 10:00), seo-reconcile (daily 10:10). Every service sets TZ, `EnvironmentFile=/opt/seo/.env`, `User=seo`. |
| `install.sh` | Idempotent Debian 12 provisioning. Enables nothing, except with the opt-in `--pm2-startup` flag (installs and enables `pm2-seo.service` for boot persistence; the Carter-approved F3 step). |
| `render-env.sh` | Validates a PC-built `.env` against `env.required`, enforces the pinned values (`GBP_POSTER`, `SEO_PIPELINE`, `MAV_BRIDGE_GBP`, `SEO_AUTO_APPROVE`, `FB_BOOST_API`, `MAV_BRIDGE_BIND`) and, with `--check-paths`, that every path name resolves (`seo-weekly-run.service` runs it as `ExecStartPre`). Names only, never values. |
| `env.required` | Names the `.env` must define, tagged by service. |
| `verify-units.sh` | `bash -n`, shellcheck if present, `systemd-analyze verify` if present, else a grep lint (incl. the ` America/Chicago` suffix on every `OnCalendar`). Also checks that the ecosystem loads. |

Also changed: the Windows `ecosystem.config.cjs` at the repo root has a one-line pointer to this directory.
Nothing else in it changed.

## Decisions reflected here

- **D2** `.env` is built on the PC and shipped. `render-env.sh` validates it. Nothing here reads Secret Manager.
- **D3** Photo intake is `rclone sync` from the Drive folder "GBP Photos" into `/srv/seo/photos-inbox` (outside the cache, F8). It is gated by `SEO_RCLONE_REMOTE`. Unset means the rclone step is skipped.
- Friday timers have `Persistent=false`, so a missed Friday does not run on Monday. Daily timers have `Persistent=true`, so a missed daily run fires once on the next boot.

## Follow-ups (not implemented in B4)

1. **mav-bridge bind host.** Done in rc1 (B8 + F13): `MAV_BRIDGE_BIND` (`scripts/lib/bridge-bind.mjs`), loopback default, `0.0.0.0` refused unless `MAV_BRIDGE_ALLOW_ANY=1`, loud warning for any non-loopback bind. The CT-103-only firewall rule is a hard E3 gate (RUNBOOK 3a).
2. **fb-comment-agent bind.** Done in rc1 (B6): `FB_COMMENT_AGENT_BIND` defaults to `127.0.0.1`.
3. **seo-monitor pm2 and `net use`.** `scripts/seo-monitor.mjs:152-198` runs `pm2 jlist/restart/resurrect` and a Windows `net use M:` remount. On Linux these need B3 (`SEO_MONITOR_PM2=0` and the `GBP_ARCHIVE_FOLDER` existence check) before `seo-monitor.timer` is enabled in phase F3.
4. **`SEO_PIPELINE=new`.** Landed in rc1 (C/V1): `run-weekly-seo.py` runs `scripts/weekly/run.mjs --mode new`; an unknown mode fails closed (exit 2, F5). `seo-weekly-run.timer` stays disabled until phase F3 regardless.
5. **rclone `sync` mirrors deletions into the inbox.** Files removed from Drive are removed from `/srv/seo/photos-inbox`. The library at `/srv/seo/photos` is the copy that matters. For an additive inbox, change the `ExecStartPre` in `systemd/seo-photo-sync.service` to `rclone copy`.
6. **systemd EnvironmentFile wins over `Environment=`.** The unit-level `GBP_PHOTOS_FOLDER` and `GBP_PHOTOS_LOCAL_CACHE` are defaults only. The values in `.env` take effect, so `env.required` lists them.
7. **Legacy crew (D5) is not covered.** `SEO_PIPELINE=legacy` needs the CrewAI key set and the B7 path changes. None of that is in `env.required`.
8. **Watchdog during the shadow week.** `seo-watchdog` runs daily on AIWA against copied `outputs/`, which can lag the PC. Check its alerts against the PC's live state during E.
9. **Windows-only strings** (`CMB-Workbench` in alert text, `CARTERSPC` in old docs) are cosmetic. Left to B2/B3.
10. **Legacy `PORT` in the PC ecosystem file.** `ecosystem.config.cjs` sets `PORT: '8795'` for fb-comment-agent, which the script never reads. The Linux file uses `FB_COMMENT_AGENT_PORT`.
11. **`install.sh` pulls two installers over the network.** NodeSource's apt key and the pinned `astral.sh/uv/<SEO_UV_VERSION>/install.sh` (0.12.7). Review before the first run on AIWA.
