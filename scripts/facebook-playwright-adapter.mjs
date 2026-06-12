#!/usr/bin/env node
/**
 * facebook-playwright-adapter.mjs
 * Posts to Grizzly's Facebook Business Page via Playwright browser automation.
 * Reuses a persistent browser session so login only happens once.
 *
 * Usage:
 *   node facebook-playwright-adapter.mjs --auth               # First-time login
 *   node facebook-playwright-adapter.mjs --payload <json>     # Post live
 *   node facebook-playwright-adapter.mjs --payload <json> --dry-run
 *
 * Payload shape: same as facebook-poster-adapter.mjs
 *   {
 *     "live": true,
 *     "action": {
 *       "id": "fb-post-2026-06-11",
 *       "action_type": "publish_facebook_post",
 *       "post": {
 *         "type": "text|photo|video",
 *         "hook": "First line scroll-stopper",
 *         "body": "Story text...",
 *         "hashtags": "#DFW #GrizzlyElectrical",
 *         "cta": "Call us today.",
 *         "photo_file": "C:\\path\\to\\photo.jpg",
 *         "video_prompt": "Gemini Veo prompt (auto-generates video if no video_file)",
 *         "video_file": "C:\\path\\to\\video.mp4"
 *       }
 *     }
 *   }
 *
 * Env (or .env):
 *   FB_PAGE_URL  — your Facebook page URL (e.g. https://www.facebook.com/grizzlyelectrical)
 *                  falls back to FB_PAGE_ID if set
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

const FB_PAGE_URL = process.env.FB_PAGE_URL
  || (process.env.FB_PAGE_ID ? `https://www.facebook.com/${process.env.FB_PAGE_ID}` : '');
const GEMINI_VIDEO_GEN = process.env.GEMINI_VIDEO_GENERATOR
  || path.join(__dirname, 'gemini-video-generator.mjs');
const VIDEO_OUTPUT_DIR = process.env.FB_VIDEO_OUTPUT_DIR
  || path.join(PROJECT_ROOT, 'outputs', 'fb-videos');

const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'fb-session');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'outputs', 'fb-debug');
const VIEWPORT = { width: 1366, height: 768 };

// ---------------------------------------------------------------------------
// Playwright dynamic import (reuse homelab node_modules if not local)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
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

function buildCaption(post) {
  return [
    post.hook ? `${post.hook}\n\n` : '',
    post.body || '',
    post.hashtags ? `\n\n${post.hashtags}` : '',
    post.cta ? `\n\n${post.cta}` : '',
  ].join('').trim();
}

async function saveDebug(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const p = path.join(DEBUG_DIR, `fb-${label}-${stamp}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
}

async function assertLoggedIn(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const url = page.url();
  if (/login|checkpoint|recover/i.test(url)) {
    throw new Error('Facebook session expired. Re-authenticate: node facebook-playwright-adapter.mjs --auth');
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Switch active Facebook profile to the business page
// ---------------------------------------------------------------------------

async function switchToPageProfile(page) {
  // There is a "Switch profiles" button directly on the Grizzly page — click it
  const switchBtn = page.locator(
    'div[role="button"]:has-text("Switch now"), span:has-text("Switch now"), a:has-text("Switch now"), div[role="button"]:has-text("Switch profiles"), span:has-text("Switch profiles"), a:has-text("Switch profiles")'
  ).first();

  if (await switchBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await switchBtn.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.error('Switched to Grizzly Electrical Solutions profile.');
    return true;
  }

  console.error('Warning: "Switch profiles" button not found — posting may appear as personal account.');
  return false;
}

// ---------------------------------------------------------------------------
// Navigate to the page's "Create post" composer
// ---------------------------------------------------------------------------

async function openPostComposer(page) {
  if (!FB_PAGE_URL) throw new Error('FB_PAGE_URL or FB_PAGE_ID must be set in .env');

  // Navigate to the page, switch profile if needed, then look for compose box
  await page.goto(FB_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await assertLoggedIn(page);
  await switchToPageProfile(page);
  await assertLoggedIn(page);

  // Click the "Create post" button or "What's on your mind?" box on the page
  const composerSelectors = [
    '[aria-label="Create post"]',
    '[aria-label="Write something..."]',
    '[data-testid="status-attachment-mentions-input"]',
    'div[role="button"]:has-text("Create post")',
    'div[role="button"]:has-text("Write something")',
    'div[role="button"]:has-text("What\'s on your mind")',
  ];

  let opened = false;
  for (const sel of composerSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 5000 });
      opened = true;
      break;
    }
  }

  if (!opened) {
    // Try clicking the text area placeholder that looks like a compose box
    const placeholder = page.locator('div[contenteditable="true"]').first();
    if (await placeholder.isVisible({ timeout: 5000 }).catch(() => false)) {
      await placeholder.click({ timeout: 5000 });
      opened = true;
    }
  }

  if (!opened) throw new Error('Could not find the Create Post button on the page.');

  // Wait for the composer modal/dialog to open
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Type the caption into the active composer
// ---------------------------------------------------------------------------

async function typeCaption(page, caption) {
  // Scope to the dialog to avoid picking up comment boxes in the feed behind the modal
  const dialog = page.locator('div[role="dialog"]').first();
  await dialog.waitFor({ timeout: 10000 });

  const textarea = dialog.locator('div[contenteditable="true"]').first();
  await textarea.waitFor({ timeout: 10000 });
  await textarea.click({ timeout: 5000 });
  await page.waitForTimeout(300);

  // Use clipboard paste for reliability with special characters and newlines
  await page.evaluate((text) => {
    const dialog = document.querySelector('div[role="dialog"]');
    const el = dialog ? dialog.querySelector('div[contenteditable="true"]') : null;
    if (el) {
      el.focus();
      document.execCommand('insertText', false, text);
    }
  }, caption);

  await page.waitForTimeout(500);

  // Verify something was typed
  const typed = await textarea.innerText().catch(() => '');
  if (!typed.includes(caption.slice(0, 20))) {
    await textarea.type(caption, { delay: 10 });
  }
}

// ---------------------------------------------------------------------------
// Attach a photo
// ---------------------------------------------------------------------------

async function attachPhoto(page, photoPath) {
  if (!fs.existsSync(photoPath)) throw new Error(`Photo file not found: ${photoPath}`);

  const dialog = page.locator('div[role="dialog"]').first();
  const photoBtn = dialog.locator(
    '[aria-label="Photo/video"], [aria-label="Add photos or videos"], [aria-label*="Photo"], button:has-text("Photo")'
  ).first();

  if (await photoBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await photoBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1000);
  }

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(photoPath);
  await page.waitForTimeout(3000);
}

// ---------------------------------------------------------------------------
// Attach a video
// ---------------------------------------------------------------------------

async function attachVideo(page, videoPath) {
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);

  const dialog = page.locator('div[role="dialog"]').first();

  // Click the Photo/video button to reveal the file inputs
  const videoBtn = dialog.locator(
    '[aria-label="Photo/video"], [aria-label="Add photos or videos"], [aria-label*="Photo"]'
  ).first();
  if (await videoBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await videoBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
  }

  // Target the file input that explicitly accepts video (not the photo-only input)
  let fileInput = page.locator('input[type="file"][accept*="video"]').first();
  const hasVideoInput = await fileInput.count() > 0;
  if (!hasVideoInput) {
    // Fallback: use the first file input
    fileInput = page.locator('input[type="file"]').first();
  }

  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(videoPath);

  // Videos take longer to process — wait for the upload progress to appear/clear
  console.error('Waiting for video to upload and process...');
  await page.waitForTimeout(30000);
}

// ---------------------------------------------------------------------------
// Submit the post
// ---------------------------------------------------------------------------

async function submitPost(page) {
  const dialog = page.locator('div[role="dialog"]').first();
  // Use exact text match to avoid matching "Add to your post" etc.
  const postBtn = dialog.locator(
    'div[role="button"]:text-is("Post"), button:text-is("Post"), [aria-label="Post"]:not([aria-label*="your"])'
  ).first();

  await postBtn.waitFor({ timeout: 15000 });

  // Make sure button is enabled
  const disabled = await postBtn.getAttribute('aria-disabled').catch(() => null);
  if (disabled === 'true') {
    throw new Error('Post button is disabled — caption may be empty or media still uploading.');
  }

  await postBtn.click({ timeout: 10000 });

  // Wait for the modal to close or a success indicator
  await Promise.race([
    page.locator('div[role="dialog"]').waitFor({ state: 'hidden', timeout: 30000 }),
    page.waitForNavigation({ timeout: 30000 }),
  ]).catch(() => {});

  await page.waitForTimeout(3000);
}

// ---------------------------------------------------------------------------
// Generate video with Gemini if needed
// ---------------------------------------------------------------------------

function generateGeminiVideo(prompt, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const out = execFileSync('node', [GEMINI_VIDEO_GEN, '--prompt', prompt, '--output', outputPath], {
    timeout: 5 * 60 * 1000,
    encoding: 'utf8',
  });
  const lastLine = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
  if (!lastLine) throw new Error('No JSON output from gemini-video-generator');
  const result = JSON.parse(lastLine);
  if (result.status !== 'success') throw new Error(`Video gen failed: ${result.message}`);
  return outputPath;
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
      args: ['--start-maximized'],
      ignoreDefaultArgs: ['--window-size'],
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1366, height: 900 });
    console.log('AUTH MODE: Log into Facebook (complete 2FA if needed), then close this window.');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    await context.close();
    console.log(JSON.stringify({ status: 'auth_complete', session_dir: USER_DATA_DIR }));
    return;
  }

  if (!args.payloadText) {
    console.log(JSON.stringify({ status: 'error', message: 'Missing --payload' }));
    process.exit(2);
  }

  const payload = JSON.parse(args.payloadText);
  const action = payload.action || {};
  const post = action.post || {};
  const live = Boolean(payload.live) && !args.dryRun;
  const type = (post.type || 'text').toLowerCase();
  const caption = buildCaption(post);

  // Dry run
  if (!live) {
    console.log(JSON.stringify({
      status: 'dry_run',
      adapter: 'facebook-playwright',
      action_id: action.id || null,
      post_type: type,
      date: post.date || post.day || null,
      caption_preview: caption.slice(0, 200) + (caption.length > 200 ? '...' : ''),
      hashtag_count: (post.hashtags || '').split(/\s+/).filter(h => h.startsWith('#')).length,
      photo_file: type === 'photo' ? (post.photo_file || null) : null,
      video_prompt: type === 'video' ? (post.video_prompt || null) : null,
      message: 'Dry run — no browser launched',
    }));
    return;
  }

  // Resolve video file for video posts
  let videoPath = post.video_file || null;
  if (type === 'video' && !videoPath) {
    const videoPrompt = post.video_prompt;
    if (!videoPrompt) throw new Error('video_prompt or video_file required for video posts');
    const dateSlug = (post.date || post.day || new Date().toISOString().slice(0, 10)).replace(/\s/g, '-');
    videoPath = path.join(VIDEO_OUTPUT_DIR, `fb-video-${dateSlug}.mp4`);
    if (!fs.existsSync(videoPath)) {
      console.error(`Generating video via Gemini: ${videoPrompt.slice(0, 80)}...`);
      generateGeminiVideo(videoPrompt, videoPath);
      console.error(`Video saved: ${videoPath}`);
    } else {
      console.error(`Reusing existing video: ${videoPath}`);
    }
  }

  // Launch browser
  const { chromium } = await importPlaywright();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: VIEWPORT,
  });
  const page = await context.newPage();

  try {
    await openPostComposer(page);
    await saveDebug(page, 'after-open-composer');
    await typeCaption(page, caption);

    if (type === 'photo' && post.photo_file) {
      await attachPhoto(page, post.photo_file);
    } else if (type === 'video' && videoPath) {
      await saveDebug(page, 'before-attach-video');
      await attachVideo(page, videoPath);
      await saveDebug(page, 'after-attach-video');
    }

    await submitPost(page);

    // Get the URL of the posted content
    const currentUrl = page.url();

    console.log(JSON.stringify({
      status: 'success',
      adapter: 'facebook-playwright',
      action_id: action.id || null,
      post_type: type,
      date: post.date || post.day || null,
      page_url: currentUrl,
      video_file: videoPath || null,
    }));

  } catch (e) {
    const screenshot = await saveDebug(page, 'failure');
    console.log(JSON.stringify({
      status: 'error',
      adapter: 'facebook-playwright',
      action_id: action.id || null,
      message: e.message || String(e),
      debug_screenshot: screenshot,
    }));
    process.exit(1);
  } finally {
    await context.close();
  }
}

main().catch(e => {
  console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  process.exit(1);
});
