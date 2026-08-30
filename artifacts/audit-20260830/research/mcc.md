# Workstream: mcc (status: ?)

# MCC Decomposition Audit — SEO-Essential vs Non-SEO Modules

## Findings

### Module Classification Table

| Module | Verdict | Rationale |
|--------|---------|----------|
| `src/SEOApprovalPage.jsx` | **KEEP** | Core SEO approval UI. Imports only from `./lib/api.js` and `./lib/seoRules.js`. Pure client-side rendering of SEO pipeline status, actions, posts, and faults. |
| `src/lib/seoRules.js` | **KEEP** | Pure function `postHealth()` — no imports from MCC server code. Deterministic post health checks used exclusively by SEOApprovalPage. |
| `src/lib/api.js` | **SPLIT** | Contains SEO-specific functions (`querySeoWorkflow`, `querySeoActions`, `approveSeoAction`, `runSeoAction`, `dismissSeoAction`, `retrySeoAction`, `clearSeoFault`, `querySeoWeekPosts`, `querySeoTaskLog`, `generateFacebookSchedule`) that are SEO-essential, mixed with homelab/agent functions (`queryAllMetrics`, `queryModelStatus`, `queryZaiStatus`, `queryDeployStatus`, `queryOrchestratorStatus`, `createOrchestratorPlan`, `createLocalWorkerBrief`, `createTaskRun`, `updateTaskRun`, `queryMemory`). The `api()` helper and `queryPrometheus` are shared infrastructure. |
| `src/pages/HomePage.jsx` | **RETIRE** | Homelab operations command dashboard. Imports `useOrchestratorStatus`, `useSeoWorkflow` from hooks; `Panel` from Dashboard component; `approveSeoAction`, `querySeoActions`, `runSeoAction` from api.js; `workerLabel` from dashboardHelpers. Displays agent fleet status, local model status, Z.AI brain status, orchestrator workflow — none SEO-essential. |
| `server.mjs` | **SPLIT** | The HTTP server wires ALL routes together. SEO-relevant routes: `/api/workflows/seo/*`, `/api/workflows/seo/posts/week`, `/api/workflows/seo/facebook/*`, `/api/workflows/seo/tasks/log`. Non-SEO: `/api/chat`, `/api/build-chat`, `/api/build/apply`, `/api/extract-file`, `/api/photos/upload`, `/api/list-dirs`, `/api/rag*`, `/api/query`, `/api/llm/status`, `/api/llm/zai-status`, `/api/llm/models`, `/api/orchestrator/*`, `/api/memory`, `/api/deploy/status`, `/api/webhooks/thumbtack/*`, `/api/integrations/thumbtack/*`, `/api/realtime-token`, `/api/rag-voice-query`. Static file serving is shared. |
| `routes/seo.mjs` | **KEEP** | Pure SEO proxy: `getSeoWorkflowStatus()` and `proxySeoActions()` forward to SEO App. Depends only on `lib/http.mjs`, `lib/config.mjs` (for `seoAppUrl`), `lib/state.mjs` (for `logSeoEvent`), `lib/models.mjs` (for `callSeoApp`). |
| `routes/orchestrator.mjs` | **RETIRE** | AI work-router for agent fleet. Plans, routes tasks to Claude/Codex/rag-server, tracks ledger. Uses Anthropic API, memory index, SEO app state probe, self-improve trigger. No SEO approval function. |
| `routes/build.mjs` | **RETIRE** | Build pipeline: applies staged file runs to disk with backups, lists directories. PM2 restart orchestration. Pure homelab devops. |
| `lib/chat.mjs` | **RETIRE** | 500+ line AI assistant brain: BUILD, OPS, ASK, VISION, ESTIMATE, CLAUDE-CODE, AGENT modes. Claude-director/Pi-executor loop, NIM QC, Venice QC, RAG integration, Mastra agent spawning, HCP estimate pipeline. No SEO function. |
| `lib/models.mjs` | **SPLIT** | Contains `callSeoApp()` and `getSeoAppState()` which are SEO-essential. Also contains `anthropicChat`, `openRouterChat`, `localChat`, `openAiChat`, `veniceChat`, `callLocalModel`, `callClaude`, `callGpt4o`, `callPiRpc`, `streamUpstream`, `extractJsonObject` — all homelab/agent infrastructure. |
| `lib/config.mjs` | **SPLIT** | SEO-essential export: `seoAppUrl`. Also exports every other config constant: Prometheus, RAG, local model, OpenRouter, Venice, Anthropic, Gemini, NIM, Z.AI, Pi, workspace paths, Thumbtack (6+ config groups), GBP photos, Supabase, brain vault, memory paths, staging/backup roots, blocked paths, allowed origins. |
| `lib/http.mjs` | **KEEP** | Generic `send`, `sendJson`, `readJsonBody`, `sseWrite`, `buildChatSseWrite`. No domain logic. Used by everything. |
| `lib/state.mjs` | **SPLIT** | SEO-essential: `seoTaskLog` array, `logSeoEvent()`. Also: `readLedger`, `writeLedger`, `addLedgerRun`, `updateLedgerRun` (orchestrator task ledger), `orchestratorState`, `saveOrchestratorState`, generic `readJsonState`/`writeJsonState`. |
| `lib/load-env.mjs` | **KEEP** | 7 lines. Loads dotenv. Shared bootstrap, no domain. |
| `lib/llama-status.mjs` | **RETIRE** | Probes local llama.cpp/guardian for model status. Homelab infrastructure. |
| `lib/zai-status.mjs` | **RETIRE** | Probes Venice/Z.AI cloud endpoint. Homelab infrastructure. |
| `lib/memory.mjs` | **RETIRE** | Claude memory directory reader, brain vault scanner, keyword search. Falls back to SEO App memory endpoint when local is missing, but that's a convenience fallback, not SEO-essential. |
| `lib/prompts.mjs` | **RETIRE** | System prompts for ASK (Maverick Field Tech, NEC code), ESTIMATE, BUILD architect, OPS orchestrator. Electrical contracting domain. No SEO content. |
| `lib/self-improve.mjs` | **RETIRE** | Background Qwen self-improvement script trigger. Homelab agent. |
| `lib/extract.mjs` | **RETIRE** | PDF/DOCX text extraction for electrical inspection reports. Uses Anthropic vision fallback. |
| `lib/exec.mjs` | **RETIRE** | Agentic execution engine: path sandboxing, file I/O, shell, web, docs, email, vision tools, staged-run persistence. BUILD/OPS infrastructure. |
| `lib/ops-notify.mjs` | **RETIRE** | Twilio SMS for operator nudges. |
| `lib/thumbtack-api.mjs` | **RETIRE** | Thumbtack Partner API v4 adapters. |
| `lib/thumbtack-lead-processor.mjs` | **RETIRE** | Lead processing logic. |
| `lib/thumbtack-lead-state.mjs` | **RETIRE** | Lead state machine. |
| `lib/thumbtack-policy.mjs` | **RETIRE** | Reply policy rules. |
| `lib/thumbtack-token-store.mjs` | **RETIRE** | Token persistence/encryption. |
| `ecosystem.config.cjs` | **SPLIT** | Defines `mav-console` app (shared) and `mav-bridge` (SEO-relevant, lives in SEO-Agents-App). Also `prometheus-sync` (SEO-Agents-App script), `downloads-watcher` (homelab), `mcc-dashboard-agent` (homelab). |
| `routes/thumbtack.mjs` | **RETIRE** | Thumbtack webhook handler. |
| `routes/thumbtack-oauth.mjs` | **RETIRE** | Thumbtack OAuth flow. |
| `routes/photos.mjs` | **RETIRE** | GBP photo upload endpoint. |

