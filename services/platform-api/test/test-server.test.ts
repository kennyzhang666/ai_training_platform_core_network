import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchSafeApplication, isFetchSafeTestUrl } from './test-server';

test('Fetch test servers discard blocked ephemeral ports before returning a URL', async () => {
  const urls = ['http://127.0.0.1:6000', 'http://127.0.0.1:49152'];
  const closed: string[] = [];
  let created = 0;
  const result = await createFetchSafeApplication(async () => {
    const url = urls[created++];
    return {
      async listen() {},
      async getUrl() { return url; },
      async close() { closed.push(url); },
    };
  });
  try {
    assert.equal(result.baseUrl, urls[1]);
    assert.deepEqual(closed, [urls[0]]);
    assert.equal(isFetchSafeTestUrl(urls[0]), false);
    assert.equal(isFetchSafeTestUrl(urls[1]), true);
  } finally {
    await result.app.close();
  }
});
