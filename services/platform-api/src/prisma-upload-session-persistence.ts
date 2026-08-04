import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { StoredArtifact } from './artifact-store';
import {
  PersistedUploadSession,
  UploadSessionPersistence,
  UploadedObjectMetadata,
} from './object-storage';

/**
 * PostgreSQL-backed upload-session state.  Object bytes stay in S3; this
 * table only holds the short-lived capability, its compare-and-set status and
 * the immutable object metadata needed to survive an API restart.
 */
@Injectable()
export class PrismaUploadSessionPersistence implements UploadSessionPersistence, OnModuleDestroy {
  private readonly client?: PrismaClient;
  readonly enabled: boolean;

  constructor() {
    const mode = (process.env.PLATFORM_REPOSITORY ?? 'file').trim().toLowerCase();
    if (mode === 'postgres') {
      if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required when PLATFORM_REPOSITORY=postgres');
      this.client = new PrismaClient();
    }
    this.enabled = Boolean(this.client);
  }

  private db(): PrismaClient {
    if (!this.client) throw new Error('PostgreSQL upload-session persistence is not enabled');
    return this.client;
  }

  private map(row: {
    id: string;
    tokenHash: string;
    objectKey: string;
    actorId: string;
    eventId: string;
    fileName: string;
    declaredSize: number;
    expiresAt: Date;
    status: string;
    uploadedSize: number | null;
    uploadedSha256: string | null;
    completedUri: string | null;
    completedSize: number | null;
    completedSha256: string | null;
  }): PersistedUploadSession {
    const uploaded = row.uploadedSize !== null && row.uploadedSha256 !== null
      ? { size: row.uploadedSize, sha256: row.uploadedSha256 }
      : undefined;
    const completed = row.completedUri && row.completedSize !== null && row.completedSha256
      ? { uri: row.completedUri, size: row.completedSize, sha256: row.completedSha256 }
      : undefined;
    const status = row.status === 'UPLOADING' || row.status === 'UPLOADED' || row.status === 'COMPLETED' ? row.status : 'CREATED';
    return {
      uploadId: row.id,
      tokenHash: row.tokenHash,
      objectKey: row.objectKey,
      actorId: row.actorId,
      eventId: row.eventId,
      fileName: row.fileName,
      declaredSize: row.declaredSize,
      expiresAt: row.expiresAt.toISOString(),
      status,
      ...(uploaded ? { uploaded } : {}),
      ...(completed ? { completed } : {}),
    };
  }

  async create(session: PersistedUploadSession): Promise<void> {
    await this.db().uploadSession.create({
      data: {
        id: session.uploadId,
        tokenHash: session.tokenHash,
        objectKey: session.objectKey,
        actorId: session.actorId,
        eventId: session.eventId,
        fileName: session.fileName,
        declaredSize: session.declaredSize,
        expiresAt: new Date(session.expiresAt),
        status: session.status,
      },
    });
  }

  async get(uploadId: string): Promise<PersistedUploadSession | undefined> {
    const row = await this.db().uploadSession.findUnique({ where: { id: uploadId } });
    return row ? this.map(row) : undefined;
  }

  async claim(uploadId: string): Promise<'CLAIMED' | 'BUSY' | 'DONE' | 'MISSING'> {
    const db = this.db();
    const changed = await db.uploadSession.updateMany({ where: { id: uploadId, status: 'CREATED' }, data: { status: 'UPLOADING' } });
    if (changed.count) return 'CLAIMED';
    const row = await db.uploadSession.findUnique({ where: { id: uploadId }, select: { status: true } });
    if (!row) return 'MISSING';
    return row.status === 'UPLOADING' ? 'BUSY' : 'DONE';
  }

  async release(uploadId: string): Promise<void> {
    await this.db().uploadSession.updateMany({ where: { id: uploadId, status: 'UPLOADING' }, data: { status: 'CREATED' } });
  }

  async markUploaded(uploadId: string, metadata: UploadedObjectMetadata): Promise<PersistedUploadSession> {
    const db = this.db();
    const changed = await db.uploadSession.updateMany({
      where: { id: uploadId, status: 'UPLOADING' },
      data: { status: 'UPLOADED', uploadedSize: metadata.size, uploadedSha256: metadata.sha256 },
    });
    if (!changed.count) {
      const current = await this.get(uploadId);
      if (current?.status === 'UPLOADED' && current.uploaded?.size === metadata.size && current.uploaded.sha256 === metadata.sha256) return current;
      throw new Error('upload session was changed while writing');
    }
    return (await this.get(uploadId))!;
  }

  async markCompleted(uploadId: string, artifact: StoredArtifact): Promise<PersistedUploadSession> {
    const db = this.db();
    const current = await this.get(uploadId);
    if (!current) throw new Error('upload session not found');
    if (current.completed) {
      if (current.completed.uri !== artifact.uri || current.completed.sha256 !== artifact.sha256 || current.completed.size !== artifact.size) throw new Error('upload session completion metadata does not match');
      return current;
    }
    const changed = await db.uploadSession.updateMany({
      where: { id: uploadId, status: 'UPLOADED' },
      data: { status: 'COMPLETED', completedUri: artifact.uri, completedSize: artifact.size, completedSha256: artifact.sha256 },
    });
    if (!changed.count) {
      const after = await this.get(uploadId);
      if (after?.completed && after.completed.uri === artifact.uri && after.completed.sha256 === artifact.sha256 && after.completed.size === artifact.size) return after;
      throw new Error('upload session is not ready for completion');
    }
    return (await this.get(uploadId))!;
  }

  async listExpired(now: Date): Promise<PersistedUploadSession[]> {
    const rows = await this.db().uploadSession.findMany({ where: { expiresAt: { lte: now }, status: { not: 'COMPLETED' } } });
    return rows.map((row) => this.map(row));
  }

  async remove(uploadId: string): Promise<void> {
    await this.db().uploadSession.deleteMany({ where: { id: uploadId } });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}
