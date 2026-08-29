#!/usr/bin/env node
/**
 * slideshow-reel.mjs — Ken Burns photo slideshow → Facebook Reel
 *
 * Real job photos only (no AI video). Usable as:
 *   import { buildSlideshowReel, parseOnScreenText, compressTextTimeline } from './slideshow-reel.mjs'
 *   node scripts/slideshow-reel.mjs --day N [--dry-run]
 *
 * Polish: larger amber text with outline, faster beat pacing, optional bed audio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultGbpPhotoDirs } from './lib/gbp-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CURATED = defaultGbpPhotoDirs(process.env).curatedPreferred;
const DEFAULT_SCHEDULE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const DEFAULT_OUTPUT_DIR = process.env.FB_VIDEO_OUTPUT_DIR
  || path.join(PROJECT_ROOT, 'outputs', 'fb-videos');
const DEFAULT_AUDIO = process.env.FB_SLIDESHOW_AUDIO
  || path.join(PROJECT_ROOT, 'assets', 'audio', 'upbeat-1.mp3');

const FONT = 'Arial';
const FONT_PATH = 'C\\:/Windows/Fonts/arialbd.ttf';
const W = 1080;
const H = 1920;
const FPS = 30;
// Faster beats: ~2.4s per caption line (was ~4s).
const BEAT_SEC = Number(process.env.FB_SLIDESHOW_BEAT_SEC || 2.7);
const MIN_SEG_SEC = Number(process.env.FB_SLIDESHOW_MIN_SEG_SEC || 3.0);
// Amber / electric gold — reads well on job-site photos
const TEXT_COLOR = process.env.FB_SLIDESHOW_TEXT_COLOR || '0xFFD166';
const TEXT_OUTLINE = process.env.FB_SLIDESHOW_TEXT_OUTLINE || 'black';

let FONT_SPEC = `font='${FONT}'`;
let hasFont = false;
try {
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=10x10,drawtext=fontfile='${FONT_PATH}':text=x,format=yuv420p`,
    '-t', '0.1', '-f', 'null', '-',
  ], { timeout: 10000, stdio: 'pipe' });
  FONT_SPEC = `fontfile='${FONT_PATH}'`;
  hasFont = true;
} catch {
  try {
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i',
      `color=c=black:s=10x10,drawtext=font='${FONT}':text=x,format=yuv420p`,
      '-t', '0.1', '-f', 'null', '-',
    ], { timeout: 10000, stdio: 'pipe' });
    hasFont = true;
  } catch {
    // text overlays skipped when font unavailable
  }
}

/** Parse crew ON_SCREEN_TEXT block into {start,end,text} seconds. */
export function parseOnScreenText(raw) {
  const textItems = [];
  if (!raw) return textItems;
  const re = /\[(\d+):(\d+)[–-](\d+):(\d+)\][^"]*"([^"]+)"/g;
  let m;
  while ((m = re.exec(String(raw))) !== null) {
    textItems.push({
      start: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
      end: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
      text: m[5],
    });
  }
  // Fallback: bare quoted lines without timestamps
  if (!textItems.length) {
    const lines = String(raw).split(/\r?\n/)
      .map((l) => {
        const qm = l.match(/"([^"]+)"/);
        return qm ? qm[1].trim() : '';
      })
      .filter(Boolean)
      .slice(0, 6);
    let t = 0;
    for (const text of lines) {
      textItems.push({ start: t, end: t + BEAT_SEC, text });
      t += BEAT_SEC;
    }
  }
  return textItems;
}

/**
 * Re-time long schedule beats into a snappier cadence (keeps order + copy).
 * Crew often writes 3–5s holds; we compress to ~BEAT_SEC each with 0.15s gap.
 */
export function compressTextTimeline(items, beatSec = BEAT_SEC) {
  if (!items?.length) return [];
  const gap = 0.12;
  let t = 0;
  return items.map((item) => {
    const text = String(item.text || '').trim();
    // Longer lines get a touch more dwell time
    const words = text.split(/\s+/).filter(Boolean).length;
    const hold = Math.min(3.2, Math.max(beatSec, beatSec + Math.max(0, words - 5) * 0.12));
    const start = t;
    const end = t + hold;
    t = end + gap;
    return { start, end, text };
  });
}

function ensureSlideshowBed(audioPath, durationSec) {
  if (audioPath && fs.existsSync(audioPath)) return audioPath;
  const out = audioPath || path.join(DEFAULT_OUTPUT_DIR, '_slideshow-bed.mp3');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Soft multi-tone bed (no vocals, no license issues). Looped/trimmed to clip length later.
  // Layer: warm root + fifth + soft noise pad.
  const dur = Math.max(20, Math.ceil(durationSec || 20) + 2);
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', `sine=frequency=130.81:duration=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=196.00:duration=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=261.63:duration=${dur}`,
      '-f', 'lavfi', '-i', `anoisesrc=color=pink:duration=${dur}:amplitude=0.02`,
      '-filter_complex',
      // Gentle volumes + lowpass so it sits under voice-of-text, not harsh
      '[0:a]volume=0.10[a0];[1:a]volume=0.07[a1];[2:a]volume=0.05[a2];'
      + '[3:a]lowpass=f=600,volume=0.35[n];'
      + '[a0][a1][a2][n]amix=inputs=4:duration=longest:dropout_transition=0,'
      + 'afade=t=in:st=0:d=0.6,afade=t=out:st=' + Math.max(1, dur - 1.2) + ':d=1.2,'
      + 'volume=0.85',
      '-c:a', 'libmp3lame', '-b:a', '160k',
      out,
    ], { timeout: 60000, stdio: 'pipe' });
    return out;
  } catch {
    return null;
  }
}

