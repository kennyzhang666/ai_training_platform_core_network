import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkEvaluationScore } from '../src/score-validator';
import { validateEvaluationResult } from '../src/contract-validator';

const projectRoot = resolve(__dirname, '..', '..', '..');
const challengeRoot = join(projectRoot, 'challenges', 'sdd-log-redaction-v1');
const python = process.env.PYTHON
  ?? (existsSync(join(projectRoot, '.venv', 'Scripts', 'python.exe'))
    ? join(projectRoot, '.venv', 'Scripts', 'python.exe')
    : 'python');

function buildAndRun(workspace: string): Record<string, unknown> {
  const temporary = mkdtempSync(join(tmpdir(), 'sdd-log-redaction-engine-'));
  try {
    const archive = join(temporary, 'engine.zip');
    const output = join(temporary, 'result.json');
    execFileSync(process.execPath, [
      join(projectRoot, 'scripts', 'build-engine-package.mjs'),
      'sdd-log-redaction-v1',
      '--out', archive,
    ], { cwd: projectRoot, windowsHide: true, stdio: 'pipe' });
    execFileSync(python, [
      join(projectRoot, 'tools', 'engine-dev-kit', 'tools', 'engine_dev.py'),
      'validate', archive,
    ], { cwd: projectRoot, windowsHide: true, stdio: 'pipe' });
    execFileSync(python, [
      join(projectRoot, 'tools', 'engine-dev-kit', 'tools', 'engine_dev.py'),
      'run', archive,
      '--workspace', workspace,
      '--output', output,
    ], { cwd: projectRoot, windowsHide: true, stdio: 'pipe' });
    return JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('SDD 运维日志脱敏赛题冻结完整交付契约和评测资产', () => {
  const challenge = readFileSync(join(challengeRoot, 'challenge.yaml'), 'utf8');
  assert.match(challenge, /基于SDD的运维日志脱敏工具开发实战演练/);
  const contract = JSON.parse(readFileSync(join(challengeRoot, 'submission-contract.json'), 'utf8')) as {
    schemaVersion: string;
    required: Array<{ path: string }>;
  };
  assert.equal(contract.schemaVersion, '1.1');
  assert.deepEqual(contract.required.map((item) => item.path), [
    'SPEC.md',
    'README.md',
    'AI_WORKLOG.md',
    'src/log_redactor.py',
    'tests/test_log_redactor.py',
  ]);
});

test('参考交付件通过 16 个评分点并生成契约一致的满分结果', () => {
  const result = buildAndRun(join(challengeRoot, 'reference'));
  assert.deepEqual(validateEvaluationResult(result), []);
  assert.deepEqual(checkEvaluationScore(result).errors, []);
  assert.equal(result.total, 100);
  assert.equal((result.criteria as unknown[]).length, 16);
  assert.equal((result.findings as unknown[]).length, 0);
});

test('合规学员交付件保留可追溯改进项并仍能完成评测', () => {
  const result = buildAndRun(join(challengeRoot, 'sample-submission'));
  assert.deepEqual(validateEvaluationResult(result), []);
  assert.deepEqual(checkEvaluationScore(result).errors, []);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.total, 95.75);
  assert.equal((result.criteria as unknown[]).length, 16);
  assert.ok((result.findings as Array<{ file?: string; line?: number; fix?: string }>).some(
    (finding) => finding.file === 'SPEC.md' && Number.isInteger(finding.line) && Boolean(finding.fix),
  ));
});
