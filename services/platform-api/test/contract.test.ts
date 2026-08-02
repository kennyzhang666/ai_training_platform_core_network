import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEvaluationResult } from '../src/contract-validator';

const root = join(__dirname, '..', '..', '..');

test('evaluation result fixture is accepted by the Node contract validator', () => {
  const fixture = JSON.parse(readFileSync(join(root, 'contracts', 'examples', 'evaluation-result.valid.json'), 'utf8'));
  assert.deepEqual(validateEvaluationResult(fixture), []);
});

test('invalid evaluation result is rejected by the Node contract validator', () => {
  const fixture = JSON.parse(readFileSync(join(root, 'contracts', 'examples', 'evaluation-result.invalid.json'), 'utf8'));
  assert.ok(validateEvaluationResult(fixture).length > 0);
});

test('OpenAPI documents every controller route and method', () => {
  const controller = readFileSync(join(root, 'services', 'platform-api', 'src', 'controllers.ts'), 'utf8');
  const implemented = [...controller.matchAll(/@(Get|Post|Patch|Put|Delete)\('([^']+)'\)/g)]
    .map((match) => `${match[1].toUpperCase()} /api/v1${match[2].replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}')}`)
    .sort();

  const documented: string[] = [];
  let currentPath = '';
  for (const line of readFileSync(join(root, 'contracts', 'openapi.yaml'), 'utf8').split(/\r?\n/)) {
    const path = /^  (\/api\/v1\/.*):$/.exec(line);
    if (path) {
      currentPath = path[1];
      continue;
    }
    const method = /^    (get|post|patch|put|delete):$/.exec(line);
    if (currentPath && method) documented.push(`${method[1].toUpperCase()} ${currentPath}`);
  }

  assert.deepEqual([...new Set(documented)].sort(), [...new Set(implemented)].sort());
});
