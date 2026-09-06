# Grizzly Electrical Solutions: DFW expansion strategy

Date: 2026-09-06. Status: proposal. Nothing in this document has been applied, published, or posted.

Business facts come from `knowledge/baselines/grizzly-business-facts.md` (owner-reviewed 2026-09-05). Raw data lives under `D:/Workspace/Active/SEO-Agents-App/state/weekly/research/` (Search Console pulls, 42 SerpApi responses, the site audit) and in the session scratchpad `research/` folder (live HTTP checks). Paths below are relative to `D:/Workspace/Active/SEO-Agents-App/` unless they start with a drive letter. Website line numbers refer to `C:/Workspace/Active/Grizzly Launch/grizzly-website` at HEAD 83fa863, which matches the deployed site (scratchpad `research/live-checks-2026-09-06.json`, `deployed_matches_repo`).

Every number is marked as observed (read from a file) or inference (our reading of it). Effort scale: S is up to 2 hours, M is half a day to two days, L is multi-day or recurring.

## 1. Executive summary

What is actually stopping growth beyond Rowlett, in plain words:

1. **The map pack is tied to the Rowlett address, and no setting extends it.** Google shows the profile to people searching near 8902 Merritt Rd. It does not show it to people 15 to 30 miles away. Service-area settings are display only (Sterling Sky service-area test, updated 2025-03-31; Google `support.google.com/business/answer/9157481`). Observed: the profile sits at #2 in the Rowlett pack with 154 reviews at 5.0, behind W3 Electric with 1,500 (`outputs/archive/04a3760f/gbp_report.md` lines 22-23, read 2026-09-04). Inference: a cluster of 15 non-brand queries with 1,863 desktop-only impressions at position 1 to 2 and one click is the pack "Website" button for searchers near Rowlett, Garland and Wylie (`search-console-analysis.json` `localPackSignature`). Nothing in the 40 scanned SERPs shows Grizzly in a pack or an organic top 10, but every scan resolved to DFW Airport, so the scans can neither confirm nor deny pack presence (`serp-city-verdicts.json` `location_caveat`).

2. **Almost every click comes from people who already know the name.** Observed: 35 of the 43 attributed clicks in the 56-day window are brand queries (81%). The 1,132 non-brand queries earned 8 clicks on 12,399 impressions, a 0.06% click rate (`search-console-analysis.json` `brandVsNonBrand.d90`).

3. **For every city past the home ring, the site shows on pages 3 to 5 and nobody clicks.** Observed: Rockwall 1,474 impressions at position 40.3, Fort Worth 1,142 at 37.8, McKinney 330 at 31.5, Plano 160 at 36, all with 0 clicks (`citiesRanked90d`). An impression at position 40 means someone loaded page 4 or 5 of results. That is not a lead pool.

4. **Google answers city searches with the homepage, and the six city pages have faded.** Observed: the homepage carries 11,181 of the page-level impressions and 67 of 79 clicks (`pages90d`). The six city pages drew 570 impressions and 0 clicks over 56 days, and only 33 impressions in the last 28 days (`pages90d`, `pages28d`). The cause of the August drop is not diagnosed. The review of the draft recommendations found no evidence that more links or more sections on those pages fix a proximity problem (Section 4).

5. **The review gap is the pack gap in the home ring.** Observed: 154 reviews versus 796 to 1,500 for the top pack members in Rockwall, Garland, Plano, Frisco and McKinney (`serp-city-verdicts.json` `pack_top`).

6. **The one Google channel that reaches a named city regardless of address is not in use.** Observed: as of 2026-07-03, W3 Electric and Adis Electric ran Local Services Ads in Rowlett and Grizzly did not (`outputs/archive/2026-07-03_150959/gbp_report.md` line 436). No later file records a change.

What follows from this. Three recommendations survived a skeptical review and are kept: GBP hygiene for the home ring (R7), review velocity through Housecall Pro and Nextdoor (R8), and Local Services Ads for the 15 to 25 mile ring (R9). Ten were dropped because their evidence did not hold, they were already done, or a cheaper action gives the same result (Section 4). The honest expectation: organic and pack gains are possible in Rowlett, Garland, Wylie, Sachse and the edge of Rockwall. Richardson, Plano, Mesquite, McKinney and north-east Dallas are reached with paid per-lead ads plus reviews, not with city pages. Fort Worth, Frisco and beyond are a signal on the service pages, not cities to chase. Every public-facing change is owner-gated.

## 2. Where Grizzly stands today

### 2.1 Data window

Observed: the "90-day" Search Console request (2026-06-07 to 2026-09-04) returned only 56 dated rows, from 2026-07-10 to 2026-09-03 (`search-console-analysis.json` `dataWindow`; `search-console-90d-date.json` has 56 rows). Treat "90d" as 56 days. The 28-day window is 2026-08-08 to 2026-09-04 (`search-console-28d-device.json`). All 16 pulled files are listed in `search-console-manifest.json`.

### 2.2 Property totals

| Window | Clicks | Impressions | Source |
|---|---|---|---|
| 56 days | 79 | 16,797 | `search-console-90d-device.json` (property level) |
| 28 days | 33 | 8,256 | `search-console-28d-device.json` |

Other reports quote 19,636 impressions (page-level sums, a query showing two URLs counts twice) or 11,497 (attributed queries only). Use 79 / 16,797 for headlines.

### 2.3 Brand versus non-brand (56 days)

| Segment | Queries | Clicks | Impressions | CTR | Avg position |
|---|---|---|---|---|---|
| Brand | 23 | 35 | 508 | 6.9% | 4.6 |
| Non-brand (attributed) | 1,132 | 8 | 12,399 | 0.06% | 27.6 |
| Anonymized by Google | n/a | 36 | 3,890 | n/a | n/a |

Source: `search-console-analysis.json` `brandVsNonBrand.d90`. The 28-day window is the same picture: brand 12 clicks, non-brand 2 clicks on 6,226 impressions (`brandVsNonBrand.d28`).

### 2.4 Device split (56 days)

| Device | Clicks | Impressions | CTR | Avg position |
|---|---|---|---|---|
| Desktop | 44 | 13,032 | 0.34% | 23.5 |
| Mobile | 34 | 3,736 | 0.91% | 29.3 |
| Tablet | 1 | 29 | 3.4% | 44.9 |

