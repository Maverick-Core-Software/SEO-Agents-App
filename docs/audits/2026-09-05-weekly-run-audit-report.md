# Weekly research-to-content audit — 2026-09-05

Repository: D:\Workspace\Active\SEO-Agents-App. Source snapshot: main at 3ee3f8b, with existing Thumbtack changes preserved. C:\Workspace is a junction to D:\Workspace; these are the same checkout.

This is an audit and proposed migration, not an implementation. Evidence includes source, retained logs, scheduled-task configuration, read-only Supabase queries, isolated parser probes, and 22 passing Node tests. Three DeepSeek Flash reviews ran through owned Orca terminals under the user's explicit delegation request; their conclusions were checked against primary evidence. No production workflow, publisher, collector, service change, database write, or paid search was run. Helper billing was not measured.

## 1. Executive summary

The system generates schedules and hands rows to existing publishers. It does not reliably identify the services most searched in DFW this week, and it does not learn from content performance.

The three biggest problems are:

1. **Inputs are unreliable.** The real CLI loses the wrapper's topic. Trends compares a fixed list using separately normalized Texas-wide batches. Agents receive a baseline falsely describing the website as WordPress/Contact Form 7.
2. **There is no closed feedback loop.** Research and outcomes are scattered across local files and database rows. Analytics collectors have no consumer in the next run. “Done” does not establish publication or business results.
3. **Complexity exceeds the checks it provides.** Several crews, competing state models, claim parsing, Markdown parsing, and local gates create failure points. September 4 required seven launches. The executor consumed almost 30 minutes while reporting no fully verified task.

The simplest suitable architecture is one scheduled script: collect source data and recent results, select a topic, generate validated JSON, persist one revision, hand it to the existing publishers, and reconcile outcomes. Keep Supabase. Keep human-readable reports as exports.

**First week:** fix topic/run identity, correct business facts, prevent partial or duplicate sync, isolate verification, and make alerts track the current attempt.

**First month:** replace the multi-crew chain, add durable research and performance history, and prove a replacement in shadow mode. Consider moving the orchestrator to AIWA only after validating its dependencies and publishing contracts.

## 2. Goal-by-goal assessment

| Owner goal | What is actually delivered | Appearance or gap | Assessment |
|---|---|---|---|
| Find this week's most-searched DFW services | Texas Trends sampling from ten candidates; search tools can be attached to research agents. | No defensible DFW volume ranking; batch scores are not directly comparable; topic disappears at CLI parsing. | **Not met.** Findings R1–R3. |
| Create next week's social and website content | GBP and Facebook schedules and website task descriptions are produced. | GBP intentionally uses Friday–Thursday; Facebook uses the following week. Website tasks can be blocked, misclassified, or suppressed. | **Partly met.** E2, P2; week_spec.py:8–11, 58–68. |
| Publish through existing posters | Supabase rows reach the operational publishing boundary. | Latest run is “done” while GBP rows include errors and future unpublished items. Website execution is not established by generated prose. | **Partly met.** P3. Publisher internals remain outside this audit. |
| Remember, measure, improve | Reads recent plan excerpts, completed website tasks, and topic history. | No automated content-performance feedback enters selection or drafting. Some recalled knowledge is false or malformed. | **Not met.** M1–M3. |
| Run every Friday and report inability | Tasks, wrapper health, monitor, watchdog, and two alert transports exist. | Multiple historical recoveries; alert timing and stale receipts leave gaps. Retained evidence cannot establish every scheduled firing. | **Not reliably met.** L1–L3 and section 5. |

## 3. Findings

Severity: **P1** directly undermines an owner goal or permits incorrect operational state; **P2** materially increases cost, fragility, or ambiguity; **P3** is cleanup. No production change is authorized by these recommendations.

### Research

**R1 — P1: The CLI discards the chosen topic.** The research subparser and legacy root parser both use the destination “topic.” Executing the actual parse_args function in isolation with arguments research, “audit probe,” and --dry-run returned command=research, topic=None, dry_run=True. The wrapper supplies a real topic, but main converts the missing result to an empty string. The latest manifest is untitled with topic, keywords, region, audience, and site_url blank. Agents have defaults for some fields, so blank manifest fields do not prove all effective context was empty. **Impact:** goals 1, 2, 4. **Recommendation:** remove the conflicting legacy argument, require a nonempty research topic, and persist effective inputs. Evidence: [main.py:574–705, 828–842][main]; [run-weekly-seo.py:281–282][runner]; outputs/run_manifest.json, run 2026-09-04T14:53:49Z_untitled; isolated argparse command output.

