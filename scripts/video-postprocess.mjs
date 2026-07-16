#!/usr/bin/env node
/**
 * video-postprocess.mjs
 * Standalone FFmpeg post-processing module for AI-generated videos.
 *
 * Exports:
 *   enhanceVideo(inputPath, outputPath, options)
 *       Trim boundaries, denoise, sharpen, add film grain, re-encode.
 *
 *   addBrandedEndCardWithFade(videoPath, cardPath, outputPath, overlays, cardDuration)
 *       Concatenate a branded end card with fade-out / fade-in transition.
 *
 *   postProcessVideo(rawVideoPath, finalOutputPath, options)
 *       Full pipeline: enhance → branded end card with fade.
 *
 * Used by facebook-poster.mjs to replace the legacy addBrandedEndCard().
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Logging (mirrors facebook-poster.mjs hopLog pattern)
// ---------------------------------------------------------------------------

function hopLog(hop, level, message, extra) {
  const rec = { ts: new Date().toISOString(), source: 'video-postprocess', hop, level, message, ...extra };
  console.error(`[video-postprocess][${hop}][${level}] ${message}`);
  if (level === 'error') console.error(`  ↳ ${JSON.stringify(rec)}`);
}

// ---------------------------------------------------------------------------
// FFmpeg availability check (same pattern as facebook-poster.mjs)
// ---------------------------------------------------------------------------

let HAS_FFMPEG = false;
try {
  execFileSync('ffmpeg', ['-version'], { timeout: 5000, encoding: 'utf8', stdio: 'pipe' });
  HAS_FFMPEG = true;
} catch {
  hopLog('video-postprocess', 'warn', 'FFmpeg not found — video post-processing will be skipped');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape text for use in FFmpeg drawtext filter values.
 * Must escape :, \, ', %.
 */
function ffmpegEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

/**
 * Probe video metadata: width, height, fps, duration, audio presence.
 * @param {string} videoPath
 * @returns {{ width: number, height: number, fps: number, duration: number, hasAudio: boolean }}
 */
function probeVideo(videoPath) {
  const probeOut = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,duration',
    '-of', 'json', videoPath,
  ], { encoding: 'utf8', timeout: 15000 });
  const stream = JSON.parse(probeOut).streams?.[0] || {};
  const W = stream.width || 720;
  const H = stream.height || 1280;
  const [fpsN, fpsD] = (stream.r_frame_rate || '24/1').split('/').map(Number);
  const fps = Math.round(fpsN / fpsD) || 24;
  const duration = parseFloat(stream.duration) || 0;

  let hasAudio = false;
  try {
    const audioProbe = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type', '-of', 'json', videoPath,
    ], { encoding: 'utf8', timeout: 15000 });
    hasAudio = !!JSON.parse(audioProbe).streams?.[0];
  } catch { /* no audio stream */ }

  return { width: W, height: H, fps, duration, hasAudio };
}

// ---------------------------------------------------------------------------
// 1. enhanceVideo
// ---------------------------------------------------------------------------

/**
 * Post-process an AI-generated video to reduce artifacts and improve quality.
 *
 * Pipeline:
 * 1. Trim first/last 0.5s (worst artifacts at clip boundaries; skipped if < 3s)
 * 2. Denoise (hqdn3d — removes inter-frame shimmer)
 * 3. Sharpen (unsharp — recovers edge detail)
 * 4. Subtle film grain (masks remaining artifacts, adds organic texture)
 * 5. Re-encode (libx264, CRF 20, preset fast)
 *
 * @param {string} inputPath  - raw AI video
 * @param {string} outputPath - processed video
 * @param {object} options    - { trim, denoise, sharpen, grain } (all default true)
 * @returns {string} outputPath
 */
