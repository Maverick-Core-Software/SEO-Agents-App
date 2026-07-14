# SEO Agents App — Agent Context

## Stack
- **Apps:** Next.js (TypeScript), React, Tailwind CSS, shadcn/ui
- **Backend:** Supabase (Postgres, Auth, Storage), Edge Functions
- **Deployment:** Vercel, GitHub
- **Runtime:** Node.js, Python 3.12
- **Package manager:** npm
- **AI orchestration:** CrewAI with local/remote LLM routing

## Key file locations
- Entry point: `src/seo_agents/main.py`
- Research crew: `src/seo_agents/crew.py`
- Claim/evidence extraction: `src/seo_agents/claims_extract.py`
- Run finalizer: `src/seo_agents/finalize.py`
- Evidence/claim/task writers: `src/seo_agents/evidence.py`
- Action queue + dispatch: `src/seo_agents/actions.py`
- Workflow status + validation: `src/seo_agents/status.py`
- Run context/locking: `src/seo_agents/run_context.py`
- Observability: `src/seo_agents/observability.py`
- Pydantic contracts: `src/seo_agents/contracts.py`
- Prompts: `prompts/agents/*.txt`
- Tests: `tests/`
- Node helpers: `scripts/lib/`

## Runtime boundaries
- `research --dry-run`: builds crew config, writes manifest + empty evidence/claim/task, no LLM/Supabase/adapter calls.
- `research --skip-execute`: research-only mode, finalizes evidence/claims, skips execution pipeline.
- Live research: archives reports, finalizes evidence/claims, validates gates, builds task graph, executes only if gates pass.
- `run-action`: routes through `enforce_idempotency()`; requires approval for live side effects.

## Auth / env
- Secrets live in `.env` only.
- Required env vars: `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SMTP_APP_PASSWORD`, `GBP_PHOTO_PATH`, etc.

## Testing
- Python: `export PYTHONPATH=src && python -m pytest -q`
- Node: `node --test scripts/lib/*.test.mjs`
- No live LLM, Supabase writes, or adapter calls during offline tests.

## Project-specific rules
- Preserve existing Markdown report markers (`[START:X]` / `[END:X]`).
- Every artifact carries the current `run_id`; empty collections still require an explicit `run_id`.
- Hard gate failures stop automatic execution before any adapter side effect.
- GBP `live_unverified` requires owner verification; no automatic retry.
