import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { assertEventSubmissionWindow, PlatformStore } from '../src/store';

const uploadSnapshot = {
  sourceType: 'UPLOAD' as const,
  snapshotHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  artifactHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  submittedAt: '2026-08-01T10:00:00Z',
};

test('database startup can opt out of local demo fixtures', () => {
  const store = new PlatformStore({ dataFile: ':memory:', seed: false });
  assert.deepEqual(store.exportState().users, []);
  assert.deepEqual(store.exportState().events, []);
});

test('an explicitly configured SSO employee bootstraps the first global administrator', () => {
  const previous = process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO;
  process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO = 'bootstrap-admin';
  try {
    const store = new PlatformStore({ dataFile: ':memory:', seed: false });
    const learner = store.syncSsoIdentity({ employeeNo: 'first-learner', name: '首位普通员工', department: '未配置部门' });
    assert.deepEqual(learner.user.roles, ['learner']);

    const administrator = store.syncSsoIdentity({ employeeNo: 'bootstrap-admin', name: '初始管理员', department: '未配置部门' });
    assert.deepEqual(administrator.user.roles, ['global_admin']);
    assert.deepEqual(administrator.user.roleBindings, [{ role: 'global_admin', scopeOrgPath: '/' }]);
    assert.ok(store.exportState().audits.some((audit) => audit.actorId === 'bootstrap-admin' && audit.action === 'sso.user-provision'));

    const later = store.syncSsoIdentity({ employeeNo: 'later-learner', name: '后续员工', department: '未配置部门' });
    assert.deepEqual(later.user.roles, ['learner']);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO;
    else process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO = previous;
  }
});

test('bootstrap configuration never grants a second global administrator', () => {
  const previous = process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO;
  process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO = 'configured-second-admin';
  try {
    const store = new PlatformStore(':memory:');
    const result = store.syncSsoIdentity({ employeeNo: 'configured-second-admin', name: '已存在管理员后的员工', department: 'AI 工程团队' });
    assert.deepEqual(result.user.roles, ['learner']);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO;
    else process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO = previous;
  }
});

test('the in-memory demo event stays usable regardless of the wall clock', () => {
  const store = new PlatformStore(':memory:');
  const event = store.getEvent('event-local', 'w00123');
  assert.doesNotThrow(() => assertEventSubmissionWindow(event));
  assert.ok(Date.parse(event.startsAt ?? '') <= Date.parse(uploadSnapshot.submittedAt));
  assert.ok(Date.parse(event.endsAt ?? '') >= Date.parse(uploadSnapshot.submittedAt));
});

test('file startup compacts the legacy local fixture to the supported demo roster', () => {
  const dataFile = join(__dirname, '..', 'tmp', `store-minimal-${process.pid}-${Date.now()}.json`);
  mkdirSync(dirname(dataFile), { recursive: true });
  try {
    const legacy = new PlatformStore(':memory:').exportState();
    const legacyEvent = legacy.events.find((event) => event.id === 'event-local')!;
    legacyEvent.startsAt = '2026-08-01T09:00:00+08:00';
    legacyEvent.endsAt = '2026-08-08T18:00:00+08:00';
    legacy.participants = [
      { eventId: 'event-local', subjectId: 'w00124', orgPathSnapshot: '/1/12/125/', importedAt: '2026-08-01T00:00:00.000Z' },
      { eventId: 'event-local', subjectId: 'w00127', orgPathSnapshot: '/1/12/125/', importedAt: '2026-08-01T00:00:00.000Z' },
    ];
    writeFileSync(dataFile, JSON.stringify(legacy), 'utf8');
    const store = new PlatformStore({ dataFile, seedProfile: 'MINIMAL' });
    const state = store.exportState();
    assert.deepEqual(state.orgUnits.map((unit) => unit.id), ['org-root', 'org-125']);
    assert.deepEqual(state.challenges.map((challenge) => challenge.id), ['parking-fee-01']);
    assert.deepEqual(state.events.map((event) => event.id), ['event-local']);
    assert.deepEqual(state.users.map((user) => ({ id: user.id, roles: user.roles })), [
      { id: 'w00123', roles: ['global_admin'] },
      { id: 'w00124', roles: ['learner'] },
      { id: 'w00126', roles: ['learner'] },
      { id: 'w00133', roles: ['mentor'] },
    ]);
    assert.deepEqual(state.users.map((user) => ({ id: user.id, name: user.name })), [
      { id: 'w00123', name: '本地开发用户' },
      { id: 'w00124', name: '本地学员 A' },
      { id: 'w00126', name: '本地学员 B' },
      { id: 'w00133', name: '本地导师' },
    ]);
    assert.deepEqual(state.events[0].accessPolicy, {
      mode: 'RESTRICTED',
      subjectIds: ['w00124', 'w00126'],
      departmentIds: ['org-125'],
      mentorIds: ['w00133'],
    });
    assert.ok(Date.parse(state.events[0].startsAt ?? '') < Date.now());
    assert.ok(Date.parse(state.events[0].endsAt ?? '') > Date.now() + 300 * 24 * 60 * 60 * 1000);
    assert.deepEqual(state.participants.map((participant) => participant.subjectId).sort(), ['w00124', 'w00126']);
  } finally {
    rmSync(dataFile, { force: true });
  }
});

