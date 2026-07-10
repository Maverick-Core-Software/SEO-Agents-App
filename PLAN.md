# PLAN — Grizzly Website Task Execution + Auto-Exec Wiring

**Date:** 2026-07-10
**Source:** SEO run `2c5fc296-b102-49a4-8903-4f91dc7b7859` website tasks
**Planner:** Claude Fable (frontier) · **Executor:** Qwen (qwen3.6-35b-a3b via qwen-executor) · **Orchestrator:** Opus/Sonnet

**Locked decisions (do not revisit):**
1. **No dollar figures anywhere on the site.** Keep cost-focused SEO titles, but answer cost questions with cost *factors* + "call/text for a free quote." Existing dollar figures on the homepage (visible FAQ + FAQ schema) must be scrubbed.
2. **Fully automatic website execution.** mav-bridge auto-executes approved `platform=website` tasks by priority with no human approval step. GBP/social/directory tasks stay manual.

**Repos & branches:**
| Sessions | Repo | Path | Branch |
|---|---|---|---|
| 1–5 | grizzly-website | `C:/Workspace/Active/Grizzly Launch/grizzly-website` | `master` (NOT main; Vercel auto-deploys every push) |
| 6 | SEO-Agents-App | `C:/Workspace/Active/SEO-Agents-App` | `feat/website-auto-exec` (create from `main`) |

---

## How to Read This Plan (blueprint mode)

This plan is a **specification, not a code dump**. You (Qwen) write the actual HTML/JS/content.

- **CONTRACT blocks** (anything shown in a fenced code block labeled as exact) must be reproduced **verbatim**: find/replace anchors, machine markers, commit messages, verification commands, URLs, phone numbers.
- Everything else (page copy, HTML structure, JS implementation) you author yourself, following the specs and the design system below.
- Every task ends with verification commands and expected outputs. Run them. If output doesn't match, one focused fix attempt, then STOP and report.
- Never invent business facts, prices, license numbers, or service claims not listed in this primer.

---

## Codebase Primer

### Repo A — grizzly-website (Sessions 1–5)

Static HTML site, live at `https://www.grizzlyelectricaltx.com`, GitHub `barnscarter-ops/grizzly-website`. **Every push to `master` deploys to production via Vercel** — commit only at the end of each session, after all verifications pass.

Current repo contents: `index.html` (~1156-line single-page site), `404.html`, `privacy-policy/`, `sms-terms/`, `uploads/`, `vercel.json`. There is **no** sitemap.xml, robots.txt, service pages, or blog yet — this plan creates all of them.

Before starting each session:
```bash
cd "/c/Workspace/Active/Grizzly Launch/grizzly-website" && git pull --rebase origin master && git status
```
Expected: clean working tree on `master`.

### Design system (CONTRACT — use these exact values)

- Backgrounds: `#090909` (page), `#0d0d0d` / `#181818` (panels), borders `#1c1c1c`
- Text: body `#e0dbd4`, headings `#f0ebe4`, muted `#aaa` / `#888` / `#777`
- Accent: `#cc2200` (hover `#a81c00`)
- Fonts (Google Fonts): **Oswald** wght 500;700 for headings (uppercase, letter-spacing), **Barlow** wght 300;400;600 for body (weight 300 default)
- Body: `line-height:1.8`, font-size 16px

### Business facts (CONTRACT — never invent beyond this list)

- **Grizzly Electrical Solutions**, 8902 Merritt Rd., Rowlett, TX 75089
- Phone **(469) 863-9804** → `tel:4698639804` · SMS quote line **(469) 896-3862** → `sms:4698963862`
- Email `contactus@grizzlyelectrical.net`
- Hours: Mon–Fri 8AM–6PM, Sat 8AM–2PM, **24/7 emergency service**
- Owner-operated, licensed & insured, senior & veteran discounts, free quotes (often same-day by phone/text)
- Service area: Rowlett, Garland, Plano, Richardson, greater Dallas–Fort Worth
- ~1/3 of work is commercial

### Content rules (CONTRACT)

1. **Zero dollar figures.** No `$` followed by a number anywhere in any file you write or edit. Cost topics: explain the factors (scope, materials, permits, access), then CTA to call/text for a free quote.
2. Primary CTA is a phone call; secondary is texting photos to the SMS line; tertiary is `/#contact`.
3. Every page: unique `<title>`, meta description ≤160 chars, `<link rel="canonical">` with the full `https://www.grizzlyelectricaltx.com/...` URL and trailing slash.
4. Tone: direct, competent, a little gruff-friendly. Texas-aware (heat, 2021 freeze, older DFW housing stock). No fluff, no "we are pleased to announce."

