#!/usr/bin/env node
/**
 * slideshow-reel.mjs — Ken Burns photo slideshow → Facebook Reel
 *
 * Real job photos only (no AI video). Usable as:
 *   import { buildSlideshowReel, parseOnScreenText } from './slideshow-reel.mjs'
 *   node scripts/slideshow-reel.mjs --day N [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CURATED = process.env.GBP_CURATED_FOLDER || 'E:\\Media\\Grizzly\\Curated';
const DEFAULT_SCHEDULE = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const DEFAULT_OUTPUT_DIR = process.env.FB_VIDEO_OUTPUT_DIR
  || path.join(PROJECT_ROOT, 'outputs', 'fb-videos');

const FONT = 'Arial';
const FONT_PATH = 'C\\:/Windows/Fonts/arialbd.ttf';
const W = 1080;
const H = 1920;
const FPS = 30;

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
  // Fallback: bare quoted lines without timestamps — 4s each
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
      textItems.push({ start: t, end: t + 4, text });
      t += 4;
    }
  }
  return textItems;
}

/**
 * Build a vertical 9:16 slideshow reel from real photos.
 * @param {{ photos: string[], textItems?: {start:number,end:number,text:string}[], outPath: string, workDir?: string }} opts
 */
export function buildSlideshowReel(opts) {
  const photos = (opts.photos || []).filter((p) => p && fs.existsSync(p));
  if (!photos.length) {
    return { status: 'error', message: 'No photos' };
  }
  const textItems = opts.textItems || [];
  const outPath = opts.outPath;
  if (!outPath) return { status: 'error', message: 'outPath required' };

  const workDir = opts.workDir || path.dirname(outPath);
  fs.mkdirSync(workDir, { recursive: true });

  const maxT = textItems.length
    ? Math.max(...textItems.map((t) => t.end))
    : photos.length * 4;
  const segDur = Math.max(4, Math.ceil((maxT + (photos.length - 1) * 0.8) / photos.length));
  const totalDur = photos.length * segDur;

  const stamp = `${process.pid}-${Date.now()}`;
  const segments = [];
  for (let i = 0; i < photos.length; i++) {
    const segPath = path.join(workDir, `_seg-${stamp}-${i}.mp4`);
    execFileSync('ffmpeg', [
      '-y', '-loop', '1', '-t', String(segDur), '-i', photos[i],
      '-vf',
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
      + `zoompan=z='min(zoom+0.001,1.08)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
      segPath,
    ], { timeout: 120000, stdio: 'pipe' });
    segments.push(segPath);
  }

  const concatFile = path.join(workDir, `_concat-${stamp}.txt`);
  // Concat demuxer resolves relative paths against the concat file's directory.
  // Always write absolute POSIX-style paths so Windows + relative workDir both work.
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

  try {
    if (hasFont && textItems.length) {
      const vfParts = [];
      for (const t of textItems) {
        const fontSize = 44;
        const lineHeight = 56;
        const maxCharsPerLine = 30;
        const words = t.text.split(' ');
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

        const safe = (s) => s.replace(/'/g, "'\\\\\\''").replace(/:/g, '\\\\:');
        const startY = Math.round(H * 0.12);
        for (let li = 0; li < lines.length; li++) {
          const y = startY + li * lineHeight;
          vfParts.push(
            `drawtext=${FONT_SPEC}:text='${safe(lines[li])}':fontcolor=white:fontsize=${fontSize}:`
            + `x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.5:boxborderw=8:`
            + `shadowcolor=black@0.8:shadowx=3:shadowy=3:`
            + `enable='between(t,${t.start},${t.end})'`,
          );
        }
      }
      if (vfParts.length) {
        const textPath = path.join(workDir, `_text-${stamp}.mp4`);
        execFileSync('ffmpeg', [
          '-y', '-i', rawPath,
          '-vf', vfParts.join(','),
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', '-t', String(totalDur),
          textPath,
        ], { timeout: 120000, stdio: 'pipe' });
        fs.renameSync(textPath, outPath);
      } else {
        fs.renameSync(rawPath, outPath);
      }
    } else {
      fs.renameSync(rawPath, outPath);
    }
  } finally {
    for (const s of segments) try { fs.unlinkSync(s); } catch { /* ignore */ }
    try { fs.unlinkSync(concatFile); } catch { /* ignore */ }
    try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
  }

  const stats = fs.statSync(outPath);
  return {
    status: 'success',
    output: outPath,
    sizeBytes: stats.size,
    duration: totalDur,
    photos: photos.length,
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
      textItems,
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
