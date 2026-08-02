import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PlatformController } from './controllers';
import { PlatformStore } from './store';
import { ArtifactStore } from './artifact-store';
import { GRADING_EXECUTOR, LocalGradingExecutor } from './grading-executor';
import { AutoGradingQueue } from './auto-grading-queue';
import { ApiExceptionFilter } from './error-filter';
import { LocalGitSnapshotter } from './git-snapshotter';

@Module({
  controllers: [PlatformController],
  providers: [PlatformStore, ArtifactStore, LocalGitSnapshotter, LocalGradingExecutor, AutoGradingQueue, { provide: GRADING_EXECUTOR, useExisting: LocalGradingExecutor }, { provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