### index.html anchor map (verified 2026-07-10 — verbatim strings to find)

| ~Line | What | Verbatim anchor |
|---|---|---|
| 295 | Title tag | `<title>Licensed Electrician in DFW \| Grizzly Electrical Solutions \| (469) 863-9804</title>` |
| 304/310 | og:title & twitter:title content | `Licensed Electrician in DFW \| Grizzly Electrical Solutions` |
| 323 | LocalBusiness schema image | `"image": "https://www.grizzlyelectricaltx.com/wp-content/uploads/grizzly-logo.png",` |
| 378–425 | FAQPage JSON-LD (5 questions); Q at ~388 answers with `$1,500 to $4,000` | |
| 439–445 | Nav overlay links HOME/SERVICES/ABOUT/GALLERY/REVIEWS/FAQ/CONTACT, each `onclick="toggleMenu()"` | |
| 508 | Stats block | `16+` (Services Offered) |
| 525–651 | Services section: 16 numbered cards. Cards 01–15 end with `<div class="svc-arr">LEARN MORE →</div>` (dead, non-link). Card 03 (~550) = "Panel Upgrades"; card 05 (~564) = "Panel Upgrades & Replacement" (**duplicate — delete**); card 16 (~642) = emergency, featured, already has real `<a href="tel:4698639804">CALL NOW →</a>` | |
| 872 | Reviews heading | `WHAT OUR<br>CUSTOMERS SAY` |
| 932–971 | Visible FAQ, 5 `faq-item`s; answer at ~937 contains `$1,500–$4,000`; last answer (~969) ends `workers' comp coverage on every job.` | |

Line numbers are approximate after edits — **always match on the verbatim strings**, not line numbers.

### Blog contract (Sessions 4–5)

The site's automated blog publisher lives in `C:/Workspace/Active/SEO-Agents-App/src/seo_agents/website.py`:
- `BLOG_PAGE_TEMPLATE` (lines ~177–214) — post page skeleton
- `BLOG_INDEX_TEMPLATE` (lines ~216–250) — blog index skeleton
- `BLOG_LIST_ITEM` (lines ~252–255) — index list-item shape

**Read those templates and reproduce their structure exactly** in the hand-written files, so future automated posts render identically. Key contract points:
- Post page: `.wrap` max-width **760px**, padding `44px 24px 90px`; `.meta` date line format `July 10, 2026 · DFW, Texas`; `.cta` box `margin-top:52px; padding:26px; background:#181818; border-left:3px solid #cc2200;`
- Index page: title `Blog | Grizzly Electrical Solutions`, H1 `ELECTRICAL TIPS &amp; NEWS`, and this exact machine marker inside `<ul class="posts">`:
```html
<!-- BLOG-LIST -->
```
  The automation inserts new items **immediately after** this marker (newest first). Never remove or duplicate it.
- List item shape (CONTRACT — exact indentation):
```html
    <li><a href="/blog/SLUG/">TITLE</a>
    <p>META-DESCRIPTION</p></li>
```

### Repo B — SEO-Agents-App (Session 6)

Pipeline: `seo-agents` CLI → `outputs/*.md` → `scripts/supabase-sync.mjs` → Supabase (`website_tasks` table, project tbvsycqfpkkxitdbgfsj) → MCC approval UI → `scripts/mav-bridge.mjs` (PM2 service, port 8790, polls every 30s).

Website CLI: `seo-agents website "<task>" --type <action_type> --live` runs the website crew, applies the edit, commits, pushes, and prints a JSON result as the **last JSON object on stdout** with `status` ∈ `pushed | preview | validation_failed | error | push_failed`.

Valid action types (`WEBSITE_ACTION_TYPES` in `src/seo_agents/website.py:34`):
`website_blog_post`, `website_service_page_update`, `website_gallery_update`, `website_hours_update`, `website_faq_update`, `website_contact_form_update`, `website_copy_update`, `website_layout_update`

mav-bridge today (see `scripts/mav-bridge.mjs` ~line 411): approved website tasks are only flagged for **manual review** — no execution. Session 6 replaces that with auto-execution.

