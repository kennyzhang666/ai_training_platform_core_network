import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, Injectable } from '@nestjs/common';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { EnginePackageManifest, EnginePackageRecord } from './domain';

const execFileAsync = promisify(execFile);

const MAX_PACKAGE_BYTES = Number(process.env.ENGINE_PACKAGE_MAX_BYTES ?? 32 * 1024 * 1024);
const MAX_PACKAGE_FILES = Number(process.env.ENGINE_PACKAGE_MAX_FILES ?? 5000);
const MAX_PACKAGE_EXPANDED_BYTES = Number(process.env.ENGINE_PACKAGE_MAX_EXPANDED_BYTES ?? 128 * 1024 * 1024);
const DEPENDENCY_INSTALL_TIMEOUT_MS = Number(process.env.ENGINE_DEPENDENCY_TIMEOUT_MS ?? 300_000);

/**
 * Safe unpack: reject absolute paths, `..`, symlinks, too many entries and zip
 * bombs before anything lands on disk. The author is trusted not to be
 * hostile, but a malformed archive must not be able to write outside the
 * engine cache.
 */
const ZIP_EXTRACT = [
  'import pathlib, stat, sys, zipfile',
  'archive, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()',
  'max_files, max_expanded = int(sys.argv[3]), int(sys.argv[4])',
  'root.mkdir(parents=True, exist_ok=True)',
  'with zipfile.ZipFile(archive) as z:',
  '    infos = z.infolist()',
  '    if len(infos) > max_files: raise RuntimeError("engine package contains too many files")',
  '    total = 0',
  '    for info in infos:',
  '        raw = info.filename.replace("\\\\", "/")',
  '        path = pathlib.PurePosixPath(raw)',
  '        if path.is_absolute() or ".." in path.parts: raise RuntimeError("engine package path escapes the package root")',
  '        mode = (info.external_attr >> 16) & 0xffff',
  '        if stat.S_ISLNK(mode): raise RuntimeError("engine package must not contain symbolic links")',
  '        target = (root / raw).resolve()',
  '        if target != root and root not in target.parents: raise RuntimeError("engine package path escapes the package root")',
  '        if info.is_dir():',
  '            target.mkdir(parents=True, exist_ok=True)',
  '            continue',
  '        total += info.file_size',
  '        if total > max_expanded: raise RuntimeError("engine package expands beyond the allowed size")',
  '        target.parent.mkdir(parents=True, exist_ok=True)',
  '        target.write_bytes(z.read(info))',
  '        if mode & 0o111:',
  '            target.chmod(target.stat().st_mode | 0o111)',
].join('\n');

