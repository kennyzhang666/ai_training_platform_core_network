import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const root = join(__dirname, '..', '..', '..');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function validatorFor(name: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(join(root, 'contracts', `${name}.schema.json`), 'utf8'));
  return ajv.compile(schema);
}

const evaluationResultValidator = validatorFor('evaluation-result');

export function validateEvaluationResult(result: unknown): string[] {
  const valid = evaluationResultValidator(result);
  if (valid) return [];
  return (evaluationResultValidator.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message ?? 'invalid'}`);
}
