# scripts/weekly — design contract

This is the contract every module in this package follows. Implementers work in parallel on
disjoint files, so interfaces here are binding. If you must deviate, say so in your report and
keep the exported names identical.

Plan of record: `docs/rebuild/2026-09-06-weekly-pipeline-rebuild-plan.md`. Business truth:
`knowledge/baselines/grizzly-business-facts.md`. Owner goal added 2026-09-06: grow beyond
Rowlett across the DFW metroplex; geography is a first-class selection input.

## Ground rules

- Node 20+, ESM `.mjs`, no TypeScript. Dependencies already installed: `zod` 3.25,
  `@supabase/supabase-js` 2.x, `node:test`. Do not add dependencies or edit `package.json`.
- No network in unit tests. Every collector and the LLM client take an injectable `fetchImpl`.
- Every "now" is a parameter (`now: Date`) so tests are deterministic. Never call `Date.now()`
  without a `now` fallback parameter.
- Modules never write outside `outputs/shadow/`, `state/weekly/`, and the file store dir passed
  in. Nothing in this package ever writes to `weekly_posts` or `website_tasks` in S1–S3.
- Never print secrets. Never log token values or full API keys.
- Each module: pure functions plus at most one I/O entry point. Tests under
  `scripts/weekly/test/<module>.test.mjs`, fixtures under `scripts/weekly/test/fixtures/`.
- Errors: throw typed errors from `lib/errors.mjs` (`BudgetExceeded`, `GenerationInvalid`,
  `ValidationFailed`, `LeaseHeld`, `CollectorUnavailable`). Collectors catch their own errors
  and return an `unavailable`/`error` observation instead of throwing.
- Style: match `scripts/lib/*.mjs` (2-space, single quotes, semicolons). `npm run lint` must
  pass (`eslint scripts/ --quiet`).

## Layout and ownership

```
scripts/weekly/
  DESIGN.md                      (this file)
  README.md                      (integrator)
  run.mjs                        (integrator)  orchestrator CLI
  lib/
    env.mjs        paths.mjs     schemas.mjs   errors.mjs      (pre-written, do not change exports)
    week-spec.mjs  cost-meter.mjs  llm.mjs                     (owner: core-2)
    facts.mjs      store.mjs     attempt.mjs                   (owner: core-1)
    collectors/search-console.mjs  collectors/facebook.mjs     (owner: collect-1)
    collectors/serpapi.mjs         collectors/history.mjs      (owner: collect-2)
    select.mjs                                                 (owner: select)
    generate.mjs   prompts/plan.system.md                      (owner: generate)
    validate.mjs                                               (owner: validate)
    render.mjs                                                 (owner: render; may add `export` to two functions in scripts/supabase-sync.mjs)
    stage.mjs      compare.mjs                                 (owner: stage)
  test/*.test.mjs, test/fixtures/**                            (each owner writes their own)
config/weekly-policy.json                                      (pre-written; select/generate read it)
```

## Shared pre-written modules

`lib/paths.mjs` exports `PROJECT_ROOT`, `OUTPUTS_DIR`, `SHADOW_DIR` (`outputs/shadow`),
`STATE_DIR` (`state/weekly`), `POLICY_PATH`, `FACTS_PATH`, `SERP_CACHE_DIR`.
`lib/env.mjs` exports `loadEnv(projectRoot = PROJECT_ROOT)` (reads `.env` without overriding
existing env; returns `process.env`).
`lib/schemas.mjs` exports the Zod schemas below plus `parseOrIssues(schema, value)` which returns
`{ data, issues }` (issues is an array of `{ path, message }`, never throws).
`lib/errors.mjs` exports the error classes.

## Schemas (lib/schemas.mjs)

