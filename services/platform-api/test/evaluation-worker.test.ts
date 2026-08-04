import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(__dirname, '..', '..', '..');

test('Worker materialises a frozen batch, invokes the Code Agent bridge and imports the result', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'evaluation-worker-e2e-'));
  const previous = {
    data: process.env.PLATFORM_DATA_FILE,
    anonymous: process.env.ALLOW_ANONYMOUS_LOCAL,
    embedded: process.env.EMBEDDED_EVALUATION_WORKER,
    project: process.env.PROJECT_ROOT,
    artifacts: process.env.ARTIFACT_ROOT,
    logs: process.env.EVALUATION_LOG_ROOT,
  };
  process.env.PLATFORM_DATA_FILE = ':memory:';
  process.env.ALLOW_ANONYMOUS_LOCAL = 'false';
  process.env.EMBEDDED_EVALUATION_WORKER = 'false';
  process.env.PROJECT_ROOT = projectRoot;
  process.env.ARTIFACT_ROOT = join(sandbox, 'artifacts');
  process.env.EVALUATION_LOG_ROOT = join(sandbox, 'logs');
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const baseUrl = await app.getUrl();
    const admin = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
    const quoteCommandArgument = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
    const configured = await fetch(`${baseUrl}/api/v1/admin/code-agent-runtime`, {
      method: 'PUT', headers: admin,
      body: JSON.stringify({
        enabled: true,
        commandLine: `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(join(projectRoot, 'scripts', 'code-agent-local-bridge.mjs'))} --manifest "{{manifestPath}}"`,
        prompt: '',
        timeoutSeconds: 3600,
      }),
    });
    assert.equal(configured.status, 200);
    const submit = async (subjectId: string, minute: number): Promise<{ id: string }> => {
      const response = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({
          subjectId,
          snapshot: { sourceType: 'UPLOAD', workspacePath: 'challenges/parking-fee-v1/reference', submittedAt: `2026-08-01T10:${String(minute).padStart(2, '0')}:00Z` },
        }),
      });
      assert.equal(response.status, 201);
      return response.json() as Promise<{ id: string }>;
    };
    const selected = [await submit('w00124', 0), await submit('w00125', 1)];
    const excluded = await submit('w00126', 2);
    const started = await fetch(`${baseUrl}/api/v1/events/event-local/start-grading`, {
      method: 'POST', headers: admin, body: JSON.stringify({ submissionIds: selected.map((item) => item.id) }),
    });
    assert.equal(started.status, 201);

    const worker = await execFileAsync(process.execPath, [
      join(projectRoot, 'scripts', 'evaluation-worker.mjs'),
      '--api', `${baseUrl}/api/v1`,
      '--employee', 'w00123',
      '--worker', 'worker-e2e',
      '--once',
      '--batch-root', join(sandbox, 'batches'),
      '--cache', join(sandbox, 'engine-cache'),
    ], { cwd: projectRoot, timeout: 45_000, windowsHide: true, env: { ...process.env } });
    assert.match(worker.stdout, /完成批次/);
    assert.match(worker.stdout, /成功 2/);
    const workerLogPath = join(sandbox, 'logs', 'worker-e2e', 'worker.log');
    assert.equal(existsSync(workerLogPath), true);
    const workerLog = readFileSync(workerLogPath, 'utf8');
    assert.match(workerLog, /"event":"worker.start"/);
    assert.match(workerLog, /"event":"batch.completed"/);
    const findFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? findFiles(path) : statSync(path).isFile() ? [path] : [];
    });
    const logFiles = findFiles(join(sandbox, 'logs'));
    const interactionPath = logFiles.find((path) => path.endsWith('interaction.jsonl'));
    assert.ok(interactionPath);
    const interaction = readFileSync(interactionPath, 'utf8');
    assert.match(interaction, /"event":"batch.start"/);
    assert.match(interaction, /"event":"agent.start"/);
    assert.equal(logFiles.some((path) => path.endsWith('agent.stdout.log')), true);
    assert.equal(logFiles.some((path) => path.endsWith('agent.stderr.log')), true);

    for (const [index, submission] of selected.entries()) {
      const loaded = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}`, { headers: { 'x-employee-id': `w0012${index + 4}` } });
      assert.equal(loaded.status, 200);
      const body = await loaded.json() as { gradingStatus?: string; resultId?: string; failureReason?: string };
      assert.equal(body.gradingStatus, 'COMPLETED', JSON.stringify({ body, stdout: worker.stdout, stderr: worker.stderr }));
      assert.ok(body.resultId);
    }
    const untouched = await fetch(`${baseUrl}/api/v1/submissions/${excluded.id}`, { headers: { 'x-employee-id': 'w00126' } });
    const untouchedBody = await untouched.json() as { gradingStatus?: string; resultId?: string };
    assert.equal(untouchedBody.gradingStatus, 'PENDING');
    assert.equal(untouchedBody.resultId, undefined);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries({
      PLATFORM_DATA_FILE: previous.data,
      ALLOW_ANONYMOUS_LOCAL: previous.anonymous,
      EMBEDDED_EVALUATION_WORKER: previous.embedded,
      PROJECT_ROOT: previous.project,
      ARTIFACT_ROOT: previous.artifacts,
      EVALUATION_LOG_ROOT: previous.logs,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});
