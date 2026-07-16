#!/usr/bin/env node
/**
 * generate-reference-image.mjs
 * Generates clean reference images for image-to-video (I2V) generation.
 *
 * These images serve as the first frame for xAI Grok Imagine I2V, anchoring
 * scene geometry and preventing temporal artifacts. Uses Google's Gemini image
 * generation API (Imagen) via the GEMINI_API_KEY already in .env.
 *
 * Usage:
 *   node generate-reference-image.mjs --prompt "text" --output /path/to/image.jpg
 *   node generate-reference-image.mjs --service "panel-upgrade" --output assets/reference-images/panel-upgrade.jpg
 *   node generate-reference-image.mjs --service "panel-upgrade" --output assets/reference-images/panel-upgrade.jpg --dry-run
 *
 * Env:
 *   GEMINI_API_KEY  - required for Gemini image generation API
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import process from 'node:process';

// ---------------------------------------------------------------------------
// .env loader (same pattern as xai-video-generator.mjs)
// ---------------------------------------------------------------------------

const envPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// ---------------------------------------------------------------------------
// Service-to-prompt mapping
// ---------------------------------------------------------------------------

const SERVICE_PROMPTS = {
  'panel-upgrade': 'Clean close-up of a modern electrical panel with circuit breakers neatly arranged, installed in a residential utility room, white drywall wall, natural daylight, photorealistic, no text, no people, no hands, vertical 9:16 composition',
  'ev-charger': 'A Level 2 EV charger mounted on a clean garage wall, modern home garage interior, natural daylight, photorealistic, no text, no people, no hands, vertical 9:16 composition',
  'generator': 'A whole-home standby generator installed on a concrete pad outside a suburban house, clean installation, daytime, photorealistic, no text, no people, no hands, vertical 9:16 composition',
  'troubleshooting': 'Close-up of a digital multimeter probing an electrical outlet, tools on a workbench nearby, residential wall with white drywall, photorealistic, no text, no face visible, vertical 9:16 composition',
  'commercial': 'Interior of a commercial electrical room with large breaker panels and conduit runs, clean industrial environment, fluorescent lighting, photorealistic, no text, no people, vertical 9:16 composition',
  'lighting': 'Modern recessed LED lighting installed in a kitchen ceiling, warm glow, clean drywall finish, photorealistic, no text, no people, vertical 9:16 composition',
  'surge-protection': 'A whole-house surge protector installed next to an electrical panel, clean residential utility room, natural daylight, photorealistic, no text, no people, no hands, vertical 9:16 composition',
  'wiring': 'Close-up of neat electrical wiring in a residential junction box, copper conductors with wire nuts, clean installation, natural daylight, photorealistic, no text, no people, no hands, vertical 9:16 composition',
  'inspection': 'Close-up of an electrical inspector\'s checklist on a clipboard next to an open electrical panel, residential utility room, natural daylight, photorealistic, no text, no face visible, vertical 9:16 composition',
  'outdoor-lighting': 'Modern outdoor landscape lighting illuminating a garden pathway at dusk, warm LED fixtures, suburban home exterior, photorealistic, no text, no people, vertical 9:16 composition',
};

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    prompt: '',
    service: '',
    output: '',
    dryRun: false,
    aspectRatio: '9:16',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt') args.prompt = argv[++i] || '';
    else if (argv[i] === '--service') args.service = argv[++i] || '';
    else if (argv[i] === '--output') args.output = argv[++i] || '';
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--aspect-ratio') args.aspectRatio = argv[++i] || '9:16';
  }
  return args;
}

// ---------------------------------------------------------------------------
// HTTPS helper (same pattern as xai-video-generator.mjs)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Gemini image generation (Imagen via generativelanguage API)
// ---------------------------------------------------------------------------

/**
 * Generate an image using Google's Gemini API (gemini-2.5-flash-image).
 * Uses the v1beta generateContent endpoint with image output modality.
 *
 * @param {string} prompt - text description of the desired image
 * @param {string} aspectRatio - '9:16' for vertical (default, passed via prompt text)
 * @returns {Buffer} - raw image bytes (PNG)
 */
