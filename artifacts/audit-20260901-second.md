# Second independent audit — SEO Agents App and Marketing Control

**Date:** 2026-09-01  
**Scope:** Current `main` worktree, including the uncommitted Marketing Control polish as observed. Static review and safe local tests only; no live service, Google, PM2, or worker interaction was performed.  
**Purpose:** Identify material omissions from `marketing-control/docs/AUDIT-FINDINGS.md`, corrections to stale assertions in that document, and small hardening/simplification work that can proceed without changing the read-only dashboard contract.

## Executive result

The earlier audit correctly maps the main content/idempotency risks, but it misses an engine-local unauthenticated action surface and a website-repository overwrite path. The dashboard's current read-only tests pass (82/82), while the Python engine suite cannot collect on this checkout because `pydantic_core` fails to load with `Access is denied`; that is a real verification blocker, not evidence of a passing engine suite. The currently observed Marketing Control implementation remains client-side read-only in source and tests, but final screen-level browser validation must wait for Grok's in-progress polish to settle.

## Findings, ranked by severity

### High — S1: `mav-bridge` mutates execution state without authentication and advertises wildcard CORS

**Evidence**

- Every response receives `access-control-allow-origin: '*'` in `scripts/mav-bridge.mjs:847-857`.
- The same handler accepts unauthenticated `POST` calls that approve, dismiss, retry, clear locks, execute a run, approve a generated prompt, or start schedule generation (`scripts/mav-bridge.mjs:1008-1277`).
- The service correctly binds to loopback (`scripts/mav-bridge.mjs:1396`), which limits direct LAN reachability, but a browser page can still target a local loopback service. `readBody()` accepts arbitrary JSON from a body without requiring a content type (`scripts/mav-bridge.mjs:858-861`), so a browser can use a CORS-simple `text/plain` JSON request rather than relying on a preflight.

**Impact**

A page opened in the operator's browser can potentially drive local SEO actions through `127.0.0.1:8790`—including status transitions that trigger posting or website execution. This is separate from existing finding C1, which concerns MCC's network listener and build route; the affected engine process here is loopback-only but has its own mutating HTTP API.

**Hardening path**

Make mutations fail closed behind a server-held action token or same-origin proxy boundary; expose CORS only for explicitly allowed read-only origins and routes. Bound request size and reject malformed JSON with a 4xx response. Preserve direct local service-to-service callers only through an explicit authenticated contract, not wildcard browser reachability.

### High — S2: Website automation can overwrite a dirty target checkout before it verifies repository state

**Evidence**

- `apply_edit()` writes generated content directly into `WEBSITE_REPO_DIR` before its commit path (`src/seo_agents/website.py:425-481`).
- `commit_and_push()` checks only the current branch and then stages the named paths; it does not reject a dirty target or detect that a human changed the same files before the generated write (`src/seo_agents/website.py:331-352`).
- This is an autonomous path: the module writes, commits, and pushes to the website repository (`src/seo_agents/website.py:317-352`), and a default bridge configuration auto-executes approved website tasks (`scripts/mav-bridge.mjs:78-79, 422-435`).

**Impact**

A human's uncommitted website change to a generated target can be overwritten before the later git operation reports a problem. A clean commit is therefore not evidence that the content was safe to replace.

**Hardening path**

Before any target write, require a clean repository and/or require each destination to be unmodified relative to `HEAD`; return a structured `dirty_target` status and leave the task pending for human resolution. Add unit coverage using a temporary git repository. This is a contained engine-side change.

### High — S3: The Python engine test suite is presently non-runnable in this checkout

**Evidence**

- `pyproject.toml:1-18` declares the engine's Python dependencies; the project has a `.venv`.
- Running `PYTHONPATH=src .venv\\Scripts\\python.exe -m pytest -q` failed during collection of all 20 test modules because `pydantic_core` could not load: `ImportError: DLL load failed while importing _pydantic_core: Access is denied`.

**Impact**

Current Python test claims cannot be independently revalidated on this machine, including existing critical-path coverage for the website adapter and execution gate. This is an environment/installation integrity issue, not a code defect proven by the test run.

**Hardening path**

Repair or recreate the local virtual environment through the approved local dependency workflow, then add a single non-secret preflight command that imports `pydantic_core` before the full suite. Do not treat a bare `pytest` collection failure as a test failure in CI; make the setup failure explicit.

### Medium — S4: The HTTP request reader is unbounded and throws parse failures through the generic 500 path

**Evidence**

- `readBody()` concatenates every received chunk into a string and immediately calls `JSON.parse` (`scripts/mav-bridge.mjs:858-861`).
- The top-level handler converts thrown request errors to an internal-error response (`scripts/mav-bridge.mjs:1388-1394`).

**Impact**

A local caller can consume process memory with a large request body; malformed JSON is logged as an internal failure rather than rejected as client input. This worsens the S1 local attack surface and makes operational diagnosis noisier.

