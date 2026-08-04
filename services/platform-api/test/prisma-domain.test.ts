import test from 'node:test';
import assert from 'node:assert/strict';
import { mapSubmission } from '../src/prisma-domain-repository';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'submission-current-pointer',
    eventId: 'event-current-pointer',
    subjectId: 'employee-current-pointer',
    orgPathSnapshot: '/training/',
    sourceType: 'UPLOAD',
    snapshotHash: 'a'.repeat(64),
    artifactUri: null,
    artifactName: null,
    artifactHash: 'b'.repeat(64),
    repository: null,
    branch: null,
    commitSha: null,
    workspacePath: null,
    submittedAt: new Date('2026-08-03T00:00:00Z'),
    state: 'SEALED',
    challengeVersionSnapshot: 'challenge@1',
    rubricVersionSnapshot: '1.0',
    gradingStatus: 'PENDING',
    gradingAttempt: 2,
    previousResultIds: ['old-result'],
    failureReason: null,
    gradingRuns: [{ id: 'old-run', createdAt: new Date('2026-08-02T00:00:00Z') }],
    results: [{ id: 'old-result', createdAt: new Date('2026-08-02T00:00:00Z') }],
    createdAt: new Date('2026-08-01T00:00:00Z'),
    currentGradingRunId: null,
    currentResultId: null,
    ...overrides,
  };
}

test('normalized submission mapping keeps current pointers separate from historical attempts', () => {
  const regraded = mapSubmission(row());
  assert.equal(regraded.gradingRunId, undefined);
  assert.equal(regraded.resultId, undefined);

  const active = mapSubmission(row({ currentGradingRunId: 'new-run', currentResultId: 'new-result', state: 'GRADED', gradingStatus: 'COMPLETED' }));
  assert.equal(active.gradingRunId, 'new-run');
  assert.equal(active.resultId, 'new-result');
});

