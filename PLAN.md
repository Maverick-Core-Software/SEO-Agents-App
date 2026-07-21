# PLAN.md: Facebook Engagement Optimization for Grizzly Electrical Solutions

**Run ID:** fb-engagement-20260716
**Date:** 2026-07-16
**Pipeline Depth:** Research + Plan (awaiting approval)
**Research Package:** Three research reports at `C:\Workspace\Active\pi-agents\`

---

## Executive Summary

Grizzly Electrical's Facebook page (187 followers) gets **zero engagement** across all posts. The root cause is NOT content quality — the copy is good. The problem is a convergence of:

1. **7 posts/week with 187 followers** — algorithm sees high volume + zero engagement = low-quality page, suppresses everything
2. **Uniform hook→story→"Call us at 555-XXXX" format** — Facebook's 2026 algorithm penalizes repetitive broadcast content and suppresses posts with phone-number sales CTAs
3. **No conversation triggers** — followers have nothing to comment on, save, or share
4. **Page organic reach is 2-6%** — 4-11 people see each post. Facebook Groups deliver 30-60% reach
5. **No seed engagement network** — no initial likes/comments to signal to the algorithm that content is worth distributing

**This plan addresses all five root causes with 6 sessions across 3 waves. No new subscriptions required — all changes are to existing CrewAI prompts and Node.js scripts. Boost budget locked at $50/week — the CrewAI agent decides how to distribute it across posts.**

---

## Codebase Primer

### Key Files

| File | Lines | Role |
|------|-------|------|
| `src/seo_agents/crew.py` | ~1230 | **PRIMARY TARGET** — `build_facebook_crew()` generates schedule with content instructions |
| `scripts/facebook-poster.mjs` | ~1214 | Facebook posting: prompt rewrite, video gen, Graph API upload, `buildCaption()` |
| `scripts/mav-bridge.mjs` | ~1350 | Pipeline orchestrator: Supabase bridge, executes approved runs |
| `outputs/facebook_posting_schedule.md` | ~147 | Intermediate format between generator and executor |
| `src/seo_agents/main.py` | ~1380 | Weekly runner, orchestrates research → schedule generation |

### Architecture Flow

```
crew.py (CrewAI/GPT-4o) → facebook_posting_schedule.md (7 posts)
    ↓
mav-bridge.mjs → Supabase poll → pick up approved items
    ↓
facebook-poster.mjs → parseSchedule() → buildCaption() → graphDispatch()
    ↓
