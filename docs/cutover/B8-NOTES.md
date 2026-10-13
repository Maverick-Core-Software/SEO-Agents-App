# B8 notes: mav-bridge bind address

Branch `cutover/b8-bridge-bind`. Carried here because `docs/cutover/RUNBOOK-AIWA.md`
lives on `cutover/b4-b5-deploy-rekey`, not on this branch.

## Network

- `MAV_BRIDGE_BIND` sets the listen address for mav-bridge (default `127.0.0.1`).
  On the LXC, set it to the LXC address in `/opt/seo/.env` so CT 103 can reach the bridge.
- Restrict `:8790` at the LXC/host firewall to CT 103's address only.
- MCC env change (one line, Carter-approved): set `SEO_APP_URL` to `http://<seo-prod-ip>:8790`.
- Startup log line: `mav-bridge listening on <host>:<port>`.
- Routes and auth are unchanged by this change.
