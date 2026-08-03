#!/usr/bin/env node
/**
 * Pull-based evaluation host worker.
 *
 * The worker never judges a delivery itself. It leases one same-challenge
 * batch, materialises the frozen engine and every selected learner delivery in
 * one isolated folder, then invokes the configured Code Agent bridge with a
 * batch manifest. The bridge writes a result index and this worker returns the
 * whole batch to the platform for schema, score, identity and idempotency
 * validation.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) continue;
  const next = process.argv[index + 1];
  options.set(key.slice(2), next && !next.startsWith('--') ? (index += 1, next) : 'true');
}

const api = options.get('api') ?? process.env.PLATFORM_API ?? 'http://127.0.0.1:3000/api/v1';
const employeeId = options.get('employee') ?? process.env.PLATFORM_EMPLOYEE_ID ?? 'w00123';
const workerId = options.get('worker') ?? process.env.EVALUATION_WORKER_ID ?? `worker-${process.pid}`;
const intervalSeconds = Math.max(1, Number(options.get('interval') ?? 5));
const once = options.has('once');
const engineCache = resolve(options.get('cache') ?? join(root, 'tmp', 'worker-engines'));
const batchRoot = resolve(options.get('batch-root') ?? process.env.EVALUATION_BATCH_ROOT ?? join(root, 'tmp', 'evaluation-batches'));
const keepBatches = options.has('keep-batches') || process.env.EVALUATION_KEEP_BATCHES === 'true';
const python = process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
const commandLineOverride = options.get('agent-command');
const environmentCodeAgentCommand = process.env.CODE_AGENT_COMMAND;
let codeAgentArgs;
try {
  codeAgentArgs = JSON.parse(options.get('agent-args-json') ?? process.env.CODE_AGENT_ARGS_JSON ?? '[]');
  if (!Array.isArray(codeAgentArgs) || codeAgentArgs.some((value) => typeof value !== 'string')) throw new Error('must be a JSON string array');
} catch (error) {
  throw new Error(`CODE_AGENT_ARGS_JSON 配置错误: ${error.message}`);
}

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-employee-id': employeeId, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  return response;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJsonFile(path, maxBytes, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${label}不存在`);
  const size = lstatSync(path).size;
  if (size > maxBytes) throw new Error(`${label}超过大小限制（${size} > ${maxBytes}）`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function canonicalBytes(value) {
  if (value.includes(0)) return value;
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) return value;
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

function directoryHash(value) {
  const directory = realpathSync(resolve(value));
  const ignoredDirectories = new Set(['.git', '.venv', '__pycache__', '.mypy_cache', '.pytest_cache']);
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (ignoredDirectories.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).split('\\').join('/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && !/\.(?:pyc|pyo)$/i.test(entry.name)) entries.push({ path, absolute });
      else if (entry.isSymbolicLink()) throw new Error(`目录中包含符号链接: ${path}`);
    }
  };
  walk(directory);
  const digest = createHash('sha256');
  for (const entry of entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const contentHash = sha256(canonicalBytes(readFileSync(entry.absolute)));
    const executable = lstatSync(entry.absolute).mode & 0o111 ? '1' : '0';
    digest.update(`${entry.path}\0${contentHash}\0${executable}\n`, 'utf8');
  }
  return digest.digest('hex');
}

function builtInEngineHash(engineHash, dependencies = []) {
  const digest = createHash('sha256');
  digest.update(`engine\0${engineHash}\n`, 'utf8');
  for (const dependency of [...dependencies].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    digest.update(`${dependency.name}\0${dependency.repositoryPath}\0${dependency.contentHash}\n`, 'utf8');
  }
  return digest.digest('hex');
}

function safeExtract(archive, target) {
  mkdirSync(target, { recursive: true });
  execFileSync(python, ['-c', [
    'import pathlib, stat, sys, zipfile',
    'archive, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()',
    'with zipfile.ZipFile(archive) as z:',
    '    for info in z.infolist():',
    '        path = pathlib.PurePosixPath(info.filename.replace("\\\\", "/"))',
    '        if path.is_absolute() or ".." in path.parts: raise SystemExit("archive path escapes root")',
    '        mode = (info.external_attr >> 16) & 0xffff',
    '        if stat.S_ISLNK(mode): raise SystemExit("archive symlink is not allowed")',
    '        destination = (target / path).resolve()',
    '        if destination != target and target not in destination.parents: raise SystemExit("archive path escapes root")',
    '        if info.is_dir(): destination.mkdir(parents=True, exist_ok=True); continue',
    '        destination.parent.mkdir(parents=True, exist_ok=True)',
    '        destination.write_bytes(z.read(info))',
  ].join('\n'), archive, target], { cwd: root, windowsHide: true, stdio: 'pipe' });
}

function assertInside(base, target, label) {
  const resolvedBase = existsSync(base) ? realpathSync(resolve(base)) : resolve(base);
  const resolvedTarget = existsSync(target) ? realpathSync(resolve(target)) : resolve(target);
  const relativePath = relative(resolvedBase, resolvedTarget);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} 超出允许目录`);
  }
}

function materializeProtocolContract(reference, target, label) {
  if (!reference || reference.format !== 'JSON' || !reference.schemaVersion || !reference.contractPath) {
    throw new Error(`${label}配置不完整`);
  }
  const source = resolve(root, reference.contractPath);
  assertInside(root, source, label);
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`${label}不存在: ${reference.contractPath}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  return {
    format: 'JSON',
    schemaVersion: reference.schemaVersion,
    sourcePath: reference.contractPath,
    path: target,
    sha256: sha256(readFileSync(target)),
  };
}

/** Materialise one verified engine copy inside this batch folder. */
async function materializeEngine(task, target) {
  let source;
  const runtimeAssets = {};
  if (task.engine.source === 'BUILT_IN') {
    source = join(root, 'executors', task.engine.id);
    if (!existsSync(join(source, 'engine.json'))) throw new Error(`内置执行器不存在: ${task.engine.id}`);
    const dependencies = task.engine.platformDependencies ?? [];
    for (const dependency of dependencies) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(dependency.name)) throw new Error(`评测引擎依赖名称不合法: ${dependency.name}`);
      const dependencySource = resolve(root, dependency.repositoryPath);
      assertInside(root, dependencySource, `评测引擎依赖 ${dependency.name}`);
      if (!existsSync(dependencySource) || directoryHash(dependencySource) !== dependency.contentHash) {
        throw new Error(`评测引擎依赖哈希不一致: ${dependency.name}`);
      }
    }
    const actualHash = builtInEngineHash(directoryHash(source), dependencies);
    if (actualHash !== task.engine.packageHash) throw new Error(`内置执行器哈希不一致: ${task.engine.id}`);
  } else {
    const cached = join(engineCache, task.engine.packageHash);
    if (!existsSync(join(cached, 'engine.json'))) {
      mkdirSync(engineCache, { recursive: true });
      const response = await call(`/evaluation-engines/${task.engine.packageHash}/package`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== task.engine.packageHash) throw new Error('下载的评测引擎包哈希不一致');
      const archive = join(engineCache, `${task.engine.packageHash}.zip`);
      const staging = `${cached}.${process.pid}.staging`;
      rmSync(staging, { recursive: true, force: true });
      writeFileSync(archive, bytes);
      safeExtract(archive, staging);
      if (!existsSync(join(staging, 'engine.json'))) throw new Error('评测引擎包缺少 engine.json');
      if (!existsSync(cached)) cpSync(staging, cached, { recursive: true, dereference: false });
      rmSync(staging, { recursive: true, force: true });
    }
    source = cached;
  }
  cpSync(source, target, { recursive: true, dereference: false });
  for (const dependency of task.engine.platformDependencies ?? []) {
    const destination = join(target, '_platform', dependency.name, basename(dependency.repositoryPath));
    cpSync(resolve(root, dependency.repositoryPath), destination, { recursive: true, dereference: false });
    runtimeAssets[dependency.name] = destination;
  }
  return { root: target, runtimeAssets };
}

