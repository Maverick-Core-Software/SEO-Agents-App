# Slack Alerts + Interactive Approvals Runbook

Source/test-only implementation. Nothing here is live: no Slack message is sent and
no public route is exposed until the wiring steps at the bottom are performed.

## What it does

When the direct-Slack env vars are configured, `mav-bridge` gains two things while
replacing routine Hermes/Twilio delivery:

1. **Slack-first alerts (Block Kit cards).** Fault alerts (failed/stuck runs, posts,
   website tasks) are posted as cards with one-tap **↻ Retry** / **Dismiss** buttons.
   Pending `seo_runs` and pending **website tasks** get cards with **✅ Approve**
   (one per action, deduped via the alert-store 'pending' keys). A successful direct
   Slack post suppresses the Hermes fallback, so routine alerts do not also incur
   Twilio/SMS cost. Email remains an independent best-effort channel.
2. **Interactive approvals.** Button clicks hit `POST /slack/interactions`, which
   verifies the request and dispatches to the **same** approve/dismiss/retry
   implementation the MCC dashboard uses (`scripts/lib/slack-actions.mjs`). The card
   is replaced by the outcome text (e.g. "Run re-queued; 2 post(s) reset.").

`HERMES_ALERT_TO=slack` is the no-cost one-way compatibility default: it routes
through the local `hermes send` CLI to Slack's home channel when direct delivery is
not configured or cannot post.

## Configuration (.env)

| Variable | Required for direct Slack | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot token (scope `chat:write`, plus `chat:write.public` for public channels) |
| `SLACK_ALERT_CHANNEL` | yes | Channel/DM the bot posts to, e.g. `#seo-ops` |
| `SLACK_SIGNING_SECRET` | yes | App Signing Secret — used only to verify inbound button clicks |

Fail closed: with any of these unset the direct path is a no-op and the bridge uses
the `HERMES_ALERT_TO` fallback (Slack by default) plus the independent email path.

## Security model

- **HMAC-SHA256 v0 over the raw body** (`X-Slack-Signature`), computed against the
  exact bytes received (see `scripts/lib/slack-verify.mjs`).
- **Strict replay window:** `X-Slack-Request-Timestamp` must be within ±5 minutes;
  anything older/future is rejected as a replay.
- **Constant-time comparison** via `crypto.timingSafeEqual`.
- **Allowlisted actions:** only `seo_approve:<id>`, `seo_dismiss:<id>`,
  `seo_retry:<id>` are accepted; the id must be UUID-shaped.
- **The legacy `token` field in the payload is never trusted** — authentication is
  the signature only.
- Fail closed: bad/missing signature, stale timestamp, unknown action, or no signing
  secret configured ⇒ 4xx, and no database mutation happens.

## Code layout

- `scripts/lib/slack-verify.mjs` — signature verification (pure, unit-tested).
- `scripts/lib/slack-alert.mjs` — `getSlackConfig`, Block Kit card builder, `chat.postMessage` sender (never throws).
- `scripts/lib/slack-actions.mjs` — the shared `approveAction` / `dismissAction` / `retryAction` (single source of truth, also called by the MCC HTTP routes).
- `scripts/lib/slack-interactions.mjs` — signed handler: verify → parse → allowlist → dispatch.
- `scripts/mav-bridge.mjs` — `POST /slack/interactions` route + Slack-first alert cards in the poll loop.
- Tests: `scripts/lib/slack-{verify,alert,actions,interactions}.test.mjs` (`node scripts/lib/slack-*.test.mjs`).

## LATER LIVE CONFIGURATION (explicitly out of scope for this change)

The endpoint binds to `127.0.0.1:8790` only. Slack must reach it over public HTTPS,
which is a separate, deliberate step that has NOT been done:

1. Create/configure the Slack app (bot token + signing secret + scopes above).
2. Enable **Interactivity** in the app and set the **Request URL** to a public HTTPS
   URL (for example an existing Caddy or Cloudflare Tunnel endpoint) that reverse-proxies to
   `http://127.0.0.1:8790/slack/interactions`.
3. Restart `mav-bridge` with the new env vars loaded.
4. Post a card, click a button, confirm the replacement message appears.

Until step 2, Slack cannot deliver button clicks, so the interactive path is dormant
by construction.