### SEO Approval Dependency Graph

```
SEOApprovalPage.jsx
  └── src/lib/api.js (SEO functions only)
        └── HTTP fetch → server.mjs routes
  └── src/lib/seoRules.js (zero imports)

server.mjs SEO routes:
  /api/workflows/seo                 → routes/seo.mjs::getSeoWorkflowStatus()
  /api/workflows/seo/actions          → routes/seo.mjs::proxySeoActions('list')
  /api/workflows/seo/actions/approve  → routes/seo.mjs::proxySeoActions('approve')
  /api/workflows/seo/actions/run      → routes/seo.mjs::proxySeoActions('run')
  /api/workflows/seo/actions/dismiss  → routes/seo.mjs::proxySeoActions('dismiss')
  /api/workflows/seo/actions/retry    → routes/seo.mjs::proxySeoActions('retry')
  /api/workflows/seo/actions/clear-fault → routes/seo.mjs::proxySeoActions('clear-fault')
  /api/workflows/seo/tasks/log        → lib/state.mjs::seoTaskLog (direct read)
  /api/workflows/seo/posts/week       → lib/models.mjs::callSeoApp() (direct call)
  /api/workflows/seo/facebook/pending-prompt → lib/models.mjs::callSeoApp()
  /api/workflows/seo/facebook/approve-prompt → lib/models.mjs::callSeoApp()
  /api/workflows/seo/facebook/new-schedule   → lib/models.mjs::callSeoApp()

routes/seo.mjs depends on:
  lib/http.mjs         (sendJson, readJsonBody)
  lib/config.mjs       (seoAppUrl only)
  lib/state.mjs        (logSeoEvent)
  lib/models.mjs       (callSeoApp)

lib/models.mjs::callSeoApp depends on:
  lib/config.mjs       (seoAppUrl only)
  node:fetch           (stdlib)

lib/state.mjs::logSeoEvent depends on:
  lib/config.mjs       (seoTaskLogFile path)
  lib/state.mjs        (seoTaskLog array, writeJsonState)

server.mjs SEO direct calls (bypass routes/seo.mjs):
  /api/workflows/seo/posts/week       → lib/models.mjs::callSeoApp
  /api/workflows/seo/facebook/*       → lib/models.mjs::callSeoApp
  /api/workflows/seo/tasks/log        → lib/state.mjs::seoTaskLog
```

