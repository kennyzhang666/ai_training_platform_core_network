import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OBJECT_STORAGE, ObjectStorage } from './object-storage';

/**
 * Periodically removes expired staging objects and their durable capability
 * rows. The operation is idempotent, so multiple API replicas may run it;
 * production lifecycle policy remains the final cleanup backstop.
 */
@Injectable()
export class ObjectStorageCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  onModuleInit(): void {
    const seconds = Number(process.env.OBJECT_STORAGE_CLEANUP_INTERVAL_SECONDS ?? 300);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.timer = setInterval(() => { void this.cleanup(); }, Math.max(30, Math.min(seconds, 86_400)) * 1000);
    this.timer.unref?.();
    void this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.storage.discardExpired(); } catch { /* the next interval and bucket lifecycle policy retry cleanup */ }
    finally { this.running = false; }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
