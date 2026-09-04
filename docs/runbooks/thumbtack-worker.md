# Thumbtack worker

Extracted from MCC into SEO-Agents-App. This is the Grizzly Thumbtack channel: webhook intake, OAuth, deterministic first-touch auto-reply. Marketing Control is the dashboard; this worker is the server.

## Process

- Script: `scripts/thumbtack-worker.mjs`
- PM2 name: `thumbtack-worker`
- Bind: `127.0.0.1:8796` (do not use 8080)
- Health: `GET /api/webhooks/thumbtack/health`
- Webhook: `POST /api/webhooks/thumbtack` header `X-Maverick-Webhook-Token`

## Live cutover (2026-09-03)

- Worker is a hidden Node process (not session-0 PM2; do not `pm2 start` from a normal shell on this PC).
- Local: `http://127.0.0.1:8796`
- Public Funnel (internet): `https://cmb-workbench.tailf72e3f.ts.net` → `127.0.0.1:8796`
- Health: `https://cmb-workbench.tailf72e3f.ts.net/api/webhooks/thumbtack/health`
- Webhook: `POST https://cmb-workbench.tailf72e3f.ts.net/api/webhooks/thumbtack` header `X-Maverick-Webhook-Token`
- OAuth callbacks: `/api/integrations/thumbtack/oauth/callback` and `.../oauth/staging/callback` on that same host
- Existing tailnet serves on `:18920` and `:5188` were left in place
- Still update the URL in the Thumbtack Pro webhook UI (self-serve). Partner API webhooks use Basic auth; this worker still uses the custom header.

## Maverick replies

The worker POSTs to the live SMS Maverick process:

`POST http://127.0.0.1:3012/internal/thumbtack/reply` (loopback only)

Mav uses the Thumbtack channel (pricebook lookups, one question at a time). Timeout 45s; if Mav is down or slow, the worker sends the deterministic first-touch instead of going silent. Follow-up customer messages are also auto-sent.

## Alerts

Slack first via existing `scripts/lib/slack-alert.mjs` (Hermes bot token / home channel). Hermes CLI fallback. Twilio 1546 last.

## Tests

```bash
node --test scripts/lib/thumbtack/*.test.mjs scripts/thumbtack-worker.test.mjs
```
