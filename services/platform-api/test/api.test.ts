import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { createCorsOptions } from '../src/cors-config';

// API tests must never delete or mutate the developer's persistent local data
// file, especially when a dev server is running alongside the test process.
process.env.PLATFORM_DATA_FILE = ':memory:';
process.env.ALLOW_ANONYMOUS_LOCAL = 'true';
process.env.EMBEDDED_EVALUATION_WORKER = 'true';

function validParkingZip(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'api-delivery-'));
  const archive = join(directory, 'delivery.zip');
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? join(__dirname, '..', '..', '..', '.venv', 'Scripts', 'python.exe') : 'python');
  try {
    execFileSync(python, ['-c', [
      'import sys, zipfile',
      'archive, label = sys.argv[1], sys.argv[2]',
      'with zipfile.ZipFile(archive, "w") as z:',
      '    z.writestr("SPEC.md", "# 需求\\n\\n" + label)',
      '    z.writestr("transcript.md", (label + " ") * 40)',
      '    z.writestr("src/parking.py", "def calculate_fee(entry_time, exit_time, is_member=False):\\n    return 0\\n# " + label)',
    ].join('\n'), archive, label], { windowsHide: true });
    return readFileSync(archive).toString('base64');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const ZIP_FIXTURES = {
  local: validParkingZip('local artifact fixture'),
  first: validParkingZip('first selective artifact'),
  second: validParkingZip('second selective artifact'),
  allowlisted: validParkingZip('allowlisted fixture'),
  invalidLayout: (() => {
    const directory = mkdtempSync(join(tmpdir(), 'api-invalid-delivery-'));
    const archive = join(directory, 'delivery.zip');
    const python = process.env.PYTHON ?? (process.platform === 'win32' ? join(__dirname, '..', '..', '..', '.venv', 'Scripts', 'python.exe') : 'python');
    try {
      execFileSync(python, ['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr("README.md", "missing required files")', archive], { windowsHide: true });
      return readFileSync(archive).toString('base64');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })(),
  traversal: 'UEsDBBQAAAAAAAAAIQCOsOglBgAAAAYAAAANAAAALi4vZXNjYXBlLnR4dGVzY2FwZVBLAQIUABQAAAAAAAAAIQCOsOglBgAAAAYAAAANAAAAAAAAAAAAAACAAQAAAAAuLi9lc2NhcGUudHh0UEsFBgAAAAABAAEAOwAAADEAAAAAAA==',
} as const;

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.enableCors(createCorsOptions(['http://127.0.0.1:5173']));
  await app.listen(0, '127.0.0.1');
  try {
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

test('only a global administrator can read aggregate operational metrics', async () => {
  await withApp(async (baseUrl) => {
    await fetch(`${baseUrl}/api/v1/health`);
    const unknown = await fetch(`${baseUrl}/api/v1/not-found/w00123?secret=should-not-be-recorded`, { headers: { 'x-employee-id': 'w00123' } });
    assert.equal(unknown.status, 404);
    const invalidQuery = await fetch(`${baseUrl}/api/v1/users?page=not-a-number`, { headers: { 'x-employee-id': 'w00123' } });
    assert.equal(invalidQuery.status, 400);
    const global = await fetch(`${baseUrl}/api/v1/metrics`, { headers: { 'x-employee-id': 'w00123' } });
    assert.equal(global.status, 200);
    const body = await global.json() as { schemaVersion?: string; requests?: { total?: number; clientErrors?: number }; latencyMs?: { p95?: number }; routes?: Record<string, unknown> };
    assert.equal(body.schemaVersion, '1.0');
    assert.ok((body.requests?.total ?? 0) >= 1);
    assert.ok((body.requests?.clientErrors ?? 0) >= 1);
    assert.ok((body.latencyMs?.p95 ?? 0) >= 0);
    assert.ok(body.routes && typeof body.routes === 'object');
    assert.doesNotMatch(JSON.stringify(body), /w00123|should-not-be-recorded/);

    const scoped = await fetch(`${baseUrl}/api/v1/metrics`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(scoped.status, 403);
  });
});

test('API prevents a global administrator from removing their own global access', async () => {
  await withApp(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
    const demotion = await fetch(`${baseUrl}/api/v1/users/w00123`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ roles: ['learner'] }),
    });
    assert.equal(demotion.status, 403);

    const retained = await fetch(`${baseUrl}/api/v1/users/w00123`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ roles: ['global_admin'], roleBindings: [] }),
    });
    assert.equal(retained.status, 200);
    const body = await retained.json() as { roles: string[]; roleBindings?: Array<{ role: string; scopeOrgPath: string }> };
    assert.deepEqual(body.roles, ['global_admin']);
    assert.ok(body.roleBindings?.some((binding) => binding.role === 'global_admin' && binding.scopeOrgPath === '/'));
  });
});

test('browser preflight allows administration update and delete requests', async () => {
  await withApp(async (baseUrl) => {
    for (const method of ['PATCH', 'DELETE']) {
      const response = await fetch(`${baseUrl}/api/v1/org-units/org-125`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type,x-employee-id',
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
      const allowedMethods = (response.headers.get('access-control-allow-methods') ?? '').split(',').map((value) => value.trim());
      assert.ok(allowedMethods.includes(method));
      assert.match(response.headers.get('access-control-allow-headers') ?? '', /x-employee-id/i);
    }
  });
});

test('administrator can update and delete an empty department through the API', async () => {
  await withApp(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
    const createdAtCollection = await fetch(`${baseUrl}/api/v1/org-units`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'org-api-empty', parentId: 'org-125', name: '接口协作组', label: '团队' }),
    });
    assert.equal(createdAtCollection.status, 201);

    const updated = await fetch(`${baseUrl}/api/v1/org-units/org-api-empty`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: '接口交付组', label: '部门' }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), {
      id: 'org-api-empty', parentId: 'org-125', path: '/1/12/125/org-api-empty/', level: 4, label: '部门', name: '接口交付组',
    });

    const deleted = await fetch(`${baseUrl}/api/v1/org-units/org-api-empty`, {
      method: 'DELETE',
      headers: { 'x-employee-id': 'w00123' },
    });
    assert.equal(deleted.status, 204);
    const missing = await fetch(`${baseUrl}/api/v1/org-units/org-api-empty`, { headers: { 'x-employee-id': 'w00123' } });
    assert.equal(missing.status, 404);
  });
});

test('administrator mutations keep the workspace refresh endpoints healthy', async () => {
  await withApp(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
    const updated = await fetch(`${baseUrl}/api/v1/users/w00124`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ orgUnitId: 'org-125', roles: ['learner', 'mentor'] }),
    });
    assert.equal(updated.status, 200);

    // The Web admin calls this set after every mutation. A single broken
    // refresh request used to turn a successful user edit into a visible
    // failure, because runAction awaited Promise.all(refresh()).
    const refreshPaths = [
      '/api/v1/admin/overview',
      '/api/v1/challenges',
      '/api/v1/events',
      '/api/v1/submissions?page=1&pageSize=100',
      '/api/v1/users?page=1&pageSize=100',
      '/api/v1/users?page=1&pageSize=20&role=learner&status=ACTIVE',
      '/api/v1/org-units',
      '/api/v1/admin/capabilities',
      '/api/v1/announcements',
      '/api/v1/audits?page=1&pageSize=100',
      '/api/v1/admin/grading-queue',
      '/api/v1/evaluation-executors',
      '/api/v1/admin/code-agent-runtime',
      '/api/v1/admin/code-agent-runtime/diagnostics',
      '/api/v1/evaluation-contracts',
    ];
    const responses = await Promise.all(refreshPaths.map((path) => fetch(`${baseUrl}${path}`, { headers })));
    assert.deepEqual(responses.map((response) => response.status), refreshPaths.map(() => 200));

    const contractCatalogResponse = await fetch(`${baseUrl}/api/v1/evaluation-contracts`, { headers });
    assert.equal(contractCatalogResponse.status, 200);
    const contractCatalog = await contractCatalogResponse.json() as Array<{ id: string; visibility: string; examplePath: string; guidePath: string }>;
    assert.equal(contractCatalog.length, 3);
    assert.ok(contractCatalog.every((item) => item.visibility === 'PUBLIC' && item.examplePath.startsWith('contracts/examples/') && item.guidePath === 'docs/evaluation-contract-authoring.md'));

    const contractDetailResponse = await fetch(`${baseUrl}/api/v1/evaluation-contracts/platform-evaluation-result-v1`, { headers });
    assert.equal(contractDetailResponse.status, 200);
    const contractDetail = await contractDetailResponse.json() as { kind: string; label: string; schema: Record<string, unknown>; example: Record<string, unknown>; guide: string };
    assert.equal(contractDetail.kind, 'OUTPUT');
    assert.match(contractDetail.label, /输出约束/);
    assert.equal(typeof contractDetail.schema, 'object');
    assert.equal(typeof contractDetail.example, 'object');
    assert.match(contractDetail.guide, /复制给 AI/);

    const internalContractDetailResponse = await fetch(`${baseUrl}/api/v1/evaluation-contracts/engine-invocation-input-v1`, { headers });
    assert.equal(internalContractDetailResponse.status, 404);
  });
});

test('global administrators can move several employees to one department in a single request', async () => {
  await withApp(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
    const created = await fetch(`${baseUrl}/api/v1/org-units`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'org-api-batch', parentId: 'org-125', name: '批量调整测试部门', label: '团队' }),
    });
    assert.equal(created.status, 201);

    const response = await fetch(`${baseUrl}/api/v1/users/batch-department`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ userIds: ['w00124', 'w00126'], orgUnitId: 'org-api-batch' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { requested: number; updated: Array<{ id: string; orgUnitId: string; orgPath: string }> };
    assert.equal(body.requested, 2);
    assert.deepEqual(body.updated.map((user) => user.id).sort(), ['w00124', 'w00126']);
    assert.ok(body.updated.every((user) => user.orgUnitId === 'org-api-batch' && user.orgPath.endsWith('/org-api-batch/')));
  });
});

