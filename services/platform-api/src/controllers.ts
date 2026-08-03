import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Res, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PlatformStore } from './store';
import { Announcement, Challenge, ChallengeCategory, ChallengeVersion, CodeAgentRuntimeInput, EvaluationEngineConfig, EventConfig, HardProblem, HardProblemReviewStatus, HardProblemSolutionVisibility, Season, SubmissionSnapshot, SsoIdentity } from './domain';
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

  private scheduleIfAutomatic(eventId: string, submissionId: string): void {
    if (this.store.getEvent(eventId).trigger !== 'AUTO') return;
    const submission = this.store.getSubmission(submissionId);
    if (!submission.gradingRunId) return;
    // The in-process executor remains an explicit single-host compatibility
    // switch. Normal deployments always create a pull-based Code Agent batch.
    if (process.env.EMBEDDED_EVALUATION_WORKER === 'true') this.autoQueue.enqueue(submissionId);
    else this.evaluationBatches.create([submission.gradingRunId], 'system');
  }

  @Get('/health')
  health() {
    return { status: 'ok', service: 'platform-api', time: new Date().toISOString() };
  }

  @Get('/me')
  me(@Headers('x-employee-id') employeeId?: string) {
    return this.store.getUser(this.actor(employeeId));
  }

  /**
   * Exchange the trusted internal SSO identity for a local platform account.
   * The gateway supplies only the claims below; the store provisions the
   * employee on first login and keeps later logins idempotent.
   */
  @Post('/auth/sso')
  ssoLogin(@Body() body: SsoIdentity) {
    return this.store.syncSsoIdentity(body);
  }

  @Get('/announcements')
  announcements(@Headers('x-employee-id') employeeId?: string) {
    return this.store.listAnnouncements(this.actor(employeeId));
  }

  @Post('/announcements')
  createAnnouncement(@Body() body: Omit<Announcement, 'id'> & { id?: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...announcement } = body;
    return this.store.createAnnouncement(announcement, actorId);
  }

  @Patch('/announcements/:announcementId')
  updateAnnouncement(@Param('announcementId') announcementId: string, @Body() body: Partial<Omit<Announcement, 'id'>> & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.store.updateAnnouncement(announcementId, patch, actorId);
  }

  @Delete('/announcements/:announcementId')
  @HttpCode(204)
  deleteAnnouncement(@Param('announcementId') announcementId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    this.store.deleteAnnouncement(announcementId, this.requireAdmin(employeeId));
  }

  @Get('/hard-problems')
  hardProblems(@Query('status') status?: string, @Query('reviewStatus') reviewStatus?: string, @Headers('x-employee-id') employeeId?: string) {
    if (status && status !== 'OPEN' && status !== 'RESOLVED') throw new BadRequestException('hard problem status must be OPEN or RESOLVED');
    if (reviewStatus && !['PENDING_REVIEW', 'APPROVED', 'REJECTED'].includes(reviewStatus)) throw new BadRequestException('hard problem reviewStatus is invalid');
    return this.store.listHardProblems(status as 'OPEN' | 'RESOLVED' | undefined, reviewStatus as HardProblemReviewStatus | undefined, this.actor(employeeId));
  }

  @Get('/hard-problems/:problemId')
  hardProblem(@Param('problemId') problemId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.store.getHardProblem(problemId, this.actor(employeeId));
  }

  @Post('/hard-problems')
  createHardProblem(@Body() body: Omit<HardProblem, 'id' | 'challengeId' | 'createdAt' | 'updatedAt' | 'status' | 'reviewStatus' | 'resolvedAt' | 'resolvedBy' | 'resolvedByName' | 'solutionSubmissionId' | 'solution'> & { id?: string; status?: 'OPEN' | 'RESOLVED'; solutionVisibility?: HardProblemSolutionVisibility; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    const { actorId: _ignoredActorId, ...problem } = body;
    return this.store.createHardProblem(problem, actorId);
  }

  @Post('/hard-problems/:problemId/review')
  reviewHardProblem(@Param('problemId') problemId: string, @Body() body: { decision?: string; comment?: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (body.decision !== 'APPROVE' && body.decision !== 'REJECT') throw new BadRequestException('decision must be APPROVE or REJECT');
    return this.store.reviewHardProblem(problemId, body.decision, body.comment ?? '', actorId);
  }

  @Post('/hard-problems/:problemId/resolve')
  resolveHardProblem(@Param('problemId') problemId: string, @Body() body: { actorId?: string; submissionId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.store.resolveHardProblem(problemId, this.actor(employeeId), body.submissionId);
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
    this.store.recordEnginePackageUpload(record, actorId);
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

  /**
   * Lease queued evaluation tasks. The platform hands out immutable work
   * descriptors; the evaluation environment runs the engine and posts results
   * back, so no challenge or engine code executes while serving this request.
   */
  @Post('/evaluation-tasks:lease')
  @HttpCode(200)
  leaseEvaluationTasks(@Body() body: { workerId?: string; limit?: number; executorIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const tasks = this.tasks.lease(String(body.workerId ?? '').trim(), Number(body.limit ?? 1), Array.isArray(body.executorIds) ? body.executorIds : [], actorId);
    return { leasedAt: new Date().toISOString(), tasks };
  }

  @Post('/evaluation-tasks/:runId/heartbeat')
  @HttpCode(200)
  heartbeatEvaluationTask(@Param('runId') runId: string, @Body() body: { leaseId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.tasks.heartbeat(runId, String(body.leaseId ?? ''), this.requireAdmin(employeeId));
  }

  @Post('/evaluation-tasks/:runId/complete')
  @HttpCode(201)
  completeEvaluationTask(@Param('runId') runId: string, @Body() body: { leaseId?: string; result?: Record<string, unknown> }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!body.result || typeof body.result !== 'object') throw new BadRequestException({ code: 'RESULT_REQUIRED', message: '缺少评测结果' });
    return { accepted: true, stored: this.tasks.complete(runId, String(body.leaseId ?? ''), body.result, actorId) };
  }

  @Post('/evaluation-tasks/:runId/fail')
  @HttpCode(200)
  failEvaluationTask(@Param('runId') runId: string, @Body() body: { leaseId?: string; reason?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.tasks.fail(runId, String(body.leaseId ?? ''), String(body.reason ?? ''), this.requireAdmin(employeeId));
  }

  @Get('/evaluation-batches')
  evaluationBatchList(@Query('eventId') eventId?: string, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.list(this.requireAdmin(employeeId), eventId);
  }

  @Get('/evaluation-batches/:batchId')
  evaluationBatch(@Param('batchId') batchId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.get(batchId, this.requireAdmin(employeeId));
  }

  /** Lease complete same-challenge batches for a Code Agent worker. */
  @Post('/evaluation-batches:lease')
  @HttpCode(200)
  leaseEvaluationBatches(@Body() body: { workerId?: string; limit?: number; executorIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const batches = this.evaluationBatches.lease(String(body.workerId ?? '').trim(), Number(body.limit ?? 1), Array.isArray(body.executorIds) ? body.executorIds : [], actorId);
    return { leasedAt: new Date().toISOString(), batches };
  }

  @Post('/evaluation-batches/:batchId/heartbeat')
  @HttpCode(200)
  heartbeatEvaluationBatch(@Param('batchId') batchId: string, @Body() body: { leaseId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.heartbeat(batchId, String(body.leaseId ?? ''), this.requireAdmin(employeeId));
  }

  @Post('/evaluation-batches/:batchId/complete')
  @HttpCode(201)
  completeEvaluationBatch(
    @Param('batchId') batchId: string,
    @Body() body: { leaseId?: string; results?: Array<{ runId: string; result: Record<string, unknown> }>; failures?: Array<{ runId: string; reason: string }> },
    @Headers('x-employee-id') employeeId?: string,
  ) {
    return this.evaluationBatches.complete(batchId, String(body.leaseId ?? ''), body.results ?? [], body.failures ?? [], this.requireAdmin(employeeId));
  }

  @Post('/evaluation-batches/:batchId/fail')
  @HttpCode(200)
  failEvaluationBatch(@Param('batchId') batchId: string, @Body() body: { leaseId?: string; reason?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.evaluationBatches.fail(batchId, String(body.leaseId ?? ''), String(body.reason ?? ''), this.requireAdmin(employeeId));
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
  adminOverview(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    return this.store.adminOverview(actorId);
  }

  @Get('/admin/grading-queue')
  gradingQueue(@Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (process.env.EMBEDDED_EVALUATION_WORKER === 'true') return this.autoQueue.getStats();
    const batches = this.evaluationBatches.list(actorId);
    return {
      queued: batches.filter((batch) => batch.status === 'QUEUED').length,
      running: batches.filter((batch) => batch.status === 'RUNNING').length,
      maxConcurrency: Number(process.env.EVALUATION_BATCH_LEASE_MAX ?? 5),
      scheduled: batches.filter((batch) => ['QUEUED', 'RUNNING'].includes(batch.status)).length,
      embedded: process.env.EMBEDDED_EVALUATION_WORKER === 'true',
    };
  }

  @Get('/admin/code-agent-runtime')
  codeAgentRuntime(@Headers('x-employee-id') employeeId?: string) {
    return this.store.getCodeAgentRuntimeConfig(this.requireGlobalAdmin(employeeId));
  }

  @Put('/admin/code-agent-runtime')
  updateCodeAgentRuntime(@Body() body: CodeAgentRuntimeInput, @Headers('x-employee-id') employeeId?: string) {
    return this.store.updateCodeAgentRuntimeConfig(body, this.requireGlobalAdmin(employeeId));
  }

  @Get('/admin/capabilities')
  adminCapabilities(@Query('orgPath') orgPath?: string, @Query('subjectIds') subjectIds?: string, @Query('includeProfiles') includeProfiles?: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const selectedSubjectIds = subjectIds
      ? subjectIds.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
    return this.store.adminCapabilities(actorId, { orgPath, subjectIds: selectedSubjectIds, includeProfiles: includeProfiles !== 'false' });
  }

  @Get('/org-units')
  orgUnits(@Query('parentId') parentId?: string, @Headers('x-employee-id') employeeId?: string) {
    return this.store.listOrgUnits(parentId, this.actor(employeeId));
  }

  @Post('/org-units')
  createOrgUnit(@Body() body: { id: string; parentId?: string; label?: string; name: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...input } = body;
    return this.store.createOrgUnit(input, actorId);
  }

  @Patch('/org-units/:orgUnitId')
  updateOrgUnit(@Param('orgUnitId') orgUnitId: string, @Body() body: { label?: string; name?: string; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.store.updateOrgUnit(orgUnitId, patch, actorId);
  }

  @Get('/org-units/:orgUnitId')
  orgUnit(@Param('orgUnitId') orgUnitId: string) {
    return this.store.getOrgUnit(orgUnitId);
  }

  @Get('/users')
  users(@Query('orgPath') orgPath?: string, @Headers('x-employee-id') employeeId?: string) {
    return this.store.listUsers(orgPath, this.actor(employeeId));
  }

  @Get('/users/:userId')
  user(@Param('userId') userId: string, @Headers('x-employee-id') employeeId?: string) {
    this.store.assertSelfOrAdmin(this.actor(employeeId), userId);
    return this.store.getUser(userId);
  }

  @Patch('/users/:userId')
  updateUser(@Param('userId') userId: string, @Body() body: { orgUnitId?: string; roles?: string[]; roleBindings?: Array<{ role: string; scopeOrgPath: string }>; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.store.updateUser(userId, patch, actorId);
  }

  @Get('/challenges')
  challenges(@Headers('x-employee-id') employeeId?: string) {
    return this.store.listChallenges(this.actor(employeeId)).map((challenge) => this.withResolvedSubmissionContracts(challenge));
  }

  @Get('/challenges/:challengeId')
  challenge(@Param('challengeId') challengeId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.withResolvedSubmissionContracts(this.store.getChallenge(challengeId, this.actor(employeeId)));
  }

  @Post('/challenges')
  createChallenge(@Body() body: Challenge & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...challenge } = body;
    for (const version of challenge.versions ?? []) {
      this.assertExecutorSelection(version);
      this.assertSubmissionContract(version);
    }
    return this.store.createChallenge(challenge, actorId);
  }

  @Post('/challenges/:challengeId/publish')
  publishChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.store.publishChallenge(challengeId, this.requireAdmin(employeeId));
  }

  @Patch('/challenges/:challengeId')
  updateChallenge(@Param('challengeId') challengeId: string, @Body() body: { category?: ChallengeCategory; solutionVisibility?: HardProblemSolutionVisibility; actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.store.updateChallenge(challengeId, patch, actorId);
  }

  @Post('/challenges/:challengeId/archive')
  archiveChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.store.archiveChallenge(challengeId, this.requireAdmin(employeeId));
  }

  @Post('/challenges/:challengeId/trash')
  trashChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.store.archiveChallenge(challengeId, this.requireAdmin(employeeId));
  }

  @Post('/challenges/:challengeId/restore')
  restoreChallenge(@Param('challengeId') challengeId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.store.restoreChallenge(challengeId, this.requireAdmin(employeeId));
  }

  @Post('/challenges/:challengeId/versions')
  createChallengeVersion(@Param('challengeId') challengeId: string, @Body() body: ChallengeVersion & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...version } = body;
    this.assertExecutorSelection(version);
    this.assertSubmissionContract(version);
    return this.store.addChallengeVersion(challengeId, version, actorId);
  }

  @Patch('/challenges/:challengeId/versions/:versionId')
  updateChallengeVersion(@Param('challengeId') challengeId: string, @Param('versionId') versionId: string, @Body() body: Partial<ChallengeVersion> & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    if (patch.evaluationEngine) this.assertExecutorSelection(patch as { evaluationEngine?: EvaluationEngineConfig });
    this.assertSubmissionContract(patch);
    return this.store.updateChallengeVersion(challengeId, versionId, patch, actorId);
  }

  @Post('/challenges/:challengeId/versions/:versionId/publish')
  publishChallengeVersion(@Param('challengeId') challengeId: string, @Param('versionId') versionId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    return this.store.publishChallengeVersion(challengeId, versionId, this.requireAdmin(employeeId));
  }

  @Get('/seasons')
  seasons() {
    return this.store.listSeasons();
  }

  @Post('/seasons')
  createSeason(@Body() body: Season & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    this.store.assertGlobalAdmin(actorId);
    const { actorId: _ignoredActorId, ...season } = body;
    return this.store.createSeason(season, actorId);
  }

  @Get('/seasons/:seasonId/leaderboard')
  leaderboard(@Param('seasonId') seasonId: string) {
    return this.store.leaderboard(seasonId);
  }

  @Get('/seasons/:seasonId')
  season(@Param('seasonId') seasonId: string) {
    return this.store.getSeason(seasonId);
  }

  @Get('/profiles/:subjectId')
  profile(@Param('subjectId') subjectId: string, @Headers('x-employee-id') employeeId?: string) {
    this.store.assertSelfOrAdmin(this.actor(employeeId), subjectId);
    return this.store.profile(subjectId);
  }

  @Get('/profiles/:subjectId/capabilities')
  capabilities(@Param('subjectId') subjectId: string, @Headers('x-employee-id') employeeId?: string) {
    this.store.assertSelfOrAdmin(this.actor(employeeId), subjectId);
    return this.store.capabilities(subjectId);
  }

  @Get('/events')
  events(@Headers('x-employee-id') employeeId?: string) {
    return this.store.listEvents(this.actor(employeeId));
  }

  @Get('/events/:eventId')
  event(@Param('eventId') eventId: string, @Headers('x-employee-id') employeeId?: string) {
    return this.store.getEvent(eventId, this.actor(employeeId));
  }

  @Post('/events')
  createEvent(@Body() body: (Omit<EventConfig, 'status'> & { status?: EventConfig['status'] }) & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...event } = body;
    return this.store.createEvent(event, actorId);
  }

  @Patch('/events/:eventId')
  updateEvent(@Param('eventId') eventId: string, @Body() body: Partial<Omit<EventConfig, 'id' | 'status'>> & { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const { actorId: _ignoredActorId, ...patch } = body;
    return this.store.updateEvent(eventId, patch, actorId);
  }

  @Get('/events/:eventId/participants')
  participants(@Param('eventId') eventId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    return this.store.listParticipants(eventId, actorId);
  }

  @Put('/events/:eventId/participants')
  replaceParticipants(@Param('eventId') eventId: string, @Body() body: { subjectIds: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!Array.isArray(body.subjectIds) || body.subjectIds.length > 10000) throw new BadRequestException('subjectIds must be an array with at most 10000 items');
    return this.store.replaceParticipants(eventId, body.subjectIds, actorId);
  }

  @Post('/events/:eventId/participants:import')
  importParticipants(@Param('eventId') eventId: string, @Body() body: { participants: Array<{ subjectId: string }> }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (!Array.isArray(body.participants) || body.participants.length > 10000) throw new BadRequestException('participants must be an array with at most 10000 items');
    return this.store.importParticipants(eventId, body.participants, actorId);
  }

  @Get('/submissions')
  submissions(@Query('eventId') eventId?: string, @Headers('x-employee-id') employeeId?: string) {
    return this.store.listSubmissions(eventId, this.actor(employeeId));
  }

  @Post('/submissions')
  async createSubmission(@Body() body: { eventId: string; subjectId: string; snapshot: SubmissionSnapshot }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    this.store.assertSelfOrAdmin(actorId, body.subjectId);
    const snapshot = this.normalizeSnapshot(body.snapshot);
    const version = this.store.challengeVersionForEvent(body.eventId);
    if (snapshot.artifactUri) await this.submissionContracts.validateArtifact(version, snapshot.artifactUri);
    else if (snapshot.workspacePath) this.submissionContracts.validateWorkspace(version, snapshot.workspacePath);
    const submission = this.store.createSubmission(body.eventId, body.subjectId, snapshot);
    this.scheduleIfAutomatic(body.eventId, submission.id);
    return submission;
  }

  @Post('/events/:eventId/submissions:upload')
  async upload(@Param('eventId') eventId: string, @Body() body: { subjectId: string; snapshot: SubmissionSnapshot; artifactBase64?: string; fileName?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.actor(employeeId);
    this.store.assertSelfOrAdmin(actorId, body.subjectId);
    const event = this.store.getEvent(eventId);
    this.store.assertSubmissionSubject(eventId, body.subjectId);
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
      const estimatedBytes = Math.floor(normalizedEncoded.length * 3 / 4);
      if (event.deliveryConfig?.maxBytes && estimatedBytes > event.deliveryConfig.maxBytes) {
        throw new BadRequestException(`artifact exceeds event maxBytes ${event.deliveryConfig.maxBytes}`);
      }
      const stored = await this.artifacts.saveBase64(body.artifactBase64, fileName);
      if (event.deliveryConfig?.maxBytes && stored.size > event.deliveryConfig.maxBytes) {
        throw new BadRequestException(`artifact exceeds event maxBytes ${event.deliveryConfig.maxBytes}`);
      }
      if (snapshot.artifactHash && snapshot.artifactHash !== stored.sha256) {
        throw new BadRequestException('artifactHash does not match uploaded bytes');
      }
      await this.artifacts.validateArchive(stored.uri, event.deliveryConfig?.maxFiles ?? 2000);
      await this.submissionContracts.validateArtifact(this.store.challengeVersionForEvent(eventId), stored.uri);
      const computedSnapshotHash = await this.artifacts.snapshotHash(stored.uri);
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
      const actualArtifactHash = await this.artifacts.contentHash(snapshot.artifactUri);
      if (snapshot.artifactHash && snapshot.artifactHash !== actualArtifactHash) {
        throw new BadRequestException('artifactHash does not match stored artifact bytes');
      }
      await this.artifacts.validateArchive(snapshot.artifactUri, event.deliveryConfig?.maxFiles ?? 2000);
      await this.submissionContracts.validateArtifact(this.store.challengeVersionForEvent(eventId), snapshot.artifactUri);
      const computedSnapshotHash = await this.artifacts.snapshotHash(snapshot.artifactUri);
      if (snapshot.snapshotHash && snapshot.snapshotHash !== computedSnapshotHash) {
        throw new BadRequestException('snapshotHash does not match stored artifact contents');
      }
      snapshot = { ...snapshot, artifactHash: actualArtifactHash, snapshotHash: computedSnapshotHash };
    } else if (!snapshot.workspacePath) {
      throw new BadRequestException('upload requires artifactBase64, artifactUri or a local workspacePath');
    } else {
      this.submissionContracts.validateWorkspace(this.store.challengeVersionForEvent(eventId), snapshot.workspacePath);
    }
    const submission = this.store.createSubmission(eventId, body.subjectId, this.normalizeSnapshot(snapshot));
    this.scheduleIfAutomatic(eventId, submission.id);
    return submission;
  }

  @Post('/events/:eventId/submissions:register-git')
  async registerGit(@Param('eventId') eventId: string, @Body() body: { subjectId: string; snapshot: SubmissionSnapshot }, @Headers('x-employee-id') employeeId?: string) {
    this.store.assertSelfOrAdmin(this.actor(employeeId), body.subjectId);
    const event = this.store.getEvent(eventId);
    this.store.assertSubmissionSubject(eventId, body.subjectId);
    let snapshot = this.normalizeSnapshot({ ...body.snapshot, ...(this.localGit.enabled ? { workspacePath: undefined } : {}), sourceType: 'GIT_REF' });
    if (this.localGit.enabled && event.deliveryConfig?.pinAt !== 'DEADLINE' && snapshot.repository && snapshot.branch && snapshot.commitSha) {
      const local = await this.localGit.snapshot({ repository: snapshot.repository, branch: snapshot.branch, commitSha: snapshot.commitSha });
      await this.submissionContracts.validateArtifact(this.store.challengeVersionForEvent(eventId), local.artifact.uri);
      snapshot = { ...snapshot, commitSha: local.commitSha, artifactUri: local.artifact.uri, artifactHash: local.artifact.sha256, snapshotHash: local.snapshotHash };
    }
    const submission = this.store.createSubmission(eventId, body.subjectId, snapshot);
    this.scheduleIfAutomatic(eventId, submission.id);
    return submission;
  }

  @Post('/submissions/:submissionId/start-grading')
  startSubmission(@Param('submissionId') submissionId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const run = this.store.startGrading(submissionId, actorId);
    this.evaluationBatches.create([run.id], actorId);
    return run;
  }

  @Post('/submissions/:submissionId/regrade')
  regradeSubmission(@Param('submissionId') submissionId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const result = this.store.regradeSubmission(submissionId, this.requireAdmin(employeeId));
    if (result.run?.triggerType === 'AUTO') this.scheduleIfAutomatic(result.submission.eventId, submissionId);
    return result;
  }

  @Post('/events/:eventId/start-grading')
  startEvent(@Param('eventId') eventId: string, @Body() body: { actorId?: string; submissionIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const runs = this.store.startEventGrading(eventId, actorId, body.submissionIds);
    return { runs, ...(runs.length ? { batch: this.evaluationBatches.create(runs.map((run) => run.id), actorId) } : {}) };
  }

  @Post('/events/:eventId/regrade')
  regradeEvent(@Param('eventId') eventId: string, @Body() body: { actorId?: string; submissionIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const result = this.store.regradeEvent(eventId, this.requireAdmin(employeeId), body.submissionIds);
    for (const run of result.runs) if (run.triggerType === 'AUTO') this.scheduleIfAutomatic(eventId, run.submissionId);
    return result;
  }

  @Post('/events/:eventId/grading-input')
  gradingInput(@Param('eventId') eventId: string, @Body() body: { submissionIds?: string[] }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const batch = this.store.prepareEvaluationInput(eventId, body.submissionIds ?? [], actorId);
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
    const available = this.store.listSubmissions(eventId, actorId);
    const selectedIds = body.submissionIds === undefined ? undefined : [...new Set(body.submissionIds.map((id) => String(id).trim()).filter(Boolean))];
    if (selectedIds && !selectedIds.length) throw new BadRequestException('at least one submission must be selected');
    if (selectedIds && selectedIds.some((id) => !available.some((submission) => submission.id === id))) {
      throw new BadRequestException('selected submissions are outside this event or administrator scope');
    }
    for (const submission of available.filter((item) => !selectedIds || selectedIds.includes(item.id))) {
      if (!submission.gradingRunId || submission.resultId) continue;
      const currentRun = this.store.getRun(submission.gradingRunId);
      if (currentRun.status === 'RUNNING') continue;
      const run = this.store.markRunRunning(submission.gradingRunId);
      try {
        const result = await this.localGrader.execute({ event: this.store.getEvent(eventId), submission, run, ...this.store.gradingContextForSubmission(submission) });
        executions.push({ run: this.store.getRun(run.id), stored: this.store.completeRun(run.id, result) });
      } catch (error) {
        this.store.failRun(run.id, error instanceof Error ? error.message : String(error));
        executions.push({ run: this.store.getRun(run.id), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return executions;
  }

  @Post('/events/:eventId/reveal')
  reveal(@Param('eventId') eventId: string, @Headers('x-employee-id') employeeId?: string) {
    return { eventId, revealed: this.store.reveal(eventId, this.requireAdmin(employeeId)) };
  }

  @Post('/events/:eventId/close')
  async close(@Param('eventId') eventId: string, @Body() _body: { actorId?: string }, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const event = this.store.getEvent(eventId, actorId);
    if (event.submissionSource === 'GIT_REF' && event.deliveryConfig?.pinAt === 'DEADLINE') {
      // Deadline pinning must cover every delivery in the event, not just the
      // ones inside the closing administrator's subject scope; the event scope
      // itself was already asserted above.
      const pending = this.store.systemSubmissions(eventId).filter((submission) => !submission.resultId && !submission.gradingRunId);
      if (pending.length && !this.localGit.enabled) {
        throw new BadRequestException('DEADLINE Git pinning requires LOCAL_GIT_ROOT in local mode');
      }
      for (const submission of pending) {
        const repository = submission.snapshot.repository;
        const branch = submission.snapshot.branch;
        if (!repository || !branch) throw new BadRequestException(`submission ${submission.id} has no Git repository or branch`);
        const local = await this.localGit.snapshot({ repository, branch });
        await this.submissionContracts.validateArtifact(this.store.challengeVersionForEvent(eventId), local.artifact.uri);
        this.store.pinGitSnapshot(submission.id, { commitSha: local.commitSha, artifactUri: local.artifact.uri, artifactHash: local.artifact.sha256, snapshotHash: local.snapshotHash }, actorId);
      }
    }
    return this.store.closeEvent(eventId, actorId);
  }

  @Get('/audits')
  audits(@Query('target') target?: string, @Headers('x-employee-id') employeeId?: string) {
    this.requireAdmin(employeeId);
    return this.store.listAudits(target);
  }

  @Get('/submissions/:submissionId')
  submission(@Param('submissionId') submissionId: string, @Headers('x-employee-id') employeeId?: string) {
    this.store.assertCanViewSubmission(this.actor(employeeId), submissionId);
    return this.store.getSubmission(submissionId);
  }

  @Get('/submissions/:submissionId/artifact')
  async downloadSubmissionArtifact(@Param('submissionId') submissionId: string, @Headers('x-employee-id') employeeId?: string, @Res({ passthrough: true }) response?: any) {
    const actorId = this.requireAdmin(employeeId);
    this.store.assertCanViewSubmission(actorId, submissionId);
    const submission = this.store.getSubmission(submissionId);
    const artifactUri = submission.snapshot.artifactUri;
    if (!artifactUri) throw new NotFoundException('该提交没有可下载的交付件');
    let content: Buffer;
    try {
      content = await this.artifacts.readBuffer(artifactUri);
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
  importResult(@Body() body: { result: Record<string, unknown>; actorId?: string; eventId?: string; subjectId?: string }, @Headers('x-employee-id') employeeId?: string, @Headers('idempotency-key') requestIdempotencyKey?: string) {
    const actorId = this.requireAdmin(employeeId);
    if (requestIdempotencyKey && body.result.idempotencyKey !== requestIdempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_MISMATCH', message: 'Idempotency-Key must match result.idempotencyKey' });
    const errors = validateEvaluationResult(body.result);
    if (errors.length) throw new BadRequestException({ code: 'RESULT_SCHEMA_INVALID', errors });
    return { accepted: true, stored: this.store.importResult(body.result as Record<string, any>, actorId, { eventId: body.eventId, subjectId: body.subjectId }) };
  }

  @Post('/grading-results:import-batch')
  @HttpCode(201)
  importBatch(@Body() body: { results: Array<{ result: Record<string, unknown>; eventId?: string; subjectId?: string }> }, @Headers('x-employee-id') employeeId?: string) {
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
        const stored = this.store.importResult(item.result as Record<string, any>, actorId, { eventId: item.eventId, subjectId: item.subjectId });
        accepted.push({ index, ok: true, resultId: stored.resultId, submissionId: stored.submissionId, code: 'RESULT_IMPORTED', message: 'evaluation result accepted' });
      } catch (error) {
        rejected.push({ index, ok: false, resultId: item.result?.resultId, code: 'RESULT_IMPORT_REJECTED', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { accepted, rejected, acceptedCount: accepted.length, rejectedCount: rejected.length };
  }

  @Get('/grading-runs/:runId')
  gradingRun(@Param('runId') runId: string, @Headers('x-employee-id') employeeId?: string) {
    this.store.assertCanViewRun(this.actor(employeeId), runId);
    return this.store.getRun(runId);
  }

  @Post('/grading-runs/:runId/execute')
  async executeLocal(@Param('runId') runId: string, @Headers('x-employee-id') employeeId?: string) {
    const actorId = this.requireAdmin(employeeId);
    const storedRun = this.store.getRun(runId);
    const submission = this.store.getSubmission(storedRun.submissionId);
    this.store.getEvent(submission.eventId, actorId);
    const run = this.store.markRunRunning(runId);
    if (run.status === 'GRADED' && submission.resultId) return { run, stored: this.store.getReport(submission.id) };
    try {
      const result = await this.localGrader.execute({ event: this.store.getEvent(submission.eventId), submission, run, ...this.store.gradingContextForSubmission(submission) });
      return { run: this.store.getRun(runId), stored: this.store.completeRun(runId, result) };
    } catch (error) {
      this.store.failRun(runId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  @Get('/reports/:submissionId')
  report(@Param('submissionId') submissionId: string, @Headers('x-employee-id') employeeId?: string) {
    this.store.assertCanViewSubmission(this.actor(employeeId), submissionId);
    return this.store.getReport(submissionId);
  }
}