- `WeekSpecSchema`: `{ run_friday, week_of, gbp_start, computed_at, gbp_dates: {1..7: date}, fb_dates: {1,3,5,6: date} }`.
  Rule (America/Chicago): `run_friday` = most recent Friday on or before the anchor date;
  `week_of` = Monday on or after `run_friday`; `gbp_start` = `run_friday`; GBP day N =
  `gbp_start + (N-1)`; Facebook day 1 = `week_of` (Mon), 3 = Wed, 5 = Fri, 6 = Sat of that week.
  Matches `src/seo_agents/week_spec.py` and `fb_week_dates` in `src/seo_agents/crew.py`.
- `ObservationSchema`: `{ id, attempt_id, source: 'search_console'|'facebook'|'serpapi'|'history'|'facts'|'trends', scope: string, geography: string|null, period: {start,end}|null, status: 'ok'|'unavailable'|'error', metric: string|null, value: unknown, raw_ref: string|null, retrieved_at: iso, note: string|null }`.
- `CandidateSchema`: `{ service_key, service_label, city, query_family: string[], scores: { priority, demand, opportunity, recency, season, performance }, total, reasons: string[] }`.
- `SelectionSchema`: `{ winner: Candidate, ranked: Candidate[], excluded: [{ candidate: Candidate, reason }], rationale: string, degraded: boolean }`.
- `GbpItemSchema`: `{ day: 1..7, date, service, topic, trend_tie, headline (≤ 100 chars), body (≤ 1500), caption, photo_file: string|null, cta, hashtags: string[3..5], status: 'Needs approval' }`.
- `FbItemSchema`: `{ day: 1|3|5|6, date, type: 'slideshow'|'photo'|'carousel'|'text', service, post_goal: 'education'|'social_proof'|'engagement'|'entertainment', format: string, hook, body (30–80 words is the target; schema allows ≤ 900 chars), cta, hashtags: string[0..3], contact: string, photo_file: string|null, video_prompt: '' , on_screen_text: string, boost: { decision: 'YES'|'MAYBE'|'NO', daily_usd: number|null, days: number|null }, boost_targeting: string }`.
  Day 1 must be `slideshow`; days 3 and 5 `photo` or `carousel`; day 6 `photo` or `text`.
- `WebsiteActionSchema`: `{ type: 'website_blog_post'|'website_service_page_update'|'website_faq_update'|'website_hours_update'|'website_contact_form_update'|'website_gallery_update'|'website_layout_update'|'website_copy_update', title, target, priority: 'critical'|'high'|'medium'|'low', description, owner_gate: boolean, draft: { title, meta_description, html }|null, source_ids: string[] }`.
- `PlanSchema`: `{ attempt_id, week_of, topic: { service_key, service_label, city, query_family: string[] }, gbp: GbpItem[7], facebook: FbItem[4], website_actions: WebsiteAction[], notes: { trend_signals: string[], photo_gaps: string[], degraded: boolean, degraded_reason: string|null } }`.
- `AttemptSchema`: `{ id, week_of, mode: 'legacy'|'shadow'|'new'|'offline', git_sha, versions: { schema, prompt, policy }, models: { generate, fallback: string|null }, started_at, finished_at: iso|null, stages: Record<string, { started_at, finished_at: iso|null, status: 'running'|'ok'|'failed'|'skipped', error: string|null }>, lease_until: iso|null, budget_usd, spent_usd, status: 'running'|'succeeded'|'degraded'|'failed', error: string|null }`.
- `RevisionSchema`: `{ id, attempt_id, week_of, revision: number, topic, selection: Selection, validation: { ok, errors: string[], warnings: string[] }, exported_at: iso|null, projected_at: iso|null }`.
- `PlanItemSchema`: `{ id, revision_id, platform: 'gbp'|'facebook'|'website', slot_date: date|null, item_type: string, content: unknown, media_ref: string|null, idempotency_key, projected_ref: string|null, publish_status: string|null }`.

## Module contracts

