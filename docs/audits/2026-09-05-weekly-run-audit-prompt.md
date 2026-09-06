# Audit brief: the weekly CrewAI research-to-content run in SEO-Agents-App

**Mode: READ-ONLY AUDIT. Do not edit, fix, refactor, commit, or run anything that mutates state.**
Your deliverable is a written report. Nothing else.

## 1. Who you are working for and what they actually want

The owner runs Grizzly Electrical Solutions, a residential electrician in Rowlett / DFW, Texas. He built
this repo so that **once a week, automatically and without him**, a system would:

1. Find out what electrical services people in DFW are searching for most *this week*.
2. Turn that into next week's social media posts (Google Business Profile and Facebook) and website
   updates (blog posts, service page copy, fixes), aimed at those searches.
3. Publish them through the existing posters.
4. **Remember everything it has done, measure what worked and what did not, and get better every week.**
5. Run every Friday without errors, and tell him when it cannot.

He believes the current implementation is heavily over-engineered and could be much simpler. He does not
care what framework, model, provider, database, or scheduler is used. He is open to replacing any part of
it, including CrewAI, DeepSeek/Anthropic, Supabase, Windows Task Scheduler, or the Markdown-based
pipeline, if that gets him the five outcomes above more reliably. He wants an honest, specific report:
what is wrong, what must be fixed, what can be simplified, what can be deleted, and what should move to a
different approach or provider.

## 2. Scope

**In scope** (audit these end to end):

- Weekly trigger and wrapper: `scripts/setup-scheduled-tasks.ps1`, `scripts/run-weekly-seo.py`
  (topic selection with pytrends, preflight, launch, health file).
- The CrewAI engine in `src/seo_agents/`: `crew.py` (all crews: research, executor, GBP poster
  schedule, Facebook schedule, website), `main.py` (the `research` command chain that auto-runs
  execute, post-schedule, facebook-schedule, then Supabase sync), `run_context.py`, `week_spec.py`.
- The evidence / claims / gates layer: `contracts.py`, `evidence.py`, `claims_extract.py`,
  `finalize.py`, `observability.py`, `actions.py` (action queue, task graph, dispatch gate,
  idempotency), `status.py`.
- Agent prompts in `prompts/agents/*.txt` and the knowledge fed to agents in `knowledge/baselines/`.
- Persistence: `scripts/supabase-sync.mjs`, `scripts/lib/parse-website-tasks.mjs`,
  `supabase/schema.sql`, `supabase/migrations/`, and everything written under `outputs/`, `state/`,
  `outputs/archive/`, `memory/`.
- The memory and feedback loop: `load_previous_run_context`, `_fetch_completed_tasks`,
  `compact_baselines`, `state/topic-history.json`, `scripts/facebook-insights-collector.mjs`,
  `scripts/gbp-analytics-collector.mjs`, and whether any of it is actually consumed by the next run.
- Reliability tooling: `scripts/seo-monitor.mjs`, `scripts/seo-watchdog.mjs`, alerting paths
  (Hermes CLI and SMTP), `FRIDAY-RUNBOOK.md`, `outputs/run_health.json`,
  `outputs/weekly-runner-health.json`, the weekly logs under `outputs/`.
- LLM routing and failover in `crew.py` (`_build_tier_llm`, `_attach_failover`, `_call_local_llm`).
- Tests under `tests/` and `scripts/**/*.test.mjs` as they relate to the above.
- Dependencies: `pyproject.toml`, `uv.lock`, `requirements.txt`, `package.json`.

**Out of scope** (do not audit internals; only note the contract the in-scope code hands them):

- Facebook publishing and boosting: `scripts/facebook-poster.mjs`, `scripts/fb-boost-*.mjs`,
  `scripts/lib/fb-boost-marketing.mjs`, `scripts/facebook-comment-agent.mjs`, slideshow/video
  generators.
