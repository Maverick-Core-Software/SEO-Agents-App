// scripts/gbp-api-poster.test.mjs
// G2 idempotent create + G3 photo-rule guard for the GBP API poster. Every
// network call is injected (gbpFetch / getGbpAccessToken / fetchImpl), the
// workbook, config, image and selection manifest are temp files. Nothing here
// reaches Google or the real state/.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import {
  runPoster,
  findLivePostForSummary,
  summaryPrefix,
  listLocalPosts,
  resolveManifestEntry,
  preparePhoto,
  probeV4,
  SUMMARY_PREFIX_CHARS,
} from './gbp-api-poster.mjs';
import { loadSelectionManifest, sha256Buffer } from './lib/photo-selection.mjs';

const LOCATION = 'accounts/111/locations/222';
const DATE = '2026-10-16';
const CAPTION = 'Breakers tripping in Frisco? Our licensed electricians find the fault fast and fix it right the first time.';
const NOW = Date.parse('2026-10-16T14:05:00Z');
const NOW_ISO = new Date(NOW).toISOString();

const tmpDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gbp-api-poster-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A fake JPEG: 12 KB of bytes seeded by `seed` so two images never share a hash. */
function fakeImage(dir, name, seed = 1, size = 12000) {
  const file = path.join(dir, name);
  const buf = Buffer.alloc(size, seed);
  buf[0] = 0xff; buf[1] = 0xd8;
  fs.writeFileSync(file, buf);
  return { file, hash: sha256Buffer(buf) };
}

/**
 * Workbook with one Approved row for DATE, a config pointing at it, a 12 KB
 * image and a keyed selection manifest auditing that image for DATE.
 */
function fixture({ caption = CAPTION, status = 'Approved', posted = false, workbookImage = 'audited', manifest = true, extraEntries = [], imageSeed = 7 } = {}) {
  const dir = tmp('fx');
  const img = fakeImage(dir, `${DATE}-troubleshooting.jpg`, imageSeed);
  const imagePath = workbookImage === 'audited' ? img.file : (workbookImage || '');
  const workbook = path.join(dir, 'schedule.xlsx');
  const ws = xlsx.utils.aoa_to_sheet([
    ['Date', 'Status', 'Posted', 'Topic', 'CaptionDraft', 'AssetIdOrDescription'],
    [DATE, status, posted, 'Troubleshooting', caption, imagePath],
  ]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Posts');
  xlsx.writeFile(wb, workbook);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ workbook_path: 'schedule.xlsx', config_dir: dir, default_cta_url: 'https://example.test/' }));
  const manifestPath = path.join(dir, 'state', 'photo-selection-manifest.json');
  const entry = {
    postDate: DATE, postService: 'Electrical Troubleshooting & Repair', postServiceType: 'troubleshooting',
    photoPath: img.file, photoHash: img.hash, sourcePath: img.file, sourceHash: img.hash,
    photoServiceType: 'troubleshooting', selectedAt: '2026-10-15T20:00:00.000Z', selectedBy: 'gbp-photo-pick',
  };
  if (manifest) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const keyed = { version: 1, platforms: { gbp: [entry], fb: [] } };
    for (const e of extraEntries) { (keyed.platforms[e.platform] ||= []).push(e); }
    fs.writeFileSync(manifestPath, JSON.stringify(keyed, null, 2));
  }
  return { dir, workbook, config, image: img, imagePath: img.file, manifestPath, entry };
}

/**
 * Mock GBP API: records every call; serves accounts/locations, the localPosts
 * list (as pages), create, GET-back, and media upload.
 */