### core-2: `lib/week-spec.mjs`, `lib/cost-meter.mjs`, `lib/llm.mjs`
- `computeWeekSpec({ anchor?: 'YYYY-MM-DD', now?: Date })` → WeekSpec. Port `src/seo_agents/week_spec.py` exactly; Chicago date from `now` via `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' })`. Tests must include the table cases from `tests/test_week_spec.py`.
- `createCostMeter({ ceilingUsd, pricing })` → `{ record({ kind, model, inputTokens, outputTokens, usd? }), spent(), entries(), assertUnder(nextUsd) }`; `assertUnder` throws `BudgetExceeded`. `pricing` is `policy.pricing` (usd per 1M tokens, `{ [model]: { input, output } }`); when `usd` is not passed, compute from pricing, else 0 with a warning entry.
- `createLlmClient({ apiKey, model, baseUrl = 'https://api.deepseek.com/v1', fetchImpl = fetch, meter })` → `{ chatJSON({ system, user, schema, maxTokens = 8000, temperature = 0.4, label }) }` returning `{ data, issues, usage: { input, output }, model, raw }`. Uses OpenAI-compatible `/chat/completions` with `response_format: { type: 'json_object' }`. Parses JSON (tolerate a leading code fence); validates with `parseOrIssues(schema, ...)`; records usage in the meter with `label`; never throws on validation failure (returns `issues`); throws on HTTP error with status in the message. 60 s timeout via `AbortController`.

### core-1: `lib/facts.mjs`, `lib/store.mjs`, `lib/attempt.mjs`
- `loadFacts(path = FACTS_PATH)` → `{ business_name, founded_year, tenure_phrase, address, service_area: string[], phones: { customer_text, published_main }, email, domain, hours: string[], platform_notes: string[], existing_pages: string[], existing_blog_slugs: string[], priority_services: string[], known_issues: string[], approved_prices: string[], raw }`. Parse by the `##` headings in the facts file; tolerate reordering; tests run against the real file and a fixture.
- `createFileStore(dir)` → Store. Store interface (all async):
  `createAttempt(attempt)`, `getAttempt(id)`, `updateAttempt(id, patch)`,
  `acquireLease({ week_of, attempt_id, ttlMs, now })` → `{ ok: true } | { ok: false, holder, lease_until }`,
  `releaseLease({ week_of, attempt_id })`, `putObservations(list)`, `putRevision(rev)`,
  `putItems(list)`, `listRevisions(week_of)`, `listPublishedHistory({ weeks })` (file store: reads
  `<dir>/history.json` if present else `[]`). Files: `<dir>/attempts/<id>.json`, `<dir>/leases/<week_of>.json`, `<dir>/observations/<attempt_id>.jsonl`, `<dir>/revisions/<id>.json`, `<dir>/items/<revision_id>.jsonl`. Atomic writes (tmp + rename).
- `createAttempt({ store, week_of, mode, now, gitSha, versions, models, budgetUsd, ttlMs })` → attempt (lease acquired or throws `LeaseHeld`). `stageStart(store, attempt, name, now)`, `stageEnd(store, attempt, name, { status, error }, now)`, `finishAttempt(store, attempt, { status, error, spentUsd }, now)`.

### collect-1: `lib/collectors/search-console.mjs`, `lib/collectors/facebook.mjs`
- `collectSearchConsole({ attemptId, days = [28, 90], now, tokenFile, fetchImpl, gbpFetchImpl })` → Observation[]. Reuse `scripts/lib/search-console.mjs` (`pickGrizzlyProperty`, `dateRange`, `formatQueryRows`) and `scripts/lib/gbp-api-auth.mjs` by setting `process.env.GBP_TOKEN_FILE` to the Search Console token before dynamic import (same trick as `scripts/search-console-probe.mjs`). Pull, for each window: by `query` (rowLimit 500), by `page` (500), by `['query','page']` (1000). Emit one observation per row with `metric: 'search_analytics'` and `value: { clicks, impressions, ctr, position, page? }`, `geography` = city name when the query contains one of `policy.cities[].name` (case-insensitive) else null. On any failure: one observation `status: 'unavailable'` with the probe's `explainSearchConsoleError` text in `note`.
- `collectFacebook({ attemptId, days = 28, now, client })` → Observation[] using `createFacebookClient` from `scripts/lib/facebook-insights.mjs` (accept an injected client for tests). One observation per post with `scope` = platform post id, `value: { impressions, reach, engaged, reactions, comments, shares, created_time, message_excerpt }`. Unavailable observation on failure.

