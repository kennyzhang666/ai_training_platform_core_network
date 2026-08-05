import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ArtifactEntry, ArtifactStore, inspectArchiveFile, snapshotHashFile, StoredArtifact, validateArchiveFile } from './artifact-store';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface UploadSessionRequest {
  actorId: string;
  eventId: string;
  fileName: string;
  declaredSize: number;
  maxBytes: number;
  expiresInSeconds?: number;
}

export interface UploadSession {
  uploadId: string;
  uploadToken: string;
  objectKey: string;
  actorId: string;
  eventId: string;
  fileName: string;
  declaredSize: number;
  expiresAt: string;
}

export interface UploadedObjectMetadata {
  size: number;
  sha256: string;
}

export interface MaterializedArtifact {
  /** A local path valid only until cleanup is called. */
  path: string;
  cleanup(): Promise<void>;
}

export type UploadSessionStatus = 'CREATED' | 'UPLOADING' | 'UPLOADED' | 'COMPLETED';

/**
 * Durable state needed by the S3 two-phase upload protocol.  The token hash
 * is persisted, never the bearer token itself.  Implementations must make
 * `claim` a compare-and-set so two API instances cannot write the same
 * staging object concurrently.
 */
export interface PersistedUploadSession {
  uploadId: string;
  tokenHash: string;
  objectKey: string;
  actorId: string;
  eventId: string;
  fileName: string;
  declaredSize: number;
  expiresAt: string;
  status: UploadSessionStatus;
  uploaded?: UploadedObjectMetadata;
  completed?: StoredArtifact;
}

export interface UploadSessionPersistence {
  /** Whether this provider has durable backing enabled for the current process. */
  readonly enabled?: boolean;
  create(session: PersistedUploadSession): Promise<void>;
  get(uploadId: string): Promise<PersistedUploadSession | undefined>;
  claim(uploadId: string): Promise<'CLAIMED' | 'BUSY' | 'DONE' | 'MISSING'>;
  release(uploadId: string): Promise<void>;
  markUploaded(uploadId: string, metadata: UploadedObjectMetadata): Promise<PersistedUploadSession>;
  markCompleted(uploadId: string, artifact: StoredArtifact): Promise<PersistedUploadSession>;
  listExpired(now: Date): Promise<PersistedUploadSession[]>;
  remove(uploadId: string): Promise<void>;
}

export interface ObjectStorage {
  createUpload(request: UploadSessionRequest): Promise<UploadSession>;
  put(uploadId: string, uploadToken: string, bytes: Uint8Array, actorId: string): Promise<UploadedObjectMetadata>;
  confirm(uploadId: string, uploadToken: string, actorId: string, expected?: UploadedObjectMetadata): Promise<StoredArtifact>;
  read(uri: string): Promise<Buffer>;
  materialize(uri: string, fileName?: string): Promise<MaterializedArtifact>;
  contentHash(uri: string): Promise<string>;
  snapshotHash(uri: string): Promise<string>;
  validateArchive(uri: string, maxFiles?: number, maxExpandedBytes?: number): Promise<void>;
  inspectArchive(uri: string): Promise<ArtifactEntry[]>;
  discardExpired(now?: Date): Promise<number>;
}

interface SessionState extends UploadSession {
  tokenHash: string;
  stagingPath: string;
  uploaded?: UploadedObjectMetadata;
  completed?: StoredArtifact;
}

