# Grizzly Website Structure Reference

Live site: https://www.grizzlyelectricaltx.com/ — static HTML, no CMS.
Repo: C:\Workspace\Active\Grizzly Launch\grizzly-website (github.com/barnscarter-ops/grizzly-website, branch main).
Deploy: Vercel builds automatically on every push to main. Rollback = git revert + push.

Generated 2026-07-09 from index.html (~1,270 lines, ~84 KB). If the site is redesigned, regenerate this file.

## Files
| Path | Purpose |
|---|---|
| index.html | The entire homepage — every section below lives here |
| 404.html | Not-found page |
| blog/ | Static blog pages created by the Website Manager (/blog/<slug>/index.html + blog/index.html listing) |
| privacy-policy/, sms-terms/ | Standalone compliance pages |
| uploads/ | Images (gallery photos gallery-1a.jpg … gallery-5b.jpg, etc.) |
| vercel.json, _redirects | Hosting config — do not edit without a specific task |

## index.html sections (keys used by the Website Manager)
Section keys come from the block's id, or a slug of its first heading when it has no id.

| Key | Block | What's inside |
|---|---|---|
| top | `<section id="top">` | Hero: h1 "QUALITY WORK. FAIR PRICE. EVERY TIME.", tagline, CTAs, phone banner |
| services | `<section id="services">` | "ELECTRICAL SERVICES" — 16 service cards |
| about | `<section id="about">` | "OWNER-OPERATED. CODE-OBSESSED. ALWAYS ON CALL." — owner story |
| commercial-electrical-for-dfw-businesses | `<section>` (no id) | "COMMERCIAL ELECTRICAL" pitch |
| gallery | `<section id="gallery">` | "OUR WORK SPEAKS" — 8 project cards, images from /uploads/ |
| reviews | `<section id="reviews">` | Customer testimonials (6 cards) |
| section-9 | `<section class="pg emg-bar">` | Red 24/7 emergency strip (#cc2200) — no id, no heading |
| faq | `<section id="faq">` | "ANSWERS BEFORE YOU ASK" — FAQ items |
| contact | `<footer id="contact">` | Hours block (Mon–Fri 8AM–6PM, Sat 8AM–2PM, Sun Closed), contact info, Formspree form (action https://formspree.io/f/meebvlze) |

Exact current keys at any time:
`PYTHONPATH=src python -c "from seo_agents.website import load_index, parse_sections; print(list(parse_sections(load_index())))"`

## Conventions
- Inline styles on nearly every element; fonts Oswald (headings) / Barlow (body); colors #090909/#0d0d0d backgrounds, #f0ebe4 headings, #cc2200 brand red.
- data-reveal / data-reveal-delay attributes drive scroll animations — never remove them.
- Business hours appear in TWO places: the footer Hours block AND the JSON-LD openingHoursSpecification in <head> (~line 331). An hours change must update both (the adapter flags this in its run notes).
- Phone numbers appear in the hero banner, emergency bar, and footer.
- Blog pages are self-contained (own <head>, fonts, styles) — the homepage does not yet link to /blog/.
