import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { EnginePackageManifest, EvaluationEngineConfig, ResolvedEngine } from './domain';
import { EnginePackageStore } from './engine-package-store';
import { computeDirectorySnapshotHash } from './snapshot-hash';

export interface BuiltInExecutorSummary {
  id: string;
  version: string;
  title: string;
  description?: string;
  contentHash: string;
  params: Record<string, unknown> | null;
  limits: EnginePackageManifest['limits'] | null;
}

/**
 * Built-in executors are engine packages that ship in the repository instead of
 * being uploaded, so both kinds share one manifest format and one invocation
 * contract. Administrators pick one from a list rather than typing paths.
 */
@Injectable()
export class ExecutorRegistry {
  private readonly root = resolve(process.env.EXECUTOR_ROOT ?? join(this.projectRoot(), 'executors'));
  private readonly validateManifest: ValidateFunction;
  private readonly hashes = new Map<string, string>();

  constructor(@Inject(EnginePackageStore) private readonly packages: EnginePackageStore) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    this.validateManifest = ajv.compile(JSON.parse(readFileSync(join(this.projectRoot(), 'contracts', 'evaluation-engine-package.schema.json'), 'utf8')));
  }

  private projectRoot(): string {
    const cwd = process.cwd();
    return resolve(process.env.PROJECT_ROOT ?? (existsSync(join(cwd, 'grader', 'run_grader.py')) ? cwd : join(cwd, '..', '..')));
  }

  private manifestOf(executorId: string): { manifest: EnginePackageManifest; root: string } {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(executorId)) throw new BadRequestException('executor id is invalid');
    const directory = join(this.root, executorId);
    const manifestPath = join(directory, 'engine.json');
    if (!existsSync(manifestPath)) throw new NotFoundException({ code: 'EXECUTOR_NOT_FOUND', message: `内置执行器不存在: ${executorId}` });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EnginePackageManifest;
    if (!this.validateManifest(manifest)) {
      const errors = (this.validateManifest.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message ?? 'invalid'}`);
      throw new BadRequestException({ code: 'EXECUTOR_MANIFEST_INVALID', message: `内置执行器清单不合法: ${executorId}`, errors });
    }
    if (manifest.id !== executorId) {
      throw new BadRequestException({ code: 'EXECUTOR_MANIFEST_INVALID', message: `执行器目录名与 engine.json 的 id 不一致: ${executorId}` });
    }
    if (!existsSync(join(directory, manifest.runtime.entrypoint))) {
      throw new BadRequestException({ code: 'EXECUTOR_ENTRYPOINT_MISSING', message: `执行器入口不存在: ${manifest.runtime.entrypoint}` });
    }
    return { manifest, root: directory };
  }

  /**
   * Content hash of the executor directory. It participates in the grading
   * identity, so editing a built-in executor invalidates cached results the
   * same way uploading a new package does.
   */
  private dependencyRecords(manifest: EnginePackageManifest): ResolvedEngine['platformDependencies'] {
    return Object.entries(manifest.platformDependencies ?? {})
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, repositoryPath]) => {
        const root = this.projectRoot();
        const target = resolve(root, repositoryPath);
        const child = relative(root, target);
        if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !existsSync(target) || !statSync(target).isDirectory()) {
          throw new BadRequestException({ code: 'EXECUTOR_DEPENDENCY_INVALID', message: `内置执行器依赖目录不存在：${repositoryPath}` });
        }
        return { name, repositoryPath, contentHash: computeDirectorySnapshotHash(target) };
      });
  }

  private contentHash(executorId: string, directory: string, manifest: EnginePackageManifest): string {
    const cached = this.hashes.get(executorId);
    if (cached) return cached;
    const digest = createHash('sha256');
    digest.update(`engine\0${computeDirectorySnapshotHash(directory)}\n`, 'utf8');
    for (const dependency of this.dependencyRecords(manifest)) {
      digest.update(`${dependency.name}\0${dependency.repositoryPath}\0${dependency.contentHash}\n`, 'utf8');
    }
    const hash = digest.digest('hex');
    this.hashes.set(executorId, hash);
    return hash;
  }

  list(): BuiltInExecutorSummary[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(this.root, entry.name, 'engine.json')))
      .map((entry) => {
        const { manifest, root } = this.manifestOf(entry.name);
        return {
          id: manifest.id,
          version: manifest.version,
          title: manifest.title ?? manifest.id,
          description: manifest.description,
          contentHash: this.contentHash(manifest.id, root, manifest),
          params: manifest.params ?? null,
          limits: manifest.limits ?? null,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Reject a challenge that selects a missing executor or omits a required parameter. */
  assertExecutorConfiguration(executorId: string, params: Record<string, unknown> = {}): void {
    const { manifest } = this.manifestOf(executorId);
    const declared = manifest.params as { required?: string[]; properties?: Record<string, { enum?: unknown[] }> } | undefined;
    for (const key of declared?.required ?? []) {
      const value = params[key];
      if (value === undefined || value === null || String(value).trim() === '') {
        throw new BadRequestException({ code: 'EXECUTOR_PARAM_MISSING', message: `内置执行器 ${executorId} 缺少必填参数: ${key}` });
      }
    }
    for (const [key, value] of Object.entries(params)) {
      const property = declared?.properties?.[key];
      if (!property) throw new BadRequestException({ code: 'EXECUTOR_PARAM_UNKNOWN', message: `内置执行器 ${executorId} 不接受参数: ${key}` });
      if (property.enum && !property.enum.includes(value)) {
        throw new BadRequestException({ code: 'EXECUTOR_PARAM_INVALID', message: `参数 ${key} 只能取 ${property.enum.join(' / ')}` });
      }
      // Repository-relative paths only: a challenge may not point an executor
      // outside the repository.
      if (typeof value === 'string' && /Path$|Dir$/.test(key)) {
        if (!value.trim() || value.includes('..') || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
          throw new BadRequestException({ code: 'EXECUTOR_PARAM_INVALID', message: `参数 ${key} 必须是仓库内相对路径` });
        }
        if (!existsSync(join(this.projectRoot(), value))) {
          throw new BadRequestException({ code: 'EXECUTOR_PARAM_PATH_MISSING', message: `参数 ${key} 指向的路径在仓库中不存在: ${value}` });
        }
      }
    }
  }

  /**
   * Code Agent assets are part of the frozen engine, not arbitrary host paths.
   * Validate them while the challenge version is edited so an invalid package
   * can never enter the evaluation queue.
   */
  assertAgentConfiguration(engine: EvaluationEngineConfig): void {
    if (!['PLATFORM_LOCAL', 'PACKAGED'].includes(engine.mode)) return;
    const resolvedEngine = this.resolve(engine);
    const agent = engine.agent ?? (resolvedEngine.manifest.agent
      ? { instructionPath: resolvedEngine.manifest.agent.instruction, skillPaths: resolvedEngine.manifest.agent.skills }
      : { instructionPath: 'instruction.md', skillPaths: ['skills/evaluation'] });
    if (!agent.instructionPath.trim()) {
      throw new BadRequestException({ code: 'CODE_AGENT_INSTRUCTION_REQUIRED', message: '请配置 Code Agent 评测指令' });
    }
    if (!agent.skillPaths.length || agent.skillPaths.some((path) => !path.trim())) {
      throw new BadRequestException({ code: 'CODE_AGENT_SKILLS_REQUIRED', message: '请至少配置一个 Code Agent skill' });
    }
    for (const [kind, configuredPath] of [
      ['instruction', agent.instructionPath],
      ...agent.skillPaths.map((path) => ['skill', path]),
    ] as Array<['instruction' | 'skill', string]>) {
      const target = resolve(resolvedEngine.root, configuredPath);
      const relativePath = relative(resolvedEngine.root, target);
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || !existsSync(target)) {
        throw new BadRequestException({ code: 'CODE_AGENT_ASSET_MISSING', message: `Code Agent ${kind} 不存在：${configuredPath}` });
      }
      if (kind === 'instruction' && !statSync(target).isFile()) {
        throw new BadRequestException({ code: 'CODE_AGENT_ASSET_INVALID', message: `Code Agent instruction 必须是文件：${configuredPath}` });
      }
      const skillFile = statSync(target).isDirectory() ? join(target, 'SKILL.md') : target;
      if (kind === 'skill' && (!existsSync(skillFile) || !statSync(skillFile).isFile())) {
        throw new BadRequestException({ code: 'CODE_AGENT_ASSET_INVALID', message: `Code Agent skill 缺少 SKILL.md：${configuredPath}` });
      }
    }
  }

  /** Resolve either kind of engine into the shape the runner and worker use. */
  resolve(engine: EvaluationEngineConfig): ResolvedEngine {
    if (engine.mode === 'PACKAGED') {
      const packageHash = engine.package?.packageHash;
      if (!packageHash) throw new BadRequestException({ code: 'ENGINE_PACKAGE_REQUIRED', message: '该赛题未绑定评测引擎包' });
      return {
        source: 'PACKAGE',
        id: engine.id,
        version: engine.version,
        packageHash,
        root: this.packages.packageRoot(packageHash),
        manifest: this.packages.readManifest(packageHash),
        params: {},
        platformDependencies: [],
      };
    }
    if (engine.mode === 'PLATFORM_LOCAL') {
      const executorId = engine.executor?.id;
      if (!executorId) throw new BadRequestException({ code: 'EXECUTOR_REQUIRED', message: '该赛题未选择内置执行器' });
      const { manifest, root } = this.manifestOf(executorId);
      return {
        source: 'BUILT_IN',
        id: manifest.id,
        version: manifest.version,
        packageHash: this.contentHash(manifest.id, root, manifest),
        root,
        manifest,
        params: engine.executor?.params ?? {},
        platformDependencies: this.dependencyRecords(manifest),
      };
    }
    throw new BadRequestException({ code: 'ENGINE_NOT_RUNNABLE', message: `${engine.mode} 引擎不在平台内执行` });
  }
}