Facebook Graph API (/{page-id}/feed, /{page-id}/photos, /{page-id}/videos)
```

### Conventions
- Node.js ESM (`.mjs`) for scripts, Python (CrewAI) for content generation
- `hopLog()` for structured logging in facebook-poster.mjs
- `buildCaption(post)` assembles final caption from hook + body + hashtags + CTA
- `parseSchedule()` reads markdown schedule, returns array of post objects
- `graphDispatch()` routes `post.type` → correct Graph API endpoint
- CrewAI uses OpenAI GPT-4o via `build_exec_llm()`
- `DAY_TOPIC_BINDING_RULE` keeps Facebook and GBP on the same daily topic

### Current Caption Assembly (facebook-poster.mjs, ~line 260)

```javascript
function buildCaption(post) {
  const parts = [];
  if (post.hook) parts.push(post.hook);
  if (post.body) parts.push(`\n${post.body}`);
  if (post.hashtags) parts.push(`\n\n${post.hashtags}`);
  if (post.cta) parts.push(`\n\n${post.cta}`);
  return parts.join('').trim();
}
```

The CTA (e.g. "Call us today at (469) 863-9804") is included inline in EVERY post's caption — this is what Facebook suppresses.

---

## Wave 1: Foundation — Content Strategy Overhaul (3 Parallel Sessions)

All three sessions touch different files and have no inter-session dependencies. They can run in parallel.

### Session 1: Overhaul crew.py Facebook Content Instructions

**File:** `src/seo_agents/crew.py` — `build_facebook_crew()` function (lines 970–1110)
**Executor:** Claude Code (bridge) — nuanced prompt engineering
**Context estimate:** ~25k tokens

#### Background

The current `build_facebook_crew()` generates 7 posts/week (3 video + 3 photo + 1 text) all with phone-number CTAs. Research shows this uniform broadcast format gets suppressed by Facebook's 2026 algorithm. The fix requires changing the prompt instructions that CrewAI's GPT-4o agent follows — NOT changing the agent itself.

#### Tasks

1. **Reduce posting frequency from 7 to 4 posts/week**

   In the `fb_context` string (line 1005), change:
   ```python
   "VIDEO DAYS: Days 1, 4, and 7 must be VIDEO posts. Day 5 must be a TEXT-only post..."
   ```
   To:
   ```python
   "POSTING DAYS: 4 posts per week — Mon (Day 1), Wed (Day 3), Fri (Day 5), Sat (Day 6). "
   "Day 1 is VIDEO (Reel), Day 3 is PHOTO or CAROUSEL, Day 5 is VIDEO (Reel), Day 6 is PHOTO or TEXT."
   ```

2. **Add content format variety requirements**

   After the "TONE RULES" section (line 1044), add a new "CONTENT FORMAT VARIETY (mandatory)" section:

   ```python
   "CONTENT FORMAT VARIETY (mandatory — avoid algorithm suppression):\n"
   "- Each post MUST use a DIFFERENT content format from the last. Never repeat the same "
   "format twice in a row (e.g. not two 'hook→story→CTA' posts consecutively).\n"
   "- Rotate through these formats across the week:\n"
   "  1. Before/After transformation (photo or video): Show problem then solution\n"
   "  2. Educational/How-To: Teach something useful (signs of failing panel, GFCI basics)\n"
   "  3. Behind-the-Scenes/Day-in-the-Life: Team member at work, loading the van, job walkthrough\n"
   "  4. Interactive/Question: Poll, 'this or that', 'what would you do', fill-in-the-blank\n"
   "  5. Social Proof/Testimonial: Customer story, completed job showcase, review highlight\n"
   "  6. Humor/Personality: Trade humor, relatable electrical fails, 'caption this'\n"
   "- 50% of posts must be educational/value-first, 30% social proof/personality, 20% interactive\n"
   "- 0% direct sales pitches — the CTA should invite conversation, not quote a phone number\n"
   ```

3. **Replace phone-number CTAs with engagement CTAs**

   Change the CTA rule (line 1047-1048):
   ```python
   # OLD:
   "- CTA is specific: 'Call us today', 'DM us for a free quote', 'DM \"PANEL\" for a free estimate'. "
   "DM-based CTAs perform better on Reels because Meta rewards DM engagement.\n"
   
   # NEW:
   "- CTA is an ENGAGEMENT invitation, NOT a sales pitch. Rotate through:\n"
   "  * 'Save this for your next panel inspection'\n"
   "  * 'Tag a homeowner who needs to see this'\n"
   "  * 'Drop a 👍 if this has ever happened to you'\n"
   "  * 'Which would you choose — left panel or right? 👇'\n"
   "  * 'Share this with someone whose house was built before 1980'\n"
   "  * 'What's the weirdest electrical issue you've had at home? Tell us below'\n"
   "- Business phone number goes in a separate CONTACT field (add to format below), "
   "NOT in the caption CTA. The poster script will post it as the first comment.\n"
   ```

4. **Add CONTACT field to output format**

   In the format specification (lines 1080-1091), add a CONTACT field:
   ```python
   "CONTACT: [business phone/contact info — goes in the first comment, not caption]\n"
   ```
   
   Place it after HASHTAGS and before PHOTO_FILE.

5. **Add POST_GOAL field to output format**

   Add a POST_GOAL field that tells the poster what this post should achieve:
   ```python
   "POST_GOAL: [engagement | education | social_proof | entertainment]\n"
   ```
   
   This drives analytics tracking and boost decisions.

6. **Update VIDEO_PROMPT instructions for algorithm-optimized Reels**

   The current video instructions (lines 1054-1071) are technically correct for AI video quality but missing algorithm optimization. Add:
   ```python
   "- REEL LENGTH: 15-25 seconds (not 8). Facebook's algorithm favors Reels "
   "in the 15-30 second range. The video generator will be told 15s.\n"
   "- ON-SCREEN TEXT: Every Reel must include text overlays for the hook and key points — "
   "most Facebook users watch without sound. Describe what text should appear on screen.\n"
   "- FIRST 1.5 SECONDS: The VIDEO_PROMPT must describe an instant visual hook — "
   "a sparking outlet, a burnt wire, a dramatic before/after reveal. No establishing shots.\n"
   ```

7. **Remove HASHTAGS requirement (negligible reach impact on Facebook)**

   Research shows hashtags have minimal impact on Facebook distribution. Remove the HASHTAGS requirement and reallocate that space to keyword-rich captions:
   ```python
   # OLD:
   "- HASHTAGS: 5-8 tags. Always include #DFW or #Dallas, one service tag, one brand tag (#GrizzlyElectrical)\n"
   
   # NEW:
   "- HASHTAGS: 2-3 max (optional). Facebook hashtags have minimal reach impact. "
   "Prioritize keyword-rich body text over hashtag stuffing.\n"
   ```

#### Verification

```bash
# Syntax check
PYTHONPATH="" .venv/Scripts/python.exe -c "from seo_agents.crew import build_facebook_crew; print('OK')"

