import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformStore } from '../src/store';
import { FileUserDirectoryRepository, PrismaUserDirectoryRepository, createUserDirectoryRepository } from '../src/user-directory';

const original = {
  mode: process.env.PLATFORM_REPOSITORY,
  databaseUrl: process.env.DATABASE_URL,
  nodeEnv: process.env.NODE_ENV,
};

function restoreEnvironment(): void {
  if (original.mode === undefined) delete process.env.PLATFORM_REPOSITORY;
  else process.env.PLATFORM_REPOSITORY = original.mode;
  if (original.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original.databaseUrl;
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.nodeEnv;
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

test('postgres adapter is constructed only after explicit configuration', () => {
  process.env.PLATFORM_REPOSITORY = 'postgres';
  process.env.DATABASE_URL = 'postgresql://localhost:5432/ai_training_platform';
  const repository = createUserDirectoryRepository(new PlatformStore(':memory:'));
  assert.ok(repository instanceof PrismaUserDirectoryRepository);
});
