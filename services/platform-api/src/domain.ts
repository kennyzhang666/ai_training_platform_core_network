export type SubmissionSource = 'UPLOAD' | 'GIT_REF';
export type TriggerType = 'AUTO' | 'MANUAL' | 'IMPORT';
export type RevealMode = 'IMMEDIATE' | 'ON_RELEASE';
export type EventMode = 'LIVE' | 'WINDOW';
export type EventStatus = 'OPEN' | 'CLOSED' | 'RELEASED';
export type EventAccessMode = 'OPEN' | 'RESTRICTED';
export type EventPurpose = 'TRAINING' | 'HARD_PROBLEM';
/**
 * How a challenge is evaluated.
 * - EXTERNAL_CLI  : run outside the platform, results come back through import.
 * - PLATFORM_LOCAL: the built-in drill-grader, parameterised per challenge.
 * - PACKAGED      : an author-uploaded engine package, run by the platform in
 *                   a controlled subprocess.
 */
export type EvaluationEngineMode = 'EXTERNAL_CLI' | 'PLATFORM_LOCAL' | 'PACKAGED';

export interface CodeAgentRuntimeInput {
  enabled: boolean;
  /** Administrator-facing single-line command. Parsed once and never run through a shell. */
  commandLine: string;
  /** Optional organization-level instruction prepended to the mandatory batch protocol. */
  prompt: string;
  timeoutSeconds: number;
}

export interface CodeAgentRuntimeConfig extends CodeAgentRuntimeInput {
  schemaVersion: '1.0';
  executable: string;
  args: string[];
  configHash: string;
  updatedAt: string;
  updatedBy: string;
}

export type CodeAgentRuntimeSnapshot = Pick<
  CodeAgentRuntimeConfig,
  'schemaVersion' | 'executable' | 'args' | 'prompt' | 'timeoutSeconds' | 'configHash'
>;
export type SubmissionState =
  | 'RECEIVED'
  | 'QUEUED'
  | 'WAITING_TRIGGER'
  | 'WAITING_IMPORT'
  | 'IMPORT_VALIDATING'
  /** A grading run failed. `RECEIVED` remains the legacy retryable state for persisted records. */
  | 'FAILED'
  | 'GRADED'
  | 'SEALED'
  | 'REVEALED';

export interface EventConfig {
  id: string;
  challengeVersion: string;
  /** Hard-problem submission events are accessed from the independent problem workbench. */
  purpose?: EventPurpose;
  submissionSource: SubmissionSource;
  trigger: TriggerType;
  reveal: RevealMode;
  status: EventStatus;
  mode?: EventMode;
  deliveryConfig?: {
    repository?: string;
    branch?: string;
    branchTemplate?: string;
    pinAt?: 'SUBMIT' | 'DEADLINE';
    allowedFormats?: string[];
    maxBytes?: number;
    maxFiles?: number;
  };
  startsAt?: string;
  endsAt?: string;
  participantMode?: 'OPEN' | 'ALLOWLIST';
  /**
   * Visibility and entry scope for a training session.  OPEN keeps the
   * legacy organisation-scoped behaviour; RESTRICTED only exposes the event
   * to configured employees/departments and mentors. Administrators always
   * retain access for operations and support.
   */
  accessPolicy?: {
    mode: EventAccessMode;
    subjectIds?: string[];
    departmentIds?: string[];
    mentorIds?: string[];
  };
  rubricVersion?: string;
  /**
   * @deprecated Executor configuration now lives on the challenge version as
   * `evaluationEngine.local`, so one challenge cannot be graded by two
   * different rule sets depending on which session it was delivered to. This
   * field is only read once, to migrate sessions persisted before the move.
   */
  localGrading?: LocalEvaluationConfig;
}

export interface SubmissionSnapshot {
  sourceType: SubmissionSource;
  snapshotHash: string;
  artifactHash?: string;
  artifactUri?: string;
  /** Original upload name kept for public hard-problem solution summaries. */
  artifactName?: string;
  repository?: string;
  branch?: string;
  commitSha?: string;
  workspacePath?: string;
  submittedAt: string;
}

