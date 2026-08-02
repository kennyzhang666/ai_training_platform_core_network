import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { EvaluationEngineConfig, EventConfig, GradingRun, SubmissionRecord } from './domain';
import { ArtifactStore } from './artifact-store';
import { computeDirectorySnapshotHash } from './snapshot-hash';

const execFileAsync = promisify(execFile);
const GRADER_TIMEOUT_MS = Number(process.env.GRADER_TIMEOUT_MS ?? 180_000);
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS ?? 30_000);

const ZIP_EXTRACTOR = [
  'import pathlib, stat, sys, zipfile',
  'archive = pathlib.Path(sys.argv[1])',
  'root = pathlib.Path(sys.argv[2]).resolve()',
  'with zipfile.ZipFile(archive) as z:',
  '    infos = z.infolist()',
  '    if len(infos) > 2000: raise RuntimeError("archive contains too many files")',
  '    total = 0',
  '    for info in infos:',
  '        if (info.external_attr >> 16) and stat.S_ISLNK(info.external_attr >> 16): raise RuntimeError("symlink is not allowed")',
  '        target = (root / info.filename).resolve()',
  '        if target != root and root not in target.parents: raise RuntimeError("archive path escapes workspace")',
  '        if info.is_dir(): target.mkdir(parents=True, exist_ok=True); continue',
  '        total += info.file_size',
  '        if total > 100 * 1024 * 1024: raise RuntimeError("archive expands beyond limit")',
  '        target.parent.mkdir(parents=True, exist_ok=True)',
  '        target.write_bytes(z.read(info))',
].join('\n');

/**
 * The engine is resolved from the challenge version the delivery was submitted
 * against, so an executor never has to guess which rule set applies and a
 * session cannot override the challenge's own grading configuration.
 */
export interface GradingExecutionRequest {
  event: EventConfig;
  submission: SubmissionRecord;
  run: GradingRun;
  engine: EvaluationEngineConfig;
  /** Challenge context captured at submission time, for the engine's report. */
  challenge: {
    id: string;
    title: string;
    challengeVersion: string;
    rubricVersion: string;
    zone?: 'YELLOW' | 'BLUE';
  };
}

export interface GradingExecutor {
  execute(input: GradingExecutionRequest): Promise<Record<string, unknown>>;
}

export const GRADING_EXECUTOR = 'GRADING_EXECUTOR';

function resolveInside(base: string, value: string, label: string): string {
  const target = resolve(base, value);
  if (!existsSync(base) || !existsSync(target)) throw new BadRequestException(`${label} does not exist`);
  const realBase = realpathSync(base);
  const realTarget = realpathSync(target);
  const relative = relativePath(realBase, realTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
    throw new BadRequestException(`${label} must stay inside the local workspace root`);
  }
  const forbidden = new Set(['hidden-tests', 'grader', 'contracts', 'node_modules', '.git', 'tmp']);
  if (relative.split(sep).some((part) => forbidden.has(part))) throw new BadRequestException(`${label} points to a protected platform directory`);
  return realTarget;
}

@Injectable()
export class LocalGradingExecutor implements GradingExecutor {
  private readonly cwd = process.cwd();
  private readonly projectRoot = resolve(process.env.PROJECT_ROOT ?? (existsSync(join(this.cwd, 'grader', 'run_grader.py')) ? this.cwd : join(this.cwd, '..', '..')));
  private readonly workspaceRoot = resolve(process.env.LOCAL_WORKSPACE_ROOT ?? this.projectRoot);
  private readonly graderScript = resolve(process.env.GRADER_SCRIPT ?? join(this.projectRoot, 'grader', 'run_grader.py'));

  constructor(@Inject(ArtifactStore) private readonly artifacts: ArtifactStore) {}

  private async assertImmutableSnapshot(snapshot: SubmissionRecord['snapshot'], workspace?: string): Promise<void> {
    if (workspace) {
      const actual = computeDirectorySnapshotHash(workspace);
      if (actual !== snapshot.snapshotHash) {
        throw new BadRequestException({ code: 'SNAPSHOT_CHANGED', message: 'workspace contents changed after submission; snapshotHash no longer matches' });
      }
      return;
    }
    if (!snapshot.artifactUri) return;
    const actualArtifactHash = await this.artifacts.contentHash(snapshot.artifactUri);
    if (snapshot.artifactHash && actualArtifactHash !== snapshot.artifactHash) {
      throw new BadRequestException({ code: 'ARTIFACT_CHANGED', message: 'stored artifact bytes changed after submission; artifactHash no longer matches' });
    }
    const actualSnapshotHash = await this.artifacts.snapshotHash(snapshot.artifactUri);
    if (actualSnapshotHash !== snapshot.snapshotHash) {
      throw new BadRequestException({ code: 'SNAPSHOT_CHANGED', message: 'stored artifact contents changed after submission; snapshotHash no longer matches' });
    }
  }

