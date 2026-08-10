export type SubmissionSource = 'UPLOAD' | 'GIT_REF';

export type SubmissionSourceAvailability = {
  selected: SubmissionSource | undefined;
  uploadEnabled: boolean;
  gitEnabled: boolean;
};

/**
 * A training event has one authoritative delivery source. The delivery page
 * may render both choices for a stable layout, but only the configured source
 * is interactive.
 */
export function submissionSourceAvailability(configuredSource?: SubmissionSource): SubmissionSourceAvailability {
  return {
    selected: configuredSource,
    uploadEnabled: configuredSource === 'UPLOAD',
    gitEnabled: configuredSource === 'GIT_REF',
  };
}
