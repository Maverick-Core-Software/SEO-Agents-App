# Weekly pipeline rebuild plan

Date: 2026-09-06. Owner: Carter Barns. Basis: `docs/audits/2026-09-05-weekly-run-audit-report.md`
sections 6 and 7 and `docs/audits/2026-09-05-decisions.md`. Status: plan for review; no code
from this plan exists yet.

## 1. What the rebuild must deliver

The five outcomes from the audit brief, restated as acceptance criteria:

| Outcome | Acceptance |
|---|---|
| Know what DFW searches for this week | Every attempt stores the queries it ran, where, when, what came back, and the score each candidate topic received. A human can read why the topic was chosen. |
| Next week's posts and site updates | One validated plan revision per week: 7 GBP posts, 4 Facebook posts, and typed website actions, all with exact dates from WeekSpec and only approved business facts. |
| Publish through existing posters | Rows land in `weekly_posts` and `website_tasks` in the shape mav-bridge and gbp-worker already consume. No publisher code changes. |
| Remember and improve | Published content, its platform IDs, and 7-day and 28-day metrics are stored per item and read back into the next selection. Duplicate topics and repeated angles are detected against stored history, not against a Markdown file. |
| Run every Friday | One attempt record with stage timestamps, a lease that expires, a hard time budget, a cost budget, and alerts bound to the attempt. A run that cannot get fresh data still produces a marked "degraded" plan from evergreen content. |

## 2. Shape of the new pipeline

One Node package at `scripts/weekly/`, run by the same Windows Task Scheduler entry through
`scripts/run-weekly-seo.py` with a `--pipeline` switch (`legacy`, `shadow`, `new`). Node is chosen
because Supabase, Zod, the publishers, the collectors, and the monitor are already Node; the Python
side keeps only `website.py` (deterministic HTML edits) and `week_spec.py` semantics, which are
ported to JavaScript with the same tests.

Stages, each a module with one exported function and its own tests:

1. `attempt.mjs` creates an attempt row: week from WeekSpec, immutable attempt ID, git commit, prompt
   and schema versions, model IDs, mode. It takes a lease on the week that expires after the time
   budget. A second attempt while a lease is live is refused with the reason recorded.
