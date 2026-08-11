#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');

export function resolvePnpmInvocation({
  platform = process.platform,
  nodeExecutable = process.execPath,
  environment = process.env,
  fileExists = existsSync,
} = {}) {
  const configured = environment.npm_execpath?.trim();
  if (configured && /\.(?:c?js|mjs)$/i.test(configured) && fileExists(configured)) {
    return { executable: nodeExecutable, args: [configured] };
  }
  if (platform !== 'win32') return { executable: 'pnpm', args: [] };
  const roots = [environment.PNPM_HOME, ...(environment.PATH ?? '').split(';')].filter(Boolean);
  for (const directory of roots) {
    for (const relativePath of ['pnpm.cjs', 'pnpm.mjs', 'node_modules/pnpm/bin/pnpm.cjs', 'node_modules/pnpm/bin/pnpm.mjs']) {
      const candidate = resolve(directory, ...relativePath.split('/'));
      if (fileExists(candidate)) return { executable: nodeExecutable, args: [candidate] };
    }
  }
  throw new Error('Windows 发布构建未找到 pnpm 的 JavaScript 入口；请通过 pnpm release:build 运行，或配置 PNPM_HOME');
}

export const RELEASE_TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    platform: 'win32',
    arch: 'x64',
    manager: 'manage.ps1',
    installer: 'install.cmd',
    environmentTemplate: 'windows.env.example',
    archiveExtension: '.zip',
    runtimeFiles: Object.freeze([
      'node/node.exe',
      'powershell/pwsh.exe',
      'python/python.exe',
      'nginx/nginx.exe',
      'nginx/conf/mime.types',
    ]),
  }),
  'linux-x64': Object.freeze({
    platform: 'linux',
    arch: 'x64',
    manager: 'manage.sh',
    installer: 'install.sh',
    environmentTemplate: 'linux.env.example',
    archiveExtension: '.tar.gz',
    runtimeFiles: Object.freeze([
      'node/bin/node',
      'python/bin/python3',
      'nginx/sbin/nginx',
      'nginx/conf/mime.types',
    ]),
  }),
});

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value ?? '').trim());
  if (!match) throw new Error(`runtime returned an invalid version: ${value}`);
  return match.slice(1).map((part) => Number(part ?? 0));
}

export function assertNodeRuntimeIdentity(identity, target) {
  const descriptor = RELEASE_TARGETS[target];
  if (!descriptor) throw new Error(`unsupported release target: ${target}`);
  const [major] = versionTuple(identity?.version);
  if (major < 20) throw new Error(`${target} runtime requires Node.js 20 or newer; received ${identity?.version ?? 'unknown'}`);
  if (identity?.platform !== descriptor.platform || identity?.arch !== descriptor.arch) {
    throw new Error(`${target} Node.js runtime must report ${descriptor.platform}/${descriptor.arch}; received ${identity?.platform ?? 'unknown'}/${identity?.arch ?? 'unknown'}`);
  }
}

export function assertPythonRuntimeIdentity(identity, target) {
  const descriptor = RELEASE_TARGETS[target];
  if (!descriptor) throw new Error(`unsupported release target: ${target}`);
  const [major, minor] = versionTuple(identity?.version);
  if (major < 3 || (major === 3 && minor < 11)) throw new Error(`${target} runtime requires Python 3.11 or newer; received ${identity?.version ?? 'unknown'}`);
  const expectedSystem = descriptor.platform === 'win32' ? 'windows' : 'linux';
  const machine = String(identity?.machine ?? '').toLowerCase();
  if (String(identity?.system ?? '').toLowerCase() !== expectedSystem || !['x86_64', 'amd64', 'x64'].includes(machine)) {
    throw new Error(`${target} Python runtime must be ${descriptor.platform === 'win32' ? 'Windows' : 'Linux'} x64; received ${identity?.system ?? 'unknown'} ${identity?.machine ?? 'unknown'}`);
  }
}

function slash(value) {
  return value.split(sep).join('/');
}

function inside(root, path) {
  const child = relative(root, path);
  return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function requireFile(path, label) {
  let info;
  try { info = await stat(path); } catch { throw new Error(`${label} does not exist: ${path}`); }
  if (!info.isFile()) throw new Error(`${label} must be a file: ${path}`);
}

async function requireDirectory(path, label) {
  let info;
  try { info = await stat(path); } catch { throw new Error(`${label} does not exist: ${path}`); }
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

async function copyDirectory(source, destination, label, filter = undefined) {
  await requireDirectory(source, label);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
    ...(filter ? { filter } : {}),
  });
}

