#!/usr/bin/env node
/**
 * slideshow-reel.mjs — Ken Burns photo slideshow → Facebook Reel
 * Simplified: renders each photo as a segment, then concats them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const CURATED_DIR = process.env.GBP_CURATED_FOLDER || 'E:\\Media\\Grizzly\\Curated';
const SCHEDULE_PATH = path.join(PROJECT_ROOT, 'outputs', 'facebook_posting_schedule.md');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'outputs', 'fb-videos');
const FONT = 'Arial';
const FONT_PATH = 'C\\:/Windows/Fonts/arialbd.ttf';  // fallback if fontconfig unavailable

// Font check — skip text overlays if font can't be resolved
let FONT_SPEC = `font='${FONT}'`;  // default to fontconfig name
let hasFont = false;
try {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=10x10,drawtext=fontfile='${FONT_PATH}':text=x,format=yuv420p`, '-t', '0.1', '-f', 'null', '-'], { timeout: 10000, stdio: 'pipe' });
  FONT_SPEC = `fontfile='${FONT_PATH}'`;
  hasFont = true;
} catch {
  try {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=10x10,drawtext=font='${FONT}':text=x,format=yuv420p`, '-t', '0.1', '-f', 'null', '-'], { timeout: 10000, stdio: 'pipe' });
    hasFont = true;
  } catch { console.error('Font not available — skipping text overlays'); }
}
const W = 1080, H = 1920, FPS = 30;

const args = process.argv.slice(2);
const dayIdx = args.indexOf('--day');
const day = dayIdx >= 0 ? parseInt(args[dayIdx + 1]) : 0;
const dryRun = args.includes('--dry-run');

if (!day) { console.error('Usage: --day N [--dry-run]'); process.exit(1); }

const scheduleText = fs.readFileSync(SCHEDULE_PATH, 'utf8');

// Parse ONE key from a schedule block
function field(block, name) {
  // Match **NAME:** value or NAME: value — crew uses both formats
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

// Find the block for this day
const blocks = scheduleText.split(/\n(?=## DAY \d)/);
let block, date;
for (const b of blocks) {
  const dm = b.match(/\*{0,2}DAY:\*{0,2}\s*(\d+)/);
  if (dm && parseInt(dm[1]) === day) { block = b; date = field(b, 'DATE'); break; }
}
if (!block) { console.log(JSON.stringify({status:'error',message:`Day ${day} not found`})); process.exit(1); }

// Resolve photos
const photos = fs.readdirSync(CURATED_DIR)
  .filter(f => f.startsWith(date) && /\.(jpe?g|png)$/i.test(f))
  .sort()
  .slice(0, 4)
  .map(f => path.join(CURATED_DIR, f));

// Parse text items
const textItems = [];
const txtStart = block.indexOf('ON_SCREEN_TEXT');
if (txtStart >= 0) {
  let end = block.indexOf('\n**', txtStart);
  if (end === -1) end = block.indexOf('\n---', txtStart);
  if (end === -1) end = block.length;
  const raw = block.slice(txtStart, end);
  const re = /\[(\d+):(\d+)[–-](\d+):(\d+)\][^"]*"([^"]+)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    textItems.push({ start: parseInt(m[1])*60+parseInt(m[2]), end: parseInt(m[3])*60+parseInt(m[4]), text: m[5] });
  }
}

if (dryRun) {
  console.log(JSON.stringify({status:'dry_run',photos:photos.map(p=>path.basename(p)),textItems,output:path.join(OUTPUT_DIR,`fb-reel-${date}.mp4`)}));
  process.exit(0);
}

if (!photos.length) { console.log(JSON.stringify({status:'error',message:'No photos'})); process.exit(1); }

// Auto-size: fit text timeline
const maxT = textItems.length ? Math.max(...textItems.map(t=>t.end)) : photos.length * 4;
const segDur = Math.max(4, Math.ceil((maxT + (photos.length-1)*0.8) / photos.length));
const totalDur = photos.length * segDur - (photos.length > 1 ? 0.8 * (photos.length-1) : 0);
const outPath = path.join(OUTPUT_DIR, `fb-reel-${date}.mp4`);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Render each photo as a segment (pre-scale for speed)
const segments = [];
for (let i = 0; i < photos.length; i++) {
  const segPath = path.join(OUTPUT_DIR, `_seg${i}.mp4`);
  // Pre-scale + crop to exact dimensions, then gentle zoom for motion
  execFileSync('ffmpeg', [
    '-y', '-loop', '1', '-t', String(segDur), '-i', photos[i],
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},zoompan=z='min(zoom+0.001,1.08)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    segPath,
  ], { timeout: 120000, stdio: 'pipe' });
  segments.push(segPath);
}

// Build concat file
const concatFile = path.join(OUTPUT_DIR, '_concat.txt');
const concatLines = [];
for (let i = 0; i < segments.length; i++) {
  concatLines.push(`file '${segments[i].replace(/'/g, "'\\''")}'`);
  if (i < segments.length - 1) {
    // Crossfade: add a silent gap segment is complex with concat.
    // Simpler: just do fast concat with no transition for now.
  }
}
fs.writeFileSync(concatFile, concatLines.join('\n'));

// Concat segments
const rawPath = path.join(OUTPUT_DIR, '_raw.mp4');
execFileSync('ffmpeg', [
  '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
  '-c', 'copy', rawPath,
], { timeout: 30000, stdio: 'pipe' });

// Add text overlays (only if font is available)
if (hasFont && textItems.length) {
  const vfParts = [];
  for (const t of textItems) {
    const fontSize = 44;
    const lineHeight = 56;
    const maxCharsPerLine = 30; // ~900px at fontsize 44 with Arial Bold

    // Word-wrap the text into lines
    const words = t.text.split(' ');
    const lines = [];
    let current = '';
    for (const w of words) {
      const test = current ? current + ' ' + w : w;
      if (test.length <= maxCharsPerLine) { current = test; }
      else { lines.push(current); current = w; }
    }
    if (current) lines.push(current);

    const safe = (s) => s.replace(/'/g, "'\\\\\\''").replace(/:/g, '\\\\:');
    const startY = Math.round(H * 0.12);
    const totalHeight = lines.length * lineHeight;

    for (let li = 0; li < lines.length; li++) {
      const y = startY + li * lineHeight;
      vfParts.push(
        `drawtext=${FONT_SPEC}:text='${safe(lines[li])}':fontcolor=white:fontsize=${fontSize}:` +
        `x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.5:boxborderw=8:` +
        `shadowcolor=black@0.8:shadowx=3:shadowy=3:` +
        `enable='between(t,${t.start},${t.end})'`
      );
    }
  }
  if (vfParts.length) {
    const vfArg = ['-vf', vfParts.join(',')];
    const textPath = path.join(OUTPUT_DIR, '_text.mp4');
    execFileSync('ffmpeg', [
      '-y', '-i', rawPath,
      ...vfArg,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-t', String(totalDur),
      textPath,
    ], { timeout: 120000, stdio: 'pipe' });
    fs.renameSync(textPath, outPath);
    try { fs.unlinkSync(rawPath); } catch {}
  } else {
    fs.renameSync(rawPath, outPath);
  }
} else {
  fs.renameSync(rawPath, outPath);
}

// Cleanup
for (const s of segments) try { fs.unlinkSync(s); } catch {}
try { fs.unlinkSync(concatFile); } catch {}
try { fs.unlinkSync(rawPath); } catch {}

const stats = fs.statSync(outPath);
console.log(JSON.stringify({status:'success',output:outPath,sizeBytes:stats.size,duration:totalDur,photos:photos.length}));