### collect-2: `lib/collectors/serpapi.mjs`, `lib/collectors/history.mjs`
- `buildSerpQueries(policy)` → `[{ query, service_key, city, template }]` from `policy.services[].query_templates × policy.cities` filtered by `policy.serp.city_tiers`; deterministic order; capped to `policy.serp.max_queries`.
- `collectSerp({ attemptId, queries, cacheDir = SERP_CACHE_DIR, cacheDays, maxCalls, apiKey, location, now, fetchImpl, meter })` → Observation[]. SerpApi `engine=google`, `q`, `location`, `hl=en`, `gl=us`, `num=10`. Cache key = sha1(query+location); cached results younger than `cacheDays` are reused and marked `raw_ref: 'cache:<key>'`. Emit per query: `metric: 'serp'`, `value: { organic: [{ position, title, link, domain }], paa: string[], local_pack: [{ title, rating, reviews }], grizzly_organic_position: number|null, grizzly_in_local_pack: boolean }`. Stop at `maxCalls` live calls and emit `unavailable` for the remainder with `note: 'cap reached'`. Record each live call in the meter as `kind: 'serpapi'` with `usd: policy.pricing.serpapi_per_call`.
- `collectHistory({ attemptId, supabase, now, weeks = 8 })` → `{ observations, history }` where `history = { posts: [{ platform, post_date, service, hook, status, platform_post_id, photo_file, city? }], website_tasks: [{ title, type, status, updated_at }] }`. Read-only selects on `weekly_posts` (last `weeks` weeks by post_date) and `website_tasks` (last 12 weeks). Accept an injected `supabase` client whose `.from().select()...` chain resolves fixtures in tests. `city` is inferred from text against `policy.cities`.

### select: `lib/select.mjs`
- `buildCandidates(policy)` → Candidate[] skeletons for `services × cities` (city tiers from policy).
- `rankCandidates({ policy, observations, history, facts, weekSpec })` → Selection. Scores in [0,1]:
  `priority` from `policy.services[].priority` (1–5 → 0.2–1.0);
  `demand` from Search Console impressions for the candidate's query family (28d) normalized by the max across candidates, plus 0.2 if SerpApi shows People Also Ask for the family;
  `opportunity` = 1.0 when Search Console shows impressions with average position between 8 and 30 for the family (page 1 bottom to page 3), 0.6 when position > 30, 0.3 when < 8, 0 when no data; +0.2 when SerpApi local pack for the city lacks Grizzly (capped at 1);
  `recency` = 1 minus penalty: same service published in the last `policy.recency_weeks` → 0.5, same service and city → 0.1; never published → 1.0;
  `season` from `policy.services[].season[month]` (default 0.5);
  `performance` from Facebook/Search Console observations joined to history posts of the same service: normalized engagement, 0.5 when unknown.
  `total = Σ weights[k] × score[k]` with `policy.weights`. City weight multiplies `total` (`policy.cities[].weight`). Exclude candidates whose service was the winner in the last 2 weeks. `degraded = true` when both Search Console and SerpApi were unavailable (then `demand`/`opportunity` fall back to 0.5 and the rationale says so).
  Rationale is a short paragraph naming the winner, its top two score drivers, and the runner-up.

