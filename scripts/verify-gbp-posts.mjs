#!/usr/bin/env node
/**
 * verify-gbp-posts.mjs
 * Retroactively verify GBP posts that landed without a platform_post_id.
 *
 * Launches Playwright against the GBP dashboard, scrapes the posts list,
 * and matches by caption snippet. On match, writes platform_post_id + media_status
 * back to Supabase so the MCC dashboard flips from CHECK/NO POST ID to green.
 *
 * Queries:
 *   - status='posted' AND platform_post_id IS NULL
 *   - status='needs_verification'
 *   Both limited to last 14 days.
 *
 * Usage:
 *   node scripts/verify-gbp-posts.mjs                  # verify all unverified
 *   node scripts/verify-gbp-posts.mjs --date 2026-07-03 # verify one date
 *   node scripts/verify-gbp-posts.mjs --headless       # headless mode
 *   node scripts/verify-gbp-posts.mjs --once            # single pass (default)
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  captionSnippet,
  findSnippetInAllPosts,
  gbpListingUnverifiedMessage,
  isGbpSessionExpiredText,
  assertGbpLoggedIn,
  openAllPostsModal,
} from './lib/gbp-listing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Load .env ──────────────────────────────────────────────────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'gbp-session');
const VIEWPORT = { width: 1365, height: 900 };
const DEBUG_DIR = path.join(PROJECT_ROOT, 'outputs', 'gbp-debug');
const LOOKBACK_DAYS = 14;

// ── Parse args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { date: null, dates: [], headless: false, once: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) {
      const value = argv[++i];
      const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
      args.dates.push(...parts);
      args.date = args.dates[0];
    } else if (argv[i] === '--headless') { args.headless = true; }
    else if (argv[i] === '--once') { args.once = true; }
  }
  return args;
}

// ── Logging ──────────────────────────────────────────────────────────────────────
function log(msg) { console.error(`[verify-gbp] ${msg}`); }
function emit(obj) { console.log(JSON.stringify(obj)); }

// ── Supabase helpers ───────────────────────────────────────────────────────────
function requireEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY required in .env');
    process.exit(1);
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// ── Session checks (mirrors driver.mjs) ───────────────────────────────────────
async function detectBlockingInterstitial(page) {
  if (/\/sorry\/|recaptcha/i.test(page.url())) {
    throw new Error('CAPTCHA / unusual-traffic interstitial. A human must solve it.');
  }
  const frame = page.locator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]').first();
  if (await frame.isVisible({ timeout: 500 }).catch(() => false)) {
    throw new Error('CAPTCHA challenge detected. A human must solve it.');
  }
  const text = page.getByText(/unusual traffic|verify it'?s you|confirm you'?re not a robot/i).first();
  if (await text.isVisible({ timeout: 500 }).catch(() => false)) {
    throw new Error('Google anti-bot challenge detected.');
  }
}

async function assertLoggedIn(page) {
  await assertGbpLoggedIn(page);
}

// ── Debug screenshot ──────────────────────────────────────────────────────────
async function saveDebugScreenshot(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(DEBUG_DIR, `verify-${label}-${stamp}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  return filePath;
}

// ── Navigate to posts list ─────────────────────────────────────────────────────
async function navigateToPosts(page) {
  log('Navigating to business.google.com...');
  await page.goto('https://business.google.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await detectBlockingInterstitial(page);
  await assertLoggedIn(page);

  await openAllPostsModal(page);
  await page.waitForTimeout(1500);
}

// ── Verify a single post ───────────────────────────────────────────────────────
async function verifyOnePost(page, post, supabase) {
  // weekly_posts stores content in `body` (main caption) and `hook` (headline).
  const snippet = captionSnippet(post.body || post.hook || '');
  if (!snippet) {
    log(`  SKIP ${post.post_date}: no body/hook to match`);
    return { id: post.id, date: post.post_date, verified: false, reason: 'no_caption' };
  }

  log(`  Checking ${post.post_date}: "${snippet}"`);

  const found = await findSnippetInAllPosts(page, snippet);

  if (found.match === 'live') {
    const postUrl = found.postUrl || 'verified-no-url';
    log(`  FOUND ${post.post_date}${found.postUrl ? ` → ${found.postUrl}` : ' (no URL extracted)'}`);

    // Update Supabase — a live match is posted, even if the row was previously error.
    const update = {
      status: 'posted',
      error: null,
      platform_post_id: postUrl,
      media_status: 'photo',
    };
    if (!post.posted_at) {
      update.posted_at = new Date().toISOString();
    }

    await supabase.from('weekly_posts').update(update).eq('id', post.id);

    return { id: post.id, date: post.post_date, verified: true, postUrl };
  }

  log(`  NOT FOUND ${post.post_date}: "${snippet}" ${found.match === 'scheduled' ? 'is scheduled, not live' : 'not visible after scrolling All posts'}`);
  if (!post.platform_post_id && ['error', 'posted', 'needs_verification'].includes(post.status)) {
    await supabase.from('weekly_posts').update({
      status: 'needs_verification',
      error: gbpListingUnverifiedMessage(),
    }).eq('id', post.id);
  }
  return { id: post.id, date: post.post_date, verified: false, reason: found.match === 'scheduled' ? 'scheduled_not_live' : 'not_visible' };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = requireEnv();

  log('Starting GBP post verification...');

  // Build Supabase query
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  if (args.dates.length) {
    log(`Verifying date(s): ${args.dates.join(', ')}`);
  }

  let posts;
  if (args.dates.length) {
    const { data } = await supabase
      .from('weekly_posts')
      .select('id, run_id, post_date, status, body, hook, platform_post_id, posted_at')
      .eq('platform', 'gbp')
      .in('post_date', args.dates);
    posts = data || [];
  } else {
    const { data } = await supabase
      .from('weekly_posts')
      .select('id, run_id, post_date, status, body, hook, platform_post_id, posted_at')
      .eq('platform', 'gbp')
      .in('status', ['posted', 'needs_verification', 'error'])
      .gte('post_date', cutoff.slice(0, 10));
    posts = (data || []).filter((p) =>
      p.status === 'needs_verification'
      || p.status === 'error'
      || !p.platform_post_id
    );
  }

  if (!posts.length) {
    log('No unverified GBP posts found. All clear.');
    emit({ result: 'no_posts', verified: 0, failed: 0 });
    return;
  }

  log(`Found ${posts.length} post(s) to verify`);
  for (const p of posts) {
    log(`  ${p.post_date} status=${p.status} post_id=${p.platform_post_id || 'NULL'}`);
  }

  // Launch browser
  log('Launching browser...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: args.headless,
    viewport: VIEWPORT,
  });

  const page = await context.newPage();

  const results = { verified: 0, failed: 0, errors: [], details: [] };
  let fatal = null;

  try {
    await navigateToPosts(page);

    for (const post of posts) {
      try {
        const r = await verifyOnePost(page, post, supabase);
        results.details.push(r);
        if (r.verified) results.verified++;
        else results.failed++;

        // Small delay between checks to avoid rate-limit-like behavior
        await page.waitForTimeout(2000);
      } catch (e) {
        const msg = String(e.message || e);
        log(`  ERROR ${post.post_date}: ${msg}`);
        results.errors.push({ id: post.id, date: post.post_date, error: msg });
        results.failed++;

        // Session-expired / marketing page is a crash, not a miss.
        if (isGbpSessionExpiredText(msg)) {
          log('Session expired — aborting remaining checks');
          fatal = e;
          break;
        }
      }
    }

    // Summary screenshot
    await saveDebugScreenshot(page, 'final');
  } catch (e) {
    const msg = String(e.message || e);
    log(`Fatal error: ${msg}`);
    await saveDebugScreenshot(page, 'fatal-error').catch(() => {});
    results.errors.push({ error: msg });
    fatal = e;
  }

  // Emit BEFORE context.close() — Chromium persistent-context teardown has
  // aborted with STATUS_STACK_BUFFER_OVERRUN after a live match, and the
  // worker used to treat the missing JSON as a failed post.
  log(`Done: ${results.verified} verified, ${results.failed} not found/error`);
  const fatalMsg = fatal ? String(fatal.message || fatal) : '';
  const fatalCrash = Boolean(fatal) && (isGbpSessionExpiredText(fatalMsg) || /captcha|unusual traffic/i.test(fatalMsg));
  if (fatalCrash) {
    emit({ result: 'fatal', error: fatalMsg, ...results });
  } else {
    emit({ result: fatal ? 'fatal' : 'complete', ...results, error: fatal ? fatalMsg : undefined });
  }

  try {
    await context.close();
  } catch (e) {
    log(`context.close failed: ${e.message || e}`);
  }

  if (fatalCrash) {
    throw fatal;
  }
}

main().catch((e) => {
  log(`Fatal: ${e.message || e}`);
  emit({ result: 'fatal', error: String(e.message || e) });
  process.exit(1);
});
