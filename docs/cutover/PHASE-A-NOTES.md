# Phase A notes - repo convergence (2026-10-13)

Branch: `cutover/phase-a-v2-merge` (from `main` @ `6f748c0`). `main` was not touched.
Companion to `2026-10-13-SCOPING-AUDIT.md` section 10, Phase A.

## Commits on the branch

| sha | what |
|---|---|
| `eb024d6` | A1: merge `feat/seo-v2` (`4151431`) into main; 7 both-sides files reconciled (table below) |
| `1f39af0` | A2a: facts/docs/prompt phone `(469) 863-9804` -> `(469) 716-9870` + 9 `scripts/weekly/test` fixtures/tests |
| `9467dd8` | A2b: FB poster retired-number guard + selfcheck; GBP API poster policy gate (exit 5) + realpath entry guard |
| (this) | A3/A4: these notes |

## A1 - conflict resolution (file -> winner, why)

Seven files changed on both sides since the common base `2492234`. Git auto-merged six; one
(`gbp-paths.mjs`) needed a manual resolution. Both parents were diffed against the merged
tree to confirm every PR #7/#8 hunk survived.

| File | Winner | Decision |
|---|---|---|
| `scripts/lib/gbp-paths.mjs` `:195` (param list) | BOTH | main's `fallback = true` (PR #8: `sync-gbp-schedule.mjs:138` passes `fallback:false` so no service-blind photo is substituted at sync) + v2's `log = defaultSkipLog` (G4 policy skip logging). |
| `scripts/lib/gbp-paths.mjs` `:225` (tail of `resolveGbpImagePath`) | UNION | `if (fallback) { pickCuratedFallbackPhoto(..., log) }` then v2's `return fs.existsSync(imagePath) ? '' : imagePath`. Main returned the raw path when `fallback=false`; v2 never returns an on-disk file that failed the G4 policy. Net: with `fallback=false` a missing file still returns the planned name (PR #8 intent, 3 assertions at `gbp-paths.test.mjs:84-98` pass); an on-disk-but-policy-failing file now returns `''`, and `sync-gbp-schedule.mjs:140-143` then falls through to `localCache/<planned name>`, so the workbook keeps the planned PHOTO_FILE either way. v2 is a strict superset of safety here. |
| `scripts/lib/gbp-paths.test.mjs` | BOTH (auto) | main's `fallback:false` block `:84-98` + v2's policy / `pickCuratedFallbackPhoto` cases `:150-185`. |
| `scripts/lib/ffmpeg-bin.mjs` | IDENTICAL | The backslash-in-template fallback-path fix is byte-for-byte the same in `6e53c23` (main) and `4151431` (v2). `git diff main` and `git diff feat/seo-v2` on the merged file are both empty. Nothing to choose. |
| `scripts/slideshow-reel.mjs` | IDENTICAL | Same commit pair as `ffmpeg-bin.mjs`; both diffs empty. |
| `scripts/fb-boost-ledger.mjs` | BOTH (auto) | main's `scheduleAgeDays()` one clock (`FB_BOOST_TODAY` honoured for staleness; `:58-66`, `:195`, `:287`) + v2's wider `Week of <Month> <d>, <yyyy>` / bold `DATE:` regexes. Orthogonal hunks. |
| `scripts/seo-watchdog.mjs` | BOTH (auto) | Every `+` line of PR #7 (`git diff 2492234 main`) is present verbatim in the merged file: HUNG and NOTIFY MISS judged on any day (`:153-168`), schedule files newer than kickoff. v2 adds the shadow-run checks (T3). |
| `scripts/seo-watchdog.test.mjs` | BOTH (auto) | main's Saturday catch-up cases (`:51-67`) + v2's shadow cases. |

Nothing in `feat/seo-v2` was dropped. Nothing in PR #7/#8 was dropped.

## A2 - cherry-pick from `wip/pc-local-2026-10-13` (`fa4057d`)

Taken by path (`git checkout fa4057d -- <paths>`), because `fa4057d` is one mixed commit:

- `knowledge/baselines/grizzly-business-facts.md` (v2 `FACTS_PATH`), `knowledge/website-structure.md`
- `prompts/agents/gbp-local-rankings-agent.txt` - **phone line only**. WIP's copy rewrote all 120 lines
  with whitespace-only changes (`git diff -w` = the one phone line; no CRLF on either side), so the
  swap was applied to main's copy with `sed` instead of taking the file.
- `scripts/weekly/test/`: `core-1.facts.test.mjs`, `generate.test.mjs`, `stage.compare.test.mjs`,
  `validate.test.mjs`, `fixtures/e2e/facts.md`, `fixtures/render.plan.json`, `fixtures/stage.facts.md`,
  `fixtures/validate.facts.md`, `fixtures/validate.plan.json` - nine files, not the seven the task
  brief counted; all are the phone swap and the tests pin it.
- `scripts/facebook-poster.mjs`, `scripts/facebook-poster.selfcheck.mjs`, `scripts/gbp-api-poster.mjs`.

Main had not touched any of these paths after v2 (`git diff --stat feat/seo-v2 HEAD -- <paths>` empty),
so the by-path checkout reverts nothing.