@Injectable()
export class EnginePackageStore {
  private readonly root = resolve(process.env.ENGINE_PACKAGE_ROOT ?? join(this.projectRoot(), 'tmp', 'engine-packages'));
  private readonly validate: ValidateFunction;
  private readonly preparedEnvironments = new Map<string, Promise<string | undefined>>();

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    this.validate = ajv.compile(JSON.parse(readFileSync(join(this.projectRoot(), 'contracts', 'evaluation-engine-package.schema.json'), 'utf8')));
  }

  private projectRoot(): string {
    const cwd = process.cwd();
    return resolve(process.env.PROJECT_ROOT ?? (existsSync(join(cwd, 'grader', 'run_grader.py')) ? cwd : join(cwd, '..', '..')));
  }

  private python(): string {
    const venv = join(this.projectRoot(), '.venv', 'Scripts', 'python.exe');
    return process.env.PYTHON ?? (existsSync(venv) ? venv : 'python');
  }

  packageRoot(packageHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(packageHash)) throw new BadRequestException('engine package hash is invalid');
    return join(this.root, packageHash, 'package');
  }

  /** Store an uploaded package under its content hash and return its manifest. */
  async save(bytes: Buffer, fileName = 'engine.zip'): Promise<EnginePackageRecord> {
    if (!bytes.length) throw new BadRequestException({ code: 'ENGINE_PACKAGE_EMPTY', message: '引擎包为空' });
    if (bytes.length > MAX_PACKAGE_BYTES) {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_TOO_LARGE', message: `引擎包超过 ${MAX_PACKAGE_BYTES} 字节` });
    }
    if (!fileName.toLowerCase().endsWith('.zip')) {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_FORMAT', message: '引擎包必须是 zip 文件' });
    }
    const packageHash = createHash('sha256').update(bytes).digest('hex');
    const target = this.packageRoot(packageHash);
    if (!existsSync(join(target, 'engine.json'))) {
      // Unpack beside the destination and move into place, so a failed or
      // concurrent extraction can never leave a half-written package that a
      // later run would happily execute.
      const staging = `${target}.${process.pid}.staging`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(join(this.root, packageHash), { recursive: true });
      const archivePath = join(this.root, packageHash, 'package.zip');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(archivePath, bytes);
      try {
        await execFileAsync(this.python(), ['-c', ZIP_EXTRACT, archivePath, staging, String(MAX_PACKAGE_FILES), String(MAX_PACKAGE_EXPANDED_BYTES)], {
          cwd: this.projectRoot(),
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        const details = error as { stderr?: string; message?: string };
        throw new BadRequestException({ code: 'ENGINE_PACKAGE_INVALID', message: `引擎包解析失败: ${(details.stderr ?? details.message ?? '').trim().slice(-500)}` });
      }
      if (existsSync(target)) rmSync(staging, { recursive: true, force: true });
      else renameSync(staging, target);
    }
    const manifest = this.readManifest(packageHash);
    return { packageHash, size: bytes.length, manifest, uploadedFileName: fileName };
  }

  /** Raw package bytes, so an evaluation worker can materialise the engine. */
  async readPackageBytes(packageHash: string): Promise<Buffer> {
    const archive = join(this.root, packageHash, 'package.zip');
    if (!/^[a-f0-9]{64}$/.test(packageHash) || !existsSync(archive)) {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_NOT_FOUND', message: `引擎包不存在: ${packageHash}` });
    }
    const { readFile } = await import('node:fs/promises');
    return readFile(archive);
  }

  readManifest(packageHash: string): EnginePackageManifest {
    const manifestPath = join(this.packageRoot(packageHash), 'engine.json');
    if (!existsSync(manifestPath)) {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_MANIFEST_MISSING', message: '引擎包根目录缺少 engine.json' });
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_MANIFEST_INVALID', message: 'engine.json 不是合法 JSON' });
    }
    if (!this.validate(manifest)) {
      const errors = (this.validate.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message ?? 'invalid'}`);
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_MANIFEST_INVALID', message: 'engine.json 不符合引擎包契约', errors });
    }
    const typed = manifest as EnginePackageManifest;
    if (Object.keys(typed.platformDependencies ?? {}).length) {
      throw new BadRequestException({
        code: 'ENGINE_PACKAGE_PLATFORM_DEPENDENCY_FORBIDDEN',
        message: '上传的评测引擎包必须自包含，不能引用平台仓库目录',
      });
    }
    // A declared path that does not exist is an authoring mistake that must
    // surface at upload time, not on the first trainee submission.
    const declared: Array<[string, string | undefined]> = [
      ['runtime.entrypoint', typed.runtime.entrypoint],
      ['runtime.requirements', typed.runtime.requirements],
      ['assets.submissionContract', typed.assets?.submissionContract],
      ['assets.testsDir', typed.assets?.testsDir],
      ['assets.referenceDir', typed.assets?.referenceDir],
      ['agent.instruction', typed.agent?.instruction],
      ...((typed.agent?.skills ?? []).map((path, index) => [`agent.skills[${index}]`, path] as [string, string])),
    ];
    for (const [label, value] of declared) {
      if (!value) continue;
      if (!existsSync(this.resolveInsidePackage(packageHash, value))) {
        throw new BadRequestException({ code: 'ENGINE_PACKAGE_PATH_MISSING', message: `引擎包中不存在 ${label} 指向的 ${value}` });
      }
    }
    return typed;
  }

  resolveInsidePackage(packageHash: string, relativePath: string): string {
    const root = this.packageRoot(packageHash);
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${require('node:path').sep}`)) {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_PATH_ESCAPE', message: `路径逃出引擎包: ${relativePath}` });
    }
    return target;
  }

  /**
   * Materialise the engine's declared dependencies once per package hash and
   * reuse the environment afterwards. Returns the interpreter to run the
   * engine with, or undefined when the package declares no dependencies.
   */
  async prepareEnvironment(packageHash: string, manifest: EnginePackageManifest): Promise<string | undefined> {
    if (!manifest.runtime.requirements) return undefined;
    const cached = this.preparedEnvironments.get(packageHash);
    if (cached) return cached;
    const prepare = (async () => {
      const environmentRoot = join(this.root, packageHash, 'venv');
      const interpreter = process.platform === 'win32'
        ? join(environmentRoot, 'Scripts', 'python.exe')
        : join(environmentRoot, 'bin', 'python');
      if (existsSync(interpreter)) return interpreter;
      const requirements = this.resolveInsidePackage(packageHash, manifest.runtime.requirements!);
      try {
        await execFileAsync(this.python(), ['-m', 'venv', environmentRoot], { cwd: this.projectRoot(), timeout: DEPENDENCY_INSTALL_TIMEOUT_MS, windowsHide: true });
        const install = ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '-r', requirements];
        if (process.env.ENGINE_PIP_INDEX_URL) install.push('--index-url', process.env.ENGINE_PIP_INDEX_URL);
        if (process.env.ENGINE_PIP_OFFLINE === 'true') install.push('--no-index');
        await execFileAsync(interpreter, install, { cwd: this.projectRoot(), timeout: DEPENDENCY_INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      } catch (error) {
        rmSync(environmentRoot, { recursive: true, force: true });
        this.preparedEnvironments.delete(packageHash);
        const details = error as { stderr?: string; message?: string };
        throw new BadRequestException({ code: 'ENGINE_DEPENDENCIES_FAILED', message: `引擎依赖安装失败: ${(details.stderr ?? details.message ?? '').trim().slice(-800)}` });
      }
      return interpreter;
    })();
    this.preparedEnvironments.set(packageHash, prepare);
    return prepare;
  }
}
