import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('a global administrator can initialize the first organization in an empty production database', async () => {
  const source = await readFile(join(root, 'src', 'admin.tsx'), 'utf8');
  assert.match(source, /canInitializeOrganization\s*=\s*adminAccess\.level === 'GLOBAL' && orgUnits\.length === 0/);
  assert.match(source, /初始化组织/);
  assert.match(source, /unitForm\.parentId \? \{ parentId: unitForm\.parentId \} : \{\}/);
});