export interface SubmissionRecord {
  id: string;
  eventId: string;
  subjectId: string;
  orgPathSnapshot?: string;
  snapshot: SubmissionSnapshot;
  /** Immutable challenge/rubric versions captured when this delivery was submitted. */
  challengeVersionSnapshot?: string;
  rubricVersionSnapshot?: string;
  state: SubmissionState;
  createdAt: string;
  gradingRunId?: string;
  resultId?: string;
  /** Current evaluation lifecycle, independent from the legacy delivery state. */
  gradingStatus?: 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  /** Number of evaluation attempts for this immutable submission snapshot. */
  gradingAttempt?: number;
  previousResultIds?: string[];
  failureReason?: string;
}

export interface ParticipantRecord {
  eventId: string;
  subjectId: string;
  orgPathSnapshot: string;
  importedAt: string;
}

export interface GradingRun {
  id: string;
  submissionId: string;
  triggerType: TriggerType;
  triggeredBy?: string;
  status: 'QUEUED' | 'RUNNING' | 'GRADED' | 'FAILED';
  idempotencyKey: string;
  createdAt: string;
  attempt?: number;
  failureReason?: string;
  /**
   * Lease held by the evaluation worker currently running this task. The
   * platform hands work out and takes results back; it does not track worker
   * liveness, so an expired lease simply returns the run to the queue.
   */
  leaseId?: string;
  leasedBy?: string;
  leaseExpiresAt?: string;
  /** Batch that currently owns this run. A run can belong to only one active batch. */
  evaluationBatchId?: string;
}

/** One unit of work handed to an evaluation worker. */
export interface EvaluationTask {
  runId: string;
  leaseId: string;
  leaseExpiresAt: string;
  attempt: number;
  triggerType: TriggerType;
  idempotencyKey: string;
  engine: {
    source: 'BUILT_IN' | 'PACKAGE';
    id: string;
    version: string;
    packageHash: string;
    entrypoint: string;
    requirements?: string;
    params: Record<string, unknown>;
    limits: { wallClockSeconds: number; memoryMB: number; outputBytes: number };
    assets: Record<string, string>;
    /** Repository assets frozen beside a built-in engine by the Worker. */
    platformDependencies?: Array<{ name: string; repositoryPath: string; contentHash: string }>;
  };
  challenge: { id: string; title: string; challengeVersion: string; rubricVersion: string; zone?: 'YELLOW' | 'BLUE' };
  subject: { id: string; name?: string; orgPath?: string };
  submission: {
    id: string;
    eventId: string;
    sourceType: SubmissionSource;
    snapshotHash: string;
    artifactHash?: string;
    artifactUrl?: string;
    repository?: string;
    branch?: string;
    commitSha?: string;
    workspacePath?: string;
    submittedAt: string;
  };
}

export type EvaluationBatchStatus = 'QUEUED' | 'RUNNING' | 'PARTIAL' | 'COMPLETED' | 'FAILED';

/**
 * An immutable, same-challenge set of grading runs sent to one Code Agent.
 * The exact run ids are frozen at creation so selecting one employee never
 * accidentally expands into "all submissions" while a worker is running.
 */
export interface EvaluationBatch {
  id: string;
  eventId: string;
  challengeVersion: string;
  runIds: string[];
  submissionIds: string[];
  engineIdentity: string;
  /** Global-admin runtime configuration frozen when this batch is created. */
  codeAgentRuntime?: CodeAgentRuntimeSnapshot;
  status: EvaluationBatchStatus;
  createdBy: string;
  createdAt: string;
  leaseId?: string;
  leasedBy?: string;
  leaseExpiresAt?: string;
  /** Lease token retained after completion only to make the callback idempotent. */
  completionLeaseId?: string;
  completedRunIds?: string[];
  failedRunIds?: string[];
  failureReason?: string;
  finishedAt?: string;
}

/** One learner delivery inside a Code Agent evaluation batch. */
export interface EvaluationBatchSubmission {
  runId: string;
  attempt: number;
  triggerType: TriggerType;
  idempotencyKey: string;
  subject: { id: string; name?: string; orgPath?: string };
  submission: EvaluationTask['submission'];
}