**Hardening path**

Add a small maximum body size, stop reading once exceeded, and return `400`/`413` for invalid JSON/oversize bodies. Unit-test the parser independently from live polling.

### Medium — S5: `AUDIT-FINDINGS.md` is stale on current test coverage, which can misprioritize remediation

**Evidence**

- The prior audit says `scripts/supabase-sync.mjs` is entirely untested and lists no GBP worker coverage (`marketing-control/docs/AUDIT-FINDINGS.md:108-118, 337`).
- Current source contains `scripts/supabase-sync.test.mjs`, which tests auto-approval CAS/rollback behavior, and `scripts/gbp-worker.test.mjs`, which tests verify-queue terminal-state behavior.
- The historical claim is still directionally valid for `getWeekOf`, schedule parsing, and top-level polling: these current tests do not cover those paths (`scripts/supabase-sync.test.mjs:1-126`, `scripts/gbp-worker.test.mjs:1-52`).

**Impact**

Calling the whole modules untested hides useful new safety coverage and makes the remaining untested seams less precise.

**Simplification path**

Replace the blanket assertions with a coverage matrix by function/contract. Keep the unresolved clock-derived `week_of`, parser fan-out, and watchdog gaps as high-risk items; do not duplicate their already-recorded findings.

### Medium — S6: Dashboard tests are source-level, not seven-screen behavior coverage

**Evidence**

- `marketing-control/package.json:6-10` runs Node tests against library/page source; no browser runner is configured.
- The read-only source walk is valuable and passes, but it only searches source call shapes (`marketing-control/src/lib/guard.test.mjs:31-58`).
- The page suite is concentrated on Approval Inbox (`marketing-control/src/pages/ApprovalInboxPage.test.mjs:1-82`); Today, Calendar, Content Detail, Website Tasks, Performance, and Operations lack comparable page tests.

**Impact**

Responsive layout, navigation, loading/error states, and disabled-control semantics can regress while the source scan remains green.

**Hardening path**

After the current polish, add a small browser smoke suite covering all seven routes at desktop and mobile widths, fixture/no-config/error/loading states, and asserting no mutation-shaped network call occurs. This is dashboard-owned work, so it is not being changed by this audit stream.

### Low — S7: Engine date conventions still mix local calendar dates and UTC timestamps

**Evidence**

- `scripts/run-weekly-seo.py:31-36, 65` derives filenames and health `date` from host-local `date.today()`, while `at` is UTC (`scripts/run-weekly-seo.py:39-41`).
- `scripts/seo-watchdog.mjs:68-74` deliberately reads the local date, while `scripts/seo-monitor.mjs:69-72` derives its logfile date with `new Date().toISOString()`.

**Impact**

Around local evening / UTC rollover, the same run can be filed under different date keys across monitor logs and health diagnostics. This does not reintroduce the earlier `supabase-sync` `week_of` bug directly, but it complicates incident correlation.

**Simplification path**

Introduce one explicit `America/Chicago` date helper for operational date keys, leaving UTC exclusively for instants. Export and unit-test it with the already-known after-19:00-CDT boundary.

## Previously recorded issues rechecked

| Item | Current result |
|---|---|
| `website.py` fence stripping | Still present: `re.sub(..., "", "", stripped)` at `src/seo_agents/website.py:147` passes a string as `count` and raises on fenced content. Engine fix is being dispatched. |
| `supabase-sync` local-clock week key | Still present at `scripts/supabase-sync.mjs:50-62, 325`; the old `.toISOString()` rollover is absent, but the key remains run-clock-derived and lacks direct date/parser tests. |
| Dashboard mutation guard | Source guard and no-mutation source walk pass in current working tree (`marketing-control/src/lib/guard.js:1-34`, `marketing-control/src/lib/guard.test.mjs:31-58`). This does not substitute for hosted RLS. |
| Dashboard test baseline | `npm test` passes **82/82** in `marketing-control/` on the observed worktree. This is not final UI regression verification because Grok's polish was still uncommitted during audit. |

## Work deliberately not performed

- No change to `scripts/classify-electrical.mjs`, `scripts/vision-benchmark.mjs`, or `dump-gbp-dates.mjs`.
- No PM2, mav-bridge, GBP-worker, browser, Google, Supabase, or deployment interaction.
- No edits to Grok-owned Marketing Control files.

## Recommended engineering order

1. Fail-close the bridge mutation boundary and bound request parsing (S1/S4).
2. Prevent dirty-target overwrites and repair the live fence parsing defect (S2 and the prior H9).
3. Restore Python test collection, then add the missing watchdog/week-key tests (S3/S5).
4. Let dashboard ownership add post-polish browser coverage (S6), keeping its read-only guard as a defense-in-depth control rather than a substitute for RLS.