test('global administrators can inspect runtime diagnostics and receive a safe test result', async () => {
  await withApp(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
    const diagnosticsResponse = await fetch(`${baseUrl}/api/v1/admin/code-agent-runtime/diagnostics`, { headers });
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json() as { defaults: { enabled: boolean; commandLine: string; prompt: string; timeoutSeconds: number }; worker: { cliOverrideVisible: boolean }; test: { canExecute: boolean } };
    assert.equal(diagnostics.defaults.enabled, false);
    assert.equal(diagnostics.defaults.commandLine, 'opencode --prompt "{{prompt}}"');
    assert.match(diagnostics.defaults.prompt, /instruction\.md/);
    assert.equal(diagnostics.defaults.timeoutSeconds, 3600);
    assert.equal(diagnostics.worker.cliOverrideVisible, false);
    assert.equal(typeof diagnostics.test.canExecute, 'boolean');

    const command = `"${process.execPath}" -e "process.exit(0)"`;
    const response = await fetch(`${baseUrl}/api/v1/admin/code-agent-runtime/test`, {
      method: 'POST', headers,
      body: JSON.stringify({ commandLine: command, prompt: 'runtime connectivity test', timeoutSeconds: 60 }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { status: string; executable: string | null; stdout: string; stderr: string };
    assert.ok(['PASS', 'FAIL', 'BLOCKED', 'TIMEOUT'].includes(result.status));
    assert.equal(result.executable, process.execPath);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /process\.env|DATABASE_URL/);
  });
});

test('manual upload can be triggered and imported results are idempotent', async () => {
  await withApp(async (baseUrl) => {
    const uploadedBytes = Buffer.from(ZIP_FIXTURES.local, 'base64');
    const uploadedHash = createHash('sha256').update(uploadedBytes).digest('hex');
    const submitted = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'w00123',
        artifactBase64: uploadedBytes.toString('base64'),
        fileName: 'submission.zip',
        snapshot: { sourceType: 'UPLOAD', submittedAt: '2026-08-01T10:00:00Z' },
      }),
    });
    assert.equal(submitted.status, 201);
    const submission = await submitted.json() as { id: string; state: string; snapshot: { snapshotHash: string } };
    assert.equal(submission.state, 'WAITING_TRIGGER');

    const downloaded = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}/artifact`, { headers: { 'x-employee-id': 'w00123' } });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('content-disposition'), 'attachment; filename*=UTF-8\'\'submission.zip');
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString('utf8'), uploadedBytes.toString('utf8'));
    const deniedDownload = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}/artifact`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(deniedDownload.status, 403);

    const uploaded = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'w00126',
        artifactBase64: uploadedBytes.toString('base64'),
        fileName: 'submission.zip',
        snapshot: { sourceType: 'UPLOAD', snapshotHash: submission.snapshot.snapshotHash, submittedAt: '2026-08-01T10:00:00Z' },
      }),
    });
    assert.equal(uploaded.status, 201);

    const started = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}/start-grading`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actorId: 'admin-1' }),
    });
    assert.equal(started.status, 201);
    const run = await started.json() as { id: string; triggerType: string };
    assert.equal(run.triggerType, 'MANUAL');

    const createEvent = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'event-import', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' }),
    });
    assert.equal(createEvent.status, 201);
    const importSnapshot = submission.snapshot.snapshotHash;
    const uploadImport = await fetch(`${baseUrl}/api/v1/events/event-import/submissions:upload`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectId: 'w00124', artifactBase64: uploadedBytes.toString('base64'), fileName: 'submission.zip', snapshot: { sourceType: 'UPLOAD', snapshotHash: importSnapshot, artifactHash: uploadedHash, submittedAt: '2026-08-01T10:00:00Z' } }),
    });
    assert.equal(uploadImport.status, 201);

    const fixture = JSON.parse(readFileSync(join(__dirname, '../../../contracts/examples/evaluation-result.valid.json'), 'utf8')) as Record<string, unknown>;
    fixture.resultId = 'result-import-api';
    fixture.gradingRunId = 'run-import-api';
    fixture.idempotencyKey = 'abababababababababababababababab';
    fixture.triggerType = 'IMPORT';
    fixture.subject = { kind: 'person', id: 'w00124', name: '客户端自报姓名', orgPath: '/spoofed/' };
    fixture.submission = { sourceType: 'UPLOAD', snapshotHash: importSnapshot, artifactHash: uploadedHash, submittedAt: '2026-08-01T10:00:00Z' };
    const tampered = { ...fixture, resultId: 'result-import-tampered', idempotencyKey: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', total: 0 };
    const rejectedScore = await fetch(`${baseUrl}/api/v1/grading-results:import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: tampered, eventId: 'event-import', subjectId: 'w00124' }),
    });
    assert.equal(rejectedScore.status, 400);
    const rejectedScoreBody = await rejectedScore.json() as { code: string; details?: { recalculatedTotal?: number } };
    assert.equal(rejectedScoreBody.code, 'RESULT_SCORE_INCONSISTENT');
    assert.equal(rejectedScoreBody.details?.recalculatedTotal, 60);
    const first = await fetch(`${baseUrl}/api/v1/grading-results:import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: fixture, actorId: 'admin-2', eventId: 'event-import', subjectId: 'w00124' }),
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${baseUrl}/api/v1/grading-results:import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: fixture, actorId: 'admin-2', eventId: 'event-import', subjectId: 'w00124' }),
    });
    assert.equal(second.status, 201);
    const firstBody = await first.json() as { accepted: boolean; stored: { resultId: string; result: { subject?: { id: string; name?: string; orgPath?: string } } } };
    const secondBody = await second.json() as { accepted: boolean; stored: { resultId: string } };
    assert.equal(firstBody.accepted, true);
    assert.equal(secondBody.stored.resultId, firstBody.stored.resultId);
    assert.deepEqual(firstBody.stored.result.subject, { kind: 'person', id: 'w00124', name: '本地学员 A', orgPath: '/1/12/125/' });
    const reusedRun = { ...fixture, resultId: 'result-import-run-reuse', idempotencyKey: 'efefefefefefefefefefefefefefefef', subject: { kind: 'person', id: 'w00124' } };
    const rejectedRunReuse = await fetch(`${baseUrl}/api/v1/grading-results:import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: reusedRun, eventId: 'event-import', subjectId: 'w00124' }),
    });
    assert.equal(rejectedRunReuse.status, 409);
  });
});

test('two-phase upload handles are actor-bound and confirm immutable objects', async () => {
  await withApp(async (baseUrl) => {
    const content = Buffer.from('v07 upload object');
    const create = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' },
      body: JSON.stringify({ eventId: 'event-local', fileName: 'delivery.zip', declaredSize: content.length }),
    });
    assert.equal(create.status, 201);
    const session = await create.json() as { uploadId: string; uploadToken: string };
    const denied = await fetch(`${baseUrl}/api/v1/uploads/${session.uploadId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00125', 'x-upload-token': session.uploadToken },
      body: JSON.stringify({ bytesBase64: content.toString('base64') }),
    });
    assert.equal(denied.status, 400);

    const put = await fetch(`${baseUrl}/api/v1/uploads/${session.uploadId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124', 'x-upload-token': session.uploadToken },
      body: JSON.stringify({ bytesBase64: content.toString('base64') }),
    });
    assert.equal(put.status, 200);
    const metadata = await put.json() as { size: number; sha256: string };
    assert.equal(metadata.size, content.length);

    const invalid = await fetch(`${baseUrl}/api/v1/uploads/${session.uploadId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124', 'x-upload-token': session.uploadToken },
      body: JSON.stringify({ size: metadata.size, sha256: 'not-a-sha256' }),
    });
    assert.equal(invalid.status, 400);
    const confirmed = await fetch(`${baseUrl}/api/v1/uploads/${session.uploadId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124', 'x-upload-token': session.uploadToken },
      body: JSON.stringify(metadata),
    });
    assert.equal(confirmed.status, 201);
    const stored = await confirmed.json() as { sha256: string; size: number; uri: string };
    assert.equal(stored.sha256, metadata.sha256);
    assert.equal(stored.size, metadata.size);
    assert.match(stored.uri, /^local:\/\//);
  });
});

