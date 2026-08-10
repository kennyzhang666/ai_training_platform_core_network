import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchSafeApplication, isFetchSafeTestUrl } from './test-server';

test('Fetch test servers request a safe port and retry an occupied candidate', async () => {
  const requestedPorts: number[] = [];
  const closed: number[] = [];
  let created = 0;
  const result = await createFetchSafeApplication(async () => {
    const instance = created++;
    let port = 0;
    return {
      async listen(requestedPort: number) {
        port = requestedPort;
        requestedPorts.push(requestedPort);
        if (instance === 0) throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
      },
      async getUrl() { return `http://127.0.0.1:${port}`; },
      async close() { closed.push(instance); },
    };
  });
  try {
    assert.equal(requestedPorts.length, 2);
    assert.ok(requestedPorts.every((port) => port >= 11_000 && port <= 65_535));
    assert.notEqual(requestedPorts[0], requestedPorts[1]);
    assert.deepEqual(closed, [0]);
    assert.equal(isFetchSafeTestUrl(result.baseUrl), true);
  } finally {
    await result.app.close();
  }
});
