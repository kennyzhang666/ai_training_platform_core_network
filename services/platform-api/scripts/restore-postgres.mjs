#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: pnpm restore:postgres -- --source <backup.json> --confirm [--confirm-production]');
  process.exitCode = 2;
}

function parseArgs(argv) {
  let source;
  let confirm = false;
  let confirmProduction = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') source = argv[++index];
    else if (argument === '--confirm') confirm = true;
    else if (argument === '--confirm-production') confirmProduction = true;
    else if (argument === '--help' || argument === '-h') return usage();
    else return usage(`unknown argument: ${argument}`);
  }
  if (!source) return usage('--source is required');
  if (!confirm) return usage('--confirm is required; restore is destructive');
  return { source: resolve(source), confirmProduction };
}

const options = parseArgs(process.argv.slice(2));
if (!options) process.exit(2);
if (process.env.NODE_ENV === 'production' && !options.confirmProduction) {
  console.error('--confirm-production is required when NODE_ENV=production');
  process.exit(2);
}
if (!process.env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL is required for a PostgreSQL restore');
  process.exit(2);
}

let backup;
try {
  backup = JSON.parse(await readFile(options.source, 'utf8'));
} catch (error) {
  console.error(`cannot read backup: ${options.source}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (!['ai-training-platform-postgres-backup/v1', 'ai-training-platform-postgres-backup/v2'].includes(backup?.format)) {
  console.error('unsupported backup format');
  process.exit(2);
}
if (!Number.isInteger(backup.schemaVersion) || backup.schemaVersion < 1) {
  console.error('backup schemaVersion is invalid');
  process.exit(2);
}

// v1 was a snapshot-only emergency format. Keep it readable so operators can
// recover an older deployment, while all new backups use the normalized v2
// table envelope and are restored atomically below.
if (backup.format === 'ai-training-platform-postgres-backup/v1') {
  if (!backup.state || typeof backup.state !== 'object' || Array.isArray(backup.state)) {
    console.error('v1 backup state is invalid');
    process.exit(2);
  }
  let PrismaClient;
  try {
    ({ PrismaClient } = require('@prisma/client'));
  } catch (error) {
    console.error('Prisma client is not available; run prisma:generate first');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const client = new PrismaClient();
  try {
    await client.platformSnapshot.upsert({
      where: { id: 'singleton' },
      update: { schemaVersion: backup.schemaVersion, revision: { increment: 1 }, state: backup.state },
      create: { id: 'singleton', schemaVersion: backup.schemaVersion, revision: 1, state: backup.state },
    });
    console.log(JSON.stringify({ restored: true, format: backup.format, source: options.source, schemaVersion: backup.schemaVersion }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
  process.exit(process.exitCode ?? 0);
}

const tableNames = [
  'orgUnits', 'appUsers', 'roleBindings', 'challenges', 'challengeVersions',
  'events', 'seasons', 'seasonEvents', 'participations', 'submissions',
  'evaluationBatches', 'gradingRuns', 'evaluationResults', 'criterionResults',
  'findings', 'systemSettings', 'auditLogs', 'announcements', 'platformSnapshots',
];
if (!backup.tables || typeof backup.tables !== 'object' || Array.isArray(backup.tables)) {
  console.error('v2 backup tables are missing');
  process.exit(2);
}
for (const tableName of tableNames) {
  if (!Array.isArray(backup.tables[tableName])) {
    console.error(`v2 backup table is missing or invalid: ${tableName}`);
    process.exit(2);
  }
}

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function unique(rows, key, label) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const value = key(row);
    if (seen.has(value)) throw new Error(`${label}[${index}] duplicates ${String(value)}`);
    seen.add(value);
  }
}

function reference(value, known, label) {
  if (typeof value !== 'string' || !known.has(value)) throw new Error(`${label} references an unknown record`);
}

function dateValue(value, label) {
  if (value === undefined || value === null) return;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid DateTime`);
}

