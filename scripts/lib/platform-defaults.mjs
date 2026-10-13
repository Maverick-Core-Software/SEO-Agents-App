// scripts/lib/platform-defaults.mjs
// Machine-specific default locations. Each resolver reads its env var first, then
// falls back to a platform default. The resolvers are pure: env, platform and
// projectRoot are parameters (they default to process.* and this repo), so the
// linux branch can be exercised on any host. A Windows literal appears only inside
// an `if (platform === 'win32')` branch; it is the PC rollback default, nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function ctx(o = {}) {
  return {
    env: o.env || process.env,
    platform: o.platform || process.platform,
    projectRoot: o.projectRoot || REPO_ROOT,
    existsSync: o.existsSync || ((p) => fs.existsSync(p)),
  };
}

// Secrets: $SEO_SECRETS_DIR, else the PC's gmail-multi folder on win32, else
// <repo>/secrets (gitignored). posix.join keeps the forward-slash form the
// historical Windows literals used.
export function resolveSecretsDir(o = {}) {
  const { env, platform, projectRoot } = ctx(o);
  if (env.SEO_SECRETS_DIR) return env.SEO_SECRETS_DIR;
  if (platform === 'win32') return 'C:/Users/carte/gmail-multi';
  return path.posix.join(projectRoot, 'secrets');
}

export function resolveGbpClientSecret(o = {}) {
  const { env } = ctx(o);
  return env.GBP_CLIENT_SECRET
    || path.posix.join(resolveSecretsDir(o), 'client_secret_hermes_gbp.json');
}

export function resolveGbpTokenFile(o = {}) {
  const { env } = ctx(o);
  return env.GBP_TOKEN_FILE
    || path.posix.join(resolveSecretsDir(o), 'tokens', 'grizzly-gbp.json');
}

export function resolveSearchConsoleTokenFile(o = {}) {
  const { env } = ctx(o);
  return env.SEARCH_CONSOLE_TOKEN_FILE
    || path.posix.join(resolveSecretsDir(o), 'tokens', 'grizzly-search-console.json');
}

export function resolveGbpPosterConfig(o = {}) {
  const { env, platform, projectRoot } = ctx(o);
  if (env.GBP_POSTER_CONFIG) return env.GBP_POSTER_CONFIG;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(projectRoot, 'config', 'gbp-poster.config.json');
}

export function resolveGbpPhotoLocalCache(o = {}) {
  const { env, platform } = ctx(o);
  if (env.GBP_PHOTOS_LOCAL_CACHE) return env.GBP_PHOTOS_LOCAL_CACHE;
  if (platform === 'win32') return 'C:\\Workspace\\Shared\\Assets\\Media\\Grizzly\\GBP Post Photos';
  return '/srv/seo/photos';
}

// Curated folder default sits under the local photo cache. GBP_CURATED_FOLDER is
// read by gbp-paths.mjs before this default is consulted.
export function resolveGbpCuratedDefault(o = {}) {
  const { platform } = ctx(o);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(resolveGbpPhotoLocalCache(o), 'Curated');
}

export function resolveGbpArchiveFolder(o = {}) {
  const { env, platform } = ctx(o);
  if (env.GBP_ARCHIVE_FOLDER) return env.GBP_ARCHIVE_FOLDER;
  if (platform === 'win32') return 'M:\\backups\\gbp-archive';
  return '/srv/seo/gbp-archive';
}

export function resolveGbpPhotoPath(o = {}) {
  const { env, platform } = ctx(o);
  if (env.GBP_PHOTO_PATH) return env.GBP_PHOTO_PATH;
  if (platform === 'win32') return String.raw`C:\Workspace\Shared\Assets\Media\Grizzly\GBP Post Photos`;
  return '/srv/seo/photos';
}

export function resolveEndcardFont(o = {}) {
  const { env, platform } = ctx(o);
  if (env.GRIZZLY_ENDCARD_FONT) return env.GRIZZLY_ENDCARD_FONT;
  if (platform === 'win32') return String.raw`C\:/Windows/Fonts/arialbd.ttf`;
  return '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
}

// seo-agents CLI: SEO_AGENTS_EXE, then the venv for this platform. On win32 the
// first existing candidate wins, with the AppData python install as a last resort.
export function resolveSeoAgentsExe(o = {}) {
  const { env, platform, projectRoot, existsSync } = ctx(o);
  if (env.SEO_AGENTS_EXE) return env.SEO_AGENTS_EXE;
  if (platform === 'win32') {
    const candidates = [
      path.win32.join(projectRoot, '.venv', 'Scripts', 'seo-agents.exe'),
      'C:\\Users\\carte\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\seo-agents.exe',
    ];
    return candidates.find((p) => existsSync(p)) || candidates[0];
  }
  return path.posix.join(projectRoot, '.venv', 'bin', 'seo-agents');
}
