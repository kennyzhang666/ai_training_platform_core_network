import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PlatformStore } from './store';
import { GradingExecutor, GRADING_EXECUTOR } from './grading-executor';

/**
 * Embedded evaluation worker, for single-host development.
 *
 * The production shape is pull-based: an evaluation environment leases full
 * batches through `/evaluation-batches:lease` and posts results back, so the
 * API never executes engine code. This class is only the explicit compatibility
 * path used by local tests when `EMBEDDED_EVALUATION_WORKER=true`.
 */
@Injectable()
export class AutoGradingQueue implements OnModuleInit {
  private readonly embedded = process.env.EMBEDDED_EVALUATION_WORKER === 'true';
  private readonly scheduled = new Set<string>();
  private readonly pending: string[] = [];
  private readonly maxConcurrency = Math.max(1, Math.min(8, Number(process.env.LOCAL_GRADING_CONCURRENCY ?? 2)));
  private active = 0;

  constructor(
    @Inject(PlatformStore) private readonly store: PlatformStore,
    @Inject(GRADING_EXECUTOR) private readonly grader: GradingExecutor,
  ) {}

  onModuleInit(): void {
    if (!this.embedded) return;
    // Rehydrate only AUTO work after a local API restart. MANUAL and IMPORT
    // runs must remain administrator-controlled even when their state is
    // persisted as QUEUED.
    for (const submission of this.store.systemSubmissions()) {
      if (!submission.gradingRunId || submission.resultId) continue;
      let run;
      try { run = this.store.getRun(submission.gradingRunId); } catch { continue; }
      if (run.triggerType === 'AUTO' && ['QUEUED', 'RUNNING'].includes(run.status)) this.enqueue(submission.id);
    }
  }

  enqueue(submissionId: string): void {
    // With an external evaluation environment the run simply stays QUEUED
    // until a worker leases it.
    if (!this.embedded) return;
    if (this.scheduled.has(submissionId)) return;
    this.scheduled.add(submissionId);
    this.pending.push(submissionId);
    this.pump();
  }

  getStats(): { queued: number; running: number; maxConcurrency: number; scheduled: number; embedded: boolean } {
    return { queued: this.pending.length, running: this.active, maxConcurrency: this.maxConcurrency, scheduled: this.scheduled.size, embedded: this.embedded };
  }

  private pump(): void {
    while (this.active < this.maxConcurrency && this.pending.length) {
      const submissionId = this.pending.shift()!;
      this.active += 1;
      setImmediate(() => void this.run(submissionId).finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.scheduled.delete(submissionId);
        this.pump();
      }));
    }
  }

  private async run(submissionId: string): Promise<void> {
    try {
      const submission = this.store.getSubmission(submissionId);
      if (!submission.gradingRunId || submission.resultId) return;
      const run = this.store.markRunRunning(submission.gradingRunId);
      const result = await this.grader.execute({ event: this.store.getEvent(submission.eventId), submission, run, ...this.store.gradingContextForSubmission(submission) });
      this.store.completeRun(run.id, result);
    } catch (error) {
      try {
        const submission = this.store.getSubmission(submissionId);
        if (submission.gradingRunId) this.store.failRun(submission.gradingRunId, error instanceof Error ? error.message : String(error));
      } catch {
        // The original failure is already represented by the run state.
      }
    }
  }
}