- GBP publishing: `scripts/gbp-poster/`, `scripts/gbp-worker.mjs`, `scripts/gbp-api-poster.mjs`,
  `scripts/gbp-profile-adapter.mjs`, photo picking and photo ingestion scripts.
- `scripts/mav-bridge.mjs` execution internals (note only what it expects from Supabase rows).
- `marketing-control/`, `maverick-core-commercial/`, `scripts/lib/thumbtack/`,
  `scripts/thumbtack-worker.mjs`, `scripts/classify-electrical.mjs`, `scripts/vision-benchmark.mjs`.
- The separate MCC repo at `C:\Workspace\Active\MCC`.

You may still flag out-of-scope files under "what could be removed from this repo" if they clearly do
not belong to the weekly run.

## 3. Hard rules

- Do not modify any file in the repo. Do not create branches, stashes, or commits.
- Do not run `seo-agents research`, `execute`, `post-schedule`, `facebook-schedule`, `website`,
  `blog-post`, or `compact-baselines` without `--dry-run`. `--dry-run` for `research` is documented as
  making no LLM, Supabase, or adapter calls; verify that claim in `main.py` before relying on it.
- Do not start, stop, or re-register any Windows Scheduled Task or PM2 process. Reading them is fine.
- Do not write to Supabase. Read-only `select` queries are fine. If a Supabase MCP tool is available,
  prefer it; otherwise use the REST API with the service key from `.env`.
- Never print, quote, or copy secret values. Refer to `.env` keys by name only.
- Do not delete `outputs/lock.lock.json` or anything else, even if it looks stale.
- Do not spend money: no live LLM calls, no Serper/SerpApi calls, no Meta or Google API calls.
- Every finding must cite a file path and line range, a log line, a database row, or a command output
  you actually observed. Label anything you could not verify as **unverified**.
- Read `AGENTS.md` at the workspace root and `.pi/AGENTS.md` before starting; they describe the
  intended runtime boundaries.

## 4. Starting evidence (observed 2026-09-05, re-verify each before relying on it)

These are observations from a quick pass, not conclusions. Confirm, correct, or expand each one.

**How "research the top searches" actually works today**

- Topic selection is not open-ended. `scripts/run-weekly-seo.py` compares a fixed list of 10
  keywords through pytrends (`CANDIDATE_KEYWORDS`, `TOPIC_MAP`), excludes the last 4 used, and falls
  back to rotation by ISO week when pytrends fails. `state/topic-history.json` shows the same topic
  appended twice in 7 entries because failed attempts also append.
- The GBP agent's "trend research" in `crew.py` is five hardcoded queries, one of which is
  `'panel upgrade Dallas 2025'`. Prompts tell agents to use `SerperDevTool` (9 mentions across
  `src/` and `prompts/`) while the code builds `SerpApiGoogleSearchTool` gated on `SERPAPI_API_KEY`.
  Determine whether live search actually fires in a normal run and what the agents fall back to.
- `run_manifest.json` from the last run has `topic: ""` and `run_id: "..._untitled"` even though the
  wrapper launched with a real topic. Trace where the topic is lost.

**What the agents are told is true**

- `knowledge/baselines/` contains exactly one active file, 764 bytes,
  `grizzly-current-status-2026-08-28.md`. It states the site is WordPress with Contact Form 7. The site
  is a static HTML repo deployed on Vercel (see `README.md`, `prompts/agents/website-manager-agent.txt`,
  `knowledge/website-structure.md`). A comment in `main.py` says the `compact-baselines` step
  "archived real knowledge into an 800-word stub that still claimed WordPress/CF7". Assess how much of
  every weekly run is built on stale or false context, and where the truth should live instead.
- `load_previous_run_context` injects the first 40 lines of the last 2 archived manager plans.
  `_fetch_completed_tasks` injects `website_tasks` rows with `status=done` from Supabase (the brief in
  `outputs/completed-work-brief.md` includes at least one garbage row whose title is a format
  instruction). Evaluate whether this constitutes memory of "what it has done".

