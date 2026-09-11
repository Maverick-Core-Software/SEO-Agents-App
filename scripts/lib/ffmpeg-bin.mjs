// Locate ffmpeg / ffprobe for the posters. `ffmpeg` on PATH is tried first; when
// the caller was started by Task Scheduler or `pm2 resurrect` its PATH can miss
// the per-user winget entry (Gyan.FFmpeg lives under %LOCALAPPDATA%), which is why
// mav-bridge logged "FFmpeg not found" on 2026-09-04 and 2026-09-11 while the same
// binary ran fine from an interactive shell. Override with FFMPEG_PATH /
// FFPROBE_PATH (full exe path) or FFMPEG_DIR (their bin folder) in .env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function candidates(name, env = process.env) {
  const out = [];
  if (env.FFMPEG_DIR) out.push(path.join(env.FFMPEG_DIR, `${name}.exe`), path.join(env.FFMPEG_DIR, name));
  if (name === 'ffmpeg' && env.FFMPEG_PATH) out.push(env.FFMPEG_PATH);
  if (name === 'ffprobe' && env.FFPROBE_PATH) out.push(env.FFPROBE_PATH);
  if (name === 'ffprobe' && env.FFMPEG_PATH) out.push(path.join(path.dirname(env.FFMPEG_PATH), 'ffprobe.exe'));
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(pkgs)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const root = path.join(pkgs, pkg);
      for (const sub of fs.readdirSync(root)) out.push(path.join(root, sub, 'bin', `${name}.exe`));
    }
  } catch { /* no winget packages dir */ }
  out.push(path.join(local, 'Microsoft', 'WinGet', 'Links', `${name}.exe`));
  out.push(`C:\ffmpeg\bin\${name}.exe`, `C:\Program Files\ffmpeg\bin\${name}.exe`);
  return out;
}

const resolved = new Map();

/** Returns an executable path/name for `ffmpeg` or `ffprobe`, or null when none works. */
export function resolveFfBin(name, env = process.env) {
  if (resolved.has(name)) return resolved.get(name);
  let found = null;
  const tryRun = (exe) => {
    try { execFileSync(exe, ['-version'], { timeout: 5000, stdio: 'pipe' }); return true; } catch { return false; }
  };
  for (const c of candidates(name, env)) {
    if (c && fs.existsSync(c) && tryRun(c)) { found = c; break; }
  }
  if (!found && tryRun(name)) found = name; // plain PATH lookup
  resolved.set(name, found);
  return found;
}

export const ffmpegBin = (env) => resolveFfBin('ffmpeg', env);
export const ffprobeBin = (env) => resolveFfBin('ffprobe', env);
