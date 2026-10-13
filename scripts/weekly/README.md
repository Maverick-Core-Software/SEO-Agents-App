# scripts/weekly — the weekly content pipeline

One attempt per week: collect signals, pick a topic, generate a plan with one model call,
validate it against the business facts, stage a revision, render the legacy Markdown, and
compare with the legacy chain. The contract every module follows is `DESIGN.md`; the plan of
record is `docs/rebuild/2026-09-06-weekly-pipeline-rebuild-plan.md`; business truth is
`knowledge/baselines/grizzly-business-facts.md`.

`shadow` and `offline` never write `weekly_posts` or `website_tasks`: their only writes are the
store, `--out`, and the SERP cache under `state/weekly/serp-cache`. `new` (the Phase C cutover
mode) is the one mode that does, through `lib/project.mjs`.

## Running

```
node scripts/weekly/run.mjs --mode offline [--now 2026-09-04T17:00:00Z] [--legacy-dir outputs]
node scripts/weekly/run.mjs --mode shadow  [--week-of 2026-09-07] [--budget-usd 5] [--notify]
node scripts/weekly/run.mjs --mode new     [--week-of 2026-09-07] --notify
```

| Option | Meaning | Default |
|---|---|---|
| `--mode shadow\|new\|offline` | required, see below | — |
| `--week-of YYYY-MM-DD` | plan this Monday week (`weekSpecForWeekOf`) | the week for `--now`/today in Chicago (`computeWeekSpec`) |
| `--now ISO` | fixed clock for every timestamp, window and stage stamp | wall clock |
| `--store <dir>` | file-store root | `state/weekly` (offline: `state/weekly/offline`) |
| `--out <dir>` | export/mirror directory | `outputs/shadow` (new: `outputs`; offline: `outputs/shadow/offline`) |
| `--budget-usd N` | spend ceiling for the attempt | `WEEKLY_BUDGET_USD`, then `policy.budget_usd` (5) |
| `--fixtures <dir>` | offline fixtures | `scripts/weekly/test/fixtures/e2e` |
| `--legacy-dir <dir>` | legacy outputs to compare against | `outputs` in shadow; new/offline compare only when given |
| `--photos-dir <dir>` | photo inventory | the GBP photo folders from `scripts/lib/gbp-paths.mjs` |
| `--notify` | shadow and new: Hermes/SMTP attempt alert via `lib/notify.mjs` (receipt on the attempt as `notify:<event>`) | off |

