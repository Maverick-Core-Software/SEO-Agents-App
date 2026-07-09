#!/usr/bin/env node
/**
 * xai-video-generator.mjs
 * Generates short video clips via xAI's Grok Imagine video API.
 * Saves the output mp4 locally for use by the Facebook poster.
 *
 * CLI mirrors gemini-video-generator.mjs so facebook-poster can swap
 * generators via FB_VIDEO_BACKEND without changing its spawn code.
 *
 * Usage:
 *   node xai-video-generator.mjs --prompt "text" --output /path/to/out.mp4 \
 *     [--aspect-ratio 9:16] [--duration 8] [--dry-run]
 *
 * Env:
 *   XAI_API_KEY              - required (falls back to GROK_API_KEY)
 *   GROK_VIDEO_MODEL         - default 'grok-imagine-video-1.5'
 *   GROK_VIDEO_RESOLUTION    - default '720p'
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import process from 'node:process';

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

const XAI_API_KEY = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
const XAI_VIDEO_MODEL = process.env.GROK_VIDEO_MODEL || 'grok-imagine-video-1.5';
const XAI_VIDEO_RESOLUTION = process.env.GROK_VIDEO_RESOLUTION || '720p';
const POLL_INTERVAL_MS = 5000;
// xAI typically returns in 1-3 min; leave headroom for queue depth on the
// preview model. 144 polls x 5s = 720s (12 min), matching the parent timeout.
const MAX_POLL_ATTEMPTS = 144;

function parseArgs(argv) {
  const args = { prompt: '', output: '', dryRun: false, aspectRatio: '9:16', durationSeconds: 8 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt') args.prompt = argv[++i] || '';
    else if (argv[i] === '--output') args.output = argv[++i] || '';
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--aspect-ratio') args.aspectRatio = argv[++i] || '9:16';
    else if (argv[i] === '--duration') args.durationSeconds = parseInt(argv[++i] || '8');
  }
  return args;
}

function httpsRequest(url, options, body, _redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && _redirects < 5) {
        res.resume();
        const redirectUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        resolve(httpsRequest(redirectUrl, { ...options, method: 'GET' }, null, _redirects + 1));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (options._binary) return resolve(raw);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw.toString()) }); }
        catch { resolve({ status: res.statusCode, body: raw.toString() }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function submitJob(prompt, aspectRatio, durationSeconds) {
  const body = JSON.stringify({
    model: XAI_VIDEO_MODEL,
    prompt,
    duration: durationSeconds,
    aspect_ratio: aspectRatio,
    resolution: XAI_VIDEO_RESOLUTION,
  });
  console.error(`Submitting xAI video job (${XAI_VIDEO_MODEL}, ${aspectRatio}, ${durationSeconds}s, ${XAI_VIDEO_RESOLUTION})...`);
  const res = await httpsRequest('https://api.x.ai/v1/videos/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
  }, body);
  if (res.status !== 200 || !res.body?.request_id) {
    const msg = res.body?.error?.message || res.body?.error || JSON.stringify(res.body).slice(0, 400);
    throw new Error(`xAI submit failed (HTTP ${res.status}): ${msg}`);
  }
  return res.body.request_id;
}

async function pollUntilDone(requestId) {
  const pollUrl = `https://api.x.ai/v1/videos/${requestId}`;
  const authHeader = { Authorization: `Bearer ${XAI_API_KEY}` };
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await httpsRequest(pollUrl, { method: 'GET', headers: authHeader });
    const data = res.body || {};
    if (res.status !== 200) {
      throw new Error(`Poll HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    if (data.status === 'done') {
      const url = data.video?.url;
      if (!url) throw new Error(`Done status but no video.url: ${JSON.stringify(data).slice(0, 300)}`);
      return url;
    }
    if (data.status === 'failed' || data.status === 'expired') {
      throw new Error(`xAI generation ${data.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`);
    }
    console.error(`  Generating... status=${data.status || 'pending'} (attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS})`);
  }
  throw new Error('xAI video generation timed out after max poll attempts');
}

async function downloadTo(url, outputPath) {
  console.error(`Downloading from: ${url.slice(0, 80)}...`);
  const data = await httpsRequest(url, { method: 'GET', _binary: true });
  fs.writeFileSync(outputPath, data);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.prompt) {
    console.error(JSON.stringify({ status: 'error', message: 'Missing --prompt' }));
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      backend: 'xai',
      model: XAI_VIDEO_MODEL,
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration_seconds: args.durationSeconds,
      output: args.output || '(not set)',
      message: 'Dry run — no API call made',
    }));
    return;
  }

  if (!args.output) {
    console.error(JSON.stringify({ status: 'error', message: 'Missing --output path' }));
    process.exit(2);
  }
  if (!XAI_API_KEY) {
    console.error(JSON.stringify({ status: 'error', message: 'XAI_API_KEY (or GROK_API_KEY) not set in environment or .env' }));
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });

  try {
    const requestId = await submitJob(args.prompt, args.aspectRatio, args.durationSeconds);
    console.error(`Job submitted: ${requestId}`);
    const videoUrl = await pollUntilDone(requestId);
    await downloadTo(videoUrl, args.output);

    const stats = fs.statSync(args.output);
    console.log(JSON.stringify({
      status: 'success',
      backend: 'xai',
      model: XAI_VIDEO_MODEL,
      output: args.output,
      size_bytes: stats.size,
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration_seconds: args.durationSeconds,
    }));
  } catch (e) {
    console.error(JSON.stringify({ status: 'error', message: e.message || String(e) }));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(JSON.stringify({ status: 'error', message: e.message || String(e) }));
  process.exit(1);
});