Excluded on purpose: `scripts/lib/thumbtack/first-touch.mjs`, `scripts/lib/thumbtack/policy.mjs`
(owner's call on wording), `scripts/log_monitor_web.py`, `artifacts/phone-change-2026-09-30/*`.

Validator pin (facts validator accepts the new number):
`scripts/weekly/test/validate.test.mjs:43` (`FACTS.phones.published_main === '(469) 716-9870'`),
`:60` (`findPhoneNumbers`), `:128` (`textFactsErrors` clean with the new number), `:134` (the
allow-list error names exactly `(469) 896-3862, (469) 716-9870`); `core-1.facts.test.mjs:43`.
The retired number appears in the facts file only in the "external listings may still show"
note and is not in the allow-list (`:134`).

## A3 - remote branches (nothing deleted; for Carter)

`git fetch --prune` on 2026-10-13 removed four stale local remote-tracking refs that were already
gone on origin (GitHub deleted them at PR merge): `origin/barnscarter-ops/cockle`,
`origin/feat/seo-phase2-media`, `origin/feat/seo-plan-phase0-wave2`,
`origin/fix/ffmpeg-and-watchdog-followups`. Nothing was deleted on the remote.

Origin now has exactly: `main`, `feat/seo-v2`, `wip/pc-local-2026-10-13` (+ this branch once pushed).

| Remote branch | vs `origin/main` (behind/ahead) | Fully merged into `main` today? | Fully merged once this branch lands? |
|---|---|---|---|
| `origin/feat/seo-v2` | 5 / 13 | no | **yes** (`4151431` is an ancestor of `eb024d6`) - safe to delete then |
| `origin/wip/pc-local-2026-10-13` | 5 / 14 | no | no - cherry-picked by path, `fa4057d` stays unmerged; keep until Carter decides on the Thumbtack wording / `log_monitor_web.py` / `artifacts/` remainder, then delete |

The two doc lines naming `barnscarter-ops/grizzly-website` (`README.md:86`,
`knowledge/website-structure.md:4`) were left as-is per instruction.

## A4 - gates on the final branch state (`9467dd8` + this docs commit)

- `node --test "scripts/**/*.test.mjs"` (Node v24): **901 tests / 174 suites, 901 pass, 0 fail,
  0 skipped, 0 cancelled, duration_ms 62920.7 (64 s wall)**. Main alone was 800/159. The same
  numbers were obtained on the uncommitted merge state before `eb024d6` (55.1 s).
- `npm run lint` (`eslint scripts/ --quiet`): clean, exit 0 (run after the merge and again after A2b).
- `node scripts/facebook-poster.selfcheck.mjs`: all assertions passed.
- `node scripts/gbp-api-poster.mjs --selfcheck`: `ok gbp-api-poster selfcheck` (the realpath guard
  makes it reachable from the `C:\Workspace` junction too).
- Offline smoke: `node scripts/weekly/run.mjs --mode offline --store <scratch>/store --out <scratch>/out`
  -> `status succeeded`, 1 s, `collect search_console 10 ok; facebook 3 ok; serpapi 3 ok / 1
  unavailable; history 12 ok`, validate 0 errors, 10 files written under the scratch `out/`.
  Run with explicit `--store/--out` because the README defaults are `state/weekly/offline` and
  `outputs/shadow/offline`; with the overrides nothing under `outputs/` or `state/` was written
  by the run (`state/fb-pending-first-comments.json`, git-ignored, is rewritten every ~60 s by the
  resident fb-comment-agent and bumped again a minute after the run with nothing of ours
  running - not the pipeline). Offline mode makes no network calls; `--notify` is shadow-only.
- `git status` on the branch: clean apart from this `docs/cutover/` directory before it was committed.

## Things confirmed in v2 after the merge (not built; Phase C)

- `projectPlan` (`scripts/weekly/lib/project.mjs:111`) has **no callers** outside its tests; it
  throws unless `allowLive:true`, which only a future `--mode new` passes. `run.mjs:63`
  `MODES = ['shadow','offline']`.
- T1 notify receipt: wired on this branch. `run-weekly-seo.py:351` appends `--notify` for shadow;
  `run.mjs:856-862` calls `notifyAttempt`, which writes the `notify:<event>` receipt into the
  attempt's stages (`notify.mjs:104-118`); `run-weekly-seo.py:416-449` lifts it into the health
  block. The 2026-10-09 `notify.sent=false, status=missing` in `outputs/weekly-runner-health.json`
  came from main's pre-v2 wrapper (no `--notify`). First real verification: the next Friday shadow
  run on this code; delivery still depends on Hermes/SMTP being reachable from the runner.
- The FB retired-number guard is a hard throw in `buildCaption` (`facebook-poster.mjs`); a stale
  schedule fails the whole FB batch. Acceptable per the audit, but the alert path must surface it.
- Nothing else looked broken: lint clean, 901/901, offline chain end to end.

## Not done / for Carter

- Merge `cutover/phase-a-v2-merge` -> `main` (fast-forward is possible: the branch is `main` + 4).
- Delete `origin/feat/seo-v2` after that merge; decide the `wip/pc-local-2026-10-13` remainder.
- `.gitattributes` on this branch is PR #8's (`3a77dcd`: `scripts/weekly/test/fixtures/**` LF, legacy
  e2e fixtures `-text`); `feat/seo-v2` never touched the file, so there was nothing to reconcile and
  the LF-fixture rule applies to v2's fixtures as intended (901/901 on Windows confirms it).
