import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  Challenge,
  ChallengeVersion,
  EventConfig,
  EvaluationBatch,
  GradingRun,
  ParticipantRecord,
  StoredResult,
  SubmissionRecord,
  SubmissionSnapshot,
} from './domain';
import {
  ChallengeRepository,
  EventRepository,
  SubmissionListQuery,
  SubmissionListItem,
  SubmissionRepository,
} from './repository';

export type PrismaDomainExecutor = PrismaClient | Prisma.TransactionClient;

function jsonValue(value: unknown, fallback: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === undefined ? fallback : value as Prisma.InputJsonValue;
}

function stringArray(value: Prisma.JsonValue | null | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function recordValue(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function mapVersion(row: any): ChallengeVersion {
  return {
    id: row.id,
    challengeId: row.challengeId,
    version: row.version,
    title: row.title,
    ...(row.summary !== null ? { summary: row.summary } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    descriptionFormat: row.descriptionFormat === 'HTML' ? 'HTML' : 'MARKDOWN',
    ...(stringArray(row.objectives) ? { objectives: stringArray(row.objectives) } : {}),
    ...(stringArray(row.requirements) ? { requirements: stringArray(row.requirements) } : {}),
    ...(stringArray(row.constraints) ? { constraints: stringArray(row.constraints) } : {}),
    ...(stringArray(row.deliverables) ? { deliverables: stringArray(row.deliverables) } : {}),
    ...(stringArray(row.tags) ? { tags: stringArray(row.tags) } : {}),
    ...(row.estimatedMinutes !== null ? { estimatedMinutes: row.estimatedMinutes } : {}),
    zone: row.zone === 'BLUE' ? 'BLUE' : 'YELLOW',
    languagePolicy: recordValue(row.languagePolicy) ?? {},
    deliveryPolicy: recordValue(row.deliveryPolicy) ?? {},
    rubricVersion: row.rubricVersion,
    submissionContract: row.submissionContract,
    ...(row.submissionContractDefinition !== null ? { submissionContractDefinition: row.submissionContractDefinition } : {}),
    ...(row.evaluationEngine !== null ? { evaluationEngine: row.evaluationEngine } : {}),
    ...(row.tests !== null ? { tests: row.tests } : {}),
    ...(row.resources !== null ? { resources: row.resources } : {}),
    ...(row.resourceLimits !== null ? { resourceLimits: row.resourceLimits } : {}),
    ...(row.changePackage !== null ? { changePackage: recordValue(row.changePackage) } : {}),
    ...(row.visibility !== null ? { visibility: row.visibility } : {}),
    ...(row.bounty !== null ? { bounty: Number(row.bounty) } : {}),
    ...(row.explore ? { explore: true } : {}),
    status: row.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
  };
}

export function mapChallenge(row: any): Challenge {
  return {
    id: row.id,
    ownerOrgPath: row.ownerOrgPath,
    origin: ['OFFICIAL', 'USER', 'IMPORTED', 'BOUNTY', 'EXPLORE'].includes(row.origin) ? row.origin : 'IMPORTED',
    category: ['TRAINING', 'COMPETITION', 'HARD_PROBLEM'].includes(row.category) ? row.category : 'TRAINING',
    status: row.status === 'PUBLISHED' ? 'PUBLISHED' : row.status === 'ARCHIVED' ? 'ARCHIVED' : 'DRAFT',
    ...(row.archivedFrom === 'DRAFT' || row.archivedFrom === 'PUBLISHED' ? { archivedFrom: row.archivedFrom } : {}),
    ...(row.board !== null ? { board: row.board } : {}),
    versions: Array.isArray(row.versions) ? row.versions.map(mapVersion) : [],
  };
}

export function mapEvent(row: any): EventConfig {
  return {
    id: row.id,
    challengeVersion: row.challengeVersionId,
    ...(row.purpose === 'TRAINING' || row.purpose === 'HARD_PROBLEM' ? { purpose: row.purpose } : {}),
    submissionSource: row.submissionSource === 'GIT_REF' ? 'GIT_REF' : 'UPLOAD',
    trigger: row.trigger === 'AUTO' ? 'AUTO' : row.trigger === 'IMPORT' ? 'IMPORT' : 'MANUAL',
    reveal: row.reveal === 'ON_RELEASE' ? 'ON_RELEASE' : 'IMMEDIATE',
    status: row.status === 'CLOSED' ? 'CLOSED' : row.status === 'RELEASED' ? 'RELEASED' : 'OPEN',
    ...(row.mode === 'LIVE' || row.mode === 'WINDOW' ? { mode: row.mode } : {}),
    ...(row.deliveryConfig !== null ? { deliveryConfig: row.deliveryConfig } : {}),
    ...(row.startsAt !== null ? { startsAt: row.startsAt.toISOString() } : {}),
    ...(row.endsAt !== null ? { endsAt: row.endsAt.toISOString() } : {}),
    ...(row.participantMode === 'ALLOWLIST' ? { participantMode: 'ALLOWLIST' } : { participantMode: 'OPEN' }),
    ...(row.accessPolicy !== null ? { accessPolicy: row.accessPolicy } : {}),
    ...(row.rubricVersion ? { rubricVersion: row.rubricVersion } : {}),
    ...(row.localGrading !== null ? { localGrading: row.localGrading } : {}),
  };
}

function mapSnapshot(row: any): SubmissionSnapshot {
  return {
    sourceType: row.sourceType === 'GIT_REF' ? 'GIT_REF' : 'UPLOAD',
    snapshotHash: row.snapshotHash,
    ...(row.artifactHash ? { artifactHash: row.artifactHash } : {}),
    ...(row.artifactUri ? { artifactUri: row.artifactUri } : {}),
    ...(row.artifactName ? { artifactName: row.artifactName } : {}),
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.commitSha ? { commitSha: row.commitSha } : {}),
    ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
    submittedAt: row.submittedAt.toISOString(),
  };
}

export function mapSubmission(row: any): SubmissionRecord {
  const hasCurrentRunPointer = Object.prototype.hasOwnProperty.call(row, 'currentGradingRunId');
  const hasCurrentResultPointer = Object.prototype.hasOwnProperty.call(row, 'currentResultId');
  return {
    id: row.id,
    eventId: row.eventId,
    subjectId: row.subjectId,
    ...(row.orgPathSnapshot ? { orgPathSnapshot: row.orgPathSnapshot } : {}),
    snapshot: mapSnapshot(row),
    ...(row.challengeVersionSnapshot ? { challengeVersionSnapshot: row.challengeVersionSnapshot } : {}),
    ...(row.rubricVersionSnapshot ? { rubricVersionSnapshot: row.rubricVersionSnapshot } : {}),
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    ...(row.gradingStatus ? { gradingStatus: row.gradingStatus } : {}),
    ...(row.gradingAttempt !== null ? { gradingAttempt: row.gradingAttempt } : {}),
    ...(Array.isArray(row.previousResultIds) ? { previousResultIds: row.previousResultIds.filter((item: unknown): item is string => typeof item === 'string') } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(hasCurrentRunPointer ? (row.currentGradingRunId ? { gradingRunId: row.currentGradingRunId } : {}) : row.gradingRuns?.[0]?.id ? { gradingRunId: row.gradingRuns[0].id } : {}),
    ...(hasCurrentResultPointer ? (row.currentResultId ? { resultId: row.currentResultId } : {}) : row.results?.[0]?.id ? { resultId: row.results[0].id } : {}),
  };
}

export function mapSubmissionListItem(row: any): SubmissionListItem {
  const submission = mapSubmission(row);
  if (!submission.resultId) return submission;
  if (row.event?.reveal === 'ON_RELEASE' && submission.state !== 'REVEALED') return submission;
  const result = row.results?.find((candidate: { id?: string }) => candidate.id === submission.resultId);
  if (!result) return submission;
  const total = Number(result.total);
  if (!Number.isFinite(total)) return submission;
  return {
    ...submission,
    resultSummary: {
      resultId: result.id,
      total,
      status: typeof result.status === 'string' ? result.status : 'COMPLETE',
      published: true,
    },
  };
}

export function mapRun(row: any): GradingRun {
  return {
    id: row.id,
    submissionId: row.submissionId,
    triggerType: row.triggerType,
    ...(row.triggeredBy ? { triggeredBy: row.triggeredBy } : {}),
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    ...(row.attempt !== null ? { attempt: row.attempt } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.leaseId ? { leaseId: row.leaseId } : {}),
    ...(row.leasedBy ? { leasedBy: row.leasedBy } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt.toISOString() } : {}),
    ...(row.evaluationBatchId ? { evaluationBatchId: row.evaluationBatchId } : {}),
  };
}

export function mapBatch(row: any): EvaluationBatch {
  const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return {
    id: row.id,
    eventId: row.eventId,
    challengeVersion: row.challengeVersionId,
    runIds: list(row.runIds),
    submissionIds: list(row.submissionIds),
    engineIdentity: row.engineIdentity,
    ...(row.codeAgentRuntime !== null ? { codeAgentRuntime: row.codeAgentRuntime } : {}),
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    ...(row.leaseId ? { leaseId: row.leaseId } : {}),
    ...(row.leasedBy ? { leasedBy: row.leasedBy } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt.toISOString() } : {}),
    ...(row.completionLeaseId ? { completionLeaseId: row.completionLeaseId } : {}),
    ...(row.completedRunIds !== null ? { completedRunIds: list(row.completedRunIds) } : {}),
    ...(row.failedRunIds !== null ? { failedRunIds: list(row.failedRunIds) } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
  };
}

export function mapResult(row: any): StoredResult {
  return {
    resultId: row.id,
    gradingRunId: row.gradingRunId,
    submissionId: row.submissionId,
    eventId: row.submission?.eventId ?? row.eventId,
    result: row.resultJson,
    importedAt: (row.importedAt ?? row.createdAt).toISOString(),
  };
}

function date(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}

function normalizeScopePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

function prismaError(error: unknown, code: string, message: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === code) {
    if (code === 'P2002') throw new ConflictException(message);
    if (code === 'P2025') throw new NotFoundException(message);
  }
  throw error;
}

function versionData(version: ChallengeVersion): Omit<Prisma.ChallengeVersionUncheckedCreateInput, 'challengeId'> {
  return {
    id: version.id,
    version: version.version,
    title: version.title,
    summary: version.summary ?? null,
    description: version.description ?? null,
    descriptionFormat: version.descriptionFormat ?? 'MARKDOWN',
    objectives: jsonValue(version.objectives),
    requirements: jsonValue(version.requirements),
    constraints: jsonValue(version.constraints),
    deliverables: jsonValue(version.deliverables),
    tags: jsonValue(version.tags),
    estimatedMinutes: version.estimatedMinutes ?? null,
    zone: version.zone,
    languagePolicy: jsonValue(version.languagePolicy, {}),
    deliveryPolicy: jsonValue(version.deliveryPolicy, {}),
    rubricVersion: version.rubricVersion,
    submissionContract: version.submissionContract,
    submissionContractDefinition: jsonValue(version.submissionContractDefinition),
    evaluationEngine: jsonValue(version.evaluationEngine),
    tests: jsonValue(version.tests),
    resources: jsonValue(version.resources),
    resourceLimits: jsonValue(version.resourceLimits),
    changePackage: jsonValue(version.changePackage),
    visibility: version.visibility ?? null,
    bounty: version.bounty ?? null,
    explore: Boolean(version.explore),
    status: version.status,
  };
}

export class PrismaChallengeRepository implements ChallengeRepository {
  constructor(private readonly db: PrismaDomainExecutor) {}

  async list(query: { ownerOrgPath?: string; status?: Challenge['status'] } = {}): Promise<Challenge[]> {
    const rows = await this.db.challenge.findMany({
      where: {
        ...(query.ownerOrgPath ? { ownerOrgPath: query.ownerOrgPath } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: { versions: { orderBy: { version: 'asc' } } },
      orderBy: [{ id: 'asc' }],
    });
    return rows.map(mapChallenge);
  }

  async getById(id: string): Promise<Challenge | undefined> {
    const row = await this.db.challenge.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'asc' } } } });
    return row ? mapChallenge(row) : undefined;
  }

  async create(challenge: Challenge): Promise<Challenge> {
    try {
      const row = await this.db.challenge.create({
        data: {
          id: challenge.id,
          ownerOrgPath: challenge.ownerOrgPath,
          origin: challenge.origin,
          category: challenge.category ?? 'TRAINING',
          status: challenge.status,
          archivedFrom: challenge.archivedFrom ?? null,
          board: jsonValue(challenge.board),
          versions: challenge.versions.length ? { create: challenge.versions.map(versionData) } : undefined,
        },
        include: { versions: { orderBy: { version: 'asc' } } },
      });
      return mapChallenge(row);
    } catch (error) {
      prismaError(error, 'P2002', `challenge already exists: ${challenge.id}`);
    }
  }

  async createVersion(challengeId: string, version: ChallengeVersion): Promise<ChallengeVersion> {
    if (version.challengeId !== challengeId) throw new BadRequestException('challenge version does not belong to challenge');
    try {
      const row = await this.db.challengeVersion.create({ data: { ...versionData(version), challengeId } });
      return mapVersion(row);
    } catch (error) {
      prismaError(error, 'P2002', `challenge version already exists: ${challengeId}@${version.version}`);
      prismaError(error, 'P2025', `challenge not found: ${challengeId}`);
    }
  }

  async publishVersion(challengeId: string, versionId: string): Promise<ChallengeVersion> {
    const version = await this.db.challengeVersion.findFirst({ where: { id: versionId, challengeId } });
    if (!version) throw new NotFoundException(`challenge version not found: ${versionId}`);
    if (version.status === 'PUBLISHED') return mapVersion(version);
    const row = await this.db.challengeVersion.update({ where: { id: versionId }, data: { status: 'PUBLISHED' } });
    await this.db.challenge.update({ where: { id: challengeId }, data: { status: 'PUBLISHED' } });
    return mapVersion(row);
  }
}

