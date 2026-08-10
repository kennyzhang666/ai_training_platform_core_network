import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  assert.match(environment, /^CODE_AGENT_ARGS_JSON=\["--prompt","\{\{prompt\}\}"\]$/m);
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
  const guide = readFileSync(join(root, 'DEPLOYMENT.html'), 'utf8');
  assert.match(guide, /PostgreSQL/);
  assert.match(guide, /50[–-]100\s*人/);
  assert.match(guide, /数据库.*交付件|交付件.*数据库/s);
  assert.match(guide, /Windows Server/);
  assert.match(guide, /Linux Server/);
  assert.match(guide, /一页纸傻瓜部署/);
  assert.doesNotMatch(guide, /PLATFORM_REPOSITORY=file|不需要 PostgreSQL/);
});

test('single-node reverse proxy authenticates both the UI and API', () => {
  const template = readFileSync(join(deploy, 'nginx-http.conf.template'), 'utf8');
  assert.match(template, /location \/api\/ \{[\s\S]*auth_request \/_ldap_verify;/);
  assert.match(template, /proxy_set_header X-Employee-Id "";/);
  assert.match(template, /location \/ \{[\s\S]*auth_request \/_ldap_verify;/);
  assert.match(template, /error_page 401 =302 \/auth\/login\?returnTo=\$request_uri;/);
});

test('single-node backend ports have one source of truth across proxy and health checks', () => {
  const template = readFileSync(join(deploy, 'nginx-http.conf.template'), 'utf8');
  const windows = readFileSync(join(deploy, 'manage.ps1'), 'utf8');
  const linux = readFileSync(join(deploy, 'manage.sh'), 'utf8');

  assert.match(template, /http:\/\/__LDAP_GATEWAY_HOST__:__LDAP_GATEWAY_PORT__/);
  assert.match(template, /http:\/\/__API_HOST__:__API_PORT__/);
  assert.doesNotMatch(template, /proxy_pass http:\/\/127\.0\.0\.1:(?:3000|8081)/);
  assert.match(windows, /Wait-Health '平台 API' \$apiHealthUri/);
  assert.match(windows, /Wait-Health 'LDAP 网关' \$ldapHealthUri/);
  assert.match(linux, /wait_health '平台 API' "\$api_health_uri"/);
  assert.match(linux, /wait_health 'LDAP 网关' "\$ldap_health_uri"/);
});

test('single-node managers validate the Worker command and roll back a partial start', () => {
  const windows = readFileSync(join(deploy, 'manage.ps1'), 'utf8');
  const linux = readFileSync(join(deploy, 'manage.sh'), 'utf8');

  assert.match(windows, /--check-config/);
  assert.match(linux, /--check-config/);
  assert.match(windows, /Assert-PortAvailable/);
  assert.match(linux, /assert_port_available/);
  assert.match(windows, /catch\s*\{[\s\S]*Stop-ManagedProcess/s);
  assert.match(linux, /rollback_start/);
});

test('the Worker fallback can invoke a direct Code Agent with the mandatory batch prompt', () => {
  const worker = readFileSync(join(root, 'scripts', 'evaluation-worker.mjs'), 'utf8');
  assert.match(worker, /platformInvocation\(\{ executable: environmentCodeAgentCommand, args: codeAgentArgs, prompt: '' \}/);
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

test('Windows Doctor succeeds in an isolated release layout and renders configured ports', { skip: process.platform === 'win32' ? false : 'Windows deployment script' }, () => {
  const releaseRoot = mkdtempSync(join(tmpdir(), 'ai-training-doctor-'));
  try {
    const copy = (source, target) => {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    };
    const put = (target, content) => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    copy(join(deploy, 'manage.ps1'), join(releaseRoot, 'deploy', 'single-node', 'manage.ps1'));
    copy(join(deploy, 'nginx-http.conf.template'), join(releaseRoot, 'deploy', 'single-node', 'nginx-http.conf.template'));
    copy(join(root, 'scripts', 'evaluation-worker.mjs'), join(releaseRoot, 'scripts', 'evaluation-worker.mjs'));
    copy(join(root, 'scripts', 'code-agent-executable.mjs'), join(releaseRoot, 'scripts', 'code-agent-executable.mjs'));
    put(join(releaseRoot, 'apps', 'web', 'dist', 'index.html'), '<!doctype html>');
    put(join(releaseRoot, 'services', 'platform-api', 'dist', 'main.js'), '');
    put(join(releaseRoot, 'services', 'platform-api', 'prisma', 'schema.prisma'), '');
    put(join(releaseRoot, 'services', 'platform-api', 'node_modules', 'prisma', 'build', 'index.js'), 'process.exit(0);');
    put(join(releaseRoot, 'runtime', 'nginx', 'nginx.cmd'), '@exit /b 0\r\n');
    put(join(releaseRoot, 'runtime', 'nginx', 'conf', 'mime.types'), 'types {}\r\n');
    put(join(releaseRoot, 'python-fixture', 'ldap3.py'), '__version__ = "fixture"\n');
    put(join(releaseRoot, 'python-fixture', 'jsonschema.py'), '__version__ = "fixture"\n');
    put(join(releaseRoot, 'python-fixture', 'yaml.py'), '__version__ = "fixture"\n');

    const python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).trim();
    const environment = join(releaseRoot, 'deploy', 'single-node', '.env');
    writeFileSync(environment, [
      'NODE_ENV=production',
      'PLATFORM_DEPLOYMENT_PROFILE=single-node',
      'PLATFORM_RUNTIME_MODE=bundled',
      'HOST=127.0.0.1',
      'PORT=3100',
      `NODE_EXE=${process.execPath}`,
      `PYTHON=${python}`,
      `LDAP_GATEWAY_PYTHON=${python}`,
      `PYTHONPATH=${join(releaseRoot, 'python-fixture')}`,
      'NGINX_EXE=runtime/nginx/nginx.cmd',
      'PLATFORM_REPOSITORY=postgres',
      'DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:5432/fixture',
      'OBJECT_STORAGE_MODE=local',
      'SINGLE_NODE_DATA_ROOT=data',
      'SINGLE_NODE_RUNTIME_ROOT=runtime-state',
      'SINGLE_NODE_BACKUP_ROOT=backups',
      'ARTIFACT_ROOT=data/artifacts',
      'ARTIFACT_UPLOAD_TMP_ROOT=runtime-state/artifact-uploads',
      'ENGINE_PACKAGE_ROOT=data/engine-packages',
      'EVALUATION_BATCH_ROOT=runtime-state/evaluation-batches',
      'EVALUATION_LOG_ROOT=runtime-state/evaluation-logs',
      'ENGINE_CACHE_ROOT=data/worker-engines',
      'PIP_CACHE_DIR=data/pip-cache',
      'ENGINE_PIP_FIND_LINKS=deploy/single-node/wheelhouse',
      'PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY',
      `TRUSTED_GATEWAY_HMAC_SECRET=${'a'.repeat(32)}`,
      `LDAP_GATEWAY_SESSION_SECRET=${'b'.repeat(32)}`,
      'PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO=fixture-admin',
      'LDAP_GATEWAY_HOST=127.0.0.1',
      'LDAP_GATEWAY_PORT=8181',
      'LDAP_SERVER=ldap.internal',
      'LDAP_BASE_DN=dc=internal,dc=example',
      'EMBEDDED_EVALUATION_WORKER=false',
      'PLATFORM_API=http://127.0.0.1:3100/api/v1',
      'EVALUATION_WORKER_EMPLOYEE_NO=fixture-admin',
      'EVALUATION_WORKER_NAME=部署检查',
      `EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET=${'a'.repeat(32)}`,
      `CODE_AGENT_COMMAND=${process.execPath}`,
      'CODE_AGENT_ARGS_JSON=[]',
      'CODE_AGENT_ALLOWED_EXECUTABLES=node',
      'SINGLE_NODE_LISTEN_PORT=8282',
    ].join('\r\n'));

    execFileSync('pwsh', ['-NoProfile', '-File', join(releaseRoot, 'deploy', 'single-node', 'manage.ps1'), 'Doctor', '-EnvironmentFile', environment], {
      cwd: releaseRoot,
      windowsHide: true,
      stdio: 'pipe',
    });
    const rendered = readFileSync(join(releaseRoot, 'runtime-state', 'nginx.conf'), 'utf8');
    assert.match(rendered, /http:\/\/127\.0\.0\.1:3100/);
    assert.match(rendered, /http:\/\/127\.0\.0\.1:8181/);
    assert.match(rendered, /listen 8282;/);
    assert.doesNotMatch(rendered, /__[A-Z_]+__/);
  } finally {
    rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test('single-node Bash manager parses cleanly when Bash is available', { skip: process.platform === 'win32' ? 'Bash syntax is checked by the Linux release job' : false }, () => {
  execFileSync('bash', ['-n', join(deploy, 'manage.sh')], { cwd: root, windowsHide: true, stdio: 'pipe' });
});
