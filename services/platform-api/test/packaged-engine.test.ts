import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../src/artifact-store';
import { EnginePackageStore } from '../src/engine-package-store';
import { PackagedEngineExecutor } from '../src/packaged-engine-executor';
import { PlatformStore } from '../src/store';
import { checkEvaluationScore } from '../src/score-validator';
import { validateEvaluationResult } from '../src/contract-validator';

const projectRoot = resolve(__dirname, '..', '..', '..');

function buildPackage(target: string): Buffer {
  execFileSync('node', [join(projectRoot, 'scripts', 'build-engine-package.mjs'), 'parking-fee-v1', '--out', target], {
    cwd: projectRoot, encoding: 'utf8', windowsHide: true,
  });
  return readFileSync(target);
}

async function withEngineRoots(run: (packages: EnginePackageStore) => Promise<void>): Promise<void> {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'ai-training-engine-'));
  const previous = { root: process.env.ENGINE_PACKAGE_ROOT, project: process.env.PROJECT_ROOT, workspace: process.env.LOCAL_WORKSPACE_ROOT };
  process.env.ENGINE_PACKAGE_ROOT = join(sandboxRoot, 'packages');
  process.env.PROJECT_ROOT = projectRoot;
  process.env.LOCAL_WORKSPACE_ROOT = projectRoot;
  try {
    await run(new EnginePackageStore());
  } finally {
    for (const [key, value] of [['ENGINE_PACKAGE_ROOT', previous.root], ['PROJECT_ROOT', previous.project], ['LOCAL_WORKSPACE_ROOT', previous.workspace]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

test('an uploaded engine package is validated, content addressed and self describing', async () => {
  await withEngineRoots(async (packages) => {
    const archive = join(tmpdir(), `engine-${process.pid}.zip`);
    try {
      const bytes = buildPackage(archive);
      const record = await packages.save(bytes, 'parking-fee-engine.zip');
      assert.match(record.packageHash, /^[a-f0-9]{64}$/);
      assert.equal(record.manifest.id, 'parking-fee-packaged');
      assert.equal(record.manifest.runtime.entrypoint, 'judge.py');
      // Hidden tests and the submission contract travel inside the package.
      assert.ok(existsSync(join(packages.packageRoot(record.packageHash), 'assets', 'hidden-tests', 'basic.json')));
      assert.ok(existsSync(join(packages.packageRoot(record.packageHash), 'assets', 'submission-contract.json')));
      // Identical bytes are the same package; upload is idempotent.
      assert.equal((await packages.save(bytes, 'again.zip')).packageHash, record.packageHash);
      // Paths cannot escape the package.
      assert.throws(() => packages.resolveInsidePackage(record.packageHash, '../../etc/passwd'), /逃出引擎包/);
    } finally {
      rmSync(archive, { force: true });
    }
  });
});

test('a package without engine.json is rejected at upload time', async () => {
  await withEngineRoots(async (packages) => {
    const python = process.env.PYTHON ?? (existsSync(join(projectRoot, '.venv', 'Scripts', 'python.exe')) ? join(projectRoot, '.venv', 'Scripts', 'python.exe') : 'python');
    const archive = join(tmpdir(), `broken-engine-${process.pid}.zip`);
    execFileSync(python, ['-c', [
      'import pathlib, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr("judge.py", "print(1)")',
    ].join('\n'), archive], { cwd: projectRoot, windowsHide: true });
    try {
      await assert.rejects(() => packages.save(readFileSync(archive), 'broken.zip'), /engine.json/);
    } finally {
      rmSync(archive, { force: true });
    }
  });
});

test('the packaged engine grades a real delivery inside the sandbox and the platform recomputes its score', async () => {
  await withEngineRoots(async (packages) => {
    const archive = join(tmpdir(), `engine-run-${process.pid}.zip`);
    try {
      const record = await packages.save(buildPackage(archive), 'parking-fee-engine.zip');
      const store = new PlatformStore(':memory:');
      const version = {
        id: 'packaged-parking@1', challengeId: 'packaged-parking', version: 1, title: '停车场计费（打包引擎）', zone: 'YELLOW' as const,
        languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
        rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'PUBLISHED' as const,
        evaluationEngine: {
          id: record.manifest.id, version: record.manifest.version, mode: 'PACKAGED' as const,
          package: { packageHash: record.packageHash, size: record.size, fileName: 'parking-fee-engine.zip' },
          input: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/engine-invocation.schema.json' },
          output: { format: 'JSON' as const, schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
        },
      };
      store.createChallenge({ id: 'packaged-parking', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'PUBLISHED', versions: [version] }, 'w00123');
      const event = store.createEvent({ id: 'event-packaged', challengeVersion: 'packaged-parking@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE' }, 'w00123');

      const { computeDirectorySnapshotHash } = await import('../src/snapshot-hash');
      const reference = join(projectRoot, 'challenges', 'parking-fee-v1', 'reference');
      const snapshotHash = computeDirectorySnapshotHash(reference);
      const submission = store.createSubmission(event.id, 'w00124', {
        sourceType: 'UPLOAD', snapshotHash, artifactHash: snapshotHash,
        workspacePath: 'challenges/parking-fee-v1/reference', submittedAt: '2026-08-01T10:00:00Z',
      });
      const run = store.startGrading(submission.id, 'w00123');
      store.markRunRunning(run.id);

      const context = store.gradingContextForSubmission(submission);
      assert.equal(context.engine.mode, 'PACKAGED');
      const executor = new PackagedEngineExecutor(new ArtifactStore(), packages);
      const result = await executor.execute({ event: store.getEvent(event.id), submission, run, ...context });

      // The engine's output is a contract, not a trusted score.
      assert.deepEqual(validateEvaluationResult(result), []);
      assert.deepEqual(checkEvaluationScore(result as Record<string, unknown>).errors, []);
      assert.equal((result as { graderVersion: string }).graderVersion, 'parking-fee-packaged@1.0.0');
      const verify = (result as { dimensions: Record<string, { score: number; max: number }> }).dimensions.verify;
      assert.equal(verify.score, 40);
      assert.equal(verify.max, 40);

      const stored = store.completeRun(run.id, result);
      assert.equal(store.getRun(run.id).status, 'GRADED');
      assert.equal((stored.result as { recalculatedTotal: number }).recalculatedTotal, (stored.result as { total: number }).total);
      // The package hash is part of the grading identity: a new package is a
      // new rule set, so the same delivery must not reuse an old result.
      assert.ok(run.idempotencyKey.length >= 32);
    } finally {
      rmSync(archive, { force: true });
    }
  });
});
