import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { EnginePackageManifest, ResolvedEngine, SubmissionRecord } from './domain';
import { OBJECT_STORAGE, ObjectStorage } from './object-storage';
import { EnginePackageStore } from './engine-package-store';
import { ExecutorRegistry } from './executor-registry';
import { GradingExecutionRequest, GradingExecutor } from './grading-executor';
import { computeDirectorySnapshotHash } from './snapshot-hash';

const execFileAsync = promisify(execFile);

/** Ceilings the platform enforces regardless of what a package asks for. */
const MAX_WALL_CLOCK_SECONDS = Number(process.env.ENGINE_MAX_WALL_SECONDS ?? 600);
const MAX_MEMORY_MB = Number(process.env.ENGINE_MAX_MEMORY_MB ?? 2048);
const MAX_OUTPUT_BYTES = Number(process.env.ENGINE_MAX_OUTPUT_BYTES ?? 16 * 1024 * 1024);
const DEFAULT_WALL_CLOCK_SECONDS = 180;
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_OUTPUT_BYTES = 5 * 1024 * 1024;

const ZIP_EXTRACT_SUBMISSION = [
  'import pathlib, stat, sys, zipfile',
  'archive, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()',
  'with zipfile.ZipFile(archive) as z:',
  '    infos = z.infolist()',
  '    if len(infos) > 2000: raise RuntimeError("archive contains too many files")',
  '    total = 0',
  '    for info in infos:',
  '        if (info.external_attr >> 16) and stat.S_ISLNK(info.external_attr >> 16): raise RuntimeError("symlink is not allowed")',
  '        target = (root / info.filename).resolve()',
  '        if target != root and root not in target.parents: raise RuntimeError("archive path escapes workspace")',
  '        if info.is_dir():',
  '            target.mkdir(parents=True, exist_ok=True)',
  '            continue',
  '        total += info.file_size',
  '        if total > 100 * 1024 * 1024: raise RuntimeError("archive expands beyond limit")',
  '        target.parent.mkdir(parents=True, exist_ok=True)',
  '        target.write_bytes(z.read(info))',
].join('\n');

/**
 * Runs one delivery through the engine its challenge selected — a built-in
 * executor from `executors/` or an uploaded package. Both kinds share the same
 * manifest, the same invocation contract and this same runner, so a challenge
 * cannot be graded differently depending on where its engine came from.
 *
 * The engine is trusted code (an author uploaded it, not a trainee), but it is
 * still someone else's program running on the evaluation host, so it gets a
 * scratch directory, a stripped environment, and wall-clock/memory ceilings.
 * The platform never trusts its *output*: the result is schema-checked and the
 * score is recomputed by the store exactly as for every other trigger.
 */
@Injectable()
export class EngineRunner implements GradingExecutor {
  private readonly cwd = process.cwd();
  private readonly projectRoot = resolve(process.env.PROJECT_ROOT ?? (existsSync(join(this.cwd, 'grader', 'run_grader.py')) ? this.cwd : join(this.cwd, '..', '..')));
  private readonly launcher = resolve(process.env.ENGINE_SANDBOX_LAUNCHER ?? join(this.projectRoot, 'sandbox', 'launch.py'));

  constructor(
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
    @Inject(EnginePackageStore) private readonly packages: EnginePackageStore,
    @Inject(ExecutorRegistry) private readonly executors: ExecutorRegistry,
  ) {}

  private repositoryRoot(): string {
    return this.projectRoot;
  }

  /**
   * Absolute asset paths handed to the engine. A built-in executor receives
   * the repository paths its parameters name, resolved here, so it never needs
   * the repository root inside the sandbox.
   */
  private assetPaths(engine: ResolvedEngine): Record<string, string> {
    const assets: Record<string, string> = {};
    const fromManifest = (value?: string) => value ? resolve(engine.root, value) : undefined;
    for (const [key, value] of Object.entries({
      submissionContract: fromManifest(engine.manifest.assets?.submissionContract),
      testsDir: fromManifest(engine.manifest.assets?.testsDir),
      referenceDir: fromManifest(engine.manifest.assets?.referenceDir),
    })) {
      if (value) assets[key] = value;
    }
    if (engine.source === 'BUILT_IN') {
      const params = engine.params as { contractPath?: string; testsDir?: string };
      if (params.contractPath) assets.submissionContract = resolve(this.repositoryRoot(), params.contractPath);
      if (params.testsDir) assets.testsDir = resolve(this.repositoryRoot(), params.testsDir);
    }
    return assets;
  }

