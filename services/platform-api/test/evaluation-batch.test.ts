import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PlatformStore } from '../src/store';
import { EnginePackageStore } from '../src/engine-package-store';
import { ExecutorRegistry } from '../src/executor-registry';
import { evaluationBatchLeaseLimit, evaluationBatchLeaseSeconds, EvaluationBatchService } from '../src/evaluation-batch-service';

const projectRoot = resolve(__dirname, '..', '..', '..');

test('evaluation batch lease settings reject malformed deployment values', () => {
  assert.equal(evaluationBatchLeaseLimit({}), 5);
  assert.equal(evaluationBatchLeaseLimit({ EVALUATION_BATCH_LEASE_MAX: '2' }), 2);
  assert.throws(() => evaluationBatchLeaseLimit({ EVALUATION_BATCH_LEASE_MAX: 'invalid' }), /EVALUATION_BATCH_LEASE_MAX/);
  assert.equal(evaluationBatchLeaseSeconds({}), 1800);
  assert.equal(evaluationBatchLeaseSeconds({ EVALUATION_BATCH_LEASE_SECONDS: '900' }), 900);
  assert.throws(() => evaluationBatchLeaseSeconds({ EVALUATION_BATCH_LEASE_SECONDS: '0' }), /EVALUATION_BATCH_LEASE_SECONDS/);
});

function resultFor(task: ReturnType<EvaluationBatchService['lease']>[number], index: number): Record<string, unknown> {
  const item = task.submissions[index];
  const fixture = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'examples', 'evaluation-result.valid.json'), 'utf8')) as Record<string, unknown>;
  return {
    ...fixture,
    resultId: `batch-result-${index}`,
    gradingRunId: item.runId,
    idempotencyKey: item.idempotencyKey,
    triggerType: item.triggerType,
    challengeVersion: task.challenge.challengeVersion,
    rubricVersion: task.challenge.rubricVersion,
    submission: {
      sourceType: item.submission.sourceType,
      snapshotHash: item.submission.snapshotHash,
      artifactHash: item.submission.artifactHash,
      submittedAt: item.submission.submittedAt,
    },
  };
}

test('one Code Agent lease preserves an administrator-selected multi-person batch', () => {
  const previous = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const store = new PlatformStore(':memory:');
    const registry = new ExecutorRegistry(new EnginePackageStore());
    const batches = new EvaluationBatchService(store, registry);
    const first = store.createSubmission('event-local', 'w00124', { sourceType: 'UPLOAD', snapshotHash: '1'.repeat(64), artifactHash: 'a'.repeat(64), submittedAt: '2026-08-01T10:00:00Z' });
    const second = store.createSubmission('event-local', 'w00125', { sourceType: 'UPLOAD', snapshotHash: '2'.repeat(64), artifactHash: 'b'.repeat(64), submittedAt: '2026-08-01T10:01:00Z' });
    const third = store.createSubmission('event-local', 'w00126', { sourceType: 'UPLOAD', snapshotHash: '3'.repeat(64), artifactHash: 'c'.repeat(64), submittedAt: '2026-08-01T10:02:00Z' });
    const runs = store.startEventGrading('event-local', 'w00123', [first.id, second.id]);
    const batch = batches.create(runs.map((run) => run.id), 'w00123');
    assert.deepEqual(batch.submissionIds, [first.id, second.id]);
    assert.ok(!batch.submissionIds.includes(third.id));

    const [task] = batches.lease('code-agent-host-1', 1);
    assert.equal(task.batchId, batch.id);
    assert.deepEqual(task.submissions.map((item) => item.submission.id), [first.id, second.id]);
    assert.equal(task.engine.agent.instruction, 'instruction.md');
    assert.deepEqual(task.engine.agent.skills, ['skills/evaluation']);
    assert.equal(task.contracts.input.contractPath, 'contracts/evaluation-agent-batch-v1.1.schema.json');
    assert.equal(task.contracts.output.contractPath, 'contracts/evaluation-result.schema.json');
    assert.equal(store.getEvaluationBatch(batch.id).status, 'RUNNING');

    const completed = batches.complete(task.batchId, task.leaseId, [
      { runId: task.submissions[0].runId, result: resultFor(task, 0) },
    ], [{ runId: task.submissions[1].runId, reason: '交付件无法执行隐藏测试' }]);
    assert.equal(completed.batch.status, 'PARTIAL');
    assert.equal(completed.accepted.length, 1);
    assert.equal(completed.rejected.length, 1);
    assert.equal(store.getSubmission(first.id).gradingStatus, 'COMPLETED');
    assert.equal(store.getSubmission(second.id).gradingStatus, 'FAILED');

    assert.throws(
      () => batches.complete(task.batchId, 'stale-or-forged-lease', [], []),
      /租约|凭据/,
    );

    // A network retry of the same completion call returns the frozen outcome.
    const retried = batches.complete(task.batchId, task.leaseId, [], []);
    assert.equal(retried.batch.status, 'PARTIAL');
    assert.equal(retried.accepted.length, 1);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous;
  }
});