Source: `search-console-90d-device.json`. Desktop carries 78% of impressions at a third of the mobile click rate. Inference: the desktop pack "Website" button inflates desktop impressions without clicks (see 2.8).

### 2.5 Top pages

| Page | 56d impressions | 56d clicks | 28d impressions | 28d clicks |
|---|---|---|---|---|
| / | 11,181 | 67 | 5,235 | 24 |
| /ev-charger-installation/ | 858 | 3 | 527 | 2 |
| /panel-upgrades/ | 782 | 0 | 299 | 0 |
| /whole-home-surge-protection/ | 771 | 0 | 682 | 0 |
| /recessed-lighting/ | 651 | 0 | 262 | 0 |
| /generator-installation/ | 595 | 2 | 440 | 2 |
| /generator-inlet-installation/ | 480 | 5 | 236 | 3 |
| /service-areas/electrician-richardson-tx/ (404) | 395 | 0 | 0 | 0 |
| /reviews/ | 348 | 0 | 131 | 0 |
| /service-areas/ | 332 | 0 | 247 | 0 |
| /service-areas/electrician-rowlett-tx/ | 309 | 0 | 6 | 0 |

Source: `search-console-analysis.json` `pages90d` and `pages28d` (property level). Homepage totals differ slightly between reports (10,344 to 11,181) because URL variants were merged differently; the ranking is the same everywhere.

### 2.6 City demand (non-brand queries that name a city)

| City | 56d impressions | 56d clicks | 56d position | 28d impressions | 28d position | Miles from Rowlett (approx) |
|---|---|---|---|---|---|---|
| Rowlett | 1,635 | 5 | 11.1 | 701 | 10.7 | 0 |
| Rockwall | 1,474 | 0 | 40.3 | 909 | 37.8 | 7 |
| Fort Worth | 1,142 | 0 | 37.8 | 726 | 34.5 | 45 |
| Garland | 573 | 1 | 11.5 | 236 | 11.9 | 5 |
| Richardson | 359 | 0 | 25.2 | 36 | 37.9 | 15 |
| Greenville | 335 | 0 | 51.6 | 251 | 50.7 | 30 (Hunt County) |
| McKinney | 330 | 0 | 31.5 | 196 | 33.1 | 25 |
| Dallas | 261 | 1 | 26.0 | 138 | 24.5 | 20 |
| Plano | 160 | 0 | 36.0 | 78 | 39.0 | 20 |
| Grapevine | 154 | 0 | 47.2 | 83 | 43.3 | 35 |
| Wylie | 148 | 1 | 4.4 | 32 | 2.1 | 8 |
| Sachse | 117 | 0 | 5.6 | 27 | 1.4 | 4 |
| Royse City | 117 | 0 | 45.0 | 17 | 46.9 | 15 |
| Frisco | 103 | 0 | 35.7 | 61 | 31.5 | 30 |
| Sunnyvale | 88 | 0 | 39.5 | 43 | 39.7 | 9 |
| Murphy | 38 | 0 | 12.6 | 0 | n/a | 8 |
| Heath | 30 | 0 | 47.0 | 27 | 47.4 | 10 |
| Allen | 8 | 0 | 42.5 | 8 | 42.5 | 25 |
| Mesquite | 4 | 0 | 1.0 | 4 | 1.0 | 12 |

Source: `search-console-analysis.json` `citiesRanked90d` and `citiesRanked28d`. Distances are approximate and taken from `serp-city-verdicts.json` where scanned; the rest are inference from the map. Rockwall's total is 1,474 here and 1,488 in the SERP verdicts because the two files classify a few queries differently.

Where the demand lands by service family (observed, `citiesRanked90d` `families`): Rowlett is generic electrician queries (961 at 9.6, 5 clicks), commercial (221 at 14.2) and generator (166 at 11.2). Rockwall is generic (968 at 43.7), troubleshooting (139), surge (135), EV (67). Fort Worth is EV (380 at 45.8), panel (236), recessed lighting (114 at 22.9). Dallas is recessed lighting (111 at 16.8, the best non-home foothold). McKinney is EV (97), surge (50), panel (34), smoke/CO (29). Frisco is one panel cluster (82 at 36.9).

### 2.7 The six city pages, 56 days versus 28 days

| Page | 56d impressions | 56d position | 28d impressions |
|---|---|---|---|
| /service-areas/electrician-rowlett-tx/ | 309 | 15.7 | 6 |
| /service-areas/electrician-garland-tx/ | 81 | 29.1 | 2 |
| /service-areas/electrician-sachse-tx/ | 75 | 11.7 | 6 |
| /service-areas/electrician-murphy-tx/ | 57 | n/a | 5 |
| /service-areas/electrician-wylie-tx/ | 30 | 22.5 | 11 |
| /service-areas/electrician-rockwall-tx/ | 18 | 15.2 | 3 |

Source: `search-console-90d-page.json`, `search-console-28d-page.json`, summarized in `pages90d` / `pages28d`. All six went live 2026-07-18 and have 0 clicks. Observed: "electrician rockwall tx" (223 impressions at 43.5) ranks the homepage, not the Rockwall page. Inference: Google is not associating the site with Rockwall at all; the August collapse of city-page impressions is undiagnosed.

### 2.8 Local pack signature (inference)

Observed rows: non-brand queries with 15 or more desktop impressions at desktop position 2.0 or better. Nearly all are desktop-only with zero clicks.

| Query | Desktop impressions | Desktop position | Clicks | Mobile |
|---|---|---|---|---|
| electrician | 652 | 1.4 | 0 | 12 at 13.4 |
| electrician garland | 300 | 1.4 | 1 | 4 at 20.5 |
| electrical repair | 279 | 1.1 | 0 | none |
| electrical panel replacement | 226 | 1.0 | 0 | none |
| electrician wylie | 103 | 1.0 | 0 | 1 at 29 |
| sub panel installation | 82 | 1.0 | 0 | none |
| electrician rowlett | 56 | 1.8 | 0 | 57 at 9.2 |

Fifteen queries, 1,863 desktop impressions, 1 click in total (`search-console-analysis.json` `localPackSignature`). Inference, shared by all four research reports: this is the desktop pack "Website" link counted as a position-1 impression for searchers near the business. Search Console's search-appearance report returned 0 rows in both windows (`search-console-90d-search-appearance.json`, `rowCount: 0`), so it cannot label the source. It is corroborated by the live Rowlett pack read (#2, `outputs/archive/04a3760f/gbp_report.md` line 22).

