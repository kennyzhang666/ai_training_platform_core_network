import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PlatformController } from './controllers';
import { PlatformStore } from './store';
import { ArtifactStore } from './artifact-store';
import { GRADING_EXECUTOR, LocalGradingExecutor } from './grading-executor';
import { EnginePackageStore } from './engine-package-store';
import { EngineRunner } from './packaged-engine-executor';
import { ExecutorRegistry } from './executor-registry';
import { EvaluationTaskService } from './evaluation-task-service';
import { SubmissionContractService } from './submission-contract-service';
import { EvaluationBatchService } from './evaluation-batch-service';
import { GradingDispatcher } from './grading-dispatcher';
import { AutoGradingQueue } from './auto-grading-queue';
import { ApiExceptionFilter } from './error-filter';
import { LocalGitSnapshotter } from './git-snapshotter';

@Module({
  controllers: [PlatformController],
  providers: [PlatformStore, ArtifactStore, SubmissionContractService, LocalGitSnapshotter, EnginePackageStore, ExecutorRegistry, EvaluationTaskService, EvaluationBatchService, LocalGradingExecutor, EngineRunner, GradingDispatcher, AutoGradingQueue, { provide: GRADING_EXECUTOR, useExisting: GradingDispatcher }, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
