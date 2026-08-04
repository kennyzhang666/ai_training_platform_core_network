import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const serviceRoot = resolve(__dirname, '..');
const script = join(serviceRoot, 'scripts', 'migrate-json-to-postgres.mjs');

function dryRun(source: string): string {
  return execFileSync(process.execPath, [script, '--source', source, '--dry-run'], {
    cwd: serviceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('JSON migration dry-run reports graph statistics without opening a database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-stats-'));
  const source = join(directory, 'platform-data.json');
  writeFileSync(source, JSON.stringify({
    orgUnits: [
      { id: 'org-root', path: '/', level: 0, label: '集团', name: '华为' },
      { id: 'org-demo', parentId: 'org-root', path: '/1/', level: 1, label: '部门', name: 'AI 工程团队' },
    ],
    users: [
      { id: 'w00123', employeeNo: 'w00123', name: '本地开发用户', orgUnitId: 'org-demo', roles: ['global_admin'] },
      { id: 'w00124', employeeNo: 'w00124', name: '本地学员 A', orgUnitId: 'org-demo', roles: ['learner'] },
      { id: 'w00126', employeeNo: 'w00126', name: '本地学员 B', orgUnitId: 'org-demo', roles: ['learner'] },
      { id: 'w00133', employeeNo: 'w00133', name: '本地导师', orgUnitId: 'org-demo', roles: ['mentor'] },
    ],
    challenges: [{ id: 'parking-fee-01', versions: [{ id: 'parking-fee-01@1', challengeId: 'parking-fee-01', version: 1 }] }],
    events: [{ id: 'event-local', challengeVersion: 'parking-fee-01@1' }],
  }), 'utf8');
  try {
    const output = JSON.parse(dryRun(source)) as {
      dryRun: boolean;
      errors: unknown[];
      stats: Record<string, { read: number }>;
    };
    assert.equal(output.dryRun, true);
    assert.deepEqual(output.errors, []);
    assert.equal(output.stats.orgUnits.read, 2);
    assert.equal(output.stats.users.read, 4);
    assert.equal(output.stats.challenges.read, 1);
    assert.equal(output.stats.events.read, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('JSON migration dry-run rejects broken references and duplicate keys before PostgreSQL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-validation-'));
  const source = join(directory, 'invalid.json');
  try {
    writeFileSync(source, JSON.stringify({
      orgUnits: [{ id: 'root', path: '/', name: 'Root' }],
      users: [
        { id: 'user-a', employeeNo: 'employee-a', name: 'Synthetic A' },
        { id: 'user-b', employeeNo: 'employee-a', name: 'Synthetic B' },
      ],
      submissions: [{ id: 'submission-a', eventId: 'missing-event', subjectId: 'user-a', snapshot: { snapshotHash: 'a'.repeat(64) } }],
    }), 'utf8');
    assert.throws(
      () => dryRun(source),
      (error: unknown) => {
        const failure = error as { status?: number; stderr?: Buffer | string };
        return failure.status === 2 && /users\.employeeNo|submissions\[0\]\.eventId/.test(String(failure.stderr));
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('JSON migration dry-run rejects cross-linked runs, batches and results', () => {
  const source = join(tmpdir(), `platform-migration-cross-link-${process.pid}-${Date.now()}.json`);
  const graph = {
    users: [{ id: 'user-a', employeeNo: 'employee-a', name: 'A', roles: ['learner'] }],
    challenges: [{ id: 'challenge-a', versions: [{ id: 'challenge-a@1', challengeId: 'challenge-a', version: 1 }] }],
    events: [{ id: 'event-a', challengeVersion: 'challenge-a@1' }, { id: 'event-b', challengeVersion: 'challenge-a@1' }],
    submissions: [
      { id: 'submission-a', eventId: 'event-a', subjectId: 'user-a', snapshot: { snapshotHash: 'a'.repeat(64) } },
      { id: 'submission-b', eventId: 'event-b', subjectId: 'user-a', snapshot: { snapshotHash: 'b'.repeat(64) } },
    ],
    runs: [{ id: 'run-a', submissionId: 'submission-a', idempotencyKey: 'run-a' }],
    evaluationBatches: [{ id: 'batch-a', eventId: 'event-a', challengeVersion: 'challenge-a@1', runIds: ['run-a'], submissionIds: ['submission-b'] }],
    results: [{ resultId: 'result-a', gradingRunId: 'run-a', submissionId: 'submission-b', result: { total: 1 } }],
  };
  writeFileSync(source, JSON.stringify(graph));
  try {
    const failure = spawnSync(process.execPath, ['scripts/migrate-json-to-postgres.mjs', '--source', source, '--dry-run'], { cwd: serviceRoot, encoding: 'utf8' });
    assert.equal(failure.status, 2);
    assert.match(`${failure.stdout}\n${failure.stderr}`, /does not belong to submissionIds|gradingRunId does not belong/);
  } finally {
    rmSync(source, { force: true });
  }
});
