#!/usr/bin/env node
/**
 * facebook-poster.mjs
 * Single consolidated Facebook posting module for Grizzly Electrical Solutions.
 *
 * Replaces the three previous overlapping files:
 *   - facebook-poster-adapter.mjs      (single post via Graph API)
 *   - facebook-post-week.mjs           (whole-week batch + Playwright)
 *   - facebook-playwright-adapter.mjs  (single post via Playwright + login)
 *
 * Posting strategy:
 *   1. Graph API is the PRIMARY path (no browser needed).
 *   2. On a token-expiry error the Graph call retries once after re-resolving the
 *      Page token; if it still fails it throws a clear "regenerate your token" error.
 *   3. Playwright is an OPTIONAL fallback, used ONLY when explicitly enabled with
 *      FB_USE_PLAYWRIGHT=1 (it is never selected automatically).
 *
 * Modes:
 *   node facebook-poster.mjs --payload <json> [--dry-run]   # post ONE item (dashboard action queue)
 *   node facebook-poster.mjs [--schedule-all] [--time HH:MM] [--start-day N] [--end-day N] [--dry-run]
 *                                                            # whole week from facebook_posting_schedule.md (mav-bridge)
 *   node facebook-poster.mjs --check-token                  # print FB_PAGE_ACCESS_TOKEN status JSON
 *   node facebook-poster.mjs --auth                         # Playwright: first-time browser login
 *
 * Single-post payload shape:
 *   { "live": true, "action": { "id": "...", "post": {
 *       "type": "text|photo|video", "headline", "hook", "body", "hashtags",
 *       "photo_file", "video_prompt", "cta", "date", "day" } } }
 *
 * Required env (or .env):
 *   FB_PAGE_ID            — numeric Facebook Page ID
 *   FB_PAGE_ACCESS_TOKEN  — long-lived Page Access Token
 * Optional env:
 *   FB_MEDIA_MODE         — "real" (default): still photos + Ken Burns slideshow Reels from
 *                           real job photos. "ai": legacy Grok/Veo generative video for TYPE video.
 *   FB_USE_PLAYWRIGHT     — "1" to use Playwright browser automation instead of the Graph API
 *   FB_PAGE_URL           — page URL for Playwright (falls back to https://facebook.com/<FB_PAGE_ID>)
 *   FB_GRAPH_API_VERSION  — Graph API version (default v22.0)
 *   FB_VIDEO_OUTPUT_DIR   — where Reels/slideshows are saved (default outputs/fb-videos)
 *   GEMINI_VIDEO_GENERATOR — path to gemini-video-generator.mjs (only when FB_MEDIA_MODE=ai)
 *   GBP_PHOTO_PATH        — folder of GBP post photos used as photo / slideshow source
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePhotoFile } from './lib/schedule-text.mjs';
import { loadPhotoSelectionManifest, isManifestSelectionCompatible } from './lib/photo-selection.mjs';
import { postProcessVideo, enhanceVideo } from './video-postprocess.mjs';
import { buildSlideshowReel, parseOnScreenText } from './slideshow-reel.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

// FORCE-OVERRIDE: this script is spawned by mav-bridge, which inherits its env
// from PM2. PM2's ecosystem.config.cjs loads MCC's .env first (line 1), whose
// keys can differ from this repo's .env (notably GEMINI_API_KEY — a stale value
// there caused 401 auth failures on every Veo generation). .env here wins.
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
let FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
const GRAPH_API_VERSION = process.env.FB_GRAPH_API_VERSION || 'v22.0';
const USE_PLAYWRIGHT = /^(1|true|yes|on)$/i.test(process.env.FB_USE_PLAYWRIGHT || '');

const FB_PAGE_URL = process.env.FB_PAGE_URL
  || (FB_PAGE_ID ? `https://www.facebook.com/${FB_PAGE_ID}` : '');
const VIDEO_OUTPUT_DIR = process.env.FB_VIDEO_OUTPUT_DIR
  || path.join(PROJECT_ROOT, 'outputs', 'fb-videos');
// Media policy: "real" (default) = still photos + Ken Burns slideshows from job
// photos. "ai" = legacy generative video (Grok Imagine / Veo) for TYPE video.
const MEDIA_MODE = (process.env.FB_MEDIA_MODE || 'real').toLowerCase();
// Backend for AI video generation (only when FB_MEDIA_MODE=ai):
// 'xai' (Grok Imagine, default) or 'gemini' (Veo 3).
const VIDEO_BACKEND = (process.env.FB_VIDEO_BACKEND || 'xai').toLowerCase();
const GEMINI_VIDEO_GEN = process.env.GEMINI_VIDEO_GENERATOR
  || path.join(__dirname, 'gemini-video-generator.mjs');
const XAI_VIDEO_GEN = process.env.XAI_VIDEO_GENERATOR
  || path.join(__dirname, 'xai-video-generator.mjs');
const VIDEO_GEN_SCRIPT = VIDEO_BACKEND === 'gemini' ? GEMINI_VIDEO_GEN : XAI_VIDEO_GEN;
const GBP_PHOTO_PATH = process.env.GBP_PHOTO_PATH
  || String.raw`C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos`;
const PHOTO_SELECTION_MANIFEST = process.env.GBP_PHOTO_SELECTION_MANIFEST
  || path.join(PROJECT_ROOT, 'state', 'photo-selection-manifest.json');
const photoSelectionManifest = loadPhotoSelectionManifest(PHOTO_SELECTION_MANIFEST);
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const LOGO_PATH = process.env.GRIZZLY_LOGO_PATH || path.join(PROJECT_ROOT, 'assets', 'grizzly-logo.png');
const ENDCARD_PATH = process.env.GRIZZLY_ENDCARD_PATH || path.join(PROJECT_ROOT, 'assets', 'grizzly-endcard.jpg');
// Brand info stamped onto every video's end card so viewers always see the
// correct name + phone, regardless of what the video model hallucinates on
// shirts or signs inside the clip.
const BRAND_NAME = process.env.GRIZZLY_BRAND_NAME || 'Grizzly Electrical Solutions';
const BRAND_PHONE = process.env.GRIZZLY_BRAND_PHONE || '(469) 863-9804';
const BRAND_TEXT_LINE = process.env.GRIZZLY_TEXT_LINE || '(469) 896-3862';
const BRAND_LOCATION = process.env.GRIZZLY_BRAND_LOCATION || 'Rowlett, TX';
// First comment posted under every FB post. Fixed copy here (not the schedule's
// CONTACT text) so the LLM can never garble a public-facing phone number.
// (469) 896-3862 is the customer-chat Twilio text line (canonical:
// Hermes-Supervisor hermes-config/operational-facts.yaml); the schedule's
// CONTACT field now only gates whether the comment is posted.
const FIRST_COMMENT = process.env.FB_FIRST_COMMENT
  || '📲 Text us at (469) 896-3862 to get a free instant quote — calls welcome too!';
const ENDCARD_FONT = process.env.GRIZZLY_ENDCARD_FONT
  || (process.platform === 'win32'
    ? String.raw`C\:/Windows/Fonts/arialbd.ttf`
    : '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf');
const XAI_API_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';

// Must exceed gemini-video-generator's poll ceiling (90 polls × 8s = 720s) so a
// slow Veo 3 render isn't killed by the parent before it can finish. See Fix 1.
const VIDEO_GEN_TIMEOUT_MS = 13 * 60 * 1000;

// Playwright session/debug locations
const USER_DATA_DIR = path.join(os.homedir(), '.claude', 'fb-session');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'outputs', 'fb-debug');
const VIEWPORT = { width: 1366, height: 900 };

// ---------------------------------------------------------------------------
// Structured per-hop logging (Fix 5)
// Every outbound boundary tags its failures so a vague UI error can be traced
// to the exact hop that broke: dashboard → mav-bridge → facebook-poster → Graph/Playwright.
// All logs go to stderr; stdout is reserved for the final JSON result the caller parses.
// ---------------------------------------------------------------------------

function hopLog(hop, level, message, extra) {
  const rec = { ts: new Date().toISOString(), source: 'facebook-poster', hop, level, message, ...extra };
  console.error(`[facebook-poster][${hop}][${level}] ${message}`);
  if (level === 'error') console.error(`  ↳ ${JSON.stringify(rec)}`);
}

// One-time FFmpeg availability check — avoids crashing per-video with unhelpful
// errors when FFmpeg isn't installed; branded end cards are simply skipped.
let HAS_FFMPEG = false;
try {
  execFileSync('ffmpeg', ['-version'], { timeout: 5000, encoding: 'utf8', stdio: 'pipe' });
  HAS_FFMPEG = true;
} catch {
  hopLog('facebook-poster', 'warn', 'FFmpeg not found — branded end cards will be skipped for all videos this run');
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hasPhoneNumber(text) {
  return /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text);
}

/**
 * Classify a CTA string into its engagement type so the analytics pipeline
 * can correlate CTA type with engagement outcomes.
 * Returns: 'comment' | 'save' | 'tag' | 'vote' | 'share' | 'call' | 'other'
 */
