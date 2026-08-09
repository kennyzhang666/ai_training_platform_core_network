import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = join(root, 'deploy', 'single-node');

test('single-node bundle uses same-server PostgreSQL, local artifacts and an independent Worker', () => {
  const environment = readFileSync(join(deploy, '.env.example'), 'utf8');
  assert.match(environment, /^PLATFORM_DEPLOYMENT_PROFILE=single-node$/m);
  assert.match(environment, /^PLATFORM_REPOSITORY=postgres$/m);
  assert.match(environment, /^DATABASE_URL=postgresql:\/\//m);
  assert.match(environment, /^OBJECT_STORAGE_MODE=local$/m);
  assert.match(environment, /^ARTIFACT_UPLOAD_TMP_ROOT=deploy\/single-node\/runtime\/artifact-uploads$/m);
  assert.match(environment, /^EMBEDDED_EVALUATION_WORKER=false$/m);
  assert.match(environment, /^ENGINE_PIP_OFFLINE=true$/m);
  assert.doesNotMatch(environment, /^PLATFORM_DATA_FILE=/m);
  assert.doesNotMatch(environment, /^OBJECT_STORAGE_BUCKET=/m);
});

test('single-node manager deploys migrations and backs up PostgreSQL with local artifacts', () => {
  const manager = readFileSync(join(deploy, 'manage.ps1'), 'utf8');
  assert.match(manager, /prisma:migrate:deploy/);
  assert.match(manager, /backup:postgres/);
  assert.match(manager, /restore:postgres/);
  assert.match(manager, /ARTIFACT_UPLOAD_TMP_ROOT/);
  assert.match(manager, /artifact-uploads\.before-restore-/);
  assert.match(manager, /PLATFORM_RUNTIME_MODE/);
  assert.match(manager, /NODE_EXE/);
  assert.match(manager, /node_modules[\\/]prisma[\\/]build[\\/]index\.js/);
  assert.match(manager, /migrate['",\s]+status/);
  assert.match(manager, /VERSION/);
  assert.doesNotMatch(manager, /version = '0\.9\.1'/);
  assert.doesNotMatch(manager, /PLATFORM_DATA_FILE/);
});

test('Windows release launcher uses the bundled PowerShell runtime', () => {
  const launcher = readFileSync(join(deploy, 'manage.cmd'), 'utf8');
  assert.match(launcher, /runtime\\powershell\\pwsh\.exe/i);
  assert.match(launcher, /manage\.ps1/i);
});

test('Linux single-node manager provides the same lifecycle and bundled runtime boundary', () => {
  const manager = readFileSync(join(deploy, 'manage.sh'), 'utf8');
  for (const action of ['Prepare', 'Start', 'Stop', 'Status', 'Backup', 'Restore', 'Doctor']) {
    assert.match(manager, new RegExp(`\\b${action}\\b`));
  }
  assert.match(manager, /PLATFORM_RUNTIME_MODE/);
  assert.match(manager, /NODE_EXE/);
  assert.match(manager, /prisma\/build\/index\.js/);
  assert.match(manager, /backup-postgres\.mjs/);
  assert.match(manager, /restore-postgres\.mjs/);
  assert.match(manager, /migrate status/);
  assert.match(manager, /VERSION/);
  assert.doesNotMatch(manager, /docker|redis|kafka|minio/i);
});

test('single-node Nginx stays attached to the platform process manager', () => {
  const template = readFileSync(join(deploy, 'nginx-http.conf.template'), 'utf8');
  assert.match(template, /^daemon off;$/m);
});

test('single-node operator guide targets a fifty-to-one-hundred-person training session', () => {
  const guide = readFileSync(join(deploy, 'README.md'), 'utf8');
  assert.match(guide, /PostgreSQL/);
  assert.match(guide, /50[–-]100\s*人/);
  assert.match(guide, /数据库.*交付件|交付件.*数据库/s);
  assert.doesNotMatch(guide, /PLATFORM_REPOSITORY=file|不需要 PostgreSQL/);
});

test('single-node reverse proxy authenticates both the UI and API', () => {
  const template = readFileSync(join(deploy, 'nginx-http.conf.template'), 'utf8');
  assert.match(template, /location \/api\/ \{[\s\S]*auth_request \/_ldap_verify;/);
  assert.match(template, /proxy_set_header X-Employee-Id "";/);
  assert.match(template, /location \/ \{[\s\S]*auth_request \/_ldap_verify;/);
  assert.match(template, /error_page 401 =302 \/auth\/login\?returnTo=\$request_uri;/);
});

test('single-node PowerShell manager parses cleanly on Windows', { skip: process.platform === 'win32' ? false : 'Windows deployment script' }, () => {
  const script = join(deploy, 'manage.ps1');
  const escaped = script.replaceAll("'", "''");
  execFileSync('pwsh', ['-NoProfile', '-Command', `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`], {
    cwd: root,
    windowsHide: true,
    stdio: 'pipe',
  });
});

test('single-node Bash manager parses cleanly when Bash is available', { skip: process.platform === 'win32' ? 'Bash syntax is checked by the Linux release job' : false }, () => {
  execFileSync('bash', ['-n', join(deploy, 'manage.sh')], { cwd: root, windowsHide: true, stdio: 'pipe' });
});
