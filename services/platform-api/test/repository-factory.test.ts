import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformStore } from '../src/store';
import { FileUserDirectoryRepository, PrismaUserDirectoryRepository, createUserDirectoryRepository } from '../src/user-directory';
import { createPlatformStore } from '../src/postgres-platform-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const original = {
  mode: process.env.PLATFORM_REPOSITORY,
  databaseUrl: process.env.DATABASE_URL,
  nodeEnv: process.env.NODE_ENV,
  deploymentProfile: process.env.PLATFORM_DEPLOYMENT_PROFILE,
  dataFile: process.env.PLATFORM_DATA_FILE,
  bootstrapAdmin: process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO,
};

function restoreEnvironment(): void {
  if (original.mode === undefined) delete process.env.PLATFORM_REPOSITORY;
  else process.env.PLATFORM_REPOSITORY = original.mode;
  if (original.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original.databaseUrl;
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.nodeEnv;
  if (original.deploymentProfile === undefined) delete process.env.PLATFORM_DEPLOYMENT_PROFILE;
  else process.env.PLATFORM_DEPLOYMENT_PROFILE = original.deploymentProfile;
  if (original.dataFile === undefined) delete process.env.PLATFORM_DATA_FILE;
  else process.env.PLATFORM_DATA_FILE = original.dataFile;
  if (original.bootstrapAdmin === undefined) delete process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO;
  else process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO = original.bootstrapAdmin;
}

test.afterEach(restoreEnvironment);

test('repository factory defaults to the local adapter for development', () => {
  delete process.env.PLATFORM_REPOSITORY;
  process.env.NODE_ENV = 'test';
  const repository = createUserDirectoryRepository(new PlatformStore(':memory:'));
  assert.ok(repository instanceof FileUserDirectoryRepository);
});

test('repository factory rejects unknown adapters instead of silently falling back', () => {
  process.env.PLATFORM_REPOSITORY = 'redis';
  assert.throws(() => createUserDirectoryRepository(new PlatformStore(':memory:')), /unsupported PLATFORM_REPOSITORY/);
});

test('postgres adapter requires an explicit database URL', () => {
  process.env.PLATFORM_REPOSITORY = 'postgres';
  delete process.env.DATABASE_URL;
  assert.throws(() => createUserDirectoryRepository(new PlatformStore(':memory:')), /DATABASE_URL is required/);
});

test('production cannot use the file adapter', () => {
  process.env.PLATFORM_REPOSITORY = 'file';
  process.env.NODE_ENV = 'production';
  assert.throws(() => createUserDirectoryRepository(new PlatformStore(':memory:')), /file repository is not allowed in production/);
});

test('single-node production requires PostgreSQL instead of a durable file repository', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'single-node-store-'));
  process.env.PLATFORM_REPOSITORY = 'file';
  process.env.PLATFORM_DATA_FILE = join(directory, 'platform-data.json');
  process.env.PLATFORM_DEPLOYMENT_PROFILE = 'single-node';
  process.env.NODE_ENV = 'production';
  process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO = 'first-admin';

  try {
    await assert.rejects(createPlatformStore(), /single-node production requires PLATFORM_REPOSITORY=postgres/);
    assert.throws(
      () => createUserDirectoryRepository(new PlatformStore(':memory:')),
      /single-node production requires PLATFORM_REPOSITORY=postgres/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('postgres adapter is constructed only after explicit configuration', () => {
  process.env.PLATFORM_REPOSITORY = 'postgres';
  process.env.DATABASE_URL = 'postgresql://localhost:5432/ai_training_platform';
  const repository = createUserDirectoryRepository(new PlatformStore(':memory:'));
  assert.ok(repository instanceof PrismaUserDirectoryRepository);
});
