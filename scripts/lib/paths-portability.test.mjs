// Silent-failure guards for machine-specific defaults. The resolvers run on the
// linux branch with no env set, so a default that leaks a Windows path fails here
// instead of on AIWA. The platform is passed in, never stubbed globally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveGbpClientSecret,
  resolveGbpTokenFile,
  resolveSearchConsoleTokenFile,
  resolveGbpPosterConfig,
  resolveGbpPhotoLocalCache,
  resolveGbpCuratedDefault,
  resolveGbpArchiveFolder,
  resolveGbpPhotoPath,
  resolveEndcardFont,
  resolveSeoAgentsExe,
} from './platform-defaults.mjs';
import { resolveGbpMode, DEFAULT_GBP_POSTER } from './gbp-mode.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINUX = { env: {}, platform: 'linux', projectRoot: '/opt/seo/app', existsSync: () => false };

const ALL_DEFAULTS = {
  gbpClientSecret: resolveGbpClientSecret,
  gbpTokenFile: resolveGbpTokenFile,
  searchConsoleTokenFile: resolveSearchConsoleTokenFile,
  gbpPosterConfig: resolveGbpPosterConfig,
  photoLocalCache: resolveGbpPhotoLocalCache,
  curatedDefault: resolveGbpCuratedDefault,
  archiveFolder: resolveGbpArchiveFolder,
  photoPath: resolveGbpPhotoPath,
  endcardFont: resolveEndcardFont,
  seoAgentsExe: resolveSeoAgentsExe,
};

test('linux defaults with env unset carry no Windows path', () => {
  for (const [name, resolve] of Object.entries(ALL_DEFAULTS)) {
    const value = resolve(LINUX);
    assert.ok(value, `${name} resolved to an empty value`);
    assert.ok(!value.includes('C:') && !value.includes('\\'), `${name} leaked a Windows path: ${value}`);
  }
});

test('repo-scoped linux defaults resolve under projectRoot', () => {
  for (const name of ['gbpClientSecret', 'gbpTokenFile', 'searchConsoleTokenFile', 'gbpPosterConfig', 'seoAgentsExe']) {
    assert.ok(ALL_DEFAULTS[name](LINUX).startsWith('/opt/seo/app/'), `${name} escaped projectRoot`);
  }
});

test('GBP_POSTER default is one value, read by both mav-bridge and gbp-worker', () => {
  assert.equal(DEFAULT_GBP_POSTER, 'playwright');
  assert.equal(resolveGbpMode({}), DEFAULT_GBP_POSTER);
  for (const file of ['scripts/mav-bridge.mjs', 'scripts/gbp-worker.mjs']) {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    assert.match(src, /const GBP_MODE = resolveGbpMode\(\);/, `${file} must read the shared default`);
    assert.ok(!/GBP_POSTER \|\| '/.test(src), `${file} still carries its own GBP_POSTER default`);
  }
});