test('legacy demo dates remain immutable once the event has a submission', () => {
  const dataFile = join(__dirname, '..', 'tmp', `store-legacy-window-${process.pid}-${Date.now()}.json`);
  mkdirSync(dirname(dataFile), { recursive: true });
  try {
    const original = new PlatformStore(':memory:');
    original.createSubmission('event-local', 'w00124', uploadSnapshot);
    const state = original.exportState();
    const event = state.events.find((item) => item.id === 'event-local')!;
    event.startsAt = '2026-08-01T09:00:00+08:00';
    event.endsAt = '2026-08-08T18:00:00+08:00';
    delete event.deliveryConfig;
    writeFileSync(dataFile, JSON.stringify(state), 'utf8');

    const restarted = new PlatformStore({ dataFile, seedProfile: 'MINIMAL' });
    const preserved = restarted.getEvent('event-local', 'w00123');
    assert.equal(preserved.startsAt, '2026-08-01T09:00:00+08:00');
    assert.equal(preserved.endsAt, '2026-08-08T18:00:00+08:00');
    assert.deepEqual(preserved.deliveryConfig, { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024 });
  } finally {
    rmSync(dataFile, { force: true });
  }
});

test('deleting the local demo event and challenge keeps the empty state after restart', () => {
  const dataFile = join(__dirname, '..', 'tmp', `store-empty-demo-${process.pid}-${Date.now()}.json`);
  mkdirSync(dirname(dataFile), { recursive: true });
  try {
    const first = new PlatformStore(dataFile);
    first.deleteEvent('event-local', 'w00123');
    first.deleteChallenge('parking-fee-01', 'w00123');

    const second = new PlatformStore(dataFile);
    assert.deepEqual(second.listEvents('w00123'), []);
    assert.ok(second.listChallenges('w00123').every((challenge) => challenge.status === 'ARCHIVED'));
    assert.equal(second.exportState().localDemoSeedEnabled, false);
  } finally {
    rmSync(dataFile, { force: true });
  }
});

test('file user adapter applies scoped filtering, stable ordering, and pagination', () => {
  const store = new PlatformStore(':memory:');
  const firstPage = store.listUsersPage({ page: 1, pageSize: 3 }, 'w00123');
  assert.deepEqual(firstPage.items.map((user) => user.employeeNo), ['w00123', 'w00124', 'w00125']);
  assert.deepEqual(firstPage.pageInfo, { page: 1, pageSize: 3, total: 12, totalPages: 4, hasNext: true, hasPrevious: false });

  const scoped = store.listUsersPage({ page: 1, pageSize: 100, orgPath: '/1/12/125/', query: '学员', roles: ['learner'], sortBy: 'name' }, 'w00134');
  assert.ok(scoped.items.length >= 8);
  assert.ok(scoped.items.every((user) => user.orgPath.startsWith('/1/12/125/') && user.roles.includes('learner')));
  assert.throws(() => store.listUsersPage({ orgPath: '/1/12/' }, 'w00134'), /organization scope/);
  assert.throws(() => store.listUsersPage({ pageSize: 101 }, 'w00123'), /pageSize/);
  assert.throws(() => store.listUsersPage({}, 'w00124'), /administrator role/);
});

test('manual upload submission waits for administrator trigger', () => {
  const store = new PlatformStore(':memory:');
  const submission = store.createSubmission('event-local', 'w00123', uploadSnapshot);
  assert.equal(submission.state, 'WAITING_TRIGGER');
  const run = store.startGrading(submission.id, 'admin-1');
  assert.equal(run.triggerType, 'MANUAL');
  assert.equal(store.getSubmission(submission.id).state, 'QUEUED');
});

