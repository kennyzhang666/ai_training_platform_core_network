import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PlatformStore } from './store';
import { claimSnapshotRevision, loadNormalizedState, synchronizeNormalized } from './postgres-platform-store';

const SNAPSHOT_ID = 'singleton';

function repositoryMode(): string {
  return (process.env.PLATFORM_REPOSITORY ?? 'file').trim().toLowerCase();
}

function snapshotState(value: Prisma.JsonValue | null | undefined): Partial<import('./store').PlatformStateSnapshot> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Partial<import('./store').PlatformStateSnapshot>;
}

/**
 * Request-scoped PostgreSQL Unit of Work for domains that are still exposed
 * through the mature PlatformStore business rules.
 *
 * The working store is created from the current normalized graph *inside* the
 * same database transaction.  The operation therefore never validates a
 * stale process snapshot, while the revision CAS makes concurrent writers
 * fail with a retryable conflict instead of silently replacing one another.
 * The file adapter keeps its existing synchronous path and is not affected.
 */
@Injectable()
export class PostgresDomainUnitOfWork implements OnModuleDestroy {
  private readonly client?: PrismaClient;

  constructor(@Inject(PlatformStore) private readonly cache: PlatformStore) {
    const mode = repositoryMode();
    if (mode === 'postgres') {
      if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required when PLATFORM_REPOSITORY=postgres');
      this.client = new PrismaClient();
    } else if (mode !== 'file') {
      throw new Error(`unsupported PLATFORM_REPOSITORY: ${mode}`);
    }
  }

  get isPostgres(): boolean {
    return Boolean(this.client);
  }

  private async workingStore(db: Prisma.TransactionClient): Promise<PlatformStore> {
    const snapshot = await db.platformSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
    const normalized = await loadNormalizedState(db);
    const compatibility = snapshotState(snapshot?.state);
    const working = new PlatformStore({ dataFile: ':memory:', seed: false });
    // Hard-problem entries created by the pre-v0.7 compatibility path have
    // no normalized table of their own. Preserve them until their
    // Challenge.board projection is explicitly migrated.
    working.importState(normalized
      ? { ...normalized, ...(normalized.hardProblems?.length ? {} : compatibility?.hardProblems?.length ? { hardProblems: compatibility.hardProblems } : {}) }
      : compatibility ?? {});
    return working;
  }

  async run<T>(operation: (store: PlatformStore) => T | Promise<T>): Promise<T> {
    if (!this.client) return operation(this.cache);

    const committed = await this.client.$transaction(async (db) => {
      const snapshot = await db.platformSnapshot.findUnique({ where: { id: SNAPSHOT_ID } });
      const working = await this.workingStore(db);

      const revision = await claimSnapshotRevision(db, snapshot?.revision ?? 0);
      const result = await operation(working);
      const state = working.exportState();
      await synchronizeNormalized(db, state, revision);
      return { result, state };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: Number(process.env.PERSIST_TRANSACTION_TIMEOUT_MS ?? 120_000) });

    // Keep this process's authorization and compatibility read cache aligned
    // with the committed canonical state.  No persistence write is queued;
    // `noteExternalCommit` only advances the CAS cursor for the legacy writer.
    this.cache.importState(committed.state);
    this.cache.noteExternalCommit();
    return committed.result;
  }

  /** Read the latest canonical graph without touching the process cache. */
  async read<T>(operation: (store: PlatformStore) => T | Promise<T>): Promise<T> {
    if (!this.client) return operation(this.cache);
    return this.client.$transaction(async (db) => operation(await this.workingStore(db)), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: Number(process.env.PERSIST_TRANSACTION_TIMEOUT_MS ?? 120_000) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}