# Run existing tests (no regressions)
PYTHONPATH="" .venv/Scripts/python.exe -m pytest tests/ -q -x --basetemp=/tmp/pytest-tmp -p no:cacheprovider
```

#### Commit Message
```
feat: overhaul Facebook content strategy — 4 posts/week, engagement CTAs, format variety, algorithm optimization
```

---

### Session 2: Update facebook-poster.mjs — CTA Handling + First Comment + Engagement Tracking

**File:** `scripts/facebook-poster.mjs`
**Executor:** Claude Code (bridge) — multiple function changes
**Context estimate:** ~35k tokens
**Depends on:** Session 1 (new schedule format with CONTACT field and POST_GOAL)

#### Tasks

1. **Strip phone-number CTAs from `buildCaption()` and move to first comment**

   Modify `buildCaption()` (around line 260) to EXCLUDE the CTA field and INCLUDE a new `contact` field:
   
   ```javascript
   function buildCaption(post) {
     const parts = [];
     if (post.hook) parts.push(post.hook);
     if (post.body) parts.push(`\n${post.body}`);
     // HASHTAGS: keep but minimize (Session 1 reduces to 2-3)
     if (post.hashtags) parts.push(`\n\n${post.hashtags}`);
     // CTA: only include if it's an ENGAGEMENT CTA (no phone numbers)
     if (post.cta && !hasPhoneNumber(post.cta)) parts.push(`\n\n${post.cta}`);
     return parts.join('').trim();
   }
   
   function hasPhoneNumber(text) {
     return /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text);
   }
   ```

2. **Post business contact as first comment after publishing**

   After `graphDispatch()` succeeds, post the contact info as a comment:
   
   ```javascript
   async function postFirstComment(postId, contactText) {
     if (!contactText) return;
     const body = new URLSearchParams({
       message: contactText,
       access_token: FB_PAGE_ACCESS_TOKEN,
     });
     await fetch(
       `https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}/comments`,
       { method: 'POST', body }
     );
   }
   ```
   
   Call this in `graphDispatch()` after successful post:
   ```javascript
   const { id, media, fallback } = await graphDispatch(post, caption, videoPath, scheduleUnix);
   if (id && post.contact) {
     await postFirstComment(id, post.contact).catch(e =>
       hopLog('facebook-poster→graph', 'warn', `First comment failed: ${e.message}`)
     );
   }
   ```

3. **Add `parseSchedule()` support for new CONTACT and POST_GOAL fields**

   In the schedule parser, add extraction for the new fields:
   ```javascript
   function parseSchedule(text) {
     // ... existing parsing ...
     const contact = get('CONTACT');    // NEW
     const postGoal = get('POST_GOAL'); // NEW
     // ... include in returned post object ...
   }
   ```

4. **Add post-upload engagement tracking**

   After a post is published, wait 1 hour then log initial engagement metrics:
   
   ```javascript
   async function trackPostEngagement(postId, postGoal) {
     // Facebook Insights data isn't available immediately — we log the post ID
     // and goal for later analysis. The analytics feedback pipeline (Session 3)
     // handles the delayed read-back.
     hopLog('facebook-poster', 'info', `Post ${postId} published — goal: ${postGoal}`);
     return { postId, postGoal, tracked: true };
   }
   ```

5. **Update the schedule parser to handle 4-day weeks**

   The current `parseSchedule()` expects 7 days. Make it flexible:
   ```javascript
   const posts = parseSchedule(SCHEDULE_FILE).filter(p => 
     p.day >= args.startDay && p.day <= args.endDay && p.type !== 'skip'
   );
   ```
   
   Add support for `TYPE: skip` to allow the schedule to explicitly skip days.

6. **Add logging for engagement CTA type**

   Log which CTA type was used so the analytics pipeline can correlate:
   ```javascript
   const ctaType = classifyCta(post.cta || ''); // 'comment', 'save', 'tag', 'vote', 'share', 'call'
   hopLog('facebook-poster', 'info', `Day ${post.day}: CTA type = ${ctaType}`);
   ```

#### Verification

```bash
# Syntax check
node -c scripts/facebook-poster.mjs