**Minimal SEO server surface (4 lib files + 1 route file + server.mjs routing):**
- `lib/config.mjs` — needs only `seoAppUrl`, `seoTaskLogFile`, `port`, `dataDir`
- `lib/http.mjs` — used as-is
- `lib/state.mjs` — needs only `seoTaskLog`, `logSeoEvent`, `readJsonState`, `writeJsonState`, `ensureDataDir`
- `lib/models.mjs` — needs only `callSeoApp` (and its `seoAppUrl` dep from config)
- `routes/seo.mjs` — used as-is

**Independent modules (zero SEO dependency):**
- `lib/chat.mjs`, `lib/exec.mjs`, `lib/prompts.mjs`, `lib/self-improve.mjs`
- `lib/llama-status.mjs`, `lib/zai-status.mjs`, `lib/memory.mjs`, `lib/extract.mjs`
- `lib/ops-notify.mjs`
- `lib/thumbtack-*.mjs` (5 files)
- `routes/orchestrator.mjs`, `routes/build.mjs`, `routes/thumbtack.mjs`, `routes/thumbtack-oauth.mjs`, `routes/photos.mjs`
- `src/pages/HomePage.jsx`, `src/MaverickPage.jsx`, `src/pages/SystemPages.jsx`, `src/pages/OrchestratorPage.jsx`, `src/pages/EcosystemMapPage.jsx`
- `src/components/Dashboard.jsx`
- `src/hooks/useMetrics.js`, `src/config/metrics.js`

### Shared-but-splittable modules