function classifyCta(ctaText) {
  const t = (ctaText || '').toLowerCase();
  if (/\b(comment|tell us|drop a|what('s| is)|ask|answer|reply)\b/.test(t)) return 'comment';
  if (/\b(save|bookmark)\b/.test(t)) return 'save';
  if (/\b(tag|share with)\b/.test(t)) return 'tag';
  if (/\b(vote|poll|choose|pick|this or that|which would|which one|👍)\b/.test(t)) return 'vote';
  if (/\b(share|send to|forward)\b/.test(t)) return 'share';
  if (/\b(call|phone|☎|📞)\b/.test(t)) return 'call';
  return 'other';
}

/**
 * Log initial post engagement tracking data.
 * Facebook Insights data isn't available immediately after publishing;
 * we log the post ID and goal for later analysis. The analytics feedback
 * pipeline handles the delayed read-back.
 */
function trackPostEngagement(postId, postGoal, postDay) {
  hopLog('facebook-poster', 'info',
    `Post ${postId} (day ${postDay}) published — goal: ${postGoal || 'unspecified'}`);
  return { postId, postGoal, tracked: true };
}

const FIRST_COMMENT_STATE_FILE = path.join(PROJECT_ROOT, 'state', 'fb-first-comments.json');
const PENDING_FIRST_COMMENT_FILE = path.join(PROJECT_ROOT, 'state', 'fb-pending-first-comments.json');
const PHONE_IN_TEXT_RE = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const CONTACT_STYLE_RE = /text us|instant quote|896-3862|863-9804/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadFirstCommentState() {
  try {
    if (fs.existsSync(FIRST_COMMENT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(FIRST_COMMENT_STATE_FILE, 'utf8'));
    }
  } catch { /* ignore corrupt state */ }
  return { posts: {} };
}

function saveFirstCommentState(state) {
  try {
    fs.mkdirSync(path.dirname(FIRST_COMMENT_STATE_FILE), { recursive: true });
    // Keep ~90 days of success markers
    const cutoff = Date.now() - 90 * 86400000;
    for (const [id, entry] of Object.entries(state.posts || {})) {
      const ts = typeof entry === 'object' ? entry.ts : entry;
      if (!ts || ts < cutoff) delete state.posts[id];
    }
    fs.writeFileSync(FIRST_COMMENT_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    hopLog('facebook-poster', 'warn', `Could not save first-comment state: ${e.message}`);
  }
}

function resolveFirstCommentText(contactText) {
  // Always prefer the fixed public-facing copy. Schedule CONTACT only used to
  // be a gate; LLM-written CONTACT lines often include instructional notes.
  const fixed = (FIRST_COMMENT || '').trim();
  if (fixed) return fixed;
  const raw = String(contactText || '').trim();
  if (!raw) return '';
  // Strip trailing "— *posted as first comment..." annotations from schedules
  return raw.replace(/\s*[—-]\s*\*+posted as first comment[\s\S]*$/i, '').trim();
}

function isContactStyleComment(message) {
  const msg = String(message || '');
  return CONTACT_STYLE_RE.test(msg) || PHONE_IN_TEXT_RE.test(msg);
}

/**
 * Does this post already have our page's contact/phone first comment?
 * Returns { present, commentId } or { present:false, error }.
 */
export async function hasContactFirstComment(postId) {
  if (!postId || !FB_PAGE_ACCESS_TOKEN) {
    return { present: false, error: 'missing postId or token' };
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}/comments`
    + `?fields=id,message,from{id}`
    + `&order=chronological`
    + `&filter=stream`
    + `&limit=25`
    + `&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) {
      return { present: false, error: json.error.message || JSON.stringify(json.error), code: json.error.code };
    }
    const comments = json.data || [];
    const hit = comments.find((c) => {
      const fromPage = !c.from?.id || String(c.from.id) === String(FB_PAGE_ID);
      return fromPage && isContactStyleComment(c.message);
    });
    return hit
      ? { present: true, commentId: hit.id }
      : { present: false };
  } catch (e) {
    return { present: false, error: e.message };
  }
}

/**
 * Post (or ensure) the Grizzly contact first-comment on a live FB post.
 *
 * Reliability notes:
 * - Facebook rejects comments on unpublished / still-processing media. Callers
 *   must only invoke this for live posts; we still retry transient failures.
 * - Graph errors used to be swallowed (return null) while reconcile marked the
 *   row `posted` forever — one-shot, no retry. This now returns a structured
 *   result, retries with backoff, and is idempotent via Graph read + local state.
 *
 * @returns {{ ok: boolean, id?: string, skipped?: boolean, reason?: string, attempts?: number, error?: string }}
 */
export async function postFirstComment(postId, contactText, options = {}) {
  const {
    retries = 4,
    initialDelayMs = 0,
    backoffMs = 4000,
    skipIfPresent = true,
    persistState = true,
  } = options;

  const message = resolveFirstCommentText(contactText);
  if (!postId) return { ok: false, error: 'missing postId' };
  if (!message) return { ok: false, error: 'missing first-comment text' };
  if (!FB_PAGE_ACCESS_TOKEN) return { ok: false, error: 'FB_PAGE_ACCESS_TOKEN not set' };

  if (persistState) {
    const state = loadFirstCommentState();
    const prior = state.posts?.[postId];
    if (prior && (prior.ok || prior === true)) {
      return { ok: true, skipped: true, reason: 'state_already_ok', id: prior.id || null };
    }
  }

  if (initialDelayMs > 0) await sleep(initialDelayMs);

  if (skipIfPresent) {
    const existing = await hasContactFirstComment(postId);
    if (existing.present) {
      if (persistState) {
        const state = loadFirstCommentState();
        state.posts[postId] = { ok: true, id: existing.commentId, ts: Date.now(), source: 'preexisting' };
        saveFirstCommentState(state);
      }
      hopLog('facebook-poster→graph', 'info', `Contact first comment already present on ${postId}`);
      return { ok: true, skipped: true, reason: 'already_present', id: existing.commentId };
    }
  }

  let lastError = null;
  const attempts = Math.max(1, retries);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const body = new URLSearchParams({
        message,
        access_token: FB_PAGE_ACCESS_TOKEN,
      });
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}/comments`,
        { method: 'POST', body }
      );
      const json = await res.json();
      if (json.error) {
        lastError = json.error.message || JSON.stringify(json.error);
        hopLog('facebook-poster→graph', 'warn',
          `First comment attempt ${attempt}/${attempts} failed for ${postId}: ${lastError}`,
          { code: json.error.code });
      } else if (json.id) {
        hopLog('facebook-poster→graph', 'info', `Contact posted as first comment on ${postId} (${json.id})`);
        if (persistState) {
          const state = loadFirstCommentState();
          state.posts[postId] = { ok: true, id: json.id, ts: Date.now(), source: 'posted' };
          saveFirstCommentState(state);
        }
        return { ok: true, id: json.id, attempts: attempt };
      } else {
        lastError = 'empty Graph response';
      }
    } catch (e) {
      lastError = e.message || String(e);
      hopLog('facebook-poster→graph', 'warn',
        `First comment attempt ${attempt}/${attempts} network error for ${postId}: ${lastError}`);
    }

    if (attempt < attempts) {
      // Exponential backoff; videos often need a few seconds after publish.
      await sleep(backoffMs * attempt);
    }
  }

  if (persistState) {
    const state = loadFirstCommentState();
    state.posts[postId] = { ok: false, error: lastError, ts: Date.now() };
    saveFirstCommentState(state);
  }
  return { ok: false, error: lastError || 'unknown', attempts };
}

/**
 * Ensure contact first-comments exist on a list of live post IDs.
 * Safe to call repeatedly (idempotent).
 */
export async function ensureFirstComments(postIds, options = {}) {
  const ids = [...new Set((postIds || []).filter(Boolean).map(String))];
  const results = [];
  for (const id of ids) {
    const r = await postFirstComment(id, FIRST_COMMENT, options);
    results.push({ postId: id, ...r });
    // small gap between posts to stay under Graph burst limits
    await sleep(500);
  }
  return results;
}

function loadPendingFirstComments() {
  try {
    if (fs.existsSync(PENDING_FIRST_COMMENT_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_FIRST_COMMENT_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return { pending: {} };
}

function savePendingFirstComments(state) {
  try {
    fs.mkdirSync(path.dirname(PENDING_FIRST_COMMENT_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FIRST_COMMENT_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    hopLog('facebook-poster', 'warn', `Could not save pending first-comment queue: ${e.message}`);
  }
}

/** Queue a first-comment for after a scheduled post goes live (Graph rejects early). */
export function queuePendingFirstComment(postId, meta = {}) {
  if (!postId) return;
  const state = loadPendingFirstComments();
  state.pending[String(postId)] = {
    ...meta,
    queuedAt: new Date().toISOString(),
  };
  savePendingFirstComments(state);
  hopLog('facebook-poster', 'info', `Queued first-comment for scheduled post ${postId}`);
}

/**
 * Drain local pending first-comment queue (no Supabase required).
 * Call after publish day, or via: node facebook-poster.mjs --backfill-comments
 */
export async function drainPendingFirstComments(options = {}) {
  const state = loadPendingFirstComments();
  const entries = Object.entries(state.pending || {});
  const results = [];
  for (const [postId, meta] of entries) {
    const isVideo = /video|slideshow|reel/i.test(String(meta?.type || meta?.media || ''));
    const r = await postFirstComment(postId, FIRST_COMMENT, {
      retries: isVideo ? 6 : 4,
      initialDelayMs: isVideo ? 3000 : 500,
      backoffMs: 4000,
      ...options,
    });
    results.push({ postId, ...r, meta });
    if (r.ok) {
      delete state.pending[postId];
    }
    await sleep(400);
  }
  savePendingFirstComments(state);
  return results;
}

export function buildCaption(post) {
  const parts = [];
  if (post.hook) parts.push(post.hook);
  if (post.body || post.headline) parts.push(`\n${post.body || post.headline}`);
  if (post.hashtags) parts.push(`\n\n${post.hashtags}`);
  // CTA: only include if it's an ENGAGEMENT CTA (no phone numbers).
  // Phone-number CTAs are stripped because Facebook's algorithm suppresses
  // posts with sales-style phone CTAs in the caption. Contact info goes in
  // the first comment instead (see postFirstComment below).
  if (post.cta && !hasPhoneNumber(post.cta)) parts.push(`\n\n${post.cta}`);
  return parts.join('').trim();
}

function stripMd(str) {
  return (str || '').replace(/\*\*/g, '').trim();
}

function parseSchedule(filePath) {
  return parseScheduleText(fs.readFileSync(filePath, 'utf8'));
}

export function parseScheduleText(text) {
  // Anchor blocks on `DAY:` field lines rather than splitting on `---`:
  // executor models sometimes put a `---` INSIDE a day block (between the
  // metadata fields and HOOK/BODY), which would orphan the content from its
  // DAY marker and yield empty captions.
  const starts = [];
  const dayRe = /^\*{0,2}DAY:/gm;
  let dm;
  while ((dm = dayRe.exec(text)) !== null) starts.push(dm.index);
  const blocks = starts.map((s, i) => text.slice(s, i + 1 < starts.length ? starts[i + 1] : text.length));
  return blocks.map(block => {
    // Executor models vary between `**HOOK:** value` (inline) and `**HOOK:**\nvalue`
    // (value on the following lines) — accept both, reading until the next field
    // header. An inline value that is only `**`/whitespace counts as empty.
    const get = (key) => {
      const m = block.match(new RegExp(`^\\*{0,2}${key}:\\*{0,2}[ \\t]*(.*)$`, 'm'));
      if (!m) return '';
      const inline = stripMd(m[1]);
      if (inline) return inline;
      const following = block.slice(m.index + m[0].length).split('\n').slice(1);
      const lines = [];
      for (const line of following) {
        if (/^\*{0,2}[A-Z_]+:/.test(line.trim()) || /^#{1,6}\s/.test(line.trim()) || /^-{3,}$/.test(line.trim())) break;
        lines.push(line);
      }
      return stripMd(lines.join('\n').trim());
    };
    const type = get('TYPE').toLowerCase();
    // DATE lines often look like "2026-08-17 (Monday, August 17, 2026)" — keep ISO only.
    const dateRaw = get('DATE');
    const dateIso = (dateRaw.match(/\d{4}-\d{2}-\d{2}/) || [dateRaw.replace(/\s*\(.*$/, '').trim()])[0];
    return {
      day: parseInt(get('DAY')) || 0,
      date: dateIso,
      type,
      service: get('SERVICE'),
      post_goal: get('POST_GOAL') || '',
      hook: get('HOOK'),
      body: get('BODY'),
      cta: get('CTA'),
      hashtags: get('HASHTAGS'),
      contact: get('CONTACT') || '',
      photo_file: normalizePhotoFile(get('PHOTO_FILE')),
      video_prompt: get('VIDEO_PROMPT'),
      on_screen_text: get('ON_SCREEN_TEXT') || '',
      boost: get('BOOST') || '',
      boost_amount: get('BOOST_AMOUNT') || '',
      boost_duration: get('BOOST_DURATION') || '',
      boost_targeting: get('BOOST_TARGETING') || '',
      status: get('STATUS'),
    };
  }).filter(p => p.day > 0 && p.type !== 'skip').sort((a, b) => a.day - b.day);
}

const GBP_CURATED_FOLDER = process.env.GBP_CURATED_FOLDER || 'E:\\Media\\Grizzly\\Curated';

function curatedPhotoForDate(date, service) {
  // gbp-photo-pick copies winners as `${date}-${slug}.<ext>`. For a FB video day
  // whose video failed, reuse that same-day curated photo so we post an image,
  // not text. Prefer a file whose slug matches the post's service type; if
  // multiple services share a date, fall back to the first match.
  if (!date) return null;
  // Schedule DATE fields sometimes include a human parenthetical.
  date = String(date).replace(/\s*\(.*$/, '').trim();
  try {
    const files = fs.readdirSync(GBP_CURATED_FOLDER)
      .filter(f => f.startsWith(`${date}-`) && /\.(jpe?g|png|webp)$/i.test(f))
      .sort();
    if (!files.length) return null;
    if (service) {
      const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const matches = files.filter(f => f.toLowerCase().includes(slug));
      for (const match of matches) {
        const candidate = path.join(GBP_CURATED_FOLDER, match);
        if (isManifestSelectionCompatible({
          date,
          service,
          photoPath: candidate,
          manifest: photoSelectionManifest,
        }).ok) return candidate;
      }
    }
    for (const file of files) {
      const candidate = path.join(GBP_CURATED_FOLDER, file);
      if (isManifestSelectionCompatible({
        date,
        service,
        photoPath: candidate,
        manifest: photoSelectionManifest,
      }).ok) return candidate;
    }
    return null;
  } catch { return null; }
}

function resolvePhotoPath(post) {
  // Explicit PHOTO_FILE from the schedule is trusted when the file exists on disk
  // in curated/GBP libraries (crew/human-picked). Manifest audit is a soft
  // warning only for those explicit picks so carousel/slideshow weeks don't
  // collapse to text when the pick pipeline hasn't re-manifested every file.
  const acceptExplicit = (candidate) => {
    if (!candidate || !fs.existsSync(candidate)) return null;
    if (photoSelectionManifest?.length) {
      const audit = isManifestSelectionCompatible({
        date: post.date,
        service: post.service,
        photoPath: candidate,
        manifest: photoSelectionManifest,
      });
      if (!audit.ok) {
        hopLog('facebook-poster', 'warn',
          `[photo-guard] explicit PHOTO_FILE not in manifest (${audit.reason}) — allowing ${path.basename(candidate)}`);
      }
    }
    return candidate;
  };
  const photoFile = (post.photo_file || '').trim();
  // Multi-file PHOTO_FILE is handled by resolveCarouselPhotos — take first only here.
  const firstFile = photoFile && /[,|;]/.test(photoFile)
    ? photoFile.split(/[,|;]+/)[0].trim()
    : photoFile;
  if (firstFile) {
    if (path.isAbsolute(firstFile)) {
      const accepted = acceptExplicit(firstFile);
      if (accepted) return accepted;
    } else {
      const basenames = [firstFile, path.basename(firstFile)];
      for (const name of basenames) {
        const candidates = [
          path.join(GBP_CURATED_FOLDER, name),
          path.join(GBP_PHOTO_PATH, name),
          path.join(PROJECT_ROOT, 'outputs', name),
        ];
        for (const c of candidates) {
          const accepted = acceptExplicit(c);
          if (accepted) return accepted;
        }
      }
    }
  }
  // No usable explicit photo — try the same-date curated winner (video-day fallback).
  return curatedPhotoForDate(post.date, post.service);
}

function resolveVideoPath(post) {
  const slug = (post.date || post.day || new Date().toISOString().slice(0, 10)).toString().replace(/\s/g, '-');
  return path.join(VIDEO_OUTPUT_DIR, `fb-video-${slug}.mp4`);
}

function resolveSlideshowPath(post) {
  const slug = (post.date || post.day || new Date().toISOString().slice(0, 10)).toString().replace(/\s/g, '-');
  return path.join(VIDEO_OUTPUT_DIR, `fb-reel-${slug}.mp4`);
}

function isMotionType(type) {
  const t = (type || '').toLowerCase();
  return t === 'video' || t === 'slideshow';
}

/** Under FB_MEDIA_MODE=real, TYPE video|slideshow → photo slideshow Reel (no AI). */
function wantsSlideshow(post) {
  if (MEDIA_MODE === 'ai') return false;
  return isMotionType(post.type);
}

function curatedPhotosForPost(post, max = 4) {
  // Prefer same-date curated winners (gbp-photo-pick). If the selection
  // manifest is empty/missing, date-prefixed curated files are still trusted —
  // they only land in GBP_CURATED_FOLDER via the pick pipeline.
  const date = (post.date || '').replace(/\s*\(.*$/, '').trim();
  if (!date) return [];
  try {
    let files = fs.readdirSync(GBP_CURATED_FOLDER)
      .filter((f) => f.startsWith(`${date}-`) && /\.(jpe?g|png|webp)$/i.test(f))
      .sort();
    if (!files.length && post.service) {
      const slug = post.service.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      // Match on meaningful tokens (not only the full slug) so
      // "Federal Pacific / Zinsco Panel Replacement" hits federal-pacific-zinsco-*.
      const tokens = slug.split('-').filter((t) => t.length >= 4);
      files = fs.readdirSync(GBP_CURATED_FOLDER)
        .filter((f) => {
          if (!/\.(jpe?g|png|webp)$/i.test(f)) return false;
          const low = f.toLowerCase();
          if (low.includes(slug)) return true;
          const hits = tokens.filter((t) => low.includes(t)).length;
          return hits >= Math.min(2, tokens.length);
        })
        .sort()
        .slice(-max);
    }
    const out = [];
    const manifestEmpty = !photoSelectionManifest || photoSelectionManifest.length === 0;
    for (const file of files) {
      if (out.length >= max) break;
      const candidate = path.join(GBP_CURATED_FOLDER, file);
      if (manifestEmpty) {
        out.push(candidate);
        continue;
      }
      const audit = isManifestSelectionCompatible({
        date: post.date,
        service: post.service,
        photoPath: candidate,
        manifest: photoSelectionManifest,
      });
      if (audit.ok) out.push(candidate);
    }
    // Date-prefixed curated files with no matching manifest entry: still allow
    // them for slideshow (same trust boundary as pre-manifest video fallback).
    if (!out.length && files.length) {
      for (const file of files.slice(0, max)) {
        out.push(path.join(GBP_CURATED_FOLDER, file));
      }
    }
    return out;
  } catch {
    return [];
  }
}

function resolveSlideshowPhotos(post) {
  // Explicit multi PHOTO_FILE list (same syntax as carousel)
  const raw = post.photo_file || '';
  if (raw && /[,|;]/.test(raw)) {
    const parts = raw.split(/[,|;]+/).map((s) => s.trim()).filter(Boolean);
    const resolved = [];
    for (const part of parts) {
      const p = resolvePhotoPath({ ...post, photo_file: part });
      if (p && !resolved.includes(p)) resolved.push(p);
    }
    if (resolved.length) return resolved.slice(0, 6);
  }
  const photos = curatedPhotosForPost(post, 4);
  if (photos.length) return photos;
  const single = resolvePhotoPath(post);
  return single ? [single] : [];
}

/**
 * Prepare motion media for posts. Default FB_MEDIA_MODE=real builds Ken Burns
 * slideshows from real photos. FB_MEDIA_MODE=ai keeps the legacy generative path.
 */
async function prepareMotionMedia(posts) {
  const motionPosts = posts.filter((p) => isMotionType(p.type));
  if (!motionPosts.length) return;

  if (MEDIA_MODE === 'ai') {
    hopLog('facebook-poster', 'info', 'FB_MEDIA_MODE=ai — generative video backend');
    await generateAllVideos(posts);
    for (const p of posts) {
      if (isMotionType(p.type)) p._videoPath = resolveVideoPath(p);
    }
    return;
  }

  hopLog('facebook-poster', 'info',
    'FB_MEDIA_MODE=real — still photos + Ken Burns slideshows (no AI video)');
  fs.mkdirSync(VIDEO_OUTPUT_DIR, { recursive: true });

  for (const post of motionPosts) {
    const outPath = resolveSlideshowPath(post);
    if (fs.existsSync(outPath)) {
      hopLog('facebook-poster', 'info',
        `Day ${post.day}: reusing slideshow ${path.basename(outPath)}`);
      post._videoPath = outPath;
      post.type = 'video';
      continue;
    }
    const photos = resolveSlideshowPhotos(post);
    if (!photos.length) {
      hopLog('facebook-poster', 'warn',
        `Day ${post.day}: no photos for slideshow — will fall back to still/text`);
      continue;
    }
    try {
      const textItems = parseOnScreenText(post.on_screen_text);
      // If the schedule left ON_SCREEN_TEXT blank, use hook + short body beats.
      if (!textItems.length && post.hook) {
        textItems.push({ start: 0, end: 3, text: String(post.hook).slice(0, 80) });
        if (post.service) {
          textItems.push({ start: 3, end: 7, text: String(post.service).slice(0, 60) });
        }
      }
      const result = buildSlideshowReel({
        photos,
        textItems,
        outPath,
        workDir: VIDEO_OUTPUT_DIR,
      });
      if (result.status !== 'success') {
        hopLog('facebook-poster', 'warn',
          `Day ${post.day}: slideshow failed (${result.message}) — photo/text fallback`);
        continue;
      }
      post._videoPath = outPath;
      post.type = 'video'; // Graph path uploads video for motion posts
      hopLog('facebook-poster', 'info',
        `Day ${post.day}: slideshow ready (${result.photos} photos, ${result.duration}s, `
        + `${(result.sizeBytes / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      hopLog('facebook-poster', 'warn',
        `Day ${post.day}: slideshow error (${e.message.slice(0, 120)}) — photo/text fallback`);
    }
  }
}

function dateTimeToUnix(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0).getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Token handling (Graph API)
// ---------------------------------------------------------------------------

class TokenExpiredError extends Error {}

function isTokenError(graphError) {
  // Graph error codes 190 (invalid/expired OAuth token) and 102 (session
  // invalidated) are the only true token errors. Facebook labels MANY
  // unrelated errors with type 'OAuthException' (e.g. 197 "post is empty"),
  // so type alone must never trigger the regenerate-token advice.
  return graphError && (graphError.code === 190 || graphError.code === 102);
}

function tokenErrorMessage(graphError) {
  return `FB_PAGE_ACCESS_TOKEN is expired or invalid (Graph error ${graphError?.code ?? '190'}: `
    + `${graphError?.message || 'OAuthException'}). Regenerate a long-lived Page Access Token at `
    + `https://developers.facebook.com/tools/explorer and update FB_PAGE_ACCESS_TOKEN in .env.`;
}

async function debugToken(token) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/debug_token`
    + `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  return res.json();
}

/**
 * Pure classification of a /debug_token response. Extracted so the expiry-decision
 * logic (the part with real edge cases: invalid / expired / expiring-soon / never-expires)
 * is testable without a network call. See scripts/facebook-poster.selfcheck.mjs.
 */
export function classifyDebugToken(json, nowSec) {
  const data = json?.data || {};
  if (json?.error || data.is_valid === false) {
    return {
      ok: false, level: 'error', valid: false, expired: true,
      message: tokenErrorMessage(json?.error || { code: 190, message: data.error?.message || 'token invalid' }),
    };
  }
  const expiresAt = Number(data.expires_at || 0); // 0 = never expires (long-lived page token)
  if (!expiresAt) {
    return { ok: true, level: 'info', valid: true, neverExpires: true, expiresAt: 0, message: 'FB token valid (no expiry)' };
  }
  const daysLeft = Math.floor((expiresAt - nowSec) / 86400);
  if (daysLeft < 0) {
    return { ok: false, level: 'error', valid: false, expired: true, expiresAt, daysLeft, message: tokenErrorMessage({ code: 190, message: 'token expired' }) };
  }
  if (daysLeft <= 7) {
    return {
      ok: false, level: 'warn', valid: true, expiresAt, daysLeft,
      message: `FB_PAGE_ACCESS_TOKEN expires in ${daysLeft} day(s) (${new Date(expiresAt * 1000).toISOString().slice(0, 10)}). Regenerate it soon at https://developers.facebook.com/tools/explorer`,
    };
  }
  return { ok: true, level: 'info', valid: true, expiresAt, daysLeft, message: `FB token valid (${daysLeft} days left)` };
}

/**
 * Validate FB_PAGE_ACCESS_TOKEN against the /debug_token endpoint. (Fix 4)
 * Returns a structured status; callers log the message at the right level.
 */
export async function checkFacebookToken(token = FB_PAGE_ACCESS_TOKEN) {
  if (!token) {
    return { ok: false, level: 'warn', valid: false, message: 'FB_PAGE_ACCESS_TOKEN not set in .env' };
  }
  let json;
  try {
    json = await debugToken(token);
  } catch (e) {
    return { ok: false, level: 'warn', valid: false, message: `Could not reach Graph debug_token: ${e.message}` };
  }
  return classifyDebugToken(json, Math.floor(Date.now() / 1000));
}

// Re-resolve a Page token from a (possibly user) token. Used once on retry.
async function resolvePageToken() {
  const probe = await debugToken(FB_PAGE_ACCESS_TOKEN).catch(() => ({}));
  if (probe?.data?.type === 'PAGE') return; // already a page token
  hopLog('facebook-poster→graph', 'info', 'User token detected — exchanging for a Page Access Token...');
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}?fields=access_token,name`
    + `&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`
  );
  const json = await res.json();
  if (json.error) throw new TokenExpiredError(tokenErrorMessage(json.error));
  if (!json.access_token) throw new Error('No access_token in page response — ensure pages_manage_posts is granted.');
  FB_PAGE_ACCESS_TOKEN = json.access_token;
  hopLog('facebook-poster→graph', 'info', `Got Page token for: ${json.name}`);
}

// Run a Graph operation, retrying once on token expiry after re-resolving the token. (Fix 3.2)
async function withTokenRetry(label, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof TokenExpiredError)) throw e;
    hopLog('facebook-poster→graph', 'warn', `${label}: token error — re-resolving Page token and retrying once`);
    await resolvePageToken();
    try {
      return await fn();
    } catch (e2) {
      hopLog('facebook-poster→graph', 'error', `${label}: still failing after token refresh`, { detail: e2.message });
      // Propagate the real error — a different failure after refresh (e.g.
      // empty caption) must keep its message, not the regenerate-token advice.
      throw e2;
    }
  }
}

// ---------------------------------------------------------------------------
// Graph API posting
// ---------------------------------------------------------------------------

async function graphParse(label, res) {
  const json = await res.json();
  if (json.error) {
    if (isTokenError(json.error)) throw new TokenExpiredError(tokenErrorMessage(json.error));
    hopLog('facebook-poster→graph', 'error', `${label} failed`, { code: json.error.code, detail: json.error.message });
    throw new Error(`Graph API (${label}): ${json.error.message}`);
  }
  return json;
}

async function graphPostText(caption, scheduleUnix) {
  if (!caption || !caption.trim()) {
    // Graph rejects empty text posts with error 197 — fail fast with the real
    // reason (a schedule/payload parse that produced no HOOK/BODY) instead.
    throw new Error('Refusing to post: caption is empty. The post content parse produced no HOOK/BODY — check the schedule/payload format, this is NOT a token problem.');
  }
  const body = new URLSearchParams({ message: caption, access_token: FB_PAGE_ACCESS_TOKEN });
  if (scheduleUnix) { body.append('published', 'false'); body.append('scheduled_publish_time', String(scheduleUnix)); }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/feed`, { method: 'POST', body });
  return (await graphParse('text', res)).id;
}

