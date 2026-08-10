import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub builds, smoke-tests and publishes the Linux amd64 Docker delivery', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'release-docker-linux-amd64.yml'), 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: ubuntu-22\.04/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /docker buildx build/);
  assert.match(workflow, /--platform linux\/amd64/);
  assert.match(workflow, /docker compose[^\n]*up -d --wait/);
  assert.match(workflow, /docker compose[^\n]*logs --no-color --tail 300/);
  assert.match(workflow, /ghcr\.io/);
  assert.match(workflow, /docker save/);
  assert.match(workflow, /docker load/);
  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
});
