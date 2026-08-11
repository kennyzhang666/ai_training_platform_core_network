import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_TARGETS,
  assembleReleaseLayout,
  assertNodeRuntimeIdentity,
  assertPythonRuntimeIdentity,
  createReleaseArchive,
  parseReleaseArguments,
  resolvePnpmInvocation,
  verifyReleaseLayout,
} from './build-single-node-release.mjs';

async function put(root, path, content = path) {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture(root) {
  const sourceRoot = join(root, 'source');
  const apiDeployRoot = join(root, 'api-deploy');
  const wheelhouseRoot = join(root, 'wheelhouse');

  for (const path of [
    'apps/web/dist/index.html',
    'contracts/evaluation-result.schema.json',
    'docs/evaluation-contract-authoring.md',
    'grader/src/drill_grader/__init__.py',
    'grader/profiles/yellow.yaml',
    'grader/profiles/blue.yaml',
    'sandbox/launch.py',
    'scripts/evaluation-worker.mjs',
    'scripts/log-redaction.mjs',
    'scripts/safe-archive-extract.py',
    'scripts/code-agent-executable.mjs',
    'scripts/prepare-single-node-environment.mjs',
    'services/ldap3-gateway/ldap3_gateway.py',
    'services/ldap3-gateway/requirements.txt',
    'services/ldap3-gateway/static/login.html',
    'deploy/single-node/manage.ps1',
    'deploy/single-node/manage.cmd',
    'deploy/single-node/manage.sh',
    'deploy/single-node/nginx-http.conf.template',
    'deploy/release/windows.env.example',
    'deploy/release/linux.env.example',
    'install.cmd',
    'install.sh',
    'DEPLOYMENT.html',
  ]) await put(sourceRoot, path);
  await put(sourceRoot, 'executors/drill-grader/engine.json', JSON.stringify({
    schemaVersion: '1.0',
    id: 'drill-grader',
    version: '0.3.1',
    runtime: { type: 'python', entrypoint: 'judge.py' },
    platformDependencies: {
      graderSource: 'grader/src/drill_grader',
      graderProfiles: 'grader/profiles',
    },
  }));
  await put(sourceRoot, 'executors/drill-grader/judge.py');
  await put(sourceRoot, '.env', 'DATABASE_URL=do-not-package');

  for (const path of [
    'dist/main.js',
    'node_modules/.prisma/client/default.js',
    'node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node',
    'node_modules/.prisma/client/query_engine-windows.dll.node',
    'node_modules/@prisma/client/index.js',
    'node_modules/prisma/build/index.js',
    'node_modules/runtime-dependency/src/index.js',
    'prisma/schema.prisma',
    'prisma/migrations/0016/example.sql',
    'scripts/backup-postgres.mjs',
    'scripts/restore-postgres.mjs',
    'package.json',
  ]) await put(apiDeployRoot, path, path === 'package.json' ? '{"name":"@ai-training/platform-api"}' : path);
  await put(apiDeployRoot, `node_modules/runtime-dependency/dist/${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/${'d'.repeat(60)}/index.js`);
  await put(apiDeployRoot, 'src/must-not-ship.ts');
  await put(apiDeployRoot, 'test/must-not-ship.test.ts');
  await put(wheelhouseRoot, 'offline-dependency.whl');
  return { sourceRoot, apiDeployRoot, wheelhouseRoot };
}

async function runtimeFixture(root, target) {
  const runtimeRoot = join(root, `runtime-${target}`);
  for (const path of RELEASE_TARGETS[target].runtimeFiles) await put(runtimeRoot, path, path);
  return runtimeRoot;
}

test('release contract supports Windows x64 and Linux x64 with platform runtimes', () => {
  assert.deepEqual(Object.keys(RELEASE_TARGETS).sort(), ['linux-x64', 'win32-x64']);
  assert.ok(RELEASE_TARGETS['win32-x64'].runtimeFiles.includes('node/node.exe'));
  assert.ok(RELEASE_TARGETS['win32-x64'].runtimeFiles.includes('powershell/pwsh.exe'));
  assert.equal(RELEASE_TARGETS['win32-x64'].runtimeFiles.includes('service/winsw.exe'), false);
  assert.ok(RELEASE_TARGETS['linux-x64'].runtimeFiles.includes('node/bin/node'));
  assert.equal(RELEASE_TARGETS['win32-x64'].archiveExtension, '.zip');
  assert.equal(RELEASE_TARGETS['linux-x64'].archiveExtension, '.tar.gz');
  assert.equal(RELEASE_TARGETS['linux-x64'].prismaEngine, 'libquery_engine-debian-openssl-3.0.x.so.node');
  assert.equal(RELEASE_TARGETS['win32-x64'].prismaEngine, 'query_engine-windows.dll.node');
});

test('Prisma schema pins the Ubuntu 22.04 OpenSSL 3 query engine', async () => {
  const schema = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'services', 'platform-api', 'prisma', 'schema.prisma'), 'utf8');
  assert.match(schema, /binaryTargets\s*=\s*\["native",\s*"debian-openssl-3\.0\.x"\]/);
});