function eventData(event: EventConfig): Prisma.EventUncheckedCreateInput {
  return {
    id: event.id,
    challengeVersionId: event.challengeVersion,
    mode: event.mode ?? 'LIVE',
    submissionSource: event.submissionSource,
    deliveryConfig: jsonValue(event.deliveryConfig, {}),
    trigger: event.trigger,
    reveal: event.reveal,
    participantMode: event.participantMode ?? 'OPEN',
    purpose: event.purpose ?? null,
    accessPolicy: jsonValue(event.accessPolicy),
    rubricVersion: event.rubricVersion ?? '1.0',
    startsAt: date(event.startsAt),
    endsAt: date(event.endsAt),
    status: event.status,
    localGrading: jsonValue(event.localGrading),
  };
}

export class PrismaEventRepository implements EventRepository {
  constructor(private readonly db: PrismaDomainExecutor) {}

  async list(query: { challengeVersion?: string; status?: EventConfig['status'] } = {}): Promise<EventConfig[]> {
    const rows = await this.db.event.findMany({
      where: {
        ...(query.challengeVersion ? { challengeVersionId: query.challengeVersion } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ id: 'asc' }],
    });
    return rows.map(mapEvent);
  }

  async getById(id: string): Promise<EventConfig | undefined> {
    const row = await this.db.event.findUnique({ where: { id } });
    return row ? mapEvent(row) : undefined;
  }

