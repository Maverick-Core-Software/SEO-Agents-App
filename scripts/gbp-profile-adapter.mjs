#!/usr/bin/env node
/**
 * gbp-profile-adapter.mjs
 * Playwright adapter for updating Grizzly's Google Business Profile.
 * Reuses the same persistent session as the GBP poster (~/.claude/gbp-session).
 *
 * Usage:
 *   node gbp-profile-adapter.mjs --payload <json>  [--dry-run] [--auth]
 *
 * Payload shape:
 *   {
 *     "live": true,
 *     "action": {
 *       "id": "GBP-UPDATE-001",
 *       "action_type": "gbp_profile_update",
 *       "updates": {
 *         "description": "Updated business description text.",
 *         "hours": {
 *           "monday":    { "open": "08:00", "close": "17:00" },
 *           "tuesday":   { "open": "08:00", "close": "17:00" },
 *           "wednesday": { "open": "08:00", "close": "17:00" },
 *           "thursday":  { "open": "08:00", "close": "17:00" },
 *           "friday":    { "open": "08:00", "close": "17:00" },
 *           "saturday":  { "open": "08:00", "close": "14:00" },
 *           "sunday":    { "open": null,    "close": null }
 *         },
 *         "services": ["Electrical Panel Upgrade", "EV Charger Installation"]
 *       }
 *     }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import process from 'node:process';

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const candidates = [
      process.env.PLAYWRIGHT_NODE_MODULE_DIR,
      'C:\\Workspace\\Active\\homelab-noc-dashboard\\homelab-noc-dashboard\\homelab-noc-dashboard\\node_modules',
    ].filter(Boolean);
    for (const dir of candidates) {
      const entry = path.join(dir, 'playwright', 'index.mjs');
      if (fs.existsSync(entry)) return await import(pathToFileURL(entry).href);
    }
    throw new Error('Playwright not found. Set PLAYWRIGHT_NODE_MODULE_DIR or install playwright.');
  }
}

const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'gbp-session');
const VIEWPORT = { width: 1365, height: 900 };
const DEBUG_DIR = 'C:\\Workspace\\Active\\SEO-Agents-App\\outputs\\gbp-debug';

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, auth: false, payloadText: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--auth') args.auth = true;
    else if (argv[i] === '--payload') args.payloadText = argv[++i] || '';
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(obj) {
  console.log(JSON.stringify(obj));
}

async function saveDebugArtifacts(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(DEBUG_DIR, `gbp-profile-${label}-${stamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return screenshotPath;
}

async function assertLoggedIn(page) {
  if (/accounts\.google\.com/.test(page.url())) {
    throw new Error('GBP session expired. Re-authenticate: node gbp-profile-adapter.mjs --auth');
  }
  const signIn = page.locator('a:has-text("Sign in"), button:has-text("Sign in")').first();
  if (await signIn.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('GBP session logged out. Re-authenticate: node gbp-profile-adapter.mjs --auth');
  }
}

async function navigateToEditProfile(page) {
  await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await assertLoggedIn(page);

  // Click "Edit profile" button
  const editBtn = page.locator('button:has-text("Edit profile"), a:has-text("Edit profile")').first();
  await editBtn.waitFor({ timeout: 20000 });
  await editBtn.click({ timeout: 10000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Description update
// ---------------------------------------------------------------------------

async function updateDescription(page, description) {
  // Look for the description field in the edit profile panel
  const descSection = page.locator('[aria-label*="description" i], [placeholder*="description" i], textarea').filter({ hasText: '' }).first();

  // Navigate to the About tab if present
  const aboutTab = page.locator('li[aria-label*="About" i], button:has-text("About"), [role="tab"]:has-text("About")').first();
  if (await aboutTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await aboutTab.click({ timeout: 5000 });
    await page.waitForTimeout(1000);
  }

  const descField = page.locator(
    'textarea[aria-label*="description" i], textarea[id*="description"], ' +
    'div[aria-label*="Business description" i] textarea, ' +
    'div[data-field="description"] textarea'
  ).first();

  await descField.waitFor({ timeout: 15000 });
  await descField.click({ timeout: 5000 });
  await page.keyboard.press('Control+A');
  await descField.fill(description);

  const typed = await descField.inputValue().catch(() => '');
  if (!typed.includes(description.slice(0, 30))) {
    throw new Error('Description text did not register in the field.');
  }

  return { field: 'description', chars: description.length };
}

// ---------------------------------------------------------------------------
// Hours update
// ---------------------------------------------------------------------------

async function updateHours(page, hours) {
  const hoursTab = page.locator('button:has-text("Hours"), [role="tab"]:has-text("Hours"), li[aria-label*="Hours" i]').first();
  if (await hoursTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    await hoursTab.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
  }

  const updated = [];
  for (const day of DAY_ORDER) {
    const dayHours = hours[day];
    if (!dayHours) continue;

    const dayRow = page.locator(`[aria-label*="${day}" i], tr:has-text("${day}"), div:has-text("${day}")`).first();
    if (!(await dayRow.isVisible({ timeout: 3000 }).catch(() => false))) continue;

    if (!dayHours.open || !dayHours.close) {
      // Mark as closed
      const closedToggle = dayRow.locator('input[type="checkbox"], [aria-label*="closed" i]').first();
      if (await closedToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isChecked = await closedToggle.isChecked().catch(() => false);
        if (!isChecked) await closedToggle.click({ timeout: 5000 });
        updated.push({ day, status: 'closed' });
      }
      continue;
    }

    // Set open time
    const openSelect = dayRow.locator('select, input[aria-label*="open" i]').first();
    if (await openSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await openSelect.selectOption({ label: dayHours.open }).catch(async () => {
        await openSelect.fill(dayHours.open).catch(() => {});
      });
    }

    // Set close time
    const closeSelect = dayRow.locator('select, input[aria-label*="close" i]').last();
    if (await closeSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeSelect.selectOption({ label: dayHours.close }).catch(async () => {
        await closeSelect.fill(dayHours.close).catch(() => {});
      });
    }

    updated.push({ day, open: dayHours.open, close: dayHours.close });
  }

  return { field: 'hours', updated };
}

// ---------------------------------------------------------------------------
// Save / confirm changes
// ---------------------------------------------------------------------------

async function saveChanges(page) {
  const saveBtn = page.locator(
    'button:has-text("Save"), button[aria-label*="Save" i], button:has-text("Apply")'
  ).first();
  await saveBtn.waitFor({ timeout: 10000 });
  await saveBtn.click({ timeout: 10000 });

  // Wait for success confirmation or dialog close
  await Promise.race([
    page.locator('text=/saved|changes saved|profile updated/i').first().waitFor({ timeout: 15000 }),
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
  ]).catch(() => {});

  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Auth mode
  if (args.auth) {
    const { chromium } = await importPlaywright();
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: VIEWPORT,
    });
    const page = await context.newPage();
    console.log('AUTH MODE: Log into Google Business Profile, then close this browser window.');
    await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    await context.close();
    return;
  }

  if (!args.payloadText) {
    console.error(JSON.stringify({ status: 'error', message: 'Missing --payload' }));
    process.exit(2);
  }

  const payload = JSON.parse(args.payloadText);
  const action = payload.action || {};
  const updates = action.updates || {};
  const live = Boolean(payload.live) && !args.dryRun;

  const result = {
    adapter: 'gbp-profile-adapter',
    action_id: action.id || null,
    live,
    updates_requested: Object.keys(updates),
    results: [],
    status: 'dry_run_ready',
  };

  if (!live) {
    // Dry run — just report what would be changed
    if (updates.description) {
      result.results.push({
        field: 'description',
        status: 'dry_run',
        chars: updates.description.length,
        preview: updates.description.slice(0, 120) + (updates.description.length > 120 ? '...' : ''),
      });
    }
    if (updates.hours) {
      result.results.push({
        field: 'hours',
        status: 'dry_run',
        days: Object.keys(updates.hours),
      });
    }
    if (updates.services) {
      result.results.push({
        field: 'services',
        status: 'dry_run',
        count: updates.services.length,
        services: updates.services,
      });
    }
    emit(result);
    return;
  }

  // Live execution
  const { chromium } = await importPlaywright();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();

  try {
    await navigateToEditProfile(page);
    result.status = 'live_running';

    if (updates.description) {
      const r = await updateDescription(page, updates.description);
      result.results.push({ ...r, status: 'updated' });
    }

    if (updates.hours) {
      const r = await updateHours(page, updates.hours);
      result.results.push({ ...r, status: 'updated' });
    }

    // Save all changes
    await saveChanges(page);

    result.status = 'live_complete';
    result.message = `GBP profile updated: ${result.results.map(r => r.field).join(', ')}`;
    emit(result);

  } catch (e) {
    const screenshot = await saveDebugArtifacts(page, 'failure');
    result.status = 'failed';
    result.error = e.message || String(e);
    result.debug_screenshot = screenshot;
    emit(result);
    process.exit(1);
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  process.exit(1);
});