test('an expired batch lease returns every unfinished run to the queue together', () => {
  const previous = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const store = new PlatformStore(':memory:');
    const batches = new EvaluationBatchService(store, new ExecutorRegistry(new EnginePackageStore()));
    const submission = store.createSubmission('event-local', 'w00124', { sourceType: 'UPLOAD', snapshotHash: '4'.repeat(64), artifactHash: 'd'.repeat(64), submittedAt: '2026-08-01T10:00:00Z' });
    const run = store.startGrading(submission.id, 'w00123');
    const batch = batches.create([run.id], 'w00123');
    batches.lease('crashed-worker', 1);
    store.getEvaluationBatch(batch.id).leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(batches.reclaimExpiredLeases(), 1);
    assert.equal(store.getEvaluationBatch(batch.id).status, 'QUEUED');
    assert.equal(store.getRun(run.id).status, 'QUEUED');
    assert.equal(batches.lease('replacement-worker', 1)[0].batchId, batch.id);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous;
  }
});

test('a resumed batch preserves results persisted before a worker callback interruption', () => {
  const previous = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const store = new PlatformStore(':memory:');
    const batches = new EvaluationBatchService(store, new ExecutorRegistry(new EnginePackageStore()));
    const first = store.createSubmission('event-local', 'w00124', { sourceType: 'UPLOAD', snapshotHash: '5'.repeat(64), artifactHash: 'e'.repeat(64), submittedAt: '2026-08-01T10:00:00Z' });
    const second = store.createSubmission('event-local', 'w00125', { sourceType: 'UPLOAD', snapshotHash: '6'.repeat(64), artifactHash: 'f'.repeat(64), submittedAt: '2026-08-01T10:01:00Z' });
    const runs = store.startEventGrading('event-local', 'w00123', [first.id, second.id]);
    const batch = batches.create(runs.map((run) => run.id), 'w00123');
    const initialTask = batches.lease('interrupted-worker', 1)[0];

    // Simulate a process interruption after one idempotent result write but
    // before the batch terminal state could be persisted.
    store.completeRun(initialTask.submissions[0].runId, resultFor(initialTask, 0));
    store.getEvaluationBatch(batch.id).leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(batches.reclaimExpiredLeases(), 1);

    const resumedTask = batches.lease('replacement-worker', 1)[0];
    assert.deepEqual(resumedTask.submissions.map((item) => item.runId), [initialTask.submissions[1].runId]);
    const resumedResult = { ...resultFor(resumedTask, 0), resultId: 'batch-result-resumed' };
    const completed = batches.complete(resumedTask.batchId, resumedTask.leaseId, [{ runId: resumedTask.submissions[0].runId, result: resumedResult }]);
    assert.equal(completed.batch.status, 'COMPLETED');
    assert.equal(completed.accepted.length, 2);
    assert.deepEqual(new Set(completed.batch.completedRunIds), new Set(runs.map((run) => run.id)));
  } finally {
    if (previous === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous;
  }
});