function mockApi({ listed = [], pages = null, createdState = 'LIVE' } = {}) {
  const calls = [];
  const created = [];
  const uploads = [];
  const listPages = pages || [{ localPosts: listed }];
  let listCall = 0;
  const gbpFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/v1/accounts')) return { accounts: [{ name: 'accounts/111' }] };
    if (url.includes('/locations?readMask')) return { locations: [{ name: 'locations/222', title: 'Grizzly' }] };
    if (url.includes(`/${LOCATION}/localPosts?pageSize=`) && (options.method || 'GET') === 'GET') {
      const page = listPages[Math.min(listCall, listPages.length - 1)];
      listCall += 1;
      return page;
    }
    if (url.endsWith(`/${LOCATION}/localPosts`) && options.method === 'POST') {
      const body = JSON.parse(options.body);
      const name = `${LOCATION}/localPosts/new-${created.length + 1}`;
      created.push({ name, body });
      return { name, state: createdState, summary: body.summary };
    }
    if (url.includes('/media:startUpload')) return { mediaDataRef: { resourceName: 'media/abc' } };
    if (url.includes('/localPosts/new-')) return { name: url.split('/v4/')[1], state: createdState };
    throw new Error(`unexpected gbpFetch ${options.method || 'GET'} ${url}`);
  };
  const fetchImpl = async (url, options = {}) => {
    uploads.push({ url, contentType: options.headers?.['Content-Type'], bytes: options.body?.length || 0 });
    return { ok: true, status: 200, text: async () => '' };
  };
  const getGbpAccessToken = async () => 'test-token';
  return { calls, created, uploads, gbpFetch, fetchImpl, getGbpAccessToken };
}

function run(args, api, fx, extra = {}) {
  const emitted = [];
  const logs = [];
  const printed = [];
  return runPoster(
    { dryRun: false, config: fx.config, date: DATE, ...args },
    {
      ...api, manifestPath: fx.manifestPath, emit: (r) => emitted.push(r), log: (l) => logs.push(l), print: (l) => printed.push(l),
      now: () => NOW, env: {}, ...extra,
    },
  ).then((code) => ({ code, emitted, logs, printed, result: emitted[emitted.length - 1] }));
}

describe('G2 pure helpers', () => {
  it('summaryPrefix normalises whitespace, lower-cases and cuts at 60 chars', () => {
    const p = summaryPrefix('  Breakers\n\ttripping?   We   can help ' + 'x'.repeat(100));
    assert.equal(p.length, SUMMARY_PREFIX_CHARS);
    assert.ok(p.startsWith('breakers tripping? we can help '));
  });
  it('findLivePostForSummary: prefix + 7-day window, newest first, unparseable createTime counts as recent', () => {
    const old = { name: 'p/old', summary: CAPTION, createTime: '2026-10-01T00:00:00Z' };
    const recent = { name: 'p/recent', summary: `${CAPTION} (edited)`, createTime: '2026-10-15T00:00:00Z' };
    const older = { name: 'p/older', summary: CAPTION, createTime: '2026-10-12T00:00:00Z' };
    const undated = { name: 'p/undated', summary: CAPTION };
    assert.equal(findLivePostForSummary({ posts: [old], summary: CAPTION, now: NOW }), null, 'older than 7 days is not a duplicate');
    assert.equal(findLivePostForSummary({ posts: [older, recent], summary: CAPTION, now: NOW }).name, 'p/recent');
    assert.equal(findLivePostForSummary({ posts: [undated], summary: CAPTION, now: NOW }).name, 'p/undated');
    assert.equal(findLivePostForSummary({ posts: [recent], summary: 'Totally different caption text here', now: NOW }), null);
  });
  it('listLocalPosts follows nextPageToken', async () => {
    const api = mockApi({ pages: [
      { localPosts: [{ name: 'a', summary: 'one' }], nextPageToken: 'tok-2' },
      { localPosts: [{ name: 'b', summary: 'two' }] },
    ] });
    const posts = await listLocalPosts(LOCATION, api);
    assert.deepEqual(posts.map((p) => p.name), ['a', 'b']);
    const listCalls = api.calls.filter((c) => c.url.includes('localPosts?pageSize=100'));
    assert.equal(listCalls.length, 2);
    assert.ok(listCalls[1].url.includes('pageToken=tok-2'));
  });
});