# Test buildCaption with new format
node -e "
import { buildCaption } from './scripts/facebook-poster.mjs';
const test = { hook: 'Test', body: 'Body', hashtags: '#DFW', cta: 'Save this!', contact: '(469) 863-9804' };
const caption = buildCaption(test);
console.assert(!caption.includes('863-9804'), 'Phone should not be in caption');
console.assert(caption.includes('Save this!'), 'Engagement CTA should be in caption');
console.log('PASS');
"

# Test parseSchedule with new fields
node -e "
// Parse the existing schedule file to verify new fields are handled gracefully
import { parseSchedule } from './scripts/facebook-poster.mjs';
const posts = parseSchedule('outputs/facebook_posting_schedule.md');
console.log('Posts parsed:', posts.length);
posts.forEach(p => console.log('Day', p.day, 'Type', p.type, 'Goal', p.postGoal || 'N/A'));
"
```

#### Commit Message
```
feat: strip phone CTAs from captions, post to first comment, add engagement tracking
```

---

### Session 3: Create Facebook Analytics Feedback Pipeline

**Files:** `scripts/facebook-insights-collector.mjs` (NEW), `outputs/facebook_engagement_report.md` (NEW output)
**Executor:** Claude Code (bridge) — API integration + data pipeline
**Context estimate:** ~15k tokens

#### Background

The current pipeline pushes content OUT but never reads results back IN. The Facebook Page Insights MCP tools are available (facebook_top_posts, facebook_page_overview, etc.) but aren't integrated into the SEO agents workflow. This session creates a bridge that feeds engagement data back into the weekly content generation cycle.

#### Tasks

1. **Create `scripts/facebook-insights-collector.mjs`**

   A script that reads recent post performance and writes a structured report consumed by crew.py:

   ```javascript
   #!/usr/bin/env node
   /**
    * facebook-insights-collector.mjs
    * Collects engagement data for recent Facebook posts and writes a structured
    * report consumed by crew.py's research phase.
    *
    * Usage:
    *   node facebook-insights-collector.mjs --days 7 --output outputs/facebook_engagement_report.md
    *   node facebook-insights-collector.mjs --post-id <id>  # single post
    */
   ```

   The script:
   - Reads the last week's `facebook_posting_schedule.md` to get post IDs and goals
   - Calls Facebook Graph API to fetch engagement metrics for each post:
     - `/{post-id}/insights/post_impressions,post_engaged_users,post_reactions_by_type_total,post_clicks`
   - Calculates engagement rate: (reactions + comments + shares) / impressions
   - Ranks posts by engagement rate
   - Identifies which content types (before/after, educational, behind-scenes) performed best
   - Identifies which CTA types (save, tag, comment, vote) drove most engagement
   - Writes a structured markdown report

2. **Report format**

   The output file (`facebook_engagement_report.md`) follows this structure:

   ```markdown
   # Facebook Engagement Report — Week of [date]
   
   ## Top Performing Posts
   | Rank | Day | Type | Goal | CTA | Impressions | Engagement | Rate |
   |------|-----|------|------|-----|-------------|------------|------|
   
   ## Content Type Performance
   | Type | Avg Engagement Rate | Best Day |
   |------|---------------------|----------|
   
   ## CTA Performance
   | CTA Type | Avg Comments | Avg Shares |
   |----------|-------------|------------|
   
   ## Recommendations for Next Week
   - Double down on: [winning content type]
   - Drop: [worst performing format]
   - Test: [new format idea based on data]
   ```

3. **Integrate into weekly pipeline**

   In `src/seo_agents/main.py`, add a step BEFORE schedule generation that reads `facebook_engagement_report.md` and injects it into the Facebook crew's context:

   ```python
   # In the weekly pipeline, after research phase, before schedule generation:
   fb_engagement = read_output("facebook_engagement_report.md")
   # Pass to build_facebook_crew() as additional context
   ```

4. **Fallback for zero data**

   When there's no engagement data yet (fresh start), the report should state:
   ```markdown
   # Facebook Engagement Report — Week of [date]
   
   **Status:** No engagement data available yet — this is expected for the first week of the new strategy.
   Recommendations below are based on research best practices, not live data.
   ```

#### Verification

```bash
# Syntax check
node -c scripts/facebook-insights-collector.mjs

# Dry run (should produce a report even with no data)
node scripts/facebook-insights-collector.mjs --days 7 --dry-run