async function materializeSubmission(item, target) {
  const workspace = join(target, 'workspace');
  mkdirSync(workspace, { recursive: true });
  if (item.submission.artifactUrl) {
    const response = await call(item.submission.artifactUrl.replace('/api/v1', ''));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (item.submission.artifactHash && sha256(bytes) !== item.submission.artifactHash) {
      throw new Error(`交付件字节哈希不一致: ${item.submission.id}`);
    }
    const archive = join(target, 'delivery.zip');
    writeFileSync(archive, bytes);
    safeExtract(archive, workspace);
  } else if (item.submission.workspacePath) {
    const source = resolve(root, item.submission.workspacePath);
    assertInside(root, source, '本地交付目录');
    cpSync(source, workspace, { recursive: true, dereference: false });
  } else {
    throw new Error(`提交没有可物化的交付件: ${item.submission.id}`);
  }
  const actualSnapshotHash = directoryHash(workspace);
  if (actualSnapshotHash !== item.submission.snapshotHash) {
    throw new Error(`交付快照哈希不一致: ${item.submission.id}`);
  }
  return workspace;
}

function copyChallengeAssets(task, target) {
  const assets = {};
  for (const [key, value] of Object.entries(task.engine.assets ?? {})) {
    if (value) assets[key] = join(target, 'engine', value);
  }
  if (task.engine.source !== 'BUILT_IN') return assets;
  const challengeAssetsRoot = join(target, 'challenge-assets');
  for (const [key, value] of Object.entries(task.engine.params ?? {})) {
    if (typeof value !== 'string' || !/(?:Path|Dir)$/.test(key)) continue;
    const source = resolve(root, value);
    assertInside(root, source, `评测参数 ${key}`);
    if (!existsSync(source)) throw new Error(`评测参数路径不存在: ${value}`);
    const destination = join(challengeAssetsRoot, `${key}-${basename(source)}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false });
    if (key === 'contractPath') assets.submissionContract = destination;
    else if (key === 'testsDir') assets.testsDir = destination;
    else assets[key] = destination;
  }
  return assets;
}

function mandatoryAgentPrompt(configuredPrompt, manifestPath) {
  return [
    configuredPrompt?.trim(),
    '执行 AI 训战平台评测批次。',
    `批次清单：${manifestPath}`,
    '读取清单中的 instructionPath 和全部 skillPaths，只处理 submissions 中列出的交付件。',
    '逐份使用清单指定的评测引擎，将单人结果写入 outputPath，最后将批次索引写入 resultIndexPath。',
    '输出必须符合清单中 contracts.output.path 指向的 JSON Schema；不得修改交付快照、评测引擎或契约。',
  ].filter(Boolean).join('\n\n');
}

function platformInvocation(runtime, manifestPath, cwd) {
  const prompt = mandatoryAgentPrompt(runtime.prompt, manifestPath);
  let promptInjected = false;
  let manifestInjected = false;
  const values = { prompt, manifestPath, batchDir: cwd };
  const args = runtime.args.map((raw) => raw.replace(/\{\{(prompt|manifestPath|batchDir)\}\}/g, (_match, key) => {
    if (key === 'prompt') promptInjected = true;
    if (key === 'manifestPath') manifestInjected = true;
    return values[key];
  }));
  if (!promptInjected) {
    const promptFlag = args.findIndex((value) => value === '--prompt' || value === '-p');
    const inlinePrompt = args.findIndex((value) => value.startsWith('--prompt='));
    if (promptFlag >= 0) {
      if (args[promptFlag + 1] === undefined) args.push(prompt);
      else args[promptFlag + 1] = `${args[promptFlag + 1]}\n\n${prompt}`;
      promptInjected = true;
    } else if (inlinePrompt >= 0) {
      args[inlinePrompt] = `${args[inlinePrompt]}\n\n${prompt}`;
      promptInjected = true;
    }
  }
  // A bridge generally has no prompt option and expects the legacy manifest
  // flag. A direct agent command receives the path inside the mandatory prompt.
  if (!promptInjected && !manifestInjected) args.push('--manifest', manifestPath);

  const allowed = (process.env.CODE_AGENT_ALLOWED_EXECUTABLES ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (allowed.length) {
    const executable = runtime.executable.toLowerCase();
    const executableName = basename(runtime.executable).toLowerCase();
    if (!allowed.includes(executable) && !allowed.includes(executableName)) {
      throw new Error(`平台配置的 Code Agent 可执行文件不在 Worker 允许列表中: ${basename(runtime.executable)}`);
    }
  }
  return { command: runtime.executable, args };
}

function resolveCodeAgentInvocation(task, manifestPath, cwd) {
  if (commandLineOverride) return { command: commandLineOverride, args: [...codeAgentArgs, '--manifest', manifestPath] };
  if (task.codeAgentRuntime?.executable) return platformInvocation(task.codeAgentRuntime, manifestPath, cwd);
  if (environmentCodeAgentCommand) return { command: environmentCodeAgentCommand, args: [...codeAgentArgs, '--manifest', manifestPath] };
  return null;
}

function runCodeAgent(task, manifestPath, cwd, timeoutMs) {
  const invocation = resolveCodeAgentInvocation(task, manifestPath, cwd);
  if (!invocation) {
    throw new Error('未配置 CODE_AGENT_COMMAND；请将它指向实现 Code Agent batch bridge 契约的可执行文件');
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, AI_TRAINING_BATCH_MANIFEST: manifestPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Code Agent bridge 批次执行超时（${Math.ceil(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 1024 * 1024) stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`Code Agent bridge 退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）: ${stderr.trim().slice(-1000)}`));
    });
  });
}

async function runBatch(task) {
  mkdirSync(batchRoot, { recursive: true });
  const directory = mkdtempSync(join(batchRoot, `${task.batchId}-`));
  let heartbeat;
  try {
    const materializedEngine = await materializeEngine(task, join(directory, 'engine'));
    const engineRoot = materializedEngine.root;
    const assets = { ...copyChallengeAssets(task, directory), ...materializedEngine.runtimeAssets };
    const resultsRoot = join(directory, 'results');
    mkdirSync(resultsRoot, { recursive: true });
    const submissions = [];
    for (const item of task.submissions) {
      const submissionRoot = join(directory, 'submissions', item.submission.id);
      const workspace = await materializeSubmission(item, submissionRoot);
      submissions.push({
        ...item,
        workspace,
        outputPath: join(resultsRoot, `${item.runId}.json`),
        scratchDir: join(submissionRoot, 'scratch'),
      });
      mkdirSync(submissions.at(-1).scratchDir, { recursive: true });
    }
    const resultIndexPath = join(resultsRoot, 'index.json');
    const manifestPath = join(directory, 'batch-manifest.json');
    const contractsRoot = join(directory, 'contracts');
    const contracts = {
      input: materializeProtocolContract(task.contracts?.input, join(contractsRoot, 'batch-input.schema.json'), '批次输入契约'),
      output: materializeProtocolContract(task.contracts?.output, join(contractsRoot, 'evaluation-result.schema.json'), '评测结果契约'),
    };
    const instructionPath = join(engineRoot, task.engine.agent.instruction);
    const skillPaths = task.engine.agent.skills.map((path) => join(engineRoot, path));
    const manifest = {
      schemaVersion: '1.1',
      generatedAt: new Date().toISOString(),
      batch: { id: task.batchId, leaseId: task.leaseId, challengeVersion: task.challenge.challengeVersion },
      agent: { instructionPath, skillPaths },
      contracts,
      engine: {
        id: task.engine.id,
        version: task.engine.version,
        source: task.engine.source,
        packageHash: task.engine.packageHash,
        root: engineRoot,
        entrypoint: join(engineRoot, task.engine.entrypoint),
        assets,
        params: task.engine.params ?? {},
        limits: task.engine.limits,
      },
      challenge: task.challenge,
      submissions,
      resultIndexPath,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const heartbeatMs = Math.max(15_000, Number(process.env.EVALUATION_HEARTBEAT_SECONDS ?? 60) * 1000);
    heartbeat = setInterval(() => {
      void call(`/evaluation-batches/${task.batchId}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ leaseId: task.leaseId }),
      }).catch((error) => console.error(`[${workerId}] 批次心跳失败 ${task.batchId}: ${error.message}`));
    }, heartbeatMs);
    const defaultBatchTimeoutSeconds = Math.max(300, Math.min(
      21_600,
      Number(task.engine.limits?.wallClockSeconds ?? 600) * task.submissions.length + 300,
    ));
    const batchTimeoutSeconds = Number(
      options.get('agent-timeout-seconds')
      ?? process.env.CODE_AGENT_BATCH_TIMEOUT_SECONDS
      ?? task.codeAgentRuntime?.timeoutSeconds
      ?? defaultBatchTimeoutSeconds,
    );
    if (!Number.isFinite(batchTimeoutSeconds) || batchTimeoutSeconds <= 0) {
      throw new Error('CODE_AGENT_BATCH_TIMEOUT_SECONDS 必须是正数');
    }
    await runCodeAgent(task, manifestPath, directory, batchTimeoutSeconds * 1000);
    if (!existsSync(resultIndexPath)) throw new Error('Code Agent 未生成批次结果索引');
    const perResultLimit = Math.max(1024, Number(task.engine.limits?.outputBytes ?? 5 * 1024 * 1024));
    const resultIndexLimit = Math.min(
      64 * 1024 * 1024,
      Math.max(1024 * 1024, perResultLimit * task.submissions.length + 1024 * 1024),
    );
    const index = readJsonFile(resultIndexPath, resultIndexLimit, 'Code Agent 批次结果索引');
    if (index.schemaVersion !== '1.0' || index.batchId !== task.batchId || !Array.isArray(index.results) || !Array.isArray(index.failures ?? [])) {
      throw new Error('Code Agent 批次结果索引不符合契约');
    }
    const expectedRunIds = new Set(task.submissions.map((item) => item.runId));
    const returnedRunIds = new Set();
    for (const item of [...index.results, ...(index.failures ?? [])]) {
      if (!item || typeof item.runId !== 'string' || !expectedRunIds.has(item.runId)) {
        throw new Error('Code Agent 批次结果包含范围外的 runId');
      }
      if (returnedRunIds.has(item.runId)) throw new Error(`Code Agent 批次结果重复返回 runId：${item.runId}`);
      returnedRunIds.add(item.runId);
    }
    for (const item of index.failures ?? []) {
      if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error(`Code Agent 未提供失败原因：${item.runId}`);
    }
    const results = index.results.map((item) => {
      let resultFile;
      if (item.resultPath) {
        resultFile = resolve(directory, item.resultPath);
        assertInside(resultsRoot, resultFile, '评测结果路径');
      }
      const output = item.result ?? readJsonFile(resultFile ?? join(resultsRoot, `${item.runId}.json`), perResultLimit, '单份评测结果');
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error(`单份评测结果必须是 JSON 对象：${item.runId}`);
      if (item.result && Buffer.byteLength(JSON.stringify(item.result), 'utf8') > perResultLimit) {
        throw new Error(`单份评测结果超过大小限制：${item.runId}`);
      }
      return { runId: item.runId, result: output };
    });
    return { directory, results, failures: index.failures ?? [] };
  } catch (error) {
    if (!keepBatches) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function pump() {
  const response = await call('/evaluation-batches:lease', {
    method: 'POST',
    body: JSON.stringify({ workerId, limit: Number(options.get('batches') ?? 1) }),
  });
  const { batches } = await response.json();
  for (const task of batches) {
    console.log(`[${workerId}] 领取批次 ${task.batchId} · ${task.submissions.length} 份提交 · ${task.engine.id}@${task.engine.version}`);
    let output;
    try {
      output = await runBatch(task);
      const completed = await call(`/evaluation-batches/${task.batchId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ leaseId: task.leaseId, results: output.results, failures: output.failures }),
      });
      const summary = await completed.json();
      console.log(`[${workerId}] 完成批次 ${task.batchId} · 成功 ${summary.accepted?.length ?? 0} · 失败 ${summary.rejected?.length ?? 0}`);
      if (!keepBatches) rmSync(output.directory, { recursive: true, force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[${workerId}] 批次失败 ${task.batchId}: ${reason}`);
      await call(`/evaluation-batches/${task.batchId}/fail`, {
        method: 'POST',
        body: JSON.stringify({ leaseId: task.leaseId, reason }),
      }).catch(() => undefined);
    }
  }
  return batches.length;
}

console.log(`[${workerId}] 评测 Worker 已启动 · API ${api}${once ? ' · 单次模式' : ` · 轮询 ${intervalSeconds}s`}`);
do {
  const handled = await pump().catch((error) => {
    console.error(`[${workerId}] 领取批次失败: ${error.message}`);
    return 0;
  });
  if (once) break;
  if (!handled) await new Promise((done) => setTimeout(done, intervalSeconds * 1000));
} while (true);