async function graphPostPhoto(photoPath, caption, scheduleUnix) {
  const form = new FormData();
  form.append('caption', caption);
  form.append('access_token', FB_PAGE_ACCESS_TOKEN);
  form.append('source', new Blob([fs.readFileSync(photoPath)]), path.basename(photoPath));
  if (scheduleUnix) { form.append('published', 'false'); form.append('scheduled_publish_time', String(scheduleUnix)); }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/photos`, { method: 'POST', body: form });
  return (await graphParse('photo', res)).id;
}

/**
 * Multi-photo carousel: upload unpublished photos, then attach them to a feed post.
 * Graph requires ≥2 unpublished media_fbids on /feed with attached_media[n].
 */
async function graphPostCarousel(photoPaths, caption, scheduleUnix) {
  const paths = (photoPaths || []).filter((p) => p && fs.existsSync(p)).slice(0, 10);
  if (paths.length < 2) {
    throw new Error(`Carousel needs ≥2 photos (got ${paths.length})`);
  }
  if (!caption || !caption.trim()) {
    throw new Error('Refusing to post carousel: caption is empty.');
  }
  const mediaIds = [];
  for (const photoPath of paths) {
    const form = new FormData();
    form.append('published', 'false');
    form.append('temporary', 'true');
    form.append('access_token', FB_PAGE_ACCESS_TOKEN);
    form.append('source', new Blob([fs.readFileSync(photoPath)]), path.basename(photoPath));
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/photos`,
      { method: 'POST', body: form },
    );
    const json = await graphParse('carousel photo upload', res);
    if (!json.id) throw new Error(`Carousel photo upload returned no id for ${path.basename(photoPath)}`);
    mediaIds.push(json.id);
  }
  const body = new URLSearchParams();
  body.append('message', caption);
  body.append('access_token', FB_PAGE_ACCESS_TOKEN);
  mediaIds.forEach((id, i) => {
    body.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id }));
  });
  if (scheduleUnix) {
    body.append('published', 'false');
    body.append('scheduled_publish_time', String(scheduleUnix));
  }
  const feedRes = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/feed`,
    { method: 'POST', body },
  );
  return (await graphParse('carousel feed', feedRes)).id;
}

function resolveCarouselPhotos(post) {
  // Explicit multi-path PHOTO_FILE: "a.jpg, b.jpg" or pipe-separated
  const raw = post.photo_file || '';
  if (raw && /[,|;]/.test(raw)) {
    const parts = raw.split(/[,|;]+/).map((s) => s.trim()).filter(Boolean);
    const resolved = [];
    for (const part of parts) {
      const probe = { ...post, photo_file: part };
      const p = resolvePhotoPath(probe);
      if (p && !resolved.includes(p)) resolved.push(p);
    }
    if (resolved.length >= 2) return resolved.slice(0, 10);
    // If only one explicit resolved, still try curated fill
    const fill = curatedPhotosForPost(post, 6);
    for (const p of fill) {
      if (!resolved.includes(p)) resolved.push(p);
      if (resolved.length >= 6) break;
    }
    if (resolved.length >= 2) return resolved.slice(0, 10);
  }
  const curated = curatedPhotosForPost(post, 6);
  if (curated.length >= 2) return curated.slice(0, 6);
  const single = resolvePhotoPath(post);
  if (single && curated.length === 1 && curated[0] !== single) return [single, curated[0]];
  return curated.length >= 2 ? curated : (single ? [single] : []);
}

async function graphPostVideo(videoPath, caption, scheduleUnix) {
  // Single-request upload via multipart form. The older resumable/chunked
  // (upload_phase start→transfer→finish) path returns {"success":true} with no
  // video id on current Graph API versions — the video object is never created,
  // so the post silently never appears. Short Veo clips (<1GB) upload fine in
  // one request, and this path returns the actual video id.
  const form = new FormData();
  form.append('description', caption);
  form.append('access_token', FB_PAGE_ACCESS_TOKEN);
  form.append('file_type', 'video/mp4');
  form.append('source', new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' }), path.basename(videoPath));
  if (scheduleUnix) {
    form.append('published', 'false');
    form.append('scheduled_publish_time', String(scheduleUnix));
  } else {
    form.append('published', 'true');
  }
  const url = `https://graph-video.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/videos`;
  const json = await graphParse('video upload', await fetch(url, { method: 'POST', body: form }));
  if (!json.id) throw new Error(`Video upload returned no id: ${JSON.stringify(json)}`);
  return json.id;
}

