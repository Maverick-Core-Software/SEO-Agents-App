# Grizzly Marketing Control

Private **read-only** weekly marketing dashboard for Grizzly Electrical. This is Phase 1 of [`../PLAN.md`](../PLAN.md). It surfaces the existing Supabase record (runs, posts, website tasks, logs) plus bundled fixtures. It does **not** replace MCC writes, mav-bridge, or the SEO worker.

## Run

From this directory (`marketing-control/`):

1. Copy `.env.example` → `.env`.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (key **names** only; never commit real values).
3. Install and start:

```bash
npm install
npm run dev
```

Other scripts:

```bash
npm test
npm run build
```

Missing env degrades to bundled fixtures and a not-configured banner. The app does not crash.

## Read-only guarantee

- No Supabase `insert` / `update` / `delete` / `upsert` / `rpc`. Queries go through `src/lib/guard.js` (`wrapReadOnly`); mutation property access throws `Error('READ_ONLY')`.
- Write buttons are disabled with tooltip `write action — read-only slice`.
- The only network write-shaped call that would be allowed is GET. Worker liveness is GET-only.

## Optional env

| Name | Purpose |
|---|---|
| `VITE_SEO_STATUS_URL` | GET worker liveness (Operations). Unset or failed GET → “worker unreachable”. Never POST. |
| `VITE_OUTPUTS_DIR` | Documented for a later file-backed performance path. **Unused in the browser** (Vite has no `fs`); Performance still shows bundled fixtures. |

## Phase 2 (not this slice)

See [`../PLAN.md`](../PLAN.md) and [`docs/AUDIT-FINDINGS.md`](docs/AUDIT-FINDINGS.md).

- Durable command path (commands / attempts / worker lease) instead of direct writes.
- RLS: `schema.sql` has none. If live RLS is off, the anon key can write — Phase-2 prerequisite (H11 / M1).
- MCC SEO proxy cutover after one full weekly cycle.

## Non-goals

- Do not post.
- Do not approve live.
- Do not edit the two Active repos (`C:\Workspace\Active\SEO-Agents-App`, `C:\Workspace\Active\MCC`).