test('upload rejects an unsafe ZIP even when the event does not set maxFiles', async () => {
  await withApp(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'event-unsafe-archive',
        challengeVersion: 'parking-fee-01@1',
        submissionSource: 'UPLOAD',
        trigger: 'IMPORT',
        reveal: 'IMMEDIATE',
      }),
    });
    assert.equal(created.status, 201);
    const uploaded = await fetch(`${baseUrl}/api/v1/events/event-unsafe-archive/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' },
      body: JSON.stringify({
        subjectId: 'w00124',
        artifactBase64: ZIP_FIXTURES.traversal,
        fileName: 'submission.zip',
        snapshot: { sourceType: 'UPLOAD', submittedAt: '2026-08-01T10:00:00Z' },
      }),
    });
    assert.equal(uploaded.status, 400);
    assert.equal((await uploaded.json() as { code?: string }).code, 'ARTIFACT_ARCHIVE_INVALID');
  });
});

test('submission endpoints reject requests outside the current event window', async () => {
  await withApp(async (baseUrl) => {
    const current = Date.now();
    const created = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'event-api-window-future',
        challengeVersion: 'parking-fee-01@1',
        submissionSource: 'UPLOAD',
        trigger: 'IMPORT',
        reveal: 'IMMEDIATE',
        mode: 'WINDOW',
        startsAt: new Date(current + 60 * 60 * 1000).toISOString(),
        endsAt: new Date(current + 2 * 60 * 60 * 1000).toISOString(),
      }),
    });
    assert.equal(created.status, 201);

    const uploadHandle = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ eventId: 'event-api-window-future', fileName: 'submission.zip', declaredSize: 1 }),
    });
    assert.equal(uploadHandle.status, 409);

    const snapshot = { sourceType: 'UPLOAD', submittedAt: new Date(current).toISOString() };
    const generic = await fetch(`${baseUrl}/api/v1/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ eventId: 'event-api-window-future', subjectId: 'w00123', snapshot }),
    });
    assert.equal(generic.status, 409);
    assert.match((await generic.json() as { message: string }).message, /window has not started/);

    const upload = await fetch(`${baseUrl}/api/v1/events/event-api-window-future/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ subjectId: 'w00123', artifactBase64: 'not-used', fileName: 'submission.zip', snapshot }),
    });
    assert.equal(upload.status, 409);

    const git = await fetch(`${baseUrl}/api/v1/events/event-api-window-future/submissions:register-git`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ subjectId: 'w00123', snapshot: { sourceType: 'GIT_REF', submittedAt: snapshot.submittedAt, repository: 'training/demo', branch: 'drill/w00123', commitSha: 'abcdef1' } }),
    });
    assert.equal(git.status, 409);

    const pastCreated = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'event-api-window-past',
        challengeVersion: 'parking-fee-01@1',
        submissionSource: 'UPLOAD',
        trigger: 'IMPORT',
        reveal: 'IMMEDIATE',
        mode: 'WINDOW',
        startsAt: new Date(current - 2 * 60 * 60 * 1000).toISOString(),
        endsAt: new Date(current - 60 * 60 * 1000).toISOString(),
      }),
    });
    assert.equal(pastCreated.status, 201);
    const past = await fetch(`${baseUrl}/api/v1/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ eventId: 'event-api-window-past', subjectId: 'w00123', snapshot }),
    });
    assert.equal(past.status, 409);
    assert.match((await past.json() as { message: string }).message, /window has ended/);
  });
});

test('upload rejects a ZIP that does not match the challenge delivery layout', async () => {
  await withApp(async (baseUrl) => {
    const uploaded = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' },
      body: JSON.stringify({
        subjectId: 'w00124',
        artifactBase64: ZIP_FIXTURES.invalidLayout,
        fileName: 'submission.zip',
        snapshot: { sourceType: 'UPLOAD', submittedAt: '2026-08-01T10:00:00Z' },
      }),
    });
    assert.equal(uploaded.status, 400);
    const body = await uploaded.json() as { code?: string; details?: { issues?: Array<{ code: string; path?: string }> } };
    assert.equal(body.code, 'DELIVERY_STRUCTURE_INVALID');
    assert.ok(body.details?.issues?.some((issue) => issue.code === 'REQUIRED_PATH_MISSING' && issue.path === 'SPEC.md'));
  });
});

test('external evaluation input can target one submission and import its prepared result', async () => {
  await withApp(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({
        id: 'event-import-selective',
        challengeVersion: 'parking-fee-01@1',
        submissionSource: 'UPLOAD',
        trigger: 'IMPORT',
        reveal: 'IMMEDIATE',
        mode: 'WINDOW',
        startsAt: '2026-08-01T09:00:00+08:00',
        endsAt: '2026-08-08T18:00:00+08:00',
      }),
    });
    assert.equal(created.status, 201);

    const firstBytes = Buffer.from(ZIP_FIXTURES.first, 'base64');
    const secondBytes = Buffer.from(ZIP_FIXTURES.second, 'base64');
    const upload = async (subjectId: string, bytes: Buffer, submittedAt: string) => {
      const response = await fetch(`${baseUrl}/api/v1/events/event-import-selective/submissions:upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-employee-id': subjectId },
        body: JSON.stringify({ subjectId, artifactBase64: bytes.toString('base64'), fileName: `${subjectId}.zip`, snapshot: { sourceType: 'UPLOAD', submittedAt } }),
      });
      assert.equal(response.status, 201);
      return await response.json() as { id: string; state: string; snapshot: { snapshotHash: string; artifactHash?: string; submittedAt: string; sourceType: string } };
    };
    const first = await upload('w00124', firstBytes, '2026-08-01T10:00:00Z');
    const second = await upload('w00126', secondBytes, '2026-08-01T10:01:00Z');
    const duplicate = await upload('w00130', firstBytes, '2026-08-01T10:02:00Z');
    assert.equal(first.state, 'WAITING_IMPORT');
    assert.equal(second.state, 'WAITING_IMPORT');
    assert.equal(duplicate.state, 'WAITING_IMPORT');

    const inputResponse = await fetch(`${baseUrl}/api/v1/events/event-import-selective/grading-input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ submissionIds: [first.id] }),
    });
    assert.equal(inputResponse.status, 201);
    const input = await inputResponse.json() as {
      schemaVersion: string;
      event: { trigger: string; challengeVersion: string };
      challenge: { evaluationEngine: { id: string; version: string; input: { contractPath: string }; output: { contractPath: string } } };
      submissions: Array<{ submissionId: string; snapshot: { snapshotHash: string; artifactHash?: string; submittedAt: string }; grading: { runId: string; idempotencyKey: string; triggerType: string } }>;
    };
    assert.equal(input.schemaVersion, '1.0');
    assert.equal(input.event.trigger, 'IMPORT');
    assert.equal(input.event.challengeVersion, 'parking-fee-01@1');
    assert.equal(input.challenge.evaluationEngine.id, 'parking-fee-evaluator');
    assert.equal(input.challenge.evaluationEngine.input.contractPath, 'contracts/evaluation-input.schema.json');
    assert.equal(input.challenge.evaluationEngine.output.contractPath, 'contracts/evaluation-result.schema.json');
    assert.equal(input.submissions.length, 1);
    assert.equal(input.submissions[0].submissionId, first.id);
    assert.equal(input.submissions[0].snapshot.snapshotHash, first.snapshot.snapshotHash);

    const fixture = JSON.parse(readFileSync(join(__dirname, '../../../contracts/examples/evaluation-result.valid.json'), 'utf8')) as Record<string, any>;
    fixture.resultId = 'result-import-selective-api';
    fixture.gradingRunId = input.submissions[0].grading.runId;
    fixture.challengeVersion = input.event.challengeVersion;
    fixture.rubricVersion = '1.0';
    fixture.graderVersion = input.challenge.evaluationEngine.version ?? '1.0.0';
    fixture.idempotencyKey = input.submissions[0].grading.idempotencyKey;
    fixture.triggerType = 'IMPORT';
    fixture.subject = { kind: 'person', id: 'w00124', name: '外部名称不作为身份来源' };
    fixture.submission = {
      sourceType: first.snapshot.sourceType,
      snapshotHash: first.snapshot.snapshotHash,
      artifactHash: first.snapshot.artifactHash,
      submittedAt: first.snapshot.submittedAt,
    };

    const imported = await fetch(`${baseUrl}/api/v1/grading-results:import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ result: fixture, eventId: 'event-import-selective', subjectId: 'w00124' }),
    });
    assert.equal(imported.status, 201);
    const importedBody = await imported.json() as { accepted: boolean; stored: { resultId: string; gradingRunId: string; submissionId: string } };
    assert.equal(importedBody.accepted, true);
    assert.equal(importedBody.stored.resultId, 'result-import-selective-api');
    assert.equal(importedBody.stored.gradingRunId, input.submissions[0].grading.runId);
    assert.equal(importedBody.stored.submissionId, first.id);

    const firstAfter = await fetch(`${baseUrl}/api/v1/submissions/${first.id}`, { headers: { 'x-employee-id': 'w00123' } });
    const secondAfter = await fetch(`${baseUrl}/api/v1/submissions/${second.id}`, { headers: { 'x-employee-id': 'w00123' } });
    const firstState = await firstAfter.json() as { state: string; resultId?: string };
    assert.equal(firstState.state, 'REVEALED');
    assert.equal(firstState.resultId, 'result-import-selective-api');
    const secondState = await secondAfter.json() as { state: string; resultId?: string; gradingRunId?: string };
    assert.equal(secondState.state, 'WAITING_IMPORT');
    assert.equal(secondState.resultId, undefined);
    assert.equal(secondState.gradingRunId, undefined);
    const duplicateAfter = await (await fetch(`${baseUrl}/api/v1/submissions/${duplicate.id}`, { headers: { 'x-employee-id': 'w00123' } })).json() as { state: string; resultId?: string; gradingRunId?: string };
    assert.equal(duplicateAfter.state, 'WAITING_IMPORT');
    assert.equal(duplicateAfter.resultId, undefined);
    assert.equal(duplicateAfter.gradingRunId, undefined);

    const duplicateInputResponse = await fetch(`${baseUrl}/api/v1/events/event-import-selective/grading-input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ submissionIds: [duplicate.id] }),
    });
    assert.equal(duplicateInputResponse.status, 201);
    const duplicateInput = await duplicateInputResponse.json() as { submissions: Array<{ grading: { runId: string } }> };
    assert.equal(duplicateInput.submissions.length, 1);
    assert.notEqual(duplicateInput.submissions[0].grading.runId, input.submissions[0].grading.runId);
  });
});