  async create(event: EventConfig): Promise<EventConfig> {
    try {
      const row = await this.db.event.create({ data: eventData(event) });
      return mapEvent(row);
    } catch (error) {
      prismaError(error, 'P2002', `event already exists: ${event.id}`);
      prismaError(error, 'P2025', `challenge version not found: ${event.challengeVersion}`);
    }
  }

  async replaceParticipants(eventId: string, participants: readonly ParticipantRecord[]): Promise<void> {
    try {
      const replace = async (tx: PrismaDomainExecutor) => {
        const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
        if (!event) throw new NotFoundException(`event not found: ${eventId}`);
        await tx.participation.deleteMany({ where: { eventId } });
        if (participants.length) {
          await tx.participation.createMany({
            data: participants.map((participant) => ({
              eventId,
              subjectId: participant.subjectId,
              orgPathSnapshot: participant.orgPathSnapshot,
              importedAt: new Date(participant.importedAt),
            })),
          });
        }
      };
      if ('$transaction' in this.db) await this.db.$transaction((tx) => replace(tx));
      else await replace(this.db);
    } catch (error) {
      prismaError(error, 'P2025', `event not found: ${eventId}`);
    }
  }

  async listParticipants(eventId: string): Promise<ParticipantRecord[]> {
    const rows = await this.db.participation.findMany({ where: { eventId }, orderBy: [{ subjectId: 'asc' }] });
    return rows.map((row) => ({ eventId: row.eventId, subjectId: row.subjectId, orgPathSnapshot: row.orgPathSnapshot, importedAt: row.importedAt.toISOString() }));
  }
}