### generate: `lib/generate.mjs`, `lib/prompts/plan.system.md`
- `buildGenerationInput({ facts, selection, weekSpec, photos, history, policy })` → the user-message JSON (dates, fixed contact line, phone numbers, domain, tenure phrase, existing pages, available photo filenames, recent hooks to avoid, winner and two supporting candidates, boost budget).
- `generatePlan(input, { llm, meter, attemptId })` → Plan. One `chatJSON` with `PlanSchema`; if `issues` non-empty, one repair call whose user message includes the issues and the previous JSON; if still invalid throw `GenerationInvalid` with the issues. Code, not the model, sets `attempt_id`, `week_of`, each item's `date`, each Facebook `contact`, `video_prompt: ''`, and `status`.
- Prompt file: the editorial rules from `prompts/agents/gbp-poster-agent.txt` and the Facebook rules in `build_facebook_crew` in `src/seo_agents/crew.py` (hook first, 30–80 word body, engagement CTA, no phone in caption, format rotation, slideshow on day 1, boost rules with a single decided allocation summing to the budget), plus: never state a license number, never a price not in `approved_prices`, tenure phrase exactly as given, only the listed photo filenames or null, target the winner city by name in at least 3 GBP posts and 2 Facebook posts, mention supporting cities naturally, never invent reviews or numbers.

### validate: `lib/validate.mjs`
- `validatePlan(plan, { facts, weekSpec, photos, history, policy })` → `{ ok, errors: string[], warnings: string[] }`. Errors: schema; any `date` not equal to WeekSpec for that day; any phone number in any text other than `facts.phones.*`; any domain other than `facts.domain`; tenure claims that contradict `facts.founded_year` ("decade", "3+ years", wrong year); a dollar amount not in `facts.approved_prices` in GBP/Facebook copy; `photo_file` not in `photos`; Facebook boost YES rows whose `daily_usd × days` do not sum to `policy.boost_weekly_usd` exactly; more than 2 YES rows; a hook identical (normalized) to any hook in `history.posts`; a service repeated on more than 3 of the 7 GBP days; missing required day slots; a MAYBE/NO row carrying dollars. Warnings: headline over 58 chars, body under 30 words, no city mentioned in ≥ 3 GBP posts, hashtags missing a local tag.
- `findPhoneNumbers(text)` and `findDollarAmounts(text)` are exported for tests and for compare.

### render: `lib/render.mjs` (+ exports in `scripts/supabase-sync.mjs`)
- `renderGbpSchedule(plan, weekSpec)` → Markdown with the exact block layout of `outputs/gbp_posting_schedule.md`: header lines, then per day a `---` separator and `**DAY:** N`, `**DATE:** YYYY-MM-DD`, `**SERVICE:**`, `**TOPIC:**`, `**TREND_TIE:**`, `**HEADLINE:**`, `**BODY:**`, `**CAPTION:**`, `**PHOTO_FILE:**` (`NEEDS PHOTO` when null), `**CTA:**`, `**HASHTAGS:**`, `**STATUS:** Needs approval`; then `## Photo Gaps`, `## Trend Summary This Week`, `## Owner Notes`.
- `renderFacebookSchedule(plan, weekSpec)` → Markdown with `## Week of YYYY-MM-DD` (the Monday; `resolveWeekOf` in `scripts/supabase-sync.mjs` reads `week of YYYY-MM-DD`), then per post the `**DAY:**`/`**DATE:**`/`**TYPE:**`/`**SERVICE:**`/`**POST_GOAL:**`/`**FORMAT:**`/`**HOOK:**`/`**BODY:**`/`**CTA:**`/`**HASHTAGS:**`/`**CONTACT:**`/`**PHOTO_FILE:**`/`**VIDEO_PROMPT:**`/`**ON_SCREEN_TEXT:**`/`**BOOST:**`/`**BOOST_AMOUNT:**`/`**BOOST_DURATION:**`/`**BOOST_TARGETING:**`/`**STATUS:**` fields, separated by `---`; then `## CONTENT NOTES`; then `## BOOST BUDGET SUMMARY` with `### Weekly Budget: $50`, the table `| Post | Day | Service | Boost Decision | Daily Budget | Duration | Total |` (one row per post, Post cell `Day N`, decision exactly YES/MAYBE/NO, `—` for non-YES budget cells), then `- **Posts boosted:** N of 4`, `- **TOTAL SPEND:** $50`, `- **Priority post (boost first):** Day X - reason`, the two "Expected" lines, and the targeting line. Copy the current file's shape in `outputs/facebook_posting_schedule.md` and the rules in `build_facebook_crew`.
- `renderWebsiteQueue(plan)` → simple Markdown list (not parsed by anything).
- `renderPlanSummary(plan, selection, attempt)` → human summary Markdown.
- Compatibility: add `export` to `parseFacebookSchedule` and `parseGbpSchedule` in `scripts/supabase-sync.mjs` (change nothing else there). Tests must prove: GBP render → `parseGbpSchedule` gives 7 rows with the WeekSpec dates and `platform: 'gbp'`; FB render → `parseFacebookSchedule` gives 4 rows with days 1,3,5,6; `resolveWeekOf({ argv: [], fbText })` returns `week_of`; `parseScheduleText` from `scripts/facebook-poster.mjs` gives 4 posts with matching `type`, `hook`, and boost fields (check the import is side-effect safe first; if importing it would run network or main code, assert against a copied minimal parser and say so in the report); `normalizePhotoFile` from `scripts/lib/schedule-text.mjs` accepts every rendered PHOTO_FILE.