2. `collect.mjs` gathers inputs and writes each as a research observation with source, geography,
   period, status, and raw payload reference:
   - business facts from `knowledge/baselines/grizzly-business-facts.md`;
   - published history from Supabase: last 8 weeks of `weekly_posts` and done `website_tasks`;
   - performance: Facebook insights by post ID (existing collector, cleaned), Search Console top
     queries and pages (the probe's helper), GBP performance when access exists;
   - search: 20 to 40 fixed DFW service queries through SerpApi with a 7-day cache, recording
     organic results, People Also Ask, and local pack presence;
   - Google Trends stays optional and supplementary, never the sole selector.
   Missing sources are recorded as unavailable, never as zero.
3. `select.mjs` ranks candidate topics with a documented score: service priority from the facts
   file, demand signal from search and Search Console, recency penalty from published history,
   seasonal weight, and last month's performance for that service. Candidates, scores, exclusions,
   and the winner are stored on the attempt.
4. `generate.mjs` makes one model call with a Zod schema for the whole plan: GBP items, Facebook
   items, website actions, notes. Code supplies dates, phone numbers, the domain, and the photo
   list; the model supplies copy and angles. One bounded repair call on invalid output, then fail.
   Every call records model, tokens, and cost against the attempt's budget.
5. `validate.mjs` runs deterministic checks: schema, dates equal WeekSpec, only approved phone
   numbers and domain, tenure wording, no prices unless on the approved list, photo references
   exist and are unused, no duplicate hooks or topics against stored history, boost table sums to
   the weekly budget, required slots present.
6. `stage.mjs` writes one plan revision and its items in a single transaction (Postgres function
   called through Supabase RPC), then renders the legacy Markdown files to `outputs/shadow/` (or
   `outputs/` after cutover) with the exact field layout today's parsers expect. In `new` mode it
   also projects items into `weekly_posts` and `website_tasks` with the existing statuses.
7. `reconcile.mjs` runs daily from the existing watchdog slot: copies platform IDs and terminal
   statuses from `weekly_posts` back to plan items, and collects 7-day and 28-day metrics into
   performance observations.
8. `notify.mjs` sends the same Hermes and SMTP alerts as today, keyed by attempt and event, with
   delivery receipts stored on the attempt.

## 3. Data model additions (migration 003, applied only after owner review)

| Table | Purpose |
|---|---|
| `seo_attempts` | One row per attempt: week_of, attempt_id, mode, git_sha, versions, stage timestamps, lease_until, budget_usd, spent_usd, status, error, notify receipts. |
| `research_observations` | attempt_id, source, query or scope, geography, period, status, metric, value, raw_ref, retrieved_at. |
| `plan_revisions` | attempt_id, week_of, revision number, topic, selection rationale, validation result, exported_at, projected_at. |
| `plan_items` | revision_id, platform, slot date, type, content fields, media refs, idempotency_key, projected weekly_posts or website_tasks id, publish status copied back. |
| `performance_observations` | plan_item_id or page URL, metric, window, source, value, availability, measured_at. |

The four existing tables are unchanged. Business facts stay in the versioned repo file.

## 4. Providers and budgets

- Generation: DeepSeek through its OpenAI-compatible API with an explicit model ID in `.env`
  (`WEEKLY_MODEL`), verified by a one-token probe in preflight. Anthropic stays only as an
  explicit, capped backup (`WEEKLY_FALLBACK_MODEL`), off by default.
- Search: SerpApi, cached 7 days, capped at 60 calls per attempt.
- Budget: `WEEKLY_BUDGET_USD` default 20 during shadow, 5 after cutover. An attempt refuses to
  start past the ceiling and records why.
- No CrewAI in the new path. The legacy chain keeps running untouched until cutover.

## 5. Shadow mode and cutover

Shadow mode runs the legacy chain first, then the new pipeline against the same week. The new
pipeline writes only to the new tables and `outputs/shadow/`. A comparison report lists, side by
side: topic chosen, post counts, validation failures, facts violations in the legacy output,
runtime, and cost. Carter reviews the shadow plan in the Marketing Control dashboard or the
Markdown export.

Cutover requires two consecutive shadow Fridays where the new pipeline: finished under 10 minutes,
produced a schema-valid revision, passed all facts checks, rendered Markdown that round-trips
through today's `supabase-sync` parsers with identical row counts, stayed under budget, and got
a content-quality approval from Carter. Cutover flips `--pipeline new`, projects items into the
existing tables, and disables the legacy research, execute, and schedule crews. The claims,
gates, and observability modules are removed one session later once nothing imports them.

## 6. Work breakdown

Each session is bounded for a DeepSeek executor with review before merge. Offline sessions make
no external calls and no database changes.

| Session | Scope | External effects | Effort |
|---|---|---|---|
| S1 | Package skeleton, Zod schemas for observations, plan, items; WeekSpec port with tests; legacy Markdown renderer plus a round-trip test through `supabase-sync` parsers; cost meter. | None | 1 day |
| S2 | Collectors: facts loader, Supabase history reader, SerpApi collector with cache and receipts, Search Console and Facebook readers with graceful "unavailable". | Read-only API calls under cap | 1 day |
| S3 | Selection policy, DeepSeek client with schema and repair, validators, fixture-driven tests, one capped live generation smoke. | One capped model call | 1 day |
| S4 | Migration 003 as SQL for review; `attempt`, `stage` with the RPC transaction; wrapper `--pipeline shadow`; shadow comparison report. | Migration applied only on owner go | 1 day |
| S5 | Reconcile, notify, attempt-based health file; monitor and watchdog read attempts. | None until enabled | 1 day |
| S6 | First shadow Friday, fix list, second shadow Friday. | Shadow writes only | 2 Fridays |
| S7 | Cutover: projection, legacy disable, retire gates layer, docs and runbook. | Production | 1 day |

Target dates: S1 to S4 before Friday 2026-09-18 so 09-18 is the first shadow run; 09-25 the
second; cutover session the week of 09-28 if both pass.

## 7. Not in scope

Facebook and GBP publisher internals, boosting, photo ingestion, the Marketing Control dashboard,
MCC, Thumbtack, and hosting changes. The GBP poster's session and photo problems remain a
separate track.

## 8. Decisions needed before S1 starts

1. Approve this shape, or name the change you want.
2. Confirm S1 may begin now (offline only).
3. The GitHub repository is public. Either make it private before S4, or keep operational
   documents out of it. This plan and the audit assume private.
