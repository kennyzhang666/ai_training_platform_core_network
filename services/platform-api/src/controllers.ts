import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Res, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { assertEventSubmissionWindow, PlatformStore } from './store';
import type { UserListQuery, UserListSortBy, UserListSortOrder } from './store';
import type { SubmissionListQuery } from './repository';
import { Announcement, Challenge, ChallengeCategory, ChallengeVersion, CodeAgentRuntimeDiagnostics, CodeAgentRuntimeInput, CodeAgentRuntimeTestInput, EvaluationEngineConfig, EventConfig, HardProblem, HardProblemReviewStatus, HardProblemSolutionVisibility, Season, SubmissionSnapshot, SsoIdentity } from './domain';
import { validateEvaluationResult } from './contract-validator';
import { ArtifactStore } from './artifact-store';
import { GradingExecutor, GRADING_EXECUTOR } from './grading-executor';
import { computeDirectorySnapshotHash } from './snapshot-hash';
import { AutoGradingQueue } from './auto-grading-queue';
import { LocalGitSnapshotter } from './git-snapshotter';
import { EnginePackageStore } from './engine-package-store';
import { ExecutorRegistry } from './executor-registry';
import { EvaluationTaskService } from './evaluation-task-service';
import { SubmissionContractService } from './submission-contract-service';
import { EvaluationBatchService } from './evaluation-batch-service';
import { UserDirectoryService } from './user-directory';
import { OBJECT_STORAGE, ObjectStorage } from './object-storage';
import { PlatformReadService } from './platform-read-service';
import { PostgresDomainUnitOfWork } from './postgres-domain-unit-of-work';
import { PlatformMetrics } from './metrics';
import { EvaluationContractCatalogService } from './evaluation-contract-catalog';
import { CodeAgentRuntimeTestService } from './code-agent-runtime-test';

type UserQueryValue = string | string[] | undefined;
type UserListRequestQuery = Record<string, UserQueryValue>;

const USER_SORT_FIELDS = new Set<UserListSortBy>(['employeeNo', 'name', 'orgPath', 'status', 'id']);

function invalidUserQuery(message: string): BadRequestException {
  return new BadRequestException({ code: 'INVALID_USER_QUERY', message });
}

function queryString(value: UserQueryValue, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw invalidUserQuery(`${name} must be provided once`);
    return value[0];
  }
  return value;
}

function queryInteger(value: UserQueryValue, name: string, fallback: number, maximum?: number): number {
  const raw = queryString(value, name);
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw invalidUserQuery(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || (maximum !== undefined && parsed > maximum)) {
    throw invalidUserQuery(maximum === undefined ? `${name} is out of range` : `${name} must be at most ${maximum}`);
  }
  return parsed;
}

function parseUserListQuery(input: UserListRequestQuery): UserListQuery {
  const sortBy = queryString(input.sortBy, 'sortBy');
  if (sortBy !== undefined && !USER_SORT_FIELDS.has(sortBy as UserListSortBy)) {
    throw invalidUserQuery('sortBy is not supported');
  }
  const sortOrder = queryString(input.sortOrder, 'sortOrder')?.toLowerCase();
  if (sortOrder !== undefined && sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw invalidUserQuery('sortOrder must be asc or desc');
  }
  const status = queryString(input.status, 'status');
  if (status !== undefined && status !== 'ACTIVE' && status !== 'DISABLED') {
    throw invalidUserQuery('status must be ACTIVE or DISABLED');
  }
  const rawRoles = input.role === undefined ? [] : (Array.isArray(input.role) ? input.role : [input.role]);
  const roles = rawRoles.flatMap((value) => value.split(',').map((role) => role.trim()).filter(Boolean));
  if (roles.some((role) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(role))) {
    throw invalidUserQuery('role contains an invalid value');
  }
  const query = queryString(input.query, 'query')?.trim();
  if (query && query.length > 200) throw invalidUserQuery('query must be at most 200 characters');
  const orgPath = queryString(input.orgPath, 'orgPath')?.trim();
  if (orgPath && orgPath.length > 512) throw invalidUserQuery('orgPath must be at most 512 characters');
  return {
    page: queryInteger(input.page, 'page', 1),
    pageSize: queryInteger(input.pageSize, 'pageSize', 20, 100),
    ...(orgPath ? { orgPath } : {}),
    ...(query ? { query } : {}),
    ...(roles.length ? { roles: [...new Set(roles)] } : {}),
    ...(status ? { status: status as 'ACTIVE' | 'DISABLED' } : {}),
    ...(sortBy ? { sortBy: sortBy as UserListSortBy } : {}),
    ...(sortOrder ? { sortOrder: sortOrder as UserListSortOrder } : {}),
  };
}

const PROFILE_NICKNAME_MAX_LENGTH = 32;
const PROFILE_AVATAR_MAX_BYTES = 256 * 1024;
const PROFILE_AVATAR_MIME = /^(image\/png|image\/jpeg|image\/webp)$/;

type UserProfilePatch = { nickname?: string | null; avatarDataUrl?: string | null };

function validAvatarBytes(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && bytes.subarray(12, 16).toString('ascii') === 'IHDR';
  if (mime === 'image/jpeg') return bytes.length >= 4
    && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    && bytes.subarray(bytes.length - 2).equals(Buffer.from([0xff, 0xd9]));
  return bytes.length >= 20 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function parseAvatarDataUrl(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException('avatarDataUrl must be a PNG, JPEG, or WebP data URL');
  if (value.length > 360_000) throw new BadRequestException(`avatarDataUrl must be a valid image no larger than ${PROFILE_AVATAR_MAX_BYTES} bytes`);
  const match = /^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !PROFILE_AVATAR_MIME.test(match[1]) || match[2].length % 4 !== 0) {
    throw new BadRequestException('avatarDataUrl must be a PNG, JPEG, or WebP data URL');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > PROFILE_AVATAR_MAX_BYTES || Buffer.from(bytes).toString('base64') !== match[2] || !validAvatarBytes(match[1], bytes)) {
    throw new BadRequestException(`avatarDataUrl must be a valid image no larger than ${PROFILE_AVATAR_MAX_BYTES} bytes`);
  }
  return `data:${match[1]};base64,${bytes.toString('base64')}`;
}

function parseUserProfilePatch(input: unknown): UserProfilePatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('profile patch must be an object');
  const body = input as Record<string, unknown>;
  const unknownKeys = Object.keys(body).filter((key) => key !== 'nickname' && key !== 'avatarDataUrl');
  if (unknownKeys.length) throw new BadRequestException(`unsupported profile field: ${unknownKeys[0]}`);
  const patch: UserProfilePatch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'nickname')) {
    if (body.nickname !== null && typeof body.nickname !== 'string') throw new BadRequestException('nickname must be a string or null');
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    if ([...nickname].length > PROFILE_NICKNAME_MAX_LENGTH) throw new BadRequestException(`nickname must be at most ${PROFILE_NICKNAME_MAX_LENGTH} characters`);
    patch.nickname = nickname || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'avatarDataUrl')) patch.avatarDataUrl = parseAvatarDataUrl(body.avatarDataUrl);
  if (!Object.keys(patch).length) throw new BadRequestException('at least one profile field is required');
  return patch;
}

@Controller('/api/v1')
export class PlatformController {
  constructor(
    @Inject(PlatformStore) private readonly store: PlatformStore,
    @Inject(ArtifactStore) private readonly artifacts: ArtifactStore,
    @Inject(GRADING_EXECUTOR) private readonly localGrader: GradingExecutor,
    @Inject(AutoGradingQueue) private readonly autoQueue: AutoGradingQueue,
    @Inject(LocalGitSnapshotter) private readonly localGit: LocalGitSnapshotter,
    @Inject(EnginePackageStore) private readonly enginePackages: EnginePackageStore,
    @Inject(ExecutorRegistry) private readonly executors: ExecutorRegistry,
    @Inject(EvaluationTaskService) private readonly tasks: EvaluationTaskService,
    @Inject(SubmissionContractService) private readonly submissionContracts: SubmissionContractService,
    @Inject(EvaluationBatchService) private readonly evaluationBatches: EvaluationBatchService,
    @Inject(UserDirectoryService) private readonly userDirectory: UserDirectoryService,
    @Inject(PlatformReadService) private readonly platformRead: PlatformReadService,
    @Inject(PostgresDomainUnitOfWork) private readonly domainUnitOfWork: PostgresDomainUnitOfWork,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStorage,
    @Inject(PlatformMetrics) private readonly metrics: PlatformMetrics,
    @Inject(EvaluationContractCatalogService) private readonly contractCatalog: EvaluationContractCatalogService,
    @Inject(CodeAgentRuntimeTestService) private readonly codeAgentRuntimeTest: CodeAgentRuntimeTestService,
  ) {}