---

## Session 1 — Service Pages A (Tasks 1–3)

Create three standalone service pages. Each is a directory with a single `index.html` at the repo root (e.g. `electrical-troubleshooting/index.html` → served at `/electrical-troubleshooting/`).

### Service-page spec (applies to all 6 pages in Sessions 1–2)

Author each page from scratch following the design system. Required structure:
1. `<head>`: charset, viewport, unique title (pattern: `<Service> in Dallas-Fort Worth, TX | Grizzly Electrical Solutions`), meta description ≤160 chars, canonical URL, Google Fonts preconnect + Oswald/Barlow load, inline `<style>` (self-contained page — no external CSS file). Content column `.wrap` max-width **860px**.
2. Header link back to home: `← Grizzly Electrical Solutions` (Oswald, small caps style, links to `/`).
3. `<h1>` naming the service + DFW.
4. 4–6 `<h2>` sections covering: what the service is / when you need it, how Grizzly does it (process), why it matters in DFW specifically (climate/housing-stock angle), what affects the cost (**factors only, no dollars**), and a "get a quote" close.
5. At least two internal links to other service pages or `/blog/` posts where topically natural, plus tel: and sms: CTAs (exact numbers from the primer).
6. Prominent CTA button block: primary `CALL (469) 863-9804` (accent `#cc2200` button), secondary `TEXT PHOTOS FOR A QUOTE` → sms link, and a link to `/#contact`.
7. Two JSON-LD blocks in `<head>` or end of `<body>`:
   - `Service` — `serviceType`, `provider` (LocalBusiness: name, telephone `+14698639804`, address 8902 Merritt Rd., Rowlett, TX 75089), `areaServed` (Dallas-Fort Worth), `url` = canonical.
   - `BreadcrumbList` — Home (`/`) → page.
8. Footer with links to `/`, `/blog/`, `/privacy-policy/`.

Per-page verification (run for each page created; substitute the directory):
```bash
grep -c 'rel="canonical"' <dir>/index.html && grep -c 'application/ld+json' <dir>/index.html && grep -E '\$[0-9]' <dir>/index.html | wc -l
```
Expected: `1`, then `2`, then `0`.

### - [ ] Task 1: `electrical-troubleshooting/index.html`
- Title: `Electrical Troubleshooting & Repair in Dallas-Fort Worth, TX | Grizzly Electrical Solutions`
- Topics to cover: dead outlets/circuits, breakers that trip repeatedly, flickering or dimming lights, burning smells / warm switch plates (urgency → 24/7 line), aluminum wiring in older DFW homes, diagnostic process (systematic, explain-before-repair), when troubleshooting reveals a panel problem → link `/panel-upgrades/`.

### - [ ] Task 2: `panel-upgrades/index.html`
- Title: `Electrical Panel Upgrades & Replacement in DFW, TX | Grizzly Electrical Solutions`
- Topics: signs a panel needs upgrading (link the blog post `/blog/7-signs-your-electrical-panel-needs-an-upgrade/`), 100A vs 200A and modern load demands (EV chargers → link `/ev-charger-installation/`, HVAC), known-hazard brands (Federal Pacific, Zinsco) common in pre-1990 DFW housing, permits & inspection handled by Grizzly, what drives the price (amperage, meter/mast work, permit fees — no dollars), insurance benefits.

### - [ ] Task 3: `ev-charger-installation/index.html`
- Title: `EV Charger Installation in Dallas-Fort Worth, TX | Grizzly Electrical Solutions`
- Topics: Level 1 vs Level 2, hardwired vs NEMA 14-50, panel-capacity check first (link `/panel-upgrades/`), permits, install-day process, all makes (Tesla, Ford, Rivian, universal J1772/NACS), text-a-photo-of-your-panel free quote angle.

### - [ ] Session 1 commit (message CONTRACT)
```bash
git add electrical-troubleshooting/ panel-upgrades/ ev-charger-installation/
git commit -m "feat(services): electrical troubleshooting, panel upgrades, and EV charger pages"
git push origin master
```

**STOP. End of Session 1. Report and await orchestrator verification.**

---

## Session 2 — Service Pages B (Tasks 4–6)

Same service-page spec as Session 1.

