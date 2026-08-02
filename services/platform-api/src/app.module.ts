import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PlatformController } from './controllers';
import { PlatformStore } from './store';
import { ArtifactStore } from './artifact-store';
import { GRADING_EXECUTOR, LocalGradingExecutor } from './grading-executor';
import { EnginePackageStore } from './engine-package-store';
import { PackagedEngineExecutor } from './packaged-engine-executor';
import { GradingDispatcher } from './grading-dispatcher';
import { AutoGradingQueue } from './auto-grading-queue';
import { ApiExceptionFilter } from './error-filter';
import { LocalGitSnapshotter } from './git-snapshotter';

@Module({
  controllers: [PlatformController],
  providers: [PlatformStore, ArtifactStore, LocalGitSnapshotter, EnginePackageStore, LocalGradingExecutor, PackagedEngineExecutor, GradingDispatcher, AutoGradingQueue, { provide: GRADING_EXECUTOR, useExisting: GradingDispatcher }, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
