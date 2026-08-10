import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { buildCodeAgentRuntimeConfig, codeAgentRuntimeDiagnostics, defaultCodeAgentRuntimeConfig, DEFAULT_CODE_AGENT_COMMAND, DEFAULT_CODE_AGENT_PROMPT, parseCommandLine } from '../src/code-agent-runtime';
import { PlatformStore } from '../src/store';

test('Code Agent command configuration is tokenized without invoking a shell', () => {
  assert.deepEqual(
    parseCommandLine('codeagent --profile strict --prompt "请评测全部交付件"'),
    {
      executable: 'codeagent',
      args: ['--profile', 'strict', '--prompt', '请评测全部交付件'],
    },
  );
  assert.throws(() => parseCommandLine('codeagent --prompt "未闭合'), /引号/);
  assert.throws(() => parseCommandLine('codeagent\npowershell'), /单行/);
});

test('Code Agent runtime config has a stable hash and validates its limits', () => {
  const input = {
    enabled: true,
    commandLine: 'codeagent --profile strict --prompt "{{prompt}}"',
    prompt: '逐份评测批次中的交付件。',
    timeoutSeconds: 3600,
  };
  const first = buildCodeAgentRuntimeConfig(input, 'w00123', '2026-08-03T01:00:00.000Z');
  const second = buildCodeAgentRuntimeConfig(input, 'w00123', '2026-08-03T02:00:00.000Z');
  assert.equal(first.configHash, second.configHash);
  assert.equal(first.executable, 'codeagent');
  assert.deepEqual(first.args.slice(0, 2), ['--profile', 'strict']);
  assert.throws(() => buildCodeAgentRuntimeConfig({ ...input, timeoutSeconds: 10 }, 'w00123'), /超时/);
});

test('only a global administrator can configure the Code Agent runtime', () => {
  const store = new PlatformStore(':memory:');
  assert.throws(
    () => store.updateCodeAgentRuntimeConfig({ enabled: true, commandLine: 'codeagent --prompt "{{prompt}}"', prompt: '', timeoutSeconds: 3600 }, 'w00134'),
    ForbiddenException,
  );
  const saved = store.updateCodeAgentRuntimeConfig({ enabled: true, commandLine: 'codeagent --prompt "{{prompt}}"', prompt: '执行赛题评测。', timeoutSeconds: 3600 }, 'w00123');
  assert.equal(saved.enabled, true);
  assert.equal(saved.executable, 'codeagent');
});

test('runtime diagnostics exposes defaults and explains the Worker precedence safely', () => {
  const config = defaultCodeAgentRuntimeConfig();
  assert.equal(config.commandLine, 'codeagent --prompt "{{prompt}}"');
  assert.equal(config.prompt, '');
  const diagnostics = codeAgentRuntimeDiagnostics(config);
  assert.equal(diagnostics.schemaVersion, '1.0');
  assert.deepEqual(diagnostics.defaults, {
    enabled: false,
    commandLine: DEFAULT_CODE_AGENT_COMMAND,
    prompt: DEFAULT_CODE_AGENT_PROMPT,
    timeoutSeconds: 3600,
  });
  assert.equal(diagnostics.platform.configHash, config.configHash);
  assert.equal(diagnostics.worker.cliOverrideVisible, false);
  assert.ok(['PLATFORM', 'ENVIRONMENT', 'NONE'].includes(diagnostics.worker.source));
  assert.equal(typeof diagnostics.test.reason, 'string');
});

test('runtime diagnostics reads the Worker fallback executable and fixed args', () => {
  const diagnostics = codeAgentRuntimeDiagnostics(defaultCodeAgentRuntimeConfig(), {
    CODE_AGENT_COMMAND: 'node',
    CODE_AGENT_ARGS_JSON: '["--profile", "safe"]',
    EMBEDDED_EVALUATION_WORKER: 'false',
  });
  assert.equal(diagnostics.worker.source, 'ENVIRONMENT');
  assert.equal(diagnostics.worker.executable, 'node');
  assert.deepEqual(diagnostics.worker.args, ['--profile', 'safe']);
  assert.equal(diagnostics.worker.canResolveExecutable, true);
});

test('runtime diagnostics treats the Windows native extension as the configured portable command', () => {
  const diagnostics = codeAgentRuntimeDiagnostics(defaultCodeAgentRuntimeConfig(), {
    CODE_AGENT_COMMAND: 'C:\\tools\\codeagent.exe',
    CODE_AGENT_ALLOWED_EXECUTABLES: 'codeagent',
    EMBEDDED_EVALUATION_WORKER: 'false',
  });
  assert.equal(diagnostics.worker.source, 'ENVIRONMENT');
  assert.equal(diagnostics.worker.canResolveExecutable, true);
});

test('an evaluation batch freezes the Code Agent runtime selected at creation', () => {
  const store = new PlatformStore(':memory:');
  const original = store.updateCodeAgentRuntimeConfig({ enabled: true, commandLine: 'codeagent --profile policy-a --prompt "{{prompt}}"', prompt: '执行评测。', timeoutSeconds: 3600 }, 'w00123');
  const submission = store.createSubmission('event-local', 'w00124', {
    sourceType: 'UPLOAD', snapshotHash: '7'.repeat(64), artifactHash: '8'.repeat(64), submittedAt: '2026-08-03T01:00:00.000Z',
  });
  const run = store.startGrading(submission.id, 'w00123');
  const batch = store.createEvaluationBatch([run.id], 'w00123');
  store.updateCodeAgentRuntimeConfig({ enabled: true, commandLine: 'codeagent --profile policy-b --prompt "{{prompt}}"', prompt: '执行评测。', timeoutSeconds: 3600 }, 'w00123');

  assert.equal(batch.codeAgentRuntime?.configHash, original.configHash);
  assert.deepEqual(batch.codeAgentRuntime?.args.slice(0, 2), ['--profile', 'policy-a']);
});
