import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const projectRoot = process.cwd();
const helper = join(projectRoot, 'scripts', 'offline-upgrade-helper.py');
const python = process.env.PYTHON || 'python';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture({ sourceVersion = '1.1.4', targetVersion = '1.1.5', target = process.platform === 'win32' ? 'win32-x64' : 'linux-x64' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-training-upgrade-'));
  const source = join(root, 'current');
  const release = join(root, 'release');
  mkdirSync(source);
  mkdirSync(release);
  writeFileSync(join(source, 'VERSION'), `${sourceVersion}\n`);
  writeFileSync(join(release, 'VERSION'), `${targetVersion}\n`);
  writeFileSync(join(release, 'upgrade-manifest.json'), `${JSON.stringify({ schemaVersion: '1.0', product: 'ai-training-platform', target, targetVersion, supportedSourceVersions: ['1.1.4'], minimumPostgresMajor: 14, migrationStrategy: 'prisma-migrate-deploy-with-native-postgres-rollback', requiresSameFilesystem: true }, null, 2)}\n`);
  const files = ['VERSION', 'upgrade-manifest.json'].map((path) => {
    const bytes = readFileSync(join(release, path));
    return { path, type: 'file', size: bytes.length, sha256: sha256(bytes), mode: process.platform === 'win32' ? 438 : 420 };
  });
  writeFileSync(join(release, 'release-manifest.json'), `${JSON.stringify({ schemaVersion: '1.0', product: 'ai-training-platform', version: targetVersion, target, createdAt: '2026-08-12T00:00:00.000Z', files }, null, 2)}\n`);
  return { root, source, release };
}

test('offline upgrade verifier accepts a complete supported release', () => {
  const { source, release } = fixture();
  const output = execFileSync(python, [helper, 'verify-release', '--release-root', release, '--source-root', source], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.sourceVersion, '1.1.4');
  assert.equal(result.targetVersion, '1.1.5');
});

test('offline upgrade verifier fails closed for tampering and extra files', () => {
  const tampered = fixture();
  writeFileSync(join(tampered.release, 'VERSION'), 'changed\n');
  assert.notEqual(spawnSync(python, [helper, 'verify-release', '--release-root', tampered.release, '--source-root', tampered.source]).status, 0);

  const extra = fixture();
  writeFileSync(join(extra.release, 'unregistered.txt'), 'no');
  assert.notEqual(spawnSync(python, [helper, 'verify-release', '--release-root', extra.release, '--source-root', extra.source]).status, 0);
});

test('offline upgrade verifier rejects unsupported, same-version and downgrade attempts', () => {
  const unsupported = fixture({ sourceVersion: '1.0.6' });
  assert.notEqual(spawnSync(python, [helper, 'verify-release', '--release-root', unsupported.release, '--source-root', unsupported.source]).status, 0);
  const same = fixture({ sourceVersion: '1.1.4', targetVersion: '1.1.4' });
  assert.notEqual(spawnSync(python, [helper, 'verify-release', '--release-root', same.release, '--source-root', same.source]).status, 0);
});

test('offline upgrade verifier rejects a package for the other operating system', () => {
  const otherTarget = process.platform === 'win32' ? 'linux-x64' : 'win32-x64';
  const item = fixture({ target: otherTarget });
  assert.notEqual(spawnSync(python, [helper, 'verify-release', '--release-root', item.release, '--source-root', item.source]).status, 0);
});

test('offline upgrade verifier rejects manifest path traversal', () => {
  const item = fixture();
  const manifestPath = join(item.release, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files.push({ path: '../outside', type: 'file', size: 0, sha256: sha256(Buffer.alloc(0)), mode: 420 });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.notEqual(spawnSync(python, [helper, 'verify-release', '--release-root', item.release, '--source-root', item.source]).status, 0);
});

test('database parser rejects remote PostgreSQL without printing credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-training-database-'));
  const environment = join(root, '.env');
  const password = 'do-not-print-this';
  writeFileSync(environment, `DATABASE_URL=postgresql://app:${password}@db.internal:5432/platform\n`);
  const result = spawnSync(python, [helper, 'database-check', '--environment-file', environment], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(password));
});

test('environment layout resolves only disjoint children of the installed release', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-training-layout-'));
  const environment = join(root, '.env');
  writeFileSync(environment, [
    'SINGLE_NODE_DATA_ROOT=state/data',
    'SINGLE_NODE_BACKUP_ROOT=state/backups',
    'SINGLE_NODE_RUNTIME_ROOT=runtime-state',
    'PORT=3100',
    '',
  ].join('\n'));
  const output = execFileSync(python, [helper, 'environment-layout', '--environment-file', environment, '--install-root', root], { encoding: 'utf8' });
  const layout = JSON.parse(output);
  assert.equal(layout.dataRelative, 'state/data');
  assert.equal(layout.backupRelative, 'state/backups');
  assert.equal(layout.apiPort, 3100);

  writeFileSync(environment, 'SINGLE_NODE_DATA_ROOT=../outside\n');
  assert.notEqual(spawnSync(python, [helper, 'environment-layout', '--environment-file', environment, '--install-root', root]).status, 0);
});

test('upgrade launchers and helper are parseable and shipped as safe entrypoints', () => {
  execFileSync(python, ['-m', 'py_compile', helper]);
  assert.match(readFileSync(join(projectRoot, 'upgrade.cmd'), 'utf8'), /deploy\\single-node\\upgrade\.ps1/i);
  assert.match(readFileSync(join(projectRoot, 'upgrade.sh'), 'utf8'), /deploy\/single-node\/upgrade\.sh/);
  const windows = readFileSync(join(projectRoot, 'deploy', 'single-node', 'upgrade.ps1'), 'utf8');
  const linux = readFileSync(join(projectRoot, 'deploy', 'single-node', 'upgrade.sh'), 'utf8');
  assert.match(windows, /--source-root/);
  assert.match(windows, /database-active-evaluations/);
  assert.match(windows, /database-restore/);
  assert.match(linux, /--source-root/);
  assert.match(linux, /database-active-evaluations/);
  assert.match(linux, /database-restore/);
  assert.match(linux, /systemctl start/);
  assert.match(linux, /systemctl is-failed/);
  assert.match(linux, /systemd 启动失败或不可用，改由 root 直接拉起业务进程/);
  assert.match(linux, /systemd 单元异常且平台进程不完整；将由 root 清理残留并在升级后直接恢复业务进程/);
  assert.match(linux, /root 兜底启动后仍未完整拉起四个业务进程/);
  const helperSource = readFileSync(join(projectRoot, 'scripts', 'offline-upgrade-helper.py'), 'utf8');
  assert.match(helperSource, /pg_get_userbyid\(datdba\) = current_user/);
  assert.match(helperSource, /DATABASE_URL 用户是当前专用数据库的所有者/);
  if (process.platform !== 'win32') {
    chmodSync(join(projectRoot, 'upgrade.sh'), 0o755);
    chmodSync(join(projectRoot, 'deploy', 'single-node', 'upgrade.sh'), 0o755);
  }
});