**R2 — P1: Topic selection is not a valid “top searches in DFW” measurement.** Ten fixed keywords are filtered against the last four selections, requested in batches of five for US-TX over seven days, then ranked using mean interest across batches. Those independent 0–100 scales cannot establish a shared ranking. Zero or unavailable interest is not absolute search volume. Failures fall back to ISO-week rotation. Selection is recorded before the run succeeds, and the seven-entry history repeats circuit-breaker work. **Impact:** goals 1 and 4. **Recommendation:** expand candidates from actual query data, use comparable geography/time windows and anchored comparisons, retain source observations, distinguish unavailable from zero, and record attempts separately from successful content decisions. Evidence: [runner:118–211][runner]; state/topic-history.json. Google explains [Trends normalization](https://support.google.com/trends/answer/4365533?hl=en) and why [separate UI requests are not directly comparable](https://developers.google.com/search/blog/2025/07/trends-api).

**R3 — P2: Search instructions disagree with the installed tool, and search success is not independently recorded.** build_tools constructs SerpApiGoogleSearchTool when SERPAPI_API_KEY is usable; construction exceptions silently leave scraping tools. Prompts instead name SerperDevTool. SERPAPI_API_KEY was present; SERPER_API_KEY was absent. Research includes fixed queries such as “panel upgrade Dallas 2025.” The GBP report says three searches succeeded and two failed, while the content report describes fallback estimates. These are model-authored claims, not transport receipts. Both schedule agents have tools=[] and reuse reports. **Impact:** goals 1 and 2. **Recommendation:** collect search results deterministically before drafting; save query, location, time, status, and results; expose one correct tool vocabulary. Normal runs can invoke search, but the precise successful searches on September 4 are **unverified**. Evidence: [crew.py:153–165, 507–520, 1080–1085, 1234–1249][crew]; prompts/agents; outputs/gbp_report.md:1–37; outputs/content_report.md:1–11.

### Memory and feedback

**M1 — P1: The default baseline gives the agents false website facts.** The sole active baseline, 764 bytes, describes WordPress and Contact Form 7. The website structure, manager prompt, and deterministic website module describe a static HTML site. Research concatenates every active baseline, so this contradiction is directly injected. Automatic compaction is already removed from the weekly chain; the remaining manual compactor can still archive detailed sources into a model summary. **Impact:** goals 2 and 4. **Recommendation:** replace this baseline with reviewed, versioned business facts and source references; never let a generated summary overwrite their authority. Evidence: knowledge/baselines/grizzly-current-status-2026-08-28.md:1–20; knowledge/website-structure.md; [crew.py:113–117, 384–397, 665–666][crew]; [main.py:378–454, 915–918][main]; [website.py:1–7][website]. The public site's current condition was not independently retested.

**M2 — P1: Recall records plans and labels more than verified work.** Previous-run context reads the first 40 lines of two archived manager plans, without requiring successful runs. Reports are archived before the final gate. Completed-task recall takes up to 50 “done” website tasks using updated_at and shortened descriptions. It does not read post outcomes or performance. Database task 9b0df13c-c382-43d8-9eb5-58e9171e61fb is marked done although its title contains format instructions. Current parsing rejects this kind of new title, but recall still admits the old row. **Impact:** goals 2 and 4. **Recommendation:** use verified action records with content IDs, completion evidence and explicit dates; quarantine historical garbage and validate recalled rows. Evidence: [main.py:214–249, 457–509, 940–945][main]; [parse-website-tasks.mjs:15–23][parser]; cited website_tasks row. memory/HANDOFF.md and JOURNAL.md are human handoffs; no engine reader was found.

**M3 — P1: The performance feedback loop is absent; the GBP collector is also incorrect.** Searches for both analytics output filenames found no research consumer. Facebook's retained report is dated July 16: 15 rows, zero recorded engagement, and unavailable impressions shown as dashes. This does not prove zero reach. The runbook's manual collection instruction does not connect the output to planning. The GBP collector selects the first account/location, prepares but never sends the required metrics/date parameters, calls the wrong hostname, and catches errors without failing the process. Its GET method is correct; changing it to POST would be another bug. **Impact:** goal 4. **Recommendation:** persist scheduled metric observations and explicitly load them into weekly selection; repair GBP access and request construction before relying on it. Evidence: scripts/facebook-insights-collector.mjs:200–218; outputs/facebook_engagement_report.md:1 onward; FRIDAY-RUNBOOK.md:110–113; scripts/gbp-analytics-collector.mjs:19–85. The [official performance endpoint](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries) uses businessprofileperformance.googleapis.com with dailyMetrics and dailyRange. PLANSCOPE.MD's quota-zero statement is historical; current GBP API access remains unverified.

### Engine and gates

**E1 — P1: Artifacts from the same attempt disagree about run identity.** build_run_id includes a trailing Z in its timestamp. RunContext.run_id slices started_at to 19 characters, dropping Z, and the supplied run_id is not retained as the authoritative value. The current manifest/action/task artifacts use 2026-09-04T14:53:49Z_untitled; evidence/claim artifacts use 2026-09-04T14:53:49_untitled. This is a formatting defect, not merely a rare clock-boundary race. Other CLI paths rebuild action queues with the default empty run ID. **Impact:** goals 3–5; lineage checks may reject related artifacts or lose their association. **Recommendation:** allocate one immutable attempt ID once and pass it through every artifact and database write. Evidence: [crew.py:70–80][crew]; [run_context.py:92–97, 209–252][context]; [main.py:954–977, 1099–1114][main]; [actions.py:1191–1228, 2160–2293][actions]; current JSON run_id fields.

**E2 — P1: The executor's “no eligible work” path can restore the blocked queue.** Filtering excludes “blocked” rather than positively selecting executable states and does not enforce current-run identity. When the filtered result is empty, build_executor_crew reads the raw queue again. A verifier also uses the original queue. The September 4 executor spent 1,789 seconds and reported no fully verified task; all four remained waiting_on_owner. That is roughly 77% of the four recorded phase durations. **Impact:** goals 2 and 5, with unnecessary model cost. **Recommendation:** choose eligible actions deterministically before any model call; an empty set must return immediately. Keep blocked owner decisions as records. Generate useful drafts once without invoking six execution/verification agents. Evidence: [crew.py:624–694, 706–850][crew]; [main.py:741–764][main]; outputs/run_health.json; outputs/weekly-crew-2026-09-04.log:1325 onward.

**E3 — P2: The claim machinery blocks unrelated production and duplicates operational state.** The five named contracts/evidence/extraction/finalization/observability modules total **2,625 lines**, not approximately 3,300; actions.py adds 2,452 and status.py 625. September 4 recorded three gate aborts with 2, 1, and 4 failures. Tenure contradictions appear in the same log, but not every failure was attributed to tenure. Any hard failure exits the whole research chain. The local queue, claim graph, task graph, approvals, workbook, workflow status, and Supabase are not one authoritative state machine. **Impact:** goals 2, 3, 5. **Recommendation:** retain source references and deterministic validation of dates, approved facts, media references, approval and idempotency. Remove generated claim IDs, prose extraction, and generic task graphs from the weekly critical path after replacement tests pass. Reject or repair the affected draft rather than blocking unrelated safe content. Evidence: module line-count command; [main.py:979–997][main]; weekly-crew-2026-09-04.log:326, 629, 673, 937; [actions.py:733–765, 1882–1997][actions].

Observability also rewrites its entire JSONL file to append an event, inviting quadratic work and lost concurrent updates. The file had 36,627 lines. emit_research_complete hardcodes dry_run=true even when called by live research. Retain append-only operational events with real attempt and mode fields. Evidence: [observability.py:70–113][observability]; main.py research event calls; line-count command.

### Persistence

**P1 — P1: Sync can leave a partial or duplicated week and still proceed toward approval.** Sync upserts a week into pending_approval, deletes only pending posts/tasks, then inserts replacements through separate requests. Delete errors are not checked; insert errors are logged without aborting. Counts describe parsed records rather than verified committed records. Already approved or posted rows survive a rerun, with no unique platform/slot constraint to prevent duplicates. Approval compare-and-set and rollback guards are useful, but cannot make the preceding multi-request write atomic. **Impact:** goals 3–5. **Recommendation:** transactionally stage and validate an immutable plan revision; enforce slot/idempotency uniqueness and terminal-state rules; approve only a complete committed revision. Never repair this by deleting published history. Evidence: [supabase-sync.mjs:307–365, 386–499][sync]; [schema.sql:7–107][schema]; live constraints.

**P2 — P1: Website task classification and deduplication suppress legitimate work.** classifyTask checks for Google/GBP terms before website/blog intent. An isolated call with a website blog title and “update Google search metadata” returned platform=gbp. The latest parsed blog was likewise classified as GBP. Separately, every weekly blog receives the fingerprint “weekly-blog”; a pending EV-charger blog causes a distinct surge-protection blog to count as a duplicate. **Impact:** goals 2 and 4. **Recommendation:** require explicit typed action/platform fields; deduplicate by subject, target URL and revision, with a deliberate backlog policy. Evidence: [parser:212–239, 460–478][parser]; sync:455–466; isolated classification/deduplication outputs; current queue parsing returned four tasks but sync retained only one new task.

**P3 — P1: Database status does not prove publication, and schema security is not reproducible.** Read-only inspection of project tbvsycqfpkkxitdbgfsj found 10 seo_runs, 115 weekly_posts, 115 website_tasks and 1,017 run_logs. All ten research_completed_at values are null. Research inputs/results and performance observations have no corresponding model in the four-table weekly schema.

Latest run b5ae26c1-c436-4cb5-b687-fe1efa002f2f, week September 7, is done. Its four Facebook rows are scheduled and have platform IDs. Of seven GBP rows, September 4 and 5 are errors without platform IDs; September 6–10 remain scheduled without IDs. September 5 run_logs rows 3dda95e5-6e7f-4b7d-9a7b-81bd75f63f3b and 8f62ab61-7db2-476f-938c-f4d1d3e3773d record CAPTCHA/error outcomes. These are boundary observations, not an audit of publisher internals. **Recommendation:** separate planning completion, accepted schedule, publication, failure and verification states; reconcile every item.

Live/schema comparison:

| Area | Observed comparison | Required action |
|---|---|---|
| Weekly tables | Four expected tables; observed column counts: seo_runs 10, weekly_posts 23, website_tasks 13, run_logs 7. Checked columns and baseline keys/indexes aligned. media_status is present. | Keep migrations; add repeatable schema verification. |
| Week uniqueness | seo_runs_week_of_unique exists, as required by migration 001. | Preserve; introduce separate attempt/revision records instead of overwriting history. |
| State/content constraints | No state-domain checks or unique post slot/content key. | Add explicit constraints through a reviewed migration. |
| RLS | Enabled on all four live tables; absent from schema.sql and migrations 001/002. | Version the actual intended security policy. |
| Anonymous reads | SELECT grants plus unconditional anon SELECT policies allow reading seo_runs, weekly_posts and website_tasks. run_logs has no equivalent anon read policy. | Decide whether this exposure is intended; prefer authenticated operational access. |
| Write privileges | anon has table INSERT grants, but RLS still governs row access. | Do not confuse a grant with an effective anonymous write permission. No anon write was attempted or established. |
| Other tables | Six additional public tables: metrics, agent_checks, node_status, agent_audits, agent_remediations, agent_dry_runs. | Establish ownership; their internals are outside this weekly audit. Do not delete them. |

Evidence: read-only information_schema, pg_constraint, pg_indexes, pg_class, pg_policies and has_table_privilege queries; cited rows; [schema.sql][schema] and both migrations. Actual anonymous HTTP exposure was not probed. Supabase documents the distinction between [grants and RLS policies](https://supabase.com/docs/guides/database/postgres/row-level-security).

### Reliability and scheduling

**L1 — P1: Friday monitoring has timing and delivery gaps.** Current tasks have the weekly run and monitor at Friday 08:30 Central and watchdog daily at 10:00. The watchdog's failed/hung/notification checks mostly apply only on Friday. A late run starting at 09:53 is too young for its 90-minute hung threshold at 10:00; a later hang or notification failure can miss that check. The fallback stale threshold is over eight days. notify.sent is accepted without matching the current attempt. The monitor marks an alert key before delivery, preventing a same-session retry if delivery fails. **Impact:** goal 5. **Recommendation:** evaluate the expected run every few minutes until terminal reconciliation, bind receipts to attempt IDs, retry delivery, and add a heartbeat observed from another machine. Evidence: live Get-ScheduledTask/Get-ScheduledTaskInfo output; [watchdog:106–179][watchdog]; [monitor:223–256, 500–529][monitor].

**L2 — P1: Preflight and locking do not cover the actual failure boundary.** Preflight imports pydantic_core and seo_agents, whose __init__ is effectively just a package marker; it does not construct the configured providers or exercise the actual chain. Its import path differs from the launched child. The child subprocess has no timeout; the scheduled task permits 16 hours. Windows locking uses an exclusive file that can survive a crash. The POSIX path replaces the locked file and closes its descriptor, so it does not provide a full-run lease suitable for Linux migration. Current try/finally cleanup improves ordinary exceptions but does not solve crashes. **Impact:** goal 5. **Recommendation:** test the actual runtime imports/providers, use attempt-scoped leases with liveness and expiry, and bound stages and total runtime. Evidence: [runner:215–305][runner]; src/seo_agents/__init__.py; [context:138–186, 209–252][context]; [main.py:864 onward][main]; September 4 stranded-lock log.

**L3 — P2: Health files mix attempts and “success” means different things.** run_health.json retains finalize=failed at 14:45:35Z alongside later successful phases ending 15:32:46Z. write_run_health merges phase fields without resetting or binding them to an attempt. weekly-runner-health.json correctly records the later wrapper exit 0 at 15:32:50Z. The monitor/watchdog use wrapper health and Supabase, not the mixed phase file, so this audit does **not** attribute their alerts to that stale finalize field. **Impact:** goals 4 and 5. **Recommendation:** derive phase, run, and publishing status from one durable attempt/event model. Evidence: [main.py:168–189][main]; both current health files; monitor/watchdog health readers.

Live task observations are snapshots, not service guarantees: Weekly Run, Monitor, Photo Sync and Watchdog last reported result 0. GBP worker was Running with last result 0x800710E0, consistent with a refused overlapping start under IgnoreNew; this alone does not prove a broken worker. PM2's recorded PID existed, but a read-only jlist attempt failed with EPERM on its RPC pipe. Its live process inventory remains unverified. No production process was restarted.

### LLM and providers

**V1 — P2: Routing is needlessly coupled to CrewAI internals, with several configuration paths.** Configured research/execution tiers use DeepSeek and Anthropic, while default source values still name OpenAI. Runtime failover changes the concrete LLM object's class. It retries availability/billing/authentication errors on a second provider; schema/context errors intentionally propagate. Constructor fallback now handles failure building a primary, but construction of a configured backup can still fail when a healthy primary was built. _call_local_llm uses a DeepSeek-compatible HTTP path and DEEPSEEK_API_KEY; “local/Qwen” naming is misleading. **Impact:** goals 2 and 5 and operating cost. **Recommendation:** one explicit model client with recorded model IDs, deadlines, bounded retry, token/cost ceilings and an optional capped backup. Do not use dynamic class mutation. Evidence: [crew.py:180–346][crew]; [main.py:256–376][main]; tests/test_llm_failover.py. Current paid-provider balance, availability and production spend were not tested.

### Tests

**T1 — P1: Passing unit tests do not establish the Friday path.** The repository contains 21 Python test modules and 33 Node test files, but many Python tests focus on claims/gates. The dry-run “no LLM” test sets up mocks and then executes pass; other assertions only check fake arguments. The no-op conftest fixture does not actually redirect outputs. No CI workflow was found and package.json has lint but no test script. The actual topic-parser defect survives these tests. **Recommendation:** exercise real CLI parsing and the complete transform-to-persistence contract in an isolated workspace, with network and publishers denied by default. Evidence: tests/conftest.py:12–34; tests/test_dry_run_offline.py:87–125; package.json; file inventory; R1 probe.

Executed: node --test scripts/lib/schedule-text.test.mjs scripts/lib/parse-website-tasks.test.mjs — **22 passed**. Current imports of pydantic_core and anthropic passed; installed versions include CrewAI/tools 1.15.1, anthropic 0.73.0 and pytrends 4.9.2. The full Python suite and the brief's “372 collected” claim were not revalidated because collection/imports and tests were not proven free of shared-output writes.

### Repo hygiene

**H1 — P2/P3: Operational history is scattered, and unrelated assets obscure the weekly system.** outputs, state and logs are ignored. There were 57 archive directories, not the brief's 74. Seven .env.bak-* files, AIWA Demo Script, veo3-test-output.mp4, nul, large historical plan files, and an empty malformed CWorkspaceActiveSEO-Agents-Apptestsfixturesresearchartifacts directory exist at the root. Secret values were not opened or copied into this report. **Recommendation:** establish retention/backups for run artifacts, consolidate operational documentation, and propose cleanup separately; preserve publisher state and evidence until replacement/retention decisions are approved. Evidence: .gitignore; root/output directory inventory; archive and line counts. Backup coverage was not established.

Prior audits were reviewed. The September 1 pydantic_core import failure is not reproducible in the narrow current import check. Anthropic is now explicitly included and locked. WeekSpec and explicit sync week handling already address the old local-clock derivation. Title/parser guards and tests also exist now. These improvements do not prove the full suite or all earlier fixes. The brief's counts were corrected where measured: 2,625 core gate-layer lines, 57 archive directories, and **109 fix-prefixed commits out of 294 since June 1**, rather than roughly 60. Evidence: artifacts/audit-20260901-second.md; artifacts/audit-20260830 summaries; pyproject.toml:7–17; uv.lock; [sync:51–78][sync]; git log command output.

## 4. Keep / simplify / merge / delete inventory

“Delete” means retire after a verified replacement and any required consumer migration. It is not permission to remove files now. Paths below are relative to the repository stated above.

| Component, agent, format or store | Decision | Reason / replacement |
|---|---|---|
| scripts/run-weekly-seo.py | Simplify | Preserve scheduling entry contract; deterministic collection and bounded stage calls. R1/R2/L2. |
| scripts/setup-scheduled-tasks.ps1 | Simplify | One weekly orchestrator schedule plus independent monitoring; retain existing publishers' service schedules until a separate decision. L1. |
| src/seo_agents/main.py | Simplify/merge | Replace overlapping command chains with explicit stage transitions. R1/E1/L3. |
| crew.py: research crew | Merge | One sourced brief and one structured content generation step. R3/E3. |
| Content/Keyword agent; content-keyword-agent.txt | Merge | Keep business/editorial instructions; remove autonomous tool selection and claim boilerplate. |
| Website SEO agent; website-seo-agent.txt | Simplify | Deterministic site checks plus targeted copy proposals. M1. |
| GBP/Local Rankings agent; gbp-local-rankings-agent.txt | Merge | Use recorded local search/profile observations. R3/M3. |
| Reviews/Reputation agent; reviews-reputation-agent.txt | Simplify | Run when fresh review data or an actionable event exists. No evidence justifies mandatory weekly model work. |
| Local Presence Manager; local-presence-manager-agent.txt | Merge | Selection policy and one review step replace report synthesis loops. |
| Delegation/Scheduling agent; delegation-scheduling-agent.txt | Delete from weekly path | Build typed actions and dates in code. E2/E3. |
| Executor crew | Delete from weekly path | Six-agent execution/verification is not earning its runtime. E2. |
| Content Production Executor; content-production-executor.txt | Merge | Generate a draft once for an eligible action. |
| Local Presence Assets Executor; local-presence-assets-executor.txt | Simplify | Deterministic asset availability/reservation checks. |
| Technical SEO/CRO Executor; technical-seo-cro-executor.txt | Simplify | Run concrete checks; create explicit proposed changes. |
| Website Manager Executor; website-manager-agent.txt | Keep/simplify | Preserve website constraints and generate typed edits only when needed. |
| Executor Manager Verifier and Scheduling Verifier | Delete/merge | Deterministic completion checks; review only an actual proposed change. |
| GBP schedule crew/agent; gbp-poster-agent.txt | Merge | Generate GBP items in the shared structured content step; retain platform rules. |
| Facebook schedule crew/agent; inline prompt | Merge | Same generator, explicit Facebook slots and fields. |
| Standalone website crew/Website Manager | Simplify | On-demand typed edit generation; preserve approved-change boundary. |
| build_seo_crew compatibility entry | Delete after caller migration | Avoid a second apparent orchestration API. crew.py:1486 onward. |
| crew.py LLM routing; main.py _call_local_llm/generate_blog_post | Merge | One client, configuration and cost policy. V1. |
| website.py | Keep/simplify | Deterministic preview/validation/application is useful; keep deployment approval. website.py:59–478. |
| run_context.py | Simplify | One attempt ID, scoped artifact directory, robust lease. E1/L2. |
| week_spec.py; outputs/week_spec.json | Keep | Explicit Chicago dates already fix a class of errors; decide cadence separately. |
| contracts.py | Simplify | Small versioned schemas for sources, plans and actions. |
| evidence.py; evidence_package.json | Simplify | Save collector receipts and source IDs without generated claim syntax. |
| claims_extract.py; claim_graph.json; extraction_diagnostics.json | Delete after migration | Eliminate parsing of model-written provenance blocks. |
| finalize.py | Simplify | Validate schema, approved facts, dates, media references, eligibility and complete revision. |
| actions.py; task_graph.json | Split/simplify | Retain approval/idempotency/adapter boundaries; remove generic graph and duplicated schedule parsers. |
| Local action_queue/action_approvals/action run and reservation files | Merge into Supabase | One authoritative action/approval model; retain old evidence through migration. |
| Excel GBP workbook synchronization | Retire as an authority | Not called by the current automatic execute-to-Supabase chain; confirm any manual/external consumers before removal. actions.py:1821–1997; main.py:722–812. |
| status.py; workflow_status.json | Merge | Derive status from durable attempts and item outcomes. |
| observability.py; observability.jsonl | Simplify | Append-only structured events with rotation and actual IDs/modes. E3. |
| __init__.py; src/seo_agents/agents.md | Keep | Package/instructions; not runtime readiness checks. |
| prompts/agents/*.txt as a format | Keep/simplify | Version editorial rules; remove false tool names and duplicated machine schemas. |
| knowledge/baselines current/archive; compact_baselines | Replace authority; retire compaction | Reviewed facts with provenance; archive old baselines as historical evidence. M1. |
| knowledge/website-structure.md | Keep | Reconcile against the actual website repository and maintain one authoritative description. |
| load_previous_run_context; _fetch_completed_tasks; completed-work-brief.md | Replace | Query successful, verified actions and recent content/metrics. M2. |
| state/topic-history.json; _this-week-topic.txt | Merge | Topic choices belong to attempts and successful plan revisions. |
| scripts/facebook-insights-collector.mjs | Keep/fix/integrate | Collect available metrics periodically and feed selection. M3. |
| scripts/gbp-analytics-collector.mjs | Fix, then enable when access works | Correct location, endpoint, metrics and dates; surface unavailable access. M3. |
| facebook_engagement_report.md; gbp-analytics-latest.json | Export only | Durable observations belong in the database; reports remain useful to people. |
| scripts/supabase-sync.mjs | Replace internals incrementally | Transactional structured ingestion preserving publisher row contracts. P1. |
| scripts/lib/parse-website-tasks.mjs and schedule-text helpers | Keep as migration adapters, then retire prose parsing | Preserve regression fixtures while introducing typed data. P2/T1. |
| Supabase seo_runs, weekly_posts, website_tasks, run_logs | Keep/extend | Already used operationally; add attempt, research, performance and revision history. P3. |
| schema.sql; migrations 001/002 | Keep/extend | Reproducible schema, RLS and transactional constraints. |
| Six additional public database tables | Keep pending ownership review | Outside the weekly model; no evidence supports deleting shared infrastructure. |
| Markdown research/manager/queue/schedule/final/delegation reports | Export only | Stop treating prose as an API or proof of completion. |
| *_completion.json; website_edit.json; website_preview | Keep typed outputs; consolidate history | Associate with one action/revision; retire obsolete parallel formats after consumer checks. |
| outputs/run_manifest.json; run_meta.json; outputs/archive | Keep, make immutable and durable | One artifact manifest per attempt; retention and verified backup. |
| run_health.json; weekly-runner-health.json | Merge | One attempt-based status; local files can be generated compatibility views. |
| seo-monitor.mjs; seo-watchdog.mjs; alert paths | Merge responsibilities, retain external observer | Durable checks, retryable delivery, no duplicate local authority. L1–L3. |
| approval-notify.json; notification/alert dedupe state | Merge | Receipts keyed by attempt and event, not global “sent.” |
| outputs weekly/monitor/watchdog logs; logs/ | Keep with retention | Operational evidence, not an unbounded second database. |
| memory/HANDOFF.md; JOURNAL.md; FRIDAY-RUNBOOK.md; NEXT-SESSION.md | Keep/consolidate human documentation | Accurate operating instructions; do not confuse these with consumed agent memory. |
| .crewai cache and local transient PID/lock files | Ephemeral only | Never the durable record of business work. |
| Photo manifests/reservations and other publisher-owned state under state/outputs | Keep existing contracts | Publishing/media internals were excluded; no blanket state cleanup. |
| Python and relevant Node tests | Keep/rebalance | Favor real orchestration/data-boundary coverage over generic gate machinery. |
| pyproject.toml; uv.lock; requirements.txt | Keep one authoritative lock; simplify duplicate requirements | uv.lock includes Anthropic, pytrends and serpapi; requirements.txt omits the latter two. |
| package.json and Node lockfile | Keep | Existing SDK/schema tooling; add an explicit verification command in later implementation. |
| marketing-control, maverick-core-commercial, Thumbtack, demo/video/probe assets | Separate after ownership review | Unrelated to this weekly core; do not infer unused or delete active products. |
| Root plans, prior audits, .env backups, malformed directory, nul | Archive/consolidate or delete by explicit cleanup decision | Preserve useful history and secrets handling; H1 is not a deletion order. |

Crew/agent mapping evidence: crew.py:353–622, 651–859, 1004–1130, 1152–1392, 1394–1486; the eleven prompt files. Store decisions follow their readers/writers in main.py, actions.py, status.py and supabase-sync.mjs, plus the inventories reported in section 3.

## 5. Failure catalog and Friday history

A wrapper exit 0 proves that invocation completed its chain, not that every post was published. Counts below are **minimum retained attempts**. A single upserted weekly database row cannot establish exact retry counts, automatic firing, or absence of manual intervention.

| Intended Friday | Fired / attempts evidenced | Outcome and cause | Evidence |
|---|---|---|---|
| June 5 | Unverified | No retained runner log or corresponding current DB row establishes outcome. | Retained output inventory; complete seo_runs query. |
| June 12 | Unverified | Same evidence gap. | Same; wrapper introduction is June 16 commit f203212. |
| June 19 | Runner unverified | Monitor activity exists; that does not prove a research launch. | outputs/monitor-2026-06-19.jsonl; no matching runner/DB record. |
| June 26 | At least 1 launch | Exit 1; underlying cause unverified. | weekly-runner-2026-06-26.log:1–4. |
| July 3 | At least 1 | Wrapper exit 0; week July 6 marked done, 14 posts. | weekly-runner-2026-07-03.log:1–4; seo_runs 03df29fa-957a-48fc-8ead-e06bed923b22. |
| July 10 | At least 1 | Exit 0; week July 13 done, 13 posts. | Matching runner log; seo_runs 2c5fc296-b102-49a4-8903-4f91dc7b7859. |
| July 17 | At least 1 | Exit 0; week July 20 done, but done_at is null. | Matching runner log; seo_runs a842e8d7-34c4-4321-b3bd-0e4a7a54125d. |
| July 24 | At least 1 Friday attempt; 2 retained July 28 launches | Friday exit 1; exact root cause unverified. Recovery produced a misdated August 4 row later rejected. | July 24 runner log; July 28 crew log:2, 402; seo_runs abcd2982-5cb6-4fda-9db0-169ed67ec631 and its recorded rejection reason. |
| July 31 | At least 2 | First attempt exhausted Anthropic credit; later exit 0, week August 3 done. | July 31 runner log:35–46; seo_runs bc9f900f-46cb-41f4-9a3e-3414911111ed. |
| August 7 | At least 1; later resync indicated | Exit 0. execute_completed_at is later than done_at, showing mutable history rather than an immutable attempt record. | Runner log; seo_runs 85b2df56-77bd-4ddc-bf8a-167df5b132dd. |
| August 14 | At least 1; total unverified | Wrapper log has only a start; DB nevertheless reaches done. Stored week is Friday August 14, unlike the current Monday policy. | weekly-runner-2026-08-14.log:1; seo_runs 3710a43e-2735-448a-8d15-bf1753781a4b. |
| August 21 | At least 1 | Exit 0; week August 24 done. | Matching runner log; seo_runs b60a0305-6688-4723-8491-fac37d387f95. |
| August 28 | At least 1 | Exit 0; approval occurred Saturday August 29 at 16:08Z. | Runner log; seo_runs 50ce16b6-c866-4464-9539-b33897ff6714. |
| September 4 | **7** | Missing Anthropic SDK, stranded lock, three gate aborts and an intervening SyntaxError; seventh chain exits 0. Publishing errors remain. | weekly-crew-2026-09-04.log:31, 34, 326, 629, 644, 937; runner log final exit; latest DB run in P3. |

September 4 launch headers were 13:30:05, 14:08:33, 14:14:03, 14:24:34, 14:36:32, 14:37:26 and 14:53:47 UTC. This establishes seven launches; it does not establish seven automatic scheduled retries.

| Distinct failure mode | Observed date or present risk | Current prevention / detection | Evidence |
|---|---|---|---|
| Unknown runner exception | June 26; July 24 | Nonzero exit detected; retained root-cause detail insufficient. | Runner logs above. |
| Provider credits/auth/outage | July 31 credit failure; continuing risk | Partial prevention through fallback; no verified current balance/readiness. | July 31 log; crew.py:205–338. |
| Missing provider SDK / dependency incompatibility | September 4; older audit import failure | Anthropic pin/extra and constructor fallback improved; narrow imports pass. Full runtime preflight insufficient. | pyproject.toml, uv.lock; L2/V1/T1. |
| Syntax error introduced in working checkout | September 4 | Process detects after launch; no CI/readiness gate proved before schedule. | Crew log:644. |
| Stranded Windows lock / invalid Linux lease | September 4; present portability risk | Ordinary exception cleanup partially helps; crash/lifetime prevention inadequate. | run_context.py:138–186; crew log:34. |
| Claim/schema/prose gate abort | September 4 | Detected by aborting all downstream work; availability not preserved. | Gate log lines and E3. |
| Topic lost / non-comparable research | Current reproducible defects | Neither adequately prevented nor detected before “success.” | R1/R2. |
| Wrong week/date; Markdown field drift | July 28; recurring fixes July–September | WeekSpec and parser guards improve coverage; prose handoff remains fragile. | Rejected row; sync:51–190; parser tests. |
| Garbage tasks, wrong platform, overly broad dedupe | August 14 garbage row; current probes | New garbage-title guard exists; old-row recall/classification/dedupe still fail. | M2/P2. |
| Partial sync, duplicate rerun, terminal status reset | Current code risk; not reproduced against live DB | Some approval guards; no atomic complete revision or post-slot uniqueness. | P1 and schema inspection. |
| Stale/mixed health and run IDs | Current files and code | Local checks can themselves reject mismatched IDs; no coherent attempt authority. | E1/L3. |
| Missed schedule, reboot, late hang | Historical corrective commits; current timing gap | StartWhenAvailable, WakeToRun, IgnoreNew and retries help; local monitoring cannot observe its own host being off. | Live task configuration; commits 4960f9d/d969d5e; L1. |
| Alert lost or old receipt accepted | August 28 delayed approval; current code risk | Hermes/SMTP alternatives exist; dedupe-before-send and stale receipt matching remain. | monitor:223–256; watchdog:145–164; approval dates. |
| Publisher rejects staged item | September 4–5 | Errors recorded; run-level done can conceal incomplete publication. | P3 rows. Repairing publisher internals requires a separate scope. |
| No analytics or unverifiable metric treated as zero | Retained July report; current wiring | Neither performance feedback nor unavailable-data handling is complete. | M3. |

Of 294 commits since June 1, 109 subjects begin with fix: or fix(. Repeated categories are parser/format/date repair; dependency/provider failures; approval/idempotency/state handling; reboot/monitor/alert repair; and media/GBP boundary failures. Examples include 1e77d23 (next-line parsing), 1c85d1b (separators), bc27224 (Facebook dates), a748618 (missing parser export), e509eca (week/watchdog handling), and d969d5e (Friday recovery). Media/boosting/dashboard changes also create churn but their internals were excluded.

## 6. Recommended target design

Use this weekly flow:

1. **Create an attempt.** A scheduler requests one business week. A database lease prevents overlap; an immutable attempt ID records code, prompt, configuration and model versions.
2. **Collect evidence in code.** Load approved business facts, recent published content, verified website changes and available performance windows. Collect fresh query/trend/search observations with location, time, status and source IDs.
3. **Select a topic.** Rank relevant opportunities using a documented policy: service relevance, measurable demand, recent coverage, business priority and past results. Store the candidates, scores, exclusions and reason. Missing fresh data produces a clearly marked degraded plan, not an invented trend claim.
4. **Generate one structured plan.** One model call, or a small bounded set, returns typed GBP/Facebook items and proposed website work. Code supplies dates and known business facts. Allow one bounded repair for invalid output.
5. **Validate and stage a complete revision.** Check approved factual claims, links, dates, expected slots, media references, duplicate content and eligibility. Commit the entire revision transactionally. Export Markdown for review and legacy consumers.
6. **Release according to the owner's policy.** Hand compatible rows to existing publishers. Website deployment and exceptional actions retain their required approval boundaries. Never restart the entire chain to repair one failed item.
7. **Reconcile and learn.** Record accepted platform IDs, actual publication/verification results and failures. Collect later metrics by content ID or landing URL. Notify on degraded/failed operation and required decisions; retain delivery receipts.

### Platform and provider choices

| Choice | Recommendation and trade-off |
|---|---|
| CrewAI / another framework / scripts | **Plain scripted pipeline**, using existing Node Supabase/Zod tooling for orchestration and persistence. Retain useful Python website helpers initially. This fixed workflow does not require autonomous agent delegation. Avoid replacing CrewAI with another comparable framework. |
| Model provider | **DeepSeek Flash for routine drafting**, pinned to a tested supported ID. Keep Anthropic only as an explicit, budget-capped backup if the owner values outage resilience enough to fund it. Remove per-agent routing and dynamic class mutation. The current deepseek-chat alias is not evidence that this migration is already configured. |
| Local model | Optional shadow evaluator later. Do not make Friday depend on it until quality, uptime, throughput and context limits are measured. Existing hardware is not proof of a reliable inference service. |
| Scheduler | One authority for the weekly orchestrator; do not simultaneously schedule that same job in Task Scheduler, PM2 and a server timer. Existing long-running publishing services have separate needs and stay intact during migration. |
| Windows / AIWA | Stabilize on the current machine first. Prefer an always-on AIWA service for the orchestrator after proving network, credentials, storage and adapter compatibility. Browser/media/publishing dependencies may remain on Windows. Any server change requires the AIWA runbook and gated Orca path. |
| Markdown / structured output | **JSON validated against a versioned schema** as the machine contract. Markdown remains an export. Existing consumers require a compatibility renderer or coordinated migration; switching model output alone would break regex readers. CrewAI itself already supports [structured task output](https://docs.crewai.com/en/concepts/tasks), so the first improvement need not wait for framework removal. |
| Database | **Keep Supabase/Postgres.** It already connects the publishers and is adequate for this workload. Changing databases would add risk without solving bad inputs or missing measurements. |

### Sources, measurable outcomes and cost

Use existing SerpAPI for localized result inspection and candidate discovery. Search results reveal competition and content opportunities; they do not establish absolute local search volume. Start with 20–40 deliberate queries per week, caching unchanged lookups. Current public pricing offers 250 searches/month free and a $25/month starter tier with 1,000 searches; actual account plan and shared quota were not checked. [SerpAPI pricing](https://serpapi.com/pricing).

Use Search Console, once authorized, for the website's query/page impressions, clicks, CTR and position. This measures the site's observed search visibility, not all DFW demand, and the API does not guarantee every row. Use comparable Trends observations as a supplementary signal. Google's official Trends API remains limited alpha access; do not design as if this account already has it. [Search Analytics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [Trends API access](https://developers.google.com/search/apis/trends).

Facebook metrics are the first practical integration because its publishing connection already exists, but each insight's permissions and availability need a scoped verification. Preserve “unavailable,” “not yet mature,” and zero separately. GBP performance requires confirmed access, location selection and corrected requests; quota zero indicates access has not been granted. Profile-level call clicks/impressions are not booked jobs or per-post causal ROI. [GBP access/limits](https://developers.google.com/my-business/content/limits).

Collect 7-day and 28-day windows. Join post IDs and landing URLs to outcomes; separate paid from organic. Add tagged landing links and CRM/booked-job attribution only with owner agreement and access. Evaluate changes over several weeks; sparse local-business data cannot justify strong causal claims from one post.

As a transparent draft-generation example, DeepSeek Flash peak uncached rates of $0.44/million input tokens and $1.32/million output tokens make 200,000 input plus 20,000 output tokens approximately **$0.1144 per weekly run**, before retries or fallback. This is a proposed workload calculation, not the current app's bill. Search, database, media, advertising and backup-provider charges are separate. Set a small explicit weekly model ceiling instead of assuming this estimate. [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).

### Durable data model

Extend the existing database without changing publisher contracts abruptly:

| Entity | Minimum durable information |
|---|---|
| Business facts | Approved value, source, effective date, reviewer/version; never silently replaced by a summary. |
| Run attempts and plan revisions | Week, immutable attempt/revision ID, selected topic, effective inputs, code/prompt/model versions, stage states, timestamps, cost and errors. |
| Research observations | Candidate/query, source, geography, period, metric/unit, availability, retrieval time and raw artifact reference. |
| Content and action history | Stable item ID, subject/target URL, content revision, source IDs, approval, eligibility, idempotency key and superseded item. |
| Publishing/verification receipts | Item ID, platform ID, scheduled/accepted/published/verified times, result and error category. |
| Performance observations | Item/page/profile scope, metric, measurement window, source, paid/organic designation and availability. |
| Events and alerts | Attempt/item ID, stage, timestamp, severity, delivery attempt and acknowledged delivery. |

Keep raw research/artifact snapshots in backed-up object storage keyed by attempt with a retention policy. Store searchable facts and metrics in Postgres. Use one weekly parent with multiple attempts/revisions, not one mutable row pretending to be complete history.

### What would constitute pre-Friday verification

The existing research --dry-run skips kickoff, Supabase and adapter calls, but writes shared manifests/empty evidence and creates run context/artifacts. It was therefore not executed in this read-only audit. It does not test credentials, real search, schedule generation, database ingestion, retry safety or publishing readiness. Evidence: main.py:847–908.

Build an isolated acceptance path that:

- Parses the real scheduled CLI arguments and constructs the actual configured runtime/providers.
- Runs a deterministic full plan-to-row fixture through the same validators and transaction interface; blocks network and publishers by default.
- Tests timeout, malformed output, unavailable metrics, partial insert, duplicate retry, concurrent lease, late completion and failed alert delivery.
- Applies migrations and exercises the real ingestion transaction in a separate test database, with publishing disabled by credentials and topology.
- Separately performs approved, budgeted provider/search credential probes and scoped read-only publishing-readiness checks.

A paid probe or staging write needs separate authorization under this audit's rules. Even a passing rehearsal proves the tested configuration and contracts, not that an external provider cannot fail next Friday. Bounded recovery and useful alerts remain necessary.

## 7. Migration path

Effort estimates are engineering time, not promises. “Safe-to-do-now” means a suitable first isolated development step after implementation is authorized; **none of these changes was made during this audit**.

| Order | Step | Authorization category | Rough effort |
|---|---|---|---|
| 1 | Fix topic parsing and canonical run IDs; add isolated real-CLI regressions. | Safe-to-do-now | 0.5–1 day |
| 2 | Reconcile approved business facts; remove false baseline authority; choose GBP/Facebook cadence. | Needs-owner-decision | 0.5 day plus review |
| 3 | Correct task typing/deduplication; skip blocked executor work before calling models. | Safe-to-do-now | 0.5–1 day |
| 4 | Introduce validated structured schedules with a legacy Markdown renderer; preserve downstream contracts. | Safe-to-do-now | 1–2 days |
| 5 | Add transaction/revision/idempotency design, migration tests and an RLS policy proposal. Apply only after review. | Needs-owner-decision | 1–2 days |
| 6 | Replace mixed health/alert state with attempt-based monitoring and retryable delivery; review automatic recovery permissions. | Needs-owner-decision | 1–2 days |
| 7 | Wire Facebook observations; obtain Search Console and, if available, GBP performance access. | Needs-new-access | 1–3 days plus access delay |
| 8 | Run the smaller pipeline in shadow mode for two weekly cycles; compare content quality, costs and validated rows. | Needs-owner-decision | 2–4 days spread across cycles |
| 9 | Cut over one weekly orchestrator and retire duplicate gates/queues only after proving publisher compatibility and rollback. | Needs-owner-decision | 1–2 days |
| 10 | Evaluate AIWA hosting, move only verified components, and implement backups/retention and repository cleanup. | Needs-owner-decision | 1–3 days, dependency-dependent |

The largest reliability gains are in steps 1–6. A server move or model swap should not precede them.

## 8. Open questions for the owner

1. Should both channels cover Monday–Sunday, or should GBP retain its intentional Friday–Thursday cadence?
2. Which content may publish automatically? Which website changes, factual claims and unusual actions must remain approval-gated?
3. What approved years-in-business, service-area, licensing and offer facts should replace the contradictory baseline?
4. When current research is unavailable, should the system use preapproved evergreen content or stop and alert?
5. What weekly research/model budget and fallback-provider ceiling are acceptable?
6. Are Search Console, site analytics, GBP performance and booked-job attribution available, and which outcome matters most?
7. Are anonymous operational database reads intentional? Who owns the six additional tables and legacy workbook consumers?
8. What retention, backup and always-on hosting policy should govern run evidence?

These are decisions for implementation, not blockers to the completed audit.

## 9. Unverified items

- Exact automatic firing, intervention and retry counts for all Fridays; June 5–19 outcomes and June 26/July 24 root causes. Scheduler event history, backups or fuller logs would resolve them.
- Full current Python suite and exact collected count; only the isolated checks described above were run.
- Actual September 4 search transport receipts, paid-provider balances, production token costs and current per-source API permissions.
- Facebook metric completeness, current GBP API approval/quota, Search Console/site-analytics access and CRM attribution.
- Successful publication or business effect of every “done” run. This needs platform receipts and later metrics, not run status alone.
- PM2's live process list because its read-only query failed on the RPC pipe.
- Current public-site defects, browser/session lifetime, media availability and publisher internals excluded by the brief.
- Anonymous REST exposure beyond confirmed database grants/policies; external workbook users; ownership of unrelated tables/projects; artifact backup/restore coverage.
- Readiness of AIWA for this workflow. No remote service changes or deployment validation occurred.

The report is the only repository file created. Existing dirty Thumbtack files were preserved. No fix, commit, branch, production restart, publication, alert delivery or database mutation was performed.

[main]: D:/Workspace/Active/SEO-Agents-App/src/seo_agents/main.py
[runner]: D:/Workspace/Active/SEO-Agents-App/scripts/run-weekly-seo.py
[crew]: D:/Workspace/Active/SEO-Agents-App/src/seo_agents/crew.py
[context]: D:/Workspace/Active/SEO-Agents-App/src/seo_agents/run_context.py
[actions]: D:/Workspace/Active/SEO-Agents-App/src/seo_agents/actions.py
[observability]: D:/Workspace/Active/SEO-Agents-App/src/seo_agents/observability.py
[website]: D:/Workspace/Active/SEO-Agents-App/src/seo_agents/website.py
[parser]: D:/Workspace/Active/SEO-Agents-App/scripts/lib/parse-website-tasks.mjs
[sync]: D:/Workspace/Active/SEO-Agents-App/scripts/supabase-sync.mjs
[schema]: D:/Workspace/Active/SEO-Agents-App/supabase/schema.sql
[monitor]: D:/Workspace/Active/SEO-Agents-App/scripts/seo-monitor.mjs
[watchdog]: D:/Workspace/Active/SEO-Agents-App/scripts/seo-watchdog.mjs
