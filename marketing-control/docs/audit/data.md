# Workstream: data (status: ?)

I now have full evidence. Compiling the audit report.

## Findings

### F1. Systems of record actually in play (observed)

| Store | Location | Written by | Read by |
|---|---|---|---|
| Supabase `seo_runs`, `weekly_posts`, `website_tasks`, `run_logs` | `C:\Workspace\Active\SEO-Agents-App\supabase\schema.sql` | `scripts/supabase-sync.mjs`, `scripts/mav-bridge.mjs`, `scripts/gbp-worker.mjs`, `scripts/lib/website-task-runner.mjs` | mav-bridge, gbp-worker, seo-monitor, MCC (proxy + direct anon fallback), Python crew |
| Markdown schedules | `outputs/facebook_posting_schedule.md`, `outputs/gbp_posting_schedule.md`, `outputs/grizzly_execution_queue.md`, `outputs/final_report.md` | CrewAI crews (src/seo_agents), then **mutated** by `fb-photo-rewrite.mjs`, `gbp-photo-pick.mjs`, `fb-repost-week.mjs` | 6+ parsers (F4) |
| Local op-state JSON | `state/alerted.json`, `approval-notified.json`, `fault-acks.json`, `topic-history.json`, `photo-selection-manifest.json`; `outputs/pending_prompt.json` | mav-bridge, supabase-sync, run-weekly-seo.py | same |
| Local legacy status | `outputs/run_manifest.json` (stale: `run_id "2026-08-28T13:30:06Z_untitled"`, `topic: ""`), `workflow_status.json`, `run_health.json` | Python crew (`write_run_health`/`write_workflow_status` in `src/seo_agents/main.py`) | seo-monitor; **not** MCC (mav-bridge `/seo/status` returns `runHealth: null`, mav-bridge.mjs:~890) |
| MCC event log | `MCC/lib/state.mjs:92-97` `logSeoEvent` → local JSON, cap 100 | MCC server on every approve/run/retry/dismiss | MCC UI only — **not** in Supabase |
| Boost ledger | `outputs/fb-boost-ledger.json` | `fb-boost-ledger.mjs` | `fb-boost-api.mjs` (called daily by mav-bridge) |

MCC's `src/supabase.js` is an anon-key client used for `node_status`/`metrics` (homelab telemetry) **and** as a fallback SEO reader (`src/hooks/useMetrics.js:191-257`). All SEO mutations go MCC → `routes/seo.mjs` → mav-bridge HTTP → Supabase.

### F2. Sync direction (observed code paths)

1. `run-weekly-seo.py` (Fri 08:30 Task Scheduler) → `seo-agents research` → auto-runs GBP + FB schedule crews → `_run_supabase_sync()` (`src/seo_agents/main.py:731`, **no `--week-of`**).
2. `supabase-sync.mjs` parses `facebook_posting_schedule.md` + `gbp_posting_schedule.md` → inserts `weekly_posts` (`pending_approval`); parses `grizzly_execution_queue.md` + `final_report.md` via `lib/parse-website-tasks.mjs` → `website_tasks`; upserts `seo_runs` with `onConflict: 'week_of'` (lines ~283-288). One-way: file → DB.
3. Approval: MCC → mav-bridge `POST /seo/actions/approve` → `seo_runs.status='approved'` + cascade `weekly_posts`→`approved` (mav-bridge.mjs:994-1022), or `SEO_AUTO_APPROVE=1` in supabase-sync (`autoApproveRun`, lines ~198-213).
4. Execution: mav-bridge polls `seo_runs.status='approved'`; **before posting it mutates the markdown** (runs `gbp-photo-pick.mjs` then `fb-photo-rewrite.mjs`, mav-bridge.mjs:~265-286); `facebook-poster.mjs` then reads the **mutated file**, not the DB; results written back to `weekly_posts` (status, `platform_post_id`, `media_status`). gbp-worker claims rows via CAS `approved→posting` (gbp-worker.mjs:130-140).
5. Feedback loops: `weekly_posts`(scheduled/posted) → daily Graph reconcile → `posted`/`error` (mav-bridge.mjs:~430-480); `website_tasks(done)` → Python research context (`main.py:_fetch_completed_tasks`); Graph insights → `facebook_engagement_report.md` → next week's crew prompt.

**Net: content flows file→DB once; status flows DB-only; but final posted content comes from the file *after* post-sync mutation.**

