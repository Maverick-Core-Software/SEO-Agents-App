// scripts/gbp-api-poster.test.mjs
// G2 idempotent create + G3 photo-rule guard for the GBP API poster. Every
// network call is injected (gbpFetch / getGbpAccessToken / fetchImpl), the
// workbook and config are temp files, and the selection manifest is a temp
// file under its own lock. Nothing here reaches Google or the real state/.
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
  SUMMARY_PREFIX_CHARS,
} from './gbp-api-poster.mjs';

const LOCATION = 'accounts/111/locations/222';
const DATE = '2026-10-16';
const CAPTION = 'Breakers tripping in Frisco? Our licensed electricians find the fault fast and fix it right the first time.';
const NOW = Date.parse('2026-10-16T14:05:00Z');

const tmpDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gbp-api-poster-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A workbook with one Approved row for DATE, plus a config pointing at it. */
function fixture({ caption = CAPTION, status = 'Approved', posted = false, imagePath = '' } = {}) {
  const dir = tmp('fx');
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
  return { dir, workbook, config };
}

/**
 * Mock GBP API: records every call; serves accounts/locations, the localPosts
 * list (as pages), create, GET-back, and media upload.
 */
function mockApi({ listed = [], pages = null, createdState = 'LIVE' } = {}) {
  const calls = [];
  const created = [];
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
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
  const getGbpAccessToken = async () => 'test-token';
  return { calls, created, gbpFetch, fetchImpl, getGbpAccessToken };
}

function run(args, api, extra = {}) {
  const emitted = [];
  const logs = [];
  return runPoster(
    { dryRun: false, ...args },
    { ...api, emit: (r) => emitted.push(r), log: (l) => logs.push(l), print: () => {}, now: () => NOW, env: {}, ...extra },
  ).then((code) => ({ code, emitted, logs, result: emitted[emitted.length - 1] }));
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
    const listCalls = api.calls.filter((c) => c.url.includes('localPosts?pageSize='));
    assert.equal(listCalls.length, 2);
    assert.ok(listCalls[1].url.includes('pageToken=tok-2'));
  });
});

describe('G2 idempotent create (runPoster with mocked API)', () => {
  let fx;
  before(() => { fx = fixture(); });

  it('a matching post within 7 days: no create, exit 0, already_live with the resource name', async () => {
    const api = mockApi({ listed: [
      { name: `${LOCATION}/localPosts/777`, summary: `${CAPTION}`, createTime: '2026-10-16T13:00:00Z', state: 'LIVE' },
    ] });
    const r = await run({ date: DATE, config: fx.config }, api);
    assert.equal(r.code, 0);
    assert.equal(r.result.result, 'already_live');
    assert.equal(r.result.status, 'already_live');
    assert.equal(r.result.name, `${LOCATION}/localPosts/777`);
    assert.equal(r.result.postUrl, `${LOCATION}/localPosts/777`, 'platform_post_id = resource name');
    assert.equal(api.created.length, 0, 'no POST localPosts');
  });

  it('no match: creates once and reports the resource name as postUrl', async () => {
    const api = mockApi({ listed: [
      { name: `${LOCATION}/localPosts/1`, summary: 'A different post from last week', createTime: '2026-10-15T13:00:00Z', state: 'LIVE' },
    ] });
    const r = await run({ date: DATE, config: fx.config }, api);
    assert.equal(r.code, 0, r.logs.join('\n'));
    assert.equal(r.result.result, 'posted');
    assert.equal(api.created.length, 1, 'exactly one create');
    assert.equal(r.result.postUrl, api.created[0].name);
    const listIdx = api.calls.findIndex((c) => c.url.includes('localPosts?pageSize='));
    const createIdx = api.calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/localPosts'));
    assert.ok(listIdx !== -1 && listIdx < createIdx, 'the list runs before the create');
  });

  it('a matching post Google REJECTED: exit 5 google_rejected, no create', async () => {
    const api = mockApi({ listed: [
      { name: `${LOCATION}/localPosts/9`, summary: CAPTION, createTime: '2026-10-16T13:00:00Z', state: 'REJECTED' },
    ] });
    const r = await run({ date: DATE, config: fx.config }, api);
    assert.equal(r.code, 5);
    assert.equal(r.result.result, 'policy_violation');
    assert.equal(r.result.reason, 'google_rejected');
    assert.equal(api.created.length, 0);
  });

  it('a listing failure propagates instead of creating blind', async () => {
    const api = mockApi();
    const failing = { ...api, gbpFetch: async (url, o) => (url.includes('localPosts?pageSize=') ? Promise.reject(new Error('503 list')) : api.gbpFetch(url, o)) };
    await assert.rejects(run({ date: DATE, config: fx.config }, failing), /503 list/);
    assert.equal(api.created.length, 0);
  });

  it('created but GET-back not LIVE: exit 3 still carries the resource name', async () => {
    const api = mockApi({ createdState: 'PROCESSING' });
    api.gbpFetch = ((orig) => async (url, o) => {
      if (url.includes('/localPosts/new-') && (o.method || 'GET') === 'GET') return { name: url.split('/v4/')[1], state: 'REJECTED' };
      return orig(url, o);
    })(api.gbpFetch);
    const r = await run({ date: DATE, config: fx.config }, api);
    assert.equal(r.code, 3);
    assert.equal(r.result.result, 'posted');
    assert.equal(r.result.verified, false);
    assert.equal(r.result.postUrl, api.created[0].name, 'exit 3 reports the name so the runner closes the workbook gate');
  });
});
