import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { preferredSeasonId } from '../src/season';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the employee site prefers a running season and supports a new empty database', () => {
  assert.equal(preferredSeasonId([
    { id: 'season-draft', status: 'DRAFT' },
    { id: 'season-running', status: 'RUNNING' },
  ]), 'season-running');
  assert.equal(preferredSeasonId([{ id: 'season-closed', status: 'CLOSED' }]), 'season-closed');
  assert.equal(preferredSeasonId([]), null);
});

test('the production employee site never requests a local demo season', async () => {
  const source = await readFile(join(root, 'src', 'main.tsx'), 'utf8');
  assert.doesNotMatch(source, /season-local-2026/);
  assert.match(source, /request<SeasonSummary\[]>\('\/seasons'\)/);
  assert.match(source, /preferredSeasonId/);
});