test('release runtime gate rejects unsupported versions and the wrong target architecture', () => {
  assert.doesNotThrow(() => assertNodeRuntimeIdentity({ version: '20.19.0', platform: 'win32', arch: 'x64' }, 'win32-x64'));
  assert.throws(() => assertNodeRuntimeIdentity({ version: '18.20.0', platform: 'win32', arch: 'x64' }, 'win32-x64'), /Node\.js 20/);
  assert.throws(() => assertNodeRuntimeIdentity({ version: '22.1.0', platform: 'linux', arch: 'arm64' }, 'linux-x64'), /linux\/x64/);
  assert.doesNotThrow(() => assertPythonRuntimeIdentity({ version: '3.11.9', system: 'Linux', machine: 'x86_64' }, 'linux-x64'));
  assert.throws(() => assertPythonRuntimeIdentity({ version: '3.10.14', system: 'Linux', machine: 'x86_64' }, 'linux-x64'), /Python 3\.11/);
  assert.throws(() => assertPythonRuntimeIdentity({ version: '3.12.1', system: 'Windows', machine: 'AMD64' }, 'linux-x64'), /Linux x64/);
});

test('release builder creates a portable production dependency tree with pnpm 11', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'build-single-node-release.mjs'), 'utf8');
  assert.match(source, /'--config\.node-linker=hoisted', 'deploy', '--prod', '--legacy', apiDeployRoot/);
  assert.match(source, /'generate', '--schema'/);
  assert.match(source, /import ldap3, jsonschema, yaml/);
  assert.match(source, /verbatimSymlinks: true/);
});

test('release builder launches pnpm through Node on Windows instead of spawning a command shim', () => {
  const invocation = resolvePnpmInvocation({
    platform: 'win32',
    nodeExecutable: 'C:\\runtime\\node.exe',
    environment: { npm_execpath: 'C:\\tools\\pnpm\\bin\\pnpm.cjs' },
    fileExists: () => true,
  });
  assert.deepEqual(invocation, {
    executable: 'C:\\runtime\\node.exe',
    args: ['C:\\tools\\pnpm\\bin\\pnpm.cjs'],
  });
});

test('release CLI accepts pnpm arguments with or without a separator', () => {
  assert.deepEqual(
    [...parseReleaseArguments(['--target', 'linux-x64'])],
    [['target', 'linux-x64']],
  );
  assert.deepEqual(
    [...parseReleaseArguments(['--', '--target', 'linux-x64'])],
    [['target', 'linux-x64']],
  );
});