function submissionData(input: SubmissionRecord): Prisma.SubmissionUncheckedCreateInput {
  return {
    id: input.id,
    eventId: input.eventId,
    subjectId: input.subjectId,
    orgPathSnapshot: input.orgPathSnapshot ?? null,
    sourceType: input.snapshot.sourceType,
    snapshotHash: input.snapshot.snapshotHash,
    artifactUri: input.snapshot.artifactUri ?? null,
    artifactName: input.snapshot.artifactName ?? null,
    artifactHash: input.snapshot.artifactHash ?? null,
    repository: input.snapshot.repository ?? null,
    branch: input.snapshot.branch ?? null,
    commitSha: input.snapshot.commitSha ?? null,
    workspacePath: input.snapshot.workspacePath ?? null,
    submittedAt: new Date(input.snapshot.submittedAt),
    state: input.state,
    challengeVersionSnapshot: input.challengeVersionSnapshot ?? null,
    rubricVersionSnapshot: input.rubricVersionSnapshot ?? null,
    gradingStatus: input.gradingStatus ?? null,
    gradingAttempt: input.gradingAttempt ?? null,
    previousResultIds: jsonValue(input.previousResultIds),
    failureReason: input.failureReason ?? null,
    currentGradingRunId: input.gradingRunId ?? null,
    currentResultId: input.resultId ?? null,
  };
}

