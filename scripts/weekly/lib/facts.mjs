// scripts/weekly/lib/facts.mjs
// Loads knowledge/baselines/grizzly-business-facts.md into a typed object.
// The file is owner-reviewed prose organised under `##` headings; we parse by
// heading keyword (not position) so the owner can reorder or retitle sections
// without breaking the pipeline. Anything we cannot find is null / [] — never
// invented — so downstream validation fails closed instead of guessing.
import fs from 'node:fs';
import { FACTS_PATH } from './paths.mjs';

const PHONE_RE = /\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /https?:\/\/[^\s)]+/;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;
const PATH_RE = /\/[a-z0-9][a-z0-9-]*\//gi;
const QUOTED_RE = /"([^"]+)"/g;

/** Split markdown into `##` sections: [{ heading, lines }]. Text before the first heading has heading ''. */
function splitSections(lines) {
  const sections = [{ heading: '', lines: [] }];
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) sections.push({ heading: m[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

/**
 * Group a section's lines into blocks: bullets (`- ` / `* `, continuation lines
 * indented) and paragraphs (runs of non-blank, non-bullet lines).
 */
function blocks(section) {
  const out = [];
  let cur = null;
  const close = () => { if (cur) { out.push({ kind: cur.kind, text: cur.parts.join(' ').replace(/\s+/g, ' ').trim() }); cur = null; } };
  for (const line of section ? section.lines : []) {
    if (!line.trim()) { close(); continue; }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) { close(); cur = { kind: 'bullet', parts: [bullet[1]] }; continue; }
    if (/^\s/.test(line) && cur) { cur.parts.push(line.trim()); continue; }
    if (cur && cur.kind === 'para') { cur.parts.push(line.trim()); continue; }
    close();
    cur = { kind: 'para', parts: [line.trim()] };
  }
  close();
  return out;
}

const bullets = (section) => blocks(section).filter((b) => b.kind === 'bullet').map((b) => b.text);
const paragraphs = (section) => blocks(section).filter((b) => b.kind === 'para').map((b) => b.text);

/** First section whose heading contains every needle (case-insensitive). */
function findSection(sections, ...needles) {
  return sections.find((s) => needles.every((n) => s.heading.toLowerCase().includes(n))) || null;
}

/** Value of the bullet that starts with `Label:` (case-insensitive), or null. */
function field(items, label) {
  const re = new RegExp(`^${label}\\s*:\\s*(.*)$`, 'i');
  for (const item of items) {
    const m = item.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

const firstItem = (items, re) => items.find((t) => re.test(t)) || null;
const afterColon = (text) => (text.includes(':') ? text.slice(text.indexOf(':') + 1) : text);
const splitList = (text) => text.split(',').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
const sentences = (text) => text.split(/\.\s+|\.$/).map((s) => s.trim()).filter(Boolean);
const unique = (list) => [...new Set(list)];

function normalizePhone(text) {
  const digits = text.replace(/\D/g, '');
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : text.trim();
}
const phonesIn = (text) => (text ? [...text.matchAll(PHONE_RE)].map((m) => normalizePhone(m[0])) : []);

function parseServiceArea(value) {
  if (!value) return [];
  const out = [];
  for (const s of sentences(value)) {
    const base = s.match(/^home base is\s+(.+)$/i);
    if (base) { out.push(base[1].trim()); continue; }
    if (s.includes(':')) {
      for (const span of afterColon(s).split(',')) {
        for (const place of span.split(/\s+to\s+/)) { const p = place.trim(); if (p) out.push(p); }
      }
      continue;
    }
    out.push(s);
  }
  return unique(out);
}

/** Quoted phrases in the clause that follows a keyword ("Say" / "Never"), e.g. Say "since 2021" or "five years". */
function quotedAfter(text, keyword) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(new RegExp(`\\b${keyword}\\b([^.]*)`, 'gi'))) {
    for (const q of m[1].matchAll(QUOTED_RE)) out.push(q[1]);
  }
  return unique(out);
}

function parsePriorityServices(section) {
  const out = [];
  for (const para of paragraphs(section)) {
    for (const s of sentences(para)) {
      for (const item of s.split(',')) {
        const cleaned = item.trim().replace(/\s+(first|second|third|fourth|last)$/i, '').trim();
        if (cleaned) out.push(cleaned);
      }
    }
  }
  return unique(out);
}

/** Parse facts markdown text. Pure; exported for tests and fixtures. */
export function parseFacts(text) {
  const raw = String(text);
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const title = (lines.find((l) => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim();
  const sections = splitSections(lines);

  const identity = bullets(findSection(sections, 'identity'));
  const contact = bullets(findSection(sections, 'contact'));
  const hoursSection = findSection(sections, 'hours');
  const platformSection = findSection(sections, 'platform');
  const pagesSection = findSection(sections, 'page');
  const prioritySection = findSection(sections, 'priority');
  const issuesSection = findSection(sections, 'known', 'issue');
  const pricesSection = findSection(sections, 'approved', 'price');

  // Identity
  const founded = field(identity, 'Founded');
  const yearMatch = founded ? founded.match(YEAR_RE) : null;
  const founded_year = yearMatch ? Number(yearMatch[0]) : null;
  const tenure_phrases = quotedAfter(founded, 'Say');
  const tenure_phrase = tenure_phrases[0] || (founded_year ? `since ${founded_year}` : null);
  const forbidden_phrases = quotedAfter(founded, 'Never');
  const addressRaw = field(identity, 'Address');
  const address = addressRaw ? addressRaw.replace(/\s*\([^)]*\)\s*$/, '').trim() : null;

  // Contact — match phone lines by role keyword, fall back to document order.
  const contactText = contact.join('\n');
  const customerLine = firstItem(contact, /customer (text|line)|text and call|text us/i);
  const mainLine = firstItem(contact, /published main|main number/i);
  const allPhones = unique(phonesIn(contactText));
  let customer_text = customerLine ? phonesIn(customerLine)[0] || null : null;
  let published_main = mainLine ? phonesIn(mainLine)[0] || null : null;
  if (!customer_text) customer_text = allPhones.find((p) => p !== published_main) || null;
  if (!published_main) published_main = allPhones.find((p) => p !== customer_text) || null;
  const emailMatch = contactText.match(EMAIL_RE);
  // The website bullet is the one carrying a URL (other bullets mention "the website" in prose).
  const websiteLine = contact.find((t) => /website|domain/i.test(t) && URL_RE.test(t)) || firstItem(contact, URL_RE);
  const urlMatch = websiteLine ? websiteLine.match(URL_RE) : null;
  const website_url = urlMatch ? urlMatch[0].replace(/[.,;]+$/, '') : null;
  let domain = null;
  if (website_url) {
    try { domain = new URL(website_url).hostname.replace(/^www\./, ''); } catch { domain = null; }
  }

  // Pages
  const pageParas = paragraphs(pagesSection);
  const servicePara = pageParas.find((p) => /^service and info pages/i.test(p));
  const pathSource = servicePara || pageParas.filter((p) => !/^blog posts/i.test(p)).join(' ');
  const existing_pages = unique((pathSource.match(PATH_RE) || []).map((p) => p.toLowerCase())).filter((p) => p !== '/blog/');
  const blogPara = pageParas.find((p) => /^blog posts/i.test(p));
  const existing_blog_slugs = blogPara ? splitList(afterColon(blogPara)).filter((s) => /^[a-z0-9-]+$/i.test(s)) : [];
  const alsoPara = pageParas.find((p) => /^also present/i.test(p));
  const existing_files = alsoPara ? splitList(afterColon(alsoPara)) : [];

  return {
    business_name: field(identity, 'Business name') || (title ? title.split(/\s+[—–-]\s+/)[0].trim() : null),
    founded_year,
    tenure_phrase,
    tenure_phrases,
    forbidden_phrases,
    address,
    service_area: parseServiceArea(field(identity, 'Service area')),
    phones: { customer_text, published_main },
    email: emailMatch ? emailMatch[0] : null,
    domain,
    website_url,
    hours: bullets(hoursSection),
    platform_notes: bullets(platformSection),
    existing_pages,
    existing_blog_slugs,
    existing_files,
    priority_services: parsePriorityServices(prioritySection),
    known_issues: bullets(issuesSection),
    approved_prices: bullets(pricesSection),
    raw,
  };
}

/** Read and parse the facts file. Throws if the file cannot be read (facts are mandatory). */
export function loadFacts(path = FACTS_PATH) {
  return parseFacts(fs.readFileSync(path, 'utf8'));
}