- **`lib/config.mjs`** — exports 80+ constants. SEO needs 3 (`seoAppUrl`, `seoTaskLogFile`, `port`/`dataDir`). The rest (Prometheus, RAG, 8 AI provider configs, Thumbtack, GBP, workspace, brain, staging) are non-SEO.
- **`lib/models.mjs`** — exports 12 functions. SEO needs 1 (`callSeoApp`). The rest are AI provider clients and planner primitives.
- **`lib/state.mjs`** — exports 10 functions + 2 live objects. SEO needs `seoTaskLog` + `logSeoEvent`. The rest (orchestrator state, ledger CRUD) are non-SEO.
- **`src/lib/api.js`** — exports 22 functions. SEO needs 10 (the `querySeo*`, `approveSeoAction`, `runSeoAction`, `dismissSeoAction`, `retrySeoAction`, `clearSeoFault`, `generateFacebookSchedule`). The rest are homelab/agent/orchestrator.
- **`server.mjs`** — monolithic router. SEO routes are ~40 lines of the ~200-line request handler. The rest is non-SEO.
- **`ecosystem.config.cjs`** — `mav-console` entry is shared; `mav-bridge` and `prometheus-sync` entries reference SEO-Agents-App scripts but are PM2 process definitions, not code.

## Analysis

### Key Observation

SEO approval in MCC is a **thin proxy layer**. The entire SEO approval flow is:
1. Frontend (`SEOApprovalPage.jsx`) calls client-side API helpers (`src/lib/api.js` SEO functions)
2. Those hit `server.mjs` routes under `/api/workflows/seo/*`
3. Server-side routes in `routes/seo.mjs` call `callSeoApp()` from `lib/models.mjs`
4. `callSeoApp()` is a thin HTTP forwarder to the SEO Agents App at `seoAppUrl` (currently `http://127.0.0.1:8790`)
5. Mutating actions also call `logSeoEvent()` which appends to an in-memory array backed by `lib/state.mjs`

The SEO approval page does **no AI calls**, **no model routing**, **no file I/O**, **no database writes**. It is a pure read-mutate-proxy UI. The actual SEO intelligence lives entirely in the SEO Agents App.

### What Can Be Extracted Cleanly

The SEO approval surface (frontend + backend) could be extracted into a standalone ~300-line Express/Hono server with zero coupling to the homelab/agent code. The dependency chain is 4 server modules + 1 route file + 1 JSX page + 1 CSS rule file.

### What's Tangled

- `server.mjs` is the monolith entry point. SEO routes are interleaved with 15+ non-SEO route handlers. Extraction requires either: (a) a new server entry point that only mounts SEO routes, or (b) route-level extraction from the existing file.
- `lib/config.mjs` is the single config source. Splitting it requires either: (a) a new minimal config for the SEO server, or (b) tree-shaking (the SEO server imports only what it needs from the existing config).
- `ecosystem.config.cjs` defines both MCC and non-MCC PM2 processes (`downloads-watcher`, `mcc-dashboard-agent`). The `mav-console` entry itself mixes SEO env vars (`SEO_APP_URL`) with non-SEO env vars.

### Risks

1. **`src/lib/api.js` split** — if the SEO frontend is extracted, it needs its own `api.js` with only the 10 SEO functions. Currently all 22 functions share the same `api()` base-URL helper, so this is a clean extraction.
2. **`lib/state.mjs` `seoTaskLog` is a module-level singleton** — if both MCC and a new SEO app import it, they'd have separate in-memory arrays writing to the same JSON file. Not a problem if MCC is retired; would be a race condition if both run concurrently.
3. **`callSeoApp()` in `lib/models.mjs`** — this is the only function from models.mjs that SEO needs. It's 30 lines, self-contained (depends only on `seoAppUrl` from config). Clean to copy or extract.
4. **No circular dependencies observed** in the SEO subgraph.

### HomePage Classification Note

`src/pages/HomePage.jsx` imports `useOrchestratorStatus` and `useSeoWorkflow` from hooks, and displays agent fleet status, local model status, Z.AI brain status, orchestrator plans, task runs, and Prometheus metrics. It also has inline approve/run/dry-run buttons for SEO actions, but these are a secondary view — the primary `SEOApprovalPage.jsx` is the canonical SEO UI. HomePage is **RETIRE** (homelab operations dashboard) — the inline SEO action buttons are a convenience duplicate, not the source of truth.