import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { PlatformStore } from '../src/store';

const uploadSnapshot = {
  sourceType: 'UPLOAD' as const,
  snapshotHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  artifactHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  submittedAt: '2026-08-01T10:00:00Z',
};

test('manual upload submission waits for administrator trigger', () => {
  const store = new PlatformStore(':memory:');
  const submission = store.createSubmission('event-local', 'w00123', uploadSnapshot);
  assert.equal(submission.state, 'WAITING_TRIGGER');
  const run = store.startGrading(submission.id, 'admin-1');
  assert.equal(run.triggerType, 'MANUAL');
  assert.equal(store.getSubmission(submission.id).state, 'QUEUED');
});

test('manual grading and external input preparation honor exact submission selection', () => {
  const store = new PlatformStore(':memory:');
  const first = store.createSubmission('event-local', 'w00124', { ...uploadSnapshot, snapshotHash: '1111111111111111111111111111111111111111111111111111111111111111' });
  const second = store.createSubmission('event-local', 'w00126', { ...uploadSnapshot, snapshotHash: '2222222222222222222222222222222222222222222222222222222222222222' });
  const selectedRuns = store.startEventGrading('event-local', 'admin-1', [first.id]);
  assert.equal(selectedRuns.length, 1);
  assert.equal(store.getSubmission(first.id).state, 'QUEUED');
  assert.equal(store.getSubmission(second.id).state, 'WAITING_TRIGGER');
  assert.throws(() => store.startEventGrading('event-local', 'admin-1', [first.id, 'missing-submission']), /outside/);

  const externalEvent = store.createEvent({ id: 'event-external-input', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' });
  const externalFirst = store.createSubmission(externalEvent.id, 'w00124', { ...uploadSnapshot, snapshotHash: '3333333333333333333333333333333333333333333333333333333333333333' });
  const externalSecond = store.createSubmission(externalEvent.id, 'w00126', { ...uploadSnapshot, snapshotHash: '4444444444444444444444444444444444444444444444444444444444444444' });
  const batch = store.prepareEvaluationInput(externalEvent.id, [externalFirst.id], 'admin-1');
  assert.equal(batch.submissions.length, 1);
  assert.equal(batch.submissions[0].submissionId, externalFirst.id);
  assert.equal(batch.challenge.evaluationEngine.id, 'parking-fee-evaluator');
  assert.equal(batch.submissions[0].grading.triggerType, 'IMPORT');
  assert.equal(store.getSubmission(externalFirst.id).state, 'WAITING_IMPORT');
  assert.equal(store.getSubmission(externalFirst.id).gradingRunId, batch.submissions[0].grading.runId);
  assert.equal(store.getSubmission(externalSecond.id).gradingRunId, undefined);
  const repeated = store.prepareEvaluationInput(externalEvent.id, [externalFirst.id], 'admin-1');
  assert.equal(repeated.submissions[0].grading.runId, batch.submissions[0].grading.runId);
  assert.throws(() => store.prepareEvaluationInput(externalEvent.id, [first.id], 'admin-1'), /outside/);
});

test('a failed manual run can be retried without losing the failed run history', () => {
  const store = new PlatformStore(':memory:');
  const submission = store.createSubmission('event-local', 'w00123', {
    ...uploadSnapshot,
    snapshotHash: 'abababababababababababababababababababababababababababababababab',
  });
  const first = store.startGrading(submission.id, 'admin-1');
  store.failRun(first.id);
  assert.equal(store.getRun(first.id).status, 'FAILED');
  assert.equal(store.getSubmission(submission.id).state, 'RECEIVED');
  const retry = store.startGrading(submission.id, 'admin-1');
  assert.notEqual(retry.id, first.id);
  assert.equal(store.getSubmission(submission.id).gradingRunId, retry.id);
});

test('submission captures immutable challenge and rubric versions and locks event edits', () => {
  const store = new PlatformStore(':memory:');
  store.createEvent({ id: 'event-version-lock', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE', rubricVersion: '1.0' });
  const submission = store.createSubmission('event-version-lock', 'w00124', { ...uploadSnapshot, snapshotHash: 'abababababababababababababababababababababababababababababababab' });
  assert.equal(submission.challengeVersionSnapshot, 'parking-fee-01@1');
  assert.equal(submission.rubricVersionSnapshot, '1.0');
  assert.throws(() => store.updateEvent('event-version-lock', { challengeVersion: 'parking-fee-01@2' }, 'admin-1'), /锁定/);
  assert.throws(() => store.updateEvent('event-version-lock', { rubricVersion: '2.0' }, 'admin-1'), /锁定/);
});

test('a completed submission can be regraded as a new immutable attempt', () => {
  const store = new PlatformStore(':memory:');
  const submission = store.createSubmission('event-local', 'w00124', { ...uploadSnapshot, snapshotHash: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' });
  const run = store.startGrading(submission.id, 'admin-1');
  store.failRun(run.id, '本地评估进程失败');
  const regraded = store.regradeSubmission(submission.id, 'admin-1');
  assert.equal(regraded.submission.gradingAttempt, 2);
  assert.equal(regraded.submission.state, 'WAITING_TRIGGER');
  assert.equal(regraded.submission.gradingStatus, 'PENDING');
  assert.equal(store.getRun(run.id).status, 'FAILED');
});

test('global administrator can maintain departments and mentors while scoped operations stay bounded', () => {
  const store = new PlatformStore(':memory:');
  const unit = store.createOrgUnit({ id: 'org-new', parentId: 'org-125', name: '新业务组', label: '团队' }, 'w00123');
  const mentor = store.syncSsoIdentity({ employeeNo: 'w00999', name: '新导师', department: '新业务组' }).user;
  assert.equal(mentor.orgPath, '/1/12/125/org-new/');
  assert.deepEqual(store.updateUser(mentor.id, { orgUnitId: unit.id, roles: ['mentor'] }, 'w00123').roles, ['mentor']);
  assert.equal(store.updateOrgUnit(unit.id, { name: '新业务组（调整）' }, 'w00123').name, '新业务组（调整）');
});

test('SSO first login provisions a learner and keeps an unmatched department for administrator follow-up', () => {
  const store = new PlatformStore(':memory:');
  const first = store.syncSsoIdentity({ employeeNo: 'w01001', name: '待配置员工', department: '尚未建档部门' });
  assert.equal(first.firstLogin, true);
  assert.equal(first.departmentMatched, false);
  assert.equal(first.user.orgUnitId, '');
  assert.equal(first.user.orgPath, '');
  assert.equal(first.user.departmentHint, '尚未建档部门');
  assert.deepEqual(first.user.roles, ['learner']);

  const second = store.syncSsoIdentity({ employeeNo: 'w01001', name: '待配置员工（更新）', department: '尚未建档部门' });
  assert.equal(second.firstLogin, false);
  assert.equal(second.user.name, '待配置员工（更新）');
  const configured = store.updateUser('w01001', { orgUnitId: 'org-125', roles: ['learner', 'mentor'] }, 'w00123');
  assert.equal(configured.orgPath, '/1/12/125/');
  assert.equal(configured.departmentHint, undefined);
  assert.deepEqual(configured.roles, ['learner', 'mentor']);
});

test('a submission source must match the event configuration', () => {
  const store = new PlatformStore(':memory:');
  assert.throws(() => store.createSubmission('event-local', 'w00123', {
    sourceType: 'GIT_REF',
    snapshotHash: uploadSnapshot.snapshotHash,
    repository: 'training/project',
    branch: 'main',
    commitSha: 'abcdef1234567',
    submittedAt: uploadSnapshot.submittedAt,
  }), BadRequestException);
});

test('auto Git submission is queued immediately and pins the supplied commit', () => {
  const store = new PlatformStore(':memory:');
  store.createEvent({
    id: 'event-auto-git',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'GIT_REF',
    trigger: 'AUTO',
    reveal: 'ON_RELEASE',
    deliveryConfig: { repository: 'training/parking-fee', branchTemplate: 'drill/{subjectId}' },
  });
  const submission = store.createSubmission('event-auto-git', 'w00125', {
    sourceType: 'GIT_REF',
    snapshotHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    repository: 'training/parking-fee',
    branch: 'drill/w00125',
    commitSha: 'abcdef1234567',
    submittedAt: '2026-08-01T10:00:00Z',
  });
  assert.equal(submission.state, 'QUEUED');
  assert.ok(submission.gradingRunId);
});

test('file adapter reloads events and submissions after process restart', () => {
  const file = join(process.cwd(), 'tmp', 'store-reload-test.json');
  rmSync(file, { force: true });
  const first = new PlatformStore(file);
  first.createEvent({ id: 'event-persisted', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE' });
  const created = first.createSubmission('event-persisted', 'w00126', {
    sourceType: 'UPLOAD',
    snapshotHash: '1212121212121212121212121212121212121212121212121212121212121212',
    artifactHash: '3434343434343434343434343434343434343434343434343434343434343434',
    submittedAt: '2026-08-01T10:00:00Z',
  });
  const second = new PlatformStore(file);
  assert.equal(second.getEvent('event-persisted').id, 'event-persisted');
  assert.equal(second.getSubmission(created.id).subjectId, 'w00126');
  rmSync(file, { force: true });
});

test('configured Git repository and branch are enforced and audited', () => {
  const store = new PlatformStore(':memory:');
  store.createEvent({
    id: 'event-git-policy',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'GIT_REF',
    trigger: 'MANUAL',
    reveal: 'IMMEDIATE',
    deliveryConfig: { repository: 'training/parking-fee', branchTemplate: 'drill/{subjectId}' },
  });
  assert.throws(() => store.createSubmission('event-git-policy', 'w00125', {
    sourceType: 'GIT_REF', snapshotHash: 'abababababababababababababababababababababababababababababababab',
    repository: 'training/other', branch: 'main', commitSha: 'abcdef1234567', submittedAt: '2026-08-01T10:00:00Z',
  }), BadRequestException);
  const submission = store.createSubmission('event-git-policy', 'w00125', {
    sourceType: 'GIT_REF', snapshotHash: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    repository: 'training/parking-fee', branch: 'drill/w00125', commitSha: 'abcdef1234567', submittedAt: '2026-08-01T10:00:00Z',
  });
  assert.equal(submission.state, 'WAITING_TRIGGER');
  assert.ok(store.listAudits(`submission:${submission.id}`).some((item) => item.action === 'submission.create'));
});

test('Git events require an administrator-owned repository and branch policy', () => {
  const store = new PlatformStore(':memory:');
  assert.throws(() => store.createEvent({
    id: 'event-git-without-policy',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'GIT_REF',
    trigger: 'MANUAL',
    reveal: 'IMMEDIATE',
  }), BadRequestException);
  const fixed = store.createEvent({
    id: 'event-git-fixed-branch',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'GIT_REF',
    trigger: 'MANUAL',
    reveal: 'IMMEDIATE',
    deliveryConfig: { repository: 'training/parking-fee', branch: 'release' },
  });
  assert.equal(fixed.deliveryConfig?.branch, 'release');
  assert.throws(() => store.createSubmission(fixed.id, 'w00125', {
    sourceType: 'GIT_REF', snapshotHash: 'abababababababababababababababababababababababababababababababab',
    repository: 'training/parking-fee', branch: 'drill/w00125', commitSha: 'abcdef1234567', submittedAt: uploadSnapshot.submittedAt,
  }), BadRequestException);
});

test('event listings enforce challenge organization and participant scope', () => {
  const store = new PlatformStore(':memory:');
  store.createChallenge({
    id: 'org-private-01', ownerOrgPath: '/9/', origin: 'OFFICIAL', status: 'PUBLISHED', versions: [{
      id: 'org-private-01@1', challengeId: 'org-private-01', version: 1, title: '组织私有题', zone: 'YELLOW',
      languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
      rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'PUBLISHED',
    }],
  });
  store.createEvent({ id: 'event-org-private', challengeVersion: 'org-private-01@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE' });
  store.createEvent({ id: 'event-allowlist', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE', participantMode: 'ALLOWLIST' });
  store.replaceParticipants('event-allowlist', ['w00124']);
  assert.ok(store.listEvents('w00124').some((event) => event.id === 'event-allowlist'));
  assert.ok(!store.listEvents('w00125').some((event) => event.id === 'event-allowlist'));
  assert.ok(!store.listEvents('w00124').some((event) => event.id === 'event-org-private'));
  assert.throws(() => store.getEvent('event-org-private', 'w00124'), /outside/);
});

test('training access policy scopes employees, departments, mentors and administrators', () => {
  const store = new PlatformStore(':memory:');
  const event = store.createEvent({
    id: 'event-audience-policy',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'UPLOAD',
    trigger: 'MANUAL',
    reveal: 'IMMEDIATE',
    accessPolicy: { mode: 'RESTRICTED', subjectIds: ['w00124'], departmentIds: ['org-125'], mentorIds: ['w00133'] },
  });
  assert.equal(event.accessPolicy?.mode, 'RESTRICTED');
  assert.ok(store.listEvents('w00124').some((item) => item.id === event.id));
  assert.ok(store.listEvents('w00126').some((item) => item.id === event.id));
  assert.ok(store.listEvents('w00133').some((item) => item.id === event.id));
  assert.ok(store.listEvents('w00123').some((item) => item.id === event.id));
  assert.ok(!store.listEvents('w00125').some((item) => item.id === event.id));
  assert.throws(() => store.getEvent(event.id, 'w00125'), /outside/);
  assert.throws(() => store.createSubmission(event.id, 'w00125', uploadSnapshot), /not configured/);
  assert.throws(() => store.createEvent({
    id: 'event-invalid-mentor', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE',
    accessPolicy: { mode: 'RESTRICTED', mentorIds: ['w00124'] },
  }), /not a mentor/);
});

test('automatic events pin snapshots at submission time', () => {
  const store = new PlatformStore(':memory:');
  assert.throws(() => store.createEvent({
    id: 'event-auto-deadline',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'GIT_REF',
    trigger: 'AUTO',
    reveal: 'IMMEDIATE',
    deliveryConfig: { repository: 'training/parking-fee', pinAt: 'DEADLINE' },
  }), BadRequestException);
  const event = store.createEvent({
    id: 'event-auto-default-pin',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'GIT_REF',
    trigger: 'AUTO',
    reveal: 'IMMEDIATE',
    deliveryConfig: { repository: 'training/parking-fee', branchTemplate: 'drill/{subjectId}' },
  });
  assert.equal(event.deliveryConfig?.pinAt, 'SUBMIT');
});

test('local admin-created parking sessions inherit the runnable local grader contract', () => {
  const store = new PlatformStore(':memory:');
  const event = store.createEvent({
    id: 'event-admin-parking-local', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE',
    deliveryConfig: { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024 },
  });
  assert.equal(event.localGrading?.entry, 'src/parking.py');
  assert.equal(event.localGrading?.testsDir, 'challenges/parking-fee-v1/hidden-tests');
});

test('manual Git events can defer commit pinning until the deadline', () => {
  const store = new PlatformStore(':memory:');
  const event = store.createEvent({
    id: 'event-git-deadline', challengeVersion: 'parking-fee-01@1', submissionSource: 'GIT_REF', trigger: 'MANUAL', reveal: 'ON_RELEASE',
    deliveryConfig: { repository: 'training/parking-fee', branchTemplate: 'drill/{subjectId}', pinAt: 'DEADLINE' },
  });
  const submission = store.createSubmission(event.id, 'w00125', {
    sourceType: 'GIT_REF', snapshotHash: 'abababababababababababababababababababababababababababababababab',
    repository: 'training/parking-fee', branch: 'drill/w00125', submittedAt: uploadSnapshot.submittedAt,
  });
  assert.equal(submission.snapshot.commitSha, undefined);
  assert.equal(submission.state, 'WAITING_TRIGGER');
});

test('administrator can create a draft version, update it, publish it and archive a closed challenge', () => {
  const store = new PlatformStore(':memory:');
  const created = store.createChallenge({
    id: 'admin-demo-01', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'DRAFT', versions: [{
      id: 'admin-demo-01@1', challengeId: 'admin-demo-01', version: 1, title: '管理员示例题', zone: 'YELLOW',
      languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
      rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'DRAFT',
    }],
  }, 'admin-test');
  assert.equal(created.status, 'DRAFT');
  const version = store.updateChallengeVersion('admin-demo-01', 'admin-demo-01@1', { description: '已补充说明' }, 'admin-test');
  assert.equal(version.description, '已补充说明');
  store.publishChallengeVersion('admin-demo-01', 'admin-demo-01@1', 'admin-test');
  assert.equal(store.getChallenge('admin-demo-01').status, 'PUBLISHED');
  assert.throws(() => store.updateChallengeVersion('admin-demo-01', 'admin-demo-01@1', { title: '禁止修改' }, 'admin-test'), /immutable/);
  store.archiveChallenge('admin-demo-01', 'admin-test');
  assert.equal(store.getChallenge('admin-demo-01').status, 'ARCHIVED');
  assert.equal(store.getChallenge('admin-demo-01').archivedFrom, 'PUBLISHED');
  const restored = store.restoreChallenge('admin-demo-01', 'admin-test');
  assert.equal(restored.status, 'PUBLISHED');
  assert.equal(restored.archivedFrom, undefined);
  assert.ok(store.listAudits().some((item) => item.action === 'challenge-version.publish'));
  assert.ok(store.listAudits().some((item) => item.action === 'challenge.archive'));
  assert.ok(store.listAudits().some((item) => item.action === 'challenge.restore'));
});

test('administrator overview and announcements expose operational state', () => {
  const store = new PlatformStore(':memory:');
  const announcement = store.createAnnouncement({ title: '管理员公告', summary: '请按时收卷', tag: '训战提醒', publishedAt: '2026-08-01T10:00:00Z' }, 'admin-test');
  assert.ok(store.listAnnouncements().some((item) => item.id === announcement.id));
  const overview = store.adminOverview() as { challenges: { published: number }; events: { open: number }; announcements: number; eventStats: unknown[] };
  assert.ok(overview.challenges.published >= 1);
  assert.ok(overview.events.open >= 1);
  assert.equal(overview.announcements, 4);
  assert.ok(overview.eventStats.length >= 2);
  store.deleteAnnouncement(announcement.id, 'admin-test');
  assert.equal(store.listAnnouncements().some((item) => item.id === announcement.id), false);
});
