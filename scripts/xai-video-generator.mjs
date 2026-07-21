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
 *     [--image /path/to/image.jpg] [--seed 42] [--negative-prompt "text"]
 *
 * Env:
 *   XAI_API_KEY              - required (falls back to GROK_API_KEY)
 *   GROK_VIDEO_MODEL         - default 'grok-imagine-video' (T2V) or 'grok-imagine-video-1.5' (I2V)
 *   GROK_VIDEO_RESOLUTION    - default '720p' (1080p is rejected by grok-imagine-video — HTTP 400)
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
// T2V model: grok-imagine-video (text-to-video)
// I2V model: grok-imagine-video-1.5 (image-to-video, requires image_url)
// Model is selected automatically based on whether --image is provided.
const XAI_VIDEO_MODEL_T2V = process.env.GROK_VIDEO_MODEL || 'grok-imagine-video';
const XAI_VIDEO_MODEL_I2V = 'grok-imagine-video-1.5';
// 720p, NOT 1080p: grok-imagine-video rejects 1080p with HTTP 400
// ("1080p video resolution is not available for this model") — this killed both
// renders on the 2026-07-20 run. Facebook re-encodes uploads anyway.
const XAI_VIDEO_RESOLUTION = process.env.GROK_VIDEO_RESOLUTION || '720p';
const POLL_INTERVAL_MS = 5000;
// xAI typically returns in 1-3 min; leave headroom for queue depth on the
// preview model. 144 polls x 5s = 720s (12 min), matching the parent timeout.
const MAX_POLL_ATTEMPTS = 144;

function parseArgs(argv) {
  const args = {
    prompt: '',
    output: '',
    dryRun: false,
    aspectRatio: '9:16',
    durationSeconds: 8,
    image: '',
    seed: null,
    negativePrompt: '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt') args.prompt = argv[++i] || '';
    else if (argv[i] === '--output') args.output = argv[++i] || '';
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--aspect-ratio') args.aspectRatio = argv[++i] || '9:16';
    else if (argv[i] === '--duration') args.durationSeconds = parseInt(argv[++i] || '8');
    else if (argv[i] === '--image') args.image = argv[++i] || '';
    else if (argv[i] === '--seed') args.seed = parseInt(argv[++i] || '0') || null;
    else if (argv[i] === '--negative-prompt') args.negativePrompt = argv[++i] || '';
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

async function submitJob(prompt, aspectRatio, durationSeconds, options = {}) {
  const { image, seed, negativePrompt } = options;
  const isI2V = !!image;

  // Select model: I2V uses grok-imagine-video-1.5, T2V uses grok-imagine-video
  const model = isI2V ? XAI_VIDEO_MODEL_I2V : XAI_VIDEO_MODEL_T2V;
  const mode = isI2V ? 'I2V' : 'T2V';
  console.error(`Mode: ${mode} | Model: ${model} | Resolution: ${XAI_VIDEO_RESOLUTION} | Aspect: ${aspectRatio} | Duration: ${durationSeconds}s`);

  const bodyObj = {
    model,
    prompt,
    duration: durationSeconds,
    aspect_ratio: aspectRatio,
    resolution: XAI_VIDEO_RESOLUTION,
  };

  // I2V: include image as base64 data URL
  if (isI2V) {
    const imageBuffer = fs.readFileSync(image);
    const ext = path.extname(image).toLowerCase().slice(1);
    const mimeType = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';
    bodyObj.image_url = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  }

  // Optional seed for reproducibility
  if (seed !== null && !isNaN(seed)) {
    bodyObj.seed = seed;
  }

  // Optional negative prompt
  if (negativePrompt) {
    bodyObj.negative_prompt = negativePrompt;
  }

  const body = JSON.stringify(bodyObj);
  console.error(`Submitting xAI video job (${mode}, ${model}, ${aspectRatio}, ${durationSeconds}s, ${XAI_VIDEO_RESOLUTION})...`);

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
    // xAI returns HTTP 202 (not 200) while the job is still pending.
    if (res.status !== 200 && res.status !== 202) {
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

  // Determine mode (T2V vs I2V)
  const isI2V = !!args.image;
  const mode = isI2V ? 'I2V' : 'T2V';
  const activeModel = isI2V ? XAI_VIDEO_MODEL_I2V : XAI_VIDEO_MODEL_T2V;

  // Warn if aspect ratio is not 9:16 (Facebook Reels standard)
  if (args.aspectRatio !== '9:16') {
    console.error(`WARNING: aspect-ratio is ${args.aspectRatio}, but 9:16 is the Facebook Reels standard.`);
  }

  // Validate image file exists if I2V
  if (isI2V && !args.dryRun) {
    if (!fs.existsSync(args.image)) {
      console.error(JSON.stringify({ status: 'error', message: `Image file not found: ${args.image}` }));
      process.exit(2);
    }
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      backend: 'xai',
      mode,
      model: activeModel,
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration_seconds: args.durationSeconds,
      resolution: XAI_VIDEO_RESOLUTION,
      image: args.image || null,
      seed: args.seed,
      negative_prompt: args.negativePrompt || null,
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
    const requestId = await submitJob(args.prompt, args.aspectRatio, args.durationSeconds, {
      image: args.image,
      seed: args.seed,
      negativePrompt: args.negativePrompt,
    });
    console.error(`Job submitted: ${requestId}`);
    const videoUrl = await pollUntilDone(requestId);
    await downloadTo(videoUrl, args.output);

    const stats = fs.statSync(args.output);
    console.log(JSON.stringify({
      status: 'success',
      backend: 'xai',
      mode,
      model: activeModel,
      output: args.output,
      size_bytes: stats.size,
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      duration_seconds: args.durationSeconds,
      resolution: XAI_VIDEO_RESOLUTION,
      seed: args.seed,
      negative_prompt: args.negativePrompt || null,
      image: args.image || null,
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
