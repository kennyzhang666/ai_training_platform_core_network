export type SubmissionEvaluationState = {
  eventId: string;
  subjectId: string;
  state: string;
  gradingRunId?: string;
  gradingStatus?: string;
};

export function submissionEvaluationInProgress(submission: SubmissionEvaluationState): boolean {
  return submission.gradingStatus === 'QUEUED'
    || submission.gradingStatus === 'RUNNING'
    || (submission.state === 'QUEUED' && Boolean(submission.gradingRunId));
}

export function participantHasEvaluationInProgress(
  submissions: readonly SubmissionEvaluationState[],
  eventId: string,
  subjectId: string,
): boolean {
  return submissions.some((submission) => submission.eventId === eventId
    && submission.subjectId === subjectId
    && submissionEvaluationInProgress(submission));
}