export function enhanceVideo(inputPath, outputPath, options = {}) {
  if (!HAS_FFMPEG) {
    hopLog('video-postprocess→enhance', 'warn', 'FFmpeg unavailable — skipping enhancement, copying raw');
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  const trim = options.trim !== false;
  const denoise = options.denoise !== false;
  const sharpen = options.sharpen !== false;
  const grain = options.grain !== false;

  // Probe duration to decide on trimming
  let shouldTrim = false;
  let duration = 0;
  if (trim) {
    try {
      const probe = probeVideo(inputPath);
      duration = probe.duration;
      shouldTrim = duration >= 3;  // skip trim if video < 3s
    } catch {
      hopLog('video-postprocess→enhance', 'warn', 'ffprobe failed — skipping trim');
    }
  }

  // Build FFmpeg args
  const args = ['-y'];

  // Trim: use -ss and -to as input options for fast seek
  if (shouldTrim) {
    const startTime = 0.5;
    const endTime = duration - 0.5;
    args.push('-ss', String(startTime), '-to', String(endTime));
  }

  args.push('-i', inputPath);

  // Build filter chain
  const filters = [];
  if (denoise) filters.push('hqdn3d=2:2:3:3');
  if (sharpen) filters.push('unsharp=5:5:0.6:5:5:0.4');
  if (grain) filters.push('noise=alls=4:allf=t+u');

  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }

  // Re-encode
  args.push(
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  );

  try {
    execFileSync('ffmpeg', args, { timeout: 120000, stdio: 'pipe' });
    hopLog('video-postprocess→enhance', 'info',
      `Enhanced: ${path.basename(inputPath)} → ${path.basename(outputPath)}`
      + (shouldTrim ? ' (trimmed ±0.5s)' : '')
      + (filters.length ? ` filters: ${filters.join(',')}` : ''));
    return outputPath;
  } catch (e) {
    hopLog('video-postprocess→enhance', 'error', `FFmpeg enhancement failed: ${e.message.slice(0, 200)}`);
    // Fallback: copy raw if enhancement fails
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
}

// ---------------------------------------------------------------------------
// 2. addBrandedEndCardWithFade
// ---------------------------------------------------------------------------

/**
 * Concatenate video with a branded end card using fade transitions.
 *
 * - Probes video for dimensions, fps, audio presence
 * - Creates end card from static image with drawtext overlays (brand name + phone)
 * - Adds 0.5s fade-out at end of main video
 * - Adds 0.5s fade-in at start of end card
 * - Preserves audio with silence padding on the end card
 *
 * @param {string} videoPath    - main video (already enhanced)
 * @param {string} cardPath     - end card image
 * @param {string} outputPath   - final video
 * @param {object} overlays     - { brandName, brandPhone, fontPath }
 * @param {number} cardDuration - seconds (default 3)
 * @returns {string} outputPath
 */
export function addBrandedEndCardWithFade(videoPath, cardPath, outputPath, overlays = {}, cardDuration = 3) {
  if (!HAS_FFMPEG) {
    hopLog('video-postprocess→endcard', 'warn', 'FFmpeg unavailable — skipping end card, copying video');
    if (videoPath !== outputPath) fs.copyFileSync(videoPath, outputPath);
    return outputPath;
  }

  if (!fs.existsSync(cardPath)) {
    hopLog('video-postprocess→endcard', 'warn', `End card image not found: ${cardPath} — copying video as-is`);
    if (videoPath !== outputPath) fs.copyFileSync(videoPath, outputPath);
    return outputPath;
  }

  try {
    const { width: W, height: H, fps, duration, hasAudio } = probeVideo(videoPath);

    const brandName = overlays.brandName || '';
    const brandPhone = overlays.brandPhone || '';
    const rawFontPath = overlays.fontPath || '';
    const fontExists = rawFontPath && fs.existsSync(rawFontPath.replace(/\\:/g, ':'));
    // Escape colons in font path for FFmpeg filter syntax (e.g. C:/ → C\:/)
    const fontPath = fontExists ? rawFontPath.replace(/:/g, '\\:') : '';

    // drawtext overlays for brand name + phone (same positioning as facebook-poster.mjs)
    const phoneFontSize = Math.max(28, Math.round(H / 22));
    const nameFontSize = Math.max(22, Math.round(H / 30));
    const shadow = 'shadowcolor=black@0.9:shadowx=3:shadowy=3';
    let textFilter = '';
    if (fontExists && brandName) {
      textFilter = `,drawtext=fontfile='${fontPath}':text='${ffmpegEscape(brandName)}':fontcolor=white:fontsize=${nameFontSize}:x=(w-text_w)/2:y=h*0.72:${shadow}`;
      if (brandPhone) {
        textFilter += `,drawtext=fontfile='${fontPath}':text='${ffmpegEscape(brandPhone)}':fontcolor=white:fontsize=${phoneFontSize}:x=(w-text_w)/2:y=h*0.80:${shadow}`;
      }
    }

    const fadeDuration = 0.5;

    // Calculate fade-out start time for main video (0.5s before end)
    const fadeOutStart = Math.max(0, duration - fadeDuration);

    // End card filter chain: scale, pad, set fps, fade-in, drawtext
    const cardChain = `[1:v]scale=${W}:-1,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},fade=t=in:st=0:d=${fadeDuration}${textFilter}[card]`;

    // Main video: apply fade-out at end
    const mainChain = `[0:v]setsar=1,fade=t=out:st=${fadeOutStart}:d=${fadeDuration}[main]`;

    if (hasAudio) {
      // With audio: concat main video+audio with card video+silence
      execFileSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-loop', '1', '-t', String(cardDuration), '-i', cardPath,
        '-f', 'lavfi', '-t', String(cardDuration), '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
        '-filter_complex', [
          cardChain,
          mainChain,
          `[main][0:a][card][2:a]concat=n=2:v=1:a=1[out][outa]`,
        ].join(';'),
        '-map', '[out]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
      ], { timeout: 120000 });
    } else {
      // No audio: concat video only
      execFileSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-loop', '1', '-t', String(cardDuration), '-i', cardPath,
        '-filter_complex', [
          cardChain,
          mainChain,
          `[main][card]concat=n=2:v=1:a=0[out]`,
        ].join(';'),
        '-map', '[out]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-an',
        '-movflags', '+faststart',
        outputPath,
      ], { timeout: 120000 });
    }

    hopLog('video-postprocess→endcard', 'info',
      `Branded end card with fade added: ${path.basename(videoPath)} → ${path.basename(outputPath)}`
      + ` (card: ${cardDuration}s, fade: ${fadeDuration}s, audio: ${hasAudio ? 'yes' : 'no'})`);
    return outputPath;
  } catch (e) {
    hopLog('video-postprocess→endcard', 'warn', `End card with fade failed (${e.message.slice(0, 200)}) — copying video as-is`);
    if (videoPath !== outputPath) fs.copyFileSync(videoPath, outputPath);
    return outputPath;
  }
}

