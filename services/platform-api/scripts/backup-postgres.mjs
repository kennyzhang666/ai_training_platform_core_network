#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: pnpm backup:postgres -- --output <backup.json>');
  process.exitCode = 2;
}

function parseArgs(argv) {
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') output = argv[++index];
    else if (argument === '--help' || argument === '-h') return usage();
    else return usage(`unknown argument: ${argument}`);
  }
  if (!output) return usage('--output is required');
  return { output: resolve(output) };
}

const options = parseArgs(process.argv.slice(2));
if (!options) process.exit(2);
if (!process.env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL is required for a PostgreSQL backup');
  process.exit(2);
}

let PrismaClient;
let Prisma;
try {
  ({ PrismaClient, Prisma } = require('@prisma/client'));
} catch (error) {
  console.error('Prisma client is not available; run prisma:generate first');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

// Keep this list explicit: a backup must be reviewable and adding a new model
// must force a deliberate backup/restore change instead of silently omitting
// production data.
const tableMap = [
  // UploadSession is intentionally excluded: it contains short-lived
  // capability digests and must never be resurrected by a restore.
  ['orgUnits', 'orgUnit'],
  ['appUsers', 'appUser'],
  ['roleBindings', 'roleBinding'],
  ['challenges', 'challenge'],
  ['challengeVersions', 'challengeVersion'],
  ['events', 'event'],
  ['seasons', 'season'],
  ['seasonEvents', 'seasonEvent'],
  ['participations', 'participation'],
  ['submissions', 'submission'],
  ['evaluationBatches', 'evaluationBatch'],
  ['gradingRuns', 'gradingRun'],
  ['evaluationResults', 'evaluationResult'],
  ['criterionResults', 'criterionResult'],
  ['findings', 'finding'],
  ['systemSettings', 'systemSetting'],
  ['auditLogs', 'auditLog'],
  ['announcements', 'announcement'],
  ['platformSnapshots', 'platformSnapshot'],
];

const sensitiveKey = /token|cookie|secret|password|credential|assertion|private[_-]?key/i;

function jsonSafe(value, key = '') {
  if (key && sensitiveKey.test(key)) return '[REDACTED]';
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));
  if (typeof value === 'object') {
    // Prisma Decimal instances expose toJSON as a string. Do not serialize
    // driver-specific internals into a backup that must be portable.
    const keys = Object.keys(value);
    const decimalKeys = keys.filter((key) => key !== 'constructor');
    if ((value.constructor?.name === 'Decimal' || (decimalKeys.length === 3 && decimalKeys.includes('s') && decimalKeys.includes('e') && decimalKeys.includes('d'))) && typeof value.toString === 'function') {
      return value.toString();
    }
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, jsonSafe(child, childKey)]));
  }
  return value;
}

const client = new PrismaClient();
try {
  // Read every table from one repeatable-read snapshot. A sequence of
  // independent findMany calls could otherwise produce a backup whose
  // foreign-key graph reflects different moments while writes are active.
  const tables = await client.$transaction(async (db) => {
    const snapshot = {};
    for (const [backupName, prismaName] of tableMap) {
      const rows = await db[prismaName].findMany();
      snapshot[backupName] = rows.map((row) => jsonSafe(row));
    }
    return snapshot;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const snapshot = tables.platformSnapshots.find((row) => row.id === 'singleton');
  const backup = {
    format: 'ai-training-platform-postgres-backup/v2',
    exportedAt: new Date().toISOString(),
    schemaVersion: Number.isInteger(snapshot?.schemaVersion) ? snapshot.schemaVersion : 1,
    databaseRevision: '0016_upload_session_subject_binding',
    // Preserve the transitional envelope for the current API adapter. The
    // normalized tables above are the source of truth for the restored DB.
    state: snapshot?.state == null ? null : jsonSafe(snapshot.state),
    tables,
  };
  const payload = `${JSON.stringify(backup, null, 2)}\n`;
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, payload, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ output: options.output, format: backup.format, schemaVersion: backup.schemaVersion, tables: Object.fromEntries(tableMap.map(([name]) => [name, tables[name].length])), bytes: Buffer.byteLength(payload) }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
