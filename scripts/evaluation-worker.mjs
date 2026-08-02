#!/usr/bin/env node
/**
 * Evaluation worker: the thing that actually runs engines.
 *
 * The platform never executes challenge or engine code. This worker runs in the
 * evaluation environment (a dedicated host, or an administrator's machine),
 * leases queued tasks, materialises the engine and the delivery locally, runs
 * the engine through the sandbox launcher, and posts the result back. If it
 * dies mid-task the lease simply expires and the task returns to the queue.
 *
 *   node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 \
 *        --employee w00123 --worker eval-host-1 [--once] [--interval 5]
 *
 * The engine is invoked exactly as `contracts/engine-invocation.schema.json`
 * describes, so a built-in executor and an uploaded package are the same job.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
const intervalSeconds = Number(options.get('interval') ?? 5);
const once = options.has('once');
const engineCache = resolve(options.get('cache') ?? join(root, 'tmp', 'worker-engines'));
const python = process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
const launcher = join(root, 'sandbox', 'launch.py');

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-employee-id': employeeId, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  return response;
}

/** Built-in executors ship with this checkout; packages are downloaded once. */
async function materializeEngine(engine) {
  if (engine.source === 'BUILT_IN') return join(root, 'executors', engine.id);
  const target = join(engineCache, engine.packageHash);
  if (existsSync(join(target, 'engine.json'))) return target;
  const response = await call(`/evaluation-engines/${engine.packageHash}/package`);
  const archive = join(engineCache, `${engine.packageHash}.zip`);
  mkdirSync(engineCache, { recursive: true });
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  execFileSync(python, ['-c', [
    'import pathlib, sys, zipfile',
    'archive, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()',
    'with zipfile.ZipFile(archive) as z:',
    '    for info in z.infolist():',
    '        path = pathlib.PurePosixPath(info.filename.replace("\\\\", "/"))',
    '        if path.is_absolute() or ".." in path.parts: raise SystemExit("engine package path escapes root")',
    '        destination = target / path',
    '        if info.is_dir(): destination.mkdir(parents=True, exist_ok=True); continue',
    '        destination.parent.mkdir(parents=True, exist_ok=True)',
    '        destination.write_bytes(z.read(info))',
  ].join('\n'), archive, target], { cwd: root, windowsHide: true });
  return target;
}

async function materializeWorkspace(task, sandbox) {
  const workspace = join(sandbox, 'workspace');
  mkdirSync(workspace, { recursive: true });
  if (task.submission.artifactUrl) {
    const response = await call(task.submission.artifactUrl.replace('/api/v1', ''));
    const archive = join(sandbox, 'delivery.zip');
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    execFileSync(python, ['-c', [
      'import pathlib, sys, zipfile',
      'archive, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()',
      'with zipfile.ZipFile(archive) as z:',
      '    for info in z.infolist():',
      '        path = pathlib.PurePosixPath(info.filename.replace("\\\\", "/"))',
      '        if path.is_absolute() or ".." in path.parts: raise SystemExit("delivery path escapes workspace")',
      '        destination = target / path',
      '        if info.is_dir(): destination.mkdir(parents=True, exist_ok=True); continue',
      '        destination.parent.mkdir(parents=True, exist_ok=True)',
      '        destination.write_bytes(z.read(info))',
    ].join('\n'), archive, workspace], { cwd: root, windowsHide: true });
    return workspace;
  }
  if (task.submission.workspacePath) {
    const { cpSync } = await import('node:fs');
    cpSync(join(root, task.submission.workspacePath), workspace, { recursive: true, dereference: false });
    return workspace;
  }
  throw new Error('任务没有可物化的交付件');
}

function absoluteAssets(task, engineRoot) {
  const assets = {};
  for (const [key, value] of Object.entries(task.engine.assets ?? {})) {
    if (value) assets[key] = resolve(engineRoot, value);
  }
  // A built-in executor is generic: its per-challenge paths come from params
  // and are resolved against this checkout.
  if (task.engine.source === 'BUILT_IN') {
    if (task.engine.params?.contractPath) assets.submissionContract = resolve(root, task.engine.params.contractPath);
    if (task.engine.params?.testsDir) assets.testsDir = resolve(root, task.engine.params.testsDir);
  }
  return assets;
}