test('release layout creates a missing output parent on a clean checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-training-release-parent-test-'));
  try {
    const inputs = await fixture(root);
    const runtimeRoot = await runtimeFixture(root, 'linux-x64');
    const outputRoot = join(root, 'release', 'ai-training-platform-test-linux-x64');
    await assembleReleaseLayout({
      ...inputs,
      runtimeRoot,
      outputRoot,
      target: 'linux-x64',
      version: '0.9.2-test',
      sourceDateEpoch: 1_786_320_000,
    });
    assert.equal(existsSync(join(outputRoot, 'release-manifest.json')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const target of ['win32-x64', 'linux-x64']) {
  test(`${target} release contains runtime assets and deployable application only`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-training-release-test-'));
    try {
      const inputs = await fixture(root);
      const runtimeRoot = await runtimeFixture(root, target);
      const outputRoot = join(root, 'output');
      await assembleReleaseLayout({
        ...inputs,
        runtimeRoot,
        outputRoot,
        target,
        version: '0.9.2-test',
        sourceDateEpoch: 1_786_320_000,
      });

      const manifest = await verifyReleaseLayout(outputRoot);
      assert.equal(manifest.target, target);
      assert.equal(manifest.version, '0.9.2-test');
      assert.ok(manifest.files.some((file) => file.path === 'services/platform-api/dist/main.js'));
      assert.ok(manifest.files.some((file) => file.path === 'services/platform-api/node_modules/.prisma/client/default.js'));
      assert.ok(manifest.files.some((file) => file.path === `services/platform-api/node_modules/.prisma/client/${RELEASE_TARGETS[target].prismaEngine}`));
      assert.ok(manifest.files.some((file) => file.path === 'services/platform-api/node_modules/prisma/build/index.js'));
      assert.ok(manifest.files.some((file) => file.path === 'services/platform-api/node_modules/runtime-dependency/src/index.js'));
      assert.ok(manifest.files.some((file) => file.path === 'grader/src/drill_grader/__init__.py'));
      assert.ok(manifest.files.some((file) => file.path === 'grader/profiles/yellow.yaml'));
      assert.ok(manifest.files.some((file) => file.path === 'scripts/code-agent-executable.mjs'));
      assert.ok(manifest.files.some((file) => file.path === 'scripts/log-redaction.mjs'));
      assert.ok(manifest.files.some((file) => file.path === 'scripts/safe-archive-extract.py'));
      assert.ok(manifest.files.some((file) => file.path === 'scripts/prepare-single-node-environment.mjs'));
      assert.ok(manifest.files.some((file) => file.path === RELEASE_TARGETS[target].runtimeFiles[0].replace(/^/, 'runtime/')));
      assert.ok(manifest.files.some((file) => file.path === 'DEPLOYMENT.html'));
      assert.ok(existsSync(join(outputRoot, 'deploy', 'single-node', RELEASE_TARGETS[target].manager)));
      if (target === 'win32-x64') {
        assert.ok(existsSync(join(outputRoot, 'deploy', 'single-node', 'manage.cmd')));
        assert.ok(existsSync(join(outputRoot, 'install.cmd')));
        assert.equal(existsSync(join(outputRoot, 'install.sh')), false);
      }
      if (target === 'linux-x64') {
        assert.ok(existsSync(join(outputRoot, 'install.sh')));
        assert.equal(existsSync(join(outputRoot, 'install.cmd')), false);
      }
      if (target === 'linux-x64' && process.platform !== 'win32') {
        assert.equal(manifest.files.find((file) => file.path === 'deploy/single-node/manage.sh')?.mode, 0o755);
        assert.equal(manifest.files.find((file) => file.path === 'install.sh')?.mode, 0o755);
      }
      assert.equal(existsSync(join(outputRoot, '.env')), false);
      assert.equal(existsSync(join(outputRoot, 'services', 'platform-api', 'src')), false);
      assert.equal(existsSync(join(outputRoot, 'services', 'platform-api', 'test')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('Windows ZIP and Linux tar.gz are deterministic for the same release layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-training-release-archive-'));
  try {
    const inputs = await fixture(root);
    for (const target of ['win32-x64', 'linux-x64']) {
      const runtimeRoot = await runtimeFixture(root, target);
      const outputRoot = join(root, `output-${target}`);
      await assembleReleaseLayout({ ...inputs, runtimeRoot, outputRoot, target, version: '0.9.2-test', sourceDateEpoch: 1_786_320_000 });
      const first = join(root, `first${RELEASE_TARGETS[target].archiveExtension}`);
      const second = join(root, `second${RELEASE_TARGETS[target].archiveExtension}`);
      await createReleaseArchive({ releaseRoot: outputRoot, archivePath: first, target });
      await createReleaseArchive({ releaseRoot: outputRoot, archivePath: second, target });
      const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
      assert.equal(digest(await readFile(first)), digest(await readFile(second)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
