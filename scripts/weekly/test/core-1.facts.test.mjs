// scripts/weekly/test/core-1.facts.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFacts, parseFacts } from '../lib/facts.mjs';
import { FACTS_PATH } from '../lib/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'core-1.facts-fixture.md');

const CONTRACT_KEYS = [
  'business_name', 'founded_year', 'tenure_phrase', 'address', 'service_area', 'phones', 'email', 'domain',
  'hours', 'platform_notes', 'existing_pages', 'existing_blog_slugs', 'priority_services', 'known_issues',
  'approved_prices', 'raw',
];

describe('loadFacts (real knowledge/baselines/grizzly-business-facts.md)', () => {
  const facts = loadFacts();

  it('returns every contract key', () => {
    for (const key of CONTRACT_KEYS) assert.ok(key in facts, `missing ${key}`);
    assert.equal(facts.raw, fs.readFileSync(FACTS_PATH, 'utf8'));
  });

  it('identity: name, founding year, tenure phrase, address', () => {
    assert.equal(facts.business_name, 'Grizzly Electrical Solutions');
    assert.equal(facts.founded_year, 2021);
    assert.equal(facts.tenure_phrase, 'since 2021');
    assert.deepEqual(facts.tenure_phrases, ['since 2021', 'five years']);
    assert.deepEqual(facts.forbidden_phrases, ['over a decade', '3+ years']);
    assert.equal(facts.address, '8902 Merritt Rd., Rowlett, TX 75089');
  });

  it('service area lists DFW, the home base and every range endpoint', () => {
    assert.deepEqual(facts.service_area, [
      'DFW and surrounding areas', 'Rowlett', 'McKinney', 'Waxahachie', 'Rockwall', 'West Fort Worth',
    ]);
  });

  it('contact: exactly the two publishable phone numbers, email, domain', () => {
    assert.deepEqual(facts.phones, { customer_text: '(469) 896-3862', published_main: '(469) 863-9804' });
    assert.equal(facts.email, 'contactus@grizzlyelectrical.net');
    assert.equal(facts.domain, 'grizzlyelectricaltx.com');
    assert.equal(facts.website_url, 'https://www.grizzlyelectricaltx.com/');
  });

  it('hours and platform notes are the section bullets with continuation lines joined', () => {
    assert.equal(facts.hours[0], 'Monday to Friday, 8:00 AM to 5:00 PM');
    assert.ok(facts.hours.includes('24/7 emergency calls'));
    assert.ok(facts.hours.some((h) => h.startsWith('Known discrepancy') && h.includes('until the owner says which is right.')));
    assert.equal(facts.platform_notes.length, 3);
    assert.ok(facts.platform_notes.some((n) => n.includes('Formspree')));
  });

  it('existing pages: all 18 service/info paths, no /blog/, 7 blog slugs, static files', () => {
    assert.equal(facts.existing_pages.length, 18);
    assert.ok(facts.existing_pages.includes('/panel-upgrades/'));
    assert.ok(facts.existing_pages.includes('/sms-terms/'));
    assert.ok(!facts.existing_pages.includes('/blog/'));
    assert.ok(facts.existing_pages.every((p) => /^\/[a-z0-9-]+\/$/.test(p)));
    assert.equal(facts.existing_blog_slugs.length, 7);
    assert.ok(facts.existing_blog_slugs.includes('how-much-does-an-electrician-cost-in-dallas'));
    assert.deepEqual(facts.existing_files, ['sitemap.xml', 'robots.txt', '404.html']);
  });

  it('priority services split on commas, ordinal words stripped', () => {
    assert.deepEqual(facts.priority_services, [
      'Electrical troubleshooting', 'recessed lighting', 'panel replacement and upgrades', 'service upgrades',
      'EV chargers', 'generator inlets and installations', 'whole-home surge protection', 'remodel electrical',
      'Light commercial',
    ]);
  });

  it('known issues are the three tracked bullets; approved prices are empty (none listed)', () => {
    assert.equal(facts.known_issues.length, 3);
    assert.ok(facts.known_issues[0].startsWith('Homepage stat counters show 0.'));
    assert.deepEqual(facts.approved_prices, []);
  });
});

describe('loadFacts (fixture: reordered sections, * bullets, dashed phone, approved prices)', () => {
  const facts = loadFacts(FIXTURE);

  it('parses identity regardless of section order', () => {
    assert.equal(facts.business_name, 'Acme Sparks Electric');
    assert.equal(facts.founded_year, 2019);
    assert.equal(facts.tenure_phrase, 'since 2019');
    assert.deepEqual(facts.tenure_phrases, ['since 2019', 'seven years']);
    assert.deepEqual(facts.forbidden_phrases, ['over a decade']);
    assert.equal(facts.address, '1 Main St., Plano, TX 75023');
    assert.deepEqual(facts.service_area, ['North Texas', 'Plano', 'Frisco', 'Garland', 'Allen', 'Richardson']);
  });

  it('normalises phone formats and matches roles by keyword, not order', () => {
    assert.deepEqual(facts.phones, { customer_text: '(214) 555-0199', published_main: '(214) 555-0100' });
    assert.equal(facts.email, 'hello@acmesparks.example');
    assert.equal(facts.domain, 'acmesparks.example');
  });

  it('lists, pages, prices', () => {
    assert.deepEqual(facts.hours, ['Monday to Saturday, 7:00 AM to 7:00 PM', '24/7 emergency calls']);
    assert.deepEqual(facts.platform_notes, ['Static site on Netlify.']);
    assert.deepEqual(facts.existing_pages, ['/panel-upgrades/', '/ev-charger-installation/', '/reviews/']);
    assert.deepEqual(facts.existing_blog_slugs, ['how-to-reset-a-breaker', 'ev-charger-cost-plano']);
    assert.deepEqual(facts.existing_files, ['sitemap.xml', 'robots.txt']);
    assert.deepEqual(facts.priority_services, ['Panel upgrades', 'EV chargers', 'Light commercial']);
    assert.deepEqual(facts.known_issues, ['Footer year shows 2024.']);
    assert.equal(facts.approved_prices.length, 2);
    assert.ok(facts.approved_prices[0].startsWith('$149 diagnostic fee'));
  });

  it('CRLF line endings parse identically (raw keeps the original bytes)', () => {
    const lf = fs.readFileSync(FIXTURE, 'utf8');
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = parseFacts(lf);
    const b = parseFacts(crlf);
    assert.equal(b.raw, crlf);
    delete a.raw; delete b.raw;
    assert.deepEqual(b, a);
  });
});

