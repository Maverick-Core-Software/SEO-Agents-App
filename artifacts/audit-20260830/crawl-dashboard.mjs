import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'ui-shots');
fs.mkdirSync(outDir, { recursive: true });

const BASE = 'http://127.0.0.1:5188';
const MCC = 'http://127.0.0.1:3000';

const ROUTES = [
  ['today', '#/today'],
  ['calendar', '#/calendar'],
  ['approval', '#/approval'],
  ['detail', '#/detail'],
  ['website', '#/website'],
  ['performance', '#/performance'],
  ['operations', '#/operations'],
];

function visibleText(page) {
  return page.evaluate(() => {
    const banner = document.querySelector('.readonlyBanner')?.innerText || '';
    const notice = document.querySelector('.configNotice')?.innerText || '';
    const main = document.querySelector('main')?.innerText || document.body.innerText;
    const nav = [...document.querySelectorAll('.navLink')].map((a) => ({
      text: a.textContent.trim(),
      active: a.classList.contains('active'),
      href: a.getAttribute('href'),
    }));
    const buttons = [...document.querySelectorAll('button')].slice(0, 40).map((b) => ({
      text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      disabled: b.disabled,
      title: b.getAttribute('title') || '',
    }));
    return { title: document.title, banner, notice, nav, buttons, main: main.slice(0, 6000) };
  });
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
});

const findings = {};

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

const desktop = await browser.newPage({ viewport: { width: 1400, height: 900 } });
desktop.setDefaultTimeout(15000);

for (const [name, hash] of ROUTES) {
  await desktop.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
  await desktop.waitForTimeout(800);
  const text = await visibleText(desktop);
  const file = await shot(desktop, `desktop-${name}`);
  findings[`desktop-${name}`] = { file, ...text };
}

// Today: click GBP tab and prior-week chip if present
await desktop.goto(`${BASE}/#/today`, { waitUntil: 'networkidle' });
await desktop.waitForTimeout(600);
const gbpBtn = desktop.getByRole('button', { name: /Google Business/i });
if (await gbpBtn.count()) {
  await gbpBtn.click();
  await desktop.waitForTimeout(300);
  findings['desktop-today-gbp'] = {
    file: await shot(desktop, 'desktop-today-gbp'),
    ...(await visibleText(desktop)),
  };
}
const priorBtn = desktop.getByRole('button', { name: /prior-week/i });
if (await priorBtn.count()) {
  await priorBtn.click();
  await desktop.waitForTimeout(300);
  findings['desktop-today-prior'] = {
    file: await shot(desktop, 'desktop-today-prior'),
    ...(await visibleText(desktop)),
  };
}

// Calendar click-through to detail
await desktop.goto(`${BASE}/#/calendar`, { waitUntil: 'networkidle' });
await desktop.waitForTimeout(600);
const postChip = desktop.locator('button[aria-label^="Open"]').first();
if (await postChip.count()) {
  await postChip.click();
  await desktop.waitForTimeout(600);
  findings['desktop-detail-from-calendar'] = {
    file: await shot(desktop, 'desktop-detail-from-calendar'),
    ...(await visibleText(desktop)),
  };
}

// Mobile today + nav
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto(`${BASE}/#/today`, { waitUntil: 'networkidle' });
await mobile.waitForTimeout(600);
findings['mobile-today'] = {
  file: await shot(mobile, 'mobile-today'),
  ...(await visibleText(mobile)),
};
await mobile.goto(`${BASE}/#/calendar`, { waitUntil: 'networkidle' });
await mobile.waitForTimeout(600);
findings['mobile-calendar'] = {
  file: await shot(mobile, 'mobile-calendar'),
  ...(await visibleText(mobile)),
};
await mobile.goto(`${BASE}/#/approval`, { waitUntil: 'networkidle' });
await mobile.waitForTimeout(600);
findings['mobile-approval'] = {
  file: await shot(mobile, 'mobile-approval'),
  ...(await visibleText(mobile)),
};

// MCC live SEO surface
try {
  await desktop.goto(`${MCC}/seo`, { waitUntil: 'networkidle', timeout: 20000 });
  await desktop.waitForTimeout(1500);
  const mccText = await desktop.evaluate(() => ({
    title: document.title,
    main: (document.body.innerText || '').slice(0, 7000),
  }));
  findings['mcc-seo'] = {
    file: await shot(desktop, 'mcc-seo'),
    ...mccText,
  };
} catch (e) {
  findings['mcc-seo'] = { error: String(e.message || e).slice(0, 200) };
}

await browser.close();

const summaryPath = path.join(outDir, 'crawl-text.json');
fs.writeFileSync(summaryPath, JSON.stringify(findings, null, 2));
console.log(JSON.stringify({
  outDir,
  pages: Object.keys(findings),
  summaryPath,
  todayHasNotice: Boolean(findings['desktop-today']?.notice),
  todayMainHead: (findings['desktop-today']?.main || '').slice(0, 500),
}, null, 2));
