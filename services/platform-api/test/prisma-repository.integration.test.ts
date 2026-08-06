import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PrismaPlatformRepository } from '../src/prisma-platform-repository';
import { createPlatformStore } from '../src/postgres-platform-store';
import { PrismaUploadSessionPersistence } from '../src/prisma-upload-session-persistence';
import { PlatformReadService } from '../src/platform-read-service';
import { Challenge, EventConfig, EvaluationBatch, GradingRun, SubmissionRecord } from '../src/domain';

const enabled = process.env.POSTGRES_INTEGRATION === 'true';
const databaseUrl = process.env.DATABASE_URL?.trim();

test('PostgreSQL integration requires an explicit opt-in and DATABASE_URL', { skip: enabled && Boolean(databaseUrl) ? false : 'set POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL integration tests' }, async () => {
  assert.equal(enabled, true);
  assert.ok(databaseUrl);

  // The integration command is intentionally migration-first. It never uses
  // `prisma db push`, so the test exercises the same schema history as a
  // deployment. CI should point DATABASE_URL at an isolated database.
  const migrationCommand = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm';
  const migrationArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'pnpm exec prisma migrate deploy']
    : ['exec', 'prisma', 'migrate', 'deploy'];
  execFileSync(migrationCommand, migrationArgs, {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  const client = new PrismaClient();
  const repository = new PrismaPlatformRepository({ client });
  const suffix = `${process.pid}-${Date.now()}`;
  const orgId = `it-org-${suffix}`;
  const employeeNo = `it-${String(Date.now()).slice(-10)}`;
  const userId = `it-user-${suffix}`;
  const auditId = `it-audit-${suffix}`;
  const challengeId = `it-challenge-${suffix}`;
  const versionId = `it-challenge-version-${suffix}`;
  const eventId = `it-event-${suffix}`;
  const submissionId = `it-submission-${suffix}`;
  const runId = `it-run-${suffix}`;
  const batchId = `it-batch-${suffix}`;
  const resultId = `it-result-${suffix}`;
  const uploadSessionId = `it-upload-${suffix}`;
  const adminId = `it-admin-${suffix}`;
  const casOrgA = `it-cas-a-${suffix}`;
  const casOrgB = `it-cas-b-${suffix}`;
  const duplicateRootId = `it-root-duplicate-${suffix}`;
  const raceEmployeeNo = `it-race-user-${suffix}`;
  const raceRootA = `it-race-root-a-${suffix}`;
  const raceRootB = `it-race-root-b-${suffix}`;
  const raceSubmissionId = `it-race-submission-${suffix}`;
  const raceRunA = `it-race-run-a-${suffix}`;
  const raceRunB = `it-race-run-b-${suffix}`;
  const raceBatchId = `it-race-batch-${suffix}`;
  const raceResultId = `it-race-result-${suffix}`;
  let uploadPersistence: PrismaUploadSessionPersistence | undefined;
  let restartedUploadPersistence: PrismaUploadSessionPersistence | undefined;
  let readService: PlatformReadService | undefined;
  const previousMode = process.env.PLATFORM_REPOSITORY;
  try {
    const result = await repository.transaction(async (transaction) => {
      const org = await transaction.organizations.create({ id: orgId, parentId: undefined, path: `/it-${suffix}/`, level: 1, label: 'IT', name: 'Integration' });
      const identity = await transaction.users.syncSsoIdentity({ employeeNo, name: 'Integration User', department: org.path });
      const updated = await transaction.users.update(identity.user.id, { roles: ['learner', 'mentor'], roleBindings: [{ role: 'mentor', scopeOrgPath: org.path }] });
      const audit = await transaction.audits.append({ id: auditId, actorId: userId, action: 'integration.user.update', target: `user:${identity.user.id}`, before: identity.user, after: updated, createdAt: new Date().toISOString() });
      const page = await transaction.users.list({ page: 1, pageSize: 10, orgPath: org.path, sortBy: 'employeeNo', sortOrder: 'asc' });
      return { org, identity, updated, audit, page };
    });

    assert.equal(result.identity.firstLogin, true);
    assert.equal(result.identity.user.orgPath, result.org.path);
    assert.deepEqual(result.updated.roles, ['learner', 'mentor']);
    assert.equal(result.audit.id, auditId);
    assert.equal(result.page.items.some((item) => item.employeeNo === employeeNo), true);
    await assert.rejects(
      repository.organizations.create({ id: duplicateRootId, path: `/duplicate-${suffix}/`, level: 0, label: 'IT', name: 'Integration' }),
      /duplicate sibling name/,
    );

    const challenge: Challenge = {
      id: challengeId,
      ownerOrgPath: result.org.path,
      origin: 'IMPORTED',
      category: 'TRAINING',
      status: 'DRAFT',
      versions: [{
        id: versionId,
        challengeId: challengeId,
        version: 1,
        title: 'Integration challenge',
        zone: 'YELLOW',
        languagePolicy: {},
        deliveryPolicy: {},
        rubricVersion: '1.0',
        submissionContract: 'contracts/submission.schema.json',
        status: 'DRAFT',
      }],
    };
    const event: EventConfig = {
      id: eventId,
      challengeVersion: versionId,
      submissionSource: 'UPLOAD',
      trigger: 'MANUAL',
      reveal: 'IMMEDIATE',
      status: 'OPEN',
      mode: 'WINDOW',
      deliveryConfig: { allowedFormats: ['zip'], maxBytes: 1024 },
    };
    const submission: SubmissionRecord = {
      id: submissionId,
      eventId,
      subjectId: result.identity.user.id,
      orgPathSnapshot: result.org.path,
      snapshot: { sourceType: 'UPLOAD', snapshotHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64), artifactUri: 'local://placeholder', submittedAt: new Date().toISOString() },
      challengeVersionSnapshot: versionId,
      rubricVersionSnapshot: '1.0',
      state: 'QUEUED',
      createdAt: new Date().toISOString(),
      gradingStatus: 'QUEUED',
      gradingAttempt: 1,
    };
    const run: GradingRun = { id: runId, submissionId, triggerType: 'MANUAL', triggeredBy: result.identity.user.id, status: 'QUEUED', idempotencyKey: `it-idempotency-${suffix}`, createdAt: new Date().toISOString(), attempt: 1 };
    const batch: EvaluationBatch = { id: batchId, eventId, challengeVersion: versionId, runIds: [runId], submissionIds: [submissionId], engineIdentity: 'integration-engine@1.0.0', status: 'QUEUED', createdBy: result.identity.user.id, createdAt: new Date().toISOString() };
    const domainResult = await repository.transaction(async (transaction) => {
      const createdChallenge = await transaction.challenges.create(challenge);
      const createdEvent = await transaction.events.create(event);
      await transaction.events.replaceParticipants(eventId, [{ eventId, subjectId: result.identity.user.id, orgPathSnapshot: result.org.path, importedAt: new Date().toISOString() }]);
      const createdSubmission = await transaction.submissions.create(submission);
      const createdRun = await transaction.submissions.createRun(run);
      const createdBatch = await transaction.submissions.createBatch(batch);
      const leasedBatch = await transaction.submissions.leaseBatch(batchId, `lease-${suffix}`, 'worker-it', new Date(Date.now() + 60_000).toISOString());
      const leasedRun = await transaction.submissions.leaseRun(runId, `run-lease-${suffix}`, 'worker-it', new Date(Date.now() + 60_000).toISOString());
      const storedResult = await transaction.submissions.appendResult({ resultId, gradingRunId: runId, submissionId, eventId, result: { schemaVersion: '1.0', rubricVersion: '1.0', status: 'COMPLETE', total: 80, recalculatedTotal: 80 }, importedAt: new Date().toISOString() });
      const repeatResult = await transaction.submissions.appendResult({ resultId, gradingRunId: runId, submissionId, eventId, result: { schemaVersion: '1.0', rubricVersion: '1.0', status: 'COMPLETE', total: 80, recalculatedTotal: 80 }, importedAt: new Date().toISOString() });
      return { createdChallenge, createdEvent, createdSubmission, createdRun, createdBatch, leasedBatch, leasedRun, storedResult, repeatResult };
    });
    assert.equal(domainResult.createdChallenge.versions[0].id, versionId);
    assert.equal(domainResult.createdEvent.id, eventId);
    assert.equal(domainResult.createdSubmission.id, submissionId);
    assert.equal(domainResult.createdRun.id, runId);
    assert.equal(domainResult.createdBatch.id, batchId);
    assert.equal(domainResult.leasedBatch?.leaseId, `lease-${suffix}`);
    assert.equal(domainResult.leasedRun?.leaseId, `run-lease-${suffix}`);
    assert.equal(domainResult.storedResult.resultId, resultId);
    assert.equal(domainResult.repeatResult.resultId, resultId);
    assert.equal((await repository.submissions.getById(submissionId))?.state, 'GRADED');
    assert.equal((await repository.submissions.getById(submissionId))?.resultId, resultId);
    assert.equal((await repository.submissions.getRunById(runId))?.status, 'GRADED');
    const submissionPage = await repository.submissions.list({ page: 1, pageSize: 1, eventId, state: 'GRADED' });
    assert.equal(submissionPage.pageInfo.total, 1);
    assert.equal(submissionPage.items[0]?.id, submissionId);
    const auditPage = await repository.audits.list({ target: `user:${result.identity.user.id}`, page: 1, pageSize: 1 });
    assert.equal(auditPage.pageInfo.total, 1);
    assert.equal(auditPage.items[0]?.id, auditId);
    const scopedAuditPage = await repository.audits.list({ target: `user:${result.identity.user.id}`, page: 1, pageSize: 1, scopeOrgPaths: [result.org.path], viewerId: result.identity.user.id });
    assert.equal(scopedAuditPage.pageInfo.total, 1);
    assert.equal(scopedAuditPage.items[0]?.id, auditId);

    const concurrentIdentities = await Promise.all(Array.from({ length: 10 }, (_, index) => repository.users.syncSsoIdentity({
      employeeNo: raceEmployeeNo,
      name: `Concurrent ${index}`,
      department: result.org.path,
    })));
    assert.equal(new Set(concurrentIdentities.map((identity) => identity.user.id)).size, 1);
    assert.equal(concurrentIdentities.filter((identity) => identity.firstLogin).length, 1);
    assert.equal(concurrentIdentities.filter((identity) => !identity.firstLogin).length, 9);

    const concurrentRoots = await Promise.allSettled([
      repository.organizations.create({ id: raceRootA, path: `/race-root-a-${suffix}/`, level: 0, label: 'IT', name: `Concurrent root ${suffix}` }),
      repository.organizations.create({ id: raceRootB, path: `/race-root-b-${suffix}/`, level: 0, label: 'IT', name: `Concurrent root ${suffix}` }),
    ]);
    assert.equal(concurrentRoots.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const rejectedRoot = concurrentRoots.find((attempt) => attempt.status === 'rejected');
    assert.ok(rejectedRoot && rejectedRoot.status === 'rejected');
    assert.match(String(rejectedRoot.reason?.message ?? rejectedRoot.reason), /duplicate sibling name|already exists/i);

    await client.appUser.create({ data: { id: adminId, employeeNo: adminId, name: 'Integration Admin', roles: ['admin'], roleBindings: { create: [{ role: 'admin', scopeOrgPath: '/' }] } } });
    process.env.PLATFORM_REPOSITORY = 'postgres';
    const normalizedStore = await createPlatformStore();
    const staleStore = await createPlatformStore();
    readService = new PlatformReadService(normalizedStore);
    const normalizedSubmissionPage = await readService.listSubmissions({ eventId, page: 1, pageSize: 1 }, adminId);
    assert.equal(normalizedSubmissionPage.pageInfo.total, 1);
    assert.equal(normalizedSubmissionPage.items[0]?.id, submissionId);
    assert.equal(normalizedStore.listEvents(result.identity.user.id).some((item) => item.id === eventId), true);
    assert.equal(normalizedStore.getSubmission(submissionId)?.state, 'GRADED');
    normalizedStore.createOrgUnit({ id: casOrgA, parentId: orgId, name: 'CAS first', label: 'IT' }, adminId);
    await normalizedStore.flushPersistence();
    staleStore.createOrgUnit({ id: casOrgB, parentId: orgId, name: 'CAS stale', label: 'IT' }, adminId);
    await assert.rejects(staleStore.flushPersistence(), /changed on another API instance/);
    await staleStore.onModuleDestroy().catch(() => undefined);
    normalizedStore.cacheUserSnapshot({ ...result.updated, name: 'Normalized reload' });
    await normalizedStore.flushPersistence();
    const reloadedStore = await createPlatformStore();
    // cacheUserSnapshot is deliberately process-local in PostgreSQL mode;
    // the repository transaction above remains the canonical user write.
    assert.equal(reloadedStore.getUser(result.identity.user.id)?.name, result.updated.name);
    await reloadedStore.onModuleDestroy();
    await normalizedStore.onModuleDestroy();
    await assert.rejects(repository.submissions.appendResult({ resultId: `other-${suffix}`, gradingRunId: runId, submissionId, eventId, result: { status: 'COMPLETE', total: 80 }, importedAt: new Date().toISOString() }), /already has result/);

    const raceSubmission: SubmissionRecord = {
      id: raceSubmissionId,
      eventId,
      subjectId: result.identity.user.id,
      orgPathSnapshot: result.org.path,
      snapshot: { sourceType: 'UPLOAD', snapshotHash: 'c'.repeat(64), artifactHash: 'd'.repeat(64), artifactUri: 'local://race-placeholder', submittedAt: new Date().toISOString() },
      challengeVersionSnapshot: versionId,
      rubricVersionSnapshot: '1.0',
      state: 'QUEUED',
      createdAt: new Date().toISOString(),
      gradingStatus: 'QUEUED',
      gradingAttempt: 1,
    };
    await repository.submissions.create(raceSubmission);
    const concurrentRuns = await Promise.allSettled([
      repository.submissions.createRun({ id: raceRunA, submissionId: raceSubmissionId, triggerType: 'MANUAL', triggeredBy: result.identity.user.id, status: 'QUEUED', idempotencyKey: `it-race-idempotency-${suffix}`, createdAt: new Date().toISOString(), attempt: 1 }),
      repository.submissions.createRun({ id: raceRunB, submissionId: raceSubmissionId, triggerType: 'MANUAL', triggeredBy: result.identity.user.id, status: 'QUEUED', idempotencyKey: `it-race-idempotency-${suffix}`, createdAt: new Date().toISOString(), attempt: 1 }),
    ]);
    assert.equal(concurrentRuns.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const rejectedRun = concurrentRuns.find((attempt) => attempt.status === 'rejected');
    assert.ok(rejectedRun && rejectedRun.status === 'rejected');
    assert.match(String(rejectedRun.reason?.message ?? rejectedRun.reason), /idempotency|already exists/i);
    const winningRun = concurrentRuns.find((attempt): attempt is PromiseFulfilledResult<GradingRun> => attempt.status === 'fulfilled')?.value;
    assert.ok(winningRun);

    await repository.submissions.createBatch({ id: raceBatchId, eventId, challengeVersion: versionId, runIds: [winningRun.id], submissionIds: [raceSubmissionId], engineIdentity: 'integration-race-engine@1.0.0', status: 'QUEUED', createdBy: result.identity.user.id, createdAt: new Date().toISOString() });
    const leaseDeadline = new Date(Date.now() + 60_000).toISOString();
    const concurrentBatchLeases = await Promise.all([
      repository.submissions.leaseBatch(raceBatchId, `race-batch-lease-a-${suffix}`, 'worker-race-a', leaseDeadline),
      repository.submissions.leaseBatch(raceBatchId, `race-batch-lease-b-${suffix}`, 'worker-race-b', leaseDeadline),
    ]);
    assert.equal(concurrentBatchLeases.filter(Boolean).length, 1);
    const concurrentRunLeases = await Promise.all([
      repository.submissions.leaseRun(winningRun.id, `race-run-lease-a-${suffix}`, 'worker-race-a', leaseDeadline),
      repository.submissions.leaseRun(winningRun.id, `race-run-lease-b-${suffix}`, 'worker-race-b', leaseDeadline),
    ]);
    assert.equal(concurrentRunLeases.filter(Boolean).length, 1);

    const concurrentResults = await Promise.all(Array.from({ length: 10 }, () => repository.submissions.appendResult({
      resultId: raceResultId,
      gradingRunId: winningRun.id,
      submissionId: raceSubmissionId,
      eventId,
      result: { schemaVersion: '1.0', rubricVersion: '1.0', status: 'COMPLETE', total: 75, recalculatedTotal: 75 },
      importedAt: new Date().toISOString(),
    })));
    assert.equal(concurrentResults.length, 10);
    assert.ok(concurrentResults.every((stored) => stored.resultId === raceResultId));
    assert.equal((await repository.submissions.getResultByRunId(winningRun.id))?.resultId, raceResultId);

    await assert.rejects(
      repository.transaction(async (transaction) => {
        await transaction.users.update(result.identity.user.id, { roles: ['learner'] });
        await transaction.audits.append({ id: `rollback-${suffix}`, actorId: userId, action: 'integration.rollback', target: `user:${result.identity.user.id}`, createdAt: new Date().toISOString() });
        throw new Error('intentional rollback');
      }),
      /intentional rollback/,
    );
    const afterRollback = await repository.users.getById(result.identity.user.id);
    assert.deepEqual(afterRollback?.roles, ['learner', 'mentor']);

    uploadPersistence = new PrismaUploadSessionPersistence();
    await uploadPersistence.create({
      uploadId: uploadSessionId,
      tokenHash: 'f'.repeat(64),
      objectKey: `platform/uploads/${uploadSessionId}/delivery.zip.part`,
      actorId: result.identity.user.id,
      eventId,
      fileName: 'delivery.zip',
      declaredSize: 12,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'CREATED',
    });
    restartedUploadPersistence = new PrismaUploadSessionPersistence();
    assert.equal((await restartedUploadPersistence.get(uploadSessionId))?.actorId, result.identity.user.id);
    assert.equal(await restartedUploadPersistence.claim(uploadSessionId), 'CLAIMED');
    await restartedUploadPersistence.markUploaded(uploadSessionId, { size: 12, sha256: 'a'.repeat(64) });
    await restartedUploadPersistence.markCompleted(uploadSessionId, { uri: 's3://bucket/platform/objects/a/delivery.zip', size: 12, sha256: 'a'.repeat(64) });
    assert.equal((await uploadPersistence.get(uploadSessionId))?.status, 'COMPLETED');
    if (previousMode === undefined) delete process.env.PLATFORM_REPOSITORY; else process.env.PLATFORM_REPOSITORY = previousMode;
  } finally {
    if (previousMode === undefined) delete process.env.PLATFORM_REPOSITORY; else process.env.PLATFORM_REPOSITORY = previousMode;
    await restartedUploadPersistence?.onModuleDestroy();
    await uploadPersistence?.onModuleDestroy();
    await client.uploadSession.deleteMany({ where: { id: uploadSessionId } });
    await client.auditLog.deleteMany({ where: { OR: [{ id: { in: [auditId, `rollback-${suffix}`] } }, { target: { in: [`user:${raceEmployeeNo}`, `gradingRun:${runId}`, `gradingRun:${raceRunA}`, `gradingRun:${raceRunB}`] } }] } });
    await client.auditLog.deleteMany({ where: { target: { in: [`org-unit:${casOrgA}`, `org-unit:${casOrgB}`] } } });
    await client.evaluationResult.deleteMany({ where: { id: { in: [resultId, raceResultId] } } });
    await client.evaluationBatch.deleteMany({ where: { id: { in: [batchId, raceBatchId] } } });
    await client.gradingRun.deleteMany({ where: { id: { in: [runId, raceRunA, raceRunB] } } });
    await client.submission.deleteMany({ where: { id: { in: [submissionId, raceSubmissionId] } } });
    await client.participation.deleteMany({ where: { eventId } });
    await client.event.deleteMany({ where: { id: eventId } });
    await client.challengeVersion.deleteMany({ where: { id: versionId } });
    await client.challenge.deleteMany({ where: { id: challengeId } });
    await client.roleBinding.deleteMany({ where: { userId: { in: [userId, employeeNo, raceEmployeeNo] } } });
    await client.appUser.deleteMany({ where: { OR: [{ id: userId }, { employeeNo }, { employeeNo: raceEmployeeNo }] } });
    await client.roleBinding.deleteMany({ where: { userId: adminId } });
    await client.appUser.deleteMany({ where: { id: adminId } });
    await client.orgUnit.deleteMany({ where: { id: { in: [casOrgA, casOrgB] } } });
    await client.orgUnit.deleteMany({ where: { id: { in: [duplicateRootId, raceRootA, raceRootB] } } });
    await client.orgUnit.deleteMany({ where: { id: orgId } });
    await readService?.onModuleDestroy();
    await repository.close();
    await client.$disconnect();
  }
});
