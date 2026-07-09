# Weekly SEO Pipeline Fixes (2026-07-09 Audit) — Implementation Plan

> **For agentic workers:** Execute task-by-task, in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restore the broken pieces of the weekly SEO pipeline before the 2026-07-10 Friday run: mark stale GBP posts skipped, swap both GPT-4o-mini text calls to Grok on the existing xAI key, install pytrends, fix the GBP worker scheduled task, and restore the PM2-managed services with a correct saved process list.

**Architecture:** The pipeline is a Windows Task Scheduler chain (Friday 8:30 AM) that runs a Python crew, syncs results to Supabase, and hands execution to two long-lived Node workers: `mav-bridge` (PM2-managed, port 8790, does Facebook + website) and `gbp-worker` (user-session Scheduled Task, does Google Business Profile). Both workers are currently down; two small code files also get a vendor swap (OpenAI → xAI Grok chat).

**Tech Stack:** Node.js (ES modules, plain `.mjs`, no TypeScript), Python 3.12 with a uv-managed venv, PM2 on Windows via an NSSM service, Windows Task Scheduler, Supabase (Postgres) via `@supabase/supabase-js`.

---

## Codebase Primer

Read this whole section before touching anything.

### Repo layout (only what this plan touches)

```
C:\Workspace\Active\SEO-Agents-App\        <- repo root, all relative paths below are from here
  .env                                     <- secrets (SUPABASE_URL, SUPABASE_SERVICE_KEY, XAI_API_KEY, ...) — NEVER print values, NEVER commit
  pyproject.toml                           <- Python deps, uv-managed
  .venv\Scripts\python.exe                 <- the venv the Friday task actually runs
  scripts\facebook-poster.mjs              <- Task 3 edits this
  scripts\mav-bridge.mjs                   <- Task 4 edits this
  scripts\gbp-worker.mjs                   <- NOT edited; restarted by Task 6
C:\Workspace\Active\MCC\ecosystem.config.cjs  <- PM2 app definitions (different repo, NOT edited, only referenced by pm2 commands)
```

### Contracts and conventions you must not break

- **`.env` loading:** every script loads the repo `.env` itself. Never hardcode a secret; never echo a secret value to the console.
- **hopLog / hop names:** log lines tag the outbound boundary, e.g. `facebook-poster→openai`. When the vendor changes to xAI, the hop name changes to `→xai`. Keep the exact format.
- **Fallback behavior is sacred:** both functions being edited fall back to the schedule's own `VIDEO_PROMPT` when no API key is present or the API errors. The replacements below preserve this exactly. Do not "improve" the error handling.
- **`ponytail:` comments** in this codebase mark intentional simplifications. Preserve them wherever you see them.
- **Commit style:** conventional-commit-ish one-liners like `fix(fb-video): ...`. Work directly on `main` — that is this repo's convention (all recent commits are direct to main) and the services restart from the working tree, so the code must be live on the checked-out branch.

### Environment gotchas (Windows 11, PowerShell 7)

- Use PowerShell syntax for all commands (`Test-Path`, `$env:VAR`, backtick escapes). Not bash.
- **PM2 home is machine-wide:** `PM2_HOME` is set to `C:\ProgramData\pm2` as a machine environment variable so user shells and the NSSM "PM2" service share one daemon. If `$env:PM2_HOME` prints empty in your shell, set it for the session before any pm2 command: `$env:PM2_HOME = 'C:\ProgramData\pm2'`.
- **CRITICAL — do not touch the running LLM:** PM2 currently manages `qwen3-llama` (the local LLM server on port 8080) and `llama-guardian`. NEVER run `pm2 restart`, `pm2 stop`, `pm2 delete`, or `pm2 reload` on these — or on anything. The only pm2 commands this plan uses are `pm2 ls`, `pm2 start <ecosystem> ...`, and `pm2 save`. `pm2 start` on an already-running app name prints an error and leaves it alone — that error is EXPECTED for `qwen3-llama`, do not retry or "fix" it.
- The untracked `.serena/` directory in `git status` is pre-existing and expected. Leave it alone; never `git add` it.
- There is no test suite for these scripts. Verification is `node --check` (syntax) plus live behavior checks with expected outputs, as written in each task.