// Dispatch one post over the Graph API, with token-expiry retry around the whole op.
// Returns { id, media, fallback } where media is 'video' | 'photo' | 'text' — what actually
// went out — and fallback is null unless the intended media type could not be honored
// (e.g. 'video→photo', 'video→text', 'photo→text').
async function graphDispatch(post, caption, videoPath, scheduleUnix) {
  return withTokenRetry(`day ${post.day ?? '?'} (${post.type})`, async () => {
    if (isMotionType(post.type) && videoPath && fs.existsSync(videoPath)) {
      hopLog('facebook-poster→graph', 'info', `Uploading video (${(fs.statSync(videoPath).size / 1e6).toFixed(1)} MB)`);
      return { id: await graphPostVideo(videoPath, caption, scheduleUnix), media: 'video', fallback: null };
    }
    // Multi-photo carousel (TYPE carousel, or photo day with ≥2 curated stills when forced)
    if ((post.type || '').toLowerCase() === 'carousel') {
      const photos = resolveCarouselPhotos(post);
      if (photos.length >= 2) {
        hopLog('facebook-poster→graph', 'info',
          `Uploading carousel (${photos.length} photos): ${photos.map((p) => path.basename(p)).join(', ')}`);
        return {
          id: await graphPostCarousel(photos, caption, scheduleUnix),
          media: 'carousel',
          fallback: null,
        };
      }
      hopLog('facebook-poster→graph', 'warn',
        `Carousel needs ≥2 photos (got ${photos.length}) — falling back to single photo/text`);
    }
    const fullPhotoPath = resolvePhotoPath(post);
    if (fullPhotoPath) {
      const fallback = isMotionType(post.type)
        ? 'video→photo'
        : (post.type || '').toLowerCase() === 'carousel'
          ? 'carousel→photo'
          : null;
      if (fallback) hopLog('facebook-poster→graph', 'info', `Media fallback (${fallback}): ${path.basename(fullPhotoPath)}`);
      else hopLog('facebook-poster→graph', 'info', `Uploading photo: ${path.basename(fullPhotoPath)}`);
      return { id: await graphPostPhoto(fullPhotoPath, caption, scheduleUnix), media: 'photo', fallback };
    }
    const t = (post.type || '').toLowerCase();
    const fallback = isMotionType(post.type)
      ? 'video→text'
      : t === 'carousel'
        ? 'carousel→text'
        : post.photo_file
          ? 'photo→text'
          : null;
    if (post.photo_file) hopLog('facebook-poster→graph', 'warn', `Photo not found: ${post.photo_file} — posting as text`);
    return { id: await graphPostText(caption, scheduleUnix), media: 'text', fallback };
  });
}

