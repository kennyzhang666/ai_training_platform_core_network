import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PlatformStore } from './store';
import { GradingExecutor, GRADING_EXECUTOR } from './grading-executor';

/** Local replacement for the future queue/worker (GitLab/K8s adapter). */
@Injectable()
export class AutoGradingQueue implements OnModuleInit {
  private readonly scheduled = new Set<string>();
  private readonly pending: string[] = [];
  private readonly maxConcurrency = Math.max(1, Math.min(8, Number(process.env.LOCAL_GRADING_CONCURRENCY ?? 2)));
  private active = 0;

  constructor(
    @Inject(PlatformStore) private readonly store: PlatformStore,
    @Inject(GRADING_EXECUTOR) private readonly grader: GradingExecutor,
  ) {}

  onModuleInit(): void {
    // Rehydrate only AUTO work after a local API restart. MANUAL and IMPORT
    // runs must remain administrator-controlled even when their state is
    // persisted as QUEUED.
    for (const submission of this.store.listSubmissions()) {
      if (!submission.gradingRunId || submission.resultId) continue;
      let run;
      try { run = this.store.getRun(submission.gradingRunId); } catch { continue; }
      if (run.triggerType === 'AUTO' && ['QUEUED', 'RUNNING'].includes(run.status)) this.enqueue(submission.id);
    }
  }

  enqueue(submissionId: string): void {
    if (this.scheduled.has(submissionId)) return;
    this.scheduled.add(submissionId);
    this.pending.push(submissionId);
    this.pump();
  }

  getStats(): { queued: number; running: number; maxConcurrency: number; scheduled: number } {
    return { queued: this.pending.length, running: this.active, maxConcurrency: this.maxConcurrency, scheduled: this.scheduled.size };
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
      const result = await this.grader.execute({ event: this.store.getEvent(submission.eventId), submission, run });
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