### - [ ] Task 4: `generator-inlet-installation/index.html`
- Title: `Generator Inlet Box & Interlock Installation in DFW, TX | Grizzly Electrical Solutions`
- Topics: 2021 freeze framing, how inlet + interlock works, why backfeeding kills linemen (interlock as the safety mechanism), what a portable generator can run, interlock vs whole-home standby (Grizzly installs both), half-day install process, panel-brand-specific interlock kits.

### - [ ] Task 5: `recessed-lighting/index.html`
- Title: `Recessed Lighting Installation in Dallas-Fort Worth, TX | Grizzly Electrical Solutions`
- Topics: canless LED vs housed cans, layout/spacing planning per room, dimmers & color-temperature selection, attic/insulation considerations in Texas heat (IC-rated), retrofits in existing ceilings without wrecking drywall, pairing with a panel-capacity check for large jobs.

### - [ ] Task 6: `commercial-electrical/index.html`
- Title: `Commercial Electrician in Dallas-Fort Worth, TX | Grizzly Electrical Solutions`
- Topics: ~1/3 of Grizzly's work is commercial; tenant finish-outs & build-outs, lighting retrofits, dedicated circuits for equipment, panel & service upgrades, code compliance & inspections, maintenance for property managers, minimal-disruption scheduling, licensed & insured with workers' comp.

### - [ ] Session 2 commit (message CONTRACT)
```bash
git add generator-inlet-installation/ recessed-lighting/ commercial-electrical/
git commit -m "feat(services): generator inlet, recessed lighting, and commercial pages"
git push origin master
```

**STOP. End of Session 2. Report and await orchestrator verification.**

---

## Session 3 — Homepage Surgical Edits (Tasks 7–10)

All edits in `index.html`. These are find/replace operations on the verbatim anchors from the primer. Make each edit minimal — do not reflow or reformat surrounding code.

### - [ ] Task 7: Head fixes (title, social titles, schema logo URL)
1. Replace the title tag (anchor at ~295) with:
```html
<title>Electrician in Dallas-Fort Worth, TX | Grizzly Electrical Solutions</title>
```
2. In both `og:title` (~304) and `twitter:title` (~310), replace the content string `Licensed Electrician in DFW | Grizzly Electrical Solutions` with `Electrician in Dallas-Fort Worth, TX | Grizzly Electrical Solutions`.
3. In the LocalBusiness schema (~323), fix the dead WordPress path: remove `wp-content/` so the image URL is `https://www.grizzlyelectricaltx.com/uploads/grizzly-logo.png`. Verify a logo file actually exists under `uploads/` (`ls uploads/ | grep -i logo`); if the filename differs, use the real filename.

Verify:
```bash
grep -c "Dallas-Fort Worth, TX | Grizzly" index.html && grep -c "wp-content" index.html
```
Expected: `3` then `0`.

### - [ ] Task 8: Services section — real links, dedupe, stat fix
1. **Delete the duplicate card**: card 05 "Panel Upgrades & Replacement" (~564) duplicates card 03 "Panel Upgrades" (~550). Remove the entire card 05 element.
2. **Renumber** the remaining cards sequentially 01–15 (emergency card stays last as 15, keeping its featured styling and existing `tel:` link).
3. **Link six cards to their new pages** by converting the dead `<div class="svc-arr">LEARN MORE →</div>` into `<a class="svc-arr" href="/<slug>/" style="text-decoration:none;color:inherit;display:block;">LEARN MORE →</a>`:

| Card title contains | href |
|---|---|
| Troubleshooting (or Repairs) | `/electrical-troubleshooting/` |
| Panel Upgrades | `/panel-upgrades/` |
| EV Charger | `/ev-charger-installation/` |
| Generator | `/generator-inlet-installation/` |
| Recessed Lighting | `/recessed-lighting/` |
| Commercial | `/commercial-electrical/` |

4. **Stat fix**: in the stats block (~508), change `16+` Services Offered to `15+`.

Verify:
```bash
grep -c 'class="svc-arr" href' index.html && grep -c "Panel Upgrades" index.html && grep -c "16+" index.html
```
Expected: `6`, then fewer occurrences than before the edit (duplicate card gone — confirm visually with `grep -n "Panel Upgrades" index.html` that only one card remains), then `0`.

### - [ ] Task 9: Review badge
Directly above the reviews heading anchor `WHAT OUR<br>CUSTOMERS SAY` (~872), add a small badge line (muted color, Oswald, letter-spaced) reading `★★★★★ 5.0 ON GOOGLE` styled consistently with the section's existing eyebrow/label elements. Do not fabricate a review count.

