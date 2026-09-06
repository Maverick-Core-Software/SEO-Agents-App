# Decisions after the 2026-09-05 weekly-run audit

Owner answers recorded 2026-09-05. These bind the pre-Friday fixes and the rebuild that
follows. See `2026-09-05-weekly-run-audit-report.md` for the findings they answer.

| Question | Decision |
|---|---|
| Business facts | Recorded in `knowledge/baselines/grizzly-business-facts.md`. Owner-reviewed; never compacted. |
| Auto-publish policy | GBP and Facebook posts auto-approve (`SEO_AUTO_APPROVE=1`) as today. Website changes stay gated on the owner. |
| GBP posting week | Keep Friday to Thursday. It matches the 9:00 poster. |
| Weekly spend ceiling | Proposed below. Owner delegated the number. |
| Google Search Console | Owner owns the property. API access to be set up (steps below). |
| GBP performance API | Owner will follow up on Google support case 2-5921000040991. |
| When live search fails on a Friday | Publish preapproved evergreen content and alert the owner. Do not stop. |
| Anonymous read access on Supabase tables | Leave as is; the dashboards use it. |
| Hosting | Stay on the current PC through the rebuild. AIWA only after cutover. |
| Cheap subagents | DeepSeek (pi, provider `deepseek`, model `deepseek-v4-flash`) for bounded implementation and review work, with independent review before anything is applied. |

## Spend ceiling (proposed, owner delegated)

| Period | Ceiling | Alert at |
|---|---|---|
| Now, current CrewAI pipeline | $20 per week for models plus search | $15 |
| After cutover to the scripted pipeline | $5 per week | $4 |

Basis: the current run is one DeepSeek research pass plus roughly 35 minutes of Anthropic
Sonnet execution and schedule generation, which lands in the low single dollars per attempt.
Three failed attempts in one Friday would still fit under $20. The rebuilt pipeline is one or
two model calls per week. Enforcement is not in code yet; the rebuild adds a per-attempt cost
meter and refuses to start a new attempt past the ceiling.

## Search Console API access: steps

The repo already has a working Google OAuth path for GBP: client secret at
`C:\Users\carte\gmail-multi\client_secret_hermes_gbp.json` (project hermes-agent,
`exalted-slice-502415-s0`), one-shot authorize flow in `scripts/authorize-gbp.mjs`, and a
refreshing token reader in `scripts/lib/gbp-api-auth.mjs`. Search Console reuses that path
with a different scope and its own token file.

1. Owner, once, in the Google Cloud console for project `exalted-slice-502415-s0`:
   APIs and Services, Library, search "Google Search Console API", Enable.
2. Owner, once, from the repo, signed in to the Google account that owns the Search Console
   property for grizzlyelectricaltx.com:
   `node scripts/authorize-search-console.mjs`
   A browser opens; approve read-only Search Console access. The token saves to
   `C:\Users\carte\gmail-multi\tokens\grizzly-search-console.json`.
3. Anyone: `node scripts/search-console-probe.mjs` lists the properties the token can see and
   prints the last 28 days of top queries for the site. The error text names the exact fix if
   step 1 or 2 is missing.

## Applied on 2026-09-05 (pre-Friday fixes)

- `src/seo_agents/main.py`: removed the hidden root `topic` positional that blanked every
  research topic since June; research now refuses an empty topic; the executor crew is skipped
  in code when no queued task is executable, with explicit "skipped" output files so stale
  reports cannot leak into status, the action queue, or Supabase sync.
- `src/seo_agents/crew.py`: the raw-queue fallback only applies to legacy runs with no task
  graph; `task_graph_tasks()` added.
- `src/seo_agents/run_context.py`: the caller's run ID is authoritative, so every artifact of
  one attempt carries one identical ID.
- `scripts/run-weekly-seo.py`: preflight byte-compiles the package, parses the real CLI shape,
  and constructs both LLM tiers with the same interpreter and env the crew runs under; the crew
  is launched as `python -m seo_agents.main` (not the .exe launcher) with a 150-minute timeout
  (`SEO_CREW_TIMEOUT_MIN`) that clears the stale run lock on kill; the topic rotation records a
  topic only after a successful run.
- `knowledge/baselines/`: the false WordPress/CF7 baseline is archived under
  `archive/2026-09/`; `grizzly-business-facts.md` replaces it and is excluded from
  `compact-baselines`.