  async execute(input: GradingExecutionRequest): Promise<Record<string, unknown>> {
    const engine = input.engine;
    if (engine.mode !== 'PLATFORM_LOCAL') {
      throw new BadRequestException({
        code: 'ENGINE_NOT_LOCAL',
        message: `赛题的评测引擎为 ${engine.mode}，请使用线下结果录入而不是平台本地执行`,
      });
    }
    const config = engine.local;
    if (!config) throw new BadRequestException({ code: 'ENGINE_LOCAL_CONFIG_MISSING', message: '赛题的本地评测引擎缺少执行配置' });
    const workspacePath = input.submission.snapshot.workspacePath;
    let temporaryWorkspace: string | undefined;
    let workspace: string;
    if (workspacePath) {
      workspace = resolveInside(this.workspaceRoot, workspacePath, 'workspacePath');
    } else if (input.submission.snapshot.artifactUri) {
      const archive = this.artifacts.localPath(input.submission.snapshot.artifactUri);
      mkdirSync(join(this.projectRoot, 'tmp'), { recursive: true });
      temporaryWorkspace = mkdtempSync(join(this.projectRoot, 'tmp', 'local-workspace-'));
      workspace = temporaryWorkspace;
    } else {
      throw new BadRequestException('submission requires workspacePath or a local artifactUri for grading');
    }
    const contract = resolve(this.projectRoot, config.contractPath);
    const tests = config.testsDir ? resolve(this.projectRoot, config.testsDir) : undefined;
    try {
      if (!existsSync(workspace)) throw new BadRequestException(`local workspace does not exist: ${workspace}`);
      if (!existsSync(contract)) throw new BadRequestException(`local grading contract does not exist: ${contract}`);
      if (!existsSync(this.graderScript)) throw new BadRequestException(`grader script does not exist: ${this.graderScript}`);
      await this.assertImmutableSnapshot(input.submission.snapshot, workspacePath ? workspace : undefined);
      const python = process.env.PYTHON ?? (existsSync(join(this.projectRoot, '.venv', 'Scripts', 'python.exe')) ? join(this.projectRoot, '.venv', 'Scripts', 'python.exe') : 'python');
      if (temporaryWorkspace) {
        const archive = this.artifacts.localPath(input.submission.snapshot.artifactUri!);
        try {
          await execFileAsync(python, ['-c', ZIP_EXTRACTOR, archive, temporaryWorkspace], {
            cwd: this.projectRoot,
            maxBuffer: 2 * 1024 * 1024,
            timeout: EXTRACT_TIMEOUT_MS,
            windowsHide: true,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
          });
        } catch (error) {
          const details = error as { stderr?: string };
          throw new BadRequestException(`artifact extraction failed: ${(details.stderr ?? '').slice(-1000)}`);
        }
      }
      const output = join(this.projectRoot, 'tmp', `local-result-${input.run.id}.json`);
      const args = [
        this.graderScript,
        'run',
        '--submission', workspace,
        '--contract', contract,
        '--challenge-version', input.event.challengeVersion,
        '--rubric-version', input.event.rubricVersion ?? '1.0',
        '--trigger-type', input.run.triggerType,
        '--source-type', input.submission.snapshot.sourceType,
        '--language', config.language ?? 'python',
        '--entry', config.entry,
        '--function', config.function,
        '--full-local',
        '--out', output,
      ];
      if (tests) args.push('--tests', tests);
      if (input.submission.snapshot.repository) args.push('--repository', input.submission.snapshot.repository);
      if (input.submission.snapshot.branch) args.push('--branch', input.submission.snapshot.branch);
      if (input.submission.snapshot.commitSha) args.push('--commit-sha', input.submission.snapshot.commitSha);
      try {
        await execFileAsync(python, args, {
          cwd: this.projectRoot,
          maxBuffer: 20 * 1024 * 1024,
          timeout: GRADER_TIMEOUT_MS,
          windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
      } catch (error) {
        const details = error as { stdout?: string; stderr?: string };
        if (!existsSync(output)) throw new BadRequestException(`local grader failed: ${(details.stderr ?? '').slice(-1000)}`);
      }
      if (!existsSync(output)) throw new BadRequestException('local grader did not produce a result');
      try {
        return JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
      } finally {
        unlinkSync(output);
      }
    } finally {
      if (temporaryWorkspace) rmSync(temporaryWorkspace, { recursive: true, force: true });
    }
  }
}
