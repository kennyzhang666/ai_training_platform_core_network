#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: pnpm migrate:json -- --source <platform-data.json> [--dry-run]');
  process.exitCode = 2;
}

function parseArgs(argv) {
  let source;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') source = argv[++index];
    else if (argument === '--dry-run') dryRun = true;
    else if (argument === '--help' || argument === '-h') return usage();
    else return usage(`unknown argument: ${argument}`);
  }
  if (!source) return usage('--source is required');
  return { source: resolve(source), dryRun };
}

const options = parseArgs(process.argv.slice(2));
if (!options) process.exit(2);

let state;
try {
  state = JSON.parse(await readFile(options.source, 'utf8'));
} catch (error) {
  console.error(`cannot read JSON source: ${options.source}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const domains = ['orgUnits', 'users', 'challenges', 'events', 'participants', 'submissions', 'evaluationBatches', 'runs', 'results', 'seasons', 'audits', 'announcements'];
const stats = Object.fromEntries(domains.map((domain) => [domain, { read: 0, written: 0, skipped: 0, failed: 0 }]));
const errors = [];

function list(domain) {
  const value = state?.[domain];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${domain} must be an array`);
  return value;
}

function byLevel(rows, direction = 1) {
  return [...rows].sort((left, right) => (Number(left.level ?? 0) - Number(right.level ?? 0)) * direction || String(left.id ?? '').localeCompare(String(right.id ?? '')));
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function dateValue(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid date`);
  return date;
}

function jsonValue(value, fallback = null) {
  return value === undefined ? fallback : value;
}

function assertUnique(rows, key, label) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const value = key(row);
    if (seen.has(value)) throw new Error(`${label}[${index}] duplicates ${String(value)}`);
    seen.add(value);
  }
}

function assertReference(value, known, label) {
  if (value !== undefined && value !== null && !known.has(value)) throw new Error(`${label} references an unknown record`);
}

function assertSha256(value, label, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} must be a lowercase SHA-256 hash`);
    return;
  }
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash`);
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function validateShape() {
  for (const domain of domains) {
    const items = list(domain);
    stats[domain].read = items.length;
    for (const [index, item] of items.entries()) {
      if (!item || typeof item !== 'object') throw new Error(`${domain}[${index}] must be an object`);
    }
  }
  for (const [index, unit] of list('orgUnits').entries()) {
    requiredString(unit.id, `orgUnits[${index}].id`);
    requiredString(unit.path, `orgUnits[${index}].path`);
    requiredString(unit.name, `orgUnits[${index}].name`);
  }
  for (const [index, user] of list('users').entries()) {
    requiredString(user.id, `users[${index}].id`);
    requiredString(user.employeeNo, `users[${index}].employeeNo`);
    requiredString(user.name, `users[${index}].name`);
    if (user.status !== undefined && !['ACTIVE', 'DISABLED'].includes(user.status)) throw new Error(`users[${index}].status is invalid`);
    if (user.roles !== undefined && (!Array.isArray(user.roles) || user.roles.some((role) => typeof role !== 'string'))) throw new Error(`users[${index}].roles must be a string array`);
  }
  for (const [index, submission] of list('submissions').entries()) {
    requiredString(submission.id, `submissions[${index}].id`);
    requiredString(submission.eventId, `submissions[${index}].eventId`);
    requiredString(submission.subjectId, `submissions[${index}].subjectId`);
    requiredString(submission.snapshot?.snapshotHash, `submissions[${index}].snapshot.snapshotHash`);
  }

  // Validate the graph before opening PostgreSQL.  The database remains the
  // final arbiter for constraints, but dry-run must catch broken references,
  // duplicate keys and immutable snapshot corruption without requiring a
  // target database or emitting any delivery contents.
  const orgUnits = list('orgUnits');
  const orgUnitIds = new Set(orgUnits.map((unit) => unit.id));
  assertUnique(orgUnits, (unit) => unit.id, 'orgUnits');
  assertUnique(orgUnits, (unit) => unit.path, 'orgUnits.path');
  assertUnique(orgUnits, (unit) => `${unit.parentId ?? '<root>'}\0${unit.name}`, 'orgUnits.siblingName');
  for (const [index, unit] of orgUnits.entries()) {
    assertReference(unit.parentId, orgUnitIds, `orgUnits[${index}].parentId`);
    if (unit.parentId === unit.id) throw new Error(`orgUnits[${index}] cannot parent itself`);
  }

  const users = list('users');
  const userIds = new Set(users.map((user) => user.id));
  assertUnique(users, (user) => user.id, 'users');
  assertUnique(users, (user) => user.employeeNo, 'users.employeeNo');
  for (const [index, user] of users.entries()) {
    assertReference(user.orgUnitId, orgUnitIds, `users[${index}].orgUnitId`);
    const bindings = user.roleBindings === undefined ? [] : assertArray(user.roleBindings, `users[${index}].roleBindings`);
    assertUnique(bindings, (binding) => `${binding.role}\0${binding.scopeOrgPath}`, `users[${index}].roleBindings`);
    for (const [bindingIndex, binding] of bindings.entries()) {
      requiredString(binding.role, `users[${index}].roleBindings[${bindingIndex}].role`);
      requiredString(binding.scopeOrgPath, `users[${index}].roleBindings[${bindingIndex}].scopeOrgPath`);
    }
  }

  const challenges = list('challenges');
  assertUnique(challenges, (challenge) => challenge.id, 'challenges');
  const versions = [];
  for (const [index, challenge] of challenges.entries()) {
    const challengeVersions = challenge.versions === undefined ? [] : assertArray(challenge.versions, `challenges[${index}].versions`);
    assertUnique(challengeVersions, (version) => String(version.version), `challenges[${index}].versions`);
    for (const [versionIndex, version] of challengeVersions.entries()) {
      requiredString(version.id, `challenges[${index}].versions[${versionIndex}].id`);
      versions.push(version);
      if (version.challengeId !== undefined && version.challengeId !== challenge.id) throw new Error(`challenges[${index}].versions[${versionIndex}].challengeId does not match its challenge`);
    }
  }
  const versionIds = new Set(versions.map((version) => version.id));
  assertUnique(versions, (version) => version.id, 'challengeVersions');

  const events = list('events');
  const eventIds = new Set(events.map((event) => event.id));
  assertUnique(events, (event) => event.id, 'events');
  for (const [index, event] of events.entries()) {
    assertReference(event.challengeVersion, versionIds, `events[${index}].challengeVersion`);
    if (event.startsAt !== undefined) dateValue(event.startsAt, `events[${index}].startsAt`);
    if (event.endsAt !== undefined) dateValue(event.endsAt, `events[${index}].endsAt`);
    if (event.trigger !== undefined && !['AUTO', 'MANUAL', 'IMPORT'].includes(event.trigger)) throw new Error(`events[${index}].trigger is invalid`);
    if (event.submissionSource !== undefined && !['UPLOAD', 'GIT_REF'].includes(event.submissionSource)) throw new Error(`events[${index}].submissionSource is invalid`);
  }

  const participants = list('participants');
  assertUnique(participants, (participant) => `${participant.eventId}\0${participant.subjectId}`, 'participants');
  for (const [index, participant] of participants.entries()) {
    assertReference(participant.eventId, eventIds, `participants[${index}].eventId`);
    assertReference(participant.subjectId, userIds, `participants[${index}].subjectId`);
    if (participant.importedAt !== undefined) dateValue(participant.importedAt, `participants[${index}].importedAt`);
  }

  const submissions = list('submissions');
  const submissionIds = new Set(submissions.map((submission) => submission.id));
  const submissionsById = new Map(submissions.map((submission) => [submission.id, submission]));
  assertUnique(submissions, (submission) => submission.id, 'submissions');
  assertUnique(submissions, (submission) => `${submission.eventId}\0${submission.subjectId}\0${submission.snapshot?.snapshotHash}`, 'submissions.snapshot');
  for (const [index, submission] of submissions.entries()) {
    assertReference(submission.eventId, eventIds, `submissions[${index}].eventId`);
    assertReference(submission.subjectId, userIds, `submissions[${index}].subjectId`);
    const snapshot = submission.snapshot ?? {};
    assertSha256(snapshot.snapshotHash, `submissions[${index}].snapshot.snapshotHash`, true);
    assertSha256(snapshot.artifactHash, `submissions[${index}].snapshot.artifactHash`);
    if (snapshot.submittedAt !== undefined) dateValue(snapshot.submittedAt, `submissions[${index}].snapshot.submittedAt`);
    if (submission.currentGradingRunId !== undefined) requiredString(submission.currentGradingRunId, `submissions[${index}].currentGradingRunId`);
    if (submission.currentResultId !== undefined) requiredString(submission.currentResultId, `submissions[${index}].currentResultId`);
    if (submission.previousResultIds !== undefined) {
      const previousResultIds = assertArray(submission.previousResultIds, `submissions[${index}].previousResultIds`);
      assertUnique(previousResultIds.map((id) => ({ id })), (item) => item.id, `submissions[${index}].previousResultIds`);
    }
  }

  const runs = list('runs');
  const runIds = new Set(runs.map((run) => run.id));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  assertUnique(runs, (run) => run.id, 'runs');
  assertUnique(runs, (run) => `${run.submissionId}\0${run.idempotencyKey ?? run.id}`, 'runs.idempotency');
  for (const [index, run] of runs.entries()) {
    assertReference(run.submissionId, submissionIds, `runs[${index}].submissionId`);
    if (run.createdAt !== undefined) dateValue(run.createdAt, `runs[${index}].createdAt`);
    if (run.leaseExpiresAt !== undefined) dateValue(run.leaseExpiresAt, `runs[${index}].leaseExpiresAt`);
  }

  const batches = list('evaluationBatches');
  const batchIds = new Set(batches.map((batch) => batch.id));
  assertUnique(batches, (batch) => batch.id, 'evaluationBatches');
  for (const [index, batch] of batches.entries()) {
    assertReference(batch.eventId, eventIds, `evaluationBatches[${index}].eventId`);
    assertReference(batch.challengeVersion, versionIds, `evaluationBatches[${index}].challengeVersion`);
    const batchRuns = assertArray(batch.runIds ?? [], `evaluationBatches[${index}].runIds`);
    const batchSubmissions = assertArray(batch.submissionIds ?? [], `evaluationBatches[${index}].submissionIds`);
    const completedRunIds = assertArray(batch.completedRunIds ?? [], `evaluationBatches[${index}].completedRunIds`);
    const failedRunIds = assertArray(batch.failedRunIds ?? [], `evaluationBatches[${index}].failedRunIds`);
    assertUnique(completedRunIds.map((id) => ({ id })), (item) => item.id, `evaluationBatches[${index}].completedRunIds`);
    assertUnique(failedRunIds.map((id) => ({ id })), (item) => item.id, `evaluationBatches[${index}].failedRunIds`);
    for (const runId of batchRuns) assertReference(runId, runIds, `evaluationBatches[${index}].runIds`);
    for (const submissionId of batchSubmissions) assertReference(submissionId, submissionIds, `evaluationBatches[${index}].submissionIds`);
    for (const runId of completedRunIds) assertReference(runId, runIds, `evaluationBatches[${index}].completedRunIds`);
    for (const runId of failedRunIds) assertReference(runId, runIds, `evaluationBatches[${index}].failedRunIds`);
    if (batchRuns.length !== batchSubmissions.length) throw new Error(`evaluationBatches[${index}] runIds/submissionIds length mismatch`);
    for (const [pairIndex, runId] of batchRuns.entries()) {
      const submissionId = batchSubmissions[pairIndex];
      const run = runsById.get(runId);
      const submission = submissionsById.get(submissionId);
      if (run && submission && run.submissionId !== submission.id) throw new Error(`evaluationBatches[${index}] runIds[${pairIndex}] does not belong to submissionIds[${pairIndex}]`);
      if (submission && submission.eventId !== batch.eventId) throw new Error(`evaluationBatches[${index}] submissionIds[${pairIndex}] belongs to another event`);
    }
    if (batch.leaseExpiresAt !== undefined) dateValue(batch.leaseExpiresAt, `evaluationBatches[${index}].leaseExpiresAt`);
    if (batch.finishedAt !== undefined) dateValue(batch.finishedAt, `evaluationBatches[${index}].finishedAt`);
  }

  const results = list('results');
  assertUnique(results, (stored) => stored.resultId, 'results');
  assertUnique(results, (stored) => stored.gradingRunId, 'results.gradingRunId');
  const resultIds = new Set(results.map((stored) => stored.resultId));
  const resultsById = new Map(results.map((stored) => [stored.resultId, stored]));
  for (const [index, stored] of results.entries()) {
    requiredString(stored.resultId, `results[${index}].resultId`);
    requiredString(stored.gradingRunId, `results[${index}].gradingRunId`);
    requiredString(stored.submissionId, `results[${index}].submissionId`);
    assertReference(stored.gradingRunId, runIds, `results[${index}].gradingRunId`);
    assertReference(stored.submissionId, submissionIds, `results[${index}].submissionId`);
    const run = runsById.get(stored.gradingRunId);
    if (run && run.submissionId !== stored.submissionId) throw new Error(`results[${index}] gradingRunId does not belong to submissionId`);
    const result = stored.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`results[${index}].result must be an object`);
    const total = Number(result.recalculatedTotal ?? result.total);
    if (!Number.isFinite(total) || total < 0 || total > 100) throw new Error(`results[${index}].result total is invalid`);
    if (stored.importedAt !== undefined) dateValue(stored.importedAt, `results[${index}].importedAt`);
  }
  for (const [index, submission] of submissions.entries()) {
    if (submission.currentGradingRunId !== undefined) {
      assertReference(submission.currentGradingRunId, runIds, `submissions[${index}].currentGradingRunId`);
      const run = runsById.get(submission.currentGradingRunId);
      if (run && run.submissionId !== submission.id) throw new Error(`submissions[${index}].currentGradingRunId belongs to another submission`);
    }
    if (submission.currentResultId !== undefined) {
      assertReference(submission.currentResultId, resultIds, `submissions[${index}].currentResultId`);
      const result = resultsById.get(submission.currentResultId);
      if (result && result.submissionId !== submission.id) throw new Error(`submissions[${index}].currentResultId belongs to another submission`);
    }
    for (const resultId of submission.previousResultIds ?? []) {
      assertReference(resultId, resultIds, `submissions[${index}].previousResultIds`);
      const result = resultsById.get(resultId);
      if (result && result.submissionId !== submission.id) throw new Error(`submissions[${index}].previousResultIds contains another submission result`);
    }
  }

  const seasons = list('seasons');
  assertUnique(seasons, (season) => season.id, 'seasons');
  for (const [index, season] of seasons.entries()) {
    for (const eventId of season.eventIds ?? []) assertReference(eventId, eventIds, `seasons[${index}].eventIds`);
    if (season.createdAt !== undefined) dateValue(season.createdAt, `seasons[${index}].createdAt`);
    if (season.updatedAt !== undefined) dateValue(season.updatedAt, `seasons[${index}].updatedAt`);
  }
  assertUnique(list('audits'), (audit) => audit.id, 'audits');
  assertUnique(list('announcements'), (announcement) => announcement.id, 'announcements');
}

try {
  validateShape();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (options.dryRun) {
  console.log(JSON.stringify({ dryRun: true, source: options.source, stats, errors }, null, 2));
  process.exit(0);
}

if (!process.env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL is required for a non-dry-run import');
  process.exit(2);
}

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (error) {
  console.error('Prisma client is not available; run pnpm install and prisma:generate first');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const client = new PrismaClient();

async function each(domain, items, handler) {
  for (const item of items) {
    try {
      await handler(item);
      stats[domain].written += 1;
    } catch (error) {
      stats[domain].failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ domain, id: item?.id, message });
      // A migration is all-or-nothing. Do not continue with a partially
      // imported graph and do not commit a transaction containing failures.
      throw new Error(`${domain}[${item?.id ?? 'unknown'}] failed: ${message}`);
    }
  }
}

try {
  await client.$transaction(async (db) => {
    // Parent rows must exist before their children because the normalized
    // schema enforces the self-referencing foreign key.  The JSON adapter did
    // not promise array order, so import by level rather than trusting the
    // source file's incidental ordering.
    await each('orgUnits', byLevel(list('orgUnits')), async (unit) => {
      await db.orgUnit.upsert({ where: { id: requiredString(unit.id, 'org unit id') }, update: { parentId: unit.parentId ?? null, path: requiredString(unit.path, 'org unit path'), level: Number(unit.level ?? 0), label: String(unit.label ?? ''), name: requiredString(unit.name, 'org unit name') }, create: { id: unit.id, parentId: unit.parentId ?? null, path: unit.path, level: Number(unit.level ?? 0), label: String(unit.label ?? ''), name: unit.name } });
    });

    await each('users', list('users'), async (user) => {
      const orgUnitId = user.orgUnitId?.trim() || null;
      await db.appUser.upsert({
        where: { id: user.id },
        update: { employeeNo: user.employeeNo, name: user.name, orgUnitId, orgPath: user.orgPath?.trim() || null, departmentHint: user.departmentHint ?? null, departmentSource: user.departmentSource ?? null, roles: jsonValue(user.roles, []), status: user.status ?? 'ACTIVE' },
        create: { id: user.id, employeeNo: user.employeeNo, name: user.name, orgUnitId, orgPath: user.orgPath?.trim() || null, departmentHint: user.departmentHint ?? null, departmentSource: user.departmentSource ?? null, roles: jsonValue(user.roles, []), status: user.status ?? 'ACTIVE' },
      });
      await db.roleBinding.deleteMany({ where: { userId: user.id } });
      const bindings = Array.isArray(user.roleBindings) ? user.roleBindings : [];
      if (bindings.length) await db.roleBinding.createMany({ data: bindings.map((binding) => ({ userId: user.id, role: requiredString(binding.role, 'role binding role'), scopeOrgPath: requiredString(binding.scopeOrgPath, 'role binding scope') })), skipDuplicates: true });
    });

    for (const challenge of list('challenges')) {
      await each('challenges', [challenge], async (item) => {
        await db.challenge.upsert({ where: { id: item.id }, update: { ownerOrgPath: item.ownerOrgPath ?? '/', origin: item.origin ?? 'IMPORTED', category: item.category ?? 'TRAINING', status: item.status ?? 'DRAFT', archivedFrom: item.archivedFrom ?? null, board: jsonValue(item.board) }, create: { id: item.id, ownerOrgPath: item.ownerOrgPath ?? '/', origin: item.origin ?? 'IMPORTED', category: item.category ?? 'TRAINING', status: item.status ?? 'DRAFT', archivedFrom: item.archivedFrom ?? null, board: jsonValue(item.board) } });
        for (const version of item.versions ?? []) {
          await db.challengeVersion.upsert({ where: { challengeId_version: { challengeId: item.id, version: Number(version.version) } }, update: { title: version.title ?? version.id, description: version.description ?? null, objectives: jsonValue(version.objectives), requirements: jsonValue(version.requirements), constraints: jsonValue(version.constraints), deliverables: jsonValue(version.deliverables), tags: jsonValue(version.tags), estimatedMinutes: version.estimatedMinutes ?? null, zone: version.zone ?? 'YELLOW', languagePolicy: jsonValue(version.languagePolicy, {}), deliveryPolicy: jsonValue(version.deliveryPolicy, {}), rubricVersion: version.rubricVersion ?? '1.0', submissionContract: version.submissionContract ?? '', submissionContractDefinition: jsonValue(version.submissionContractDefinition), evaluationEngine: jsonValue(version.evaluationEngine), tests: jsonValue(version.tests), resources: jsonValue(version.resources), resourceLimits: jsonValue(version.resourceLimits), changePackage: jsonValue(version.changePackage), visibility: version.visibility ?? null, bounty: version.bounty ?? null, explore: Boolean(version.explore), status: version.status ?? 'DRAFT' }, create: { id: version.id, challengeId: item.id, version: Number(version.version), title: version.title ?? version.id, description: version.description ?? null, objectives: jsonValue(version.objectives), requirements: jsonValue(version.requirements), constraints: jsonValue(version.constraints), deliverables: jsonValue(version.deliverables), tags: jsonValue(version.tags), estimatedMinutes: version.estimatedMinutes ?? null, zone: version.zone ?? 'YELLOW', languagePolicy: jsonValue(version.languagePolicy, {}), deliveryPolicy: jsonValue(version.deliveryPolicy, {}), rubricVersion: version.rubricVersion ?? '1.0', submissionContract: version.submissionContract ?? '', submissionContractDefinition: jsonValue(version.submissionContractDefinition), evaluationEngine: jsonValue(version.evaluationEngine), tests: jsonValue(version.tests), resources: jsonValue(version.resources), resourceLimits: jsonValue(version.resourceLimits), changePackage: jsonValue(version.changePackage), visibility: version.visibility ?? null, bounty: version.bounty ?? null, explore: Boolean(version.explore), status: version.status ?? 'DRAFT' } });
        }
      });
    }

    await each('events', list('events'), async (event) => {
      const versionId = requiredString(event.challengeVersion, 'event.challengeVersion');
      const version = await db.challengeVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new Error(`challenge version not found: ${versionId}`);
      await db.event.upsert({ where: { id: event.id }, update: { challengeVersionId: version.id, mode: event.mode ?? 'LIVE', submissionSource: event.submissionSource ?? 'UPLOAD', deliveryConfig: jsonValue(event.deliveryConfig, {}), trigger: event.trigger ?? 'MANUAL', reveal: event.reveal ?? 'IMMEDIATE', participantMode: event.participantMode ?? 'OPEN', purpose: event.purpose ?? null, accessPolicy: jsonValue(event.accessPolicy), rubricVersion: event.rubricVersion ?? '1.0', startsAt: dateValue(event.startsAt, 'event.startsAt') ?? null, endsAt: dateValue(event.endsAt, 'event.endsAt') ?? null, status: event.status ?? 'OPEN', localGrading: jsonValue(event.localGrading) }, create: { id: event.id, challengeVersionId: version.id, mode: event.mode ?? 'LIVE', submissionSource: event.submissionSource ?? 'UPLOAD', deliveryConfig: jsonValue(event.deliveryConfig, {}), trigger: event.trigger ?? 'MANUAL', reveal: event.reveal ?? 'IMMEDIATE', participantMode: event.participantMode ?? 'OPEN', purpose: event.purpose ?? null, accessPolicy: jsonValue(event.accessPolicy), rubricVersion: event.rubricVersion ?? '1.0', startsAt: dateValue(event.startsAt, 'event.startsAt'), endsAt: dateValue(event.endsAt, 'event.endsAt'), status: event.status ?? 'OPEN', localGrading: jsonValue(event.localGrading) } });
    });

    await each('participants', list('participants'), async (participant) => {
      await db.participation.upsert({ where: { eventId_subjectId: { eventId: participant.eventId, subjectId: participant.subjectId } }, update: { orgPathSnapshot: participant.orgPathSnapshot ?? '' }, create: { eventId: participant.eventId, subjectId: participant.subjectId, orgPathSnapshot: participant.orgPathSnapshot ?? '', importedAt: dateValue(participant.importedAt, 'participant.importedAt') } });
    });

    await each('submissions', list('submissions'), async (submission) => {
      const snapshot = submission.snapshot ?? {};
      const data = { eventId: submission.eventId, subjectId: submission.subjectId, orgPathSnapshot: submission.orgPathSnapshot ?? null, sourceType: snapshot.sourceType ?? 'UPLOAD', snapshotHash: snapshot.snapshotHash, artifactUri: snapshot.artifactUri ?? null, artifactName: snapshot.artifactName ?? null, artifactHash: snapshot.artifactHash ?? null, repository: snapshot.repository ?? null, branch: snapshot.branch ?? null, commitSha: snapshot.commitSha ?? null, workspacePath: snapshot.workspacePath ?? null, submittedAt: dateValue(snapshot.submittedAt, 'submission.submittedAt') ?? new Date(), state: submission.state ?? 'RECEIVED', challengeVersionSnapshot: submission.challengeVersionSnapshot ?? null, rubricVersionSnapshot: submission.rubricVersionSnapshot ?? null, gradingStatus: submission.gradingStatus ?? null, gradingAttempt: submission.gradingAttempt ?? null, previousResultIds: jsonValue(submission.previousResultIds), failureReason: submission.failureReason ?? null, currentGradingRunId: submission.gradingRunId ?? null, currentResultId: submission.resultId ?? null };
      await db.submission.upsert({ where: { eventId_subjectId_snapshotHash: { eventId: submission.eventId, subjectId: submission.subjectId, snapshotHash: snapshot.snapshotHash } }, update: data, create: { id: submission.id, ...data } });
    });

    await each('evaluationBatches', list('evaluationBatches'), async (batch) => {
      const version = await db.challengeVersion.findUnique({ where: { id: batch.challengeVersion } });
      if (!version) throw new Error(`challenge version not found: ${batch.challengeVersion}`);
      await db.evaluationBatch.upsert({ where: { id: batch.id }, update: { eventId: batch.eventId, challengeVersionId: version.id, runIds: jsonValue(batch.runIds, []), submissionIds: jsonValue(batch.submissionIds, []), engineIdentity: batch.engineIdentity ?? '', codeAgentRuntime: jsonValue(batch.codeAgentRuntime), createdBy: batch.createdBy ?? 'migration', status: batch.status ?? 'QUEUED', leaseId: batch.leaseId ?? null, completionLeaseId: batch.completionLeaseId ?? null, leasedBy: batch.leasedBy ?? null, leaseExpiresAt: dateValue(batch.leaseExpiresAt, 'batch.leaseExpiresAt') ?? null, completedRunIds: jsonValue(batch.completedRunIds), failedRunIds: jsonValue(batch.failedRunIds), failureReason: batch.failureReason ?? null, finishedAt: dateValue(batch.finishedAt, 'batch.finishedAt') ?? null }, create: { id: batch.id, eventId: batch.eventId, challengeVersionId: version.id, runIds: jsonValue(batch.runIds, []), submissionIds: jsonValue(batch.submissionIds, []), engineIdentity: batch.engineIdentity ?? '', codeAgentRuntime: jsonValue(batch.codeAgentRuntime), createdBy: batch.createdBy ?? 'migration', status: batch.status ?? 'QUEUED', leaseId: batch.leaseId ?? null, completionLeaseId: batch.completionLeaseId ?? null, leasedBy: batch.leasedBy ?? null, leaseExpiresAt: dateValue(batch.leaseExpiresAt, 'batch.leaseExpiresAt'), completedRunIds: jsonValue(batch.completedRunIds), failedRunIds: jsonValue(batch.failedRunIds), failureReason: batch.failureReason ?? null, finishedAt: dateValue(batch.finishedAt, 'batch.finishedAt') } });
    });

    await each('runs', list('runs'), async (run) => {
      await db.gradingRun.upsert({ where: { id: run.id }, update: { submissionId: run.submissionId, triggerType: run.triggerType ?? 'MANUAL', triggeredBy: run.triggeredBy ?? null, status: run.status ?? 'QUEUED', idempotencyKey: run.idempotencyKey ?? run.id, graderVersion: run.graderVersion ?? null, attempt: run.attempt ?? null, failureReason: run.failureReason ?? null, leaseId: run.leaseId ?? null, leasedBy: run.leasedBy ?? null, leaseExpiresAt: dateValue(run.leaseExpiresAt, 'run.leaseExpiresAt') ?? null, evaluationBatchId: run.evaluationBatchId ?? null }, create: { id: run.id, submissionId: run.submissionId, triggerType: run.triggerType ?? 'MANUAL', triggeredBy: run.triggeredBy ?? null, status: run.status ?? 'QUEUED', idempotencyKey: run.idempotencyKey ?? run.id, graderVersion: run.graderVersion ?? null, attempt: run.attempt ?? null, failureReason: run.failureReason ?? null, leaseId: run.leaseId ?? null, leasedBy: run.leasedBy ?? null, leaseExpiresAt: dateValue(run.leaseExpiresAt, 'run.leaseExpiresAt'), evaluationBatchId: run.evaluationBatchId ?? null, createdAt: dateValue(run.createdAt, 'run.createdAt') } });
    });

    await each('results', list('results'), async (stored) => {
      const result = stored.result ?? {};
      const total = Number(result.recalculatedTotal ?? result.total ?? 0);
      if (!Number.isFinite(total) || total < 0 || total > 100) throw new Error(`result total is invalid: ${stored.resultId}`);
      await db.evaluationResult.upsert({ where: { id: stored.resultId }, update: { gradingRunId: stored.gradingRunId, submissionId: stored.submissionId, schemaVersion: result.schemaVersion ?? '1.0', rubricVersion: result.rubricVersion ?? '1.0', total, status: result.status ?? 'COMPLETE', resultJson: result, importedAt: dateValue(stored.importedAt, 'result.importedAt') ?? new Date() }, create: { id: stored.resultId, gradingRunId: stored.gradingRunId, submissionId: stored.submissionId, schemaVersion: result.schemaVersion ?? '1.0', rubricVersion: result.rubricVersion ?? '1.0', total, status: result.status ?? 'COMPLETE', resultJson: result, importedAt: dateValue(stored.importedAt, 'result.importedAt') ?? new Date() } });
      // Keep the relational report projections in lockstep with the
      // immutable result JSON. Re-running the import therefore refreshes
      // evidence without accumulating stale criteria/findings.
      await db.criterionResult.deleteMany({ where: { evaluationResultId: stored.resultId } });
      await db.finding.deleteMany({ where: { evaluationResultId: stored.resultId } });
      const criteria = Array.isArray(result.criteria) ? result.criteria.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
      if (criteria.length) await db.criterionResult.createMany({ data: criteria.map((criterion, index) => {
        const key = typeof criterion.key === 'string' && criterion.key.trim() ? criterion.key.trim() : `criterion-${index + 1}`;
        return {
          evaluationResultId: stored.resultId,
          criterionKey: key,
          dimension: typeof criterion.dim === 'string' && criterion.dim.trim() ? criterion.dim : 'unknown',
          level: typeof criterion.level === 'string' && criterion.level.trim() ? criterion.level : 'UNKNOWN',
          score: Number.isFinite(Number(criterion.score)) ? Number(criterion.score) : 0,
          max: Number.isFinite(Number(criterion.max)) ? Number(criterion.max) : 0,
          source: typeof criterion.source === 'string' && criterion.source.trim() ? criterion.source : 'unknown',
          ...(criterion.evidence !== undefined ? { evidenceJson: criterion.evidence } : {}),
        };
      }) });
      const findings = Array.isArray(result.findings) ? result.findings.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
      if (findings.length) await db.finding.createMany({ data: findings.map((finding, index) => ({
        id: `${stored.resultId}:finding:${typeof finding.id === 'string' && finding.id.trim() ? finding.id.trim() : index + 1}`,
        evaluationResultId: stored.resultId,
        criterionKey: typeof finding.criteria === 'string' && finding.criteria.trim() ? finding.criteria : 'unknown',
        severity: typeof finding.severity === 'string' && finding.severity.trim() ? finding.severity : 'unknown',
        title: typeof finding.title === 'string' && finding.title.trim() ? finding.title : 'Finding',
        file: typeof finding.file === 'string' ? finding.file : null,
        line: Number.isSafeInteger(finding.line) ? finding.line : null,
        detail: typeof finding.detail === 'string' ? finding.detail : '',
        fix: typeof finding.fix === 'string' ? finding.fix : null,
      })) });
    });

    await each('seasons', list('seasons'), async (season) => {
      await db.season.upsert({ where: { id: season.id }, update: { name: season.name ?? season.id, status: season.status ?? 'DRAFT' }, create: { id: season.id, name: season.name ?? season.id, status: season.status ?? 'DRAFT', createdAt: dateValue(season.createdAt, 'season.createdAt'), updatedAt: dateValue(season.updatedAt, 'season.updatedAt') } });
      for (const eventId of season.eventIds ?? []) await db.seasonEvent.upsert({ where: { seasonId_eventId: { seasonId: season.id, eventId } }, update: { weight: 1 }, create: { seasonId: season.id, eventId, weight: 1 } });
    });

    await each('audits', list('audits'), async (audit) => {
      await db.auditLog.upsert({ where: { id: audit.id }, update: { actorId: audit.actorId, action: audit.action, target: audit.target, before: jsonValue(audit.before), after: jsonValue(audit.after), createdAt: dateValue(audit.createdAt, 'audit.createdAt') ?? new Date() }, create: { id: audit.id, actorId: audit.actorId, action: audit.action, target: audit.target, before: jsonValue(audit.before), after: jsonValue(audit.after), createdAt: dateValue(audit.createdAt, 'audit.createdAt') ?? new Date() } });
    });

    await each('announcements', list('announcements'), async (announcement) => {
      await db.announcement.upsert({ where: { id: announcement.id }, update: { title: announcement.title ?? '', summary: announcement.summary ?? '', tag: announcement.tag ?? '', publishedAt: dateValue(announcement.publishedAt, 'announcement.publishedAt') ?? new Date(), pinned: Boolean(announcement.pinned), orgPath: announcement.orgPath ?? null }, create: { id: announcement.id, title: announcement.title ?? '', summary: announcement.summary ?? '', tag: announcement.tag ?? '', publishedAt: dateValue(announcement.publishedAt, 'announcement.publishedAt') ?? new Date(), pinned: Boolean(announcement.pinned), orgPath: announcement.orgPath ?? null, createdAt: dateValue(announcement.createdAt, 'announcement.createdAt'), updatedAt: dateValue(announcement.updatedAt, 'announcement.updatedAt') } });
    });

    // Keep the transitional API envelope in the same transaction as the
    // normalized import. This prevents an otherwise successful migration from
    // booting the API with an empty snapshot while the relational tables hold
    // data that has not yet moved behind a domain repository.
    await db.platformSnapshot.upsert({
      where: { id: 'singleton' },
      update: { schemaVersion: 1, revision: { increment: 1 }, state },
      create: { id: 'singleton', schemaVersion: 1, revision: 1, state },
    });
  }, { timeout: Number(process.env.MIGRATION_TRANSACTION_TIMEOUT_MS ?? 120_000) });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  errors.push({ domain: 'transaction', message });
  console.error(`JSON import rolled back: ${message}`);
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}

console.log(JSON.stringify({ dryRun: false, source: options.source, stats, errors }, null, 2));
if (errors.length) process.exitCode = 1;
