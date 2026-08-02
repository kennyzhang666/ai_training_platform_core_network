import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { GradingExecutionRequest, GradingExecutor } from './grading-executor';
import { EngineRunner } from './packaged-engine-executor';

/**
 * Routes a run by the mode its challenge engine declares. Built-in executors
 * and uploaded packages share one runner and one invocation contract, so the
 * only real branch is "does the platform run this at all".
 */
@Injectable()
export class GradingDispatcher implements GradingExecutor {
  constructor(@Inject(EngineRunner) private readonly runner: EngineRunner) {}

  async execute(input: GradingExecutionRequest): Promise<Record<string, unknown>> {
    if (input.engine.mode === 'PLATFORM_LOCAL' || input.engine.mode === 'PACKAGED') {
      return this.runner.execute(input);
    }
    throw new BadRequestException({
      code: 'ENGINE_NOT_LOCAL',
      message: `赛题的评测引擎为 ${input.engine.mode}，请使用线下结果录入而不是平台内执行`,
    });
  }
}
