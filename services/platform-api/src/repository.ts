import { AppUser, AuditRecord, Challenge, ChallengeVersion, EventConfig, EvaluationBatch, GradingRun, OrgUnit, ParticipantRecord, SsoIdentity, StoredResult, SubmissionRecord } from './domain';

/**
 * Stable page metadata shared by the file and PostgreSQL adapters.
 * Offset pagination is intentional for the v0.7 administration lists; the
 * API owns the maximum page size and adapters must not silently change it.
 */
export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export type UserSortField = 'employeeNo' | 'name' | 'orgPath' | 'status' | 'id';
export type SortOrder = 'asc' | 'desc';

export interface UserListQuery {
  page?: number;
  pageSize?: number;
  orgPath?: string;
  query?: string;
  roles?: readonly string[];
  status?: AppUser['status'];
  sortBy?: UserSortField;
  sortOrder?: SortOrder;
  /** Scope is supplied by the application service after authorization. */
  scopeOrgPaths?: readonly string[];
}

export interface NormalizedUserListQuery {
  page: number;
  pageSize: number;
  orgPath?: string;
  query?: string;
  roles?: readonly string[];
  status?: AppUser['status'];
  sortBy: UserSortField;
  sortOrder: SortOrder;
  scopeOrgPaths?: readonly string[];
}

export interface UserPage {
  items: AppUser[];
  pageInfo: PageInfo;
}

export interface SubmissionListQuery {
  page?: number;
  pageSize?: number;
  eventId?: string;
  eventIds?: readonly string[];
  subjectId?: string;
  scopeOrgPaths?: readonly string[];
  state?: SubmissionRecord['state'];
}

/** Compact list projection; full criteria, evidence and findings stay behind /reports/:submissionId. */
export interface SubmissionResultSummary {
  resultId: string;
  total: number;
  status: string;
  published: true;
}

export type SubmissionListItem = SubmissionRecord & { resultSummary?: SubmissionResultSummary };

export interface SubmissionPage {
  items: SubmissionListItem[];
  pageInfo: PageInfo;
}

export interface AuditListQuery {
  target?: string;
  page?: number;
  pageSize?: number;
  scopeOrgPaths?: readonly string[];
  /** Viewer identity used for legacy/system audit rows without a user FK. */
  viewerId?: string;
}

export interface AuditPage {
  items: AuditRecord[];
  pageInfo: PageInfo;
}

/** Narrow ports reserved for the next persistence slices; controllers should
 * depend on these rather than on Prisma models when the domain is migrated. */
export interface ChallengeRepository {
  list(query?: { ownerOrgPath?: string; status?: Challenge['status'] }): Promise<Challenge[]>;
  getById(id: string): Promise<Challenge | undefined>;
  create(challenge: Challenge): Promise<Challenge>;
  createVersion(challengeId: string, version: ChallengeVersion): Promise<ChallengeVersion>;
  publishVersion(challengeId: string, versionId: string): Promise<ChallengeVersion>;
}

export interface EventRepository {
  list(query?: { challengeVersion?: string; status?: EventConfig['status'] }): Promise<EventConfig[]>;
  getById(id: string): Promise<EventConfig | undefined>;
  create(event: EventConfig): Promise<EventConfig>;
  replaceParticipants(eventId: string, participants: readonly ParticipantRecord[]): Promise<void>;
  listParticipants(eventId: string): Promise<ParticipantRecord[]>;
}

/**
 * Immutable delivery and evaluation ports.  These are deliberately expressed
 * in domain values instead of Prisma rows so the file adapter and the
 * PostgreSQL adapter can be exercised by the same contract tests.
 */
export interface SubmissionRepository {
  list(query?: SubmissionListQuery): Promise<SubmissionPage>;
  getById(id: string): Promise<SubmissionRecord | undefined>;
  findBySnapshot(eventId: string, subjectId: string, snapshotHash: string): Promise<SubmissionRecord | undefined>;
  create(input: SubmissionRecord): Promise<SubmissionRecord>;
  updateLifecycle(id: string, patch: Pick<SubmissionRecord, 'state' | 'gradingRunId' | 'resultId' | 'gradingStatus' | 'gradingAttempt' | 'previousResultIds' | 'failureReason'>): Promise<SubmissionRecord>;
  createRun(input: GradingRun): Promise<GradingRun>;
  getRunById(id: string): Promise<GradingRun | undefined>;
  leaseRun(id: string, leaseId: string, workerId: string, leaseExpiresAt: string): Promise<GradingRun | undefined>;
  updateRun(id: string, patch: Partial<Pick<GradingRun, 'status' | 'failureReason' | 'leaseId' | 'leasedBy' | 'leaseExpiresAt' | 'evaluationBatchId'>>): Promise<GradingRun>;
  createBatch(input: EvaluationBatch): Promise<EvaluationBatch>;
  getBatchById(id: string): Promise<EvaluationBatch | undefined>;
  leaseBatch(id: string, leaseId: string, workerId: string, leaseExpiresAt: string): Promise<EvaluationBatch | undefined>;
  updateBatch(id: string, patch: Partial<Pick<EvaluationBatch, 'status' | 'leaseId' | 'leasedBy' | 'leaseExpiresAt' | 'completionLeaseId' | 'completedRunIds' | 'failedRunIds' | 'failureReason' | 'finishedAt'>>): Promise<EvaluationBatch>;
  appendResult(input: StoredResult): Promise<StoredResult>;
  getResultByRunId(runId: string): Promise<StoredResult | undefined>;
}

export interface OrgUnitListQuery {
  parentId?: string;
  pathPrefix?: string;
}

export interface UserPatch {
  orgUnitId?: string;
  roles?: readonly string[];
  roleBindings?: readonly { role: string; scopeOrgPath: string }[];
  nickname?: string | null;
  avatarDataUrl?: string | null;
}

export interface AuditAppendInput {
  id: string;
  actorId: string;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  createdAt: string;
}

export interface OrganizationRepository {
  list(query?: OrgUnitListQuery): Promise<OrgUnit[]>;
  getById(id: string): Promise<OrgUnit | undefined>;
  create(input: OrgUnit): Promise<OrgUnit>;
  update(id: string, patch: Pick<OrgUnit, 'label' | 'name'>): Promise<OrgUnit>;
  delete(id: string): Promise<void>;
}

export interface UserRepository {
  list(query: NormalizedUserListQuery): Promise<UserPage>;
  getById(id: string): Promise<AppUser | undefined>;
  getByEmployeeNo(employeeNo: string): Promise<AppUser | undefined>;
  update(id: string, patch: UserPatch): Promise<AppUser>;
  /** `changed` is false when a periodic refresh matched the stored identity. */
  syncSsoIdentity(identity: SsoIdentity): Promise<{ user: AppUser; firstLogin: boolean; departmentMatched: boolean; changed?: boolean }>;
}

export interface AuditRepository {
  append(record: AuditAppendInput): Promise<AuditRecord>;
  list(query?: AuditListQuery): Promise<AuditPage>;
}

export interface RepositoryTransaction {
  organizations: OrganizationRepository;
  users: UserRepository;
  audits: AuditRepository;
  challenges: ChallengeRepository;
  events: EventRepository;
  submissions: SubmissionRepository;
}

/**
 * v0.7 persistence port. Domain services depend on this port rather than on
 * Prisma types or the JSON file layout. A transaction receives repositories
 * bound to one transaction context and must not escape that callback.
 */
export interface PlatformRepository extends RepositoryTransaction {
  transaction<T>(work: (transaction: RepositoryTransaction) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
