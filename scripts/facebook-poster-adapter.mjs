#!/usr/bin/env node
/**
 * facebook-poster-adapter.mjs
 * Posts to Grizzly's Facebook Business Page via the Graph API.
 * Supports text-only posts, photo posts, and video posts.
 * Video posts optionally generate the clip via Gemini (gemini-video-generator.mjs).
 *
 * Usage:
 *   node facebook-poster-adapter.mjs --payload <json> [--dry-run]
 *
 * Payload shape:
 *   {
 *     "live": true,
 *     "action": {
 *       "id": "fb-post-2026-06-10",
 *       "action_type": "publish_facebook_post",
 *       "post": {
 *         "day": "Monday",
 *         "date": "2026-06-10",
 *         "type": "video",          // text | photo | video
 *         "headline": "Is your panel ready for summer?",
 *         "hook": "Most DFW homeowners don't know this...",
 *         "body": "Full caption text here...",
 *         "hashtags": "#DallasElectrician #GrizzlyElectrical #RowlettTX",
 *         "photo_file": "C:\\path\\to\\photo.jpg",
 *         "video_prompt": "Electrician replacing a circuit breaker panel in a Dallas home, professional work, safety gear",
 *         "cta": "Call us for a free estimate — link in bio.",
 *         "status": "Needs approval"
 *       }
 *     }
 *   }
 *
 * Required env (or .env):
 *   FB_PAGE_ID           — numeric Facebook Page ID
 *   FB_PAGE_ACCESS_TOKEN — long-lived Page Access Token
 *
 * Optional env:
 *   FB_VIDEO_OUTPUT_DIR  — where to save Gemini-generated videos (default: outputs/fb-videos)
 *   GEMINI_VIDEO_GENERATOR — path to gemini-video-generator.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
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

const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
let FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';
const GRAPH_API_VERSION = 'v22.0';
const GRAPH_API_BASE = 'graph.facebook.com';

async function resolvePageToken() {
  // If we already have a Page token, use it as-is
  const debugRes = await new Promise((resolve) => {
    const url = `https://${GRAPH_API_BASE}/${GRAPH_API_VERSION}/debug_token?input_token=${FB_PAGE_ACCESS_TOKEN}&access_token=${FB_PAGE_ACCESS_TOKEN}`;
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
    }).on('error', () => resolve({}));
  });

  if (debugRes.data?.type === 'PAGE') return; // already a page token

  // Exchange user token for page token
  console.error('User token detected — fetching Page Access Token automatically...');
  const pageRes = await graphRequest('GET', FB_PAGE_ID, { fields: 'access_token,name' });
  if (pageRes.error) throw new Error(`Could not fetch Page token: ${pageRes.error.message}`);
  if (!pageRes.access_token) throw new Error('No access_token in page response — ensure pages_manage_posts permission is granted.');
  console.error(`Got Page token for: ${pageRes.name}`);
  FB_PAGE_ACCESS_TOKEN = pageRes.access_token;
}

const VIDEO_OUTPUT_DIR = process.env.FB_VIDEO_OUTPUT_DIR
  || path.join(PROJECT_ROOT, 'outputs', 'fb-videos');

const GEMINI_VIDEO_GEN = process.env.GEMINI_VIDEO_GENERATOR
  || path.join(__dirname, 'gemini-video-generator.mjs');

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { payloadText: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--payload') args.payloadText = argv[++i] || '';
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function graphRequest(method, endpoint, params, body) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, access_token: FB_PAGE_ACCESS_TOKEN });
    const path_ = `/${GRAPH_API_VERSION}/${endpoint}?${qs}`;
    const options = {
      hostname: GRAPH_API_BASE,
      path: path_,
      method,
      headers: {},
    };

    if (body) {
      const encoded = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(encoded);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function graphUploadVideo(videoPath, caption) {
  // Facebook video upload is multipart — use the resumable upload protocol
  // Step 1: initialize upload session
  const fileSize = fs.statSync(videoPath).size;
  const initRes = await graphRequest('POST', `${FB_PAGE_ID}/videos`, {}, {
    upload_phase: 'start',
    file_size: fileSize,
  });
  if (!initRes.data.upload_session_id) {
    throw new Error(`Video upload session init failed: ${JSON.stringify(initRes.data)}`);
  }

  const { upload_session_id, video_id, start_offset } = initRes.data;
  let offset = parseInt(start_offset, 10) || 0;
  const CHUNK_SIZE = 1024 * 1024 * 4; // 4 MB chunks
  const fd = fs.openSync(videoPath, 'r');

  // Step 2: transfer chunks
  while (offset < fileSize) {
    const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize - offset));
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
    const sliced = chunk.slice(0, bytesRead);

    await new Promise((resolve, reject) => {
      const boundary = '----FBUploadBoundary';
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="video_file_chunk"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const multipart = Buffer.concat([header, sliced, footer]);
      const qs = new URLSearchParams({
        upload_phase: 'transfer',
        upload_session_id,
        start_offset: String(offset),
        access_token: FB_PAGE_ACCESS_TOKEN,
      });
      const options = {
        hostname: GRAPH_API_BASE,
        path: `/${GRAPH_API_VERSION}/${FB_PAGE_ID}/videos?${qs}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': multipart.length,
        },
      };
      const req = https.request(options, (res) => {
        const chunks2 = [];
        res.on('data', c => chunks2.push(c));
        res.on('end', () => {
          try {
            const d = JSON.parse(Buffer.concat(chunks2).toString());
            offset = parseInt(d.start_offset, 10);
            resolve(d);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(multipart);
      req.end();
    });
  }
  fs.closeSync(fd);

  // Step 3: finish upload
  const finishRes = await graphRequest('POST', `${FB_PAGE_ID}/videos`, {}, {
    upload_phase: 'finish',
    upload_session_id,
    description: caption,
    published: true,
  });

  return { video_id, finish: finishRes.data };
}

// ---------------------------------------------------------------------------
// Post types
// ---------------------------------------------------------------------------

async function postText(message) {
  const res = await graphRequest('POST', `${FB_PAGE_ID}/feed`, {}, { message });
  if (res.data.error) throw new Error(`Graph API error: ${res.data.error.message}`);
  return { post_id: res.data.id, type: 'text' };
}

async function postPhoto(message, photoPath) {
  // Upload photo to page photos endpoint
  const photoData = fs.readFileSync(photoPath);
  const boundary = '----FBPhotoBoundary';
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${path.basename(photoPath)}"\r\nContent-Type: image/jpeg\r\n\r\n`
  );
  const captionField = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${message}\r\n--${boundary}--\r\n`
  );
  const multipart = Buffer.concat([header, photoData, captionField]);

  const result = await new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ access_token: FB_PAGE_ACCESS_TOKEN });
    const options = {
      hostname: GRAPH_API_BASE,
      path: `/${GRAPH_API_VERSION}/${FB_PAGE_ID}/photos?${qs}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': multipart.length,
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(multipart);
    req.end();
  });

  if (result.error) throw new Error(`Graph API error: ${result.error.message}`);
  return { post_id: result.id, type: 'photo' };
}

async function postVideo(message, videoPath) {
  const result = await graphUploadVideo(videoPath, message);
  return { post_id: result.video_id, type: 'video' };
}

// ---------------------------------------------------------------------------
// Gemini video generation
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

  if (!args.payloadText) {
    console.log(JSON.stringify({ status: 'error', message: 'Missing --payload' }));
    process.exit(2);
  }

  const payload = JSON.parse(args.payloadText);
  const action = payload.action || {};
  const post = action.post || {};
  const live = Boolean(payload.live) && !args.dryRun;

  const type = (post.type || 'text').toLowerCase();
  const fullCaption = [
    post.hook ? `${post.hook}\n\n` : '',
    post.body || post.headline || '',
    post.hashtags ? `\n\n${post.hashtags}` : '',
    post.cta ? `\n\n${post.cta}` : '',
  ].join('').trim();

  // ---- Dry run ----
  if (!live) {
    console.log(JSON.stringify({
      status: 'dry_run',
      adapter: 'facebook-poster',
      action_id: action.id || null,
      post_type: type,
      date: post.date || post.day || null,
      headline: post.headline || null,
      caption_preview: fullCaption.slice(0, 200) + (fullCaption.length > 200 ? '...' : ''),
      hashtag_count: (post.hashtags || '').split(/\s+/).filter(h => h.startsWith('#')).length,
      photo_file: type === 'photo' ? (post.photo_file || null) : null,
      video_prompt: type === 'video' ? (post.video_prompt || null) : null,
      message: 'Dry run — no API call made',
    }));
    return;
  }

  // ---- Credential check ----
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) {
    console.log(JSON.stringify({
      status: 'error',
      message: 'FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN must be set in .env',
    }));
    process.exit(1);
  }

  // ---- Live execution ----
  try {
    await resolvePageToken();
    let result;

    if (type === 'video') {
      const videoPrompt = post.video_prompt;
      if (!videoPrompt) throw new Error('video_prompt is required for video posts');

      const dateSlug = (post.date || post.day || new Date().toISOString().slice(0, 10)).replace(/\s/g, '-');
      const videoPath = path.join(VIDEO_OUTPUT_DIR, `fb-video-${dateSlug}.mp4`);

      console.error(`Generating video via Gemini: ${videoPrompt.slice(0, 80)}...`);
      const savedPath = generateGeminiVideo(videoPrompt, videoPath);
      console.error(`Video saved: ${savedPath}`);

      result = await postVideo(fullCaption, savedPath);

    } else if (type === 'photo') {
      const photoPath = post.photo_file;
      if (!photoPath || !fs.existsSync(photoPath)) {
        throw new Error(`photo_file not found: ${photoPath}`);
      }
      result = await postPhoto(fullCaption, photoPath);

    } else {
      result = await postText(fullCaption);
    }

    console.log(JSON.stringify({
      status: 'success',
      adapter: 'facebook-poster',
      action_id: action.id || null,
      post_type: type,
      post_id: result.post_id,
      date: post.date || post.day || null,
      headline: post.headline || null,
      fb_post_url: result.post_id ? `https://www.facebook.com/${result.post_id.replace('_', '/posts/')}` : null,
    }));

  } catch (e) {
    console.log(JSON.stringify({
      status: 'error',
      adapter: 'facebook-poster',
      action_id: action.id || null,
      message: e.message || String(e),
    }));
    process.exit(1);
  }
}

main().catch(e => {
  console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  process.exit(1);
});