Verify:
```bash
grep -c "5.0 ON GOOGLE" index.html
```
Expected: `1`.

### - [ ] Task 10: FAQ — scrub dollars, add two Q&As (visible + schema, kept in sync)
1. **Visible FAQ** (~932–971): rewrite the panel-cost answer (~937, contains `$1,500–$4,000`) to give cost factors (panel amperage, meter/mast work, permit fees, home age) + "call or text for a free quote — usually same-day." Keep the question text (cost-focused questions are good SEO).
2. **FAQ schema** (~378–425): rewrite the matching answer (~388, contains `$1,500 to $4,000`) to align with the new visible answer.
3. **Add two new Q&As** to BOTH the visible FAQ (after the last item, whose answer ends `workers' comp coverage on every job.`) and the FAQPage schema, matching each existing structure exactly:
   - *"Do you install EV chargers?"* — yes, Level 2 home charging, panel check first, link `/ev-charger-installation/` in the visible answer (plain text in schema).
   - *"Are quotes really free?"* — yes, free quotes, often same-day by phone or by texting photos to (469) 896-3862; senior & veteran discounts.

Verify:
```bash
grep -E '\$[0-9]' index.html | wc -l && grep -c "faq-item" index.html && grep -c '"@type": "Question"' index.html
```
Expected: `0`, then `7`-ish (5 + 2 — match whatever the class count pattern shows; confirm both new items present), then `7`.

### - [ ] Session 3 commit (message CONTRACT)
```bash
git add index.html
git commit -m "feat(home): SEO title fixes, linked service cards, review badge, FAQ without dollar figures"
git push origin master
```

**STOP. End of Session 3. Report and await orchestrator verification.**

---

## Session 4 — Blog Foundation + First Two Posts (Tasks 11–14)

### Blog-post spec (applies to all 5 posts in Sessions 4–5)

- File: `blog/<slug>/index.html`. Reproduce the structure of `BLOG_PAGE_TEMPLATE` from `C:/Workspace/Active/SEO-Agents-App/src/seo_agents/website.py` (lines ~177–214) — read it first, copy its skeleton/CSS exactly, then fill title/meta/canonical/date/body.
- Date line: `July 10, 2026 · DFW, Texas`.
- Body: intro paragraph + 4–6 `<h2>` sections, 500–900 words, ≥2 internal links (service pages / other posts), tel/sms CTAs in the closing section, template `.cta` box at the end.
- Canonical: `https://www.grizzlyelectricaltx.com/blog/<slug>/`.
- **Zero dollar figures** — including in the two "cost" posts.

Per-post verification:
```bash
grep -c 'rel="canonical"' blog/<slug>/index.html && grep -E '\$[0-9]' blog/<slug>/index.html | wc -l
```
Expected: `1` then `0`.

### - [ ] Task 11: `blog/index.html`
Reproduce `BLOG_INDEX_TEMPLATE` (website.py lines ~216–250) exactly, including the `<!-- BLOG-LIST -->` marker inside `<ul class="posts">`. Then add list items for the two posts from this session (Tasks 12–13), newest-listed-first, using the exact `BLOG_LIST_ITEM` shape from the contract.

Verify:
```bash
grep -c "BLOG-LIST" blog/index.html && grep -c "<li>" blog/index.html
```
Expected: `1` then `2`.

### - [ ] Task 12: `blog/7-signs-your-electrical-panel-needs-an-upgrade/index.html`
- Title: `7 Signs Your Electrical Panel Needs an Upgrade | Grizzly Electrical Solutions`
- The 7 signs (one H2 or list item each): frequent breaker trips; flickering/dimming when appliances start; buzzing/hot panel; scorch marks or burning smell (urgent → 24/7 line); fuse box or 100A panel in an older home; known-hazard brands (Federal Pacific, Zinsco); planned EV charger or major appliance addition.
- Links: `/panel-upgrades/`, `/ev-charger-installation/`.

### - [ ] Task 13: `blog/how-much-does-an-electrical-panel-upgrade-cost-in-dfw/index.html`
- Title: `How Much Does an Electrical Panel Upgrade Cost in DFW? | Grizzly Electrical Solutions`
- Angle: cost-question title for SEO; body explains the price *drivers* — amperage (100A→200A), meter base/mast condition, permit fees varying by DFW city, panel brand/quality, attic-access difficulty — then how to get a real number (text panel photos to the SMS line). No dollars anywhere.
- Links: `/panel-upgrades/`, `/blog/7-signs-your-electrical-panel-needs-an-upgrade/`.