function runData(input: GradingRun): Prisma.GradingRunUncheckedCreateInput {
  return {
    id: input.id,
    submissionId: input.submissionId,
    triggerType: input.triggerType,
    triggeredBy: input.triggeredBy ?? null,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    graderVersion: null,
    attempt: input.attempt ?? null,
    failureReason: input.failureReason ?? null,
    leaseId: input.leaseId ?? null,
    leasedBy: input.leasedBy ?? null,
    leaseExpiresAt: date(input.leaseExpiresAt),
    evaluationBatchId: input.evaluationBatchId ?? null,
    createdAt: new Date(input.createdAt),
  };
}

function batchData(input: EvaluationBatch): Prisma.EvaluationBatchUncheckedCreateInput {
  return {
    id: input.id,
    eventId: input.eventId,
    challengeVersionId: input.challengeVersion,
    runIds: input.runIds,
    submissionIds: input.submissionIds,
    engineIdentity: input.engineIdentity,
    codeAgentRuntime: jsonValue(input.codeAgentRuntime),
    createdBy: input.createdBy,
    status: input.status,
    leaseId: input.leaseId ?? null,
    completionLeaseId: input.completionLeaseId ?? null,
    leasedBy: input.leasedBy ?? null,
    leaseExpiresAt: date(input.leaseExpiresAt),
    completedRunIds: jsonValue(input.completedRunIds),
    failedRunIds: jsonValue(input.failedRunIds),
    failureReason: input.failureReason ?? null,
    finishedAt: date(input.finishedAt),
    createdAt: new Date(input.createdAt),
  };
}

export class PrismaSubmissionRepository implements SubmissionRepository {
  constructor(private readonly db: PrismaDomainExecutor) {}

  private async transaction<T>(work: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(work);
    return work(this.db);
  }

  private async loadSubmission(id: string): Promise<SubmissionRecord | undefined> {
    const row = await this.db.submission.findUnique({
      where: { id },
      include: { gradingRuns: { orderBy: [{ createdAt: 'desc' }], take: 1 }, results: { orderBy: [{ createdAt: 'desc' }], take: 1 } },
    });
    return row ? mapSubmission(row) : undefined;
  }

