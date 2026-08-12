import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Linux hotfix is self-checking, reversible and does not touch platform data', async () => {
  const script = await readFile(join(root, 'deploy', 'hotfix', 'apply-hotfix.sh'), 'utf8');
  assert.match(script, /sha256sum --check SHA256SUMS/);
  assert.match(script, /application-dist-before\.tar\.gz/);
  assert.match(script, /trap rollback ERR/);
  assert.match(script, /manage\.sh/);
  assert.doesNotMatch(script, /prisma|DATABASE_URL|data\/artifacts|engine-packages/);
});

test('Linux hotfix builder emits the archive, checksum and operator guide', async () => {
  const output = await mkdtemp(join(tmpdir(), 'ai-training-hotfix-test-'));
  try {
    const apiDist = join(output, 'fixture-api-dist');
    const webDist = join(output, 'fixture-web-dist');
    await mkdir(apiDist, { recursive: true });
    await mkdir(webDist, { recursive: true });
    await writeFile(join(apiDist, 'main.js'), 'fixture api\n', 'utf8');
    await writeFile(join(webDist, 'index.html'), '<!doctype html>\n', 'utf8');
    execFileSync(process.execPath, [
      join(root, 'scripts', 'build-linux-hotfix.mjs'), '--version', '1.1.3', '--output-root', output,
      '--api-dist', apiDist, '--web-dist', webDist,
    ], { cwd: root, stdio: 'pipe' });
    const directory = join(output, 'ai-training-platform-1.1.3-hotfix-linux-x64');
    assert.equal((await stat(join(directory, 'apply-hotfix.sh'))).isFile(), true);
    assert.equal((await stat(join(directory, 'HOTFIX_GUIDE.md'))).isFile(), true);
    assert.equal((await stat(join(directory, 'SHA256SUMS'))).isFile(), true);
    assert.equal((await stat(join(directory, 'payload', 'services', 'platform-api', 'dist', 'main.js'))).isFile(), true);
    assert.equal((await stat(join(directory, 'payload', 'apps', 'web', 'dist', 'index.html'))).isFile(), true);
    assert.equal((await stat(`${directory}.tar.gz`)).isFile(), true);
    assert.match(await readFile(`${directory}.tar.gz.sha256`, 'utf8'), /^[a-f0-9]{64}  ai-training-platform-1\.1\.3-hotfix-linux-x64\.tar\.gz\n$/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
