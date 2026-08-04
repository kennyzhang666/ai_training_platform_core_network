import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../src/artifact-store';
import { createObjectStorage, LocalObjectStorage, PersistedUploadSession, S3ObjectStorage, UploadSessionPersistence } from '../src/object-storage';

test('local object storage binds handles to actor, verifies checksum, and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'object-store-'));
  const previousRoot = process.env.ARTIFACT_ROOT;
  const previousTmp = process.env.ARTIFACT_UPLOAD_TMP_ROOT;
  process.env.ARTIFACT_ROOT = join(root, 'objects');
  process.env.ARTIFACT_UPLOAD_TMP_ROOT = join(root, 'staging');
  try {
    const storage = new LocalObjectStorage(new ArtifactStore());
    const content = Buffer.from('immutable upload');
    const session = await storage.createUpload({ actorId: 'worker-a', eventId: 'event-a', fileName: '../delivery.zip', declaredSize: content.length, maxBytes: 1024 });
    await assert.rejects(storage.put(session.uploadId, session.uploadToken, content, 'worker-b'), /invalid/);
    const metadata = await storage.put(session.uploadId, session.uploadToken, content, 'worker-a');
    assert.equal(metadata.size, content.length);
    const stored = await storage.confirm(session.uploadId, session.uploadToken, 'worker-a', metadata);
    assert.deepEqual(await storage.read(stored.uri), content);
    const materialized = await storage.materialize(stored.uri, 'delivery.bin');
    assert.equal(existsSync(materialized.path), true);
    assert.deepEqual(readFileSync(materialized.path), content);
    await materialized.cleanup();
    assert.equal(existsSync(materialized.path), true, 'local materialization is owned by ArtifactStore and remains immutable');
    assert.deepEqual(await storage.confirm(session.uploadId, session.uploadToken, 'worker-a', metadata), stored);
    await assert.rejects(storage.confirm(session.uploadId, session.uploadToken, 'worker-a', { ...metadata, sha256: '0'.repeat(64) }), /does not match/);
  } finally {
    if (previousRoot === undefined) delete process.env.ARTIFACT_ROOT; else process.env.ARTIFACT_ROOT = previousRoot;
    if (previousTmp === undefined) delete process.env.ARTIFACT_UPLOAD_TMP_ROOT; else process.env.ARTIFACT_UPLOAD_TMP_ROOT = previousTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

test('local object storage rejects oversized and expired handles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'object-store-expiry-'));
  const previousRoot = process.env.ARTIFACT_ROOT;
  const previousTmp = process.env.ARTIFACT_UPLOAD_TMP_ROOT;
  process.env.ARTIFACT_ROOT = join(root, 'objects');
  process.env.ARTIFACT_UPLOAD_TMP_ROOT = join(root, 'staging');
  try {
    const storage = new LocalObjectStorage(new ArtifactStore());
    await assert.rejects(storage.createUpload({ actorId: 'worker-a', eventId: 'event-a', fileName: 'delivery.zip', declaredSize: 10, maxBytes: 5 }), /exceeds/);
    const session = await storage.createUpload({ actorId: 'worker-a', eventId: 'event-a', fileName: 'delivery.zip', declaredSize: 1, maxBytes: 5, expiresInSeconds: 30 });
    const state = (storage as unknown as { sessions: Map<string, { expiresAt: string }> }).sessions.get(session.uploadId)!;
    state.expiresAt = new Date(Date.now() - 1_000).toISOString();
    await assert.rejects(storage.put(session.uploadId, session.uploadToken, Buffer.from('x'), 'worker-a'), /expired/);
    assert.equal(await storage.discardExpired(), 1);
  } finally {
    if (previousRoot === undefined) delete process.env.ARTIFACT_ROOT; else process.env.ARTIFACT_ROOT = previousRoot;
    if (previousTmp === undefined) delete process.env.ARTIFACT_UPLOAD_TMP_ROOT; else process.env.ARTIFACT_UPLOAD_TMP_ROOT = previousTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S3 object storage materializes only after immutable confirmation', async () => {
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  const fakeClient = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
      const name = command.constructor.name;
      const input = command.input;
      if (name === 'PutObjectCommand') {
        objects.set(input.Key, { bytes: Buffer.from(input.Body), metadata: input.Metadata ?? {} });
        return {};
      }
      if (name === 'HeadObjectCommand') {
        const object = objects.get(input.Key);
        if (!object) throw new Error('missing object');
        return { ContentLength: object.bytes.length, Metadata: object.metadata };
      }
      if (name === 'CopyObjectCommand') {
        const source = String(input.CopySource).split('/').slice(1).join('/');
        const object = objects.get(source);
        if (!object) throw new Error('missing source');
        objects.set(input.Key, { bytes: Buffer.from(object.bytes), metadata: { ...object.metadata } });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(input.Key);
        return {};
      }
      if (name === 'GetObjectCommand') {
        const object = objects.get(input.Key);
        if (!object) throw new Error('missing object');
        return { Body: { transformToByteArray: async () => Uint8Array.from(object.bytes) } };
      }
      throw new Error(`unexpected command: ${name}`);
    },
  };
  const storage = new S3ObjectStorage(fakeClient as never, { bucket: 'bucket', region: 'test', prefix: 'platform' });
  const content = Buffer.from('s3 immutable upload');
  const session = await storage.createUpload({ actorId: 'worker-a', eventId: 'event-a', fileName: 'delivery.zip', declaredSize: content.length, maxBytes: 1024 });
  const metadata = await storage.put(session.uploadId, session.uploadToken, content, 'worker-a');
  const stored = await storage.confirm(session.uploadId, session.uploadToken, 'worker-a', metadata);
  assert.equal(stored.uri.startsWith('s3://bucket/platform/objects/'), true);
  const materialized = await storage.materialize(stored.uri, 'delivery.zip');
  assert.deepEqual(readFileSync(materialized.path), content);
  await materialized.cleanup();
  assert.equal(existsSync(materialized.path), false);
});

