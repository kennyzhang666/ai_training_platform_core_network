import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub workflow builds tagged releases and a verified Linux hotfix on native Ubuntu 22.04', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'release-linux-ubuntu-22.04.yml'), 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
  assert.match(workflow, /permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /runs-on: ubuntu-22\.04/);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /services:\s*\n\s*postgres:\s*\n\s*image: postgres:14/);
  assert.match(workflow, /POSTGRES_INTEGRATION: ['"]true['"]/);
  assert.match(workflow, /pnpm --filter @ai-training\/platform-api test:integration:postgres/);
  assert.match(workflow, /node --test scripts\/single-node-deployment\.test\.mjs/);
  assert.doesNotMatch(workflow, /pnpm deployment:test/);
  assert.match(workflow, /cp tooling\/scripts\/build-single-node-release\.mjs source\/scripts\/build-single-node-release\.mjs/);
  assert.match(workflow, /cp tooling\/scripts\/build-linux-hotfix\.mjs source\/scripts\/build-linux-hotfix\.mjs/);
  assert.match(workflow, /cp tooling\/scripts\/linux-hotfix\.test\.mjs source\/scripts\/linux-hotfix\.test\.mjs/);
  assert.match(workflow, /RELEASE_TOOLING_SHA/);
  assert.match(workflow, /mkdir -p release/);
  assert.match(workflow, /pnpm release:build \\\n/);
  assert.match(workflow, /node scripts\/build-linux-hotfix\.mjs --version "\$RELEASE_VERSION"/);
  assert.match(workflow, /hotfix-linux-x64\.tar\.gz/);
  assert.match(workflow, /bash -n "\$hotfix_unpacked\/apply-hotfix\.sh"/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/);
  assert.doesNotMatch(workflow, /pnpm release:build -- \\\n/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /checksum="\$\{archive\}\.sha256"/);
  assert.match(workflow, /require\(['"]@prisma\/client['"]\)/);
  assert.match(workflow, /libquery_engine-debian-openssl-3\.0\.x\.so\.node/);
  assert.match(workflow, /PRISMA_QUERY_ENGINE_LIBRARY/);
  assert.match(workflow, /PRISMA_SCHEMA_ENGINE_BINARY/);
  assert.match(workflow, /schema-engine-debian-openssl-3\.0\.x/);
  assert.match(workflow, /migrate deploy/);
  assert.match(workflow, /bash -n "\$unpacked\/upgrade\.sh"/);
  assert.match(workflow, /offline-upgrade-helper\.py/);
  assert.match(workflow, /cp tooling\/scripts\/offline-upgrade-helper\.py source\/scripts\/offline-upgrade-helper\.py/);
  assert.match(workflow, /cp tooling\/deploy\/single-node\/upgrade\.sh source\/deploy\/single-node\/upgrade\.sh/);
  assert.match(workflow, /cp tooling\/deploy\/single-node\/upgrade\.ps1 source\/deploy\/single-node\/upgrade\.ps1/);
  assert.match(workflow, /PYTHONDONTWRITEBYTECODE: ['"]1['"]/);
  assert.match(workflow, /database-backup --environment-file/);
  assert.match(workflow, /database-restore --environment-file/);
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
