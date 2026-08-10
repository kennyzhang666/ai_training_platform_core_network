import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub workflow builds tagged releases on native Ubuntu 22.04 and publishes both assets', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'release-linux-ubuntu-22.04.yml'), 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
  assert.match(workflow, /permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /runs-on: ubuntu-22\.04/);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /node --test scripts\/single-node-deployment\.test\.mjs/);
  assert.doesNotMatch(workflow, /pnpm deployment:test/);
  assert.match(workflow, /cp tooling\/scripts\/build-single-node-release\.mjs source\/scripts\/build-single-node-release\.mjs/);
  assert.match(workflow, /RELEASE_TOOLING_SHA/);
  assert.match(workflow, /mkdir -p release/);
  assert.match(workflow, /pnpm release:build \\\n/);
  assert.doesNotMatch(workflow, /pnpm release:build -- \\\n/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /checksum="\$\{archive\}\.sha256"/);
  assert.match(workflow, /gh release (?:create|upload)/);
  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /--verify-tag/);
});

test('Linux runtime preparation is pinned, checksummed and restricted to Ubuntu 22.04 x64', async () => {
  const script = await readFile(join(root, 'scripts', 'prepare-linux-release-runtime.sh'), 'utf8');

  assert.match(script, /NODE_VERSION=['"]22\.23\.2['"]/);
  assert.match(script, /PYTHON_VERSION=['"]3\.11\.15['"]/);
  assert.match(script, /NGINX_VERSION=['"]1\.30\.4['"]/);
  assert.match(script, /VERSION_ID.*22\.04/);
  assert.match(script, /x86_64/);
  assert.match(script, /sha256sum/);
  assert.match(script, /--proto '=https'/);
  assert.doesNotMatch(script, /curl[^\n]*\|\s*(?:ba)?sh/);
  assert.match(script, /grader\/requirements\.txt/);
  assert.match(script, /services\/ldap3-gateway\/requirements\.txt/);
  assert.match(script, /is_symlink\(\)/);
  assert.match(script, /relative_to\(root\)/);
  assert.match(script, /runtime-provenance\.json/);
});