test('local grading executor runs the reference challenge without GitLab', async () => {
  await withApp(async (baseUrl) => {
    const submitted = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'w00123',
        snapshot: {
          sourceType: 'UPLOAD',
          workspacePath: 'challenges/parking-fee-v1/starter',
          submittedAt: '2026-08-01T10:00:00Z',
        },
      }),
    });
    assert.equal(submitted.status, 201);
    const submission = await submitted.json() as { id: string };
    const started = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}/start-grading`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actorId: 'admin-local' }),
    });
    assert.equal(started.status, 201);
    const run = await started.json() as { id: string };
    const executed = await fetch(`${baseUrl}/api/v1/grading-runs/${run.id}/execute`, { method: 'POST' });
    assert.equal(executed.status, 201);
    const body = await executed.json() as { run: { status: string }; stored: { result: { total: number; verifyDetail: { total: number }; subject?: { id: string; orgPath?: string } } } };
    assert.equal(body.run.status, 'GRADED');
    assert.equal(body.stored.result.verifyDetail.total, 25);
    assert.equal(body.stored.result.total, 52.5);
    assert.deepEqual(body.stored.result.subject, { kind: 'person', id: 'w00123', name: '本地开发用户', orgPath: '/1/12/125/' });

    const reportResponse = await fetch(`${baseUrl}/api/v1/reports/${submission.id}`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as {
      report: {
        summary: { score: number; evaluatedDimensions: number; findingCount: number };
        submission: { snapshotHash: string; sourceType: string };
        dimensionBreakdown: Array<{ key: string; percent: number | null }>;
        criteriaByDimension: Record<string, unknown[]>;
        recommendations: string[];
      };
    };
    assert.equal(report.report.summary.score, 52.5);
    assert.equal(report.report.summary.evaluatedDimensions, 2);
    assert.match(report.report.submission.snapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(report.report.submission.sourceType, 'UPLOAD');
    assert.equal(report.report.dimensionBreakdown.find((item) => item.key === 'verify')?.percent, 100);
    assert.ok(report.report.criteriaByDimension.verify.length > 0);
    assert.ok(report.report.recommendations.length > 0);

    const employeeLeaderboardResponse = await fetch(`${baseUrl}/api/v1/seasons/season-local-2026/leaderboard`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(employeeLeaderboardResponse.status, 200);
    const employeeLeaderboard = await employeeLeaderboardResponse.json() as Array<{ rank: number; nickname: string; name?: string; employeeNo?: string; subjectId?: string }>;
    assert.ok(employeeLeaderboard.length <= 3);
    assert.equal(employeeLeaderboard.length, 1);
    assert.equal(employeeLeaderboard[0].rank, 1);
    assert.equal(employeeLeaderboard[0].nickname, '未设置昵称');
    assert.equal(employeeLeaderboard[0].name, undefined);
    assert.equal(employeeLeaderboard[0].employeeNo, undefined);
    assert.equal(employeeLeaderboard[0].subjectId, undefined);

    const adminLeaderboardResponse = await fetch(`${baseUrl}/api/v1/seasons/season-local-2026/leaderboard`, { headers: { 'x-employee-id': 'w00123' } });
    assert.equal(adminLeaderboardResponse.status, 200);
    const adminLeaderboard = await adminLeaderboardResponse.json() as Array<{ rank: number; nickname: string; name?: string; employeeNo?: string; subjectId?: string }>;
    assert.ok(adminLeaderboard.length <= 3);
    assert.equal(adminLeaderboard[0].name, '本地开发用户');
    assert.equal(adminLeaderboard[0].employeeNo, 'w00123');
    assert.equal(adminLeaderboard[0].subjectId, 'w00123');

    const capabilityResponse = await fetch(`${baseUrl}/api/v1/profiles/w00123/capabilities`);
    assert.equal(capabilityResponse.status, 200);
    const capabilities = await capabilityResponse.json() as {
      summary: { gradedSubmissions: number; overallAverage: number; totalSkillItems: number; evaluatedSkillItems: number; totalCapabilityDomains: number; evaluatedCapabilityDomains: number; strongestDomain: string | null; focusDomain: string | null; zoneStats: { YELLOW: number; BLUE: number } };
      dimensions: Array<{ key: string; percent: number | null; evaluatedCount: number }>;
      domains: Array<{ key: string; label: string; percent: number | null; evidenceCount: number; status: string }>;
      capabilityCatalogVersion: string;
      trend: Array<{ total: number }>;
      skills: Array<{ key: string; criterionKey: string; domainKeys?: string[]; percent: number | null; averageLevel: string | null; sampleCount: number }>;
      gradeMatrix: Array<{ criterionKey: string }>;
      weakItems: Array<{ key: string; recommendation: string }>;
    };
    assert.equal(capabilities.summary.gradedSubmissions, 1);
    assert.equal(capabilities.summary.overallAverage, 52.5);
    assert.equal(capabilities.trend[0].total, 52.5);
    assert.equal(capabilities.dimensions.find((item) => item.key === 'verify')?.percent, 100);
    assert.equal(capabilities.dimensions.find((item) => item.key === 'spec')?.evaluatedCount, 0);
    assert.equal(capabilities.summary.totalSkillItems, 16);
    assert.equal(capabilities.summary.evaluatedSkillItems, 8);
    assert.equal(capabilities.summary.zoneStats.YELLOW, 1);
    assert.equal(capabilities.capabilityCatalogVersion, '1.1');
    assert.equal(capabilities.summary.totalCapabilityDomains, 8);
    assert.equal(capabilities.summary.evaluatedCapabilityDomains, 4);
    assert.equal(capabilities.domains.length, 8);
    assert.equal(capabilities.domains.find((item) => item.key === 'prompt_engineering')?.percent, null);
    assert.equal(capabilities.domains.find((item) => item.key === 'output_evaluation')?.percent, 100);
    assert.equal(capabilities.domains.find((item) => item.key === 'engineering_delivery')?.evidenceCount, 4);
    assert.equal(capabilities.skills.length, 16);
    assert.deepEqual(capabilities.skills.find((item) => item.criterionKey === 'P3')?.domainKeys, ['prompt_engineering']);
    assert.equal(capabilities.gradeMatrix.length, 16);
    assert.equal(capabilities.skills.find((item) => item.criterionKey === 'S1')?.percent, null);
    assert.ok(capabilities.weakItems.length >= 1);
    assert.ok(capabilities.weakItems[0].recommendation.length > 0);

    const employeeCapabilityResponse = await fetch(`${baseUrl}/api/v1/profiles/w00124/capabilities`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(employeeCapabilityResponse.status, 200);
    const employeeCapabilities = await employeeCapabilityResponse.json() as {
      summary: { departmentStatsVisible: boolean; departmentAverage: number | null; departmentMedian: number | null; departmentPercentile: number | null };
      dimensions: Array<{ peerMedianPercent: number | null; peerCount: number }>;
    };
    assert.equal(employeeCapabilities.summary.departmentStatsVisible, false);
    assert.equal(employeeCapabilities.summary.departmentAverage, null);
    assert.equal(employeeCapabilities.summary.departmentMedian, null);
    assert.equal(employeeCapabilities.summary.departmentPercentile, null);
    assert.ok(employeeCapabilities.dimensions.every((item) => item.peerMedianPercent === null && item.peerCount === 0));

    const departmentAdminCapabilityResponse = await fetch(`${baseUrl}/api/v1/profiles/w00124/capabilities`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(departmentAdminCapabilityResponse.status, 200);
    const departmentAdminCapabilities = await departmentAdminCapabilityResponse.json() as {
      summary: { departmentStatsVisible: boolean; departmentAverage: number | null };
      dimensions: Array<{ peerMedianPercent: number | null; peerCount: number }>;
    };
    assert.equal(departmentAdminCapabilities.summary.departmentStatsVisible, true);
    assert.equal(departmentAdminCapabilities.summary.departmentAverage, 52.5);
    assert.ok(departmentAdminCapabilities.dimensions.some((item) => item.peerMedianPercent !== null && item.peerCount > 0));

    const profileWithoutHistoryResponse = await fetch(`${baseUrl}/api/v1/profiles/w00123?includeHistory=false`);
    assert.equal(profileWithoutHistoryResponse.status, 200);
    const profileWithoutHistory = await profileWithoutHistoryResponse.json() as { history: unknown[]; stats: { graded: number } };
    assert.deepEqual(profileWithoutHistory.history, []);
    assert.equal(profileWithoutHistory.stats.graded, 1);

    const profileHistoryResponse = await fetch(`${baseUrl}/api/v1/profiles/w00123/history?page=1&pageSize=1`);
    assert.equal(profileHistoryResponse.status, 200);
    const profileHistory = await profileHistoryResponse.json() as { items: Array<{ submissionId: string; total: number }>; pageInfo: { page: number; pageSize: number; total: number; totalPages: number } };
    assert.equal(profileHistory.items.length, 1);
    assert.equal(profileHistory.items[0].total, 52.5);
    assert.deepEqual(profileHistory.pageInfo, { page: 1, pageSize: 1, total: 1, totalPages: 1, hasNext: false, hasPrevious: false });

    const allPeopleResponse = await fetch(`${baseUrl}/api/v1/admin/capabilities`);
    assert.equal(allPeopleResponse.status, 200);
    const allPeople = await allPeopleResponse.json() as {
      selection: { mode: string; orgPath: string | null; eventId: string | null };
      totalCandidates: number;
      selectedCount: number;
      gradedUsers: number;
      aggregate: { skills: Array<{ key: string; percent: number | null; evaluatedUsers: number }> };
      profiles: Array<{ subject: { id: string }; profile: { summary: { gradedSubmissions: number } } }>;
      profilePageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean };
    };
    assert.equal(allPeople.selection.mode, 'ALL');
    assert.equal(allPeople.selection.orgPath, null);
    assert.equal(allPeople.selection.eventId, null);
    assert.equal(allPeople.totalCandidates, 10);
    assert.equal(allPeople.selectedCount, 10);
    assert.equal(allPeople.gradedUsers, 1);
    assert.deepEqual(allPeople.profilePageInfo, { page: 1, pageSize: 20, total: 10, totalPages: 1, hasNext: false, hasPrevious: false });
    assert.equal(allPeople.aggregate.skills.length, 16);
    assert.equal(allPeople.profiles.find((item) => item.subject.id === 'w00123')?.profile.summary.gradedSubmissions, 1);

    const eventPeopleResponse = await fetch(`${baseUrl}/api/v1/admin/capabilities?eventId=event-local`);
    assert.equal(eventPeopleResponse.status, 200);
    const eventPeople = await eventPeopleResponse.json() as {
      selection: { mode: string; orgPath: string | null; eventId: string | null };
      totalCandidates: number;
      selectedCount: number;
      gradedUsers: number;
      aggregate: { overallAverage: number | null };
      profiles: Array<{ subject: { id: string }; profile: { summary: { gradedSubmissions: number; overallAverage: number | null } } }>;
    };
    assert.equal(eventPeople.selection.eventId, 'event-local');
    assert.equal(eventPeople.totalCandidates, 1);
    assert.equal(eventPeople.selectedCount, 1);
    assert.equal(eventPeople.gradedUsers, 1);
    assert.equal(eventPeople.aggregate.overallAverage, 52.5);
    assert.deepEqual(eventPeople.profiles.map((item) => item.subject.id), ['w00123']);
    assert.equal(eventPeople.profiles[0].profile.summary.gradedSubmissions, 1);
    assert.equal(eventPeople.profiles[0].profile.summary.overallAverage, 52.5);

    const missingEventResponse = await fetch(`${baseUrl}/api/v1/admin/capabilities?eventId=event-does-not-exist`);
    assert.equal(missingEventResponse.status, 404);

    const selectedResponse = await fetch(`${baseUrl}/api/v1/admin/capabilities?orgPath=%2F1%2F12%2F125%2F&subjectIds=w00124,w00126&includeProfiles=false`);
    assert.equal(selectedResponse.status, 200);
    const selected = await selectedResponse.json() as { selection: { mode: string; subjectIds: string[] }; selectedCount: number; aggregate: { skills: Array<{ key: string }> }; profiles: unknown[] };
    assert.equal(selected.selection.mode, 'SELECTED');
    assert.deepEqual(selected.selection.subjectIds, ['w00124', 'w00126']);
    assert.equal(selected.selectedCount, 2);
    assert.equal(selected.aggregate.skills.length, 16);
    assert.equal(selected.profiles.length, 0);

    const pagedPeopleResponse = await fetch(`${baseUrl}/api/v1/admin/capabilities?page=2&pageSize=2&historyPageSize=1`);
    assert.equal(pagedPeopleResponse.status, 200);
    const pagedPeople = await pagedPeopleResponse.json() as { profiles: Array<{ subject: { id: string } }>; profilePageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean } };
    assert.equal(pagedPeople.profiles.length, 2);
    assert.deepEqual(pagedPeople.profilePageInfo, { page: 2, pageSize: 2, total: 10, totalPages: 5, hasNext: true, hasPrevious: true });

    const outsideScope = await fetch(`${baseUrl}/api/v1/admin/capabilities?orgPath=%2F1%2F12%2F125%2F&subjectIds=w00125`);
    assert.equal(outsideScope.status, 400);
  });
});

test('local grading rejects a workspace changed after submission', async () => {
  const projectRoot = resolve(__dirname, '../../..');
  const temporaryWorkspace = mkdtempSync(join(projectRoot, 'challenges', 'parking-fee-v1', 'workspace-tamper-'));
  cpSync(join(projectRoot, 'challenges', 'parking-fee-v1', 'starter'), temporaryWorkspace, { recursive: true });
  try {
    await withApp(async (baseUrl) => {
      const workspacePath = relative(projectRoot, temporaryWorkspace).split('\\').join('/');
      const submitted = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectId: 'w00123', snapshot: { sourceType: 'UPLOAD', workspacePath, submittedAt: '2026-08-01T10:00:00Z' } }),
      });
      assert.equal(submitted.status, 201);
      const submission = await submitted.json() as { id: string };
      const started = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}/start-grading`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(started.status, 201);
      const run = await started.json() as { id: string };
      const source = join(temporaryWorkspace, 'src', 'parking.py');
      writeFileSync(source, `${readFileSync(source, 'utf8')}\n# changed after submission\n`, 'utf8');
      const executed = await fetch(`${baseUrl}/api/v1/grading-runs/${run.id}/execute`, { method: 'POST' });
      assert.equal(executed.status, 400);
      const body = await executed.json() as { message?: string };
      assert.match(String(body.message), /SNAPSHOT_CHANGED|snapshotHash|快照/);
      const runResponse = await fetch(`${baseUrl}/api/v1/grading-runs/${run.id}`);
      assert.equal((await runResponse.json() as { status: string }).status, 'FAILED');
    });
  } finally {
    rmSync(temporaryWorkspace, { recursive: true, force: true });
  }
});

