import { Prisma, PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { PlatformStatePersistence, PlatformStateSnapshot, PlatformStore } from './store';
import { defaultCodeAgentRuntimeConfig, buildCodeAgentRuntimeConfig } from './code-agent-runtime';
import { AppUser, Challenge, EventConfig, EvaluationBatch, GradingRun, Season, StoredResult, SubmissionRecord } from './domain';
import { mapOrgUnit, mapUser } from './prisma-platform-repository';
import { mapBatch, mapChallenge, mapEvent, mapResult, mapRun, mapSubmission } from './prisma-domain-repository';

const SNAPSHOT_ID = 'singleton';
const SNAPSHOT_VERSION = 1;
const RUNTIME_SETTING_KEY = 'code-agent-runtime';

function repositoryMode(): string {
  return (process.env.PLATFORM_REPOSITORY ?? 'file').trim().toLowerCase();
}

function isSnapshot(value: unknown): value is Partial<PlatformStateSnapshot> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return ['events', 'submissions', 'runs', 'evaluationBatches', 'results', 'orgUnits', 'users', 'challenges', 'seasons', 'audits', 'announcements', 'hardProblems', 'participants'].every((key) => state[key] === undefined || Array.isArray(state[key]));
}

function jsonValue(value: unknown, fallback: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return fallback;
  return value as Prisma.InputJsonValue;
}

function dateValue(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}