### stage: `lib/stage.mjs`, `lib/compare.mjs`
- `stagePlan({ store, attempt, plan, selection, validation, rendered, mode, now, outDir })` → Revision. Writes revision + items to the store; in `shadow`/`offline` mode writes `outDir/gbp_posting_schedule.md`, `facebook_posting_schedule.md`, `website_queue.md`, `plan.json`, `selection.json`, `attempt.json`, `summary.md`. Items: one per GBP day, per Facebook day, per website action; `idempotency_key = sha256(week_of|platform|slot_date|item_type|content.service)`; never writes `weekly_posts`/`website_tasks` unless `mode === 'new'` AND a `project` function is passed (S7).
- `compareWithLegacy({ shadowDir, outputsDir, facts, weekSpec, policy })` → Markdown: legacy files parsed with the same `supabase-sync` parsers; counts per platform; dates check; the legacy copy run through `validatePlan`'s text rules (phones, domain, tenure, prices) to list facts violations; topics side by side; attempt runtime and spend. Never modifies `outputsDir`.

### integrator: `run.mjs`, `README.md`, `test/e2e-offline.test.mjs`
- CLI: `node scripts/weekly/run.mjs --mode shadow|offline [--week-of YYYY-MM-DD] [--now ISO] [--store <dir>] [--out <dir>] [--budget-usd N]`. `offline` uses fixture collectors and a fake LLM (a canned valid plan) so the whole chain runs with no network; it is the e2e test. Order: attempt → collect (all collectors, in parallel with `Promise.allSettled`) → select → generate → validate (on failure: one regeneration with the errors appended, then fail the attempt) → stage → compare (shadow only, when legacy outputs exist) → finish. Every stage wrapped with `stageStart/stageEnd`; any throw → attempt `failed`, exit 1; collectors unavailable → continue with `degraded`. Print a one-screen summary and the paths written. Exit 0 on `succeeded`/`degraded`.

## Policy config (config/weekly-policy.json)

Pre-written. Fields: `services[]` (`key`, `label`, `priority` 1–5, `query_templates[]`, `season{}`), `cities[]` (`name`, `tier` 1–3, `weight`), `weights{}`, `recency_weeks`, `boost_weekly_usd`, `serp{}` (`location`, `max_queries`, `max_calls`, `cache_days`, `city_tiers`), `budget_usd`, `pricing{}` (approximate; per 1M tokens), `models{}`.

## Reporting

Every implementer and reviewer ends with a structured report: files created or changed, test
command and counts, lint result, and any deviation from this contract with the reason.