### - [ ] Task 14: Nav BLOG link in `index.html`
In the nav overlay (~439–445), add a BLOG link after the FAQ link, matching the existing links' exact markup pattern (same classes/styling) — **except** it navigates to `/blog/` (a real href, not an on-page anchor). Include `onclick="toggleMenu()"` only if the existing pattern requires it for closing the overlay; since this navigates away, a plain href matching the visual classes is correct.

Verify:
```bash
grep -c 'href="/blog/"' index.html
```
Expected: `1`.

### - [ ] Session 4 commit (message CONTRACT)
```bash
git add blog/ index.html
git commit -m "feat(blog): blog index, first two posts, and nav BLOG link"
git push origin master
```

**STOP. End of Session 4. Report and await orchestrator verification.**

---

## Session 5 — Remaining Posts + Sitemap & Robots (Tasks 15–19)

### - [ ] Task 15: `blog/home-ev-charger-installation-dfw/index.html`
- Title: `Home EV Charger Installation in DFW: What to Know Before You Buy | Grizzly Electrical Solutions`
- Cover: Level 1 vs Level 2 (miles-of-range-per-hour framing), hardwired vs NEMA 14-50, check panel capacity *before* buying the charger (link `/panel-upgrades/`), permits required in most DFW cities, what install day looks like, get-it-quoted-first close.
- Links: `/ev-charger-installation/`, `/panel-upgrades/`.

### - [ ] Task 16: `blog/generator-inlet-interlock-installation-dfw/index.html`
- Title: `Generator Inlet Box & Interlock Kit: Backup Power Done Right | Grizzly Electrical Solutions`
- Cover: 2021 freeze hook, how the inlet + interlock setup works, why the interlock prevents deadly backfeeding (licensed install + permit required), what a portable generator can realistically run, interlock vs standby generator trade-off, install process.
- Links: `/generator-inlet-installation/`.

### - [ ] Task 17: `blog/how-much-does-an-electrician-cost-in-dallas/index.html`
- Title: `How Much Does an Electrician Cost in Dallas? | Grizzly Electrical Solutions`
- Cover: why national averages mislead; the four real price drivers (job scope, materials grade, permits/inspections, access difficulty — Texas attic angle); flat quote vs hourly and when each protects the customer; red flags in a cheap quote (no license/insurance, no permit, price without seeing the job); how to get a real number (text photos, free same-day quotes, senior/veteran discounts). No dollars.
- Links: `/electrical-troubleshooting/`, at least one other service page.

