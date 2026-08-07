# FB Boost Runbook — weekly automated boost application

Procedure for the `fb-boost-weekly` scheduled task (daily, 10:00 AM). It reads
the crew's boost recommendation from `outputs/facebook_posting_schedule.md` and
applies it through the Facebook Boost UI. **This spends real money.** Every
dollar must pass through `scripts/fb-boost-ledger.mjs` before Publish is
clicked — the ledger enforces the hard $50/week cap in code.

Carter's standing authorization (2026-08-02 session): apply the crew's
recommended boost each week automatically, within the $50 weekly cap, with an
SMS confirmation after every publish. No per-boost chat approval is needed —
the ledger + the gates below are the approval.

## Hard rules — never violate

1. **Never click Publish without a successful `ledger reserve`.** If reserve
   exits non-zero, stop and go to Escalation.
2. **Never boost a post you have not verified live** via the Graph API.
3. **Never exceed the schedule's stated boost for a post** (daily × days). If
   the schedule is ambiguous about amounts, escalate instead of guessing.
4. **Location is always Dallas + 15 mi** (Carter's standing override) — ignore
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

If `eligible: true`, the output includes `pick` (key, date, daily, days, total).
Proceed to Step 2 with that pick.

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
  overrides per-post fields. The crew often writes a "Revised decision" /
  "Corrected Allocation" there when per-post fields conflict with the $50 cap
  (e.g. week of 7/31: two posts each marked $25×2d, summary gave the full $50
  to Day 1 and $0 to Day 3). Follow the summary's final allocation.
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
       to **15 mi**.
     - Interests: suggested chips under Detailed targeting are sometimes
       directly clickable (`role=button` with the interest text); otherwise
       search box + keyboard (fill → wait 3 s → ArrowDown → Enter). Interest
       *exclusion* is unavailable in the boost UI — skip "Exclude" hints.
     - Save audience.
   - **Duration:** click "Choose end date" (radio labels are empty — click the
     text node), then set the `input[type=number]` Days field (defaults to 7!)
     to the schedule's days via triple-click + fill + Tab.
   - **Daily budget:** text input, verify it equals the schedule amount
     (e.g. "25.00"); FB carries over the previous boost's value.
   - **Payment:** confirm "Funds available: $X" ≥ boost total (prepaid; the
     Visa on file only charges past the prepaid balance).
5. Verify the on-page **Payment summary** shows exactly
   `$<daily> a day x <days> days` / total = reserved amount, and Audience
   details show Dallas (+15 mi) + expected ages/interests. Screenshot to
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

- 2026-08-01: Day 1 Panel Upgrade Reel, $25×2d=$50, published manually by
  Claude with Carter's chat approval (ledger seeded retroactively).
- 2026-07-22: Day 1 generator post $25×1d published; Day 5 one-shot scheduled
  task fired early (7/22 instead of 7/24) and correctly stopped at the
  verify-live gate — the origin of Step 3.
