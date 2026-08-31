# Slack Alerts + Interactive Approvals Runbook

SEO Slack approvals use the existing local Hermes Slack app in **Socket Mode**.
There is no public callback URL, Tailscale proxy, reverse proxy, or Slack signing
secret in the SEO application.

## What it does

When Hermes has Slack configured, `mav-bridge` gains two things while replacing
routine Hermes/Twilio delivery:

1. **Slack-first alerts (Block Kit cards).** Fault alerts (failed/stuck runs, posts,
   website tasks) are posted as cards with one-tap **↻ Retry** / **Dismiss** buttons.
   Pending `seo_runs` and pending **website tasks** get cards with **✅ Approve**
   (one per action, deduped via the alert-store 'pending' keys). A successful direct
   Slack post suppresses the Hermes fallback, so routine alerts do not also incur
   Twilio/SMS cost. Email remains an independent best-effort channel.
2. **Interactive approvals.** Button clicks arrive through Hermes' existing Slack
   Socket Mode gateway. The `seo-slack-approvals` Hermes user plugin checks the
   existing `SLACK_ALLOWED_USERS` allowlist, accepts only `seo_approve`,
   `seo_dismiss`, and `seo_retry` UUID actions, then posts to the corresponding
   loopback-only bridge endpoint used by the dashboard.

`HERMES_ALERT_TO=slack` is the no-cost one-way compatibility default: it routes
through the local `hermes send` CLI to Slack's home channel when direct delivery is
not configured or cannot post.

## Configuration

The credentials remain in the Hermes runtime (`%LOCALAPPDATA%\\hermes\\.env`):
`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_HOME_CHANNEL`, and
`SLACK_ALLOWED_USERS`. `mav-bridge` reads the bot token and target channel only as
a local runtime fallback; its own `.env` contains no Slack credential. Hermes owns
the inbound Socket Mode connection and authorization allowlist.

Fail closed: no bot/channel disables card delivery; an absent allowlist or a user
outside it disables every approval click. `HERMES_ALERT_TO=slack` and email remain
best-effort fallback paths.

## Security model

- **No externally reachable listener:** the bridge binds to `127.0.0.1`; the old
  `/slack/interactions` endpoint is removed.
- **Socket Mode authority:** Slack delivers the click over Hermes' authenticated
  Socket Mode connection; no signing secret or callback request URL is needed.
- **Hermes allowlist:** the plugin requires `body.user.id` in `SLACK_ALLOWED_USERS`.
- **Strict action surface:** only `seo_approve:<uuid>`, `seo_dismiss:<uuid>`, and
  `seo_retry:<uuid>` can reach the bridge.
- **Fixed loopback target:** each action maps to one `127.0.0.1` route; Slack data
  cannot choose a host, port, endpoint, command, or database query.

## Code layout

- `scripts/lib/slack-alert.mjs` — Hermes-env fallback config, Block Kit builder,
  and `chat.postMessage` sender (never throws).
- `scripts/lib/slack-actions.mjs` — the shared `approveAction` / `dismissAction` / `retryAction` (single source of truth, also called by the MCC HTTP routes).
- `scripts/mav-bridge.mjs` — loopback dashboard/action API plus Slack-first cards.
- `integrations/hermes-seo-slack-approvals/` — reviewed source for the Hermes user
  plugin; its dependency-free test validates the strict matcher, allowlist, and
  fixed loopback action mapping.

## Runtime installation

Install the reviewed plugin source at
`%LOCALAPPDATA%\\hermes\\plugins\\seo-slack-approvals\\`, then restart the existing
Hermes gateway once so it loads the plugin. Restart `mav-bridge` once after the
updated source is deployed so it reads the Hermes runtime fallback credentials.

Verification: confirm Hermes reports its gateway healthy, create a pending website
task, receive one Block Kit card, click Approve as an allowed user, and confirm the
task becomes `approved` in the dashboard before the worker executes it.
