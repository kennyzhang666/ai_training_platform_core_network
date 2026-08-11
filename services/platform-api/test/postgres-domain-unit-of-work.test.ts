import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { postgresTransactionTimeoutMs, runWithPostgresConflictRetry, SerialExecutionQueue } from '../src/postgres-domain-unit-of-work';
import { PrismaPlatformRepository } from '../src/prisma-platform-repository';
import { SnapshotRevisionConflictError } from '../src/postgres-platform-store';

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

test('a snapshot revision collision is retried without swallowing business conflicts', async () => {
  let attempts = 0;
  const value = await runWithPostgresConflictRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new SnapshotRevisionConflictError();
    return 'committed';
  }, { maxAttempts: 4, baseDelayMs: 0 });
  assert.equal(value, 'committed');
  assert.equal(attempts, 3);

  let businessAttempts = 0;
  await assert.rejects(runWithPostgresConflictRetry(async () => {
    businessAttempts += 1;
    throw new ConflictException('业务状态不允许该操作');
  }, { maxAttempts: 4, baseDelayMs: 0 }), /业务状态不允许/);
  assert.equal(businessAttempts, 1);
});

test('PostgreSQL transaction timeout configuration fails fast on invalid values', () => {
  assert.equal(postgresTransactionTimeoutMs({}), 120_000);
  assert.equal(postgresTransactionTimeoutMs({ PERSIST_TRANSACTION_TIMEOUT_MS: '45000' }), 45_000);
  assert.throws(() => postgresTransactionTimeoutMs({ PERSIST_TRANSACTION_TIMEOUT_MS: 'not-a-number' }), /PERSIST_TRANSACTION_TIMEOUT_MS/);
  assert.throws(() => postgresTransactionTimeoutMs({ PERSIST_TRANSACTION_TIMEOUT_MS: '500' }), /PERSIST_TRANSACTION_TIMEOUT_MS/);
});

test('the root PostgreSQL repository serializes concurrent identity transactions', async () => {
  let active = 0;
  let peak = 0;
  const transactionClient = {
    platformSnapshot: { upsert: async () => undefined },
  };
  const client = {
    ...transactionClient,
    $transaction: async <T>(operation: (db: typeof transactionClient) => Promise<T>) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        return await operation(transactionClient);
      } finally {
        active -= 1;
      }
    },
  } as unknown as PrismaClient;
  const repository = new PrismaPlatformRepository({ client });

  const values = await Promise.all(Array.from({ length: 100 }, (_, index) => repository.transaction(async () => index)));

  assert.equal(peak, 1);
  assert.deepEqual(values, Array.from({ length: 100 }, (_, index) => index));
  await repository.close();
});