### 2.9 Legacy URLs that now return 404

Observed: 13 `/service-areas/*` URLs from the old WordPress site drew 1,379 impressions (8.2% of the property) and 0 clicks in 56 days, and 0 impressions in the last 28 days. Live HEAD checks on 2026-09-06 returned 404 for all 13 (`search-console-analysis.json` `legacyUrls404`; scratchpad `research/live-checks-2026-09-06.json` `http`). Largest: `/service-areas/electrician-richardson-tx/` 395 at 21.8, `/service-areas/panel-change-garland-tx/` 169 at 32.2, `/service-areas/richardson-tx/` 162, `/service-areas/mckinney-tx/` 150, `/service-areas/farmers-branch-tx/` 121 at 12.7. Google has already dropped them from the index; there is nothing live to stop.

### 2.10 SERP scan (40 SerpApi calls, 8 cities x 5 queries, 2026-09-06)

Caveat, observed in every file: SerpApi resolved the location to Dallas Fort Worth International Airport (`serp/*.json` `search_parameters.location_used`). Pack results are for an airport searcher. Organic results are less sensitive but not immune. No SerpApi call was made for this document and none should be until the next budgeted run.

| City | Verdict | Pack difficulty | Pack top (rating/reviews) | Giants (4.8+, 500+) | Queries with no pack | Directory share of organic | Score (lower is easier) |
|---|---|---|---|---|---|---|---|
| Wylie | WINNABLE | easy | JME Electric 5.0/130 | 0 | panel, EV, generator | 0.43 | -2.78 |
| Mesquite | WINNABLE organic, no demand yet | moderate | 5th Generation 4.9/230 | 0 | repair | 0.38 | 0.87 |
| Richardson | MODERATE | moderate | ElectricMan 4.8/583 | 1 | generator | 0.43 | 1.70 |
| Garland | HARD pack, panel/generator organic winnable | hard | Arrow Electric 4.9/889 | 2 | panel, EV | 0.43 | 4.20 |
| Rockwall | SPLIT: pack hard, organic winnable | hard | Milestone 4.9/1,500 | 1 | none | 0.50 | 5.00 |
| Plano | HARD | hard | Electrician On Call 4.9/717 | 2 | panel | 0.47 | 6.60 |
| Frisco | HARD | hard | Resilient Power 4.9/796 | 3 | none | 0.39 | 6.84 |
| McKinney | HARD, hardest of eight | very hard | Blue Line 4.9/820 | 3 | none | 0.31 | 8.57 |

Source: `serp-city-verdicts.json`, `serp-analysis.json` `verdicts` (score formula in scratchpad `research/analyze-serp.mjs` line 65; four of five terms are pack terms and inherit the airport bias). Grizzly appears in 0 of 40 packs and 0 of 40 organic top-10s (`grizzly_presence`). The organic winners across cities are multi-location brands with city-by-service page grids: callmilestone.com (16 hits, 7 cities), bakerbrothersplumbing.com (10, 5), mrelectric.com (9, 5) (`multi_city_organic_winners`). Directories hold a large share of organic: facebook.com 41 hits, yelp.com 29, thumbtack.com 17 (`directories_ranking_organic`). Note the Wylie SERPs were partly resolved to Lake Wylie, SC and Harford County, MD (`serp-organic.csv`), so "easiest" is weaker than it looks.

### 2.11 Weekly trend (56 days)

Clicks per week: 2 (3 days), 11, 17, 12, 4, 12, 8, 6, 7 (4 days). Impressions per week: 1,263 to 2,492. Average position moved from 26.0 to 20.1 without a click trend (`search-console-analysis.json` `weeklyTrend90d`). Observed: there is no growth line to defend or extend; the property is flat at 4 to 17 clicks a week.

### 2.12 What the live listing and the live site say (observed)

- GBP, read 2026-09-04: Rowlett pack #2; 5.0 with 154 reviews; hours shown as closes 6 pm, Mon-Fri 8-6, Sat 8-2; online estimates enabled; "3+ years in business" displayed (`outputs/archive/04a3760f/gbp_report.md` lines 22-26). The facts file says never "3+ years" and never quote a review count from memory; re-read at run time.
- GBP, read 2026-07-03: W3 Electric and Adis Electric run Local Services Ads in Rowlett; Grizzly does not (`outputs/archive/2026-07-03_150959/gbp_report.md` line 436).
- Site JSON-LD hours: Mon-Fri 08:00-18:00, Sat 08:00-14:00 (`index.html` lines 50-61). Facts file says Mon-Fri 8-5 and that the listing is authoritative when they differ.
- Site review claims: `reviewCount` "150" and `ratingValue` "5.0" in the homepage JSON-LD with six copied review objects (`index.html` lines 71-82); "150+" on `/reviews/` at lines 6, 7, 12, 13, 18, 19, 71, 74, 79, 159, 161 and `ratingValue` 5.0 at line 202. The listing showed 154 on 2026-09-04.
- The `/reviews/` "Leave us a review" button links to a Google Maps place URL, not the write-a-review link (`reviews/index.html` line 123).
- `areaServed` is one identical 14-city array in 22 files (Rowlett, Plano, Dallas, Fort Worth, Frisco, Arlington, Royse City, Garland, Rockwall, Irving, Grapevine, Richardson, McKinney, Farmers Branch; `index.html` line 64). Sachse, Wylie, Murphy, Sunnyvale and Mesquite are absent. The homepage city chips at line 1044 list the same 14 as plain spans, not links. The `/service-areas/` hub lists 11 "call for availability" cities (lines 121-130), no Mesquite or Sunnyvale.
- Homepage counters: `data-count="10"` under "Years Experience", 15 services, 100% licensed (`index.html` lines 780-783). The facts file says founded 2021, five years, never "over a decade".
- `/contact/` returns 404 but nothing in the repo links to it; the nav uses `#contact` (`live-checks-2026-09-06.json`; `index.html` line 721). The facts-file item about the nav link is probably stale.
- Business facts we do not have: review count and rating must be read live; no license number is published; pricing only from the live site or owner approval (`grizzly-business-facts.md`, "Facts we do not have").

## 3. Verified recommendations

Three recommendations survived. Each is restated with the skeptic fixes applied. All three are owner-gated: Claude drafts, the owner acts.

