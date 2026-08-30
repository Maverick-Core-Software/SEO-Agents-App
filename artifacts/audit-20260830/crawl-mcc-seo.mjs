import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'ui-shots');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20000);
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const seoNav = page.getByText('SEO Pipeline', { exact: true }).first();
if (await seoNav.count()) {
  await seoNav.click();
  await page.waitForTimeout(2000);
}

const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 8000));
await page.screenshot({ path: path.join(outDir, 'mcc-seo-pipeline.png'), fullPage: true });
console.log(JSON.stringify({
  url: page.url(),
  head: text.slice(0, 1500),
  hasGbpError: /GBP verification failed|Recessed Lighting|needs recovery|POST TODAY|OVERDUE/i.test(text),
}, null, 2));
await browser.close();
