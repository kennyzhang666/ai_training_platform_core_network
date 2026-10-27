import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { validateEvaluationResult } from '../src/contract-validator';
import { checkEvaluationScore } from '../src/score-validator';

const root = resolve(__dirname, '../../..');
const challenge = join(root, 'challenges/coupon-stacking-v1');
const python = process.env.PYTHON ?? (existsSync(join(root, '.venv/Scripts/python.exe')) ? join(root, '.venv/Scripts/python.exe') : 'python');
const kit = join(root, 'tools/engine-dev-kit/tools/engine_dev.py');
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

function verify(schema: string, value: unknown) {
  const validator = ajv.compile(json(join(root, 'contracts', schema)));
  assert.equal(validator(value), true, JSON.stringify(validator.errors));
}

function temporary() { return mkdtempSync(join(tmpdir(), 'coupon-stacking-engine-')); }
function cleanup(folder: string) {
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  assert.ok(basename(folder).startsWith('coupon-stacking-engine-'));
  rmSync(folder, { recursive: true, force: true });
}

test('coupon 赛题定义、交付规范与单份调用样例符合已发布 Schema', () => {
  verify('submission-contract-v1.1.schema.json', json(join(challenge, 'submission-contract.json')));
  verify('engine-invocation.schema.json', json(join(challenge, 'tests/fixtures/invocation.json')));
  verify('evaluation-engine-package.schema.json', json(join(challenge, 'engine/engine.json')));
  assert.equal(json(join(challenge, 'engine/engine.json')).selfCheck.expectMinTotal, 100);
  assert.deepEqual(json(join(challenge, 'engine/assets/submission-contract.json')), json(join(challenge, 'submission-contract.json')));
  assert.match(readFileSync(join(challenge, 'starter/SPEC.md'), 'utf8'), /订单金额达到门槛时可使用满减券/);
  assert.doesNotMatch(readFileSync(join(challenge, 'starter/src/pricing.py'), 'utf8'), /B[1-4]|银行家|缺陷/);
});

test('coupon 可上传包对全部校准交付件评分，结果通过平台格式与重算检查', { timeout: 240_000 }, () => {
  const folder = temporary();
  try {
    const archive = join(folder, 'engine.zip');
    execFileSync(process.execPath, [join(root, 'scripts/build-engine-package.mjs'), 'coupon-stacking-v1', '--out', archive], { cwd: root, windowsHide: true, stdio: 'pipe' });
    execFileSync(python, [kit, 'validate', archive], { cwd: root, windowsHide: true, stdio: 'pipe' });
    execFileSync(python, ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); assert not any(n.startswith(("calibration/","starter/")) for n in names); assert "assets/oracle/tests/test_quote.py" in names; assert "run_batch.py" in names', archive], { windowsHide: true, stdio: 'pipe' });
    const scores: Record<string, number> = {};
    for (const name of ['oracle', 'ai-direct', 'spec-guess', 'snapshot', 'legacy-only', 'happy-path', 'assert-false', 'cheat', 'flaky']) {
      const resultPath = join(folder, `${name}.json`);
      execFileSync(python, [kit, 'run', archive, '--workspace', join(challenge, name === 'oracle' ? 'engine/assets/oracle' : `calibration/${name}`), '--output', resultPath], { cwd: root, windowsHide: true, stdio: 'pipe' });
      const result = json(resultPath);
      assert.deepEqual(validateEvaluationResult(result), [], name);
      assert.deepEqual(checkEvaluationScore(result).errors, [], name);
      assert.equal(result.criteria.length, 16);
      scores[name] = result.total;
      assert.doesNotMatch(JSON.stringify(result), /variants\/|(?<![A-Za-z0-9])M\d{2}(?![A-Za-z0-9])/);
      if (name === 'oracle') {
        assert.equal(result.total, 100);
        assert.equal(result.verifyDetail.mutation.killed, 40);
        assert.equal(result.status, 'COMPLETE');
      }
      if (name === 'ai-direct') assert.ok(result.total <= 60);
      if (name === 'spec-guess') assert.ok(result.metrics.misreadGaps >= 2);
      if (name === 'snapshot') assert.ok(result.dimensions.verify.score <= 5);
      if (name === 'legacy-only') { assert.equal(result.metrics.outdatedAssertions, 2); assert.equal(result.metrics.fixedBugAssertions, 1); }
      if (name === 'happy-path') assert.ok(result.criteria.filter((c: {key: string}) => ['V2', 'V3'].includes(c.key)).reduce((sum: number, c: {score: number}) => sum + c.score, 0) <= 6);
      if (['assert-false', 'cheat'].includes(name)) assert.equal(result.dimensions.verify.score, 0);
      if (name === 'flaky') assert.ok(result.verifyDetail.unstableTests.length > 0);
    }
    console.log('coupon calibration scores:', JSON.stringify(scores));
  } finally { cleanup(folder); }
});