test('AUTO submissions are dispatched by the local queue without a manual trigger', async () => {
  await withApp(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'event-auto-local', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'AUTO', reveal: 'IMMEDIATE',
        deliveryConfig: { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024 },
        localGrading: { contractPath: 'challenges/parking-fee-v1/submission-contract.json', testsDir: 'challenges/parking-fee-v1/hidden-tests', entry: 'src/parking.py', function: 'calculate_fee', language: 'python' },
      }),
    });
    assert.equal(created.status, 201);
    const submitted = await fetch(`${baseUrl}/api/v1/events/event-auto-local/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'w00123',
        snapshot: { sourceType: 'UPLOAD', workspacePath: 'challenges/parking-fee-v1/starter', submittedAt: '2026-08-01T10:00:00Z' },
      }),
    });
    assert.equal(submitted.status, 201);
    const submission = await submitted.json() as { id: string; state: string };
    assert.equal(submission.state, 'QUEUED');
    let completed: { resultId?: string; state?: string } = {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}`);
      completed = await response.json() as { resultId?: string; state?: string };
      if (completed.resultId) break;
    }
    assert.ok(completed.resultId);
    assert.equal(completed.state, 'REVEALED');
  });
});

test('administrator workspace endpoints manage challenge versions and announcements', async () => {
  await withApp(async (baseUrl) => {
    const overview = await fetch(`${baseUrl}/api/v1/admin/overview`);
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as { challenges: { total: number }; events: { open: number } };
    assert.ok(overviewBody.challenges.total >= 3);
    assert.ok(overviewBody.events.open >= 1);

    const created = await fetch(`${baseUrl}/api/v1/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'admin-api-demo', ownerOrgPath: '/', origin: 'OFFICIAL', category: 'COMPETITION', status: 'DRAFT', versions: [{
          id: 'admin-api-demo@1', challengeId: 'admin-api-demo', version: 1, title: 'API 管理题', zone: 'YELLOW',
          languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
          rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'DRAFT',
        }],
      }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.clone().json() as { category: string }).category, 'COMPETITION');
    const categorized = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'HARD_PROBLEM' }),
    });
    assert.equal(categorized.status, 200);
    const categorizedBody = await categorized.json() as { category: string; board?: { type?: string } };
    assert.equal(categorizedBody.category, 'HARD_PROBLEM');
    assert.equal(categorizedBody.board?.type, 'HARD_PROBLEM');
    const invalidCategory = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'UNKNOWN' }),
    });
    assert.equal(invalidCategory.status, 400);
    const reclassified = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'COMPETITION' }),
    });
    assert.equal(reclassified.status, 200);
    const reclassifiedBody = await reclassified.json() as { category: string; board?: unknown };
    assert.equal(reclassifiedBody.category, 'COMPETITION');
    assert.equal(reclassifiedBody.board, undefined);
    const categorizedAgain = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'HARD_PROBLEM' }),
    });
    assert.equal(categorizedAgain.status, 200);
    assert.equal((await categorizedAgain.json() as { board?: { type?: string } }).board?.type, 'HARD_PROBLEM');
    const updated = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo/versions/admin-api-demo@1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: '管理员编辑后的题目说明' }),
    });
    assert.equal(updated.status, 200);
    const published = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo/versions/admin-api-demo@1/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(published.status, 201);
    const hardBoard = await fetch(`${baseUrl}/api/v1/hard-problems?status=OPEN`);
    assert.ok((await hardBoard.json() as Array<{ id: string }>).some((item) => item.id === 'admin-api-demo'));
    const trashed = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo`, {
      method: 'DELETE',
    });
    assert.equal(trashed.status, 200);
    assert.equal((await trashed.json() as { status: string }).status, 'ARCHIVED');
    const restored = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(restored.status, 201);
    assert.equal((await restored.json() as { status: string }).status, 'PUBLISHED');

    const purgeChallenge = await fetch(`${baseUrl}/api/v1/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'admin-api-purge', ownerOrgPath: '/', origin: 'OFFICIAL', category: 'TRAINING', status: 'DRAFT', versions: [{
          id: 'admin-api-purge@1', challengeId: 'admin-api-purge', version: 1, title: 'API 永久删除题', zone: 'YELLOW',
          languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
          rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'DRAFT',
        }],
      }),
    });
    assert.equal(purgeChallenge.status, 201);
    const purgeArchived = await fetch(`${baseUrl}/api/v1/challenges/admin-api-purge`, { method: 'DELETE' });
    assert.equal(purgeArchived.status, 200);
    assert.equal((await purgeArchived.json() as { status: string }).status, 'ARCHIVED');
    const purged = await fetch(`${baseUrl}/api/v1/challenges/admin-api-purge/permanent`, { method: 'DELETE' });
    assert.equal(purged.status, 200);
    assert.deepEqual(await purged.json() as { id: string; status: string }, { id: 'admin-api-purge', status: 'PURGED' });
    assert.equal((await fetch(`${baseUrl}/api/v1/challenges/admin-api-purge`)).status, 404);

    const editableEvent = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'admin-api-delete-event', challengeVersion: 'parking-fee-01@1', submissionSource: 'UPLOAD', trigger: 'IMPORT', reveal: 'IMMEDIATE' }),
    });
    assert.equal(editableEvent.status, 201);
    const editedEvent = await fetch(`${baseUrl}/api/v1/events/admin-api-delete-event`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reveal: 'ON_RELEASE' }),
    });
    assert.equal(editedEvent.status, 200);
    assert.equal((await editedEvent.json() as { reveal: string }).reveal, 'ON_RELEASE');
    const deletedEvent = await fetch(`${baseUrl}/api/v1/events/admin-api-delete-event`, { method: 'DELETE' });
    assert.equal(deletedEvent.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/v1/events/admin-api-delete-event`)).status, 404);

    const announcement = await fetch(`${baseUrl}/api/v1/announcements`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API 公告', summary: '公告内容', tag: '平台通知', publishedAt: '2026-08-01T10:00:00Z' }),
    });
    assert.equal(announcement.status, 201);
    const announcementBody = await announcement.json() as { id: string };
    const removed = await fetch(`${baseUrl}/api/v1/announcements/${announcementBody.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(removed.status, 204);
  });
});

test('local identity adapter enforces administrator, self-service and event participant boundaries', async () => {
  await withApp(async (baseUrl) => {
    const publicChallenges = await fetch(`${baseUrl}/api/v1/challenges`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(publicChallenges.status, 200);
    const publicChallengeList = await publicChallenges.json() as Array<{ id: string; versions: Array<{ evaluationEngine?: unknown }> }>;
    assert.equal(publicChallengeList.find((challenge) => challenge.id === 'parking-fee-01')?.versions[0]?.evaluationEngine, undefined);
    const adminChallenges = await fetch(`${baseUrl}/api/v1/challenges`, { headers: { 'x-employee-id': 'w00123' } });
    assert.equal(adminChallenges.status, 200);
    const adminChallengeList = await adminChallenges.json() as Array<{ id: string; versions: Array<{ evaluationEngine?: { id: string } }> }>;
    assert.equal(adminChallengeList.find((challenge) => challenge.id === 'parking-fee-01')?.versions[0]?.evaluationEngine?.id, 'parking-fee-evaluator');

    const forbiddenOverview = await fetch(`${baseUrl}/api/v1/admin/overview`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(forbiddenOverview.status, 403);

    const forbiddenProfile = await fetch(`${baseUrl}/api/v1/profiles/w00123`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(forbiddenProfile.status, 403);

    const forbiddenCapabilities = await fetch(`${baseUrl}/api/v1/profiles/w00123/capabilities`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(forbiddenCapabilities.status, 403);

    const forbiddenAdminCapabilities = await fetch(`${baseUrl}/api/v1/admin/capabilities`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(forbiddenAdminCapabilities.status, 403);

    const forbiddenCreate = await fetch(`${baseUrl}/api/v1/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' },
      body: JSON.stringify({ id: 'should-not-create', actorId: 'w00123' }),
    });
    assert.equal(forbiddenCreate.status, 403);

    const configured = await fetch(`${baseUrl}/api/v1/events/event-local/participants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ subjectIds: ['w00124'] }),
    });
    assert.equal(configured.status, 200);
    assert.equal((await configured.json() as Array<{ subjectId: string }>).length, 1);

    const rejected = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00125' },
      body: JSON.stringify({ subjectId: 'w00125', snapshot: { sourceType: 'UPLOAD', submittedAt: '2026-08-01T10:00:00Z' } }),
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' },
      body: JSON.stringify({ subjectId: 'w00124', artifactBase64: ZIP_FIXTURES.allowlisted, fileName: 'submission.zip', snapshot: { sourceType: 'UPLOAD', submittedAt: '2026-08-01T10:00:00Z' } }),
    });
    assert.equal(accepted.status, 201);
  });
});

test('global and department administrators are isolated by organization scope', async () => {
  await withApp(async (baseUrl) => {
    const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(me.status, 200);
    const identity = await me.json() as { roles: string[]; orgPath: string };
    assert.ok(identity.roles.includes('department_admin'));
    assert.equal(identity.orgPath, '/1/12/125/');

    const overview = await fetch(`${baseUrl}/api/v1/admin/overview`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(overview.status, 200);

    const users = await fetch(`${baseUrl}/api/v1/users`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(users.status, 200);
    const scopedPage = await users.json() as { items: Array<{ id: string }>; pageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean } };
    assert.ok(scopedPage.items.some((user) => user.id === 'w00124'));
    assert.ok(!scopedPage.items.some((user) => user.id === 'w00125'));
    assert.equal(scopedPage.pageInfo.page, 1);
    assert.equal(scopedPage.pageInfo.pageSize, 20);
    assert.equal(scopedPage.pageInfo.total, scopedPage.items.length);

    const filtered = await fetch(`${baseUrl}/api/v1/users?page=1&pageSize=2&query=w0012&role=learner&sortBy=employeeNo&sortOrder=desc`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(filtered.status, 200);
    const filteredPage = await filtered.json() as { items: Array<{ employeeNo: string; roles: string[] }>; pageInfo: { page: number; pageSize: number; totalPages: number } };
    assert.equal(filteredPage.pageInfo.pageSize, 2);
    assert.ok(filteredPage.items.every((user) => user.roles.includes('learner')));
    assert.ok(filteredPage.items.every((user, index, rows) => index === 0 || rows[index - 1].employeeNo >= user.employeeNo));

    const outsideUsers = await fetch(`${baseUrl}/api/v1/users?orgPath=/1/12/`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(outsideUsers.status, 403);
    const invalidUsers = await fetch(`${baseUrl}/api/v1/users?pageSize=101`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(invalidUsers.status, 400);

    const employeeUsers = await fetch(`${baseUrl}/api/v1/users`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(employeeUsers.status, 403);

    const outsideCapabilities = await fetch(`${baseUrl}/api/v1/admin/capabilities?subjectIds=w00125`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(outsideCapabilities.status, 400);

    const outsideEventCapabilities = await fetch(`${baseUrl}/api/v1/admin/capabilities?eventId=event-local`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(outsideEventCapabilities.status, 403);

    const outsideChallengeUpdate = await fetch(`${baseUrl}/api/v1/challenges/parking-fee-01`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00134' },
      body: JSON.stringify({ category: 'COMPETITION' }),
    });
    assert.equal(outsideChallengeUpdate.status, 403);

    const globalOnlySeason = await fetch(`${baseUrl}/api/v1/seasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00134' },
      body: JSON.stringify({ id: 'season-department-denied', name: '部门赛季', eventIds: [], status: 'DRAFT' }),
    });
    assert.equal(globalOnlySeason.status, 403);
  });
});

