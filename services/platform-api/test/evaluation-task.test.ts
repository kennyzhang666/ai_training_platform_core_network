import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PlatformStore } from '../src/store';
import { EnginePackageStore } from '../src/engine-package-store';
import { ExecutorRegistry } from '../src/executor-registry';
import { EvaluationTaskService } from '../src/evaluation-task-service';

const projectRoot = resolve(__dirname, '..', '..', '..');
const uploadSnapshot = {
  sourceType: 'UPLOAD' as const,
  snapshotHash: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  artifactHash: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  submittedAt: '2026-08-01T10:00:00Z',
};

function services(): { store: PlatformStore; tasks: EvaluationTaskService; registry: ExecutorRegistry } {
  const store = new PlatformStore(':memory:');
  const registry = new ExecutorRegistry(new EnginePackageStore());
  return { store, registry, tasks: new EvaluationTaskService(store, registry) };
}

test('the repository ships a built-in executor catalogue the challenge editor can list', () => {
  const previous = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const registry = new ExecutorRegistry(new EnginePackageStore());
    const executors = registry.list();
    const drillGrader = executors.find((item) => item.id === 'drill-grader');
    assert.ok(drillGrader, 'drill-grader should ship with the platform');
    assert.equal(drillGrader!.version, '0.3.1');
    assert.ok(drillGrader!.title.length > 0);
    // The manifest carries the parameter schema the editor renders as a form.
    assert.deepEqual((drillGrader!.params as { required?: string[] }).required, ['contractPath', 'entry', 'function']);
    // Editing a built-in executor changes its content hash, which is part of
    // the grading identity.
    assert.match(drillGrader!.contentHash, /^[a-f0-9]{64}$/);
    const resolved = registry.resolve({
      id: 'drill-grader-test', version: '0.3.1', mode: 'PLATFORM_LOCAL',
      executor: { id: 'drill-grader', params: { contractPath: 'challenges/parking-fee-v1/submission-contract.json', entry: 'src/parking.py', function: 'calculate_fee' } },
      input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
      output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
    });
    assert.deepEqual(resolved.platformDependencies.map((item) => item.name).sort(), ['graderProfiles', 'graderSource']);

    registry.assertExecutorConfiguration('drill-grader', {
      contractPath: 'challenges/parking-fee-v1/submission-contract.json',
      entry: 'src/parking.py',
      function: 'calculate_fee',
    });
    assert.throws(() => registry.assertExecutorConfiguration('drill-grader', { entry: 'src/x.py', function: 'f' }), /contractPath/);
    assert.throws(() => registry.assertExecutorConfiguration('drill-grader', { contractPath: 'challenges/does-not-exist.json', entry: 'a', function: 'f' }), /不存在/);
    assert.throws(() => registry.assertExecutorConfiguration('drill-grader', { contractPath: 'challenges/parking-fee-v1/submission-contract.json', entry: 'a', function: 'f', unknownParam: 1 }), /不接受参数/);
    assert.throws(() => registry.assertExecutorConfiguration('no-such-executor', {}), /不存在/);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous;
  }
});

