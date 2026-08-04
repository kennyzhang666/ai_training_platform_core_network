import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const serviceRoot = resolve(__dirname, '..');
const script = join(serviceRoot, 'scripts', 'restore-postgres.mjs');
const tableNames = [
  'orgUnits', 'appUsers', 'roleBindings', 'challenges', 'challengeVersions',
  'events', 'seasons', 'seasonEvents', 'participations', 'submissions',
  'evaluationBatches', 'gradingRuns', 'evaluationResults', 'criterionResults',
  'findings', 'systemSettings', 'auditLogs', 'announcements', 'platformSnapshots',
];

test('PostgreSQL restore rejects an invalid v2 graph before connecting to the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'restore-validation-'));
  const source = join(directory, 'invalid-backup.json');
  try {
    const tables = Object.fromEntries(tableNames.map((name) => [name, [] as unknown[]]));
    tables.orgUnits = [{ id: 'child', parentId: 'missing', path: '/child/', level: 1, label: 'Team', name: 'Child' }];
    writeFileSync(source, JSON.stringify({ format: 'ai-training-platform-postgres-backup/v2', schemaVersion: 1, tables }), 'utf8');
    const result = spawnSync(process.execPath, [script, '--source', source, '--confirm'], {
      cwd: serviceRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgresql://127.0.0.1:1/does-not-connect' },
      windowsHide: true,
    });
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /backup graph is invalid|orgUnits\[0\]\.parentId/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
