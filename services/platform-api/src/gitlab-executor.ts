import { Injectable, NotImplementedException } from '@nestjs/common';
import { EventConfig, GradingRun, SubmissionRecord } from './domain';
import { GradingExecutor } from './grading-executor';

/**
 * Stable seam for the final production adapter.  The platform domain only
 * depends on GradingExecutor; GitLab credentials, pipeline variables and
 * callback verification stay behind this boundary.
 */
export interface GitLabPipelineRequest {
  projectPath: string;
  ref: string;
  variables: Record<string, string>;
}

export interface GitLabPipelineClient {
  trigger(request: GitLabPipelineRequest): Promise<{ pipelineId: string }>;
}

@Injectable()
export class GitLabGradingExecutor implements GradingExecutor {
  constructor(private readonly client?: GitLabPipelineClient) {}

  async execute(input: { event: EventConfig; submission: SubmissionRecord; run: GradingRun }): Promise<Record<string, unknown>> {
    if (!this.client) throw new NotImplementedException('GitLab grading adapter is intentionally deferred; use LocalGradingExecutor locally');
    const repository = input.submission.snapshot.repository ?? input.event.deliveryConfig?.repository;
    const branch = input.submission.snapshot.branch;
    if (!repository || !branch) throw new NotImplementedException('GitLab grading requires a configured repository and pinned branch');
    const pipeline = await this.client.trigger({
      projectPath: repository,
      ref: branch,
      variables: { GRADING_RUN_ID: input.run.id, SNAPSHOT_HASH: input.submission.snapshot.snapshotHash },
    });
    return { deferred: true, pipelineId: pipeline.pipelineId, gradingRunId: input.run.id };
  }
}
