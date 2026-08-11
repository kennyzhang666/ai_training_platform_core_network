import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { CodeAgentRuntimeConfig, CodeAgentRuntimeDiagnostics, CodeAgentRuntimeInput } from './domain';

const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 8192;
const MAX_PROMPT_LENGTH = 16_000;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 21_600;
const DEFAULT_TEST_MAX_TIMEOUT_SECONDS = 120;

/**
 * The administrator form starts with the company Code Agent template.
 * The template is deliberately disabled by default; an administrator must
 * enable and save it after confirming `codeagent` is available on the Worker.
 */
export const DEFAULT_CODE_AGENT_COMMAND = 'codeagent -p "{{prompt}}"';
export const DEFAULT_CODE_AGENT_PROMPT = '';

/**
 * Parse the administrator-facing command line into an executable plus argv.
 * The Worker always uses spawn(..., { shell: false }); this parser exists only
 * to preserve quoted arguments and never implements pipes, expansion or any
 * other shell language.
 */
export function parseCommandLine(commandLine: string): { executable: string; args: string[] } {
  const source = commandLine.trim();
  if (!source) throw new BadRequestException({ code: 'CODE_AGENT_COMMAND_REQUIRED', message: '请配置 Code Agent 启动命令' });
  if (source.length > MAX_COMMAND_LENGTH) throw new BadRequestException({ code: 'CODE_AGENT_COMMAND_TOO_LONG', message: 'Code Agent 启动命令过长' });
  if (/[\u0000\r\n]/.test(source)) throw new BadRequestException({ code: 'CODE_AGENT_COMMAND_MULTILINE', message: 'Code Agent 启动命令必须是单行' });

  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (character === '\\' && source[index + 1] === quote) {
        token += quote;
        tokenStarted = true;
        index += 1;
        continue;
      }
      token += character;
      tokenStarted = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (quote) throw new BadRequestException({ code: 'CODE_AGENT_COMMAND_QUOTE', message: 'Code Agent 启动命令存在未闭合引号' });
  if (tokenStarted) tokens.push(token);
  if (!tokens.length || !tokens[0]) throw new BadRequestException({ code: 'CODE_AGENT_COMMAND_REQUIRED', message: '请配置 Code Agent 启动命令' });
  if (tokens.length - 1 > MAX_ARGUMENTS) throw new BadRequestException({ code: 'CODE_AGENT_ARGUMENTS_LIMIT', message: `Code Agent 启动参数不能超过 ${MAX_ARGUMENTS} 个` });
  if (tokens.some((value) => value.length > MAX_ARGUMENT_LENGTH)) throw new BadRequestException({ code: 'CODE_AGENT_ARGUMENT_TOO_LONG', message: 'Code Agent 单个启动参数过长' });
  if (/\{\{(?:prompt|manifestPath|batchDir)\}\}/.test(tokens[0])) {
    throw new BadRequestException({ code: 'CODE_AGENT_EXECUTABLE_PLACEHOLDER', message: 'Code Agent 可执行文件不能使用占位符' });
  }
  const unknownPlaceholders = source.match(/\{\{[^{}]+\}\}/g)?.filter((value) => !['{{prompt}}', '{{manifestPath}}', '{{batchDir}}'].includes(value)) ?? [];
  if (unknownPlaceholders.length) {
    throw new BadRequestException({ code: 'CODE_AGENT_PLACEHOLDER_INVALID', message: `不支持的命令占位符：${[...new Set(unknownPlaceholders)].join('、')}` });
  }
  return { executable: tokens[0], args: tokens.slice(1) };
}