/** Work descriptor leased by an evaluation-host worker. */
export interface EvaluationBatchTask {
  batchId: string;
  leaseId: string;
  leaseExpiresAt: string;
  engine: EvaluationTask['engine'] & {
    agent: { instruction: string; skills: string[] };
  };
  /** Omitted when the Worker must use its host-level CODE_AGENT_COMMAND fallback. */
  codeAgentRuntime?: CodeAgentRuntimeSnapshot;
  contracts: {
    input: EvaluationEngineConfig['input'];
    output: EvaluationEngineConfig['output'];
  };
  challenge: EvaluationTask['challenge'];
  submissions: EvaluationBatchSubmission[];
}

/**
 * Per-challenge evaluation contract. The platform owns the transport and
 * result validation; the configured engine owns the actual evaluation logic.
 */
/**
 * How the platform runs the built-in grader for a `PLATFORM_LOCAL` engine.
 * All paths are repository-relative; absolute paths, backslashes and `..` are
 * rejected so a challenge cannot point the executor outside the repository.
 */
export interface LocalEvaluationConfig {
  contractPath: string;
  testsDir?: string;
  entry: string;
  function: string;
  language?: string;
}

/** engine.json, frozen inside an uploaded engine package. */
export interface EnginePackageManifest {
  schemaVersion: '1.0' | '1.1';
  id: string;
  version: string;
  /** Display name in the built-in executor picker. */
  title?: string;
  description?: string;
  /** JSON Schema for the per-challenge parameters this engine accepts. */
  params?: { type: 'object'; required?: string[]; properties?: Record<string, Record<string, unknown>> };
  runtime: {
    type: 'python';
    entrypoint: string;
    requirements?: string;
    pythonVersion?: string;
  };
  limits?: {
    wallClockSeconds?: number;
    memoryMB?: number;
    outputBytes?: number;
  };
  assets?: {
    submissionContract?: string;
    testsDir?: string;
    referenceDir?: string;
  };
  /** Code Agent orchestration assets. Required by manifest schema 1.1. */
  agent?: {
    instruction: string;
    skills: string[];
  };
  selfCheck?: {
    expectMinTotal?: number;
    expectStatus?: 'COMPLETE' | 'PARTIAL';
  };
  /** Built-in executors only. Uploaded engine packages must be self-contained. */
  platformDependencies?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/** An engine resolved for execution, whether built in or uploaded. */
export interface ResolvedEngine {
  source: 'BUILT_IN' | 'PACKAGE';
  id: string;
  version: string;
  /** Content hash: package bytes for uploads, directory tree for built-ins. */
  packageHash: string;
  root: string;
  manifest: EnginePackageManifest;
  params: Record<string, unknown>;
  platformDependencies: Array<{ name: string; repositoryPath: string; contentHash: string }>;
}

export interface EnginePackageRecord {
  packageHash: string;
  size: number;
  manifest: EnginePackageManifest;
  uploadedFileName?: string;
}

/** The immutable engine package a PACKAGED challenge version is pinned to. */
export interface EnginePackageReference {
  packageHash: string;
  size?: number;
  fileName?: string;
  uploadedAt?: string;
  uploadedBy?: string;
}

/** A built-in executor from the repository `executors/` directory. */
export interface PlatformExecutorReference {
  id: string;
  version?: string;
  /** Values for the parameters the executor manifest declares. */
  params?: Record<string, unknown>;
}

export interface EvaluationEngineConfig {
  id: string;
  version: string;
  mode: EvaluationEngineMode;
  /** Required by PLATFORM_LOCAL: which built-in executor, with its parameters. */
  executor?: PlatformExecutorReference;
  /**
   * @deprecated Superseded by `executor`. The built-in grader used to be
   * configured through free-text paths instead of a chosen executor; kept only
   * to migrate challenge versions persisted before the registry existed.
   */
  local?: LocalEvaluationConfig;
  /** Required by PACKAGED, rejected for the other modes. */
  package?: EnginePackageReference;
  /** Paths loaded by the evaluation-host Code Agent, relative to the engine root. */
  agent?: {
    instructionPath: string;
    skillPaths: string[];
  };
  input: {
    format: 'JSON';
    schemaVersion: string;
    contractPath: string;
  };
  output: {
    format: 'JSON';
    schemaVersion: string;
    contractPath: string;
  };
}

export interface EvaluationInputSubmission {
  submissionId: string;
  subject: { id: string; name: string; orgPath: string };
  snapshot: SubmissionSnapshot;
  grading: {
    runId: string;
    idempotencyKey: string;
    triggerType: 'IMPORT';
  };
}

export interface EvaluationInputBatch {
  schemaVersion: '1.0';
  generatedAt: string;
  event: {
    id: string;
    challengeVersion: string;
    rubricVersion: string;
    trigger: 'IMPORT';
    submissionSource: SubmissionSource;
    reveal: RevealMode;
  };
  challenge: {
    id: string;
    title: string;
    version: number;
    evaluationEngine: EvaluationEngineConfig;
  };
  submissions: EvaluationInputSubmission[];
}

export interface StoredResult {
  resultId: string;
  gradingRunId: string;
  submissionId: string;
  eventId: string;
  result: Record<string, unknown>;
  importedAt: string;
}

export interface OrgUnit {
  id: string;
  parentId?: string;
  path: string;
  level: number;
  label: string;
  name: string;
}

/** Identity claims supplied by the internal SSO gateway on first login. */
export interface SsoIdentity {
  employeeNo: string;
  name: string;
  /** Department name, id, or path as returned by SSO. */
  department?: string;
}

export interface AppUser {
  id: string;
  employeeNo: string;
  name: string;
  orgUnitId: string;
  orgPath: string;
  /** Raw SSO department retained only as a matching hint when no unit matches. */
  departmentHint?: string;
  /** Whether the current department was assigned by SSO or by an administrator. */
  departmentSource?: 'SSO' | 'ADMIN';
  roles: string[];
  /**
   * `admin` is retained as a legacy global-admin role for existing identity
   * data. New assignments should use `global_admin` or `department_admin`.
   */
  roleBindings?: Array<{ role: string; scopeOrgPath: string }>;
  status: 'ACTIVE' | 'DISABLED';
}

export type AdminAccessLevel = 'GLOBAL' | 'DEPARTMENT';

export interface AdminAccess {
  level: AdminAccessLevel;
  /** Organization paths the administrator can manage. `/` means all. */
  scopeOrgPaths: string[];
}

export type SubmissionContractItemType = 'markdown' | 'source' | 'directory' | 'text' | 'json' | 'yaml';

export interface SubmissionContractItem {
  path: string;
  type?: SubmissionContractItemType;
  minSections?: number;
  minChars?: number;
  notTemplate?: boolean;
  mustExport?: string;
  signature?: string;
  /** Minimum number of files matched by a directory or glob rule. */
  minFiles?: number;
  /** Case-insensitive file extensions allowed for the matched files. */
  allowedExtensions?: string[];
}

/**
 * Per-challenge delivery layout. Version 1.0 mirrors the original grader
 * contract; 1.1 adds archive-root and allow-list controls used at upload time.
 */
export interface SubmissionContractDefinition {
  schemaVersion: '1.0' | '1.1';
  root?: { mode: 'ARCHIVE_ROOT' | 'SINGLE_DIRECTORY'; directoryName?: string };
  required: SubmissionContractItem[];
  optional?: SubmissionContractItem[];
  forbidden: string[];
  languageEntry?: Partial<Record<'python' | 'java' | 'go', string>>;
  allowedPaths?: string[];
  allowAdditionalPaths?: boolean;
  maxDepth?: number;
  maxFiles?: number;
}

export interface ChallengeVersion {
  id: string;
  challengeId: string;
  version: number;
  title: string;
  description?: string;
  objectives?: string[];
  requirements?: string[];
  constraints?: string[];
  deliverables?: string[];
  tags?: string[];
  estimatedMinutes?: number;
  zone: 'YELLOW' | 'BLUE';
  languagePolicy: Record<string, unknown>;
  deliveryPolicy: Record<string, unknown>;
  rubricVersion: string;
  submissionContract: string;
  /** Inline, version-frozen delivery layout configured in the challenge editor. */
  submissionContractDefinition?: SubmissionContractDefinition;
  /** The engine contract used to evaluate this challenge version. */
  evaluationEngine?: EvaluationEngineConfig;
  tests?: { public?: string[]; hidden?: string[]; golden?: string[] };
  resources?: { starter?: string; reference?: string; attachments?: string[] };
  resourceLimits?: { timeoutSeconds?: number; memoryMb?: number; maxOutputBytes?: number };
  changePackage?: Record<string, unknown>;
  visibility?: 'PUBLIC' | 'ORG' | 'PRIVATE';
  bounty?: number;
  explore?: boolean;
  status: 'DRAFT' | 'PUBLISHED';
}

/** Publisher-selected business classification for a challenge. */
export type ChallengeCategory = 'TRAINING' | 'COMPETITION' | 'HARD_PROBLEM';

/**
 * A hard-problem challenge can optionally carry board metadata. The board is
 * a view of the challenge library, not a second question store.
 */
export interface ChallengeBoardMetadata {
  type: 'HARD_PROBLEM';
  summary: string;
  details?: string;
  publisherType: 'DEPARTMENT' | 'EMPLOYEE';
  publisherId: string;
  publisherName: string;
  departmentName?: string;
  orgPath?: string;
  difficulty: 'HIGH' | 'MEDIUM' | 'LOW';
  tags: string[];
  status: 'OPEN' | 'RESOLVED';
  /** Publisher submissions stay off the board until administrator approval. */
  reviewStatus: HardProblemReviewStatus;
  /** Whether the winning submission can be shown on the resolved board. */
  solutionVisibility: HardProblemSolutionVisibility;
  /** The submission selected as the winning solution, once the problem is resolved. */
  solutionSubmissionId?: string;
  /** Independent upload event used by the hard-problem workbench. */
  submissionEventId?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComment?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  /** Administrator/publisher who closed the problem. */
  resolvedBy?: string;
  resolvedByName?: string;
  /** Employee whose submission was selected as the winning solution. */
  solverId?: string;
  solverName?: string;
}

export interface Challenge {
  id: string;
  ownerOrgPath: string;
  origin: 'OFFICIAL' | 'USER' | 'IMPORTED' | 'BOUNTY' | 'EXPLORE';
  /**
   * Publisher-selected business type. Optional on the input shape only so
   * older persisted/API records can be normalized to TRAINING on load.
   */
  category?: ChallengeCategory;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  /** Previous lifecycle state, retained so a trashed challenge can be restored safely. */
  archivedFrom?: 'DRAFT' | 'PUBLISHED';
  board?: ChallengeBoardMetadata;
  versions: ChallengeVersion[];
}

export interface Season {
  id: string;
  name: string;
  eventIds: string[];
  status: 'DRAFT' | 'RUNNING' | 'FINISHED';
}

export interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  createdAt: string;
}