test('hard problem board lists unresolved problems and supports employee publishing and resolution', async () => {
  await withApp(async (baseUrl) => {
    const initial = await fetch(`${baseUrl}/api/v1/hard-problems`);
    assert.equal(initial.status, 200);
    const initialProblems = await initial.json() as Array<{ id: string; status: string; publisherType: string }>;
    assert.ok(initialProblems.length >= 3);
    assert.ok(initialProblems.every((problem) => problem.status === 'OPEN'));
    assert.ok(initialProblems.some((problem) => problem.publisherType === 'DEPARTMENT'));
    assert.ok(initialProblems.some((problem) => problem.publisherType === 'EMPLOYEE'));

    const departmentProblem = initialProblems.find((problem) => problem.publisherType === 'DEPARTMENT');
    assert.ok(departmentProblem);
    const unauthorizedDepartmentResolve = await fetch(`${baseUrl}/api/v1/hard-problems/${departmentProblem.id}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' }, body: JSON.stringify({}),
    });
    assert.equal(unauthorizedDepartmentResolve.status, 403);

    const library = await fetch(`${baseUrl}/api/v1/challenges`, { headers: { 'x-employee-id': 'w00124' } });
    assert.equal(library.status, 200);
    const libraryChallenges = await library.json() as Array<{ id: string; category?: string; board?: { type?: string; status?: string } }>;
    const boardChallenge = libraryChallenges.find((challenge) => challenge.id === initialProblems[0].id);
    assert.equal(boardChallenge?.category, 'HARD_PROBLEM');
    assert.equal(boardChallenge?.board?.type, 'HARD_PROBLEM');
    assert.equal(boardChallenge?.board?.status, 'OPEN');

    const created = await fetch(`${baseUrl}/api/v1/hard-problems`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' },
      body: JSON.stringify({
        title: '如何快速验证跨服务提示词变更的影响？',
        summary: '需要一套低成本的回归验证方式，避免提示词调整影响现有交付。',
        publisherType: 'EMPLOYEE', publisherId: 'w00124', publisherName: '本地学员 A', departmentName: 'AI 工程团队',
        difficulty: 'LOW', tags: ['提示词工程', '回归验证'],
      }),
    });
    assert.equal(created.status, 201);
    const createdProblem = await created.json() as { id: string; status: string; reviewStatus: string; publisherName: string; submissionEventId?: string };
    assert.equal(createdProblem.status, 'OPEN');
    assert.equal(createdProblem.reviewStatus, 'PENDING_REVIEW');
    assert.equal(createdProblem.publisherName, '本地学员 A');

    const hiddenFromBoard = await fetch(`${baseUrl}/api/v1/hard-problems?status=OPEN`, { headers: { 'x-employee-id': 'w00125' } });
    assert.equal(hiddenFromBoard.status, 200);
    assert.ok(!(await hiddenFromBoard.json() as Array<{ id: string }>).some((problem) => problem.id === createdProblem.id));

    const createdLibrary = await fetch(`${baseUrl}/api/v1/challenges`, { headers: { 'x-employee-id': 'w00124' } });
    const createdLibraryChallenges = await createdLibrary.json() as Array<{ id: string; category?: string; board?: { type?: string; status?: string } }>;
    assert.equal(createdLibraryChallenges.find((challenge) => challenge.id === createdProblem.id)?.category, 'HARD_PROBLEM');
    assert.equal(createdLibraryChallenges.find((challenge) => challenge.id === createdProblem.id)?.board?.type, 'HARD_PROBLEM');

    const reviewed = await fetch(`${baseUrl}/api/v1/hard-problems/${createdProblem.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ decision: 'APPROVE', comment: '问题描述清晰，可以进入难题榜。' }),
    });
    assert.equal(reviewed.status, 201);
    const reviewedProblem = await reviewed.json() as { reviewStatus: string; submissionEventId?: string };
    assert.equal(reviewedProblem.reviewStatus, 'APPROVED');
    assert.ok(reviewedProblem.submissionEventId);

    const visibleOnBoard = await fetch(`${baseUrl}/api/v1/hard-problems?status=OPEN`, { headers: { 'x-employee-id': 'w00125' } });
    assert.ok((await visibleOnBoard.json() as Array<{ id: string }>).some((problem) => problem.id === createdProblem.id));

    const deliveryEvent = await fetch(`${baseUrl}/api/v1/events/${reviewedProblem.submissionEventId}`, { headers: { 'x-employee-id': 'w00125' } });
    assert.equal(deliveryEvent.status, 200);
    const deliveryConfig = await deliveryEvent.json() as { purpose?: string; submissionSource?: string; status?: string };
    assert.equal(deliveryConfig.purpose, 'HARD_PROBLEM');
    assert.equal(deliveryConfig.submissionSource, 'UPLOAD');
    assert.equal(deliveryConfig.status, 'OPEN');

    const delivery = await fetch(`${baseUrl}/api/v1/events/${reviewedProblem.submissionEventId}/submissions:upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-employee-id': 'w00125' },
      body: JSON.stringify({ subjectId: 'w00125', artifactBase64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', fileName: 'solution.zip', snapshot: { sourceType: 'UPLOAD', submittedAt: '2026-08-01T10:00:00Z' } }),
    });
    const deliveryBody = await delivery.text();
    assert.equal(delivery.status, 201, deliveryBody);
    const submittedSolution = JSON.parse(deliveryBody) as { id: string; state: string; snapshot?: { artifactName?: string } };
    assert.equal(submittedSolution.state, 'WAITING_TRIGGER');
    assert.equal(submittedSolution.snapshot?.artifactName, 'solution.zip');

    const resolved = await fetch(`${baseUrl}/api/v1/hard-problems/${createdProblem.id}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-employee-id': 'w00124' }, body: JSON.stringify({ submissionId: submittedSolution.id }),
    });
    assert.equal(resolved.status, 201);
    const resolvedProblem = await resolved.json() as { status: string; resolvedBy?: string; resolvedByName?: string; solverId?: string; solverName?: string; solution?: { submissionId: string; solverName: string; artifactName?: string }; solutionVisibility?: string };
    assert.equal(resolvedProblem.status, 'RESOLVED');
    assert.equal(resolvedProblem.resolvedBy, 'w00124');
    assert.equal(resolvedProblem.resolvedByName, '本地学员 A');
    assert.equal(resolvedProblem.solverId, 'w00125');
    assert.equal(resolvedProblem.solverName, '本地学员 B');
    assert.equal(resolvedProblem.solution?.submissionId, submittedSolution.id);
    assert.equal(resolvedProblem.solution?.solverName, '本地学员 B');
    assert.equal(resolvedProblem.solution?.artifactName, 'solution.zip');
    assert.equal(resolvedProblem.solutionVisibility, 'PUBLIC');

    const openAfterResolve = await fetch(`${baseUrl}/api/v1/hard-problems?status=OPEN`);
    assert.ok(!(await openAfterResolve.json() as Array<{ id: string }>).some((problem) => problem.id === createdProblem.id));
    const resolvedList = await fetch(`${baseUrl}/api/v1/hard-problems?status=RESOLVED`);
    const resolvedProblems = await resolvedList.json() as Array<{ id: string; solverName?: string; solution?: { artifactName?: string } }>;
    const resolvedBoardItem = resolvedProblems.find((problem) => problem.id === createdProblem.id);
    assert.equal(resolvedBoardItem?.solverName, '本地学员 B');
    assert.equal(resolvedBoardItem?.solution?.artifactName, 'solution.zip');

    const hiddenConfig = await fetch(`${baseUrl}/api/v1/challenges/${createdProblem.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' }, body: JSON.stringify({ solutionVisibility: 'HIDDEN' }),
    });
    assert.equal(hiddenConfig.status, 200);
    assert.equal((await hiddenConfig.json() as { board?: { solutionVisibility?: string } }).board?.solutionVisibility, 'HIDDEN');
    const hiddenForEmployee = await fetch(`${baseUrl}/api/v1/hard-problems/${createdProblem.id}`, { headers: { 'x-employee-id': 'w00125' } });
    const hiddenEmployeeProblem = await hiddenForEmployee.json() as { solutionVisibility?: string; solverName?: string; solution?: unknown };
    assert.equal(hiddenEmployeeProblem.solutionVisibility, 'HIDDEN');
    assert.equal(hiddenEmployeeProblem.solverName, '本地学员 B');
    assert.equal(hiddenEmployeeProblem.solution, undefined);
    const hiddenForAdmin = await fetch(`${baseUrl}/api/v1/hard-problems/${createdProblem.id}`, { headers: { 'x-employee-id': 'w00123' } });
    assert.ok((await hiddenForAdmin.json() as { solution?: { artifactName?: string } }).solution?.artifactName === 'solution.zip');

    const resolvedLibrary = await fetch(`${baseUrl}/api/v1/challenges`, { headers: { 'x-employee-id': 'w00124' } });
    const resolvedLibraryChallenges = await resolvedLibrary.json() as Array<{ id: string; category?: string; board?: { type?: string; status?: string } }>;
    assert.equal(resolvedLibraryChallenges.find((challenge) => challenge.id === createdProblem.id)?.category, 'HARD_PROBLEM');
    assert.equal(resolvedLibraryChallenges.find((challenge) => challenge.id === createdProblem.id)?.board?.status, 'RESOLVED');

    const closedDeliveryEvent = await fetch(`${baseUrl}/api/v1/events/${reviewedProblem.submissionEventId}`, { headers: { 'x-employee-id': 'w00125' } });
    assert.equal((await closedDeliveryEvent.json() as { status: string }).status, 'CLOSED');
  });
});

test('employees can update their own nickname and validated avatar', async () => {
  await withApp(async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-employee-id': 'w00124' };
    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const updated = await fetch(`${baseUrl}/api/v1/me/profile`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ nickname: 'Parking Hero', avatarDataUrl }),
    });
    assert.equal(updated.status, 200);
    const user = await updated.json() as { id: string; name: string; nickname?: string; avatarDataUrl?: string };
    assert.equal(user.id, 'w00124');
    assert.equal(user.nickname, 'Parking Hero');
    assert.equal(user.avatarDataUrl, avatarDataUrl);
    assert.equal(user.name, '本地学员 A');

    const profile = await fetch(`${baseUrl}/api/v1/profiles/w00124?includeHistory=false`, { headers });
    assert.equal(profile.status, 200);
    const profileBody = await profile.json() as { subject: { nickname?: string; avatarDataUrl?: string } };
    assert.equal(profileBody.subject.nickname, 'Parking Hero');
    assert.equal(profileBody.subject.avatarDataUrl, avatarDataUrl);

    const invalidAvatar = await fetch(`${baseUrl}/api/v1/me/profile`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ avatarDataUrl: 'https://example.com/avatar.png' }),
    });
    assert.equal(invalidAvatar.status, 400);

    const invalidNickname = await fetch(`${baseUrl}/api/v1/me/profile`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ nickname: 'x'.repeat(33) }),
    });
    assert.equal(invalidNickname.status, 400);

    const cleared = await fetch(`${baseUrl}/api/v1/me/profile`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ nickname: null, avatarDataUrl: null }),
    });
    assert.equal(cleared.status, 200);
    const clearedUser = await cleared.json() as { nickname?: string; avatarDataUrl?: string };
    assert.equal(clearedUser.nickname, undefined);
    assert.equal(clearedUser.avatarDataUrl, undefined);
  });
});

test('SSO login provisions users, matches departments, and removes manual employee creation', async () => {
  await withApp(async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/v1/auth/sso`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);

    const first = await fetch(`${baseUrl}/api/v1/auth/sso`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'w01002', name: 'SSO 新员工', department: 'AI 工程团队' }),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json() as { firstLogin: boolean; departmentMatched: boolean; user: { id: string; orgPath: string; roles: string[] } };
    assert.equal(firstBody.firstLogin, true);
    assert.equal(firstBody.departmentMatched, true);
    assert.equal(firstBody.user.id, 'w01002');
    assert.equal(firstBody.user.orgPath, '/1/12/125/');
    assert.deepEqual(firstBody.user.roles, ['learner']);

    const repeated = await fetch(`${baseUrl}/api/v1/auth/sso`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'w01002', name: 'SSO 新员工（更新）', department: '尚未建立部门' }),
    });
    assert.equal(repeated.status, 201);
    const repeatedBody = await repeated.json() as { firstLogin: boolean; user: { name: string; orgPath: string } };
    assert.equal(repeatedBody.firstLogin, false);
    assert.equal(repeatedBody.user.name, 'SSO 新员工（更新）');
    assert.equal(repeatedBody.user.orgPath, '/1/12/125/');

    const unmatched = await fetch(`${baseUrl}/api/v1/auth/sso`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'w01003', name: '待配置员工', department: '新组织单元' }),
    });
    assert.equal(unmatched.status, 201);
    const unmatchedBody = await unmatched.json() as { user: { orgPath: string; orgUnitId: string; departmentHint?: string } };
    assert.equal(unmatchedBody.user.orgPath, '');
    assert.equal(unmatchedBody.user.orgUnitId, '');
    assert.equal(unmatchedBody.user.departmentHint, '新组织单元');

    const configured = await fetch(`${baseUrl}/api/v1/users/w01003`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ orgUnitId: 'org-125', roles: ['learner', 'mentor'] }),
    });
    assert.equal(configured.status, 200);
    const configuredBody = await configured.json() as { orgPath: string; roles: string[]; departmentHint?: string };
    assert.equal(configuredBody.orgPath, '/1/12/125/');
    assert.deepEqual(configuredBody.roles, ['learner', 'mentor']);
    assert.equal(configuredBody.departmentHint, undefined);

    const syncedForMe = await fetch(`${baseUrl}/api/v1/auth/sso`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeNo: 'w01004', name: 'GatewayUser', department: 'AI-Engineering' }),
    });
    assert.equal(syncedForMe.status, 201);
    const gatewayUser = await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-employee-id': 'w01004' } });
    assert.equal(gatewayUser.status, 200);
    assert.equal((await gatewayUser.json() as { id: string; name: string }).id, 'w01004');

    const manualCreate = await fetch(`${baseUrl}/api/v1/users`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-employee-id': 'w00123' },
      body: JSON.stringify({ id: 'w01005', employeeNo: 'w01005', name: '不应手工创建', orgUnitId: 'org-125' }),
    });
    assert.ok(manualCreate.status >= 400);
  });
});

