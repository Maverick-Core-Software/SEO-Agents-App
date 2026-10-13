# deploy/aiwa: AIWA SEO host artifacts (cutover B4)

Target: Debian 12 LXC `seo-prod`, app root `/opt/seo`, photo library `/srv/seo/photos`. The full procedure is
`docs/cutover/RUNBOOK-AIWA.md`. Every live step there needs Carter's approval.

## Contents

| File | What |
|---|---|
| `ecosystem.linux.config.cjs` | pm2 apps: mav-bridge, gbp-worker (via `gbp-worker-service.mjs`), fb-comment-agent. Logs to `/opt/seo/logs/<app>.log`. No secrets. |
| `systemd/*.service`, `systemd/*.timer` | seo-photo-sync (Fri 08:25, rclone then cache sync), seo-weekly-run (Fri 08:30), seo-monitor (Fri 08:30, 14 h), seo-watchdog (daily 10:00), seo-reconcile (daily 10:10). Every service sets TZ, `EnvironmentFile=/opt/seo/.env`, `User=seo`. |
| `install.sh` | Idempotent Debian 12 provisioning. Enables nothing, except with the opt-in `--pm2-startup` flag (installs and enables `pm2-seo.service` for boot persistence; the Carter-approved F3 step). |
| `render-env.sh` | Validates a PC-built `.env` against `env.required`. Names only, never values. |
| `env.required` | Names the `.env` must define, tagged by service. |
| `verify-units.sh` | `bash -n`, shellcheck if present, `systemd-analyze verify` if present, else a grep lint. Also checks that the ecosystem loads. |

Also changed: the Windows `ecosystem.config.cjs` at the repo root has a one-line pointer to this directory.
Nothing else in it changed.

## Decisions reflected here

- **D2** `.env` is built on the PC and shipped. `render-env.sh` validates it. Nothing here reads Secret Manager.
- **D3** Photo intake is `rclone sync` from the Drive folder "GBP Photos" into `/srv/seo/photos-inbox` (outside the cache, F8). It is gated by `SEO_RCLONE_REMOTE`. Unset means the rclone step is skipped.
- Friday timers have `Persistent=false`, so a missed Friday does not run on Monday. Daily timers have `Persistent=true`, so a missed daily run fires once on the next boot.

## Follow-ups (not implemented in B4)

1. **mav-bridge bind host.** `scripts/mav-bridge.mjs:1473` hard-codes `listen(BRIDGE_PORT, '127.0.0.1')`, with no bind env. MCC on CT 103 cannot reach `:8790` from another host until the bind is configurable. The fix is one line plus an env name (for example `MAV_BRIDGE_BIND`). Owner: next item, not B4.
2. **fb-comment-agent binds all interfaces.** `scripts/facebook-comment-agent.mjs:380` calls `listen(port)` with no host. B6 moves it to `127.0.0.1` by default.
3. **seo-monitor pm2 and `net use`.** `scripts/seo-monitor.mjs:152-198` runs `pm2 jlist/restart/resurrect` and a Windows `net use M:` remount. On Linux these need B3 (`SEO_MONITOR_PM2=0` and the `GBP_ARCHIVE_FOLDER` existence check) before `seo-monitor.timer` is enabled in phase F3.
4. **`SEO_PIPELINE=new` is not in this branch.** The `seo-weekly-run` unit calls `run-weekly-seo.py`, which only knows the legacy and shadow pipelines until cutover V1 lands. Keep `seo-weekly-run.timer` disabled until V1 is in rc1.
5. **rclone `sync` mirrors deletions into the inbox.** Files removed from Drive are removed from `/srv/seo/photos-inbox`. The library at `/srv/seo/photos` is the copy that matters. For an additive inbox, change the `ExecStartPre` in `systemd/seo-photo-sync.service` to `rclone copy`.
6. **systemd EnvironmentFile wins over `Environment=`.** The unit-level `GBP_PHOTOS_FOLDER` and `GBP_PHOTOS_LOCAL_CACHE` are defaults only. The values in `.env` take effect, so `env.required` lists them.
7. **Legacy crew (D5) is not covered.** `SEO_PIPELINE=legacy` needs the CrewAI key set and the B7 path changes. None of that is in `env.required`.
8. **Watchdog during the shadow week.** `seo-watchdog` runs daily on AIWA against copied `outputs/`, which can lag the PC. Check its alerts against the PC's live state during E.
9. **Windows-only strings** (`CMB-Workbench` in alert text, `CARTERSPC` in old docs) are cosmetic. Left to B2/B3.
10. **Legacy `PORT` in the PC ecosystem file.** `ecosystem.config.cjs` sets `PORT: '8795'` for fb-comment-agent, which the script never reads. The Linux file uses `FB_COMMENT_AGENT_PORT`.
11. **`install.sh` pulls two installers over the network.** NodeSource's apt key and the pinned `astral.sh/uv/<SEO_UV_VERSION>/install.sh` (0.12.7). Review before the first run on AIWA.