describe('parseFacts edge cases', () => {
  it('a file with no recognised sections yields nulls and empty lists, never invented values', () => {
    const facts = parseFacts('# Nothing Here — Facts\n\nSome preamble only.\n');
    assert.equal(facts.business_name, 'Nothing Here');
    assert.equal(facts.founded_year, null);
    assert.equal(facts.tenure_phrase, null);
    assert.equal(facts.address, null);
    assert.deepEqual(facts.service_area, []);
    assert.deepEqual(facts.phones, { customer_text: null, published_main: null });
    assert.equal(facts.email, null);
    assert.equal(facts.domain, null);
    for (const key of ['hours', 'platform_notes', 'existing_pages', 'existing_blog_slugs', 'priority_services', 'known_issues', 'approved_prices']) {
      assert.deepEqual(facts[key], [], key);
    }
  });

  it('falls back to document order for phones when role keywords are absent', () => {
    const facts = parseFacts('## Contact\n\n- Call (972) 555-0111 or text (972) 555-0222.\n');
    assert.deepEqual(facts.phones, { customer_text: '(972) 555-0111', published_main: '(972) 555-0222' });
  });

  it('a founded line without a quoted phrase derives "since <year>"', () => {
    const facts = parseFacts('## Identity\n\n- Founded: 2020\n');
    assert.equal(facts.founded_year, 2020);
    assert.equal(facts.tenure_phrase, 'since 2020');
    assert.deepEqual(facts.tenure_phrases, []);
  });

  it('pages section without the "Service and info pages" prefix still yields paths minus /blog/', () => {
    const facts = parseFacts('## Pages\n\nWe have /a-page/ and /b-page/ under /blog/.\n');
    assert.deepEqual(facts.existing_pages, ['/a-page/', '/b-page/']);
  });

  it('loadFacts throws when the file is missing (facts are mandatory)', () => {
    assert.throws(() => loadFacts(path.join(here, 'fixtures', 'does-not-exist.md')), /ENOENT/);
  });
});

describe('parseFacts robustness (reviewer additions)', () => {
  it('a UTF-8 BOM hides neither the title nor a first-line heading; raw keeps the bytes', () => {
    const BOM = String.fromCharCode(0xfeff);
    const withTitle = `${BOM}# Bom Co — Facts\n\n## Identity\n\n- Founded: 2018\n`;
    const a = parseFacts(withTitle);
    assert.equal(a.raw, withTitle);
    assert.equal(a.business_name, 'Bom Co', 'title fallback still works behind a BOM');
    assert.equal(a.founded_year, 2018);
    const b = parseFacts(`${BOM}## Identity\n\n- Business name: Bom Co\n`);
    assert.equal(b.business_name, 'Bom Co', 'a heading on the first line is still a heading');
  });

  it('typographic quotes around tenure and forbidden phrases are read like straight quotes', () => {
    const facts = parseFacts('## Identity\n\n- Founded: 2020. Say “since 2020” or “six years”. Never “over a decade”. Never "3+ years".\n');
    assert.deepEqual(facts.tenure_phrases, ['since 2020', 'six years']);
    assert.equal(facts.tenure_phrase, 'since 2020');
    assert.deepEqual(facts.forbidden_phrases, ['over a decade', '3+ years']);
  });

  it('a bulleted priority-services section yields one service per bullet (ordinals stripped)', () => {
    const facts = parseFacts('## Priority services\n\n- Panel upgrades\n- EV chargers, generator inlets\n- Light commercial second.\n');
    assert.deepEqual(facts.priority_services, ['Panel upgrades', 'EV chargers', 'generator inlets', 'Light commercial']);
  });

  it('a Website/Domain line without http(s) still yields the domain (never the email domain); website_url stays null', () => {
    const a = parseFacts('## Contact\n\n- Email: hi@mail.example\n- Website: www.Acme.Example is the only website domain.\n');
    assert.equal(a.domain, 'acme.example');
    assert.equal(a.website_url, null);
    assert.equal(a.email, 'hi@mail.example');
    const b = parseFacts('## Contact\n\n- Domain: acme.example/\n');
    assert.equal(b.domain, 'acme.example');
    const c = parseFacts('## Contact\n\n- Website: https://www.acme.example/ (bare mention: other.example)\n');
    assert.equal(c.domain, 'acme.example', 'a real URL wins over the bare-host fallback');
    assert.equal(parseFacts('## Contact\n\n- Email: hi@mail.example\n').domain, null, 'no website line, no domain');
  });

  it('a "Homepage ..." heading before the pages section does not shadow it', () => {
    const facts = parseFacts('## Homepage notes\n\nThe /hero/ block is fine.\n\n## Pages that already exist\n\nService and info pages: /a/, /b/\n');
    assert.deepEqual(facts.existing_pages, ['/a/', '/b/']);
  });
});
