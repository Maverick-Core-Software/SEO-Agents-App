# Grizzly Website Structure Reference

Live site: https://www.grizzlyelectricaltx.com/ — static HTML, no CMS.
Repo: C:\Workspace\Active\Grizzly Launch\grizzly-website (github.com/barnscarter-ops/grizzly-website, branch main).
Deploy: Vercel builds automatically on every push to main. Rollback = git revert + push.

Generated 2026-08-01 from index.html (~1,190 lines, ~71 KB) after the 2026-07-31 SEO rebuild.
Section ids `hero` and `footer` were added 2026-08-01 (commit 5a1e540) so parse_sections can key every block.
If the site is redesigned, regenerate this file.

## Files
| Path | Purpose |
|---|---|
| index.html | The entire homepage — every section below lives here |
| 404.html | Not-found page |
| blog/ | Static blog pages created by the Website Manager (/blog/<slug>/index.html + blog/index.html listing) |
| panel-upgrades/, ev-charger-installation/, generator-installation/, generator-inlet-installation/, recessed-lighting/, electrical-troubleshooting/, outlet-switch-installation/, ceiling-fan-installation/, electrical-inspections/, whole-home-rewire/, whole-home-surge-protection/, smoke-co-detector-installation/, emergency-electrician/, commercial-electrical/, reviews/, service-areas/ | Standalone service/landing pages (each dir = index.html), linked from homepage service rows and footer nav |
| privacy-policy/, sms-terms/ | Standalone compliance pages |
| uploads/ | Images (gallery photos gallery-1a.jpg … gallery-9b.jpg, grizzly-logo.png, etc.) |
| sitemap.xml, robots.txt | 31-URL sitemap + crawler rules |
| vercel.json | Hosting config incl. redirects — do not edit without a specific task (no _redirects file anymore) |

## index.html sections (keys used by the Website Manager)
Section keys come from the block's id. All `<section>`/`<footer>` blocks must have a unique `id` attribute (parse_sections raises if one is missing). The two JSON-LD blocks in `<head>` are also keyed.

| Key | Block | What's inside |
|---|---|---|
| local-schema | `<script type="application/ld+json">` in head (~line 33) | LocalBusiness/Electrician schema: NAP, openingHoursSpecification, areaServed (14 cities), aggregateRating, 6 reviews |
| faq-schema | `<script type="application/ld+json">` in head (~line 86) | FAQPage schema — 7 questions, must mirror the #faq section |
| hero | `<section class="hero" id="hero">` (~line 754) | Hero: h1 "Dallas-Fort Worth Electrician.", sub "Quality Work. Fair Price. Every time.", call CTA, hero images, stats row (10+ yrs / 24-7 / 15+ services / 100% licensed) |
| services | `<section id="services">` (~line 805) | "Electrical services for every need." — 20 service rows, most linking to standalone service pages |
| about | `<section id="about">` (~line 841) | "Owner-operated. Code-obsessed. Always on call." — owner story, discount chips, 4 pillars |
| commercial | `<section class="sec comm" id="commercial">` (~line 870) | "Commercial electrical for DFW business." — 30% stat, 4 commercial service items, link to /commercial-electrical/ |
| gallery | `<section id="gallery">` (~line 892) | "Our work speaks for itself." — 9 project cards with before/after hover images from /uploads/ |
| reviews | `<section id="reviews">` (~line 943) | 6 testimonial cards — same 6 reviews as the local-schema review array; keep them in sync |
| emergency | `<section class="emg" id="emergency">` (~line 967) | Red 24/7 emergency strip with big phone link |
| faq | `<section id="faq">` (~line 977) | "Answers before you call." — 7 accordion FAQ items (mirror faq-schema; some answers link to blog posts) |
| contact | `<section id="contact">` (~line 1017) | Call/Text block, Hours block (Mon–Fri 8–6, Sat 8–2, Sun closed), address + Google Maps embed, area chips, socials, Formspree form (action https://formspree.io/f/meebvlze) |
| footer | `<footer class="site-foot" id="footer">` (~line 1078) | NAP line (name · 8902 Merritt Rd, Rowlett, TX 75089 · phone · GBP link), footer nav (service pages, blog, reviews, service areas), legal |

Not keyed (plain `<div>`s, invisible to parse_sections): sticky header + nav overlay (~line 700s), sms-strip text-quote banner (~line 789), service-area marquee (~line 797), toast (~line 1102).

Exact current keys at any time:
`PYTHONPATH=src python -c "from seo_agents.website import load_index, parse_sections; print(list(parse_sections(load_index())))"`

## Conventions
- Single `<style>` block (~line 135) with CSS variables: --ink #0c0b0a backgrounds, --paper #f3efe6 text, --red #d63c14 brand red. Fonts Barlow Condensed (headings) / Barlow (body) / Instrument Serif (italic `<em>` accents). Alternating dark/light sections via the `on-light` class.
- Scroll animations use `class="reveal"` plus an optional `style="--d:.15s"` delay — never remove them. (The old data-reveal attributes are gone.)
- Business hours appear in TWO places: the contact section Hours block (~line 1031) AND the JSON-LD openingHoursSpecification in local-schema (~line 50). An hours change must update both (the adapter flags this in its run notes).
- Main phone (469) 863-9804 appears in: meta/OG descriptions (head), local-schema, header, nav overlay, hero CTA, emergency section, contact section, footer NAP, and the form toast (~line 1102). Text line (469) 896-3862 appears in: nav overlay, sms-strip, the "Are quotes really free?" FAQ answer, and faq-schema.
- The reviews section cards and the local-schema `review` array carry the same 6 reviews — change one, change both.
- Service rows in #services link to the standalone service-page directories; keep hrefs valid when renaming pages (sitemap.xml lists all 31 URLs).
- Blog pages are self-contained (own head, fonts, styles); the homepage nav overlay and footer both link to /blog/.
