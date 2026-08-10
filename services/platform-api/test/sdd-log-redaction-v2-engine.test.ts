import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkEvaluationScore } from '../src/score-validator';
import { validateEvaluationResult } from '../src/contract-validator';

const projectRoot = resolve(__dirname, '..', '..', '..');
const challengeName = 'sdd-log-redaction-v2';
const challengeRoot = join(projectRoot, 'challenges', challengeName);
const python = process.env.PYTHON
  ?? (existsSync(join(projectRoot, '.venv', 'Scripts', 'python.exe'))
    ? join(projectRoot, '.venv', 'Scripts', 'python.exe')
    : 'python');

function buildAndRun(workspace: string): Record<string, unknown> {
  const temporary = mkdtempSync(join(tmpdir(), 'sdd-log-redaction-v2-engine-'));
  try {
    const archive = join(temporary, 'engine.zip');
    const output = join(temporary, 'result.json');
    execFileSync(process.execPath, [
      join(projectRoot, 'scripts', 'build-engine-package.mjs'),
      challengeName,
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

test('SDD 日志脱敏 v2 冻结进阶题面、策略文件和交付契约', () => {
  const challenge = readFileSync(join(challengeRoot, 'challenge.yaml'), 'utf8');
  assert.match(challenge, /version: 2/);
  assert.match(challenge, /rubricVersion: "2\.0"/);
  assert.match(challenge, /流式批处理/);
  assert.match(challenge, /HMAC/);

  const contract = JSON.parse(readFileSync(join(challengeRoot, 'submission-contract.json'), 'utf8')) as {
    schemaVersion: string;
    required: Array<{ path: string }>;
  };
  assert.equal(contract.schemaVersion, '1.1');
  assert.deepEqual(contract.required.map((item) => item.path), [
    'SPEC.md',
    'README.md',
    'AI_WORKLOG.md',
    'policy/redaction_policy.json',
    'src/log_redactor.py',
    'tests/test_log_redactor.py',
  ]);
});

test('v2 参考交付件通过 24 个评测方隐藏用例并获得满分', () => {
  const result = buildAndRun(join(challengeRoot, 'reference'));
  assert.deepEqual(validateEvaluationResult(result), []);
  assert.deepEqual(checkEvaluationScore(result).errors, []);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.total, 100);
  assert.equal((result.criteria as unknown[]).length, 16);
  assert.equal((result.findings as unknown[]).length, 0);
  assert.deepEqual((result.verifyDetail as { hiddenTests: unknown }).hiddenTests, {
    passed: 24,
    total: 24,
    byTier: {
      core: { passed: 6, total: 6 },
      complex: { passed: 6, total: 6 },
      safety: { passed: 6, total: 6 },
      engineering: { passed: 6, total: 6 },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /hidden-evaluator-secret|13812348000|alice@example\.com/);
});

test('v2 隐藏用例能识别规格完整但实现停留在 v1 的交付件', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'sdd-log-redaction-v2-weak-'));
  try {
    cpSync(join(challengeRoot, 'reference'), temporary, { recursive: true });
    cpSync(
      join(challengeRoot, 'test-fixtures', 'v1-style-log-redactor.py'),
      join(temporary, 'src', 'log_redactor.py'),
    );
    const result = buildAndRun(temporary);
    assert.deepEqual(validateEvaluationResult(result), []);
    assert.deepEqual(checkEvaluationScore(result).errors, []);
    assert.equal(result.status, 'COMPLETE');
    assert.ok(Number(result.total) <= 75, `弱实现不应得到 ${String(result.total)} 分`);
    const hidden = (result.verifyDetail as {
      hiddenTests: { passed: number; total: number };
    }).hiddenTests;
    assert.equal(hidden.total, 24);
    assert.ok(hidden.passed <= 10, `弱实现意外通过 ${hidden.passed} 个隐藏用例`);
    assert.ok((result.findings as Array<{ file?: string; detail?: string }>).some(
      (finding) => finding.file === 'src/log_redactor.py' && /隐藏用例/.test(finding.detail ?? ''),
    ));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