async function copyFile(source, destination, label) {
  await requireFile(source, label);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: false, errorOnExist: true });
}

async function wheelFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.whl'));
}

function portablePythonSource(path) {
  const name = basename(path).toLowerCase();
  return name !== '__pycache__' && !name.endsWith('.pyc') && !name.endsWith('.pyo');
}

async function copyExecutorDependencies(sourceRoot, outputRoot) {
  const executorsRoot = join(sourceRoot, 'executors');
  const entries = await readdir(executorsRoot, { withFileTypes: true });
  const dependencies = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(executorsRoot, entry.name, 'engine.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new Error(`executor manifest is not valid JSON: ${manifestPath}`); }
    for (const repositoryPath of Object.values(manifest.platformDependencies ?? {})) {
      if (typeof repositoryPath !== 'string' || !repositoryPath.trim()) throw new Error(`executor dependency path is invalid: ${manifestPath}`);
      const source = resolve(sourceRoot, repositoryPath);
      if (!inside(sourceRoot, source)) throw new Error(`executor dependency escapes the source root: ${repositoryPath}`);
      dependencies.add(slash(relative(sourceRoot, source)));
    }
  }
  for (const repositoryPath of [...dependencies].sort()) {
    await copyDirectory(
      join(sourceRoot, ...repositoryPath.split('/')),
      join(outputRoot, ...repositoryPath.split('/')),
      `executor dependency ${repositoryPath}`,
      portablePythonSource,
    );
  }
}

async function describeEntry(root, path) {
  const info = await lstat(path);
  const entryPath = slash(relative(root, path));
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    const resolvedTarget = resolve(dirname(path), target);
    if (!inside(root, resolvedTarget)) throw new Error(`release symlink escapes the package: ${entryPath}`);
    const bytes = Buffer.from(target, 'utf8');
    return { path: entryPath, type: 'symlink', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: info.mode & 0o777 };
  }
  if (!info.isFile()) return undefined;
  const bytes = await readFile(path);
  return { path: entryPath, type: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: info.mode & 0o777 };
}

async function listReleaseFiles(root, directory = root) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const item = await describeEntry(root, path);
    if (item) files.push(item);
    else if (entry.isDirectory()) files.push(...await listReleaseFiles(root, path));
  }
  return files;
}

function releaseTimestamp(sourceDateEpoch) {
  const epoch = Number(sourceDateEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 315_532_800) throw new Error('sourceDateEpoch must be an integer at or after 1980-01-01');
  return new Date(epoch * 1000).toISOString();
}