function safeFileName(value: string): string {
  const base = value.trim().split(/[\\/]/).pop() ?? '';
  const safe = base.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new BadRequestException('fileName is invalid');
  return safe.slice(0, 200);
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function compareToken(session: SessionState, token: string): boolean {
  const received = Buffer.from(tokenDigest(token), 'hex');
  const expected = Buffer.from(session.tokenHash, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Local two-phase object storage used by development and contract tests.
 * Content is first written to a per-upload staging file, then content-addressed
 * by ArtifactStore only after size and checksum confirmation. Sessions bind the
 * actor and event so a client cannot reuse another user's upload handle.
 */
@Injectable()
export class LocalObjectStorage implements ObjectStorage {
  private readonly sessions = new Map<string, SessionState>();
  private readonly stagingRoot = resolve(process.env.ARTIFACT_UPLOAD_TMP_ROOT ?? join(process.cwd(), 'tmp', 'artifact-uploads'));

  constructor(private readonly artifacts: ArtifactStore) {}

  async createUpload(request: UploadSessionRequest): Promise<UploadSession> {
    if (!request.actorId?.trim() || !request.eventId?.trim()) throw new BadRequestException('actorId and eventId are required');
    if (!Number.isSafeInteger(request.declaredSize) || request.declaredSize <= 0) throw new BadRequestException('declaredSize must be a positive integer');
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || request.declaredSize > request.maxBytes) throw new BadRequestException('declaredSize exceeds the upload limit');
    const uploadId = randomUUID();
    const uploadToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + Math.min(Math.max(request.expiresInSeconds ?? 900, 30), 3_600) * 1000).toISOString();
    const session: SessionState = {
      uploadId,
      uploadToken: '',
      tokenHash: tokenDigest(uploadToken),
      objectKey: `uploads/${uploadId}/${safeFileName(request.fileName)}`,
      actorId: request.actorId.trim(),
      eventId: request.eventId.trim(),
      fileName: safeFileName(request.fileName),
      declaredSize: request.declaredSize,
      expiresAt,
      stagingPath: join(this.stagingRoot, `${uploadId}.part`),
    };
    await mkdir(this.stagingRoot, { recursive: true });
    this.sessions.set(uploadId, session);
    return { uploadId, uploadToken, objectKey: session.objectKey, actorId: session.actorId, eventId: session.eventId, fileName: session.fileName, declaredSize: session.declaredSize, expiresAt };
  }

  private sessionFor(uploadId: string, uploadToken: string, actorId: string): SessionState {
    const session = this.sessions.get(uploadId);
    if (!session || !compareToken(session, uploadToken) || session.actorId !== actorId) throw new BadRequestException('upload handle is invalid');
    if (Date.parse(session.expiresAt) <= Date.now()) throw new BadRequestException('upload handle has expired');
    return session;
  }

  async put(uploadId: string, uploadToken: string, bytes: Uint8Array, actorId: string): Promise<UploadedObjectMetadata> {
    const session = this.sessionFor(uploadId, uploadToken, actorId);
    if (session.completed) return { size: session.completed.size, sha256: session.completed.sha256 };
    if (session.uploaded) throw new BadRequestException('upload has already been received');
    if (!bytes.length || bytes.length !== session.declaredSize) throw new BadRequestException('uploaded size does not match the declared size');
    const content = Buffer.from(bytes);
    const metadata = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    await writeFile(session.stagingPath, content, { flag: 'wx' });
    session.uploaded = metadata;
    return metadata;
  }

  async confirm(uploadId: string, uploadToken: string, actorId: string, expected?: UploadedObjectMetadata): Promise<StoredArtifact> {
    const session = this.sessionFor(uploadId, uploadToken, actorId);
    if (session.completed) {
      if (expected && (expected.size !== session.completed.size || expected.sha256 !== session.completed.sha256)) throw new BadRequestException('confirmed object metadata does not match');
      return session.completed;
    }
    if (!session.uploaded) throw new BadRequestException('upload has not been received');
    if (expected && (expected.size !== session.uploaded.size || expected.sha256 !== session.uploaded.sha256)) throw new BadRequestException('confirmed object metadata does not match');
    const content = await readFile(session.stagingPath);
    const actual = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    if (actual.size !== session.uploaded.size || actual.sha256 !== session.uploaded.sha256) throw new BadRequestException('staged object was modified');
    const stored = await this.artifacts.saveBuffer(content, session.fileName);
    session.completed = stored;
    await rm(session.stagingPath, { force: true });
    return stored;
  }

  read(uri: string): Promise<Buffer> { return this.artifacts.readBuffer(uri); }
  async materialize(uri: string): Promise<MaterializedArtifact> {
    return { path: this.artifacts.localPath(uri), cleanup: async () => undefined };
  }
  contentHash(uri: string): Promise<string> { return this.artifacts.contentHash(uri); }
  snapshotHash(uri: string): Promise<string> { return this.artifacts.snapshotHash(uri); }
  validateArchive(uri: string, maxFiles?: number, maxExpandedBytes?: number): Promise<void> { return this.artifacts.validateArchive(uri, maxFiles, maxExpandedBytes); }
  inspectArchive(uri: string): Promise<ArtifactEntry[]> { return this.artifacts.inspectArchive(uri); }

  async discardExpired(now = new Date()): Promise<number> {
    let removed = 0;
    for (const [uploadId, session] of this.sessions) {
      if (session.completed || Date.parse(session.expiresAt) > now.getTime()) continue;
      await rm(session.stagingPath, { force: true });
      this.sessions.delete(uploadId);
      removed += 1;
    }
    return removed;
  }

  async stagedBytes(uploadId: string): Promise<number> {
    const session = this.sessions.get(uploadId);
    if (!session) throw new BadRequestException('upload handle is invalid');
    try { return (await stat(session.stagingPath)).size; } catch { return 0; }
  }
}

interface S3Session extends Omit<UploadSession, 'uploadToken'> {
  tokenHash: string;
  stagingKey: string;
  status: UploadSessionStatus;
  uploaded?: UploadedObjectMetadata;
  completed?: StoredArtifact;
}

export interface S3ObjectStorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

/**
 * S3-compatible two-phase storage for production.  The API never accepts a
 * client-provided object key: the upload session owns a generated staging key
 * and confirmation copies it to a content-addressed immutable key.
 */
@Injectable()
export class S3ObjectStorage implements ObjectStorage {
  private readonly sessions = new Map<string, S3Session>();
  private readonly prefix: string;
  private readonly maxBytes = Number(process.env.ARTIFACT_MAX_BYTES ?? 50 * 1024 * 1024);

  constructor(private readonly client: S3Client, private readonly options: S3ObjectStorageOptions, private readonly persistence?: UploadSessionPersistence) {
    this.prefix = (options.prefix ?? 'platform').replace(/^\/+|\/+$/g, '') || 'platform';
  }

  async createUpload(request: UploadSessionRequest): Promise<UploadSession> {
    if (!request.actorId?.trim() || !request.eventId?.trim()) throw new BadRequestException('actorId and eventId are required');
    if (!Number.isSafeInteger(request.declaredSize) || request.declaredSize <= 0) throw new BadRequestException('declaredSize must be a positive integer');
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || request.declaredSize > request.maxBytes) throw new BadRequestException('declaredSize exceeds the upload limit');
    const uploadId = randomUUID();
    const uploadToken = randomBytes(32).toString('base64url');
    const fileName = safeFileName(request.fileName);
    const expiresAt = new Date(Date.now() + Math.min(Math.max(request.expiresInSeconds ?? 900, 30), 3_600) * 1000).toISOString();
    const stagingKey = `${this.prefix}/uploads/${uploadId}/${fileName}.part`;
    const session: S3Session = { uploadId, objectKey: stagingKey, actorId: request.actorId.trim(), eventId: request.eventId.trim(), fileName, declaredSize: request.declaredSize, expiresAt, tokenHash: tokenDigest(uploadToken), stagingKey, status: 'CREATED' };
    if (this.persistence) {
      await this.persistence.create(session);
    } else {
      this.sessions.set(uploadId, session);
    }
    return { uploadId, uploadToken, objectKey: stagingKey, actorId: request.actorId.trim(), eventId: request.eventId.trim(), fileName, declaredSize: request.declaredSize, expiresAt };
  }

  private async sessionFor(uploadId: string, uploadToken: string, actorId: string): Promise<S3Session> {
    const persisted = this.persistence ? await this.persistence.get(uploadId) : undefined;
    const session = persisted ? { ...persisted, stagingKey: persisted.objectKey } : this.sessions.get(uploadId);
    if (!session) throw new BadRequestException('upload handle is invalid');
    const received = Buffer.from(tokenDigest(uploadToken), 'hex');
    const expected = Buffer.from(session.tokenHash, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected) || session.actorId !== actorId) throw new BadRequestException('upload handle is invalid');
    if (Date.parse(session.expiresAt) <= Date.now()) throw new BadRequestException('upload handle has expired');
    return session;
  }

  async put(uploadId: string, uploadToken: string, bytes: Uint8Array, actorId: string): Promise<UploadedObjectMetadata> {
    const session = await this.sessionFor(uploadId, uploadToken, actorId);
    if (session.completed) return { size: session.completed.size, sha256: session.completed.sha256 };
    if (session.uploaded) throw new BadRequestException('upload has already been received');
    if (!bytes.length || bytes.length !== session.declaredSize) throw new BadRequestException('uploaded size does not match the declared size');
    if (this.persistence) {
      const claim = await this.persistence.claim(uploadId);
      if (claim === 'MISSING') throw new BadRequestException('upload handle is invalid');
      if (claim === 'BUSY') throw new ConflictException('upload is currently being written');
      if (claim === 'DONE') {
        const current = await this.persistence.get(uploadId);
        if (current?.completed) return { size: current.completed.size, sha256: current.completed.sha256 };
        if (current?.uploaded) return current.uploaded;
        throw new ConflictException('upload has already been received');
      }
    } else {
      const current = this.sessions.get(uploadId);
      if (!current || current.status !== 'CREATED') throw new ConflictException('upload is currently being written');
      current.status = 'UPLOADING';
    }
    const content = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(content).digest('hex');
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: session.stagingKey, Body: content, ContentLength: content.length, Metadata: { sha256 } }));
      const uploaded = { size: content.length, sha256 };
      if (this.persistence) {
        await this.persistence.markUploaded(uploadId, uploaded);
      } else {
        session.status = 'UPLOADED';
        session.uploaded = uploaded;
      }
      return uploaded;
    } catch (error) {
      if (this.persistence) await this.persistence.release(uploadId);
      else session.status = 'CREATED';
      throw error;
    }
  }

  async confirm(uploadId: string, uploadToken: string, actorId: string, expected?: UploadedObjectMetadata): Promise<StoredArtifact> {
    const session = await this.sessionFor(uploadId, uploadToken, actorId);
    if (session.completed) {
      if (expected && (expected.size !== session.completed.size || expected.sha256 !== session.completed.sha256)) throw new BadRequestException('confirmed object metadata does not match');
      // The durable completion fact is committed before staging deletion. A
      // retry after a crash should still make a best-effort cleanup attempt;
      // DeleteObject is idempotent and the immutable result remains usable if
      // the object store is temporarily unavailable.
      try { await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: session.stagingKey })); } catch { /* cleanup can be retried by lifecycle policy */ }
      return session.completed;
    }
    if (!session.uploaded) throw new BadRequestException('upload has not been received');
    if (expected && (expected.size !== session.uploaded.size || expected.sha256 !== session.uploaded.sha256)) throw new BadRequestException('confirmed object metadata does not match');
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: session.stagingKey }));
    const remoteSha = head.Metadata?.sha256;
    if (head.ContentLength !== session.uploaded.size || remoteSha !== session.uploaded.sha256) throw new BadRequestException('staged object was modified');
    const finalKey = `${this.prefix}/objects/${session.uploaded.sha256}/${session.fileName}`;
    const completed = { uri: `s3://${this.options.bucket}/${finalKey}`, sha256: session.uploaded.sha256, size: session.uploaded.size };
    try {
      await this.client.send(new CopyObjectCommand({ Bucket: this.options.bucket, Key: finalKey, CopySource: `${this.options.bucket}/${session.stagingKey}`, MetadataDirective: 'COPY' }));
      // Commit the durable fact before deleting the staging object.  If the
      // API crashes after the copy, a retry can still observe COMPLETED and
      // return the immutable object instead of being stranded on a missing
      // staging key.
      if (this.persistence) {
        const persisted = await this.persistence.markCompleted(uploadId, completed);
        await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: session.stagingKey }));
        return persisted.completed ?? completed;
      }
      session.status = 'COMPLETED';
      session.completed = completed;
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: session.stagingKey }));
      return completed;
    } catch (error) {
      // Another API instance may have completed the same immutable object
      // between our HEAD and COPY.  Treat that race as an idempotent retry;
      // otherwise surface the storage failure to the caller.
      const persisted = this.persistence ? await this.persistence.get(uploadId) : undefined;
      if (persisted?.completed && persisted.completed.uri === completed.uri && persisted.completed.sha256 === completed.sha256 && persisted.completed.size === completed.size) {
        return persisted.completed;
      }
      throw error;
    }
  }

  async read(uri: string): Promise<Buffer> {
    const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (!match || match[1] !== this.options.bucket) throw new BadRequestException('artifactUri is not a permitted object URI');
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: match[2] }));
    if (!response.Body) throw new BadRequestException('object body is empty');
    if (Number.isSafeInteger(response.ContentLength) && response.ContentLength! > this.maxBytes) {
      throw new BadRequestException('object exceeds the configured artifact size limit');
    }
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    if (bytes.length > this.maxBytes) throw new BadRequestException('object exceeds the configured artifact size limit');
    return bytes;
  }

  async materialize(uri: string, fileName = 'artifact.bin'): Promise<MaterializedArtifact> {
    const directory = await mkdtemp(join(tmpdir(), 'ai-training-object-'));
    const path = join(directory, safeFileName(fileName));
    try {
      await writeFile(path, await this.read(uri), { flag: 'wx' });
      return {
        path,
        cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async contentHash(uri: string): Promise<string> {
    return createHash('sha256').update(await this.read(uri)).digest('hex');
  }

  private async withMaterializedArtifact<T>(uri: string, fileName: string, work: (path: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'ai-training-object-'));
    const path = join(directory, safeFileName(fileName));
    try {
      await writeFile(path, await this.read(uri), { flag: 'wx' });
      return await work(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async snapshotHash(uri: string): Promise<string> {
    const fileName = uri.split('/').pop() ?? 'artifact.bin';
    return this.withMaterializedArtifact(uri, fileName, snapshotHashFile);
  }

  async validateArchive(uri: string, maxFiles?: number, maxExpandedBytes?: number): Promise<void> {
    const fileName = uri.split('/').pop() ?? 'artifact.bin';
    await this.withMaterializedArtifact(uri, fileName, (path) => validateArchiveFile(path, maxFiles, maxExpandedBytes));
  }

  async inspectArchive(uri: string): Promise<ArtifactEntry[]> {
    const fileName = uri.split('/').pop() ?? 'artifact.bin';
    return this.withMaterializedArtifact(uri, fileName, inspectArchiveFile);
  }

  async discardExpired(now = new Date()): Promise<number> {
    if (this.persistence) {
      let removed = 0;
      for (const session of await this.persistence.listExpired(now)) {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: session.objectKey }));
        await this.persistence.remove(session.uploadId);
        removed += 1;
      }
      return removed;
    }
    let removed = 0;
    for (const [uploadId, session] of this.sessions) {
      if (session.completed || Date.parse(session.expiresAt) > now.getTime()) continue;
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: session.stagingKey }));
      this.sessions.delete(uploadId);
      removed += 1;
    }
    return removed;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for S3 object storage`);
  return value;
}

/** Select the object storage adapter exactly once at application startup. */
export function createObjectStorage(artifacts: ArtifactStore, uploadSessions?: UploadSessionPersistence): ObjectStorage {
  const configured = process.env.OBJECT_STORAGE_MODE?.trim().toLowerCase();
  const mode = configured || (process.env.NODE_ENV === 'production' ? 's3' : 'local');
  if (mode === 'local') {
    if (process.env.NODE_ENV === 'production') throw new Error('local object storage is not allowed in production');
    return new LocalObjectStorage(artifacts);
  }
  if (mode !== 's3') throw new Error(`unsupported OBJECT_STORAGE_MODE: ${mode}`);
  const bucket = requiredEnv('OBJECT_STORAGE_BUCKET');
  const durableSessions = uploadSessions?.enabled === false ? undefined : uploadSessions;
  if (process.env.NODE_ENV === 'production' && !durableSessions) throw new Error('durable upload-session persistence is required for S3 object storage in production');
  const region = process.env.OBJECT_STORAGE_REGION?.trim() || 'us-east-1';
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim() || undefined;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() || undefined;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() || undefined;
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) throw new Error('S3 access key and secret must be configured together');
  const client = new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false' } : {}), ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}) });
  return new S3ObjectStorage(client, { bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle: endpoint ? process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false' : undefined, prefix: process.env.OBJECT_STORAGE_PREFIX }, durableSessions);
}
