import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the employee shell does not eagerly fetch one full report per submission', async () => {
  const source = await readFile(join(root, 'src', 'main.tsx'), 'utf8');
  const refresh = source.slice(source.indexOf('  async function refresh()'), source.indexOf('  async function loadProfileHistory'));
  const openReport = source.slice(source.indexOf('  async function openReport'), source.indexOf('  const challengeCards'));

  assert.doesNotMatch(refresh, /request<Report>\(`\/reports\/\$\{item\.id\}`\)/);
  assert.doesNotMatch(refresh, /Promise\.all\(loadedSubmissionPage\.items/);
  assert.match(openReport, /request<Report>\(`\/reports\/\$\{submissionId\}`\)/);
  assert.match(source, /resultSummary\.total/);
});
