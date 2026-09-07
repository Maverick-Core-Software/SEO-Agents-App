# FB boost tick redesign (2026-09-07)

Spec for three coordinated changes to the Facebook boost automation. Carter's
requests, in his numbering:

1. Fix the Monday race: the bridge tick fired at 9:00:02 Central, two seconds
   after the Day 1 post's scheduled 9:00:00 publish, so Graph had not listed the
   post yet and nothing was boosted.
2. Text notifications when the booster runs and again with the exit state.
   Once the week's boosts are applied, no more texts until the next post week.
3. Once the week's boosts are applied, do not run the booster again until the
   next post week.
4. Fix the misleading bridge log line (`failed: Command failed` on a run whose
   own JSON said `ok: true`).
5. If Day 1 is applied and the schedule allocates another boost later in the
   week (Day 3 on Wednesday), the booster must run on that day.

Interpretation used here: "the boost for the week" means every YES row in the
schedule's BOOST BUDGET SUMMARY. Texts and runs happen only on days that have
an unapplied allocation whose post date is today or past. After the last
allocation is published, the ledger reports nothing eligible and the bridge
stops launching the booster until the next schedule lands.

## Background (read before editing)

- `scripts/mav-bridge.mjs` polls every 30 s. Inside the poll, a "daily tick"
  block runs once per Central calendar day after 9 AM, keyed on
  `lastDailyGbpDate`. The boost call currently lives inside that block (around
  lines 671-701) and so fires at 9:00:xx.
- `scripts/fb-boost-api.mjs run` is the booster. Pipeline: ledger `eligible`
  (offline) -> config gates -> resolve live Graph post -> verify -> ledger
  `reserve` -> Marketing API create -> ledger `publish` -> Hermes text.
- `scripts/fb-boost-ledger.mjs eligible` already returns the next unapplied
  allocation whose post date is today or past, and `eligible: false` with a
  reason otherwise. It is the gate for both "should anything happen today" and
  "is the week done".
- `scripts/lib/hermes-alert.mjs` exports `sendHermesAlert(message)`. That is the
  only notification path. It shells out to the Hermes CLI; it can throw.