test('API rejects requests without an identity unless anonymous local mode is explicitly enabled', async () => {
  const previous = process.env.ALLOW_ANONYMOUS_LOCAL;
  process.env.ALLOW_ANONYMOUS_LOCAL = 'false';
  try {
    await withApp(async (baseUrl) => {
      const anonymous = await fetch(`${baseUrl}/api/v1/me`);
      assert.equal(anonymous.status, 401);
      const authenticated = await fetch(`${baseUrl}/api/v1/me`, { headers: { 'x-employee-id': 'w00124' } });
      assert.equal(authenticated.status, 200);
    });
  } finally {
    if (previous === undefined) delete process.env.ALLOW_ANONYMOUS_LOCAL;
    else process.env.ALLOW_ANONYMOUS_LOCAL = previous;
  }
});

// The whole point of the pull model: the API hands out work, an evaluation
// environment runs it. This exercises the real Nest container, which caught a
// wiring bug that unit tests constructing services by hand could not.
test('an evaluation environment leases work through the API for both engine sources', async () => {
  const previousEmbedded = process.env.EMBEDDED_EVALUATION_WORKER;
  const previousProjectRoot = process.env.PROJECT_ROOT;
  const engineRoot = mkdtempSync(join(tmpdir(), 'api-engine-'));
  process.env.EMBEDDED_EVALUATION_WORKER = 'false';
  process.env.PROJECT_ROOT = join(__dirname, '..', '..', '..');
  process.env.ENGINE_PACKAGE_ROOT = join(engineRoot, 'packages');
  try {
    await withApp(async (baseUrl) => {
      const admin = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };

      const executors = await (await fetch(`${baseUrl}/api/v1/evaluation-executors`, { headers: admin })).json() as Array<{ id: string; params: { required: string[] } }>;
      assert.ok(executors.some((item) => item.id === 'drill-grader'));

      // A built-in executor task.
      const submitted = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({ subjectId: 'w00124', snapshot: { sourceType: 'UPLOAD', workspacePath: 'challenges/parking-fee-v1/reference', submittedAt: '2026-08-01T10:00:00Z' } }),
      });
      assert.equal(submitted.status, 201);
      const submission = await submitted.json() as { id: string };
      await fetch(`${baseUrl}/api/v1/submissions/${submission.id}/start-grading`, { method: 'POST', headers: admin, body: '{}' });

      // Upload an engine package and pin a challenge to it.
      const archive = join(engineRoot, 'engine.zip');
      execFileSync('node', [join(__dirname, '..', '..', '..', 'scripts', 'build-engine-package.mjs'), 'parking-fee-v1', '--out', archive], { cwd: join(__dirname, '..', '..', '..'), windowsHide: true });
      const uploaded = await fetch(`${baseUrl}/api/v1/evaluation-engines`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({ packageBase64: readFileSync(archive).toString('base64'), fileName: 'engine.zip' }),
      });
      assert.equal(uploaded.status, 201);
      const enginePackage = await uploaded.json() as { packageHash: string; engine: { id: string; version: string } };

      const created = await fetch(`${baseUrl}/api/v1/challenges`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({
          id: 'api-packaged', ownerOrgPath: '/', origin: 'OFFICIAL', status: 'PUBLISHED', versions: [{
            id: 'api-packaged@1', challengeId: 'api-packaged', version: 1, title: '打包引擎题', zone: 'YELLOW',
            languagePolicy: { mode: 'fixed', languages: ['python'] }, deliveryPolicy: { allowedSources: ['UPLOAD'], upload: { formats: ['zip'] } },
            rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', status: 'PUBLISHED',
            evaluationEngine: {
              id: enginePackage.engine.id, version: enginePackage.engine.version, mode: 'PACKAGED',
              package: { packageHash: enginePackage.packageHash },
              input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/engine-invocation.schema.json' },
              output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
            },
          }],
        }),
      });
      assert.equal(created.status, 201);
      await fetch(`${baseUrl}/api/v1/events`, { method: 'POST', headers: admin, body: JSON.stringify({ id: 'event-api-packaged', challengeVersion: 'api-packaged@1', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE' }) });
      const packagedSubmission = await (await fetch(`${baseUrl}/api/v1/events/event-api-packaged/submissions:upload`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({ subjectId: 'w00126', snapshot: { sourceType: 'UPLOAD', workspacePath: 'challenges/parking-fee-v1/starter', submittedAt: '2026-08-01T10:00:00Z' } }),
      })).json() as { id: string };
      await fetch(`${baseUrl}/api/v1/submissions/${packagedSubmission.id}/start-grading`, { method: 'POST', headers: admin, body: '{}' });

      const leased = await fetch(`${baseUrl}/api/v1/evaluation-batches:lease`, { method: 'POST', headers: admin, body: JSON.stringify({ workerId: 'eval-host-api', limit: 5 }) });
      assert.equal(leased.status, 200);
      const { batches } = await leased.json() as { batches: Array<{ batchId: string; leaseId: string; engine: { source: string; id: string; entrypoint: string }; submissions: Array<{ runId: string }> }> };
      const sources = batches.map((task) => task.engine.source).sort();
      assert.deepEqual(sources, ['BUILT_IN', 'PACKAGE']);
      // The package download the worker needs must be reachable.
      const download = await fetch(`${baseUrl}/api/v1/evaluation-engines/${enginePackage.packageHash}/package`, { headers: { 'x-employee-id': 'w00123' } });
      assert.equal(download.status, 200);
      assert.ok((await download.arrayBuffer()).byteLength > 0);

      // A worker that gives up releases the task instead of stranding it.
      const failed = await fetch(`${baseUrl}/api/v1/evaluation-batches/${batches[0].batchId}/fail`, { method: 'POST', headers: admin, body: JSON.stringify({ leaseId: batches[0].leaseId, reason: '评测环境磁盘不足' }) });
      assert.equal(failed.status, 200);
    });
  } finally {
    for (const [key, value] of [['EMBEDDED_EVALUATION_WORKER', previousEmbedded], ['PROJECT_ROOT', previousProjectRoot]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete process.env.ENGINE_PACKAGE_ROOT;
    rmSync(engineRoot, { recursive: true, force: true });
  }
});