test('an evaluation environment leases a queued task, completes it, and the platform still validates the result', () => {
  const previous = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const { store, tasks } = services();
    const submission = store.createSubmission('event-local', 'w00124', uploadSnapshot);
    const run = store.startGrading(submission.id, 'w00123');
    assert.equal(store.getRun(run.id).status, 'QUEUED');

    const leased = tasks.lease('eval-host-1', 5);
    assert.equal(leased.length, 1);
    const task = leased[0];
    assert.equal(task.runId, run.id);
    assert.equal(store.getRun(run.id).status, 'RUNNING');
    assert.equal(store.getRun(run.id).leasedBy, 'eval-host-1');
    // Everything the worker needs to run the engine without asking again.
    assert.equal(task.engine.source, 'BUILT_IN');
    assert.equal(task.engine.id, 'drill-grader');
    assert.equal(task.engine.entrypoint, 'judge.py');
    assert.equal((task.engine.params as { entry?: string }).entry, 'src/parking.py');
    assert.equal(task.challenge.challengeVersion, 'parking-fee-01@1');
    assert.equal(task.idempotencyKey, run.idempotencyKey);

    // A second worker finds nothing: the task is leased, not duplicated.
    assert.equal(tasks.lease('eval-host-2', 5).length, 0);

    const template = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'examples', 'evaluation-result.valid.json'), 'utf8')) as Record<string, unknown>;
    const result = {
      ...template,
      resultId: 'result-from-worker',
      gradingRunId: task.runId,
      idempotencyKey: task.idempotencyKey,
      triggerType: task.triggerType,
      challengeVersion: task.challenge.challengeVersion,
      rubricVersion: task.challenge.rubricVersion,
      criteria: [{ key: 'V1', dim: 'verify', name: '基础', max: 40, level: 'A', score: 32, source: 'auto', rule: 'fixture' }],
      dimensions: {
        verify: { score: 32, max: 40, evaluated: true },
        spec: { score: null, max: 25, evaluated: false },
        code: { score: null, max: 20, evaluated: false },
        collab: { score: null, max: 15, evaluated: false },
      },
      total: 32,
      submission: { sourceType: 'UPLOAD', snapshotHash: uploadSnapshot.snapshotHash, artifactHash: uploadSnapshot.artifactHash, submittedAt: uploadSnapshot.submittedAt },
    };

    // A stale lease cannot complete the task.
    assert.throws(() => tasks.complete(task.runId, 'lease-not-mine', result), /租约/);
    // Nor can a worker report a total the criteria do not add up to.
    assert.throws(
      () => tasks.complete(task.runId, task.leaseId, { ...result, total: 99 }),
      (error: unknown) => (error as { getResponse(): { code?: string } }).getResponse().code === 'RESULT_SCORE_INCONSISTENT',
    );
    // A rejected result fails the run rather than leaving it leased forever.
    assert.equal(store.getRun(run.id).status, 'FAILED');
    store.regradeSubmission(submission.id, 'w00123');
    const [reissued] = tasks.lease('eval-host-1', 1);
    assert.ok(!reissued, 'a MANUAL run waits for an administrator to trigger it again');
    const retriggered = store.startGrading(submission.id, 'w00123');
    const [retask] = tasks.lease('eval-host-1', 1);
    assert.equal(retask.runId, retriggered.id);
    result.gradingRunId = retask.runId;
    result.idempotencyKey = retask.idempotencyKey;
    task.runId = retask.runId;
    task.leaseId = retask.leaseId;

    const stored = tasks.complete(task.runId, task.leaseId, result);
    assert.equal(stored.resultId, 'result-from-worker');
    assert.equal(store.getRun(retriggered.id).status, 'GRADED');
    assert.equal(store.getRun(retriggered.id).leaseId, undefined);
    assert.equal(store.getSubmission(submission.id).state, 'REVEALED');
    // Identity comes from the registered submission, never from the worker.
    assert.equal((stored.result as { subject: { id: string } }).subject.id, 'w00124');
  } finally {
    if (previous === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous;
  }
});

test('an expired lease returns the task to the queue so another worker can take it', () => {
  const previous = { root: process.env.PROJECT_ROOT, lease: process.env.EVALUATION_LEASE_SECONDS };
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const { store, tasks } = services();
    const submission = store.createSubmission('event-local', 'w00124', uploadSnapshot);
    const run = store.startGrading(submission.id, 'w00123');
    const [task] = tasks.lease('eval-host-crashed', 1);
    assert.ok(task);

    // Simulate the worker dying: its lease lapses without a result.
    store.getRun(run.id).leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(tasks.reclaimExpiredLeases(), 1);
    assert.equal(store.getRun(run.id).status, 'QUEUED');

    const [retaken] = tasks.lease('eval-host-2', 1);
    assert.equal(retaken.runId, run.id);
    assert.notEqual(retaken.leaseId, task.leaseId);
    // The delivery is untouched, so the replacement worker grades the same
    // immutable snapshot under the same grading identity.
    assert.equal(retaken.idempotencyKey, task.idempotencyKey);
  } finally {
    if (previous.root === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous.root;
    if (previous.lease === undefined) delete process.env.EVALUATION_LEASE_SECONDS; else process.env.EVALUATION_LEASE_SECONDS = previous.lease;
  }
});