### - [ ] Task 18: Add the three new posts to `blog/index.html`
Insert three list items **immediately after** the `<!-- BLOG-LIST -->` marker (newest first, so Task 17's post ends up listed first), using the exact `BLOG_LIST_ITEM` shape. Do not disturb the marker or the two existing items.

Verify:
```bash
grep -c "<li>" blog/index.html && grep -c "BLOG-LIST" blog/index.html
```
Expected: `5` then `1`.

### - [ ] Task 19: `sitemap.xml` + `robots.txt` (deliberately LAST — lists only live URLs)
Create `sitemap.xml` at the repo root: standard `urlset` (namespace `http://www.sitemaps.org/schemas/sitemap/0.9`), `<lastmod>2026-07-10</lastmod>` on every URL, covering exactly these 15 URLs — homepage (priority 1.0); the six service pages (0.8); `/blog/` and the five posts (0.6); `/privacy-policy/` and `/sms-terms/` (0.3). All URLs absolute `https://www.grizzlyelectricaltx.com/...` with trailing slashes.

Create `robots.txt` at the repo root (CONTRACT — exact content):
```
User-agent: *
Allow: /

Sitemap: https://www.grizzlyelectricaltx.com/sitemap.xml
```

Verify:
```bash
grep -c "<loc>" sitemap.xml && grep -c "Sitemap:" robots.txt
```
Expected: `15` then `1`.

### - [ ] Session 5 commit (message CONTRACT)
```bash
git add blog/ sitemap.xml robots.txt
git commit -m "feat(blog): three more posts; add sitemap.xml and robots.txt"
git push origin master
```

**STOP. End of Session 5. Report and await orchestrator verification.**

---

## Session 6 — Website Task Auto-Execution (Tasks 20–22)

Repo: `C:/Workspace/Active/SEO-Agents-App`. Create branch first:
```bash
cd /c/Workspace/Active/SEO-Agents-App && git checkout main && git pull && git checkout -b feat/website-auto-exec
```
**Read each target file in full before editing it.** Do not touch the running PM2 process — code changes only; the orchestrator handles restarts with Carter.

### - [ ] Task 20: Platform tagging in `scripts/supabase-sync.mjs`
**Goal:** every `website_tasks` row gets machine-readable routing info in its `details` JSONB so the bridge knows what it may auto-execute.

Spec:
1. Locate where `website_tasks` rows are built for insert.
2. Add a pure helper `classifyTask(title, description)` returning `{ platform, website_action_type }`:
   - `platform`: `'website'` when the task is a site-content/page/blog/SEO edit; `'gbp'` for Google Business Profile tasks; `'social'` for social posts; `'directory'` for citations/listings; `'other'` fallback. Classify on keywords in title+description (e.g. GBP/"business profile" → gbp; "citation"/"directory"/Yelp → directory; Facebook/Instagram/"post to" socials → social; page/blog/meta/title tag/schema/sitemap/homepage/FAQ/content → website).
   - `website_action_type` (only when platform is `website`): map keywords to one of the valid `WEBSITE_ACTION_TYPES` from the primer — blog → `website_blog_post`; service page → `website_service_page_update`; FAQ → `website_faq_update`; hours → `website_hours_update`; contact form → `website_contact_form_update`; gallery → `website_gallery_update`; nav/layout/header/footer/sitemap/robots → `website_layout_update`; default `website_copy_update`.
3. Merge the result into the row's `details` object (preserve existing keys).
4. Follow the file's existing code style; no new dependencies.

Verify (syntax only — no live sync):
```bash
node --check scripts/supabase-sync.mjs
```
Expected: exits 0, no output.

### - [ ] Task 21: `processWebsiteTasks()` in `scripts/mav-bridge.mjs`
**Goal:** replace the manual-review-only block (~line 411, "tasks need manual review") with priority-ordered auto-execution of website tasks.

Spec:
1. Env gate: `MAV_WEBSITE_AUTO_EXEC` — enabled by default; the literal string `'0'` disables and falls back to the current manual-review log line. Read via `process.env`; no secrets, no new deps.
2. Query `website_tasks` where `status = 'approved'` AND `details->>platform = 'website'`. Tasks without `details.platform` or with other platforms keep today's manual-review behavior.
3. Sort by priority using `{critical: 0, high: 1, medium: 2, low: 3}` (unknown → 4), tie-break oldest `created_at` first.
4. **Claim exactly ONE task per poll cycle** with a compare-and-swap: `update ... set status='executing' where id = X and status='approved'`; if zero rows updated, another worker took it — skip this cycle.
5. Execute via the existing child-process helper pattern in this file (mirror how other phases spawn `seo-agents`):
   `seo-agents website "<title>. <description>" --type <details.website_action_type or website_copy_update> --live`, 20-minute timeout.
6. Parse the **last JSON object on stdout**. `status === 'pushed'` → update the task row to `status='done'`, store the result JSON under `details.result`, set the completion timestamp. `preview`/`validation_failed`/`error`/`push_failed` or timeout/crash → `status='error'` with the message stored in `details.result`. Never leave a task stuck in `executing` — wrap in try/catch/finally.
7. Log each step through the file's existing `log(runId, ...)` helper (channel `'website'`).

Verify:
```bash
node --check scripts/mav-bridge.mjs && grep -c "MAV_WEBSITE_AUTO_EXEC" scripts/mav-bridge.mjs
```
Expected: check passes; grep ≥ `1`.

### - [ ] Task 22: Docs & env example
1. Update the header comment block of `scripts/mav-bridge.mjs` (line ~9 area) to describe auto-execution of website tasks by priority.
2. Add `MAV_WEBSITE_AUTO_EXEC=1` with a one-line comment to `.env.example` (create the entry, not the file, if the file exists; if there is no `.env.example`, add the note to the README's environment section instead).

Verify:
```bash
grep -rn "MAV_WEBSITE_AUTO_EXEC" .env.example README.md scripts/mav-bridge.mjs 2>/dev/null | wc -l
```
Expected: ≥ `2`.

### - [ ] Session 6 commit (message CONTRACT)
```bash
git add scripts/supabase-sync.mjs scripts/mav-bridge.mjs .env.example README.md
git commit -m "feat(bridge): auto-execute approved website tasks by priority"
git push -u origin feat/website-auto-exec
```

**STOP. End of Session 6. Report and await orchestrator verification.**

---

## Appendix A — Orchestrator: Supabase task closeout (NOT for Qwen)

After each grizzly-website session is verified, mark the corresponding run-`2c5fc296` tasks done in Supabase (project tbvsycqfpkkxitdbgfsj). Always SELECT first, then UPDATE only verified IDs:

```sql
select id, title, priority, status from website_tasks
where run_id = '2c5fc296-b102-49a4-8903-4f91dc7b7859' and status <> 'done'
order by priority, created_at;

update website_tasks set status = 'done', updated_at = now()
where id in ('<ids matched to the tasks just verified>');
```

Special cases:
- Task `29477989…` (confirm CMS access) — moot after the static-site migration; mark done with a note or skip.
- Task `e3d94ef9…` (approve cost ranges) — resolved by the no-dollar-figures decision; leave for Carter to close.

Restart note: after Session 6 merges, `mav-bridge` (PM2) needs a restart to load the new code — **get Carter's explicit consent first** (his hard rule), and confirm no run is mid-execution before restarting.

---

## Appendix B — Session Prompts (copy-paste, one per session)

### Session 1
```
You are executing **Session 1** of a pre-written implementation plan. All design decisions have already been made by a more capable model — your job is faithful execution of the specifications.

**Plan file:** `C:/Workspace/Active/SEO-Agents-App/PLAN.md`
**Feature:** Grizzly website tasks — service pages A
**Working Tasks:** Tasks 1 through 3
**Working Directory:** `C:/Workspace/Active/Grizzly Launch/grizzly-website` on branch `master`
**Environment:** Windows 11 / Git Bash shell. Forward slashes in paths.

Rules — follow these exactly:
1. Read the plan's "How to Read This Plan" and "Codebase Primer" sections first, in full, before touching anything.
2. Execute Tasks 1 through 3 strictly in order.
3. This plan is a blueprint: YOU write the HTML and copy to the specs given. Anything the plan marks CONTRACT (anchors, markers, URLs, phone numbers, commit messages, commands) must be reproduced verbatim.
4. Every verification command has an expected output. Run it and check. If it doesn't match, make at most ONE focused fix attempt, then STOP and report: task, command, full actual output.
5. Commit exactly when and what the plan says, with the plan's commit message verbatim.
6. Do not add features, files, or dependencies the plan doesn't specify. If something seems wrong in the plan, STOP and report.
7. DO NOT proceed beyond Task 3.

When done, reply with: tasks completed, verification outputs, commits made (hash + message), then ask the user to return to the frontier orchestrator for verification.
```

### Session 2
Same as Session 1 with: **Feature:** service pages B · **Working Tasks:** Tasks 4 through 6 · rule 7: DO NOT proceed beyond Task 6.

### Session 3
Same as Session 1 with: **Feature:** homepage surgical edits · **Working Tasks:** Tasks 7 through 10 · add rule: match on the plan's verbatim anchor strings, never on line numbers · rule 7: DO NOT proceed beyond Task 10.

### Session 4
Same as Session 1 with: **Feature:** blog foundation + first two posts · **Working Tasks:** Tasks 11 through 14 · add rule: read the blog templates in `C:/Workspace/Active/SEO-Agents-App/src/seo_agents/website.py` (lines ~177–255) and reproduce their structure exactly; never remove the `<!-- BLOG-LIST -->` marker · rule 7: DO NOT proceed beyond Task 14.

### Session 5
Same as Session 4 with: **Feature:** remaining blog posts + sitemap/robots · **Working Tasks:** Tasks 15 through 19 · rule 7: DO NOT proceed beyond Task 19.

### Session 6
Same as Session 1 with: **Feature:** website task auto-execution · **Working Tasks:** Tasks 20 through 22 · **Working Directory:** `C:/Workspace/Active/SEO-Agents-App` on branch `feat/website-auto-exec` (create from main per the plan) · add rules: read each target file in full before editing; do not run, restart, or touch any PM2 process — code changes only · rule 7: DO NOT proceed beyond Task 22.
