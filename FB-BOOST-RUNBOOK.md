# FB Boost Runbook — weekly automated boost application

**Primary path (2026-08-17+):** Meta **Marketing API** via `scripts/fb-boost-api.mjs`,
driven daily from **mav-bridge** after Facebook reconcile. Ledger-gated.

**Rollback path:** Playwright Boost UI (steps below) if the API path is broken
or credentials are not ready. Claude/`fb-boost-weekly` cron may still use UI.

**This spends real money.** Every dollar must pass through
`scripts/fb-boost-ledger.mjs` before any ad is created or Publish is clicked —
the ledger enforces the hard $50/week cap in code.

Carter's standing authorization (2026-08-02 session): apply the crew's
recommended boost each week automatically, within the $50 weekly cap, with an
SMS confirmation after every publish. No per-boost chat approval is needed —
the ledger + the gates below are the approval.

---

## Primary path — Marketing API (`fb-boost-api.mjs`)

### One-time setup
1. Create / note the Grizzly **ad account** id (`act_…`) in Meta Business Suite.
2. Issue a long-lived token (system user preferred) with `ads_management` and
   page access for `FB_PAGE_ID`. Prefer a dedicated `FB_ADS_ACCESS_TOKEN`; the
   page token is only a fallback if it can manage ads.
3. In repo `.env` (never commit secrets):
   ```
   FB_BOOST_API=1
   FB_AD_ACCOUNT_ID=act_…
   FB_ADS_ACCESS_TOKEN=…
   ```

**Two tokens, two jobs (2026-08-17).** The run needs *both*
`FB_ADS_ACCESS_TOKEN` and `FB_PAGE_ACCESS_TOKEN`. Page reads
(`/{page}/published_posts`, post-exists verify) require a **Page** token —
a system-user ads token gets `(#210) A page access token is required`. Campaign
/ ad set / creative / ad writes and `/search?type=adinterest` require the **ads**
token. `readBoostConfig` exposes both (`cfg.token`, `cfg.pageToken`);
`fb-boost-api.mjs` builds a separate `pageClient`. `pageToken` falls back to
`token` so the old single-token setup still works. Do **not** replace
`FB_PAGE_ACCESS_TOKEN` with a system-user page token — the `seo-boost` system
user has `pages_read_engagement` but **not** `pages_manage_posts`, so the poster
would break.
4. Optional: `FB_BOOST_CAMPAIGN_ID` to reuse a standing campaign.

**Ad account time zone is `America/Los_Angeles`, the pipeline schedules on
`America/Chicago`.** `act_30224457` was created 2008-08-10 with `timezone_id 1`.
Currency and time zone are **create-only** in the Marketing API and locked in
the UI once an account has spend — there is no setting to change, and the Ad
account setup page no longer displays one. Accepted as-is on 2026-08-17.

Consequence: Meta's budget day rolls over at **10pm Central**, not midnight, so
a `$25/day` budget is attributed on Pacific day boundaries. This does **not**
weaken the cap — `fb-boost-ledger.mjs` reserves before any create and is
timezone-independent, and ad sets carry explicit `start_time`/`end_time` so Meta
prorates partial days. Only spend *attribution by calendar day* shifts 2 hours.

If it ever needs fixing, change the budget-boundary math to
`America/Los_Angeles` to match the account. Do **not** create a replacement ad
account for this — that costs a re-claim into the portfolio, re-assigning
`seo-boost`, re-adding billing, and losing delivery history.
5. Confirm payment method / prepaid funds ≥ next boost total (same Rule 5 spirit
   as the UI path — API will fail closed if Meta rejects billing).

### Daily automation
mav-bridge (after 9:00 America/Chicago, once per day) runs:

```
node scripts/fb-boost-api.mjs run
```

Pipeline (fail closed at each gate):
1. `fb-boost-ledger.mjs eligible` — schedule + summary + $50 cap
2. Resolve live Graph post (date + caption tokens; `--force-post` override)
3. Verify object exists
4. `ledger reserve` **before** any Marketing API create
5. Campaign (or reuse) → ad set (Dallas + 20 mi, ages/interests) → creative
   (`object_story_id`) → ad `ACTIVE`
6. `ledger publish` + Hermes SMS

### Ad set shape — do not change without checking a working boost

Went live 2026-08-17. The ad set **must** carry all three of these together:

```
objective         OUTCOME_ENGAGEMENT     (campaign)
optimization_goal POST_ENGAGEMENT
destination_type  ON_POST
promoted_object   {"page_id": FB_PAGE_ID}
```

`destination_type: ON_POST` is the load-bearing one. It sets the conversion
location to the post. Drop it and Meta guesses, and fails in one of two ways
that look unrelated:

- with `promoted_object` → `(#100) subcode 2490408` "Performance goal isn't
  available … with your campaign objective"
- without `promoted_object` → `(#100) subcode 1487888` "Tracking Pixel Required"

Both are really the same missing field. Two live runs burned on this.

Also: `targeting.targeting_automation.advantage_audience = 0`. Advantage+
audience is **on by default** and caps `age_min` at 25, which rejects the 28-65
range with subcode `1870188`. (The Boost UI dodges this by sending `age_min 25`
plus `age_range [28,65]`; we opt out instead and get real 28+ targeting.)

**`execution_options: ['validate_only']` is not trustworthy here** — it passed a
config that then failed on real create. Verify against a real boost's ad set
instead: `GET /<adset_id>?fields=optimization_goal,billing_event,destination_type,promoted_object,targeting`.

Failed runs leave an orphan campaign (and sometimes an ad set) behind, because
creation is not transactional. Neither delivers without an ad, so neither
spends, but check `/<act>/campaigns` after any failure and set stragglers to
`DELETED`.

### Manual commands
```
node scripts/fb-boost-api.mjs status
node scripts/fb-boost-api.mjs resolve-post
node scripts/fb-boost-api.mjs run --dry-run
node scripts/fb-boost-api.mjs run --force-post 108252941997164_…
# Live (only when FB_BOOST_API=1 and ad account configured):
node scripts/fb-boost-api.mjs run
```

Dry-run never reserves and never creates ads. Without `FB_BOOST_API=1` the run
exits with code 2 (config) even if eligible.

### Disable
- `FB_BOOST_API=0` (or unset) — API will not spend
- `MAV_BRIDGE_FB_BOOST=0` — bridge skips the daily tick entirely
- Ledger `REFUSED` — no spend

---

## Rollback path — Boost UI (Playwright / Claude)

## Hard rules — never violate

1. **Never click Publish without a successful `ledger reserve`.** If reserve
   exits non-zero, stop and go to Escalation.
2. **Never boost a post you have not verified live** via the Graph API.
3. **Never exceed the schedule's stated boost for a post** (daily × days). If
   the schedule is ambiguous about amounts, escalate instead of guessing.
