import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { CodeAgentRuntimeConfig, CodeAgentRuntimeInput } from './domain';

const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 8192;
const MAX_PROMPT_LENGTH = 16_000;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 21_600;

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
  return buildCodeAgentRuntimeConfig({ enabled: false, commandLine: '', prompt: '', timeoutSeconds: 3600 }, 'system', '1970-01-01T00:00:00.000Z');
}