async function runTask(task) {
  const sandbox = mkdtempSync(join(tmpdir(), 'evaluation-worker-'));
  try {
    const engineRoot = await materializeEngine(task.engine);
    const workspace = await materializeWorkspace(task, sandbox);
    const scratch = join(sandbox, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const outputPath = join(sandbox, 'result.json');
    const inputPath = join(sandbox, 'input.json');
    writeFileSync(inputPath, JSON.stringify({
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      engine: {
        id: task.engine.id,
        version: task.engine.version,
        source: task.engine.source,
        packageHash: task.engine.packageHash,
        packageRoot: engineRoot,
        assets: absoluteAssets(task, engineRoot),
      },
      challenge: task.challenge,
      grading: { runId: task.runId, idempotencyKey: task.idempotencyKey, triggerType: task.triggerType, attempt: task.attempt },
      subject: task.subject,
      submission: {
        id: task.submission.id,
        sourceType: task.submission.sourceType,
        snapshotHash: task.submission.snapshotHash,
        ...(task.submission.artifactHash ? { artifactHash: task.submission.artifactHash } : {}),
        ...(task.submission.repository ? { repository: task.submission.repository } : {}),
        ...(task.submission.branch ? { branch: task.submission.branch } : {}),
        ...(task.submission.commitSha ? { commitSha: task.submission.commitSha } : {}),
        submittedAt: task.submission.submittedAt,
      },
      workspace,
      outputPath,
      scratchDir: scratch,
      limits: task.engine.limits,
      params: task.engine.params ?? {},
    }, null, 2), 'utf8');

    execFileSync(python, [
      launcher,
      '--entry', join(engineRoot, task.engine.entrypoint),
      '--input', inputPath,
      '--output', outputPath,
      '--cwd', scratch,
      '--python', python,
      '--memory-mb', String(task.engine.limits.memoryMB),
      '--cpu-seconds', String(task.engine.limits.wallClockSeconds),
      '--wall-seconds', String(task.engine.limits.wallClockSeconds),
      '--output-bytes', String(task.engine.limits.outputBytes),
    ], { cwd: root, windowsHide: true, stdio: 'pipe' });

    if (!existsSync(outputPath)) throw new Error('引擎没有产出结果文件');
    return JSON.parse(readFileSync(outputPath, 'utf8'));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function pump() {
  const response = await call('/evaluation-tasks:lease', { method: 'POST', body: JSON.stringify({ workerId, limit: Number(options.get('batch') ?? 1) }) });
  const { tasks } = await response.json();
  for (const task of tasks) {
    console.log(`[${workerId}] 领取 ${task.runId} · ${task.engine.source} ${task.engine.id}@${task.engine.version}`);
    try {
      const result = await runTask(task);
      await call(`/evaluation-tasks/${task.runId}/complete`, { method: 'POST', body: JSON.stringify({ leaseId: task.leaseId, result }) });
      console.log(`[${workerId}] 完成 ${task.runId} · total=${result.total}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[${workerId}] 失败 ${task.runId}: ${reason}`);
      await call(`/evaluation-tasks/${task.runId}/fail`, { method: 'POST', body: JSON.stringify({ leaseId: task.leaseId, reason }) }).catch(() => undefined);
    }
  }
  return tasks.length;
}

console.log(`[${workerId}] 评测环境已启动 · API ${api}${once ? ' · 单次模式' : ` · 轮询 ${intervalSeconds}s`}`);
do {
  const handled = await pump().catch((error) => {
    console.error(`[${workerId}] 领取任务失败: ${error.message}`);
    return 0;
  });
  if (once) break;
  if (!handled) await new Promise((done) => setTimeout(done, intervalSeconds * 1000));
} while (true);