4. **Location is always Dallas + 20 mi** (Carter's standing override) — ignore
   the schedule's Rowlett/other center. Ages and interests come from the
   schedule's BOOST_TARGETING.
5. If the UI does not match this runbook in a way you can't confidently adapt
   to, or prepaid "Funds available" is less than the boost total, **do not
   publish** — Escalation.
6. One boost per task run. If the schedule allocates a second boost later in
   the week, a later daily run handles it.

## Step 1 — should anything happen today?

```
cd C:/Workspace/Active/SEO-Agents-App
node scripts/fb-boost-ledger.mjs eligible
```

If the output is `eligible: false`, exit quietly — no browser, no SMS. There is
nothing to boost today. This replaces the old approach of blindly running daily
and hoping the schedule had work.

If `eligible: true`, the output includes `pick` (key, date, daily, days, total,
and `source`: `summary` when the amounts came from the authoritative BOOST
BUDGET SUMMARY, `post-fields` when no summary section exists). Proceed to
Step 2 with that pick.

`eligible` already cross-checks the summary and **fails closed** — it will
return `eligible: false` with a "human review required" reason when the summary
is unparseable, or when the crew deferred the allocation to a judgement call
(either-or wording like "whichever performs better", or YES rows totalling more
than the cap — the week of 8/07 did exactly this). In those cases the crew has
NOT made a machine-followable decision: do not boost, and do not try to pick a
winner yourself. Send Carter one SMS noting the schedule needs his call, then
stop. Only send that SMS once per week — check the ledger entries first so a
daily re-run doesn't text him repeatedly about the same schedule.

The old `status` check (below) is still useful for inspecting the overall budget
state, but `eligible` is the gate that decides whether the rest of the runbook
should run at all:
```
node scripts/fb-boost-ledger.mjs status
```

## Step 2 — interpret the recommendation

Read `outputs/facebook_posting_schedule.md`:
- Per-post `BOOST*` fields give candidates (`BOOST: yes:$N`, amount, duration,
  targeting).
- The **BOOST BUDGET SUMMARY section at the bottom is authoritative** and
  overrides per-post fields — both the yes/no decision AND the amounts. The
  crew often writes a "Revised decision" / "Corrected Allocation" there when
  per-post fields conflict with the $50 cap (e.g. week of 7/31: two posts each
  marked $25×2d, summary gave the full $50 to Day 1 and $0 to Day 3). Follow
  the summary's final allocation. `eligible` enforces this in code, so its
  `pick` already reflects the summary; use the pick's amounts, not the
  per-post fields.
- `BOOST: maybe` or blank amounts = NOT a boost instruction. Skip.
- Cross-check `entries` from ledger status so you never re-boost a post
  (entries carry `post_id` and `key`).

Pick the next unapplied allocation whose post date (DAY-TOPIC BINDING table)
is today or past.

## Step 3 — verify the post is live

Get the real FB post id via the Graph API (creds in repo `.env`):

```
node -e "const fs=require('fs');const env=Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).map(l=>l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2].trim()]));fetch('https://graph.facebook.com/v22.0/'+env.FB_PAGE_ID+'/published_posts?fields=id,message,created_time,attachments{media_type,target}&limit=10&access_token='+env.FB_PAGE_ACCESS_TOKEN).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,1)))"
```

Match by created_time (the post's scheduled day, ~9 AM) and caption keywords
from the schedule. Beware: the third-party Surefire Local app also auto-posts
to this page — its posts have no phone number and are NOT crew posts. If the
target post is not found live, exit quietly (it may post later today; tomorrow's
run retries) — but if the post's date was yesterday or older, escalate instead.

## Step 4 — reserve the budget (the money gate)

```
node scripts/fb-boost-ledger.mjs reserve --key <dayN-slug> --post <fb_post_id> --daily <N> --days <N>
```

Non-zero exit = REFUSED = stop, escalate. Never work around a refusal.

## Step 5 — apply the boost in the FB UI

Proven Playwright pattern (persistent logged-in profile, same as
facebook-poster):

1. Keep-alive script (run_in_background):
   `chromium.launchPersistentContext(path.join(os.homedir(),'.claude','fb-session'), { headless:false, viewport:{width:1440,height:900}, args:['--remote-debugging-port=9223'] })`,
   then `page.goto` the post/reel URL and hang forever.
2. Drive step-by-step via `chromium.connectOverCDP('http://127.0.0.1:9223')`,
   picking the page whose URL includes facebook.com.
3. "Boost post" / "Boost reel" is role=**link** on the post page. It opens
   `facebook.com/ad_center/create/boostpost/...`.
4. Composer settings:
   - **Goal:** Automatic (default — leave).
   - **Audience:** open "Edit Advantage+ audience":
     - Age sliders are `role=slider` divs (`aria-label` "Slider to pick
       min/max age for targeting, minimum value" etc.): focus, then Arrow keys
       while polling `aria-valuenow` until at target (min age per schedule,
       usually 28; max 65+).
     - Location: type in the Locations box: `fill('Dallas, Texas')` → wait
       3.5 s → ArrowDown → Enter. "United States" in the list is the country
       group HEADER, not a chip — only actual chips have Remove buttons.
       Radius slider (`aria-label` "Change radius"): focus + ArrowLeft/Right
       to **20 mi** — it defaults to **25 mi**, so this is never a no-op.
       Whether "United States" is a removable chip varies: on 8/07 it was one,
       and adding Dallas replaced it automatically with no explicit remove.
       Confirm the final chip list is exactly the location you intended.
     - Interests: suggested chips under Detailed targeting are sometimes
       directly clickable (`role=button` with the interest text); otherwise
       search box + keyboard (fill → wait 3 s → ArrowDown → Enter). Interest
       *exclusion* is unavailable in the boost UI — skip "Exclude" hints.
     - **VERIFY THE CHIP after every keyboard add — never trust blind
       ArrowDown+Enter.** The dropdown does not stay empty on a no-match term;
       it falls back to unrelated *behavior/demographic* options and Enter
       silently selects one. Real case (8/07): the schedule asked for
       "Portable generators", FB had no such interest, and ArrowDown+Enter
       added **"Facebook access (mobile): all mobile devices"** — a device
       restriction nobody asked for, which would have cut every desktop user
       from the audience.

       After each add, re-enumerate the chips and confirm the new one is a
       plausible match for the term you typed:
       ```js
       const chips = async () => (await Promise.all(
         (await page.getByRole('button').all()).map(async (el) =>
           (await el.getAttribute('aria-label').catch(() => '')) || '')
       )).filter((al) => /^Remove/i.test(al));

       const before = await chips();
       /* fill → wait 3 s → ArrowDown → Enter */
       const added = (await chips()).filter((c) => !before.includes(c));
       // 0 added  = no match; fine, move on (don't retry — retry re-triggers the fallback)
       // 1 added  = check it loosely matches the term; if not, click its Remove and move on
       ```
       Terms that produced no match are **not** an error — drop them and note
       it. A wrong chip that survives to Publish is the real failure, and it is
       invisible in the Payment summary, so nothing downstream will catch it.
       The same trap applies to the Locations box.
     - Save audience (`role=button`, name **"Save audience"** — the dialog has
       no plain "Save"). Then re-read "Audience details" on the main composer
       and confirm location, age range, and interests all read back correctly.
   - **Duration:** click "Choose end date" (radio labels are empty — click the
     text node), then set the `input[type=number]` Days field (defaults to 7!)
     to the schedule's days via triple-click + fill + Tab.
   - **Daily budget:** text input, verify it equals the schedule amount
     (e.g. "25.00"); FB carries over the previous boost's value.
   - **Payment:** confirm "Funds available: $X" ≥ boost total (prepaid; the
     Visa on file only charges past the prepaid balance).
5. Verify the on-page **Payment summary** shows exactly
   `$<daily> a day x <days> days` / total = reserved amount, and Audience
   details show Dallas (+20 mi) + expected ages/interests. Screenshot to
   `outputs/`.
6. Click **Publish** (bottom-right `role=button`). Success = "Ad in review"
   dialog: "Your ad is being created", Status: In review, with matching Total
   budget. Screenshot it.

## Step 6 — record and notify

```
node scripts/fb-boost-ledger.mjs publish --key <dayN-slug>
node scripts/fb-boost-ledger.mjs notify "[FB Boost] Published <post name>: $<daily>/day x <days>d = $<total>. Status: In review. Week <week> remaining: $<remaining>."
```

Then stop the keep-alive browser task and delete any temp scripts you created.

## Escalation (any failed gate, refusal, or surprise)

```
node scripts/fb-boost-ledger.mjs fail --key <dayN-slug> --note "<what happened>"   # only if reserved
node scripts/fb-boost-ledger.mjs notify "[FB Boost] NOT applied: <reason>. Manual review needed."
```

Never retry Publish after an ambiguous state — a double-click risks two ads.
Check Ad Center manually first (via the same CDP browser) to see whether an ad
was created before deciding anything.

## History

- 2026-08-07: Day 1 Generator Interlock (slideshow, posted as a reel object —
  post `108252941997164_1029168739903021`), $25×2d=$50, published, In review.
  Notes: (a) the morning run correctly **halted** — the Day 1 asset was still
  being produced and the 9 AM slot held a carried-over EV-charger reel, so the
  Step 3 verify-live gate did its job; (b) the crew's schedule dropped
  `**Start Date:**` (now `**Week of August 7–12, 2026**`), which failed the
  ledger's week parse *closed* until the parser gained fallbacks; (c) **funds
  gate hit** — prepaid was $25.29 against a $50 total, and Carter explicitly
  authorized the Visa to cover the ~$24.71 remainder in chat. Rule 5 still
  stands: an unattended run must escalate here, not self-authorize the card;
  (d) the Detailed-targeting mis-selection that produced the VERIFY THE CHIP
  step above.
- 2026-08-01: Day 1 Panel Upgrade Reel, $25×2d=$50, published manually by
  Claude with Carter's chat approval (ledger seeded retroactively).
- 2026-07-22: Day 1 generator post $25×1d published; Day 5 one-shot scheduled
  task fired early (7/22 instead of 7/24) and correctly stopped at the
  verify-live gate — the origin of Step 3.