test('API never executes a grading run in-process when the embedded worker is disabled', async () => {
  const previousEmbedded = process.env.EMBEDDED_EVALUATION_WORKER;
  process.env.EMBEDDED_EVALUATION_WORKER = 'false';
  try {
    await withApp(async (baseUrl) => {
      const admin = { 'content-type': 'application/json', 'x-employee-id': 'w00123' };
      const submitted = await fetch(`${baseUrl}/api/v1/events/event-local/submissions:upload`, {
        method: 'POST', headers: admin,
        body: JSON.stringify({ subjectId: 'w00124', snapshot: { sourceType: 'UPLOAD', workspacePath: 'challenges/parking-fee-v1/reference', submittedAt: '2026-08-01T10:00:00Z' } }),
      });
      assert.equal(submitted.status, 201);
      const submission = await submitted.json() as { id: string };
      const started = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}/start-grading`, { method: 'POST', headers: admin, body: '{}' });
      assert.equal(started.status, 201);
      const run = await started.json() as { id: string };

      const direct = await fetch(`${baseUrl}/api/v1/grading-runs/${run.id}/execute`, { method: 'POST', headers: admin, body: '{}' });
      assert.equal(direct.status, 400);
      const error = await direct.json() as { code?: string };
      assert.equal(error.code, 'CODE_AGENT_WORKER_REQUIRED');

      const current = await (await fetch(`${baseUrl}/api/v1/grading-runs/${run.id}`, { headers: admin })).json() as { status?: string };
      assert.equal(current.status, 'QUEUED');
    });
  } finally {
    if (previousEmbedded === undefined) delete process.env.EMBEDDED_EVALUATION_WORKER;
    else process.env.EMBEDDED_EVALUATION_WORKER = previousEmbedded;
  }
});
