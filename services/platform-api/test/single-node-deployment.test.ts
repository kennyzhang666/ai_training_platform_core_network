import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformStore } from '../src/store';
import { PrismaUserDirectoryRepository, createUserDirectoryRepository } from '../src/user-directory';
import { ArtifactStore } from '../src/artifact-store';
import { createObjectStorage, LocalObjectStorage, PersistedUploadSession, UploadSessionPersistence } from '../src/object-storage';

test('single-node production combines PostgreSQL metadata with durable local artifacts', () => {
  const keys = [
    'NODE_ENV', 'PLATFORM_DEPLOYMENT_PROFILE', 'PLATFORM_REPOSITORY', 'DATABASE_URL', 'OBJECT_STORAGE_MODE',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'production',
    PLATFORM_DEPLOYMENT_PROFILE: 'single-node',
    PLATFORM_REPOSITORY: 'postgres',
    DATABASE_URL: 'postgresql://platform@127.0.0.1:5432/ai_training_platform',
    OBJECT_STORAGE_MODE: 'local',
  });
  const sessions = new Map<string, PersistedUploadSession>();
  const persistence: UploadSessionPersistence = {
    enabled: true,
    async create(session) { sessions.set(session.uploadId, structuredClone(session)); },
    async get(uploadId) { return sessions.get(uploadId); },
    async claim() { return 'CLAIMED'; },
    async release() {},
    async markUploaded(uploadId) { return sessions.get(uploadId)!; },
    async markCompleted(uploadId) { return sessions.get(uploadId)!; },
    async listExpired() { return []; },
    async remove(uploadId) { sessions.delete(uploadId); },
  };

  try {
    assert.ok(createUserDirectoryRepository(new PlatformStore(':memory:')) instanceof PrismaUserDirectoryRepository);
    assert.throws(() => createObjectStorage(new ArtifactStore()), /durable upload-session persistence is required/);
    assert.ok(createObjectStorage(new ArtifactStore(), persistence) instanceof LocalObjectStorage);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