- Exit code bug: `fb-boost-api.mjs` ends with `process.exit(code)`. On Node
  24.19 / Windows this intermittently aborts with
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`
  after the JSON has already been printed. The bridge then sees a non-zero exit
  and logs `failed: Command failed` even though the payload says `ok: true`.
- Tests: `node --test scripts/lib/*.test.mjs` (node:test) and
  `node scripts/fb-boost-ledger.test.mjs` (plain script). Lint: `npm run lint`.

## Hard rules for every worker

- Work in the current worktree on `main`. Do not commit, stash, branch, or push.
- Do not edit `.env`. Do not edit files owned by another worker (ownership below).
- Never run `node scripts/fb-boost-api.mjs run` without `--dry-run`. Never run
  `fb-boost-ledger.mjs reserve|publish|fail|notify` against the real ledger.
  Tests must point `FB_SCHEDULE_PATH` and `FB_BOOST_LEDGER_PATH` at temp files.
- Do not restart PM2 processes. Do not start long-lived processes.
- Match each file's existing line endings when editing (`git ls-files --eol`:
  `scripts/lib/gbp-runner.mjs` and its test are CRLF, `scripts/mav-bridge.mjs`
  is mixed, everything else here is LF). New files use LF. Do not re-save a
  whole file with different endings. Match the existing code style (2-space,
  single quotes, ESM, no new dependencies).
- Run the tests and lint named in your task before reporting done.

## Worker 1: bridge tick (owns `scripts/mav-bridge.mjs`, `scripts/lib/fb-boost-tick.mjs`, `scripts/lib/fb-boost-tick.test.mjs`, `scripts/lib/gbp-runner.mjs`, `scripts/lib/gbp-runner.test.mjs`, `.env.example`)

### 1a. `centralDateHour` gains minutes

In `scripts/lib/gbp-runner.mjs`, extend `centralDateHour(nowUtc)` so the
returned object also carries `cstMinute` (integer 0-59, Central time). Keep
`todayDate` and `cstHour` exactly as they are. Add one assertion to
`scripts/lib/gbp-runner.test.mjs` covering `cstMinute`.

### 1b. New pure module `scripts/lib/fb-boost-tick.mjs`

Export these functions. No I/O in this module.

```js
// "09:30" -> { hour: 9, minute: 30 }. Invalid or empty input returns the parsed
// fallback (default '09:30'). Accepts H:MM and HH:MM, 24h.
export function parseAfterTime(text, fallback = '09:30')

// True when the Central clock is at or past `after` and no tick has run today.
export function shouldRunFbBoostTick({ todayDate, cstHour, cstMinute, lastTickDate, after })

// Whether the bridge should launch `fb-boost-api.mjs run` given the parsed
// output of `fb-boost-ledger.mjs eligible`.
//   eligible === true                          -> { launch: true,  reason: 'eligible' }
//   reason matches /human review required/i   -> { launch: true,  reason }   (the booster texts Carter once per week for these)
//   anything else                              -> { launch: false, reason: json?.reason || 'not eligible' }
export function decideBoostLaunch(eligibleJson)

// Parse the booster's stdout. It pretty-prints one JSON object. Try
// JSON.parse on the trimmed payload; if that fails, try the substring from the
// first '{' to the last '}'. Return the object or null.
export function parseBoostResult(stdout)

// Turn a finished booster invocation into one log line.
// Input: { stdout, stderr, exitCode, error } where exitCode is a number
// (0 on success) and error is the execFile error message if any.
// Output: { level: 'info' | 'warn' | 'error', line: string, result: object|null }
export function summarizeBoostRun({ stdout, stderr, exitCode, error })
```

`summarizeBoostRun` rules, in order:

- No parseable JSON: level `error`, line
  `failed: exit <exitCode> <first 300 chars of error/stderr/stdout>`.
- `result.boost_applied === true`: level `info`,
  `applied <pick.key> ad=<created.ad_id> total=$<pick.total>`.
- `result.ok === false`: level `error`,
  `failed at <stage>: <error || detail || reason>`.
- `result.stage === 'eligible' && result.eligible === false`: level `info`,
  `skip: <reason> (not eligible)`.
- `result.stage === 'resolve'` and not applied: level `warn`,
  `pending: post not live for <pick.key> (<reason>); next attempt tomorrow`.
  Append ` ESCALATED` when `result.escalate === true`.
- `result.stage === 'config'`: level `warn`, `skip: <reason>`.
- Otherwise: level `info`, `<stage>: <reason || 'ok'>`.
- When `exitCode !== 0` but JSON parsed and `result.ok !== false`, append
  ` (exit <exitCode> after result; ignored)` to the line. This is the case the
  old code mislabelled as `failed`.

Write `scripts/lib/fb-boost-tick.test.mjs` with node:test covering: time
parsing (valid, invalid, fallback), the time gate (before/after the boundary,
same-day repeat blocked, new day allowed), `decideBoostLaunch` for all three
branches, `parseBoostResult` for clean JSON, JSON with a trailing assertion
line, and garbage, and `summarizeBoostRun` for every rule above including the
non-zero-exit-with-ok-JSON case.

### 1c. Bridge wiring in `scripts/mav-bridge.mjs`

- Import `parseAfterTime`, `shouldRunFbBoostTick`, `decideBoostLaunch`,
  `summarizeBoostRun` from `./lib/fb-boost-tick.mjs`.
- New config next to `FB_BOOST_BRIDGE_ON`:
  `const FB_BOOST_AFTER = parseAfterTime(process.env.MAV_BRIDGE_FB_BOOST_AFTER, '09:30');`
  and `const FB_BOOST_LEDGER_PATH = path.join(PROJECT_ROOT, 'scripts', 'fb-boost-ledger.mjs');`
- New module state next to `lastDailyGbpDate`: `let lastFbBoostTickDate = '';`
- Remove the boost block from inside the 9 AM daily tick (the
  `// ── Facebook boost via Marketing API` block). Add a separate block right
  after the daily tick's closing brace:

```js
// ── Facebook boost tick: once per Central day, after MAV_BRIDGE_FB_BOOST_AFTER ──
// Runs later than the 9 AM tick on purpose: posts publish at 9:00:00 and the
// Graph listing lags by seconds, so a 9:00 boost attempt misses the post.
// The ledger pre-gate keeps this offline and silent on days with nothing to boost.
if (FB_BOOST_BRIDGE_ON) {
  const clock = centralDateHour(new Date());
  if (shouldRunFbBoostTick({ ...clock, lastTickDate: lastFbBoostTickDate, after: FB_BOOST_AFTER })) {
    lastFbBoostTickDate = clock.todayDate;
    await runFbBoostTick();
  }
}
```

- `async function runFbBoostTick()` (module level, near the other helpers):
  1. Run `fb-boost-ledger.mjs eligible` with `execFileAsync(process.execPath, [...])`,
     `cwd: PROJECT_ROOT`, `timeout: 30_000`, `windowsHide: true`, `env: process.env`.
     Parse stdout as JSON. On throw or unparseable output log
     `[mav-bridge][fb-boost] eligible check failed: <msg>` with `console.error` and return.
  2. `const gate = decideBoostLaunch(json)`. If `!gate.launch`, log
     `[mav-bridge][fb-boost] skip: <gate.reason> (not eligible)` and return.
  3. Run `fb-boost-api.mjs run` exactly as today (same timeout and maxBuffer).
     Capture stdout, stderr and exit code on both success and failure paths:
     on the catch path read `e.stdout`, `e.stderr`, `e.code`, `e.message`.
  4. `const s = summarizeBoostRun({...})`. Log `[mav-bridge][fb-boost] <s.line>`
     with `console.error` for level `error`, `console.log` otherwise. If stderr
     is non-empty, log the first 300 chars on a second line as today.
- Do not use `runPhase`/`hopError` here (soft skips are normal).
- Keep every other part of the bridge unchanged.

### 1d. `.env.example`

Under the existing `# MAV_BRIDGE_FB_BOOST=1` line add:
`# MAV_BRIDGE_FB_BOOST_AFTER=09:30      # Central time; boost tick waits for this so 9:00 posts are listed on Graph first`

### Verify

- `node --test scripts/lib/fb-boost-tick.test.mjs scripts/lib/gbp-runner.test.mjs`
- `node --check scripts/mav-bridge.mjs`
- `npm run lint`

## Worker 2: booster notifications and exit code (owns `scripts/fb-boost-api.mjs`, `scripts/fb-boost-ledger.mjs`, `scripts/fb-boost-ledger.test.mjs`)

### 2a. Exit code

Replace the final `process.exit(code);` in `scripts/fb-boost-api.mjs` with:

```js
process.exitCode = code;
// Safety net only: if something keeps the loop alive, exit anyway.
setTimeout(() => process.exit(code), 10_000).unref();
```

Do the same treatment in `scripts/fb-boost-ledger.mjs` only for the `notify`
branch (the one async branch): set `process.exitCode = 1` and fall through
instead of `process.exit(1)` inside its catch. Leave the other synchronous
`process.exit` calls in the ledger alone.

In the `ledger()` helper of `fb-boost-api.mjs`, when the child exits non-zero
but stdout parses as JSON with `ok === true`, return `ok: true` (keep the
parsed json and record `exitCode`). A ledger command that already wrote its
result must not be mistaken for a refusal.

### 2b. Notifications in `cmdRun`

Add a `--no-notify` flag (parseArgs: boolean, like `--dry-run`). Define
`const notify = !dryRun && !args['no-notify'];`. Add a local helper:

```js
async function text(out, message) {
  if (!notify) { out.notified = false; out.notify_skipped = dryRun ? 'dry_run' : 'no_notify'; return; }
  try { await sendHermesAlert(message.slice(0, 400)); out.notified = true; }
  catch (e) { out.notified = false; out.notify_error = e.message; }
}
```

Texts, all through that helper, none of which may change the exit code or
stop the pipeline:

- START, sent after the config gates pass and before `resolveLivePost`:
  `[FB Boost] Run started <pick.key>: $<daily>/day x <days>d = $<total> (week <week>, post date <pick.date>)`.
  Record `out.started_notified` on whichever `out` object is eventually written.
- Config gate exits while eligible (`stage: 'config'`, both the not-enabled and
  not-ready branches, and the missing-token branch): 
  `[FB Boost] Exit config <pick.key>: <reason>`.
- Resolve throw: `[FB Boost] Exit resolve error <pick.key>: <message>`.
- Post not live (`stage: 'resolve'`, `boost_applied: false`): always text now,
  not only when stale:
  `[FB Boost] Exit not applied <pick.key>: post not live (<reason>). Next attempt tomorrow.`
  When `escalate` is true append ` Post date <pick.date> is stale; check the poster.`
  Keep the `escalate` field.
- Verify error: `[FB Boost] Exit verify error <pick.key>: <message>`.
- Reserve refused: `[FB Boost] Exit REFUSED <pick.key>: <detail>` (this path
  is silent today; it must text).
- Marketing API error: keep the existing message but route it through the
  helper.
- Publish: keep the existing `[FB Boost] Published ...` message, routed through
  the helper. Remove the duplicated audit/console block in its catch; one
  `out` object with `notified`/`notify_error` is enough.
- Not eligible (`stage: 'eligible'`): no new text. Keep the existing once-per-week
  human-review text as is.
- Dry run: never texts (helper handles it).

Update the header comment: flags list gains `--no-notify`, and the
"Wire-in" line becomes
`Wire-in: mav-bridge boost tick, once per Central day after MAV_BRIDGE_FB_BOOST_AFTER (default 09:30), only when the ledger reports an eligible allocation.`

### 2c. Ledger `eligible` date and test overrides

In `scripts/fb-boost-ledger.mjs`:

- `LEDGER_PATH` becomes `process.env.FB_BOOST_LEDGER_PATH || <current default>`
  (comment: tests only).
- In the `eligible` branch, `today` becomes Central time, not UTC:
  `const today = process.env.FB_BOOST_TODAY || centralDate(new Date());` where
  `centralDate` formats `YYYY-MM-DD` in `America/Chicago` using
  `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })`.
  Add that small helper in the ledger file. `FB_BOOST_TODAY` is a test-only
  override; say so in a comment.

### 2d. Scenario tests in `scripts/fb-boost-ledger.test.mjs`

Keep the existing header cases. Add a second block that writes a temp schedule
modelled on the real week of 2026-09-07 (Day 1 date 2026-09-07 `BOOST: yes:$25`,
Day 3 date 2026-09-09 `BOOST: yes:$25`, Day 5 and Day 6 `BOOST: no`, plus a
BOOST BUDGET SUMMARY table with YES rows for Day 1 and Day 3 at $25 x 1 day and
NO rows for Day 5 and Day 6) and a temp ledger, then runs `eligible` with
`FB_SCHEDULE_PATH`, `FB_BOOST_LEDGER_PATH`, and `FB_BOOST_TODAY` set:

| today      | ledger state                          | expected                                    |
|------------|---------------------------------------|---------------------------------------------|
| 2026-09-07 | empty                                 | eligible, pick.key starts with `day1-`      |
| 2026-09-08 | day1 published                        | eligible false, reason `no eligible boosts` |
| 2026-09-08 | empty (Monday attempt never resolved) | eligible, pick.key starts with `day1-`      |
| 2026-09-09 | day1 published                        | eligible, pick.key starts with `day3-`      |
| 2026-09-10 | day1 and day3 published               | eligible false, reason `no eligible boosts` |

Write the ledger JSON directly in the shape of `outputs/fb-boost-ledger.json`
(`{ weeks: { '2026-09-07': { boosts: [ { key, post_id, daily, days, total, status: 'published', ... } ] } } }`).
Look at the real file for the exact shape; do not modify it.

### Verify

- `node scripts/fb-boost-ledger.test.mjs`
- `node scripts/fb-boost-api.mjs status` then print the exit code; repeat
  `node scripts/fb-boost-api.mjs run --dry-run --no-notify` five times and
  confirm exit code 0 each time, no assertion text, and each finishes within
  15 s. (Dry run is safe: it never reserves, creates ads, or texts.)
- `npm run lint`

## Worker 3: runbook (owns `FB-BOOST-RUNBOOK.md`)

Update `FB-BOOST-RUNBOOK.md` to match the behaviour above. Do not touch the
UI rollback section or the ad-set-shape section.

- Header paragraph: "driven daily from mav-bridge after Facebook reconcile"
  becomes a description of the separate boost tick: once per Central day, at or
  after `MAV_BRIDGE_FB_BOOST_AFTER` (default 09:30), and only when
  `fb-boost-ledger.mjs eligible` reports work or a human-review reason.
- "Daily automation" section: replace the "after 9:00 America/Chicago" wording
  with the tick description, the pre-gate, and why 9:30 (posts publish at
  9:00:00 and Graph lists them seconds later; 2026-09-07 missed by two seconds).
  State the week rule in plain words: the booster runs only on days with an
  unapplied YES allocation whose post date has arrived; after the last one is
  published it does not run again until the next schedule.
- New "Notifications" subsection listing every text: run started, exit
  config, exit resolve error, exit not applied (post not live), exit verify
  error, exit REFUSED, NOT applied (Marketing API error), Published, and the
  once-per-week human-review text. Note `--no-notify` and that dry runs never
  text.
- "Manual commands": add `--no-notify` examples.
- "Disable": add `MAV_BRIDGE_FB_BOOST_AFTER=HH:MM` as the way to move the tick.
- New paragraph under Daily automation: exit codes. The booster sets
  `process.exitCode` instead of calling `process.exit`, because Node 24 on
  Windows could abort during exit after the result was printed. The bridge now
  parses the JSON result even on a non-zero exit and only logs `failed` when
  there is no result or the result says `ok: false`.
- History: add a 2026-09-07 entry: Day 1 Whole-Home Surge Protection, $25 x 1d.
  9:00:02 tick found no live post (post published 9:00:00 on Facebook's
  scheduler); bridge mislabelled the run as failed; boost applied manually
  later that day after this change landed; tick moved to 09:30 with the ledger
  pre-gate and full exit texts.

### Verify

Read the final file once top to bottom for consistency with the sections you
did not edit.