### F3. Schema vs. reality drift (facts)

- `supabase/schema.sql` `weekly_posts.type` comment: `'video' | 'photo' | 'text'`. Live file uses `slideshow`, `carousel` (outputs/facebook_posting_schedule.md DAY 1/3/5). `media_status` comment lists 6 values; `lib/action-enrich.mjs` + migration 002 show a live-DB drift incident (column missing, PostgREST silently dropped writes).
- `day int — 1-7 for Facebook; null for GBP`: `parseGbpSchedule` populates day 1-7 for GBP (supabase-sync.mjs:139-160).
- Status vocabulary in code exceeds documented enums: `needs_verification` (gbp-worker), `scheduled_native` (gbp-poster/driver.mjs:610), `rejected`/`dismissed`/`cancelled` (lib/seo-run-status.mjs TERMINAL sets), `awaiting_prompt` (seo_runs, mav-bridge poll). None in schema.sql comments.
- **No RLS statements anywhere** in `schema.sql` or `supabase/migrations/` (only `001_unique_week_of.sql`, `002_add_media_status.sql`). Live RLS state unverifiable from repo.
- `seo_runs.week_of` = "next Monday from run time" (supabase-sync.mjs:getWeekOf), **not** from schedule content. Observed live mismatch: `gbp_posting_schedule.md` Start Date **2026-08-28** vs `facebook_posting_schedule.md` Week of **August 31** — both filed under one `week_of`. Past incident documented in `HANDOFF-2026-07-31-missed-run.md:169-171`.

### F4. Markdown parsed into records — parser inventory (format-is-a-boundary)

`facebook_posting_schedule.md` is parsed by **at least six independent implementations**:
1. `facebook-poster.mjs:469-512` `parseScheduleText` (canonical, extracts 18 fields incl. `post_goal`, `contact`, `on_screen_text`, `boost*`, `status`)
2. `supabase-sync.mjs:102-133` (hand-mirrored subset — **drops 8 fields**)
3. `facebook-insights-collector.mjs:94` (comment: "compatible with" = copy)
4. `fb-boost-api.mjs:113-119` `scheduleBlockForPick` (own block regex)
5. `fb-boost-ledger.mjs:55-80` `scheduleWeekStart` (own week-header regex) + `parseSummary` (parses the BOOST BUDGET SUMMARY markdown table; its own comment calls that section "the AUTHORITATIVE allocation" with "conditional … not machine-decidable" rows)
6. `fb-photo-pick.mjs`, `fb-photo-rewrite.mjs` (rewrites PHOTO_FILE), `slideshow-reel.mjs`, `fix-empty-caption-week.mjs`, `fb-fix-scheduled-photo.mjs`

`gbp_posting_schedule.md`: `parseGbpSchedule` (drops `CAPTION`, `TOPIC`, `TREND_TIE`), `gbp-photo-pick.mjs` (mutates), `sync-gbp-schedule.mjs` (md→xlsx for Playwright path).

`grizzly_execution_queue.md` → `lib/parse-website-tasks.mjs` (defensive heuristics like `isFormatInstructionTitle` show repeated format breakage).

Silent loss: `parseFacebookSchedule` filters `p.day > 0 && /^\d{4}-\d{2}-\d{2}$/` — a malformed DATE/DAY drops the post from Supabase with only "No Facebook posts found" logged.

`normalizePhotoFile` (lib/schedule-text.mjs): returns the **entire comma-separated list** only when the string ends in an image extension; otherwise regex-extracts the **first** filename. Live file has 3-4-photo comma lists → `weekly_posts.photo_file` (text, documented as single filename) now holds multi-path lists with inconsistent truncation behavior.

### F5. Re-sync state clobber (observed code)

`supabase-sync.mjs` non-`--tasks-only` path unconditionally upserts `{status:'pending_approval', execute_completed_at:now}` on `week_of` — re-running sync for a week already `done`/`posted` **resets the run row to pending_approval** and re-inserts pending posts alongside already-posted rows for the same days (delete only removes `status='pending_approval'`). FB re-execution is guarded by `platform_post_id` (mav-bridge.mjs:~295-300); GBP re-approval relies on the gbp-worker CAS.

### F6. Two dashboard truth-derivations