// ---------------------------------------------------------------------------
// 3. postProcessVideo
// ---------------------------------------------------------------------------

/**
 * Full post-processing pipeline: enhance → brand end card with fade.
 * This replaces the current addBrandedEndCard() in facebook-poster.mjs.
 *
 * @param {string} rawVideoPath    - raw AI-generated video
 * @param {string} finalOutputPath - final output path
 * @param {object} options         - { cardPath, overlays, trim, denoise, sharpen, grain }
 * @returns {string} finalOutputPath
 */
export function postProcessVideo(rawVideoPath, finalOutputPath, options = {}) {
  if (!fs.existsSync(rawVideoPath)) {
    hopLog('video-postprocess→pipeline', 'error', `Raw video not found: ${rawVideoPath}`);
    return finalOutputPath;
  }

  // Intermediate enhanced path (same dir as raw, with -enhanced suffix)
  const enhancedPath = rawVideoPath.replace(/-raw\.mp4$/, '-enhanced.mp4');

  // Step 1: Enhance (denoise, sharpen, grain, trim)
  enhanceVideo(rawVideoPath, enhancedPath, options);

  // Step 2: Add branded end card with fade transition
  if (options.cardPath) {
    addBrandedEndCardWithFade(
      enhancedPath,
      options.cardPath,
      finalOutputPath,
      options.overlays || {},
      options.cardDuration || 3,
    );
    // Clean up intermediate enhanced file
    try { fs.unlinkSync(enhancedPath); } catch { /* already gone */ }
  } else {
    // No end card — just rename enhanced to final
    if (enhancedPath !== finalOutputPath) {
      fs.renameSync(enhancedPath, finalOutputPath);
    }
  }

  hopLog('video-postprocess→pipeline', 'info',
    `Post-processing complete: ${path.basename(rawVideoPath)} → ${path.basename(finalOutputPath)}`);
  return finalOutputPath;
}
