import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAdapters } from './adapters.js';

describe('deriveAdapters', () => {
  it('marks GBP worker when native-scheduled and nothing live', () => {
    const adapters = deriveAdapters({
      facebook: [],
      gbp: [{ id: '1', platform: 'gbp', status: 'scheduled_native' }],
      tasks: [],
      waitingOnOwner: [],
      runRecovery: [],
    });
    assert.equal(adapters.find((a) => a.id === 'gbp').status, 'worker');
  });

  it('marks GBP error when current-run recovery is on gbp', () => {
    const adapters = deriveAdapters({
      facebook: [],
      gbp: [{ id: '1', platform: 'gbp', status: 'error' }],
      tasks: [],
      waitingOnOwner: [],
      runRecovery: [{ id: '1', platform: 'gbp', status: 'error' }],
    });
    assert.equal(adapters.find((a) => a.id === 'gbp').status, 'error');
  });

  it('marks Facebook live_ready from Graph-scheduled posts', () => {
    const adapters = deriveAdapters({
      facebook: [{ id: 'f', platform: 'facebook', status: 'scheduled', platform_post_id: '123' }],
      gbp: [],
      tasks: [],
      waitingOnOwner: [],
      runRecovery: [],
    });
    assert.equal(adapters.find((a) => a.id === 'facebook').status, 'live_ready');
  });

  it('marks website live_ready when a task is done and nothing is failed', () => {
    const adapters = deriveAdapters({
      facebook: [],
      gbp: [],
      tasks: [{ id: 't', status: 'done' }],
      waitingOnOwner: [],
      runRecovery: [],
    });
    assert.equal(adapters.find((a) => a.id === 'website').status, 'live_ready');
  });
});
