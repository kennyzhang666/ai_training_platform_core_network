import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { createFetchSafeApplication } from './test-server';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(__dirname, '..', '..', '..');

test('trusted-gateway Worker requires the existing employee display name', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      join(projectRoot, 'scripts', 'evaluation-worker.mjs'),
      '--api', 'http://127.0.0.1:1/api/v1',
      '--once',
    ], {
      cwd: projectRoot,
      timeout: 5_000,
      windowsHide: true,
      env: {
        ...process.env,
        EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET: 'worker-test-secret',
        EVALUATION_WORKER_NAME: '',
      },
    }),
    (error: unknown) => {
      const details = error && typeof error === 'object'
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : String(error);
      assert.match(details, /EVALUATION_WORKER_NAME/);
      return true;
    },
  );
});

test('Worker rejects invalid polling configuration before contacting the platform', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      join(projectRoot, 'scripts', 'evaluation-worker.mjs'),
      '--interval', 'not-a-number',
      '--once',
    ], { cwd: projectRoot, timeout: 5_000, windowsHide: true }),
    (error: unknown) => {
      const details = error && typeof error === 'object'
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : String(error);
      assert.match(details, /--interval/);
      return true;
    },
  );
});

test('Worker materialises a frozen batch, invokes the Code Agent bridge and imports the result', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'evaluation-worker-e2e-'));
  const previous = {
    data: process.env.PLATFORM_DATA_FILE,
    anonymous: process.env.ALLOW_ANONYMOUS_LOCAL,
    embedded: process.env.EMBEDDED_EVALUATION_WORKER,
    project: process.env.PROJECT_ROOT,
    artifacts: process.env.ARTIFACT_ROOT,
    logs: process.env.EVALUATION_LOG_ROOT,
    enginePackages: process.env.ENGINE_PACKAGE_ROOT,
  };
  process.env.PLATFORM_DATA_FILE = ':memory:';
  process.env.ALLOW_ANONYMOUS_LOCAL = 'false';
  process.env.EMBEDDED_EVALUATION_WORKER = 'false';
  process.env.PROJECT_ROOT = projectRoot;
  process.env.ARTIFACT_ROOT = join(sandbox, 'artifacts');
  process.env.EVALUATION_LOG_ROOT = join(sandbox, 'logs');
  process.env.ENGINE_PACKAGE_ROOT = join(sandbox, 'packages');
  const { app, baseUrl } = await createFetchSafeApplication(
    () => NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false }),
  );
  try {
    const admin = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
    const quoteCommandArgument = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
    const bridgeMarker = join(sandbox, 'packaged-engine-python.txt');
    const bridgeWrapper = join(sandbox, 'assert-engine-python.mjs');
    writeFileSync(bridgeWrapper, [
      "import { spawnSync } from 'node:child_process';",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      'const args = process.argv.slice(2);',
      "const promptIndex = args.indexOf('--prompt');",
      "const prompt = promptIndex >= 0 ? args[promptIndex + 1] : '';",
      "if (!prompt.includes('challenge') || !prompt.includes('instructionPath') || !prompt.includes('skillPaths')) throw new Error('Worker 未按赛题自动组合 Prompt');",
      "const manifestPath = resolve(process.env.AI_TRAINING_BATCH_MANIFEST ?? '');",
      "const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));",
      "if (manifest.engine.id === 'parking-fee-packaged') {",
      "  const interpreter = process.env.AI_TRAINING_ENGINE_PYTHON ?? '';",
      "  if (!interpreter || !existsSync(interpreter)) throw new Error('Worker 未准备评测引擎 Python 环境');",
      `  writeFileSync(${JSON.stringify(bridgeMarker)}, interpreter, 'utf8');`,
      '}',
      `const child = spawnSync(process.execPath, [${JSON.stringify(join(projectRoot, 'scripts', 'code-agent-local-bridge.mjs'))}, '--manifest', manifestPath], { stdio: 'inherit', env: process.env });`,
      'process.exit(child.status ?? 1);',
    ].join('\n'), 'utf8');
    const configured = await fetch(`${baseUrl}/api/v1/admin/code-agent-runtime`, {
      method: 'PUT', headers: admin,
      body: JSON.stringify({
        enabled: true,
        commandLine: `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(bridgeWrapper)} --prompt "{{prompt}}"`,
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
    const selectedSubjects = Array.from({ length: 20 }, (_, index) => `worker-learner-${String(index + 1).padStart(2, '0')}`);
    await Promise.all(selectedSubjects.map(async (employeeNo, index) => {
      const response = await fetch(`${baseUrl}/api/v1/auth/sso`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({ employeeNo, name: `Worker 学员 ${index + 1}`, department: 'AI 工程团队' }),
      });
      assert.equal(response.status, 201);
    }));
    const selected = await Promise.all(selectedSubjects.map((subjectId, index) => submit(subjectId, index)));
    const excluded = await submit('w00126', 2);
    const started = await fetch(`${baseUrl}/api/v1/events/event-local/start-grading`, {
      method: 'POST', headers: admin, body: JSON.stringify({ submissionIds: selected.map((item) => item.id) }),
    });
    assert.equal(started.status, 201);

    const archive = join(sandbox, 'parking-engine.zip');
    await execFileAsync(process.execPath, [join(projectRoot, 'scripts', 'build-engine-package.mjs'), 'parking-fee-v1', '--out', archive], { cwd: projectRoot, windowsHide: true });
    const uploadedEngine = await fetch(`${baseUrl}/api/v1/evaluation-engines`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({ packageBase64: readFileSync(archive).toString('base64'), fileName: 'parking-engine.zip' }),
    });
    assert.equal(uploadedEngine.status, 201);
    const engine = await uploadedEngine.json() as { packageHash: string; engine: { id: string; version: string } };
    const createdChallenge = await fetch(`${baseUrl}/api/v1/challenges`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({
        id: 'worker-packaged', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'PUBLISHED', versions: [{
          id: 'worker-packaged@1', challengeId: 'worker-packaged', version: 1, title: 'Worker 打包引擎验证', zone: 'YELLOW',
          languagePolicy: { mode: 'fixed', languages: ['python'] },
          deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
          rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'PUBLISHED',
          evaluationEngine: {
            id: engine.engine.id, version: engine.engine.version, mode: 'PACKAGED', package: { packageHash: engine.packageHash },
            input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/engine-invocation.schema.json' },
            output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
          },
        }],
      }),
    });
    assert.equal(createdChallenge.status, 201);
    assert.equal((await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({ id: 'event-worker-packaged', challengeVersion: 'worker-packaged@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE' }),
    })).status, 201);
    const packagedSubmit = await fetch(`${baseUrl}/api/v1/events/event-worker-packaged/submissions:upload`, {
      method: 'POST', headers: admin,
      body: JSON.stringify({ subjectId: 'w00126', snapshot: { sourceType: 'UPLOAD', workspacePath: 'challenges/parking-fee-v1/reference', submittedAt: '2026-08-01T10:03:00Z' } }),
    });
    assert.equal(packagedSubmit.status, 201);
    const packagedSubmission = await packagedSubmit.json() as { id: string };
    assert.equal((await fetch(`${baseUrl}/api/v1/submissions/${packagedSubmission.id}/start-grading`, {
      method: 'POST', headers: admin, body: '{}',
    })).status, 201);

    const engineCache = join(sandbox, 'engine-cache');
    const worker = await execFileAsync(process.execPath, [
      join(projectRoot, 'scripts', 'evaluation-worker.mjs'),
      '--api', `${baseUrl}/api/v1`,
      '--employee', 'w00123',
      '--worker', 'worker-e2e',
      '--once',
      '--batch-root', join(sandbox, 'batches'),
      '--cache', engineCache,
      '--batches', '2',
    ], { cwd: projectRoot, timeout: 60_000, windowsHide: true, env: { ...process.env, ENGINE_PIP_OFFLINE: 'true' } });
    assert.match(worker.stdout, /完成批次/);
    assert.match(worker.stdout, /成功 20/);
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

    for (const submission of selected) {
      const loaded = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}`, { headers: admin });
      assert.equal(loaded.status, 200);
      const body = await loaded.json() as { gradingStatus?: string; resultId?: string; failureReason?: string };
      assert.equal(body.gradingStatus, 'COMPLETED', JSON.stringify({ body, stdout: worker.stdout, stderr: worker.stderr }));
      assert.ok(body.resultId);
    }
    const profiledReport = await fetch(`${baseUrl}/api/v1/reports/${selected[0].id}`, { headers: admin });
    assert.equal(profiledReport.status, 200);
    assert.match(JSON.stringify(await profiledReport.json()), /0、1、-1、2/);
    const untouched = await fetch(`${baseUrl}/api/v1/submissions/${excluded.id}`, { headers: { 'x-employee-id': 'w00126' } });
    const untouchedBody = await untouched.json() as { gradingStatus?: string; resultId?: string };
    assert.equal(untouchedBody.gradingStatus, 'PENDING');
    assert.equal(untouchedBody.resultId, undefined);
    const packaged = await fetch(`${baseUrl}/api/v1/submissions/${packagedSubmission.id}`, { headers: { 'x-employee-id': 'w00126' } });
    const packagedBody = await packaged.json() as { gradingStatus?: string; resultId?: string; failureReason?: string };
    assert.equal(packagedBody.gradingStatus, 'COMPLETED', JSON.stringify({ packagedBody, stdout: worker.stdout, stderr: worker.stderr }));
    assert.ok(packagedBody.resultId);
    const preparedPython = readFileSync(bridgeMarker, 'utf8');
    assert.equal(preparedPython.startsWith(join(engineCache, '.environments-v1', engine.packageHash)), true);
    assert.equal(existsSync(preparedPython), true);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries({
      PLATFORM_DATA_FILE: previous.data,
      ALLOW_ANONYMOUS_LOCAL: previous.anonymous,
      EMBEDDED_EVALUATION_WORKER: previous.embedded,
      PROJECT_ROOT: previous.project,
      ARTIFACT_ROOT: previous.artifacts,
      EVALUATION_LOG_ROOT: previous.logs,
      ENGINE_PACKAGE_ROOT: previous.enginePackages,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});
