import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_CONSOLE_TOKEN_FILE_DEFAULT,
  explainSearchConsoleError,
  pickGrizzlyProperty,
  dateRange,
  formatQueryRows,
} from './search-console.mjs';

function gbpFetchError(status, body) {
  const e = new Error(`GBP API Error [${status}]: ${body}`);
  e.status = status;
  e.body = body;
  return e;
}

describe('explainSearchConsoleError', () => {
  it('missing token file → run authorize', () => {
    const e = new Error('GBP token file not found at: C:/x.json. Run setup_account.py grizzly1 first.');
    assert.equal(explainSearchConsoleError(e), 'run node scripts/authorize-search-console.mjs');
  });
  it('HTTP 401 → token rejected', () => {
    assert.equal(explainSearchConsoleError(gbpFetchError(401, 'unauthorized')), 'token rejected; re-run authorize');
  });
  it('HTTP 403 accessNotConfigured → enable API', () => {
    const body = '{"error":{"code":403,"errors":[{"reason":"accessNotConfigured"}]}}';
    assert.equal(explainSearchConsoleError(gbpFetchError(403, body)), 'enable the Google Search Console API in project exalted-slice-502415-s0');
  });
  it('HTTP 403 SERVICE_DISABLED → enable API', () => {
    assert.equal(explainSearchConsoleError(gbpFetchError(403, '{"error":{"errors":[{"reason":"SERVICE_DISABLED"}]}}')), 'enable the Google Search Console API in project exalted-slice-502415-s0');
  });
  it('HTTP 403 insufficient → token lacks scope', () => {
    const body = '{"error":{"code":403,"message":"Request had insufficient authentication scopes."}}';
    assert.equal(explainSearchConsoleError(gbpFetchError(403, body)), 'token lacks webmasters.readonly; re-run authorize');
  });
  it('HTTP 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT → token lacks scope', () => {
    assert.equal(explainSearchConsoleError(gbpFetchError(403, '{"error":{"errors":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}')), 'token lacks webmasters.readonly; re-run authorize');
  });
  it('HTTP 403 otherwise → not a user on the property', () => {
    assert.equal(explainSearchConsoleError(gbpFetchError(403, '{"error":{"code":403,"message":"forbidden"}}')), 'this Google account is not a user on the Search Console property; add it under Settings > Users and permissions');
  });
  it('HTTP 404 → property not found', () => {
    assert.equal(explainSearchConsoleError(gbpFetchError(404, 'not found')), 'property not found for this account');
  });
  it('anything else → the error message', () => {
    assert.equal(explainSearchConsoleError(new Error('network down')), 'network down');
  });
});

describe('pickGrizzlyProperty', () => {
  const sites = [
    { siteUrl: 'https://someother.com/', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://www.grizzlyelectricaltx.com/', permissionLevel: 'siteRestrictedUser' },
    { siteUrl: 'sc-domain:grizzlyelectricaltx.com', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://grizzlyelectricaltx.com/', permissionLevel: 'siteOwner' },
  ];
  it('prefers sc-domain when all three present', () => {
    assert.deepEqual(pickGrizzlyProperty(sites), { siteUrl: 'sc-domain:grizzlyelectricaltx.com', permissionLevel: 'siteFullUser' });
  });
  it('falls back to https://www when sc-domain absent', () => {
    const rest = sites.filter((s) => s.siteUrl !== 'sc-domain:grizzlyelectricaltx.com');
    assert.deepEqual(pickGrizzlyProperty(rest), { siteUrl: 'https://www.grizzlyelectricaltx.com/', permissionLevel: 'siteRestrictedUser' });
  });
  it('falls back to bare https when only that is present', () => {
    const bare = sites.filter((s) => s.siteUrl === 'https://grizzlyelectricaltx.com/');
    assert.deepEqual(pickGrizzlyProperty(bare), { siteUrl: 'https://grizzlyelectricaltx.com/', permissionLevel: 'siteOwner' });
  });
  it('returns null when no Grizzly property present (and for empty input)', () => {
    assert.equal(pickGrizzlyProperty([{ siteUrl: 'https://other.com/', permissionLevel: 'siteFullUser' }]), null);
    assert.equal(pickGrizzlyProperty([]), null);
    assert.equal(pickGrizzlyProperty(undefined), null);
  });
});

describe('dateRange', () => {
  it('ends 2 days before now and spans the requested days', () => {
    // 2026-09-10 local noon.
    const now = new Date(2026, 8, 10, 12, 0, 0);
    assert.deepEqual(dateRange(7, now), { startDate: '2026-09-02', endDate: '2026-09-08' });
  });
  it('single day collapses start to end', () => {
    const now = new Date(2026, 8, 10, 0, 0, 0);
    assert.deepEqual(dateRange(1, now), { startDate: '2026-09-08', endDate: '2026-09-08' });
  });
  it('crosses a month boundary', () => {
    const now = new Date(2026, 8, 1, 0, 0, 0); // Sep 1 → end Aug 30, start Aug 24 for 7 days
    assert.deepEqual(dateRange(7, now), { startDate: '2026-08-24', endDate: '2026-08-30' });
  });
});

describe('formatQueryRows', () => {
  const rows = [
    { keys: ['a'], clicks: 5, impressions: 500, ctr: 0.05, position: 3.4 },
    { keys: ['b'], clicks: 5, impressions: 900, ctr: 0.1234, position: 4.567 },
    { keys: ['c'], clicks: 20, impressions: 2000, ctr: 0.01, position: 1 },
  ];
  it('sorts by clicks then impressions descending and formats ctr/position', () => {
    assert.deepEqual(formatQueryRows(rows), [
      { query: 'c', clicks: 20, impressions: 2000, ctr: '1.0%', position: '1.0' },
      { query: 'b', clicks: 5, impressions: 900, ctr: '12.3%', position: '4.6' },
      { query: 'a', clicks: 5, impressions: 500, ctr: '5.0%', position: '3.4' },
    ]);
  });
  it('is empty for empty input and does not mutate the input', () => {
    const copy = [...rows];
    assert.deepEqual(formatQueryRows([]), []);
    assert.deepEqual(formatQueryRows(undefined), []);
    assert.deepEqual(rows, copy);
  });
});

describe('SEARCH_CONSOLE_TOKEN_FILE_DEFAULT', () => {
  it('points at the grizzly search-console token', () => {
    assert.equal(SEARCH_CONSOLE_TOKEN_FILE_DEFAULT, 'C:/Users/carte/gmail-multi/tokens/grizzly-search-console.json');
  });
});
