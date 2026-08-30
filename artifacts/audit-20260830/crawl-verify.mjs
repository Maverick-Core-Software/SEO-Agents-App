import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:5188';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20000);

async function text(hash) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return page.evaluate(() => (document.querySelector('main')?.innerText || '').slice(0, 3500));
}

const today = await text('#/today');
const ops = await text('#/operations');
const detail = await text('#/detail');
const approval = await text('#/approval');
const website = await text('#/website');

await page.goto(`${BASE}/#/today`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const gbp = page.getByRole('button', { name: /Google Business/i });
if (await gbp.count()) await gbp.click();
await page.waitForTimeout(400);
const todayGbp = await page.evaluate(() => (document.querySelector('main')?.innerText || '').slice(0, 2500));

console.log(JSON.stringify({
  todayHead: today.slice(0, 900),
  todayHasRecessed: /Recessed Lighting/i.test(today) || /Recessed Lighting/i.test(todayGbp),
  todayHas53: /^\s*53\s*$/m.test(today) && /PENDING APPROVAL/.test(today),
  todayPendingSplit: /Posts pending/i.test(today) && /Website pending/i.test(today),
  todayWeek: (today.match(/\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/) || [])[0] || null,
  todayGbpHasError: /Recessed|verification failed/i.test(todayGbp),
  opsHasDONE: /DONE/.test(ops),
  opsHasPOSTEDRun: /run\.status[\s\S]{0,40}POSTED/.test(ops),
  opsHasFault: /GBP verification failed|2026-08-29/i.test(ops),
  detailIsEmpty: /pick a post from Today or Calendar/i.test(detail),
  detailHasFakeId: /122000000000000123/.test(detail),
  approvalHasShowAll: /Show all pending/i.test(approval),
  approvalHasOwner: /Waiting on owner/i.test(approval),
  websiteHasTabs: /Waiting on owner/.test(website) && /Open/.test(website),
}, null, 2));

await browser.close();
