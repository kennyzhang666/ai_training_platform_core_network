import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, ...path.split('/')), 'utf8');
const execFileAsync = promisify(execFile);

test('one production application image contains every platform runtime without embedding secrets', async () => {
  const [dockerfile, ignore] = await Promise.all([read('Dockerfile'), read('.dockerignore')]);

  assert.match(dockerfile, /FROM node:22\.23\.2-bookworm-slim AS build/);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/);
  assert.match(dockerfile, /--config\.node-linker=hoisted.*deploy.*--prod.*--legacy/s);
  assert.match(dockerfile, /python3-venv/);
  assert.match(dockerfile, /nginx/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini"/);
  assert.doesNotMatch(dockerfile, /COPY\s+[^\n]*\.env(?:\s|$)/);
  for (const excluded of ['.git', '**/.env', 'node_modules', 'release', 'tmp']) assert.match(ignore, new RegExp(`^${excluded.replaceAll('*', '\\*').replaceAll('.', '\\.')}\\s*$`, 'm'));
});

test('Compose reuses the application image while isolating API, Worker, gateway, web and PostgreSQL', async () => {
  const compose = await read('deploy/docker/compose.yaml');

  for (const service of ['init', 'api', 'worker', 'gateway', 'web', 'postgres']) {
    assert.match(compose, new RegExp(`^  ${service}:`, 'm'));
  }
  assert.match(compose, /AI_TRAINING_IMAGE/);
  assert.match(compose, /POSTGRES_IMAGE/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /condition: service_completed_successfully/);
  assert.match(compose, /platform-data:/);
  assert.match(compose, /postgres-data:/);
  assert.match(compose, /CODE_AGENT_BUNDLE_PATH[^\n]*:\/opt\/code-agent:ro/);
  assert.match(compose, /ENGINE_WHEELHOUSE_PATH[^\n]*:\/opt\/ai-training\/extra-wheelhouse:ro/);
  assert.match(compose, /ENGINE_PIP_FIND_LINKS_JSON/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /restart: unless-stopped/);
  assert.doesNotMatch(compose, /["']?(?:3000|5432|8081):(?:3000|5432|8081)["']?/);
});

test('Docker entrypoint, proxy and manager provide a checked one-command Linux lifecycle', async () => {
  const [entrypoint, nginx, manager, environment] = await Promise.all([
    read('deploy/docker/entrypoint.sh'),
    read('deploy/docker/nginx.conf'),
    read('deploy/docker/manage.sh'),
    read('deploy/docker/.env.example'),
  ]);

  for (const role of ['init', 'api', 'worker', 'gateway', 'web']) assert.match(entrypoint, new RegExp(`${role}\\)`));
  assert.match(entrypoint, /prisma\/build\/index\.js.*migrate deploy/s);
  assert.match(entrypoint, /evaluation-worker\.mjs" --check-config/);
  assert.match(entrypoint, /exec node .*evaluation-worker\.mjs/s);
  assert.doesNotMatch(entrypoint, /\beval\b/);

  assert.match(nginx, /proxy_pass http:\/\/api:3000/);
  assert.match(nginx, /proxy_pass http:\/\/gateway:8081/);
  assert.match(nginx, /proxy_set_header X-Employee-Id ""/);
  assert.match(nginx, /X-Trusted-Identity-Signature/);

  for (const action of ['Prepare', 'Doctor', 'Start', 'Stop', 'Status', 'Logs']) assert.match(manager, new RegExp(action));
  assert.match(manager, /docker compose/);
  assert.match(manager, /docker load/);
  assert.match(manager, /up -d --wait/);
  assert.doesNotMatch(manager, /curl[^\n]*\|\s*(?:ba)?sh/);

  assert.match(environment, /POSTGRES_PASSWORD=__GENERATE_POSTGRES_PASSWORD__/);
  assert.match(environment, /TRUSTED_GATEWAY_HMAC_SECRET=__GENERATE_TRUSTED_SECRET__/);
  assert.match(environment, /LDAP_GATEWAY_SESSION_SECRET=__GENERATE_SESSION_SECRET__/);
  assert.match(environment, /PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO=<[^>]+>/);
  assert.match(environment, /CODE_AGENT_BUNDLE_PATH=\.\/code-agent/);
  assert.match(environment, /ENGINE_WHEELHOUSE_PATH=\.\/wheelhouse/);
  assert.doesNotMatch(environment, /(?:password|secret)=.{32,}/i);
});

test('Docker Prepare generates independent secrets once and never overwrites operator configuration', async (context) => {
  const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
  if (!existsSync(bash)) {
    context.skip('Bash is not available');
    return;
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ai-training-docker-prepare-'));
  try {
    await mkdir(join(temporaryRoot, 'deploy'), { recursive: true });
    await Promise.all([
      copyFile(join(root, 'deploy', 'docker', 'manage.sh'), join(temporaryRoot, 'deploy', 'manage.sh')),
      copyFile(join(root, 'deploy', 'docker', '.env.example'), join(temporaryRoot, 'deploy', '.env.example')),
      copyFile(join(root, 'deploy', 'docker', 'compose.yaml'), join(temporaryRoot, 'deploy', 'compose.yaml')),
    ]);
    const manager = join(temporaryRoot, 'deploy', 'manage.sh');
    await execFileAsync(bash, [manager, 'Prepare'], { cwd: temporaryRoot });
    const first = await readFile(join(temporaryRoot, 'deploy', '.env'), 'utf8');
    assert.equal(existsSync(join(temporaryRoot, 'deploy', 'wheelhouse')), true);
    assert.doesNotMatch(first, /__GENERATE_[A-Z_]+__/);
    const postgres = /^POSTGRES_PASSWORD=([a-f0-9]{64})$/m.exec(first)?.[1];
    const trusted = /^TRUSTED_GATEWAY_HMAC_SECRET=([a-f0-9]{64})$/m.exec(first)?.[1];
    const session = /^LDAP_GATEWAY_SESSION_SECRET=([a-f0-9]{64})$/m.exec(first)?.[1];
    assert.ok(postgres && trusted && session);
    assert.equal(new Set([postgres, trusted, session]).size, 3);

    await execFileAsync(bash, [manager, 'Prepare'], { cwd: temporaryRoot });
    assert.equal(await readFile(join(temporaryRoot, 'deploy', '.env'), 'utf8'), first);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