**The feedback loop**

- `outputs/facebook_engagement_report.md` is dated week of 2026-07-16, shows zero engagement on every
  row, and is referenced by no file other than the collector that writes it. `FRIDAY-RUNBOOK.md` says to
  run the collector by hand before the Friday crew.
- `scripts/gbp-analytics-collector.mjs` writes `outputs/gbp-analytics-latest.json`, which nothing
  reads, and `PLANSCOPE.MD` records that the GBP API project is still not approved (quota 0).
- Conclusion to test: there is currently no automated measurement of post or website performance
  feeding the next run, so "what is working and what isn't" is not known to the system.

**The evidence / claims / gates layer**

- Every research prompt requires the LLM to emit machine-readable claim blocks
  (`Claim ID: claim_<16-hex>`, Claim Type, Source Mode, Source Kind, Source URI, Retrieved At). About
  3,300 lines across `contracts.py`, `evidence.py`, `claims_extract.py`, `finalize.py`,
  `observability.py`, plus the 2,452-line `actions.py`, parse those blocks into `claim_graph.json`,
  `evidence_package.json`, `task_graph.json`, `action_queue.json`, and a 36,000-line
  `outputs/observability.jsonl`. `observability.py` labels its metrics "proposed".
- On 2026-09-04 the finalize gate hard-failed three separate times (2, 1, then 4 failures) on things like
  a "3+ years" versus "over a decade" tenure contradiction, each time aborting the entire pipeline
  before any content was produced. Decide whether this layer earns its cost against the owner's five
  goals, and what a minimal replacement would be.
- `outputs/run_health.json` currently shows `finalize: failed` at 14:45Z alongside
  `research/execute/post_schedule/facebook_schedule: success` from a later attempt. Determine whether
  the health file can be trusted by the monitor and watchdog.

**Multiple state stores and approval systems**

- README documents a local action queue and approval flow (`outputs/action_queue.json`,
  `outputs/action_approvals.json`, `approve-action`, `run-action`, idempotency locks in `actions.py`).
- `FRIDAY-RUNBOOK.md` and `docs/NEXT-SESSION.md` describe the real path as Supabase
  (`seo_runs`, `weekly_posts`, `website_tasks`) polled by mav-bridge and gbp-worker, with
  `SEO_AUTO_APPROVE=1` bypassing the human gate.
- `sync_gbp_schedule_to_workbook` in `actions.py` writes a third store, an Excel workbook.
- Determine which of these is actually load-bearing today and which are dead or duplicate.

**Persistence to Supabase**

- `supabase/schema.sql` has four tables. `seo_runs` stores only status timestamps: no topic, no
  keywords, no trend data, no report content. Research output survives only as Markdown under the
  gitignored `outputs/` and `outputs/archive/` (74 directories using two different naming schemes)
  on one Windows machine.
- `scripts/supabase-sync.mjs` reconstructs posts by regex-parsing LLM-written Markdown
  (`DAY:`, `DATE:`, `HOOK:` fields). The git log since June contains repeated fixes to those parsers
  (code fences, `---` inside blocks, next-line values, date normalization). The same parsing logic is
  described as "mirrored" in `facebook-poster.mjs`. CrewAI supports structured outputs
  (`output_json`, `output_pydantic`), which the executor crew already uses; assess why the schedules
  do not, and what breaks if they did.
- Compare `supabase/schema.sql` against the live database (tables, columns, constraints, RLS) and
  report drift. Migration 002 exists because a column silently went missing before.

**Run reliability history**

