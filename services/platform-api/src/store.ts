import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LocalEvaluationConfig,
  EventConfig,
  GradingRun,
  StoredResult,
  SubmissionRecord,
  SubmissionSnapshot,
  SubmissionSource,
  SubmissionState,
  TriggerType,
  AppUser,
  Challenge,
  ChallengeVersion,
  ChallengeBoardMetadata,
  ChallengeCategory,
  OrgUnit,
  Season,
  AuditRecord,
  Announcement,
  ParticipantRecord,
  HardProblem,
  HardProblemSolution,
  HardProblemSolutionVisibility,
  HardProblemReviewStatus,
  HardProblemStatus,
  AdminAccess,
  EvaluationEngineConfig,
  EvaluationInputBatch,
  EnginePackageRecord,
  SsoIdentity,
  EvaluationBatch,
  CodeAgentRuntimeConfig,
  CodeAgentRuntimeDiagnostics,
  CodeAgentRuntimeInput,
} from './domain';
import { validateEvaluationResult } from './contract-validator';
import { checkEvaluationScore } from './score-validator';
import { buildCodeAgentRuntimeConfig, codeAgentRuntimeDiagnostics, defaultCodeAgentRuntimeConfig } from './code-agent-runtime';
import {
  CAPABILITY_CATALOG_VERSION,
  CAPABILITY_DOMAINS,
  CAPABILITY_ITEMS,
  CAPABILITY_ITEM_BY_KEY,
} from './capability-catalog';
import type { AuditListQuery, AuditPage, SortOrder, SubmissionListItem, SubmissionListQuery, SubmissionPage, UserListQuery, UserPage, UserSortField } from './repository';
import { hasGlobalAdminAccess } from './access-control';

export type { UserListQuery, UserPage } from './repository';

function now(): string {
  return new Date().toISOString();
}

export function assertEventSubmissionWindow(event: Pick<EventConfig, 'startsAt' | 'endsAt'>): void {
  const currentTime = Date.now();
  const startsAt = event.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  if (Number.isFinite(startsAt) && currentTime < startsAt) {
    throw new ConflictException('event submission window has not started');
  }
  const endsAt = event.endsAt ? Date.parse(event.endsAt) : Number.NaN;
  if (Number.isFinite(endsAt) && currentTime > endsAt) {
    throw new ConflictException('event submission window has ended');
  }
}

function pageInfo(page: number, pageSize: number, total: number) {
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  return { page, pageSize, total, totalPages, hasNext: totalPages > 0 && page < totalPages, hasPrevious: totalPages > 0 && page > 1 };
}

const CHALLENGE_CATEGORIES: readonly ChallengeCategory[] = ['TRAINING', 'COMPETITION', 'HARD_PROBLEM'];
const HARD_PROBLEM_EVENT_SUFFIX = ':upload';

function isChallengeCategory(value: unknown): value is ChallengeCategory {
  return typeof value === 'string' && (CHALLENGE_CATEGORIES as readonly string[]).includes(value);
}

function isHardProblemReviewStatus(value: unknown): value is HardProblemReviewStatus {
  return value === 'PENDING_REVIEW' || value === 'APPROVED' || value === 'REJECTED';
}

function isHardProblemSolutionVisibility(value: unknown): value is HardProblemSolutionVisibility {
  return value === 'PUBLIC' || value === 'HIDDEN';
}

function inferChallengeCategory(challenge: Pick<Challenge, 'category' | 'origin' | 'board'>): ChallengeCategory {
  if (challenge.board?.type === 'HARD_PROBLEM' || challenge.origin === 'BOUNTY') return 'HARD_PROBLEM';
  return isChallengeCategory(challenge.category) ? challenge.category : 'TRAINING';
}

