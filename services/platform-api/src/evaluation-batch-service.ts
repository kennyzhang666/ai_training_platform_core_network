import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { EvaluationBatch, EvaluationBatchTask, GradingRun, StoredResult } from './domain';
import { ExecutorRegistry } from './executor-registry';
import { PlatformStore } from './store';
import { PostgresDomainUnitOfWork } from './postgres-domain-unit-of-work';

function boundedSetting(env: Record<string, string | undefined>, name: string, fallback: number, minimum: number, maximum: number, aliases: string[] = []): number {
  const source = [name, ...aliases].find((key) => env[key]?.trim());
  if (!source) return fallback;
  const value = Number(env[source]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${source} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function evaluationBatchLeaseSeconds(env: Record<string, string | undefined> = process.env): number {
  return boundedSetting(env, 'EVALUATION_BATCH_LEASE_SECONDS', 1800, 60, 21_600, ['EVALUATION_LEASE_SECONDS']);
}

export function evaluationBatchLeaseLimit(env: Record<string, string | undefined> = process.env): number {
  return boundedSetting(env, 'EVALUATION_BATCH_LEASE_MAX', 5, 1, 100);
}

const LEASE_SECONDS = evaluationBatchLeaseSeconds();
const MAX_LEASE_BATCHES = evaluationBatchLeaseLimit();

type BatchResultInput = { runId: string; result: Record<string, unknown> };
type BatchFailureInput = { runId: string; reason: string };

@Injectable()
export class EvaluationBatchService {
  constructor(
    @Inject(PlatformStore) private readonly store: PlatformStore,
    @Inject(ExecutorRegistry) private readonly executors: ExecutorRegistry,
    @Optional() @Inject(PostgresDomainUnitOfWork) private readonly domainUnitOfWork?: PostgresDomainUnitOfWork,
  ) {}

  create(runIds: string[], actorId: string): EvaluationBatch {
    return this.store.createEvaluationBatch(runIds, actorId);
  }

  list(actorId: string, eventId?: string): EvaluationBatch[] {
    return this.store.listEvaluationBatches(actorId, eventId);
  }

  async listPersistent(actorId: string, eventId?: string): Promise<EvaluationBatch[]> {
    if (!this.domainUnitOfWork?.isPostgres) return this.list(actorId, eventId);
    return this.domainUnitOfWork.read((store) => store.listEvaluationBatches(actorId, eventId));
  }

  get(batchId: string, actorId: string): EvaluationBatch {
    const batch = this.store.getEvaluationBatch(batchId);
    // Reuse the scoped list rather than exposing a system-level batch lookup.
    if (!this.store.listEvaluationBatches(actorId, batch.eventId).some((item) => item.id === batch.id)) {
      throw new ConflictException('evaluation batch is outside the administrator scope');
    }
    return batch;
  }

  async getPersistent(batchId: string, actorId: string): Promise<EvaluationBatch> {
    if (!this.domainUnitOfWork?.isPostgres) return this.get(batchId, actorId);
    return this.domainUnitOfWork.read((store) => {
      store.assertEvaluationBatchScope(batchId, actorId);
      return store.getEvaluationBatch(batchId);
    });
  }

  reclaimExpiredLeases(): number {
    let reclaimed = 0;
    const current = Date.now();
    for (const batch of this.store.systemEvaluationBatches()) {
      if (batch.status !== 'RUNNING' || !batch.leaseExpiresAt || Date.parse(batch.leaseExpiresAt) > current) continue;
      this.store.releaseEvaluationBatchLease(batch.id, '评测批次租约超时，已重新排队');
      reclaimed += 1;
    }
    return reclaimed;
  }

  private resolveAgentPaths(engineRoot: string, instruction: string, skills: string[]): { instruction: string; skills: string[] } {
    const instructionTarget = resolve(engineRoot, instruction);
    if (!instructionTarget.startsWith(`${engineRoot}${sep}`) || !existsSync(instructionTarget)) {
      throw new BadRequestException({ code: 'CODE_AGENT_ASSET_MISSING', message: `Code Agent instruction 不存在：${instruction}` });
    }
    if (!statSync(instructionTarget).isFile()) {
      throw new BadRequestException({ code: 'CODE_AGENT_ASSET_INVALID', message: `Code Agent instruction 必须是文件：${instruction}` });
    }
    const normalizedSkills = skills.map((value) => {
      const target = resolve(engineRoot, value);
      if (!target.startsWith(`${engineRoot}${sep}`) || !existsSync(target)) {
        throw new BadRequestException({ code: 'CODE_AGENT_ASSET_MISSING', message: `Code Agent skill 不存在：${value}` });
      }
      if (statSync(target).isDirectory()) {
        const skillFile = resolve(target, 'SKILL.md');
        if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
          throw new BadRequestException({ code: 'CODE_AGENT_ASSET_INVALID', message: `Code Agent skill 缺少 SKILL.md：${value}` });
        }
        return value;
      }
      if (basename(target) !== 'SKILL.md') {
        throw new BadRequestException({ code: 'CODE_AGENT_ASSET_INVALID', message: `Code Agent skill 必须指向 Skills 目录或 SKILL.md：${value}` });
      }
      return dirname(value).replace(/\\/g, '/');
    });
    return { instruction, skills: normalizedSkills };
  }

  private taskFor(store: PlatformStore, batch: EvaluationBatch, workerId: string): EvaluationBatchTask {
    const runs = batch.runIds.map((runId) => store.getRun(runId));
    const firstSubmission = store.getSubmission(runs[0].submissionId);
    const context = store.gradingContextForSubmission(firstSubmission);
    const resolved = this.executors.resolve(context.engine);
    const configuredAgent = context.engine.agent;
    const manifestAgent = resolved.manifest.agent;
    const instruction = configuredAgent?.instructionPath ?? manifestAgent?.instruction ?? 'instruction.md';
    const skills = configuredAgent?.skillPaths ?? manifestAgent?.skills ?? ['skills/evaluation'];
    if (!skills.length) throw new BadRequestException({ code: 'CODE_AGENT_SKILLS_REQUIRED', message: '该赛题未配置 Code Agent skills' });
    const agent = this.resolveAgentPaths(resolved.root, instruction, skills);
    const assets: Record<string, string> = {};
    for (const [key, value] of Object.entries(resolved.manifest.assets ?? {})) if (value) assets[key] = value;
    const lease = store.acquireEvaluationBatchLease(batch.id, workerId, LEASE_SECONDS);
    const activeRuns = runs.filter((run) => run.status === 'RUNNING');
    return {
      batchId: batch.id,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.leaseExpiresAt,
      engine: {
        source: resolved.source,
        id: resolved.id,
        version: resolved.version,
        packageHash: resolved.packageHash,
        entrypoint: resolved.manifest.runtime.entrypoint,
        ...(resolved.manifest.runtime.requirements ? { requirements: resolved.manifest.runtime.requirements } : {}),
        params: resolved.params,
        limits: {
          wallClockSeconds: resolved.manifest.limits?.wallClockSeconds ?? 180,
          memoryMB: resolved.manifest.limits?.memoryMB ?? 512,
          outputBytes: resolved.manifest.limits?.outputBytes ?? 5 * 1024 * 1024,
        },
        assets,
        ...(resolved.platformDependencies.length ? { platformDependencies: resolved.platformDependencies } : {}),
        agent,
      },
      ...(batch.codeAgentRuntime ? { codeAgentRuntime: { ...batch.codeAgentRuntime, args: [...batch.codeAgentRuntime.args] } } : {}),
      contracts: {
        input: { ...context.engine.input },
        output: { ...context.engine.output },
      },
      challenge: context.challenge,
      submissions: activeRuns.map((run) => this.submissionDescriptor(store, run)),
    };
  }

  private submissionDescriptor(store: PlatformStore, run: GradingRun): EvaluationBatchTask['submissions'][number] {
    const submission = store.getSubmission(run.submissionId);
    const subject = store.getUser(submission.subjectId);
    return {
      runId: run.id,
      attempt: run.attempt ?? 1,
      triggerType: run.triggerType,
      idempotencyKey: run.idempotencyKey,
      subject: { id: subject.id, name: subject.name, orgPath: submission.orgPathSnapshot ?? subject.orgPath },
      submission: {
        id: submission.id,
        eventId: submission.eventId,
        sourceType: submission.snapshot.sourceType,
        snapshotHash: submission.snapshot.snapshotHash,
        ...(submission.snapshot.artifactHash ? { artifactHash: submission.snapshot.artifactHash } : {}),
        ...(submission.snapshot.artifactUri ? { artifactUrl: `/api/v1/submissions/${submission.id}/artifact` } : {}),
        ...(submission.snapshot.repository ? { repository: submission.snapshot.repository } : {}),
        ...(submission.snapshot.branch ? { branch: submission.snapshot.branch } : {}),
        ...(submission.snapshot.commitSha ? { commitSha: submission.snapshot.commitSha } : {}),
        ...(submission.snapshot.workspacePath ? { workspacePath: submission.snapshot.workspacePath } : {}),
        submittedAt: submission.snapshot.submittedAt,
      },
    };
  }

  lease(workerId: string, limit = 1, executorIds: string[] = [], actorId = 'w00123'): EvaluationBatchTask[] {
    if (!workerId.trim()) throw new BadRequestException({ code: 'WORKER_ID_REQUIRED', message: '评测环境必须声明 workerId' });
    this.reclaimExpiredLeases();
    const wanted = Math.max(1, Math.min(Number(limit) || 1, MAX_LEASE_BATCHES));
    const tasks: EvaluationBatchTask[] = [];
    const allowedBatchIds = new Set(this.store.listEvaluationBatches(actorId).map((batch) => batch.id));
    for (const batch of this.store.systemEvaluationBatches()) {
      if (tasks.length >= wanted) break;
      if (batch.status !== 'QUEUED' || !allowedBatchIds.has(batch.id)) continue;
      try {
        const batchRuns = batch.runIds.map((runId) => this.store.getRun(runId));
        const completedRunIds = batchRuns.filter((run) => run.status === 'GRADED').map((run) => run.id);
        const failedRunIds = batchRuns.filter((run) => run.status === 'FAILED').map((run) => run.id);
        if (completedRunIds.length + failedRunIds.length === batchRuns.length) {
          this.store.finishEvaluationBatch(
            batch.id,
            completedRunIds,
            failedRunIds,
            failedRunIds.length ? `${failedRunIds.length} 份提交未完成评测` : undefined,
          );
          continue;
        }
        const task = this.taskFor(this.store, batch, workerId);
        if (executorIds.length && !executorIds.includes(task.engine.id)) {
          this.store.releaseEvaluationBatchLease(batch.id);
          continue;
        }
        tasks.push(task);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failed: string[] = [];
        for (const runId of batch.runIds) {
          const run = this.store.getRun(runId);
          if (run.status === 'GRADED' || run.status === 'FAILED') continue;
          this.store.failRun(runId, reason);
          failed.push(runId);
        }
        this.store.finishEvaluationBatch(batch.id, [], failed, reason);
      }
    }
    return tasks;
  }

  /** PostgreSQL request path: batch selection, lease and every run transition share one UoW. */
  async leasePersistent(workerId: string, limit = 1, executorIds: string[] = [], actorId = 'w00123'): Promise<EvaluationBatchTask[]> {
    if (!this.domainUnitOfWork?.isPostgres) return this.lease(workerId, limit, executorIds, actorId);
    return this.domainUnitOfWork.run((store) => {
      if (!workerId.trim()) throw new BadRequestException({ code: 'WORKER_ID_REQUIRED', message: '评测环境必须声明 workerId' });
      const current = Date.now();
      for (const batch of store.systemEvaluationBatches()) {
        if (batch.status === 'RUNNING' && batch.leaseExpiresAt && Date.parse(batch.leaseExpiresAt) <= current) {
          store.releaseEvaluationBatchLease(batch.id, '评测批次租约超时，已重新排队');
        }
      }
      const wanted = Math.max(1, Math.min(Number(limit) || 1, MAX_LEASE_BATCHES));
      const tasks: EvaluationBatchTask[] = [];
      const allowedBatchIds = new Set(store.listEvaluationBatches(actorId).map((batch) => batch.id));
      for (const batch of store.systemEvaluationBatches()) {
        if (tasks.length >= wanted || batch.status !== 'QUEUED' || !allowedBatchIds.has(batch.id)) continue;
        try {
          const batchRuns = batch.runIds.map((runId) => store.getRun(runId));
          const completedRunIds = batchRuns.filter((run) => run.status === 'GRADED').map((run) => run.id);
          const failedRunIds = batchRuns.filter((run) => run.status === 'FAILED').map((run) => run.id);
          if (completedRunIds.length + failedRunIds.length === batchRuns.length) {
            store.finishEvaluationBatch(batch.id, completedRunIds, failedRunIds, failedRunIds.length ? `${failedRunIds.length} 份提交未完成评测` : undefined);
            continue;
          }
          const task = this.taskFor(store, batch, workerId);
          if (executorIds.length && !executorIds.includes(task.engine.id)) {
            store.releaseEvaluationBatchLease(batch.id);
            continue;
          }
          tasks.push(task);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const failed: string[] = [];
          for (const runId of batch.runIds) {
            const run = store.getRun(runId);
            if (run.status === 'GRADED' || run.status === 'FAILED') continue;
            store.failRun(runId, reason);
            failed.push(runId);
          }
          store.finishEvaluationBatch(batch.id, [], failed, reason);
        }
      }
      return tasks;
    });
  }

  private assertLeaseForStore(store: PlatformStore, batchId: string, leaseId: string, actorId: string): EvaluationBatch {
    store.assertEvaluationBatchScope(batchId, actorId);
    const batch = store.getEvaluationBatch(batchId);
    if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(batch.status)) {
      if (!batch.completionLeaseId || batch.completionLeaseId !== leaseId) {
        throw new ConflictException({ code: 'BATCH_LEASE_INVALID', message: '批次回调凭据无效' });
      }
      return batch;
    }
    if (batch.status !== 'RUNNING' || !batch.leaseId || batch.leaseId !== leaseId) {
      throw new ConflictException({ code: 'BATCH_LEASE_INVALID', message: '批次租约已失效，任务可能已被重新分配' });
    }
    return batch;
  }

  private assertLease(batchId: string, leaseId: string, actorId: string): EvaluationBatch {
    return this.assertLeaseForStore(this.store, batchId, leaseId, actorId);
  }

  heartbeat(batchId: string, leaseId: string, actorId = 'w00123'): { leaseExpiresAt: string } {
    const batch = this.assertLease(batchId, leaseId, actorId);
    if (batch.status !== 'RUNNING') throw new ConflictException({ code: 'BATCH_ALREADY_FINISHED', message: '该评测批次已经结束' });
    return { leaseExpiresAt: this.store.extendEvaluationBatchLease(batch.id, LEASE_SECONDS) };
  }

  async heartbeatPersistent(batchId: string, leaseId: string, actorId = 'w00123'): Promise<{ leaseExpiresAt: string }> {
    if (!this.domainUnitOfWork?.isPostgres) return this.heartbeat(batchId, leaseId, actorId);
    return this.domainUnitOfWork.run((store) => {
      const batch = this.assertLeaseForStore(store, batchId, leaseId, actorId);
      if (batch.status !== 'RUNNING') throw new ConflictException({ code: 'BATCH_ALREADY_FINISHED', message: '该评测批次已经结束' });
      return { leaseExpiresAt: store.extendEvaluationBatchLease(batch.id, LEASE_SECONDS) };
    });
  }

  private completeForStore(store: PlatformStore, batchId: string, leaseId: string, results: BatchResultInput[], failures: BatchFailureInput[] = [], actorId = 'w00123'): {
    batch: EvaluationBatch;
    accepted: StoredResult[];
    rejected: Array<{ runId: string; reason: string }>;
  } {
    const batch = this.assertLeaseForStore(store, batchId, leaseId, actorId);
    if (batch.status !== 'RUNNING') {
      return {
        batch,
        accepted: (batch.completedRunIds ?? []).map((runId) => {
          const submission = store.getSubmission(store.getRun(runId).submissionId);
          return store.getStoredResult(submission.resultId!);
        }),
        rejected: (batch.failedRunIds ?? []).map((runId) => ({ runId, reason: store.getRun(runId).failureReason ?? '评测失败' })),
      };
    }
    if (!Array.isArray(results) || !Array.isArray(failures) || results.length + failures.length > 500) {
      throw new BadRequestException('batch results must contain at most 500 items');
    }
    const allowed = new Set(batch.runIds);
    const accepted: StoredResult[] = [];
    const rejected: Array<{ runId: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const runId of batch.runIds) {
      const run = store.getRun(runId);
      if (run.status === 'GRADED') {
        const submission = store.getSubmission(run.submissionId);
        if (!submission.resultId) throw new ConflictException({ code: 'BATCH_RESULT_MISSING', message: `已完成运行缺少结果：${runId}` });
        accepted.push(store.getStoredResult(submission.resultId));
        seen.add(runId);
      } else if (run.status === 'FAILED') {
        rejected.push({ runId, reason: run.failureReason ?? '评测失败' });
        seen.add(runId);
      }
    }
    for (const item of [...results, ...failures]) {
      if (!allowed.has(item.runId)) throw new BadRequestException(`run does not belong to evaluation batch: ${item.runId}`);
      if (seen.has(item.runId)) throw new BadRequestException(`run appears more than once in evaluation batch result: ${item.runId}`);
      seen.add(item.runId);
    }
    for (const item of results) {
      try {
        accepted.push(store.completeRun(item.runId, item.result));
      } catch (error) {
        rejected.push({ runId: item.runId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const item of failures) {
      const reason = item.reason?.trim() || 'Code Agent 未给出失败原因';
      store.failRun(item.runId, reason);
      rejected.push({ runId: item.runId, reason });
    }
    for (const runId of batch.runIds.filter((id) => !seen.has(id))) {
      const reason = 'Code Agent 未返回该提交的评测结果';
      store.failRun(runId, reason);
      rejected.push({ runId, reason });
    }
    const finished = store.finishEvaluationBatch(
      batch.id,
      accepted.map((item) => item.gradingRunId),
      rejected.map((item) => item.runId),
      rejected.length ? `${rejected.length} 份提交未完成评测` : undefined,
    );
    return { batch: finished, accepted, rejected };
  }

  complete(batchId: string, leaseId: string, results: BatchResultInput[], failures: BatchFailureInput[] = [], actorId = 'w00123'): {
    batch: EvaluationBatch;
    accepted: StoredResult[];
    rejected: Array<{ runId: string; reason: string }>;
  } {
    return this.completeForStore(this.store, batchId, leaseId, results, failures, actorId);
  }

  async completePersistent(batchId: string, leaseId: string, results: BatchResultInput[], failures: BatchFailureInput[] = [], actorId = 'w00123'): Promise<{
    batch: EvaluationBatch;
    accepted: StoredResult[];
    rejected: Array<{ runId: string; reason: string }>;
  }> {
    if (!this.domainUnitOfWork?.isPostgres) return this.complete(batchId, leaseId, results, failures, actorId);
    return this.domainUnitOfWork.run((store) => this.completeForStore(store, batchId, leaseId, results, failures, actorId));
  }

  private failForStore(store: PlatformStore, batchId: string, leaseId: string, reason: string, actorId = 'w00123'): EvaluationBatch {
    const batch = this.assertLeaseForStore(store, batchId, leaseId, actorId);
    if (batch.status !== 'RUNNING') return batch;
    const failed: string[] = [];
    for (const runId of batch.runIds) {
      const run = store.getRun(runId);
      if (run.status === 'GRADED' || run.status === 'FAILED') continue;
      store.failRun(runId, reason || '评测环境未给出失败原因');
      failed.push(runId);
    }
    return store.finishEvaluationBatch(batch.id, [], failed, reason || '评测环境未给出失败原因');
  }

  fail(batchId: string, leaseId: string, reason: string, actorId = 'w00123'): EvaluationBatch {
    return this.failForStore(this.store, batchId, leaseId, reason, actorId);
  }

  async failPersistent(batchId: string, leaseId: string, reason: string, actorId = 'w00123'): Promise<EvaluationBatch> {
    if (!this.domainUnitOfWork?.isPostgres) return this.fail(batchId, leaseId, reason, actorId);
    return this.domainUnitOfWork.run((store) => this.failForStore(store, batchId, leaseId, reason, actorId));
  }
}