- Runner logs under `outputs/weekly-runner-*.log` show: 07-24 failed, 07-28 manual re-run, 07-31 failed
  on Anthropic credit exhaustion, 08-14 has no completion line, 09-04 needed seven launches between
  13:30Z and 14:53Z before succeeding (missing `anthropic` SDK after `uv sync`, a stranded lock file,
  a `SyntaxError` in `crew.py` line 493 introduced mid-morning, then three gate failures). Cross-check
  against `seo_runs` rows in Supabase to build a table of every intended Friday since June: fired or not,
  succeeded or not, how many attempts, root cause.
- Roughly 60 of the ~290 commits since June are `fix:` commits. Read `git log --since=2026-06-01` and
  categorize what keeps breaking.
- Phase durations from the last successful run: research ~400 s, execute ~1,790 s, GBP schedule ~80 s,
  Facebook schedule ~65 s. The executor crew on 09-04 reported "No tasks reached a fully verified state";
  all four tasks were `waiting_on_owner`. Assess what the 30-minute executor crew contributes.
- LLM routing: research tier is `deepseek/deepseek-chat`, execution tier is
  `anthropic/claude-sonnet-4-6`, with fallbacks. Failover is implemented by swapping `__class__` on the
  CrewAI `LLM` instance at runtime. `_call_local_llm` and `generate_blog_post` say "Qwen" in comments
  but call DeepSeek. Assess the routing for correctness, cost, and simplicity, and recommend a provider
  strategy (single provider, local model, or otherwise) with reasoning.
- Hardcoded Windows paths (`C:\Users\carte\...`, `C:\Workspace\...`) appear in 9 files under `src/`
  and `scripts/`; `C:\Workspace` is a junction to `D:\Workspace`, and logs show both forms for the same
  files. `outputs/`, `state/`, and `logs/` are gitignored, so all run state is unversioned and
  machine-local.

**Tests and repo hygiene**

- `pytest --collect-only` collects 372 tests today. There are 33 Node test files. There is no CI and no
  `npm test` script. `tests/conftest.py` contains a no-op fixture with a hardcoded path. An empty,
  untracked directory literally named `C:WorkspaceActiveSEO-Agents-Apptestsfixturesresearchartifacts`
  sits at the repo root, apparently from a path bug. Determine which tests exercise the Friday path and
  which are testing the gates layer only.
- The repo root also holds seven `.env.bak-*` files, `AIWA Demo Script` (an HTML page),
  `veo3-test-output.mp4`, a file named `nul`, `COMPLETED_TASKS.md` (a 46 KB plan), `PLAN.md`,
  `PLANSCOPE.MD`, and two prior audits under `artifacts/` (`audit-20260830/`,
  `audit-20260901-second.md`). Read the prior audits so you do not repeat their findings without adding
  new evidence; note where they were wrong or are now stale.

## 5. Questions the report must answer

Answer each with evidence, not opinion.

1. **Goal fit.** For each of the owner's five outcomes in section 1, what does the current system
   actually deliver, what does it only appear to deliver, and what does it not attempt?
2. **Research quality.** What data sources does a normal Friday run really consult for "top searches in
   DFW this week"? What would a minimal, reliable version look like (Google Trends, Search Console,
   GBP performance, Serper/SerpApi, keyword tools, or otherwise), and what would it cost?
3. **Memory.** Where does knowledge of past runs, past posts, past website changes, and their results
   live today? Which of it is read by the next run? Is any of it wrong? Propose a single durable model of
   "what we did, when, and how it performed" and say where it should live.
4. **Feedback.** What would it take to close the loop so that engagement, impressions, clicks, calls,
   and rankings from last week's output influence this week's choices? Which of those signals are
   obtainable now (Facebook Graph is live; GBP API is gated) and which need new access?
5. **Over-engineering.** List every module, crew, agent, gate, file format, and state store, and for
   each say: keep, simplify, merge, or delete, with a one-line reason. Be specific about the
   claims/evidence/observability layer, the six-agent executor crew, the dual approval systems, and the
   Markdown-regex handoffs.