async function generateImageViaGemini(prompt, aspectRatio = '9:16') {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set in environment or .env');
  }

  // Gemini 2.5 Flash Image — supports generateContent with image output
  const model = 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  // Include aspect ratio hint in the prompt text since generateContent doesn't
  // have a separate aspectRatio parameter like Imagen's predict endpoint
  const fullPrompt = `Generate a photorealistic image: ${prompt}`;
  const bodyObj = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  };

  const body = JSON.stringify(bodyObj);
  console.error(`Generating image via Gemini (${model}, ${aspectRatio})...`);
  console.error(`Prompt: ${prompt.slice(0, 100)}...`);

  const res = await httpsRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (res.status !== 200) {
    const msg = res.body?.error?.message || res.body?.error || JSON.stringify(res.body).slice(0, 500);
    throw new Error(`Gemini image generation failed (HTTP ${res.status}): ${msg}`);
  }

  // Extract inline image data from candidate parts
  const parts = res.body?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
  }

  throw new Error('Gemini returned no image data in response parts');
}

// ---------------------------------------------------------------------------
// Fallback: FAL.ai FLUX image generation (via direct API call)
// ---------------------------------------------------------------------------

/**
 * Generate an image using FAL.ai's FLUX model.
 * Requires FAL_KEY in environment.
 *
 * @param {string} prompt - text description
 * @param {string} aspectRatio - '9:16' for vertical
 * @returns {Buffer} - raw image bytes
 */
async function generateImageViaFAL(prompt, aspectRatio = '9:16') {
  const falKey = process.env.FAL_KEY || '';
  if (!falKey) {
    throw new Error('FAL_KEY not set — cannot use FAL.ai fallback');
  }

  // Map aspect ratio to FLUX dimensions
  const dimensions = aspectRatio === '9:16' ? { width: 1080, height: 1920 } : { width: 1024, height: 1024 };

  const body = JSON.stringify({
    prompt,
    image_size: { width: dimensions.width, height: dimensions.height },
    num_inference_steps: 50,
    guidance_scale: 7.5,
    num_images: 1,
    enable_safety_checker: true,
  });

  console.error(`Generating image via FAL.ai FLUX (${dimensions.width}x${dimensions.height})...`);

  const res = await httpsRequest('https://fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${falKey}`,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (res.status !== 200) {
    throw new Error(`FAL.ai failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`);
  }

  const imageUrl = res.body?.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error('FAL.ai returned no image URL');
  }

  // Download the image
  console.error(`Downloading generated image from FAL.ai CDN...`);
  const imageData = await httpsRequest(imageUrl, { method: 'GET', _binary: true });
  return imageData;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve prompt from --service or --prompt
  let prompt = args.prompt;
  if (args.service) {
    prompt = SERVICE_PROMPTS[args.service] || '';
    if (!prompt) {
      console.error(JSON.stringify({
        status: 'error',
        message: `Unknown service: "${args.service}". Available services: ${Object.keys(SERVICE_PROMPTS).join(', ')}`,
      }));
      process.exit(2);
    }
  }

  if (!prompt) {
    console.error(JSON.stringify({
      status: 'error',
      message: 'Either --prompt "text" or --service "service-name" is required',
    }));
    process.exit(2);
  }

  if (!args.output) {
    console.error(JSON.stringify({ status: 'error', message: 'Missing --output path' }));
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      prompt,
      service: args.service || null,
      aspect_ratio: args.aspectRatio,
      output: args.output,
      backend: GEMINI_API_KEY ? 'gemini-imagen' : 'fal-flux',
      message: 'Dry run — no API call made',
    }));
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });

  try {
    let imageBuffer;

    // Try Gemini first, fall back to FAL.ai
    if (GEMINI_API_KEY) {
      try {
        imageBuffer = await generateImageViaGemini(prompt, args.aspectRatio);
      } catch (geminiErr) {
        console.error(`Gemini image generation failed: ${geminiErr.message}`);
        console.error('Falling back to FAL.ai FLUX...');
        imageBuffer = await generateImageViaFAL(prompt, args.aspectRatio);
      }
    } else {
      imageBuffer = await generateImageViaFAL(prompt, args.aspectRatio);
    }

    fs.writeFileSync(args.output, imageBuffer);
    const stats = fs.statSync(args.output);

    console.log(JSON.stringify({
      status: 'success',
      prompt,
      service: args.service || null,
      aspect_ratio: args.aspectRatio,
      output: args.output,
      size_bytes: stats.size,
      message: `Reference image saved to ${args.output}`,
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