# Verify report generated
cat outputs/facebook_engagement_report.md

# Verify Python integration
PYTHONPATH="" .venv/Scripts/python.exe -c "
from seo_agents.main import read_output
report = read_output('facebook_engagement_report.md')
print('Engagement report loaded:', 'yes' if report else 'no')
"
```

#### Commit Message
```
feat: add Facebook analytics feedback pipeline — closing the engagement loop
```

---

## Wave 2: Integration — Schedule Format & Boost Framework (2 Parallel Sessions)

### Session 4: Update Schedule Format & Cross-Platform Alignment

**Files:** `src/seo_agents/crew.py` (format instructions), `scripts/facebook-poster.mjs` (parser)
**Executor:** Claude Code (bridge)
**Context estimate:** ~20k tokens
**Depends on:** Session 1 (new content instructions), Session 2 (new parser fields)

#### Tasks

1. **Update the schedule output format in crew.py fb_task description**

   In lines 1080-1093, update the format spec to include new fields:
   ```python
   "DAY: [number]\n"
   "DATE: [YYYY-MM-DD]\n"
   "TYPE: [video|photo|text|carousel|poll|skip]\n"
   "SERVICE: [service area]\n"
   "POST_GOAL: [engagement|education|social_proof|entertainment]\n"
   "HOOK: [first line — the scroll-stopper]\n"
   "BODY: [the story or value, varied by format type]\n"
   "CTA: [engagement invitation — save, tag, vote, comment, share — NO phone numbers]\n"
   "HASHTAGS: [2-3 max, optional]\n"
   "CONTACT: [(469) 863-9804 — posted as first comment, not in caption]\n"
   "PHOTO_FILE: [path or blank]\n"
   "VIDEO_PROMPT: [cinematic Reel prompt with on-screen text notes or blank]\n"
   "ON_SCREEN_TEXT: [text that should appear as overlays on the Reel]\n"
   "STATUS: Needs approval\n"
   ```

2. **Ensure DAY_TOPIC_BINDING_RULE still works with 4-day weeks**

   The GBP poster still runs 7 days. The binding rule needs to handle the mismatch:
   ```python
   DAY_TOPIC_BINDING_RULE = (
       "DAY→TOPIC BINDING (MANDATORY):\n"
       "Use the '## RECOMMENDED POST TOPIC QUEUE' in the GBP REPORT as the source of truth.\n"
       "Facebook posts 4 days/week: assign RANK 1→Day 1, RANK 3→Day 3, RANK 5→Day 5, RANK 6→Day 6.\n"
       "The topic/SERVICE on each posted day MUST match the same rank's topic on GBP.\n"
   )
   ```

3. **Add `parseSchedule()` support for `SKIP` type and `ON_SCREEN_TEXT` field**

   In facebook-poster.mjs:
   ```javascript
   // In parseSchedule:
   if (type === 'skip') continue; // Skip this day entirely
   
   // Add on_screen_text to post object
   post.on_screen_text = get('ON_SCREEN_TEXT') || '';
   ```

#### Verification

```bash
# Syntax check both files
node -c scripts/facebook-poster.mjs
PYTHONPATH="" .venv/Scripts/python.exe -c "from seo_agents.crew import build_facebook_crew; print('OK')"

# Test schedule generation
PYTHONPATH="" .venv/Scripts/python.exe -m seo_agents.main facebook-schedule --days 4 2>&1 | head -50