6. **Reliability.** Enumerate every distinct way the Friday run has failed since June and every way it
   could still fail (dependency drift, lock files, provider outages, gate aborts, parser drift, scheduler
   and reboot behavior, alerting). For each, say whether current code prevents it, detects it, or
   neither.
7. **Verification.** What would it take to prove, before Friday, that the run will succeed: a
   pre-flight that exercises real imports, real credentials, real search, and the full parse-to-Supabase
   path without publishing? What does the existing `--dry-run` actually cover?
8. **Persistence.** Should Supabase hold research results, keyword data, and performance metrics, not
   just post rows and statuses? Propose the schema changes or a different store. Report schema drift
   between `schema.sql` and the live project.
9. **Platform choices.** Give a recommendation on each of: CrewAI versus a plain scripted pipeline or a
   different agent framework; DeepSeek plus Anthropic versus a single provider or local model; Windows
   Task Scheduler plus PM2 versus one scheduler; Markdown handoffs versus structured outputs; this
   Windows PC versus the owner's Proxmox/AIWA server. For each, state the trade-off and what you would
   choose given the five goals.
10. **Repo shape.** What in this repository is unrelated to the weekly run and should live elsewhere or
    be deleted?

## 6. Suggested read-only checks

Use what you need. All are non-mutating.

```powershell
# Scheduled tasks and last results
Get-ScheduledTask | Where-Object { $_.TaskName -like 'Grizzly SEO*' } |
  Get-ScheduledTaskInfo | Format-List TaskName,LastRunTime,LastTaskResult,NextRunTime
pm2 ls
```

```powershell
# Engine dry-run and test collection (no LLM, no Supabase writes; confirm in main.py first)
$env:PYTHONPATH='src'
.\.venv\Scripts\python.exe -m seo_agents.main research "audit probe" --dry-run
.\.venv\Scripts\python.exe -m pytest --collect-only -q
.\.venv\Scripts\python.exe -m pytest -q
node --test scripts/lib/*.test.mjs scripts/*.test.mjs
```

```bash
# History
git log --since=2026-06-01 --format='%ad %s' --date=short
ls outputs/archive
grep -nE '^=== .* launching' outputs/weekly-crew-2026-09-04.log
```

Supabase, read-only: row counts and latest rows of `seo_runs`, `weekly_posts`, `website_tasks`,
`run_logs`; the live column list of each table; whether RLS is enabled; one row per Friday since June.

## 7. Report format

Write the report to `docs/audits/2026-09-05-weekly-run-audit-report.md` (creating that file is the one
write you are allowed) and also return it in full in your final message. Structure:

1. **Executive summary** (under 300 words): the three biggest problems, the single simplest architecture
   that meets the five goals, and the one-week and one-month priorities.
2. **Goal-by-goal assessment** (section 5, question 1) as a table.
3. **Findings**, ranked by severity, each with: title, evidence (paths, lines, rows, log excerpts),
   impact on the five goals, and the fix or removal you recommend. Group under: Research, Memory and
   feedback, Engine and gates, Persistence, Reliability and scheduling, LLM and providers, Tests,
   Repo hygiene.
4. **Keep / simplify / merge / delete inventory** (question 5) as a table covering every in-scope
   module and state store.
5. **Failure catalog** (question 6) as a table: failure mode, date(s) observed, prevented / detected /
   neither, evidence.
6. **Recommended target design**: a diagram or ordered list of the weekly flow as it should be,
   naming components and data stores, with the provider and framework choices from question 9 and
   the reasoning behind each.
7. **Migration path**: ordered steps from today's system to the target, each marked as safe-to-do-now,
   needs-owner-decision, or needs-new-access, with rough effort.
8. **Open questions for the owner**: anything you could not decide without him.
9. **Unverified items**: everything you could not confirm, and what would confirm it.

Plain language. Short sentences. Cite evidence for every claim. Do not pad. Do not soften findings;
the owner asked for candor and is open to replacing anything.
