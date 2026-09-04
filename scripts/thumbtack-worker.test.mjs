import assert from 'node:assert/strict';
import test from 'node:test';

import { createThumbtackServer } from './thumbtack-worker.mjs';

test('health endpoint answers without a webhook secret', async () => {
  const server = createThumbtackServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/thumbtack/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(['ready', 'not-configured'].includes(body.state));
    assert.ok('lastEventAt' in body);
    assert.ok('outboundEnabled' in body);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
