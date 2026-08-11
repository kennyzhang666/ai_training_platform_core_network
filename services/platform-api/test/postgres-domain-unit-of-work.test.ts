import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { postgresTransactionTimeoutMs, RevisionAwareStateCache, runWithPostgresConflictRetry, SerialExecutionQueue } from '../src/postgres-domain-unit-of-work';
import { PrismaPlatformRepository } from '../src/prisma-platform-repository';
import { mapSubmissionListItem } from '../src/prisma-domain-repository';
import { SnapshotRevisionConflictError } from '../src/postgres-platform-store';
import { compatibilitySnapshotState } from '../src/postgres-platform-store';

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

test('a PostgreSQL revision burst loads one canonical state and reuses it until the revision changes', async () => {
  const cache = new RevisionAwareStateCache<{ marker: string }>();
  let loads = 0;
  const load = async (revision: number) => {
    loads += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { revision, value: { marker: `revision-${revision}` } };
  };

  const firstBurst = await Promise.all(Array.from({ length: 100 }, () => cache.get(7, () => load(7))));
  assert.equal(loads, 1);
  assert.ok(firstBurst.every((value) => value.marker === 'revision-7'));

  assert.equal((await cache.get(7, () => load(7))).marker, 'revision-7');
  assert.equal(loads, 1);

  const nextBurst = await Promise.all(Array.from({ length: 20 }, () => cache.get(8, () => load(8))));
  assert.equal(loads, 2);
  assert.ok(nextBurst.every((value) => value.marker === 'revision-8'));
});

test('the PostgreSQL compatibility envelope excludes normalized business history', () => {
  const envelope = compatibilitySnapshotState({
    events: [{ id: 'event-large' }], submissions: [{ id: 'submission-large' }], runs: [], evaluationBatches: [],
    results: [{ resultId: 'result-large' }], orgUnits: [], users: [], challenges: [], seasons: [], audits: [{ id: 'audit-large' }],
    announcements: [], participants: [], hardProblems: [{ id: 'legacy-problem' }],
    codeAgentRuntimeConfig: { enabled: false }, localDemoSeedEnabled: false,
  } as never);

  assert.equal(envelope.events, undefined);
  assert.equal(envelope.submissions, undefined);
  assert.equal(envelope.results, undefined);
  assert.equal(envelope.audits, undefined);
  assert.deepEqual(envelope.hardProblems, [{ id: 'legacy-problem' }]);
  assert.equal(envelope.localDemoSeedEnabled, false);
});

test('PostgreSQL submission pages expose scores only after the result is published', () => {
  const row = {
    id: 'submission-summary', eventId: 'event-summary', subjectId: 'employee-summary',
    sourceType: 'UPLOAD', snapshotHash: 'a'.repeat(64), submittedAt: new Date('2026-08-01T10:00:00Z'),
    state: 'SEALED', createdAt: new Date('2026-08-01T10:00:00Z'), gradingStatus: 'COMPLETED', gradingAttempt: 1,
    currentGradingRunId: 'run-summary', currentResultId: 'result-summary', gradingRuns: [{ id: 'run-summary' }],
    results: [{ id: 'result-summary', total: 88.5, status: 'COMPLETE' }], event: { reveal: 'ON_RELEASE' },
  };
  assert.equal(mapSubmissionListItem(row).resultSummary, undefined);
  assert.deepEqual(mapSubmissionListItem({ ...row, state: 'REVEALED' }).resultSummary, {
    resultId: 'result-summary', total: 88.5, status: 'COMPLETE', published: true,
  });
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

test('wrapped PostgreSQL deadlocks and serialization failures are retried', async () => {
  for (const databaseError of [
    'ConnectorError: PostgresError { code: "40P01", message: "deadlock detected" }',
    'ConnectorError: PostgresError { code: "40001", message: "could not serialize access due to concurrent update" }',
  ]) {
    let attempts = 0;
    const value = await runWithPostgresConflictRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(databaseError);
      return 'committed';
    }, { maxAttempts: 2, baseDelayMs: 0 });
    assert.equal(value, 'committed');
    assert.equal(attempts, 2);
  }
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
  const transactionOrder: string[] = [];
  const transactionClient = {
    platformSnapshot: { upsert: async () => { transactionOrder.push('revision'); } },
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

  const values = await Promise.all(Array.from({ length: 100 }, (_, index) => repository.transaction(async () => {
    transactionOrder.push(`work-${index}`);
    return index;
  })));

  assert.equal(peak, 1);
  assert.deepEqual(values, Array.from({ length: 100 }, (_, index) => index));
  assert.deepEqual(transactionOrder.slice(0, 2), ['revision', 'work-0']);
  await repository.close();
});
