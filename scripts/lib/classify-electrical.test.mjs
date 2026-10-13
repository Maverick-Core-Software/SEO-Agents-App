// scripts/lib/classify-electrical.test.mjs
// P2.1 label-schema rejection. An injected fake transport stands in for the paid
// gpt-4o call, so this test never touches the endpoint, the network, or a photo
// library: the only thing under test is that malformed/unknown labels are rejected
// instead of being checkpointed into state/curated-labels.json.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateLabel, relabelCurated } from '../classify-electrical.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe('relabel-curated label schema (P2.1)', () => {
  it('rejects malformed and unknown labels instead of storing them', async () => {
    // Anti-vacuity: the same fixture must accept a valid label, so a "rejected
    // everything" bug cannot pass this test.
    assert.equal(validateLabel({
      service_type: 'panel', subtype: 'subpanel', tags: ['breaker-box'],
      what_is_visible: 'A labelled subpanel.', quality: 'ok', score: 88,
    }).ok, true);
    assert.equal(validateLabel({ service_type: 'panel', subtype: 'khaki-subpanel' }).reason, 'unknown_subtype');
    assert.equal(validateLabel({ service_type: 'roofing' }).reason, 'unknown_service_type');
    assert.equal(validateLabel({ service_type: 'panel', quality: 'vibes' }).reason, 'unknown_quality');
    assert.equal(validateLabel(null).reason, 'not_an_object');

    const replies = {
      [HASH_A]: { service_type: 'plumbing', quality: 'ok', score: 80, what_is_visible: 'A sink.', tags: [] },
      [HASH_B]: { service_type: 'wiring', subtype: 'conduit', quality: 'ok', score: 71, what_is_visible: '' , tags: [] },
      [HASH_C]: { service_type: 'ev-charger', quality: 'ok', score: 91, what_is_visible: 'A wall charger.', tags: ['level-2'] },
    };
    const transportCalls = [];
    const writes = [];
    const summary = await relabelCurated({
      items: [
        { file: 'C:/fixture/panel.jpg', sha256: HASH_A },
        { file: 'C:/fixture/blank.jpg', sha256: HASH_B },
        { file: 'C:/fixture/charger.jpg', sha256: HASH_C },
      ],
      transport: async ({ sha256 }) => { transportCalls.push(sha256); return { label: replies[sha256], model: 'gpt-4o-2024-11-20' }; },
      outPath: 'state/curated-labels.json',
      readLabels: () => ({}),
      writeLabels: (p, labels) => { writes.push(JSON.parse(JSON.stringify(labels))); },
      modelRequested: 'gpt-4o',
      now: () => new Date('2026-09-25T00:00:00Z'),
      log: () => {},
    });

    assert.equal(transportCalls.length, 3, 'every photo is attempted once');
    assert.equal(summary.rejected, 2, 'unknown service_type and a missing description are rejected');
    assert.equal(summary.added, 1, 'only the well-formed label is stored');
    const stored = writes.at(-1);
    assert.deepEqual(Object.keys(stored), [HASH_C], 'a rejected label is never checkpointed');
    assert.deepEqual(stored[HASH_C], {
      filenames: ['charger.jpg'],
      service_type: 'ev-charger',
      subtype: '',
      tags: ['level-2'],
      what_is_visible: 'A wall charger.',
      quality: 'ok',
      score: 91,
      model: 'gpt-4o',
      model_reported: 'gpt-4o-2024-11-20',
      date: '2026-09-25',
    });
  });
});