  async list(query: SubmissionListQuery = {}): Promise<import('./repository').SubmissionPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('page must be a positive integer');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('pageSize must be between 1 and 100');
    const scopeOrgPaths = [...new Set((query.scopeOrgPaths ?? []).map(normalizeScopePath))];
    const allowedEventIds = query.eventIds ? [...new Set(query.eventIds)] : undefined;
    const eventIds = query.eventId
      ? (allowedEventIds ? (allowedEventIds.includes(query.eventId) ? [query.eventId] : []) : [query.eventId])
      : allowedEventIds;
    const where: Prisma.SubmissionWhereInput = {
      ...(eventIds ? { eventId: { in: eventIds } } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(scopeOrgPaths.length ? {
        subject: {
          OR: scopeOrgPaths.map((path) => ({ orgPath: path === '/' ? { not: null } : { startsWith: path } })),
        },
      } : {}),
    };
    const [total, pageKeys] = await Promise.all([
      this.db.submission.count({ where }),
      this.db.submission.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Select only the ordered keys first.  PostgreSQL can satisfy this
        // page from the composite event/state/time index without sorting or
        // materialising the JSON/history columns for every skipped row.
        select: { id: true },
      }),
    ]);
    const rows = pageKeys.length
      ? await this.db.submission.findMany({
        where: { id: { in: pageKeys.map((key) => key.id) } },
        include: {
          gradingRuns: { orderBy: [{ createdAt: 'desc' }], take: 1 },
          results: { orderBy: [{ createdAt: 'desc' }], take: 1, select: { id: true, total: true, status: true } },
          event: { select: { reveal: true } },
        },
      })
      : [];
    const rowById = new Map(rows.map((row) => [row.id, row] as const));
    const totalPages = total ? Math.ceil(total / pageSize) : 0;
    return {
      // The hydration query has no ordering guarantee; restore the exact
      // keyset order so equal timestamps cannot move between pages.
      items: pageKeys.flatMap((key) => {
        const row = rowById.get(key.id);
        return row ? [mapSubmissionListItem(row)] : [];
      }),
      pageInfo: { page, pageSize, total, totalPages, hasNext: totalPages > 0 && page < totalPages, hasPrevious: totalPages > 0 && page > 1 },
    };
  }

  async getById(id: string): Promise<SubmissionRecord | undefined> { return this.loadSubmission(id); }

  async findBySnapshot(eventId: string, subjectId: string, snapshotHash: string): Promise<SubmissionRecord | undefined> {
    const row = await this.db.submission.findUnique({
      where: { eventId_subjectId_snapshotHash: { eventId, subjectId, snapshotHash } },
      include: { gradingRuns: { orderBy: [{ createdAt: 'desc' }], take: 1 }, results: { orderBy: [{ createdAt: 'desc' }], take: 1 } },
    });
    return row ? mapSubmission(row) : undefined;
  }

  async create(input: SubmissionRecord): Promise<SubmissionRecord> {
    try {
      const row = await this.db.submission.create({ data: submissionData(input), include: { gradingRuns: true, results: true } });
      return mapSubmission(row);
    } catch (error) {
      prismaError(error, 'P2002', 'submission snapshot already exists for this event and subject');
      prismaError(error, 'P2025', `submission dependency not found: ${input.id}`);
    }
  }

  async updateLifecycle(id: string, patch: Pick<SubmissionRecord, 'state' | 'gradingRunId' | 'resultId' | 'gradingStatus' | 'gradingAttempt' | 'previousResultIds' | 'failureReason'>): Promise<SubmissionRecord> {
    try {
      const row = await this.db.submission.update({
        where: { id },
        data: {
          state: patch.state,
          gradingStatus: patch.gradingStatus ?? null,
          gradingAttempt: patch.gradingAttempt ?? null,
          previousResultIds: jsonValue(patch.previousResultIds),
          failureReason: patch.failureReason ?? null,
          currentGradingRunId: patch.gradingRunId ?? null,
          currentResultId: patch.resultId ?? null,
        },
        include: { gradingRuns: true, results: true },
      });
      return mapSubmission(row);
    } catch (error) {
      prismaError(error, 'P2025', `submission not found: ${id}`);
    }
  }

  async createRun(input: GradingRun): Promise<GradingRun> {
    try {
      const row = await this.transaction(async (tx) => {
        const created = await tx.gradingRun.create({ data: runData(input) });
        await tx.submission.update({ where: { id: input.submissionId }, data: { currentGradingRunId: input.id, currentResultId: null } });
        return created;
      });
      return mapRun(row);
    } catch (error) {
      prismaError(error, 'P2002', `grading run already exists for idempotency key: ${input.idempotencyKey}`);
      prismaError(error, 'P2025', `submission not found: ${input.submissionId}`);
    }
  }

  async getRunById(id: string): Promise<GradingRun | undefined> {
    const row = await this.db.gradingRun.findUnique({ where: { id } });
    return row ? mapRun(row) : undefined;
  }

  /** Atomic compare-and-set lease. A concurrent worker can update zero rows. */
  async leaseRun(id: string, leaseId: string, workerId: string, leaseExpiresAt: string): Promise<GradingRun | undefined> {
    const now = new Date();
    const changed = await this.db.gradingRun.updateMany({
      where: {
        id,
        OR: [
          { status: 'QUEUED' },
          { status: 'RUNNING', leaseExpiresAt: { lt: now } },
          { status: 'FAILED' },
        ],
      },
      data: { status: 'RUNNING', leaseId, leasedBy: workerId, leaseExpiresAt: new Date(leaseExpiresAt) },
    });
    if (!changed.count) return undefined;
    const row = await this.db.gradingRun.findUnique({ where: { id } });
    return row ? mapRun(row) : undefined;
  }

  async updateRun(id: string, patch: Partial<Pick<GradingRun, 'status' | 'failureReason' | 'leaseId' | 'leasedBy' | 'leaseExpiresAt' | 'evaluationBatchId'>>): Promise<GradingRun> {
    try {
      const row = await this.db.gradingRun.update({
        where: { id },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
          ...(patch.leaseId !== undefined ? { leaseId: patch.leaseId } : {}),
          ...(patch.leasedBy !== undefined ? { leasedBy: patch.leasedBy } : {}),
          ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: date(patch.leaseExpiresAt) } : {}),
          ...(patch.evaluationBatchId !== undefined ? { evaluationBatchId: patch.evaluationBatchId } : {}),
        },
      });
      return mapRun(row);
    } catch (error) {
      prismaError(error, 'P2025', `grading run not found: ${id}`);
    }
  }

  async createBatch(input: EvaluationBatch): Promise<EvaluationBatch> {
    if (!input.runIds.length || input.runIds.length !== input.submissionIds.length) throw new BadRequestException('evaluation batch must contain matching non-empty run and submission sets');
    try {
      return await this.transaction(async (tx) => {
        const event = await tx.event.findUnique({ where: { id: input.eventId }, select: { id: true, challengeVersionId: true } });
        if (!event || event.challengeVersionId !== input.challengeVersion) throw new BadRequestException('evaluation batch event/challenge version mismatch');
        const runs = await tx.gradingRun.findMany({ where: { id: { in: input.runIds } }, select: { id: true, submissionId: true, evaluationBatchId: true, submission: { select: { eventId: true } } }, orderBy: { id: 'asc' } });
        if (runs.length !== input.runIds.length) throw new NotFoundException('one or more grading runs do not exist');
        if (runs.some((run) => run.evaluationBatchId)) throw new ConflictException('one or more grading runs already belong to a batch');
        const runSubmissionIds = runs.map((run) => run.submissionId).sort();
        const requestedSubmissionIds = [...input.submissionIds].sort();
        if (runSubmissionIds.join('\0') !== requestedSubmissionIds.join('\0')) throw new BadRequestException('evaluation batch submission set does not match its grading runs');
        if (runs.some((run) => run.submission.eventId !== input.eventId)) throw new BadRequestException('evaluation batch contains a submission from another event');
        const row = await tx.evaluationBatch.create({ data: batchData(input) });
        const claimed = await tx.gradingRun.updateMany({ where: { id: { in: input.runIds }, evaluationBatchId: null }, data: { evaluationBatchId: input.id } });
        if (claimed.count !== input.runIds.length) throw new ConflictException('evaluation batch run binding lost a concurrent race');
        return mapBatch(row);
      });
    } catch (error) {
      prismaError(error, 'P2002', `evaluation batch already exists: ${input.id}`);
      prismaError(error, 'P2025', `evaluation batch dependency not found: ${input.id}`);
    }
  }

  async getBatchById(id: string): Promise<EvaluationBatch | undefined> {
    const row = await this.db.evaluationBatch.findUnique({ where: { id } });
    return row ? mapBatch(row) : undefined;
  }

  /** Atomic compare-and-set batch lease. */
  async leaseBatch(id: string, leaseId: string, workerId: string, leaseExpiresAt: string): Promise<EvaluationBatch | undefined> {
    const now = new Date();
    const changed = await this.db.evaluationBatch.updateMany({
      where: {
        id,
        OR: [
          { status: 'QUEUED' },
          { status: 'RUNNING', leaseExpiresAt: { lt: now } },
        ],
      },
      data: { status: 'RUNNING', leaseId, leasedBy: workerId, leaseExpiresAt: new Date(leaseExpiresAt) },
    });
    if (!changed.count) return undefined;
    const row = await this.db.evaluationBatch.findUnique({ where: { id } });
    return row ? mapBatch(row) : undefined;
  }

  async updateBatch(id: string, patch: Partial<Pick<EvaluationBatch, 'status' | 'leaseId' | 'leasedBy' | 'leaseExpiresAt' | 'completionLeaseId' | 'completedRunIds' | 'failedRunIds' | 'failureReason' | 'finishedAt'>>): Promise<EvaluationBatch> {
    try {
      const row = await this.db.evaluationBatch.update({
        where: { id },
        data: {
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.leaseId !== undefined ? { leaseId: patch.leaseId } : {}),
          ...(patch.leasedBy !== undefined ? { leasedBy: patch.leasedBy } : {}),
          ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: date(patch.leaseExpiresAt) } : {}),
          ...(patch.completionLeaseId !== undefined ? { completionLeaseId: patch.completionLeaseId } : {}),
          ...(patch.completedRunIds !== undefined ? { completedRunIds: jsonValue(patch.completedRunIds) } : {}),
          ...(patch.failedRunIds !== undefined ? { failedRunIds: jsonValue(patch.failedRunIds) } : {}),
          ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
          ...(patch.finishedAt !== undefined ? { finishedAt: date(patch.finishedAt) } : {}),
        },
      });
      return mapBatch(row);
    } catch (error) {
      prismaError(error, 'P2025', `evaluation batch not found: ${id}`);
    }
  }

  async appendResult(input: StoredResult): Promise<StoredResult> {
    const result = input.result;
    const total = Number(result.recalculatedTotal ?? result.total ?? 0);
    if (!Number.isFinite(total) || total < 0 || total > 100) throw new BadRequestException('evaluation result total is invalid');
    try {
      return await this.transaction(async (tx) => {
        const existing = await tx.evaluationResult.findUnique({ where: { gradingRunId: input.gradingRunId }, include: { submission: true } });
        if (existing) {
          if (existing.id !== input.resultId) throw new ConflictException(`grading run already has result: ${input.gradingRunId}`);
          if (existing.submissionId !== input.submissionId || existing.submission.eventId !== input.eventId) throw new ConflictException('evaluation result identity does not match the existing grading run');
          return mapResult(existing);
        }
        const run = await tx.gradingRun.findUnique({ where: { id: input.gradingRunId }, select: { id: true, submissionId: true, evaluationBatchId: true, submission: { select: { eventId: true } } } });
        if (!run) throw new NotFoundException(`grading run not found: ${input.gradingRunId}`);
        if (run.submissionId !== input.submissionId) throw new ConflictException('evaluation result submission does not match grading run');
        if (run.submission.eventId !== input.eventId) throw new ConflictException('evaluation result event does not match grading run');
        const row = await tx.evaluationResult.create({
          data: {
            id: input.resultId,
            gradingRunId: input.gradingRunId,
            submissionId: input.submissionId,
            schemaVersion: typeof result.schemaVersion === 'string' ? result.schemaVersion : '1.0',
            rubricVersion: typeof result.rubricVersion === 'string' ? result.rubricVersion : '1.0',
            total,
            status: typeof result.status === 'string' ? result.status : 'COMPLETE',
            resultJson: result as Prisma.InputJsonValue,
            importedAt: new Date(input.importedAt),
          },
          include: { submission: true },
        });
        const failed = result.status === 'FAILED';
        await tx.gradingRun.update({ where: { id: input.gradingRunId }, data: { status: failed ? 'FAILED' : 'GRADED', leaseId: null, leasedBy: null, leaseExpiresAt: null, failureReason: failed ? String(result.failureReason ?? 'evaluation result failed') : null } });
        await tx.submission.update({ where: { id: input.submissionId }, data: { state: failed ? 'FAILED' : 'GRADED', gradingStatus: failed ? 'FAILED' : 'COMPLETED', failureReason: failed ? String(result.failureReason ?? 'evaluation result failed') : null, currentResultId: input.resultId } });
        if (run.evaluationBatchId) {
          const batch = await tx.evaluationBatch.findUnique({ where: { id: run.evaluationBatchId } });
          if (batch) {
            const list = (value: Prisma.JsonValue | null): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
            const completedRunIds = list(batch.completedRunIds);
            const failedRunIds = list(batch.failedRunIds);
            const target = failed ? failedRunIds : completedRunIds;
            if (!target.includes(input.gradingRunId)) target.push(input.gradingRunId);
            const allRunIds = list(batch.runIds);
            const finished = allRunIds.length > 0 && allRunIds.every((id) => completedRunIds.includes(id) || failedRunIds.includes(id));
            await tx.evaluationBatch.update({
              where: { id: batch.id },
              data: {
                completedRunIds,
                failedRunIds,
                status: finished ? (failedRunIds.length ? 'PARTIAL' : 'COMPLETED') : 'RUNNING',
                ...(finished ? { finishedAt: new Date() } : {}),
              },
            });
          }
        }
        await tx.auditLog.create({
          data: {
            id: `audit-${randomUUID()}`,
            actorId: 'evaluation-worker',
            action: failed ? 'grading.result-failed' : 'grading.result-accepted',
            target: `gradingRun:${input.gradingRunId}`,
            after: { resultId: input.resultId, submissionId: input.submissionId, status: failed ? 'FAILED' : 'GRADED' },
          },
        });
        return mapResult(row);
      });
    } catch (error) {
      // A retried callback can race the first insert.  The unique
      // gradingRunId constraint is the arbiter; return the already committed
      // fact when it describes the same run/submission instead of turning a
      // safe retry into a 409.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.db.evaluationResult.findUnique({ where: { gradingRunId: input.gradingRunId }, include: { submission: true } });
        if (existing && existing.id === input.resultId && existing.submissionId === input.submissionId && existing.submission.eventId === input.eventId) return mapResult(existing);
      }
      prismaError(error, 'P2002', `evaluation result already exists for grading run: ${input.gradingRunId}`);
      prismaError(error, 'P2025', `evaluation result dependency not found: ${input.resultId}`);
    }
  }

  async getResultByRunId(runId: string): Promise<StoredResult | undefined> {
    const row = await this.db.evaluationResult.findUnique({ where: { gradingRunId: runId }, include: { submission: true } });
    return row ? mapResult(row) : undefined;
  }
}