// ---------------------------------------------------------------------------
// Gemini video generation
// ---------------------------------------------------------------------------

// ffmpeg drawtext values must have :, \, ', % escaped.
function ffmpegEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

export function addBrandedEndCard(rawPath, finalPath) {
  if (!HAS_FFMPEG) {
    fs.renameSync(rawPath, finalPath);
    return;
  }
  const cardSrc = fs.existsSync(ENDCARD_PATH) ? ENDCARD_PATH : LOGO_PATH;
  if (!fs.existsSync(cardSrc)) {
    fs.renameSync(rawPath, finalPath);
    return;
  }
  try {
    const probeOut = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', rawPath,
    ], { encoding: 'utf8', timeout: 15000 });
    const stream = JSON.parse(probeOut).streams?.[0] || {};
    const W = stream.width || 720;
    const H = stream.height || 1280;
    const [fpsN, fpsD] = (stream.r_frame_rate || '24/1').split('/').map(Number);
    const fps = Math.round(fpsN / fpsD) || 24;

    // Overlay brand + both phone lines on the end card via drawtext so every
    // reel ends with the correct name and numbers, even if the video model
    // garbled a shirt logo mid-clip. Font path is configurable (GRIZZLY_ENDCARD_FONT).
    const fontExists = fs.existsSync(ENDCARD_FONT.replace(/\\:/g, ':'));
    const phoneFontSize = Math.max(28, Math.round(H / 22));
    const nameFontSize = Math.max(22, Math.round(H / 30));
    // Longest line ("Text ... for a free quote") gets its own smaller size so it
    // keeps a side margin at 720px width instead of running edge-to-edge.
    const textLineFontSize = Math.max(20, Math.round(H / 36));
    const shadow = 'shadowcolor=black@0.9:shadowx=3:shadowy=3';
    const textFilter = fontExists
      ? `,drawtext=fontfile='${ENDCARD_FONT}':text='${ffmpegEscape(BRAND_NAME)}':fontcolor=white:fontsize=${nameFontSize}:x=(w-text_w)/2:y=h*0.70:${shadow}`
        + `,drawtext=fontfile='${ENDCARD_FONT}':text='${ffmpegEscape(`Call ${BRAND_PHONE}`)}':fontcolor=white:fontsize=${phoneFontSize}:x=(w-text_w)/2:y=h*0.78:${shadow}`
        + `,drawtext=fontfile='${ENDCARD_FONT}':text='${ffmpegEscape(`Text ${BRAND_TEXT_LINE} for a free quote`)}':fontcolor=white:fontsize=${textLineFontSize}:x=(w-text_w)/2:y=h*0.86:${shadow}`
      : '';

    // Detect whether the raw video has an audio track. Grok Imagine and Veo 3
    // can both produce synced audio; if present we keep it on the main clip
    // and pad silence over the still end card so the concat aligns.
    let hasAudio = false;
    try {
      const audioProbe = execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type', '-of', 'json', rawPath,
      ], { encoding: 'utf8', timeout: 15000 });
      hasAudio = !!JSON.parse(audioProbe).streams?.[0];
    } catch { /* no audio stream */ }

    const cardChain = `[1:v]scale=${W}:-1,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}${textFilter}[card]`;
    if (hasAudio) {
      execFileSync('ffmpeg', [
        '-y',
        '-i', rawPath,
        '-loop', '1', '-t', '3', '-i', cardSrc,
        '-f', 'lavfi', '-t', '3', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-filter_complex', [
          cardChain,
          `[0:v]setsar=1[main]`,
          `[main][0:a][card][2:a]concat=n=2:v=1:a=1[out][outa]`,
        ].join(';'),
        '-map', '[out]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '128k',
        finalPath,
      ], { timeout: 120000 });
    } else {
      execFileSync('ffmpeg', [
        '-y', '-i', rawPath, '-loop', '1', '-t', '3', '-i', cardSrc,
        '-filter_complex', [
          cardChain,
          `[0:v]setsar=1[main]`,
          `[main][card]concat=n=2:v=1:a=0[out]`,
        ].join(';'),
        '-map', '[out]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-an', finalPath,
      ], { timeout: 120000 });
    }
    fs.unlinkSync(rawPath);
  } catch (e) {
    hopLog('facebook-poster→ffmpeg', 'warn', `end card failed (${e.message.slice(0, 120)}) — using raw video`);
    if (fs.existsSync(rawPath)) fs.renameSync(rawPath, finalPath);
  }
}

// Strip brand tokens and phone-shaped numbers before handing the prompt to
// the video model. Even with strict "no on-screen text" instructions, video
// models will happily hallucinate a shirt logo or fake CTA card if the
// prompt names the business or contains anything that looks like a number to
// stamp on a sign. Defense in depth on top of the system prompt.
function sanitizeVideoPrompt(prompt) {
  if (!prompt) return prompt;
  return prompt
    .replace(/\bGrizzly\s+Electrical(?:\s+Solutions)?\b/gi, 'a residential electrician')
    .replace(/\bGrizzly\b/gi, 'the electrician')
    .replace(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, '')
    .replace(/\b1?-?\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function generateVideoViaBackend(prompt, outputPath, { brand = true, referenceImage = null } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rawPath = brand ? outputPath.replace(/\.mp4$/, '-raw.mp4') : outputPath;
  const cleanPrompt = sanitizeVideoPrompt(prompt);
  hopLog('facebook-poster→' + VIDEO_BACKEND, 'info', `Video prompt (sanitized, ${cleanPrompt.length} chars): ${cleanPrompt.slice(0, 100)}...`);

  const backendArgs = ['--prompt', cleanPrompt, '--output', rawPath];
  if (referenceImage && fs.existsSync(referenceImage)) {
    backendArgs.push('--image', referenceImage);
    hopLog('facebook-poster→' + VIDEO_BACKEND, 'info', `Using image-to-video mode with reference: ${path.basename(referenceImage)}`);
  }
  // Pass aspect-ratio and duration explicitly (Facebook Reels standard)
  backendArgs.push('--aspect-ratio', '9:16', '--duration', '8');

  const out = execFileSync('node', [VIDEO_GEN_SCRIPT, ...backendArgs], {
    timeout: VIDEO_GEN_TIMEOUT_MS,
    encoding: 'utf8',
  });
  const lastLine = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
  if (!lastLine) throw new Error(`No JSON output from ${VIDEO_BACKEND}-video-generator`);
  const result = JSON.parse(lastLine);
  if (result.status !== 'success') throw new Error(`Video gen failed (${VIDEO_BACKEND}): ${result.message}`);
  if (brand) {
    hopLog('facebook-poster→ffmpeg', 'info', 'Post-processing: enhance + branded end card with fade...');
    try {
      postProcessVideo(rawPath, outputPath, {
        cardPath: ENDCARD_PATH,
        overlays: { brandName: BRAND_NAME, brandPhone: BRAND_PHONE, textLine: BRAND_TEXT_LINE, fontPath: ENDCARD_FONT },
        trim: true,
        denoise: true,
        sharpen: true,
        grain: true,
      });
    } catch (e) {
      hopLog('facebook-poster→ffmpeg', 'warn', `post-processing failed (${e.message.slice(0, 120)}) — falling back to legacy end card`);
      addBrandedEndCard(rawPath, outputPath);
    }
  }
  return outputPath;
}

// Back-compat alias — existing call sites keep working while the backend
// selection now lives inside generateVideoViaBackend.
const generateGeminiVideo = generateVideoViaBackend;

/**
 * Validate a generated video's resolution, duration, and file size.
 * Returns { ok, ...details } — does NOT throw; callers decide how to handle.
 */
function validateVideo(videoPath) {
  if (!fs.existsSync(videoPath)) return { ok: false, reason: 'file missing' };
  const stats = fs.statSync(videoPath);
  if (stats.size < 100_000) return { ok: false, reason: `file too small (${stats.size} bytes)` };
  try {
    const probe = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration',
      '-of', 'json', videoPath,
    ], { encoding: 'utf8', timeout: 15000 });
    const s = JSON.parse(probe).streams?.[0] || {};
    const width = parseInt(s.width) || 0;
    const height = parseInt(s.height) || 0;
    const duration = parseFloat(s.duration) || 0;
    if (width < 720 || height < 1280) return { ok: false, reason: `low resolution ${width}x${height}` };
    if (duration < 5) return { ok: false, reason: `too short (${duration}s)` };
    return { ok: true, width, height, duration, sizeBytes: stats.size };
  } catch (e) {
    return { ok: false, reason: `ffprobe failed: ${e.message}` };
  }
}