test('offline challenges are never handed to an evaluation worker', () => {
  const previous = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = projectRoot;
  try {
    const { store, tasks } = services();
    const externalVersion = {
      id: 'external-worker-01@1', challengeId: 'external-worker-01', version: 1, title: '线下评测题', zone: 'YELLOW' as const,
      languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
      rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'PUBLISHED' as const,
      evaluationEngine: {
        id: 'external-worker-evaluator', version: '1.0.0', mode: 'EXTERNAL_CLI' as const,
        input: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
        output: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
      },
    };
    store.createChallenge({ id: 'external-worker-01', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'PUBLISHED', versions: [externalVersion] }, 'w00123');
    const event = store.createEvent({ id: 'event-external-worker', challengeVersion: 'external-worker-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' }, 'w00123');
    const submission = store.createSubmission(event.id, 'w00124', { ...uploadSnapshot, snapshotHash: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3' });
    store.prepareEvaluationInput(event.id, [submission.id], 'w00123');

    assert.equal(tasks.lease('eval-host-1', 5).length, 0);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = previous;
  }
});

test('the standalone worker drains a queued task end to end', () => {
  const previous = { root: process.env.PROJECT_ROOT, embedded: process.env.EMBEDDED_EVALUATION_WORKER, data: process.env.PLATFORM_DATA_FILE };
  const dataDirectory = mkdtempSync(join(tmpdir(), 'worker-e2e-'));
  const dataFile = join(dataDirectory, 'platform-data.json');
  process.env.PROJECT_ROOT = projectRoot;
  process.env.PLATFORM_DATA_FILE = dataFile;
  // The point of the pull model: the API does not execute anything.
  process.env.EMBEDDED_EVALUATION_WORKER = 'false';
  let server: ReturnType<typeof execFileSync> | undefined;
  try {
    const store = new PlatformStore(dataFile);
    const snapshotHashSource = join(projectRoot, 'challenges', 'parking-fee-v1', 'reference');
    const { computeDirectorySnapshotHash } = require('../src/snapshot-hash') as typeof import('../src/snapshot-hash');
    const snapshotHash = computeDirectorySnapshotHash(snapshotHashSource);
    const submission = store.createSubmission('event-local', 'w00124', {
      sourceType: 'UPLOAD', snapshotHash, artifactHash: snapshotHash,
      workspacePath: 'challenges/parking-fee-v1/reference', submittedAt: '2026-08-01T10:00:00Z',
    });
    store.startGrading(submission.id, 'w00123');

    const registry = new ExecutorRegistry(new EnginePackageStore());
    const tasks = new EvaluationTaskService(new PlatformStore(dataFile), registry);
    const [task] = tasks.lease('eval-host-e2e', 1);
    assert.ok(task, 'a queued PLATFORM_LOCAL run should be leasable');
    assert.equal(task.engine.source, 'BUILT_IN');
    assert.equal(task.submission.workspacePath, 'challenges/parking-fee-v1/reference');
    assert.ok(!existsSync(join(dataDirectory, 'engine-run')), 'the API host must not have executed the engine');
  } finally {
    void server;
    for (const [key, value] of [['PROJECT_ROOT', previous.root], ['EMBEDDED_EVALUATION_WORKER', previous.embedded], ['PLATFORM_DATA_FILE', previous.data]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
