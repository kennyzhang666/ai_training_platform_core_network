import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { GradingExecutionRequest, GradingExecutor } from './grading-executor';
import { LocalGradingExecutor } from './grading-executor';
import { PackagedEngineExecutor } from './packaged-engine-executor';

/**
 * Routes a run to the executor its challenge engine declares. `mode` is the
 * single dispatch decision in the platform; adding a production adapter
 * (GitLab, remote runner) means adding a branch here, not changing any caller.
 */
@Injectable()
export class GradingDispatcher implements GradingExecutor {
  constructor(
    @Inject(LocalGradingExecutor) private readonly builtIn: LocalGradingExecutor,
    @Inject(PackagedEngineExecutor) private readonly packaged: PackagedEngineExecutor,
  ) {}

  async execute(input: GradingExecutionRequest): Promise<Record<string, unknown>> {
    switch (input.engine.mode) {
      case 'PLATFORM_LOCAL':
        return this.builtIn.execute(input);
      case 'PACKAGED':
        return this.packaged.execute(input);
      default:
        throw new BadRequestException({
          code: 'ENGINE_NOT_LOCAL',
          message: `赛题的评测引擎为 ${input.engine.mode}，请使用线下结果录入而不是平台内执行`,
        });
    }
  }
}