### Why each fix exists (so you don't "correct" intentional choices)

1. **Stale GBP rows:** the GBP worker died 2026-07-09 00:27 (console closed). Days 2–6 of the 7/03 run (post_date 2026-07-04 … 2026-07-08) are stuck at `status='scheduled'` in the `weekly_posts` table and are now week-old content. Carter decided they must be marked `skipped`, not posted late. Rows with `post_date` = today or later are left alone on purpose (the worker may still legitimately post today's row).
2. **Grok swap:** the video generator already runs on xAI (`XAI_API_KEY`). Two leftover text calls still hit OpenAI `gpt-4o-mini`. Both move to xAI's chat endpoint (`https://api.x.ai/v1/chat/completions`, OpenAI-compatible) with model `grok-4.20-0309-non-reasoning` — this exact model id was verified against the account's live `/v1/models` list on 2026-07-09. Do not substitute a different model name.
3. **pytrends:** `scripts/run-weekly-seo.py` imports pytrends for Google Trends topic selection, but it was never installed, so topic selection has silently fallen back to a fixed rotation since day one. The venv is uv-managed (there is no pip inside it) — the install MUST go through `uv add`.
4. **Duplicate GBP task:** two Scheduled Tasks ("GBP Worker" and "Grizzly SEO GBP Worker") run the identical worker script at logon — a double-posting risk. The unnamed-prefix one ("GBP Worker") gets deleted. The survivor gets a second, daily 8:00 AM trigger so it recovers without a re-logon (its `MultipleInstancesPolicy` is IgnoreNew, so the extra trigger can never start a second copy).
5. **PM2 dump:** `C:\ProgramData\pm2\dump.pm2` was overwritten by a `pm2 save` on 7/8 while only the llama apps were loaded, so the auto-resurrect supervisor restores nothing else. Starting the full ecosystem and re-saving fixes resurrection permanently.

---

## Session Map (for small-context executors)

This plan is executed in THREE separate sessions, each started fresh. In every session: read the **Codebase Primer** above first, then ONLY the tasks listed for your session. Do not read or execute the other sessions' tasks. Earlier sessions' commits are your starting state.

- **Session 1:** Task 1 (preflight) + Task 2 (mark stale GBP rows skipped). No commits.
- **Session 2:** Task 3 (facebook-poster Grok swap) + Task 4 (mav-bridge Grok swap). Two commits.
- **Session 3:** Task 5 (pytrends) + Task 6 (scheduled tasks) + Task 7 (PM2 restore) + Task 8 (final verification). One commit.

---

### Task 1: Preflight

**Files:** none (checks only).

- [ ] Step: open a PowerShell terminal and confirm the repo state:
  ```powershell
  Set-Location C:\Workspace\Active\SEO-Agents-App
  git rev-parse --abbrev-ref HEAD
  git status --short
  ```
  Expected output: first command prints `main`. Second prints at most `?? .serena/` (plus possibly `?? docs/superpowers/plans/...` if this plan file is not yet committed). If there are OTHER modified files, STOP and report — do not proceed on a dirty tree.
- [ ] Step: confirm the tools this plan needs exist:
  ```powershell
  node --version
  uv --version
  pm2 --version
  ```
  Expected output: three version strings, one per line (any versions). If any command is not found, STOP and report.

### Task 2: Mark stale GBP rows as skipped

**Files:** Create `scripts\tmp-skip-stale-gbp.mjs` (temporary — deleted at the end of this task, never committed).

Run this BEFORE restarting any worker so stale content can never race a restarted worker.

- [ ] Step: create `C:\Workspace\Active\SEO-Agents-App\scripts\tmp-skip-stale-gbp.mjs` with exactly this content:
  ```js
  // One-off: mark GBP rows that were never posted (worker was down) as skipped,
  // so week-old content can never post late. Rows dated today or later are left alone.
  import { createClient } from '@supabase/supabase-js';
  import fs from 'node:fs';
  import path from 'node:path';
  import { fileURLToPath } from 'node:url';

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const { data, error } = await supabase
    .from('weekly_posts')
    .update({ status: 'skipped', error: 'skipped: stale — gbp-worker was down during posting window (2026-07-09 audit)' })
    .eq('platform', 'gbp')
    .eq('status', 'scheduled')
    .lt('post_date', today)
    .select('id, day, post_date');

  if (error) { console.error('FAILED:', error.message); process.exit(1); }
  console.log(`Marked ${data.length} stale GBP rows skipped:`);
  for (const r of data) console.log(`  day ${r.day} — ${r.post_date}`);
  ```
- [ ] Step: run it:
  ```powershell
  node C:\Workspace\Active\SEO-Agents-App\scripts\tmp-skip-stale-gbp.mjs
  ```
  Expected output: `Marked 5 stale GBP rows skipped:` followed by five lines, days 2–6, dates 2026-07-04 through 2026-07-08. (If you are executing this plan on 2026-07-10 or later, the count is 6 and includes day 7 / 2026-07-09 — that is correct.) Every listed date must be earlier than today. If the count is 0 or `FAILED:` prints, STOP and report the exact output.
- [ ] Step: delete the temporary script:
  ```powershell
  Remove-Item C:\Workspace\Active\SEO-Agents-App\scripts\tmp-skip-stale-gbp.mjs
  git status --short
  ```
  Expected output: `git status --short` shows no entry for `scripts/tmp-skip-stale-gbp.mjs`. No commit in this task.

### Task 3: Swap facebook-poster's director rewrite from OpenAI to Grok

**Files:** Modify `scripts\facebook-poster.mjs` (three surgical edits: the key constant near line 109, the `generateCinematicPrompt` function near lines 549–581, and one error-message string near line 920).

The long director system prompt inside the function is copied UNCHANGED — only the endpoint, key, model, hop names, and one comment change. Copy the replacement block character-for-character.

- [ ] Step: in `scripts\facebook-poster.mjs`, find this exact line (currently line 109):
  ```js
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  ```
  and replace it with:
  ```js
  const XAI_API_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
  ```
- [ ] Step: in the same file, find the entire `generateCinematicPrompt` function. It currently spans lines 549–581. Replace the whole function — from the line `export async function generateCinematicPrompt(post) {` through its closing `}` (the closing brace sits two lines above `let geminiCreditsDepletedFlag = false;`) — with this block:
  ```js
  export async function generateCinematicPrompt(post) {
    // The schedule's VIDEO_PROMPT (written by the weekly crew) is used as a
    // scene idea, never verbatim — those prompts are tame single-shot
    // descriptions and often name the brand. The director rewrite below is what
    // makes the clip Reels-worthy.
    if (!XAI_API_KEY) {
      hopLog('facebook-poster→xai', 'warn', 'No XAI_API_KEY — falling back to schedule prompt as-is.');
      return post.video_prompt || null;
    }
    const caption = buildCaption(post);
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XAI_API_KEY}` },
      body: JSON.stringify({
        model: 'grok-4.20-0309-non-reasoning', max_tokens: 320,
        messages: [
          { role: 'system', content: `You are a video director writing generation prompts for short vertical Facebook Reels (9:16, ~8 seconds) for a licensed residential and commercial electrician in DFW, Texas. These compete in a Reels feed — the viewer decides in the FIRST SECOND whether to keep watching. Slow establishing shots and a guy calmly looking at a panel are failures.\n\nWrite a single vivid, cinematic prompt (100-140 words) that:\n- OPENS ON THE DRAMA — the spark, the arc flash, the plunge into darkness, the lightning strike, the smoking outlet — in the very first moment, not after a build-up\n- Packs 3-4 fast cuts into 8 seconds: e.g. crash zoom on a sparking outlet → lights die across the whole house → worried faces lit by phone flashlight → electrician's boots striding in, tool bag swinging\n- Uses dynamic camera energy: whip pans, crash zooms, hard push-ins, handheld urgency — never a static tripod shot\n- Includes real spectacle scaled to the topic: arcing breakers, a breaker panel erupting in sparks, smoke curling from a scorched socket, a Texas storm hammering a dark neighborhood, an EV charger snapping to life with a glow\n- Shows human stakes (a family plunged into dark, a homeowner flinching from a popping outlet) and ends on the electrician arriving or the power surging triumphantly back on — lights blazing room by room\n- Matches the service and caption topic provided\n- Calls for punchy diegetic AUDIO (electrical crackle, thunder, breaker thunk, the hum of power returning) but no dialogue\n\nSTRICT — the finished video must contain NO readable text of any kind:\n- Do NOT name the business, its owner, its city, or its phone number in the prompt\n- Do NOT ask for logos on shirts, polos, vans, hats, patches, signs, storefronts, or paperwork\n- Do NOT ask for on-screen captions, subtitles, lower thirds, chyrons, or phone numbers\n- Wardrobe should be a plain solid-color work polo with no visible writing or emblem\n- Any incidental signs/labels in the scene must be unreadable or out of focus\n\nEnds with: Photorealistic, cinematic, 4K, high-energy fast-cut editing, dramatic atmosphere, plain unbranded wardrobe, absolutely no visible text or numbers anywhere in frame.\n\nOutput the prompt only. No explanation, no quotes, no title.` },
          { role: 'user', content: `Service: ${post.service}\nHook: ${post.hook}\nCaption:\n${caption}${post.video_prompt ? `\n\nScene idea from the content planner (rewrite it to be far more exciting — do not copy it):\n${post.video_prompt}` : ''}` },
        ],
      }),
    });
    const json = await res.json();
    if (json.error) {
      hopLog('facebook-poster→xai', 'warn', `prompt gen error: ${json.error.message} — using schedule prompt`);
      return post.video_prompt || null;
    }
    let prompt = json.choices?.[0]?.message?.content?.trim() || post.video_prompt || null;
    // The model sometimes drops the required style/no-text tail — enforce it ourselves.
    if (prompt && !/no visible text/i.test(prompt)) {
      prompt += ' Photorealistic, cinematic, 4K, high-energy fast-cut editing, dramatic atmosphere, plain unbranded wardrobe, absolutely no visible text or numbers anywhere in frame.';
    }
    return prompt;
  }
  ```
- [ ] Step: in the same file, find this exact line (currently line 920, indented with 6 spaces):
  ```js
      if (!prompt) throw new Error('video_prompt or video_file required for video posts (no OPENAI_API_KEY to generate one)');
  ```
  and replace it with (same 6-space indentation):
  ```js
      if (!prompt) throw new Error('video_prompt or video_file required for video posts (no XAI_API_KEY to generate one)');
  ```
- [ ] Step: verify no OpenAI references remain and the file parses:
  ```powershell
  Select-String -Path C:\Workspace\Active\SEO-Agents-App\scripts\facebook-poster.mjs -Pattern 'OPENAI_API_KEY|api\.openai\.com'
  node --check C:\Workspace\Active\SEO-Agents-App\scripts\facebook-poster.mjs
  ```
  Expected output: `Select-String` prints NOTHING (zero matches). `node --check` prints nothing and exits 0. If either shows output, STOP and report.
- [ ] Step: commit:
  ```powershell
  git -C C:\Workspace\Active\SEO-Agents-App add scripts/facebook-poster.mjs
  git -C C:\Workspace\Active\SEO-Agents-App commit -m "fix(fb-video): director rewrite via Grok chat on XAI_API_KEY — drops OpenAI dependency"
  ```
  Expected output: `1 file changed` with small insertion/deletion counts.

### Task 4: Swap mav-bridge's Day-1 prompt generator from OpenAI to Grok

**Files:** Modify `scripts\mav-bridge.mjs` (three surgical edits: the key constant near line 54, a comment near line 96, and the `generateDay1VideoPrompt` function near lines 158–196).

- [ ] Step: in `scripts\mav-bridge.mjs`, find this exact line (currently line 54):
  ```js
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  ```
  and replace it with:
  ```js
  const XAI_API_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
  ```
- [ ] Step: in the same file, find this exact comment line (currently line 96):
  ```js
  // 'mav-bridge→openai', 'mav-bridge→subprocess:facebook'.
  ```
  and replace it with:
  ```js
  // 'mav-bridge→xai', 'mav-bridge→subprocess:facebook'.
  ```
- [ ] Step: in the same file, replace the entire `generateDay1VideoPrompt` function — from the line `async function generateDay1VideoPrompt(scheduleFile) {` (currently line 158) through its closing `}` (currently line 196, the line immediately before `function writePendingPrompt(runId, prompt) {` and its blank line) — with this block:
  ```js
  async function generateDay1VideoPrompt(scheduleFile) {
    const text = fs.readFileSync(scheduleFile, 'utf8');
    const blocks = text.split(/\n\s*---\s*\n/).filter(b => b.includes('DAY:'));
    const day1 = blocks[0];
    if (!day1) return null;
    const get = (key) => {
      const m = day1.match(new RegExp(`^\\*{0,2}${key}:\\s*(.*?)\\s*$`, 'm'));
      return m ? (m[1] || '').replace(/\*\*/g, '').trim() : '';
    };
    const service = get('SERVICE');
    const hook = get('HOOK');
    const body = get('BODY');
    const cta = get('CTA');
    const hashtags = get('HASHTAGS');
    const caption = [hook ? `${hook}\n\n` : '', body, hashtags ? `\n\n${hashtags}` : '', cta ? `\n\n${cta}` : ''].join('').trim();

    if (!XAI_API_KEY) return get('VIDEO_PROMPT') || null;

    let res;
    try {
      res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XAI_API_KEY}` },
      body: JSON.stringify({
        model: 'grok-4.20-0309-non-reasoning', max_tokens: 300,
        messages: [
          { role: 'system', content: `You are a video director writing text-to-video generation prompts for Grizzly Electrical Solutions, a licensed residential and commercial electrician in DFW, Texas.\n\nWrite a single vivid, cinematic prompt (100-140 words) that:\n- Opens with an establishing shot that sets a relatable scene (home, family, business)\n- Builds tension around an electrical problem (flickering lights, sparking outlet, dead panel, etc.)\n- Includes a dramatic visual moment — arcing breakers, sparks, smoke, worried faces, a professional electrician arriving\n- Feels like a mini movie trailer — emotional, urgent, real\n- Matches the service and caption topic provided\n- Ends with: Photorealistic, cinematic, 4K, dramatic atmosphere, no text overlays.\n\nOutput the prompt only. No explanation, no quotes, no title.` },
          { role: 'user', content: `Service: ${service}\nHook: ${hook}\nCaption:\n${caption}` },
        ],
      }),
      });
    } catch (e) {
      // Tag the xAI hop so a network/DNS failure here is distinguishable from a bad response.
      throw new Error(`[mav-bridge→xai] request failed: ${e.message}`);
    }
    const json = await res.json();
    if (json.error) throw new Error(`[mav-bridge→xai] ${json.error.message || 'API error'}`);
    return json.choices?.[0]?.message?.content?.trim() || get('VIDEO_PROMPT') || null;
  }
  ```
  Note: the odd indentation of the `fetch(...)` argument block matches the original file — keep it as shown; it is valid JavaScript. The only intentional wording change inside the system prompt is "Veo 3 generation prompts" → "text-to-video generation prompts" (the backend is no longer Veo).
- [ ] Step: verify no OpenAI references remain and the file parses:
  ```powershell
  Select-String -Path C:\Workspace\Active\SEO-Agents-App\scripts\mav-bridge.mjs -Pattern 'OPENAI_API_KEY|api\.openai\.com|→openai'
  node --check C:\Workspace\Active\SEO-Agents-App\scripts\mav-bridge.mjs
  ```
  Expected output: zero matches from `Select-String`; nothing (exit 0) from `node --check`. If either shows output, STOP and report.
- [ ] Step: commit:
  ```powershell
  git -C C:\Workspace\Active\SEO-Agents-App add scripts/mav-bridge.mjs
  git -C C:\Workspace\Active\SEO-Agents-App commit -m "fix(mav-bridge): Day-1 video prompt via Grok chat on XAI_API_KEY"
  ```
  Expected output: `1 file changed`.

### Task 5: Install pytrends so Google Trends topic selection works

**Files:** Modify `pyproject.toml` and `uv.lock` (both changed automatically by `uv add` — do not hand-edit either).

- [ ] Step: install via uv from the repo root:
  ```powershell
  Set-Location C:\Workspace\Active\SEO-Agents-App
  uv add pytrends
  ```
  Expected output: ends with a `+ pytrends==<version>` line (any 4.x version) among resolved/installed packages. If uv reports a dependency conflict, STOP and report the full output — do not force or pin anything.
- [ ] Step: verify the import works inside the SAME venv the Friday task uses:
  ```powershell
  C:\Workspace\Active\SEO-Agents-App\.venv\Scripts\python.exe -c "from pytrends.request import TrendReq; print('pytrends ok')"
  ```
  Expected output: `pytrends ok`. (A pandas FutureWarning line before it is acceptable; an ImportError/ModuleNotFoundError is not.)
- [ ] Step: commit:
  ```powershell
  git -C C:\Workspace\Active\SEO-Agents-App add pyproject.toml uv.lock
  git -C C:\Workspace\Active\SEO-Agents-App commit -m "feat(weekly): install pytrends — Google Trends topic selection was silently falling back to rotation"
  ```
  Expected output: `2 files changed`.

### Task 6: Fix the GBP worker scheduled tasks (dedupe, add daily trigger, start)

**Files:** none (Windows Task Scheduler only). Requires an elevated (Administrator) PowerShell if the tasks were registered elevated — if a command below fails with "Access is denied", re-run that command in an elevated PowerShell and continue.

Background: two tasks run the identical worker at logon — `GBP Worker` (duplicate, delete it) and `Grizzly SEO GBP Worker` (keeper). The keeper gets a second daily trigger at 8:00 AM so the worker comes back after a crash/console-close without waiting for a re-logon. Its instance policy is IgnoreNew, so the extra trigger can never start a second copy. Do this AFTER Task 2 (stale rows already skipped) — safe: the worker only posts rows dated today.

- [ ] Step: delete the duplicate task:
  ```powershell
  Unregister-ScheduledTask -TaskName 'GBP Worker' -Confirm:$false
  Get-ScheduledTask -TaskName 'GBP Worker' -ErrorAction SilentlyContinue
  ```
  Expected output: the second command prints nothing (task gone).
- [ ] Step: rebuild the keeper's triggers as logon + daily 8:00 AM (this REPLACES the trigger list; actions and settings are untouched):
  ```powershell
  $logon = New-ScheduledTaskTrigger -AtLogOn -User 'CARTERSPC\carte'
  $daily = New-ScheduledTaskTrigger -Daily -At '8:00AM'
  Set-ScheduledTask -TaskName 'Grizzly SEO GBP Worker' -Trigger @($logon, $daily)
  (Get-ScheduledTask -TaskName 'Grizzly SEO GBP Worker').Triggers | ForEach-Object { $_.CimClass.CimClassName }
  ```
  Expected output: the last command prints exactly two lines: `MSFT_TaskLogonTrigger` and `MSFT_TaskDailyTrigger`.
- [ ] Step: start the worker now and confirm it is running:
  ```powershell
  Start-ScheduledTask -TaskName 'Grizzly SEO GBP Worker'
  Start-Sleep -Seconds 5
  (Get-ScheduledTask -TaskName 'Grizzly SEO GBP Worker').State
  ```
  Expected output: `Running`. If it prints `Ready` instead, STOP and report the result of `Get-ScheduledTaskInfo -TaskName 'Grizzly SEO GBP Worker'`.

### Task 7: Restore PM2 apps and fix the saved process list

**Files:** none (PM2 state only). Reminder from the primer: the ONLY pm2 commands allowed are `pm2 ls`, `pm2 start`, and `pm2 save`. NEVER restart/stop/delete/reload anything — especially `qwen3-llama` (the local LLM, possibly the model executing this plan) and `llama-guardian`.

Do this AFTER Tasks 3–4 so mav-bridge boots with the new Grok code.

- [ ] Step: point the shell at the shared PM2 home and look (read-only) at current state:
  ```powershell
  $env:PM2_HOME = 'C:\ProgramData\pm2'
  pm2 ls
  ```
  Expected output: a table containing `qwen3-llama` and `llama-guardian` with status `online`. Other apps (mav-bridge, mav-console, …) are absent or stopped — that is the problem being fixed.
- [ ] Step: start every app defined in the MCC ecosystem file:
  ```powershell
  pm2 start C:\Workspace\Active\MCC\ecosystem.config.cjs
  ```
  Expected output: PM2 prints an ERROR like `Script already launched` for `qwen3-llama` — that is EXPECTED and correct (it refuses to touch the running LLM); do not retry it. The other apps (`mav-console`, `prometheus-sync`, `downloads-watcher`, `mav-bridge`, `maverickforge`, `mcc-dashboard-agent`) appear in the final table as `online`.
- [ ] Step: persist the now-correct process list so the auto-resurrect supervisor restores everything after a crash or reboot:
  ```powershell
  pm2 save
  Select-String -Path C:\ProgramData\pm2\dump.pm2 -Pattern '"mav-bridge"' -Quiet
  ```
  Expected output: `pm2 save` prints `Successfully saved` with the dump path `C:\ProgramData\pm2\dump.pm2`; `Select-String` prints `True`.
- [ ] Step: verify the two service ports answer:
  ```powershell
  Start-Sleep -Seconds 10
  Test-NetConnection 127.0.0.1 -Port 8790 -InformationLevel Quiet
  Test-NetConnection 127.0.0.1 -Port 3000 -InformationLevel Quiet
  ```
  Expected output: `True` twice (mav-bridge on 8790, mav-console on 3000). If either is `False`, run `pm2 ls` and STOP with the table pasted into your report — do not restart anything.

### Task 8: Final verification

**Files:** none.

- [ ] Step: full status sweep, all read-only:
  ```powershell
  git -C C:\Workspace\Active\SEO-Agents-App log --oneline -4
  (Get-ScheduledTask -TaskName 'Grizzly SEO GBP Worker').State
  Get-ScheduledTask -TaskName 'GBP Worker' -ErrorAction SilentlyContinue
  pm2 ls
  Test-NetConnection 127.0.0.1 -Port 8790 -InformationLevel Quiet
  C:\Workspace\Active\SEO-Agents-App\.venv\Scripts\python.exe -c "from pytrends.request import TrendReq; print('pytrends ok')"
  ```
  Expected output: the git log's top three commits are (newest first) the pytrends commit, the mav-bridge commit, and the facebook-poster commit from Tasks 5, 4, 3; task state `Running`; nothing printed for the deleted `GBP Worker`; pm2 table with mav-bridge/mav-console/qwen3-llama all `online`; `True`; `pytrends ok`.
- [ ] Step: confirm the stale rows really are skipped (read-only Supabase REST check, no file created; the key is read from `.env` into variables and never printed):
  ```powershell
  Set-Location C:\Workspace\Active\SEO-Agents-App
  $envMap = @{}
  Get-Content .env | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)=(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() } }
  $headers = @{ apikey = $envMap['SUPABASE_SERVICE_KEY']; Authorization = "Bearer $($envMap['SUPABASE_SERVICE_KEY'])" }
  $rows = Invoke-RestMethod -Uri "$($envMap['SUPABASE_URL'])/rest/v1/weekly_posts?platform=eq.gbp&run_id=eq.03df29fa-957a-48fc-8ead-e06bed923b22&select=day,post_date,status&order=day" -Headers $headers
  $rows | ForEach-Object { "day $($_.day) $($_.post_date) $($_.status)" }
  ```
  Expected output: seven lines, day 1 through day 7. Day 1 is `posted`. Days 2–6 (2026-07-04 … 2026-07-08) are `skipped`. Day 7 (2026-07-09) is `scheduled`, `posted`, or `skipped` depending on when this plan is executed — any of those three is a pass.
- [ ] Step: report to Carter with this manual checklist (things only a human at the machine can do):
  1. **Google Drive mount:** `Test-Path 'H:\My Drive\GBP Photos'` — if `False`, launch Google Drive for Desktop from the Start menu and sign in; the GBP photo cache has been stale since ~June 17.
  2. **Tomorrow (Friday 2026-07-10) after 8:30 AM:** check `outputs\weekly-runner-health.json` in the repo — the topic source should now say pytrends/trending instead of rotation fallback.
  3. **After approving the run in the MCC dashboard:** the approve button POSTs to mav-bridge on :8790, which is now up. If approval errors, read the log file `C:\ProgramData\pm2\logs\mav-bridge-out.log` (do not use `pm2 logs` — it streams and blocks the terminal).

No commits in Tasks 6–8. Done.