### R7. GBP hygiene for the home radius: Services list, 2 to 3 secondary categories, service areas, opening date, photos, hours confirmation

**What this is and is not.** This is home-radius hygiene for Rowlett, Garland, Wylie, Sachse and the near edge of Rockwall. It does not extend the pack beyond the Rowlett proximity radius. DFW expansion has to come from R8 and R9.

**What the owner does (Claude drafts the lists; the listing is never touched by Claude except through `scripts/gbp-profile-adapter.mjs` with owner approval, which can write hours and services but not categories):**

1. Services list (the step with the strongest evidence): fill the pre-defined Services list to mirror the 15 service pages: panel upgrade, EV charger, generator installation, generator inlet, surge protection, recessed lighting, rewire, troubleshooting, emergency, outlets/GFCI, smoke/CO, ceiling fans, inspections, light commercial. Use Google's predefined services where they exist; add custom entries only where there is no predefined match (generator inlet, light commercial). Sterling Sky's test (article updated 2026-02-27, finding from a 2022 retest) moved rankings within 24 to 72 hours after adding predefined services; the effect varies by market.
2. Categories: a 30-second check that "Electrician" is primary. Add at most 2 to 3 secondary categories that pass Google's "this business IS a" test (`support.google.com/business/answer/3038177`), for example "Electrical installation service" and a lighting or EV-charger contractor category if the picker offers one. Never one category per service page. Explicitly exclude "Electric vehicle charging station" and "Electric generator shop": the EV packs in `serp/ev-charger-installation-*.json` are charging stations, and a contractor with that category misrepresents itself.
3. Service areas (10-minute timebox, display only per Sterling Sky's test updated 2025-03-31): set the list to the owner-confirmed tier-1 and tier-2 cities from Section 5. That is 16 cities, under Google's cap of 20 within about a two-hour drive (`support.google.com/business/answer/9157481`). Align the site's `areaServed` array to the same list when the owner confirms (Section 4, surviving fixes).
4. Opening date: set to July/August 2021 so the pack stops showing "3+ years in business" (facts file: never "3+ years"; observed on 2026-09-04, `gbp_report.md` line 26).
5. Photos: upload recent job photos. Whitespark's 2026 factors rank photo quality #45; this is a conversion item, not a ranking item.
6. Hours: do not narrow GBP hours. GBP (Mon-Fri 8-6, Sat 8-2, `gbp_report.md` line 24) matches the live site JSON-LD (`index.html` lines 50-61). Only the facts file says 8-5, and the facts file itself says the listing is authoritative. Default action: ask the owner to confirm GBP is correct, then correct the facts file. Change the site only if the owner says GBP is wrong. Do not set "Open 24 hours" to chase Whitespark's #5 factor unless the phone is genuinely answered 24/7 (Google asks for regular customer-facing hours, `answer/3038177`).
7. Address: keep it hidden only if customers never visit 8902 Merritt Rd (`answer/9157481`, `answer/3038177`). Record the trade-off in the run note: Whitespark 2026 ranks "address showing on GBP" #7 and Sterling Sky's 2024-10-30 test saw ranking and call drops after hiding. Do not flip the setting either way without the owner's answer.
8. Keep exactly one profile. No virtual offices (`answer/3038177`).
9. Read and record the live review count and rating during the run (facts file requirement).

**Why.** The controllable pack factors are primary category (#1), open at time of search (#5), additional categories (#8), reviews and Services (Whitespark 2026 Local Search Ranking Factors). The profile already surfaces for generic searches near Rowlett, Garland and Wylie (Section 2.8, inference, corroborated by the observed Rowlett #2 pack position). Service-family pack eligibility near Rowlett is the target.

**Evidence.** `search-console-analysis.json` `localPackSignature`; `outputs/archive/04a3760f/gbp_report.md` lines 22-26; `index.html` lines 50-61; `grizzly-business-facts.md` "Hours" and "Facts we do not have"; Google help answers 7091, 3038177, 9157481; Sterling Sky services test (updated 2026-02-27) and service-area test (updated 2025-03-31); Whitespark 2026 factors.

**Baseline for the success test (observed, `search-console-90d-query-device-full.json`, desktop rows, filter by family keyword):** EV charger 0 of 471 desktop impressions at position 2 or better; generator 51 of 953; recessed lighting 9 of 180; surge 1 of 338; rewire 0 of 96; "emergency electrician" 296 desktop impressions at 3.8. (An earlier review counted EV at 586 with a broader keyword filter; direction is the same.) Re-pull the 28-day query+device report four weeks after the edit and report whether those families gained desktop impressions at position 2 or better and whether "emergency electrician" moved to 3 or better.

**Effort:** S to M, 1 to 2 hours in the GBP dashboard once the owner decides hours and the served-city list. **Owner-gated: yes.** **Category:** GBP.

**Skeptic fixes applied:** hours not narrowed and facts file corrected by default; service areas capped at 20 and labelled display-only; address setting left to the owner with the trade-off recorded; outcome reframed to near-Rowlett pack eligibility with a measurable baseline; categories capped at 2 to 3 with named exclusions; the 1,863-impression cluster labelled inference; opening date fix added; photo item labelled conversion-only; Sterling Sky citation corrected; adapter capability noted.

### R8. Review velocity through Housecall Pro and Nextdoor; no incentives, no gating, no keyword coaching; Nextdoor ask before Sept 9

**What the owner does:**

1. In Housecall Pro (review requests and reviews are already enabled per `get_organization_features`), turn on the automated post-job review request. Paste the GBP write-a-review short link from the Business Profile "Get more reviews" panel. Keep HCP's default delay and one follow-up at most. No incentive language. No filtering by satisfaction. HCP's messaging consent covers this.
2. Do not send review asks from the Twilio customer line (469) 896-3862 unless the customer texted that line first and the SMS terms and A2P campaign are updated to cover it. Use that line to reply inside threads the customer started.
3. Keep a QR code and short link on the invoice.
4. Nextdoor: this week, before Sept 9, claim or verify the free Nextdoor Business Page, copy the unique Fave link from the dashboard, and add it as a second line in the same HCP post-job template for the Sept 9 to 30 Fave Awards window only. Post to the page when there is a real job photo, not on a quota. Do not promise weekly feed reach; the US business feed was "coming soon" per Nextdoor's 2026-09-02 post.
5. Log the review count from the live listing every week so recency can be measured. No research file records it today.
6. Website (owner-gated, in the policy proposal JSON): replace the `/reviews/` CTA href at `reviews/index.html` line 123 with the GBP write-a-review link; remove the self-serving `aggregateRating` and the copied review array from `index.html` lines 71-82 and `reviews/index.html` lines 199-240 (Google's review-snippet guideline: pages with LocalBusiness data that control their own reviews are ineligible for stars); read the real count from the listing and correct "150+" at `reviews/index.html` lines 6, 7, 12, 13, 18, 19, 71, 74, 79, 159, 161 and the homepage `reviewCount` to the actual number, or drop the number.
7. Skip the "- {City}, TX" attribution idea unless HCP job records confirm the city. No evidenced benefit.

**Plain expectation.** Reviews support Local Services Ads ranking (R9, `support.google.com/localservices/answer/7527305`) and conversion in the Rowlett, Garland, Wylie, Rockwall, Sachse ring. They will not place Grizzly in Plano, Frisco or McKinney packs, where it holds zero positions in the scans and faces 500 to 1,500 review incumbents.

**Why.** Review recency and text outweighed total count in the largest 2025 study (Sterling Sky, 8,186 businesses, 2025-11-05); 74% of consumers filter on the last three months and 47% skip businesses under 20 reviews (BrightLocal LCRS 2026). Coaching keywords into reviews did not move rankings in Sterling Sky's controlled test (updated 2023-01-25; Whitespark 2026 ranks keywords in reviews #36). Incentives and gating violate Google policy (`support.google.com/business/answer/3474122`; `support.google.com/contributionpolicy/answer/7400114`). Nextdoor's Local Faves hub (2026-09-02) ranks purely by verified-neighbor Faves.

**Evidence.** `reviews/index.html` lines 6-19, 71-79, 123, 159-161, 199-240; `index.html` lines 71-82; `outputs/archive/04a3760f/gbp_report.md` line 23 (154 reviews); `grizzly-business-facts.md` "Contact" and "Facts we do not have"; `business.nextdoor.com/en-us/small-business/faves`; `blog.nextdoor.com/small-business-improvements` (2026-09-02; voting-window year inferred).

**Effort:** S to set up, then recurring per job. **Owner-gated: yes.** **Category:** reviews.

**Skeptic fixes applied:** mechanism moved from the Twilio line to HCP's built-in request; Nextdoor reach not promised and posting tied to real photos; city attributions dropped; hard-coded 150 / 5.0 fixed to the live number or removed; self-serving rating markup removed; weekly review-count log added; expectation limited to the home ring and LSA.

### R9. Local Services Ads across the home ring and the 15 to 25 mile ring

**What the owner does, in order:**

0. Sign in at `ads.google.com/localservices` and check for an existing or paused Google Guaranteed account. A 2023 owner photo was classified as a Google Guaranteed verification screenshot (weak vision-classifier inference, `state/electrical-qwen-takeout.json`). Reactivation may skip most of the screening. Also confirm current status: the last recorded observation is 2026-07-03, "Grizzly is not" running LSA (`outputs/archive/2026-07-03_150959/gbp_report.md` line 436).
1. Eligibility gate, phrased as the unknowns the facts file leaves open: (a) does Grizzly hold its own TDLR electrical contractor license (TECL) with a designated master electrician, or operate under another contractor's license? (b) does Carter hold a master license (Google requires an owner-level state license where applicable)? (c) is professional liability insurance in force in addition to general liability (both are on Google's electrician row, `support.google.com/localservices/answer/12174778`)? If (a) is no, drop R9 entirely. If the master of record is not the owner, flag it as a blocker. Never record the license number in the repo.
2. Gather documents: TDLR license (supplied to Google, never published), general and professional liability certificates, the verified GBP, business and owner background checks.
3. Submit the application this week. Google states screening averages 3 to 4 weeks after documents, with extra background checks for electricians (`answer/12174778`). First charged leads are unlikely before roughly mid-October 2026. The in-month deliverable is a submitted application; for the first month the tracker logs application status, not leads.
4. Service area: include the home cities (Rowlett, Garland, Sachse, Wylie, Murphy, Rockwall) because they will be the cheapest leads, and add Richardson, Plano, Mesquite, McKinney and north-east Dallas as the test of ring reach. Do not exclude home zips.
5. Job types are account-wide, not per city. Either accept low-ticket troubleshooting calls from 20 miles away or restrict to panel, EV charger, generator and rewire. Do not list "emergency electrician" unless the owner will answer at 2 a.m. from Plano.
6. One-truck operations: enable message leads (`answer/12492201`, cheaper and 24/7); route the LSA phone lead to whichever line is actually answered during jobs (the Twilio customer line is the candidate; owner decides); answer or return every call the same day (missed calls lower LSA rank); dispute out-of-area or non-serviceable leads; add photos to the LSA profile.
7. Budget: weak vendor evidence puts the Dallas metro at roughly $40 to $70 per lead with about a 44% book rate, so roughly $100 to $160 per booked job. The owner sets the weekly cap.
8. Log every charged lead's zip and job type in the weekly tracker. After 8 weeks of live ads, report leads and cost per lead split home cities versus ring, then keep, rebalance the service area, or stop on that split.

**Why.** All four research reports agree the pack will not reach Richardson, Plano, McKinney or Dallas from a Rowlett address (Whitespark 2026-06-05: moving or opening a second location is the only true fix). LSA is the per-lead Google channel with the Google Guaranteed badge that shows to people located in, or searching for, a named city regardless of business address (`answer/7419052`). Google Ads location targeting (`support.google.com/google-ads/answer/1722038`) also reaches the ring but bills per click. Ranking caveat from `answer/7527305`: bid, responsiveness, search-context location and review count all rank the ad; with 154 reviews against 345 to 25,000 for observed DFW LSA occupants, expect spend to skew toward the home area at first. Pair with R8.

**Evidence.** `search-console-analysis.json` `localPackSignature` (pack-like position 1 only within about 8 miles, inference) and `citiesRanked90d` (Richardson 359 impressions, 250 of them on a URL that now 404s; McKinney, Plano, Dallas on pages 3 to 5 with 0 to 1 clicks); `outputs/archive/2026-07-03_150959/gbp_report.md` line 436 (W3 and Adis run LSA above Grizzly's #2 organic pack slot in Rowlett); `grizzly-business-facts.md` (licensed and insured, no license number published, no LSA mention); Google LSA help answers 7419052, 7527305, 7496631, 12174778, 12492201; `tdlr.texas.gov/electricians`. The "0 of 40 packs" figure is not used as evidence here because of the airport location caveat.

**Effort:** M. Application and verification take days to weeks; ongoing spend is an owner decision. **Owner-gated: yes.** **Category:** paid.

**Skeptic fixes applied:** evidence rewritten without the airport-biased pack count and without Fort Worth impressions; "only channel" replaced with "per-lead channel" and Google Ads named as the per-click alternative; retitled to include the home ring; eligibility made the first gate with the license unknowns spelled out; step 0 account check added; timeline set from Google's own figure; one-truck operating rules and job-type choice added; budget stated as weak vendor evidence; 8-week home-versus-ring success test added.

## 4. Dropped recommendations and why

One line each. Full reasoning is in the review notes that produced this document.

- **R1. Link the homepage to the city pages in a crawlable block.** Dropped: the city pages already have 20 inbound internal links each and still faded in August; part (5) was already live; the FAQPage entry earns nothing; the mechanism does not address a proximity problem.
- **R2. Make the Rockwall page the Rockwall answer and cover Rockwall County.** Dropped: the page already has every section the recommendation asks for (1,837 words); the 1,474 impressions are page 4 to 5 loads, not a lead pool; a county section naming Heath, Fate and Royse City without jobs there is the doorway pattern; no SERP was scanned for those towns.
- **R3. 301 the 13 legacy URLs and close the slash-variant leak.** Dropped: the slash split closed on 2026-07-18 (`vercel.json` `trailingSlash: true`); the 13 URLs had 0 impressions and 0 clicks in the last 28 days and are already de-indexed; redirecting 8 city URLs to the hub is the pattern Google warns against; the `/contact-us` hop cannot be removed as specified.
- **R4. Rebuild Richardson at its legacy URL now; queue Mesquite.** Dropped: the legacy URLs had 0 impressions in the last 28 days, so nothing is "disappearing"; the same template has 33 impressions and 0 clicks across six pages in 28 days; Richardson generator demand is 3 impressions; no evidenced Richardson jobs or photos exist.
- **R5. Add service sections to the Wylie and Garland pages.** Dropped: both pages already carry those sections and links; "no local pack" is an airport-scan artifact and the Wylie SERPs partly resolved to South Carolina and Maryland; Wylie panel and EV demand is zero and Garland is about 60 impressions in 56 days.
- **R6. Answer the cost and permit questions on the blog posts.** Dropped: nine of the ten price points cannot be quoted under the facts-file pricing rule; the posts already cover the topics without numbers; all blog posts combined earned 1 click in 56 days; FAQ rich results are gone for this class of site.
- **R10. Citation and NAP pass.** Dropped: the brand-query evidence was misread (those are other entities' names showing this site); no NAP inconsistency is observed; Google's LSA and GBP docs do not mention citations; the listed directories carry paid memberships; citations cannot move the GBP pin.
- **R11. Crawl and structured-data hygiene batch.** Dropped as a batch: the two "invisible" posts are already indexed with 114 and 103 impressions; `areaServed` is not a documented LocalBusiness property; the `foundingDate` item would contradict the on-page "10+ years" counter; the owner gate was manufactured by a served-city question the facts file already answers.
- **R12. Freeze a measurement baseline before any change ships.** Dropped: the baseline is already frozen in `search-console-manifest.json` and `search-console-analysis.json` (2026-09-06); Google retains 16 months; the search-appearance exit condition can never fire; a weekly collector already exists in `scripts/weekly/lib/collectors/search-console.mjs`.
- **R13. Pipeline policy: tiers, SerpApi location, service-by-city focus.** Dropped as a bundle: per-city SerpApi location and a service-focus block are code changes, not config; position 8-30 already scores 1.0; utility-intent de-weighting is moot; the tier scores are built from the airport-biased pack terms. The one surviving piece, the weight inversion (Rowlett at 0.9 ranks 22nd in the live selector), is what the policy proposal JSON fixes.

**What survives from the dropped items.** Small, no-ranking-claim fixes that cost minutes and were verified as real by the reviewers. They are listed as owner-gated `website_actions` in the policy proposal JSON, at low or medium priority: remove the self-serving rating markup and fix the review count (from R8 and R11); align `areaServed`, the homepage chips and the hub list to the confirmed city list, including the Wylie page's array that omits Wylie (R5, R11); convert the six homepage chips for cities with pages into links (R1, R2, 20 to 30 minutes); add Mesquite and Sunnyvale to the hub's "call for availability" list (R4); redirect the five service-specific legacy URLs to their matching live service pages and leave the eight city URLs as 404 (R3); add the two 2026-07-31 posts to the sitemap with Article JSON-LD and shorter titles (R6, R11); fix the known counter, placeholder and nav items (R11, facts file).

## 5. Target cities and tiers

Tier meaning for the weekly pipeline (`config/weekly-policy.json` `cities[]`): tier 1 is the home ring where the profile, the site and LSA can all win now; tier 2 is the next ring, reached by LSA and service-page content, tracked by SerpApi, no generic city pages; tier 3 is tracking only. Weights are multipliers around 1.0. The live selector barely discriminates on demand because city-less queries count toward every city (`scripts/weekly/lib/select.mjs` line 512), so the weight is the tie-breaker and the order below encodes intent. The current file has Rowlett at 0.9, which ranks the home base 22nd of 24 in a simulation on the real 28-day rows (R13 review, scratchpad `sim-r13.mjs`).

Changes from the draft tiers: Rowlett moves to the top weight (the inversion fix). Richardson and Mesquite move from tier 1 to tier 2 because the page builds that justified tier 1 (R4) were dropped and their last-28-day demand is 36 and 4 impressions. With that change tier 1 plus tier 2 is 16 cities, which fits Google's 20-city service-area cap without dropping anyone.

| City | Tier | Weight | Reason (observed unless marked) |
|---|---|---|---|
| Rowlett | 1 | 1.20 | Home base. Only city on page 1 to 2: 1,635 impressions at 11.1, 5 of 8 non-brand clicks; 18 queries at position 8-30 (1,126 impressions) are the nearest click gain (`citiesRanked90d`, `expansionSummary.byCity`). Pack #2 with 154 reviews. |
| Rockwall | 1 | 1.15 | Largest non-Rowlett demand: 1,474 impressions, 0 clicks at 40.3; #1 city in the last 28 days (909). Homepage answers "electrician rockwall tx" at 43.5. Pack hard (Milestone 4.9/1,500). Page exists. Cheapest LSA ring city at 7 miles. |
| Garland | 1 | 1.10 | 5 miles; 573 impressions at 11.5; "electrician garland" 300 desktop at 1.4 (inference: pack Website link). Panel and generator organic thin per the scan. Page exists. |
| Wylie | 1 | 1.00 | Easiest scanned SERP (score -2.78, ceiling 130 reviews) but tiny demand (148 impressions, 103 of them the desktop pack signature). Page exists at 22.5. Maintain. |
| Sachse | 1 | 0.95 | Adjacent; 117 impressions at 5.6, 28-day position 1.4. Page exists. Maintain. Not SERP-scanned. |
| Sunnyvale | 1 | 0.90 | Never named on the site, yet the homepage draws 88 impressions at 39.5 for "electrician sunnyvale tx". About 9 miles. Add to `areaServed` and the hub list; no page until owner proof. |
| Murphy | 1 | 0.90 | Page exists; 38 impressions at 12.6 in 56 days, 0 in the last 28. Maintain only. |
| Richardson | 2 | 1.00 | 15 miles. 359 impressions at 25.2 but 36 in the last 28 days after the legacy URL 404'd. Pack moderate (ElectricMan 4.8/583); generator SERP has no pack. First LSA ring test city. No city page until owner-supplied jobs. |
| Dallas | 2 | 0.95 | 261 impressions at 26; the only foothold is recessed lighting (111 at 16.8 on /recessed-lighting/). Pack unreachable at 20+ miles. Recessed-lighting service-page content and north-east Dallas LSA zips only. |
| Mesquite | 2 | 0.95 | 12 miles; 4 impressions; never named on the site. Scan says organic winnable (score 0.87, no giants). GBP service area and LSA now; page only with owner-supplied jobs and photos (doorway risk). |
| Plano | 2 | 0.90 | 160 impressions at 36; pack hard (six 100+ members, two giants); panel SERP has no pack. Service-page content and LSA only. |
| Royse City | 2 | 0.90 | 117 impressions at 45 on the homepage; Rockwall County. GBP service area and LSA zips; no content until jobs exist. |
| McKinney | 2 | 0.85 | 330 impressions at 31.5 with a broad family mix (EV 97, surge 50, panel 34, smoke/CO 29) and the hardest scanned SERP (score 8.57, three giants). 25 miles. EV, surge and smoke content on service pages plus LSA. No city page. |
| Heath | 2 | 0.85 | 30 impressions at 47; never named on the site. Rockwall County; GBP service area only. |
| Forney | 2 | 0.80 | 0 impressions; never named; not scanned; about 15 miles. Track only. |
| Fate | 2 | 0.80 | 0 impressions; never named; not scanned. Rockwall County; track only. |
| Frisco | 3 | 0.80 | 103 impressions at 35.7, one panel cluster on /panel-upgrades/. Scan hard (score 6.84, three giants). 30 miles. Panel and EV service-page content only. |
| Fort Worth | 3 | 0.80 | #3 city by impressions (1,142, 0 clicks) entirely through DFW-generic service pages on pages 3 to 5. About 45 miles. A service-page signal, not a city to chase. Owner to decide whether "Rockwall to West Fort Worth" stays a claimed range. |
| Allen | 3 | 0.75 | 8 impressions; not scanned; about 25 miles. Revisit after LSA data. |
| Greenville | 3 | 0.70 | New, pending owner confirmation it is served. Largest non-policy place in Search Console (335 impressions at 51.6, 251 in the last 28 days), Hunt County, about 30 minutes east. Tracking only; no content until confirmed. |
| Carrollton | 3 | 0.70 | 0 impressions; never named; about 30 miles. |
| Irving | 3 | 0.70 | 0 impressions; in `areaServed` only; about 35 miles. |
| Arlington | 3 | 0.65 | 0 impressions; in `areaServed` only; 35+ miles. |
| Denton | 3 | 0.60 | 2 impressions; about 45 miles. |
| Waxahachie | 3 | 0.60 | 0 impressions; the "McKinney to Waxahachie" phrase from the facts file does not appear on the site. |

Grapevine (154 impressions at 47.2) and Farmers Branch (a 121-impression legacy URL) appear in the site's `areaServed` but are deliberately not added as policy cities; the owner decides whether they stay in `areaServed`.

## 6. A 90-day sequence

Dates assume a start on Monday 2026-09-07.

**Weeks 1-2 (Sept 7 to Sept 20): decisions, listing, reviews, application.**

1. Owner decisions (Section 8): hours, served-city list, review count, LSA status and license facts, address visibility, Greenville.
2. R8 before Sept 9: claim or verify the Nextdoor Business Page; copy the Fave link. Turn on HCP's automated review request with the GBP write-a-review link; add the Fave line for Sept 9 to 30. Read and log the live review count (week 1 baseline).
3. R7: Services list, 2 to 3 secondary categories, service areas (the 16 tier-1 and tier-2 cities), opening date 2021, photos. Record the date of the edit; the R7 success test runs four weeks later.
4. R9: step 0 account check, eligibility answers, documents, application submitted.
5. Website PR 1 (owner-gated, one PR, about 2 hours): the `website_actions` in the policy proposal JSON. Deploy only after the owner confirms the city list and the review number.
6. Internal, no gate: adopt the tiers and weights from the policy proposal into `config/weekly-policy.json` once the owner confirms the served-city list, and record the R7 edit date and the review-count baseline in the weekly tracker.

**Weeks 3-6 (Sept 21 to Oct 18): screening, cadence, first check.**

1. R9: LSA screening runs (3 to 4 weeks). Set the weekly budget, job types, message leads and the phone routing before approval lands. Tracker logs application status.
2. R8: weekly review-count log; Nextdoor window closes Sept 30; post to the page only with real job photos.
3. Weekly pipeline runs under the new tiers: GBP posts with real job photos, home ring first.
4. Week 6 (around Oct 12): re-pull the 28-day query+device report and run the R7 success test (Section 7). Report it plainly, including "no change".

**Weeks 7-12 (Oct 19 to Nov 29): leads, evidence, decisions.**

1. R9 live: log every charged lead's zip and job type; answer or return every call the same day; dispute out-of-area leads. Rebalance the service area only on the logged split.
2. Week 12: second Search Console check (Rowlett 8-30 cluster, pack-signature families, city-page trend) and the LSA split so far. Eight full weeks of LSA data will likely land after week 12; the keep, rebalance or stop decision waits for it.
3. Content decisions come after evidence: a Mesquite or Richardson page is considered only if LSA leads and completed jobs with photos exist there. Fort Worth, Arlington and Irving claims on the site are decided by the owner, not by content work.
4. Nothing in this window adds generic city pages, programmatic cost pages or blog FAQs.

## 7. Measurement

All Search Console pulls reuse the existing collector and the `pull-search-console.mjs` scratch script; Google retains 16 months, so every window can be re-pulled later. GBP numbers are read from the listing by the owner or through the read paths already in the repo; nothing writes to the listing.

| Metric | Baseline (observed) | Source | Should move by | Target and how to read it |
|---|---|---|---|---|
| Live GBP review count and rating | 154 at 5.0 on 2026-09-04 | `outputs/archive/04a3760f/gbp_report.md` line 23 | weekly from week 1 | Steady weekly additions after HCP automation is on; any week with 0 new reviews is flagged. Count on the site matches the listing (binary). |
| Desktop impressions at position 2 or better, by service family (28-day query+device) | EV 0 of 471; generator 51 of 953; recessed 9 of 180; surge 1 of 338; rewire 0 of 96 (56-day baseline) | `search-console-90d-query-device-full.json` | week 6, four weeks after the R7 Services edit | Any family gaining desktop position 2 or better impressions is a pass for R7. No change is reported as no change. |
| "emergency electrician" desktop position | 3.8 on 296 desktop impressions | same file | week 6 | Moves to 3 or better. |
| Rowlett position 8-30 cluster | 18 queries, 1,126 impressions; "electrician rowlett tx" 355 at 10.8 | `expansionSummary.byCity`, `keyQueryDeviceSplit` | week 12 | "electrician rowlett tx" toward 7 or better; cluster impressions per day rising. |
| Non-brand clicks per day | 8 in 56 days (0.14/day); 2 in 28 days | `brandVsNonBrand` | reported, not targeted | Too small to be a KPI; report the per-day rate to avoid week-to-week noise. |
| City-page impressions (six pages, 28-day) | 33 | `pages28d` | week 6 and 12 | Diagnostic only: does the August collapse continue, stabilize or reverse. |
| Legacy 404 impressions (28-day) | 0 | `live-checks-2026-09-06.json` | week 6 | Stays 0 after the five service-URL redirects; confirms nothing was lost. |
| LSA status | not running (2026-07-03) | `2026-07-03_150959/gbp_report.md` line 436 | application by week 2; live by about week 6 | Application submitted; verification complete; first charged lead date recorded. |
| LSA charged leads, cost per lead, home versus ring | none | weekly tracker (new column) | 8 weeks after go-live | Keep, rebalance or stop on the home-versus-ring split and cost per booked job. |
| GBP calls, direction requests, website clicks | unknown | owner reads from the Performance tab | week 1 baseline, then monthly | Direction only; no target until a baseline exists. |
| Nextdoor Faves | Business Page not yet claimed | Nextdoor dashboard | Sept 30 | Page claimed before Sept 9; Fave count read on Oct 1. |

Things that should not be read as success: property impressions rising while clicks stay flat (pages 3 to 5 loads), homepage impressions rising for far cities, and any pack claim without a live read.

## 8. Open questions for the owner

1. Hours: GBP and the site say Mon-Fri 8-6 and Sat 8-2; the facts file says Mon-Fri 8-5. Is GBP right? If yes, the facts file is corrected and nothing else changes.
2. Served-city list: confirm the 16 tier-1 and tier-2 cities in Section 5 for the GBP service areas and the site's `areaServed`. Do Grapevine, Farmers Branch, Fort Worth, Arlington and Irving stay in `areaServed`? Does "Rockwall to West Fort Worth" stay as a claimed range?
3. Is Greenville served?
4. Address: do customers ever visit 8902 Merritt Rd? Is the address currently shown or hidden on the profile?
5. Review count: read it from the listing today. Should the site show the exact number or drop the number?
6. Is a Google Guaranteed / Local Services Ads account already open or paused? Does Grizzly hold its own TDLR contractor license with a designated master, does Carter hold a master license, and is professional liability insurance in force? (Answers stay out of the repo except yes/no.)
7. LSA operating choices: weekly lead budget, job types (all, or panel, EV, generator, rewire only), whether to list emergency, and which line answers LSA calls.
8. Homepage counters: what are the three real numbers? "10+ Years Experience" conflicts with founded 2021.
9. The contact form placeholder (469) 555-0123 and the nav Contact item: confirm the fix; the nav item appears already resolved (no link to `/contact/` exists).
10. Can HCP's automated review request be switched on this week, and may the Nextdoor Fave line be added to the same template for Sept 9 to 30?
11. Photos: are there recent job photos for GBP and Nextdoor, and do any come from Richardson, Mesquite, Rockwall County or Sunnyvale? (This decides whether those places ever get a page.)
12. Secondary categories: which 2 to 3 of the picker's options describe what the business IS?

## Appendix: files read for this document

Research: `state/weekly/research/search-console-manifest.json`, `search-console-analysis.json`, `search-console-90d-device.json`, `search-console-28d-device.json`, `search-console-90d-search-appearance.json`, `search-console-90d-query-device-full.json`, `serp-city-verdicts.json`, `serp-analysis.json`, the `serp/` file listing; scratchpad `research/live-checks-2026-09-06.json` and folder listing. Repo: `config/weekly-policy.json`, `knowledge/baselines/grizzly-business-facts.md`, `outputs/archive/04a3760f/gbp_report.md` (lines 1-26), `outputs/archive/2026-07-03_150959/gbp_report.md` (line 436). Website (read-only): `index.html` (lines 50-64, 71-82, 780-783, 1044), `reviews/index.html` (lines 6-19, 71-79, 121-125, 159-161, 202), `service-areas/index.html` (lines 119-132). No SerpApi or Search Console calls were made. Nothing was changed, published or posted. No keys, tokens or secret values were read or printed.