- mav-bridge `/seo/status` derives live status from posts (`lib/seo-run-status.mjs:liveRunStatus`), 28-day window.
- MCC fallback `fetchSeoFromSupabase` (useMetrics.js:191-257) buckets **raw `seo_runs.status`** (`done`→complete, `posting|posted`→partial…) — different algorithm, no window, no post-level derivation. Same dashboard, two answers depending on whether the proxy is up.

### F7. Money path lives only in markdown

Boost spend ($50/wk cap) is decided by the `BOOST BUDGET SUMMARY` markdown table + prose (outputs/facebook_posting_schedule.md bottom); `weekly_posts` has **no boost columns**; ledger eligibility obeys the summary (fb-boost-ledger.mjs:83-120). Supabase cannot answer "what did we plan to spend".

## Analysis

### Which record is authoritative when they disagree

- **Status / approval / execution state**: Supabase, definitively — mav-bridge and gbp-worker only poll Supabase; MCC mutations land in Supabase. Markdown `STATUS:` fields are never updated after sync (dead weight).
- **Published content**: the *mutated markdown* — facebook-poster reads the file at post time; `weekly_posts` hook/body/photo_file are a pre-mutation snapshot. When DB and file disagree about what was posted, the file (plus `run_logs` + `platform_post_id`) wins.
- **Boost decisions**: markdown BOOST BUDGET SUMMARY + `fb-boost-ledger.json`, not Supabase (no columns).
- **Week identity**: ambiguous today — `seo_runs.week_of` is the only unique key, but it's derived from run time, while mav-bridge's `/seo/posts/week` anchors to latest `created_at`, and each schedule file carries its own header. Highest-leverage disagreement source.
- **Human action audit**: MCC's local `seoTaskLog` — a single-node file, lost on MCC reinstall; Supabase `run_logs` records pipeline events, not approvals.

### Drift risks, ranked

1. **Parser fan-out (High)**: 6+ grammars for one file; format change breaks them independently and silently (drop-filter). The two "canonical" parsers already diverge in field set.
2. **Mutate-after-sync (High)**: DB snapshot ≠ posted content by design of the current ordering.
3. **week_of keying (High)**: run-time-derived key + two schedules with different anchors under one run; documented incident (7/28→8/04).
4. **Re-sync clobber (Medium)**: status reset to pending_approval on re-run; duplicate same-day rows.
5. **Status vocab drift (Medium)**: 11+ live statuses vs 7 documented; text columns mean nothing enforces it.
6. **Money in prose (Medium)**: "conditional" boost allocations not machine-decidable; $ decisions re-parsed weekly.
7. **Dual dashboard derivations (Medium)**: proxy-up vs proxy-down show different panel states.
8. **No RLS in schema (Medium, unverifiable live)**: anon key ships in MCC's Vite bundle and demonstrably reads SEO tables; if live RLS is disabled (schema never enables it), the anon key can also write/delete.
9. **Local op-state (Low)**: `approval-notified.json` loss → duplicate SMS; `alerted.json` loss → cold-start baseline handles it; `run_manifest.json` already stale.

### Minimum canonical schema

1. `seo_runs`: keep; add `schedule_week_start date` (parsed from schedule header, not run time) and `fb_schedule_source`/`gbp_schedule_source` hashes; make `week_of` derive from content, not clock. Fix status comment to the real vocabulary.
2. `weekly_posts`: add `post_goal`, `contact`, `on_screen_text` (or drop—poster-only), `caption`, `photos jsonb` (array, replacing comma-list `photo_file`), `boost_decision`, `boost_amount_cents int`, `boost_duration_days int`, `boost_targeting jsonb`, `boost_source` ('summary'|'per_post'). Add `unique(run_id, platform, day)` so re-sync upserts instead of duplicating. Correct the `day`/`type` comments.
3. `website_tasks`: fine as-is; add `details.source_line` for traceability (partially exists: `details.platform` contract).
4. Single parser: move `parseScheduleText` into `scripts/lib/schedule-text.mjs`, make supabase-sync/insights-collector/boost consume it; parse once at sync, store structured boost rows, delete the BOOST prose dependency.
5. Sync-once contract: after a run has any non-pending `weekly_posts`, refuse full re-sync (or upsert by natural key); `--tasks-only` already models this.
6. Decide one authority for the dashboard: ship `liveRunStatus` from mav-bridge and have MCC fallback call nothing (or replicate the same lib) — one bucketing implementation.