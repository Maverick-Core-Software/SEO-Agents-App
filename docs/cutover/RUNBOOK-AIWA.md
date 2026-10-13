# RUNBOOK: SEO on AIWA (LXC `seo-prod`)

Status: draft for cutover item B4, written 2026-10-13. Governing runbook: `brain/agent-memory/runbooks/aiwa-deployment.md`
(plus `proxmox-mcp-split.md`). Plan: `docs/cutover/CUTOVERPLAN.md` (sections 8 and 9). Artifacts: `deploy/aiwa/`.

**Rule for this document:** every step that changes a live host, reads or writes a secret, copies data, enables a
timer, starts a process or touches a publisher is marked **[Carter approval]**. Nothing here runs without his
yes in chat for that step. Read-only checks are unmarked. Run every AIWA action from an Orca terminal (not SSH
or SCP from an agent), per `aiwa-deployment.md`.

## 0. Preconditions

| Check | How | Pass |
|---|---|---|
| LXC `seo-prod` exists (D1: Debian 12, unprivileged, 4 vCPU, 8 GB, 60 GB, static IP) | `proxmox` MCP `get_container_config` (read-only) | config shows it |
| Orca environment `seo-prod` paired | `orca environment list` | listed |
| Release tag exists on `main` after rc1 merge | `git tag -l seo-aiwa-rc1` on the PC | tag present |
| Phase R gates green (`node --test` 0 fail, lint clean) | PC gate output in evidence folder | recorded |
| GBP API token minted and probe passed (D8, section 6a of the plan) | `docs/cutover/evidence/gbp-probe-*.json` | pass |

## 1. Install the host (E2) [Carter approval]

1. Copy the repo tree (or a tag archive) to `/opt/seo`. Install.sh expects it there.
2. As root: `bash /opt/seo/deploy/aiwa/install.sh`
   - Installs apt packages (ffmpeg, fonts-dejavu-core, rclone, git), NodeSource Node 22, uv, pm2.
   - Creates user `seo`, `/opt/seo` (+ logs, state, outputs), `/opt/seo/secrets` (700), `/srv/seo/{photos,photos-inbox,gbp,gbp-archive}` (the rclone inbox is outside the photo cache), then `chown -R seo:seo /opt/seo /srv/seo` (the tree was copied as root).
   - Sets the host timezone to America/Chicago. Copies the units to `/etc/systemd/system` and runs `daemon-reload`.
   - Runs `npm ci` (with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, no browsers needed in API mode) and `uv sync --locked` as `seo`.
   - **Enables nothing.** The installer reaches the NodeSource apt key and the pinned `astral.sh/uv/<version>/install.sh` (uv 0.12.7, the PC lock version; `SEO_UV_VERSION` overrides) over the network. Review them first.
3. Re-run `install.sh` once. Every step must report "already" or succeed. Idempotence check.

## 2. Deploy ref and tests on AIWA (E2) [Carter approval: release]

1. `runuser -u seo -- git -C /opt/seo checkout seo-aiwa-rc1` (or the rc tag).
2. `runuser -u seo -- env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix /opt/seo`
3. `runuser -u seo -- sh -c 'cd /opt/seo && node --test "scripts/**/*.test.mjs"'`: the **0 fail** count must equal the PC's number.
4. `runuser -u seo -- sh -c 'cd /opt/seo && npm run lint'`: clean.
5. `bash /opt/seo/deploy/aiwa/verify-units.sh`: PASS. On the host, `systemd-analyze verify` runs in place of the grep lint.

## 3. Secrets: `.env` and OAuth files (E3, D2) [Carter approval: credentials]

Decision D2: the `.env` is built on the PC from Carter's keys and shipped through the Orca release path. Nothing on
the LXC fetches secrets, and no agent prints values.

1. Build the `.env` on the PC. It must set `SEO_PIPELINE=shadow`, `SEO_AUTO_APPROVE=0`, `GBP_POSTER=api`,
   `MAV_BRIDGE_GBP=off`, `FB_BOOST_API=0`, `TZ=America/Chicago`, plus every name in `deploy/aiwa/env.required`.
2. Ship it to `/opt/seo/.env` owned by `seo`, mode 600.
3. Copy `client_secret_hermes_gbp.json`, `grizzly-search-console.json` and `grizzly-gbp.json` to `/opt/seo/secrets/`
   (mode 600, owner `seo`). `gbp-api-auth.mjs` rewrites the token file on refresh, so `seo` must own it.
