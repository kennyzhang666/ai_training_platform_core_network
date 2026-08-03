import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

test('department deletion protects the organization tree and assigned employees', () => {
  const store = new PlatformStore(':memory:');
  const empty = store.createOrgUnit({ id: 'org-empty', parentId: 'org-125', name: '待撤销团队', label: '团队' }, 'w00123');
  store.deleteOrgUnit(empty.id, 'w00123');
  assert.throws(() => store.getOrgUnit(empty.id), /not found/);
  assert.throws(() => store.deleteOrgUnit('org-root', 'w00123'), /根组织不可删除/);
  assert.throws(() => store.deleteOrgUnit('org-125', 'w00123'), /仍有员工/);

  const parent = store.createOrgUnit({ id: 'org-parent', parentId: 'org-125', name: '产品组', label: '部门' }, 'w00123');
  const child = store.createOrgUnit({ id: 'org-child', parentId: parent.id, name: '交付团队', label: '团队' }, 'w00123');
  assert.throws(() => store.deleteOrgUnit(parent.id, 'w00123'), /仍有下级部门/);
  store.deleteOrgUnit(child.id, 'w00123');
  store.deleteOrgUnit(parent.id, 'w00123');
  assert.throws(() => store.getOrgUnit(parent.id), /not found/);
});

test('department administrators can remove empty descendants but not their scope root', () => {
  const store = new PlatformStore(':memory:');
  const child = store.createOrgUnit({ id: 'org-scoped-empty', parentId: 'org-125', name: '临时协作组', label: '团队' }, 'w00134');
  store.deleteOrgUnit(child.id, 'w00134');
  assert.throws(() => store.getOrgUnit(child.id), /not found/);
  assert.throws(() => store.deleteOrgUnit('org-125', 'w00134'), /管理范围的根部门/);
});

