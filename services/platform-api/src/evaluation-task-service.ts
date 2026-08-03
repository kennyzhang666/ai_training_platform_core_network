import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { EvaluationTask, GradingRun, StoredResult } from './domain';
import { PlatformStore } from './store';
import { ExecutorRegistry } from './executor-registry';

const LEASE_SECONDS = Number(process.env.EVALUATION_LEASE_SECONDS ?? 900);
const MAX_LEASE_BATCH = Number(process.env.EVALUATION_LEASE_MAX_BATCH ?? 20);

/**
 * The platform's side of the pull-based evaluation protocol.
 *
 * Evaluation environments lease queued tasks, run the engine themselves, and
 * post the result back. The platform therefore never executes challenge or
 * engine code as part of serving an API request; it only hands out immutable
 * work descriptors and validates what comes back. A worker that dies simply
 * lets its lease expire, and the task returns to the queue.
 */
@Injectable()
export class EvaluationTaskService {
  constructor(
    @Inject(PlatformStore) private readonly store: PlatformStore,
    @Inject(ExecutorRegistry) private readonly executors: ExecutorRegistry,
  ) {}

  /** Return runs whose lease has lapsed to the queue before handing out work. */
  reclaimExpiredLeases(): number {
    const now = Date.now();
    let reclaimed = 0;
    for (const run of this.store.systemRuns()) {
      if (run.status !== 'RUNNING' || !run.leaseExpiresAt) continue;
      if (Date.parse(run.leaseExpiresAt) > now) continue;
      this.store.releaseLease(run.id, '评测任务租约超时，已重新排队');
      reclaimed += 1;
    }
    return reclaimed;
  }

  private taskFor(run: GradingRun, workerId: string, leaseSeconds: number): EvaluationTask | undefined {
    const submission = this.store.getSubmission(run.submissionId);
    const context = this.store.gradingContextForSubmission(submission);
    // EXTERNAL_CLI challenges are never queued for a worker; they are evaluated
    // offline and imported by an administrator.
    if (context.engine.mode !== 'PLATFORM_LOCAL' && context.engine.mode !== 'PACKAGED') return undefined;
    const engine = this.executors.resolve(context.engine);
    const manifest = engine.manifest;
    const assets: Record<string, string> = {};
    for (const [key, value] of Object.entries(manifest.assets ?? {})) {
      if (value) assets[key] = value;
    }
    const lease = this.store.acquireLease(run.id, workerId, leaseSeconds);
    return {
      runId: run.id,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.leaseExpiresAt,
      attempt: run.attempt ?? 1,
      triggerType: run.triggerType,
      idempotencyKey: run.idempotencyKey,
      engine: {
        source: engine.source,
        id: engine.id,
        version: engine.version,
        packageHash: engine.packageHash,
        entrypoint: manifest.runtime.entrypoint,
        ...(manifest.runtime.requirements ? { requirements: manifest.runtime.requirements } : {}),
        params: engine.params,
        limits: {
          wallClockSeconds: manifest.limits?.wallClockSeconds ?? 180,
          memoryMB: manifest.limits?.memoryMB ?? 512,
          outputBytes: manifest.limits?.outputBytes ?? 5 * 1024 * 1024,
        },
        assets,
        ...(engine.platformDependencies.length ? { platformDependencies: engine.platformDependencies } : {}),
      },
      challenge: context.challenge,
      subject: {
        id: submission.subjectId,
        name: this.store.getUser(submission.subjectId).name,
        orgPath: submission.orgPathSnapshot,
      },
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

  lease(workerId: string, limit = 1, executorIds: string[] = [], actorId = 'w00123'): EvaluationTask[] {
    if (!workerId.trim()) throw new BadRequestException({ code: 'WORKER_ID_REQUIRED', message: '评测环境必须声明 workerId' });
    this.reclaimExpiredLeases();
    const wanted = Math.max(1, Math.min(limit, MAX_LEASE_BATCH));
    const tasks: EvaluationTask[] = [];
    for (const run of this.store.systemRuns()) {
      if (tasks.length >= wanted) break;
      if (run.status !== 'QUEUED') continue;
      // Runs owned by a Code Agent batch must stay together; the legacy
      // single-run endpoint may not split one learner out of that batch.
      if (run.evaluationBatchId) continue;
      try { this.store.assertGradingRunScope(run.id, actorId); } catch { continue; }
      let task: EvaluationTask | undefined;
      try {
        task = this.taskFor(run, workerId, LEASE_SECONDS);
      } catch (error) {
        // A misconfigured challenge must not block the queue for everyone else.
        this.store.failRun(run.id, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!task) continue;
      if (executorIds.length && !executorIds.includes(task.engine.id)) {
        this.store.releaseLease(run.id);
        continue;
      }
      tasks.push(task);
    }
    return tasks;
  }

  private assertLease(runId: string, leaseId: string, actorId: string): GradingRun {
    this.store.assertGradingRunScope(runId, actorId);
    const run = this.store.getRun(runId);
    if (run.status === 'GRADED') throw new ConflictException({ code: 'TASK_ALREADY_COMPLETED', message: '该评测任务已完成' });
    if (!run.leaseId || run.leaseId !== leaseId) {
      throw new ConflictException({ code: 'TASK_LEASE_INVALID', message: '租约已失效，任务可能已被重新分配' });
    }
    return run;
  }

  heartbeat(runId: string, leaseId: string, actorId = 'w00123'): { leaseExpiresAt: string } {
    const run = this.assertLease(runId, leaseId, actorId);
    return { leaseExpiresAt: this.store.extendLease(run.id, LEASE_SECONDS) };
  }

  complete(runId: string, leaseId: string, result: Record<string, unknown>, actorId = 'w00123'): StoredResult {
    this.assertLease(runId, leaseId, actorId);
    return this.store.completeRun(runId, result);
  }

  fail(runId: string, leaseId: string, reason: string, actorId = 'w00123'): GradingRun {
    this.assertLease(runId, leaseId, actorId);
    return this.store.failRun(runId, reason || '评测环境未给出失败原因');
  }

  /** Local repository path of a built-in executor, for a worker on this host. */
  builtInExecutorPath(executorId: string, projectRoot: string): string {
    const summary = this.executors.list().find((item) => item.id === executorId);
    if (!summary) throw new BadRequestException({ code: 'EXECUTOR_NOT_FOUND', message: `内置执行器不存在: ${executorId}` });
    return relative(projectRoot, resolve(projectRoot, 'executors', executorId)) || executorId;
  }
}