describe('G2 idempotent create (runPoster with mocked API)', () => {
  let fx;
  before(() => { fx = fixture(); });

  it('a matching post within 7 days: no create, no upload, exit 0, already_live with the resource name', async () => {
    const api = mockApi({ listed: [
      { name: `${LOCATION}/localPosts/777`, summary: `${CAPTION}`, createTime: '2026-10-16T13:00:00Z', state: 'LIVE' },
    ] });
    const r = await run({}, api, fx);
    assert.equal(r.code, 0);
    assert.equal(r.result.result, 'already_live');
    assert.equal(r.result.status, 'already_live');
    assert.equal(r.result.name, `${LOCATION}/localPosts/777`);
    assert.equal(r.result.postUrl, `${LOCATION}/localPosts/777`, 'platform_post_id = resource name');
    assert.equal(api.created.length, 0, 'no POST localPosts');
    assert.equal(api.uploads.length, 0, 'no media upload either');
  });

  it('no match: creates once (with media) and reports the resource name as postUrl', async () => {
    const api = mockApi({ listed: [
      { name: `${LOCATION}/localPosts/1`, summary: 'A different post from last week', createTime: '2026-10-15T13:00:00Z', state: 'LIVE' },
    ] });
    const r = await run({}, api, fx);
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.result.result, 'posted');
    assert.equal(api.created.length, 1, 'exactly one create');
    assert.equal(r.result.postUrl, api.created[0].name);
    assert.ok(api.created[0].body.media?.[0]?.dataRef?.resourceName, 'the create carries the uploaded media');
    const listIdx = api.calls.findIndex((c) => c.url.includes('localPosts?pageSize=100'));
    const createIdx = api.calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/localPosts'));
    assert.ok(listIdx !== -1 && listIdx < createIdx, 'the list runs before the create');
  });

  it('a matching post Google REJECTED: exit 5 google_rejected, no create', async () => {
    const api = mockApi({ listed: [
      { name: `${LOCATION}/localPosts/9`, summary: CAPTION, createTime: '2026-10-16T13:00:00Z', state: 'REJECTED' },
    ] });
    const r = await run({}, api, fx);
    assert.equal(r.code, 5);
    assert.equal(r.result.result, 'policy_violation');
    assert.equal(r.result.reason, 'google_rejected');
    assert.equal(api.created.length, 0);
  });

  it('a listing failure propagates instead of creating blind', async () => {
    const api = mockApi();
    const failing = { ...api, gbpFetch: async (url, o) => (url.includes('localPosts?pageSize=') ? Promise.reject(new Error('503 list')) : api.gbpFetch(url, o)) };
    await assert.rejects(run({}, failing, fx), /503 list/);
    assert.equal(api.created.length, 0);
  });

  it('created but GET-back not LIVE: exit 3 still carries the resource name', async () => {
    const api = mockApi({ createdState: 'PROCESSING' });
    api.gbpFetch = ((orig) => async (url, o) => {
      if (url.includes('/localPosts/new-') && (o.method || 'GET') === 'GET') return { name: url.split('/v4/')[1], state: 'REJECTED' };
      return orig(url, o);
    })(api.gbpFetch);
    const r = await run({}, api, fixture());
    assert.equal(r.code, 3);
    assert.equal(r.result.result, 'posted');
    assert.equal(r.result.verified, false);
    assert.equal(r.result.postUrl, api.created[0].name, 'exit 3 reports the name so the runner closes the workbook gate');
  });
});