function validateBackupGraph(tables) {
  const orgUnits = tables.orgUnits;
  const orgIds = new Set(orgUnits.map((row) => row.id));
  unique(orgUnits, (row) => required(row.id, 'orgUnits.id'), 'orgUnits');
  unique(orgUnits, (row) => required(row.path, 'orgUnits.path'), 'orgUnits.path');
  unique(orgUnits, (row) => `${row.parentId ?? '<root>'}\0${required(row.name, 'orgUnits.name')}`, 'orgUnits.siblingName');
  for (const [index, row] of orgUnits.entries()) {
    if (row.parentId !== null && row.parentId !== undefined) reference(row.parentId, orgIds, `orgUnits[${index}].parentId`);
    dateValue(row.createdAt, `orgUnits[${index}].createdAt`);
    dateValue(row.updatedAt, `orgUnits[${index}].updatedAt`);
  }

  const users = tables.appUsers;
  const userIds = new Set(users.map((row) => row.id));
  unique(users, (row) => required(row.id, 'appUsers.id'), 'appUsers');
  unique(users, (row) => required(row.employeeNo, 'appUsers.employeeNo'), 'appUsers.employeeNo');
  for (const [index, row] of users.entries()) {
    if (row.orgUnitId !== null && row.orgUnitId !== undefined) reference(row.orgUnitId, orgIds, `appUsers[${index}].orgUnitId`);
    dateValue(row.createdAt, `appUsers[${index}].createdAt`);
    dateValue(row.updatedAt, `appUsers[${index}].updatedAt`);
  }
  const roleBindings = tables.roleBindings;
  unique(roleBindings, (row) => required(row.id, 'roleBindings.id'), 'roleBindings');
  unique(roleBindings, (row) => `${required(row.userId, 'roleBindings.userId')}\0${required(row.role, 'roleBindings.role')}\0${required(row.scopeOrgPath, 'roleBindings.scopeOrgPath')}`, 'roleBindings.scope');
  for (const [index, row] of roleBindings.entries()) {
    reference(row.userId, userIds, `roleBindings[${index}].userId`);
    dateValue(row.createdAt, `roleBindings[${index}].createdAt`);
  }

  const challenges = tables.challenges;
  const challengeIds = new Set(challenges.map((row) => row.id));
  unique(challenges, (row) => required(row.id, 'challenges.id'), 'challenges');
  for (const [index, row] of challenges.entries()) {
    dateValue(row.createdAt, `challenges[${index}].createdAt`);
    dateValue(row.updatedAt, `challenges[${index}].updatedAt`);
  }
  const versions = tables.challengeVersions;
  const versionIds = new Set(versions.map((row) => row.id));
  unique(versions, (row) => required(row.id, 'challengeVersions.id'), 'challengeVersions');
  unique(versions, (row) => `${required(row.challengeId, 'challengeVersions.challengeId')}\0${row.version}`, 'challengeVersions.version');
  for (const [index, row] of versions.entries()) {
    reference(row.challengeId, challengeIds, `challengeVersions[${index}].challengeId`);
    dateValue(row.createdAt, `challengeVersions[${index}].createdAt`);
  }

  const events = tables.events;
  const eventIds = new Set(events.map((row) => row.id));
  unique(events, (row) => required(row.id, 'events.id'), 'events');
  for (const [index, row] of events.entries()) {
    reference(row.challengeVersionId, versionIds, `events[${index}].challengeVersionId`);
    dateValue(row.startsAt, `events[${index}].startsAt`);
    dateValue(row.endsAt, `events[${index}].endsAt`);
    dateValue(row.createdAt, `events[${index}].createdAt`);
    dateValue(row.updatedAt, `events[${index}].updatedAt`);
  }

  const participations = tables.participations;
  unique(participations, (row) => `${required(row.eventId, 'participations.eventId')}\0${required(row.subjectId, 'participations.subjectId')}`, 'participations');
  for (const [index, row] of participations.entries()) {
    reference(row.eventId, eventIds, `participations[${index}].eventId`);
    reference(row.subjectId, userIds, `participations[${index}].subjectId`);
    dateValue(row.importedAt, `participations[${index}].importedAt`);
  }

  const submissions = tables.submissions;
  const submissionIds = new Set(submissions.map((row) => row.id));
  unique(submissions, (row) => required(row.id, 'submissions.id'), 'submissions');
  unique(submissions, (row) => `${required(row.eventId, 'submissions.eventId')}\0${required(row.subjectId, 'submissions.subjectId')}\0${required(row.snapshotHash, 'submissions.snapshotHash')}`, 'submissions.snapshot');
  for (const [index, row] of submissions.entries()) {
    reference(row.eventId, eventIds, `submissions[${index}].eventId`);
    reference(row.subjectId, userIds, `submissions[${index}].subjectId`);
    dateValue(row.submittedAt, `submissions[${index}].submittedAt`);
    dateValue(row.createdAt, `submissions[${index}].createdAt`);
    if (row.previousResultIds !== null && row.previousResultIds !== undefined) {
      if (!Array.isArray(row.previousResultIds)) throw new Error(`submissions[${index}].previousResultIds is not an array`);
      unique(row.previousResultIds.map((id) => ({ id })), (item) => item.id, `submissions[${index}].previousResultIds`);
    }
  }

  const runs = tables.gradingRuns;
  const runIds = new Set(runs.map((row) => row.id));
  unique(runs, (row) => required(row.id, 'gradingRuns.id'), 'gradingRuns');
  unique(runs, (row) => `${required(row.submissionId, 'gradingRuns.submissionId')}\0${required(row.idempotencyKey, 'gradingRuns.idempotencyKey')}`, 'gradingRuns.idempotency');
  for (const [index, row] of runs.entries()) {
    reference(row.submissionId, submissionIds, `gradingRuns[${index}].submissionId`);
    dateValue(row.leaseExpiresAt, `gradingRuns[${index}].leaseExpiresAt`);
    dateValue(row.createdAt, `gradingRuns[${index}].createdAt`);
  }

  const batches = tables.evaluationBatches;
  const batchIds = new Set(batches.map((row) => row.id));
  unique(batches, (row) => required(row.id, 'evaluationBatches.id'), 'evaluationBatches');
  for (const [index, row] of batches.entries()) {
    reference(row.eventId, eventIds, `evaluationBatches[${index}].eventId`);
    reference(row.challengeVersionId, versionIds, `evaluationBatches[${index}].challengeVersionId`);
    if (!Array.isArray(row.runIds) || !Array.isArray(row.submissionIds) || row.runIds.length !== row.submissionIds.length) throw new Error(`evaluationBatches[${index}] runIds/submissionIds are not a paired array`);
    if (!Array.isArray(row.completedRunIds ?? []) || !Array.isArray(row.failedRunIds ?? [])) throw new Error(`evaluationBatches[${index}] completedRunIds/failedRunIds are not arrays`);
    unique((row.completedRunIds ?? []).map((id) => ({ id })), (item) => item.id, `evaluationBatches[${index}].completedRunIds`);
    unique((row.failedRunIds ?? []).map((id) => ({ id })), (item) => item.id, `evaluationBatches[${index}].failedRunIds`);
    for (const [pairIndex, runId] of row.runIds.entries()) {
      reference(runId, runIds, `evaluationBatches[${index}].runIds`);
      const submissionId = row.submissionIds[pairIndex];
      reference(submissionId, submissionIds, `evaluationBatches[${index}].submissionIds`);
      const run = runs.find((candidate) => candidate.id === runId);
      if (run?.submissionId !== submissionId) throw new Error(`evaluationBatches[${index}] runIds[${pairIndex}] does not belong to submissionIds[${pairIndex}]`);
    }
    for (const runId of row.completedRunIds ?? []) reference(runId, runIds, `evaluationBatches[${index}].completedRunIds`);
    for (const runId of row.failedRunIds ?? []) reference(runId, runIds, `evaluationBatches[${index}].failedRunIds`);
    dateValue(row.leaseExpiresAt, `evaluationBatches[${index}].leaseExpiresAt`);
    dateValue(row.finishedAt, `evaluationBatches[${index}].finishedAt`);
    dateValue(row.createdAt, `evaluationBatches[${index}].createdAt`);
    dateValue(row.updatedAt, `evaluationBatches[${index}].updatedAt`);
  }
  for (const [index, row] of runs.entries()) {
    if (row.evaluationBatchId !== null && row.evaluationBatchId !== undefined) reference(row.evaluationBatchId, batchIds, `gradingRuns[${index}].evaluationBatchId`);
  }

  const results = tables.evaluationResults;
  const resultIds = new Set(results.map((row) => row.id));
  unique(results, (row) => required(row.id, 'evaluationResults.id'), 'evaluationResults');
  unique(results, (row) => required(row.gradingRunId, 'evaluationResults.gradingRunId'), 'evaluationResults.gradingRunId');
  for (const [index, row] of results.entries()) {
    reference(row.gradingRunId, runIds, `evaluationResults[${index}].gradingRunId`);
    reference(row.submissionId, submissionIds, `evaluationResults[${index}].submissionId`);
    const run = runs.find((candidate) => candidate.id === row.gradingRunId);
    if (run?.submissionId !== row.submissionId) throw new Error(`evaluationResults[${index}] gradingRunId does not belong to submissionId`);
    dateValue(row.importedAt, `evaluationResults[${index}].importedAt`);
    dateValue(row.createdAt, `evaluationResults[${index}].createdAt`);
  }
  for (const [index, row] of submissions.entries()) {
    if (row.currentGradingRunId !== null && row.currentGradingRunId !== undefined) {
      reference(row.currentGradingRunId, runIds, `submissions[${index}].currentGradingRunId`);
      const run = runs.find((candidate) => candidate.id === row.currentGradingRunId);
      if (run?.submissionId !== row.id) throw new Error(`submissions[${index}].currentGradingRunId belongs to another submission`);
    }
    if (row.currentResultId !== null && row.currentResultId !== undefined) {
      reference(row.currentResultId, resultIds, `submissions[${index}].currentResultId`);
      const result = results.find((candidate) => candidate.id === row.currentResultId);
      if (result?.submissionId !== row.id) throw new Error(`submissions[${index}].currentResultId belongs to another submission`);
    }
  }

  unique(tables.seasons, (row) => required(row.id, 'seasons.id'), 'seasons');
  unique(tables.seasonEvents, (row) => `${required(row.seasonId, 'seasonEvents.seasonId')}\0${required(row.eventId, 'seasonEvents.eventId')}`, 'seasonEvents');
  const seasonIds = new Set(tables.seasons.map((row) => row.id));
  for (const [index, row] of tables.seasonEvents.entries()) {
    reference(row.seasonId, seasonIds, `seasonEvents[${index}].seasonId`);
    reference(row.eventId, eventIds, `seasonEvents[${index}].eventId`);
  }
  unique(tables.criterionResults, (row) => required(row.id, 'criterionResults.id'), 'criterionResults');
  unique(tables.criterionResults, (row) => `${required(row.evaluationResultId, 'criterionResults.evaluationResultId')}\0${required(row.criterionKey, 'criterionResults.criterionKey')}`, 'criterionResults.key');
  for (const [index, row] of tables.criterionResults.entries()) reference(row.evaluationResultId, resultIds, `criterionResults[${index}].evaluationResultId`);
  unique(tables.findings, (row) => required(row.id, 'findings.id'), 'findings');
  for (const [index, row] of tables.findings.entries()) reference(row.evaluationResultId, resultIds, `findings[${index}].evaluationResultId`);
  unique(tables.systemSettings, (row) => required(row.key, 'systemSettings.key'), 'systemSettings');
  unique(tables.auditLogs, (row) => required(row.id, 'auditLogs.id'), 'auditLogs');
  unique(tables.announcements, (row) => required(row.id, 'announcements.id'), 'announcements');
  unique(tables.platformSnapshots, (row) => required(row.id, 'platformSnapshots.id'), 'platformSnapshots');
  const dateColumns = {
    seasons: ['createdAt', 'updatedAt'],
    systemSettings: ['updatedAt'],
    auditLogs: ['createdAt'],
    announcements: ['publishedAt', 'createdAt', 'updatedAt'],
    platformSnapshots: ['createdAt', 'updatedAt'],
  };
  for (const [tableName, fields] of Object.entries(dateColumns)) {
    for (const [index, row] of tables[tableName].entries()) {
      for (const field of fields) dateValue(row[field], `${tableName}[${index}].${field}`);
    }
  }
}