test('S3 upload sessions survive an API instance restart when backed by durable persistence', async () => {
  const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  const sessions = new Map<string, PersistedUploadSession>();
  const persistence: UploadSessionPersistence = {
    async create(session) { sessions.set(session.uploadId, structuredClone(session)); },
    async get(uploadId) { const session = sessions.get(uploadId); return session ? structuredClone(session) : undefined; },
    async claim(uploadId) {
      const session = sessions.get(uploadId);
      if (!session) return 'MISSING';
      if (session.status === 'CREATED') { session.status = 'UPLOADING'; return 'CLAIMED'; }
      if (session.status === 'UPLOADING') return 'BUSY';
      return 'DONE';
    },
    async release(uploadId) { const session = sessions.get(uploadId); if (session?.status === 'UPLOADING') session.status = 'CREATED'; },
    async markUploaded(uploadId, metadata) { const session = sessions.get(uploadId)!; session.status = 'UPLOADED'; session.uploaded = metadata; return structuredClone(session); },
    async markCompleted(uploadId, completed) { const session = sessions.get(uploadId)!; session.status = 'COMPLETED'; session.completed = completed; return structuredClone(session); },
    async listExpired(now) { return [...sessions.values()].filter((session) => session.status !== 'COMPLETED' && Date.parse(session.expiresAt) <= now.getTime()).map((session) => structuredClone(session)); },
    async remove(uploadId) { sessions.delete(uploadId); },
  };
  const fakeClient = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }): Promise<any> {
      const name = command.constructor.name;
      const input = command.input;
      if (name === 'PutObjectCommand') {
        objects.set(input.Key, { bytes: Buffer.from(input.Body), metadata: input.Metadata ?? {} });
        return {};
      }
      if (name === 'HeadObjectCommand') {
        const object = objects.get(input.Key);
        if (!object) throw new Error('missing object');
        return { ContentLength: object.bytes.length, Metadata: object.metadata };
      }
      if (name === 'CopyObjectCommand') {
        const source = String(input.CopySource).split('/').slice(1).join('/');
        const object = objects.get(source);
        if (!object) throw new Error('missing source');
        objects.set(input.Key, { bytes: Buffer.from(object.bytes), metadata: { ...object.metadata } });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(input.Key);
        return {};
      }
      if (name === 'GetObjectCommand') {
        const object = objects.get(input.Key);
        if (!object) throw new Error('missing object');
        return { ContentLength: object.bytes.length, Body: { transformToByteArray: async () => Uint8Array.from(object.bytes) } };
      }
      throw new Error(`unexpected command: ${name}`);
    },
  };
  const options = { bucket: 'bucket', region: 'test', prefix: 'platform' } as const;
  const firstInstance = new S3ObjectStorage(fakeClient as never, options, persistence);
  const content = Buffer.from('durable upload');
  const session = await firstInstance.createUpload({ actorId: 'worker-a', eventId: 'event-a', fileName: 'delivery.zip', declaredSize: content.length, maxBytes: 1024 });
  const restartedInstance = new S3ObjectStorage(fakeClient as never, options, persistence);
  await assert.rejects(restartedInstance.put(session.uploadId, session.uploadToken, content, 'worker-b'), /invalid/);
  const metadata = await restartedInstance.put(session.uploadId, session.uploadToken, content, 'worker-a');
  const stored = await restartedInstance.confirm(session.uploadId, session.uploadToken, 'worker-a', metadata);
  assert.equal(sessions.get(session.uploadId)?.status, 'COMPLETED');
  assert.deepEqual(await firstInstance.read(stored.uri), content);
  assert.deepEqual(await restartedInstance.confirm(session.uploadId, session.uploadToken, 'worker-a', metadata), stored);
  assert.equal([...objects.keys()].some((key) => key.endsWith('.part')), false, 'repeated confirmation retries staging cleanup');
});

