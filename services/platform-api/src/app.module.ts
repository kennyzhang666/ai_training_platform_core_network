import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PlatformController } from './controllers';
import { PlatformStore } from './store';
import { createPlatformStore } from './postgres-platform-store';
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
import { createUserDirectoryRepository, USER_DIRECTORY_REPOSITORY, UserDirectoryService } from './user-directory';
import { AuthenticatedActorGuard } from './identity-guard';
import { createObjectStorage, OBJECT_STORAGE } from './object-storage';
import { PrismaUploadSessionPersistence } from './prisma-upload-session-persistence';
import { PlatformPersistenceInterceptor } from './platform-persistence-interceptor';
import { PlatformReadService } from './platform-read-service';
import { PostgresDomainUnitOfWork } from './postgres-domain-unit-of-work';
import { PlatformMetrics } from './metrics';
import { MetricsInterceptor } from './metrics-interceptor';
import { ObjectStorageCleanupService } from './object-storage-cleanup';
import { EvaluationContractCatalogService } from './evaluation-contract-catalog';

@Module({
  controllers: [PlatformController],
  providers: [{ provide: PlatformStore, useFactory: createPlatformStore }, PostgresDomainUnitOfWork, PlatformReadService, PlatformMetrics, MetricsInterceptor, ArtifactStore, PrismaUploadSessionPersistence, EvaluationContractCatalogService, { provide: OBJECT_STORAGE, inject: [ArtifactStore, PrismaUploadSessionPersistence], useFactory: (artifacts: ArtifactStore, uploadSessions: PrismaUploadSessionPersistence) => createObjectStorage(artifacts, uploadSessions.enabled ? uploadSessions : undefined) }, ObjectStorageCleanupService, SubmissionContractService, LocalGitSnapshotter, EnginePackageStore, ExecutorRegistry, EvaluationTaskService, EvaluationBatchService, LocalGradingExecutor, EngineRunner, GradingDispatcher, AutoGradingQueue, UserDirectoryService, AuthenticatedActorGuard, { provide: USER_DIRECTORY_REPOSITORY, inject: [PlatformStore], useFactory: createUserDirectoryRepository }, { provide: GRADING_EXECUTOR, useExisting: GradingDispatcher }, { provide: APP_FILTER, useClass: ApiExceptionFilter }, { provide: APP_GUARD, useExisting: AuthenticatedActorGuard }, { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }, { provide: APP_INTERCEPTOR, useClass: PlatformPersistenceInterceptor }],
})
export class AppModule {}