test('coupon 批次适配器按实际目录生成合法索引，拒绝越界结果且继续其余学员', { timeout: 120_000 }, () => {
  const folder = temporary();
  try {
    const manifestPath = join(folder, 'batch-manifest.json');
    const manifest = {
      schemaVersion: '1.1', generatedAt: '2026-10-27T00:00:00Z',
      batch: { id: 'batch-coupon-synthetic', leaseId: 'lease-coupon-synthetic', challengeVersion: 'coupon-stacking@1' },
      agent: { instructionPath: join(challenge, 'engine/instruction.md'), skillPaths: [join(challenge, 'engine/skills/evaluation')] },
      contracts: Object.fromEntries(['input', 'output'].map(name => [name, { format: 'JSON', schemaVersion: name === 'input' ? '1.1' : '1.0', sourcePath: `contracts/${name}.schema.json`, path: join(folder, `${name}.schema.json`), sha256: 'a'.repeat(64) }])),
      engine: { id: 'coupon-stacking-evaluator', version: '1.0.0', source: 'PACKAGE', packageHash: 'a'.repeat(64), root: join(challenge, 'engine'), entrypoint: join(challenge, 'engine/judge.py'), assets: {}, params: {}, limits: {wallClockSeconds: 240} },
      challenge: { id: 'coupon-stacking', challengeVersion: 'coupon-stacking@1', rubricVersion: '1.0', zone: 'YELLOW' },
      submissions: [0, 1, 2].map(i => ({ runId: `run-coupon-${i}`, idempotencyKey: String(i+1).repeat(64), triggerType: 'MANUAL', attempt: 1, subject: {id: `synthetic-${i}`}, submission: {id: `submission-coupon-${i}`, sourceType: 'UPLOAD', snapshotHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64), submittedAt: '2026-10-27T00:00:00Z'}, workspace: join(challenge, i === 1 ? 'engine/assets/oracle' : 'calibration/happy-path'), outputPath: join(folder, i === 0 ? 'rejected.json' : `results/run-coupon-${i}.json`), scratchDir: join(folder, `submissions/${i}/scratch`) })),
      resultIndexPath: join(folder, 'results/index.json'),
    };
    verify('evaluation-agent-batch-v1.1.schema.json', manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    execFileSync(python, ['-I', join(challenge, 'engine/run_batch.py'), '--manifest', manifestPath], { cwd: root, windowsHide: true, stdio: 'pipe' });
    const index = json(manifest.resultIndexPath);
    verify('evaluation-agent-result-index.schema.json', index);
    assert.equal(index.batchId, manifest.batch.id);
    assert.equal(index.results.length, 2);
    assert.deepEqual(index.failures.map((row: {runId: string}) => row.runId), ['run-coupon-0']);
    for (const row of index.results) {
      assert.match(row.resultPath, /^results\//);
      const result = json(join(folder, row.resultPath));
      assert.deepEqual(validateEvaluationResult(result), []);
      assert.deepEqual(checkEvaluationScore(result).errors, []);
      assert.equal(result.gradingRunId, row.runId);
    }
    const duplicate = { ...manifest, submissions: [manifest.submissions[1], manifest.submissions[1]] };
    writeFileSync(manifestPath, JSON.stringify(duplicate));
    assert.throws(() => execFileSync(python, ['-I', join(challenge, 'engine/run_batch.py'), '--manifest', manifestPath], { windowsHide: true, stdio: 'pipe' }));
  } finally { cleanup(folder); }
});