describe('G3 photo rule: manifest-only image, never text-only', () => {
  it('resolveManifestEntry ignores fb rows and gbp-api records, honours the workbook path', () => {
    const fx = fixture();
    const manifest = loadSelectionManifest(fx.manifestPath);
    assert.equal(resolveManifestEntry({ date: DATE, manifest }).entry.photoHash, fx.image.hash);
    assert.equal(resolveManifestEntry({ date: DATE, imagePath: fx.imagePath, manifest }).via, 'workbook-path');
    assert.equal(resolveManifestEntry({ date: '2026-10-17', manifest }).entry, null);
    const other = path.join(fx.dir, 'other.jpg');
    assert.match(resolveManifestEntry({ date: DATE, imagePath: other, manifest }).reason, /not the audited selection/);
    const onlyRecord = [{ platform: 'gbp', postedBy: 'gbp-api', postDate: DATE, photoPath: fx.imagePath, photoHash: fx.image.hash }];
    assert.equal(resolveManifestEntry({ date: DATE, manifest: onlyRecord }).entry, null, 'a gbp-api record is not a selection');
  });

  it('text-only is impossible: no manifest entry -> exit 5 image_missing, no API call at all', async () => {
    const fx = fixture({ workbookImage: '', manifest: false });
    const api = mockApi();
    const r = await run({}, api, fx);
    assert.equal(r.code, 5);
    assert.equal(r.result.result, 'policy_violation');
    assert.equal(r.result.reason, 'image_missing');
    assert.equal(r.result.manifest_ok, false);
    assert.equal(api.calls.length, 0, 'refused before any network call');
    assert.equal(api.created.length, 0);
  });

  it('a `<date>-` file in the folder without a manifest entry is still image_missing (no prefix scan)', async () => {
    const fx = fixture({ workbookImage: '', manifest: false });
    const api = mockApi();
    const r = await run({}, api, fx, { env: { GBP_CURATED_FOLDER: fx.dir } });
    assert.equal(r.code, 5);
    assert.equal(r.result.reason, 'image_missing');
    assert.equal(api.created.length, 0);
  });

  it('audited entry whose file is gone -> image_missing', async () => {
    const fx = fixture();
    fs.unlinkSync(fx.imagePath);
    const r = await run({}, mockApi(), fx);
    assert.equal(r.code, 5);
    assert.equal(r.result.reason, 'image_missing');
    assert.equal(r.result.image_exists, false);
  });

  it('bytes that differ from the audited sha256 -> image_missing (unaudited image)', async () => {
    const fx = fixture();
    fs.writeFileSync(fx.imagePath, Buffer.alloc(12000, 9));
    const r = await run({}, mockApi(), fx);
    assert.equal(r.code, 5);
    assert.equal(r.result.reason, 'image_missing');
    assert.match(r.result.error, /differ from the audited selection/);
  });

  it('duplicate hash within 8 weeks on another platform/date -> exit 5 hash_conflict, no create', async () => {
    const fx = fixture({ extraEntries: [
      { platform: 'fb', postDate: '2026-10-02', photoPath: 'C:/elsewhere/x.jpg', photoHash: null, sourceHash: null, selectedAt: '2026-10-01T00:00:00.000Z', selectedBy: 'fb-photo-pick' },
    ] });
    // Give the fb row this image's hash (the fixture cannot know it before the image exists).
    const keyed = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    keyed.platforms.fb[0].photoHash = fx.image.hash;
    fs.writeFileSync(fx.manifestPath, JSON.stringify(keyed));
    const api = mockApi();
    const r = await run({}, api, fx);
    assert.equal(r.code, 5);
    assert.equal(r.result.reason, 'hash_conflict');
    assert.match(r.result.error, /fb 2026-10-02/);
    assert.equal(api.created.length, 0);
  });

  it('the same hash used by a gbp-api post for another date in this run -> hash_conflict', async () => {
    const fx = fixture();
    const keyed = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    keyed.platforms.gbp.push({ postedBy: 'gbp-api', postDate: '2026-10-15', photoPath: fx.imagePath, photoHash: fx.image.hash, localPostName: 'x', selectedAt: '2026-10-15T14:00:00.000Z' });
    fs.writeFileSync(fx.manifestPath, JSON.stringify(keyed));
    const r = await run({}, mockApi(), fx);
    assert.equal(r.code, 5);
    assert.equal(r.result.reason, 'hash_conflict');
  });

  it('a reuse older than 8 weeks does not block', async () => {
    const fx = fixture();
    const keyed = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    keyed.platforms.gbp.push({ postDate: '2026-07-01', photoPath: 'C:/old.jpg', photoHash: fx.image.hash, selectedAt: '2026-06-30T00:00:00.000Z', selectedBy: 'gbp-photo-pick' });
    fs.writeFileSync(fx.manifestPath, JSON.stringify(keyed));
    const r = await run({}, mockApi(), fx);
    assert.equal(r.code, 0, r.logs.join('\n'));
  });

  it('image policy: under 10 KB -> exit 5 image_policy', async () => {
    const fx = fixture();
    const small = Buffer.alloc(4000, 3);
    fs.writeFileSync(fx.imagePath, small);
    const keyed = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    keyed.platforms.gbp[0].photoHash = sha256Buffer(small);
    fs.writeFileSync(fx.manifestPath, JSON.stringify(keyed));
    const r = await run({}, mockApi(), fx);
    assert.equal(r.code, 5);
    assert.equal(r.result.reason, 'image_policy');
    assert.match(r.result.error, /image-too-small/);
  });

  it('HEIC: converted through heic-convert and uploaded as JPEG; a failed conversion fails closed', async () => {
    const fx = fixture();
    const heic = path.join(fx.dir, `${DATE}-shot.heic`);
    const heicBytes = Buffer.alloc(15000, 5);
    fs.writeFileSync(heic, heicBytes);
    const keyed = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    keyed.platforms.gbp[0].photoPath = heic;
    keyed.platforms.gbp[0].photoHash = sha256Buffer(heicBytes);
    fs.writeFileSync(fx.manifestPath, JSON.stringify(keyed));
    fs.writeFileSync(fx.workbook, fs.readFileSync(fixture({ workbookImage: heic }).workbook));

    const jpeg = Buffer.alloc(13000, 6);
    const api = mockApi();
    const ok = await run({}, api, fx, { heicConvert: async () => async () => jpeg });
    assert.equal(ok.code, 0, ok.logs.join('\n'));
    assert.equal(api.uploads[0].contentType, 'image/jpeg');
    assert.equal(api.uploads[0].bytes, jpeg.length);
    assert.equal(ok.result.postUrl, api.created[0].name);
    const posted = loadSelectionManifest(fx.manifestPath).find((e) => e.postedBy === 'gbp-api');
    assert.equal(posted.photoHash, sha256Buffer(jpeg), 'manifest records the hash of the final (converted) bytes');

    // Same fixture (its workbook and manifest both name the HEIC): a converter
    // that throws, or no converter at all, is exit 5 image_format, not a post.
    const broken = await run({}, mockApi(), fx, { heicConvert: async () => async () => { throw new Error('input buffer is not a HEIC image'); } });
    assert.equal(broken.code, 5);
    assert.equal(broken.result.reason, 'image_format');
    const missing = await run({}, mockApi(), fx, { heicConvert: async () => null });
    assert.equal(missing.code, 5);
    assert.equal(missing.result.reason, 'image_format');
  });

  it('--dry-run prints {date,image_path,image_sha256,image_exists,manifest_ok} and touches no API', async () => {
    const fx = fixture();
    const api = mockApi();
    const r = await run({ dryRun: true }, api, fx);
    assert.equal(r.code, 0);
    assert.equal(r.result.result, 'dry_run');
    const row = JSON.parse(r.printed[0]);
    assert.deepEqual(
      { date: row.date, image_path: row.image_path, image_sha256: row.image_sha256, image_exists: row.image_exists, manifest_ok: row.manifest_ok },
      { date: DATE, image_path: fx.imagePath, image_sha256: fx.image.hash, image_exists: true, manifest_ok: true },
    );
    assert.equal(api.calls.length, 0);
    assert.equal(loadSelectionManifest(fx.manifestPath).some((e) => e.postedBy === 'gbp-api'), false, 'dry-run appends nothing');
  });

  it('--dry-run on a refused image still prints the row (manifest_ok false) and exits 5', async () => {
    const fx = fixture({ workbookImage: '', manifest: false });
    const r = await run({ dryRun: true }, mockApi(), fx);
    assert.equal(r.code, 5);
    const row = JSON.parse(r.printed[0]);
    assert.equal(row.manifest_ok, false);
    assert.equal(row.reason, 'image_missing');
  });

  it('success appends a postedBy gbp-api manifest row under the lock and leaves no lock file', async () => {
    const fx = fixture({ extraEntries: [
      { platform: 'fb', postDate: '2026-10-09', photoPath: 'C:/elsewhere/fb.jpg', photoHash: 'f'.repeat(64), selectedAt: '2026-10-08T00:00:00.000Z', selectedBy: 'fb-photo-pick' },
    ] });
    const api = mockApi();
    const r = await run({}, api, fx);
    assert.equal(r.code, 0, r.logs.join('\n'));
    const rows = loadSelectionManifest(fx.manifestPath);
    const posted = rows.find((e) => e.postedBy === 'gbp-api');
    assert.ok(posted, 'gbp-api row appended');
    assert.equal(posted.platform, 'gbp');
    assert.equal(posted.postDate, DATE);
    assert.equal(posted.photoHash, fx.image.hash);
    assert.equal(posted.localPostName, api.created[0].name);
    assert.equal(posted.postedAt, NOW_ISO);
    assert.equal(rows.filter((e) => e.selectedBy === 'gbp-photo-pick').length, 1, 'the selection row is kept');
    assert.equal(fs.existsSync(`${fx.manifestPath}.lock`), false);
    // The keyed file keeps the other platform's rows.
    const keyed = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    assert.equal(keyed.platforms.fb.length, 1, 'fb rows survive the gbp append');
    assert.equal(keyed.platforms.fb[0].photoHash, 'f'.repeat(64));
  });

  it('GBP_PHOTO_VISION_CHECK=1: a "no" verdict is exit 5 vision_rejected; unavailable fails closed; yes proceeds', async () => {
    const no = await run({}, mockApi(), fixture(), { env: { GBP_PHOTO_VISION_CHECK: '1' }, visionClient: async () => ({ matches: false, reason: 'shows a kitchen' }) });
    assert.equal(no.code, 5);
    assert.equal(no.result.reason, 'vision_rejected');
    const down = await run({}, mockApi(), fixture(), { env: { GBP_PHOTO_VISION_CHECK: '1' }, visionClient: async () => ({ unavailable: true, reason: 'OPENAI_API_KEY not set' }) });
    assert.equal(down.code, 5);
    assert.equal(down.result.reason, 'vision_unavailable');
    const seen = [];
    const yes = await run({}, mockApi(), fixture(), { env: { GBP_PHOTO_VISION_CHECK: '1' }, visionClient: async (q) => { seen.push(q); return { matches: true }; } });
    assert.equal(yes.code, 0, yes.logs.join('\n'));
    assert.equal(seen.length, 1);
    assert.ok(Buffer.isBuffer(seen[0].image.bytes), 'the vision client sees the final bytes');
  });

  it('preparePhoto never returns ok without an entry, a present file and a matching hash', async () => {
    const fx = fixture();
    const manifest = loadSelectionManifest(fx.manifestPath);
    const ok = await preparePhoto({ payload: { date: DATE, imagePath: '', topic: 't', caption: 'c' }, manifest, now: NOW });
    assert.equal(ok.ok, true);
    assert.equal(ok.sha256, fx.image.hash);
    const none = await preparePhoto({ payload: { date: '2026-10-17', imagePath: '', topic: 't', caption: 'c' }, manifest, now: NOW });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'image_missing');
  });
});

