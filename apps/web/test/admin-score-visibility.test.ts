import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// GET /submissions has always carried `resultSummary.total` for a graded
// delivery, and the employee shell renders it. The administration console
// dropped it entirely, so an operator could see that an evaluation had
// finished but never what it scored — the only way to read a score was to
// ask the participant or query the database.
test('评测中心列表显示评测总分而不只是状态', async () => {
  const source = await readFile(join(root, 'src', 'admin.tsx'), 'utf8');
  assert.match(source, /type SubmissionResultSummary = \{[^}]*total: number/, '管理端类型必须包含分数投影');
  assert.match(source, /resultSummary\?: SubmissionResultSummary/, 'Submission 必须携带 resultSummary');
  assert.match(source, /className="grading-score"/, '提交行必须渲染分数');
  const row = source.slice(source.indexOf('const scoreText'), source.indexOf('const toggleSubmissionDetails'));
  assert.match(row, /if \(!submission\.resultId\) return null/, '未完成评测不显示分数');
  assert.match(row, /return '未公布'/, '成绩封存时要说明原因而不是显示空白');
});

test('展开提交详情显示各维度得分', async () => {
  const source = await readFile(join(root, 'src', 'admin.tsx'), 'utf8');
  assert.match(source, /request<SubmissionReport>\(`\/reports\/\$\{encodeURIComponent\(submissionId\)\}`\)/, '详情必须按需拉取报告');
  assert.match(source, /grading-score-dimensions/, '详情必须渲染维度得分');
  assert.match(source, /dimensionLabel\(key\)/, '维度必须使用中文标签');
  // The list projection has no dimension data, so the fetch must be lazy and
  // must not fire for a submission that has no result at all.
  assert.match(source, /if \(next && submission\.resultId\) void loadReport/, '只有已完成评测才请求报告');
  assert.match(source, /if \(reports\[submissionId\] \|\| reportErrors\[submissionId\]\) return/, '同一份报告不得重复请求');
});

test('分数样式在管理端存在', async () => {
  const styles = await readFile(join(root, 'src', 'styles.css'), 'utf8');
  for (const rule of ['.grading-score ', '.grading-score-panel', '.grading-score-dimension', '.grading-score-note']) {
    assert.ok(styles.includes(rule), `缺少样式：${rule}`);
  }
});
