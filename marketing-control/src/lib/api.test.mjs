import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapReadOnly,
  READ_ONLY,
  fetchRuns,
  fetchPosts,
  fetchWebsiteTasks,
  fetchRunLogs,
  fetchLatestRunHealth,
  fetchWorkerStatus,
} from './api.js';

describe('wrapReadOnly', () => {
  it('allows select on a fake', () => {
    let selected = false;
    const wrapped = wrapReadOnly({
      select() {
        selected = true;
        return 'ok';
      },
    });
    assert.equal(wrapped.select(), 'ok');
    assert.equal(selected, true);
  });

  it('throws READ_ONLY on insert/update/delete/upsert/rpc', () => {
    const wrapped = wrapReadOnly({});
    for (const method of ['insert', 'update', 'delete', 'upsert', 'rpc']) {
      assert.throws(() => wrapped[method], { message: READ_ONLY });
    }
  });

  it('from().insert on a fake client wrapped at top-level throws', () => {
    let inserted = false;
    const client = wrapReadOnly({
      from() {
        return {
          insert() {
            inserted = true;
            return 'wrote';
          },
          select() {
            return 'ok';
          },
        };
      },
    });
    assert.throws(() => client.from('x').insert(), { message: READ_ONLY });
    assert.equal(inserted, false);
    assert.equal(client.from('x').select(), 'ok');
  });
});

describe('fetchers without live supabase', () => {
  it('degrades to empty structures when not configured', async () => {
    assert.deepEqual(await fetchRuns(), []);
    assert.deepEqual(await fetchPosts('2026-08-10', '2026-08-16'), []);
    assert.deepEqual(await fetchWebsiteTasks(), []);
    assert.deepEqual(await fetchRunLogs(), []);
    assert.deepEqual(await fetchLatestRunHealth(), {
      run: null,
      posts: [],
      live: 'idle',
      bucket: 'incomplete',
    });
  });

  it('fetchWorkerStatus is unreachable when VITE_SEO_STATUS_URL is unset', async () => {
    assert.deepEqual(await fetchWorkerStatus(), { ok: false, unreachable: true });
  });
});