function buildDrawtextFilters(textItems) {
  // Full-width caption band + amber text so copy stays readable on any photo
  // (drawtext's own box is easy to lose on busy panels; drawbox is solid).
  const vfParts = [];
  const fontSize = 56;
  const lineHeight = 68;
  const maxCharsPerLine = 26;
  const bandPad = 28;
  const bandY = Math.round(H * 0.68); // lower third
  const bandH = Math.round(H * 0.22);

  for (const t of textItems) {
    const words = String(t.text || '').split(' ');
    const lines = [];
    let current = '';
    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      if (test.length <= maxCharsPerLine) current = test;
      else {
        if (current) lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);

    const safe = (s) => s.replace(/\\/g, '\\\\\\\\').replace(/'/g, "'\\\\\\''").replace(/:/g, '\\\\:');
    const enable = `enable='between(t,${t.start.toFixed(2)},${t.end.toFixed(2)})'`;
    // Solid readable plate across the width (not a thin wrap box)
    vfParts.push(
      `drawbox=x=0:y=${bandY}:w=${W}:h=${bandH}:color=black@0.72:t=fill:${enable}`,
    );
    // Optional top accent bar (brand energy)
    vfParts.push(
      `drawbox=x=0:y=${bandY}:w=${W}:h=6:color=0xFFD166@0.95:t=fill:${enable}`,
    );

    const blockH = lines.length * lineHeight;
    const startY = bandY + Math.round((bandH - blockH) / 2);
    for (let li = 0; li < lines.length; li++) {
      const y = startY + li * lineHeight;
      const txt = safe(lines[li]);
      vfParts.push(
        `drawtext=${FONT_SPEC}:text='${txt}':fontsize=${fontSize}:`
        + `fontcolor=${TEXT_COLOR}:borderw=4:bordercolor=black:`
        + `x=(w-text_w)/2:y=${y}:`
        + `shadowcolor=black@0.9:shadowx=3:shadowy=3:`
        + enable,
      );
    }
  }
  return vfParts;
}

/**
 * Build a vertical 9:16 slideshow reel from real photos.
 * @param {{ photos: string[], textItems?: {start:number,end:number,text:string}[], outPath: string, workDir?: string, audioPath?: string|null, compressText?: boolean }} opts
 */
export function buildSlideshowReel(opts) {
  const photos = (opts.photos || []).filter((p) => p && fs.existsSync(p));
  if (!photos.length) {
    return { status: 'error', message: 'No photos' };
  }
  let textItems = opts.textItems || [];
  if (opts.compressText !== false && textItems.length) {
    textItems = compressTextTimeline(textItems, BEAT_SEC);
  }
  const outPath = opts.outPath;
  if (!outPath) return { status: 'error', message: 'outPath required' };

  const workDir = opts.workDir || path.dirname(outPath);
  fs.mkdirSync(workDir, { recursive: true });

  const maxT = textItems.length
    ? Math.max(...textItems.map((t) => t.end))
    : photos.length * MIN_SEG_SEC;
  // Fit photos to text timeline; keep segments snappy
  const segDur = Math.max(
    MIN_SEG_SEC,
    Math.ceil((maxT + 0.4) / photos.length * 10) / 10,
  );
  const totalDur = Math.max(maxT + 0.3, photos.length * segDur);

  const stamp = `${process.pid}-${Date.now()}`;
  const segments = [];
  for (let i = 0; i < photos.length; i++) {
    const segPath = path.join(workDir, `_seg-${stamp}-${i}.mp4`);
    // Slightly stronger Ken Burns so stills feel less static
    execFileSync('ffmpeg', [
      '-y', '-loop', '1', '-t', String(segDur), '-i', photos[i],
      '-vf',
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
      + `zoompan=z='min(zoom+0.0012,1.10)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      segPath,
    ], { timeout: 120000, stdio: 'pipe' });
    segments.push(segPath);
  }

  const concatFile = path.join(workDir, `_concat-${stamp}.txt`);
  const concatLines = segments.map((s) => {
    const abs = path.resolve(s).replace(/\\/g, '/');
    return `file '${abs.replace(/'/g, "'\\''")}'`;
  });
  fs.writeFileSync(concatFile, concatLines.join('\n'));

  const rawPath = path.join(workDir, `_raw-${stamp}.mp4`);
  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-c', 'copy', rawPath,
  ], { timeout: 30000, stdio: 'pipe' });

  let videoOnly = rawPath;
  try {
    if (hasFont && textItems.length) {
      const vfParts = buildDrawtextFilters(textItems);
      if (vfParts.length) {
        const textPath = path.join(workDir, `_text-${stamp}.mp4`);
        execFileSync('ffmpeg', [
          '-y', '-i', rawPath,
          '-vf', vfParts.join(','),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', '-t', String(totalDur),
          textPath,
        ], { timeout: 180000, stdio: 'pipe' });
        videoOnly = textPath;
      }
    }

    // Mix bed audio (file or generated). Facebook rewards native video with sound.
    const wantAudio = opts.audioPath !== null; // null = force silent
    let audioPath = opts.audioPath === undefined ? DEFAULT_AUDIO : opts.audioPath;
    if (wantAudio) {
      if (!audioPath || !fs.existsSync(audioPath)) {
        audioPath = ensureSlideshowBed(
          path.join(workDir, `_bed-${stamp}.mp3`),
          totalDur,
        );
      }
    }
    if (wantAudio && audioPath && fs.existsSync(audioPath)) {
      execFileSync('ffmpeg', [
        '-y',
        '-i', videoOnly,
        '-stream_loop', '-1', '-i', audioPath,
        '-filter_complex',
        `[1:a]atrim=0:${totalDur},afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0.5, totalDur - 0.9)}:d=0.8,volume=0.55[a]`,
        '-map', '0:v:0', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
        '-shortest', '-movflags', '+faststart',
        outPath,
      ], { timeout: 120000, stdio: 'pipe' });
    } else if (videoOnly !== outPath) {
      fs.renameSync(videoOnly, outPath);
    } else {
      fs.renameSync(rawPath, outPath);
    }
  } finally {
    for (const s of segments) try { fs.unlinkSync(s); } catch { /* ignore */ }
    try { fs.unlinkSync(concatFile); } catch { /* ignore */ }
    try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
    try {
      const textPath = path.join(workDir, `_text-${stamp}.mp4`);
      if (fs.existsSync(textPath) && textPath !== outPath) fs.unlinkSync(textPath);
    } catch { /* ignore */ }
    try {
      const bed = path.join(workDir, `_bed-${stamp}.mp3`);
      if (fs.existsSync(bed)) fs.unlinkSync(bed);
    } catch { /* ignore */ }
  }

  const stats = fs.statSync(outPath);
  // Probe for audio stream (ffprobe if available)
  let hasAudio = false;
  try {
    const probe = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outPath,
    ], { timeout: 10000, encoding: 'utf8' });
    hasAudio = /audio/i.test(probe);
  } catch { /* ignore */ }
  return {
    status: 'success',
    output: outPath,
    sizeBytes: stats.size,
    duration: totalDur,
    photos: photos.length,
    textBeats: textItems.length,
    hasAudio,
  };
}

