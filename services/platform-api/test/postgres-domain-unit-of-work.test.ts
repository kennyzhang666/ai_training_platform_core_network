import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialExecutionQueue } from '../src/postgres-domain-unit-of-work';

test('the single-API PostgreSQL write queue serializes a one-hundred-request burst', async () => {
  const queue = new SerialExecutionQueue();
  let active = 0;
  let peak = 0;
  const completed: number[] = [];

  const values = await Promise.all(Array.from({ length: 100 }, (_, index) => queue.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    completed.push(index);
    active -= 1;
    return index;
  })));

  assert.equal(peak, 1);
  assert.deepEqual(completed, values);
  assert.deepEqual(values, Array.from({ length: 100 }, (_, index) => index));
});

test('a failed PostgreSQL write does not poison later queued requests', async () => {
  const queue = new SerialExecutionQueue();
  await assert.rejects(queue.run(async () => { throw new Error('expected failure'); }), /expected failure/);
  assert.equal(await queue.run(async () => 'next request committed'), 'next request committed');
});