export function buildCodeAgentRuntimeConfig(
  input: CodeAgentRuntimeInput,
  actorId: string,
  updatedAt = new Date().toISOString(),
): CodeAgentRuntimeConfig {
  const enabled = Boolean(input.enabled);
  const commandLine = String(input.commandLine ?? '').trim();
  const prompt = String(input.prompt ?? '').trim();
  const timeoutSeconds = Number(input.timeoutSeconds ?? 3600);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < MIN_TIMEOUT_SECONDS || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new BadRequestException({ code: 'CODE_AGENT_TIMEOUT_INVALID', message: `Code Agent 批次超时必须在 ${MIN_TIMEOUT_SECONDS}–${MAX_TIMEOUT_SECONDS} 秒之间` });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) throw new BadRequestException({ code: 'CODE_AGENT_PROMPT_TOO_LONG', message: 'Code Agent 任务指令过长' });
  const parsed = commandLine ? parseCommandLine(commandLine) : { executable: '', args: [] as string[] };
  if (enabled && !parsed.executable) throw new BadRequestException({ code: 'CODE_AGENT_COMMAND_REQUIRED', message: '启用平台配置前请填写 Code Agent 启动命令' });
  const stable = { enabled, commandLine, executable: parsed.executable, args: parsed.args, prompt, timeoutSeconds };
  return {
    schemaVersion: '1.0',
    ...stable,
    configHash: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
    updatedAt,
    updatedBy: actorId,
  };
}

export function defaultCodeAgentRuntimeConfig(): CodeAgentRuntimeConfig {
  return buildCodeAgentRuntimeConfig({
    enabled: false,
    commandLine: DEFAULT_CODE_AGENT_COMMAND,
    prompt: DEFAULT_CODE_AGENT_PROMPT,
    timeoutSeconds: 3600,
  }, 'system', '1970-01-01T00:00:00.000Z');
}