# Verify new format fields present in output
grep -c "POST_GOAL:" outputs/facebook_posting_schedule.md  # Should be 4
grep -c "CONTACT:" outputs/facebook_posting_schedule.md     # Should be 4
```

#### Commit Message
```
feat: update schedule format — POST_GOAL, CONTACT, ON_SCREEN_TEXT, 4-day weeks, SKIP support
```

---

### Session 5: Add Boost Recommendation Framework

**Files:** `outputs/facebook_posting_schedule.md` (enhanced with boost flags), `scripts/facebook-poster.mjs` (optional boost logging)
**Executor:** Claude Code (bridge)
**Context estimate:** ~10k tokens
**Depends on:** Session 1 (POST_GOAL field), Session 3 (analytics data)

#### Background

Research established a clear boost strategy: $10-15/day per post, targeting 15-mile radius around Rowlett, homeowner interests, boosting before/after photos and educational videos. The budget is **locked at $50/week** — the CrewAI agent decides how to distribute it (e.g., 1 post at $50, 2 posts at $25 each, or 3 posts at ~$17 each). This session adds boost recommendations to the schedule output so the user can act on them manually (full automated boosting via Ads API is a Phase 2 project).

#### Tasks

1. **Add boost recommendations to crew.py context with $50/week budget constraint**

   In the `fb_context` (line 1005), add boost guidance for the agent:
   ```python
   "BOOST GUIDANCE (BUDGET: $50/week total — YOU decide how to distribute):\n"
   "- TOTAL WEEKLY BUDGET: Exactly $50. Distribute across 1-3 posts as you see fit. "
   "You are the strategist — decide which posts deserve budget and how much.\n"
   "- Recommendation: $25 on your best post + $25 on your second-best, "
   "OR $50 on a single must-win post, OR $17 × 3 for broad coverage.\n"
   "- For each post, include a BOOST field: 'yes:$N' (boost with $N budget), "
   "'maybe' (boost if extra budget appears), or 'no' (don't boost).\n"
   "- The sum of all BOOST=$N values must equal exactly $50.\n"
   "- BOOST=yes criteria: before/after photos, educational videos, testimonials "
   "with photos — content with visual proof and educational value.\n"
   "- BOOST=no criteria: text-only, generic updates, holiday posts.\n"
   "- Include a BOOST_TARGETING hint: e.g. '15mi Rowlett, homeowners 28-65, "
   "home improvement interests' or '10mi Garland, EV owners'\n"
   "- Include a BOOST_DURATION: how many days to run each boost (3, 5, or 7 days). "
   "At $17/day × 3 days = $51 (~on budget); at $25/day × 2 days = $50.\n"
   ```

2. **Add BOOST, BOOST_AMOUNT, BOOST_DURATION, and BOOST_TARGETING fields to output format**

   In the schedule format spec:
   ```python
   "BOOST: [yes|maybe|no]\n"
   "BOOST_AMOUNT: [$N — daily budget for this post's boost, e.g. $17]\n"
   "BOOST_DURATION: [N days — how long to run the boost, e.g. 3]\n"
   "BOOST_TARGETING: [targeting hint for this specific post or blank]\n"
   ```

3. **Add a weekly boost budget summary section**

   After the 4 posts, in the CONTENT NOTES section, add:
   ```python
   "\nBOOST BUDGET SUMMARY (Weekly Budget: $50):\n"
   "- Posts boosted: N of 4\n"
   "- Budget allocation:\n"
   "  * Day X: $N/day × N days = $N total\n"
   "  * Day Y: $N/day × N days = $N total\n"
   "- TOTAL SPEND: $50 (must equal exactly $50)\n"
   "- Priority post (boost first): Day X — [reason]\n"
   "- Expected weekly reach from boosts: ~5,000-10,000 additional impressions\n"
   "- Expected weekly engagement from boosts: ~50-120 additional engagements\n"
   "- Boost targeting: 15mi radius from Rowlett, homeowners 28-65, "
   "home improvement/DIY/real estate interests. Exclude electrician interest "
   "(that's competitors). Use Advantage+ Audience for AI optimization.\n"
   ```

4. **Update parseSchedule to extract BOOST fields**

   In facebook-poster.mjs:
   ```javascript
   post.boost = get('BOOST') || 'no';
   post.boostAmount = get('BOOST_AMOUNT') || '';
   post.boostDuration = get('BOOST_DURATION') || '';
   post.boostTargeting = get('BOOST_TARGETING') || '';
   ```

#### Verification

```bash
# Syntax checks
node -c scripts/facebook-poster.mjs
PYTHONPATH="" .venv/Scripts/python.exe -c "from seo_agents.crew import build_facebook_crew; print('OK')"