  private localWorkspaceHash(workspacePath: string): string {
    const cwd = process.cwd();
    const root = resolve(process.env.LOCAL_WORKSPACE_ROOT ?? (existsSync(join(cwd, 'grader', 'run_grader.py')) ? cwd : join(cwd, '..', '..')));
    const target = resolve(root, workspacePath);
    if (!existsSync(root) || !existsSync(target)) throw new BadRequestException('workspacePath does not exist inside the local workspace root');
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    const relativePath = relative(realRoot, realTarget);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new BadRequestException('workspacePath must stay inside the local workspace root');
    }
    const forbidden = new Set(['hidden-tests', 'grader', 'contracts', 'node_modules', '.git', 'tmp']);
    if (relativePath.split(sep).some((part) => forbidden.has(part))) throw new BadRequestException('workspacePath points to a protected platform directory');
    return computeDirectorySnapshotHash(realTarget);
  }

  private normalizeSnapshot(snapshot: SubmissionSnapshot): SubmissionSnapshot {
    if (snapshot.workspacePath) {
      const hash = this.localWorkspaceHash(snapshot.workspacePath);
      if (snapshot.snapshotHash && snapshot.snapshotHash !== hash) throw new BadRequestException('snapshotHash does not match workspace contents');
      if (snapshot.artifactHash && snapshot.artifactHash !== hash && snapshot.sourceType === 'UPLOAD') throw new BadRequestException('artifactHash does not match workspace contents');
      return { ...snapshot, snapshotHash: hash, ...(snapshot.sourceType === 'UPLOAD' && !snapshot.artifactHash ? { artifactHash: hash } : {}) };
    }
    if (snapshot.sourceType === 'GIT_REF' && snapshot.repository && snapshot.branch && snapshot.commitSha) {
      return { ...snapshot, snapshotHash: createHash('sha256').update(`${snapshot.repository}|${snapshot.branch}|${snapshot.commitSha}`).digest('hex') };
    }
    if (snapshot.sourceType === 'GIT_REF' && snapshot.repository && snapshot.branch && !snapshot.snapshotHash) {
      return { ...snapshot, snapshotHash: createHash('sha256').update(`${snapshot.repository}|${snapshot.branch}|${snapshot.submittedAt}`).digest('hex') };
    }
    return snapshot;
  }

  private actor(employeeId?: string): string {
    const supplied = employeeId?.trim();
    if (supplied) return supplied;
    if (process.env.ALLOW_ANONYMOUS_LOCAL === 'true') return 'w00123';
    throw new UnauthorizedException('X-Employee-Id is required');
  }

  private requireAdmin(employeeId?: string): string {
    const actorId = this.actor(employeeId);
    this.store.assertAdmin(actorId);
    return actorId;
  }

  private requireGlobalAdmin(employeeId?: string): string {
    const actorId = this.actor(employeeId);
    this.store.assertGlobalAdmin(actorId);
    return actorId;
  }

  /**
   * A challenge may only select an executor that exists, with parameters its
   * manifest declares. Checking here means a misconfigured challenge is
   * rejected while the author is still editing it, not on the first delivery.
   */
  private assertExecutorSelection(version: { evaluationEngine?: EvaluationEngineConfig } | undefined): void {
    const engine = version?.evaluationEngine;
    if (!engine) return;
    if (engine.mode === 'PLATFORM_LOCAL') {
      if (!engine.executor?.id) throw new BadRequestException({ code: 'EXECUTOR_REQUIRED', message: '请选择一个内置执行器' });
      this.executors.assertExecutorConfiguration(engine.executor.id, engine.executor.params ?? {});
    }
    this.executors.assertAgentConfiguration(engine);
  }

  private assertSubmissionContract(version: { submissionContractDefinition?: unknown } | undefined): void {
    if (version?.submissionContractDefinition !== undefined) this.submissionContracts.assertDefinition(version.submissionContractDefinition);
  }

  private withResolvedSubmissionContracts(challenge: Challenge): Challenge {
    return {
      ...challenge,
      versions: challenge.versions.map((version) => {
        if (version.submissionContractDefinition) return version;
        const definition = this.submissionContracts.resolve(version);
        return definition ? { ...version, submissionContractDefinition: definition } : version;
      }),
    };
  }

  private async scheduleIfAutomatic(eventId: string, submissionId: string): Promise<void> {
    const current = await this.domainUnitOfWork.read((store) => {
      const event = store.getEvent(eventId);
      const submission = store.getSubmission(submissionId);
      return { trigger: event.trigger, gradingRunId: submission.gradingRunId };
    });
    if (current.trigger !== 'AUTO' || !current.gradingRunId) return;
    // The in-process executor remains an explicit single-host compatibility
    // switch. Normal deployments create the pull-based Code Agent batch in
    // the same UoW as submission/regrade creation; this helper must not create
    // it a second time after the transaction has committed.
    if (process.env.EMBEDDED_EVALUATION_WORKER === 'true') this.autoQueue.enqueue(submissionId);
  }

  /**
   * An artifact URI is an internal reference, not an upload credential.  A
   * caller may only reuse one that the platform previously registered for the
   * same event and subject; knowing a local hash or an S3 key is insufficient.
   */
  private assertRegisteredArtifactInStore(store: PlatformStore, eventId: string, subjectId: string, artifactUri: string, uploadOnly = false): void {
    const registered = store.systemSubmissions(eventId).some((submission) => (
      submission.subjectId === subjectId
      && submission.snapshot.artifactUri === artifactUri
      && (!uploadOnly || submission.snapshot.sourceType === 'UPLOAD')
    ));
    if (!registered) throw new BadRequestException('artifactUri must reference an artifact already registered for this event and subject');
  }

  @Get('/health')
  health() {
    return { status: 'ok', service: 'platform-api', time: new Date().toISOString() };
  }

  @Get('/metrics')
  metricsSnapshot(@Headers('x-employee-id') employeeId?: string) {
    this.requireGlobalAdmin(employeeId);
    return this.metrics.snapshot();
  }

  @Get('/me')
  me(@Headers('x-employee-id') employeeId?: string) {
    return this.store.getUser(this.actor(employeeId));
  }

  @Patch('/me/profile')
  async updateMyProfile(@Body() body: unknown, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.userDirectory.updateProfile(actorId, parseUserProfilePatch(body), actorId);
  }

  /**
   * Exchange the trusted internal SSO identity for a local platform account.
   * The gateway supplies only the claims below; the store provisions the
   * employee on first login and keeps later logins idempotent.
   */
  @Post('/auth/sso')
  ssoLogin(@Body() body: SsoIdentity, @Headers('x-employee-id') employeeId?: string) {
    // In production the global identity guard has already verified the
    // gateway/OIDC assertion and synchronized the trusted claims.  Never
    // apply a request-body name or department to that account; the body is
    // retained only for the explicit LOCAL development adapter.
    if (process.env.NODE_ENV === 'production') return this.store.getUser(this.actor(employeeId));
    return this.userDirectory.syncSsoIdentity(body);
  }

  @Get('/announcements')
  async announcements(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => store.listAnnouncements(actorId));
  }

  @Post('/announcements')
  async createAnnouncement(@Body() body: Omit<Announcement, 'id'> & { id?: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...announcement } = body;
    return this.domainUnitOfWork.run((store) => store.createAnnouncement(announcement, actorId));
  }

  @Patch('/announcements/:announcementId')
  async updateAnnouncement(@Param('announcementId') announcementId: string, @Body() body: Partial<Omit<Announcement, 'id'>> & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.domainUnitOfWork.run((store) => store.updateAnnouncement(announcementId, patch, actorId));
  }

  @Delete('/announcements/:announcementId')
  @HttpCode(204)
  async deleteAnnouncement(@Param('announcementId') announcementId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    await this.domainUnitOfWork.run((store) => store.deleteAnnouncement(announcementId, this.requireAdmin(employeeId)));
  }

  @Get('/hard-problems')
  async hardProblems(@Query('status') status?: string, @Query('reviewStatus') reviewStatus?: string, @Headers('x-employee-id') employeeId?: string) {
    if (status && status !== 'OPEN' && status !== 'RESOLVED') throw new BadRequestException('hard problem status must be OPEN or RESOLVED');
    if (reviewStatus && !['PENDING_REVIEW', 'APPROVED', 'REJECTED'].includes(reviewStatus)) throw new BadRequestException('hard problem reviewStatus is invalid');
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => store.listHardProblems(status as 'OPEN' | 'RESOLVED' | undefined, reviewStatus as HardProblemReviewStatus | undefined, actorId));
  }

  @Get('/hard-problems/:problemId')
  async hardProblem(@Param('problemId') problemId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => store.getHardProblem(problemId, actorId));
  }

  @Post('/hard-problems')
  async createHardProblem(@Body() body: Omit<HardProblem, 'id' | 'challengeId' | 'createdAt' | 'updatedAt' | 'status' | 'reviewStatus' | 'resolvedAt' | 'resolvedBy' | 'resolvedByName' | 'solutionSubmissionId' | 'solution'> & { id?: string; status?: 'OPEN' | 'RESOLVED'; solutionVisibility?: HardProblemSolutionVisibility; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const { actorId: _ignoredActorId, ...problem } = body;
    return this.domainUnitOfWork.run((store) => store.createHardProblem(problem, actorId));
  }

  @Post('/hard-problems/:problemId/review')
  async reviewHardProblem(@Param('problemId') problemId: string, @Body() body: { decision?: string; comment?: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new BadRequestException('decision must be APPROVE or REJECT');
    return this.domainUnitOfWork.run((store) => store.reviewHardProblem(problemId, body.decision as 'APPROVE' | 'REJECT', body.comment ?? '', actorId));
  }

  @Post('/hard-problems/:problemId/resolve')
  async resolveHardProblem(@Param('problemId') problemId: string, @Body() body: { actorId?: string; submissionId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.resolveHardProblem(problemId, this.actor(employeeId), body.submissionId));
  }

  /**
   * Upload an evaluation engine package. The response carries the content hash
   * an administrator then pins onto a challenge version; the package itself is
   * immutable and shared by hash, so re-uploading identical bytes is a no-op.
   */
  @Post('/evaluation-engines')
  @HttpCode(201)
  async uploadEnginePackage(@Body() body: { packageBase64?: string; fileName?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!body.packageBase64?.trim()) throw new BadRequestException({ code: 'ENGINE_PACKAGE_EMPTY', message: '请上传引擎包' });
    const normalized = body.packageBase64.replace(/\s+/g, '');
    if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_INVALID', message: 'packageBase64 不是合法 base64' });
    }
    const record = await this.enginePackages.save(Buffer.from(normalized, 'base64'), body.fileName ?? 'engine.zip');
    await this.domainUnitOfWork.run((store) => store.recordEnginePackageUpload(record, actorId));
    return {
      packageHash: record.packageHash,
      size: record.size,
      fileName: record.uploadedFileName,
      engine: { id: record.manifest.id, version: record.manifest.version, description: record.manifest.description },
      runtime: record.manifest.runtime,
      limits: record.manifest.limits ?? null,
      assets: record.manifest.assets ?? null,
      selfCheck: record.manifest.selfCheck ?? null,
    };
  }

  /** Built-in executors shipped in the repository, for the challenge editor. */
  @Get('/evaluation-executors')
  evaluationExecutors(@Headers('x-employee-id') employeeId?: string) {
    this.requireAdmin(employeeId);
    return this.executors.list();
  }

  /** Git-pinned input/output constraints for the challenge editor dropdown. */
  @Get('/evaluation-contracts')
  evaluationContracts(@Headers('x-employee-id') employeeId?: string) {
    this.requireAdmin(employeeId);
    return this.contractCatalog.list();
  }

  /** Full public constraint detail, including its checked-in schema and example. */
  @Get('/evaluation-contracts/:contractId')
  evaluationContract(@Param('contractId') contractId: string, @Headers('x-employee-id') employeeId?: string) {
    this.requireAdmin(employeeId);
    return this.contractCatalog.get(contractId);
  }

  /**
   * Lease queued evaluation tasks. The platform hands out immutable work
   * descriptors; the evaluation environment runs the engine and posts results
   * back, so no challenge or engine code executes while serving this request.
   */
  @Post('/evaluation-tasks:lease')
  @HttpCode(200)
  async leaseEvaluationTasks(@Body() body: { workerId?: string; limit?: number; executorIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const tasks = await this.tasks.leasePersistent(String(body.workerId ?? '').trim(), Number(body.limit ?? 1), Array.isArray(body.executorIds) ? body.executorIds : [], actorId);
    return { leasedAt: new Date().toISOString(), tasks };
  }

  @Post('/evaluation-tasks/:runId/heartbeat')
  @HttpCode(200)
  async heartbeatEvaluationTask(@Param('runId') runId: string, @Body() body: { leaseId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.tasks.heartbeatPersistent(runId, String(body.leaseId ?? ''), this.requireAdmin(employeeId));
  }

  @Post('/evaluation-tasks/:runId/complete')
  @HttpCode(201)
  async completeEvaluationTask(@Param('runId') runId: string, @Body() body: { leaseId?: string; result?: Record<string, unknown> }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!body.result || typeof body.result !== 'object') throw new BadRequestException({ code: 'RESULT_REQUIRED', message: '缺少评测结果' });
    return { accepted: true, stored: await this.tasks.completePersistent(runId, String(body.leaseId ?? ''), body.result, actorId) };
  }

  @Post('/evaluation-tasks/:runId/fail')
  @HttpCode(200)
  async failEvaluationTask(@Param('runId') runId: string, @Body() body: { leaseId?: string; reason?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.tasks.failPersistent(runId, String(body.leaseId ?? ''), String(body.reason ?? ''), this.requireAdmin(employeeId));
  }

  @Get('/evaluation-batches')
  async evaluationBatchList(@Query('eventId') eventId?: string, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.listPersistent(this.requireAdmin(employeeId), eventId);
  }

  @Get('/evaluation-batches/:batchId')
  async evaluationBatch(@Param('batchId') batchId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.getPersistent(batchId, this.requireAdmin(employeeId));
  }

  /** Lease complete same-challenge batches for a Code Agent worker. */
  @Post('/evaluation-batches:lease')
  @HttpCode(200)
  async leaseEvaluationBatches(@Body() body: { workerId?: string; limit?: number; executorIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const batches = await this.evaluationBatches.leasePersistent(String(body.workerId ?? '').trim(), Number(body.limit ?? 1), Array.isArray(body.executorIds) ? body.executorIds : [], actorId);
    return { leasedAt: new Date().toISOString(), batches };
  }

  @Post('/evaluation-batches/:batchId/heartbeat')
  @HttpCode(200)
  async heartbeatEvaluationBatch(@Param('batchId') batchId: string, @Body() body: { leaseId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.heartbeatPersistent(batchId, String(body.leaseId ?? ''), this.requireAdmin(employeeId));
  }

  @Post('/evaluation-batches/:batchId/complete')
  @HttpCode(201)
  async completeEvaluationBatch(
    @Param('batchId') batchId: string,
    @Body() body: { leaseId?: string; results?: Array<{ runId: string; result: Record<string, unknown> }>; failures?: Array<{ runId: string; reason: string }> },
    @Headers('x-employee-id') employeeId?: string,
  ) {
    return this.evaluationBatches.completePersistent(batchId, String(body.leaseId ?? ''), body.results ?? [], body.failures ?? [], this.requireAdmin(employeeId));
  }

  @Post('/evaluation-batches/:batchId/fail')
  @HttpCode(200)
  async failEvaluationBatch(@Param('batchId') batchId: string, @Body() body: { leaseId?: string; reason?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.failPersistent(batchId, String(body.leaseId ?? ''), String(body.reason ?? ''), this.requireAdmin(employeeId));
  }

  /** Engine package bytes, so a worker can materialise the engine locally. */
  @Get('/evaluation-engines/:packageHash/package')
  async downloadEnginePackage(@Param('packageHash') packageHash: string, @Headers('x-employee-id') employeeId?: string, @Res({ passthrough: true }) response?: any) {
    this.requireAdmin(employeeId);
    const content = await this.enginePackages.readPackageBytes(packageHash);
    response?.header('content-type', 'application/zip');
    response?.header('content-length', String(content.length));
    response?.header('content-disposition', `attachment; filename="${packageHash.slice(0, 16)}.zip"`);
    return content;
  }

  @Get('/admin/overview')
  async adminOverview(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    return this.domainUnitOfWork.read((store) => store.adminOverview(actorId));
  }

  @Get('/admin/grading-queue')
  async gradingQueue(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (process.env.EMBEDDED_EVALUATION_WORKER === 'true') return this.autoQueue.getStats();
    const batches = await this.evaluationBatches.listPersistent(actorId);
    return {
      queued: batches.filter((batch) => batch.status === 'QUEUED').length,
      running: batches.filter((batch) => batch.status === 'RUNNING').length,
      maxConcurrency: Number(process.env.EVALUATION_BATCH_LEASE_MAX ?? 5),
      scheduled: batches.filter((batch) => ['QUEUED', 'RUNNING'].includes(batch.status)).length,
      embedded: process.env.EMBEDDED_EVALUATION_WORKER === 'true',
    };
  }

  @Get('/admin/code-agent-runtime')
  async codeAgentRuntime(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireGlobalAdmin(employeeId);
    return this.domainUnitOfWork.read((store) => store.getCodeAgentRuntimeConfig(actorId));
  }

  @Get('/admin/code-agent-runtime/diagnostics')
  async codeAgentRuntimeDiagnostics(@Headers('x-employee-id') employeeId?: string): Promise<CodeAgentRuntimeDiagnostics> {
    const actorId = this.requireGlobalAdmin(employeeId);
    return this.domainUnitOfWork.read((store) => store.getCodeAgentRuntimeDiagnostics(actorId));
  }

  @Put('/admin/code-agent-runtime')
  async updateCodeAgentRuntime(@Body() body: CodeAgentRuntimeInput, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireGlobalAdmin(employeeId);
    return this.domainUnitOfWork.run((store) => store.updateCodeAgentRuntimeConfig(body, actorId));
  }

  @Post('/admin/code-agent-runtime/test')
  @HttpCode(200)
  async testCodeAgentRuntime(@Body() body: CodeAgentRuntimeTestInput = {}, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireGlobalAdmin(employeeId);
    const current = await this.domainUnitOfWork.read((store) => store.getCodeAgentRuntimeConfig(actorId));
    return this.codeAgentRuntimeTest.run(body ?? {}, current);
  }

  @Get('/admin/capabilities')
  async adminCapabilities(@Query('orgPath') orgPath?: string, @Query('subjectIds') subjectIds?: string, @Query('eventId') eventId?: string, @Query('includeProfiles') includeProfiles?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('historyPage') historyPage?: string, @Query('historyPageSize') historyPageSize?: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const selectedSubjectIds = subjectIds
      ? subjectIds.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
    const profilePage = page === undefined ? 1 : queryInteger(page, 'page', 1);
    const profilePageSize = pageSize === undefined ? 20 : queryInteger(pageSize, 'pageSize', 20, 100);
    const historyPageValue = historyPage === undefined ? 1 : queryInteger(historyPage, 'historyPage', 1);
    const historyPageSizeValue = historyPageSize === undefined ? 20 : queryInteger(historyPageSize, 'historyPageSize', 20, 100);
    return this.domainUnitOfWork.read((store) => store.adminCapabilities(actorId, { orgPath, subjectIds: selectedSubjectIds, eventId, includeProfiles: includeProfiles !== 'false', page: profilePage, pageSize: profilePageSize, historyPage: historyPageValue, historyPageSize: historyPageSizeValue }));
  }

  @Get('/org-units')
  orgUnits(@Query('parentId') parentId?: string, @Headers('x-employee-id') employeeId?: string) {
    return this.userDirectory.listOrgUnits(parentId?.trim() || undefined, this.actor(employeeId));
  }

  @Post('/org-units')
  createOrgUnit(@Body() body: { id: string; parentId?: string; label?: string; name: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...input } = body;
    return this.userDirectory.createOrgUnit(input, actorId);
  }

  @Patch('/org-units/:orgUnitId')
  updateOrgUnit(@Param('orgUnitId') orgUnitId: string, @Body() body: { label?: string; name?: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.userDirectory.updateOrgUnit(orgUnitId, patch, actorId);
  }

  @Delete('/org-units/:orgUnitId')
  @HttpCode(204)
  async deleteOrgUnit(@Param('orgUnitId') orgUnitId: string, @Headers('x-employee-id') employeeId?: string): Promise<void> {
    await this.userDirectory.deleteOrgUnit(orgUnitId, this.requireAdmin(employeeId));
  }

  @Get('/org-units/:orgUnitId')
  orgUnit(@Param('orgUnitId') orgUnitId: string) {
    return this.userDirectory.getOrgUnit(orgUnitId);
  }

  @Get('/users')
  async users(@Query() query: UserListRequestQuery, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    return this.userDirectory.list(parseUserListQuery(query), actorId);
  }

  @Get('/users/:userId')
  async user(@Param('userId') userId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.userDirectory.get(userId, this.actor(employeeId));
  }

  @Patch('/users/batch-department')
  async updateUsersDepartment(@Body() body: { userIds?: unknown; orgUnitId?: unknown; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, userIds, orgUnitId } = body ?? {};
    if (!Array.isArray(userIds) || userIds.some((id) => typeof id !== 'string')) throw new BadRequestException('员工列表格式不正确');
    if (typeof orgUnitId !== 'string') throw new BadRequestException('请选择目标部门');
    return this.userDirectory.updateDepartmentBatch(userIds, orgUnitId, actorId);
  }

  @Patch('/users/:userId')
  async updateUser(@Param('userId') userId: string, @Body() body: { orgUnitId?: string; roles?: string[]; roleBindings?: Array<{ role: string; scopeOrgPath: string }>; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.userDirectory.update(userId, patch, actorId);
  }

  @Get('/challenges')
  async challenges(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => store.listChallenges(actorId).map((challenge) => this.withResolvedSubmissionContracts(challenge)));
  }

  @Get('/challenges/:challengeId')
  async challenge(@Param('challengeId') challengeId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => this.withResolvedSubmissionContracts(store.getChallenge(challengeId, actorId)));
  }

  @Post('/challenges')
  async createChallenge(@Body() body: Challenge & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...challenge } = body;
    for (const version of challenge.versions ?? []) {
      this.assertExecutorSelection(version);
      this.assertSubmissionContract(version);
      this.contractCatalog.assertSelection(version.evaluationEngine);
    }
    return this.domainUnitOfWork.run((store) => store.createChallenge(challenge, actorId));
  }

  @Post('/challenges/:challengeId/publish')
  async publishChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.publishChallenge(challengeId, this.requireAdmin(employeeId)));
  }

  @Patch('/challenges/:challengeId')
  async updateChallenge(@Param('challengeId') challengeId: string, @Body() body: { category?: ChallengeCategory; solutionVisibility?: HardProblemSolutionVisibility; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.domainUnitOfWork.run((store) => store.updateChallenge(challengeId, patch, actorId));
  }

  @Delete('/challenges/:challengeId')
  async deleteChallenge(@Param('challengeId') challengeId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.deleteChallenge(challengeId, this.requireAdmin(employeeId)));
  }

  @Delete('/challenges/:challengeId/permanent')
  async permanentlyDeleteChallenge(@Param('challengeId') challengeId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.permanentlyDeleteChallenge(challengeId, this.requireAdmin(employeeId)));
  }

  @Post('/challenges/:challengeId/archive')
  async archiveChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.archiveChallenge(challengeId, this.requireAdmin(employeeId)));
  }

  @Post('/challenges/:challengeId/trash')
  async trashChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.archiveChallenge(challengeId, this.requireAdmin(employeeId)));
  }

  @Post('/challenges/:challengeId/restore')
  async restoreChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.restoreChallenge(challengeId, this.requireAdmin(employeeId)));
  }

  @Post('/challenges/:challengeId/versions')
  async createChallengeVersion(@Param('challengeId') challengeId: string, @Body() body: ChallengeVersion & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...version } = body;
    this.assertExecutorSelection(version);
    this.assertSubmissionContract(version);
    this.contractCatalog.assertSelection(version.evaluationEngine);
    return this.domainUnitOfWork.run((store) => store.addChallengeVersion(challengeId, version, actorId));
  }

  @Patch('/challenges/:challengeId/versions/:versionId')
  async updateChallengeVersion(@Param('challengeId') challengeId: string, @Param('versionId') versionId: string, @Body() body: Partial<ChallengeVersion> & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    if (patch.evaluationEngine) this.assertExecutorSelection(patch as { evaluationEngine?: EvaluationEngineConfig });
    this.assertSubmissionContract(patch);
    if (patch.evaluationEngine) this.contractCatalog.assertSelection(patch.evaluationEngine);
    return this.domainUnitOfWork.run((store) => store.updateChallengeVersion(challengeId, versionId, patch, actorId));
  }

  @Post('/challenges/:challengeId/versions/:versionId/publish')
  async publishChallengeVersion(@Param('challengeId') challengeId: string, @Param('versionId') versionId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.domainUnitOfWork.run((store) => store.publishChallengeVersion(challengeId, versionId, this.requireAdmin(employeeId)));
  }

  @Get('/seasons')
  async seasons() {
    return this.domainUnitOfWork.read((store) => store.listSeasons());
  }

  @Post('/seasons')
  async createSeason(@Body() body: Season & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...season } = body;
    return this.domainUnitOfWork.run((store) => {
      store.assertGlobalAdmin(actorId);
      return store.createSeason(season, actorId);
    });
  }

  @Get('/seasons/:seasonId/leaderboard')
  async leaderboard(@Param('seasonId') seasonId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => store.leaderboard(seasonId, actorId));
  }

  @Get('/seasons/:seasonId')
  async season(@Param('seasonId') seasonId: string) {
    return this.domainUnitOfWork.read((store) => store.getSeason(seasonId));
  }

  @Get('/profiles/:subjectId')
  async profile(@Param('subjectId') subjectId: string, @Query('includeHistory') includeHistory?: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => {
      store.assertSelfOrAdmin(actorId, subjectId);
      return store.profile(subjectId, { includeHistory: includeHistory !== 'false' });
    });
  }

  @Get('/profiles/:subjectId/history')
  async profileHistory(@Param('subjectId') subjectId: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const historyPage = page === undefined ? 1 : queryInteger(page, 'page', 1);
    const historyPageSize = pageSize === undefined ? 20 : queryInteger(pageSize, 'pageSize', 20, 100);
    return this.domainUnitOfWork.read((store) => {
      store.assertSelfOrAdmin(actorId, subjectId);
      return store.profileHistory(subjectId, { page: historyPage, pageSize: historyPageSize });
    });
  }

  @Get('/profiles/:subjectId/capabilities')
  async capabilities(@Param('subjectId') subjectId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => {
      store.assertSelfOrAdmin(actorId, subjectId);
      return store.capabilities(subjectId, { includeDepartmentStats: store.canViewDepartmentStats(actorId, subjectId) });
    });
  }

  @Get('/events')
  async events(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => store.listEvents(actorId));
  }

  @Get('/events/:eventId')
  async event(@Param('eventId') eventId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => store.getEvent(eventId, actorId));
  }

  @Post('/events')
  async createEvent(@Body() body: (Omit<EventConfig, 'status'> & { status?: EventConfig['status'] }) & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...event } = body;
    return this.domainUnitOfWork.run((store) => store.createEvent(event, actorId));
  }

  @Patch('/events/:eventId')
  async updateEvent(@Param('eventId') eventId: string, @Body() body: Partial<Omit<EventConfig, 'id' | 'status'>> & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.domainUnitOfWork.run((store) => store.updateEvent(eventId, patch, actorId));
  }

  @Delete('/events/:eventId')
  @HttpCode(204)
  async deleteEvent(@Param('eventId') eventId: string, @Headers('x-employee-id') employeeId?: string): Promise<void> {
    await this.domainUnitOfWork.run((store) => store.deleteEvent(eventId, this.requireAdmin(employeeId)));
  }

  @Get('/events/:eventId/participants')
  async participants(@Param('eventId') eventId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    return this.domainUnitOfWork.read((store) => store.listParticipants(eventId, actorId));
  }

  @Put('/events/:eventId/participants')
  async replaceParticipants(@Param('eventId') eventId: string, @Body() body: { subjectIds: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!Array.isArray(body.subjectIds) || body.subjectIds.length > 10000) throw new BadRequestException('subjectIds must be an array with at most 10000 items');
    return this.domainUnitOfWork.run((store) => store.replaceParticipants(eventId, body.subjectIds, actorId));
  }

  @Post('/events/:eventId/participants:import')
  async importParticipants(@Param('eventId') eventId: string, @Body() body: { participants: Array<{ subjectId: string }> }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!Array.isArray(body.participants) || body.participants.length > 10000) throw new BadRequestException('participants must be an array with at most 10000 items');
    return this.domainUnitOfWork.run((store) => store.importParticipants(eventId, body.participants, actorId));
  }

  @Get('/submissions')
  submissions(@Query() query: Record<string, string | string[] | undefined>, @Headers('x-employee-id') employeeId?: string) {
    const eventId = queryString(query.eventId, 'eventId');
    const subjectId = queryString(query.subjectId, 'subjectId');
    const state = queryString(query.state, 'state') as SubmissionListQuery['state'] | undefined;
    if (state && !['RECEIVED', 'QUEUED', 'WAITING_TRIGGER', 'WAITING_IMPORT', 'IMPORT_VALIDATING', 'FAILED', 'GRADED', 'SEALED', 'REVEALED'].includes(state)) throw invalidUserQuery('state is not supported');
    return this.platformRead.listSubmissions({ page: queryInteger(query.page, 'page', 1), pageSize: queryInteger(query.pageSize, 'pageSize', 20, 100), ...(eventId ? { eventId } : {}), ...(subjectId ? { subjectId } : {}), ...(state ? { state } : {}) }, this.actor(employeeId));
  }

  @Post('/submissions')
  async createSubmission(@Body() body: { eventId: string; subjectId: string; snapshot: SubmissionSnapshot }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const context = await this.domainUnitOfWork.read((store) => {
      store.assertSelfOrAdmin(actorId, body.subjectId);
      const event = store.getEvent(body.eventId, actorId);
      assertEventSubmissionWindow(event);
      if (body.snapshot.artifactUri) this.assertRegisteredArtifactInStore(store, body.eventId, body.subjectId, body.snapshot.artifactUri);
      return { event, version: store.challengeVersionForEvent(body.eventId) };
    });
    const snapshot = this.normalizeSnapshot(body.snapshot);
    const version = context.version;
    if (snapshot.artifactUri) {
      await this.submissionContracts.validateArtifact(version, snapshot.artifactUri);
    }
    else if (snapshot.workspacePath) this.submissionContracts.validateWorkspace(version, snapshot.workspacePath);
    const submission = await this.domainUnitOfWork.run((store) => {
      store.assertSelfOrAdmin(actorId, body.subjectId);
      if (snapshot.artifactUri) this.assertRegisteredArtifactInStore(store, body.eventId, body.subjectId, snapshot.artifactUri);
      const created = store.createSubmission(body.eventId, body.subjectId, snapshot);
      if (created.gradingRunId && store.getEvent(body.eventId).trigger === 'AUTO' && process.env.EMBEDDED_EVALUATION_WORKER !== 'true') {
        store.createEvaluationBatch([created.gradingRunId], 'system');
      }
      return created;
    });
    await this.scheduleIfAutomatic(body.eventId, submission.id);
    return submission;
  }

  @Post('/events/:eventId/submissions:upload')
  async upload(@Param('eventId') eventId: string, @Body() body: { subjectId: string; snapshot: SubmissionSnapshot; artifactBase64?: string; fileName?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const context = await this.domainUnitOfWork.read((store) => {
      store.assertSelfOrAdmin(actorId, body.subjectId);
      store.assertSubmissionSubject(eventId, body.subjectId);
      const event = store.getEvent(eventId, actorId);
      assertEventSubmissionWindow(event);
      return { event, version: store.challengeVersionForEvent(eventId) };
    });
    const event = context.event;
    if (body.artifactBase64 && body.snapshot.workspacePath) throw new BadRequestException('provide either artifactBase64 or workspacePath, not both');
    const fileName = body.fileName ?? 'submission.bin';
    const allowedFormats = event.deliveryConfig?.allowedFormats;
    if (allowedFormats?.length && body.artifactBase64) {
      const normalized = fileName.toLowerCase();
      if (!allowedFormats.some((format) => normalized.endsWith(format.startsWith('.') ? format.toLowerCase() : `.${format.toLowerCase()}`))) {
        throw new BadRequestException(`file format is not allowed for event ${eventId}`);
      }
    }
    let snapshot = { ...body.snapshot, sourceType: 'UPLOAD' as const };
    if (body.artifactBase64) {
      const normalizedEncoded = body.artifactBase64.replace(/\s+/g, '');
      if (!normalizedEncoded || normalizedEncoded.length % 4 === 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalizedEncoded)) {
        throw new BadRequestException('artifactBase64 is not valid base64');
      }
      const uploadedBytes = Buffer.from(normalizedEncoded, 'base64');
      if (!uploadedBytes.length) throw new BadRequestException('artifact is empty');
      const estimatedBytes = Math.floor(normalizedEncoded.length * 3 / 4);
      if (event.deliveryConfig?.maxBytes && estimatedBytes > event.deliveryConfig.maxBytes) {
        throw new BadRequestException(`artifact exceeds event maxBytes ${event.deliveryConfig.maxBytes}`);
      }
      const maxBytes = Number(event.deliveryConfig?.maxBytes ?? process.env.ARTIFACT_MAX_BYTES ?? 50 * 1024 * 1024);
      const uploadSession = await this.objectStorage.createUpload({ actorId, eventId, fileName, declaredSize: uploadedBytes.length, maxBytes });
      await this.objectStorage.put(uploadSession.uploadId, uploadSession.uploadToken, uploadedBytes, actorId);
      const stored = await this.objectStorage.confirm(uploadSession.uploadId, uploadSession.uploadToken, actorId);
      if (event.deliveryConfig?.maxBytes && stored.size > event.deliveryConfig.maxBytes) {
        throw new BadRequestException(`artifact exceeds event maxBytes ${event.deliveryConfig.maxBytes}`);
      }
      if (snapshot.artifactHash && snapshot.artifactHash !== stored.sha256) {
        throw new BadRequestException('artifactHash does not match uploaded bytes');
      }
      await this.objectStorage.validateArchive(stored.uri, event.deliveryConfig?.maxFiles ?? 2000);
      await this.submissionContracts.validateArtifact(context.version, stored.uri);
      const computedSnapshotHash = await this.objectStorage.snapshotHash(stored.uri);
      if (snapshot.snapshotHash && snapshot.snapshotHash !== computedSnapshotHash) {
        throw new BadRequestException('snapshotHash does not match uploaded workspace contents');
      }
      snapshot = {
        ...snapshot,
        artifactHash: stored.sha256,
        artifactUri: stored.uri,
        artifactName: fileName,
        snapshotHash: computedSnapshotHash,
      };
    } else if (snapshot.artifactUri) {
      // A client may retry a previously stored artifact, but it may not invent
      // an artifact URI or hash. Re-read both hashes from the immutable store.
      await this.domainUnitOfWork.read((store) => this.assertRegisteredArtifactInStore(store, eventId, body.subjectId, snapshot.artifactUri!, true));
      const actualArtifactHash = await this.objectStorage.contentHash(snapshot.artifactUri);
      if (snapshot.artifactHash && snapshot.artifactHash !== actualArtifactHash) {
        throw new BadRequestException('artifactHash does not match stored artifact bytes');
      }
      await this.objectStorage.validateArchive(snapshot.artifactUri, event.deliveryConfig?.maxFiles ?? 2000);
      await this.submissionContracts.validateArtifact(context.version, snapshot.artifactUri);
      const computedSnapshotHash = await this.objectStorage.snapshotHash(snapshot.artifactUri);
      if (snapshot.snapshotHash && snapshot.snapshotHash !== computedSnapshotHash) {
        throw new BadRequestException('snapshotHash does not match stored artifact contents');
      }
      snapshot = { ...snapshot, artifactHash: actualArtifactHash, snapshotHash: computedSnapshotHash };
    } else if (!snapshot.workspacePath) {
      throw new BadRequestException('upload requires artifactBase64, artifactUri or a local workspacePath');
    } else {
      this.submissionContracts.validateWorkspace(context.version, snapshot.workspacePath);
    }
    const submission = await this.domainUnitOfWork.run((store) => {
      store.assertSelfOrAdmin(actorId, body.subjectId);
      store.assertSubmissionSubject(eventId, body.subjectId);
      if (snapshot.artifactUri && !body.artifactBase64) this.assertRegisteredArtifactInStore(store, eventId, body.subjectId, snapshot.artifactUri, true);
      const created = store.createSubmission(eventId, body.subjectId, this.normalizeSnapshot(snapshot));
      if (created.gradingRunId && store.getEvent(eventId).trigger === 'AUTO' && process.env.EMBEDDED_EVALUATION_WORKER !== 'true') {
        store.createEvaluationBatch([created.gradingRunId], 'system');
      }
      return created;
    });
    await this.scheduleIfAutomatic(eventId, submission.id);
    return submission;
  }

  @Post('/events/:eventId/submissions:register-git')
  async registerGit(@Param('eventId') eventId: string, @Body() body: { subjectId: string; snapshot: SubmissionSnapshot }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const context = await this.domainUnitOfWork.read((store) => {
      store.assertSelfOrAdmin(actorId, body.subjectId);
      store.assertSubmissionSubject(eventId, body.subjectId);
      const event = store.getEvent(eventId, actorId);
      assertEventSubmissionWindow(event);
      return { event, version: store.challengeVersionForEvent(eventId) };
    });
    const event = context.event;
    let snapshot = this.normalizeSnapshot({ ...body.snapshot, ...(this.localGit.enabled ? { workspacePath: undefined } : {}), sourceType: 'GIT_REF' });
    if (this.localGit.enabled && event.deliveryConfig?.pinAt !== 'DEADLINE' && snapshot.repository && snapshot.branch && snapshot.commitSha) {
      const local = await this.localGit.snapshot({ repository: snapshot.repository, branch: snapshot.branch, commitSha: snapshot.commitSha });
      await this.submissionContracts.validateArtifact(context.version, local.artifact.uri);
      snapshot = { ...snapshot, commitSha: local.commitSha, artifactUri: local.artifact.uri, artifactHash: local.artifact.sha256, snapshotHash: local.snapshotHash };
    }
    const submission = await this.domainUnitOfWork.run((store) => {
      store.assertSelfOrAdmin(actorId, body.subjectId);
      store.assertSubmissionSubject(eventId, body.subjectId);
      const created = store.createSubmission(eventId, body.subjectId, snapshot);
      if (created.gradingRunId && store.getEvent(eventId).trigger === 'AUTO' && process.env.EMBEDDED_EVALUATION_WORKER !== 'true') {
        store.createEvaluationBatch([created.gradingRunId], 'system');
      }
      return created;
    });
    await this.scheduleIfAutomatic(eventId, submission.id);
    return submission;
  }

  @Post('/submissions/:submissionId/start-grading')
  async startSubmission(@Param('submissionId') submissionId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const result = await this.domainUnitOfWork.run((store) => {
      const run = store.startGrading(submissionId, actorId);
      const batch = store.createEvaluationBatch([run.id], actorId);
      return { run, batch };
    });
    return result.run;
  }

  @Post('/submissions/:submissionId/regrade')
  async regradeSubmission(@Param('submissionId') submissionId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const result = await this.domainUnitOfWork.run((store) => {
      const regraded = store.regradeSubmission(submissionId, actorId);
      if (regraded.run?.triggerType === 'AUTO' && process.env.EMBEDDED_EVALUATION_WORKER !== 'true') {
        store.createEvaluationBatch([regraded.run.id], actorId);
      }
      return regraded;
    });
    if (result.run?.triggerType === 'AUTO') await this.scheduleIfAutomatic(result.submission.eventId, submissionId);
    return result;
  }

  @Post('/events/:eventId/start-grading')
  async startEvent(@Param('eventId') eventId: string, @Body() body: { actorId?: string; submissionIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    return this.domainUnitOfWork.run((store) => {
      const runs = store.startEventGrading(eventId, actorId, body.submissionIds);
      return { runs, ...(runs.length ? { batch: store.createEvaluationBatch(runs.map((run) => run.id), actorId) } : {}) };
    });
  }

  @Post('/events/:eventId/regrade')
  async regradeEvent(@Param('eventId') eventId: string, @Body() body: { actorId?: string; submissionIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const result = await this.domainUnitOfWork.run((store) => {
      const regraded = store.regradeEvent(eventId, actorId, body.submissionIds);
      if (process.env.EMBEDDED_EVALUATION_WORKER !== 'true') {
        for (const run of regraded.runs) if (run.triggerType === 'AUTO') store.createEvaluationBatch([run.id], actorId);
      }
      return regraded;
    });
    for (const run of result.runs) if (run.triggerType === 'AUTO') await this.scheduleIfAutomatic(eventId, run.submissionId);
    return result;
  }

  @Post('/events/:eventId/grading-input')
  async gradingInput(@Param('eventId') eventId: string, @Body() body: { submissionIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const batch = await this.domainUnitOfWork.run((store) => store.prepareEvaluationInput(eventId, body.submissionIds ?? [], actorId));
    // The local administrator/CodeAgent workflow needs the real file path for
    // locally stored uploads. This field is only returned from the admin
    // endpoint; employees never receive it.
    return {
      ...batch,
      submissions: batch.submissions.map((item) => {
        if (!item.snapshot.artifactUri) return item;
        try {
          return { ...item, snapshot: { ...item.snapshot, artifactPath: this.artifacts.localPath(item.snapshot.artifactUri) } };
        } catch {
          return item;
        }
      }),
    };
  }

  @Post('/events/:eventId/execute-local')
  async executeEventLocally(@Param('eventId') eventId: string, @Body() body: { submissionIds?: string[] } = {}, @Headers('x-employee-id') employeeId?: string) {
    if (process.env.EMBEDDED_EVALUATION_WORKER !== 'true') {
      throw new BadRequestException({ code: 'CODE_AGENT_WORKER_REQUIRED', message: '请由评测 Worker 领取批次并调用 Code Agent' });
    }
    const actorId = this.requireAdmin(employeeId);
    const executions: Array<Record<string, unknown>> = [];
    const selectedIds = body.submissionIds === undefined ? undefined : [...new Set(body.submissionIds.map((id) => String(id).trim()).filter(Boolean))];
    if (selectedIds && !selectedIds.length) throw new BadRequestException('at least one submission must be selected');
    // Reserve the exact immutable submissions and mark their runs in the
    // canonical transaction before invoking the local compatibility worker.
    // The worker itself remains outside the transaction so a long-running
    // grader never holds PostgreSQL locks.
    const jobs = await this.domainUnitOfWork.run((store) => {
      const available = store.listSubmissions(eventId, actorId);
      if (selectedIds && selectedIds.some((id) => !available.some((submission) => submission.id === id))) {
        throw new BadRequestException('selected submissions are outside this event or administrator scope');
      }
      const event = store.getEvent(eventId, actorId);
      return available
        .filter((item) => !selectedIds || selectedIds.includes(item.id))
        .flatMap((submission) => {
          if (!submission.gradingRunId || submission.resultId) return [];
          const currentRun = store.getRun(submission.gradingRunId);
          if (currentRun.status === 'RUNNING') return [];
          const run = store.markRunRunning(submission.gradingRunId);
          return [{ event, submission, run, context: store.gradingContextForSubmission(submission) }];
        });
    });
    for (const job of jobs) {
      try {
        const result = await this.localGrader.execute({ event: job.event, submission: job.submission, run: job.run, ...job.context });
        const stored = await this.domainUnitOfWork.run((store) => store.completeRun(job.run.id, result));
        executions.push({ run: stored.gradingRunId ? await this.domainUnitOfWork.run((store) => store.getRun(stored.gradingRunId)) : job.run, stored });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failed = await this.domainUnitOfWork.run((store) => store.failRun(job.run.id, reason));
        executions.push({ run: failed, error: reason });
      }
    }
    return executions;
  }

  @Post('/events/:eventId/reveal')
  async reveal(@Param('eventId') eventId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    return { eventId, revealed: await this.domainUnitOfWork.run((store) => store.reveal(eventId, actorId)) };
  }

  @Post('/events/:eventId/close')
  async close(@Param('eventId') eventId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const deadline = await this.domainUnitOfWork.run((store) => {
      const event = store.getEvent(eventId, actorId);
      if (event.submissionSource !== 'GIT_REF' || event.deliveryConfig?.pinAt !== 'DEADLINE') return undefined;
      // Deadline pinning must cover every delivery in the event, not just the
      // ones inside the closing administrator's subject scope.  The final
      // close transaction rechecks the complete event again, so a concurrent
      // submission cannot bypass the pin requirement.
      return {
        challengeVersion: store.challengeVersionForEvent(eventId),
        pending: store.systemSubmissions(eventId)
          .filter((submission) => !submission.resultId && !submission.gradingRunId)
          .map((submission) => ({ id: submission.id, snapshotHash: submission.snapshot.snapshotHash, repository: submission.snapshot.repository, branch: submission.snapshot.branch })),
      };
    });
    const pins = new Map<string, { originalHash: string; commitSha: string; artifactUri: string; artifactHash: string; snapshotHash: string }>();
    if (deadline?.pending.length) {
      if (!this.localGit.enabled) throw new BadRequestException('DEADLINE Git pinning requires LOCAL_GIT_ROOT in local mode');
      for (const submission of deadline.pending) {
        if (!submission.repository || !submission.branch) throw new BadRequestException(`submission ${submission.id} has no Git repository or branch`);
        const local = await this.localGit.snapshot({ repository: submission.repository, branch: submission.branch });
        await this.submissionContracts.validateArtifact(deadline.challengeVersion, local.artifact.uri);
        pins.set(submission.id, { originalHash: submission.snapshotHash, commitSha: local.commitSha, artifactUri: local.artifact.uri, artifactHash: local.artifact.sha256, snapshotHash: local.snapshotHash });
      }
    }
    return this.domainUnitOfWork.run((store) => {
      const currentEvent = store.getEvent(eventId, actorId);
      if (currentEvent.submissionSource === 'GIT_REF' && currentEvent.deliveryConfig?.pinAt === 'DEADLINE') {
        for (const [submissionId, pin] of pins) {
          const current = store.getSubmission(submissionId);
          if (current.resultId || current.gradingRunId) continue;
          if (current.snapshot.snapshotHash !== pin.originalHash) {
            // Another administrator may have completed the pin while the
            // external Git snapshot was being materialised.  Preserve that
            // newer immutable snapshot; reject only an incomplete mutation.
            if (!current.snapshot.commitSha || !current.snapshot.artifactUri || !current.snapshot.artifactHash) {
              throw new BadRequestException(`submission ${submissionId} changed while its Git snapshot was being pinned`);
            }
            continue;
          }
          store.pinGitSnapshot(submissionId, pin, actorId);
        }
      }
      return store.closeEvent(eventId, actorId);
    });
  }

  @Get('/audits')
  audits(@Query() query: Record<string, string | string[] | undefined>, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const target = queryString(query.target, 'target');
    return this.platformRead.listAudits({ page: queryInteger(query.page, 'page', 1), pageSize: queryInteger(query.pageSize, 'pageSize', 20, 100), ...(target ? { target } : {}) }, actorId);
  }

  /** Create a short-lived upload handle bound to the authenticated actor and event. */
  @Post('/uploads')
  @HttpCode(201)
  async createUpload(@Body() body: { eventId?: string; subjectId?: string; fileName?: string; declaredSize?: number }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const eventId = String(body.eventId ?? '').trim();
    const subjectId = String(body.subjectId ?? actorId).trim();
    if (!eventId || !body.fileName || !Number.isSafeInteger(Number(body.declaredSize))) throw new BadRequestException({ code: 'UPLOAD_REQUEST_INVALID', message: 'eventId、fileName 和 declaredSize 必须有效' });
    const event = await this.domainUnitOfWork.read((store) => {
      store.assertSelfOrAdmin(actorId, subjectId);
      store.assertSubmissionSubject(eventId, subjectId);
      const event = store.getEvent(eventId, actorId);
      assertEventSubmissionWindow(event);
      return event;
    });
    if (event.submissionSource !== 'UPLOAD') throw new BadRequestException({ code: 'UPLOAD_SOURCE_NOT_ALLOWED', message: '该训战不接受文件上传' });
    const fileName = String(body.fileName).trim();
    const allowedFormats = event.deliveryConfig?.allowedFormats;
    if (allowedFormats?.length && !allowedFormats.some((format) => fileName.toLowerCase().endsWith(format.startsWith('.') ? format.toLowerCase() : `.${format.toLowerCase()}`))) {
      throw new BadRequestException({ code: 'UPLOAD_FORMAT_NOT_ALLOWED', message: `文件格式不符合训战要求: ${eventId}` });
    }
    const configuredLimit = Number(event.deliveryConfig?.maxBytes ?? process.env.ARTIFACT_MAX_BYTES ?? 50 * 1024 * 1024);
    const session = await this.objectStorage.createUpload({ actorId, eventId, fileName, declaredSize: Number(body.declaredSize), maxBytes: configuredLimit });
    return { ...session, subjectId };
  }

  /** Upload bytes to a previously issued handle. JSON base64 is retained for local clients; S3 uses the same server-side checks. */
  @Put('/uploads/:uploadId')
  async putUpload(@Param('uploadId') uploadId: string, @Body() body: unknown, @Headers('x-upload-token') uploadToken: string | undefined, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const token = uploadToken?.trim();
    if (!token) throw new UnauthorizedException('x-upload-token is required');
    const encoded = Buffer.isBuffer(body) ? body.toString('base64') : (body as { bytesBase64?: string } | undefined)?.bytesBase64;
    if (typeof encoded !== 'string' || !encoded) throw new BadRequestException({ code: 'UPLOAD_BYTES_REQUIRED', message: 'bytesBase64 is required' });
    const normalized = encoded.replace(/\s+/g, '');
    // Buffer.from(..., 'base64') is intentionally forgiving and silently
    // drops invalid characters. Reject malformed input before decoding so the
    // declared checksum/size cannot be bypassed with a different byte stream.
    if (!normalized || normalized.length % 4 === 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
      throw new BadRequestException({ code: 'UPLOAD_BYTES_INVALID', message: '上传内容不是合法 base64' });
    }
    const bytes = Buffer.from(normalized, 'base64');
    return this.objectStorage.put(uploadId, token, bytes, actorId);
  }

  @Post('/uploads/:uploadId/confirm')
  @HttpCode(201)
  async confirmUpload(@Param('uploadId') uploadId: string, @Body() body: { size?: number; sha256?: string }, @Headers('x-upload-token') uploadToken: string | undefined, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const token = uploadToken?.trim();
    if (!token) throw new UnauthorizedException('x-upload-token is required');
    const expected = body?.size === undefined && body?.sha256 === undefined ? undefined : { size: Number(body.size), sha256: String(body.sha256 ?? '') };
    if (expected && (!Number.isSafeInteger(expected.size) || expected.size <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256))) throw new BadRequestException({ code: 'UPLOAD_METADATA_INVALID', message: '上传对象元数据无效' });
    return this.objectStorage.confirm(uploadId, token, actorId, expected);
  }

  @Get('/submissions/:submissionId')
  async submission(@Param('submissionId') submissionId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => {
      store.assertCanViewSubmission(actorId, submissionId);
      return store.getSubmission(submissionId);
    });
  }

  @Get('/submissions/:submissionId/artifact')
  async downloadSubmissionArtifact(@Param('submissionId') submissionId: string, @Headers('x-employee-id') employeeId?: string, @Res({ passthrough: true }) response?: any) {
    const actorId = this.requireAdmin(employeeId);
    const submission = await this.domainUnitOfWork.read((store) => {
      store.assertCanViewSubmission(actorId, submissionId);
      return store.getSubmission(submissionId);
    });
    const artifactUri = submission.snapshot.artifactUri;
    if (!artifactUri) throw new NotFoundException('该提交没有可下载的交付件');
    let content: Buffer;
    try {
      // Submission artifacts may be local or S3-backed; the controller only
      // depends on the object-storage port and never resolves a filesystem
      // path itself.
      content = await this.objectStorage.read(artifactUri);
      if (submission.snapshot.artifactHash) {
        const actualHash = await this.objectStorage.contentHash(artifactUri);
        if (actualHash !== submission.snapshot.artifactHash) throw new Error('artifact hash mismatch');
      }
    } catch {
      throw new NotFoundException('交付件不存在');
    }
    const fileName = submission.snapshot.artifactName ?? `submission-${submission.id}.zip`;
    response?.header('content-type', 'application/octet-stream');
    response?.header('content-length', String(content.length));
    response?.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    return content;
  }

  @Post('/grading-results:import')
  @HttpCode(201)
  async importResult(@Body() body: { result: Record<string, unknown>; actorId?: string; eventId?: string; subjectId?: string }, @Headers('x-employee-id') employeeId?: string, @Headers('idempotency-key') requestIdempotencyKey?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (requestIdempotencyKey && body.result.idempotencyKey !== requestIdempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_MISMATCH', message: 'Idempotency-Key must match result.idempotencyKey' });
    const errors = validateEvaluationResult(body.result);
    if (errors.length) throw new BadRequestException({ code: 'RESULT_SCHEMA_INVALID', errors });
    return { accepted: true, stored: await this.domainUnitOfWork.run((store) => store.importResult(body.result as Record<string, any>, actorId, { eventId: body.eventId, subjectId: body.subjectId })) };
  }

  @Post('/grading-results:import-batch')
  @HttpCode(201)
  async importBatch(@Body() body: { results: Array<{ result: Record<string, unknown>; eventId?: string; subjectId?: string }> }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!Array.isArray(body.results) || body.results.length > 500) throw new BadRequestException('results must be an array with at most 500 items');
    const accepted: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];
    for (const [index, item] of body.results.entries()) {
      const errors = validateEvaluationResult(item.result);
      if (errors.length) {
        rejected.push({ index, ok: false, resultId: item.result?.resultId, code: 'RESULT_SCHEMA_INVALID', message: 'evaluation result schema is invalid', errors });
        continue;
      }
      try {
        const stored = await this.domainUnitOfWork.run((store) => store.importResult(item.result as Record<string, any>, actorId, { eventId: item.eventId, subjectId: item.subjectId }));
        accepted.push({ index, ok: true, resultId: stored.resultId, submissionId: stored.submissionId, code: 'RESULT_IMPORTED', message: 'evaluation result accepted' });
      } catch (error) {
        rejected.push({ index, ok: false, resultId: item.result?.resultId, code: 'RESULT_IMPORT_REJECTED', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { accepted, rejected, acceptedCount: accepted.length, rejectedCount: rejected.length };
  }

  @Get('/grading-runs/:runId')
  async gradingRun(@Param('runId') runId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => {
      store.assertCanViewRun(actorId, runId);
      return store.getRun(runId);
    });
  }

  @Post('/grading-runs/:runId/execute')
  async executeLocal(@Param('runId') runId: string, @Headers('x-employee-id') employeeId?: string) {
    if (process.env.EMBEDDED_EVALUATION_WORKER !== 'true') {
      throw new BadRequestException({ code: 'CODE_AGENT_WORKER_REQUIRED', message: '请由评测 Worker 领取批次并调用 Code Agent' });
    }
    const actorId = this.requireAdmin(employeeId);
    const job = await this.domainUnitOfWork.run((store) => {
      const storedRun = store.getRun(runId);
      const submission = store.getSubmission(storedRun.submissionId);
      const event = store.getEvent(submission.eventId, actorId);
      if (storedRun.status === 'GRADED' && submission.resultId) return { event, submission, run: storedRun, context: store.gradingContextForSubmission(submission), alreadyGraded: true };
      const run = store.markRunRunning(runId);
      return { event, submission, run, context: store.gradingContextForSubmission(submission), alreadyGraded: false };
    });
    if (job.alreadyGraded) return { run: job.run, stored: await this.domainUnitOfWork.run((store) => store.getReport(job.submission.id)) };
    try {
      const result = await this.localGrader.execute({ event: job.event, submission: job.submission, run: job.run, ...job.context });
      const stored = await this.domainUnitOfWork.run((store) => store.completeRun(runId, result));
      return { run: await this.domainUnitOfWork.run((store) => store.getRun(runId)), stored };
    } catch (error) {
      await this.domainUnitOfWork.run((store) => store.failRun(runId, error instanceof Error ? error.message : String(error)));
      throw error;
    }
  }

  @Get('/reports/:submissionId')
  async report(@Param('submissionId') submissionId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    return this.domainUnitOfWork.read((store) => {
      store.assertCanViewSubmission(actorId, submissionId);
      const submission = store.getSubmission(submissionId);
      return store.getReport(submissionId, { includeDepartmentStats: store.canViewDepartmentStats(actorId, submission.subjectId) });
    });
  }
}