export interface Announcement {
  id: string;
  title: string;
  summary: string;
  tag: '平台通知' | '训战提醒' | '规则更新';
  publishedAt: string;
  pinned?: boolean;
  /** Empty means a platform-wide announcement; otherwise department scope. */
  orgPath?: string;
}

export type HardProblemStatus = 'OPEN' | 'RESOLVED';
export type HardProblemReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export type HardProblemSolutionVisibility = 'PUBLIC' | 'HIDDEN';
export type HardProblemPublisherType = 'DEPARTMENT' | 'EMPLOYEE';
export type HardProblemDifficulty = 'HIGH' | 'MEDIUM' | 'LOW';

/** Compatibility projection of a HARD_PROBLEM challenge for the board API. */
export interface HardProblem {
  id: string;
  /** Compatibility projection of the challenge-library record. */
  challengeId?: string;
  title: string;
  summary: string;
  details?: string;
  publisherType: HardProblemPublisherType;
  publisherId: string;
  publisherName: string;
  departmentName?: string;
  orgPath?: string;
  difficulty: HardProblemDifficulty;
  tags: string[];
  status: HardProblemStatus;
  reviewStatus: HardProblemReviewStatus;
  solutionVisibility: HardProblemSolutionVisibility;
  solutionSubmissionId?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComment?: string;
  /** Upload event used by the independent hard-problem workbench. */
  submissionEventId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  solverId?: string;
  solverName?: string;
  /** Sanitised winning submission summary. Omitted for employees when hidden. */
  solution?: HardProblemSolution;
}

export interface HardProblemSolution {
  submissionId: string;
  solverId: string;
  solverName: string;
  submittedAt: string;
  state: SubmissionState;
  sourceType: SubmissionSource;
  artifactName?: string;
  artifactHash?: string;
  repository?: string;
  branch?: string;
  commitSha?: string;
}