/**
 * Map a post's service type to a reference image file for I2V generation.
 * Looks in assets/reference-images/ (or GRIZZLY_REFERENCE_IMAGES env var).
 * Returns the first matching file path, or null if none found.
 */
const REFERENCE_IMAGE_DIR = process.env.GRIZZLY_REFERENCE_IMAGES
  || path.join(PROJECT_ROOT, 'assets', 'reference-images');

function resolveReferenceImage(post) {
  if (!fs.existsSync(REFERENCE_IMAGE_DIR)) return null;
  const slug = (post.service || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return null;

  // Exact match candidates (full slug, date-based)
  const candidates = [
    path.join(REFERENCE_IMAGE_DIR, `${slug}.jpg`),
    path.join(REFERENCE_IMAGE_DIR, `${slug}.png`),
  ];
  if (post.date) {
    candidates.push(path.join(REFERENCE_IMAGE_DIR, `${post.date}.jpg`));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Prefix-fallback: the crew writes verbose service names like
  // "Generator Inlet & Interlock Installation" → slug "generator-inlet-interlock-installation".
  // Reference images use short slugs like "generator". Split the slug on hyphens
  // and try progressively shorter prefixes until we find a match.
  const segments = slug.split('-');
  for (let i = 0; i < segments.length; i++) {
    const prefix = segments.slice(0, segments.length - i).join('-');
    if (!prefix) continue;
    const jpg = path.join(REFERENCE_IMAGE_DIR, `${prefix}.jpg`);
    const png = path.join(REFERENCE_IMAGE_DIR, `${prefix}.png`);
    if (fs.existsSync(jpg)) return jpg;
    if (fs.existsSync(png)) return png;
  }

  // Last resort: return ANY available reference image. An anchored
  // electrical photo is orders of magnitude better than pure T2V with
  // zero visual grounding — it prevents the model from hallucinating
  // extra limbs and morphing objects.
  try {
    const anyImage = fs.readdirSync(REFERENCE_IMAGE_DIR)
      .find(f => /\.(jpe?g|png|webp)$/i.test(f));
    if (anyImage) return path.join(REFERENCE_IMAGE_DIR, anyImage);
  } catch { /* dir not readable */ }

  return null;
}

export async function generateCinematicPrompt(post) {
  // The schedule's VIDEO_PROMPT (written by the weekly crew) is used as a
  // scene idea, never verbatim — those prompts are tame single-shot
  // descriptions and often name the brand. The director rewrite below
  // enforces the research-backed single-shot, static-camera formula.
  if (!XAI_API_KEY) {
    hopLog('facebook-poster→xai', 'warn', 'No XAI_API_KEY — falling back to schedule prompt as-is.');
    return post.video_prompt || null;
  }
  const caption = buildCaption(post);
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify({
      model: 'grok-4.20-0309-non-reasoning', max_tokens: 280,
      messages: [
        { role: 'system', content: `You are a video director writing generation prompts for short vertical Facebook Reels (9:16, ~8 seconds) for a licensed residential and commercial electrician in DFW, Texas.

Write a single vivid prompt (80-120 words) using the five-part formula:
[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]

CRITICAL RULES for AI video quality:
- SINGLE SHOT ONLY: one continuous take, no cuts, no scene changes
- STATIC or SLOW camera: "static shot", "slow dolly-in", "slow pan" only
- NEVER use: whip pan, crash zoom, hard push-in, handheld, rapid cuts
- NO HANDS, NO FACES, NO PEOPLE — AI video models cannot render human anatomy
  without severe artifacts (extra fingers, melting limbs, morphing skin)
- Use TOOL-ONLY POV: show the work through tool movement, mechanical action,
  indicators lighting up, breakers flipping, wires connecting — as if the
  camera IS the person doing the work. Never describe hands or bodies.
- Describe spatial relationships explicitly to prevent morphing
- Keep the scene simple: fewer objects = fewer artifacts
- Specify "consistent lighting" and "smooth continuous motion"
- Describe diegetic AUDIO (electrical hum, breaker thunk, tools) but no dialogue

DRAMA through the problem, not editing:
- Show a sparking outlet, a scorched wire, a tripped breaker — in ONE sustained shot
- The drama comes from what's IN the frame, not from cutting between frames

STRICT — NO readable text of any kind in the video:
- Do NOT name the business, owner, city, or phone number
- Do NOT ask for logos, signs, captions, or on-screen text
- Wardrobe: plain solid-color work polo, no visible writing
- Any incidental signs must be unreadable or out of focus

Ends with: Photorealistic, cinematic, 4K, consistent lighting, smooth continuous motion, plain unbranded wardrobe, absolutely no visible text or numbers anywhere in frame.

Output the prompt only. No explanation, no quotes, no title.` },
        { role: 'user', content: `Service: ${post.service}\nHook: ${post.hook}\nCaption:\n${caption}${post.video_prompt ? `\n\nScene idea from the content planner (rewrite it — do not copy it):\n${post.video_prompt}` : ''}` },
      ],
    }),
  });
  const json = await res.json();
  if (json.error) {
    hopLog('facebook-poster→xai', 'warn', `prompt gen error: ${json.error.message} — using schedule prompt`);
    return post.video_prompt || null;
  }
  let prompt = json.choices?.[0]?.message?.content?.trim() || post.video_prompt || null;
  // The model sometimes drops the required style/no-text tail — enforce it ourselves.
  if (prompt && !/no visible text/i.test(prompt)) {
    prompt += ' Photorealistic, cinematic, 4K, consistent lighting, smooth continuous motion, plain unbranded wardrobe, absolutely no visible text or numbers anywhere in frame.';
  }
  return prompt;
}

let geminiCreditsDepletedFlag = false;

async function generateAllVideos(posts) {
  const videoPosts = posts.filter(p => p.type === 'video');
  if (!videoPosts.length) return;

  // Pre-flight: test Gemini availability with a tiny request before committing to
  // the full generation loop. If credits are depleted, skip all videos upfront
  // instead of letting each one fail individually (13 min timeout each).
  // Only relevant when the Gemini backend is actually selected — Grok Imagine
  // has its own error surface and doesn't need this quota probe.
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (VIDEO_BACKEND === 'gemini' && GEMINI_API_KEY) {
    try {
      const checkRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}`
      );
      const checkJson = await checkRes.json();
      if (checkJson.error?.status === 'RESOURCE_EXHAUSTED' || checkJson.error?.code === 429) {
        hopLog('facebook-poster→gemini', 'warn', 'GEMINI PRE-FLIGHT: Credits depleted — skipping all video generation');
        geminiCreditsDepletedFlag = true;
        return;
      }
    } catch (e) {
      hopLog('facebook-poster→gemini', 'warn', `Gemini pre-flight check failed (${e.message}) — will attempt videos anyway`);
    }
  }

  hopLog('facebook-poster', 'info', `Generating ${videoPosts.length} videos upfront...`);
  for (const post of videoPosts) {
    const videoPath = resolveVideoPath(post);
    if (fs.existsSync(videoPath)) {
      hopLog('facebook-poster', 'info', `Day ${post.day}: reusing ${path.basename(videoPath)}`);
      continue;
    }
    try {
      const prompt = await generateCinematicPrompt(post);
      if (!prompt) {
        hopLog('facebook-poster', 'warn', `Day ${post.day}: no video prompt — will post without video`);
        continue;
      }
      const referenceImage = resolveReferenceImage(post);
      generateGeminiVideo(prompt, videoPath, { referenceImage });

      // Quality validation — log results but don't block (fallback chain handles it)
      const validation = validateVideo(videoPath);
      if (validation.ok) {
        hopLog('facebook-poster', 'info',
          `Day ${post.day}: video validated OK — ${validation.width}x${validation.height}, ${validation.duration.toFixed(1)}s, ${(validation.sizeBytes / 1e6).toFixed(1)} MB`);
      } else {
        hopLog('facebook-poster', 'warn', `Day ${post.day}: video validation FAILED — ${validation.reason}`);
      }

      hopLog('facebook-poster', 'info', `Day ${post.day}: saved ${path.basename(videoPath)}`);
    } catch (e) {
      const errText = (e.stderr ? e.stderr.toString() : '') + e.message;
      if (/prepayment credits|credits are depleted|RESOURCE_EXHAUSTED/.test(errText)) {
        geminiCreditsDepletedFlag = true;
        hopLog('facebook-poster→gemini', 'warn', `Day ${post.day}: GEMINI CREDITS DEPLETED — will post without video.`);
      } else {
        hopLog('facebook-poster→gemini', 'warn', `Day ${post.day}: video generation failed (${e.message.slice(0, 120)}) — will post without video`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Playwright fallback (only when FB_USE_PLAYWRIGHT=1)
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

async function saveDebug(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const p = path.join(DEBUG_DIR, `fb-${label}-${stamp}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

async function assertLoggedIn(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  if (/login|checkpoint|recover/i.test(page.url())) {
    throw new Error('Facebook session expired. Re-run: node facebook-poster.mjs --auth');
  }
}

async function switchToPageProfile(page) {
  const switchBtn = page.locator(
    'div[role="button"]:has-text("Switch now"), span:has-text("Switch now"), a:has-text("Switch now"), div[role="button"]:has-text("Switch profiles"), span:has-text("Switch profiles")'
  ).first();
  if (await switchBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await switchBtn.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    hopLog('facebook-poster→playwright', 'info', 'Switched to Grizzly profile.');
    return true;
  }
  return false;
}

async function openPostComposer(page) {
  if (!FB_PAGE_URL) throw new Error('FB_PAGE_URL or FB_PAGE_ID must be set in .env');
  await page.goto(FB_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await assertLoggedIn(page);
  await switchToPageProfile(page);
  const composerSelectors = [
    '[aria-label="Create post"]',
    '[aria-label="Write something..."]',
    'div[role="button"]:has-text("Create post")',
    'div[role="button"]:has-text("Write something")',
    'div[role="button"]:has-text("What\'s on your mind")',
  ];
  for (const sel of composerSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { await el.click({ timeout: 5000 }); break; }
  }
  await page.waitForTimeout(1500);
}

async function typeCaption(page, caption) {
  const dialog = page.locator('div[role="dialog"]:not([aria-label="Notifications"])').first();
  await dialog.waitFor({ timeout: 10000 });
  const textarea = dialog.locator('div[contenteditable="true"]').first();
  await textarea.waitFor({ timeout: 10000 });
  await textarea.click({ timeout: 5000 });
  await page.waitForTimeout(300);
  await page.evaluate((text) => {
    const d = document.querySelector('div[role="dialog"]');
    const el = d ? d.querySelector('div[contenteditable="true"]') : null;
    if (el) { el.focus(); document.execCommand('insertText', false, text); }
  }, caption);
  await page.waitForTimeout(500);
  const typed = await textarea.innerText().catch(() => '');
  if (!typed.includes(caption.slice(0, 20))) await textarea.type(caption, { delay: 10 });
}

async function attachMedia(page, post, videoPath) {
  const dialog = page.locator('div[role="dialog"]:not([aria-label="Notifications"])').first();
  const attachFile = async (filePath) => {
    const btn = dialog.locator('[aria-label="Photo/video"], [aria-label="Add photos or videos"]').first();
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      btn.click({ timeout: 5000 }),
    ]);
    await fileChooser.setFiles(filePath);
  };
  if (post.type === 'video' && videoPath && fs.existsSync(videoPath)) {
    await attachFile(videoPath);
    hopLog('facebook-poster→playwright', 'info', 'Waiting for video to upload...');
    await page.waitForTimeout(30000);
  } else {
    const fullPhotoPath = resolvePhotoPath(post);
    if (post.type === 'video' && fullPhotoPath) {
      hopLog('facebook-poster→playwright', 'info', `Video unavailable — falling back to photo: ${path.basename(fullPhotoPath)}`);
      await attachFile(fullPhotoPath);
      await page.waitForTimeout(3000);
    } else if (fullPhotoPath) {
      await attachFile(fullPhotoPath);
      await page.waitForTimeout(3000);
    } else if (post.photo_file) {
      hopLog('facebook-poster→playwright', 'warn', `photo not found: ${post.photo_file} — posting as text`);
    }
  }
}

async function dismissPopups(page) {
  const dismissSelectors = [
    'div[role="button"]:text-is("Not now")', 'div[role="button"]:text-is("Close")',
    'div[role="button"]:text-is("Dismiss")', 'div[role="button"]:text-is("Got it")', '[aria-label="Close"]',
  ];
  for (const sel of dismissSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  await page.waitForTimeout(300);
}

async function jsClickButton(page, text) {
  return page.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('[role="button"], button'));
    const btn = all.find(b => b.textContent.trim() === t);
    if (btn) { btn.scrollIntoView(); btn.click(); return true; }
    return false;
  }, text);
}

