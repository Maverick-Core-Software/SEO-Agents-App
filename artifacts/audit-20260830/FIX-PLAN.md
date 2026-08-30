# FIX-PLAN — Grizzly Marketing Control operator-truth fixes

**Run ID:** mktg-dash-fixes-20260830
**Date:** 2026-08-30
**Executor:** pi `--provider deepseek --model deepseek-v4-flash`
**Worktree:** `C:\Users\carte\orca\workspaces\SEO-Agents-App\cockle`
**Branch:** `barnscarter-ops/cockle` (commit in place; no worktrees)
**Status:** READY

---

## Non-negotiables (every session)

1. Stay under `marketing-control/` only. Do not edit `C:\Workspace\Active\*` or `D:\Workspace\Active\*`.
2. Read-only app: no Supabase insert/update/delete/upsert/rpc; no `method: 'POST'`. GET worker probe is allowed.
3. No `git push`, `git fetch`, `git add -A`, or `git add .`. Stage **only** the files this session owns.
4. Never print secret values. `.env` key names only.
5. Do not restart PM2, Task Scheduler, Vite, or any live service.
6. Do not redesign. Implement the session as written.
7. After tests pass: one commit with the exact message below. Then stop.
8. Do not touch files outside the session file list.

Tests: `cd marketing-control && npm test`
Build (when the session says so): `cd marketing-control && npm run build`

---

## Live facts (do not re-research)

Today (America/Chicago): **2026-08-30** (Sunday).

Latest `seo_runs` row: `week_of=2026-08-31`, frozen `status=done`.
That run's `weekly_posts` span **2026-08-28 .. 2026-09-05** (11 rows). One GBP error:

- platform gbp, post_date **2026-08-29**, service Recessed Lighting
- error: `GBP verification failed after 4 attempts over 1hr — post may not be live`

MCC SEO Pipeline (`:3000`) already shows week **2026-08-28 – 2026-09-05** and that fault.
Marketing Control Today currently shows **2026-08-30 – 2026-09-05**, RUN BLOCKED, and "No items need recovery".

`run_logs` table is empty (0 rows). Do not invent log rows.

`website_tasks` has `pending_approval` (53), `waiting_on_owner` (8), `error` (3), `failed` (1).

---

## Dependency DAG

```
S1 (data layer)
 ├── S2  Today + week fixtures
 ├── S3  Calendar
 ├── S4  Approval Inbox
 ├── S5  Website Tasks
 ├── S6  Content Detail + App hash
 └── S7  Operations
```

Wave 1: S1. Wave 2: S2–S7 in parallel (file-disjoint).

---

## Session S1 — Shared data layer (Wave 1)

**Owns (only these):**

- `marketing-control/src/lib/api.js`
- `marketing-control/src/lib/api.test.mjs`
- `marketing-control/src/lib/useMarketingData.js`
- `marketing-control/src/lib/status.js`
- `marketing-control/src/lib/status.test.mjs`
- `marketing-control/src/lib/postHealth.js`
- `marketing-control/src/lib/postHealth.test.mjs`

**Do not edit pages.** Pages still compile against extra return fields.

### S1.1 `status.js`

Keep existing exports. Add:

```js
export function isRecoveryItem(item) {
  const status = String(item?.status || '');
  if (status === 'error' || status === 'needs_verification' || status === 'failed') return true;
  if (status === 'waiting_on_owner') return true;
  return status === 'posting' && !item?.posted_at;
}

export function isPendingApproval(status) {
  const s = String(status || '').toLowerCase();
  return s === 'pending_approval' || s === 'needs_approval';
}

export function isWaitingOnOwner(status) {
  return String(status || '').toLowerCase() === 'waiting_on_owner';
}

export function isOnGraph(post) {
  const s = String(post?.status || '');
  return Boolean(post?.platform_post_id) && (s === 'scheduled' || s === 'posted' || s === 'done');
}

export const RUN_STATUS_LABEL = {
  done: 'DONE',
  error: 'ERROR',
  pending_approval: 'PENDING',
  approved: 'APPROVED',
  executing: 'EXECUTING',
  posting: 'POSTING…',
  rejected: 'REJECTED',
  dismissed: 'DISMISSED',
  cancelled: 'CANCELLED',
};

export const TASK_STATUS_LABEL = {
  done: 'DONE',
  failed: 'FAILED',
  error: 'ERROR',
  pending_approval: 'PENDING',
  waiting_on_owner: 'WAITING ON OWNER',
  skipped: 'SKIPPED',
  executing: 'EXECUTING',
};

export function statusLabelFor(status, kind = 'post') {
  const s = String(status || '');
  if (kind === 'run') return RUN_STATUS_LABEL[s] || (s ? s.replace(/_/g, ' ').toUpperCase() : '—');
  if (kind === 'task') return TASK_STATUS_LABEL[s] || (s ? s.replace(/_/g, ' ').toUpperCase() : '—');
  return POST_STATUS_LABEL[s] || (s ? s.replace(/_/g, ' ').toUpperCase() : '—');
}

export function statusColorFor(status, kind = 'post') {
  const s = String(status || '');
  if (POST_STATUS_COLOR[s]) return POST_STATUS_COLOR[s];
  if (s === 'waiting_on_owner') return '#f59e0b';
  if (s === 'failed' || s === 'rejected') return s === 'rejected' ? '#4b5563' : '#ef4444';
  if (kind === 'run' && s === 'done') return '#10b981';
  if (kind === 'task' && s === 'done') return '#10b981';
  return '#4b5563';
}
```

Add to `POST_STATUS_COLOR` (do **not** change `POST_STATUS_LABEL.done` — posts that are `done` still read POSTED):

```js
waiting_on_owner: '#f59e0b',
failed: '#ef4444',
rejected: '#4b5563',
```

### S1.2 `status.test.mjs`

Add cases:

- `isRecoveryItem` true for error, needs_verification, failed, waiting_on_owner, posting without posted_at
- `isRecoveryItem` false for posted, scheduled, pending_approval
- `statusLabelFor('done', 'run') === 'DONE'`
- `statusLabelFor('done', 'task') === 'DONE'`
- `statusLabelFor('done', 'post') === 'POSTED'`
- `statusLabelFor('waiting_on_owner', 'task') === 'WAITING ON OWNER'`
- `isOnGraph({ status: 'scheduled', platform_post_id: '1' }) === true`
- `isOnGraph({ status: 'scheduled', platform_post_id: null }) === false`

Keep existing liveRunStatus tests passing.

### S1.3 `postHealth.js`

Do not change RED rules for posted rows (tests depend on them). Slideshow posted + photo + id stays green.

No extra posted-only rules required. (Pre-publish `media_status: none` is a chip concern in S2.)

### S1.4 `api.js`

Add `fetchPostById(id)`:

```js
export async function fetchPostById(id) {
  if (!isSupabaseAvailable || !id) return null;
  const rows = await selectRows(
    readFrom('weekly_posts').select('*').eq('id', id).limit(1),
    'weekly_posts query failed',
  );
  return rows[0] || null;
}
```