try {
  validateBackupGraph(backup.tables);
} catch (error) {
  console.error(`backup graph is invalid: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (error) {
  console.error('Prisma client is not available; run prisma:generate first');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

function byLevel(rows, direction) {
  return [...rows].sort((left, right) => (Number(left.level ?? 0) - Number(right.level ?? 0)) * direction);
}

// JSON backups intentionally serialize PostgreSQL DateTime and Decimal values
// into portable strings. Prisma's runtime requires Date objects for DateTime
// fields when restoring, so revive only the fields whose schema is temporal;
// JSONB payloads and user-controlled strings must remain untouched.
const dateFields = {
  orgUnits: ['createdAt', 'updatedAt'],
  appUsers: ['createdAt', 'updatedAt'],
  roleBindings: ['createdAt'],
  challenges: ['createdAt', 'updatedAt'],
  challengeVersions: ['createdAt'],
  events: ['startsAt', 'endsAt', 'createdAt', 'updatedAt'],
  seasons: ['createdAt', 'updatedAt'],
  participations: ['importedAt'],
  submissions: ['submittedAt', 'createdAt'],
  evaluationBatches: ['leaseExpiresAt', 'finishedAt', 'createdAt', 'updatedAt'],
  gradingRuns: ['leaseExpiresAt', 'createdAt'],
  evaluationResults: ['importedAt', 'createdAt'],
  systemSettings: ['updatedAt'],
  auditLogs: ['createdAt'],
  announcements: ['publishedAt', 'createdAt', 'updatedAt'],
  platformSnapshots: ['createdAt', 'updatedAt'],
};

function restoreRow(tableName, row) {
  const copy = { ...row };
  for (const field of dateFields[tableName] ?? []) {
    if (copy[field] === null || copy[field] === undefined) continue;
    const value = new Date(copy[field]);
    if (Number.isNaN(value.getTime())) throw new Error(`${tableName}.${field} is not a valid DateTime`);
    copy[field] = value;
  }
  return copy;
}

const client = new PrismaClient();
try {
  await client.$transaction(async (db) => {
    // Delete children first. OrgUnit is the only self-referencing table, so
    // remove it deepest-first after all user foreign keys are gone.
    // Upload sessions are intentionally not part of a backup: they are
    // short-lived capabilities, and restoring one would resurrect stale
    // bearer handles. A restore always invalidates the target database's
    // outstanding sessions first.
    await db.uploadSession.deleteMany();
    await db.criterionResult.deleteMany();
    await db.finding.deleteMany();
    await db.evaluationResult.deleteMany();
    await db.gradingRun.deleteMany();
    await db.evaluationBatch.deleteMany();
    await db.submission.deleteMany();
    await db.participation.deleteMany();
    await db.seasonEvent.deleteMany();
    await db.event.deleteMany();
    await db.challengeVersion.deleteMany();
    await db.challenge.deleteMany();
    await db.roleBinding.deleteMany();
    await db.appUser.deleteMany();
    const existingOrgUnits = await db.orgUnit.findMany({ select: { id: true, level: true } });
    for (const unit of byLevel(existingOrgUnits, -1)) await db.orgUnit.delete({ where: { id: unit.id } });
    await db.season.deleteMany();
    await db.systemSetting.deleteMany();
    await db.auditLog.deleteMany();
    await db.announcement.deleteMany();
    await db.platformSnapshot.deleteMany();

    const tables = backup.tables;
    for (const row of byLevel(tables.orgUnits, 1)) await db.orgUnit.create({ data: restoreRow('orgUnits', row) });
    if (tables.appUsers.length) await db.appUser.createMany({ data: tables.appUsers.map((row) => restoreRow('appUsers', row)) });
    if (tables.roleBindings.length) await db.roleBinding.createMany({ data: tables.roleBindings.map((row) => restoreRow('roleBindings', row)) });
    if (tables.challenges.length) await db.challenge.createMany({ data: tables.challenges.map((row) => restoreRow('challenges', row)) });
    if (tables.challengeVersions.length) await db.challengeVersion.createMany({ data: tables.challengeVersions.map((row) => restoreRow('challengeVersions', row)) });
    if (tables.events.length) await db.event.createMany({ data: tables.events.map((row) => restoreRow('events', row)) });
    if (tables.seasons.length) await db.season.createMany({ data: tables.seasons.map((row) => restoreRow('seasons', row)) });
    if (tables.seasonEvents.length) await db.seasonEvent.createMany({ data: tables.seasonEvents.map((row) => restoreRow('seasonEvents', row)) });
    if (tables.participations.length) await db.participation.createMany({ data: tables.participations.map((row) => restoreRow('participations', row)) });
    if (tables.submissions.length) await db.submission.createMany({ data: tables.submissions.map((row) => restoreRow('submissions', row)) });
    if (tables.evaluationBatches.length) await db.evaluationBatch.createMany({ data: tables.evaluationBatches.map((row) => restoreRow('evaluationBatches', row)) });
    if (tables.gradingRuns.length) await db.gradingRun.createMany({ data: tables.gradingRuns.map((row) => restoreRow('gradingRuns', row)) });
    if (tables.evaluationResults.length) await db.evaluationResult.createMany({ data: tables.evaluationResults.map((row) => restoreRow('evaluationResults', row)) });
    if (tables.criterionResults.length) await db.criterionResult.createMany({ data: tables.criterionResults.map((row) => restoreRow('criterionResults', row)) });
    if (tables.findings.length) await db.finding.createMany({ data: tables.findings.map((row) => restoreRow('findings', row)) });
    if (tables.systemSettings.length) await db.systemSetting.createMany({ data: tables.systemSettings.map((row) => restoreRow('systemSettings', row)) });
    if (tables.auditLogs.length) await db.auditLog.createMany({ data: tables.auditLogs.map((row) => restoreRow('auditLogs', row)) });
    if (tables.announcements.length) await db.announcement.createMany({ data: tables.announcements.map((row) => restoreRow('announcements', row)) });
    if (tables.platformSnapshots.length) await db.platformSnapshot.createMany({ data: tables.platformSnapshots.map((row) => restoreRow('platformSnapshots', row)) });
  }, { timeout: Number(process.env.RESTORE_TRANSACTION_TIMEOUT_MS ?? 120_000) });
  console.log(JSON.stringify({ restored: true, format: backup.format, source: options.source, schemaVersion: backup.schemaVersion, tables: Object.fromEntries(tableNames.map((name) => [name, backup.tables[name].length])) }, null, 2));
} catch (error) {
  console.error(`PostgreSQL restore rolled back: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
