import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { CodeAgentRuntimeConfig, CodeAgentRuntimeTestInput, CodeAgentRuntimeTestResult } from './domain';
import { buildCodeAgentRuntimeConfig, codeAgentRuntimeDiagnostics } from './code-agent-runtime';

const OUTPUT_LIMIT = 32 * 1024;
const DEFAULT_MAX_TIMEOUT_SECONDS = 120;

function testTimeoutLimit(): number {
  const configured = Number(process.env.CODE_AGENT_RUNTIME_TEST_MAX_SECONDS ?? DEFAULT_MAX_TIMEOUT_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_TIMEOUT_SECONDS;
  return Math.max(10, Math.min(300, Math.floor(configured)));
}

function redactOutput(value: string): string {
  return value
    .replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, OUTPUT_LIMIT);
}

function mandatoryPrompt(configuredPrompt: string, manifestPath: string): string {
  return [
    configuredPrompt.trim(),
    '这是一次 Code Agent 运行配置连通性测试，不包含任何学员交付件。',
    `测试清单路径：${manifestPath}`,
    '请读取清单并确认你能接收任务指令；测试不要求修改文件或写入评测结果。',
  ].filter(Boolean).join('\n\n');
}

function resolveInvocation(config: CodeAgentRuntimeConfig, manifestPath: string, cwd: string): { command: string; args: string[] } {
  const prompt = mandatoryPrompt(config.prompt, manifestPath);
  let promptInjected = false;
  let manifestInjected = false;
  const values: Record<string, string> = { prompt, manifestPath, batchDir: cwd };
  const args = config.args.map((raw) => raw.replace(/\{\{(prompt|manifestPath|batchDir)\}\}/g, (_match, key: string) => {
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
  if (!promptInjected && !manifestInjected) args.push('--manifest', manifestPath);
  return { command: config.executable, args };
}

function syntheticManifest(manifestPath: string, prompt: string, resultIndexPath: string, assets: { instructionPath: string; skillPath: string; inputContractPath: string; outputContractPath: string; engineRoot: string }): Record<string, unknown> {
  return {
    schemaVersion: '1.1',
    generatedAt: new Date().toISOString(),
    batch: { id: `runtime-test-${randomUUID()}`, leaseId: 'runtime-test', challengeVersion: 'runtime-test' },
    agent: { instructionPath: assets.instructionPath, skillPaths: [assets.skillPath] },
    contracts: {
      input: { format: 'JSON', schemaVersion: '1.0', sourcePath: assets.inputContractPath, path: assets.inputContractPath, sha256: '0'.repeat(64) },
      output: { format: 'JSON', schemaVersion: '1.0', sourcePath: assets.outputContractPath, path: assets.outputContractPath, sha256: '0'.repeat(64) },
    },
    engine: { id: 'runtime-test', version: '0.0.0', source: 'BUILT_IN', packageHash: '0'.repeat(64), root: assets.engineRoot, entrypoint: join(assets.engineRoot, 'test.py'), assets: {}, params: {}, limits: { memoryMB: 256, wallClockSeconds: 60, outputBytes: 32_768 } },
    challenge: { challengeVersion: 'runtime-test', rubricVersion: '0.0', prompt },
    submissions: [],
    resultIndexPath,
    testOnly: true,
  };
}

@Injectable()
export class CodeAgentRuntimeTestService {
  async run(input: CodeAgentRuntimeTestInput, current: CodeAgentRuntimeConfig): Promise<CodeAgentRuntimeTestResult> {
    const config = buildCodeAgentRuntimeConfig({
      enabled: true,
      commandLine: input.commandLine ?? current.commandLine,
      prompt: input.prompt ?? current.prompt,
      timeoutSeconds: input.timeoutSeconds ?? current.timeoutSeconds,
    }, 'runtime-test');
    const diagnostics = codeAgentRuntimeDiagnostics(config);
    const workingDirectory = process.cwd();
    const startedAt = new Date().toISOString();
    if (!diagnostics.test.canExecute) {
      return {
        schemaVersion: '1.0',
        status: 'BLOCKED',
        message: diagnostics.test.reason,
        executable: config.executable || null,
        args: [...config.args],
        workingDirectory,
        manifestPath: null,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
      };
    }

    const directory = await mkdtemp(join(tmpdir(), 'ai-training-code-agent-test-'));
    const manifestPath = join(directory, 'runtime-test-manifest.json');
    const resultIndexPath = join(directory, 'runtime-test-results.json');
    const prompt = mandatoryPrompt(config.prompt, manifestPath);
    await mkdir(join(directory, 'results'), { recursive: true });
    const instructionPath = join(directory, 'instruction.md');
    const skillPath = join(directory, 'skills', 'runtime-test');
    const inputContractPath = join(directory, 'contracts', 'input.schema.json');
    const outputContractPath = join(directory, 'contracts', 'output.schema.json');
    const engineRoot = join(directory, 'engine');
    await mkdir(skillPath, { recursive: true });
    await mkdir(join(directory, 'contracts'), { recursive: true });
    await mkdir(engineRoot, { recursive: true });
    await writeFile(instructionPath, '# Code Agent runtime test\n\nThis is a synthetic connectivity test.\n', 'utf8');
    await writeFile(join(skillPath, 'SKILL.md'), '# Runtime test skill\n\nNo learner delivery is included.\n', 'utf8');
    await writeFile(inputContractPath, JSON.stringify({ type: 'object' }), 'utf8');
    await writeFile(outputContractPath, JSON.stringify({ type: 'object' }), 'utf8');
    await writeFile(manifestPath, JSON.stringify(syntheticManifest(manifestPath, prompt, resultIndexPath, { instructionPath, skillPath, inputContractPath, outputContractPath, engineRoot }), null, 2), 'utf8');
    const invocation = resolveInvocation(config, manifestPath, workingDirectory);
    const timeoutMs = Math.min(config.timeoutSeconds, diagnostics.test.maxTimeoutSeconds) * 1000;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    const executionStarted = Date.now();

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: workingDirectory,
          windowsHide: true,
          shell: false,
          env: { ...process.env, AI_TRAINING_BATCH_MANIFEST: manifestPath, CODE_AGENT_RUNTIME_TEST: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const append = (currentValue: string, chunk: Buffer | string): string => currentValue.length >= OUTPUT_LIMIT ? currentValue : `${currentValue}${chunk.toString()}`.slice(0, OUTPUT_LIMIT);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2_000).unref();
        }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
        child.once('error', reject);
        child.once('close', (code, childSignal) => {
          clearTimeout(timer);
          exitCode = code;
          signal = childSignal;
          resolve();
        });
      });
    } catch (error) {
      stderr = appendError(stderr, error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - executionStarted;
    const status = timedOut ? 'TIMEOUT' : exitCode === 0 ? 'PASS' : 'FAIL';
    const message = timedOut
      ? `Code Agent 测试超过 ${Math.ceil(timeoutMs / 1000)} 秒，已终止进程。`
      : exitCode === 0
        ? 'Code Agent 启动命令和任务指令执行成功。'
        : `Code Agent 进程退出（code=${exitCode ?? 'null'}, signal=${signal ?? 'none'}）。`;
    return {
      schemaVersion: '1.0',
      status,
      message,
      executable: config.executable || null,
      args: [...config.args],
      workingDirectory,
      manifestPath,
      startedAt,
      finishedAt,
      durationMs,
      exitCode,
      signal,
      stdout: redactOutput(stdout),
      stderr: redactOutput(stderr),
    };
  }
}

function appendError(existing: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${existing}${message}`.slice(0, OUTPUT_LIMIT);
}
