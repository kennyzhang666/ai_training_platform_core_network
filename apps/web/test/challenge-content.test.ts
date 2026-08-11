import test from 'node:test';
import assert from 'node:assert/strict';
import { challengeCardSummary, markdownToSafeHtml } from '../src/challenge-content';

test('训战卡片只使用独立简介并限制展示长度', () => {
  const details = '# 赛题详情\n\n' + '很长的评测说明'.repeat(100);
  assert.equal(challengeCardSummary({ summary: '完成流式日志脱敏工具。', description: details, descriptionFormat: 'MARKDOWN' }), '完成流式日志脱敏工具。');
  const fallback = challengeCardSummary({ description: details, descriptionFormat: 'MARKDOWN' });
  assert.ok(fallback.length <= 161);
  assert.doesNotMatch(fallback, /#/);
});

test('Markdown 详情支持题面结构和代码块并转义原始 HTML', () => {
  const html = markdownToSafeHtml([
    '# 输入输出',
    '',
    '- 支持 JSON',
    '- 支持普通文本',
    '',
    '```json',
    '{"token":"abc"}',
    '```',
    '',
    '<script>alert(1)</script>',
  ].join('\n'));
  assert.match(html, /<h1>输入输出<\/h1>/);
  assert.match(html, /<ul><li>支持 JSON<\/li><li>支持普通文本<\/li><\/ul>/);
  assert.match(html, /<pre><code class="language-json">/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('Markdown 链接仅允许 http 和 https 地址', () => {
  const html = markdownToSafeHtml('[规范](https://example.com/spec) [危险](javascript:alert(1))');
  assert.match(html, /href="https:\/\/example\.com\/spec"/);
  assert.doesNotMatch(html, /href="javascript:/);
});