Exit codes: `0` when the attempt finished `succeeded` or `degraded`; `1` when it `failed`
(any stage threw, the plan failed validation twice, or the week's lease is held); `2` on a
usage error, or when `--mode new` finds no Supabase configuration (`StoreRefused`: `new`
never falls back to the file store). Every run prints `[weekly] ...` progress lines and ends with a one-screen
summary (attempt id, status, spend, per-source availability, topic, counts, validation, stage
statuses, paths written).

### `--mode offline`

The end-to-end path with no network: fixture collectors read `test/fixtures/e2e/observations/*.json`
(re-stamped with the attempt id), a fake LLM answers with `test/fixtures/e2e/model-plan.json`
(copying the selection winner into `topic`, as a real model is told to), facts come from
`test/fixtures/e2e/facts.md`, photos from `photos.json`. Always the file store. Deleting an
observations file from a copy of the fixtures dir makes that source unavailable, which is how
`test/e2e-offline.test.mjs` exercises the degraded path.

### `--mode shadow`

Live collectors (Search Console, Facebook, SerpApi, Supabase history), DeepSeek through
`lib/llm.mjs`, the real facts file and the real photo folders. Store selection:

- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` set (after `.env` is loaded) → `createSupabaseStore`
  (tables from `supabase/migrations/003_weekly_pipeline.sql`; revision + items through the
  `stage_plan_revision` RPC); the same client feeds the history collector.
- either missing → the file store at `--store`, with a warning on stderr.

Either way the attempt, revision, observations, meter and summary are mirrored into `--out`.
Required env for a useful shadow run: `DEEPSEEK_API_KEY` (refused before an attempt is
created without it), `WEEKLY_MODEL` (else `policy.models.generate`), `WEEKLY_BUDGET_USD`,
`SERPAPI_API_KEY`, `SEARCH_CONSOLE_TOKEN_FILE`, `FB_PAGE_ID` + `FB_PAGE_ACCESS_TOKEN`. A missing
credential never stops the run: that source is recorded as `unavailable` and the attempt ends
`degraded`.

### `--mode new` (Phase C: the live week)

The shadow chain, made live. Differences from `shadow`:

- **Store**: Supabase is required. Without `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` the run is
  refused with exit `2` before the model key is checked or the preflight probe spends anything;
  there is no file-store fallback (a file-store week would reach no publisher).
- **Exports** go to `outputs/` (the `--out` default): `gbp_posting_schedule.md`,
  `facebook_posting_schedule.md`, `website_queue.md` and the JSON snapshots, in the exact legacy
  layout, because `gbp-photo-pick`, `sync-gbp-schedule`, `facebook-poster`, `fb-boost-ledger` and
  `fb-photo-pick` read `outputs/*_posting_schedule.md`. `compare` is skipped unless `--legacy-dir`
  is given (there is no legacy run to compare against).
- **Projection** (`project` stage, inside `stage`): once the revision is stored and only when the
  plan validated, `projectPlan` (`lib/project.mjs`, `allowLive`) upserts `seo_runs(week_of)` to
  `pending_approval`, replaces that run's pending rows, inserts 7 GBP + 4 Facebook `weekly_posts`
  and one `website_tasks` row per website action, links each plan item (`projected_ref`) and stamps
  the revision `projected_at`. `SEO_AUTO_APPROVE=1` (exactly `1`) then runs the legacy
  `autoApproveRun` compare-and-set so posts and run become `approved`; anything else leaves the
  week at the MCC gate. The outcome is mirrored to `<out>/projection.json` and stated in the alert.
  A projection error fails the `project` stage and the attempt; the schedules exported just before
  stay on disk for inspection and nothing reaches `weekly_posts`.
- **Publishers untouched**: mav-bridge and gbp-worker consume `weekly_posts` rows exactly as the
  legacy `supabase-sync` wrote them (`gbp` rows carry `type: 'photo'`, `hashtags: null`;
  Facebook rows join hashtags with spaces; `video_prompt` is `null`).
- **Wrapper**: `SEO_PIPELINE=new` makes `scripts/run-weekly-seo.py` run this mode as the primary
  Friday run (no CrewAI crews, no `supabase-sync`), 30-minute cap (`SEO_PIPELINE_TIMEOUT_MIN`,
  else `SEO_SHADOW_TIMEOUT_MIN`), and lift the attempt into the top-level health fields the
  watchdog/monitor read plus the `shadow` block and `outputs/approval-notify.json`.

## What a run does, stage by stage

1. **attempt** — `createAttempt` takes the week's lease (30 min TTL). A held lease is refused
   with `LeaseHeld`, recorded as a failed attempt, and nothing else is written.
2. **collect** — all four collectors in parallel (`Promise.allSettled`); a thrown collector
   becomes one `unavailable` observation. Observations go to the store. History gains
   `winners` from the previous two weeks' stored revisions (validation.ok only) so
   `select.mjs` excludes last week's topic. SERP queries are `buildSerpQueries(policy)` rotated
   by ISO week in `serp.max_calls`-sized slices (`serp.rotate_weekly`), so every city/template
   pair is refreshed every `ceil(queries / max_calls)` weeks; cached hits are served regardless.
3. **select** — `rankCandidates`; `selection.degraded` when Search Console and SerpApi both
   produced nothing.
4. **generate** — photos are the inventory minus every `photo_file` in the published history;
   `buildGenerationInput` + `generatePlan` (one model call, at most one repair call). Code forces
   `notes.degraded = true` (with a reason) whenever the selection was degraded.
5. **validate** — `validatePlan`. On errors, one regeneration whose user message carries the
   errors and the rejected plan under `previous_attempt`, then validate again.
6. **stage** — render (`render.mjs`) and `stagePlan`; a plan that still fails validation is
   staged too (revision `validation.ok=false`, files exported) so it can be inspected, then the
   attempt fails with `ValidationFailed`. In `new` mode a validated plan is then projected
   (`project` stage, see above); a failed plan is never projected.
7. **compare** — `compareWithLegacy` when the legacy dir holds a `gbp_posting_schedule.md` or
   `facebook_posting_schedule.md`; otherwise the stage is `skipped`.
8. **finish** — `succeeded`, `degraded` (any source unavailable, degraded selection, or a
   degraded plan) or `failed`; the lease is released; the final records are mirrored.

## What gets written

File store (`--store`): `attempts/<id>.json`, `leases/<week_of>.json` (only while running),
`observations/<attempt_id>.jsonl`, `revisions/<revision_id>.json`, `items/<revision_id>.jsonl`.
Supabase store: `seo_attempts`, `seo_week_leases`, `research_observations`, `plan_revisions`,
`plan_items`.

Export/mirror dir (`--out`):

| File | Written by | Content |
|---|---|---|
| `gbp_posting_schedule.md` | stage | legacy GBP layout; parses with `parseGbpSchedule` (7 rows) |
| `facebook_posting_schedule.md` | stage | legacy Facebook layout with `## Week of YYYY-MM-DD`; parses with `parseFacebookSchedule` (4 rows) and the boost ledger |
| `website_queue.md` | stage | human list of website actions |
| `plan.json`, `selection.json` | stage | the validated plan and the full ranking |
| `attempt.json` | stage, then finish | the final attempt record (status, stages, spend) |
| `revision.json` | finish | the staged revision (topic, selection, validation) |
| `observations.jsonl` | finish | every observation of the run |
| `meter.json` | finish | spend, ceiling, every metered call |
| `summary.md` | stage, then finish | `renderPlanSummary` with the final attempt |
| `compare.md` | compare | shadow-vs-legacy report (when compare ran) |
| `projection.json` | project (new only) | `seo_runs` id, row counts, links, `auto_approve` and the `approved` verdict |

## Reading the summary

`summary.md` opens with the attempt (id, mode/status, runtime, git sha, models, spend,
versions) and a stage table (status, duration, error), then the topic with the winner's six
scores, runners-up and exclusions, the GBP and Facebook tables (day, date, service,
headline/hook, photo, boost), website actions, and the notes (degraded flag and reason, trend
signals, photo gaps). The console summary is the same in one screen. Things to check on a
shadow Friday: status `succeeded` (not `degraded` — look at the `collect` line for the source
that failed), validation `ok` with few warnings, the topic and its rationale, spend against the
budget, and `compare.md` for legacy facts violations and off-spec dates.

## Tests

```
node --test scripts/weekly/test/e2e-offline.test.mjs      # the integrator's e2e (no network)
node --test scripts/weekly/test/e2e-new-mode.test.mjs     # --mode new against a fake store + in-memory Supabase fake
node --test scripts/weekly/test/reconcile-health.test.mjs # reconcile-health.json on success and failure
node --test scripts/weekly/test/*.test.mjs                 # everything
npm run lint
uv run --with pytest pytest -q tests/test_cutover_new_mode.py   # the wrapper in SEO_PIPELINE=new
```

The e2e test replaces `globalThis.fetch` with a trap, runs only in temp dirs, and covers the
full chain, the lease refusal, the degraded path, the validation regeneration, the shadow
file-store fallback, prior-week winner exclusion, and the CLI exit codes. The new-mode e2e
asserts the publisher contract (7 + 4 `weekly_posts`, the `website_tasks` rows, `week_of`,
status per `SEO_AUTO_APPROVE`), parses the exported schedules with the legacy parsers
themselves, proves `new` never reaches the file store, and checks the `notify:<event>` receipt
in both shadow and new.
