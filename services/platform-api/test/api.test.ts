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
    assert.equal(capabilities.capabilityCatalogVersion, '1.0');
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

    const allPeopleResponse = await fetch(`${baseUrl}/api/v1/admin/capabilities`);
    assert.equal(allPeopleResponse.status, 200);
    const allPeople = await allPeopleResponse.json() as {
      selection: { mode: string; orgPath: string | null };
      totalCandidates: number;
      selectedCount: number;
      gradedUsers: number;
      aggregate: { skills: Array<{ key: string; percent: number | null; evaluatedUsers: number }> };
      profiles: Array<{ subject: { id: string }; profile: { summary: { gradedSubmissions: number } } }>;
    };
    assert.equal(allPeople.selection.mode, 'ALL');
    assert.equal(allPeople.selection.orgPath, null);
    assert.equal(allPeople.totalCandidates, 10);
    assert.equal(allPeople.selectedCount, 10);
    assert.equal(allPeople.gradedUsers, 1);
    assert.equal(allPeople.aggregate.skills.length, 16);
    assert.equal(allPeople.profiles.find((item) => item.subject.id === 'w00123')?.profile.summary.gradedSubmissions, 1);

    const selectedResponse = await fetch(`${baseUrl}/api/v1/admin/capabilities?orgPath=%2F1%2F12%2F125%2F&subjectIds=w00124,w00126&includeProfiles=false`);
    assert.equal(selectedResponse.status, 200);
    const selected = await selectedResponse.json() as { selection: { mode: string; subjectIds: string[] }; selectedCount: number; aggregate: { skills: Array<{ key: string }> }; profiles: unknown[] };
    assert.equal(selected.selection.mode, 'SELECTED');
    assert.deepEqual(selected.selection.subjectIds, ['w00124', 'w00126']);
    assert.equal(selected.selectedCount, 2);
    assert.equal(selected.aggregate.skills.length, 16);
    assert.equal(selected.profiles.length, 0);

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
    const trashed = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo/trash`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(trashed.status, 201);
    assert.equal((await trashed.json() as { status: string }).status, 'ARCHIVED');
    const restored = await fetch(`${baseUrl}/api/v1/challenges/admin-api-demo/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(restored.status, 201);
    assert.equal((await restored.json() as { status: string }).status, 'PUBLISHED');

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
    const scopedUsers = await users.json() as Array<{ id: string }>;
    assert.ok(scopedUsers.some((user) => user.id === 'w00124'));
    assert.ok(!scopedUsers.some((user) => user.id === 'w00125'));

    const outsideCapabilities = await fetch(`${baseUrl}/api/v1/admin/capabilities?subjectIds=w00125`, { headers: { 'x-employee-id': 'w00134' } });
    assert.equal(outsideCapabilities.status, 400);

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