export async function assembleReleaseLayout(options) {
  const {
    sourceRoot: sourceValue,
    apiDeployRoot: apiValue,
    runtimeRoot: runtimeValue,
    wheelhouseRoot: wheelhouseValue,
    outputRoot: outputValue,
    target,
    version,
    sourceDateEpoch,
  } = options;
  const descriptor = RELEASE_TARGETS[target];
  if (!descriptor) throw new Error(`unsupported release target: ${target}`);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error(`invalid release version: ${version}`);

  const sourceRoot = resolve(sourceValue);
  const apiDeployRoot = resolve(apiValue);
  const runtimeRoot = resolve(runtimeValue);
  const wheelhouseRoot = resolve(wheelhouseValue);
  const outputRoot = resolve(outputValue);
  await requireDirectory(sourceRoot, 'source root');
  await requireDirectory(apiDeployRoot, 'API deploy root');
  await requireDirectory(runtimeRoot, `${target} runtime root`);
  await requireDirectory(wheelhouseRoot, 'offline wheelhouse');
  await requireFile(join(apiDeployRoot, 'node_modules', '.prisma', 'client', 'default.js'), 'generated Prisma Client');
  if (existsSync(outputRoot)) throw new Error(`release output already exists: ${outputRoot}`);
  if (inside(outputRoot, sourceRoot) || outputRoot === sourceRoot) throw new Error('release output cannot contain the source root');
  if (!(await wheelFiles(wheelhouseRoot)).length) throw new Error(`offline wheelhouse contains no .whl files: ${wheelhouseRoot}`);
  for (const path of descriptor.runtimeFiles) await requireFile(join(runtimeRoot, ...path.split('/')), `${target} runtime asset ${path}`);

  await mkdir(dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot, { recursive: false });
  try {
    for (const path of ['apps/web/dist', 'contracts', 'docs', 'executors', 'sandbox']) {
      await copyDirectory(join(sourceRoot, ...path.split('/')), join(outputRoot, ...path.split('/')), path);
    }
    await copyExecutorDependencies(sourceRoot, outputRoot);
    await copyFile(join(sourceRoot, 'scripts', 'evaluation-worker.mjs'), join(outputRoot, 'scripts', 'evaluation-worker.mjs'), 'evaluation Worker');
    await copyFile(join(sourceRoot, 'scripts', 'code-agent-executable.mjs'), join(outputRoot, 'scripts', 'code-agent-executable.mjs'), 'Code Agent executable resolver');
    await copyFile(join(sourceRoot, 'scripts', 'log-redaction.mjs'), join(outputRoot, 'scripts', 'log-redaction.mjs'), 'Worker log redaction');
    await copyFile(join(sourceRoot, 'scripts', 'safe-archive-extract.py'), join(outputRoot, 'scripts', 'safe-archive-extract.py'), 'safe archive extractor');
    await copyFile(join(sourceRoot, 'scripts', 'prepare-single-node-environment.mjs'), join(outputRoot, 'scripts', 'prepare-single-node-environment.mjs'), 'environment bootstrap');
    await copyFile(join(sourceRoot, 'services', 'ldap3-gateway', 'ldap3_gateway.py'), join(outputRoot, 'services', 'ldap3-gateway', 'ldap3_gateway.py'), 'LDAP3 gateway');
    await copyFile(join(sourceRoot, 'services', 'ldap3-gateway', 'requirements.txt'), join(outputRoot, 'services', 'ldap3-gateway', 'requirements.txt'), 'LDAP3 requirements');
    await copyDirectory(join(sourceRoot, 'services', 'ldap3-gateway', 'static'), join(outputRoot, 'services', 'ldap3-gateway', 'static'), 'LDAP3 static assets');

    for (const path of ['dist', 'node_modules', 'prisma', 'scripts']) {
      await copyDirectory(join(apiDeployRoot, path), join(outputRoot, 'services', 'platform-api', path), `API ${path}`);
    }
    await copyFile(join(apiDeployRoot, 'package.json'), join(outputRoot, 'services', 'platform-api', 'package.json'), 'API package manifest');

    await copyFile(join(sourceRoot, 'deploy', 'single-node', descriptor.manager), join(outputRoot, 'deploy', 'single-node', descriptor.manager), `${target} manager`);
    await copyFile(join(sourceRoot, descriptor.installer), join(outputRoot, descriptor.installer), `${target} one-command installer`);
    if (descriptor.platform === 'linux') await chmod(join(outputRoot, 'deploy', 'single-node', descriptor.manager), 0o755);
    if (descriptor.platform === 'linux') await chmod(join(outputRoot, descriptor.installer), 0o755);
    if (descriptor.platform === 'win32') {
      await copyFile(join(sourceRoot, 'deploy', 'single-node', 'manage.cmd'), join(outputRoot, 'deploy', 'single-node', 'manage.cmd'), 'Windows manager launcher');
    }
    await copyFile(join(sourceRoot, 'deploy', 'single-node', 'nginx-http.conf.template'), join(outputRoot, 'deploy', 'single-node', 'nginx-http.conf.template'), 'Nginx template');
    await copyFile(join(sourceRoot, 'deploy', 'release', descriptor.environmentTemplate), join(outputRoot, 'deploy', 'single-node', '.env.example'), `${target} environment template`);
    await copyFile(join(sourceRoot, 'DEPLOYMENT.html'), join(outputRoot, 'DEPLOYMENT.html'), 'single-page deployment guide');
    await copyDirectory(runtimeRoot, join(outputRoot, 'runtime'), `${target} runtime assets`);
    await copyDirectory(wheelhouseRoot, join(outputRoot, 'deploy', 'single-node', 'wheelhouse'), 'offline wheelhouse');

    for (const path of ['data', 'runtime-state', 'backups']) {
      await mkdir(join(outputRoot, path), { recursive: true });
      await writeFile(join(outputRoot, path, '.keep'), '');
    }
    await writeFile(join(outputRoot, 'VERSION'), `${version}\n`, 'utf8');

    const files = await listReleaseFiles(outputRoot);
    if (descriptor.platform === 'win32') {
      const link = files.find((file) => file.type === 'symlink');
      if (link) throw new Error(`Windows release cannot contain a symlink: ${link.path}`);
    }
    const manifest = {
      schemaVersion: '1.0',
      product: 'ai-training-platform',
      version,
      target,
      createdAt: releaseTimestamp(sourceDateEpoch),
      files,
    };
    await writeFile(join(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyReleaseLayout(rootValue) {
  const root = resolve(rootValue);
  await requireDirectory(root, 'release root');
  const manifestPath = join(root, 'release-manifest.json');
  await requireFile(manifestPath, 'release manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== '1.0' || manifest.product !== 'ai-training-platform' || !RELEASE_TARGETS[manifest.target] || !Array.isArray(manifest.files)) {
    throw new Error('release manifest is invalid');
  }
  await requireFile(join(root, 'services', 'platform-api', 'node_modules', '.prisma', 'client', 'default.js'), 'generated Prisma Client');
  const actual = (await listReleaseFiles(root)).filter((file) => file.path !== 'release-manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('release manifest does not match package files');
  if (RELEASE_TARGETS[manifest.target].platform === 'win32') {
    const link = actual.find((file) => file.type === 'symlink');
    if (link) throw new Error(`Windows release cannot contain a symlink: ${link.path}`);
  }
  const forbidden = actual.find((file) =>
    file.path === '.env'
    || file.path === 'deploy/single-node/.env'
    || /^(?:services\/platform-api|apps\/web)\/(?:src|test)\//.test(file.path),
  );
  if (forbidden) throw new Error(`release contains a forbidden file: ${forbidden.path}`);
  return manifest;
}

function pythonCommand() {
  const configured = process.env.PYTHON?.trim();
  if (configured) return configured;
  const workspacePython = process.platform === 'win32' ? join(projectRoot, '.venv', 'Scripts', 'python.exe') : join(projectRoot, '.venv', 'bin', 'python');
  return existsSync(workspacePython) ? workspacePython : 'python';
}

export async function createReleaseArchive({ releaseRoot: rootValue, archivePath: archiveValue, target, python = pythonCommand() }) {
  const descriptor = RELEASE_TARGETS[target];
  if (!descriptor) throw new Error(`unsupported release target: ${target}`);
  const releaseRoot = resolve(rootValue);
  const archivePath = resolve(archiveValue);
  await verifyReleaseLayout(releaseRoot);
  if (!archivePath.endsWith(descriptor.archiveExtension)) throw new Error(`${target} archive must end with ${descriptor.archiveExtension}`);
  if (existsSync(archivePath)) throw new Error(`release archive already exists: ${archivePath}`);
  if (inside(releaseRoot, archivePath) || archivePath === releaseRoot) throw new Error('release archive must be outside the release directory');
  await mkdir(dirname(archivePath), { recursive: true });
  await execFileAsync(python, [join(projectRoot, 'scripts', 'archive-release.py'), releaseRoot, archivePath, target], { cwd: projectRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  await writeFile(`${archivePath}.sha256`, `${digest}  ${basename(archivePath)}\n`, 'utf8');
  return { archivePath, sha256: digest };
}

export function parseReleaseArguments(argv) {
  const values = argv[0] === '--' ? argv.slice(1) : argv;
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    options.set(key.slice(2), value);
    index += 1;
  }
  return options;
}

async function verifyRuntimeExecutables(runtimeRoot, target) {
  const descriptor = RELEASE_TARGETS[target];
  const executable = (path) => join(runtimeRoot, ...path.split('/'));
  const nodePath = executable(descriptor.runtimeFiles.find((path) => /node(?:\.exe)?$/.test(path)));
  const pythonPath = executable(descriptor.runtimeFiles.find((path) => /python(?:3|\.exe)$/.test(path)));
  const nginxPath = executable(descriptor.runtimeFiles.find((path) => /nginx(?:\.exe)?$/.test(path)));
  const nodeIdentity = await execFileAsync(nodePath, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], { windowsHide: true });
  assertNodeRuntimeIdentity(JSON.parse(nodeIdentity.stdout), target);
  const pythonIdentity = await execFileAsync(pythonPath, ['-c', 'import json, platform, sys; print(json.dumps({"version": platform.python_version(), "system": platform.system(), "machine": platform.machine()}))'], { windowsHide: true });
  assertPythonRuntimeIdentity(JSON.parse(pythonIdentity.stdout), target);
  await execFileAsync(pythonPath, ['-c', 'import ldap3, jsonschema, yaml'], { windowsHide: true });
  const pip = await execFileAsync(pythonPath, ['-m', 'pip', '--help'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (!pip.stdout.includes('--python')) throw new Error(`${target} Python pip does not support --python`);
  await execFileAsync(pythonPath, ['-m', 'venv', '--help'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  await execFileAsync(nginxPath, ['-v'], { windowsHide: true });
  if (descriptor.platform === 'win32') {
    const pwshPath = executable('powershell/pwsh.exe');
    const powershell = await execFileAsync(pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true });
    if (versionTuple(powershell.stdout)[0] < 7) throw new Error(`win32-x64 runtime requires PowerShell 7 or newer; received ${powershell.stdout.trim()}`);
  }
}

function targetNodeExecutable(runtimeRoot, target) {
  const descriptor = RELEASE_TARGETS[target];
  const relativePath = descriptor.runtimeFiles.find((path) => /node(?:\.exe)?$/.test(path));
  return join(runtimeRoot, ...relativePath.split('/'));
}

async function generatePrismaClient(apiDeployRoot, runtimeRoot, target) {
  const nodePath = targetNodeExecutable(runtimeRoot, target);
  const prismaCli = join(apiDeployRoot, 'node_modules', 'prisma', 'build', 'index.js');
  const schema = join(apiDeployRoot, 'prisma', 'schema.prisma');
  await requireFile(prismaCli, 'Prisma CLI');
  await requireFile(schema, 'Prisma schema');
  await execFileAsync(nodePath, [prismaCli, 'generate', '--schema', schema], {
    cwd: apiDeployRoot,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  await requireFile(join(apiDeployRoot, 'node_modules', '.prisma', 'client', 'default.js'), 'generated Prisma Client');
}

async function verifyPackagedPrismaClient(releaseRoot, runtimeRoot, target) {
  const nodePath = targetNodeExecutable(runtimeRoot, target);
  const apiRoot = join(releaseRoot, 'services', 'platform-api');
  await execFileAsync(nodePath, ['-e', "const { PrismaClient } = require('@prisma/client'); const client = new PrismaClient(); client.$disconnect().catch(() => process.exitCode = 1);"], {
    cwd: apiRoot,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function runCli() {
  const args = parseReleaseArguments(process.argv.slice(2));
  const target = args.get('target') ?? `${process.platform}-${process.arch}`;
  const descriptor = RELEASE_TARGETS[target];
  if (!descriptor) throw new Error(`unsupported release target: ${target}`);
  if (descriptor.platform !== process.platform || descriptor.arch !== process.arch) {
    throw new Error(`${target} release must be built on ${descriptor.platform}/${descriptor.arch} so Prisma and runtimes match the target`);
  }
  const runtimeRoot = resolve(args.get('runtime-root') ?? '');
  const wheelhouseRoot = resolve(args.get('wheelhouse') ?? '');
  if (!args.get('runtime-root')) throw new Error('--runtime-root is required');
  if (!args.get('wheelhouse')) throw new Error('--wheelhouse is required');
  await verifyRuntimeExecutables(runtimeRoot, target);

  const rootPackage = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const version = args.get('version') ?? rootPackage.version;
  const epoch = Number(args.get('source-date-epoch') ?? process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000));
  const releaseDirectory = resolve(args.get('output') ?? join(projectRoot, 'release', `ai-training-platform-${version}-${target}`));
  const archivePath = resolve(args.get('archive') ?? `${releaseDirectory}${descriptor.archiveExtension}`);
  const suppliedApiDeploy = args.get('api-deploy-root');
  const temporaryRoot = suppliedApiDeploy ? undefined : await mkdtemp(join(tmpdir(), 'ai-training-api-deploy-'));
  const apiDeployRoot = resolve(suppliedApiDeploy ?? join(temporaryRoot, 'platform-api'));

  try {
    if (!suppliedApiDeploy) {
      const pnpm = resolvePnpmInvocation();
      await execFileAsync(pnpm.executable, [...pnpm.args, 'build'], { cwd: projectRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      await execFileAsync(pnpm.executable, [...pnpm.args, '--filter', '@ai-training/platform-api', '--config.node-linker=hoisted', 'deploy', '--prod', '--legacy', apiDeployRoot], { cwd: projectRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    }
    await generatePrismaClient(apiDeployRoot, runtimeRoot, target);
    await assembleReleaseLayout({ sourceRoot: projectRoot, apiDeployRoot, runtimeRoot, wheelhouseRoot, outputRoot: releaseDirectory, target, version, sourceDateEpoch: epoch });
    await verifyPackagedPrismaClient(releaseDirectory, runtimeRoot, target);
    const archive = await createReleaseArchive({ releaseRoot: releaseDirectory, archivePath, target });
    process.stdout.write(`release directory: ${releaseDirectory}\nrelease archive: ${archive.archivePath}\nsha256: ${archive.sha256}\n`);
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