# Verify BOOST fields in schedule output
grep -c "BOOST:" outputs/facebook_posting_schedule.md
grep "BOOST BUDGET SUMMARY" outputs/facebook_posting_schedule.md
```

#### Commit Message
```
feat: add boost recommendation framework to Facebook schedule — budget tiers, targeting hints
```

---

## Wave 3: Polish & Verification (1 Sequential Session)

### Session 6: End-to-End Testing & Runbook Update

**Files:** Tests, `FRIDAY-RUNBOOK.md`, documentation
**Executor:** Claude Code (bridge)
**Context estimate:** ~12k tokens
**Depends on:** All Wave 1 + Wave 2 sessions

#### Tasks

1. **Run the full weekly pipeline with new 4-day Facebook configuration**

   ```bash
   # Generate fresh schedules with new 4-day Facebook + existing 7-day GBP
   PYTHONPATH="" .venv/Scripts/python.exe -m seo_agents.main facebook-schedule --days 4
   ```

   Verify output:
   - 4 posts (not 7)
   - Each post has POST_GOAL, CONTACT, BOOST fields
   - CTAs are engagement-focused (no phone numbers in CTA)
   - Content formats are varied (no two identical formats in a row)

2. **Test caption assembly with new format**

   ```bash
   node -e "
   import { buildCaption, parseSchedule } from './scripts/facebook-poster.mjs';
   const posts = parseSchedule('outputs/facebook_posting_schedule.md');
   for (const p of posts) {
     const caption = buildCaption(p);
     const hasPhone = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(caption);
     console.log('Day', p.day, '| Goal:', p.postGoal, '| CTA type:', p.cta?.slice(0, 40), '| Phone in caption:', hasPhone);
     if (hasPhone) throw new Error('Phone number in caption — FAIL');
   }
   console.log('ALL PASS: No phone numbers in captions');
   "
   ```

3. **Run existing test suites for regressions**

   ```bash
   PYTHONPATH="" .venv/Scripts/python.exe -m pytest tests/ -q -x --basetemp=/tmp/pytest-tmp -p no:cacheprovider
   node -c scripts/facebook-poster.mjs
   node -c scripts/mav-bridge.mjs
   node -c scripts/facebook-insights-collector.mjs
   ```

4. **Update FRIDAY-RUNBOOK.md**

   Update the runbook to reflect:
   - New 4-day Facebook posting schedule
   - New fields in schedule format
   - Facebook Insights collection step (before schedule generation)
   - Recommended boost workflow (manual for now)

5. **Dry-run the full Facebook poster with new schedule format**

   ```bash
   node scripts/facebook-poster.mjs --dry-run --schedule-all
   ```
   
   Verify that all posts parse correctly and the Graph API calls would succeed.

6. **Verify backward compatibility**

   The new code must still parse an OLD 7-day schedule without crashing:
   ```bash
   # Backup current schedule, generate old format, test parsing, restore
   cp outputs/facebook_posting_schedule.md outputs/facebook_posting_schedule.md.bak
   # ... test old format parsing ...
   mv outputs/facebook_posting_schedule.md.bak outputs/facebook_posting_schedule.md
   ```

#### Verification

```bash
# Full verification suite
PYTHONPATH="" .venv/Scripts/python.exe -m pytest tests/ -q -x --basetemp=/tmp/pytest-tmp -p no:cacheprovider
node -c scripts/facebook-poster.mjs
node -c scripts/mav-bridge.mjs
node -c scripts/facebook-insights-collector.mjs
node -c scripts/video-postprocess.mjs
node -c scripts/xai-video-generator.mjs
```

#### Commit Message
```
test: end-to-end verification of Facebook engagement optimization pipeline, update runbook
```

---

## Dependency Graph

```
Wave 1 (parallel):
  Session 1 (crew.py content overhaul)          ──┐
  Session 2 (facebook-poster.mjs CTA/parse)     ──┼──→ Wave 2
  Session 3 (analytics feedback pipeline)       ──┘

Wave 2 (parallel):
  Session 4 (schedule format + cross-platform)  [depends on 1, 2]
  Session 5 (boost framework)                   [depends on 1, 3]

Wave 3 (sequential):
  Session 6 (e2e test + runbook)               [depends on 1, 2, 3, 4, 5]