// ---------------------------------------------------------------------------
// CLI: node slideshow-reel.mjs --day N [--dry-run]
// ---------------------------------------------------------------------------

function field(block, name) {
  const patterns = [`**${name}:**`, `${name}:`];
  for (const pat of patterns) {
    const idx = block.indexOf(pat);
    if (idx === -1) continue;
    const after = block.slice(idx + pat.length);
    const end = after.indexOf('\n');
    return (end === -1 ? after : after.slice(0, end)).replace(/\*+/g, '').trim();
  }
  return '';
}

function runCli() {
  const args = process.argv.slice(2);
  const dayIdx = args.indexOf('--day');
  const day = dayIdx >= 0 ? parseInt(args[dayIdx + 1], 10) : 0;
  const dryRun = args.includes('--dry-run');
  if (!day) {
    console.error('Usage: node slideshow-reel.mjs --day N [--dry-run]');
    process.exit(1);
  }

  const schedulePath = process.env.FB_SCHEDULE_FILE || DEFAULT_SCHEDULE;
  const curatedDir = process.env.GBP_CURATED_FOLDER || DEFAULT_CURATED;
  const outputDir = process.env.FB_VIDEO_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;

  const scheduleText = fs.readFileSync(schedulePath, 'utf8');
  const blocks = scheduleText.split(/\n(?=## DAY \d)/);
  let block;
  let date;
  for (const b of blocks) {
    const dm = b.match(/\*{0,2}DAY:\*{0,2}\s*(\d+)/);
    if (dm && parseInt(dm[1], 10) === day) {
      block = b;
      date = field(b, 'DATE').replace(/\s*\(.*$/, '').trim();
      break;
    }
  }
  if (!block) {
    console.log(JSON.stringify({ status: 'error', message: `Day ${day} not found` }));
    process.exit(1);
  }

  const photos = fs.existsSync(curatedDir)
    ? fs.readdirSync(curatedDir)
      .filter((f) => f.startsWith(date) && /\.(jpe?g|png)$/i.test(f))
      .sort()
      .slice(0, 4)
      .map((f) => path.join(curatedDir, f))
    : [];

  let textItems = [];
  const txtStart = block.indexOf('ON_SCREEN_TEXT');
  if (txtStart >= 0) {
    let end = block.indexOf('\n**', txtStart);
    if (end === -1) end = block.indexOf('\n---', txtStart);
    if (end === -1) end = block.length;
    textItems = parseOnScreenText(block.slice(txtStart, end));
  }

  const outPath = path.join(outputDir, `fb-reel-${date}.mp4`);
  if (dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      photos: photos.map((p) => path.basename(p)),
      textItems: compressTextTimeline(textItems),
      output: outPath,
    }));
    process.exit(0);
  }

  if (!photos.length) {
    console.log(JSON.stringify({ status: 'error', message: 'No photos' }));
    process.exit(1);
  }

  const result = buildSlideshowReel({ photos, textItems, outPath, workDir: outputDir });
  console.log(JSON.stringify(result));
  if (result.status !== 'success') process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) runCli();
