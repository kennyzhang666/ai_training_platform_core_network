import assert from 'node:assert/strict';
import test from 'node:test';
import { participantHasEvaluationInProgress } from '../src/submission-evaluation-lock';

test('other participants queued or running evaluations do not lock the current participant', () => {
  const submissions = [
    { eventId: 'event-1', subjectId: 'employee-current', state: 'WAITING_TRIGGER', gradingStatus: 'PENDING' },
    { eventId: 'event-1', subjectId: 'employee-other-queued', state: 'QUEUED', gradingStatus: 'QUEUED', gradingRunId: 'run-queued' },
    { eventId: 'event-1', subjectId: 'employee-other-running', state: 'QUEUED', gradingStatus: 'RUNNING', gradingRunId: 'run-running' },
  ];

  assert.equal(participantHasEvaluationInProgress(submissions, 'event-1', 'employee-current'), false);
});

test('the current participant remains locked while their own evaluation is queued or running', () => {
  const queued = [{ eventId: 'event-1', subjectId: 'employee-current', state: 'QUEUED', gradingStatus: 'QUEUED', gradingRunId: 'run-queued' }];
  const running = [{ eventId: 'event-1', subjectId: 'employee-current', state: 'QUEUED', gradingStatus: 'RUNNING', gradingRunId: 'run-running' }];

  assert.equal(participantHasEvaluationInProgress(queued, 'event-1', 'employee-current'), true);
  assert.equal(participantHasEvaluationInProgress(running, 'event-1', 'employee-current'), true);
  assert.equal(participantHasEvaluationInProgress(running, 'event-2', 'employee-current'), false);
});