test('department administrators can configure scoped employees but cannot unassign people or modify administrators', () => {
  const store = new PlatformStore(':memory:');
  const updated = store.updateUser('w00124', { orgUnitId: 'org-125', roles: ['learner', 'mentor'] }, 'w00134');
  assert.deepEqual(updated.roles, ['learner', 'mentor']);
  assert.throws(() => store.updateUser('w00124', { orgUnitId: '', roles: ['learner'] }, 'w00134'), /只能将员工调整到其管理范围内的部门/);
  assert.throws(() => store.updateUser('w00134', { orgUnitId: 'org-125', roles: ['learner'] }, 'w00134'), /管理员账号需由全局管理员配置/);
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
      evaluationEngine: {
        id: 'org-private-evaluator', version: '1.0.0', mode: 'PLATFORM_LOCAL',
        executor: { id: 'drill-grader', params: { contractPath: 'challenges/parking-fee-v1/submission-contract.json', testsDir: 'challenges/parking-fee-v1/hidden-tests', entry: 'src/parking.py', function: 'calculate_fee' } },
        input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
        output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
      },
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

test('a session resolves its executor from the challenge engine, not from the session', () => {
  const store = new PlatformStore(':memory:');
  const event = store.createEvent({
    id: 'event-admin-parking-local', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE',
    deliveryConfig: { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024 },
  });
  // Executor configuration is owned by the challenge version so that one
  // challenge cannot be graded by two rule sets depending on the session.
  assert.equal(event.localGrading, undefined);
  const submission = store.createSubmission(event.id, 'w00124', { ...uploadSnapshot, snapshotHash: '9999999999999999999999999999999999999999999999999999999999999999' });
  const engine = store.evaluationEngineForSubmission(submission);
  assert.equal(engine.mode, 'PLATFORM_LOCAL');
  // The challenge picks a built-in executor from the registry and supplies its
  // parameters, instead of carrying free-text executor paths of its own.
  assert.equal(engine.executor?.id, 'drill-grader');
  assert.equal(engine.executor?.params?.entry, 'src/parking.py');
  assert.equal(engine.executor?.params?.testsDir, 'challenges/parking-fee-v1/hidden-tests');
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

// Aggregation used to run through listSubmissions() with its `w00123` default
// actor. On a deployment whose accounts come from SSO that account does not
// exist, so the authorization filter fell through to "only w00123's own rows"
// and personal profiles, report statistics and the AUTO queue silently emptied.
test('profiles and report statistics do not depend on the seeded local account', () => {
  const dataFile = join(__dirname, '..', 'tmp', `store-sso-${process.pid}.json`);
  mkdirSync(dirname(dataFile), { recursive: true });
  rmSync(dataFile, { force: true });
  writeFileSync(dataFile, JSON.stringify({
    orgUnits: [
      { id: 'org-root', path: '/', level: 0, label: '集团', name: '华为' },
      { id: 'org-125', parentId: 'org-root', path: '/1/12/125/', level: 3, label: '团队', name: 'AI 工程团队' },
    ],
    users: [
      { id: 'e10001', employeeNo: 'e10001', name: '员工甲', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['learner'], status: 'ACTIVE' },
      { id: 'e10002', employeeNo: 'e10002', name: '员工乙', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['learner'], status: 'ACTIVE' },
      { id: 'e10003', employeeNo: 'e10003', name: '管理员', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['global_admin'], roleBindings: [{ role: 'global_admin', scopeOrgPath: '/' }], status: 'ACTIVE' },
    ],
  }), 'utf8');
  try {
    const store = new PlatformStore(dataFile);
    assert.throws(() => store.getUser('w00123'), /not found/);
    const first = store.createSubmission('event-local', 'e10001', { ...uploadSnapshot, snapshotHash: '5555555555555555555555555555555555555555555555555555555555555555' });
    store.createSubmission('event-local', 'e10002', { ...uploadSnapshot, snapshotHash: '6666666666666666666666666666666666666666666666666666666666666666' });

    assert.equal(store.systemSubmissions().length, 2);
    assert.equal(store.systemSubmissions('event-local').length, 2);
    const profile = store.profile('e10001') as { stats: { submissions: number } };
    assert.equal(profile.stats.submissions, 1);
    assert.equal((store.profile('e10002') as { stats: { submissions: number } }).stats.submissions, 1);
    assert.equal(store.getSubmission(first.id).subjectId, 'e10001');
  } finally {
    rmSync(dataFile, { force: true });
  }
});

// An administrator's own capability profile aggregated every employee's result,
// because listSubmissions() was called with the subject as the acting user and
// the rows were never filtered back down to that subject.
test('a capability profile only aggregates the subject own deliveries', () => {
  const store = new PlatformStore(':memory:');
  store.createSubmission('event-local', 'w00124', { ...uploadSnapshot, snapshotHash: '7777777777777777777777777777777777777777777777777777777777777777' });
  store.createSubmission('event-local', 'w00126', { ...uploadSnapshot, snapshotHash: '8888888888888888888888888888888888888888888888888888888888888888' });
  const adminCapabilities = store.capabilities('w00123') as { summary: { gradedSubmissions: number } };
  assert.equal(adminCapabilities.summary.gradedSubmissions, 0);
});

// Season points are derived from the event rank. Two identical scores have the
// same rank, so they must earn the same points regardless of tie-break order.
test('equal event scores share a rank and earn the same season points', () => {
  const store = new PlatformStore(':memory:');
  const importEvent = store.createEvent({ id: 'event-tie', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' }, 'admin-test');
  store.createSeason({ id: 'season-tie', name: '并列赛季', eventIds: [importEvent.id], status: 'RUNNING' }, 'admin-test');
  const template = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'contracts', 'examples', 'evaluation-result.valid.json'), 'utf8')) as Record<string, any>;

  const subjects = ['w00124', 'w00126', 'w00125'] as const;
  const totals = [70, 70, 40];
  subjects.forEach((subjectId, index) => {
    const snapshotHash = String(index + 1).repeat(64).slice(0, 64);
    const artifactHash = String((index + 5) % 10).repeat(64).slice(0, 64);
    store.createSubmission(importEvent.id, subjectId, { sourceType: 'UPLOAD', snapshotHash, artifactHash, submittedAt: '2026-08-01T10:00:00Z' });
    const criteria = [{ key: 'V1', dim: 'verify', name: '基础', max: 100, level: 'A', score: totals[index], source: 'auto', rule: 'fixture' }];
    store.importResult({
      ...template,
      resultId: `result-tie-${index}`,
      gradingRunId: `run-tie-${index}`,
      idempotencyKey: `abababababababab${index}`,
      triggerType: 'IMPORT',
      subject: { kind: 'person', id: subjectId },
      criteria,
      dimensions: {
        verify: { score: totals[index], max: 100, evaluated: true },
        spec: { score: null, max: 25, evaluated: false },
        code: { score: null, max: 20, evaluated: false },
        collab: { score: null, max: 15, evaluated: false },
      },
      total: totals[index],
      submission: { sourceType: 'UPLOAD', snapshotHash, artifactHash, submittedAt: '2026-08-01T10:00:00Z' },
    }, 'admin-test', { eventId: importEvent.id, subjectId });
  });

  const board = store.leaderboard('season-tie') as Array<{ subjectId: string; points: number }>;
  const points = new Map(board.map((row) => [row.subjectId, row.points]));
  assert.equal(points.get('w00124'), points.get('w00126'));
  assert.equal(points.get('w00124'), 100);
  // Ranks are 1, 1, 3 of 3 participants: round(100 * (1 - 2/3)) = 33.
  assert.equal(points.get('w00125'), 33);
});

// Every attempt must keep its own immutable record. The grader derives its
// resultId from the snapshot alone, so a re-evaluation proposes the same id;
// storing it verbatim overwrote the earlier attempt and `previousResultIds`
// then resolved to a record holding the new score.
test('re-evaluating the same delivery keeps the previous result intact', () => {
  const store = new PlatformStore(':memory:');
  const snapshotHash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const submission = store.createSubmission('event-local', 'w00124', { sourceType: 'UPLOAD', snapshotHash, artifactHash: snapshotHash, submittedAt: '2026-08-01T10:00:00Z' });
  const graderResult = (total: number) => ({
    schemaVersion: '1.0', resultId: 'result-derived-from-snapshot', gradingRunId: 'replaced-by-platform',
    challengeVersion: 'parking-fee-01@1', rubricVersion: '1.0', graderVersion: '0.3.0',
    idempotencyKey: 'replaced-by-platform', triggerType: 'MANUAL', status: 'COMPLETE',
    submission: { sourceType: 'UPLOAD', snapshotHash, artifactHash: snapshotHash, submittedAt: '2026-08-01T10:00:00Z' },
    dimensions: {
      verify: { score: total, max: 40, evaluated: true },
      spec: { score: null, max: 25, evaluated: false },
      code: { score: null, max: 20, evaluated: false },
      collab: { score: null, max: 15, evaluated: false },
    },
    criteria: [{ key: 'V1', dim: 'verify', name: '基础', max: 40, level: 'A', score: total, source: 'auto', rule: 'fixture' }],
    total, validationDiagnostics: [], gradedBy: 'ci',
    startedAt: '2026-08-01T10:00:00Z', finishedAt: '2026-08-01T10:00:01Z', durationMs: 1000,
  });

  const firstRun = store.startGrading(submission.id, 'w00123');
  store.markRunRunning(firstRun.id);
  const first = store.completeRun(firstRun.id, graderResult(10));
  assert.equal((first.result as { total: number }).total, 10);

  store.regradeSubmission(submission.id, 'w00123');
  const secondRun = store.startGrading(submission.id, 'w00123');
  store.markRunRunning(secondRun.id);
  const second = store.completeRun(secondRun.id, graderResult(35));

  assert.notEqual(second.resultId, first.resultId);
  assert.deepEqual(store.getSubmission(submission.id).previousResultIds, [first.resultId]);
  assert.equal(store.getSubmission(submission.id).resultId, second.resultId);
  assert.equal((store.getReport(submission.id).result as { total: number }).total, 35);
});

// `evaluationEngine.mode` used to be a label nothing dispatched on: a session
// could be created with AUTO/MANUAL on a challenge that has no in-platform
// executor, and only failed when an administrator pressed "evaluate".
test('a session cannot use a trigger its challenge engine cannot serve', () => {
  const store = new PlatformStore(':memory:');
  const externalVersion = {
    id: 'external-only-01@1', challengeId: 'external-only-01', version: 1, title: '外部评测题', zone: 'YELLOW' as const,
    languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
    rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'PUBLISHED' as const,
    evaluationEngine: {
      id: 'external-only-evaluator', version: '1.0.0', mode: 'EXTERNAL_CLI' as const,
      input: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
      output: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
    },
  };
  store.createChallenge({ id: 'external-only-01', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'PUBLISHED', versions: [externalVersion] }, 'w00123');

  for (const trigger of ['AUTO', 'MANUAL'] as const) {
    assert.throws(
      () => store.createEvent({ id: `event-external-${trigger}`, challengeVersion: 'external-only-01@1', submissionSource: 'UPLOAD', trigger, reveal: 'IMMEDIATE' }, 'w00123'),
      /EXTERNAL_CLI|线下结果录入/,
    );
  }
  const imported = store.createEvent({ id: 'event-external-import', challengeVersion: 'external-only-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' }, 'w00123');
  assert.equal(imported.trigger, 'IMPORT');
  assert.throws(() => store.updateEvent(imported.id, { trigger: 'MANUAL' }, 'w00123'), /EXTERNAL_CLI|线下结果录入/);
});

// A PLATFORM_LOCAL engine has to carry the parameters the built-in grader
// needs, and an EXTERNAL_CLI engine must not pretend it is runnable in-process.
test('engine mode and executor configuration are validated together', () => {
  const store = new PlatformStore(':memory:');
  const version = (engine: Record<string, unknown>) => ({
    id: 'engine-validation-01@1', challengeId: 'engine-validation-01', version: 1, title: '引擎校验题', zone: 'YELLOW' as const,
    languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
    rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'DRAFT' as const,
    evaluationEngine: engine,
  });
  const base = {
    id: 'engine-validation-evaluator', version: '1.0.0',
    input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
    output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
  };
  const create = (engine: Record<string, unknown>) => store.createChallenge({ id: 'engine-validation-01', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'DRAFT', versions: [version(engine) as never] }, 'w00123');

  assert.throws(() => create({ ...base, mode: 'PLATFORM_LOCAL' }), /必须选择一个内置执行器|EXECUTOR_REQUIRED/);
  assert.throws(() => create({ ...base, mode: 'EXTERNAL_CLI', executor: { id: 'drill-grader' } }), /must not declare a built-in executor/);
  assert.throws(() => create({ ...base, mode: 'PLATFORM_LOCAL', executor: { id: 'drill-grader', params: { contractPath: '../escape.json' } } }), /repository-relative path/);
  const created = create({ ...base, mode: 'PLATFORM_LOCAL', executor: { id: 'drill-grader', params: { contractPath: 'challenges/x/contract.json', entry: 'src/x.py', function: 'solve' } } });
  assert.equal((created.versions[0].evaluationEngine?.executor?.params as { function?: string })?.function, 'solve');
});

// The engine identity is the grader component of the idempotency key on every
// trigger, so publishing a challenge version with a new engine version has to
// produce a different key instead of reusing a score computed by older rules.
test('the engine version participates in the idempotency key for every trigger', () => {
  const store = new PlatformStore(':memory:');
  const executor = { id: 'drill-grader', params: { contractPath: 'challenges/parking-fee-v1/submission-contract.json', testsDir: 'challenges/parking-fee-v1/hidden-tests', entry: 'src/parking.py', function: 'calculate_fee' } };
  const makeVersion = (versionNumber: number, engineVersion: string) => ({
    id: `engine-key-01@${versionNumber}`, challengeId: 'engine-key-01', version: versionNumber, title: '引擎版本题', zone: 'YELLOW' as const,
    languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
    rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'DRAFT' as const,
    evaluationEngine: {
      id: 'engine-key-evaluator', version: engineVersion, mode: 'PLATFORM_LOCAL' as const, executor,
      input: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
      output: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
    },
  });
  store.createChallenge({ id: 'engine-key-01', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'DRAFT', versions: [makeVersion(1, '1.0.0')] }, 'w00123');
  store.publishChallengeVersion('engine-key-01', 'engine-key-01@1', 'w00123');
  store.addChallengeVersion('engine-key-01', makeVersion(2, '2.0.0'), 'w00123');
  store.publishChallengeVersion('engine-key-01', 'engine-key-01@2', 'w00123');

  const snapshot = { ...uploadSnapshot, snapshotHash: 'eaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaea' };
  const keys = ['engine-key-01@1', 'engine-key-01@2'].map((challengeVersion, index) => {
    const event = store.createEvent({ id: `event-engine-key-${index}`, challengeVersion, submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE' }, 'w00123');
    const submission = store.createSubmission(event.id, 'w00124', snapshot);
    return store.startGrading(submission.id, 'w00123').idempotencyKey;
  });
  assert.notEqual(keys[0], keys[1]);
});