4. Validate. Output lists names only:
   `bash /opt/seo/deploy/aiwa/render-env.sh /opt/seo/.env`. Expect `render-env: OK`.

## 3a. Network: mav-bridge bind (B8) [Carter approval: firewall + MCC env]

- `MAV_BRIDGE_BIND` sets the listen address for mav-bridge (default `127.0.0.1`, loopback only).
  On the LXC set it to the LXC address in `/opt/seo/.env` so CT 103 (MCC) can reach the bridge; the port stays
  `MAV_BRIDGE_PORT` (default 8790). Resolution lives in `scripts/lib/bridge-bind.mjs`.
- **Hard gate (E3): restrict `:8790` at the LXC/host firewall to CT 103's address only, before `.env` carries a
  non-loopback `MAV_BRIDGE_BIND` and before `pm2 start`.** The bridge's approve / retry / clear-lock / run /
  new-schedule routes have no auth of their own (rc1 review F13; a shared-secret header is backlog C1). Evidence
  for the gate: the firewall rule listing plus, from any host other than CT 103, `curl -m 3 http://<seo-prod-ip>:8790/health`
  timing out. No AIWA start step proceeds without it.
- The bridge refuses an unspecified address: `MAV_BRIDGE_BIND=0.0.0.0` (or `::`) exits at startup with the reason
  unless `MAV_BRIDGE_ALLOW_ANY=1` is set deliberately. Always bind the one LXC address.
- MCC env change (one line, Carter-approved): set `SEO_APP_URL` to `http://<seo-prod-ip>:8790`.
- Startup log lines to look for: `mav-bridge listening on <host>:<port>`, followed by
  `WARNING: mav-bridge is binding a non-loopback address (...)` for any bind other than loopback (expected on AIWA,
  a bug on the PC).
- Routes are unchanged. On the PC nothing changes: `MAV_BRIDGE_BIND` unset keeps loopback.

## 4. Data copy (E4) [Carter approval: data movement]

Transport: an Orca-approved path only (rsync over the LAN from a Carter-run command, or a Syncthing share). No SCP from an agent.

| Source (PC) | Destination (LXC) | Notes |
|---|---|---|
| `C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos` (15.1 GB, 6,281 files) | `/srv/seo/photos` | the rclone target is `/srv/seo/photos-inbox`, outside the cache; do not create `photos/inbox` |
| `state/` minus `weekly/serp-cache` | `/opt/seo/state` | |
| `outputs/`: `fb-boost-ledger.json`, `fb-boost-api-last.json`, `*_posting_schedule.md`, `weekly-runner-health.json`, `run_manifest.json`, `shadow/`, `archive/` | `/opt/seo/outputs` | drop `gbp-debug/`, `fb-videos/`, `monitor-*.jsonl` |
| `Grizzly GBP Schedule.xlsx` (+ backups) | `/srv/seo/gbp/` | set `GBP_WORKBOOK_PATH` to match |

Then rewrite the state paths from the Windows root to the posix root:

1. Dry-run (default): `runuser -u seo -- node /opt/seo/scripts/ops/rekey-state.mjs --from 'C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos' --to /srv/seo/photos`
2. Apply, after the dry-run counts look right: add `--apply`. Backups go to `state/*.bak-<ts>`.
3. A second `--apply` must report `total changes=0`.

Evidence: file counts on both sides and a sample sha256 match. Record them in `docs/cutover/evidence/`.

## 5. Timezone check (E3, E5) [Carter approval: probe]

1. `timedatectl show -p Timezone --value` must print `America/Chicago`. (read-only)
2. Probe the service environment, not the shell:
   `systemd-run --pipe --wait --uid=seo -p EnvironmentFile=/opt/seo/.env -p WorkingDirectory=/opt/seo -- /usr/bin/node -e 'console.log(new Date().toString())'`
   Must print `CDT` (summer) or `CST`. Required before any timer is enabled.

## 6. Enable timers (E5) [Carter approval: each step]

E5 enables **only** these three on AIWA during the shadow week:

```
systemctl enable --now seo-photo-sync.timer seo-watchdog.timer seo-reconcile.timer
systemctl list-timers 'seo-*'
```