test('object storage selection rejects local production and incomplete S3 configuration', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMode = process.env.OBJECT_STORAGE_MODE;
  const previousBucket = process.env.OBJECT_STORAGE_BUCKET;
  const previousRepository = process.env.PLATFORM_REPOSITORY;
  const previousAccessKey = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const previousSecret = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  try {
    process.env.NODE_ENV = 'production';
    process.env.OBJECT_STORAGE_MODE = 'local';
    assert.throws(() => createObjectStorage(new ArtifactStore()), /not allowed in production/);

    process.env.OBJECT_STORAGE_MODE = 's3';
    delete process.env.OBJECT_STORAGE_BUCKET;
    assert.throws(() => createObjectStorage(new ArtifactStore()), /OBJECT_STORAGE_BUCKET is required/);

    process.env.OBJECT_STORAGE_BUCKET = 'bucket';
    assert.throws(() => createObjectStorage(new ArtifactStore()), /durable upload-session persistence is required/);

    process.env.NODE_ENV = 'test';
    process.env.PLATFORM_REPOSITORY = 'file';
    const localS3 = createObjectStorage(new ArtifactStore(), { enabled: false } as UploadSessionPersistence);
    assert.ok(localS3 instanceof S3ObjectStorage);
    assert.equal((localS3 as unknown as { persistence?: unknown }).persistence, undefined);
    process.env.OBJECT_STORAGE_MODE = 'local';
    assert.ok(createObjectStorage(new ArtifactStore()) instanceof LocalObjectStorage);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousMode === undefined) delete process.env.OBJECT_STORAGE_MODE; else process.env.OBJECT_STORAGE_MODE = previousMode;
    if (previousBucket === undefined) delete process.env.OBJECT_STORAGE_BUCKET; else process.env.OBJECT_STORAGE_BUCKET = previousBucket;
    if (previousRepository === undefined) delete process.env.PLATFORM_REPOSITORY; else process.env.PLATFORM_REPOSITORY = previousRepository;
    if (previousAccessKey === undefined) delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID; else process.env.OBJECT_STORAGE_ACCESS_KEY_ID = previousAccessKey;
    if (previousSecret === undefined) delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY; else process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = previousSecret;
  }
});