test('a participant cannot submit another snapshot while an evaluation is queued or running', () => {
  const store = new PlatformStore(':memory:');
  const first = store.createSubmission('event-local', 'w00124', uploadSnapshot);
  const replacementBeforeEvaluation = store.createSubmission('event-local', 'w00124', {
    ...uploadSnapshot,
    snapshotHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    artifactHash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  });
  assert.notEqual(replacementBeforeEvaluation.id, first.id);

  const run = store.startGrading(replacementBeforeEvaluation.id, 'admin-1');
  assert.equal(run.status, 'QUEUED');
  assert.throws(
    () => store.createSubmission('event-local', 'w00124', {
      ...uploadSnapshot,
      snapshotHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      artifactHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    }),
    /正在评测/,
  );

  store.acquireLease(run.id, 'worker-lock-test', 60);
  assert.throws(
    () => store.createSubmission('event-local', 'w00124', {
      ...uploadSnapshot,
      snapshotHash: '9999999999999999999999999999999999999999999999999999999999999999',
      artifactHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    /正在评测/,
  );

  store.failRun(run.id, 'test evaluation failure');
  const retryAfterFailure = store.createSubmission('event-local', 'w00124', {
    ...uploadSnapshot,
    snapshotHash: '1111111111111111111111111111111111111111111111111111111111111111',
    artifactHash: '2222222222222222222222222222222222222222222222222222222222222222',
  });
  assert.equal(retryAfterFailure.state, 'WAITING_TRIGGER');
});

test('submission is rejected outside the event time window', () => {
  const store = new PlatformStore(':memory:');
  const current = Date.now();
  const future = store.createEvent({
    id: 'event-window-future',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'UPLOAD',
    trigger: 'IMPORT',
    reveal: 'IMMEDIATE',
    mode: 'WINDOW',
    startsAt: new Date(current + 60 * 60 * 1000).toISOString(),
    endsAt: new Date(current + 2 * 60 * 60 * 1000).toISOString(),
  });
  const past = store.createEvent({
    id: 'event-window-past',
    challengeVersion: 'parking-fee-01@1',
    submissionSource: 'UPLOAD',
    trigger: 'IMPORT',
    reveal: 'IMMEDIATE',
    mode: 'WINDOW',
    startsAt: new Date(current - 2 * 60 * 60 * 1000).toISOString(),
    endsAt: new Date(current - 60 * 60 * 1000).toISOString(),
  });
  const snapshot = { ...uploadSnapshot, submittedAt: new Date(current).toISOString() };
  assert.throws(() => store.createSubmission(future.id, 'w00123', snapshot), /window has not started/);
  assert.throws(() => store.createSubmission(past.id, 'w00123', snapshot), /window has ended/);
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

test('global administrator cannot remove their own global administrator access', () => {
  const store = new PlatformStore(':memory:');
  assert.throws(
    () => store.updateUser('w00123', { roles: ['learner'] }, 'w00123'),
    ForbiddenException,
  );

  const retained = store.updateUser('w00123', { roles: ['global_admin'], roleBindings: [] }, 'w00123');
  assert.deepEqual(retained.roles, ['global_admin']);
  assert.ok(retained.roleBindings?.some((binding) => binding.role === 'global_admin' && binding.scopeOrgPath === '/'));
});

test('employees can update and clear only their own profile fields', () => {
  const store = new PlatformStore(':memory:');
  const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const updated = store.updateUserProfile('w00124', { nickname: 'Parking Hero', avatarDataUrl }, 'w00124');
  assert.equal(updated.nickname, 'Parking Hero');
  assert.equal(updated.avatarDataUrl, avatarDataUrl);
  assert.throws(() => store.updateUserProfile('w00124', { nickname: 'Nope' }, 'w00123'), /只能修改自己的个人资料/);
  const cleared = store.updateUserProfile('w00124', { nickname: null, avatarDataUrl: null }, 'w00124');
  assert.equal(cleared.nickname, undefined);
  assert.equal(cleared.avatarDataUrl, undefined);
});

test('an empty department can be deleted after all employees are unassigned', () => {
  const store = new PlatformStore({ dataFile: ':memory:', seedProfile: 'MINIMAL' });
  for (const user of store.exportState().users) {
    store.updateUser(user.id, { orgUnitId: '', roles: user.roles }, 'w00123');
  }
  store.deleteOrgUnit('org-125', 'w00123');
  assert.deepEqual(store.exportState().orgUnits.map((unit) => unit.id), ['org-root']);
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

test('SSO department matching ignores generic organization labels', () => {
  const store = new PlatformStore(':memory:');
  const result = store.syncSsoIdentity({ employeeNo: 'w01002', name: '标签不匹配员工', department: '团队' });
  assert.equal(result.departmentMatched, false);
  assert.equal(result.user.orgUnitId, '');
  assert.equal(result.user.orgPath, '');
  assert.equal(result.user.departmentHint, '团队');
});

test('SSO department matching never assigns an employee to a root organization', () => {
  const store = new PlatformStore(':memory:');
  store.createOrgUnit({ id: 'company-root', name: '新公司', label: '集团' }, 'w00123');
  const result = store.syncSsoIdentity({ employeeNo: 'w01003', name: '根组织不匹配员工', department: '新公司' });
  assert.equal(result.departmentMatched, false);
  assert.equal(result.user.orgUnitId, '');
  assert.equal(result.user.departmentHint, '新公司');
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
  store.deleteChallenge('admin-demo-01', 'admin-test');
  assert.equal(store.getChallenge('admin-demo-01').status, 'ARCHIVED');
  assert.equal(store.getChallenge('admin-demo-01').archivedFrom, 'PUBLISHED');
  const restored = store.restoreChallenge('admin-demo-01', 'admin-test');
  assert.equal(restored.status, 'PUBLISHED');
  assert.equal(restored.archivedFrom, undefined);
  assert.ok(store.listAudits().some((item) => item.action === 'challenge-version.publish'));
  assert.ok(store.listAudits().some((item) => item.action === 'challenge.archive'));
  assert.ok(store.listAudits().some((item) => item.action === 'challenge.restore'));
});

test('administrator can permanently delete an archived challenge with no linked training event', () => {
  const store = new PlatformStore(':memory:');
  store.createChallenge({
    id: 'admin-purge-01', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'DRAFT', versions: [{
      id: 'admin-purge-01@1', challengeId: 'admin-purge-01', version: 1, title: '永久删除测试题', zone: 'YELLOW',
      languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
      rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'DRAFT',
    }],
  }, 'admin-test');
  store.deleteChallenge('admin-purge-01', 'admin-test');
  const purged = store.permanentlyDeleteChallenge('admin-purge-01', 'admin-test');
  assert.deepEqual(purged, { id: 'admin-purge-01', status: 'PURGED' });
  assert.throws(() => store.getChallenge('admin-purge-01'), /not found/);
  assert.ok(store.listAudits().some((item) => item.action === 'challenge.purge' && item.target === 'challenge:admin-purge-01'));
});

test('permanent challenge deletion only accepts trash items and preserves linked event integrity', () => {
  const store = new PlatformStore(':memory:');
  store.createChallenge({
    id: 'admin-purge-linked', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'DRAFT', versions: [{
      id: 'admin-purge-linked@1', challengeId: 'admin-purge-linked', version: 1, title: '关联训战题', zone: 'YELLOW',
      languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
      rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'DRAFT',
    }],
  }, 'admin-test');
  assert.throws(() => store.permanentlyDeleteChallenge('admin-purge-linked', 'admin-test'), /only challenges in the trash/);
  store.publishChallenge('admin-purge-linked', 'admin-test');
  store.createEvent({
    id: 'event-admin-purge-linked', challengeVersion: 'admin-purge-linked@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE', status: 'CLOSED',
  }, 'admin-test');
  store.deleteChallenge('admin-purge-linked', 'admin-test');
  assert.throws(() => store.permanentlyDeleteChallenge('admin-purge-linked', 'admin-test'), /linked training events/);
  assert.equal(store.getChallenge('admin-purge-linked').status, 'ARCHIVED');
  assert.equal(store.getEvent('event-admin-purge-linked').status, 'CLOSED');
});

test('administrator can edit and delete an unused training event without losing audit or season integrity', () => {
  const store = new PlatformStore(':memory:');
  const event = store.createEvent({
    id: 'event-admin-delete', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE',
    mode: 'WINDOW', startsAt: '2026-08-01T09:00:00Z', endsAt: '2026-08-08T18:00:00Z',
  }, 'admin-test');
  store.createSeason({ id: 'season-admin-delete', name: '删除训战测试赛季', eventIds: [event.id], status: 'DRAFT' }, 'admin-test');
  const updated = store.updateEvent(event.id, { reveal: 'ON_RELEASE', endsAt: '2026-08-09T18:00:00Z' }, 'admin-test');
  assert.equal(updated.reveal, 'ON_RELEASE');
  store.deleteEvent(event.id, 'admin-test');
  assert.throws(() => store.getEvent(event.id), /not found/);
  assert.deepEqual(store.getSeason('season-admin-delete').eventIds, []);
  assert.ok(store.listAudits().some((item) => item.action === 'event.update' && item.target === `event:${event.id}`));
  assert.ok(store.listAudits().some((item) => item.action === 'event.delete' && item.target === `event:${event.id}`));
});

test('event deletion preserves immutable submission evidence and released event history', () => {
  const store = new PlatformStore(':memory:');
  const submitted = store.createEvent({ id: 'event-delete-submitted', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' }, 'admin-test');
  store.createSubmission(submitted.id, 'w00124', { ...uploadSnapshot, snapshotHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });
  assert.throws(() => store.deleteEvent(submitted.id, 'admin-test'), /已有提交/);

  const released = store.createEvent({ id: 'event-delete-released', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE', status: 'RELEASED' }, 'admin-test');
  assert.throws(() => store.deleteEvent(released.id, 'admin-test'), /已公布/);
  assert.equal(store.getEvent(released.id).status, 'RELEASED');
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
    const profile = store.profile('e10001') as { subject: { departmentName?: string; orgPath: string }; stats: { submissions: number } };
    assert.equal(profile.stats.submissions, 1);
    assert.equal(profile.subject.departmentName, 'AI 工程团队');
    assert.equal(profile.subject.orgPath, '/1/12/125/');
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

test('department capability statistics require an in-scope administrator', () => {
  const store = new PlatformStore(':memory:');
  const employee = store.capabilities('w00124', { includeDepartmentStats: false }) as {
    summary: { departmentStatsVisible: boolean; departmentAverage: number | null; departmentMedian: number | null; departmentPercentile: number | null };
    dimensions: Array<{ peerMedianPercent: number | null; peerCount: number; vsPeerMedian: number | null }>;
  };
  assert.equal(store.canViewDepartmentStats('w00124', 'w00124'), false);
  assert.equal(store.canViewDepartmentStats('w00134', 'w00124'), true);
  assert.equal(store.canViewDepartmentStats('w00123', 'w00124'), true);
  assert.equal(employee.summary.departmentStatsVisible, false);
  assert.equal(employee.summary.departmentAverage, null);
  assert.equal(employee.summary.departmentMedian, null);
  assert.equal(employee.summary.departmentPercentile, null);
  assert.ok(employee.dimensions.every((item) => item.peerMedianPercent === null && item.peerCount === 0 && item.vsPeerMedian === null));
});

// Season points are derived from the event rank. Two identical scores have the
// same rank, so they must earn the same points regardless of tie-break order.
test('equal event scores share a rank and earn the same season points', () => {
  const store = new PlatformStore(':memory:');
  const importEvent = store.createEvent({ id: 'event-tie', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' }, 'admin-test');
  store.createSeason({ id: 'season-tie', name: '并列赛季', eventIds: [importEvent.id], status: 'RUNNING' }, 'admin-test');
  const template = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'contracts', 'examples', 'evaluation-result.valid.json'), 'utf8')) as Record<string, any>;

  const subjects = ['w00124', 'w00126', 'w00125', 'w00127'] as const;
  const totals = [70, 70, 40, 30];
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
  // Ranks are 1, 1, 3, 4 of 4 participants: round(100 * (1 - 2/4)) = 50.
  assert.equal(points.get('w00125'), 50);

  const employeeBoard = store.leaderboard('season-tie', 'w00124') as Array<Record<string, unknown>>;
  assert.equal(employeeBoard.length, 3);
  assert.equal(employeeBoard[0].nickname, '未设置昵称');
  assert.equal(employeeBoard[0].subjectId, undefined);
  assert.equal(employeeBoard[0].name, undefined);
  assert.equal(employeeBoard[0].employeeNo, undefined);

  const adminBoard = store.leaderboard('season-tie', 'w00123') as Array<Record<string, unknown>>;
  assert.equal(adminBoard.length, 3);
  assert.equal(adminBoard[0].subjectId, 'w00124');
  assert.equal(adminBoard[0].name, '本地学员 A');
  assert.equal(adminBoard[0].employeeNo, 'w00124');
});

// Every attempt must keep its own immutable record. The grader derives its
// resultId from the snapshot alone, so a re-evaluation proposes the same id;
// storing it verbatim overwrote the earlier attempt and `previousResultIds`
// then resolved to a record holding the new score.
test('re-evaluating the same delivery keeps the previous result intact', () => {
  const store = new PlatformStore(':memory:');
  const snapshotHash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  const submission = store.createSubmission('event-local', 'w00124', { sourceType: 'UPLOAD', snapshotHash, artifactHash: snapshotHash, artifactName: 'delivery.zip', submittedAt: '2026-08-01T10:00:00Z' });
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
  assert.equal((first.result as { submission: { artifactName?: string } }).submission.artifactName, undefined);

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
