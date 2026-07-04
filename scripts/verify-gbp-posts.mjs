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
  const args = { date: null, headless: false, once: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) { args.date = argv[++i]; }
    else if (argv[i] === '--headless') { args.headless = true; }
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

// ── Caption matching ────────────────────────────────────────────────────────────
// Match on the first meaningful line, trimmed, max 60 chars. Same logic as driver.mjs.
function captionSnippet(caption) {
  if (!caption) return '';
  const line = caption.split(/\n/).find(l => l.trim().length > 10) || caption;
  return line.trim().replace(/\s+/g, ' ').slice(0, 60);
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
  if (/accounts\.google\.com/.test(page.url())) {
    throw new Error('GBP session expired (redirected to sign-in). Re-authenticate with: node scripts/gbp-poster/driver.mjs --auth');
  }
  const signIn = page.locator('a:has-text("Sign in"), button:has-text("Sign in")').first();
  if (await signIn.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('GBP session expired (Sign in button visible). Re-authenticate with: node scripts/gbp-poster/driver.mjs --auth');
  }
  const marketing = page.getByText(/Stand out on Google|free Business Profile|Get your free Business Profile/i).first();
  if (await marketing.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('GBP session expired (marketing page shown). Re-authenticate with: node scripts/gbp-poster/driver.mjs --auth');
  }
}

// ── Post visibility check (three-tier, same as driver.mjs checkPostVisible) ────
async function checkPostVisible(page, snippet) {
  // 1. Main page text
  let visible = await page.getByText(snippet, { exact: false }).first()
    .isVisible({ timeout: 5000 }).catch(() => false);

  // 2. Posts iframe
  if (!visible) {
    const iframeLocator = page.frameLocator(
      'iframe[src*="contribute"], iframe[src*="posts"], iframe[src*="local/business"]'
    );
    visible = await iframeLocator.getByText(snippet, { exact: false }).first()
      .isVisible({ timeout: 8000 }).catch(() => false);
  }

  // 3. Click Posts button and re-check
  if (!visible) {
    const postsBtn = page.locator('button:has-text("Posts")').first();
    if (await postsBtn.count()) {
      await postsBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      visible = await page.getByText(snippet, { exact: false }).first()
        .isVisible({ timeout: 8000 }).catch(() => false);
    }
  }

  return visible;
}

// ── Extract post URL from the page ────────────────────────────────────────────
async function extractPostUrl(page, snippet) {
  // Try to find the link that contains the snippet text
  const postUrl = await page.evaluate((text) => {
    // Look for anchor tags near the matching text
    const allAnchors = [...document.querySelectorAll('a[href*="localPost"], a[href*="/posts/"]')];
    if (allAnchors.length) return allAnchors[0].href;

    // Fallback: find any element matching the text, then walk up to find a link
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_ELEMENT,
    );
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(text)) {
        const link = node.closest('a[href]');
        if (link) return link.href;
        // Check parent for link
        const parentLink = node.parentElement?.closest('a[href]');
        if (parentLink) return parentLink.href;
      }
    }
    return null;
  }, snippet).catch(() => null);

  // Also check inside iframes
  if (!postUrl) {
    const iframeUrl = await page.evaluate(() => {
      const frames = document.querySelectorAll(
        'iframe[src*="contribute"], iframe[src*="posts"], iframe[src*="local/business"]'
      );
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc) continue;
          const anchor = [...doc.querySelectorAll('a[href*="localPost"], a[href*="/posts/"]')];
          if (anchor.length) return anchor[0].href;
        } catch { /* cross-origin */ }
      }
      return null;
    }).catch(() => null);
    if (iframeUrl) return iframeUrl;
  }

  return postUrl;
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

  // Click "Posts" if visible to get to the posts list
  const postsBtn = page.locator('button:has-text("Posts")').first();
  if (await postsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await postsBtn.click({ timeout: 5000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  // Wait a beat for posts to render
  await page.waitForTimeout(3000);
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

  const visible = await checkPostVisible(page, snippet);

  if (visible) {
    const postUrl = await extractPostUrl(page, snippet);
    log(`  FOUND ${post.post_date}${postUrl ? ` → ${postUrl}` : ' (no URL extracted)'}`);

    // Update Supabase
    const update = {
      platform_post_id: postUrl || 'verified-no-url',
    };
    if (!post.posted_at) {
      update.posted_at = new Date().toISOString();
    }
    // Set media_status for GBP posts (always photo)
    update.media_status = 'photo';

    await supabase.from('weekly_posts').update(update).eq('id', post.id);

    return { id: post.id, date: post.post_date, verified: true, postUrl };
  }

  log(`  NOT FOUND ${post.post_date}: "${snippet}" not visible on page`);
  return { id: post.id, date: post.post_date, verified: false, reason: 'not_visible' };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = requireEnv();

  log('Starting GBP post verification...');

  // Build Supabase query
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  if (args.date) {
    log(`Verifying single date: ${args.date}`);
  }

  let posts;
  if (args.date) {
    const { data } = await supabase
      .from('weekly_posts')
      .select('id, run_id, post_date, status, body, hook, platform_post_id, posted_at')
      .eq('platform', 'gbp')
      .eq('post_date', args.date)
      .in('status', ['posted', 'needs_verification']);
    posts = data || [];
  } else {
    const { data } = await supabase
      .from('weekly_posts')
      .select('id, run_id, post_date, status, body, hook, platform_post_id, posted_at')
      .eq('platform', 'gbp')
      .in('status', ['posted', 'needs_verification'])
      .or(`platform_post_id.is.null,and(posted_at.gte.${cutoff})`);
    // Also grab needs_verification regardless of date (they're already flagged)
    const { data: nv } = await supabase
      .from('weekly_posts')
      .select('id, run_id, post_date, status, body, hook, platform_post_id, posted_at')
      .eq('platform', 'gbp')
      .eq('status', 'needs_verification')
      .gte('post_date', cutoff.slice(0, 10));
    // Merge, deduplicate by id
    const map = new Map();
    for (const p of [...(data || []), ...(nv || [])]) map.set(p.id, p);
    posts = [...map.values()];
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

        // If session expired, bail — remaining checks will all fail
        if (/session expired|sign in|accounts\.google\.com/i.test(msg)) {
          log('Session expired — aborting remaining checks');
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
    // Re-throw session/captcha errors so exit code signals the problem
    if (/session expired|sign in|captcha|accounts\.google\.com/i.test(msg)) {
      throw e;
    }
  } finally {
    await context.close();
  }

  // Report
  log(`Done: ${results.verified} verified, ${results.failed} not found/error`);
  emit({ result: 'complete', ...results });
}

main().catch((e) => {
  log(`Fatal: ${e.message || e}`);
  emit({ result: 'fatal', error: String(e.message || e) });
  process.exit(1);
});