**Do not enable** `seo-weekly-run.timer` or `seo-monitor.timer` until phase F3 (the PC is still publishing). Note that
the watchdog runs daily at 10:00 on AIWA. During E, check its alerts against the PC's live state, since the copied
`outputs/` lag the PC.

## 7. E6 full E2E test run (D6) [Carter approves the run]

For the coming week's Monday (`<next Monday>`), with publishers in dry-run:

1. `SEO_PIPELINE=new SEO_AUTO_APPROVE=0 python /opt/seo/scripts/run-weekly-seo.py --week-of <next Monday>`
   (requires cutover item V1; the `new` mode does not exist on this branch yet.)
2. `node scripts/gbp-api-poster.mjs --dry-run` for the 7 dates; `facebook-poster.mjs --dry-run` for the 4 FB slots, including one slideshow build (ffmpeg).
3. `node scripts/weekly/reconcile.mjs` once; `node scripts/seo-watchdog.mjs` once.
4. Carter reviews the 7 images (the 2026-09-25 photo rule) and the post text.
5. Evidence folder: `docs/cutover/evidence/e2e-<date>/`. E gate checks are in the plan, section 8.

## 8. Phase F: flip Friday [Carter approves each step]

F1 (Thu): PC `pm2 save`, stop the PC publishers, disable (do not delete) the 5 PC tasks.
F2 (Thu): copy the ledger and state deltas; compare ledger totals; rekey.
F3 (Thu): AIWA `.env` to `SEO_PIPELINE=new`, `SEO_AUTO_APPROVE=1`, `GBP_POSTER=api`, `FB_BOOST_API=1`, then
(each line is its own Carter-approved step):
```
bash /opt/seo/deploy/aiwa/install.sh --pm2-startup        # as root: pm2 startup systemd -u seo --hp /opt/seo → pm2-seo.service enabled (boot persistence, F7)
runuser -u seo -- pm2 start /opt/seo/deploy/aiwa/ecosystem.linux.config.cjs
runuser -u seo -- pm2 save                                 # the dump pm2-seo.service resurrects at boot
systemctl enable --now seo-weekly-run.timer seo-monitor.timer
```
Without `--pm2-startup` an LXC reboot leaves mav-bridge / gbp-worker / fb-comment-agent down and Days 2-7 never
post (the GBP OVERDUE check would page, but nothing would recover). Verify: `systemctl is-enabled pm2-seo.service`
prints `enabled`; a `systemctl restart pm2-seo.service` brings the three apps back `online`.
MCC on CT 103: `SEO_APP_URL=http://<seo-prod>:8790` (bind per section 3a, firewall gate E3 first).

## 9. Health checks (after any start)

- `runuser -u seo -- pm2 list`: mav-bridge, gbp-worker, fb-comment-agent all `online`, no restart loop.
- `systemctl is-enabled pm2-seo.service` prints `enabled` (boot persistence, F7) and `/opt/seo/.pm2/dump.pm2` exists (`pm2 save` was run).
- `systemctl list-timers 'seo-*'`: only the enabled set is scheduled, with the expected next runs.
- `outputs/reconcile-health.json` present and fresh after the 10:10 run (V3).
- `outputs/weekly-runner-health.json` written by the weekly run (`attempt.status`).
- `journalctl -u seo-watchdog.service --since today`: exit 0 at 10:00.
- Slack alert visible in the configured channel (`notify.sent: true`).

## 10. Rollback (any gate fails) [Carter approval]

AIWA side:
1. `runuser -u seo -- pm2 stop mav-bridge gbp-worker fb-comment-agent` (then `pm2 delete` only if asked; stop keeps the config)
2. `systemctl disable --now seo-weekly-run.timer seo-monitor.timer seo-photo-sync.timer seo-watchdog.timer seo-reconcile.timer`
3. Set AIWA `.env` `SEO_PIPELINE=shadow` or `legacy`, so nothing publishes.

PC side (reversal, plan done-criterion 1):
1. Re-enable the 5 scheduled tasks.
2. `pm2 resurrect` (from the `pm2 save` taken in F1).
3. Carter runs `node scripts/gbp-poster/driver.mjs --auth` (the GBP browser session is logged out).
4. Set PC `SEO_PIPELINE=legacy`.

F6 (Sat) is a reversal rehearsal on a non-posting window: re-enable one PC task, dry-run `pm2 resurrect`
(`pm2 list` only), confirm the PC path is reachable, then re-disable. Record the result here.
