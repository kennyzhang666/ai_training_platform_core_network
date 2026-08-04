import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const projectRoot = resolve(__dirname, '..', '..', '..');
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
  const output = JSON.parse(dryRun(join(projectRoot, 'tmp', 'platform-data.json'))) as {
    dryRun: boolean;
    errors: unknown[];
    stats: Record<string, { read: number }>;
  };
  assert.equal(output.dryRun, true);
  assert.deepEqual(output.errors, []);
  assert.equal(output.stats.orgUnits.read, 4);
  assert.equal(output.stats.users.read, 12);
  assert.equal(output.stats.challenges.read, 6);
  assert.equal(output.stats.events.read, 5);
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
