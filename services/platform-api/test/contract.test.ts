import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { validateEvaluationResult } from '../src/contract-validator';
import { PlatformStore } from '../src/store';

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

// The external-evaluation manifest is declared as a versioned contract but was
// never checked against its own schema, so nothing stopped the platform from
// leaking internal executor paths into it or drifting from the shape external
// evaluators are told to expect.
test('the external evaluation input manifest satisfies evaluation-input.schema.json', () => {
  const store = new PlatformStore(':memory:');
  const event = store.createEvent({
    id: 'event-manifest-contract', challengeVersion: 'parking-fee-01@1',
    submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE',
  }, 'w00123');
  const snapshotHash = 'bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc';
  const submission = store.createSubmission(event.id, 'w00124', { sourceType: 'UPLOAD', snapshotHash, artifactHash: snapshotHash, submittedAt: '2026-08-01T10:00:00Z' });
  const batch = store.prepareEvaluationInput(event.id, [submission.id], 'w00123');

  const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'contracts', 'evaluation-input.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(JSON.parse(JSON.stringify(batch))), true, JSON.stringify(validate.errors));
  // `local` is in-process executor configuration and must stay off the manifest.
  assert.equal((batch.challenge.evaluationEngine as { local?: unknown }).local, undefined);
  assert.equal(store.evaluationEngineForSubmission(submission).local?.entry, 'src/parking.py');
});