async function clickNextOrPost(page) {
  await dismissPopups(page);
  await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]:not([aria-label="Notifications"])');
    if (dialog) dialog.scrollTop = dialog.scrollHeight;
    const inner = dialog && dialog.querySelector('div[style*="overflow"], div[class*="scroll"]');
    if (inner) inner.scrollTop = inner.scrollHeight;
  });
  await page.waitForTimeout(500);
  const clicked = await jsClickButton(page, 'Next');
  if (clicked) { await page.waitForTimeout(2000); return 'next'; }
  return 'post';
}

async function submitPost(page, caption) {
  const mode = await clickNextOrPost(page);
  if (mode === 'next') {
    const editReelTitle = page.locator('h2:has-text("Edit reel"), div:has-text("Edit reel")').first();
    if (await editReelTitle.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (caption) {
        const titleInput = page.locator('input[placeholder*="title" i], textarea[placeholder*="title" i], input[aria-label*="title" i]').first();
        if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) await titleInput.fill(caption.slice(0, 255));
      }
      await page.waitForTimeout(500);
      const nextBtns = page.getByRole('button', { name: 'Next', exact: true });
      if (await nextBtns.count() > 0) await nextBtns.last().click({ force: true, timeout: 5000 });
      else await page.mouse.click(90, 405);
      await page.waitForTimeout(2000);
    }
    const published = await jsClickButton(page, 'Share now')
      || await jsClickButton(page, 'Publish now') || await jsClickButton(page, 'Publish')
      || await jsClickButton(page, 'Post now') || await jsClickButton(page, 'Post');
    if (!published) throw new Error('Could not find publish button on publishing screen');
  } else {
    if (!await jsClickButton(page, 'Post')) throw new Error('Could not find Post button in composer');
  }
  await page.waitForTimeout(5000);
}

async function schedulePost(page, scheduleDate, scheduleTime, caption) {
  const mode = await clickNextOrPost(page);
  if (mode === 'next') {
    if (caption) {
      const captionInput = page.locator('div[contenteditable="true"], textarea').first();
      if (await captionInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await captionInput.click().catch(() => {});
        await page.evaluate((text) => {
          const el = document.querySelector('div[contenteditable="true"], textarea');
          if (el) { el.focus(); document.execCommand('insertText', false, text); }
        }, caption);
        await page.waitForTimeout(500);
      }
    }
    const scheduleOpt = page.locator('div[role="button"]:has-text("Schedule"), label:has-text("Schedule"), span:has-text("Schedule for later")').first();
    if (await scheduleOpt.isVisible({ timeout: 3000 }).catch(() => false)) { await scheduleOpt.click({ timeout: 5000 }); await page.waitForTimeout(1000); }
  } else {
    const dialog = page.locator('div[role="dialog"]:not([aria-label="Notifications"])').first();
    const nextBtn = dialog.locator('div[role="button"]:text-is("Next"), button:text-is("Next")').first();
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) { await nextBtn.click({ timeout: 10000 }); await page.waitForTimeout(2000); }
    for (const sel of ['label:has-text("Schedule")', 'div[role="button"]:has-text("Schedule post")', 'span:has-text("Schedule post")', 'div[role="radio"]:has-text("Schedule")']) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { await el.click({ timeout: 5000 }); await page.waitForTimeout(1000); break; }
    }
  }
  const dateInput = page.locator('input[type="date"], input[placeholder*="date" i], input[aria-label*="date" i]').first();
  if (await dateInput.isVisible({ timeout: 5000 }).catch(() => false)) { await dateInput.fill(scheduleDate); await page.waitForTimeout(500); }
  const timeInput = page.locator('input[type="time"], input[placeholder*="time" i], input[aria-label*="time" i]').first();
  if (await timeInput.isVisible({ timeout: 3000 }).catch(() => false)) { await timeInput.fill(scheduleTime); await page.waitForTimeout(500); }
  for (const sel of ['div[role="button"]:text-is("Schedule")', 'button:text-is("Schedule")', 'div[role="button"]:text-is("Schedule post")', 'div[role="button"]:text-is("Save")']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) { await el.click({ timeout: 10000 }); break; }
  }
  await Promise.race([
    page.locator('div[role="dialog"]').waitFor({ state: 'hidden', timeout: 30000 }),
    page.waitForNavigation({ timeout: 30000 }),
  ]).catch(() => {});
  await page.waitForTimeout(2000);
}

async function withPlaywrightPage(fn) {
  const { chromium } = await importPlaywright();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, viewport: VIEWPORT });
  const page = await context.newPage();
  try { return await fn(page); }
  finally { await context.close(); }
}

// ---------------------------------------------------------------------------
// Mode: --auth (Playwright login)
// ---------------------------------------------------------------------------

async function runAuth() {
  const { chromium } = await importPlaywright();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, viewport: VIEWPORT,
    args: ['--start-maximized'], ignoreDefaultArgs: ['--window-size'],
  });
  const page = await context.newPage();
  console.error('AUTH MODE: Log into Facebook (complete 2FA if needed), then close the window.');
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await context.close();
  return { status: 'auth_complete', session_dir: USER_DATA_DIR };
}

// ---------------------------------------------------------------------------
// Mode: --check-token (Fix 4 standalone)
// ---------------------------------------------------------------------------

async function runCheckToken() {
  const status = await checkFacebookToken();
  hopLog('facebook-poster→graph', status.level, status.message);
  return { status: status.ok ? 'ok' : (status.expired ? 'expired' : 'warning'), token: status };
}

// ---------------------------------------------------------------------------
// Mode: single payload post (dashboard action queue)
// ---------------------------------------------------------------------------