describe('gated v4 (404 route not served): fail closed with exit 6, never a create', () => {
  const HTML_404 = '<!DOCTYPE html><html><head><title>Error 404 (Not Found)!!1</title></head><body>route not served</body></html>';
  const JSON_404 = '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}';
  const GATE = (url) => url.endsWith('/localPosts?pageSize=1');
  const ACCOUNTS_V4 = 'https://mybusiness.googleapis.com/v4/accounts';
  const noQuery = (u) => u.split('?')[0];
  /** Fail the calls `when` selects with a status and body, the way gbpFetch reports them. */
  const gate = (api, when, { status = 404, body = HTML_404 } = {}) => ({
    ...api,
    gbpFetch: async (url, o) => {
      if (when(url, o)) { const e = new Error(`GBP API Error [${status}]: ${body}`); e.status = status; e.body = body; throw e; }
      return api.gbpFetch(url, o);
    },
  });

  it('404 on the localPosts list -> exit 6 api_gated, no create, no upload', async () => {
    const fx = fixture();
    const api = mockApi();
    const r = await run({}, gate(api, (url) => url.includes('localPosts?pageSize=')), fx);
    assert.equal(r.code, 6);
    assert.equal(r.result.result, 'api_gated');
    assert.equal(r.result.reason, 'v4_gated');
    assert.match(r.result.error, /gated/);
    assert.equal(api.created.length, 0);
    assert.equal(api.uploads.length, 0);
    assert.equal(loadSelectionManifest(fx.manifestPath).some((e) => e.postedBy === 'gbp-api'), false, 'nothing recorded');
  });

  it('404 on media:startUpload -> exit 6 api_gated, no create', async () => {
    const api = mockApi();
    const r = await run({}, gate(api, (url) => url.includes('media:startUpload')), fixture());
    assert.equal(r.code, 6);
    assert.equal(api.created.length, 0);
  });

  it('a non-404 failure is still an error (exit 1 path), not api_gated', async () => {
    const api = mockApi();
    const boom = { ...api, gbpFetch: async (url, o) => { if (url.includes('localPosts?pageSize=')) { const e = new Error('GBP API Error [500]: boom'); e.status = 500; throw e; } return api.gbpFetch(url, o); } };
    await assert.rejects(run({}, boom, fixture()), /500/);
  });

  it('the gate is a localPosts pageSize=1 GET: 200 proceeds to create, and /v4/accounts is never called', async () => {
    const api = mockApi();
    const r = await run({}, api, fixture());
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(api.created.length, 1);
    const gateCalls = api.calls.filter((c) => GATE(c.url));
    assert.deepEqual(gateCalls.map((c) => [c.method, c.url]), [['GET', `https://mybusiness.googleapis.com/v4/${LOCATION}/localPosts?pageSize=1`]]);
    assert.ok(api.calls.every((c) => noQuery(c.url) !== ACCOUNTS_V4), 'no /v4/accounts call');
  });

  it('gate 404 JSON (a missing resource) is an error, not api_gated: nothing created', async () => {
    const api = mockApi();
    await assert.rejects(run({}, gate(api, GATE, { body: JSON_404 }), fixture()), /gate failed: .*404/);
    assert.equal(api.created.length, 0);
    assert.equal(api.uploads.length, 0);
  });

  it('gate 401 is an auth error, not api_gated: nothing created', async () => {
    const api = mockApi();
    const body = '{"error":{"code":401,"message":"Request had invalid authentication credentials."}}';
    await assert.rejects(run({}, gate(api, GATE, { status: 401, body }), fixture()), /auth failed \[401\]/);
    assert.equal(api.created.length, 0);
    assert.equal(api.uploads.length, 0);
  });

  it('probeV4: 200 is ok with the count; 404 HTML is gated; 404 JSON is not gated', async () => {
    const api = mockApi({ listed: [{ name: 'p/1' }] });
    const ok = await probeV4({ ...api, env: {} });
    assert.deepEqual(
      { ok: ok.ok, gated: ok.gated, auth: ok.auth, count: ok.count, locationName: ok.locationName },
      { ok: true, gated: false, auth: false, count: 1, locationName: LOCATION },
    );
    const html = await probeV4({ ...gate(api, GATE), env: {} });
    assert.deepEqual({ ok: html.ok, gated: html.gated, status: html.status, bodyKind: html.bodyKind }, { ok: false, gated: true, status: 404, bodyKind: 'html' });
    const json = await probeV4({ ...gate(api, GATE, { body: JSON_404 }), env: {} });
    assert.deepEqual({ ok: json.ok, gated: json.gated, bodyKind: json.bodyKind }, { ok: false, gated: false, bodyKind: 'json' });
  });

  it('probeV4 never calls /v4/accounts; with GBP_ACCOUNT_ID + GBP_LOCATION_ID it makes only the gate call', async () => {
    const api = mockApi();
    await probeV4({ ...api, env: {} });
    assert.ok(api.calls.every((c) => noQuery(c.url) !== ACCOUNTS_V4), 'no /v4/accounts call');
    const direct = mockApi();
    const r = await probeV4({ ...direct, env: { GBP_ACCOUNT_ID: '111', GBP_LOCATION_ID: '222' } });
    assert.equal(r.ok, true);
    assert.equal(r.locationName, LOCATION);
    assert.equal(direct.calls.length, 1, 'no v1 lookup when both ids are set');
  });

  it('location pick among several: default title picks the match; an unmatched set is an error, never a guess', async () => {
    const two = (api) => ({
      ...api,
      gbpFetch: async (url, o) => (url.includes('/locations?readMask')
        ? { locations: [{ name: 'locations/333', title: 'Other Co' }, { name: 'locations/222', title: 'Grizzly Electrical Solutions' }] }
        : api.gbpFetch(url, o)),
    });
    const picked = await probeV4({ ...two(mockApi()), env: {} });
    assert.equal(picked.ok, true);
    assert.equal(picked.locationName, LOCATION);
    const none = await probeV4({ ...two(mockApi()), env: { GBP_LOCATION_TITLE: 'Nobody' } });
    assert.deepEqual({ ok: none.ok, stage: none.stage }, { ok: false, stage: 'resolve' });
    assert.match(none.error, /none match/);
  });
});
