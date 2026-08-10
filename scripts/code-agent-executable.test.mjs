import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executableIsAllowed, resolveSpawnExecutable } from './code-agent-executable.mjs';

test('Windows npm command shims resolve to the native executable without a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-training-code-agent-'));
  try {
    const executable = join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    const shim = join(root, 'opencode.cmd');
    await mkdir(join(root, 'node_modules', 'opencode-ai', 'bin'), { recursive: true });
    await writeFile(executable, 'fixture');
    await writeFile(shim, '@ECHO off\r\n"%~dp0\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n');

    const resolved = resolveSpawnExecutable('opencode', {
      platform: 'win32',
      lookup: () => [shim],
    });
    assert.equal(resolved, resolve(executable));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell-only wrappers are rejected because the Worker never uses a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-training-code-agent-'));
  try {
    const wrapper = join(root, 'agent.ps1');
    await writeFile(wrapper, 'Write-Output ok');
    assert.throws(
      () => resolveSpawnExecutable('agent', { platform: 'win32', lookup: () => [wrapper] }),
      /原生可执行文件|PowerShell/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the executable allowlist treats a configured command and its native extension as the same tool', () => {
  assert.equal(executableIsAllowed('C:\\tools\\opencode.exe', ['opencode']), true);
  assert.equal(executableIsAllowed('/opt/bin/opencode', ['opencode']), true);
  assert.equal(executableIsAllowed('other-agent.exe', ['opencode']), false);
});