Keep `fetchLatestRunHealth` as-is (already loads latest `seo_runs` by `week_of` desc + that run's posts).

### S1.5 `api.test.mjs`

When not configured, `fetchPostById('x')` returns `null`.

### S1.6 `useMarketingData.js` — this is the load-bearing Today fix

`posts` must become **latest-run posts** (`health.posts`), not calendar Sunday–Saturday `fetchPosts`. That is how MCC `/seo/posts/week` works.

Also fetch a lookback window for prior-week recovery (do not use it as `posts`):

```js
const lookbackStart = addDays(sundayOfWeek(today), -21);
const lookbackEnd = saturdayOfWeek(addDays(today, 21));
```

Import `addDays` from `./week.js`. Import `isPendingApproval`, `isWaitingOnOwner`, `isRecoveryItem` from `./status.js`. Import `fetchWorkerStatus`.

Reload `Promise.all`:

- `fetchRuns()`
- `fetchPosts(lookbackStart, lookbackEnd)` → `lookbackPosts`
- `fetchWebsiteTasks()`
- `fetchRunLogs()`
- `fetchLatestRunHealth()`
- `fetchWorkerStatus()`

Set:

```js
const runPosts = nextHealth.posts || [];
setPosts(runPosts);
setLookbackPosts(nextPosts);
setWorker(nextWorker);
```

Date span for the header (match MCC):

```js
function spanFromPosts(list, fallbackStart, fallbackEnd) {
  const dates = (list || []).map((p) => p.post_date).filter(Boolean).sort();
  if (!dates.length) return { weekStart: fallbackStart, weekEnd: fallbackEnd };
  return { weekStart: dates[0], weekEnd: dates[dates.length - 1] };
}
```

Use `spanFromPosts(posts, sundayOfWeek(today), saturdayOfWeek(today))` for returned `weekStart` / `weekEnd`. Keep `calWeekStart = sundayOfWeek(today)` and `calWeekEnd = saturdayOfWeek(today)` on the return object for Calendar if needed (Calendar has its own fetch; still export them).

`partitionPosts`: if platform is not `gbp`, push to facebook (unknown platforms must not vanish).

Derived return fields (in addition to existing ones):

```js
{
  lookbackPosts,
  worker,                 // fetchWorkerStatus result or { ok:false, unreachable:true }
  pendingPosts: posts.filter((p) => isPendingApproval(p.status)),
  pendingTasks: tasks.filter((t) => isPendingApproval(t.status)),
  waitingOnOwner: tasks.filter((t) => isWaitingOnOwner(t.status)),
  runRecovery: [...posts, ...tasks.filter((t) => t.run_id && health.run && t.run_id === health.run.id)].filter(isRecoveryItem),
  priorRecovery: [
    ...lookbackPosts.filter((p) => isRecoveryItem(p) && (!health.run || p.run_id !== health.run.id)),
    ...tasks.filter((t) => isRecoveryItem(t) && (!health.run || t.run_id !== health.run.id)),
  ],
  facebookOnGraph: facebook.filter(isOnGraph).length,
  gbpOnGraph: gbp.filter(isOnGraph).length,
}
```

Unconfigured path: empty arrays, worker `{ ok:false, unreachable:true }`.

### S1 verification

```
cd marketing-control
npm test
```

Must pass (existing + new). Then:

```
git add marketing-control/src/lib/api.js marketing-control/src/lib/api.test.mjs marketing-control/src/lib/useMarketingData.js marketing-control/src/lib/status.js marketing-control/src/lib/status.test.mjs marketing-control/src/lib/postHealth.js marketing-control/src/lib/postHealth.test.mjs
git commit -m "fix(marketing-control): run-anchored posts, status kinds, recovery helpers"
```

**Commit message (exact):** `fix(marketing-control): run-anchored posts, status kinds, recovery helpers`

Reply: `SESSION S1 COMPLETE` plus test counts and commit hash.

---

## Session S2 — Today screen + week fixtures (Wave 2)

**Owns:**

- `marketing-control/src/pages/TodayPage.jsx`
- `marketing-control/src/fixtures/week.js`
- `marketing-control/src/fixtures/week.test.mjs`

Depends on S1 already merged.

### S2.1 Stop silent fixture overlay

`usingFixtures` only when `!configured`. If configured, show live `data.posts` even when empty. Keep the existing error banner.

### S2.2 Header / counts

- Week range: `data.weekStart – data.weekEnd` (run span after S1).
- Replace the single **53 PENDING APPROVAL** card with three summary numbers:
  - `data.pendingPosts.length` labeled `Posts pending`
  - `data.pendingTasks.length` labeled `Website pending`
  - `data.waitingOnOwner.length` labeled `Waiting on owner`
- Keep run health card (`health.live` / `health.bucket`).

### S2.3 Adapter dots

Do **not** use `FIXTURE_ADAPTERS` when configured.

Derive from live posts (pure helper in TodayPage or week.js):

- facebook: any recovery facebook post → `error`; else any facebook `isOnGraph` or posted → `live_ready`; else `unknown`
- gbp: any recovery gbp post → `error`; else any gbp posted → `live_ready`; else any `scheduled_native` → `worker`; else `unknown`
- website: any waiting_on_owner or task error/failed → `error`; else `unknown`

When `!configured`, keep `FIXTURE_ADAPTERS`.

### S2.4 Needs recovery

Use `data.runRecovery` (not a local filter of calendar posts). Owner-block items (`waiting_on_owner`) belong here.

`recoveryReason(item)`:

- `item.error` if present
- `waiting_on_owner` → `Waiting on owner`
- `needs_verification` → `Needs verification`
- `posting` without posted_at → existing stuck copy
- if `item.platform` → `Post failed` for error
- else → `Task failed` for error (never call a website task "Post failed")

Prior-week chip: `data.priorRecovery` (S1). Keep the expand toggle.

### S2.5 Facebook / GBP counts

Show posted count **and** on-Graph scheduled count:

- Facebook: `${fbPosted}/${facebook.length}` plus ` · N on Graph` when `data.facebookOnGraph` > fbPosted
- GBP: keep posted/total · native as now

### S2.6 Clickable rows

Each post row is a `<button>` (or clickable card) that writes `sessionStorage['mc.detailPost']` JSON and sets `window.location.hash = '#/detail/' + post.id`. Same helper as Calendar `openPost`.

### S2.7 `chipForPost` (`week.js`)

If `status === 'scheduled'` and `media_status === 'none'`, label `CHECK`, kind `check`, color red (before the POST TODAY branch is fine; health.red still wins).

`dayLabelFor`: Sunday-start labels `['Sun','Mon','Tue','Wed','Thu','Fri','Sat']` and `WEEKDAY_LABELS[dow]` (UTC day).

Keep `isRecoveryItem` in week.js as a re-export of `../lib/status.js` (delete the local copy).

Fixture comment: fixture run still covers 2026-08-24..2026-08-30 so POST TODAY / OVERDUE chips remain; `FIXTURE_WEEK_START`/`END` stay those dates for unconfigured demo. Add a gbp error on 2026-08-29 if not already present so fixture recovery is visible (the existing `fb-sat` needs_verification and `gbp-fri` posting already cover recovery).

### S2.8 Tests

Update `week.test.mjs`: scheduled + media none → CHECK. Sunday `dayLabelFor('2026-08-30') === 'Sun'`. Keep native-not-overdue.

### S2 verification

`cd marketing-control && npm test && npm run build`

**Commit message:** `fix(marketing-control): today run recovery, pending split, clickable posts`

---

## Session S3 — Calendar (Wave 2)

**Owns:** `marketing-control/src/pages/CalendarPage.jsx` only.

Website row currently keys tasks by `created_at`, so this week shows website 0 while Friday's batch sits on Aug 28.

Change `itemDate(row)`:

1. `due_date` / `post_date` if present
2. else if `row.run_id` matches a post in `posts`, use that post's `post_date` (first matching)
3. else `week_of`
4. else `created_at`

Pass posts into the helper. Tasks for the latest run then land on content dates, not only created_at.

Keep Sunday-start grid, newest-first, click-through. Do not fetch differently unless needed; current lookback is fine.

**Commit message:** `fix(marketing-control): calendar website tasks follow run post dates`

Verify: `npm test && npm run build`

---

## Session S4 — Approval Inbox (Wave 2)

**Owns:**

- `marketing-control/src/pages/ApprovalInboxPage.jsx`
- `marketing-control/src/pages/ApprovalInboxPage.test.mjs`

Default list (when live data exists):

- pending_approval **or** waiting_on_owner
- restrict to latest run if `run_id` matches `fetchRuns()[0].id`, **plus** any waiting_on_owner regardless of age (owner blocks are current)
- Add a toggle `Show all pending` that lifts the run filter (still pending_approval | waiting_on_owner only)

Groups:

```
SEO runs
Weekly posts
Website tasks
Waiting on owner
```

`waiting_on_owner` items appear **only** in the last group (do not also list them under Website tasks).

Use `statusLabelFor(status, item.type === 'seo_run' ? 'run' : item.type === 'website_task' || item.type === 'waiting_on_owner' ? 'task' : 'post')`.

Keep Approve/Skip as `ReadOnlyButton`. Keep fixture fallback when live array is empty **and** supabase is not configured; if configured and empty after filters, show "No items" not fixtures.

**Commit message:** `fix(marketing-control): approval inbox current-run filter and owner-wait group`

Verify: `npm test && npm run build`

---

## Session S5 — Website Tasks (Wave 2)

**Owns:** `marketing-control/src/pages/WebsiteTasksPage.jsx` only.

- Default filter: hide `done` and `skipped`. Tabs or chips: `Open` (pending_approval + waiting_on_owner + error + failed + executing), `Waiting on owner`, `All`.
- Default tab `Open`.
- Status chips via `statusLabelFor(status, 'task')` and `statusColorFor(status, 'task')` — `done` must read **DONE**, never POSTED.
- Sort: waiting_on_owner first, then error/failed, then pending, then the rest. Keep priority rank inside a bucket.
- Do not use fixture adapter as if live when configured; keep the capabilities card but label it `fixture capabilities (not live)`.
- If configured and list empty for the tab: `No website tasks.` not fixtures.

**Commit message:** `fix(marketing-control): website task filters and DONE labels`

Verify: `npm test && npm run build`

---

## Session S6 — Content Detail + hash routing (Wave 2)

**Owns:**

- `marketing-control/src/App.jsx`
- `marketing-control/src/pages/ContentDetailPage.jsx`
- `marketing-control/src/styles.css` (mobile nav only if needed)

### Hash

`routeFromHash`:

- `#/detail` or `#/detail/<id>` → Content Detail
- other exact NAV hashes as now
- default Today

Parse id: `hash.startsWith('#/detail/') ? hash.slice('#/detail/'.length) : ''`

Optional: pass id via `window.location.hash` only (no react-router).

### ContentDetailPage

1. If hash has id: `fetchPostById(id)` when configured; else sessionStorage; else empty.
2. If no id: sessionStorage `mc.detailPost` if present.
3. If configured and still no post: **empty state** — "Pick a post from Today or Calendar." **Do not show the Aug 24 fixture** when configured.
4. Fixture only when `!isSupabaseAvailable` and no session post.

Keep scaffolding notes for missing action_queue fields.

Mobile: `.appNav` is already column at 720px; add `max-height` / wrap is enough. Do not hide screens.

**Commit message:** `fix(marketing-control): content detail live id and no fake fixture`

Verify: `npm test && npm run build`

---

## Session S7 — Operations (Wave 2)

**Owns:** `marketing-control/src/pages/OperationsPage.jsx` only.

- Run frozen/live chips: `statusLabelFor(status, 'run')` so `done` is **DONE**, not POSTED.
- Adapter cards: do **not** use `FIXTURE_ADAPTERS` when configured. Same derivation as S2 (inline a small helper; duplication is OK, do not edit TodayPage). If worker.unreachable, say so under the cards.
- Keep worker JSON + redaction.
- `run_logs` empty is correct; keep the empty state.
- Surface `worker.data.faults` as a short list above the JSON (strings only, no secrets) so the GBP Aug 29 line is readable without opening the dump.

**Commit message:** `fix(marketing-control): operations DONE labels and live adapter/faults`

Verify: `npm test && npm run build`

---

## Out of scope

- Performance live files (`VITE_OUTPUTS_DIR`) — stay fixtures.
- MCC edits, mav-bridge writes, RLS, posting, approvals.
- Restarting the Vite server or PM2.

---

## Acceptance (orchestrator)

After all sessions:

1. `cd marketing-control && npm test && npm run build` on this branch.
2. Today live: week **2026-08-28 – 2026-09-05**, Needs recovery includes Recessed Lighting GBP error, pending is not a single 53.
3. Content Detail via nav without id does not show the fake Graph id `122000000000000123` when `.env` is set.
4. Operations run status **DONE** not POSTED; faults list includes the Aug 29 GBP line.
5. `git log --oneline -8` shows the seven fix commits (or fewer if a session was empty — none should be).