function allowedExecutables(environment: NodeJS.ProcessEnv = process.env): string[] {
  return (environment.CODE_AGENT_ALLOWED_EXECUTABLES ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function executableIsAllowed(executable: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const normalized = executable.trim().toLowerCase();
  const name = normalized.split(/[\\/]/).pop() ?? normalized;
  const portableName = name.replace(/\.(?:exe|com|cmd|bat|ps1)$/i, '');
  return allowed.some((entry) => {
    const configured = entry.trim().toLowerCase();
    const configuredName = configured.split(/[\\/]/).pop() ?? configured;
    const portableConfigured = configuredName.replace(/\.(?:exe|com|cmd|bat|ps1)$/i, '');
    return configured === normalized || configuredName === name || portableConfigured === portableName;
  });
}

function redactWorkerArgument(value: string, previous: string | undefined): string {
  if (/(?:token|key|secret|password|cookie|authorization)/i.test(previous ?? '') || /(?:token|key|secret|password|cookie|authorization)[=:]/i.test(value)) return '[REDACTED]';
  return value.length > 256 ? `${value.slice(0, 256)}…` : value;
}

function testTimeoutLimit(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.CODE_AGENT_RUNTIME_TEST_MAX_SECONDS ?? DEFAULT_TEST_MAX_TIMEOUT_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_TEST_MAX_TIMEOUT_SECONDS;
  return Math.max(10, Math.min(300, Math.floor(configured)));
}

/**
 * Return the effective Worker source without exposing its complete command
 * line. A Worker started with `--agent-command` owns that value in its own
 * process and the API deliberately reports it as not observable.
 */
export function codeAgentRuntimeDiagnostics(platform: CodeAgentRuntimeConfig, environment: NodeJS.ProcessEnv = process.env): CodeAgentRuntimeDiagnostics {
  const defaults = defaultCodeAgentRuntimeConfig();
  const allowlist = allowedExecutables(environment);
  // The pull Worker keeps its fallback executable and fixed arguments in
  // separate variables, matching scripts/evaluation-worker.mjs.
  const localCommand = environment.CODE_AGENT_COMMAND?.trim() ?? '';
  let localArgs: string[] = [];
  let localExecutable: string | null = null;
  let localCommandError = '';
  if (localCommand) {
    if (/[\u0000\r\n]/.test(localCommand)) localCommandError = 'Worker 本地可执行文件必须是单行路径';
    else localExecutable = localCommand;
  }
  const rawArgs = environment.CODE_AGENT_ARGS_JSON?.trim();
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) throw new Error('CODE_AGENT_ARGS_JSON 必须是字符串数组');
      localArgs = parsed.map((value, index) => redactWorkerArgument(value, parsed[index - 1] as string | undefined));
    } catch (error) {
      localCommandError = error instanceof Error ? error.message : String(error);
    }
  }

  const platformConfigured = platform.enabled && Boolean(platform.executable);
  const platformAllowed = platformConfigured && executableIsAllowed(platform.executable, allowlist);
  const environmentConfigured = Boolean(localExecutable);
  const environmentAllowed = environmentConfigured && !localCommandError && executableIsAllowed(localExecutable!, allowlist);
  const source = platformConfigured ? 'PLATFORM' : environmentConfigured ? 'ENVIRONMENT' : 'NONE';
  const canResolveExecutable = source === 'PLATFORM' ? platformAllowed : source === 'ENVIRONMENT' ? environmentAllowed : false;
  const reason = source === 'PLATFORM'
    ? (platformAllowed ? '批次会使用已冻结的平台配置。' : '平台可执行文件不在 CODE_AGENT_ALLOWED_EXECUTABLES 允许列表中。')
    : localCommandError
      ? `Worker 本地配置无法解析：${localCommandError}`
      : source === 'ENVIRONMENT'
        ? (environmentAllowed ? '平台配置未启用，Worker 会回退到 CODE_AGENT_COMMAND。' : 'Worker 本地可执行文件不在允许列表中。')
        : '没有可解析的可执行文件。请启用平台配置，或在 Worker 主机设置 CODE_AGENT_COMMAND。命令行 --agent-command 仅在 Worker 进程内可见。';
  const testEnabled = environment.CODE_AGENT_RUNTIME_TEST_ENABLED === 'true';
  const maxTimeoutSeconds = testTimeoutLimit(environment);
  const testCanExecute = testEnabled && environment.NODE_ENV !== 'production' && platformConfigured && platformAllowed;
  const testReason = environment.NODE_ENV === 'production'
    ? '生产环境禁止 API 进程启动 Code Agent；请在 Worker 主机执行测试。'
    : !testEnabled
      ? '运行测试默认关闭。仅在受控开发环境设置 CODE_AGENT_RUNTIME_TEST_ENABLED=true。'
      : !platformConfigured
        ? '请先保存一份启用的平台配置，测试只使用管理员当前填写的配置。'
        : !platformAllowed
          ? '平台可执行文件不在 CODE_AGENT_ALLOWED_EXECUTABLES 允许列表中。'
          : '可以使用合成批次清单执行一次受控连通性测试。';

  return {
    schemaVersion: '1.0',
    defaults: {
      enabled: defaults.enabled,
      commandLine: defaults.commandLine,
      prompt: defaults.prompt,
      timeoutSeconds: defaults.timeoutSeconds,
    },
    platform: { ...platform, args: [...platform.args] },
    worker: {
      mode: environment.EMBEDDED_EVALUATION_WORKER === 'true' ? 'EMBEDDED' : 'EXTERNAL',
      workerId: environment.EVALUATION_WORKER_ID?.trim() || null,
      source,
      commandConfigured: Boolean(localCommand),
      executable: localExecutable,
      args: localArgs,
      commandPreview: localExecutable ? `${localExecutable}${localArgs.length ? ` · ${localArgs.length} 个固定参数` : ''}` : null,
      cliOverrideVisible: false,
      canResolveExecutable,
      reason,
    },
    allowedExecutables: allowlist,
    test: {
      enabled: testEnabled,
      maxTimeoutSeconds,
      canExecute: testCanExecute,
      reason: testReason,
    },
  };
}