```

**DAG verification:** No cycles. Sessions in the same wave touch different files. ✅

---

## Acceptance Criteria

1. ✅ `build_facebook_crew()` generates 4 posts/week (not 7)
2. ✅ All CTAs are engagement-focused (save, tag, vote, comment, share) — no phone numbers
3. ✅ Business contact info posted as first comment, not in caption
4. ✅ Schedule includes POST_GOAL, CONTACT, BOOST, BOOST_TARGETING, ON_SCREEN_TEXT fields
5. ✅ Content formats are varied (no two identical formats consecutively)
6. ✅ Facebook Insights analytics pipeline feeds back into weekly content generation
7. ✅ Boost recommendations appear in schedule output with budget summaries
8. ✅ Old 7-day schedule format still parses without crashes (backward compatibility)
9. ✅ All existing tests pass
10. ✅ No new subscriptions required (uses existing Facebook Graph API + OpenAI keys)

---

## Content Strategy Summary (for reference)

### New Posting Cadence
| Day | Format | Goal | CTA Example |
|-----|--------|------|-------------|
| Mon | Video (Reel 15-25s) | education/social_proof | "Save this for your next panel inspection" |
| Wed | Photo or Carousel | education/engagement | "Would you call a pro or DIY? 👇" |
| Fri | Video (Reel 15-25s) | social_proof/entertainment | "Tag an electrician who'd appreciate this" |
| Sat | Photo or Text | engagement/social_proof | "Drop a 🔌 if you've had this issue" |

### Content Mix
- 50% Educational/Value (tips, safety, how-to, "what's wrong here")
- 30% Social Proof/Personality (before/after, reviews, team, humor)
- 20% Interactive (polls, questions, "this or that")
- 0% Direct sales CTAs in captions

### Organic Reach Tactics (manual — not automated)
- Join 10-15 DFW Facebook community Groups as Page
- Create 5-10 person seed engagement network (staff, family, past customers)
- Reply to every comment within 15 minutes
- Post 1-2 Stories/day with interactive stickers

### Boost Strategy ($50/week — CrewAI decides distribution)

- **Budget:** $50/week total. CrewAI agent decides: e.g. 2 posts × $25/day × 1 day = $50, or 3 posts × $17/day × 1 day = $51 (~on budget), or 1 post × $10/day × 5 days = $50.
- **Targeting:** 15-mile radius Rowlett, homeowners 28-65, home improvement/DIY/real estate interests. Exclude electrician interest (competitors). Use Advantage+ Audience.
- **Best posts to boost:** Before/after photos, educational videos, testimonials w/ photos
- **Never boost:** Text-only posts, generic updates, holiday greeting posts
- **Expected weekly reach from boosts:** ~3,000-7,000 additional impressions
- **Expected monthly follower growth:** +30-60 followers/month (187 → ~220-250 in 30 days)
- **Schedule output:** BOOST_AMOUNT, BOOST_DURATION, and BOOST_TARGETING per post + weekly budget summary that must sum to $50

---

## What This Plan Does NOT Cover

The following are OUT OF SCOPE for this plan and would be separate builds:

- **Facebook Groups automation** — the plan recommends joining Groups but automating Group posting is a different technical challenge
- **Facebook Stories automation** — Stories API is limited; Stories are best done manually
- **Automated boosting via Ads API** — this plan adds recommendations to the schedule; actual automated boosting is a Phase 2 project
- **GBP content optimization** — this plan is Facebook-only per user's direction
- **Instagram cross-posting** — the research recommends it but the pipeline doesn't currently connect to Instagram
- **Facebook Live** — low priority for follower count; Reels are the priority format
- **Meta Verified subscription** — $15/mo, worth testing but out of scope for code changes

---

## New Subscription Cost Analysis

| Item | Cost | Required? | Verdict |
|------|------|-----------|---------|
| Facebook Graph API | Free (included) | Already have token | ✅ No new cost |
| OpenAI (GPT-4o for CrewAI) | Existing subscription | Already configured | ✅ No new cost |
| xAI Grok (video generation) | Existing API key | Already configured | ✅ No new cost |
| Facebook Insights API | Free (included) | Same Page token | ✅ No new cost |
| **Total new subscription cost: $0** | | | |

---

## Archive Steps

After all sessions are verified and merged:

```bash
# Copy PLAN.md to archive
mkdir -p "C:\Workspace\Archive\Build Plans\SEO-Agents-App"
cp PLAN.md "C:\Workspace\Archive\Build Plans\SEO-Agents-App\20260716_fb-engagement.md"

# Archive run artifacts
mkdir -p "C:\Workspace\Archive\Agent-Orchestration\SEO-Agents-App"
cp -r artifacts/fb-engagement-20260716 "C:\Workspace\Archive\Agent-Orchestration\SEO-Agents-App\"

# Copy research reports to archive
cp C:\Workspace\Active\pi-agents\research_facebook_organic_reach_grizzly.md "C:\Workspace\Archive\Build Plans\SEO-Agents-App\20260716_research_organic-reach.md"
cp C:\Workspace\Active\pi-agents\facebook-trade-business-research.md "C:\Workspace\Archive\Build Plans\SEO-Agents-App\20260716_research_content-formats.md"
cp C:\Workspace\Active\pi-agents\research\facebook-boost-strategy-grizzly-electrical.md "C:\Workspace\Archive\Build Plans\SEO-Agents-App\20260716_research_boost-strategy.md"

# Remove PLAN.md from repo
git rm PLAN.md
git commit -m "chore: archive PLAN.md for Facebook engagement optimization build"
```