  private python(): string {
    const venv = join(this.projectRoot, '.venv', 'Scripts', 'python.exe');
    return process.env.PYTHON ?? (existsSync(venv) ? venv : 'python');
  }

  private limits(manifest: EnginePackageManifest): { wallClockSeconds: number; memoryMB: number; outputBytes: number } {
    const requested = manifest.limits ?? {};
    return {
      wallClockSeconds: Math.min(requested.wallClockSeconds ?? DEFAULT_WALL_CLOCK_SECONDS, MAX_WALL_CLOCK_SECONDS),
      memoryMB: Math.min(requested.memoryMB ?? DEFAULT_MEMORY_MB, MAX_MEMORY_MB),
      outputBytes: Math.min(requested.outputBytes ?? DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
    };
  }

  private async materializeWorkspace(submission: SubmissionRecord, sandbox: string): Promise<string> {
    const workspace = join(sandbox, 'workspace');
    mkdirSync(workspace, { recursive: true });
    if (submission.snapshot.artifactUri) {
      const materialized = await this.objects.materialize(submission.snapshot.artifactUri, submission.snapshot.artifactName);
      try {
        await execFileAsync(this.python(), ['-c', ZIP_EXTRACT_SUBMISSION, materialized.path, workspace], {
          cwd: this.projectRoot,
          maxBuffer: 2 * 1024 * 1024,
          timeout: 60_000,
          windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
      } catch (error) {
        const details = error as { stderr?: string };
        throw new BadRequestException({ code: 'ARTIFACT_EXTRACT_FAILED', message: `交付件解包失败: ${(details.stderr ?? '').slice(-500)}` });
      } finally {
        await materialized.cleanup();
      }
      return workspace;
    }
    if (submission.snapshot.workspacePath) {
      const source = resolve(process.env.LOCAL_WORKSPACE_ROOT ?? this.projectRoot, submission.snapshot.workspacePath);
      if (!existsSync(source)) throw new BadRequestException({ code: 'WORKSPACE_MISSING', message: '本地工作区不存在' });
      const { cpSync } = require('node:fs') as typeof import('node:fs');
      cpSync(source, workspace, { recursive: true, dereference: false, filter: (path: string) => !/[\\/](\.git|node_modules|__pycache__|\.venv)$/.test(path) });
      return workspace;
    }
    throw new BadRequestException({ code: 'SUBMISSION_NOT_MATERIALIZABLE', message: '提交缺少可评测的交付件' });
  }

  async execute(input: GradingExecutionRequest): Promise<Record<string, unknown>> {
    const engine = this.executors.resolve(input.engine);
    const manifest = engine.manifest;
    const interpreter = engine.source === 'PACKAGE'
      ? (await this.packages.prepareEnvironment(engine.packageHash, manifest)) ?? this.python()
      : this.python();
    const limits = this.limits(manifest);

    mkdirSync(join(this.projectRoot, 'tmp'), { recursive: true });
    const sandbox = mkdtempSync(join(this.projectRoot, 'tmp', 'engine-run-'));
    try {
      const workspace = await this.materializeWorkspace(input.submission, sandbox);
      // The delivery is immutable: if what we are about to grade is not what
      // was submitted, fail loudly instead of scoring the wrong bytes.
      const actual = computeDirectorySnapshotHash(workspace);
      if (actual !== input.submission.snapshot.snapshotHash) {
        throw new BadRequestException({ code: 'SNAPSHOT_CHANGED', message: '交付件内容与提交时的快照不一致' });
      }

      const scratch = join(sandbox, 'scratch');
      mkdirSync(scratch, { recursive: true });
      const outputPath = join(sandbox, 'result.json');
      const inputPath = join(sandbox, 'input.json');
      const invocation = {
        schemaVersion: '1.0',
        generatedAt: new Date().toISOString(),
        engine: {
          id: engine.id,
          version: engine.version,
          source: engine.source,
          packageHash: engine.packageHash,
          packageRoot: engine.root,
          assets: this.assetPaths(engine),
        },
        challenge: {
          id: input.challenge.id,
          title: input.challenge.title,
          challengeVersion: input.challenge.challengeVersion,
          rubricVersion: input.challenge.rubricVersion,
          ...(input.challenge.zone ? { zone: input.challenge.zone } : {}),
        },
        grading: {
          runId: input.run.id,
          idempotencyKey: input.run.idempotencyKey,
          triggerType: input.run.triggerType,
          attempt: input.run.attempt ?? 1,
        },
        subject: { id: input.submission.subjectId },
        submission: {
          id: input.submission.id,
          sourceType: input.submission.snapshot.sourceType,
          snapshotHash: input.submission.snapshot.snapshotHash,
          ...(input.submission.snapshot.artifactHash ? { artifactHash: input.submission.snapshot.artifactHash } : {}),
          ...(input.submission.snapshot.repository ? { repository: input.submission.snapshot.repository } : {}),
          ...(input.submission.snapshot.branch ? { branch: input.submission.snapshot.branch } : {}),
          ...(input.submission.snapshot.commitSha ? { commitSha: input.submission.snapshot.commitSha } : {}),
          submittedAt: input.submission.snapshot.submittedAt,
        },
        workspace,
        outputPath,
        scratchDir: scratch,
        limits,
        params: engine.params,
      };
      writeFileSync(inputPath, JSON.stringify(invocation, null, 2), 'utf8');

      const launcherArguments = [
        this.launcher,
        '--entry', resolve(engine.root, manifest.runtime.entrypoint),
        '--input', inputPath,
        '--output', outputPath,
        '--cwd', scratch,
        '--python', interpreter,
        '--memory-mb', String(limits.memoryMB),
        '--cpu-seconds', String(limits.wallClockSeconds),
        '--wall-seconds', String(limits.wallClockSeconds),
        '--output-bytes', String(limits.outputBytes),
      ];
      let stderr = '';
      try {
        await execFileAsync(this.python(), launcherArguments, {
          cwd: this.projectRoot,
          maxBuffer: 8 * 1024 * 1024,
          // Outer backstop: the launcher owns the real deadline, this only
          // catches a launcher that itself wedges.
          timeout: (limits.wallClockSeconds + 30) * 1000,
          windowsHide: true,
        });
      } catch (error) {
        const details = error as { stderr?: string; code?: number };
        stderr = (details.stderr ?? '').slice(-2000);
        if (details.code === 124) {
          throw new BadRequestException({ code: 'ENGINE_TIMEOUT', message: `评测引擎超过 ${limits.wallClockSeconds} 秒未完成` });
        }
        // A non-zero exit is only fatal when no result was produced; an engine
        // is allowed to exit non-zero while still reporting a graded result.
        if (!existsSync(outputPath)) {
          throw new BadRequestException({ code: 'ENGINE_FAILED', message: `评测引擎执行失败: ${stderr}` });
        }
      }
      if (!existsSync(outputPath)) {
        throw new BadRequestException({ code: 'ENGINE_NO_RESULT', message: `评测引擎没有产出结果文件: ${stderr}` });
      }
      const raw = readFileSync(outputPath, 'utf8');
      if (Buffer.byteLength(raw) > limits.outputBytes) {
        throw new BadRequestException({ code: 'ENGINE_RESULT_TOO_LARGE', message: '评测引擎结果超过允许大小' });
      }
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new BadRequestException({ code: 'ENGINE_RESULT_INVALID_JSON', message: '评测引擎结果不是合法 JSON' });
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}