function plainText(value?: string): string {
  return (value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// The grader component of the key is the challenge's evaluation engine
// identity (`id@version`), so changing a challenge's rule set invalidates
// cached results for every trigger, not just for external evaluation.
function idempotencyKey(snapshotHash: string, challengeVersion: string, rubricVersion: string, graderVersion: string, attempt = 1): string {
  const attemptPart = attempt > 1 ? `|attempt:${attempt}` : '';
  return createHash('sha256').update(`${snapshotHash}|${rubricVersion}|${graderVersion}|${challengeVersion}${attemptPart}`).digest('hex');
}

const DEFAULT_EVALUATION_ENGINE: EvaluationEngineConfig = {
  id: 'standard-evaluation-engine',
  version: '1.0.0',
  mode: 'EXTERNAL_CLI',
  input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
  output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
};

const EXTERNAL_EVALUATION_INPUT_CONTRACT: EvaluationEngineConfig['input'] = {
  format: 'JSON',
  schemaVersion: '1.0',
  contractPath: 'contracts/evaluation-input.schema.json',
};

const CODE_AGENT_BATCH_INPUT_CONTRACT: EvaluationEngineConfig['input'] = {
  format: 'JSON',
  schemaVersion: '1.1',
  contractPath: 'contracts/evaluation-agent-batch-v1.1.schema.json',
};

const PLATFORM_RESULT_CONTRACT: EvaluationEngineConfig['output'] = {
  format: 'JSON',
  schemaVersion: '1.0',
  contractPath: 'contracts/evaluation-result.schema.json',
};

function evaluationEngineForVersion(version: ChallengeVersion): EvaluationEngineConfig {
  const configured = version.evaluationEngine;
  if (!configured) return { ...DEFAULT_EVALUATION_ENGINE, input: { ...DEFAULT_EVALUATION_ENGINE.input }, output: { ...DEFAULT_EVALUATION_ENGINE.output } };
  return {
    ...configured,
    ...(configured.agent ? { agent: { instructionPath: configured.agent.instructionPath, skillPaths: [...configured.agent.skillPaths] } } : {}),
    // Online Code Agent evaluation always receives the batch manifest. The
    // per-engine invocation schema is an internal bridge-to-engine protocol,
    // not a field challenge authors should have to guess.
    input: configured.mode === 'EXTERNAL_CLI' ? { ...configured.input } : { ...CODE_AGENT_BATCH_INPUT_CONTRACT },
    // Platform ingestion currently has one stable result envelope. Individual
    // challenges vary their criteria/evidence inside it, not the outer schema.
    output: { ...PLATFORM_RESULT_CONTRACT },
  };
}

function assertRepositoryPath(value: string, label: string): void {
  if (!value?.trim() || value.includes('..') || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    throw new BadRequestException(`${label} must be a repository-relative path`);
  }
}

function validateEvaluationEngine(engine?: EvaluationEngineConfig): void {
  if (!engine) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(engine.id)) throw new BadRequestException('evaluation engine id is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(engine.version)) throw new BadRequestException('evaluation engine version is invalid');
  if (!['EXTERNAL_CLI', 'PLATFORM_LOCAL', 'PACKAGED'].includes(engine.mode)) throw new BadRequestException('evaluation engine mode is invalid');
  for (const [label, contract] of [['input', engine.input], ['output', engine.output]] as const) {
    if (!contract || contract.format !== 'JSON' || !contract.schemaVersion?.trim() || !contract.contractPath?.trim()) {
      throw new BadRequestException(`evaluation engine ${label} contract is incomplete`);
    }
    assertRepositoryPath(contract.contractPath, `evaluation engine ${label} contract path`);
  }
  // The mode is a dispatch decision, not a label: PLATFORM_LOCAL is only
  // runnable if it carries the parameters the built-in grader needs, and
  // EXTERNAL_CLI must not pretend to be runnable in-process.
  if (engine.mode === 'PLATFORM_LOCAL') {
    // Which built-in executor, plus its parameters. The registry checks that
    // the executor exists and that the parameters satisfy its declared schema;
    // here we only enforce the shape.
    const executorId = engine.executor?.id;
    if (!executorId?.trim()) {
      throw new BadRequestException({ code: 'EXECUTOR_REQUIRED', message: 'PLATFORM_LOCAL 引擎必须选择一个内置执行器' });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(executorId)) throw new BadRequestException('evaluation engine executor id is invalid');
    for (const [key, value] of Object.entries(engine.executor?.params ?? {})) {
      if (typeof value === 'string' && /Path$|Dir$/.test(key)) assertRepositoryPath(value, `executor param ${key}`);
    }
  } else if (engine.executor) {
    throw new BadRequestException(`${engine.mode} engine must not declare a built-in executor`);
  }
  if (engine.mode === 'PACKAGED') {
    if (!/^[a-f0-9]{64}$/.test(engine.package?.packageHash ?? '')) {
      throw new BadRequestException({ code: 'ENGINE_PACKAGE_REQUIRED', message: 'PACKAGED 引擎必须先上传引擎包并绑定 packageHash' });
    }
  } else if (engine.package) {
    throw new BadRequestException(`${engine.mode} engine must not reference an engine package`);
  }
  if (engine.agent) {
    assertRepositoryPath(engine.agent.instructionPath, 'code agent instruction path');
    if (!Array.isArray(engine.agent.skillPaths) || !engine.agent.skillPaths.length) {
      throw new BadRequestException({ code: 'CODE_AGENT_SKILLS_REQUIRED', message: '线上评测引擎至少需要配置一个 Code Agent skill' });
    }
    for (const path of engine.agent.skillPaths) assertRepositoryPath(path, 'code agent skill path');
  }
}

const PARKING_FEE_EXECUTOR: EvaluationEngineConfig['executor'] = {
  id: 'drill-grader',
  params: {
    contractPath: 'challenges/parking-fee-v1/submission-contract.json',
    testsDir: 'challenges/parking-fee-v1/hidden-tests',
    entry: 'src/parking.py',
    function: 'calculate_fee',
    language: 'python',
    zone: 'yellow',
  },
};

/** Move a pre-registry `local` block onto the built-in executor it described. */
function executorFromLegacyLocal(local: LocalEvaluationConfig): EvaluationEngineConfig['executor'] {
  return {
    id: 'drill-grader',
    params: {
      contractPath: local.contractPath,
      ...(local.testsDir ? { testsDir: local.testsDir } : {}),
      entry: local.entry,
      function: local.function,
      language: local.language ?? 'python',
      zone: 'yellow',
    },
  };
}

/** A trigger is only offered when the challenge engine can actually serve it. */
function assertTriggerMatchesEngine(engine: EvaluationEngineConfig, trigger: TriggerType): void {
  if (engine.mode === 'EXTERNAL_CLI' && trigger !== 'IMPORT') {
    throw new BadRequestException({
      code: 'ENGINE_TRIGGER_UNSUPPORTED',
      message: `赛题的评测引擎为外部命令（EXTERNAL_CLI），只能选择线下结果录入；当前选择了 ${trigger}`,
    });
  }
}

/** The grader component of the idempotency key; a new package is new rules. */
function engineIdentityOf(engine: EvaluationEngineConfig): string {
  const packageHash = engine.mode === 'PACKAGED' ? engine.package?.packageHash : undefined;
  const agentHash = engine.agent
    ? createHash('sha256').update(JSON.stringify(engine.agent)).digest('hex').slice(0, 12)
    : undefined;
  const suffix = [packageHash?.slice(0, 16), agentHash].filter(Boolean).join('.');
  return suffix ? `${engine.id}@${engine.version}+${suffix}` : `${engine.id}@${engine.version}`;
}

// The grading key describes an immutable snapshot and rubric. It is stable
// across retries, but the same snapshot submitted by two people must still
// produce two independently addressable result records.
function resultIdempotencyKey(submissionId: string, key: string): string {
  return `${submissionId}:${key}`;
}

/** Compatibility aliases for callers that still import pagination types from the file adapter. */
export type UserListSortBy = UserSortField;
export type UserListSortOrder = SortOrder;

/**
 * The file adapter and the PostgreSQL snapshot adapter share this explicit
 * state shape.  Keeping the serialization boundary in the store prevents a
 * Prisma model from leaking into domain services while the relational
 * repositories are migrated one vertical slice at a time.
 */
export interface PlatformStateSnapshot {
  events: EventConfig[];
  submissions: SubmissionRecord[];
  runs: GradingRun[];
  evaluationBatches: EvaluationBatch[];
  results: StoredResult[];
  orgUnits: OrgUnit[];
  users: AppUser[];
  challenges: Challenge[];
  seasons: Season[];
  audits: AuditRecord[];
  announcements: Announcement[];
  hardProblems: HardProblem[];
  participants: ParticipantRecord[];
  codeAgentRuntimeConfig: CodeAgentRuntimeConfig;
  /** File-adapter local demo seed can be explicitly disabled after cleanup. */
  localDemoSeedEnabled?: boolean;
}

export interface PlatformStatePersistence {
  write(state: PlatformStateSnapshot): void | Promise<void>;
  flush?(): Promise<void>;
  /** Notify a canonical normalized repository write in this process. */
  noteExternalCommit?(): void;
  close?(): Promise<void>;
}

export interface PlatformStoreOptions {
  dataFile?: string;
  persistence?: PlatformStatePersistence;
  /** Local fixtures are opt-in for database-backed startup. */
  seed?: boolean;
  /** Keep the file adapter's local demo data compact without changing test fixtures. */
  seedProfile?: 'FULL' | 'MINIMAL';
}

@Injectable()
export class PlatformStore {
  private readonly events = new Map<string, EventConfig>();
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly runs = new Map<string, GradingRun>();
  private readonly evaluationBatches = new Map<string, EvaluationBatch>();
  private readonly results = new Map<string, StoredResult>();
  private readonly resultsByIdempotency = new Map<string, string>();
  private readonly orgUnits = new Map<string, OrgUnit>();
  private readonly users = new Map<string, AppUser>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly seasons = new Map<string, Season>();
  private readonly audits = new Map<string, AuditRecord>();
  private readonly announcements = new Map<string, Announcement>();
  private readonly hardProblems = new Map<string, HardProblem>();
  private readonly participants = new Map<string, ParticipantRecord>();
  private codeAgentRuntimeConfig: CodeAgentRuntimeConfig = defaultCodeAgentRuntimeConfig();
  private localDemoSeedEnabled = true;
  private readonly dataFile: string;
  private persistence?: PlatformStatePersistence;

  constructor(options: string | PlatformStoreOptions = process.env.PLATFORM_DATA_FILE ?? join(existsSync(join(process.cwd(), 'grader')) ? process.cwd() : resolve(process.cwd(), '..', '..'), 'tmp', 'platform-data.json')) {
    const resolvedOptions = typeof options === 'string' ? { dataFile: options } : options;
    this.dataFile = resolvedOptions.dataFile ?? ':memory:';
    this.persistence = resolvedOptions.persistence;
    this.load();
    if (resolvedOptions.seed === false) return;
    if (this.dataFile !== ':memory:' && !this.localDemoSeedEnabled) return;
    const configuredSeedProfile = resolvedOptions.seedProfile ?? process.env.PLATFORM_SEED_PROFILE ?? (this.dataFile === ':memory:' ? 'FULL' : 'MINIMAL');
    const seedProfile = String(configuredSeedProfile).trim().toUpperCase();
    if (seedProfile !== 'FULL' && seedProfile !== 'MINIMAL') throw new Error(`unsupported PLATFORM_SEED_PROFILE: ${seedProfile}`);
    const minimalSeed = seedProfile === 'MINIMAL';
    let seeded = minimalSeed ? this.pruneLegacyLocalFixture() : false;
    // Demo fixtures must not expire with the calendar. Real training events
    // still use administrator-configured windows and the same strict runtime
    // checks. Environment overrides keep local screenshots/UAT deterministic
    // when a narrower demo window is desired.
    const localTrainingStartsAt = process.env.PLATFORM_SEED_EVENT_STARTS_AT?.trim() || '2000-01-01T00:00:00+08:00';
    const localTrainingEndsAt = process.env.PLATFORM_SEED_EVENT_ENDS_AT?.trim() || '2100-01-01T00:00:00+08:00';
    if (!Number.isFinite(Date.parse(localTrainingStartsAt)) || !Number.isFinite(Date.parse(localTrainingEndsAt)) || Date.parse(localTrainingStartsAt) >= Date.parse(localTrainingEndsAt)) {
      throw new Error('PLATFORM_SEED_EVENT_STARTS_AT must be before PLATFORM_SEED_EVENT_ENDS_AT');
    }
    const legacyLocalTrainingStartsAt = '2026-08-01T09:00:00+08:00';
    const legacyLocalTrainingEndsAt = '2026-08-08T18:00:00+08:00';
    const canRepairLegacyWindow = (eventId: string): boolean => ![...this.submissions.values()].some((submission) => submission.eventId === eventId);
    const usesLegacyWindow = (event: EventConfig): boolean => event.startsAt === legacyLocalTrainingStartsAt && event.endsAt === legacyLocalTrainingEndsAt;
    const localEvent = this.events.get('event-local');
    const repairLocalWindow = Boolean(localEvent && usesLegacyWindow(localEvent) && canRepairLegacyWindow(localEvent.id));
    if (localEvent && (!localEvent.deliveryConfig || !localEvent.startsAt || !localEvent.endsAt || repairLocalWindow)) {
      localEvent.deliveryConfig ??= { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024 };
      if (!localEvent.startsAt || !localEvent.endsAt || repairLocalWindow) {
        localEvent.startsAt = localTrainingStartsAt;
        localEvent.endsAt = localTrainingEndsAt;
      }
      seeded = true;
    }
    if (!this.events.size) {
      this.events.set('event-local', {
        id: 'event-local',
        challengeVersion: 'parking-fee-01@1',
        submissionSource: 'UPLOAD',
        trigger: 'MANUAL',
        reveal: 'IMMEDIATE',
        status: 'OPEN',
        mode: 'WINDOW',
        startsAt: localTrainingStartsAt,
        endsAt: localTrainingEndsAt,
        deliveryConfig: { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024 },
      });
      seeded = true;
    }
    if (!minimalSeed && !this.events.has('event-local-git')) {
      this.events.set('event-local-git', {
        id: 'event-local-git',
        challengeVersion: 'parking-fee-01@1',
        submissionSource: 'GIT_REF',
        trigger: 'MANUAL',
        reveal: 'IMMEDIATE',
        status: 'OPEN',
        mode: 'WINDOW',
        startsAt: localTrainingStartsAt,
        endsAt: localTrainingEndsAt,
        deliveryConfig: { repository: 'training/parking-fee', branchTemplate: 'drill/{subjectId}' },
      });
      seeded = true;
    }
    const localGitEvent = this.events.get('event-local-git');
    const repairLocalGitWindow = Boolean(localGitEvent && usesLegacyWindow(localGitEvent) && canRepairLegacyWindow(localGitEvent.id));
    if (localGitEvent && (!localGitEvent.startsAt || !localGitEvent.endsAt || repairLocalGitWindow)) {
      if (!localGitEvent.startsAt || !localGitEvent.endsAt || repairLocalGitWindow) {
        localGitEvent.startsAt = localTrainingStartsAt;
        localGitEvent.endsAt = localTrainingEndsAt;
      }
      seeded = true;
    }
    if (!this.orgUnits.size) {
      const units = minimalSeed
        ? [
            { id: 'org-root', path: '/', level: 0, label: '集团', name: '华为' },
            { id: 'org-125', parentId: 'org-root', path: '/1/', level: 1, label: '部门', name: 'AI 工程团队' },
          ]
        : [
            { id: 'org-root', path: '/', level: 0, label: '集团', name: '华为' },
            { id: 'org-1', parentId: 'org-root', path: '/1/', level: 1, label: '一级组织', name: '企业业务' },
            { id: 'org-12', parentId: 'org-1', path: '/1/12/', level: 2, label: '二级组织', name: '云计算' },
            { id: 'org-125', parentId: 'org-12', path: '/1/12/125/', level: 3, label: '团队', name: 'AI 工程团队' },
          ];
      for (const unit of units) this.orgUnits.set(unit.id, unit);
      seeded = true;
    }
    if (!this.users.size) {
      const users: AppUser[] = minimalSeed
        ? [
            { id: 'w00123', employeeNo: 'w00123', name: '本地开发用户', orgUnitId: 'org-125', orgPath: '/1/', roles: ['global_admin'], roleBindings: [{ role: 'global_admin', scopeOrgPath: '/' }], status: 'ACTIVE' },
            { id: 'w00124', employeeNo: 'w00124', name: '本地学员 A', orgUnitId: 'org-125', orgPath: '/1/', roles: ['learner'], status: 'ACTIVE' },
            { id: 'w00126', employeeNo: 'w00126', name: '本地学员 B', orgUnitId: 'org-125', orgPath: '/1/', roles: ['learner'], status: 'ACTIVE' },
            { id: 'w00133', employeeNo: 'w00133', name: '本地导师', orgUnitId: 'org-125', orgPath: '/1/', roles: ['mentor'], status: 'ACTIVE' },
          ]
        : [
            { id: 'w00123', employeeNo: 'w00123', name: '本地开发用户', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['admin', 'learner'], roleBindings: [{ role: 'admin', scopeOrgPath: '/' }], status: 'ACTIVE' },
            { id: 'w00124', employeeNo: 'w00124', name: '本地学员 A', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['learner'], status: 'ACTIVE' },
            { id: 'w00125', employeeNo: 'w00125', name: '本地学员 B', orgUnitId: 'org-12', orgPath: '/1/12/', roles: ['learner'], status: 'ACTIVE' },
            { id: 'w00126', employeeNo: 'w00126', name: '本地学员 C', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['learner'], status: 'ACTIVE' },
          ];
      for (const user of users) this.users.set(user.id, user);
      seeded = true;
    }
    if (!minimalSeed && !this.users.has('w00126')) {
      this.users.set('w00126', { id: 'w00126', employeeNo: 'w00126', name: '本地学员 C', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['learner'], status: 'ACTIVE' });
      seeded = true;
    }
    for (const [id, name] of minimalSeed ? [] : [
      ['w00127', '本地学员 D'],
      ['w00128', '本地学员 E'],
      ['w00129', '本地学员 F'],
      ['w00130', '本地学员 G'],
      ['w00131', '本地学员 H'],
      ['w00132', '本地学员 I'],
    ] as const) {
      if (this.users.has(id)) continue;
      this.users.set(id, { id, employeeNo: id, name, orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['learner'], status: 'ACTIVE' });
      seeded = true;
    }
    const localMentor = this.users.get('w00133');
    if (!localMentor) {
      this.users.set('w00133', { id: 'w00133', employeeNo: 'w00133', name: '本地导师', orgUnitId: 'org-125', orgPath: '/1/12/125/', roles: ['mentor'], status: 'ACTIVE' });
      seeded = true;
    } else {
      const roles = new Set(localMentor.roles);
      if (!roles.has('mentor')) {
        roles.add('mentor');
        localMentor.roles = [...roles];
        seeded = true;
      }
    }
    const localGlobalAdmin = this.users.get('w00123');
    if (localGlobalAdmin) {
      const roles = new Set(localGlobalAdmin.roles);
      if (!roles.has('global_admin')) {
        roles.add('global_admin');
        localGlobalAdmin.roles = [...roles];
        seeded = true;
      }
      const bindings = localGlobalAdmin.roleBindings ?? [];
      if (!bindings.some((binding) => ['global_admin', 'admin'].includes(binding.role) && binding.scopeOrgPath === '/')) {
        localGlobalAdmin.roleBindings = [...bindings, { role: 'global_admin', scopeOrgPath: '/' }];
        seeded = true;
      }
    }
    if (!minimalSeed && !this.users.has('w00134')) {
      this.users.set('w00134', {
        id: 'w00134',
        employeeNo: 'w00134',
        name: '本地部门管理员',
        orgUnitId: 'org-125',
        orgPath: '/1/12/125/',
        roles: ['department_admin'],
        roleBindings: [{ role: 'department_admin', scopeOrgPath: '/1/12/125/' }],
        status: 'ACTIVE',
      });
      seeded = true;
    }
    if (!this.challenges.size) {
      const version: ChallengeVersion = {
        id: 'parking-fee-01@1',
        challengeId: 'parking-fee-01',
        version: 1,
        title: '停车场计费',
        description: '实现可复用的停车场计费函数，处理跨天停车、车型差异，以及需求中未明确的边界情况。',
        objectives: ['将自然语言需求拆解为可执行规则', '通过澄清和测试验证边界行为', '交付可维护、可复现的实现'],
        requirements: ['实现 src/parking.py 中的 calculate_fee 函数', '保持函数签名和返回结构不变', '在提交前提供清晰的实现说明'],
        constraints: ['仅可使用 Python 标准库', '不得修改隐藏测试或提交契约', '提交内容必须能在无网络环境中运行'],
        deliverables: ['源码压缩包或指定 Git 提交', 'SPEC.md：需求拆解与假设', 'transcript.md：关键澄清记录'],
        tags: ['需求澄清', '边界测试', 'Python'],
        estimatedMinutes: 40,
        zone: 'YELLOW',
        languagePolicy: { mode: 'fixed', languages: ['python'] },
        deliveryPolicy: { allowedSources: ['UPLOAD', 'GIT_REF'], upload: { formats: ['zip'] } },
        rubricVersion: '1.0',
        submissionContract: 'challenges/parking-fee-v1/submission-contract.json',
        evaluationEngine: {
          id: 'parking-fee-evaluator',
          version: '1.0.0',
          mode: 'PLATFORM_LOCAL',
          executor: { ...PARKING_FEE_EXECUTOR!, params: { ...PARKING_FEE_EXECUTOR!.params } },
          agent: { instructionPath: 'instruction.md', skillPaths: ['skills/evaluation'] },
          input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
          output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
        },
        status: 'PUBLISHED',
      };
      this.challenges.set('parking-fee-01', { id: 'parking-fee-01', ownerOrgPath: '/', origin: 'OFFICIAL', category: 'TRAINING', status: 'PUBLISHED', versions: [version] });
      seeded = true;
    }
    if (!minimalSeed) {
      for (const challenge of [
        { id: 'member-points-01', title: '会员积分规则引擎', version: 1 },
        { id: 'batch-log-scrub-01', title: '批量日志脱敏', version: 1 },
      ]) {
        if (this.challenges.has(challenge.id)) continue;
        this.challenges.set(challenge.id, {
          id: challenge.id,
          ownerOrgPath: '/',
          origin: 'OFFICIAL',
          category: 'TRAINING',
          status: 'PUBLISHED',
          versions: [{
            id: `${challenge.id}@${challenge.version}`,
            challengeId: challenge.id,
            version: challenge.version,
            title: challenge.title,
            description: challenge.id === 'member-points-01' ? '围绕会员消费、等级和积分生命周期，设计一套可演进的规则引擎。' : '为一批真实场景日志做脱敏处理，同时保持格式、顺序和可追溯性。',
            objectives: ['拆解复杂业务规则', '设计可验证、可交付的方案'],
            requirements: ['完成赛题说明中的核心功能', '提交实现说明和测试思路'],
            constraints: ['遵守赛题声明的语言和依赖限制', '评估环境默认不提供网络访问'],
            deliverables: ['源码交付件', '需求与假设说明'],
            tags: challenge.id === 'member-points-01' ? ['规格驱动', '规则引擎'] : ['批量改造', '工程质量'],
            estimatedMinutes: challenge.id === 'member-points-01' ? 60 : 45,
            zone: 'YELLOW',
            languagePolicy: { mode: 'fixed', languages: ['python'] },
            deliveryPolicy: { allowedSources: ['UPLOAD', 'GIT_REF'], upload: { formats: ['zip'] } },
            rubricVersion: '1.0',
            submissionContract: 'contracts/submission-contract.schema.json',
            evaluationEngine: {
              id: `${challenge.id}-evaluator`,
              version: '1.0.0',
              mode: 'EXTERNAL_CLI',
              input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
              output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
            },
            status: 'PUBLISHED',
          }],
        });
        seeded = true;
      }
    }
    // Backfill the publisher-selected category for challenge records created
    // before classifications were introduced. A legacy BOUNTY or board entry
    // remains a HARD_PROBLEM; all other legacy challenges default to TRAINING.
    for (const challenge of this.challenges.values()) {
      const category = inferChallengeCategory(challenge);
      if (challenge.category !== category) {
        challenge.category = category;
        seeded = true;
      }
      for (const version of challenge.versions) {
        if (version.evaluationEngine) continue;
        const local = version.id === 'parking-fee-01@1' ? { ...PARKING_FEE_EXECUTOR!, params: { ...PARKING_FEE_EXECUTOR!.params } } : undefined;
        version.evaluationEngine = {
          id: `${challenge.id}-evaluator`,
          version: '1.0.0',
          mode: local ? 'PLATFORM_LOCAL' : 'EXTERNAL_CLI',
          ...(local ? { executor: local } : {}),
          input: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-input.schema.json' },
          output: { format: 'JSON', schemaVersion: '1.0', contractPath: 'contracts/evaluation-result.schema.json' },
        };
        seeded = true;
      }
    }
    // Executor configuration used to be free-text paths on the engine
    // (`evaluationEngine.local`). Move it onto the built-in executor it always
    // described, so the registry becomes the only way to configure one.
    for (const challenge of this.challenges.values()) {
      for (const version of challenge.versions) {
        const legacy = version.evaluationEngine?.local;
        if (!legacy || version.evaluationEngine?.executor) continue;
        version.evaluationEngine = { ...version.evaluationEngine!, mode: 'PLATFORM_LOCAL', executor: executorFromLegacyLocal(legacy) };
        delete version.evaluationEngine.local;
        seeded = true;
      }
    }
    // Code Agent orchestration is versioned with the challenge engine. Older
    // runnable versions use the conventional package paths until an author
    // customizes them in a new challenge version.
    for (const challenge of this.challenges.values()) {
      for (const version of challenge.versions) {
        const engine = version.evaluationEngine;
        if (!engine || engine.mode === 'EXTERNAL_CLI' || engine.agent) continue;
        engine.agent = { instructionPath: 'instruction.md', skillPaths: ['skills/evaluation'] };
        seeded = true;
      }
    }
    // Executor configuration used to live on the session (`event.localGrading`),
    // so the same challenge could be graded by different rules depending on
    // which session received the delivery, and only the hard-coded parking-fee
    // session was runnable at all. Lift any persisted session config onto its
    // challenge version, which is now the single source of truth.
    for (const event of this.events.values()) {
      const legacy = event.localGrading;
      if (!legacy) continue;
      for (const challenge of this.challenges.values()) {
        const version = challenge.versions.find((item) => item.id === event.challengeVersion);
        if (!version?.evaluationEngine || version.evaluationEngine.executor) continue;
        version.evaluationEngine = { ...version.evaluationEngine, mode: 'PLATFORM_LOCAL', executor: executorFromLegacyLocal(legacy) };
        seeded = true;
      }
      delete event.localGrading;
      seeded = true;
    }
    const catalogMetadata: Record<string, Partial<ChallengeVersion>> = {
      'parking-fee-01@1': {
        description: '实现可复用的停车场计费函数，处理跨天停车、车型差异，以及需求中未明确的边界情况。',
        objectives: ['将自然语言需求拆解为可执行规则', '通过澄清和测试验证边界行为', '交付可维护、可复现的实现'],
        requirements: ['实现 src/parking.py 中的 calculate_fee 函数', '保持函数签名和返回结构不变', '在提交前提供清晰的实现说明'],
        constraints: ['仅可使用 Python 标准库', '不得修改隐藏测试或提交契约', '提交内容必须能在无网络环境中运行'],
        deliverables: ['源码压缩包或指定 Git 提交', 'SPEC.md：需求拆解与假设', 'transcript.md：关键澄清记录'],
        tags: ['需求澄清', '边界测试', 'Python'],
        estimatedMinutes: 40,
      },
      'member-points-01@1': {
        description: '围绕会员消费、等级和积分生命周期，设计一套可演进的规则引擎。',
        objectives: ['拆解复杂业务规则', '设计可验证、可交付的方案'],
        requirements: ['完成赛题说明中的核心功能', '提交实现说明和测试思路'],
        constraints: ['遵守赛题声明的语言和依赖限制', '评估环境默认不提供网络访问'],
        deliverables: ['源码交付件', '需求与假设说明'],
        tags: ['规格驱动', '规则引擎'],
        estimatedMinutes: 60,
      },
      'batch-log-scrub-01@1': {
        description: '为一批真实场景日志做脱敏处理，同时保持格式、顺序和可追溯性。',
        objectives: ['拆解复杂批处理任务', '在批量改造中保持工程质量'],
        requirements: ['完成赛题说明中的核心功能', '提交实现说明和测试思路'],
        constraints: ['遵守赛题声明的语言和依赖限制', '评估环境默认不提供网络访问'],
        deliverables: ['源码交付件', '需求与假设说明'],
        tags: ['批量改造', '工程质量'],
        estimatedMinutes: 45,
      },
    };
    for (const challenge of this.challenges.values()) {
      for (const version of challenge.versions) {
        const metadata = catalogMetadata[version.id];
        if (metadata && !version.description) {
          Object.assign(version, metadata);
          seeded = true;
        }
      }
    }
    if (!this.seasons.size) {
      this.seasons.set('season-local-2026', { id: 'season-local-2026', name: '本地训战赛季 2026', eventIds: minimalSeed ? ['event-local'] : ['event-local', 'event-local-git'], status: 'RUNNING' });
      seeded = true;
    } else if (!minimalSeed) {
      const localSeason = this.seasons.get('season-local-2026');
      if (localSeason && !localSeason.eventIds.includes('event-local-git')) {
        localSeason.eventIds.push('event-local-git');
        seeded = true;
      }
    }
    if (!this.announcements.size) {
      for (const announcement of [
        { id: 'announcement-welcome', title: '本期训战安排', summary: '本期训战已开放，提交后可在个人中心查看评估报告。', tag: '平台通知' as const, publishedAt: '2026-08-01T09:00:00Z', pinned: true },
        { id: 'announcement-local-grading', title: '本周训战提交提醒', summary: '本期训战支持上传交付件或提交 Git 版本，请按题目要求完成提交；评估结果生成后会同步到个人中心。', tag: '训战提醒' as const, publishedAt: '2026-08-01T08:30:00Z' },
        { id: 'announcement-score', title: '积分与能力画像说明', summary: '评估结果公布后，赛季积分、参赛记录和能力维度会同步到个人中心。', tag: '规则更新' as const, publishedAt: '2026-07-31T09:00:00Z' },
      ]) this.announcements.set(announcement.id, announcement);
      seeded = true;
    }
    const welcomeAnnouncement = this.announcements.get('announcement-welcome');
    if (welcomeAnnouncement?.summary.includes('赛题广场')) {
      welcomeAnnouncement.summary = welcomeAnnouncement.summary.replaceAll('赛题广场', '训战广场');
      seeded = true;
    }
    const welcomeCopy = this.announcements.get('announcement-welcome');
    if (welcomeCopy && (welcomeCopy.title.includes('欢迎') || welcomeCopy.summary.includes('从训战广场'))) {
      welcomeCopy.title = '本期训战安排';
      welcomeCopy.summary = '本期训战已开放，提交后可在个人中心查看评估报告。';
      seeded = true;
    }
    const localGradingCopy = this.announcements.get('announcement-local-grading');
    if (localGradingCopy && (localGradingCopy.title.includes('本地评测') || localGradingCopy.summary.includes('开发环境'))) {
      localGradingCopy.title = '本周训战提交提醒';
      localGradingCopy.summary = '本期训战支持上传交付件或提交 Git 版本，请按题目要求完成提交；评估结果生成后会同步到个人中心。';
      seeded = true;
    }
    const scoreCopy = this.announcements.get('announcement-score');
    if (scoreCopy?.summary.includes('评测')) {
      scoreCopy.summary = '评估结果揭晓后，赛季积分、参赛记录和能力维度会同步到个人中心。';
      seeded = true;
    }
    const hardProblemSeeds: HardProblem[] = minimalSeed ? [] : [
      {
        id: 'problem-knowledge-traceability',
        title: '跨团队知识库内容如何保持可追溯和可复用？',
        summary: '同一类问题在不同团队重复解决，现有文档缺少统一的来源、版本和验证记录。',
        details: '希望找到一套轻量的知识采集、审核和检索方案，让经验可以被复用，同时能追溯到原始交付和验证结果。',
        publisherType: 'DEPARTMENT',
        publisherId: 'org-125',
        publisherName: 'AI 工程团队',
        departmentName: 'AI 工程团队',
        orgPath: '/1/12/125/',
        difficulty: 'HIGH',
        tags: ['知识沉淀', '流程协同', '可追溯'],
        status: 'OPEN',
        reviewStatus: 'APPROVED',
        solutionVisibility: 'PUBLIC',
        createdAt: '2026-07-30T08:30:00Z',
        updatedAt: '2026-07-30T08:30:00Z',
      },
      {
        id: 'problem-nested-log-redaction',
        title: '复杂嵌套字段下的批量日志脱敏如何保持稳定？',
        summary: '不同服务的日志结构差异较大，脱敏规则容易漏字段，也难以确认改造没有破坏原始格式。',
        details: '当前方案依赖人工维护字段清单，面对嵌套数组、动态键和异常日志时覆盖不足。需要可测试、可回滚的批量处理方法。',
        publisherType: 'EMPLOYEE',
        publisherId: 'w00124',
        publisherName: '本地学员 A',
        departmentName: 'AI 工程团队',
        orgPath: '/1/12/125/',
        difficulty: 'HIGH',
        tags: ['日志治理', '批量改造', '工程质量'],
        status: 'OPEN',
        reviewStatus: 'APPROVED',
        solutionVisibility: 'PUBLIC',
        createdAt: '2026-07-29T03:15:00Z',
        updatedAt: '2026-07-31T06:20:00Z',
      },
      {
        id: 'problem-api-change-impact',
        title: '内部 API 变更如何低成本验证下游影响？',
        summary: '接口字段调整前缺少可视化的下游依赖清单，变更后经常要靠人工排查回归范围。',
        details: '希望建立从接口契约、调用方到验证结果的最小闭环，在不增加过多维护成本的情况下提前发现兼容性风险。',
        publisherType: 'EMPLOYEE',
        publisherId: 'w00126',
        publisherName: '本地学员 C',
        departmentName: 'AI 工程团队',
        orgPath: '/1/12/125/',
        difficulty: 'MEDIUM',
        tags: ['API 治理', '回归验证', '依赖分析'],
        status: 'OPEN',
        reviewStatus: 'APPROVED',
        solutionVisibility: 'PUBLIC',
        createdAt: '2026-07-27T10:00:00Z',
        updatedAt: '2026-07-28T04:45:00Z',
      },
    ];
    // Migrate the previous standalone hard-problem records into the challenge
    // library. The old map remains only as a read fallback for an interrupted
    // file migration and is cleared after the challenge projection is stored.
    for (const problem of [...this.hardProblems.values(), ...hardProblemSeeds]) {
      const existing = this.challenges.get(problem.id);
      if (existing) {
        if (existing.category !== 'HARD_PROBLEM') {
          existing.category = 'HARD_PROBLEM';
          seeded = true;
        }
        if (!existing.board) {
          existing.board = this.boardMetadataFromHardProblem(problem);
          seeded = true;
        }
        continue;
      }
      this.challenges.set(problem.id, this.challengeFromHardProblem(problem));
      seeded = true;
    }
    if (this.hardProblems.size) {
      this.hardProblems.clear();
      seeded = true;
    }
    for (const challenge of this.challenges.values()) {
      if (challenge.board?.type !== 'HARD_PROBLEM') continue;
      if (!isHardProblemReviewStatus(challenge.board.reviewStatus)) {
        challenge.board.reviewStatus = 'APPROVED';
        seeded = true;
      }
      if (!isHardProblemSolutionVisibility(challenge.board.solutionVisibility)) {
        challenge.board.solutionVisibility = 'PUBLIC';
        seeded = true;
      }
      if (this.syncHardProblemSubmissionEvent(challenge)) seeded = true;
    }
    if (seeded) this.persist();
  }

  /**
   * Compact the original empty local demo fixture once it is opened with the
   * file adapter. This deliberately runs only when the file contains the
   * known seed IDs and has no submissions, runs, batches or results; a custom
   * local dataset is never silently deleted.
   */
  private pruneLegacyLocalFixture(): boolean {
    if (this.dataFile === ':memory:' || this.submissions.size || this.runs.size || this.evaluationBatches.size || this.results.size) return false;
    const knownChallenges = new Set(['parking-fee-01', 'member-points-01', 'batch-log-scrub-01', 'problem-knowledge-traceability', 'problem-nested-log-redaction', 'problem-api-change-impact']);
    const knownEvents = new Set(['event-local', 'event-local-git', 'hard-problem:problem-knowledge-traceability:upload', 'hard-problem:problem-nested-log-redaction:upload', 'hard-problem:problem-api-change-impact:upload']);
    const knownUsers = new Set(['w00123', 'w00124', 'w00125', 'w00126', 'w00127', 'w00128', 'w00129', 'w00130', 'w00131', 'w00132', 'w00133', 'w00134']);
    const knownOrgUnits = new Set(['org-root', 'org-1', 'org-12', 'org-125']);
    const onlyKnown = <T extends { id: string }>(rows: Map<string, T>, known: Set<string>): boolean => [...rows.keys()].every((id) => known.has(id));
    if (!onlyKnown(this.challenges, knownChallenges) || !onlyKnown(this.events, knownEvents) || !onlyKnown(this.users, knownUsers) || !onlyKnown(this.orgUnits, knownOrgUnits)) return false;

    let changed = false;
    const keepChallenge = new Set(['parking-fee-01']);
    for (const id of [...this.challenges.keys()]) {
      if (keepChallenge.has(id)) continue;
      this.challenges.delete(id);
      changed = true;
    }
    const keepEvent = new Set(['event-local']);
    for (const id of [...this.events.keys()]) {
      if (keepEvent.has(id)) continue;
      this.events.delete(id);
      changed = true;
    }
    const keepUser = new Set(['w00123', 'w00124', 'w00126', 'w00133']);
    for (const id of [...this.users.keys()]) {
      if (keepUser.has(id)) continue;
      this.users.delete(id);
      changed = true;
    }
    const keepOrgUnit = new Set(['org-root', 'org-125']);
    for (const id of [...this.orgUnits.keys()]) {
      if (keepOrgUnit.has(id)) continue;
      this.orgUnits.delete(id);
      changed = true;
    }
    const department = this.orgUnits.get('org-125');
    if (department && (department.parentId !== 'org-root' || department.path !== '/1/' || department.level !== 1 || department.label !== '部门' || department.name !== 'AI 工程团队')) {
      this.orgUnits.set('org-125', { ...department, parentId: 'org-root', path: '/1/', level: 1, label: '部门', name: 'AI 工程团队' });
      changed = true;
    }
    for (const user of this.users.values()) {
      const nextRoles = user.id === 'w00123' ? ['global_admin'] : user.id === 'w00133' ? ['mentor'] : ['learner'];
      const nextBindings = user.id === 'w00123' ? [{ role: 'global_admin' as const, scopeOrgPath: '/' }] : undefined;
      const canonicalName = ({ w00123: '本地开发用户', w00124: '本地学员 A', w00126: '本地学员 B', w00133: '本地导师' } as Record<string, string>)[user.id];
      if (user.name !== canonicalName || user.orgUnitId !== 'org-125' || user.orgPath !== '/1/' || JSON.stringify(user.roles) !== JSON.stringify(nextRoles) || JSON.stringify(user.roleBindings) !== JSON.stringify(nextBindings)) {
        this.users.set(user.id, { ...user, ...(canonicalName ? { name: canonicalName } : {}), orgUnitId: 'org-125', orgPath: '/1/', roles: nextRoles, ...(nextBindings ? { roleBindings: nextBindings } : { roleBindings: undefined }) });
        changed = true;
      }
    }
    const localEvent = this.events.get('event-local');
    if (localEvent) {
      const accessPolicy = {
        mode: 'RESTRICTED' as const,
        subjectIds: ['w00124', 'w00126'],
        departmentIds: ['org-125'],
        mentorIds: ['w00133'],
      };
      if (JSON.stringify(localEvent.accessPolicy) !== JSON.stringify(accessPolicy) || localEvent.participantMode !== 'ALLOWLIST') {
        localEvent.accessPolicy = accessPolicy;
        localEvent.participantMode = 'ALLOWLIST';
        changed = true;
      }
    }
    const keepParticipantIds = new Set(['w00124', 'w00126']);
    for (const key of [...this.participants.keys()]) {
      const participant = this.participants.get(key);
      if (participant?.eventId === 'event-local' && keepParticipantIds.has(participant.subjectId)) continue;
      this.participants.delete(key);
      changed = true;
    }
    for (const subjectId of keepParticipantIds) {
      const key = `event-local:${subjectId}`;
      if (this.participants.has(key)) continue;
      const user = this.users.get(subjectId);
      if (!user) continue;
      this.participants.set(key, { eventId: 'event-local', subjectId, orgPathSnapshot: user.orgPath, importedAt: now() });
      changed = true;
    }
    for (const season of this.seasons.values()) {
      const eventIds = season.eventIds.filter((eventId) => eventId === 'event-local');
      if (JSON.stringify(season.eventIds) !== JSON.stringify(eventIds)) {
        season.eventIds = eventIds;
        changed = true;
      }
    }
    if (this.hardProblems.size) {
      this.hardProblems.clear();
      changed = true;
    }
    if (this.audits.size) {
      this.audits.clear();
      changed = true;
    }
    return changed;
  }

  private load(): void {
    if (this.dataFile === ':memory:' || !existsSync(this.dataFile)) return;
    try {
      const state = JSON.parse(readFileSync(this.dataFile, 'utf8')) as Partial<PlatformStateSnapshot>;
      for (const event of state.events ?? []) this.events.set(event.id, event);
      for (const submission of state.submissions ?? []) this.submissions.set(submission.id, submission);
      for (const run of state.runs ?? []) this.runs.set(run.id, run);
      for (const batch of state.evaluationBatches ?? []) this.evaluationBatches.set(batch.id, batch);
      for (const result of state.results ?? []) {
        this.results.set(result.resultId, result);
        const key = (result.result as { idempotencyKey?: string }).idempotencyKey;
        if (key) this.resultsByIdempotency.set(resultIdempotencyKey(result.submissionId, key), result.resultId);
      }
      for (const unit of state.orgUnits ?? []) this.orgUnits.set(unit.id, unit);
      for (const user of state.users ?? []) this.users.set(user.id, user);
      for (const challenge of state.challenges ?? []) this.challenges.set(challenge.id, challenge);
      for (const season of state.seasons ?? []) this.seasons.set(season.id, season);
      for (const audit of state.audits ?? []) this.audits.set(audit.id, audit);
      for (const announcement of state.announcements ?? []) this.announcements.set(announcement.id, announcement);
      for (const problem of state.hardProblems ?? []) this.hardProblems.set(problem.id, problem);
      for (const participant of state.participants ?? []) this.participants.set(`${participant.eventId}:${participant.subjectId}`, participant);
      if (state.localDemoSeedEnabled === false) this.localDemoSeedEnabled = false;
      if (state.codeAgentRuntimeConfig) {
        this.codeAgentRuntimeConfig = buildCodeAgentRuntimeConfig(
          state.codeAgentRuntimeConfig,
          state.codeAgentRuntimeConfig.updatedBy || 'system',
          state.codeAgentRuntimeConfig.updatedAt || now(),
        );
      }
    } catch {
      throw new Error(`platform data file is invalid: ${this.dataFile}`);
    }
  }

  /** Return a detached, JSON-safe representation for a persistence adapter. */
  exportState(): PlatformStateSnapshot {
    return JSON.parse(JSON.stringify({
      events: [...this.events.values()],
      submissions: [...this.submissions.values()],
      runs: [...this.runs.values()],
      evaluationBatches: [...this.evaluationBatches.values()],
      results: [...this.results.values()],
      orgUnits: [...this.orgUnits.values()],
      users: [...this.users.values()],
      challenges: [...this.challenges.values()],
      seasons: [...this.seasons.values()],
      audits: [...this.audits.values()],
      announcements: [...this.announcements.values()],
      hardProblems: [...this.hardProblems.values()],
      participants: [...this.participants.values()],
      codeAgentRuntimeConfig: this.codeAgentRuntimeConfig,
      localDemoSeedEnabled: this.localDemoSeedEnabled,
    })) as PlatformStateSnapshot;
  }

  /**
   * Replace in-memory state from a previously validated snapshot.  This is
   * used only at startup by the PostgreSQL adapter; request handlers continue
   * to use the same domain methods as the local adapter.
   */
  importState(state: Partial<PlatformStateSnapshot>): void {
    this.events.clear();
    this.submissions.clear();
    this.runs.clear();
    this.evaluationBatches.clear();
    this.results.clear();
    this.resultsByIdempotency.clear();
    this.orgUnits.clear();
    this.users.clear();
    this.challenges.clear();
    this.seasons.clear();
    this.audits.clear();
    this.announcements.clear();
    this.hardProblems.clear();
    this.participants.clear();
    this.localDemoSeedEnabled = state.localDemoSeedEnabled !== false;
    for (const event of state.events ?? []) if (event?.id) this.events.set(event.id, event);
    for (const submission of state.submissions ?? []) if (submission?.id) this.submissions.set(submission.id, submission);
    for (const run of state.runs ?? []) if (run?.id) this.runs.set(run.id, run);
    for (const batch of state.evaluationBatches ?? []) if (batch?.id) this.evaluationBatches.set(batch.id, batch);
    for (const result of state.results ?? []) {
      if (!result?.resultId) continue;
      this.results.set(result.resultId, result);
      const key = (result.result as { idempotencyKey?: string })?.idempotencyKey;
      if (key) this.resultsByIdempotency.set(resultIdempotencyKey(result.submissionId, key), result.resultId);
    }
    for (const unit of state.orgUnits ?? []) if (unit?.id) this.orgUnits.set(unit.id, unit);
    for (const user of state.users ?? []) if (user?.id) this.users.set(user.id, user);
    for (const challenge of state.challenges ?? []) if (challenge?.id) this.challenges.set(challenge.id, challenge);
    for (const season of state.seasons ?? []) if (season?.id) this.seasons.set(season.id, season);
    for (const audit of state.audits ?? []) if (audit?.id) this.audits.set(audit.id, audit);
    for (const announcement of state.announcements ?? []) if (announcement?.id) this.announcements.set(announcement.id, announcement);
    for (const problem of state.hardProblems ?? []) if (problem?.id) this.hardProblems.set(problem.id, problem);
    for (const participant of state.participants ?? []) if (participant?.eventId && participant?.subjectId) this.participants.set(`${participant.eventId}:${participant.subjectId}`, participant);
    if (state.codeAgentRuntimeConfig) this.codeAgentRuntimeConfig = buildCodeAgentRuntimeConfig(state.codeAgentRuntimeConfig, state.codeAgentRuntimeConfig.updatedBy || 'system', state.codeAgentRuntimeConfig.updatedAt || now());
  }

  /** Attach the database writer after startup state has been loaded. */
  attachPersistence(persistence: PlatformStatePersistence, flushInitial = false): void {
    this.persistence = persistence;
    if (flushInitial) this.persist();
  }

  async flushPersistence(): Promise<void> {
    await this.persistence?.flush?.();
  }

  /** Keep the transitional writer's CAS revision aligned with a repository
   * transaction that has already committed the canonical normalized rows. */
  noteExternalCommit(): void {
    this.persistence?.noteExternalCommit?.();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.flushPersistence();
    } finally {
      await this.persistence?.close?.();
    }
  }

  /** Update the authorization cache after an external identity transaction. */
  cacheUserSnapshot(user: AppUser): void {
    this.users.set(user.id, JSON.parse(JSON.stringify(user)) as AppUser);
    // In PostgreSQL mode the user-directory repository has already committed
    // the canonical row (and its audit) in its own transaction.  This method
    // only refreshes the in-process authorization/read cache; asking the
    // transitional full-state envelope to write here would let a stale API
    // instance overwrite a concurrent normalized user update.  File mode
    // writes already happen inside the adapter operation that produced this
    // snapshot.
  }

  private persist(): void {
    const state = this.exportState();
    if (this.persistence) {
      void this.persistence.write(state);
      return;
    }
    if (this.dataFile === ':memory:') return;
    mkdirSync(dirname(this.dataFile), { recursive: true });
    // Write-then-rename: a crash or a full disk during a direct overwrite left
    // a truncated JSON file behind, and `load()` then refused to start the API
    // at all. rename(2) is atomic on the same filesystem, so a reader always
    // sees either the previous or the complete new state.
    const temporary = `${this.dataFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    renameSync(temporary, this.dataFile);
  }

  private audit(actorId: string, action: string, target: string, before?: unknown, after?: unknown): void {
    const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
    const record: AuditRecord = { id: `audit-${randomUUID()}`, actorId, action, target, before: clone(before), after: clone(after), createdAt: now() };
    this.audits.set(record.id, record);
  }

  listAudits(target?: string, actorId = 'w00123'): AuditRecord[] {
    const adminAccess = this.isAdmin(actorId) ? this.getAdminAccess(actorId) : undefined;
    const actor = this.users.get(actorId);
    return [...this.audits.values()].filter((item) => {
      if (target && item.target !== target) return false;
      if (!adminAccess || adminAccess.level === 'GLOBAL') return true;
      const targetId = item.target.split(':').slice(1).join(':');
      if (item.target.startsWith('challenge:')) {
        const challenge = this.challenges.get(targetId);
        return Boolean(challenge && adminAccess.scopeOrgPaths.some((scope) => challenge.ownerOrgPath !== '/' && this.orgPathIncludes(scope, challenge.ownerOrgPath)));
      }
      if (item.target.startsWith('event:')) {
        const event = this.events.get(targetId);
        return Boolean(event && this.eventInAdminScope(event, actorId));
      }
      if (item.target.startsWith('submission:')) {
        const submission = this.submissions.get(targetId);
        const subject = submission ? this.users.get(submission.subjectId) : undefined;
        return Boolean(subject && adminAccess.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, subject.orgPath)));
      }
      if (item.target.startsWith('announcement:')) {
        const announcement = this.announcements.get(targetId);
        return Boolean(announcement?.orgPath && adminAccess.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, announcement.orgPath!)));
      }
      const auditActor = this.users.get(item.actorId);
      return Boolean((auditActor ?? actor) && adminAccess.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, (auditActor ?? actor)!.orgPath)));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listAnnouncements(actorId = 'w00123'): Announcement[] {
    const adminAccess = this.isAdmin(actorId) ? this.getAdminAccess(actorId) : undefined;
    const actor = this.users.get(actorId);
    return [...this.announcements.values()]
      .filter((announcement) => {
        if (!announcement.orgPath) return true;
        if (!adminAccess || adminAccess.level === 'GLOBAL') return true;
        const targetPath = announcement.orgPath;
        const scopePaths = adminAccess?.scopeOrgPaths ?? (actor ? [actor.orgPath] : []);
        return scopePaths.some((scope) => this.orgPathIncludes(scope, targetPath));
      })
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.publishedAt.localeCompare(a.publishedAt));
  }

  private hardProblemEventId(challengeId: string): string {
    return `hard-problem:${challengeId}${HARD_PROBLEM_EVENT_SUFFIX}`;
  }

  private hardProblemReviewStatus(board?: ChallengeBoardMetadata): HardProblemReviewStatus {
    // Records created before review workflow existed were already visible on
    // the board, so treat a missing value as approved during migration.
    return isHardProblemReviewStatus(board?.reviewStatus) ? board!.reviewStatus : 'APPROVED';
  }

  private hardProblemSolutionVisibility(board?: ChallengeBoardMetadata): HardProblemSolutionVisibility {
    // Existing records predate the public/hide solution switch. Preserve the
    // original board behaviour by making their winning delivery public.
    return isHardProblemSolutionVisibility(board?.solutionVisibility) ? board!.solutionVisibility : 'PUBLIC';
  }

  private boardMetadataFromHardProblem(problem: HardProblem): ChallengeBoardMetadata {
    return {
      type: 'HARD_PROBLEM',
      summary: problem.summary.trim(),
      ...(problem.details?.trim() ? { details: problem.details.trim() } : {}),
      publisherType: problem.publisherType,
      publisherId: problem.publisherId,
      publisherName: problem.publisherName?.trim() || problem.publisherId,
      ...(problem.departmentName?.trim() ? { departmentName: problem.departmentName.trim() } : {}),
      ...(problem.orgPath?.trim() ? { orgPath: problem.orgPath.trim() } : {}),
      difficulty: problem.difficulty,
      tags: problem.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8),
      status: problem.status,
      reviewStatus: problem.reviewStatus ?? 'APPROVED',
      solutionVisibility: isHardProblemSolutionVisibility(problem.solutionVisibility) ? problem.solutionVisibility : 'PUBLIC',
      ...(problem.solutionSubmissionId ? { solutionSubmissionId: problem.solutionSubmissionId } : {}),
      ...(problem.submissionEventId ? { submissionEventId: problem.submissionEventId } : {}),
      ...(problem.reviewedAt ? { reviewedAt: problem.reviewedAt } : {}),
      ...(problem.reviewedBy ? { reviewedBy: problem.reviewedBy } : {}),
      ...(problem.reviewComment ? { reviewComment: problem.reviewComment } : {}),
      createdAt: problem.createdAt,
      updatedAt: problem.updatedAt,
      ...(problem.resolvedAt ? { resolvedAt: problem.resolvedAt } : {}),
      ...(problem.resolvedBy ? { resolvedBy: problem.resolvedBy } : {}),
      ...(problem.resolvedByName ? { resolvedByName: problem.resolvedByName } : {}),
      ...(problem.solverId ? { solverId: problem.solverId } : {}),
      ...(problem.solverName ? { solverName: problem.solverName } : {}),
    };
  }

  private defaultBoardMetadataFromChallenge(challenge: Challenge, actorId: string): ChallengeBoardMetadata {
    const version = challenge.versions.slice().sort((a, b) => b.version - a.version)[0];
    const actor = this.users.get(actorId);
    const publisherType = actor ? 'EMPLOYEE' as const : 'DEPARTMENT' as const;
    const publisherId = actor?.id ?? challenge.ownerOrgPath;
    const publisherName = actor?.name ?? challenge.ownerOrgPath;
    const departmentName = actor ? this.orgUnits.get(actor.orgUnitId)?.name : undefined;
    const description = version?.summary?.trim() || plainText(version?.description);
    const timestamp = now();
    const approved = actor ? this.isAdmin(actorId) : actorId === 'admin-local';
    return {
      type: 'HARD_PROBLEM',
      summary: (description || version?.title || challenge.id).slice(0, 500),
      ...(version?.description ? { details: version.description } : {}),
      publisherType,
      publisherId,
      publisherName,
      ...(departmentName ? { departmentName } : {}),
      orgPath: actor?.orgPath ?? challenge.ownerOrgPath,
      difficulty: 'MEDIUM',
      tags: [...(version?.tags ?? [])].map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8),
      status: 'OPEN',
      reviewStatus: approved ? 'APPROVED' : 'PENDING_REVIEW',
      solutionVisibility: 'PUBLIC',
      ...(approved ? { reviewedAt: timestamp, reviewedBy: actorId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private challengeFromHardProblem(problem: HardProblem): Challenge {
    const board = this.boardMetadataFromHardProblem(problem);
    const version: ChallengeVersion = {
      id: `${problem.id}@1`,
      challengeId: problem.id,
      version: 1,
      title: problem.title.trim(),
      description: problem.details?.trim() || problem.summary.trim(),
      objectives: ['明确问题边界与验收标准', '提交可复现、可验证的解决方案'],
      requirements: [problem.summary.trim()],
      constraints: ['不得修改平台评估契约或隐藏测试', '方案需要保留验证记录，便于复盘和复用'],
      deliverables: ['解决方案代码或交付件', '实现说明、验证记录和风险说明'],
      tags: [...board.tags],
      estimatedMinutes: 60,
      zone: 'BLUE',
      languagePolicy: { mode: 'flexible', languages: ['python', 'typescript'] },
      deliveryPolicy: { allowedSources: ['UPLOAD', 'GIT_REF'] },
      rubricVersion: '1.0',
      submissionContract: 'contracts/submission-contract.schema.json',
      status: 'PUBLISHED',
    };
    return {
      id: problem.id,
      ownerOrgPath: board.orgPath ?? '/',
      origin: 'BOUNTY',
      category: 'HARD_PROBLEM',
      status: 'PUBLISHED',
      board,
      versions: [version],
    };
  }

  private hardProblemSolutionFromSubmission(submission: SubmissionRecord): HardProblemSolution {
    const solver = this.users.get(submission.subjectId);
    const artifactName = submission.snapshot.artifactName
      ?? submission.snapshot.artifactUri?.match(/^local:\/\/[a-f0-9]{64}\/([A-Za-z0-9_.-]+)$/)?.[1];
    return {
      submissionId: submission.id,
      solverId: submission.subjectId,
      solverName: solver?.name ?? submission.subjectId,
      submittedAt: submission.snapshot.submittedAt || submission.createdAt,
      state: submission.state,
      sourceType: submission.snapshot.sourceType,
      ...(artifactName ? { artifactName } : {}),
      ...(submission.snapshot.artifactHash ? { artifactHash: submission.snapshot.artifactHash } : {}),
      ...(submission.snapshot.repository ? { repository: submission.snapshot.repository } : {}),
      ...(submission.snapshot.branch ? { branch: submission.snapshot.branch } : {}),
      ...(submission.snapshot.commitSha ? { commitSha: submission.snapshot.commitSha } : {}),
    };
  }

  private hardProblemFromChallenge(challenge: Challenge, actorId = 'w00123'): HardProblem | undefined {
    const board = challenge.board;
    if (challenge.category !== 'HARD_PROBLEM' || !board || board.type !== 'HARD_PROBLEM') return undefined;
    const version = challenge.versions.slice().sort((a, b) => b.version - a.version)[0];
    const solutionSubmissionId = board.solutionSubmissionId;
    const winningSubmission = solutionSubmissionId ? this.submissions.get(solutionSubmissionId) : undefined;
    const solutionVisibility = this.hardProblemSolutionVisibility(board);
    const canViewSolution = solutionVisibility === 'PUBLIC' || (this.isAdmin(actorId) && this.orgPathInAdminScope(actorId, board.orgPath ?? challenge.ownerOrgPath));
    const solution = winningSubmission && canViewSolution ? this.hardProblemSolutionFromSubmission(winningSubmission) : undefined;
    const resolvedBy = board.resolvedBy;
    const resolvedByName = board.resolvedByName ?? (resolvedBy ? this.users.get(resolvedBy)?.name : undefined);
    const solverId = board.solverId ?? winningSubmission?.subjectId;
    const solverName = board.solverName ?? (solverId ? this.users.get(solverId)?.name : undefined);
    return {
      id: challenge.id,
      challengeId: challenge.id,
      title: version?.title ?? challenge.id,
      summary: board.summary,
      ...(board.details ? { details: board.details } : {}),
      publisherType: board.publisherType,
      publisherId: board.publisherId,
      publisherName: board.publisherName,
      ...(board.departmentName ? { departmentName: board.departmentName } : {}),
      ...(board.orgPath ? { orgPath: board.orgPath } : {}),
      difficulty: board.difficulty,
      tags: [...board.tags],
      status: board.status,
      reviewStatus: this.hardProblemReviewStatus(board),
      solutionVisibility,
      ...(solutionSubmissionId ? { solutionSubmissionId } : {}),
      ...(board.reviewedAt ? { reviewedAt: board.reviewedAt } : {}),
      ...(board.reviewedBy ? { reviewedBy: board.reviewedBy } : {}),
      ...(board.reviewComment ? { reviewComment: board.reviewComment } : {}),
      ...(this.events.has(this.hardProblemEventId(challenge.id)) ? { submissionEventId: this.hardProblemEventId(challenge.id) } : {}),
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      ...(board.resolvedAt ? { resolvedAt: board.resolvedAt } : {}),
      ...(resolvedBy ? { resolvedBy } : {}),
      ...(resolvedByName ? { resolvedByName } : {}),
      ...(solverId ? { solverId } : {}),
      ...(solverName ? { solverName } : {}),
      ...(solution ? { solution } : {}),
    };
  }

  /** Keep one upload submission event behind the independent hard-problem workbench. */
  private syncHardProblemSubmissionEvent(challenge: Challenge): boolean {
    const eventId = this.hardProblemEventId(challenge.id);
    const existing = this.events.get(eventId);
    const board = challenge.board;
    const active = challenge.status === 'PUBLISHED'
      && board?.type === 'HARD_PROBLEM'
      && this.hardProblemReviewStatus(board) === 'APPROVED'
      && board.status === 'OPEN';
    if (!active) {
      if (existing && existing.status === 'OPEN') {
        existing.status = 'CLOSED';
        return true;
      }
      return false;
    }
    let changed = false;
    if (challenge.board && challenge.board.submissionEventId !== eventId) {
      challenge.board.submissionEventId = eventId;
      changed = true;
    }
    const version = challenge.versions.slice().sort((a, b) => b.version - a.version).find((item) => item.status === 'PUBLISHED');
    if (!version) return changed;
    if (existing) {
      if (existing.status !== 'OPEN') { existing.status = 'OPEN'; changed = true; }
      if (existing.challengeVersion !== version.id) { existing.challengeVersion = version.id; changed = true; }
      return changed;
    }
    this.events.set(eventId, {
      id: eventId,
      challengeVersion: version.id,
      purpose: 'HARD_PROBLEM',
      submissionSource: 'UPLOAD',
      trigger: 'MANUAL',
      reveal: 'IMMEDIATE',
      status: 'OPEN',
      mode: 'WINDOW',
      participantMode: 'OPEN',
      accessPolicy: { mode: 'OPEN' },
      deliveryConfig: { allowedFormats: ['zip'], maxBytes: 100 * 1024 * 1024, maxFiles: 3000 },
    });
    return true;
  }

  listHardProblems(status?: HardProblemStatus, reviewStatus?: HardProblemReviewStatus, actorId = 'w00123'): HardProblem[] {
    const admin = this.isAdmin(actorId);
    const adminAccess = admin ? this.getAdminAccess(actorId) : undefined;
    const visibleReviewStatus = admin && reviewStatus ? reviewStatus : 'APPROVED';
    const projected = [...this.challenges.values()]
      .filter((challenge) => challenge.status === 'PUBLISHED')
      .filter((challenge) => !adminAccess || adminAccess.level === 'GLOBAL' || (challenge.board?.orgPath ? adminAccess.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, challenge.board!.orgPath!)) : false))
      .filter((challenge) => this.hardProblemReviewStatus(challenge.board) === visibleReviewStatus)
      .map((challenge) => this.hardProblemFromChallenge(challenge, actorId))
      .filter((problem): problem is HardProblem => Boolean(problem));
    const legacy = [...this.hardProblems.values()]
      .filter((problem) => !this.challenges.has(problem.id))
      .filter((problem) => !adminAccess || adminAccess.level === 'GLOBAL' || Boolean(problem.orgPath && adminAccess.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, problem.orgPath!))))
      .filter((problem) => (problem.reviewStatus ?? 'APPROVED') === visibleReviewStatus);
    return [...projected, ...legacy]
      .filter((problem) => !status || problem.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  }

  getHardProblem(problemId: string, actorId = 'w00123'): HardProblem {
    const admin = this.isAdmin(actorId);
    const adminAccess = admin ? this.getAdminAccess(actorId) : undefined;
    const challenge = this.challenges.get(problemId);
    if (challenge?.status === 'ARCHIVED') throw new NotFoundException(`hard problem not found: ${problemId}`);
    const fromChallenge = challenge ? this.hardProblemFromChallenge(challenge, actorId) : undefined;
    const problem = fromChallenge ?? this.hardProblems.get(problemId);
    if (!problem) throw new NotFoundException(`hard problem not found: ${problemId}`);
    if (adminAccess && adminAccess.level !== 'GLOBAL' && (!problem.orgPath || !adminAccess.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, problem.orgPath!)))) {
      throw new ForbiddenException('hard problem is outside the administrator organization scope');
    }
    if (!admin && (problem.reviewStatus ?? 'APPROVED') !== 'APPROVED') throw new NotFoundException(`hard problem not found: ${problemId}`);
    return problem;
  }

  createHardProblem(input: Omit<HardProblem, 'id' | 'challengeId' | 'createdAt' | 'updatedAt' | 'status' | 'reviewStatus' | 'resolvedAt' | 'resolvedBy' | 'resolvedByName' | 'solutionSubmissionId' | 'solution'> & {
    id?: string;
    status?: HardProblemStatus;
  }, actorId = 'admin-local'): HardProblem {
    const id = input.id ?? `problem-${randomUUID()}`;
    if (this.challenges.has(id) || this.hardProblems.has(id)) throw new ConflictException(`hard problem already exists: ${id}`);
    if (!input.title?.trim() || !input.summary?.trim()) throw new BadRequestException('hard problem title and summary are required');
    if (!['DEPARTMENT', 'EMPLOYEE'].includes(input.publisherType)) throw new BadRequestException('hard problem publisherType is invalid');
    if (!['HIGH', 'MEDIUM', 'LOW'].includes(input.difficulty)) throw new BadRequestException('hard problem difficulty is invalid');
    if (input.solutionVisibility !== undefined && !isHardProblemSolutionVisibility(input.solutionVisibility)) throw new BadRequestException('hard problem solutionVisibility must be PUBLIC or HIDDEN');
    if (input.status && !['OPEN', 'RESOLVED'].includes(input.status)) throw new BadRequestException('hard problem status is invalid');
    if (!Array.isArray(input.tags)) throw new BadRequestException('hard problem tags must be an array');
    const actor = this.getUser(actorId);
    const adminAccess = this.isAdmin(actorId) ? this.getAdminAccess(actorId) : undefined;
    if (!this.isAdmin(actorId) && (input.publisherType !== 'EMPLOYEE' || input.publisherId !== actorId)) {
      throw new ForbiddenException('only the publishing employee or an administrator can publish a hard problem');
    }
    const publisher = input.publisherType === 'EMPLOYEE' ? this.getUser(input.publisherId) : undefined;
    const department = input.publisherType === 'DEPARTMENT' ? this.getOrgUnit(input.publisherId) : undefined;
    if (adminAccess?.level === 'DEPARTMENT') {
      this.assertAdminOrgScope(actorId, publisher?.orgPath ?? department?.path ?? actor.orgPath, false);
    }
    const orgPath = this.normalizeOrgPath(input.orgPath?.trim() || publisher?.orgPath || department?.path || actor.orgPath);
    if (adminAccess) this.assertAdminOrgScope(actorId, orgPath);
    const timestamp = now();
    const reviewStatus: HardProblemReviewStatus = adminAccess?.level === 'GLOBAL' ? 'APPROVED' : 'PENDING_REVIEW';
    const problem: HardProblem = {
      id,
      challengeId: id,
      title: input.title.trim(),
      summary: input.summary.trim(),
      ...(input.details?.trim() ? { details: input.details.trim() } : {}),
      publisherType: input.publisherType,
      publisherId: input.publisherId,
      publisherName: input.publisherName?.trim() || publisher?.name || department?.name || input.publisherId,
      departmentName: input.departmentName?.trim() || (publisher ? this.getOrgUnit(publisher.orgUnitId).name : department?.name),
      orgPath,
      difficulty: input.difficulty,
      tags: input.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8),
      status: input.status ?? 'OPEN',
      reviewStatus,
      solutionVisibility: isHardProblemSolutionVisibility(input.solutionVisibility) ? input.solutionVisibility : 'PUBLIC',
      ...(reviewStatus === 'APPROVED' ? { reviewedAt: timestamp, reviewedBy: actorId } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const challenge = this.challengeFromHardProblem(problem);
    this.challenges.set(id, challenge);
    this.syncHardProblemSubmissionEvent(challenge);
    this.audit(actorId, 'challenge.create', `challenge:${id}`, undefined, challenge);
    this.persist();
    return this.hardProblemFromChallenge(challenge)!;
  }

  reviewHardProblem(problemId: string, decision: 'APPROVE' | 'REJECT', comment = '', actorId = 'admin-local'): HardProblem {
    const adminAccess = this.resolveAdminAccess(actorId, true);
    const challenge = this.challenges.get(problemId);
    if (!challenge?.board || challenge.board.type !== 'HARD_PROBLEM') throw new NotFoundException(`hard problem not found: ${problemId}`);
    if (adminAccess.level !== 'GLOBAL') this.assertAdminOrgScope(actorId, challenge.board.orgPath ?? challenge.ownerOrgPath);
    const current = this.hardProblemFromChallenge(challenge, actorId);
    if (!current) throw new NotFoundException(`hard problem not found: ${problemId}`);
    const reviewStatus: HardProblemReviewStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const reviewedAt = now();
    const before = { reviewStatus: this.hardProblemReviewStatus(challenge.board), reviewComment: challenge.board.reviewComment };
    challenge.board = {
      ...challenge.board,
      reviewStatus,
      reviewedAt,
      reviewedBy: actorId,
      ...(comment.trim() ? { reviewComment: comment.trim() } : { reviewComment: undefined }),
      updatedAt: reviewedAt,
    };
    this.syncHardProblemSubmissionEvent(challenge);
    const after = this.hardProblemFromChallenge(challenge)!;
    this.audit(actorId, 'hard-problem.review', `challenge:${problemId}`, before, { reviewStatus, reviewComment: after.reviewComment });
    this.persist();
    return after;
  }

  resolveHardProblem(problemId: string, actorId = 'admin-local', solutionSubmissionId?: string): HardProblem {
    const problem = this.getHardProblem(problemId, actorId);
    if (!this.isAdmin(actorId)) {
      if (problem.publisherType !== 'EMPLOYEE' || problem.publisherId !== actorId) {
        throw new ForbiddenException('only the publishing employee or an administrator can resolve this hard problem');
      }
    }
    if ((problem.reviewStatus ?? 'APPROVED') !== 'APPROVED') throw new ConflictException('hard problem must be approved before it can be resolved');
    if (problem.status === 'RESOLVED') throw new ConflictException('hard problem is already resolved');
    const before = { ...problem };
    const challenge = this.challenges.get(problemId);
    if (challenge?.board?.type === 'HARD_PROBLEM') {
      const updatedAt = now();
      const eventId = challenge.board.submissionEventId ?? this.hardProblemEventId(problemId);
      let winningSubmission: SubmissionRecord | undefined;
      if (solutionSubmissionId) {
        winningSubmission = this.getSubmission(solutionSubmissionId);
        if (winningSubmission.eventId !== eventId) throw new BadRequestException('solution submission does not belong to this hard problem');
      } else {
        winningSubmission = [...this.submissions.values()]
          .filter((submission) => submission.eventId === eventId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      }
      const winnerId = winningSubmission?.subjectId;
      const winner = winnerId ? this.users.get(winnerId) : undefined;
      const resolver = this.users.get(actorId);
      challenge.board = {
        ...challenge.board,
        status: 'RESOLVED',
        updatedAt,
        resolvedAt: updatedAt,
        resolvedBy: actorId,
        ...(resolver?.name ? { resolvedByName: resolver.name } : {}),
        ...(winnerId ? { solverId: winnerId } : { solverId: undefined }),
        ...(winner?.name ? { solverName: winner.name } : { solverName: undefined }),
        ...(winningSubmission ? { solutionSubmissionId: winningSubmission.id } : { solutionSubmissionId: undefined }),
      };
      this.syncHardProblemSubmissionEvent(challenge);
    } else {
      // Keep a safe fallback for a data file that was created before the
      // challenge-library migration completed.
      const legacy = this.hardProblems.get(problemId);
      if (legacy) {
        legacy.status = 'RESOLVED';
        legacy.updatedAt = now();
        legacy.resolvedAt = legacy.updatedAt;
        legacy.resolvedBy = actorId;
      }
    }
    const after = this.getHardProblem(problemId, actorId);
    this.audit(actorId, 'hard-problem.resolve', `challenge:${problemId}`, before, after);
    this.persist();
    return after;
  }

  createAnnouncement(input: Omit<Announcement, 'id'> & { id?: string }, actorId = 'admin-local'): Announcement {
    const access = this.resolveAdminAccess(actorId, true);
    const id = input.id ?? `announcement-${randomUUID()}`;
    if (this.announcements.has(id)) throw new ConflictException(`announcement already exists: ${id}`);
    if (!input.title?.trim() || !input.summary?.trim()) throw new BadRequestException('announcement title and summary are required');
    if (!['平台通知', '训战提醒', '规则更新'].includes(input.tag)) throw new BadRequestException('announcement tag is invalid');
    if (!Number.isFinite(Date.parse(input.publishedAt))) throw new BadRequestException('announcement publishedAt must be an ISO date-time');
    const requestedOrgPath = input.orgPath ? this.normalizeOrgPath(input.orgPath) : undefined;
    if (requestedOrgPath && access.level !== 'GLOBAL') this.assertAdminOrgScope(actorId, requestedOrgPath);
    const announcement: Announcement = {
      ...input,
      id,
      title: input.title.trim(),
      summary: input.summary.trim(),
      ...(access.level === 'DEPARTMENT' ? { orgPath: requestedOrgPath ?? access.scopeOrgPaths[0] } : requestedOrgPath ? { orgPath: requestedOrgPath } : {}),
    };
    this.announcements.set(id, announcement);
    this.audit(actorId, 'announcement.create', `announcement:${id}`, undefined, announcement);
    this.persist();
    return announcement;
  }

  updateAnnouncement(id: string, patch: Partial<Omit<Announcement, 'id'>>, actorId = 'admin-local'): Announcement {
    const access = this.resolveAdminAccess(actorId, true);
    const announcement = this.announcements.get(id);
    if (!announcement) throw new NotFoundException(`announcement not found: ${id}`);
    if (announcement.orgPath && access.level !== 'GLOBAL') this.assertAdminOrgScope(actorId, announcement.orgPath);
    const before = { ...announcement };
    if (patch.title !== undefined && !patch.title.trim()) throw new BadRequestException('announcement title is required');
    if (patch.summary !== undefined && !patch.summary.trim()) throw new BadRequestException('announcement summary is required');
    if (patch.tag !== undefined && !['平台通知', '训战提醒', '规则更新'].includes(patch.tag)) throw new BadRequestException('announcement tag is invalid');
    if (patch.publishedAt !== undefined && !Number.isFinite(Date.parse(patch.publishedAt))) throw new BadRequestException('announcement publishedAt must be an ISO date-time');
    const nextOrgPath = patch.orgPath === undefined ? announcement.orgPath : patch.orgPath ? this.normalizeOrgPath(patch.orgPath) : undefined;
    if (nextOrgPath && access.level !== 'GLOBAL') this.assertAdminOrgScope(actorId, nextOrgPath);
    Object.assign(announcement, { ...patch, ...(nextOrgPath ? { orgPath: nextOrgPath } : { orgPath: undefined }) });
    this.audit(actorId, 'announcement.update', `announcement:${id}`, before, announcement);
    this.persist();
    return announcement;
  }

  deleteAnnouncement(id: string, actorId = 'admin-local'): void {
    const access = this.resolveAdminAccess(actorId, true);
    const announcement = this.announcements.get(id);
    if (!announcement) throw new NotFoundException(`announcement not found: ${id}`);
    if (announcement.orgPath && access.level !== 'GLOBAL') this.assertAdminOrgScope(actorId, announcement.orgPath);
    this.announcements.delete(id);
    this.audit(actorId, 'announcement.delete', `announcement:${id}`, announcement, undefined);
    this.persist();
  }

  adminOverview(actorId = 'w00123'): Record<string, unknown> {
    const access = this.resolveAdminAccess(actorId, true);
    const challenges = [...this.challenges.values()].filter((challenge) => access.level === 'GLOBAL' || (challenge.ownerOrgPath !== '/' && access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, challenge.ownerOrgPath))));
    const events = [...this.events.values()].filter((event) => access.level === 'GLOBAL' || this.eventInAdminScope(event, actorId, true));
    const eventIds = new Set(events.map((event) => event.id));
    const submissions = [...this.submissions.values()].filter((submission) => {
      if (!eventIds.has(submission.eventId)) return false;
      if (access.level === 'GLOBAL') return true;
      const subject = this.users.get(submission.subjectId);
      return Boolean(subject && access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, subject.orgPath)));
    });
    const submissionIds = new Set(submissions.map((submission) => submission.id));
    const runs = [...this.runs.values()].filter((run) => submissionIds.has(run.submissionId));
    const byState = submissions.reduce<Record<string, number>>((counts, submission) => {
      counts[submission.state] = (counts[submission.state] ?? 0) + 1;
      return counts;
    }, {});
    const eventStats = events.map((event) => ({
      eventId: event.id,
      challengeVersion: event.challengeVersion,
      status: event.status,
      submissionCount: submissions.filter((submission) => submission.eventId === event.id).length,
      pendingCount: submissions.filter((submission) => submission.eventId === event.id && ['WAITING_TRIGGER', 'WAITING_IMPORT', 'RECEIVED'].includes(submission.state)).length,
    }));
    const runningRuns = runs.filter((run) => run.status === 'QUEUED' || run.status === 'RUNNING').length;
    return {
      generatedAt: now(),
      challenges: {
        total: challenges.length,
        published: challenges.filter((challenge) => challenge.status === 'PUBLISHED').length,
        drafts: challenges.filter((challenge) => challenge.status === 'DRAFT').length,
        archived: challenges.filter((challenge) => challenge.status === 'ARCHIVED').length,
        versions: challenges.reduce((count, challenge) => count + challenge.versions.length, 0),
      },
      events: {
        total: events.length,
        open: events.filter((event) => event.status === 'OPEN').length,
        closed: events.filter((event) => event.status === 'CLOSED').length,
        released: events.filter((event) => event.status === 'RELEASED').length,
      },
      submissions: { total: submissions.length, byState, graded: submissions.filter((submission) => Boolean(submission.resultId)).length },
      grading: { totalRuns: runs.length, queuedOrRunning: runningRuns, failed: runs.filter((run) => run.status === 'FAILED').length },
      announcements: this.listAnnouncements(actorId).length,
      activeSeason: [...this.seasons.values()].find((season) => season.status === 'RUNNING') ?? null,
      eventStats,
      recentAudits: this.listAudits(undefined, actorId).slice(0, 8),
    };
  }

  listOrgUnits(parentId?: string, actorId = 'w00123'): OrgUnit[] {
    const adminAccess = this.isAdmin(actorId) ? this.getAdminAccess(actorId) : undefined;
    const actor = this.users.get(actorId);
    const scopes = adminAccess?.level === 'GLOBAL' ? undefined : adminAccess?.scopeOrgPaths ?? (actor ? [actor.orgPath] : undefined);
    return [...this.orgUnits.values()].filter((unit) => {
      const inScope = !scopes || scopes.some((scope) => this.orgPathIncludes(scope, unit.path) || this.orgPathIncludes(unit.path, scope));
      return inScope && (parentId === undefined || unit.parentId === parentId);
    });
  }

  createOrgUnit(input: { id: string; parentId?: string; label?: string; name: string }, actorId: string): OrgUnit {
    const access = this.resolveAdminAccess(actorId, true);
    const id = input.id.trim();
    const name = input.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(id)) throw new BadRequestException('org unit id is invalid');
    if (!name) throw new BadRequestException('org unit name is required');
    if (this.orgUnits.has(id)) throw new ConflictException(`org unit already exists: ${id}`);
    const parent = input.parentId ? this.getOrgUnit(input.parentId) : undefined;
    if (parent && access.level !== 'GLOBAL') this.assertAdminOrgScope(actorId, parent.path);
    if (!parent && access.level !== 'GLOBAL') throw new ForbiddenException('department administrators must create units below their organization scope');
    const path = parent ? `${parent.path === '/' ? '/' : parent.path}${id}/`.replace('//', '/') : `/${id}/`;
    if (access.level !== 'GLOBAL' && !access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, path))) {
      throw new ForbiddenException('organization scope does not allow this operation');
    }
    const unit: OrgUnit = { id, ...(parent ? { parentId: parent.id } : {}), path, level: parent ? parent.level + 1 : 0, label: input.label?.trim() || '组织', name };
    this.orgUnits.set(id, unit);
    this.audit(actorId, 'org-unit.create', `org-unit:${id}`, undefined, unit);
    this.persist();
    return unit;
  }

  updateOrgUnit(orgUnitId: string, patch: { label?: string; name?: string }, actorId: string): OrgUnit {
    const unit = this.getOrgUnit(orgUnitId);
    this.assertAdminOrgScope(actorId, unit.path);
    const before = { ...unit };
    if (patch.name !== undefined && !patch.name.trim()) throw new BadRequestException('org unit name is required');
    if (patch.label !== undefined && !patch.label.trim()) throw new BadRequestException('org unit label is required');
    const nextName = patch.name?.trim();
    if (nextName && [...this.orgUnits.values()].some((candidate) => candidate.id !== unit.id && candidate.parentId === unit.parentId && candidate.name === nextName)) {
      throw new ConflictException('同一上级部门下已存在同名部门');
    }
    Object.assign(unit, { ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.label !== undefined ? { label: patch.label.trim() } : {}) });
    this.audit(actorId, 'org-unit.update', `org-unit:${orgUnitId}`, before, unit);
    this.persist();
    return unit;
  }

  deleteOrgUnit(orgUnitId: string, actorId: string): void {
    const unit = this.getOrgUnit(orgUnitId);
    const access = this.assertAdminOrgScope(actorId, unit.path);
    if (unit.level === 0 || unit.path === '/') throw new BadRequestException('根组织不可删除');
    if (access.level === 'DEPARTMENT' && access.scopeOrgPaths.some((scope) => this.normalizeOrgPath(scope) === unit.path)) {
      throw new ForbiddenException('部门管理员不能删除其管理范围的根部门');
    }
    if ([...this.orgUnits.values()].some((candidate) => candidate.parentId === unit.id)) {
      throw new ConflictException('该部门仍有下级部门，请先调整组织结构');
    }
    if ([...this.users.values()].some((user) => user.orgUnitId === unit.id)) {
      throw new ConflictException('该部门仍有员工，请先调整员工所属部门');
    }
    if ([...this.users.values()].some((user) => user.roleBindings?.some((binding) => this.normalizeOrgPath(binding.scopeOrgPath) === unit.path))) {
      throw new ConflictException('该部门仍绑定管理员权限，请先调整权限范围');
    }
    if ([...this.events.values()].some((event) => event.accessPolicy?.departmentIds?.includes(unit.id))) {
      throw new ConflictException('该部门仍用于训战面向对象，请先调整训战范围');
    }
    if ([...this.challenges.values()].some((challenge) => challenge.ownerOrgPath === unit.path || challenge.board?.orgPath === unit.path)
      || [...this.hardProblems.values()].some((problem) => problem.orgPath === unit.path)
      || [...this.announcements.values()].some((announcement) => announcement.orgPath === unit.path)) {
      throw new ConflictException('该部门仍有关联业务数据，暂不能删除');
    }
    this.orgUnits.delete(unit.id);
    this.audit(actorId, 'org-unit.delete', `org-unit:${orgUnitId}`, unit, undefined);
    this.persist();
  }

  getOrgUnit(orgUnitId: string): OrgUnit {
    const unit = this.orgUnits.get(orgUnitId);
    if (!unit) throw new NotFoundException(`org unit not found: ${orgUnitId}`);
    return unit;
  }

  /**
   * Legacy in-process callers still need an unpaged projection while they are
   * migrated one vertical slice at a time.  HTTP callers use listUsersPage.
   */
  listUsers(orgPath?: string, actorId = 'w00123'): AppUser[] {
    const prefix = orgPath && this.normalizeOrgPath(orgPath);
    const actor = this.getUser(actorId);
    const adminAccess = this.isAdmin(actorId) ? this.getAdminAccess(actorId) : undefined;
    const scopes = adminAccess?.level === 'GLOBAL' ? undefined : adminAccess?.scopeOrgPaths ?? [actor.orgPath];
    return [...this.users.values()].filter((user) => {
      const inScope = !scopes || scopes.some((scope) => this.orgPathIncludes(scope, user.orgPath));
      const inRequestedPath = !prefix || this.orgPathIncludes(prefix, user.orgPath);
      return inScope && inRequestedPath;
    });
  }

  /**
   * Query users with deterministic, server-side pagination.  This is the file
   * adapter implementation of the v0.7 OrganizationRepository port; the
  * authorization and ordering rules intentionally live here rather than in
  * the React client so every adapter can share the same observable contract.
  */
  listUsersPage(query: UserListQuery = {}, actorId = 'w00123'): UserPage {
    // Keep the same synthetic admin ids accepted by the existing in-process
    // store tests; the HTTP controller still calls requireAdmin first and
    // therefore never permits these ids in a real request.
    const access = this.resolveAdminAccess(actorId, true);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('page must be a positive integer');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException('pageSize must be an integer between 1 and 100');
    }

    const requestedPath = query.orgPath?.trim() ? this.normalizeOrgPath(query.orgPath) : undefined;
    // A department administrator must receive an explicit 403 when asking for
    // a path outside its scope.  Returning an empty page would leak whether a
    // protected organization exists and would make client-side mistakes hard
    // to distinguish from a legitimate empty result.
    if (requestedPath && access.level !== 'GLOBAL') this.assertAdminOrgScope(actorId, requestedPath);

    const normalizedQuery = query.query?.trim().toLocaleLowerCase('zh-CN') ?? '';
    const requestedRoles = [...new Set((query.roles ?? []).map((role) => role.trim()).filter(Boolean))];
    const scopes = access.level === 'GLOBAL' ? undefined : access.scopeOrgPaths;
    const sortBy = query.sortBy ?? 'employeeNo';
    const sortOrder = query.sortOrder ?? 'asc';
    const compareText = (left: string, right: string): number => left.localeCompare(right, 'zh-CN', { sensitivity: 'base', numeric: true });

    const filtered = [...this.users.values()]
      .filter((user) => {
        if (scopes && !scopes.some((scope) => this.orgPathIncludes(scope, user.orgPath))) return false;
        if (requestedPath && !this.orgPathIncludes(requestedPath, user.orgPath)) return false;
        if (normalizedQuery && ![user.employeeNo, user.name].some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery))) return false;
        if (requestedRoles.length && !requestedRoles.some((role) => user.roles.includes(role))) return false;
        if (query.status && user.status !== query.status) return false;
        return true;
      })
      .sort((left, right) => {
        const leftValue = String(left[sortBy]);
        const rightValue = String(right[sortBy]);
        const primary = compareText(leftValue, rightValue) * (sortOrder === 'desc' ? -1 : 1);
        return primary || compareText(left.id, right.id);
      });

    const total = filtered.length;
    const totalPages = total ? Math.ceil(total / pageSize) : 0;
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      pageInfo: {
        page,
        pageSize,
        total,
        totalPages,
        hasNext: totalPages > 0 && page < totalPages,
        hasPrevious: totalPages > 0 && page > 1,
      },
    };
  }

  getUser(userId: string): AppUser {
    const user = this.users.get(userId);
    if (!user) throw new NotFoundException(`user not found: ${userId}`);
    return user;
  }

  private matchSsoDepartment(department?: string): OrgUnit | undefined {
    const value = department?.trim().toLocaleLowerCase();
    if (!value) return undefined;
    return [...this.orgUnits.values()].find((unit) => unit.level > 0 && [unit.id, unit.path, unit.name]
      .some((candidate) => candidate.trim().toLocaleLowerCase() === value));
  }

  /** Provision or refresh the local employee record from trusted SSO claims. */
  syncSsoIdentity(identity: SsoIdentity): { user: AppUser; firstLogin: boolean; departmentMatched: boolean } {
    const employeeNo = typeof identity?.employeeNo === 'string' ? identity.employeeNo.trim() : '';
    const name = typeof identity?.name === 'string' ? identity.name.trim() : '';
    const department = typeof identity?.department === 'string' ? identity.department.trim() || undefined : undefined;
    if (!employeeNo) throw new BadRequestException('SSO 工号不能为空');
    if (!name) throw new BadRequestException('SSO 姓名不能为空');
    const matchedUnit = this.matchSsoDepartment(department);
    const existing = [...this.users.values()].find((item) => item.id === employeeNo || item.employeeNo === employeeNo);
    if (existing?.status === 'DISABLED') throw new ForbiddenException('账号已停用');
    const configuredBootstrapAdmin = process.env.PLATFORM_BOOTSTRAP_GLOBAL_ADMIN_EMPLOYEE_NO?.trim();
    const bootstrapGlobalAdmin = configuredBootstrapAdmin === employeeNo && ![...this.users.values()].some(hasGlobalAdminAccess);
    if (!existing) {
      const user: AppUser = {
        id: employeeNo,
        employeeNo,
        name,
        orgUnitId: matchedUnit?.id ?? '',
        orgPath: matchedUnit?.path ?? '',
        ...(department && !matchedUnit ? { departmentHint: department } : {}),
        ...(matchedUnit ? { departmentSource: 'SSO' as const } : {}),
        roles: bootstrapGlobalAdmin ? ['global_admin'] : ['learner'],
        ...(bootstrapGlobalAdmin ? { roleBindings: [{ role: 'global_admin', scopeOrgPath: '/' }] } : {}),
        status: 'ACTIVE',
      };
      this.users.set(user.id, user);
      this.audit(employeeNo, 'sso.user-provision', `user:${user.id}`, undefined, { firstLogin: true, departmentMatched: Boolean(matchedUnit) });
      this.persist();
      return { user, firstLogin: true, departmentMatched: Boolean(matchedUnit) };
    }
    const before = { ...existing };
    existing.employeeNo = employeeNo;
    existing.name = name;
    // An administrator's manual department assignment wins over a later SSO
    // hint. SSO can still fill an empty department or refresh an SSO mapping.
    if (existing.departmentSource !== 'ADMIN' && matchedUnit) {
      existing.orgUnitId = matchedUnit.id;
      existing.orgPath = matchedUnit.path;
      existing.departmentSource = 'SSO';
      existing.departmentHint = undefined;
    } else if (!existing.orgUnitId || !existing.orgPath) {
      existing.orgUnitId = matchedUnit?.id ?? '';
      existing.orgPath = matchedUnit?.path ?? '';
      existing.departmentSource = matchedUnit ? 'SSO' : undefined;
      existing.departmentHint = matchedUnit ? undefined : department;
    } else if (department) {
      existing.departmentHint = department;
    }
    if (bootstrapGlobalAdmin) {
      existing.roles = ['global_admin'];
      existing.roleBindings = [{ role: 'global_admin', scopeOrgPath: '/' }];
    }
    if (JSON.stringify(before) !== JSON.stringify(existing)) {
      this.audit(employeeNo, 'sso.user-sync', `user:${existing.id}`, before, existing);
      this.persist();
    }
    return { user: existing, firstLogin: false, departmentMatched: Boolean(matchedUnit) };
  }

  updateUser(userId: string, patch: { orgUnitId?: string; roles?: string[]; roleBindings?: Array<{ role: string; scopeOrgPath: string }> }, actorId: string): AppUser {
    const user = this.getUser(userId);
    const access = this.resolveAdminAccess(actorId, true);
    const targetIsAdministrator = user.roles.some((role) => ['admin', 'global_admin', 'department_admin'].includes(role))
      || Boolean(user.roleBindings?.some((binding) => ['admin', 'global_admin', 'department_admin'].includes(binding.role)));
    if (access.level !== 'GLOBAL' && targetIsAdministrator) throw new ForbiddenException('管理员账号需由全局管理员配置');
    if (!user.orgPath && access.level !== 'GLOBAL') throw new ForbiddenException('未归属部门的员工需由全局管理员配置部门');
    if (user.orgPath) this.assertAdminOrgScope(actorId, user.orgPath, false);
    const before = { ...user };
    const departmentPatchProvided = patch.orgUnitId !== undefined;
    const targetUnit = departmentPatchProvided
      ? (patch.orgUnitId?.trim() ? this.getOrgUnit(patch.orgUnitId) : undefined)
      : user.orgUnitId ? this.getOrgUnit(user.orgUnitId) : undefined;
    if (departmentPatchProvided && !targetUnit && access.level !== 'GLOBAL') throw new ForbiddenException('部门管理员只能将员工调整到其管理范围内的部门');
    if (targetUnit?.id === 'org-root') throw new BadRequestException('员工必须归属具体部门');
    if (targetUnit) this.assertAdminOrgScope(actorId, targetUnit.path);
    const nextRoles = patch.roles === undefined ? user.roles : [...new Set(patch.roles.map((role) => role.trim()).filter(Boolean))];
    const validRoles = new Set(['learner', 'mentor', 'admin', 'global_admin', 'department_admin']);
    if (!nextRoles.length) throw new BadRequestException('至少需要保留一个角色');
    if (nextRoles.some((role) => !validRoles.has(role))) throw new BadRequestException('角色配置不受支持');
    const nextBindings = patch.roleBindings === undefined
      ? (user.roleBindings ?? []).filter((binding) => nextRoles.includes(binding.role) || (binding.role === 'admin' && nextRoles.includes('admin')))
      : patch.roleBindings.map((binding) => ({ role: binding.role.trim(), scopeOrgPath: this.normalizeOrgPath(binding.scopeOrgPath) }));
    if (nextBindings.some((binding) => !validRoles.has(binding.role))) throw new BadRequestException('角色范围配置不受支持');
    if (access.level !== 'GLOBAL' && (nextRoles.some((role) => ['admin', 'global_admin', 'department_admin'].includes(role)) || nextBindings.some((binding) => ['admin', 'global_admin', 'department_admin'].includes(binding.role)))) {
      throw new ForbiddenException('只有全局管理员可以分配管理员权限');
    }
    for (const binding of nextBindings) this.assertAdminOrgScope(actorId, binding.scopeOrgPath);
    if (nextRoles.includes('department_admin') && !targetUnit?.path) throw new BadRequestException('部门管理员必须先配置所属部门');
    if (!nextRoles.includes('department_admin')) {
      for (let index = nextBindings.length - 1; index >= 0; index -= 1) {
        if (nextBindings[index].role === 'department_admin') nextBindings.splice(index, 1);
      }
    } else if (patch.roleBindings === undefined) {
      for (let index = nextBindings.length - 1; index >= 0; index -= 1) {
        if (nextBindings[index].role === 'department_admin') nextBindings.splice(index, 1);
      }
    }
    if (nextRoles.includes('global_admin') && !nextBindings.some((binding) => binding.role === 'global_admin' && binding.scopeOrgPath === '/')) {
      nextBindings.push({ role: 'global_admin', scopeOrgPath: '/' });
    }
    if (nextRoles.includes('department_admin') && targetUnit && !nextBindings.some((binding) => binding.role === 'department_admin' && binding.scopeOrgPath === targetUnit.path)) {
      nextBindings.push({ role: 'department_admin', scopeOrgPath: targetUnit.path });
    }
    const nextUser: AppUser = {
      ...user,
      roles: nextRoles,
      ...(nextBindings.length ? { roleBindings: nextBindings } : { roleBindings: undefined }),
    };
    if (user.id === actorId && access.level === 'GLOBAL' && !hasGlobalAdminAccess(nextUser)) {
      throw new ForbiddenException('全局管理员不能移除自己的全局管理员权限');
    }
    Object.assign(user, {
      ...(departmentPatchProvided ? {
        orgUnitId: targetUnit?.id ?? '',
        orgPath: targetUnit?.path ?? '',
        ...(targetUnit ? { departmentSource: 'ADMIN' as const } : { departmentSource: undefined }),
        departmentHint: undefined,
      } : targetUnit ? { orgUnitId: targetUnit.id, orgPath: targetUnit.path, departmentSource: 'ADMIN' as const, departmentHint: undefined } : {}),
      roles: nextRoles,
      ...(nextBindings.length ? { roleBindings: nextBindings } : { roleBindings: undefined }),
    });
    this.audit(actorId, 'user.roles.update', `user:${userId}`, before, user);
    this.persist();
    return user;
  }

  /** Update only employee-managed profile fields; identity and permissions stay server-owned. */
  updateUserProfile(userId: string, patch: { nickname?: string | null; avatarDataUrl?: string | null }, actorId: string): AppUser {
    const user = this.getUser(userId);
    if (user.id !== actorId) throw new ForbiddenException('只能修改自己的个人资料');
    if (user.status !== 'ACTIVE') throw new ForbiddenException('account is disabled');
    const before = { ...user, ...(user.avatarDataUrl ? { avatarDataUrl: `[头像 ${user.avatarDataUrl.length} 字符]` } : {}) };
    if (patch.nickname !== undefined) user.nickname = patch.nickname?.trim() || undefined;
    if (patch.avatarDataUrl !== undefined) user.avatarDataUrl = patch.avatarDataUrl || undefined;
    const after = { ...user, ...(user.avatarDataUrl ? { avatarDataUrl: `[头像 ${user.avatarDataUrl.length} 字符]` } : {}) };
    this.audit(actorId, 'user.profile.update', `user:${userId}`, before, after);
    this.persist();
    return user;
  }

  /** Resolve the administrator tier and the organization paths it can manage. */
  getAdminAccess(userId: string): AdminAccess {
    return this.resolveAdminAccess(userId);
  }

  private resolveAdminAccess(userId: string, allowLegacyTestActor = false): AdminAccess {
    const user = this.users.get(userId);
    if (!user || user.status !== 'ACTIVE') {
      // Store-level tests and local service jobs historically used synthetic
      // administrator ids. HTTP callers must pass a real identity because
      // controllers call assertAdmin before reaching these methods.
      if (allowLegacyTestActor && /^(admin-|admin_local$)/i.test(userId)) return { level: 'GLOBAL', scopeOrgPaths: ['/'] };
      throw new ForbiddenException('administrator role is required');
    }
    const bindings = user.roleBindings ?? [];
    const globalBinding = bindings.some((binding) => ['global_admin', 'admin'].includes(binding.role) && this.normalizeOrgPath(binding.scopeOrgPath) === '/');
    const scopedLegacyBindings = bindings.filter((binding) => binding.role === 'admin' && this.normalizeOrgPath(binding.scopeOrgPath) !== '/');
    if (user.roles.includes('global_admin') || globalBinding || (user.roles.includes('admin') && scopedLegacyBindings.length === 0)) {
      return { level: 'GLOBAL', scopeOrgPaths: ['/'] };
    }
    const scopeOrgPaths = [
      ...bindings.filter((binding) => ['department_admin', 'admin'].includes(binding.role)).map((binding) => this.normalizeOrgPath(binding.scopeOrgPath)),
      ...(user.roles.includes('department_admin') && user.orgPath ? [this.normalizeOrgPath(user.orgPath)] : []),
    ].filter((path, index, all) => all.indexOf(path) === index);
    if (scopeOrgPaths.includes('/')) return { level: 'GLOBAL', scopeOrgPaths: ['/'] };
    if (scopeOrgPaths.length) return { level: 'DEPARTMENT', scopeOrgPaths };
    throw new ForbiddenException('administrator role is required');
  }

  isAdmin(userId: string): boolean {
    try {
      this.resolveAdminAccess(userId);
      return true;
    } catch {
      return false;
    }
  }

  isGlobalAdmin(userId: string): boolean {
    try {
      return this.resolveAdminAccess(userId).level === 'GLOBAL';
    } catch {
      return false;
    }
  }

  assertAdmin(userId: string): void {
    this.resolveAdminAccess(userId);
  }

  assertGlobalAdmin(userId: string): void {
    if (this.resolveAdminAccess(userId).level !== 'GLOBAL') throw new ForbiddenException('global administrator role is required');
  }

  getCodeAgentRuntimeConfig(actorId: string): CodeAgentRuntimeConfig {
    this.assertGlobalAdmin(actorId);
    return { ...this.codeAgentRuntimeConfig, args: [...this.codeAgentRuntimeConfig.args] };
  }

  getCodeAgentRuntimeDiagnostics(actorId: string): CodeAgentRuntimeDiagnostics {
    this.assertGlobalAdmin(actorId);
    return codeAgentRuntimeDiagnostics(this.getCodeAgentRuntimeConfig(actorId));
  }

  updateCodeAgentRuntimeConfig(input: CodeAgentRuntimeInput, actorId: string): CodeAgentRuntimeConfig {
    this.assertGlobalAdmin(actorId);
    const before = this.getCodeAgentRuntimeConfig(actorId);
    const next = buildCodeAgentRuntimeConfig(input, actorId);
    this.codeAgentRuntimeConfig = next;
    this.audit(actorId, 'code-agent-runtime.update', 'system:code-agent-runtime', before, next);
    this.persist();
    return { ...next, args: [...next.args] };
  }

  private normalizeOrgPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed === '/') return '/';
    return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
  }

  private orgPathIncludes(scope: string, target: string): boolean {
    if (!scope?.trim() || !target?.trim()) return false;
    const normalizedScope = this.normalizeOrgPath(scope);
    const normalizedTarget = this.normalizeOrgPath(target);
    return normalizedScope === '/' || normalizedTarget === normalizedScope || normalizedTarget.startsWith(normalizedScope);
  }

  private assertAdminOrgScope(actorId: string, targetOrgPath: string, allowLegacyTestActor = true): AdminAccess {
    const access = this.resolveAdminAccess(actorId, allowLegacyTestActor);
    if (access.level === 'GLOBAL' || access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, targetOrgPath))) return access;
    throw new ForbiddenException('organization scope does not allow this operation');
  }

  private orgPathInAdminScope(actorId: string, targetOrgPath: string): boolean {
    try {
      const access = this.resolveAdminAccess(actorId);
      return access.level === 'GLOBAL' || access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, targetOrgPath));
    } catch {
      return false;
    }
  }

  private challengeForVersion(challengeVersionId: string): Challenge {
    for (const challenge of this.challenges.values()) {
      if (challenge.versions.some((version) => version.id === challengeVersionId)) return challenge;
    }
    throw new BadRequestException(`challenge version not found: ${challengeVersionId}`);
  }

  private assertAdminChallengeScope(challenge: Challenge, actorId: string, allowLegacyTestActor = true): AdminAccess {
    return this.assertAdminOrgScope(actorId, challenge.ownerOrgPath, allowLegacyTestActor);
  }

  private getChallengeForAdmin(challengeId: string, actorId: string): Challenge {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new NotFoundException(`challenge not found: ${challengeId}`);
    this.assertAdminChallengeScope(challenge, actorId);
    return challenge;
  }

  private getEventForAdmin(eventId: string, actorId: string): EventConfig {
    const event = this.events.get(eventId);
    if (!event) throw new NotFoundException(`event not found: ${eventId}`);
    this.assertAdminEventScope(event, actorId);
    return event;
  }

  private eventInAdminScope(event: EventConfig, actorId: string, allowLegacyTestActor = false): boolean {
    const access = this.resolveAdminAccess(actorId, allowLegacyTestActor);
    if (access.level === 'GLOBAL') return true;
    const challenge = this.challengeForVersion(event.challengeVersion);
    if (challenge.ownerOrgPath !== '/' && access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, challenge.ownerOrgPath))) return true;
    const policy = event.accessPolicy;
    if (policy?.departmentIds?.some((departmentId) => {
      const department = this.orgUnits.get(departmentId);
      return department ? access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, department.path) || this.orgPathIncludes(department.path, scope)) : false;
    })) return true;
    if (policy?.subjectIds?.some((subjectId) => {
      const subject = this.users.get(subjectId);
      return Boolean(subject && access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, subject.orgPath)));
    })) return true;
    return [...this.participants.values()].some((participant) => participant.eventId === event.id && access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, participant.orgPathSnapshot)));
  }

  private assertAdminEventScope(event: EventConfig, actorId: string, allowLegacyTestActor = true): AdminAccess {
    const access = this.resolveAdminAccess(actorId, allowLegacyTestActor);
    if (access.level === 'GLOBAL' || this.eventInAdminScope(event, actorId, allowLegacyTestActor)) return access;
    throw new ForbiddenException('training event is outside the administrator organization scope');
  }

  assertSelfOrAdmin(actorId: string, subjectId: string): void {
    if (actorId === subjectId) return;
    if (!this.isAdmin(actorId)) throw new ForbiddenException('subject scope does not allow this operation');
    const subject = this.getUser(subjectId);
    this.assertAdminOrgScope(actorId, subject.orgPath, false);
  }

  assertCanViewSubmission(actorId: string, submissionId: string): void {
    const submission = this.getSubmission(submissionId);
    this.assertSelfOrAdmin(actorId, submission.subjectId);
  }

  assertCanViewRun(actorId: string, runId: string): void {
    const run = this.getRun(runId);
    this.assertCanViewSubmission(actorId, run.submissionId);
  }

  private challengeHasVisibleEvent(challenge: Challenge, actorId: string): boolean {
    const linkedEvents = [...this.events.values()].filter((event) => challenge.versions.some((version) => version.id === event.challengeVersion));
    return linkedEvents.length === 0 || linkedEvents.some((event) => this.eventVisibleTo(event, actorId));
  }

  private challengeForViewer(challenge: Challenge, includeAdminDetails: boolean): Challenge {
    if (includeAdminDetails) return challenge;
    // Evaluator identifiers and contract paths are operational configuration,
    // not part of the employee-facing challenge statement.
    return {
      ...challenge,
      versions: challenge.versions.map((version) => {
        const { evaluationEngine: _evaluationEngine, ...publicVersion } = version;
        return publicVersion;
      }),
    };
  }

  listChallenges(actorId = 'w00123'): Challenge[] {
    const admin = this.isAdmin(actorId);
    const adminAccess = admin ? this.getAdminAccess(actorId) : undefined;
    const user = this.getUser(actorId);
    return [...this.challenges.values()].filter((challenge) => {
      if (admin) {
        return adminAccess?.level === 'GLOBAL' || (challenge.ownerOrgPath !== '/' && Boolean(adminAccess?.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, challenge.ownerOrgPath))));
      }
      if (challenge.ownerOrgPath !== '/' && !this.orgPathIncludes(challenge.ownerOrgPath, user.orgPath)) return false;
      return this.challengeHasVisibleEvent(challenge, actorId);
    }).sort((a, b) => a.id.localeCompare(b.id)).map((challenge) => this.challengeForViewer(challenge, admin));
  }

  getChallenge(challengeId: string, actorId = 'w00123'): Challenge {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new NotFoundException(`challenge not found: ${challengeId}`);
    const user = this.getUser(actorId);
    const adminAccess = this.isAdmin(actorId) ? this.getAdminAccess(actorId) : undefined;
    const inAdminScope = adminAccess?.level === 'GLOBAL' || Boolean(adminAccess?.scopeOrgPaths.some((scope) => challenge.ownerOrgPath !== '/' && this.orgPathIncludes(scope, challenge.ownerOrgPath)));
    if (!adminAccess && challenge.ownerOrgPath !== '/' && !this.orgPathIncludes(challenge.ownerOrgPath, user.orgPath)) {
      throw new ForbiddenException('challenge is outside the actor organization scope');
    }
    if (adminAccess && !inAdminScope) {
      throw new ForbiddenException('challenge is outside the administrator organization scope');
    }
    if (!adminAccess && !this.challengeHasVisibleEvent(challenge, actorId)) {
      throw new ForbiddenException('challenge is outside the actor training scope');
    }
    return this.challengeForViewer(challenge, Boolean(adminAccess));
  }

  private getChallengeVersion(challengeVersionId: string): ChallengeVersion {
    for (const challenge of this.challenges.values()) {
      const version = challenge.versions.find((item) => item.id === challengeVersionId);
      if (version) return version;
    }
    throw new BadRequestException(`challenge version not found: ${challengeVersionId}`);
  }

  /** Internal, version-frozen challenge configuration used by upload checks. */
  getChallengeVersionRecord(challengeVersionId: string): ChallengeVersion {
    return this.getChallengeVersion(challengeVersionId);
  }

  challengeVersionForEvent(eventId: string): ChallengeVersion {
    return this.getChallengeVersion(this.getEvent(eventId).challengeVersion);
  }

  private submissionChallengeVersion(submission: SubmissionRecord): string {
    return submission.challengeVersionSnapshot ?? this.getEvent(submission.eventId).challengeVersion;
  }

  /**
   * The evaluation engine that owns a delivery, resolved through the challenge
   * version captured at submission time so a later challenge edit cannot change
   * how an already-submitted delivery is graded.
   */
  evaluationEngineForSubmission(submission: SubmissionRecord): EvaluationEngineConfig {
    return evaluationEngineForVersion(this.getChallengeVersion(this.submissionChallengeVersion(submission)));
  }

  /** Audit an engine package upload so a rule-set change is always traceable. */
  recordEnginePackageUpload(record: EnginePackageRecord, actorId: string): void {
    this.audit(actorId, 'engine-package.upload', `engine-package:${record.packageHash}`, undefined, {
      packageHash: record.packageHash,
      size: record.size,
      engineId: record.manifest.id,
      engineVersion: record.manifest.version,
      entrypoint: record.manifest.runtime.entrypoint,
    });
    this.persist();
  }

  /** Engine plus the challenge context an executor needs, both pinned to the submitted version. */
  gradingContextForSubmission(submission: SubmissionRecord): {
    engine: EvaluationEngineConfig;
    challenge: { id: string; title: string; challengeVersion: string; rubricVersion: string; zone?: 'YELLOW' | 'BLUE' };
  } {
    const challengeVersionId = this.submissionChallengeVersion(submission);
    const version = this.getChallengeVersion(challengeVersionId);
    return {
      engine: evaluationEngineForVersion(version),
      challenge: {
        id: this.challengeForVersion(challengeVersionId).id,
        title: version.title,
        challengeVersion: challengeVersionId,
        rubricVersion: this.submissionRubricVersion(submission),
        zone: version.zone,
      },
    };
  }

  /** Identity of the rule set, used as the grader component of an idempotency key. */
  private engineIdentity(engine: EvaluationEngineConfig): string {
    return engineIdentityOf(engine);
  }

  private submissionRubricVersion(submission: SubmissionRecord): string {
    if (submission.rubricVersionSnapshot) return submission.rubricVersionSnapshot;
    const event = this.getEvent(submission.eventId);
    return event.rubricVersion ?? this.getChallengeVersion(event.challengeVersion).rubricVersion ?? '1.0';
  }

  private markRunFailed(run: GradingRun, submission: SubmissionRecord, reason?: string): void {
    run.status = 'FAILED';
    run.failureReason = reason?.slice(0, 2000);
    run.leaseId = undefined;
    run.leasedBy = undefined;
    run.leaseExpiresAt = undefined;
    // Keep RECEIVED for compatibility with older persisted submissions and
    // clients. The run itself is the authoritative failed state; the failure
    // reason is exposed on the submission so the console can show retryable
    // failures without losing the old retry flow.
    submission.state = 'RECEIVED';
    submission.gradingStatus = 'FAILED';
    submission.failureReason = run.failureReason;
    submission.gradingRunId = undefined;
  }

  private syncSubmissionLifecycle(submission: SubmissionRecord): void {
    if (submission.resultId) {
      submission.gradingStatus = 'COMPLETED';
      return;
    }
    if (!submission.gradingRunId) return;
    const run = this.runs.get(submission.gradingRunId);
    if (!run) return;
    submission.gradingStatus = run.status === 'RUNNING' ? 'RUNNING' : run.status === 'QUEUED' ? 'QUEUED' : run.status === 'FAILED' ? 'FAILED' : submission.gradingStatus;
    if (run.status === 'FAILED' && !submission.failureReason) submission.failureReason = run.failureReason;
  }

  createChallenge(challenge: Challenge, actorId = 'admin-local'): Challenge {
    const adminAccess = this.resolveAdminAccess(actorId, true);
    if (this.challenges.has(challenge.id)) throw new ConflictException(`challenge already exists: ${challenge.id}`);
    if (!challenge.versions.length) throw new BadRequestException('challenge must contain at least one version');
    if (challenge.category !== undefined && !isChallengeCategory(challenge.category)) {
      throw new BadRequestException('challenge category must be TRAINING, COMPETITION or HARD_PROBLEM');
    }
    if (challenge.board && challenge.board.type !== 'HARD_PROBLEM') {
      throw new BadRequestException('challenge board type is invalid');
    }
    const requestedCategory = challenge.category ?? inferChallengeCategory(challenge);
    if (requestedCategory !== 'HARD_PROBLEM' && challenge.board) {
      throw new BadRequestException('only HARD_PROBLEM challenges can carry hard-problem board metadata');
    }
    const versionIds = new Set<string>();
    const versionNumbers = new Set<number>();
    for (const version of challenge.versions) {
      if (version.challengeId !== challenge.id) throw new BadRequestException(`challenge version ${version.id} must belong to ${challenge.id}`);
      if (versionIds.has(version.id) || versionNumbers.has(version.version)) throw new ConflictException(`duplicate challenge version: ${version.id}`);
      validateEvaluationEngine(version.evaluationEngine);
      versionIds.add(version.id);
      versionNumbers.add(version.version);
    }
    const requestedOwnerOrgPath = this.normalizeOrgPath(challenge.ownerOrgPath || '/');
    const ownerOrgPath = adminAccess.level === 'GLOBAL'
      ? requestedOwnerOrgPath
      : requestedOwnerOrgPath === '/'
        ? adminAccess.scopeOrgPaths[0]
        : requestedOwnerOrgPath;
    this.assertAdminOrgScope(actorId, ownerOrgPath);
    const normalized: Challenge = { ...challenge, ownerOrgPath, category: requestedCategory };
    if (normalized.category === 'HARD_PROBLEM' && !normalized.board) {
      normalized.board = this.defaultBoardMetadataFromChallenge(normalized, actorId);
    }
    this.challenges.set(challenge.id, normalized);
    this.syncHardProblemSubmissionEvent(normalized);
    this.audit(actorId, 'challenge.create', `challenge:${challenge.id}`, undefined, normalized);
    this.persist();
    return normalized;
  }

  updateChallenge(challengeId: string, patch: { category?: ChallengeCategory; solutionVisibility?: HardProblemSolutionVisibility }, actorId = 'admin-local'): Challenge {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    if (patch.category !== undefined && !isChallengeCategory(patch.category)) {
      throw new BadRequestException('challenge category must be TRAINING, COMPETITION or HARD_PROBLEM');
    }
    if (patch.solutionVisibility !== undefined && !isHardProblemSolutionVisibility(patch.solutionVisibility)) {
      throw new BadRequestException('hard problem solutionVisibility must be PUBLIC or HIDDEN');
    }
    const before = { category: challenge.category ?? inferChallengeCategory(challenge), solutionVisibility: challenge.board?.type === 'HARD_PROBLEM' ? this.hardProblemSolutionVisibility(challenge.board) : undefined };
    if (patch.category !== undefined) {
      // A board is a projection-specific metadata block. If a publisher
      // changes a hard-problem challenge to another business type, remove the
      // projection so the challenge cannot leak into the hard-problem board.
      if (patch.category !== 'HARD_PROBLEM' && challenge.board?.type === 'HARD_PROBLEM') delete challenge.board;
      challenge.category = patch.category;
      if (patch.category === 'HARD_PROBLEM' && !challenge.board) {
        challenge.board = this.defaultBoardMetadataFromChallenge(challenge, actorId);
      }
      this.syncHardProblemSubmissionEvent(challenge);
    }
    if (patch.solutionVisibility !== undefined) {
      if (challenge.board?.type !== 'HARD_PROBLEM' || (patch.category !== undefined && patch.category !== 'HARD_PROBLEM')) {
        throw new BadRequestException('solutionVisibility can only be configured for HARD_PROBLEM challenges');
      }
      challenge.board.solutionVisibility = patch.solutionVisibility;
      challenge.board.updatedAt = now();
    }
    this.audit(actorId, 'challenge.update', `challenge:${challengeId}`, before, { category: challenge.category, solutionVisibility: challenge.board?.type === 'HARD_PROBLEM' ? this.hardProblemSolutionVisibility(challenge.board) : undefined });
    this.persist();
    return challenge;
  }

  addChallengeVersion(challengeId: string, input: ChallengeVersion, actorId = 'admin-local'): ChallengeVersion {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    if (challenge.status === 'ARCHIVED') throw new ConflictException('archived challenge cannot receive a new version');
    if (input.challengeId !== challengeId) throw new BadRequestException(`challenge version must belong to ${challengeId}`);
    if (challenge.versions.some((version) => version.id === input.id || version.version === input.version)) {
      throw new ConflictException(`challenge version already exists: ${input.id}`);
    }
    validateEvaluationEngine(input.evaluationEngine);
    const version = { ...input, status: 'DRAFT' as const };
    challenge.versions.push(version);
    this.audit(actorId, 'challenge-version.create', `challenge-version:${version.id}`, undefined, version);
    this.persist();
    return version;
  }

  updateChallengeVersion(challengeId: string, versionId: string, patch: Partial<ChallengeVersion>, actorId = 'admin-local'): ChallengeVersion {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    const version = challenge.versions.find((item) => item.id === versionId);
    if (!version) throw new NotFoundException(`challenge version not found: ${versionId}`);
    if (version.status === 'PUBLISHED') throw new ConflictException('published challenge version is immutable; create a new version instead');
    const before = { ...version };
    const next = { ...patch } as Partial<ChallengeVersion>;
    delete next.id;
    delete next.challengeId;
    delete next.version;
    delete next.status;
    validateEvaluationEngine(next.evaluationEngine);
    Object.assign(version, next);
    this.audit(actorId, 'challenge-version.update', `challenge-version:${versionId}`, before, version);
    this.persist();
    return version;
  }

  publishChallengeVersion(challengeId: string, versionId: string, actorId = 'admin-local'): ChallengeVersion {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    const version = challenge.versions.find((item) => item.id === versionId);
    if (!version) throw new NotFoundException(`challenge version not found: ${versionId}`);
    validateEvaluationEngine(version.evaluationEngine);
    const before = { status: version.status, challengeStatus: challenge.status };
    version.status = 'PUBLISHED';
    challenge.status = 'PUBLISHED';
    if (challenge.category === 'HARD_PROBLEM' && !challenge.board) {
      challenge.board = this.defaultBoardMetadataFromChallenge(challenge, actorId);
    }
    this.syncHardProblemSubmissionEvent(challenge);
    this.audit(actorId, 'challenge-version.publish', `challenge-version:${versionId}`, before, { status: version.status, challengeStatus: challenge.status });
    this.persist();
    return version;
  }

  archiveChallenge(challengeId: string, actorId = 'admin-local'): Challenge {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    if (challenge.status === 'ARCHIVED') throw new ConflictException('challenge is already in the trash');
    const openEvents = [...this.events.values()].filter((event) => event.status === 'OPEN' && event.purpose !== 'HARD_PROBLEM' && challenge.versions.some((version) => version.id === event.challengeVersion));
    if (openEvents.length) throw new ConflictException(`challenge has open events: ${openEvents.map((event) => event.id).join(', ')}`);
    const before = challenge.status;
    challenge.archivedFrom = before;
    challenge.status = 'ARCHIVED';
    this.localDemoSeedEnabled = false;
    this.syncHardProblemSubmissionEvent(challenge);
    this.audit(actorId, 'challenge.archive', `challenge:${challengeId}`, { status: before }, { status: challenge.status, archivedFrom: challenge.archivedFrom });
    this.persist();
    return challenge;
  }

  /**
   * Move a challenge to the trash without destroying its versions or audit
   * history. The platform exposes this as DELETE for backwards compatibility;
   * permanently deleting an archived item is a separate operation.
   */
  deleteChallenge(challengeId: string, actorId = 'admin-local'): Challenge {
    return this.archiveChallenge(challengeId, actorId);
  }

  permanentlyDeleteChallenge(challengeId: string, actorId = 'admin-local'): { id: string; status: 'PURGED' } {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    if (challenge.status !== 'ARCHIVED') throw new ConflictException('only challenges in the trash can be permanently deleted');

    const versionIds = new Set(challenge.versions.map((version) => version.id));
    const linkedEvents = [...this.events.values()].filter((event) => versionIds.has(event.challengeVersion));
    if (linkedEvents.length) {
      throw new ConflictException(`challenge has linked training events: ${linkedEvents.map((event) => event.id).join(', ')}`);
    }

    const before = {
      status: challenge.status,
      archivedFrom: challenge.archivedFrom,
      versions: challenge.versions.map((version) => ({ id: version.id, version: version.version })),
    };
    this.challenges.delete(challengeId);
    this.hardProblems.delete(challengeId);
    this.localDemoSeedEnabled = false;
    this.audit(actorId, 'challenge.purge', `challenge:${challengeId}`, before, { status: 'PURGED' });
    this.persist();
    return { id: challengeId, status: 'PURGED' };
  }

  restoreChallenge(challengeId: string, actorId = 'admin-local'): Challenge {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    if (challenge.status !== 'ARCHIVED') throw new ConflictException('challenge is not in the trash');
    const before = { status: challenge.status, archivedFrom: challenge.archivedFrom };
    const restoredStatus = challenge.archivedFrom ?? (challenge.versions.some((version) => version.status === 'PUBLISHED') ? 'PUBLISHED' : 'DRAFT');
    challenge.status = restoredStatus;
    delete challenge.archivedFrom;
    this.syncHardProblemSubmissionEvent(challenge);
    this.audit(actorId, 'challenge.restore', `challenge:${challengeId}`, before, { status: challenge.status });
    this.persist();
    return challenge;
  }

  publishChallenge(challengeId: string, actorId = 'admin-local'): Challenge {
    const challenge = this.getChallengeForAdmin(challengeId, actorId);
    const before = { status: challenge.status, versions: challenge.versions.map((version) => ({ id: version.id, status: version.status })) };
    challenge.status = 'PUBLISHED';
    challenge.versions = challenge.versions.map((version) => ({ ...version, status: 'PUBLISHED' }));
    if (challenge.category === 'HARD_PROBLEM' && !challenge.board) {
      challenge.board = this.defaultBoardMetadataFromChallenge(challenge, actorId);
    }
    this.syncHardProblemSubmissionEvent(challenge);
    this.audit(actorId, 'challenge.publish', `challenge:${challengeId}`, before, { status: challenge.status });
    this.persist();
    return challenge;
  }

  listSeasons(): Season[] {
    return [...this.seasons.values()];
  }

  getSeason(seasonId: string): Season {
    const season = this.seasons.get(seasonId);
    if (!season) throw new NotFoundException(`season not found: ${seasonId}`);
    return season;
  }

  createSeason(season: Season, actorId = 'admin-local'): Season {
    if (this.resolveAdminAccess(actorId, true).level !== 'GLOBAL') throw new ForbiddenException('global administrator role is required');
    if (this.seasons.has(season.id)) throw new ConflictException(`season already exists: ${season.id}`);
    for (const eventId of season.eventIds) this.getEvent(eventId);
    this.seasons.set(season.id, season);
    this.audit(actorId, 'season.create', `season:${season.id}`, undefined, season);
    this.persist();
    return season;
  }

  private isOfficialEvent(eventId: string): boolean {
    const event = this.getEvent(eventId);
    const challenge = [...this.challenges.values()].find((item) => item.versions.some((version) => version.id === event.challengeVersion));
    return challenge?.origin === 'OFFICIAL';
  }

  private eventRanking(eventId: string): Map<string, { score: number; points: number; submissions: number }> {
    if (!this.isOfficialEvent(eventId)) return new Map();
    const best = new Map<string, { score: number; submissions: number }>();
    for (const submission of this.submissions.values()) {
      if (submission.eventId !== eventId || !submission.resultId) continue;
      const event = this.getEvent(submission.eventId);
      if (event.reveal === 'ON_RELEASE' && submission.state !== 'REVEALED') continue;
      const stored = this.results.get(submission.resultId);
      if (!stored) continue;
      const score = Number((stored.result as { total?: number }).total ?? 0);
      const current = best.get(submission.subjectId);
      best.set(submission.subjectId, { score: Math.max(current?.score ?? Number.NEGATIVE_INFINITY, score), submissions: (current?.submissions ?? 0) + 1 });
    }
    const sorted = [...best.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    const count = sorted.length;
    // Season points are `round(100 * (1 - (rank - 1) / participants))`. Equal
    // scores must share a rank, otherwise two identical deliveries receive
    // different season points purely because of the tie-break ordering.
    let rankIndex = 0;
    return new Map(sorted.map(([subjectId, row], index) => {
      if (index > 0 && Math.abs(row.score - sorted[index - 1][1].score) > 0.0001) rankIndex = index;
      return [subjectId, {
        score: Number(row.score.toFixed(4)),
        points: Math.round(100 * (1 - rankIndex / count)),
        submissions: row.submissions,
      }];
    }));
  }

  /**
   * Return a season leaderboard. Internal callers that omit `actorId` retain
   * the full, identity-keyed representation used by legacy store jobs. HTTP
   * callers must provide an actor so the public response can be bounded and
   * privacy-filtered at the domain boundary.
   */
  leaderboard(seasonId: string, actorId?: string): Array<Record<string, unknown>> {
    const season = this.getSeason(seasonId);
    const rows = new Map<string, { score: number; points: number; submissions: number }>();
    for (const eventId of season.eventIds) {
      for (const [subjectId, eventRow] of this.eventRanking(eventId)) {
        const row = rows.get(subjectId) ?? { score: 0, points: 0, submissions: 0 };
        row.score += eventRow.score;
        row.points += eventRow.points;
        row.submissions += eventRow.submissions;
        rows.set(subjectId, row);
      }
    }
    const sorted = [...rows.entries()].sort((a, b) => b[1].points - a[1].points || b[1].score - a[1].score || a[0].localeCompare(b[0]));
    const legacyRows = sorted.map(([subjectId, row], index) => ({ rank: index + 1, subjectId, score: Number(row.score.toFixed(4)), points: row.points, total: row.points, submissions: row.submissions }));
    if (!actorId) return legacyRows;

    const canViewIdentity = this.isAdmin(actorId);
    return sorted.slice(0, 3).map(([subjectId, row], index) => {
      const user = this.getUser(subjectId);
      return {
        rank: index + 1,
        nickname: user.nickname?.trim() || '未设置昵称',
        score: Number(row.score.toFixed(4)),
        points: row.points,
        total: row.points,
        submissions: row.submissions,
        isSelf: subjectId === actorId,
        ...(canViewIdentity ? { subjectId, name: user.name, employeeNo: user.employeeNo } : {}),
      };
    });
  }

  profile(subjectId: string, options: { includeHistory?: boolean } = {}): Record<string, unknown> {
    const user = this.getUser(subjectId);
    const submissions = this.systemSubmissions().filter((item) => item.subjectId === subjectId);
    const visible = submissions.filter((submission) => {
      if (!submission.resultId) return false;
      const event = this.getEvent(submission.eventId);
      return event.reveal === 'IMMEDIATE' || submission.state === 'REVEALED';
    });
    const scores = visible.map((submission) => Number((this.results.get(submission.resultId!)?.result as { total?: number } | undefined)?.total ?? 0));
    const runningSeason = [...this.seasons.values()].find((season) => season.status === 'RUNNING');
    const pointsByEvent = new Map<string, number>();
    for (const eventId of runningSeason?.eventIds ?? []) pointsByEvent.set(eventId, this.eventRanking(eventId).get(subjectId)?.points ?? 0);
    const totalPoints = [...pointsByEvent.values()].reduce((sum, value) => sum + value, 0);
    const departmentName = user.orgUnitId ? this.orgUnits.get(user.orgUnitId)?.name : undefined;
    return {
      subject: { ...user, ...(departmentName ? { departmentName } : {}) },
      stats: { submissions: submissions.length, graded: visible.length, average: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)) : null, best: scores.length ? Math.max(...scores) : null, totalPoints },
      history: options.includeHistory === false ? [] : visible.map((submission) => ({ submissionId: submission.id, eventId: submission.eventId, total: Number((this.results.get(submission.resultId!)?.result as { total?: number } | undefined)?.total ?? 0), points: pointsByEvent.get(submission.eventId) ?? 0, resultId: submission.resultId, createdAt: submission.createdAt })),
    };
  }

  /**
   * Server-side page for the profile result history.  The profile summary
   * remains an aggregate, while the high-cardinality history rows are bounded
   * by the same PageInfo contract used by users, submissions and audits.
   */
  profileHistory(subjectId: string, options: { page?: number; pageSize?: number } = {}): Record<string, unknown> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('page must be a positive integer');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('pageSize must be between 1 and 100');
    // Resolve the user before scanning submissions so a missing subject is a
    // stable 404 even when the history is empty.
    this.getUser(subjectId);
    const submissions = this.systemSubmissions().filter((item) => item.subjectId === subjectId);
    const visible = submissions.filter((submission) => {
      if (!submission.resultId) return false;
      const event = this.getEvent(submission.eventId);
      return event.reveal === 'IMMEDIATE' || submission.state === 'REVEALED';
    });
    const runningSeason = [...this.seasons.values()].find((season) => season.status === 'RUNNING');
    const pointsByEvent = new Map<string, number>();
    for (const eventId of runningSeason?.eventIds ?? []) pointsByEvent.set(eventId, this.eventRanking(eventId).get(subjectId)?.points ?? 0);
    const items = visible.map((submission) => ({
      submissionId: submission.id,
      eventId: submission.eventId,
      total: Number((this.results.get(submission.resultId!)?.result as { total?: number } | undefined)?.total ?? 0),
      points: pointsByEvent.get(submission.eventId) ?? 0,
      resultId: submission.resultId,
      createdAt: submission.createdAt,
    }));
    return { items: items.slice((page - 1) * pageSize, page * pageSize), pageInfo: pageInfo(page, pageSize, items.length) };
  }

  /**
   * Aggregated, read-only capability data for the employee profile.
  * Scores are normalized to percentages so different rubrics can share one
  * radar chart while the original score/max values remain available for detail.
  */
  capabilities(subjectId: string, options: { includeSealed?: boolean; trendPage?: number; trendPageSize?: number; eventId?: string; includeDepartmentStats?: boolean } = {}): Record<string, unknown> {
    const includeSealed = options.includeSealed === true;
    // Keep the historical store-level default for internal/admin consumers,
    // while HTTP callers explicitly pass the actor's department permission.
    const includeDepartmentStats = options.includeDepartmentStats !== false;
    const trendPage = options.trendPage;
    const trendPageSize = options.trendPageSize;
    const requestedEventId = options.eventId?.trim() || undefined;
    if (trendPage !== undefined && (!Number.isSafeInteger(trendPage) || trendPage < 1)) throw new BadRequestException('page must be a positive integer');
    if (trendPageSize !== undefined && (!Number.isSafeInteger(trendPageSize) || trendPageSize < 1 || trendPageSize > 100)) throw new BadRequestException('pageSize must be between 1 and 100');
    const subject = this.getUser(subjectId);
    if (requestedEventId) this.getEvent(requestedEventId);
    const visible = this.systemSubmissions(requestedEventId)
      .filter((submission) => submission.subjectId === subjectId)
      .filter((submission) => submission.resultId)
      .filter((submission) => {
        const event = this.getEvent(submission.eventId);
        return includeSealed || event.reveal === 'IMMEDIATE' || submission.state === 'REVEALED';
      })
      .map((submission) => ({ submission, result: this.results.get(submission.resultId!)?.result as Record<string, unknown> | undefined }))
      .filter((item): item is { submission: SubmissionRecord; result: Record<string, unknown> } => Boolean(item.result))
      .sort((a, b) => a.submission.createdAt.localeCompare(b.submission.createdAt));

    const dimensionMeta = [
      { key: 'verify', label: '验证能力', description: '功能验证、边界推理与变更适应' },
      { key: 'spec', label: '规格能力', description: '需求拆解、假设表达与验收设计' },
      { key: 'code', label: '工程能力', description: '可维护性、异常处理与工程质量' },
      { key: 'collab', label: '协作能力', description: '澄清沟通、过程记录与交付协同' },
    ] as const;
    const round = (value: number): number => Number(value.toFixed(2));
    const resultDimensions = (result: Record<string, unknown>): Record<string, Record<string, unknown>> => {
      const dimensions = result.dimensions;
      if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) return {};
      return dimensions as Record<string, Record<string, unknown>>;
    };
    const resultCriteria = (result: Record<string, unknown>): Map<string, Record<string, unknown>> => {
      const criteria = Array.isArray(result.criteria) ? result.criteria : [];
      const map = new Map<string, Record<string, unknown>>();
      for (const item of criteria) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const criterion = item as Record<string, unknown>;
        if (typeof criterion.key !== 'string' || typeof criterion.dim !== 'string') continue;
        map.set(`${criterion.dim}:${criterion.key}`, criterion);
      }
      return map;
    };
    const domainSample = (domain: typeof CAPABILITY_DOMAINS[number], result: Record<string, unknown>) => {
      const criteria = resultCriteria(result);
      const evidence = domain.criterionKeys
        .map((key) => criteria.get(key))
        .filter((criterion): criterion is Record<string, unknown> => {
          if (!criterion || typeof criterion.score !== 'number' || typeof criterion.max !== 'number') return false;
          return criterion.max > 0 && criterion.score >= 0 && criterion.score <= criterion.max;
        });
      if (!evidence.length) return null;
      const score = evidence.reduce((sum, criterion) => sum + Number(criterion.score), 0);
      const max = evidence.reduce((sum, criterion) => sum + Number(criterion.max), 0);
      return {
        score,
        max,
        percent: round(Math.max(0, Math.min(100, score / max * 100))),
        criterionKeys: evidence.map((criterion) => `${String(criterion.dim)}:${String(criterion.key)}`),
      };
    };
    const peerDimensionSamples = new Map<string, Map<string, number[]>>();
    const peerDomainSamples = new Map<string, Map<string, number[]>>();
    for (const candidate of this.submissions.values()) {
      if (candidate.subjectId === subjectId || !candidate.resultId) continue;
      if (requestedEventId && candidate.eventId !== requestedEventId) continue;
      let candidateUser: AppUser;
      try { candidateUser = this.getUser(candidate.subjectId); } catch { continue; }
      if (candidateUser.orgPath !== subject.orgPath) continue;
      const event = this.getEvent(candidate.eventId);
      if (!includeSealed && event.reveal === 'ON_RELEASE' && candidate.state !== 'REVEALED') continue;
      const result = this.results.get(candidate.resultId)?.result as Record<string, unknown> | undefined;
      if (!result) continue;
      for (const [key, dimension] of Object.entries(resultDimensions(result))) {
        if (dimension.evaluated !== true || typeof dimension.score !== 'number' || typeof dimension.max !== 'number' || dimension.max <= 0) continue;
        const userSamples = peerDimensionSamples.get(key) ?? new Map<string, number[]>();
        const samples = userSamples.get(candidate.subjectId) ?? [];
        samples.push(round(Math.max(0, Math.min(100, dimension.score / dimension.max * 100))));
        userSamples.set(candidate.subjectId, samples);
        peerDimensionSamples.set(key, userSamples);
      }
      for (const domain of CAPABILITY_DOMAINS) {
        const sample = domainSample(domain, result);
        if (!sample) continue;
        const userSamples = peerDomainSamples.get(domain.key) ?? new Map<string, number[]>();
        const samples = userSamples.get(candidate.subjectId) ?? [];
        samples.push(sample.percent);
        userSamples.set(candidate.subjectId, samples);
        peerDomainSamples.set(domain.key, userSamples);
      }
    }
    const peerMedian = (source: Map<string, Map<string, number[]>>, key: string): { median: number | null; count: number } => {
      const values = [...(source.get(key)?.values() ?? [])]
        .map((samples) => samples.reduce((sum, value) => sum + value, 0) / samples.length)
        .sort((a, b) => a - b);
      if (!values.length) return { median: null, count: 0 };
      const middle = Math.floor(values.length / 2);
      return { median: round(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2), count: values.length };
    };
    const dimensionRows = dimensionMeta.map((meta) => {
      const samples = visible.flatMap(({ submission, result }) => {
        const dimension = resultDimensions(result)[meta.key];
        if (!dimension || dimension.evaluated !== true || typeof dimension.score !== 'number' || typeof dimension.max !== 'number' || dimension.max <= 0) return [];
        return [{
          submissionId: submission.id,
          eventId: submission.eventId,
          createdAt: submission.createdAt,
          score: dimension.score,
          max: dimension.max,
          percent: round(Math.max(0, Math.min(100, dimension.score / dimension.max * 100))),
        }];
      });
      const latest = samples.at(-1);
      const previous = samples.at(-2);
      const average = samples.length ? round(samples.reduce((sum, sample) => sum + sample.percent, 0) / samples.length) : null;
      const peer = peerMedian(peerDimensionSamples, meta.key);
      return {
        key: meta.key,
        label: meta.label,
        description: meta.description,
        score: latest?.score ?? null,
        max: latest?.max ?? null,
        percent: average,
        latestPercent: latest?.percent ?? null,
        bestPercent: samples.length ? Math.max(...samples.map((sample) => sample.percent)) : null,
        delta: latest && previous ? round(latest.percent - previous.percent) : null,
        evaluatedCount: samples.length,
        peerMedianPercent: includeDepartmentStats ? peer.median : null,
        peerCount: includeDepartmentStats ? peer.count : 0,
        vsPeerMedian: includeDepartmentStats && average !== null && peer.median !== null ? round(average - peer.median) : null,
        samples,
      };
    });

    const domainRows = CAPABILITY_DOMAINS.map((domain) => {
      const samples = visible.flatMap(({ submission, result }) => {
        const sample = domainSample(domain, result);
        return sample ? [{
          submissionId: submission.id,
          eventId: submission.eventId,
          createdAt: submission.createdAt,
          score: sample.score,
          max: sample.max,
          percent: sample.percent,
          criterionKeys: sample.criterionKeys,
        }] : [];
      });
      const latest = samples.at(-1);
      const previous = samples.at(-2);
      const average = samples.length ? round(samples.reduce((sum, sample) => sum + sample.percent, 0) / samples.length) : null;
      const peer = peerMedian(peerDomainSamples, domain.key);
      const evidenceKeys = [...new Set(samples.flatMap((sample) => sample.criterionKeys))];
      return {
        key: domain.key,
        label: domain.label,
        shortLabel: domain.shortLabel,
        description: domain.description,
        evidenceMode: domain.evidenceMode,
        criterionKeys: [...domain.criterionKeys],
        evidenceKeys,
        score: latest?.score ?? null,
        max: latest?.max ?? null,
        percent: average,
        latestPercent: latest?.percent ?? null,
        bestPercent: samples.length ? Math.max(...samples.map((sample) => sample.percent)) : null,
        delta: latest && previous ? round(latest.percent - previous.percent) : null,
        sampleCount: samples.length,
        evidenceCount: evidenceKeys.length,
        peerMedianPercent: includeDepartmentStats ? peer.median : null,
        peerCount: includeDepartmentStats ? peer.count : 0,
        vsPeerMedian: includeDepartmentStats && average !== null && peer.median !== null ? round(average - peer.median) : null,
        status: average === null ? '待评估' : average >= 85 ? '优势' : average >= 60 ? '稳定' : '待提升',
        samples,
      };
    });

    const trend = visible.map(({ submission, result }) => {
      const dimensions = resultDimensions(result);
      const dimensionPercentages: Record<string, number | null> = {};
      const domainPercentages: Record<string, number | null> = {};
      for (const meta of dimensionMeta) {
        const dimension = dimensions[meta.key];
        dimensionPercentages[meta.key] = dimension?.evaluated === true && typeof dimension.score === 'number' && typeof dimension.max === 'number' && dimension.max > 0
          ? round(Math.max(0, Math.min(100, dimension.score / dimension.max * 100)))
          : null;
      }
      for (const domain of CAPABILITY_DOMAINS) domainPercentages[domain.key] = domainSample(domain, result)?.percent ?? null;
      const zone = this.getChallengeVersion(this.getEvent(submission.eventId).challengeVersion).zone;
      return {
        submissionId: submission.id,
        eventId: submission.eventId,
        createdAt: submission.createdAt,
        total: typeof result.total === 'number' ? result.total : null,
        zone,
        dimensionPercentages,
        domainPercentages,
      };
    });

    const zoneStats = { YELLOW: 0, BLUE: 0 };
    for (const { submission } of visible) {
      const version = this.getChallengeVersion(this.getEvent(submission.eventId).challengeVersion);
      zoneStats[version.zone] += 1;
    }

    const skillMap = new Map<string, { key: string; name: string; dimension: string; max: number; description: string; samples: Array<{ percent: number; level: string | null }> }>();
    for (const { result } of visible) {
      const criteria = Array.isArray(result.criteria) ? result.criteria : [];
      for (const item of criteria) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const criterion = item as Record<string, unknown>;
        if (typeof criterion.key !== 'string' || typeof criterion.name !== 'string' || typeof criterion.dim !== 'string' || typeof criterion.score !== 'number' || typeof criterion.max !== 'number' || criterion.max <= 0) continue;
        const key = `${criterion.dim}:${criterion.key}`;
        const definition = CAPABILITY_ITEM_BY_KEY.get(String(`${criterion.dim}:${criterion.key}`));
        const row = skillMap.get(key) ?? { key, name: criterion.name, dimension: criterion.dim, max: definition?.max ?? criterion.max, description: definition?.description ?? '', samples: [] };
        row.name = criterion.name;
        row.samples.push({ percent: round(Math.max(0, Math.min(100, criterion.score / criterion.max * 100))), level: typeof criterion.level === 'string' ? criterion.level : null });
        skillMap.set(key, row);
      }
    }
    const skills = CAPABILITY_ITEMS.map((definition) => {
      const row = skillMap.get(`${definition.dimension}:${definition.key}`);
      const samples = row?.samples ?? [];
      const latest = samples.at(-1);
      const levelCounts = new Map<string, number>();
      for (const sample of samples) if (sample.level) levelCounts.set(sample.level, (levelCounts.get(sample.level) ?? 0) + 1);
      const averageLevel = [...levelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
      return {
        key: `${definition.dimension}:${definition.key}`,
        criterionKey: definition.key,
        name: row?.name ?? definition.name,
        dimension: definition.dimension,
        domainKeys: [...definition.domainKeys],
        description: definition.description,
        max: definition.max,
        averageScore: samples.length ? round(samples.reduce((sum, sample) => sum + sample.percent * definition.max / 100, 0) / samples.length) : null,
        percent: samples.length ? round(samples.reduce((sum, sample) => sum + sample.percent, 0) / samples.length) : null,
        latestPercent: latest?.percent ?? null,
        averageLevel,
        sampleCount: samples.length,
        status: samples.length ? (averageLevel === 'A' ? '优秀' : averageLevel === 'B' ? '合格' : averageLevel === 'C' ? '待提升' : '未做到') : '待评估',
      };
    });

    const totals = trend.flatMap((item) => typeof item.total === 'number' ? [item.total] : []);
    const latestTotal = totals.at(-1) ?? null;
    const previousTotal = totals.at(-2) ?? null;
    const departmentTotals = new Map<string, number[]>();
    for (const candidate of this.submissions.values()) {
      if (!candidate.resultId) continue;
      if (requestedEventId && candidate.eventId !== requestedEventId) continue;
      let candidateUser: AppUser;
      try { candidateUser = this.getUser(candidate.subjectId); } catch { continue; }
      if (candidateUser.orgPath !== subject.orgPath) continue;
      const candidateEvent = this.getEvent(candidate.eventId);
      if (!includeSealed && candidateEvent.reveal === 'ON_RELEASE' && candidate.state !== 'REVEALED') continue;
      const candidateResult = this.results.get(candidate.resultId)?.result as { total?: unknown } | undefined;
      if (typeof candidateResult?.total !== 'number') continue;
      const values = departmentTotals.get(candidate.subjectId) ?? [];
      values.push(candidateResult.total);
      departmentTotals.set(candidate.subjectId, values);
    }
    const departmentAverages = [...departmentTotals.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length).sort((a, b) => a - b);
    const medianValue = (values: number[]): number | null => {
      if (!values.length) return null;
      const middle = Math.floor(values.length / 2);
      return round(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
    };
    const ownAverage = totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : null;
    const departmentPercentile = ownAverage === null || !departmentAverages.length ? null : round(100 * departmentAverages.filter((value) => value <= ownAverage).length / departmentAverages.length);
    const departmentComparison = {
      orgPath: subject.orgPath,
      participantCount: departmentAverages.length,
      average: includeDepartmentStats && medianValue(departmentAverages) !== null ? round(departmentAverages.reduce((sum, value) => sum + value, 0) / departmentAverages.length) : null,
      median: includeDepartmentStats ? medianValue(departmentAverages) : null,
      percentile: includeDepartmentStats ? departmentPercentile : null,
    };
    const rankedDimensions = dimensionRows.filter((dimension) => typeof dimension.percent === 'number').sort((a, b) => (b.percent as number) - (a.percent as number));
    const evaluatedSkills = skills.filter((skill) => typeof skill.percent === 'number');
    const weakItems = [...evaluatedSkills]
      .sort((a, b) => (a.percent as number) - (b.percent as number) || a.criterionKey.localeCompare(b.criterionKey))
      .slice(0, 3)
      .map((skill) => ({
        key: skill.criterionKey,
        name: skill.name,
        dimension: skill.dimension,
        percent: skill.percent,
        averageLevel: skill.averageLevel,
        recommendation: `建议通过专项练习提升「${skill.name}」：${skill.description}`,
      }));
    return {
      subjectId,
      summary: {
        gradedSubmissions: visible.length,
        overallAverage: ownAverage === null ? null : round(ownAverage),
        latestTotal,
        delta: latestTotal !== null && previousTotal !== null ? round(latestTotal - previousTotal) : null,
        strongestDimension: rankedDimensions[0]?.key ?? null,
        focusDimension: rankedDimensions.at(-1)?.key ?? null,
        strongestDomain: domainRows.filter((domain) => typeof domain.percent === 'number')[0]?.key ?? null,
        focusDomain: [...domainRows].filter((domain) => typeof domain.percent === 'number').sort((a, b) => (a.percent as number) - (b.percent as number))[0]?.key ?? null,
        zoneStats,
        capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION,
        totalCapabilityDomains: CAPABILITY_DOMAINS.length,
        evaluatedCapabilityDomains: domainRows.filter((domain) => typeof domain.percent === 'number').length,
        totalSkillItems: CAPABILITY_ITEMS.length,
        evaluatedSkillItems: evaluatedSkills.length,
        departmentAverage: departmentComparison.average,
        departmentMedian: departmentComparison.median,
        departmentPercentile: departmentComparison.percentile,
        departmentStatsVisible: includeDepartmentStats,
      },
      dimensions: dimensionRows,
      capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION,
      domains: domainRows,
      capabilityDomains: domainRows,
      skills,
      gradeMatrix: skills,
      weakItems,
      recommendations: weakItems.map((item) => item.recommendation),
      trend: trendPage === undefined ? trend : trend.slice((trendPage - 1) * (trendPageSize ?? 20), trendPage * (trendPageSize ?? 20)),
      ...(trendPage === undefined ? {} : { trendPageInfo: pageInfo(trendPage, trendPageSize ?? 20, trend.length) }),
      zoneStats,
      departmentComparison,
      departmentStatsVisible: includeDepartmentStats,
      lastUpdated: visible.at(-1)?.result.finishedAt ?? visible.at(-1)?.submission.createdAt ?? null,
    };
  }

  /**
   * Department comparisons are visible only to a global administrator or to
   * a department administrator whose scope contains the target employee.
   * A normal employee can still read their own capability profile, but never
   * receives peer statistics from the API.
   */
  canViewDepartmentStats(actorId: string, subjectId: string): boolean {
    const subject = this.getUser(subjectId);
    try {
      const access = this.resolveAdminAccess(actorId, false);
      return access.level === 'GLOBAL' || access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, subject.orgPath));
    } catch {
      return false;
    }
  }

  /**
   * Administrator-only capability workspace. The endpoint intentionally returns
   * each selected employee's normal capability profile plus aggregate rows so the
   * console can switch between an entire department and an explicit roster without
   * asking the browser to reconstruct scoring rules.
   */
  adminCapabilities(actorId = 'w00123', options: { orgPath?: string; subjectIds?: string[]; eventId?: string; includeProfiles?: boolean; page?: number; pageSize?: number; historyPage?: number; historyPageSize?: number } = {}): Record<string, unknown> {
    this.assertAdmin(actorId);
    const includeProfiles = options.includeProfiles !== false;
    const profilePage = options.page ?? 1;
    const profilePageSize = options.pageSize ?? 20;
    const historyPage = options.historyPage ?? 1;
    const historyPageSize = options.historyPageSize ?? 20;
    if (!Number.isSafeInteger(profilePage) || profilePage < 1) throw new BadRequestException('page must be a positive integer');
    if (!Number.isSafeInteger(profilePageSize) || profilePageSize < 1 || profilePageSize > 100) throw new BadRequestException('pageSize must be between 1 and 100');
    if (!Number.isSafeInteger(historyPage) || historyPage < 1) throw new BadRequestException('historyPage must be a positive integer');
    if (!Number.isSafeInteger(historyPageSize) || historyPageSize < 1 || historyPageSize > 100) throw new BadRequestException('historyPageSize must be between 1 and 100');
    const normalizedOrgPath = options.orgPath?.trim() || undefined;
    const normalizedEventId = options.eventId?.trim() || undefined;
    const requestedSubjectIds = [...new Set((options.subjectIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (requestedSubjectIds.length > 1000) throw new BadRequestException('subjectIds must contain at most 1000 ids');
    if (normalizedEventId) {
      const event = this.getEvent(normalizedEventId, actorId);
      if (event.purpose === 'HARD_PROBLEM') throw new BadRequestException('eventId must reference a training event');
    }
    const baseCandidates = this.listUsers(normalizedOrgPath, actorId).filter((user) => user.status === 'ACTIVE' && user.roles.includes('learner'));
    const eventSubjectIds = normalizedEventId
      ? new Set(this.systemSubmissions(normalizedEventId).map((submission) => submission.subjectId))
      : undefined;
    // In ALL mode the event view is intentionally limited to employees who
    // submitted in that training. Explicit selections remain valid even when
    // they have no result yet, so the administrator can see a pending/empty
    // profile instead of receiving a scope error.
    const candidates = requestedSubjectIds.length || !eventSubjectIds
      ? baseCandidates
      : baseCandidates.filter((user) => eventSubjectIds.has(user.id));
    const candidateById = new Map(baseCandidates.map((user) => [user.id, user]));
    const outsideScope = requestedSubjectIds.filter((subjectId) => !candidateById.has(subjectId));
    if (outsideScope.length) {
      throw new BadRequestException(`selected subjects are outside the requested organization scope: ${outsideScope.join(', ')}`);
    }
    const selected = requestedSubjectIds.length
      ? requestedSubjectIds.map((subjectId) => candidateById.get(subjectId)!).filter(Boolean)
      : candidates;
    const allProfiles = selected.map((subject) => ({
      subject,
      profile: this.capabilities(subject.id, { includeSealed: true, eventId: normalizedEventId, trendPage: historyPage, trendPageSize: historyPageSize }),
    }));
    const profiles = allProfiles.slice((profilePage - 1) * profilePageSize, profilePage * profilePageSize);
    const round = (value: number): number => Number(value.toFixed(2));
    const average = (values: number[]): number | null => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    const median = (values: number[]): number | null => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
    };
    const percentile = (value: number | null, values: number[]): number | null => value === null || !values.length ? null : round(100 * values.filter((item) => item <= value).length / values.length);
    type AggregateRow = { key: string; label: string; values: number[] };
    const dimensions = new Map<string, AggregateRow>();
    const domains = new Map<string, AggregateRow>();
    const skills = new Map<string, AggregateRow>();
    const dimensionLabels = new Map<string, string>();
    const domainLabels = new Map<string, string>();
    const skillLabels = new Map<string, string>();
    for (const item of allProfiles) {
      const profile = item.profile as { summary?: Record<string, unknown>; dimensions?: unknown; domains?: unknown };
      for (const raw of Array.isArray(profile.dimensions) ? profile.dimensions : []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const dimension = raw as Record<string, unknown>;
        if (typeof dimension.key !== 'string' || typeof dimension.label !== 'string') continue;
        dimensionLabels.set(dimension.key, dimension.label);
        if (typeof dimension.percent !== 'number') continue;
        const row = dimensions.get(dimension.key) ?? { key: dimension.key, label: dimension.label, values: [] };
        row.values.push(dimension.percent);
        dimensions.set(dimension.key, row);
      }
      for (const raw of Array.isArray(profile.domains) ? profile.domains : []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const domain = raw as Record<string, unknown>;
        if (typeof domain.key !== 'string' || typeof domain.label !== 'string') continue;
        domainLabels.set(domain.key, domain.label);
        if (typeof domain.percent !== 'number') continue;
        const row = domains.get(domain.key) ?? { key: domain.key, label: domain.label, values: [] };
        row.values.push(domain.percent);
        domains.set(domain.key, row);
      }
      const profileSkills = (profile as { skills?: unknown }).skills;
      for (const raw of Array.isArray(profileSkills) ? profileSkills : []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const skill = raw as Record<string, unknown>;
        if (typeof skill.criterionKey !== 'string' || typeof skill.name !== 'string') continue;
        const key = skill.criterionKey;
        skillLabels.set(key, skill.name);
        if (typeof skill.percent !== 'number') continue;
        const row = skills.get(key) ?? { key, label: skill.name, values: [] };
        row.values.push(skill.percent);
        skills.set(key, row);
      }
    }
    const aggregateRows = (rows: Map<string, AggregateRow>) => [...rows.values()].map((row) => ({
      key: row.key,
      label: row.label,
      percent: average(row.values),
      median: median(row.values),
      percentile: percentile(average(row.values), row.values),
      evaluatedUsers: row.values.length,
    }));
    const completeAggregateRows = (rows: Map<string, AggregateRow>, labels: Map<string, string>) => {
      const result = aggregateRows(rows);
      for (const [key, label] of labels) {
        if (!rows.has(key)) result.push({ key, label, percent: null, median: null, percentile: null, evaluatedUsers: 0 });
      }
      return result;
    };
    const gradedUsers = allProfiles.filter((item) => Number((item.profile as { summary?: { gradedSubmissions?: unknown } }).summary?.gradedSubmissions ?? 0) > 0).length;
    const overallValues = allProfiles
      .map((item) => (item.profile as { summary?: { overallAverage?: unknown } }).summary?.overallAverage)
      .filter((value): value is number => typeof value === 'number');
    const overallAverage = average(overallValues);
    return {
      generatedAt: now(),
      selection: {
        orgPath: normalizedOrgPath ?? null,
        eventId: normalizedEventId ?? null,
        mode: requestedSubjectIds.length ? 'SELECTED' : 'ALL',
        // Do not echo an unbounded employee roster.  Explicit selections are
        // capped above; ALL mode returns only the current profile page keys.
        subjectIds: requestedSubjectIds.length ? selected.map((subject) => subject.id) : profiles.map(({ subject }) => subject.id),
      },
      totalCandidates: candidates.length,
      selectedCount: selected.length,
      profilePageInfo: pageInfo(profilePage, profilePageSize, selected.length),
      gradedUsers,
      aggregate: {
        overallAverage,
        overallMedian: median(overallValues),
        overallPercentile: percentile(overallAverage, overallValues),
        dimensions: completeAggregateRows(dimensions, dimensionLabels),
        domains: completeAggregateRows(domains, domainLabels),
        skills: completeAggregateRows(skills, skillLabels),
      },
      profiles: includeProfiles ? profiles : [],
    };
  }

  private normalizeAccessPolicy(policy: EventConfig['accessPolicy']): EventConfig['accessPolicy'] | undefined {
    if (policy === undefined) return undefined;
    if (!policy || (policy.mode !== 'OPEN' && policy.mode !== 'RESTRICTED')) {
      throw new BadRequestException('accessPolicy.mode must be OPEN or RESTRICTED');
    }
    const ids = (value: unknown, label: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new BadRequestException(`accessPolicy.${label} must be an array of ids`);
      }
      return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
    };
    const subjectIds = ids(policy.subjectIds, 'subjectIds');
    const departmentIds = ids(policy.departmentIds, 'departmentIds');
    const mentorIds = ids(policy.mentorIds, 'mentorIds');
    for (const subjectId of subjectIds) {
      const user = this.getUser(subjectId);
      if (user.status !== 'ACTIVE') throw new BadRequestException(`access subject is not active: ${subjectId}`);
    }
    for (const departmentId of departmentIds) this.getOrgUnit(departmentId);
    for (const mentorId of mentorIds) {
      const user = this.getUser(mentorId);
      if (user.status !== 'ACTIVE') throw new BadRequestException(`mentor is not active: ${mentorId}`);
      if (!user.roles.includes('mentor')) throw new BadRequestException(`user is not a mentor: ${mentorId}`);
    }
    return { mode: policy.mode, subjectIds, departmentIds, mentorIds };
  }

  private assertAdminAccessPolicyScope(policy: EventConfig['accessPolicy'] | undefined, actorId: string): void {
    if (!policy) return;
    const access = this.resolveAdminAccess(actorId, true);
    if (access.level === 'GLOBAL') return;
    for (const departmentId of policy.departmentIds ?? []) {
      const department = this.getOrgUnit(departmentId);
      if (!access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, department.path))) {
        throw new ForbiddenException('training access includes a department outside the administrator organization scope');
      }
    }
    for (const subjectId of [...(policy.subjectIds ?? []), ...(policy.mentorIds ?? [])]) {
      const user = this.getUser(subjectId);
      if (!access.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, user.orgPath))) {
        throw new ForbiddenException('training access includes an employee outside the administrator organization scope');
      }
    }
  }

  private syncParticipantRecords(eventId: string, subjectIds: string[]): void {
    const next = subjectIds.map((subjectId) => {
      const user = this.getUser(subjectId);
      if (user.status !== 'ACTIVE') throw new BadRequestException(`participant is not active: ${subjectId}`);
      return { eventId, subjectId, orgPathSnapshot: user.orgPath, importedAt: now() } satisfies ParticipantRecord;
    });
    for (const key of [...this.participants.keys()]) if (key.startsWith(`${eventId}:`)) this.participants.delete(key);
    for (const participant of next) this.participants.set(`${eventId}:${participant.subjectId}`, participant);
  }

  private eventAudienceAllows(event: EventConfig, actorId: string): boolean {
    const user = this.getUser(actorId);
    if (user.status !== 'ACTIVE') return false;
    const policy = event.accessPolicy;
    if (policy?.mode === 'OPEN') return true;
    if (policy?.mode === 'RESTRICTED') {
      if (policy.subjectIds?.includes(actorId) || this.participants.has(`${event.id}:${actorId}`)) return true;
      if (policy.departmentIds?.some((departmentId) => {
        const department = this.orgUnits.get(departmentId);
        return department ? this.orgPathIncludes(department.path, user.orgPath) : false;
      })) return true;
      if (user.roles.includes('mentor')) return !policy.mentorIds?.length || policy.mentorIds.includes(actorId);
      return false;
    }
    return event.participantMode !== 'ALLOWLIST' || this.participants.has(`${event.id}:${actorId}`);
  }

  private eventVisibleTo(event: EventConfig, actorId: string): boolean {
    if (this.isAdmin(actorId)) return this.eventInAdminScope(event, actorId);
    const user = this.getUser(actorId);
    const challenge = [...this.challenges.values()].find((item) => item.versions.some((version) => version.id === event.challengeVersion));
    if (event.purpose === 'HARD_PROBLEM') return Boolean(challenge) && this.eventAudienceAllows(event, actorId);
    if (!challenge || (challenge.ownerOrgPath !== '/' && !this.orgPathIncludes(challenge.ownerOrgPath, user.orgPath))) return false;
    return this.eventAudienceAllows(event, actorId);
  }

  listEvents(actorId = 'w00123'): EventConfig[] {
    return [...this.events.values()].filter((event) => event.purpose !== 'HARD_PROBLEM' && this.eventVisibleTo(event, actorId));
  }

  getEvent(eventId: string, actorId?: string): EventConfig {
    const event = this.events.get(eventId);
    if (!event) throw new NotFoundException(`event not found: ${eventId}`);
    if (actorId && !this.eventVisibleTo(event, actorId)) throw new ForbiddenException('event is outside the actor organization or participant scope');
    return event;
  }

  listParticipants(eventId: string, actorId = 'w00123'): ParticipantRecord[] {
    const event = this.events.get(eventId);
    if (!event) throw new NotFoundException(`event not found: ${eventId}`);
    let legacyAdmin = false;
    try { this.resolveAdminAccess(actorId, true); legacyAdmin = true; } catch { /* employee access is checked below */ }
    if (legacyAdmin) this.assertAdminEventScope(event, actorId);
    else this.getEvent(eventId, actorId);
    return [...this.participants.values()].filter((participant) => participant.eventId === eventId).sort((a, b) => a.subjectId.localeCompare(b.subjectId));
  }

  replaceParticipants(eventId: string, subjectIds: string[], actorId = 'admin-local'): ParticipantRecord[] {
    const event = this.getEventForAdmin(eventId, actorId);
    if (event.status === 'RELEASED') throw new ConflictException('released event participant list is immutable');
    const uniqueIds = [...new Set(subjectIds.map((id) => id.trim()).filter(Boolean))];
    const access = this.resolveAdminAccess(actorId, true);
    if (access.level !== 'GLOBAL') {
      for (const subjectId of uniqueIds) {
        const subject = this.getUser(subjectId);
        this.assertAdminOrgScope(actorId, subject.orgPath);
      }
    }
    this.syncParticipantRecords(eventId, uniqueIds);
    const next = this.listParticipants(eventId, actorId);
    event.participantMode = 'ALLOWLIST';
    event.accessPolicy = this.normalizeAccessPolicy({
      ...(event.accessPolicy ?? { mode: 'RESTRICTED' as const }),
      mode: 'RESTRICTED',
      subjectIds: uniqueIds,
    });
    this.audit(actorId, 'event.participants.replace', `event:${eventId}`, undefined, { count: next.length, participants: next });
    this.persist();
    return next;
  }

  importParticipants(eventId: string, rows: Array<{ subjectId: string }>, actorId = 'admin-local'): ParticipantRecord[] {
    const current = new Set(this.listParticipants(eventId, actorId).map((participant) => participant.subjectId));
    for (const row of rows) current.add(row.subjectId);
    return this.replaceParticipants(eventId, [...current], actorId);
  }

  createEvent(input: Omit<EventConfig, 'status'> & { status?: EventConfig['status'] }, actorId = 'admin-local'): EventConfig {
    const challenge = this.challengeForVersion(input.challengeVersion);
    this.assertAdminChallengeScope(challenge, actorId);
    if (!input.id || !input.challengeVersion) throw new BadRequestException('event id and challengeVersion are required');
    if (this.events.has(input.id)) throw new ConflictException(`event already exists: ${input.id}`);
    const challengeVersion = this.getChallengeVersion(input.challengeVersion);
    if (challengeVersion.status !== 'PUBLISHED') throw new BadRequestException(`challenge version is not published: ${input.challengeVersion}`);
    const allowedSources: SubmissionSource[] = Array.isArray(challengeVersion.deliveryPolicy.allowedSources)
      ? challengeVersion.deliveryPolicy.allowedSources.filter((source): source is SubmissionSource => source === 'UPLOAD' || source === 'GIT_REF')
      : [];
    if (allowedSources.length && !allowedSources.includes(input.submissionSource)) {
      throw new BadRequestException(`challenge version does not allow source: ${input.submissionSource}`);
    }
    if (input.mode === 'WINDOW' && input.startsAt && input.endsAt && input.startsAt >= input.endsAt) {
      throw new BadRequestException('event startsAt must be before endsAt');
    }
    const deliveryConfig = { ...input.deliveryConfig };
    if (input.submissionSource === 'GIT_REF' && (!deliveryConfig.repository || (!deliveryConfig.branch && !deliveryConfig.branchTemplate))) {
      throw new BadRequestException('GIT_REF events require a configured repository and branch or branchTemplate');
    }
    if (deliveryConfig.branch && deliveryConfig.branchTemplate) {
      throw new BadRequestException('configure either branch or branchTemplate, not both');
    }
    if (input.trigger === 'AUTO' && deliveryConfig.pinAt === 'DEADLINE') {
      throw new BadRequestException('AUTO events must pin Git snapshots at SUBMIT');
    }
    if (input.trigger === 'AUTO' && !deliveryConfig.pinAt) deliveryConfig.pinAt = 'SUBMIT';
    // The challenge version owns its executor, so a session cannot be created
    // with a trigger the engine cannot serve. Rejecting here beats accepting
    // the session and only failing when an administrator presses "evaluate".
    assertTriggerMatchesEngine(evaluationEngineForVersion(challengeVersion), input.trigger);
    const accessPolicy = this.normalizeAccessPolicy(input.accessPolicy);
    this.assertAdminAccessPolicyScope(accessPolicy, actorId);
    const { localGrading: _legacyLocalGrading, ...eventInput } = input;
    const event: EventConfig = {
      ...eventInput,
      ...(accessPolicy ? { accessPolicy, participantMode: accessPolicy.mode === 'RESTRICTED' ? 'ALLOWLIST' : 'OPEN' } : {}),
      deliveryConfig,
      status: input.status ?? 'OPEN',
    };
    this.events.set(event.id, event);
    if (accessPolicy?.mode === 'RESTRICTED') this.syncParticipantRecords(event.id, accessPolicy.subjectIds ?? []);
    this.audit(actorId, 'event.create', `event:${event.id}`, undefined, event);
    this.persist();
    return event;
  }

  updateEvent(eventId: string, patch: Partial<Omit<EventConfig, 'id' | 'status'>>, actorId = 'admin-local'): EventConfig {
    const event = this.getEventForAdmin(eventId, actorId);
    if (event.status === 'RELEASED') throw new ConflictException('released event cannot be edited');
    const before = { ...event };
    const eventSubmissions = [...this.submissions.values()].filter((submission) => submission.eventId === eventId);
    if (eventSubmissions.length && patch.challengeVersion !== undefined && patch.challengeVersion !== event.challengeVersion) {
      throw new ConflictException('训战已有提交，赛题版本已锁定');
    }
    if (eventSubmissions.length && patch.rubricVersion !== undefined && patch.rubricVersion !== event.rubricVersion) {
      throw new ConflictException('训战已有提交，评分标准版本已锁定');
    }
    let nextAccessPolicy = event.accessPolicy;
    if (patch.accessPolicy !== undefined) {
      const legacySubjectIds = event.participantMode === 'ALLOWLIST' ? this.listParticipants(eventId, actorId).map((participant) => participant.subjectId) : [];
      const basePolicy = event.accessPolicy ?? { mode: event.participantMode === 'ALLOWLIST' ? 'RESTRICTED' as const : 'OPEN' as const, subjectIds: legacySubjectIds };
      nextAccessPolicy = this.normalizeAccessPolicy({ ...basePolicy, ...patch.accessPolicy });
      this.assertAdminAccessPolicyScope(nextAccessPolicy, actorId);
    }
    const next = {
      ...event,
      ...patch,
      deliveryConfig: { ...event.deliveryConfig, ...patch.deliveryConfig },
      ...(patch.accessPolicy !== undefined && nextAccessPolicy ? { accessPolicy: nextAccessPolicy, participantMode: nextAccessPolicy.mode === 'RESTRICTED' ? 'ALLOWLIST' as const : 'OPEN' as const } : {}),
    };
    if (next.trigger === 'AUTO' && next.deliveryConfig?.pinAt === 'DEADLINE') {
      throw new BadRequestException('AUTO events must pin Git snapshots at SUBMIT');
    }
    if (next.trigger === 'AUTO' && !next.deliveryConfig?.pinAt) next.deliveryConfig = { ...next.deliveryConfig, pinAt: 'SUBMIT' };
    if (next.submissionSource === 'GIT_REF' && (!next.deliveryConfig?.repository || (!next.deliveryConfig.branch && !next.deliveryConfig.branchTemplate))) {
      throw new BadRequestException('GIT_REF events require a configured repository and branch or branchTemplate');
    }
    if (next.deliveryConfig?.branch && next.deliveryConfig.branchTemplate) {
      throw new BadRequestException('configure either branch or branchTemplate, not both');
    }
    const challengeVersion = this.getChallengeVersion(next.challengeVersion);
    this.assertAdminChallengeScope(this.challengeForVersion(challengeVersion.id), actorId);
    const allowedSources: SubmissionSource[] = Array.isArray(challengeVersion.deliveryPolicy.allowedSources)
      ? challengeVersion.deliveryPolicy.allowedSources.filter((source): source is SubmissionSource => source === 'UPLOAD' || source === 'GIT_REF')
      : [];
    if (allowedSources.length && !allowedSources.includes(next.submissionSource)) {
      throw new BadRequestException(`challenge version does not allow source: ${next.submissionSource}`);
    }
    if (next.mode === 'WINDOW' && next.startsAt && next.endsAt && next.startsAt >= next.endsAt) {
      throw new BadRequestException('event startsAt must be before endsAt');
    }
    assertTriggerMatchesEngine(evaluationEngineForVersion(challengeVersion), next.trigger);
    const { localGrading: _legacyLocalGrading, ...eventPatch } = patch;
    Object.assign(event, {
      ...eventPatch,
      deliveryConfig: next.deliveryConfig,
      ...(patch.accessPolicy !== undefined && nextAccessPolicy ? { accessPolicy: nextAccessPolicy, participantMode: nextAccessPolicy.mode === 'RESTRICTED' ? 'ALLOWLIST' as const : 'OPEN' as const } : {}),
    });
    if (patch.accessPolicy !== undefined && nextAccessPolicy?.mode === 'RESTRICTED') this.syncParticipantRecords(eventId, nextAccessPolicy.subjectIds ?? []);
    this.audit(actorId, 'event.update', `event:${eventId}`, before, event);
    this.persist();
    return event;
  }

  /**
   * Delete an unused training event. Submissions are immutable evidence and
   * therefore make the event non-deletable; released events and the system
   * managed hard-problem delivery entry point are immutable as well.
   */
  deleteEvent(eventId: string, actorId = 'admin-local'): void {
    const event = this.getEventForAdmin(eventId, actorId);
    if (event.purpose === 'HARD_PROBLEM') throw new ConflictException('难题榜交付入口由系统管理，不能删除');
    if (event.status === 'RELEASED') throw new ConflictException('已公布训战不能删除');
    const submissionCount = [...this.submissions.values()].filter((submission) => submission.eventId === eventId).length;
    if (submissionCount) throw new ConflictException('训战已有提交，不能删除；请保留训战记录');

    const before = { ...event };
    this.events.delete(eventId);
    for (const key of [...this.participants.keys()]) {
      if (key.startsWith(`${eventId}:`)) this.participants.delete(key);
    }
    // A season only stores event ids as a projection. Remove the deleted
    // event from every season before the normalized repository is synced.
    for (const season of this.seasons.values()) {
      season.eventIds = season.eventIds.filter((id) => id !== eventId);
    }
    this.localDemoSeedEnabled = false;
    this.audit(actorId, 'event.delete', `event:${eventId}`, before, undefined);
    this.persist();
  }

  createSubmission(eventId: string, subjectId: string, snapshot: SubmissionSnapshot): SubmissionRecord {
    const event = this.getEvent(eventId);
    if (event.status !== 'OPEN') throw new ConflictException(`event ${eventId} is not open`);
    assertEventSubmissionWindow(event);
    if (!subjectId) throw new BadRequestException('subjectId is required');
    const subject = this.getUser(subjectId);
    if (subject.status !== 'ACTIVE') throw new ForbiddenException('subject is disabled');
    if (!this.eventAudienceAllows(event, subjectId)) throw new ForbiddenException('subject is not configured for this training event');
    const submittedAt = Date.parse(snapshot.submittedAt);
    if (!Number.isFinite(submittedAt)) throw new BadRequestException('submittedAt must be an ISO date-time');
    if (event.startsAt && submittedAt < Date.parse(event.startsAt)) throw new BadRequestException('submission is before event start');
    if (event.endsAt && submittedAt > Date.parse(event.endsAt)) throw new BadRequestException('submission is after event end');
    if (event.submissionSource !== snapshot.sourceType) {
      throw new BadRequestException(`event ${eventId} accepts ${event.submissionSource}, got ${snapshot.sourceType}`);
    }
    if (!/^[a-f0-9]{64}$/.test(snapshot.snapshotHash)) {
      throw new BadRequestException('snapshotHash must be a lowercase SHA-256 hash');
    }
    if (snapshot.sourceType === 'GIT_REF' && (!snapshot.repository || !snapshot.branch || (event.deliveryConfig?.pinAt !== 'DEADLINE' && !snapshot.commitSha))) {
      throw new BadRequestException(event.deliveryConfig?.pinAt === 'DEADLINE' ? 'GIT_REF requires repository and branch before deadline pinning' : 'GIT_REF requires repository, branch and commitSha');
    }
    if (snapshot.sourceType === 'GIT_REF') {
      if (snapshot.commitSha && !/^[a-f0-9]{7,64}$/.test(snapshot.commitSha)) throw new BadRequestException('commitSha must be a lowercase hexadecimal SHA');
      const configuredRepository = event.deliveryConfig?.repository;
      if (configuredRepository && snapshot.repository !== configuredRepository) {
        throw new BadRequestException(`repository must match event deliveryConfig.repository: ${configuredRepository}`);
      }
      const configuredBranch = event.deliveryConfig?.branch ?? event.deliveryConfig?.branchTemplate?.replace('{subjectId}', subjectId);
      if (configuredBranch && snapshot.branch !== configuredBranch) {
        throw new BadRequestException(`branch must match event branchTemplate: ${configuredBranch}`);
      }
    }
    if (snapshot.sourceType === 'UPLOAD' && !snapshot.artifactHash) {
      throw new BadRequestException('UPLOAD requires artifactHash');
    }
    const duplicate = [...this.submissions.values()].find(
      (item) => item.eventId === eventId && item.subjectId === subjectId && item.snapshot.snapshotHash === snapshot.snapshotHash,
    );
    if (duplicate) return duplicate;
    this.assertSubmissionEvaluationUnlocked(eventId, subjectId);
    const challengeVersionSnapshot = event.challengeVersion;
    const challengeVersion = this.getChallengeVersion(challengeVersionSnapshot);
    const submission: SubmissionRecord = {
      id: `sub-${randomUUID()}`,
      eventId,
      subjectId,
      orgPathSnapshot: subject.orgPath,
      snapshot,
      challengeVersionSnapshot,
      rubricVersionSnapshot: event.rubricVersion ?? challengeVersion.rubricVersion ?? '1.0',
      state: event.trigger === 'AUTO' ? 'QUEUED' : event.trigger === 'MANUAL' ? 'WAITING_TRIGGER' : 'WAITING_IMPORT',
      createdAt: now(),
      gradingAttempt: 1,
      gradingStatus: event.trigger === 'AUTO' ? 'QUEUED' : 'PENDING',
    };
    this.submissions.set(submission.id, submission);
    if (event.trigger === 'AUTO') this.createRun(submission, 'AUTO', 'system');
    this.audit(subjectId, 'submission.create', `submission:${submission.id}`, undefined, submission);
    this.persist();
    return this.submissions.get(submission.id)!;
  }

  /**
   * Once a participant's submission has entered the evaluation queue, the
   * participant cannot replace it by creating another submission in the same
   * event.  Keep this check in the domain store so every upload path (JSON,
   * two-phase object upload, and Git registration) observes the same rule.
   * A retry of the exact same snapshot is handled by the idempotency check in
   * createSubmission before this guard is reached.
   */
  private assertSubmissionEvaluationUnlocked(eventId: string, subjectId: string): void {
    for (const submission of this.submissions.values()) {
      if (submission.eventId !== eventId || submission.subjectId !== subjectId) continue;
      this.syncSubmissionLifecycle(submission);
      const run = submission.gradingRunId ? this.runs.get(submission.gradingRunId) : undefined;
      const active = run ? ['QUEUED', 'RUNNING'].includes(run.status) : ['QUEUED', 'RUNNING'].includes(submission.gradingStatus ?? '');
      if (active) {
        throw new ConflictException({
          code: 'SUBMISSION_EVALUATION_LOCKED',
          message: '该训战已有提交正在评测，请等待评测完成后再提交新的作品',
        });
      }
    }
  }

  /** Validate the subject/participant boundary before a multipart or artifact payload is processed. */
  assertSubmissionSubject(eventId: string, subjectId: string): void {
    const event = this.getEvent(eventId);
    if (event.status !== 'OPEN') throw new ConflictException(`event ${eventId} is not open`);
    const subject = this.getUser(subjectId);
    if (subject.status !== 'ACTIVE') throw new ForbiddenException('subject is disabled');
    if (!this.eventAudienceAllows(event, subjectId)) throw new ForbiddenException('subject is not configured for this training event');
  }

  getSubmission(submissionId: string): SubmissionRecord {
    const submission = this.submissions.get(submissionId);
    if (!submission) throw new NotFoundException(`submission not found: ${submissionId}`);
    this.syncSubmissionLifecycle(submission);
    return submission;
  }

  pinGitSnapshot(submissionId: string, pinned: Pick<SubmissionSnapshot, 'commitSha' | 'artifactUri' | 'artifactHash' | 'snapshotHash'>, actorId = 'admin-local'): SubmissionRecord {
    const submission = this.getSubmission(submissionId);
    this.assertAdminEventScope(this.getEvent(submission.eventId), actorId);
    if (submission.snapshot.sourceType !== 'GIT_REF') throw new BadRequestException('only GIT_REF submissions can be pinned');
    if (submission.resultId || submission.gradingRunId) throw new ConflictException('graded or queued submission cannot be repinned');
    if (!pinned.commitSha || !pinned.artifactUri || !pinned.artifactHash || !/^[a-f0-9]{64}$/.test(pinned.snapshotHash)) {
      throw new BadRequestException('pinned Git snapshot is incomplete');
    }
    const before = { ...submission.snapshot };
    submission.snapshot = { ...submission.snapshot, ...pinned };
    this.audit(actorId, 'submission.pin', `submission:${submission.id}`, before, submission.snapshot);
    this.persist();
    return submission;
  }

  /**
   * Reserve an exact set of IMPORT submissions for an external evaluator and
   * return the immutable input manifest consumed by the evaluator CLI.
   */
  prepareEvaluationInput(eventId: string, submissionIds: string[], actorId: string): EvaluationInputBatch {
    const event = this.getEventForAdmin(eventId, actorId);
    if (event.trigger !== 'IMPORT') throw new BadRequestException('external evaluation input requires an IMPORT event');
    const uniqueIds = [...new Set((submissionIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (!uniqueIds.length) throw new BadRequestException('at least one submission must be selected');
    if (uniqueIds.length > 500) throw new BadRequestException('at most 500 submissions can be prepared at once');
    const visible = new Map(this.listSubmissions(eventId, actorId).map((submission) => [submission.id, submission]));
    const inaccessible = uniqueIds.filter((id) => !visible.has(id));
    if (inaccessible.length) throw new BadRequestException('selected submissions are outside this event or administrator scope');
    const prepared = uniqueIds.map((submissionId) => {
      const submission = visible.get(submissionId)!;
      if (submission.resultId) throw new ConflictException(`submission already has an evaluation result: ${submission.id}`);
      const challengeVersionId = this.submissionChallengeVersion(submission);
      const version = this.getChallengeVersion(challengeVersionId);
      const challenge = this.challengeForVersion(challengeVersionId);
      const engine = evaluationEngineForVersion(version);
      validateEvaluationEngine(engine);
      const rubricVersion = this.submissionRubricVersion(submission);
      const expectedKey = idempotencyKey(
        submission.snapshot.snapshotHash,
        challengeVersionId,
        rubricVersion,
        this.engineIdentity(engine),
        submission.gradingAttempt ?? 1,
      );
      let run = submission.gradingRunId ? this.runs.get(submission.gradingRunId) : undefined;
      if (run && (run.submissionId !== submission.id || run.triggerType !== 'IMPORT')) {
        throw new ConflictException(`submission is already assigned to another evaluation run: ${submission.id}`);
      }
      if (run && run.status === 'GRADED') throw new ConflictException(`submission already has an evaluation run: ${submission.id}`);
      if (run && run.status === 'FAILED') run = undefined;
      if (run && run.idempotencyKey !== expectedKey) throw new ConflictException(`submission evaluation contract changed: ${submission.id}`);
      if (!run) {
        const runId = createHash('sha256').update(`${submission.id}|${expectedKey}`).digest('hex').slice(0, 40);
        run = {
          id: `import-${runId}`,
          submissionId: submission.id,
          triggerType: 'IMPORT',
          triggeredBy: actorId,
          status: 'QUEUED',
          idempotencyKey: expectedKey,
          createdAt: now(),
          attempt: submission.gradingAttempt ?? 1,
        };
        this.runs.set(run.id, run);
        submission.gradingRunId = run.id;
        submission.state = 'WAITING_IMPORT';
        this.audit(actorId, 'grading.prepare-import', `run:${run.id}`, undefined, { submissionId: submission.id, eventId });
      }
      submission.gradingStatus = 'QUEUED';
      submission.failureReason = undefined;
      const subject = this.getUser(submission.subjectId);
      return {
        submissionId: submission.id,
        subject: { id: subject.id, name: subject.name, orgPath: submission.orgPathSnapshot ?? subject.orgPath },
        snapshot: { ...submission.snapshot },
        grading: { runId: run.id, idempotencyKey: run.idempotencyKey, triggerType: 'IMPORT' as const },
      };
    });
    this.persist();
    return {
      schemaVersion: '1.0',
      generatedAt: now(),
      event: {
        id: event.id,
        challengeVersion: event.challengeVersion,
        rubricVersion: event.rubricVersion ?? this.getChallengeVersion(event.challengeVersion).rubricVersion ?? '1.0',
        trigger: 'IMPORT',
        submissionSource: event.submissionSource,
        reveal: event.reveal,
      },
      // Executor selection, parameters and package binding are in-platform
      // execution configuration; an external evaluator receives the engine's
      // identity and contracts, not the paths the platform would run.
      challenge: (({ local: _local, executor: _executor, package: _package, agent: _agent, ...engine }) => ({
        id: this.challengeForVersion(event.challengeVersion).id,
        title: this.getChallengeVersion(event.challengeVersion).title,
        version: this.getChallengeVersion(event.challengeVersion).version,
        // This endpoint is the external evaluator manifest even when the same
        // challenge also has an online engine. Its input contract therefore
        // follows the IMPORT flow, not the challenge's online batch protocol.
        evaluationEngine: { ...engine, input: { ...EXTERNAL_EVALUATION_INPUT_CONTRACT } },
      }))(evaluationEngineForVersion(this.getChallengeVersion(event.challengeVersion))),
      submissions: prepared,
    };
  }

  /**
   * Every submission, without an authorization filter. Platform-internal jobs
   * and aggregate statistics must use this: routing them through
   * `listSubmissions` made them depend on the seeded `w00123` account, so they
   * silently returned nothing on a deployment whose users come from SSO.
   * Never return the result of this method directly to an HTTP caller.
   */
  systemSubmissions(eventId?: string): SubmissionRecord[] {
    for (const submission of this.submissions.values()) this.syncSubmissionLifecycle(submission);
    return [...this.submissions.values()]
      .filter((item) => !eventId || item.eventId === eventId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listAuditsPage(query: AuditListQuery = {}, actorId = 'w00123'): AuditPage {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('page must be a positive integer');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('pageSize must be between 1 and 100');
    const items = this.listAudits(query.target, actorId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { items: items.slice((page - 1) * pageSize, page * pageSize), pageInfo: pageInfo(page, pageSize, items.length) };
  }

  listSubmissions(eventId?: string, actorId = 'w00123'): SubmissionRecord[] {
    for (const submission of this.submissions.values()) this.syncSubmissionLifecycle(submission);
    let adminAccess: AdminAccess | undefined;
    try { adminAccess = this.resolveAdminAccess(actorId, true); } catch { /* employee listing below */ }
    const admin = Boolean(adminAccess);
    return [...this.submissions.values()]
      .filter((item) => {
        if (eventId && item.eventId !== eventId) return false;
        if (!admin) return item.subjectId === actorId;
        const event = this.events.get(item.eventId);
        if (!event || (adminAccess?.level !== 'GLOBAL' && !this.eventInAdminScope(event, actorId))) return false;
        if (!adminAccess || adminAccess.level === 'GLOBAL') return true;
        const subject = this.users.get(item.subjectId);
        return Boolean(subject && adminAccess.scopeOrgPaths.some((scope) => this.orgPathIncludes(scope, subject.orgPath)));
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Resolve the administrator download button to the newest ZIP that the
   * platform successfully accepted for the same participant and event. The
   * exact submission artifact endpoint remains separate for Worker grading.
   */
  latestSuccessfulUploadSubmission(submissionId: string, actorId = 'w00123'): SubmissionRecord {
    this.assertCanViewSubmission(actorId, submissionId);
    const reference = this.getSubmission(submissionId);
    const latest = this.listSubmissions(reference.eventId, actorId)
      .filter((candidate) => candidate.subjectId === reference.subjectId
        && candidate.snapshot.sourceType === 'UPLOAD'
        && Boolean(candidate.snapshot.artifactUri)
        && Boolean(candidate.snapshot.artifactHash))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    if (!latest) throw new NotFoundException('该学员暂无可下载的交付件');
    return latest;
  }

  listSubmissionsPage(query: SubmissionListQuery = {}, actorId = 'w00123'): SubmissionPage {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('page must be a positive integer');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('pageSize must be between 1 and 100');
    const items = this.listSubmissions(query.eventId, actorId)
      .filter((item) => (!query.subjectId || item.subjectId === query.subjectId) && (!query.state || item.state === query.state))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    const pageItems = items.slice((page - 1) * pageSize, page * pageSize).map((submission): SubmissionListItem => {
      if (!submission.resultId) return submission;
      const event = this.getEvent(submission.eventId);
      if (event.reveal === 'ON_RELEASE' && submission.state !== 'REVEALED') return submission;
      const stored = this.results.get(submission.resultId);
      const result = stored?.result as { total?: unknown; recalculatedTotal?: unknown; status?: unknown } | undefined;
      const total = typeof result?.recalculatedTotal === 'number' ? result.recalculatedTotal : result?.total;
      if (!stored || typeof total !== 'number' || !Number.isFinite(total)) return submission;
      return {
        ...submission,
        resultSummary: {
          resultId: stored.resultId,
          total,
          status: typeof result?.status === 'string' ? result.status : 'COMPLETE',
          published: true,
        },
      };
    });
    return { items: pageItems, pageInfo: pageInfo(page, pageSize, items.length) };
  }

  startGrading(submissionId: string, actorId: string): GradingRun {
    const submission = this.getSubmission(submissionId);
    const event = this.getEvent(submission.eventId);
    this.assertAdminEventScope(event, actorId);
    if (event.trigger !== 'MANUAL') {
      throw new BadRequestException(`manual trigger is not allowed for ${event.trigger} event`);
    }
    if (!['WAITING_TRIGGER', 'RECEIVED'].includes(submission.state)) {
      if (submission.gradingRunId) return this.getRun(submission.gradingRunId);
      throw new ConflictException(`submission cannot be graded from state ${submission.state}`);
    }
    return this.createRun(submission, 'MANUAL', actorId);
  }

  startEventGrading(eventId: string, actorId: string, submissionIds?: string[]): GradingRun[] {
    const event = this.getEventForAdmin(eventId, actorId);
    if (event.trigger !== 'MANUAL') throw new BadRequestException(`event trigger is ${event.trigger}, not MANUAL`);
    const available = this.listSubmissions(eventId, actorId);
    const selectedIds = submissionIds === undefined ? undefined : [...new Set(submissionIds.map((id) => String(id).trim()).filter(Boolean))];
    if (selectedIds && !selectedIds.length) throw new BadRequestException('at least one submission must be selected');
    if (selectedIds) {
      const availableIds = new Set(available.map((submission) => submission.id));
      if (selectedIds.some((id) => !availableIds.has(id))) throw new BadRequestException('selected submissions are outside this event or administrator scope');
    }
    const selected = selectedIds
      ? selectedIds.map((id) => available.find((submission) => submission.id === id)!)
      : available;
    return selected.filter((submission) => ['WAITING_TRIGGER', 'RECEIVED'].includes(submission.state)).map((submission) => this.startGrading(submission.id, actorId));
  }

  /**
   * Start a new evaluation attempt against the same immutable delivery. The
   * previous result/run remains in storage for audit and report history; only
   * the submission's current pointer is advanced to the new attempt.
   */
  regradeSubmission(submissionId: string, actorId: string): { submission: SubmissionRecord; run?: GradingRun } {
    const submission = this.getSubmission(submissionId);
    const event = this.getEvent(submission.eventId);
    this.assertAdminEventScope(event, actorId);
    if (!submission.resultId && !submission.failureReason) {
      throw new ConflictException('只有已完成或失败的提交可以重新评估');
    }
    const previousResultId = submission.resultId;
    const previousRunId = submission.gradingRunId;
    if (previousResultId) submission.previousResultIds = [...new Set([...(submission.previousResultIds ?? []), previousResultId])];
    submission.resultId = undefined;
    submission.gradingRunId = undefined;
    submission.gradingAttempt = (submission.gradingAttempt ?? 1) + 1;
    submission.failureReason = undefined;
    submission.gradingStatus = event.trigger === 'AUTO' ? 'QUEUED' : 'PENDING';
    let run: GradingRun | undefined;
    if (event.trigger === 'AUTO') {
      run = this.createRun(submission, 'AUTO', actorId);
    } else {
      submission.state = event.trigger === 'IMPORT' ? 'WAITING_IMPORT' : 'WAITING_TRIGGER';
    }
    this.audit(actorId, 'grading.regrade', `submission:${submission.id}`, { previousResultId, previousRunId }, { attempt: submission.gradingAttempt, trigger: event.trigger });
    this.persist();
    return { submission, ...(run ? { run } : {}) };
  }

  regradeEvent(eventId: string, actorId: string, submissionIds?: string[]): { submissions: SubmissionRecord[]; runs: GradingRun[] } {
    const event = this.getEventForAdmin(eventId, actorId);
    const available = this.listSubmissions(eventId, actorId);
    const selectedIds = submissionIds === undefined ? undefined : [...new Set(submissionIds.map((id) => String(id).trim()).filter(Boolean))];
    if (selectedIds && !selectedIds.length) throw new BadRequestException('at least one submission must be selected');
    if (selectedIds) {
      const availableIds = new Set(available.map((submission) => submission.id));
      if (selectedIds.some((id) => !availableIds.has(id))) throw new BadRequestException('selected submissions are outside this event or administrator scope');
    }
    const selected = available.filter((submission) => !selectedIds || selectedIds.includes(submission.id));
    const submissions: SubmissionRecord[] = [];
    const runs: GradingRun[] = [];
    for (const submission of selected) {
      if (!submission.resultId && !submission.failureReason) continue;
      const result = this.regradeSubmission(submission.id, actorId);
      submissions.push(result.submission);
      if (result.run) runs.push(result.run);
    }
    if (!submissions.length) throw new ConflictException('没有可重新评估的提交');
    return { submissions, runs };
  }

  private createRun(submission: SubmissionRecord, triggerType: TriggerType, actorId?: string): GradingRun {
    if (submission.gradingRunId) return this.getRun(submission.gradingRunId);
    const challengeVersion = this.submissionChallengeVersion(submission);
    const rubricVersion = this.submissionRubricVersion(submission);
    // All three triggers key on the same engine identity, so bumping the
    // engine version invalidates cached results consistently instead of only
    // on the external-evaluation path.
    const graderVersion = this.engineIdentity(this.evaluationEngineForSubmission(submission));
    const run: GradingRun = {
      id: `run-${randomUUID()}`,
      submissionId: submission.id,
      triggerType,
      triggeredBy: actorId,
      status: 'QUEUED',
      idempotencyKey: idempotencyKey(submission.snapshot.snapshotHash, challengeVersion, rubricVersion, graderVersion, submission.gradingAttempt ?? 1),
      createdAt: now(),
      attempt: submission.gradingAttempt ?? 1,
    };
    submission.gradingRunId = run.id;
    submission.state = 'QUEUED';
    submission.gradingStatus = 'QUEUED';
    submission.failureReason = undefined;
    this.runs.set(run.id, run);
    this.audit(actorId ?? 'system', 'grading.enqueue', `run:${run.id}`, undefined, run);
    this.persist();
    return run;
  }

  /** Every run, unfiltered. Platform-internal task scheduling only. */
  systemRuns(): GradingRun[] {
    return [...this.runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Freeze an exact, same-event set of queued runs into one Code Agent job. */
  createEvaluationBatch(runIds: string[], actorId: string): EvaluationBatch {
    const uniqueRunIds = [...new Set((runIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
    if (!uniqueRunIds.length) throw new BadRequestException('at least one grading run must be selected');
    if (uniqueRunIds.length > 500) throw new BadRequestException('at most 500 grading runs can be evaluated in one batch');
    const runs = uniqueRunIds.map((id) => this.getRun(id));
    const submissions = runs.map((run) => this.getSubmission(run.submissionId));
    const eventIds = new Set(submissions.map((submission) => submission.eventId));
    const challengeVersions = new Set(submissions.map((submission) => this.submissionChallengeVersion(submission)));
    if (eventIds.size !== 1 || challengeVersions.size !== 1) {
      throw new BadRequestException('an evaluation batch must contain one training event and one challenge version');
    }
    const eventId = [...eventIds][0];
    const event = this.getEvent(eventId);
    if (actorId !== 'system') this.assertAdminEventScope(event, actorId);
    const engine = this.evaluationEngineForSubmission(submissions[0]);
    if (engine.mode !== 'PLATFORM_LOCAL' && engine.mode !== 'PACKAGED') {
      throw new BadRequestException({ code: 'ENGINE_NOT_RUNNABLE', message: '该赛题仅支持线下评测结果录入' });
    }
    const engineIdentity = engineIdentityOf(engine);
    for (const [index, run] of runs.entries()) {
      if (run.status !== 'QUEUED') throw new ConflictException(`grading run cannot enter a batch from state ${run.status}`);
      if (engineIdentityOf(this.evaluationEngineForSubmission(submissions[index])) !== engineIdentity) {
        throw new BadRequestException('an evaluation batch cannot mix evaluation engines');
      }
      if (run.evaluationBatchId) {
        const existingOwner = this.evaluationBatches.get(run.evaluationBatchId);
        if (existingOwner && ['QUEUED', 'RUNNING'].includes(existingOwner.status)) {
          throw new ConflictException(`grading run already belongs to evaluation batch ${existingOwner.id}`);
        }
      }
    }
    const batchId = `batch-${createHash('sha256').update(uniqueRunIds.slice().sort().join('|')).digest('hex').slice(0, 32)}`;
    const existing = this.evaluationBatches.get(batchId);
    if (existing) return existing;
    const batch: EvaluationBatch = {
      id: batchId,
      eventId,
      challengeVersion: [...challengeVersions][0],
      runIds: uniqueRunIds,
      submissionIds: submissions.map((submission) => submission.id),
      engineIdentity,
      ...(this.codeAgentRuntimeConfig.enabled ? {
        codeAgentRuntime: {
          schemaVersion: this.codeAgentRuntimeConfig.schemaVersion,
          executable: this.codeAgentRuntimeConfig.executable,
          args: [...this.codeAgentRuntimeConfig.args],
          prompt: this.codeAgentRuntimeConfig.prompt,
          timeoutSeconds: this.codeAgentRuntimeConfig.timeoutSeconds,
          configHash: this.codeAgentRuntimeConfig.configHash,
        },
      } : {}),
      status: 'QUEUED',
      createdBy: actorId,
      createdAt: now(),
      completedRunIds: [],
      failedRunIds: [],
    };
    for (const run of runs) run.evaluationBatchId = batch.id;
    this.evaluationBatches.set(batch.id, batch);
    this.audit(actorId, 'grading.batch-create', `evaluation-batch:${batch.id}`, undefined, {
      eventId,
      runIds: uniqueRunIds,
      engineIdentity,
      codeAgentConfigHash: batch.codeAgentRuntime?.configHash,
    });
    this.persist();
    return batch;
  }

  getEvaluationBatch(batchId: string): EvaluationBatch {
    const batch = this.evaluationBatches.get(batchId);
    if (!batch) throw new NotFoundException(`evaluation batch not found: ${batchId}`);
    return batch;
  }

  systemEvaluationBatches(): EvaluationBatch[] {
    return [...this.evaluationBatches.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listEvaluationBatches(actorId: string, eventId?: string): EvaluationBatch[] {
    this.assertAdmin(actorId);
    return [...this.evaluationBatches.values()]
      .filter((batch) => !eventId || batch.eventId === eventId)
      .filter((batch) => {
        try { this.assertAdminEventScope(this.getEvent(batch.eventId), actorId); return true; } catch { return false; }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  assertEvaluationBatchScope(batchId: string, actorId: string): void {
    const batch = this.getEvaluationBatch(batchId);
    this.assertAdminEventScope(this.getEvent(batch.eventId), actorId);
  }

  assertGradingRunScope(runId: string, actorId: string): void {
    const submission = this.getSubmission(this.getRun(runId).submissionId);
    this.assertAdminEventScope(this.getEvent(submission.eventId), actorId);
  }

  acquireEvaluationBatchLease(batchId: string, workerId: string, leaseSeconds: number): { leaseId: string; leaseExpiresAt: string } {
    const batch = this.getEvaluationBatch(batchId);
    if (batch.status !== 'QUEUED') throw new ConflictException(`evaluation batch cannot be leased from state ${batch.status}`);
    const runs = batch.runIds.map((runId) => this.getRun(runId));
    if (runs.some((run) => !['QUEUED', 'GRADED', 'FAILED'].includes(run.status))) {
      throw new ConflictException('evaluation batch contains a run that cannot be resumed');
    }
    if (!runs.some((run) => run.status === 'QUEUED')) throw new ConflictException('evaluation batch has no unfinished runs');
    const leaseId = `batch-lease-${randomUUID()}`;
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    batch.status = 'RUNNING';
    batch.leaseId = leaseId;
    batch.leasedBy = workerId;
    batch.leaseExpiresAt = leaseExpiresAt;
    batch.failureReason = undefined;
    for (const run of runs.filter((item) => item.status === 'QUEUED')) {
      run.status = 'RUNNING';
      run.leaseId = leaseId;
      run.leasedBy = workerId;
      run.leaseExpiresAt = leaseExpiresAt;
      this.getSubmission(run.submissionId).gradingStatus = 'RUNNING';
    }
    this.persist();
    return { leaseId, leaseExpiresAt };
  }

  extendEvaluationBatchLease(batchId: string, leaseSeconds: number): string {
    const batch = this.getEvaluationBatch(batchId);
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    batch.leaseExpiresAt = leaseExpiresAt;
    for (const runId of batch.runIds) {
      const run = this.getRun(runId);
      if (run.status === 'RUNNING') run.leaseExpiresAt = leaseExpiresAt;
    }
    this.persist();
    return leaseExpiresAt;
  }

  releaseEvaluationBatchLease(batchId: string, reason?: string): EvaluationBatch {
    const batch = this.getEvaluationBatch(batchId);
    if (batch.status !== 'RUNNING') return batch;
    batch.status = 'QUEUED';
    batch.leaseId = undefined;
    batch.leasedBy = undefined;
    batch.leaseExpiresAt = undefined;
    if (reason) batch.failureReason = reason.slice(0, 2000);
    for (const runId of batch.runIds) {
      const run = this.getRun(runId);
      if (run.status !== 'RUNNING') continue;
      run.status = 'QUEUED';
      run.leaseId = undefined;
      run.leasedBy = undefined;
      run.leaseExpiresAt = undefined;
      this.getSubmission(run.submissionId).gradingStatus = 'QUEUED';
    }
    this.persist();
    return batch;
  }

  finishEvaluationBatch(batchId: string, completedRunIds: string[], failedRunIds: string[], failureReason?: string): EvaluationBatch {
    const batch = this.getEvaluationBatch(batchId);
    batch.completionLeaseId = batch.leaseId;
    batch.completedRunIds = [...new Set(completedRunIds)];
    batch.failedRunIds = [...new Set(failedRunIds)];
    batch.status = batch.completedRunIds.length === batch.runIds.length
      ? 'COMPLETED'
      : batch.completedRunIds.length > 0
        ? 'PARTIAL'
        : 'FAILED';
    batch.failureReason = failureReason?.slice(0, 2000);
    batch.finishedAt = now();
    batch.leaseId = undefined;
    batch.leasedBy = undefined;
    batch.leaseExpiresAt = undefined;
    this.audit(batch.createdBy, 'grading.batch-finish', `evaluation-batch:${batch.id}`, undefined, {
      status: batch.status,
      completedRunIds: batch.completedRunIds,
      failedRunIds: batch.failedRunIds,
    });
    this.persist();
    return batch;
  }

  /** Hand a queued run to an evaluation worker. */
  acquireLease(runId: string, workerId: string, leaseSeconds: number): { leaseId: string; leaseExpiresAt: string } {
    const run = this.getRun(runId);
    if (run.status !== 'QUEUED') throw new ConflictException(`grading run cannot be leased from state ${run.status}`);
    run.status = 'RUNNING';
    run.leaseId = `lease-${randomUUID()}`;
    run.leasedBy = workerId;
    run.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    this.getSubmission(run.submissionId).gradingStatus = 'RUNNING';
    this.persist();
    return { leaseId: run.leaseId, leaseExpiresAt: run.leaseExpiresAt };
  }

  extendLease(runId: string, leaseSeconds: number): string {
    const run = this.getRun(runId);
    run.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    this.persist();
    return run.leaseExpiresAt;
  }

  /**
   * Return a leased run to the queue. Used when a lease expires or when a
   * worker declines the task; the delivery itself is untouched, so the next
   * worker grades exactly the same immutable snapshot.
   */
  releaseLease(runId: string, reason?: string): GradingRun {
    const run = this.getRun(runId);
    if (run.status !== 'RUNNING') return run;
    run.status = 'QUEUED';
    run.leaseId = undefined;
    run.leasedBy = undefined;
    run.leaseExpiresAt = undefined;
    if (reason) run.failureReason = reason;
    const submission = this.getSubmission(run.submissionId);
    submission.gradingStatus = 'QUEUED';
    this.persist();
    return run;
  }

  getRun(runId: string): GradingRun {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundException(`grading run not found: ${runId}`);
    return run;
  }

  getStoredResult(resultId: string): StoredResult {
    const result = this.results.get(resultId);
    if (!result) throw new NotFoundException(`grading result not found: ${resultId}`);
    return result;
  }

  markRunRunning(runId: string): GradingRun {
    const run = this.getRun(runId);
    if (run.status === 'GRADED') return run;
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
      throw new ConflictException(`grading run cannot start from state ${run.status}`);
    }
    run.status = 'RUNNING';
    this.getSubmission(run.submissionId).gradingStatus = 'RUNNING';
    this.persist();
    return run;
  }

  failRun(runId: string, reason?: string): GradingRun {
    const run = this.getRun(runId);
    const before = { status: run.status };
    const submission = this.getSubmission(run.submissionId);
    this.markRunFailed(run, submission, reason);
    // Keep the failed run for audit/history, but allow an administrator to retry
    // the same immutable snapshot by creating a fresh run.
    this.audit(run.triggeredBy ?? 'system', 'grading.failed', `run:${run.id}`, before, { status: run.status, reason: reason?.slice(0, 1000) });
    this.persist();
    return run;
  }

  /**
   * Result records are immutable history, so one may never overwrite another.
   * The grader derives its `resultId` from the snapshot alone, which means every
   * re-evaluation of the same delivery proposes the identical id; storing it as
   * is replaced the earlier attempt, and `previousResultIds` then pointed at a
   * record holding the *new* score.
   */
  private uniqueResultId(proposed: string, runId: string): string {
    const base = proposed || `result-${runId}`;
    const existing = this.results.get(base);
    if (!existing || existing.gradingRunId === runId) return base;
    const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 12);
    const candidate = `${base}.${suffix}`;
    return this.results.has(candidate) ? `${base}.${suffix}.${this.results.size + 1}` : candidate;
  }

  completeRun(runId: string, rawResult: Record<string, unknown>): StoredResult {
    const run = this.getRun(runId);
    const submission = this.getSubmission(run.submissionId);
    const event = this.getEvent(submission.eventId);
    const subject = this.getUser(submission.subjectId);
    const existingId = this.resultsByIdempotency.get(resultIdempotencyKey(submission.id, run.idempotencyKey));
    if (existingId) {
      const existing = this.results.get(existingId)!;
      run.status = 'GRADED';
      submission.resultId = existing.resultId;
      submission.state = event.reveal === 'IMMEDIATE' ? 'REVEALED' : 'SEALED';
      submission.gradingStatus = 'COMPLETED';
      submission.failureReason = undefined;
      this.persist();
      return existing;
    }
    // Evaluation-result.submission is a published contract, not a copy of the
    // internal delivery snapshot.  In particular, artifactName and
    // workspacePath are platform storage/working-directory metadata and are
    // intentionally not part of the result schema.  Build the projection
    // explicitly so adding a field to SubmissionSnapshot cannot silently make
    // every local completion fail schema validation.
    const evaluatorSubmission = rawResult.submission && typeof rawResult.submission === 'object' && !Array.isArray(rawResult.submission)
      ? rawResult.submission as Record<string, unknown>
      : {};
    const resultSubmission: Record<string, unknown> = {};
    for (const field of ['language', 'root', 'gradedAt'] as const) {
      if (typeof evaluatorSubmission[field] === 'string' && evaluatorSubmission[field]) resultSubmission[field] = evaluatorSubmission[field];
    }
    Object.assign(resultSubmission, {
      sourceType: submission.snapshot.sourceType,
      snapshotHash: submission.snapshot.snapshotHash,
      ...(submission.snapshot.artifactHash ? { artifactHash: submission.snapshot.artifactHash } : {}),
      ...(submission.snapshot.artifactUri ? { artifactUri: submission.snapshot.artifactUri } : {}),
      ...(submission.snapshot.repository ? { repository: submission.snapshot.repository } : {}),
      ...(submission.snapshot.branch ? { branch: submission.snapshot.branch } : {}),
      ...(submission.snapshot.commitSha ? { commitSha: submission.snapshot.commitSha } : {}),
      submittedAt: submission.snapshot.submittedAt,
    });
    const result = {
      ...rawResult,
      gradingRunId: run.id,
      idempotencyKey: run.idempotencyKey,
      triggerType: run.triggerType,
      // The evaluator cannot be the source of truth for employee identity.
      // Persist the subject and the organization path captured at submission
      // time so a later org move cannot rewrite historical results.
      subject: {
        kind: 'person',
        id: subject.id,
        name: subject.name,
        orgPath: submission.orgPathSnapshot ?? subject.orgPath,
      },
      submission: resultSubmission,
      resultId: this.uniqueResultId(String(rawResult.resultId ?? ''), run.id),
    } as Record<string, any>;
    const errors = validateEvaluationResult(result);
    if (errors.length) {
      this.markRunFailed(run, submission, `评估结果格式不正确: ${errors.join('; ')}`);
      this.persist();
      throw new BadRequestException({ code: 'RESULT_SCHEMA_INVALID', errors });
    }
    const scoreCheck = checkEvaluationScore(result);
    result.recalculatedTotal = scoreCheck.recalculatedTotal;
    if (scoreCheck.errors.length) {
      this.markRunFailed(run, submission, `评估结果分数不一致: ${scoreCheck.errors.join('; ')}`);
      this.persist();
      throw new BadRequestException({ code: 'RESULT_SCORE_INCONSISTENT', recalculatedTotal: scoreCheck.recalculatedTotal, errors: scoreCheck.errors });
    }
    const stored: StoredResult = {
      resultId: String(result.resultId),
      gradingRunId: run.id,
      submissionId: submission.id,
      eventId: submission.eventId,
      result,
      importedAt: now(),
    };
    const previousRunStatus = run.status;
    run.status = 'GRADED';
    run.failureReason = undefined;
    run.leaseId = undefined;
    run.leasedBy = undefined;
    run.leaseExpiresAt = undefined;
    submission.resultId = stored.resultId;
    submission.state = event.reveal === 'IMMEDIATE' ? 'REVEALED' : 'SEALED';
    submission.gradingStatus = 'COMPLETED';
    submission.failureReason = undefined;
    this.results.set(stored.resultId, stored);
    this.resultsByIdempotency.set(resultIdempotencyKey(submission.id, run.idempotencyKey), stored.resultId);
    this.audit(run.triggeredBy ?? 'system', 'grading.complete', `run:${run.id}`, { status: previousRunStatus }, { status: run.status, resultId: stored.resultId });
    this.persist();
    return stored;
  }

  importResult(result: Record<string, any>, actorId: string, context?: { eventId?: string; subjectId?: string }): StoredResult {
    const schemaErrors = validateEvaluationResult(result);
    if (schemaErrors.length) throw new BadRequestException({ code: 'RESULT_SCHEMA_INVALID', errors: schemaErrors });
    // A prepared external run is the strongest binding. This also keeps two
    // employees who uploaded identical bytes independently addressable; the
    // evaluator only needs to return the run id from its input manifest.
    const preparedRun = this.runs.get(String(result.gradingRunId));
    let submission: SubmissionRecord | undefined = preparedRun
      ? this.getSubmission(preparedRun.submissionId)
      : undefined;
    if (submission && context?.eventId && submission.eventId !== context.eventId) {
      throw new BadRequestException('result gradingRunId does not belong to the specified event');
    }
    if (submission && context?.subjectId && submission.subjectId !== context.subjectId) {
      throw new BadRequestException('result gradingRunId does not belong to the specified subject');
    }
    if (!submission) {
      const candidates = [...this.submissions.values()].filter((item) => item.snapshot.snapshotHash === result.submission?.snapshotHash)
        .filter((item) => !context?.eventId || item.eventId === context.eventId)
        .filter((item) => !context?.subjectId || item.subjectId === context.subjectId);
      if (candidates.length > 1) throw new BadRequestException('result snapshot matches multiple submissions; eventId and subjectId are required');
      submission = candidates[0];
    }
    if (!submission) throw new BadRequestException('result submission snapshot does not match a known submission');
    if (result.subject?.id && result.subject.id !== submission.subjectId) {
      throw new BadRequestException('result subject does not match the submission subject');
    }
    const event = this.getEvent(submission.eventId);
    this.assertAdminEventScope(event, actorId);
    if (event.trigger !== 'IMPORT') throw new BadRequestException(`result import is not allowed for ${event.trigger} event`);
    const lockedChallengeVersion = this.submissionChallengeVersion(submission);
    const lockedRubricVersion = this.submissionRubricVersion(submission);
    if (result.challengeVersion && result.challengeVersion !== lockedChallengeVersion) {
      throw new BadRequestException('result challengeVersion does not match the event');
    }
    if (result.rubricVersion && result.rubricVersion !== lockedRubricVersion) {
      throw new BadRequestException('result rubricVersion does not match the event');
    }
    if (result.triggerType !== 'IMPORT') {
      throw new BadRequestException('result import requires triggerType=IMPORT');
    }
    if (result.submission?.sourceType !== submission.snapshot.sourceType || result.submission?.snapshotHash !== submission.snapshot.snapshotHash) {
      throw new BadRequestException('result submission snapshot does not match the registered submission');
    }
    if (submission.snapshot.sourceType === 'UPLOAD' && submission.snapshot.artifactHash && result.submission?.artifactHash !== submission.snapshot.artifactHash) {
      throw new BadRequestException('result artifactHash does not match the registered submission');
    }
    if (submission.snapshot.sourceType === 'GIT_REF' && result.submission?.commitSha !== submission.snapshot.commitSha) {
      throw new BadRequestException('result commitSha does not match the registered submission');
    }
    if (submission.snapshot.sourceType === 'GIT_REF' && (result.submission?.repository !== submission.snapshot.repository || result.submission?.branch !== submission.snapshot.branch)) {
      throw new BadRequestException('result Git repository or branch does not match the registered submission');
    }
    const existingId = this.resultsByIdempotency.get(resultIdempotencyKey(submission.id, result.idempotencyKey));
    if (existingId) return this.results.get(existingId)!;
    const sameResultId = this.results.get(String(result.resultId));
    if (sameResultId) throw new ConflictException(`resultId already exists: ${result.resultId}`);
    const sameRunId = this.runs.get(String(result.gradingRunId));
    if (sameRunId) {
      // A prepared external-evaluation run is completed by the imported
      // result. A run belonging to another submission or contract must never
      // be reused.
      if (sameRunId.submissionId !== submission.id || sameRunId.triggerType !== 'IMPORT' || sameRunId.idempotencyKey !== result.idempotencyKey) {
        throw new ConflictException(`gradingRunId is already registered: ${result.gradingRunId}`);
      }
      if (sameRunId.status === 'GRADED') throw new ConflictException(`gradingRunId is already completed: ${result.gradingRunId}`);
    }
    submission.state = 'IMPORT_VALIDATING';
    submission.gradingStatus = 'RUNNING';
    submission.failureReason = undefined;
    const subject = this.getUser(submission.subjectId);
    // Normalize identity context from the registered submission. Imported
    // JSON may carry a display name, but it must never be able to forge the
    // employee or the historical organization snapshot.
    result.subject = {
      kind: 'person',
      id: subject.id,
      name: subject.name,
      orgPath: submission.orgPathSnapshot ?? subject.orgPath,
    };
    const scoreCheck = checkEvaluationScore(result);
    result.recalculatedTotal = scoreCheck.recalculatedTotal;
    if (scoreCheck.errors.length) {
      const reason = `评估结果分数不一致: ${scoreCheck.errors.join('; ')}`;
      if (sameRunId) {
        sameRunId.status = 'FAILED';
        sameRunId.failureReason = reason;
      }
      submission.state = 'WAITING_IMPORT';
      submission.gradingStatus = 'FAILED';
      submission.failureReason = reason;
      this.persist();
      throw new BadRequestException({ code: 'RESULT_SCORE_INCONSISTENT', recalculatedTotal: scoreCheck.recalculatedTotal, errors: scoreCheck.errors });
    }
    result.importedBy = { actorId, importedAt: now() };
    const run: GradingRun = sameRunId ?? {
      id: result.gradingRunId,
      submissionId: submission.id,
      triggerType: 'IMPORT',
      triggeredBy: actorId,
      status: 'GRADED',
      idempotencyKey: result.idempotencyKey,
      createdAt: now(),
      attempt: submission.gradingAttempt ?? 1,
    };
    run.triggeredBy = actorId;
    run.status = 'GRADED';
    run.failureReason = undefined;
    const stored: StoredResult = {
      resultId: result.resultId,
      gradingRunId: run.id,
      submissionId: submission.id,
      eventId: submission.eventId,
      result,
      importedAt: now(),
    };
    submission.gradingRunId = run.id;
    submission.resultId = result.resultId;
    submission.state = event.reveal === 'IMMEDIATE' ? 'REVEALED' : 'SEALED';
    submission.gradingStatus = 'COMPLETED';
    submission.failureReason = undefined;
    this.runs.set(run.id, run);
    this.results.set(stored.resultId, stored);
    this.resultsByIdempotency.set(resultIdempotencyKey(submission.id, result.idempotencyKey), stored.resultId);
    this.audit(actorId, 'grading.import', `result:${stored.resultId}`, undefined, { submissionId: submission.id, eventId: submission.eventId });
    this.persist();
    return stored;
  }

  getReport(submissionId: string, options: { includeDepartmentStats?: boolean } = {}): StoredResult & { report?: Record<string, unknown> } {
    const includeDepartmentStats = options.includeDepartmentStats !== false;
    const submission = this.getSubmission(submissionId);
    if (!submission.resultId) throw new NotFoundException(`report not available for submission: ${submissionId}`);
    const event = this.getEvent(submission.eventId);
    if (event.reveal === 'ON_RELEASE' && submission.state !== 'REVEALED') {
      throw new ConflictException('report is sealed until the event is released');
    }
    const stored = this.results.get(submission.resultId)!;
    const rawResult = stored.result as Record<string, unknown>;
    const dimensions = rawResult.dimensions && typeof rawResult.dimensions === 'object' && !Array.isArray(rawResult.dimensions)
      ? rawResult.dimensions as Record<string, Record<string, unknown>>
      : {};
    const criteria = Array.isArray(rawResult.criteria)
      ? rawResult.criteria.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const findings = Array.isArray(rawResult.findings)
      ? rawResult.findings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const diagnostics = Array.isArray(rawResult.validationDiagnostics)
      ? rawResult.validationDiagnostics.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const dimensionMeta = [
      { key: 'verify', label: '验证能力' },
      { key: 'spec', label: '规格能力' },
      { key: 'code', label: '工程能力' },
      { key: 'collab', label: '协作能力' },
    ] as const;
    const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const round = (value: number): number => Number(value.toFixed(2));
    const dimensionBreakdown = dimensionMeta.map((meta) => {
      const dimension = dimensions[meta.key] ?? {};
      const score = numberOrNull(dimension.score);
      const max = numberOrNull(dimension.max);
      const dimCriteria = criteria.filter((criterion) => criterion.dim === meta.key);
      const dimFindings = findings.filter((finding) => finding.dim === meta.key);
      return {
        key: meta.key,
        label: meta.label,
        score,
        max,
        evaluated: dimension.evaluated === true,
        percent: score !== null && max !== null && max > 0 ? round(score / max * 100) : null,
        criteriaCount: dimCriteria.length,
        findingsCount: dimFindings.length,
      };
    });
    const evaluatedMax = dimensionBreakdown.reduce((sum, dimension) => sum + (dimension.evaluated && dimension.max !== null ? dimension.max : 0), 0);
    const total = numberOrNull(rawResult.total);
    const recommendations = findings
      .map((finding) => typeof finding.fix === 'string' ? finding.fix : null)
      .filter((fix): fix is string => Boolean(fix))
      .filter((fix, index, all) => all.indexOf(fix) === index);
    for (const dimension of dimensionBreakdown) {
      if (!dimension.evaluated) recommendations.push(`${dimension.label}尚未纳入本次自动评估，可在人工评审后补齐。`);
      else if (dimension.percent !== null && dimension.percent < 70) recommendations.push(`优先提升${dimension.label}，本次得分率为 ${dimension.percent}%。`);
    }
    const visible = this.systemSubmissions(submission.eventId).filter((candidate) => {
      if (!candidate.resultId) return false;
      const candidateEvent = this.getEvent(candidate.eventId);
      return candidateEvent.reveal === 'IMMEDIATE' || candidate.state === 'REVEALED';
    }).map((candidate) => ({
      submissionId: candidate.id,
      orgPath: candidate.orgPathSnapshot ?? this.getUser(candidate.subjectId).orgPath,
      total: Number((this.results.get(candidate.resultId!)?.result as { total?: number } | undefined)?.total ?? 0),
      dimensions: (this.results.get(candidate.resultId!)?.result as { dimensions?: unknown } | undefined)?.dimensions,
    })).sort((a, b) => b.total - a.total || a.submissionId.localeCompare(b.submissionId));
    const rank = visible.findIndex((candidate) => candidate.submissionId === submission.id) + 1;
    const scores = visible.map((candidate) => candidate.total);
    const median = (values: number[]): number | null => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return Number((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2).toFixed(4));
    };
    const departmentPath = submission.orgPathSnapshot ?? this.getUser(submission.subjectId).orgPath;
    const departmentVisible = visible.filter((candidate) => candidate.orgPath === departmentPath);
    const departmentScores = departmentVisible.map((candidate) => candidate.total);
    const departmentRank = departmentVisible.findIndex((candidate) => candidate.submissionId === submission.id) + 1;
    const gradeFor = (score: number | null, max: number | null): string | null => {
      if (score === null || max === null || max <= 0) return null;
      const ratio = score / max * 100;
      return ratio >= 85 ? 'A' : ratio >= 70 ? 'B' : ratio >= 50 ? 'C' : 'D';
    };
    const criteriaByKey = new Map(criteria.map((criterion) => [`${String(criterion.dim)}:${String(criterion.key)}`, criterion]));
    const gradeMatrix = CAPABILITY_ITEMS.map((definition) => {
      const criterion = criteriaByKey.get(`${definition.dimension}:${definition.key}`);
      const score = numberOrNull(criterion?.score);
      const max = numberOrNull(criterion?.max) ?? definition.max;
      return {
        key: definition.key,
        dim: definition.dimension,
        name: typeof criterion?.name === 'string' ? criterion.name : definition.name,
        score,
        max,
        level: typeof criterion?.level === 'string' ? criterion.level : gradeFor(score, max),
        source: typeof criterion?.source === 'string' ? criterion.source : null,
        rule: typeof criterion?.rule === 'string' ? criterion.rule : null,
        rationale: typeof criterion?.rationale === 'string' ? criterion.rationale : null,
        evidenceType: typeof criterion?.evidenceType === 'string' ? criterion.evidenceType : null,
        evidence: criterion?.evidence ?? null,
      };
    });
    const rawCommitTimeline = Array.isArray(rawResult.commitTimeline)
      ? rawResult.commitTimeline.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const commitTimeline = rawCommitTimeline.length ? rawCommitTimeline : [{ at: submission.snapshot.submittedAt, commitSha: submission.snapshot.commitSha ?? null, repository: submission.snapshot.repository ?? null, branch: submission.snapshot.branch ?? null }];
    return {
      ...stored,
      report: {
        event: { eventId: event.id, participantCount: visible.length, rank: rank || null, percentile: rank ? Number((100 * (1 - (rank - 1) / Math.max(visible.length, 1))).toFixed(4)) : null, average: scores.length ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4)) : null, median: median(scores) },
        department: {
          orgPath: departmentPath,
          participantCount: departmentVisible.length,
          rank: includeDepartmentStats && departmentRank ? departmentRank : null,
          percentile: includeDepartmentStats && departmentRank ? Number((100 * (1 - (departmentRank - 1) / Math.max(departmentVisible.length, 1))).toFixed(4)) : null,
          average: includeDepartmentStats && departmentScores.length ? Number((departmentScores.reduce((sum, score) => sum + score, 0) / departmentScores.length).toFixed(4)) : null,
          median: includeDepartmentStats ? median(departmentScores) : null,
          departmentStatsVisible: includeDepartmentStats,
        },
        distribution: { min: scores.length ? Math.min(...scores) : null, max: scores.length ? Math.max(...scores) : null, scores },
        summary: {
          score: total,
          status: rawResult.status ?? null,
          grade: total === null ? null : total >= 90 ? '优秀' : total >= 75 ? '良好' : total >= 60 ? '达标' : '待提升',
          evaluatedDimensions: dimensionBreakdown.filter((dimension) => dimension.evaluated).length,
          totalDimensions: dimensionBreakdown.length,
          passRate: total !== null && evaluatedMax > 0 ? round(total / evaluatedMax * 100) : null,
          findingCount: findings.length,
          diagnosticCount: diagnostics.length,
          durationMs: numberOrNull(rawResult.durationMs),
        },
        submission: {
          id: submission.id,
          eventId: submission.eventId,
          subjectId: submission.subjectId,
          state: submission.state,
          challengeVersion: this.submissionChallengeVersion(submission),
          rubricVersion: this.submissionRubricVersion(submission),
          createdAt: submission.createdAt,
          sourceType: submission.snapshot.sourceType,
          snapshotHash: submission.snapshot.snapshotHash,
          artifactHash: submission.snapshot.artifactHash,
          artifactUri: submission.snapshot.artifactUri,
          repository: submission.snapshot.repository,
          branch: submission.snapshot.branch,
          commitSha: submission.snapshot.commitSha,
          submittedAt: submission.snapshot.submittedAt,
        },
        timeline: {
          submittedAt: submission.snapshot.submittedAt,
          createdAt: submission.createdAt,
          startedAt: rawResult.startedAt ?? null,
          finishedAt: rawResult.finishedAt ?? null,
        },
        objectiveMetrics: { metrics: rawResult.metrics ?? null, verifyDetail: rawResult.verifyDetail ?? null, project: rawResult.project ?? null, validationDiagnostics: diagnostics },
        commitTimeline,
        dimensionBreakdown,
        criteriaByDimension: Object.fromEntries(dimensionMeta.map((meta) => [meta.key, criteria.filter((criterion) => criterion.dim === meta.key)])),
        gradeMatrix,
        diagnostics,
        recommendations: [...new Set(recommendations)],
      },
    };
  }

  reveal(eventId: string, actorId = 'admin-local'): number {
    const event = this.getEventForAdmin(eventId, actorId);
    const beforeStatus = event.status;
    event.status = 'RELEASED';
    let count = 0;
    // Revealing is an event-level transition: once the event is RELEASED every
    // sealed delivery in it must become visible, including deliveries outside
    // the revealing administrator's own subject scope.
    for (const submission of this.systemSubmissions(eventId)) {
      if (submission.state === 'SEALED') {
        submission.state = 'REVEALED';
        count += 1;
      }
    }
    this.audit(actorId, 'event.reveal', `event:${eventId}`, { status: beforeStatus }, { status: event.status, revealed: count });
    this.persist();
    return count;
  }

  closeEvent(eventId: string, actorId = 'admin-local'): EventConfig {
    const event = this.getEventForAdmin(eventId, actorId);
    if (event.status === 'RELEASED') throw new ConflictException('released event cannot be closed');
    if (event.submissionSource === 'GIT_REF' && event.deliveryConfig?.pinAt === 'DEADLINE') {
      const unpinned = this.systemSubmissions(eventId).filter((submission) => (
        !submission.snapshot.commitSha || !submission.snapshot.artifactUri || !submission.snapshot.artifactHash || !/^[a-f0-9]{64}$/.test(submission.snapshot.snapshotHash)
      ));
      if (unpinned.length) throw new ConflictException({ code: 'DEADLINE_GIT_SNAPSHOT_MISSING', message: `${unpinned.length} 份 Git 提交尚未固定截止快照` });
    }
    const before = event.status;
    event.status = 'CLOSED';
    this.audit(actorId, 'event.close', `event:${eventId}`, { status: before }, { status: event.status });
    this.persist();
    return event;
  }
}