function ids<T extends { id: string }>(rows: readonly T[]): string[] {
  return rows.map((row) => row.id);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sortedByLevel<T extends { level: number }>(rows: readonly T[], direction: 1 | -1): T[] {
  return [...rows].sort((left, right) => (left.level - right.level) * direction);
}

function versionData(version: Challenge['versions'][number]): Prisma.ChallengeVersionUncheckedCreateInput {
  return {
    id: version.id,
    challengeId: version.challengeId,
    version: version.version,
    title: version.title,
    description: version.description ?? null,
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

export type NormalizedDb = PrismaClient | Prisma.TransactionClient;

/**
 * Synchronize the in-memory domain snapshot into the normalized tables and
 * the compatibility envelope in one transaction. The envelope is now only a
 * migration/cache aid; startup reads the normalized rows whenever they exist.
 */
/**
 * Write the canonical domain snapshot to the normalized tables.  This is
 * exported for the request-scoped PostgreSQL unit of work as well as the
 * startup compatibility writer.  Both callers pass a transaction client, so
 * a domain mutation and its projections commit (or roll back) together.
 */
export async function synchronizeNormalized(db: Prisma.TransactionClient, state: PlatformStateSnapshot, revision: number): Promise<void> {
  const eventIds = ids(state.events);
  const submissionIds = ids(state.submissions);
  const runIds = ids(state.runs);
  const batchIds = ids(state.evaluationBatches);
  const resultIds = state.results.map((result) => result.resultId);
  const orgUnitIds = ids(state.orgUnits);
  const userIds = ids(state.users);
  const challengeIds = ids(state.challenges);
  const versionIds = state.challenges.flatMap((challenge) => challenge.versions.map((version) => version.id));
  const seasonIds = ids(state.seasons);
  const auditIds = ids(state.audits);
  const announcementIds = ids(state.announcements);

  // Remove stale rows in dependency order. Role bindings and composite join
  // tables are projections of the domain snapshot, so replacing those small
  // tables avoids orphaned scope grants after an administrator edit.
  // Criteria/findings are relational projections of the immutable result
  // JSON. Remove projections only for deleted results; current results are
  // rebuilt below so a normal domain write cannot silently erase report
  // evidence that was imported by a worker.
  await db.criterionResult.deleteMany(resultIds.length ? { where: { evaluationResultId: { notIn: resultIds } } } : undefined);
  await db.finding.deleteMany(resultIds.length ? { where: { evaluationResultId: { notIn: resultIds } } } : undefined);
  await db.evaluationResult.deleteMany({ where: { id: { notIn: resultIds } } });
  await db.gradingRun.deleteMany({ where: { id: { notIn: runIds } } });
  await db.evaluationBatch.deleteMany({ where: { id: { notIn: batchIds } } });
  await db.submission.deleteMany({ where: { id: { notIn: submissionIds } } });
  await db.participation.deleteMany();
  await db.seasonEvent.deleteMany();
  await db.event.deleteMany({ where: { id: { notIn: eventIds } } });
  await db.challengeVersion.deleteMany({ where: { id: { notIn: versionIds } } });
  await db.challenge.deleteMany({ where: { id: { notIn: challengeIds } } });
  await db.roleBinding.deleteMany();
  await db.appUser.deleteMany({ where: { id: { notIn: userIds } } });

  const staleOrgUnits = await db.orgUnit.findMany({ where: { id: { notIn: orgUnitIds } }, select: { id: true, level: true } });
  for (const unit of sortedByLevel(staleOrgUnits, -1)) await db.orgUnit.delete({ where: { id: unit.id } });
  await db.season.deleteMany({ where: { id: { notIn: seasonIds } } });
  await db.auditLog.deleteMany({ where: { id: { notIn: auditIds } } });
  await db.announcement.deleteMany({ where: { id: { notIn: announcementIds } } });

  for (const unit of sortedByLevel(state.orgUnits, 1)) {
    await db.orgUnit.upsert({
      where: { id: unit.id },
      update: { parentId: unit.parentId ?? null, path: unit.path, level: unit.level, label: unit.label, name: unit.name },
      create: { id: unit.id, parentId: unit.parentId ?? null, path: unit.path, level: unit.level, label: unit.label, name: unit.name },
    });
  }
  for (const user of state.users) {
    await db.appUser.upsert({
      where: { id: user.id },
      update: { employeeNo: user.employeeNo, name: user.name, nickname: user.nickname ?? null, avatarDataUrl: user.avatarDataUrl ?? null, orgUnitId: user.orgUnitId || null, orgPath: user.orgPath || null, departmentHint: user.departmentHint ?? null, departmentSource: user.departmentSource ?? null, roles: jsonValue(user.roles, []), status: user.status },
      create: { id: user.id, employeeNo: user.employeeNo, name: user.name, nickname: user.nickname ?? null, avatarDataUrl: user.avatarDataUrl ?? null, orgUnitId: user.orgUnitId || null, orgPath: user.orgPath || null, departmentHint: user.departmentHint ?? null, departmentSource: user.departmentSource ?? null, roles: jsonValue(user.roles, []), status: user.status },
    });
    if (user.roleBindings?.length) {
      await db.roleBinding.createMany({ data: user.roleBindings.map((binding) => ({ userId: user.id, role: binding.role, scopeOrgPath: binding.scopeOrgPath })), skipDuplicates: true });
    }
  }
  for (const challenge of state.challenges) {
    await db.challenge.upsert({
      where: { id: challenge.id },
      update: { ownerOrgPath: challenge.ownerOrgPath, origin: challenge.origin, category: challenge.category ?? 'TRAINING', status: challenge.status, archivedFrom: challenge.archivedFrom ?? null, board: jsonValue(challenge.board) },
      create: { id: challenge.id, ownerOrgPath: challenge.ownerOrgPath, origin: challenge.origin, category: challenge.category ?? 'TRAINING', status: challenge.status, archivedFrom: challenge.archivedFrom ?? null, board: jsonValue(challenge.board) },
    });
    for (const version of challenge.versions) {
      await db.challengeVersion.upsert({
        where: { challengeId_version: { challengeId: challenge.id, version: version.version } },
        update: versionData(version),
        create: versionData(version),
      });
    }
  }
  for (const event of state.events) {
    await db.event.upsert({
      where: { id: event.id },
      update: { challengeVersionId: event.challengeVersion, mode: event.mode ?? 'LIVE', submissionSource: event.submissionSource, deliveryConfig: jsonValue(event.deliveryConfig, {}), trigger: event.trigger, reveal: event.reveal, participantMode: event.participantMode ?? 'OPEN', purpose: event.purpose ?? null, accessPolicy: jsonValue(event.accessPolicy), rubricVersion: event.rubricVersion ?? '1.0', startsAt: dateValue(event.startsAt), endsAt: dateValue(event.endsAt), status: event.status, localGrading: jsonValue(event.localGrading) },
      create: { id: event.id, challengeVersionId: event.challengeVersion, mode: event.mode ?? 'LIVE', submissionSource: event.submissionSource, deliveryConfig: jsonValue(event.deliveryConfig, {}), trigger: event.trigger, reveal: event.reveal, participantMode: event.participantMode ?? 'OPEN', purpose: event.purpose ?? null, accessPolicy: jsonValue(event.accessPolicy), rubricVersion: event.rubricVersion ?? '1.0', startsAt: dateValue(event.startsAt), endsAt: dateValue(event.endsAt), status: event.status, localGrading: jsonValue(event.localGrading) },
    });
  }
  if (state.participants.length) await db.participation.createMany({ data: state.participants.map((participant) => ({ eventId: participant.eventId, subjectId: participant.subjectId, orgPathSnapshot: participant.orgPathSnapshot, importedAt: dateValue(participant.importedAt) ?? new Date() })) });
  for (const submission of state.submissions) {
    const snapshot = submission.snapshot;
    const data = {
      eventId: submission.eventId,
      subjectId: submission.subjectId,
      orgPathSnapshot: submission.orgPathSnapshot ?? null,
      sourceType: snapshot.sourceType,
      snapshotHash: snapshot.snapshotHash,
      artifactUri: snapshot.artifactUri ?? null,
      artifactName: snapshot.artifactName ?? null,
      artifactHash: snapshot.artifactHash ?? null,
      repository: snapshot.repository ?? null,
      branch: snapshot.branch ?? null,
      commitSha: snapshot.commitSha ?? null,
      workspacePath: snapshot.workspacePath ?? null,
      submittedAt: dateValue(snapshot.submittedAt) ?? new Date(),
      state: submission.state,
      challengeVersionSnapshot: submission.challengeVersionSnapshot ?? null,
      rubricVersionSnapshot: submission.rubricVersionSnapshot ?? null,
      gradingStatus: submission.gradingStatus ?? null,
      gradingAttempt: submission.gradingAttempt ?? null,
      previousResultIds: jsonValue(submission.previousResultIds),
      failureReason: submission.failureReason ?? null,
      currentGradingRunId: submission.gradingRunId ?? null,
      currentResultId: submission.resultId ?? null,
    };
    await db.submission.upsert({ where: { id: submission.id }, update: data, create: { id: submission.id, ...data } });
  }
  for (const batch of state.evaluationBatches) {
    const data = {
      eventId: batch.eventId,
      challengeVersionId: batch.challengeVersion,
      runIds: jsonValue(batch.runIds, []),
      submissionIds: jsonValue(batch.submissionIds, []),
      engineIdentity: batch.engineIdentity,
      codeAgentRuntime: jsonValue(batch.codeAgentRuntime),
      createdBy: batch.createdBy,
      status: batch.status,
      leaseId: batch.leaseId ?? null,
      completionLeaseId: batch.completionLeaseId ?? null,
      leasedBy: batch.leasedBy ?? null,
      leaseExpiresAt: dateValue(batch.leaseExpiresAt),
      completedRunIds: jsonValue(batch.completedRunIds),
      failedRunIds: jsonValue(batch.failedRunIds),
      failureReason: batch.failureReason ?? null,
      finishedAt: dateValue(batch.finishedAt),
    };
    await db.evaluationBatch.upsert({ where: { id: batch.id }, update: data, create: { id: batch.id, createdAt: dateValue(batch.createdAt) ?? new Date(), ...data } });
  }
  for (const run of state.runs) {
    const data = { submissionId: run.submissionId, triggerType: run.triggerType, triggeredBy: run.triggeredBy ?? null, status: run.status, idempotencyKey: run.idempotencyKey, graderVersion: null, attempt: run.attempt ?? null, failureReason: run.failureReason ?? null, leaseId: run.leaseId ?? null, leasedBy: run.leasedBy ?? null, leaseExpiresAt: dateValue(run.leaseExpiresAt), evaluationBatchId: run.evaluationBatchId ?? null };
    await db.gradingRun.upsert({ where: { id: run.id }, update: data, create: { id: run.id, createdAt: dateValue(run.createdAt) ?? new Date(), ...data } });
  }
  for (const stored of state.results) {
    const result = stored.result ?? {};
    await db.criterionResult.deleteMany({ where: { evaluationResultId: stored.resultId } });
    await db.finding.deleteMany({ where: { evaluationResultId: stored.resultId } });
    const data = {
      gradingRunId: stored.gradingRunId,
      submissionId: stored.submissionId,
      schemaVersion: typeof result.schemaVersion === 'string' ? result.schemaVersion : '1.0',
      rubricVersion: typeof result.rubricVersion === 'string' ? result.rubricVersion : '1.0',
      total: numberValue(result.recalculatedTotal ?? result.total),
      status: typeof result.status === 'string' ? result.status : 'COMPLETE',
      resultJson: jsonValue(result, {}),
      importedAt: dateValue(stored.importedAt),
    };
    await db.evaluationResult.upsert({ where: { id: stored.resultId }, update: data, create: { id: stored.resultId, createdAt: dateValue(stored.importedAt) ?? new Date(), ...data } });
    const criteria = Array.isArray(result.criteria) ? result.criteria.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
    if (criteria.length) {
      await db.criterionResult.createMany({
        data: criteria.map((criterion, index) => {
          const key = typeof criterion.key === 'string' && criterion.key.trim() ? criterion.key : `criterion-${index + 1}`;
          const dimension = typeof criterion.dim === 'string' && criterion.dim.trim() ? criterion.dim : 'unknown';
          const level = typeof criterion.level === 'string' && criterion.level.trim() ? criterion.level : 'UNKNOWN';
          const source = typeof criterion.source === 'string' && criterion.source.trim() ? criterion.source : 'unknown';
          const score = numberValue(criterion.score);
          const max = numberValue(criterion.max);
          return {
            evaluationResultId: stored.resultId,
            criterionKey: key,
            dimension,
            level,
            score,
            max,
            source,
            ...(criterion.evidence !== undefined ? { evidenceJson: jsonValue(criterion.evidence) } : {}),
          };
        }),
      });
    }
    const findings = Array.isArray(result.findings) ? result.findings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
    if (findings.length) {
      await db.finding.createMany({
        data: findings.map((finding, index) => ({
          id: `${stored.resultId}:finding:${typeof finding.id === 'string' && finding.id.trim() ? finding.id.trim() : index + 1}`,
          evaluationResultId: stored.resultId,
          criterionKey: typeof finding.criteria === 'string' && finding.criteria.trim() ? finding.criteria : 'unknown',
          severity: typeof finding.severity === 'string' && finding.severity.trim() ? finding.severity : 'unknown',
          title: typeof finding.title === 'string' && finding.title.trim() ? finding.title : 'Finding',
          file: typeof finding.file === 'string' ? finding.file : null,
          line: Number.isSafeInteger(finding.line) ? finding.line as number : null,
          detail: typeof finding.detail === 'string' ? finding.detail : '',
          fix: typeof finding.fix === 'string' ? finding.fix : null,
        })),
      });
    }
  }
  for (const season of state.seasons) {
    await db.season.upsert({ where: { id: season.id }, update: { name: season.name, status: season.status }, create: { id: season.id, name: season.name, status: season.status } });
    for (const eventId of season.eventIds) await db.seasonEvent.create({ data: { seasonId: season.id, eventId, weight: 1 } });
  }
  for (const audit of state.audits) {
    const data = { actorId: audit.actorId, action: audit.action, target: audit.target, before: jsonValue(audit.before), after: jsonValue(audit.after), createdAt: dateValue(audit.createdAt) ?? new Date() };
    await db.auditLog.upsert({ where: { id: audit.id }, update: data, create: { id: audit.id, ...data } });
  }
  for (const announcement of state.announcements) {
    const data = { title: announcement.title, summary: announcement.summary, tag: announcement.tag, publishedAt: dateValue(announcement.publishedAt) ?? new Date(), pinned: Boolean(announcement.pinned), orgPath: announcement.orgPath ?? null };
    await db.announcement.upsert({ where: { id: announcement.id }, update: data, create: { id: announcement.id, ...data } });
  }
  await db.systemSetting.upsert({
    where: { key: RUNTIME_SETTING_KEY },
    update: { value: jsonValue(state.codeAgentRuntimeConfig, {}), updatedBy: state.codeAgentRuntimeConfig.updatedBy },
    create: { key: RUNTIME_SETTING_KEY, value: jsonValue(state.codeAgentRuntimeConfig, {}), updatedBy: state.codeAgentRuntimeConfig.updatedBy },
  });
  await db.platformSnapshot.upsert({ where: { id: SNAPSHOT_ID }, update: { schemaVersion: SNAPSHOT_VERSION, revision, state: state as unknown as Prisma.InputJsonValue }, create: { id: SNAPSHOT_ID, schemaVersion: SNAPSHOT_VERSION, revision, state: state as unknown as Prisma.InputJsonValue } });
}

/** Read the canonical normalized graph for an API process startup. */
/** Read the normalized domain graph from either a client or an open transaction. */
export async function loadNormalizedState(client: NormalizedDb): Promise<PlatformStateSnapshot | undefined> {
  const [orgRows, userRows, challengeRows, eventRows, participantRows, submissionRows, runRows, batchRows, resultRows, seasonRows, auditRows, announcementRows, runtimeRow] = await Promise.all([
    client.orgUnit.findMany({ orderBy: [{ level: 'asc' }, { path: 'asc' }] }),
    client.appUser.findMany({ include: { roleBindings: true } }),
    client.challenge.findMany({ include: { versions: true } }),
    client.event.findMany(),
    client.participation.findMany(),
    client.submission.findMany({ include: { gradingRuns: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 }, results: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } } }),
    client.gradingRun.findMany(),
    client.evaluationBatch.findMany(),
    client.evaluationResult.findMany({ include: { submission: { select: { eventId: true } } } }),
    client.season.findMany({ include: { eventLinks: true } }),
    client.auditLog.findMany({ orderBy: { createdAt: 'asc' } }),
    client.announcement.findMany(),
    client.systemSetting.findUnique({ where: { key: RUNTIME_SETTING_KEY } }),
  ]);
  const hasData = orgRows.length || userRows.length || challengeRows.length || eventRows.length || participantRows.length || submissionRows.length || runRows.length || batchRows.length || resultRows.length || seasonRows.length || auditRows.length || announcementRows.length;
  if (!hasData) return undefined;
  const runtimeValue = runtimeRow?.value;
  let codeAgentRuntimeConfig = defaultCodeAgentRuntimeConfig();
  if (runtimeValue && typeof runtimeValue === 'object' && !Array.isArray(runtimeValue)) {
    try {
      const candidate = runtimeValue as unknown as typeof codeAgentRuntimeConfig;
      codeAgentRuntimeConfig = buildCodeAgentRuntimeConfig(candidate, candidate.updatedBy || 'system', candidate.updatedAt || new Date().toISOString());
    } catch {
      // An invalid optional runtime setting must not make business data
      // unreadable; the domain default remains subject to administrator reset.
    }
  }
  return {
    events: eventRows.map(mapEvent),
    submissions: submissionRows.map(mapSubmission),
    runs: runRows.map(mapRun),
    evaluationBatches: batchRows.map(mapBatch),
    results: resultRows.map(mapResult),
    orgUnits: orgRows.map(mapOrgUnit),
    users: userRows.map(mapUser),
    challenges: challengeRows.map(mapChallenge),
    seasons: seasonRows.map((row) => ({ id: row.id, name: row.name, status: row.status === 'RUNNING' ? 'RUNNING' : row.status === 'FINISHED' ? 'FINISHED' : 'DRAFT', eventIds: row.eventLinks.map((link) => link.eventId) } as Season)),
    audits: auditRows.map((row) => ({ id: row.id, actorId: row.actorId, action: row.action, target: row.target, ...(row.before !== null ? { before: row.before } : {}), ...(row.after !== null ? { after: row.after } : {}), createdAt: row.createdAt.toISOString() })),
    announcements: announcementRows.map((row) => ({ id: row.id, title: row.title, summary: row.summary, tag: row.tag as never, publishedAt: row.publishedAt.toISOString(), ...(row.pinned ? { pinned: true } : {}), ...(row.orgPath ? { orgPath: row.orgPath } : {}) })),
    hardProblems: [],
    participants: participantRows.map((row) => ({ eventId: row.eventId, subjectId: row.subjectId, orgPathSnapshot: row.orgPathSnapshot, importedAt: row.importedAt.toISOString() })),
    codeAgentRuntimeConfig,
  };
}

export async function claimSnapshotRevision(db: Prisma.TransactionClient, expectedRevision: number): Promise<number> {
  // Ensure an old snapshot-only database has a row before the compare-and-set.
  // The row is created with an empty state inside the same transaction and is
  // never visible until the complete normalized synchronization commits.
  await db.platformSnapshot.upsert({
    where: { id: SNAPSHOT_ID },
    update: {},
    create: { id: SNAPSHOT_ID, schemaVersion: SNAPSHOT_VERSION, revision: 0, state: {} },
  });
  const changed = await db.platformSnapshot.updateMany({
    where: { id: SNAPSHOT_ID, revision: expectedRevision },
    data: { revision: { increment: 1 } },
  });
  if (changed.count !== 1) {
    throw new ConflictException('platform state changed on another API instance; retry the request');
  }
  return expectedRevision + 1;
}

class PrismaNormalizedPersistence implements PlatformStatePersistence {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(private readonly client: PrismaClient, private expectedRevision: number) {}

  write(state: PlatformStateSnapshot): void {
    if (this.failure) return;
    this.tail = this.tail.then(async () => {
      await this.client.$transaction(async (db) => {
        const revision = await claimSnapshotRevision(db, this.expectedRevision);
        await synchronizeNormalized(db, state, revision);
        this.expectedRevision = revision;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: Number(process.env.PERSIST_TRANSACTION_TIMEOUT_MS ?? 120_000) });
    }).catch((error) => { this.failure = error; });
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  noteExternalCommit(): void {
    // PrismaPlatformRepository increments the same database revision in its
    // transaction.  Advance the local expected value so a subsequent write
    // from this process does not conflict with its own canonical commit;
    // another API instance remains protected by the CAS check.
    this.expectedRevision += 1;
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.client.$disconnect();
    }
  }
}

/**
 * Nest factory for the stateful PlatformStore. PostgreSQL is selected once at
 * process startup; there is no request-time adapter switching or JSON fallback
 * in production. Normalized rows are the read source, while the envelope is
 * retained only for rollback/migration compatibility.
 */
export async function createPlatformStore(): Promise<PlatformStore> {
  const mode = repositoryMode();
  if (mode === 'file') {
    if (process.env.NODE_ENV === 'production') throw new Error('file repository is not allowed in production');
    return process.env.PLATFORM_DATA_FILE ? new PlatformStore(process.env.PLATFORM_DATA_FILE) : new PlatformStore();
  }
  if (mode !== 'postgres') throw new Error(`unsupported PLATFORM_REPOSITORY: ${mode}`);
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required when PLATFORM_REPOSITORY=postgres');

  const client = new PrismaClient();
  try {
    await client.$connect();
    const row = await client.platformSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
    if (row && (row.schemaVersion !== SNAPSHOT_VERSION || !isSnapshot(row.state))) throw new Error('platform PostgreSQL snapshot is invalid or unsupported');
    const normalized = await loadNormalizedState(client);
    const store = new PlatformStore({ dataFile: ':memory:', seed: false });
    const compatibility = row?.state as unknown as Partial<PlatformStateSnapshot> | undefined;
    if (normalized) {
      // Legacy hard-problem entries were stored only in the compatibility
      // envelope. Keep them until their challenge.board projection is
      // explicitly migrated; new hard-problem writes are normalized through
      // the Challenge.board JSON field.
      store.importState(normalized.hardProblems?.length || !compatibility?.hardProblems?.length
        ? normalized
        : { ...normalized, hardProblems: compatibility.hardProblems });
    } else if (row) store.importState(compatibility ?? {});
    const persistence = new PrismaNormalizedPersistence(client, row?.revision ?? 0);
    // Existing snapshot-only databases are upgraded into normalized tables on
    // their first startup. New empty databases also receive one empty envelope.
    store.attachPersistence(persistence, !normalized);
    await store.flushPersistence();
    return store;
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
}