async function runSinglePayload(args) {
  const payload = JSON.parse(args.payloadText);
  const action = payload.action || {};
  const post = action.post || {};
  const live = Boolean(payload.live) && !args.dryRun;
  const type = (post.type || 'text').toLowerCase();
  post.type = type;
  const caption = buildCaption(post);

  if (!live) {
    return {
      status: 'dry_run', adapter: 'facebook-poster', action_id: action.id || null, post_type: type,
      date: post.date || post.day || null, headline: post.headline || null,
      caption_preview: caption.slice(0, 200) + (caption.length > 200 ? '...' : ''),
      via: USE_PLAYWRIGHT ? 'playwright' : 'graph', message: 'Dry run — no API call made',
    };
  }

  // Resolve motion media (slideshow by default; AI only when FB_MEDIA_MODE=ai).
  let videoPath = post.video_file || null;
  if (isMotionType(type) && !videoPath) {
    if (wantsSlideshow(post)) {
      videoPath = resolveSlideshowPath(post);
      if (!fs.existsSync(videoPath)) {
        const photos = resolveSlideshowPhotos(post);
        if (photos.length) {
          try {
            const textItems = parseOnScreenText(post.on_screen_text);
            if (!textItems.length && post.hook) {
              textItems.push({ start: 0, end: 3, text: String(post.hook).slice(0, 80) });
            }
            const result = buildSlideshowReel({
              photos,
              textItems,
              outPath: videoPath,
              workDir: VIDEO_OUTPUT_DIR,
            });
            if (result.status !== 'success') videoPath = null;
            else hopLog('facebook-poster', 'info',
              `Slideshow ready (${result.photos} photos): ${path.basename(videoPath)}`);
          } catch (e) {
            hopLog('facebook-poster', 'warn',
              `slideshow failed (${e.message.slice(0, 120)}) — photo/text fallback`);
            videoPath = null;
          }
        } else {
          videoPath = null;
        }
      }
      if (videoPath && fs.existsSync(videoPath)) post.type = 'video';
    } else {
      videoPath = resolveVideoPath(post);
      if (!fs.existsSync(videoPath)) {
        const prompt = await generateCinematicPrompt(post);
        if (!prompt) throw new Error('video_prompt or video_file required for video posts (no XAI_API_KEY to generate one)');
        hopLog('facebook-poster', 'info', `Generating video via ${VIDEO_BACKEND}: ${prompt.slice(0, 80)}...`);
        try {
          const referenceImage = resolveReferenceImage(post);
          generateGeminiVideo(prompt, videoPath, { referenceImage });
        } catch (e) {
          hopLog('facebook-poster→gemini', 'warn', `video generation failed (${e.message.slice(0, 120)}) — will fall back to photo/text`);
          videoPath = null;
        }
      }
    }
  }

  let postId = null;
  let postFallback = null;
  let via;
  if (USE_PLAYWRIGHT) {
    via = 'playwright';
    await withPlaywrightPage(async (page) => {
      await openPostComposer(page);
      await typeCaption(page, caption);
      await attachMedia(page, post, videoPath);
      await submitPost(page, caption);
    });
  } else {
    via = 'graph';
    if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
      throw new Error('FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN must be set in .env (or set FB_USE_PLAYWRIGHT=1)');
    }
    ({ id: postId, fallback: postFallback } = await graphDispatch(post, caption, videoPath, null));
    if (postFallback) hopLog('facebook-poster→graph', 'warn', `FALLBACK: ${postFallback}`);
    // Always stamp contact first-comment on live Graph posts (do not gate on
        // schedule CONTACT — empty/missing CONTACT previously skipped this entirely).
        if (postId) {
          const isVideo = (post.type || '').toLowerCase() === 'video';
          const fc = await postFirstComment(postId, FIRST_COMMENT, {
            retries: isVideo ? 5 : 3,
            initialDelayMs: isVideo ? 5000 : 1500,
          });
          if (!fc.ok) {
            hopLog('facebook-poster→graph', 'warn', `First comment failed for ${postId}: ${fc.error}`);
          }
        }
    if (postId) trackPostEngagement(postId, post.post_goal, post.day);
  }

  // Log CTA type for analytics
  const ctaType = classifyCta(post.cta || '');
  hopLog('facebook-poster', 'info', `Single payload CTA type = ${ctaType}, goal = ${post.post_goal || 'unspecified'}`);

  return {
    status: 'success', adapter: 'facebook-poster', via, action_id: action.id || null, post_type: type,
    post_id: postId, date: post.date || post.day || null, headline: post.headline || null,
    fb_post_url: postId ? `https://www.facebook.com/${String(postId).replace('_', '/posts/')}` : null,
    fallback: postFallback,
  };
}

// ---------------------------------------------------------------------------
// Mode: whole-week schedule (mav-bridge)
// ---------------------------------------------------------------------------

async function runWeek(args) {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    throw new Error(`Schedule file not found: ${SCHEDULE_FILE}\nRun: seo-agents facebook-schedule`);
  }
  const posts = parseSchedule(SCHEDULE_FILE).filter(p => p.day >= args.startDay && p.day <= args.endDay);
  if (!posts.length) throw new Error('No posts found in schedule file.');

  hopLog('facebook-poster', 'info', `Loaded ${posts.length} posts from schedule (starting day ${args.startDay})`);
  // Log CTA types for analytics correlation
  for (const post of posts) {
    const ctaType = classifyCta(post.cta || '');
    hopLog('facebook-poster', 'info', `Day ${post.day}: CTA type = ${ctaType}, goal = ${post.post_goal || 'unspecified'}`);
  }
  if (posts.length === 0) {
    hopLog('facebook-poster', 'error', 'No posts found in schedule — aborting');
    process.exit(1);
  }

  if (args.dryRun) {
    return {
      status: 'dry_run',
      via: USE_PLAYWRIGHT ? 'playwright' : 'graph',
      posts: posts.map(p => ({
        day: p.day, date: p.date, type: p.type, service: p.service,
        action: p.day === 1 && !args.scheduleAll ? 'post_now' : `schedule_${p.date}_${args.postTime}`,
        video_ready: p.type === 'video' ? fs.existsSync(resolveVideoPath(p)) : null,
      })),
    };
  }

  await prepareMotionMedia(posts);

  const results = [];
  const nowUnix = Math.floor(Date.now() / 1000);

  if (USE_PLAYWRIGHT) {
    hopLog('facebook-poster→playwright', 'info', 'FB_USE_PLAYWRIGHT=1 — using browser automation');
    await withPlaywrightPage(async (page) => {
      for (const post of posts) {
        const caption = buildCaption(post);
        const rawScheduleUnix = dateTimeToUnix(post.date, args.postTime);
        const isLive = (post.day === 1 && !args.scheduleAll) || rawScheduleUnix < nowUnix + 600;
        try {
          await openPostComposer(page);
          await typeCaption(page, caption);
          await attachMedia(page, post, post._videoPath || null);
          if (isLive) {
            await submitPost(page, caption);
            results.push({ day: post.day, date: post.date, status: 'posted', type: post.type });
          } else {
            await schedulePost(page, post.date, args.postTime, caption);
            results.push({ day: post.day, date: post.date, status: 'scheduled', scheduled_time: `${post.date} ${args.postTime}`, type: post.type });
          }
        } catch (e) {
          const screenshot = await saveDebug(page, `day${post.day}-failure`);
          results.push({ day: post.day, date: post.date, status: 'error', message: e.message, screenshot });
          hopLog('facebook-poster→playwright', 'error', `Day ${post.day} failed: ${e.message}`);
        }
        await page.waitForTimeout(2000);
      }
    });
  } else {
    if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
      throw new Error('FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN must be set in .env (or set FB_USE_PLAYWRIGHT=1)');
    }
    hopLog('facebook-poster→graph', 'info', 'Using Graph API (no browser)');
    for (const post of posts) {
      const caption = buildCaption(post);
      const rawScheduleUnix = dateTimeToUnix(post.date, args.postTime);
      const isLive = (post.day === 1 && !args.scheduleAll) || rawScheduleUnix < nowUnix + 600;
      const scheduleUnix = isLive ? null : rawScheduleUnix;
      try {
        const { id, media, fallback } = await graphDispatch(post, caption, post._videoPath || null, scheduleUnix);
        // Only post the first comment on live posts — for scheduled posts,
                // the comment is posted later by mav-bridge's fb-reconcile when the
                // post actually goes live (Facebook rejects comments on unpublished posts).
                // Never gate on schedule CONTACT; fixed FIRST_COMMENT is always the copy.
                if (id && isLive) {
                  const isVideo = isMotionType(post.type) || media === 'video';
                  const fc = await postFirstComment(id, FIRST_COMMENT, {
                    retries: isVideo ? 5 : 3,
                    initialDelayMs: isVideo ? 5000 : 1500,
                  });
                  if (!fc.ok) {
                    hopLog('facebook-poster→graph', 'warn', `First comment failed for ${id}: ${fc.error}`);
                  }
                } else if (id && !isLive) {
                  // Graph rejects comments on unpublished scheduled posts. Queue
                  // locally so --backfill-comments / daily drain can stamp them
                  // even when Supabase reconcile never saw these IDs (manual runs).
                  queuePendingFirstComment(id, {
                    day: post.day,
                    date: post.date,
                    type: post.type,
                    media,
                  });
                }
        if (isLive) {
          results.push({ day: post.day, date: post.date, status: 'posted', type: post.type, media, id, fallback });
          hopLog('facebook-poster→graph', 'info', `Day ${post.day} posted live (id: ${id}, media: ${media})`);
          trackPostEngagement(id, post.post_goal, post.day);
        } else {
          results.push({ day: post.day, date: post.date, status: 'scheduled', scheduled_time: `${post.date} ${args.postTime}`, type: post.type, media, id, fallback });
          hopLog('facebook-poster→graph', 'info', `Day ${post.day} scheduled for ${post.date} ${args.postTime} (id: ${id}, media: ${media})`);
        }
        if (fallback) hopLog('facebook-poster→graph', 'warn', `Day ${post.day} FALLBACK: ${fallback}`);
      } catch (e) {
        results.push({ day: post.day, date: post.date, status: 'error', message: e.message });
        hopLog('facebook-poster→graph', 'error', `Day ${post.day} failed: ${e.message}`);
      }
    }
  }

  const output = { status: 'complete', results };
  if (geminiCreditsDepletedFlag) output.gemini_credits_depleted = true;
  return output;
}

// ---------------------------------------------------------------------------
// Arg parsing + dispatch
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    payloadText: '', dryRun: false, auth: false, checkToken: false,
    scheduleAll: false, postTime: '09:00', startDay: 1, endDay: 999,
    backfillComments: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--payload') args.payloadText = argv[++i] || '';
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--auth') args.auth = true;
    else if (argv[i] === '--check-token') args.checkToken = true;
    else if (argv[i] === '--schedule-all') args.scheduleAll = true;
    else if (argv[i] === '--backfill-comments') args.backfillComments = true;
    else if (argv[i] === '--time') args.postTime = argv[++i] || '09:00';
    else if (argv[i] === '--start-day') args.startDay = parseInt(argv[++i] || '1');
    else if (argv[i] === '--end-day') args.endDay = parseInt(argv[++i] || '999');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.auth) result = await runAuth();
  else if (args.checkToken) result = await runCheckToken();
  else if (args.backfillComments) {
    const drained = await drainPendingFirstComments();
    result = { status: 'ok', action: 'backfill-comments', results: drained };
  }
  else if (args.payloadText) result = await runSinglePayload(args);
  else result = await runWeek(args);

  // stdout is the machine-readable contract for callers (actions.py / mav-bridge).
  console.log(JSON.stringify(result, null, args.payloadText || args.auth || args.checkToken || args.backfillComments ? 0 : 2));
  if (result.status === 'error' || result.status === 'expired') process.exitCode = 1;
}

// Only run the CLI when invoked directly — allows mav-bridge to import checkFacebookToken().
const invokedDirectly = process.argv[1]
  && pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(__filename)).href;

if (invokedDirectly) {
  main().catch(e => {
    console.log(JSON.stringify({ status: 'error', adapter: 'facebook-poster', message: e.message || String(e) }));
    process.exit(1);
  });
}
