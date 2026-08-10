import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { readRichTextImage, richTextPreview, sanitizeRichText } from './rich-text';
import { Icon, type IconName } from './icons';
import { EVALUATION_ENGINE_GUIDE_MARKDOWN } from './evaluation-engine-guide';

// Keep production admin calls on the HTTPS reverse-proxy origin; direct API
// access remains the convenient default for local Vite development.
const API = import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? '/api/v1' : 'http://127.0.0.1:3000/api/v1');
const AUTH_LOGIN_PATH = import.meta.env.VITE_AUTH_LOGIN_PATH ?? '/auth/login';
const ADMIN_EMPLOYEE_ID = import.meta.env.VITE_EMPLOYEE_ID ?? 'w00123';

type AdminSection = 'overview' | 'organization' | 'challenges' | 'events' | 'participants' | 'capabilities' | 'grading' | 'evaluation-runtime' | 'announcements' | 'audit';
type AdminGuideKey = 'challenges' | 'events' | 'evaluation-runtime';
type AdminGuideSection = { title: string; paragraphs?: string[]; bullets?: string[] };

const ADMIN_GUIDE_CONTENT: Record<AdminGuideKey, { kicker: string; title: string; intro: string; sections: AdminGuideSection[] }> = {
  challenges: {
    kicker: '赛题配置说明',
    title: '如何创建一份可评测的赛题',
    intro: '赛题是可复用的题目资产；训战只引用已经发布的赛题版本。建议先完成赛题配置和自测，再创建训战。',
    sections: [
      { title: '1. 赛题与版本', bullets: ['赛题 ID 和标题用于识别题目，赛题类型决定它属于训战、竞赛或难题榜。', '每次发布都会形成不可变版本；已发布版本不能原地修改，修改时请创建新版本。', '训战引用的是具体版本，不是会随时变化的赛题草稿。'] },
      { title: '2. 题面和交付要求', bullets: ['题面、目标、要求、约束、交付件和支持语言会展示给参训员工，并参与 Agent 评测上下文。', '提交方式至少选择一种：上传 ZIP 或指定 Git 仓路径。Git 地址必须来自受控的训战配置。', '目录规范用于校验文件路径、大小、数量和禁止内容，平台接收后会生成不可变快照。'] },
      { title: '3. 评测引擎与契约', bullets: ['平台内置执行器适用于 PLATFORM_LOCAL；上传完整评测包适用于 PACKAGED；EXTERNAL_CLI 用于线下评测后导入。', '输入约束和输出约束必须从 Git 固定目录选择，可点击“查看详情”阅读 Schema、示例和编写说明。', 'Code Agent 评测还需要配置 instruction.md 和 Skills；评测结果必须符合平台输出契约。'] },
      { title: '4. 发布前检查', bullets: ['确认题面能让员工知道交付什么、评测什么、结果如何产生。', '确认评测引擎、版本、参数、契约路径和示例相互匹配。', '确认保存成功后再发布；发布版本被训战引用后，不要通过修改旧版本改变历史评测含义。'] },
    ],
  },
  events: {
    kicker: '训战配置说明',
    title: '如何编排一场完整训战',
    intro: '训战是一次赛题运行安排，负责开放时间、参与范围、提交方式、评测触发和结果公布，不承载赛题评分逻辑。',
    sections: [
      { title: '1. 基础配置', bullets: ['选择已经发布的赛题版本；训战保存后会固定引用该版本。', '训战类型分为开放窗口和集中训战；开始、结束时间由服务端校验。', '提交方式可选上传 ZIP 或指定 Git 仓路径，Git 分支模板和版本锁定时点也在这里配置。'] },
      { title: '2. 访问范围', bullets: ['全员可见表示组织范围内的员工都可以进入。', '定向访问时，部门和导师使用勾选方式配置；员工、部门或导师任一范围匹配即可进入。', '访问范围只控制能否进入，提交仍需满足开放时间和赛题交付契约。'] },
      { title: '3. 评测方式', bullets: ['自动评测：提交后自动进入评测队列。', '管理员发起：管理员在评测中心选择具体提交后创建评测批次。', '导入评测结果：适用于外部线下评测，先生成输入清单，再导入符合契约的结果。'] },
      { title: '4. 运行与变更', bullets: ['开放中可接收提交；结束训战后不能继续提交，管理员可以公布结果。', '已有提交的训战不允许删除，避免破坏提交和评测历史。', '修改配置只影响后续新批次；已经冻结的评测批次继续使用创建时的赛题、快照和运行配置。'] },
      { title: '5. 发布前检查', bullets: ['确认赛题版本已发布、时间窗口正确、访问范围符合预期。', '确认评测触发方式与赛题引擎匹配，EXTERNAL_CLI 应使用导入结果。', '先用测试账号验证进入、提交、评测和结果公布四个关键路径。'] },
    ],
  },
  'evaluation-runtime': {
    kicker: '评测环境说明',
    title: 'Code Agent 运行配置怎么工作',
    intro: '此页面配置的是评测 Worker 如何启动 Code Agent，不是赛题内置执行器本身。API 只负责创建批次、校验结果和保存状态，实际评测由独立 Worker 执行。',
    sections: [
      { title: '1. 两种命令来源', bullets: ['页面默认使用公司内网 `codeagent`；平台会按赛题、评测引擎、Skills 和提交清单自动组合任务指令。', '勾选“使用平台配置”后，平台会在创建新批次时冻结启动命令、任务指令和超时。', '不勾选时，Worker 使用主机上的 CODE_AGENT_COMMAND / CODE_AGENT_ARGS_JSON 兜底配置。', 'Worker 如果在另一台主机中，管理后台只能看到 API 进程可见的诊断；Worker 的 --agent-command 不会自动同步。'] },
      { title: '2. 启动命令填写规则', bullets: ['默认命令为 `codeagent --prompt "{{prompt}}"`，不需要指定模型；命令不会经过系统 Shell。', '可用占位符为 `{{prompt}}`、`{{manifestPath}}`、`{{batchDir}}`。没有清单参数时，Worker 会追加 manifest 参数。', '可执行文件必须真实存在于 Worker 主机，并满足 CODE_AGENT_ALLOWED_EXECUTABLES（如果配置了白名单）。'] },
      { title: '3. 任务指令和超时', bullets: ['任务指令描述 Agent 如何读取清单、instruction、Skills、提交物和结果契约；Worker 会补充批次上下文。', '批次超时默认 3600 秒，允许范围为 60 到 21600 秒；Worker 命令行或环境变量可以按规则覆盖。', '凭据只能放在 Worker 运行环境，不要写入题面、任务指令或日志。'] },
      { title: '4. 环境页签、测试与排查', bullets: ['“环境配置”页签按 API、Worker、租约、评测引擎和目录列出变量、优先级与 PowerShell 启动示例。', '“当前可执行文件”是只读诊断，来自已保存命令的第一个 token；它不是文件选择框。', '“测试启动命令”只在非生产环境且 CODE_AGENT_RUNTIME_TEST_ENABLED=true 时运行合成清单，不会带入真实提交。', '如果显示未找到，依次检查：平台配置是否保存、命令是否在 Worker 主机存在、Worker 是否启动、API 与 Worker 是否使用了不同环境变量。'] },
    ],
  },
};
type ChallengeStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
type ChallengeCategory = 'TRAINING' | 'COMPETITION' | 'HARD_PROBLEM';
type HardProblemReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
type VersionStatus = 'DRAFT' | 'PUBLISHED';
type Source = 'UPLOAD' | 'GIT_REF';
type Trigger = 'AUTO' | 'MANUAL' | 'IMPORT';
type LocalEvaluationConfig = { contractPath: string; testsDir?: string; entry: string; function: string; language?: string };
type EnginePackageReference = { packageHash: string; size?: number; fileName?: string; uploadedAt?: string; uploadedBy?: string };
type EnginePackageUpload = {
  packageHash: string; size: number; fileName?: string;
  engine: { id: string; version: string; description?: string };
  runtime: { type: string; entrypoint: string; requirements?: string };
  limits?: { wallClockSeconds?: number; memoryMB?: number; outputBytes?: number } | null;
  assets?: { submissionContract?: string; testsDir?: string; referenceDir?: string } | null;
};
type EngineMode = 'EXTERNAL_CLI' | 'PLATFORM_LOCAL' | 'PACKAGED';
type ExecutorParamSchema = { type: 'object'; required?: string[]; properties?: Record<string, { title?: string; description?: string; enum?: string[]; default?: string }> };
type BuiltInExecutor = { id: string; version: string; title: string; description?: string; contentHash: string; params: ExecutorParamSchema | null };
type EvaluationContractOption = { id: string; kind: 'INPUT' | 'OUTPUT'; visibility: 'PUBLIC'; modes: EngineMode[]; schemaVersion: string; path: string; label: string; description: string; examplePath: string; guidePath: string };
type EvaluationContractDetail = EvaluationContractOption & { schema: unknown; example: unknown; guide: string };
type PlatformExecutorReference = { id: string; version?: string; params?: Record<string, string> };
type EvaluationEngineConfig = {
  id: string;
  version: string;
  mode: EngineMode;
  executor?: PlatformExecutorReference;
  local?: LocalEvaluationConfig;
  package?: EnginePackageReference;
  agent?: { instructionPath: string; skillPaths: string[] };
  input: { format: 'JSON'; schemaVersion: string; contractPath: string };
  output: { format: 'JSON'; schemaVersion: string; contractPath: string };
};

type ChallengeVersion = {
  id: string;
  challengeId: string;
  version: number;
  title: string;
  description?: string;
  objectives?: string[];
  requirements?: string[];
  constraints?: string[];
  deliverables?: string[];
  tags?: string[];
  estimatedMinutes?: number;
  zone: 'YELLOW' | 'BLUE';
  languagePolicy: Record<string, unknown>;
  deliveryPolicy: { allowedSources?: Source[]; upload?: Record<string, unknown>; git?: Record<string, unknown> };
  rubricVersion: string;
  submissionContract: string;
  submissionContractDefinition?: Record<string, unknown>;
  evaluationEngine?: EvaluationEngineConfig;
  status: VersionStatus;
};

type Challenge = { id: string; ownerOrgPath: string; origin: string; category?: ChallengeCategory; status: ChallengeStatus; archivedFrom?: Exclude<ChallengeStatus, 'ARCHIVED'>; board?: { type: 'HARD_PROBLEM'; status: 'OPEN' | 'RESOLVED'; reviewStatus?: HardProblemReviewStatus; solutionVisibility?: 'PUBLIC' | 'HIDDEN'; solutionSubmissionId?: string; reviewedAt?: string; reviewedBy?: string; reviewComment?: string; submissionEventId?: string; publisherType: 'DEPARTMENT' | 'EMPLOYEE'; publisherName: string; departmentName?: string; difficulty: 'HIGH' | 'MEDIUM' | 'LOW'; resolvedBy?: string; resolvedByName?: string; solverId?: string; solverName?: string }; versions: ChallengeVersion[] };
type EventConfig = { id: string; challengeVersion: string; purpose?: 'TRAINING' | 'HARD_PROBLEM'; submissionSource: Source; trigger: Trigger; reveal: 'IMMEDIATE' | 'ON_RELEASE'; status: 'OPEN' | 'CLOSED' | 'RELEASED'; mode?: 'LIVE' | 'WINDOW'; startsAt?: string; endsAt?: string; participantMode?: 'OPEN' | 'ALLOWLIST'; accessPolicy?: { mode: 'OPEN' | 'RESTRICTED'; subjectIds?: string[]; departmentIds?: string[]; mentorIds?: string[] }; deliveryConfig?: { repository?: string; branchTemplate?: string; pinAt?: 'SUBMIT' | 'DEADLINE'; allowedFormats?: string[]; maxBytes?: number; maxFiles?: number } };
type Submission = { id: string; eventId: string; subjectId: string; state: string; createdAt: string; gradingRunId?: string; resultId?: string; gradingStatus?: string; failureReason?: string; snapshot: { sourceType: Source; snapshotHash?: string; artifactHash?: string; artifactUri?: string; artifactPath?: string; artifactName?: string; workspacePath?: string; repository?: string; branch?: string; commitSha?: string; submittedAt?: string } };
type SubmissionPage = { items: Submission[]; pageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean } };
type EvaluationInputBatch = { schemaVersion: '1.0'; generatedAt: string; event: { id: string; challengeVersion: string; rubricVersion: string; trigger: 'IMPORT'; submissionSource: Source; reveal: 'IMMEDIATE' | 'ON_RELEASE' }; challenge: { id: string; title: string; version: number; evaluationEngine: EvaluationEngineConfig }; submissions: Array<{ submissionId: string; subject: { id: string; name: string; orgPath: string }; snapshot: Submission['snapshot']; grading: { runId: string; idempotencyKey: string; triggerType: 'IMPORT' } }> };
type Announcement = { id: string; title: string; summary: string; tag: '平台通知' | '训战提醒' | '规则更新'; publishedAt: string; pinned?: boolean };
type Audit = { id: string; actorId: string; action: string; target: string; createdAt: string };
type AuditPage = { items: Audit[]; pageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean } };
type Overview = {
  generatedAt: string;
  challenges: { total: number; published: number; drafts: number; archived: number; versions: number };
  events: { total: number; open: number; closed: number; released: number };
  submissions: { total: number; byState: Record<string, number>; graded: number };
  grading: { totalRuns: number; queuedOrRunning: number; failed: number };
  announcements: number;
  activeSeason: { id: string; name: string; status: string } | null;
  eventStats: Array<{ eventId: string; challengeVersion: string; status: string; submissionCount: number; pendingCount: number }>;
  recentAudits: Audit[];
};
type QueueStats = { queued: number; running: number; maxConcurrency: number; scheduled: number };
type CodeAgentRuntimeConfig = {
  schemaVersion: '1.0';
  enabled: boolean;
  commandLine: string;
  executable: string;
  args: string[];
  prompt: string;
  timeoutSeconds: number;
  configHash: string;
  updatedAt: string;
  updatedBy: string;
};
type CodeAgentRuntimeDiagnostics = {
  schemaVersion: '1.0';
  defaults: Pick<CodeAgentRuntimeConfig, 'enabled' | 'commandLine' | 'prompt' | 'timeoutSeconds'>;
  platform: CodeAgentRuntimeConfig;
  worker: {
    mode: 'EMBEDDED' | 'EXTERNAL';
    workerId: string | null;
    source: 'PLATFORM' | 'ENVIRONMENT' | 'CLI_OVERRIDE_UNKNOWN' | 'NONE';
    commandConfigured: boolean;
    executable: string | null;
    args: string[];
    commandPreview: string | null;
    cliOverrideVisible: false;
    canResolveExecutable: boolean;
    reason: string;
  };
  allowedExecutables: string[];
  test: { enabled: boolean; maxTimeoutSeconds: number; canExecute: boolean; reason: string };
};
type CodeAgentRuntimeTestResult = {
  schemaVersion: '1.0';
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'TIMEOUT';
  message: string;
  executable: string | null;
  args: string[];
  workingDirectory: string;
  manifestPath: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};
type OrgUnit = { id: string; parentId?: string; path: string; level: number; label: string; name: string };
type AdminUser = { id: string; employeeNo: string; name: string; orgUnitId: string; orgPath: string; departmentHint?: string; departmentSource?: 'SSO' | 'ADMIN'; roles: string[]; roleBindings?: Array<{ role: string; scopeOrgPath: string }>; status: 'ACTIVE' | 'DISABLED' };
type UserPage = { items: AdminUser[]; pageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean } };
type AdminCapabilityProfile = {
  subjectId: string;
  summary: { gradedSubmissions: number; overallAverage: number | null; strongestDomain?: string | null; focusDomain?: string | null; evaluatedCapabilityDomains?: number; totalCapabilityDomains?: number };
  dimensions: Array<{ key: string; label: string; percent: number | null; evaluatedCount: number }>;
  domains: Array<{ key: string; label: string; shortLabel?: string; percent: number | null; status: string; evidenceCount: number; sampleCount: number }>;
  skills: Array<{ criterionKey: string; name: string; percent: number | null; averageLevel: string | null }>;
};
type AdminCapabilityBundle = {
  generatedAt: string;
  selection: { orgPath: string | null; eventId: string | null; mode: 'ALL' | 'SELECTED'; subjectIds: string[] };
  totalCandidates: number;
  selectedCount: number;
  profilePageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean };
  gradedUsers: number;
  aggregate: {
    overallAverage: number | null;
    overallMedian?: number | null;
    overallPercentile?: number | null;
    dimensions: Array<{ key: string; label: string; percent: number | null; median?: number | null; percentile?: number | null; evaluatedUsers: number }>;
    domains: Array<{ key: string; label: string; percent: number | null; median?: number | null; percentile?: number | null; evaluatedUsers: number }>;
    skills: Array<{ key: string; label: string; percent: number | null; median?: number | null; percentile?: number | null; evaluatedUsers: number }>;
  };
  profiles: Array<{ subject: AdminUser; profile: AdminCapabilityProfile }>;
};

type ChallengeDraft = {
  id: string;
  title: string;
  category: ChallengeCategory;
  description: string;
  objectives: string;
  requirements: string;
  constraints: string;
  deliverables: string;
  tags: string;
  estimatedMinutes: string;
  zone: 'YELLOW' | 'BLUE';
  languages: string;
  allowUpload: boolean;
  allowGit: boolean;
  repository: string;
  branchTemplate: string;
  rubricVersion: string;
  submissionContract: string;
  submissionContractJson: string;
  evaluationEngineId: string;
  evaluationEngineVersion: string;
  evaluationEngineMode: EngineMode;
  enginePackage: EnginePackageReference | null;
  enginePackageSummary: string;
  executorId: string;
  executorParams: Record<string, string>;
  evaluationInputContract: string;
  evaluationOutputContract: string;
  agentInstructionPath: string;
  agentSkillPaths: string;
};

type EventDraft = {
  id: string;
  challengeVersion: string;
  submissionSource: Source;
  trigger: Trigger;
  reveal: 'IMMEDIATE' | 'ON_RELEASE';
  mode: 'LIVE' | 'WINDOW';
  pinAt: 'SUBMIT' | 'DEADLINE';
  startsAt: string;
  endsAt: string;
  repository: string;
  branchTemplate: string;
  accessMode: 'OPEN' | 'RESTRICTED';
  departmentIds: string[];
  mentorIds: string[];
};

type AdminAccess = { level: 'GLOBAL' | 'DEPARTMENT'; scopeOrgPaths: string[] };
type Props = { onExit: () => void; userId: string; userName: string; adminAccess: AdminAccess };

function humanizeApiMessage(message: string): string {
  const value = message.trim();
  const rules: Array<[RegExp, string]> = [
    [/event .* is not open/i, '当前训战未开放'],
    [/event .*outside.*scope|subject is not configured/i, '当前账号不在该训战参训范围内'],
    [/subject is disabled/i, '当前账号已停用'],
    [/GIT_REF requires/i, '请填写 Git 仓路径、分支和提交版本'],
    [/repository must match/i, '仓库路径与训战配置不一致'],
    [/branch must match/i, '分支与训战配置不一致'],
    [/commitSha must/i, '提交版本格式不正确'],
    [/snapshotHash|artifactHash.*match/i, '交付件校验失败'],
    [/hard problem not found/i, '难题不存在或不可见'],
    [/challenge.*not found/i, '赛题不存在或不可见'],
    [/event.*not found/i, '训战不存在或不可见'],
    [/global administrator role is required/i, '该操作仅限全局管理员'],
    [/administrator role is required/i, '当前账号无管理员权限'],
    [/organization scope does not allow/i, '当前账号无权维护该部门'],
    [/department administrators must create/i, '请选择权限范围内的上级部门'],
    [/org unit id is invalid/i, '部门编号需使用字母、数字、下划线或连字符'],
    [/org unit name is required/i, '请填写部门名称'],
    [/org unit label is required/i, '请选择组织类型'],
    [/org unit already exists/i, '该部门编号已存在'],
    [/org unit not found/i, '部门不存在或已删除'],
    [/challenge has open events/i, '赛题仍有关联的开放训战，请先结束训战'],
    [/challenge has linked training events/i, '赛题仍有关联训战，不能永久删除'],
    [/only challenges in the trash can be permanently deleted/i, '只有垃圾箱中的赛题可以永久删除'],
    [/训战已有提交|已公布训战不能删除|难题榜交付入口由系统管理/i, '已有提交、已公布或系统管理的训战不能删除'],
    [/published challenge.*immutable/i, '已发布赛题不可直接修改，请创建新版本'],
    [/result .*invalid|schema is invalid/i, '评测结果格式不正确'],
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1] ?? value;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const employeeId = typeof window === 'undefined' ? ADMIN_EMPLOYEE_ID : window.localStorage.getItem('ai-training.employeeId') ?? ADMIN_EMPLOYEE_ID;
  const headers = new Headers(init?.headers);
  headers.set('x-employee-id', employeeId);
  if (init?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers });
  } catch {
    throw new Error('暂时无法连接平台服务，请稍后重试');
  }
  if (!response.ok) {
    if (response.status === 401 && import.meta.env.PROD && typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth/')) {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.assign(`${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const detail = await response.text();
    let message = '';
    try {
      const payload = JSON.parse(detail) as { message?: string | string[]; issues?: Array<{ message?: string }>; errors?: string[]; details?: { issues?: Array<{ message?: string }>; errors?: string[] } };
      const issues = payload.details?.issues ?? payload.issues;
      const errors = payload.details?.errors ?? payload.errors;
      message = issues?.map((issue) => issue.message).filter(Boolean).slice(0, 4).join('；')
        || errors?.slice(0, 4).join('；')
        || (Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? '');
    } catch {
      message = detail.trim();
    }
    throw new Error(humanizeApiMessage(message || (response.status >= 500 ? '服务暂时不可用，请稍后重试。' : '操作未完成，请检查填写内容后重试。')));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatScheduleDate(value?: string): string {
  if (!value) return '待配置';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '待配置';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function displayPersonName(name?: string): string {
  if (!name) return '参训员工';
  if (name === '本地开发用户' || name === 'admin-local') return '平台管理员';
  if (name === '本地部门管理员') return '部门管理员';
  if (name === '本地导师') return '导师';
  return name.replace(/^本地学员\s*/, '参训员工 ');
}

function displayActorName(actorId: string): string {
  if (actorId === 'admin-local' || actorId === 'w00123') return '平台管理员';
  return displayPersonName(actorId);
}

function eventScheduleLabel(event: Pick<EventConfig, 'startsAt' | 'endsAt'>): string {
  if (!event.startsAt && !event.endsAt) return '待配置';
  if (event.startsAt && event.endsAt) return `${formatScheduleDate(event.startsAt)} — ${formatScheduleDate(event.endsAt)}`;
  return `${event.startsAt ? formatScheduleDate(event.startsAt) : '待配置'} — ${event.endsAt ? formatScheduleDate(event.endsAt) : '待配置'}`;
}

type EventWindowState = 'BEFORE' | 'OPEN' | 'AFTER';

function eventWindowState(event: Pick<EventConfig, 'startsAt' | 'endsAt'>, currentTime = Date.now()): EventWindowState {
  const startsAt = event.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  if (Number.isFinite(startsAt) && currentTime < startsAt) return 'BEFORE';
  const endsAt = event.endsAt ? Date.parse(event.endsAt) : Number.NaN;
  if (Number.isFinite(endsAt) && currentTime > endsAt) return 'AFTER';
  return 'OPEN';
}

/**
 * Event status is a persisted workflow state; the time window is a separate
 * runtime state. Keep those distinct so an administrator can still close an
 * expired event (including deadline Git snapshot pinning), while the console
 * does not call it "in progress" after its submission window has ended.
 */
function eventDisplayStatus(event: EventConfig, currentTime = Date.now()): EventConfig['status'] {
  if (event.status !== 'OPEN') return event.status;
  return eventWindowState(event, currentTime) === 'AFTER' ? 'CLOSED' : 'OPEN';
}

function eventDisplayLabel(event: EventConfig, currentTime = Date.now()): string {
  if (event.status === 'OPEN') {
    const window = eventWindowState(event, currentTime);
    if (window === 'BEFORE') return '即将开放';
    if (window === 'AFTER') return '已结束';
  }
  return statusLabel(event.status);
}

function statusLabel(value: string): string {
  return ({ DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '垃圾箱', OPEN: '进行中', CLOSED: '已结束', RELEASED: '已公布', WAITING_TRIGGER: '等待处理', WAITING_IMPORT: '等待结果', RECEIVED: '已提交', QUEUED: '等待开始', RUNNING: '处理中', GRADED: '已完成', FAILED: '需要重试', ACTIVE: '在职', DISABLED: '已停用' } as Record<string, string>)[value] ?? (value && !/^[A-Z][A-Z0-9_]*$/.test(value) ? value : '—');
}

function organizationLevelLabel(level: number): string {
  const normalized = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  return normalized === 0 ? '根组织' : `第 ${normalized} 级组织`;
}

function roleLabel(value: string): string {
  return ({ learner: '新员工', mentor: '导师', global_admin: '全局管理员', department_admin: '部门管理员', admin: '全局管理员' } as Record<string, string>)[value] ?? value;
}

function roleLabels(values: string[]): string[] {
  return [...new Set(values.map(roleLabel))];
}

function editableRoles(user: AdminUser): string[] {
  const roles = user.roles.filter((role) => role !== 'admin');
  if (user.roles.includes('admin')) {
    const hasScopedLegacyAdmin = user.roleBindings?.some((binding) => binding.role === 'admin' && binding.scopeOrgPath !== '/') ?? false;
    roles.push(hasScopedLegacyAdmin ? 'department_admin' : 'global_admin');
  }
  return [...new Set(roles)];
}

function challengeCategoryLabel(category?: ChallengeCategory): string {
  return ({ TRAINING: '训战类', COMPETITION: '竞赛类', HARD_PROBLEM: '难题类' } as Record<ChallengeCategory, string>)[category ?? 'TRAINING'];
}

function hardReviewStatusLabel(status: HardProblemReviewStatus): string {
  return ({ PENDING_REVIEW: '待审核', APPROVED: '已通过', REJECTED: '已驳回' } as Record<HardProblemReviewStatus, string>)[status];
}

function challengeCategoryOf(challenge: Pick<Challenge, 'category' | 'board' | 'origin'>): ChallengeCategory {
  return challenge.board?.type === 'HARD_PROBLEM' || challenge.origin === 'BOUNTY' ? 'HARD_PROBLEM' : challenge.category ?? 'TRAINING';
}

function sourceLabel(source?: string): string {
  return source === 'GIT_REF' ? '指定 Git 仓库' : source === 'UPLOAD' ? '上传交付件' : source ?? '—';
}

function triggerLabel(trigger?: string): string {
  return trigger === 'AUTO' ? '自动评测' : trigger === 'MANUAL' ? '管理员发起' : trigger === 'IMPORT' ? '结果导入' : trigger ?? '—';
}

function revealLabel(reveal?: string): string {
  return reveal === 'IMMEDIATE' ? '评测后公布' : reveal === 'ON_RELEASE' ? '公布后可见' : reveal ?? '—';
}

function modeLabel(mode?: string): string {
  return mode === 'LIVE' ? '集中训战' : mode === 'WINDOW' ? '开放窗口' : mode ?? '—';
}

function evaluationContractKindLabel(kind: EvaluationContractOption['kind']): string {
  return kind === 'INPUT' ? '输入约束' : '输出约束';
}

function evaluationContractModeLabel(mode: EngineMode): string {
  return ({
    EXTERNAL_CLI: '线下结果导入',
    PLATFORM_LOCAL: 'Code Agent + 内置执行器',
    PACKAGED: 'Code Agent + 评测引擎包',
  } as Record<EngineMode, string>)[mode];
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function downloadTextFile(fileName: string, contents: string, mimeType = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function participantModeLabel(mode?: string): string {
  return mode === 'ALLOWLIST' ? '定向访问' : '全员可见';
}

function accessScopeLabel(event: EventConfig): string {
  if (event.accessPolicy?.mode === 'RESTRICTED') {
    const departments = event.accessPolicy.departmentIds?.length ?? 0;
    const mentors = event.accessPolicy.mentorIds?.length ?? 0;
    const people = event.accessPolicy.subjectIds?.length ?? 0;
    const details = [departments ? `${departments} 个部门` : '', people ? `${people} 名员工` : '', mentors ? `${mentors} 名导师` : ''].filter(Boolean).join('、');
    return details ? `定向访问 · ${details}` : '定向访问 · 仅管理员';
  }
  if (event.participantMode === 'ALLOWLIST') return '定向访问 · 参训名单';
  return '全员可见（组织范围内）';
}

function auditActionLabel(action: string): string {
  return ({
    'challenge.create': '创建赛题', 'challenge.update': '更新赛题', 'challenge.publish': '发布赛题', 'challenge.archive': '移入垃圾箱', 'challenge.restore': '恢复赛题', 'challenge.purge': '永久删除赛题',
    'challenge.version.create': '创建赛题版本', 'challenge.version.update': '更新赛题版本', 'challenge.version.publish': '发布赛题版本',
    'event.create': '创建训战', 'event.update': '更新训战', 'event.delete': '删除训战', 'event.start-grading': '批量安排评测', 'event.execute-local': '执行线上评测', 'event.close': '结束训战', 'event.reveal': '公布评测结果',
    'submission.start-grading': '安排评测', 'grading-result.import': '录入评测结果', 'grading.regrade': '重新评测', 'code-agent-runtime.update': '更新评测环境', 'org-unit.create': '创建部门', 'org-unit.update': '更新部门', 'org-unit.delete': '删除部门', 'user.create': '同步员工资料', 'user.update': '配置员工', 'user.roles.update': '配置员工权限', 'sso.user-provision': '登记员工资料', 'sso.user-sync': '同步员工资料', 'announcement.create': '发布公告', 'announcement.update': '更新公告', 'announcement.delete': '删除公告',
  } as Record<string, string>)[action] ?? action;
}

function auditTargetLabel(target: string): string {
  return target.replace(/^system:code-agent-runtime$/, 'Code Agent 运行配置').replace(/^challenge:/, '赛题：').replace(/^event:/, '场次：').replace(/^submission:/, '提交：').replace(/^org-unit:/, '部门：').replace(/^user:/, '员工：').replace(/^announcement:/, '公告：');
}

/** Only a PLATFORM_LOCAL engine can be driven by the platform's own executor. */
function engineSupportsPlatformExecution(versionId: string, challenges: Challenge[]): boolean {
  const version = challenges.flatMap((challenge) => challenge.versions).find((item) => item.id === versionId);
  const mode = version?.evaluationEngine?.mode;
  return mode === 'PLATFORM_LOCAL' || mode === 'PACKAGED';
}

function versionTitle(versionId: string, challenges: Challenge[]): string {
  return challenges.flatMap((challenge) => challenge.versions).find((version) => version.id === versionId)?.title ?? versionId;
}

const SKILLS_DELIVERY_CONTRACT = JSON.stringify({
  schemaVersion: '1.1',
  root: { mode: 'ARCHIVE_ROOT' },
  required: [
    { path: 'skills', type: 'directory', minFiles: 1 },
    { path: 'skills/*/SKILL.md', type: 'markdown' },
  ],
  optional: [{ path: 'README.md', type: 'markdown' }, { path: 'skills/**', type: 'text' }],
  forbidden: ['**/.env', '**/.git/**', '**/__pycache__/**', '**/*.pyc'],
  allowedPaths: ['README.md', 'skills/**'],
  allowAdditionalPaths: false,
  maxDepth: 8,
  maxFiles: 500,
}, null, 2);

const SOURCE_DELIVERY_CONTRACT = JSON.stringify({
  schemaVersion: '1.1',
  root: { mode: 'ARCHIVE_ROOT' },
  required: [
    { path: 'README.md', type: 'markdown' },
    { path: 'src', type: 'directory', minFiles: 1 },
  ],
  optional: [{ path: 'tests', type: 'directory' }],
  forbidden: ['**/.env', '**/.git/**', '**/*credential*', '**/__pycache__/**', '**/*.pyc'],
  allowAdditionalPaths: true,
  maxDepth: 12,
  maxFiles: 1000,
}, null, 2);

function blankChallenge(): ChallengeDraft {
  return { id: '', title: '', category: 'TRAINING', description: '', objectives: '', requirements: '', constraints: '', deliverables: '', tags: '', estimatedMinutes: '45', zone: 'YELLOW', languages: 'python', allowUpload: true, allowGit: true, repository: '', branchTemplate: 'drill/{subjectId}', rubricVersion: '1.0', submissionContract: 'contracts/submission-contract-v1.1.schema.json', submissionContractJson: '', evaluationEngineId: '', evaluationEngineVersion: '1.0.0', evaluationEngineMode: 'EXTERNAL_CLI', enginePackage: null, enginePackageSummary: '', executorId: '', executorParams: {}, evaluationInputContract: 'contracts/evaluation-input.schema.json', evaluationOutputContract: 'contracts/evaluation-result.schema.json', agentInstructionPath: 'instruction.md', agentSkillPaths: 'skills/evaluation' };
}

function evaluationContracts(mode: EngineMode): Pick<ChallengeDraft, 'evaluationInputContract' | 'evaluationOutputContract'> {
  return {
    evaluationInputContract: mode === 'EXTERNAL_CLI'
      ? 'contracts/evaluation-input.schema.json'
      : 'contracts/evaluation-agent-batch-v1.1.schema.json',
    evaluationOutputContract: 'contracts/evaluation-result.schema.json',
  };
}

function blankEvent(versionId = '', challenges: Challenge[] = []): EventDraft {
  // A challenge graded by an external command can only receive offline results,
  // so a new draft must not start on a trigger its engine cannot serve.
  const trigger: Trigger = engineSupportsPlatformExecution(versionId, challenges) ? 'MANUAL' : 'IMPORT';
  return { id: '', challengeVersion: versionId, submissionSource: 'UPLOAD', trigger, reveal: 'IMMEDIATE', mode: 'WINDOW', pinAt: 'SUBMIT', startsAt: '', endsAt: '', repository: '', branchTemplate: 'drill/{subjectId}', accessMode: 'RESTRICTED', departmentIds: [], mentorIds: [] };
}

function toDateTimeLocal(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function draftFromEvent(event: EventConfig): EventDraft {
  return {
    id: event.id,
    challengeVersion: event.challengeVersion,
    submissionSource: event.submissionSource,
    trigger: event.trigger,
    reveal: event.reveal,
    mode: event.mode ?? 'WINDOW',
    pinAt: event.deliveryConfig?.pinAt ?? 'SUBMIT',
    startsAt: toDateTimeLocal(event.startsAt),
    endsAt: toDateTimeLocal(event.endsAt),
    repository: event.deliveryConfig?.repository ?? '',
    branchTemplate: event.deliveryConfig?.branchTemplate ?? 'drill/{subjectId}',
    accessMode: event.accessPolicy?.mode ?? (event.participantMode === 'ALLOWLIST' ? 'RESTRICTED' : 'OPEN'),
    departmentIds: event.accessPolicy?.departmentIds ?? [],
    mentorIds: event.accessPolicy?.mentorIds ?? [],
  };
}

function draftFromVersion(version?: ChallengeVersion): ChallengeDraft {
  const git = version?.deliveryPolicy.git ?? {};
  const languages = (version?.languagePolicy.languages as string[] | undefined) ?? ['python'];
  const allowed = version?.deliveryPolicy.allowedSources ?? ['UPLOAD', 'GIT_REF'];
  const engine = version?.evaluationEngine;
  const mode = engine?.mode ?? 'EXTERNAL_CLI';
  const defaults = evaluationContracts(mode);
  return { id: version?.challengeId ?? '', title: version?.title ?? '', category: 'TRAINING', description: version?.description ?? '', objectives: (version?.objectives ?? []).join('\n'), requirements: (version?.requirements ?? []).join('\n'), constraints: (version?.constraints ?? []).join('\n'), deliverables: (version?.deliverables ?? []).join('\n'), tags: (version?.tags ?? []).join('\n'), estimatedMinutes: String(version?.estimatedMinutes ?? 45), zone: version?.zone ?? 'YELLOW', languages: languages.join('\n'), allowUpload: allowed.includes('UPLOAD'), allowGit: allowed.includes('GIT_REF'), repository: String(git.repository ?? ''), branchTemplate: String(git.branchTemplate ?? 'drill/{subjectId}'), rubricVersion: version?.rubricVersion ?? '1.0', submissionContract: version?.submissionContract ?? 'contracts/submission-contract-v1.1.schema.json', submissionContractJson: version?.submissionContractDefinition ? JSON.stringify(version.submissionContractDefinition, null, 2) : '', evaluationEngineId: engine?.id ?? `${version?.challengeId ?? 'challenge'}-evaluator`, evaluationEngineVersion: engine?.version ?? '1.0.0', evaluationEngineMode: mode, enginePackage: engine?.package ?? null, enginePackageSummary: engine?.package ? `${engine.package.fileName ?? '引擎包'} · ${engine.package.packageHash.slice(0, 12)}…` : '', executorId: engine?.executor?.id ?? '', executorParams: Object.fromEntries(Object.entries(engine?.executor?.params ?? {}).map(([key, value]) => [key, String(value ?? '')])), evaluationInputContract: engine?.input?.contractPath ?? defaults.evaluationInputContract, evaluationOutputContract: engine?.output?.contractPath ?? defaults.evaluationOutputContract, agentInstructionPath: engine?.agent?.instructionPath ?? 'instruction.md', agentSkillPaths: (engine?.agent?.skillPaths ?? ['skills/evaluation']).join('\n') };
}

export function AdminWorkspace({ onExit, userId, userName, adminAccess }: Props) {
  const [section, setSection] = useState<AdminSection>('events');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [builtInExecutors, setBuiltInExecutors] = useState<BuiltInExecutor[]>([]);
  const [evaluationContractCatalog, setEvaluationContractCatalog] = useState<EvaluationContractOption[]>([]);
  const [evaluationContractDetail, setEvaluationContractDetail] = useState<EvaluationContractDetail | null>(null);
  const [evaluationContractDetailBusy, setEvaluationContractDetailBusy] = useState(false);
  const [evaluationContractCopied, setEvaluationContractCopied] = useState(false);
  const [adminGuide, setAdminGuide] = useState<AdminGuideKey | null>(null);
  const [events, setEvents] = useState<EventConfig[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [orgUnits, setOrgUnits] = useState<OrgUnit[]>([]);
  const [adminCapabilities, setAdminCapabilities] = useState<AdminCapabilityBundle | null>(null);
  const [capabilityOrgPath, setCapabilityOrgPath] = useState('');
  const [capabilityEventId, setCapabilityEventId] = useState('');
  const [capabilitySubjectIds, setCapabilitySubjectIds] = useState<string[]>([]);
  const [capabilityUserPage, setCapabilityUserPage] = useState<UserPage | null>(null);
  const [capabilityUsersBusy, setCapabilityUsersBusy] = useState(false);
  const [capabilityProfilePage, setCapabilityProfilePage] = useState(1);
  const [capabilityProfileMode, setCapabilityProfileMode] = useState<'ALL' | 'SELECTED'>('ALL');
  const [capabilityIncludeProfiles, setCapabilityIncludeProfiles] = useState(true);
  const capabilityUsersRequestRef = useRef(0);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [queue, setQueue] = useState<QueueStats | null>(null);
  const [codeAgentRuntime, setCodeAgentRuntime] = useState<CodeAgentRuntimeConfig | null>(null);
  const [codeAgentRuntimeDiagnostics, setCodeAgentRuntimeDiagnostics] = useState<CodeAgentRuntimeDiagnostics | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedGradingIds, setSelectedGradingIds] = useState<string[]>([]);
  const [selectedChallengeId, setSelectedChallengeId] = useState('');
  const [challengeView, setChallengeView] = useState<'active' | 'trash'>('active');
  const [challengeForm, setChallengeForm] = useState<ChallengeDraft | null>(null);
  const [versionForm, setVersionForm] = useState<ChallengeDraft | null>(null);
  const [versionEditId, setVersionEditId] = useState('');
  const [eventForm, setEventForm] = useState<EventDraft | null>(null);
  const [eventEditId, setEventEditId] = useState('');
  const [announcementForm, setAnnouncementForm] = useState({ title: '', summary: '', tag: '平台通知' as Announcement['tag'], pinned: false });
  const [importText, setImportText] = useState('');
  const [participantEventId, setParticipantEventId] = useState('');
  const [participantSubjectIds, setParticipantSubjectIds] = useState<string[]>([]);

  const visibleChallenges = useMemo(() => challenges.filter((challenge) => challengeView === 'trash' ? challenge.status === 'ARCHIVED' : challenge.status !== 'ARCHIVED'), [challenges, challengeView]);
  const selectedChallenge = useMemo(() => visibleChallenges.find((challenge) => challenge.id === selectedChallengeId), [visibleChallenges, selectedChallengeId]);
  const publishedVersions = useMemo(() => challenges.filter((challenge) => challenge.status !== 'ARCHIVED').flatMap((challenge) => challenge.versions.filter((version) => version.status === 'PUBLISHED')), [challenges]);
  const pendingSubmissions = useMemo(() => submissions.filter((submission) => ['WAITING_TRIGGER', 'WAITING_IMPORT', 'RECEIVED', 'QUEUED', 'RUNNING', 'FAILED'].includes(submission.state) || ['PENDING', 'QUEUED', 'RUNNING', 'FAILED'].includes(submission.gradingStatus ?? '')), [submissions]);
  const gradingSubmissions = useMemo(() => submissions.filter((submission) => pendingSubmissions.includes(submission) || Boolean(submission.resultId)), [submissions, pendingSubmissions]);
  const capabilityUsers = capabilityUserPage?.items ?? [];
  const activeEventCount = useMemo(() => events.filter((event) => event.status === 'OPEN' && eventWindowState(event, clock) === 'OPEN').length, [events, clock]);

  async function loadCapabilityUsers(page = 1, orgPath = capabilityOrgPath): Promise<void> {
    const requestId = ++capabilityUsersRequestRef.current;
    const params = new URLSearchParams({ page: String(page), pageSize: '20', role: 'learner', status: 'ACTIVE' });
    if (orgPath) params.set('orgPath', orgPath);
    setCapabilityUsersBusy(true);
    try {
      const loaded = await request<UserPage>(`/users?${params.toString()}`);
      if (requestId === capabilityUsersRequestRef.current) setCapabilityUserPage(loaded);
    } catch (error) {
      if (requestId === capabilityUsersRequestRef.current) setMessage(error instanceof Error ? error.message : '鍛樺伐鍊欓€夊垪琛ㄥ姞杞藉け璐?');
    } finally {
      if (requestId === capabilityUsersRequestRef.current) setCapabilityUsersBusy(false);
    }
  }

  async function refresh() {
    const capabilityUserParams = new URLSearchParams({ page: '1', pageSize: '20', role: 'learner', status: 'ACTIVE' });
    if (capabilityOrgPath) capabilityUserParams.set('orgPath', capabilityOrgPath);
    const [loadedOverview, loadedChallenges, loadedEvents, loadedSubmissionPage, loadedUsers, loadedCapabilityUsers, loadedOrgUnits, loadedCapabilities, loadedAnnouncements, loadedAuditPage, loadedQueue, loadedRuntime, loadedRuntimeDiagnostics] = await Promise.all([
      request<Overview>('/admin/overview'), request<Challenge[]>('/challenges'), request<EventConfig[]>('/events'), request<SubmissionPage>('/submissions?page=1&pageSize=100'), request<UserPage>('/users?page=1&pageSize=100'), request<UserPage>(`/users?${capabilityUserParams.toString()}`), request<OrgUnit[]>('/org-units'), request<AdminCapabilityBundle>('/admin/capabilities'), request<Announcement[]>('/announcements'), request<AuditPage>('/audits?page=1&pageSize=100'), request<QueueStats>('/admin/grading-queue'), adminAccess.level === 'GLOBAL' ? request<CodeAgentRuntimeConfig>('/admin/code-agent-runtime') : Promise.resolve(null), adminAccess.level === 'GLOBAL' ? request<CodeAgentRuntimeDiagnostics>('/admin/code-agent-runtime/diagnostics').catch(() => null) : Promise.resolve(null),
    ]);
    setOverview(loadedOverview);
    setChallenges(loadedChallenges);
    // The executor catalogue ships with the platform; a failure here must not
    // break the rest of the console.
    void request<BuiltInExecutor[]>('/evaluation-executors').then(setBuiltInExecutors).catch(() => setBuiltInExecutors([]));
    // Contract choices are Git-pinned metadata. Keep this request independent
    // from the main refresh so an optional catalogue read cannot turn a
    // successful administrator mutation into a visible failure.
    void request<EvaluationContractOption[]>('/evaluation-contracts').then(setEvaluationContractCatalog).catch(() => undefined);
    setEvents(loadedEvents);
    setSubmissions(loadedSubmissionPage.items);
    // v0.7 users and capability candidates are returned through stable
    // server-side page envelopes; the capability picker never downloads the
    // full employee directory.
    setUsers(loadedUsers.items);
    setCapabilityUserPage(loadedCapabilityUsers);
    setCapabilityEventId('');
    setCapabilityProfilePage(1);
    setCapabilityProfileMode('ALL');
    setCapabilityIncludeProfiles(true);
    setOrgUnits(loadedOrgUnits);
    setAdminCapabilities(loadedCapabilities);
    setAnnouncements(loadedAnnouncements);
    setAudits(loadedAuditPage.items);
    setQueue(loadedQueue);
    setCodeAgentRuntime(loadedRuntime);
    setCodeAgentRuntimeDiagnostics(loadedRuntimeDiagnostics);
    const firstActiveChallenge = loadedChallenges.find((challenge) => challenge.status !== 'ARCHIVED') ?? loadedChallenges[0];
    if (!selectedChallengeId && firstActiveChallenge) setSelectedChallengeId(firstActiveChallenge.id);
    if (!participantEventId && loadedEvents[0]) setParticipantEventId(loadedEvents[0].id);
  }

  async function openEvaluationContractDetail(contract: EvaluationContractOption): Promise<void> {
    setEvaluationContractDetailBusy(true);
    setEvaluationContractCopied(false);
    try {
      const detail = await request<EvaluationContractDetail>(`/evaluation-contracts/${encodeURIComponent(contract.id)}`);
      setEvaluationContractDetail(detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '评测约束详情加载失败');
    } finally {
      setEvaluationContractDetailBusy(false);
    }
  }

  function closeEvaluationContractDetail(): void {
    setEvaluationContractDetail(null);
    setEvaluationContractCopied(false);
  }

  async function copyTextToClipboard(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Local HTTP pages and embedded browsers may expose the API but reject
        // it without a secure clipboard permission; use the DOM fallback below.
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('浏览器未允许复制到剪贴板');
  }

  function evaluationContractAiPrompt(detail: EvaluationContractDetail): string {
    return [
      '你是 AI 训战平台的赛题设计助手。请严格根据下面这份已发布的评测约束，为我设计可落地、可审计的赛题评测配置。',
      `约束类型：${evaluationContractKindLabel(detail.kind)}`,
      `约束名称：${detail.label}`,
      `适用评测方式：${detail.modes.map(evaluationContractModeLabel).join('、')}`,
      `Schema 路径：${detail.path}`,
      `Schema 版本：${detail.schemaVersion}`,
      '',
      '约束说明：',
      detail.description,
      '',
      '请依次输出：',
      '1. 你理解的赛题目标、学员交付物和评测流程；',
      '2. evaluationEngine 配置草稿；输入/输出约束必须使用 Git 目录中已有的路径、版本、字段和枚举值，不得创建新的 contractPath；',
      '3. rubric/criteria 设计、每个评分点的证据来源、平台可重算的总分规则；',
      '4. 需要管理员确认的参数，以及可能导致 Schema 校验失败的风险。',
      '',
      'Schema：',
      '```json',
      prettyJson(detail.schema),
      '```',
      '',
      '已校验示例：',
      '```json',
      prettyJson(detail.example),
      '```',
      '',
      '仓库中的编写说明：',
      detail.guide,
    ].join('\n');
  }

  async function copyEvaluationContractForAi(detail: EvaluationContractDetail): Promise<void> {
    try {
      await copyTextToClipboard(evaluationContractAiPrompt(detail));
      setEvaluationContractCopied(true);
      setMessage('评测约束详情已复制，可直接粘贴给 AI 出题');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '复制失败，请手动选择详情内容');
    }
  }

  useEffect(() => { void refresh().catch((error: Error) => setMessage(error.message)); }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 5000);
    return () => window.clearTimeout(timer);
  }, [message]);

  async function runAction(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setMessage('正在保存，请稍候…');
    try { await action(); setMessage(success); await refresh(); return true; } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败，请稍后重试'); return false; } finally { setBusy(false); }
  }

  async function loadAdminCapabilities(mode: 'ALL' | 'SELECTED', includeProfiles = mode === 'ALL' && !capabilityOrgPath, profilePage = 1) {
    if (mode === 'SELECTED' && !capabilitySubjectIds.length) {
      setMessage('请选择参训员工');
      return;
    }
    const params = new URLSearchParams();
    if (capabilityOrgPath) params.set('orgPath', capabilityOrgPath);
    if (capabilityEventId) params.set('eventId', capabilityEventId);
    if (mode === 'SELECTED') params.set('subjectIds', capabilitySubjectIds.join(','));
    params.set('includeProfiles', String(includeProfiles));
    params.set('page', String(profilePage));
    params.set('pageSize', '20');
    params.set('historyPage', '1');
    params.set('historyPageSize', '20');
    setCapabilityProfilePage(profilePage);
    setCapabilityProfileMode(mode);
    setCapabilityIncludeProfiles(includeProfiles);
    setBusy(true);
      setMessage('正在加载群体能力画像…');
    try {
      const query = params.toString();
      const loaded = await request<AdminCapabilityBundle>(`/admin/capabilities${query ? `?${query}` : ''}`);
      setAdminCapabilities(loaded);
      setSection('capabilities');
      setMessage(mode === 'ALL' ? (capabilityEventId ? '已加载所选训战的 AI 评测画像' : '已加载所选范围的平均画像') : `已加载 ${loaded.selectedCount} 人的平均画像`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '群体能力画像加载失败');
    } finally {
      setBusy(false);
    }
  }

  function toggleCapabilitySubject(subjectId: string) {
    setCapabilitySubjectIds((current) => current.includes(subjectId) ? current.filter((id) => id !== subjectId) : [...current, subjectId]);
  }

  function selectAllCapabilityUsers() {
    setCapabilitySubjectIds((current) => [...new Set([...current, ...capabilityUsers.map((user) => user.id)])]);
  }

  function handleCapabilityOrgPathChange(path: string) {
    setCapabilityOrgPath(path);
    setCapabilitySubjectIds([]);
    setCapabilityProfilePage(1);
    void loadCapabilityUsers(1, path);
  }

  function handleCapabilityEventChange(eventId: string) {
    setCapabilityEventId(eventId);
    setCapabilitySubjectIds([]);
    setCapabilityProfilePage(1);
  }

  function submissionContractFromDraft(form: ChallengeDraft): Record<string, unknown> | undefined {
    if (!form.submissionContractJson.trim()) return undefined;
    const parsed = JSON.parse(form.submissionContractJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('交付目录规范必须是 JSON 对象');
    return parsed as Record<string, unknown>;
  }

  function buildVersion(form: ChallengeDraft, challengeId: string, versionNumber: number): ChallengeVersion {
    const allowedSources: Source[] = [form.allowUpload ? 'UPLOAD' : null, form.allowGit ? 'GIT_REF' : null].filter((source): source is Source => source !== null);
    const upload = form.allowUpload ? { formats: ['zip'], maxBytes: 50 * 1024 * 1024, maxFiles: 2000 } : undefined;
    const git = form.allowGit && form.repository ? { provider: 'GITLAB', repository: form.repository, branchTemplate: form.branchTemplate || 'drill/{subjectId}', pinAt: 'SUBMIT', credentialRef: 'gitlab-grader-readonly' } : undefined;
    const submissionContractDefinition = submissionContractFromDraft(form);
    const inputContract = evaluationContractCatalog.find((item) => item.kind === 'INPUT' && item.modes.includes(form.evaluationEngineMode) && item.path === form.evaluationInputContract);
    const outputContract = evaluationContractCatalog.find((item) => item.kind === 'OUTPUT' && item.modes.includes(form.evaluationEngineMode) && item.path === form.evaluationOutputContract);
    if (!inputContract || !outputContract) throw new Error('请选择当前评测方式对应的 Git 评测约束');
    return {
    id: `${challengeId}@${versionNumber}`, challengeId, version: versionNumber, title: form.title.trim(), description: sanitizeRichText(form.description).trim(), objectives: lines(form.objectives), requirements: lines(form.requirements), constraints: lines(form.constraints), deliverables: lines(form.deliverables), tags: lines(form.tags), estimatedMinutes: Number(form.estimatedMinutes) || 45, zone: form.zone, languagePolicy: { mode: 'fixed', languages: lines(form.languages) }, deliveryPolicy: { allowedSources, ...(upload ? { upload } : {}), ...(git ? { git } : {}) }, rubricVersion: form.rubricVersion || '1.0', submissionContract: form.submissionContract.trim(), ...(submissionContractDefinition ? { submissionContractDefinition } : {}), status: 'DRAFT',
      evaluationEngine: {
        id: form.evaluationEngineId.trim() || `${challengeId}-evaluator`,
        version: form.evaluationEngineVersion.trim() || '1.0.0',
        mode: form.evaluationEngineMode,
        // Only a PLATFORM_LOCAL engine carries executor parameters; the API
        // rejects them on an EXTERNAL_CLI engine.
        ...(form.evaluationEngineMode === 'PACKAGED' && form.enginePackage ? { package: form.enginePackage } : {}),
        ...(form.evaluationEngineMode === 'PLATFORM_LOCAL' ? {
          executor: {
            id: form.executorId,
            params: Object.fromEntries(Object.entries(form.executorParams).filter(([, value]) => String(value ?? '').trim()).map(([key, value]) => [key, String(value).trim()])),
          },
        } : {}),
        ...(form.evaluationEngineMode !== 'EXTERNAL_CLI' ? { agent: { instructionPath: form.agentInstructionPath.trim(), skillPaths: lines(form.agentSkillPaths) } } : {}),
        input: { format: 'JSON', schemaVersion: inputContract.schemaVersion, contractPath: inputContract.path },
        output: { format: 'JSON', schemaVersion: outputContract.schemaVersion, contractPath: outputContract.path },
      },
    };
  }

  async function saveChallenge() {
    if (!challengeForm) return;
    if (!challengeForm.id.trim() || !challengeForm.title.trim()) { setMessage('请填写赛题 ID 和标题'); return; }
    if (!richTextPreview(challengeForm.description)) { setMessage('请填写赛题详情'); return; }
    if (!challengeForm.allowUpload && !challengeForm.allowGit) { setMessage('至少选择一种提交方式'); return; }
    if (!lines(challengeForm.languages).length) { setMessage('至少填写一种支持的编程语言'); return; }
    if (!evaluationContractCatalog.length) { setMessage('评测约束目录尚未加载，请稍后重试'); return; }
    if (challengeForm.allowGit && !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(challengeForm.repository.trim())) { setMessage('Git 仓库路径格式不正确'); return; }
    try { submissionContractFromDraft(challengeForm); } catch (error) { setMessage(error instanceof Error ? error.message : '交付目录规范格式不正确'); return; }
    if (!localEngineComplete(challengeForm)) { setMessage(challengeForm.evaluationEngineMode === 'PACKAGED' ? '请先上传评测引擎包' : '请选择内置执行器并填写其必填参数'); return; }
    let version: ChallengeVersion;
    try { version = buildVersion(challengeForm, challengeForm.id.trim(), 1); } catch (error) { setMessage(error instanceof Error ? error.message : '评测约束配置不完整'); return; }
    const saved = await runAction(() => request('/challenges', { method: 'POST', body: JSON.stringify({ id: challengeForm.id.trim(), ownerOrgPath: '/', origin: challengeForm.category === 'HARD_PROBLEM' ? 'BOUNTY' : 'OFFICIAL', category: challengeForm.category, status: 'DRAFT', versions: [version], actorId: 'admin-local' }) }), '赛题草稿已创建');
    if (saved) setChallengeForm(null);
  }

  function localEngineComplete(form: ChallengeDraft): boolean {
    if (form.evaluationEngineMode !== 'EXTERNAL_CLI' && (!form.agentInstructionPath.trim() || !lines(form.agentSkillPaths).length)) return false;
    if (form.evaluationEngineMode === 'PACKAGED') return Boolean(form.enginePackage?.packageHash);
    if (form.evaluationEngineMode !== 'PLATFORM_LOCAL') return true;
    const selected = builtInExecutors.find((item) => item.id === form.executorId);
    if (!selected) return false;
    return (selected.params?.required ?? []).every((key: string) => Boolean(String(form.executorParams[key] ?? '').trim()));
  }

  /** Upload an engine package and pin the returned content hash onto the draft. */
  async function uploadEnginePackage(file: File, form: ChallengeDraft, setForm: (next: ChallengeDraft) => void): Promise<void> {
    if (!file.name.toLowerCase().endsWith('.zip')) { setMessage('引擎包必须是 zip 文件'); return; }
    setBusy(true);
    setMessage('正在上传并校验引擎包…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const uploaded = await request<EnginePackageUpload>('/evaluation-engines', {
        method: 'POST',
        body: JSON.stringify({ packageBase64: toBase64(bytes), fileName: file.name }),
      });
      setForm({
        ...form,
        evaluationEngineMode: 'PACKAGED',
        evaluationEngineId: uploaded.engine.id,
        evaluationEngineVersion: uploaded.engine.version,
        enginePackage: { packageHash: uploaded.packageHash, size: uploaded.size, fileName: uploaded.fileName },
        enginePackageSummary: `${uploaded.fileName ?? file.name} · ${(uploaded.size / 1024).toFixed(1)} KB · ${uploaded.packageHash.slice(0, 12)}…`,
        ...evaluationContracts('PACKAGED'),
      });
      setMessage(`引擎包已入库：${uploaded.engine.id}@${uploaded.engine.version}，入口 ${uploaded.runtime.entrypoint}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '引擎包上传失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveVersion() {
    if (!versionForm || !selectedChallenge) return;
    if (!richTextPreview(versionForm.description)) { setMessage('请填写赛题详情'); return; }
    if (!lines(versionForm.languages).length) { setMessage('至少填写一种支持的编程语言'); return; }
    if (!evaluationContractCatalog.length) { setMessage('评测约束目录尚未加载，请稍后重试'); return; }
    if (versionForm.allowGit && !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(versionForm.repository.trim())) { setMessage('Git 仓库路径格式不正确'); return; }
    try { submissionContractFromDraft(versionForm); } catch (error) { setMessage(error instanceof Error ? error.message : '交付目录规范格式不正确'); return; }
    if (!localEngineComplete(versionForm)) { setMessage(versionForm.evaluationEngineMode === 'PACKAGED' ? '请先上传评测引擎包' : '请选择内置执行器并填写其必填参数'); return; }
    let saved = false;
    if (versionEditId) {
      const current = selectedChallenge.versions.find((item) => item.id === versionEditId);
      if (!current) return;
      let version: ChallengeVersion;
      try { version = buildVersion(versionForm, selectedChallenge.id, current.version); } catch (error) { setMessage(error instanceof Error ? error.message : '评测约束配置不完整'); return; }
      const { id: _id, challengeId: _challengeId, version: _version, status: _status, ...patch } = version;
      saved = await runAction(() => request(`/challenges/${selectedChallenge.id}/versions/${versionEditId}`, { method: 'PATCH', body: JSON.stringify({ ...patch, actorId: 'admin-local' }) }), '赛题草稿已保存');
    } else {
      const nextNumber = Math.max(...selectedChallenge.versions.map((version) => version.version), 0) + 1;
      let version: ChallengeVersion;
      try { version = buildVersion(versionForm, selectedChallenge.id, nextNumber); } catch (error) { setMessage(error instanceof Error ? error.message : '评测约束配置不完整'); return; }
      saved = await runAction(() => request(`/challenges/${selectedChallenge.id}/versions`, { method: 'POST', body: JSON.stringify({ ...version, actorId: 'admin-local' }) }), `v${nextNumber} 草稿已创建`);
    }
    if (saved) {
      setVersionForm(null);
      setVersionEditId('');
    }
  }

  /** Open the safe challenge editing flow. Published versions stay immutable;
   * editing one creates the next draft version, while an existing draft is
   * edited in place. */
  function editChallenge(challenge: Challenge) {
    if (challenge.status === 'ARCHIVED') {
      setMessage('请先恢复赛题，再进行编辑');
      return;
    }
    const latest = challenge.versions.slice().sort((left, right) => right.version - left.version)[0];
    if (!latest) {
      setMessage('该赛题暂无可编辑版本');
      return;
    }
    const draft = challenge.versions.slice().sort((left, right) => right.version - left.version).find((version) => version.status === 'DRAFT');
    setChallengeView('active');
    setSelectedChallengeId(challenge.id);
    setChallengeForm(null);
    setVersionEditId(draft?.id ?? '');
    setVersionForm(draftFromVersion(draft ?? latest));
    setMessage(draft ? '已打开赛题草稿编辑器' : '已基于最新发布版本创建编辑草稿，保存后将生成新版本');
  }

  async function saveEvent() {
    if (!eventForm?.id.trim() || !eventForm.challengeVersion) { setMessage('请填写训战 ID，并选择已发布的赛题版本'); return; }
    if (!eventForm.startsAt || !eventForm.endsAt) { setMessage('请配置训战开放时间：开始时间和结束时间都不能为空'); return; }
    const startsAt = new Date(eventForm.startsAt);
    const endsAt = new Date(eventForm.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) { setMessage('训战结束时间必须晚于开始时间'); return; }
    const deliveryConfig = eventForm.submissionSource === 'GIT_REF'
      ? { repository: eventForm.repository.trim(), branchTemplate: eventForm.branchTemplate || 'drill/{subjectId}', pinAt: eventForm.trigger === 'AUTO' ? 'SUBMIT' : eventForm.pinAt }
      : { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024, maxFiles: 2000 };
    const eventPayload = { challengeVersion: eventForm.challengeVersion, submissionSource: eventForm.submissionSource, trigger: eventForm.trigger, reveal: eventForm.reveal, mode: eventForm.mode, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), deliveryConfig, accessPolicy: { mode: eventForm.accessMode, departmentIds: eventForm.departmentIds, mentorIds: eventForm.mentorIds } };
    const editing = Boolean(eventEditId);
    const success = await runAction(() => request(editing ? `/events/${eventEditId}` : '/events', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ ...(editing ? {} : { id: eventForm.id.trim() }), ...eventPayload, actorId: 'admin-local' }) }), editing ? '训战配置已保存' : '训战已创建');
    if (success) { setEventForm(null); setEventEditId(''); }
  }

  async function eventAction(event: EventConfig, action: 'start-grading' | 'close' | 'reveal') {
    if (action === 'start-grading') {
      setSelectedGradingIds([]);
      setSection('grading');
      setMessage(`请在评测中心选择「${versionTitle(event.challengeVersion, challenges)}」的提交`);
      return;
    }
    const body = JSON.stringify({ actorId: 'admin-local' });
    await runAction(() => request(`/events/${event.id}/${action}`, { method: 'POST', body }), action === 'close' ? '场次已结束' : '评测结果已公布');
  }

  async function deleteEvent(event: EventConfig) {
    if (!window.confirm(`确认删除训战“${event.id}”吗？已有提交的训战不能删除。`)) return;
    await runAction(() => request(`/events/${event.id}`, { method: 'DELETE' }), '训战已删除');
  }

  function toggleGradingSelection(submissionId: string) {
    setSelectedGradingIds((current) => current.includes(submissionId) ? current.filter((id) => id !== submissionId) : [...current, submissionId]);
  }

  function selectEventSubmissions(eventId: string) {
    const ids = pendingSubmissions.filter((submission) => submission.eventId === eventId).map((submission) => submission.id);
    setSelectedGradingIds((current) => [...new Set([...current.filter((id) => !ids.includes(id)), ...ids])]);
  }

  function clearEventSubmissions(eventId: string) {
    const ids = new Set(pendingSubmissions.filter((submission) => submission.eventId === eventId).map((submission) => submission.id));
    setSelectedGradingIds((current) => current.filter((id) => !ids.has(id)));
  }

  async function prepareEvaluationInput(eventId: string) {
    const submissionIds = selectedGradingIds.filter((id) => pendingSubmissions.some((submission) => submission.id === id && submission.eventId === eventId));
    if (!submissionIds.length) { setMessage('请选择要评测的提交'); return; }
    await runAction(async () => {
      const batch = await request<EvaluationInputBatch>(`/events/${eventId}/grading-input`, { method: 'POST', body: JSON.stringify({ submissionIds, actorId: 'admin-local' }) });
      const blob = new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `evaluation-task-${eventId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }, `已导出 ${submissionIds.length} 份提交的评测任务`);
  }

  async function startSelectedGrading(eventId: string) {
    const submissionIds = selectedGradingIds.filter((id) => pendingSubmissions.some((submission) => submission.id === id && submission.eventId === eventId));
    if (!submissionIds.length) { setMessage('请选择要评测的提交'); return; }
    await runAction(() => request(`/events/${eventId}/start-grading`, { method: 'POST', body: JSON.stringify({ submissionIds, actorId: 'admin-local' }) }), `已创建评测批次，共 ${submissionIds.length} 份提交`);
  }

  async function submissionAction(submission: Submission) {
    await runAction(() => request(`/submissions/${submission.id}/start-grading`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '已创建单人评测批次');
  }

  async function regradeSubmission(submission: Submission) {
    await runAction(() => request(`/submissions/${submission.id}/regrade`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '已创建新的评测任务');
  }

  async function downloadSubmissionArtifact(submission: Submission) {
    const employeeId = typeof window === 'undefined' ? ADMIN_EMPLOYEE_ID : window.localStorage.getItem('ai-training.employeeId') ?? ADMIN_EMPLOYEE_ID;
    const response = await fetch(`${API}/submissions/${submission.id}/artifact`, { headers: { 'x-employee-id': employeeId } });
    if (!response.ok) {
      const detail = await response.text();
      let message = '';
      try {
        const payload = JSON.parse(detail) as { message?: string | string[] };
        message = Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? '';
      } catch {
        message = detail.trim();
      }
      throw new Error(humanizeApiMessage(message || '交付件下载失败'));
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = submission.snapshot.artifactName ?? `submission-${submission.id}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    setMessage(`已下载 ${anchor.download}`);
  }

  async function importResult(): Promise<boolean> {
    try {
      const result = JSON.parse(importText) as Record<string, unknown>;
      const success = await runAction(() => request('/grading-results:import', { method: 'POST', body: JSON.stringify({ result, actorId: 'admin-local' }) }), '评测结果已导入');
      if (success) setImportText('');
      return success;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '评测结果格式不正确');
      return false;
    }
  }

  async function saveCodeAgentRuntime(input: Pick<CodeAgentRuntimeConfig, 'enabled' | 'commandLine' | 'prompt' | 'timeoutSeconds'>) {
    await runAction(
      () => request('/admin/code-agent-runtime', { method: 'PUT', body: JSON.stringify(input) }),
      'Code Agent 运行配置已保存',
    );
  }

  async function testCodeAgentRuntime(input: Pick<CodeAgentRuntimeConfig, 'commandLine' | 'prompt' | 'timeoutSeconds'>): Promise<CodeAgentRuntimeTestResult | null> {
    setBusy(true);
    setMessage('正在执行 Code Agent 配置测试…');
    try {
      const result = await request<CodeAgentRuntimeTestResult>('/admin/code-agent-runtime/test', { method: 'POST', body: JSON.stringify(input) });
      setMessage(result.message);
      return result;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Code Agent 配置测试失败');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createAnnouncement() {
    if (!announcementForm.title.trim() || !announcementForm.summary.trim()) { setMessage('请填写公告标题和摘要'); return; }
    await runAction(() => request('/announcements', { method: 'POST', body: JSON.stringify({ ...announcementForm, publishedAt: new Date().toISOString(), actorId: 'admin-local' }) }), '公告已发布');
    setAnnouncementForm({ title: '', summary: '', tag: '平台通知', pinned: false });
  }

  async function loadParticipants(eventId: string) {
    setParticipantEventId(eventId);
    try {
      const rows = await request<Array<{ subjectId: string }>>(`/events/${eventId}/participants`);
      setParticipantSubjectIds([...new Set(rows.map((row) => row.subjectId).filter(Boolean))]);
      setMessage(rows.length ? `已加载 ${rows.length} 名参训员工` : '暂无参训员工');
    } catch (error) { setMessage(error instanceof Error ? error.message : '参训名单加载失败'); throw error; }
  }

  async function saveParticipants() {
    if (!participantEventId) return;
    const subjectIds = [...new Set(participantSubjectIds.map((id) => id.trim()).filter(Boolean))];
    await runAction(() => request(`/events/${participantEventId}/participants`, { method: 'PUT', body: JSON.stringify({ subjectIds }) }), `参训名单已保存，共 ${subjectIds.length} 人`);
  }

  const menu: Array<{ id: AdminSection; label: string; icon: IconName; count?: number }> = [
    { id: 'overview', label: '运营总览', icon: 'grid' },
    { id: 'organization', label: '组织与人员', icon: 'users', count: users.length },
    { id: 'events', label: '训战管理', icon: 'clock', count: activeEventCount },
    { id: 'challenges', label: '赛题库', icon: 'challenge', count: overview ? overview.challenges.total - overview.challenges.archived : undefined },
    { id: 'participants', label: '参训名单', icon: 'participants' },
    { id: 'capabilities', label: 'AI 能力画像', icon: 'capabilities', count: adminCapabilities?.selectedCount },
    { id: 'grading', label: '评测中心', icon: 'grading', count: overview?.grading.queuedOrRunning },
    ...(adminAccess.level === 'GLOBAL' ? [{ id: 'evaluation-runtime' as const, label: '评测环境', icon: 'runtime' as const }] : []),
    { id: 'announcements', label: '公告管理', icon: 'announcement', count: overview?.announcements },
    { id: 'audit', label: '审计日志', icon: 'audit' },
  ];

  const scopeLabel = adminAccess.level === 'GLOBAL' ? '全组织' : '所属部门及下属组织';
  const roleLabel = adminAccess.level === 'GLOBAL' ? '全局管理员' : '部门管理员';
  return <main className="admin-page">
    <section className="admin-heading panel"><div><p className="kicker">管理后台</p><h1>管理后台</h1></div><button className="secondary-button" onClick={onExit}>← 返回员工首页</button></section>
    <div className="admin-layout">
      <aside className="admin-sidebar panel"><div className="admin-sidebar-title"><span className="admin-mark"><Icon name="grid" size={18} strokeWidth={2} /></span><div><strong>平台管理</strong><small>训战运营中心</small></div></div><nav>{menu.map((item) => <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}><span><Icon name={item.icon} size={18} /></span><b>{item.label}</b>{item.count !== undefined && <em>{item.count}</em>}</button>)}</nav><div className="admin-sidebar-note"><strong>权限范围</strong><span>当前账号：{roleLabel}</span><span>组织范围：{scopeLabel}</span></div></aside>
      <section className="admin-main">
        {message && <div className="admin-message" role="status" aria-live="polite"><span>{message}</span><button type="button" className="admin-message-close" aria-label="关闭提示" onClick={() => setMessage('')}>×</button></div>}
        {section === 'overview' && <OverviewSection overview={overview} challenges={challenges} events={events} submissions={submissions} onSection={setSection} />}
        {section === 'organization' && <OrganizationSection users={users} orgUnits={orgUnits} currentUserId={userId} adminAccess={adminAccess} busy={busy} onSaved={refresh} onMessage={setMessage} />}
        {section === 'challenges' && <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">赛题库</p><h2>赛题库</h2></div><div className="admin-section-actions"><button type="button" className="secondary-button admin-guide-button" onClick={() => setAdminGuide('challenges')}>说明指导</button><button className="primary compact" onClick={() => { setChallengeView('active'); setChallengeForm(blankChallenge()); }}>＋ 新建赛题</button></div></div>{challengeForm && <ChallengeEditor form={challengeForm} setForm={setChallengeForm} onCancel={() => setChallengeForm(null)} onSave={() => void saveChallenge()} onUploadPackage={(file) => uploadEnginePackage(file, challengeForm, setChallengeForm)} executors={builtInExecutors} contracts={evaluationContractCatalog} onViewContractDetail={(contract) => void openEvaluationContractDetail(contract)} busy={busy} title="创建赛题草稿" />}{versionForm && selectedChallenge && <ChallengeEditor form={versionForm} setForm={setVersionForm} onCancel={() => { setVersionForm(null); setVersionEditId(''); }} onSave={() => void saveVersion()} onUploadPackage={(file) => uploadEnginePackage(file, versionForm, setVersionForm)} executors={builtInExecutors} contracts={evaluationContractCatalog} onViewContractDetail={(contract) => void openEvaluationContractDetail(contract)} busy={busy} title={versionEditId ? `编辑 ${selectedChallenge.id} 草稿` : `创建 ${selectedChallenge.id} 新版本`} />}{!challengeForm && !versionForm && <ChallengeList challenges={visibleChallenges} view={challengeView} activeCount={challenges.filter((challenge) => challenge.status !== 'ARCHIVED').length} trashCount={challenges.filter((challenge) => challenge.status === 'ARCHIVED').length} onViewChange={setChallengeView} selectedId={selectedChallengeId} onSelect={setSelectedChallengeId} onEdit={editChallenge} onPublish={(id) => void runAction(() => request(`/challenges/${id}/publish`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '赛题已发布')} onTrash={(id) => { if (!window.confirm(`确认删除赛题“${id}”吗？删除后可在回收站恢复。`)) return; void runAction(() => request(`/challenges/${id}`, { method: 'DELETE' }), '赛题已移入回收站'); }} onRestore={(id) => void runAction(() => request(`/challenges/${id}/restore`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '赛题已恢复')} onPurge={(id) => { if (!window.confirm(`确认永久删除赛题“${id}”吗？此操作不可恢复，历史关联训战会阻止删除。`)) return; void runAction(() => request(`/challenges/${id}/permanent`, { method: 'DELETE' }), '赛题已永久删除'); }} />}{selectedChallenge && !challengeForm && !versionForm && <ChallengeDetail challenge={selectedChallenge} events={events} onNewVersion={() => { setVersionEditId(''); setVersionForm(draftFromVersion(selectedChallenge.versions[selectedChallenge.versions.length - 1])); }} onEditVersion={(version) => { setVersionEditId(version.id); setVersionForm(draftFromVersion(version)); }} onCategoryChange={(category) => void runAction(() => request(`/challenges/${selectedChallenge.id}`, { method: 'PATCH', body: JSON.stringify({ category, actorId: 'admin-local' }) }), '赛题类型已更新')} onSolutionVisibilityChange={(solutionVisibility) => void runAction(() => request(`/challenges/${selectedChallenge.id}`, { method: 'PATCH', body: JSON.stringify({ solutionVisibility, actorId: 'admin-local' }) }), '交付件展示策略已更新')} onPublish={(versionId) => void runAction(() => request(`/challenges/${selectedChallenge.id}/versions/${versionId}/publish`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '赛题版本已发布')} />}</section>}
        {section === 'events' && <EventsSection events={events} challenges={challenges} overview={overview} users={users} orgUnits={orgUnits} eventForm={eventForm} setEventForm={setEventForm} eventEditId={eventEditId} onNew={() => { setEventEditId(''); setEventForm(blankEvent(publishedVersions[0]?.id ?? '', challenges)); }} onEdit={(event) => { setEventEditId(event.id); setEventForm(draftFromEvent(event)); }} onDelete={(event) => void deleteEvent(event)} onCreate={() => void saveEvent()} onAction={(event, action) => void eventAction(event, action)} onOpenGuide={() => setAdminGuide('events')} busy={busy} />}
        {section === 'participants' && <ParticipantSection events={events} users={users} eventId={participantEventId} setEventId={(id) => { setParticipantEventId(id); setParticipantSubjectIds([]); }} selectedIds={participantSubjectIds} setSelectedIds={setParticipantSubjectIds} onLoad={loadParticipants} onSave={() => void saveParticipants()} busy={busy} />}
        {section === 'capabilities' && <CapabilityAdminSection data={adminCapabilities} events={events} challenges={challenges} users={capabilityUsers} userPageInfo={capabilityUserPage?.pageInfo ?? null} usersBusy={capabilityUsersBusy} orgUnits={orgUnits} orgPath={capabilityOrgPath} eventId={capabilityEventId} selectedIds={capabilitySubjectIds} onOrgPathChange={handleCapabilityOrgPathChange} onEventIdChange={handleCapabilityEventChange} onUsersPageChange={(page) => void loadCapabilityUsers(page)} onToggle={toggleCapabilitySubject} onSelectAll={selectAllCapabilityUsers} onClear={() => setCapabilitySubjectIds([])} onViewAll={() => void loadAdminCapabilities('ALL')} onViewSelected={() => void loadAdminCapabilities('SELECTED')} profilePage={capabilityProfilePage} onProfilePageChange={(page) => void loadAdminCapabilities(capabilityProfileMode, capabilityIncludeProfiles, page)} busy={busy} />}
        {section === 'grading' && <GradingSection submissions={gradingSubmissions} events={events} challenges={challenges} users={users} queue={queue} selectedIds={selectedGradingIds} importText={importText} setImportText={setImportText} onToggle={toggleGradingSelection} onSelectEvent={selectEventSubmissions} onClearEvent={clearEventSubmissions} onPrepareInput={(eventId) => void prepareEvaluationInput(eventId)} onStartSelected={(eventId) => void startSelectedGrading(eventId)} onSubmission={(submission) => void submissionAction(submission)} onRegrade={(submission) => void regradeSubmission(submission)} onDownload={(submission) => void downloadSubmissionArtifact(submission).catch((error) => setMessage(error instanceof Error ? error.message : '交付件下载失败'))} onImport={importResult} busy={busy} />}
        {section === 'evaluation-runtime' && codeAgentRuntime && <CodeAgentRuntimeSection config={codeAgentRuntime} diagnostics={codeAgentRuntimeDiagnostics} busy={busy} onSave={(input) => void saveCodeAgentRuntime(input)} onTest={testCodeAgentRuntime} onOpenGuide={() => setAdminGuide('evaluation-runtime')} />}
        {section === 'announcements' && <AnnouncementSection announcements={announcements} form={announcementForm} setForm={setAnnouncementForm} onCreate={() => void createAnnouncement()} onDelete={(id) => void runAction(() => request(`/announcements/${id}`, { method: 'DELETE', body: JSON.stringify({ actorId: 'admin-local' }) }), '公告已删除')} busy={busy} />}
        {section === 'audit' && <AuditSection audits={audits} />}
        {evaluationContractDetail && <EvaluationContractDetailDialog detail={evaluationContractDetail} busy={evaluationContractDetailBusy} copied={evaluationContractCopied} onClose={closeEvaluationContractDetail} onCopy={() => void copyEvaluationContractForAi(evaluationContractDetail)} />}
        {adminGuide && <AdminGuideDialog guide={adminGuide} onClose={() => setAdminGuide(null)} />}
      </section>
    </div>
  </main>;
}

function OverviewSection({ overview, challenges, events, submissions, onSection }: { overview: Overview | null; challenges: Challenge[]; events: EventConfig[]; submissions: Submission[]; onSection: (section: AdminSection) => void }) {
  const now = Date.now();
  const title = (versionId: string) => versionTitle(versionId, challenges);
  if (overview) {
    overview = {
      ...overview,
      events: { ...overview.events, open: events.filter((event) => event.status === 'OPEN' && eventWindowState(event, now) === 'OPEN').length },
      eventStats: overview.eventStats.map((item) => {
        const event = events.find((candidate) => candidate.id === item.eventId);
        return event ? { ...item, status: eventDisplayStatus(event, now) } : item;
      }),
    };
  }
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">运营总览</p><h2>运营总览</h2></div><span className="last-sync">{overview ? `更新于 ${formatDate(overview.generatedAt)}` : '加载中…'}</span></div><div className="admin-stat-grid"><AdminStat label="已发布赛题" value={overview?.challenges.published ?? '—'} hint={`${overview?.challenges.versions ?? 0} 个赛题版本`} tone="blue" /><AdminStat label="开放训战" value={overview?.events.open ?? '—'} hint={`${overview?.events.total ?? 0} 个训战配置`} tone="violet" /><AdminStat label="待处理评测" value={overview?.grading.queuedOrRunning ?? '—'} hint={`${overview?.grading.failed ?? 0} 个需要重试`} tone="orange" /><AdminStat label="累计提交" value={overview?.submissions.total ?? '—'} hint={`${overview?.submissions.graded ?? 0} 份已完成`} tone="green" /></div><div className="admin-overview-grid"><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">训战监控</p><h3>训战运行状态</h3></div><button className="quiet" onClick={() => onSection('events')}>管理训战 →</button></div>{overview?.eventStats.map((item) => <div className="event-monitor-row" key={item.eventId}><span className={`monitor-dot monitor-${item.status.toLowerCase()}`} /><div><strong>{title(item.challengeVersion)}</strong><small>{statusLabel(item.status)}</small></div><span>{item.submissionCount} 份提交</span><b>{item.pendingCount > 0 ? `${item.pendingCount} 待处理` : '当前无待处理项'}</b></div>)}{!overview?.eventStats.length && <div className="empty">暂无训战</div>}</section><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">常用操作</p><h3>常用操作</h3></div></div><div className="quick-action-grid"><button onClick={() => onSection('challenges')}><span><Icon name="challenge" size={20} /></span><strong>创建赛题</strong><small>赛题配置</small></button><button onClick={() => onSection('events')}><span><Icon name="clock" size={20} /></span><strong>创建训战</strong><small>训战配置</small></button><button onClick={() => onSection('grading')}><span><Icon name="grading" size={20} /></span><strong>进入评测中心</strong><small>评测处理</small></button><button onClick={() => onSection('announcements')}><span><Icon name="announcement" size={20} /></span><strong>发布公告</strong><small>公告发布</small></button></div></section></div><div className="admin-overview-grid"><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">最近操作</p><h3>最近操作</h3></div><button className="quiet" onClick={() => onSection('audit')}>查看全部 →</button></div>{overview?.recentAudits.slice(0, 5).map((audit) => <div className="audit-mini-row" key={audit.id}><span className="audit-icon"><Icon name={audit.action.includes('grading') ? 'grading' : audit.action.includes('challenge') ? 'challenge' : 'dot'} size={16} /></span><div><strong>{auditActionLabel(audit.action)}</strong><small>{auditTargetLabel(audit.target)} · {displayActorName(audit.actorId)}</small></div><time>{formatDate(audit.createdAt)}</time></div>)}</section><section className="panel admin-card admin-roadmap"><div className="admin-card-heading"><div><p className="kicker">运营提醒</p><h3>运营提醒</h3></div></div><div className="empty compact-empty">暂无运营提醒</div></section></div><div className="admin-footer-note">当前赛季：{overview?.activeSeason?.name ?? '尚未创建运行中赛季'}</div></section>;
}

function AdminStat({ label, value, hint, tone }: { label: string; value: string | number; hint: string; tone: string }) {
  const icon: IconName = tone === 'blue' ? 'challenge' : tone === 'violet' ? 'clock' : tone === 'orange' ? 'warning' : 'check';
  return <article className={`admin-stat panel tone-${tone}`}><span className="admin-stat-icon"><Icon name={icon} size={21} /></span><div><strong>{value}</strong><span>{label}</span><small>{hint}</small></div></article>;
}

function ChallengeListLegacy({ challenges, selectedId, onSelect, onPublish, onArchive }: { challenges: Challenge[]; selectedId: string; onSelect: (id: string) => void; onPublish: (id: string) => void; onArchive: (id: string) => void }) {
  return <div className="panel admin-table-card"><div className="admin-table-toolbar"><strong>{challenges.length} 道赛题</strong><div><span className="filter-chip">全部状态</span><span className="filter-chip">官方题库</span></div></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>赛题</th><th>版本</th><th>状态</th><th>交付方式</th><th>最近更新</th><th>操作</th></tr></thead><tbody>{challenges.map((challenge) => { const latest = challenge.versions[challenge.versions.length - 1]; const sources = latest?.deliveryPolicy.allowedSources?.map((source) => sourceLabel(source)).join(' / ') ?? '—'; return <tr key={challenge.id} className={selectedId === challenge.id ? 'selected' : ''} onClick={() => onSelect(challenge.id)}><td><strong>{latest?.title ?? '暂无赛题标题'}</strong><small>{challengeCategoryLabel(challengeCategoryOf(challenge))}</small></td><td>v{latest?.version ?? '—'} <small>{challenge.versions.length} 个版本</small></td><td><span className={`status-badge status-${challenge.status.toLowerCase()}`}>{statusLabel(challenge.status)}</span></td><td>{sources}</td><td><small>{latest?.status === 'PUBLISHED' ? '已对外开放' : '等待发布'}</small></td><td><div className="row-actions">{challenge.status !== 'PUBLISHED' && <button className="small" onClick={(event) => { event.stopPropagation(); onPublish(challenge.id); }}>发布</button>}{challenge.status !== 'ARCHIVED' && <button className="small danger" onClick={(event) => { event.stopPropagation(); onArchive(challenge.id); }}>归档</button>}<button className="small" onClick={(event) => { event.stopPropagation(); onSelect(challenge.id); }}>查看详情</button></div></td></tr>; })}</tbody></table>{!challenges.length && <div className="empty">暂无赛题</div>}</div></div>;
}

type ChallengeListProps = {
  challenges: Challenge[];
  view: 'active' | 'trash';
  activeCount: number;
  trashCount: number;
  onViewChange: (view: 'active' | 'trash') => void;
  selectedId: string;
  onSelect: (id: string) => void;
  onEdit: (challenge: Challenge) => void;
  onPublish: (id: string) => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
};

function ChallengeList({ challenges, view, activeCount, trashCount, onViewChange, selectedId, onSelect, onEdit, onPublish, onTrash, onRestore, onPurge }: ChallengeListProps) {
  const emptyText = view === 'trash' ? '垃圾箱为空' : '暂无赛题';
  return <div className="panel admin-table-card challenge-library-card">
    <div className="admin-table-toolbar">
      <div className="challenge-library-tabs" role="tablist" aria-label="赛题库视图">
        <button type="button" className={view === 'active' ? 'active' : ''} role="tab" aria-selected={view === 'active'} onClick={() => onViewChange('active')}>赛题库 <em>{activeCount}</em></button>
        <button type="button" className={view === 'trash' ? 'active' : ''} role="tab" aria-selected={view === 'trash'} onClick={() => onViewChange('trash')}>垃圾箱 <em>{trashCount}</em></button>
      </div>
      <strong>{challenges.length} {view === 'trash' ? '道已删除赛题' : '道赛题'}</strong>
    </div>
    <div className="admin-table-wrap">
      <table className="admin-table"><thead><tr><th>赛题</th><th>版本</th><th>状态</th><th>交付方式</th><th>最近更新</th><th>操作</th></tr></thead><tbody>{challenges.map((challenge) => {
        const latest = challenge.versions[challenge.versions.length - 1];
        const sources = latest?.deliveryPolicy.allowedSources?.map((source) => sourceLabel(source)).join(' / ') ?? '—';
        return <tr key={challenge.id} className={selectedId === challenge.id ? 'selected' : ''} onClick={() => onSelect(challenge.id)}>
          <td><strong>{latest?.title ?? '暂无赛题标题'}</strong><small>{challengeCategoryLabel(challengeCategoryOf(challenge))}</small></td>
          <td>v{latest?.version ?? '—'} <small>{challenge.versions.length} 个版本</small></td>
           <td><span className={`status-badge status-${challenge.status.toLowerCase()}`}>{statusLabel(challenge.status)}</span>{challenge.board?.type === 'HARD_PROBLEM' && <small className={`review-status review-status-${(challenge.board.reviewStatus ?? 'APPROVED').toLowerCase()}`}>{hardReviewStatusLabel(challenge.board.reviewStatus ?? 'APPROVED')}</small>}</td>
          <td>{sources}</td>
          <td><small>{challenge.status === 'ARCHIVED' ? '已移入垃圾箱' : latest?.status === 'PUBLISHED' ? '已对外开放' : '等待发布'}</small></td>
          <td><div className="row-actions">
            {view === 'trash' ? <><button className="small restore" onClick={(event) => { event.stopPropagation(); onRestore(challenge.id); }}>恢复赛题</button><button className="small danger" onClick={(event) => { event.stopPropagation(); onPurge(challenge.id); }}>永久删除</button></> : <>{<button className="small" onClick={(event) => { event.stopPropagation(); onEdit(challenge); }}>编辑</button>}{challenge.status !== 'PUBLISHED' && <button className="small" onClick={(event) => { event.stopPropagation(); onPublish(challenge.id); }}>发布</button>}<button className="small danger" onClick={(event) => { event.stopPropagation(); onTrash(challenge.id); }}>删除赛题</button></>}
            <button className="small" onClick={(event) => { event.stopPropagation(); onSelect(challenge.id); }}>{view === 'trash' ? '查看题面' : '查看详情'}</button>
          </div></td>
        </tr>;
      })}</tbody></table>
      {!challenges.length && <div className="empty trash-empty">{emptyText}</div>}
    </div>
  </div>;
}

function ChallengeDetail({ challenge, events, onNewVersion, onEditVersion, onCategoryChange, onSolutionVisibilityChange, onPublish, onReview }: { challenge: Challenge; events: EventConfig[]; onNewVersion: () => void; onEditVersion: (version: ChallengeVersion) => void; onCategoryChange: (category: ChallengeCategory) => void; onSolutionVisibilityChange: (visibility: 'PUBLIC' | 'HIDDEN') => void; onPublish: (versionId: string) => void; onReview?: (decision: 'APPROVE' | 'REJECT') => void }) {
  const category = challengeCategoryOf(challenge);
  const reviewStatus = challenge.board?.reviewStatus ?? 'APPROVED';
  const [reviewBusy, setReviewBusy] = useState(false);
  const [hardSubmissions, setHardSubmissions] = useState<Submission[]>([]);
  const [resolveBusy, setResolveBusy] = useState(false);
  useEffect(() => {
    const eventId = challenge.board?.type === 'HARD_PROBLEM' ? challenge.board.submissionEventId : undefined;
    if (!eventId) { setHardSubmissions([]); return; }
    void request<SubmissionPage>(`/submissions?eventId=${encodeURIComponent(eventId)}&page=1&pageSize=100`).then((page) => setHardSubmissions(page.items)).catch(() => setHardSubmissions([]));
  }, [challenge.board?.submissionEventId, challenge.board?.type]);
  async function resolveLatestHardSubmission() {
    if (challenge.board?.type !== 'HARD_PROBLEM' || challenge.board.status !== 'OPEN' || !hardSubmissions[0]) return;
    setResolveBusy(true);
    try {
      await request(`/hard-problems/${challenge.id}/resolve`, { method: 'POST', body: JSON.stringify({ submissionId: hardSubmissions[0].id }) });
      window.location.reload();
    } finally {
      setResolveBusy(false);
    }
  }
  async function review(decision: 'APPROVE' | 'REJECT') {
    if (onReview) { onReview(decision); return; }
    setReviewBusy(true);
    try {
      await request(`/hard-problems/${challenge.id}/review`, { method: 'POST', body: JSON.stringify({ decision }) });
      window.location.reload();
    } finally {
      setReviewBusy(false);
    }
  }
  return <section className="panel admin-detail-card challenge-detail-card">
    <div className="admin-card-heading"><div><p className="kicker">赛题详情</p><h3>{challenge.versions[challenge.versions.length - 1]?.title ?? '暂无赛题标题'}</h3><small>{statusLabel(challenge.status)} · {challengeCategoryLabel(category)}{challenge.board?.type === 'HARD_PROBLEM' ? ` · 难题榜${challenge.board.status === 'OPEN' ? ' · 未解决' : ' · 已解决'}` : ''}</small></div><button className="primary compact" disabled={challenge.status === 'ARCHIVED'} title={challenge.status === 'ARCHIVED' ? '需先恢复赛题' : undefined} onClick={onNewVersion}>{challenge.status === 'ARCHIVED' ? '恢复后创建版本' : '＋ 新建版本'}</button></div>
    <div className="challenge-category-control"><label>赛题类型<select value={category} disabled={challenge.status === 'ARCHIVED'} onChange={(event) => onCategoryChange(event.target.value as ChallengeCategory)}><option value="TRAINING">训战类</option><option value="COMPETITION">竞赛类</option><option value="HARD_PROBLEM">难题类</option></select></label><span>难题类赛题进入难题榜。</span></div>
    {challenge.board?.type === 'HARD_PROBLEM' && <>
      <div className="challenge-review-control"><div><strong>发布审核</strong><span className={`review-status review-status-${reviewStatus.toLowerCase()}`}>{hardReviewStatusLabel(reviewStatus)}</span>{challenge.board.reviewComment && <small>{challenge.board.reviewComment}</small>}</div><div className="review-actions"><button className="small" disabled={reviewBusy || reviewStatus === 'APPROVED'} onClick={() => void review('APPROVE')}>通过审核</button><button className="small danger" disabled={reviewBusy || reviewStatus === 'REJECTED'} onClick={() => void review('REJECT')}>驳回</button></div></div>
      <div className="linked-events"><strong>难题来源</strong><span>{challenge.board.publisherType === 'DEPARTMENT' ? '部门发布' : '员工发布'} · {displayPersonName(challenge.board.publisherName)}</span><span>{challenge.board.departmentName ?? '所属部门未注明'}</span></div>
      <div className="challenge-solution-visibility"><label>揭榜后交付件展示<select value={challenge.board.solutionVisibility ?? 'PUBLIC'} disabled={challenge.status === 'ARCHIVED'} onChange={(event) => onSolutionVisibilityChange(event.target.value as 'PUBLIC' | 'HIDDEN')}><option value="PUBLIC">公开交付件</option><option value="HIDDEN">仅展示揭榜人，不公开交付件</option></select></label><small>不公开时仅隐藏交付件摘要。</small></div>
      {challenge.board.status === 'OPEN' && <div className="hard-problem-resolution-control"><div><strong>揭榜操作</strong><span>{hardSubmissions.length ? `已收到 ${hardSubmissions.length} 份交付` : '暂时没有可选的交付件'}</span></div><button className="small" disabled={resolveBusy || !hardSubmissions.length} onClick={() => void resolveLatestHardSubmission()}>{resolveBusy ? '处理中…' : '将最近提交标记为揭榜成功'}</button></div>}
      {challenge.board.status === 'RESOLVED' && <div className="hard-problem-resolution-control resolved"><div><strong>揭榜结果</strong><span>揭榜人：{displayPersonName(challenge.board.solverName ?? challenge.board.solverId)} · {challenge.board.solutionVisibility === 'HIDDEN' ? '交付件不公开' : '交付件公开'}</span></div><span className="review-status review-status-approved">揭榜成功</span></div>}
    </>}
    <div className="version-list">{challenge.versions.slice().reverse().map((version) => <article className="version-row" key={version.id}><div className="version-number">v{version.version}</div><div><strong>{version.title}</strong><small>评分标准 v{version.rubricVersion} · {version.estimatedMinutes ?? '—'} 分钟</small><div className="version-tags">{(version.tags ?? []).slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div></div><div className="version-actions"><span className={`status-badge status-${version.status.toLowerCase()}`}>{statusLabel(version.status)}</span>{version.status === 'DRAFT' && challenge.status !== 'ARCHIVED' && <><button className="small" onClick={() => onEditVersion(version)}>编辑草稿</button><button className="small" onClick={() => onPublish(version.id)}>发布版本</button></>}</div></article>)}</div>
    <div className="linked-events"><strong>关联训战</strong>{events.filter((event) => challenge.versions.some((version) => version.id === event.challengeVersion)).map((event) => <span key={event.id}>{challenge.versions.find((version) => version.id === event.challengeVersion)?.title ?? '训战'} · {eventDisplayLabel(event)}</span>)}{challenge.board?.type === 'HARD_PROBLEM' && challenge.board.submissionEventId && <span>独立难题交付入口</span>}{!events.some((event) => challenge.versions.some((version) => version.id === event.challengeVersion)) && challenge.board?.type !== 'HARD_PROBLEM' && <small>暂无关联训战</small>}</div>
  </section>;
}

function CapabilityAdminSection({ data, events, challenges, users, userPageInfo, usersBusy, orgUnits, orgPath, eventId, selectedIds, onOrgPathChange, onEventIdChange, onUsersPageChange, onToggle, onSelectAll, onClear, onViewAll, onViewSelected, profilePage, onProfilePageChange, busy }: {
  data: AdminCapabilityBundle | null;
  events: EventConfig[];
  challenges: Challenge[];
  users: AdminUser[];
  userPageInfo: UserPage['pageInfo'] | null;
  usersBusy: boolean;
  orgUnits: OrgUnit[];
  orgPath: string;
  eventId: string;
  selectedIds: string[];
  onOrgPathChange: (path: string) => void;
  onEventIdChange: (eventId: string) => void;
  onUsersPageChange: (page: number) => void;
  onToggle: (subjectId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onViewAll: () => void;
  onViewSelected: () => void;
  profilePage: number;
  onProfilePageChange: (page: number) => void;
  busy: boolean;
}) {
  const selectedSet = new Set(selectedIds);
  const orgName = (path: string | null) => path ? (orgUnits.find((unit) => unit.path === path)?.name ?? path) : '全组织';
  const eventName = (id: string | null) => {
    if (!id) return '';
    const event = events.find((item) => item.id === id);
    return event ? `${versionTitle(event.challengeVersion, challenges)} · ${event.id}` : id;
  };
  const loadedEventName = eventName(data?.selection.eventId ?? null);
  const selectedEventName = eventName(eventId);
  const domainStatus = (percent: number | null) => percent === null ? '待评估' : percent >= 85 ? '优势' : percent >= 60 ? '稳定' : '待提升';
  const profilePageSize = data?.profilePageInfo.pageSize ?? 20;
  const profileCount = data?.profilePageInfo.total ?? 0;
  const profileTotalPages = Math.max(1, data?.profilePageInfo.totalPages ?? 1);
  const profilePageStart = Math.max(1, Math.min(profilePage - 2, profileTotalPages - 4));
  const profilePageNumbers = Array.from({ length: Math.min(5, profileTotalPages) }, (_, index) => profilePageStart + index);
  const visibleProfiles = data?.profiles ?? [];
  const profilePlaceholderCount = profileTotalPages > 1 ? Math.max(0, profilePageSize - visibleProfiles.length) : 0;
  return <section className="admin-section capability-admin-section">
    <div className="admin-section-heading"><div><p className="kicker">人员分析</p><h2>AI 能力画像</h2></div><span className="last-sync">{data ? `更新于 ${formatDate(data.generatedAt)}` : '加载中…'}</span></div>
    <section className="panel capability-admin-filter">
      <div className="capability-admin-filter-head"><div><strong>选择画像范围</strong><small>训战 / 部门范围与参训人员</small></div><span className="status-pill">当前已选 {selectedIds.length} 人</span></div>
       <div className="capability-admin-filter-controls"><label>训战<select value={eventId} onChange={(event) => onEventIdChange(event.target.value)}><option value="">全部训战</option>{events.slice().sort((a, b) => a.id.localeCompare(b.id)).map((event) => <option key={event.id} value={event.id}>{versionTitle(event.challengeVersion, challenges)} · {event.id}</option>)}</select><small className="field-hint">选择后只统计该训战已有提交的员工及其 AI 评测；也可继续叠加部门或人员筛选。</small></label><label>部门<select value={orgPath} onChange={(event) => onOrgPathChange(event.target.value)}><option value="">全组织（所有部门）</option>{orgUnits.filter((unit) => unit.path !== '/').sort((a, b) => a.path.localeCompare(b.path)).map((unit) => <option key={unit.id} value={unit.path}>{'　'.repeat(Math.max(0, unit.level - 1))}{unit.name}</option>)}</select></label><div className="capability-admin-actions"><button className="quiet" onClick={onSelectAll} disabled={busy || usersBusy || !users.length}>选择当前页全部</button><button className="quiet" onClick={onClear} disabled={busy || !selectedIds.length}>清除选择</button><button className="primary compact" onClick={onViewAll} disabled={busy}>{busy ? '加载中…' : `查看${selectedEventName ? `${selectedEventName} ` : ''}${orgName(orgPath)}整体`}</button><button className="primary compact" onClick={onViewSelected} disabled={busy || !selectedIds.length}>查看所选 {selectedIds.length} 人</button></div></div>
       <div className="capability-user-picker">{users.map((user) => <label className="capability-user-check" key={user.id}><input type="checkbox" checked={selectedSet.has(user.id)} onChange={() => onToggle(user.id)} /><span><strong>{displayPersonName(user.name)}</strong><small>{user.employeeNo} · {orgName(user.orgPath)}</small></span></label>)}{!users.length && <div className="empty compact-empty">{usersBusy ? '正在加载员工…' : '暂无在职员工'}</div>}</div>
       {userPageInfo && <div className="table-pagination capability-user-pagination"><span>候选员工第 {userPageInfo.page} / {Math.max(1, userPageInfo.totalPages)} 页 · 共 {userPageInfo.total} 人</span><div><button className="small" disabled={usersBusy || !userPageInfo.hasPrevious} onClick={() => onUsersPageChange(userPageInfo.page - 1)}>上一页</button><button className="small" disabled={usersBusy || !userPageInfo.hasNext} onClick={() => onUsersPageChange(userPageInfo.page + 1)}>下一页</button></div></div>}
    </section>
    {!data ? <div className="panel empty">能力画像加载中…</div> : <>
      <div className="admin-stat-grid capability-admin-stats"><AdminStat label="统计人数" value={data.selectedCount} hint={`${data.totalCandidates} 名范围内员工`} tone="blue" /><AdminStat label="已完成评估" value={data.gradedUsers} hint={data.selection.eventId ? '该训战中完成 AI 评测' : '完成过至少一场已公布评估'} tone="green" /><AdminStat label="综合平均分" value={data.aggregate.overallAverage ?? '—'} hint={data.selection.eventId ? `${loadedEventName} AI 评测` : data.selection.mode === 'ALL' ? `${orgName(data.selection.orgPath)}整体` : '当前选定人员'} tone="violet" /><AdminStat label="综合中位数" value={data.aggregate.overallMedian ?? '—'} hint="按员工综合成绩计算" tone="orange" /><AdminStat label="综合百分位" value={data.aggregate.overallPercentile === null || data.aggregate.overallPercentile === undefined ? '—' : `${data.aggregate.overallPercentile}%`} hint="当前群体成绩分布" tone="orange" /></div>
      <section className="panel capability-admin-aggregate"><div className="admin-card-heading"><div><p className="kicker">群体画像</p><h3>{data.selection.eventId ? `${loadedEventName} AI 评测画像` : data.selection.mode === 'ALL' ? `${orgName(data.selection.orgPath)}能力画像` : '选定人员能力画像'}</h3><small className="capability-admin-average-note">{data.selection.eventId ? '以下聚合只使用该训战的提交结果；没有评测结果的员工会保留为空画像。' : '平均值、中位数和百分位均按在职员工的有效评估记录计算。'}</small></div><span className="dot-label">{data.selectedCount} 人</span></div><div className="capability-admin-aggregate-grid">{data.aggregate.dimensions.map((dimension) => <div className="capability-admin-aggregate-row" key={dimension.key}><div><strong>{dimension.label}</strong><small>{dimension.evaluatedUsers} 人 · 中位数 {dimension.median ?? '—'} · {dimension.percentile ?? '—'} 百分位</small></div><i><span style={{ width: `${dimension.percent ?? 0}%` }} /></i><b>{dimension.percent === null ? '—' : dimension.percent}</b></div>)}</div><div className="capability-admin-domain-grid">{data.aggregate.domains.map((domain) => <div className="capability-admin-domain" key={domain.key}><div><strong>{domain.label}</strong><small>{domain.evaluatedUsers} 人 · 中位数 {domain.median ?? '—'}</small></div><b>{domain.percent === null ? '—' : domain.percent}</b><span><i style={{ width: `${domain.percent ?? 0}%` }} /></span></div>)}</div><div className="capability-admin-skill-average"><div className="mini-heading"><div><p className="kicker">16 项评分点</p><h3>评分点画像</h3></div><span>均值 / 中位数</span></div><div className="capability-admin-skill-grid">{data.aggregate.skills.map((skill) => <div className="capability-admin-skill-average-cell" key={skill.key}><strong>{skill.key}</strong><span>{skill.label}</span><b>{skill.percent === null ? '—' : skill.percent}</b><small>{skill.evaluatedUsers} 人 · 中位数 {skill.median ?? '—'}</small></div>)}</div></div></section>
       {data.profiles.length > 0 && <><div className="capability-admin-detail-title"><div><p className="kicker">个人画像</p><h3>{data.selection.eventId ? `${loadedEventName}个人 AI 评测` : data.selection.mode === 'ALL' ? `${orgName(data.selection.orgPath)}个人画像` : '所选人员个人画像'}</h3></div></div><div className="capability-admin-profile-list">{visibleProfiles.map(({ subject, profile }) => { const personName = displayPersonName(subject.name); return <article className="panel capability-admin-person" key={subject.id}><div className="capability-admin-person-head"><div className="capability-admin-avatar">{personName.slice(0, 1)}</div><div><strong>{personName}</strong><small>{subject.employeeNo} · {orgName(subject.orgPath)}</small></div><div className="capability-admin-person-score"><b>{profile.summary.overallAverage ?? '—'}</b><span>{profile.summary.gradedSubmissions} 场 AI 评测</span></div></div><div className="capability-admin-person-dimensions">{profile.dimensions.map((dimension) => <div key={dimension.key}><span>{dimension.label}</span><i><b style={{ width: `${dimension.percent ?? 0}%` }} /></i><strong>{dimension.percent === null ? '—' : dimension.percent}</strong></div>)}</div><div className="capability-admin-person-domains">{profile.domains.map((domain) => <div key={domain.key}><span title={domain.label}>{domain.shortLabel ?? domain.label}</span><i><b style={{ width: `${domain.percent ?? 0}%` }} /></i><strong>{domain.percent === null ? '—' : domain.percent}</strong></div>)}</div><div className="capability-admin-skills">{profile.skills.map((skill) => <span className={`admin-skill admin-skill-${(skill.averageLevel ?? 'n').toLowerCase()}`} key={skill.criterionKey} title={skill.name}>{skill.criterionKey}<b>{skill.averageLevel ?? '—'}</b></span>)}</div></article>; })}{Array.from({ length: profilePlaceholderCount }, (_, index) => <article className="panel capability-admin-person capability-admin-person-placeholder" key={`profile-placeholder-${index}`} aria-hidden="true" />)}</div><div className="table-pagination capability-profile-pagination"><span>第 {profilePage} / {profileTotalPages} 页 · 共 {profileCount} 人</span><div><button className="small" disabled={profilePage <= 1 || busy} onClick={() => onProfilePageChange(Math.max(1, profilePage - 1))}>上一页</button>{profilePageNumbers.map((number) => <button className={`small page-number${profilePage === number ? ' active' : ''}`} key={number} disabled={busy} onClick={() => onProfilePageChange(number)}>{number}</button>)}<button className="small" disabled={profilePage >= profileTotalPages || busy} onClick={() => onProfilePageChange(Math.min(profileTotalPages, profilePage + 1))}>下一页</button></div></div></>}
    </>}
  </section>;
}

function ChallengeEditorLegacy({ form, setForm, onCancel, onSave, busy, title }: { form: ChallengeDraft; setForm: (form: ChallengeDraft) => void; onCancel: () => void; onSave: () => void; busy: boolean; title: string }) {
  const update = <K extends keyof ChallengeDraft>(key: K, value: ChallengeDraft[K]) => setForm({ ...form, [key]: value });
  return <section className="panel admin-editor"><div className="admin-card-heading"><div><p className="kicker">草稿编辑</p><h3>{title}</h3></div><button className="quiet" onClick={onCancel}>取消</button></div><div className="form-grid"><label>赛题 ID<input value={form.id} onChange={(event) => update('id', event.target.value)} disabled={title !== '创建赛题草稿'} /></label><label>赛题标题<input value={form.title} onChange={(event) => update('title', event.target.value)} /></label><label>分区<select value={form.zone} onChange={(event) => update('zone', event.target.value as ChallengeDraft['zone'])}><option value="YELLOW">黄区</option><option value="BLUE">蓝区</option></select></label><label>预计用时（分钟）<input type="number" min="1" value={form.estimatedMinutes} onChange={(event) => update('estimatedMinutes', event.target.value)} /></label><label className="span-2">赛题介绍<textarea value={form.description} onChange={(event) => update('description', event.target.value)} rows={3} /></label><label>训战目标<textarea value={form.objectives} onChange={(event) => update('objectives', event.target.value)} rows={4} /></label><label>赛题要求<textarea value={form.requirements} onChange={(event) => update('requirements', event.target.value)} rows={4} /></label><label>约束与评估<textarea value={form.constraints} onChange={(event) => update('constraints', event.target.value)} rows={4} /></label><label>交付件<textarea value={form.deliverables} onChange={(event) => update('deliverables', event.target.value)} rows={4} /></label><label>标签<textarea value={form.tags} onChange={(event) => update('tags', event.target.value)} rows={3} /></label><label>支持的编程语言<textarea value={form.languages} onChange={(event) => update('languages', event.target.value)} rows={3} /></label></div><div className="delivery-policy-editor"><div><strong>提交方式</strong><small>配置员工可用的提交方式。</small></div><label className="check-label"><input type="checkbox" checked={form.allowUpload} onChange={(event) => update('allowUpload', event.target.checked)} /> 上传 ZIP</label><label className="check-label"><input type="checkbox" checked={form.allowGit} onChange={(event) => update('allowGit', event.target.checked)} /> Git 仓库路径</label>{form.allowGit && <><label>Git 仓库路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label></>}<label>评分标准版本<input value={form.rubricVersion} onChange={(event) => update('rubricVersion', event.target.value)} /></label></div><div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存草稿'}</button></div></section>;
}

function RichTextEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  useEffect(() => {
    const sanitized = sanitizeRichText(value);
    if (editorRef.current && editorRef.current.innerHTML !== sanitized) editorRef.current.innerHTML = sanitized;
  }, [value]);

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editorRef.current?.contains(selection.anchorNode)) selectionRef.current = selection.getRangeAt(0).cloneRange();
  };

  const restoreSelection = () => {
    const selection = window.getSelection();
    if (!selection || !selectionRef.current || !editorRef.current?.contains(selectionRef.current.commonAncestorContainer)) return;
    selection.removeAllRanges();
    selection.addRange(selectionRef.current);
  };

  const wrapSelection = (tagName: 'strong' | 'em') => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection) return;
    restoreSelection();
    let range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || range.collapsed) {
      range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const wrapper = document.createElement(tagName);
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
    selection.removeAllRanges();
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    selection.addRange(nextRange);
    selectionRef.current = nextRange.cloneRange();
    editor.querySelectorAll('strong:empty, em:empty').forEach((node) => node.remove());
    onChange(sanitizeRichText(editor.innerHTML));
  };

  const runCommand = (command: string, argument?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (command === 'bold') { wrapSelection('strong'); return; }
    if (command === 'italic') { wrapSelection('em'); return; }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) editor.focus();
    document.execCommand(command, false, argument);
    onChange(sanitizeRichText(editor.innerHTML));
  };

  const toolbarCommand = (command: string, argument?: string) => () => {
    restoreSelection();
    runCommand(command, argument);
    rememberSelection();
  };

  const insertImage = (dataUrl: string, alt: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    restoreSelection();
    const selection = window.getSelection();
    let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    if (!range.collapsed) range.deleteContents();
    const image = document.createElement('img');
    image.src = dataUrl;
    image.alt = alt;
    range.insertNode(image);
    range.setStartAfter(image);
    range.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    selectionRef.current = range.cloneRange();
    onChange(sanitizeRichText(editor.innerHTML));
  };

  const handleImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setImageBusy(true);
    setImageError('');
    try {
      const image = await readRichTextImage(file);
      insertImage(image.dataUrl, image.alt);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '图片上传失败，请重试');
    } finally {
      setImageBusy(false);
    }
  };

  const preventToolbarFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  return <div className="rich-editor">
    <div className="rich-editor-toolbar" role="toolbar" aria-label="赛题详情格式工具栏">
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('bold')} title="加粗"><strong>B</strong></button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('italic')} title="斜体"><em>I</em></button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('formatBlock', '<h3>')} title="小标题">H3</button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('insertUnorderedList')} title="无序列表">• 列表</button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('insertOrderedList')} title="有序列表">1. 列表</button>
      <span className="rich-editor-divider" />
      <button type="button" className="rich-editor-image-button" onMouseDown={preventToolbarFocus} onClick={() => imageInputRef.current?.click()} disabled={imageBusy} title="上传 PNG、JPEG 或 WebP 图片">{imageBusy ? '读取中…' : '上传图片'}</button>
      <input ref={imageInputRef} className="rich-editor-image-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleImageChange(event)} />
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('undo')} title="撤销">撤销</button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('redo')} title="重做">重做</button>
    </div>
    <div ref={editorRef} className="rich-editor-surface" contentEditable role="textbox" aria-multiline="true" suppressContentEditableWarning onInput={(event) => { const sanitized = sanitizeRichText(event.currentTarget.innerHTML); if (event.currentTarget.innerHTML !== sanitized) event.currentTarget.innerHTML = sanitized; onChange(sanitized); rememberSelection(); }} onKeyUp={rememberSelection} onMouseUp={rememberSelection} />
    <div className="rich-editor-help">支持 PNG、JPEG、WebP，单张不超过 2 MiB；图片会嵌入赛题说明。</div>
    {imageError && <div className="rich-editor-error" role="alert">{imageError}</div>}
  </div>;
}

/** Renders the parameter form a built-in executor declares in its manifest. */
function ExecutorPicker({ form, setForm, executors }: { form: ChallengeDraft; setForm: (form: ChallengeDraft) => void; executors: BuiltInExecutor[] }) {
  const selected = executors.find((item) => item.id === form.executorId);
  const properties = Object.entries(selected?.params?.properties ?? {});
  const required = new Set(selected?.params?.required ?? []);
  const choose = (executorId: string) => {
    const next = executors.find((item) => item.id === executorId);
    const defaults = Object.fromEntries(Object.entries(next?.params?.properties ?? {}).map(([key, property]) => [key, String(property.default ?? '')]));
    setForm({ ...form, executorId, executorParams: { ...defaults, ...(executorId === form.executorId ? form.executorParams : {}) } });
  };
  return <>
    <label className="span-2">内置执行器<select value={form.executorId} onChange={(event) => choose(event.target.value)}><option value="">请选择…</option>{executors.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>)}</select>{selected?.description && <small className="field-hint">{selected.description}</small>}</label>
    {properties.map(([key, property]) => (
      <label key={key}>{property.title ?? key}{required.has(key) && <span className="field-hint">必填</span>}
        {property.enum
          ? <select value={form.executorParams[key] ?? ''} onChange={(event) => setForm({ ...form, executorParams: { ...form.executorParams, [key]: event.target.value } })}>{property.enum.map((option) => <option key={option} value={option}>{option}</option>)}</select>
          : <input value={form.executorParams[key] ?? ''} onChange={(event) => setForm({ ...form, executorParams: { ...form.executorParams, [key]: event.target.value } })} placeholder={property.description ?? ''} />}
        {property.description && <small className="field-hint">{property.description}</small>}
      </label>
    ))}
    {!executors.length && <small className="field-hint span-2">仓库中没有可用的内置执行器。</small>}
  </>;
}

type DeliveryRule = { path: string; type: 'markdown' | 'source' | 'directory' | 'text' | 'json' | 'yaml'; minFiles?: number; allowedExtensions?: string[]; [key: string]: unknown };
type DeliveryContract = {
  schemaVersion: '1.1';
  root?: { mode: 'ARCHIVE_ROOT' | 'SINGLE_DIRECTORY'; directoryName?: string };
  required: DeliveryRule[];
  optional?: DeliveryRule[];
  forbidden: string[];
  allowedPaths?: string[];
  allowAdditionalPaths?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  [key: string]: unknown;
};

function DeliveryContractEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  let contract: DeliveryContract | null = null;
  let invalid = false;
  if (value.trim()) {
    try { contract = JSON.parse(value) as DeliveryContract; } catch { invalid = true; }
  }
  const save = (next: DeliveryContract) => onChange(JSON.stringify(next, null, 2));
  const updateRule = (index: number, patch: Partial<DeliveryRule>) => {
    if (!contract) return;
    save({ ...contract, required: contract.required.map((rule, current) => current === index ? { ...rule, ...patch } : rule) });
  };
  const rootMode = contract?.root?.mode ?? 'ARCHIVE_ROOT';
  return <div className="delivery-contract-editor">
    <div className="admin-card-heading"><div><strong>交付目录规范</strong><small>不符合目录规范的 ZIP 或 Git 版本不能提交。</small></div><div className="contract-presets"><button type="button" className="small" onClick={() => onChange(SOURCE_DELIVERY_CONTRACT)}>源码项目</button><button type="button" className="small" onClick={() => onChange(SKILLS_DELIVERY_CONTRACT)}>Skills 交付</button></div></div>
    {!value.trim() && <div className="contract-empty"><span>未配置交付目录规范</span><button type="button" className="secondary-button" onClick={() => onChange(SOURCE_DELIVERY_CONTRACT)}>配置规范</button></div>}
    {invalid && <div className="contract-invalid">目录规范 JSON 格式不正确</div>}
    {contract && !invalid && <>
      <div className="contract-settings-grid">
        <label>压缩包根目录<select value={rootMode} onChange={(event) => save({ ...contract!, root: { mode: event.target.value as 'ARCHIVE_ROOT' | 'SINGLE_DIRECTORY', ...(event.target.value === 'SINGLE_DIRECTORY' ? { directoryName: contract!.root?.directoryName ?? 'delivery' } : {}) } })}><option value="ARCHIVE_ROOT">文件直接位于根目录</option><option value="SINGLE_DIRECTORY">仅允许一个顶层目录</option></select></label>
        {rootMode === 'SINGLE_DIRECTORY' && <label>顶层目录名称<input className="mono-value" value={contract.root?.directoryName ?? ''} onChange={(event) => save({ ...contract!, root: { mode: 'SINGLE_DIRECTORY', directoryName: event.target.value } })} /></label>}
        <label>最多文件数<input type="number" min="1" max="10000" value={contract.maxFiles ?? 1000} onChange={(event) => save({ ...contract!, maxFiles: Number(event.target.value) || 1 })} /></label>
        <label>最大目录层级<input type="number" min="1" max="30" value={contract.maxDepth ?? 12} onChange={(event) => save({ ...contract!, maxDepth: Number(event.target.value) || 1 })} /></label>
        <label className="check-label"><input type="checkbox" checked={contract.allowAdditionalPaths !== false} onChange={(event) => save({ ...contract!, allowAdditionalPaths: event.target.checked })} /> 允许规范之外的文件</label>
      </div>
      <div className="contract-rule-heading"><strong>必需文件与目录</strong><button type="button" className="small" onClick={() => save({ ...contract!, required: [...(contract!.required ?? []), { path: '', type: 'text' }] })}>添加规则</button></div>
      <div className="contract-rule-table">
        <div className="contract-rule-row contract-rule-header"><span>路径或匹配规则</span><span>类型</span><span>最少文件</span><span>允许扩展名</span><span /></div>
        {(contract.required ?? []).map((rule, index) => <div className="contract-rule-row" key={index}>
          <input className="mono-value" value={rule.path} onChange={(event) => updateRule(index, { path: event.target.value })} />
          <select value={rule.type} onChange={(event) => updateRule(index, { type: event.target.value as DeliveryRule['type'] })}><option value="directory">目录</option><option value="markdown">Markdown</option><option value="source">源代码</option><option value="text">文本</option><option value="json">JSON</option><option value="yaml">YAML</option></select>
          <input type="number" min="1" value={rule.minFiles ?? ''} onChange={(event) => updateRule(index, { minFiles: event.target.value ? Number(event.target.value) : undefined })} disabled={rule.type !== 'directory' && !rule.path.includes('*')} />
          <input className="mono-value" value={(rule.allowedExtensions ?? []).join(', ')} onChange={(event) => { const extensions = event.target.value.split(',').map((item) => item.trim()).filter(Boolean); updateRule(index, { allowedExtensions: extensions.length ? extensions : undefined }); }} />
          <button type="button" className="quiet danger-text" onClick={() => save({ ...contract!, required: contract!.required.filter((_, current) => current !== index) })}>删除</button>
        </div>)}
      </div>
      <div className="contract-text-grid">
        <label>禁止路径<textarea className="mono-value" rows={4} value={(contract.forbidden ?? []).join('\n')} onChange={(event) => save({ ...contract!, forbidden: lines(event.target.value) })} /></label>
        {contract.allowAdditionalPaths === false && <label>允许路径<textarea className="mono-value" rows={4} value={(contract.allowedPaths ?? []).join('\n')} onChange={(event) => save({ ...contract!, allowedPaths: lines(event.target.value) })} /></label>}
      </div>
    </>}
    <details className="contract-json"><summary>高级配置</summary><label>目录规范 JSON<textarea className="mono-value" value={value} onChange={(event) => onChange(event.target.value)} rows={14} /></label></details>
  </div>;
}

function ChallengeEditor({ form, setForm, onCancel, onSave, onUploadPackage, executors, contracts, onViewContractDetail, busy, title }: { form: ChallengeDraft; setForm: (form: ChallengeDraft) => void; onCancel: () => void; onSave: () => void; onUploadPackage: (file: File) => Promise<void>; executors: BuiltInExecutor[]; contracts: EvaluationContractOption[]; onViewContractDetail: (contract: EvaluationContractOption) => void; busy: boolean; title: string }) {
  const update = <K extends keyof ChallengeDraft>(key: K, value: ChallengeDraft[K]) => setForm({ ...form, [key]: value });
  const creatingChallenge = title === '创建赛题草稿';
  const inputContracts = contracts.filter((item) => item.kind === 'INPUT' && item.modes.includes(form.evaluationEngineMode));
  const outputContracts = contracts.filter((item) => item.kind === 'OUTPUT' && item.modes.includes(form.evaluationEngineMode));
  const selectedInput = inputContracts.find((item) => item.path === form.evaluationInputContract) ?? contracts.find((item) => item.kind === 'INPUT' && item.path === form.evaluationInputContract);
  const selectedOutput = outputContracts.find((item) => item.path === form.evaluationOutputContract) ?? contracts.find((item) => item.kind === 'OUTPUT' && item.path === form.evaluationOutputContract);
  return <section className="panel admin-editor challenge-editor-card">
    <div className="admin-card-heading"><div><p className="kicker">题面编辑</p><h3>{title}</h3></div><button className="quiet" onClick={onCancel}>取消</button></div>
    <div className="form-grid">
      <label>赛题 ID<input value={form.id} onChange={(event) => update('id', event.target.value)} disabled={!creatingChallenge} /></label>
      <label>赛题标题<input value={form.title} onChange={(event) => update('title', event.target.value)} /></label>
      {creatingChallenge && <label>赛题类型<select value={form.category} onChange={(event) => update('category', event.target.value as ChallengeCategory)}><option value="TRAINING">训战类</option><option value="COMPETITION">竞赛类</option><option value="HARD_PROBLEM">难题类</option></select><small className="field-hint">难题类进入难题榜。</small></label>}
      <label>分区<select value={form.zone} onChange={(event) => update('zone', event.target.value as ChallengeDraft['zone'])}><option value="YELLOW">黄区</option><option value="BLUE">蓝区</option></select></label>
      <label>预计用时（分钟）<input type="number" min="1" value={form.estimatedMinutes} onChange={(event) => update('estimatedMinutes', event.target.value)} /></label>
      <label className="span-2 rich-field"><span>赛题详情</span><RichTextEditor value={form.description} onChange={(value) => update('description', value)} /></label>
      <label>训战目标<textarea value={form.objectives} onChange={(event) => update('objectives', event.target.value)} rows={4} /></label>
      <label>赛题要求<textarea value={form.requirements} onChange={(event) => update('requirements', event.target.value)} rows={4} /></label>
      <label>约束与评测<textarea value={form.constraints} onChange={(event) => update('constraints', event.target.value)} rows={4} /></label>
      <label>交付件<textarea value={form.deliverables} onChange={(event) => update('deliverables', event.target.value)} rows={4} /></label>
      <label>标签<textarea value={form.tags} onChange={(event) => update('tags', event.target.value)} rows={3} /></label>
      <label>支持的编程语言<textarea value={form.languages} onChange={(event) => update('languages', event.target.value)} rows={3} /></label>
    </div>
     <div className="delivery-policy-editor"><div><strong>提交方式</strong></div><label className="check-label"><input type="checkbox" checked={form.allowUpload} onChange={(event) => update('allowUpload', event.target.checked)} /> 上传 ZIP</label><label className="check-label"><input type="checkbox" checked={form.allowGit} onChange={(event) => update('allowGit', event.target.checked)} /> Git 仓库路径</label>{form.allowGit && <><label>Git 仓库路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label></>}<label>评分标准版本<input value={form.rubricVersion} onChange={(event) => update('rubricVersion', event.target.value)} /></label></div>
     <DeliveryContractEditor value={form.submissionContractJson} onChange={(value) => update('submissionContractJson', value)} />
     <div className="evaluation-engine-editor">
       <div><strong>评测引擎</strong></div>
       <div className="form-grid">
         <label>引擎标识<input value={form.evaluationEngineId} onChange={(event) => update('evaluationEngineId', event.target.value)} /></label>
         <label>引擎版本<input value={form.evaluationEngineVersion} onChange={(event) => update('evaluationEngineVersion', event.target.value)} /></label>
         <label>执行方式<select value={form.evaluationEngineMode} onChange={(event) => { const mode = event.target.value as ChallengeDraft['evaluationEngineMode']; setForm({ ...form, evaluationEngineMode: mode, ...evaluationContracts(mode) }); }}><option value="EXTERNAL_CLI">外部评测结果导入</option><option value="PLATFORM_LOCAL">Code Agent + 内置执行器</option><option value="PACKAGED">Code Agent + 引擎包</option></select></label>
         <div className="evaluation-contract-summary span-2">
           <div><strong>评测约束</strong><span>{form.evaluationEngineMode === 'EXTERNAL_CLI' ? '评测任务 → 评测结果' : 'Code Agent 批次 → 评测结果'}</span></div>
           <div className="form-grid">
             <label>输入约束<div className="evaluation-contract-select-row"><select value={form.evaluationInputContract} onChange={(event) => update('evaluationInputContract', event.target.value)} disabled={!inputContracts.length}>
               {!selectedInput && form.evaluationInputContract && <option value={form.evaluationInputContract}>当前约束（需切换）</option>}
               {inputContracts.map((item) => <option key={item.id} value={item.path}>{item.label}</option>)}
             </select>{selectedInput && <button type="button" className="small contract-detail-button" onClick={() => onViewContractDetail(selectedInput)}>查看详情</button>}</div><small className="field-hint">{selectedInput?.description ?? '请选择 Git 约束目录中的输入约束'} 示例：{selectedInput?.examplePath ?? '—'}；编写说明：{selectedInput?.guidePath ?? '—'}</small></label>
             <label>输出约束<div className="evaluation-contract-select-row"><select value={form.evaluationOutputContract} onChange={(event) => update('evaluationOutputContract', event.target.value)} disabled={!outputContracts.length}>
               {!selectedOutput && form.evaluationOutputContract && <option value={form.evaluationOutputContract}>当前约束（需切换）</option>}
               {outputContracts.map((item) => <option key={item.id} value={item.path}>{item.label}</option>)}
             </select>{selectedOutput && <button type="button" className="small contract-detail-button" onClick={() => onViewContractDetail(selectedOutput)}>查看详情</button>}</div><small className="field-hint">{selectedOutput?.description ?? '请选择 Git 约束目录中的输出约束'} 示例：{selectedOutput?.examplePath ?? '—'}；编写说明：{selectedOutput?.guidePath ?? '—'}</small></label>
           </div>
         </div>
         {form.evaluationEngineMode !== 'EXTERNAL_CLI' && <>
           <label>评测指令路径<input className="mono-value" value={form.agentInstructionPath} onChange={(event) => update('agentInstructionPath', event.target.value)} /><small className="field-hint">相对于评测引擎根目录。</small></label>
           <label>Skills 路径<textarea className="mono-value" value={form.agentSkillPaths} onChange={(event) => update('agentSkillPaths', event.target.value)} rows={3} /><small className="field-hint">每行一个目录；目录内必须包含 SKILL.md。</small></label>
         </>}
         {form.evaluationEngineMode === 'PACKAGED' && <label className="span-2">评测引擎包<span className="field-hint">ZIP 根目录包含 engine.json、instruction.md、Skills、评测入口和评测资产。</span><input type="file" accept=".zip" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUploadPackage(file); event.target.value = ''; }} />{form.enginePackageSummary ? <small className="engine-package-summary">已绑定：{form.enginePackageSummary}</small> : null}</label>}
         {form.evaluationEngineMode === 'PLATFORM_LOCAL' && <ExecutorPicker form={form} setForm={setForm} executors={executors} />}
       </div>
     </div>
    <div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存草稿'}</button></div>
  </section>;
}

function EvaluationContractDetailDialog({ detail, busy, copied, onClose, onCopy }: { detail: EvaluationContractDetail; busy: boolean; copied: boolean; onClose: () => void; onCopy: () => void }) {
  const schemaText = prettyJson(detail.schema);
  const exampleText = prettyJson(detail.example);
  return <div className="evaluation-contract-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="panel evaluation-contract-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="evaluation-contract-detail-title">
      <div className="admin-card-heading"><div><p className="kicker">评测约束详情</p><h3 id="evaluation-contract-detail-title">{detail.label}</h3></div><button type="button" className="quiet" onClick={onClose}>关闭</button></div>
      <div className="evaluation-contract-detail-meta"><span className="contract-kind-badge">{evaluationContractKindLabel(detail.kind)}</span><span>版本 {detail.schemaVersion}</span><span>适用：{detail.modes.map(evaluationContractModeLabel).join('、')}</span><code>{detail.path}</code></div>
      <p className="evaluation-contract-detail-description">{detail.description}</p>
      <div className="evaluation-contract-copy-row"><button type="button" className="primary compact" disabled={busy} onClick={onCopy}>{copied ? '已复制 AI 出题提示' : '复制给 AI 出题'}</button><span>包含 Schema、已校验示例和编写说明，可直接粘贴到 AI 对话。</span></div>
      <details className="evaluation-contract-code" open><summary>Schema（固定版本）</summary><pre>{schemaText}</pre></details>
      <details className="evaluation-contract-code" open><summary>示例（已通过 Schema 校验）</summary><pre>{exampleText}</pre></details>
      <details className="evaluation-contract-guide"><summary>编写说明</summary><pre>{detail.guide}</pre></details>
    </section>
  </div>;
}

function AdminGuideDialog({ guide, onClose }: { guide: AdminGuideKey; onClose: () => void }) {
  const content = ADMIN_GUIDE_CONTENT[guide];
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  return <div className="admin-guide-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="panel admin-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-guide-title">
      <div className="admin-card-heading admin-guide-heading"><div><p className="kicker">{content.kicker}</p><h3 id="admin-guide-title">{content.title}</h3></div><button type="button" className="quiet" onClick={onClose}>关闭</button></div>
      <p className="admin-guide-intro">{content.intro}</p>
      <div className="admin-guide-sections">{content.sections.map((section) => <section className="admin-guide-section" key={section.title}><h4>{section.title}</h4>{section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}{section.bullets && <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}</section>)}</div>
      <div className="admin-guide-footer"><span>说明仅影响操作理解，不会改变当前配置。</span><button type="button" className="primary compact" onClick={onClose}>知道了</button></div>
    </section>
  </div>;
}

function EvaluationEngineGuideDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  function downloadGuide(): void {
    downloadTextFile('evaluation-engine-development-guide.md', EVALUATION_ENGINE_GUIDE_MARKDOWN);
  }

  return <div className="admin-guide-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="panel engine-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="evaluation-engine-guide-title">
      <div className="admin-card-heading admin-guide-heading"><div><p className="kicker">评测引擎开发</p><h3 id="evaluation-engine-guide-title">评测引擎开发指南</h3></div><button type="button" className="quiet" onClick={onClose}>关闭</button></div>
      <p className="admin-guide-intro">这里集中说明评测引擎、Code Agent、Worker、输入输出契约、结果幂等、安全边界和本地验证流程。内容可以直接下载为 Markdown，交给其他 AI 作为开发上下文。</p>
      <div className="engine-guide-actions"><div className="engine-guide-downloads"><button type="button" className="primary compact" onClick={downloadGuide}>下载开发指南（Markdown）</button><a className="secondary-button engine-guide-kit-link" href={`${import.meta.env.BASE_URL}evaluation-engine-development-kit.md`} download="evaluation-engine-development-kit.md">下载 AI 资料包（Markdown）</a><a className="primary compact engine-guide-kit-link" href={`${import.meta.env.BASE_URL}evaluation-engine-development-kit.zip`} download="evaluation-engine-development-kit.zip">下载独立开发包（ZIP）</a></div><span>ZIP 包含真实契约、样例、参考引擎和独立 Python 校验/运行 CLI；完整平台源码仍需单独取得。</span></div>
      <details className="engine-guide-document-wrap" open><summary>查看完整开发规范</summary><pre className="engine-guide-document">{EVALUATION_ENGINE_GUIDE_MARKDOWN}</pre></details>
      <div className="admin-guide-footer"><span>下载文件不包含员工信息、凭据或运行日志。</span><button type="button" className="primary compact" onClick={onClose}>知道了</button></div>
    </section>
  </div>;
}

function ParticipantSection({ events, users, eventId, setEventId, selectedIds, setSelectedIds, onLoad, onSave, busy }: { events: EventConfig[]; users: AdminUser[]; eventId: string; setEventId: (value: string) => void; selectedIds: string[]; setSelectedIds: (value: string[]) => void; onLoad: (eventId: string) => Promise<void>; onSave: () => void; busy: boolean }) {
  const selectedEvent = events.find((event) => event.id === eventId);
  const [loadedEventId, setLoadedEventId] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [availableChecked, setAvailableChecked] = useState<string[]>([]);
  const [selectedChecked, setSelectedChecked] = useState<string[]>([]);
  const userById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const availableUsers = useMemo(() => users
    .filter((user) => user.status === 'ACTIVE' && !selectedSet.has(user.id))
    .sort((a, b) => a.employeeNo.localeCompare(b.employeeNo)), [users, selectedSet]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAvailableUsers = normalizedQuery
    ? availableUsers.filter((user) => `${user.name} ${user.employeeNo} ${user.departmentHint ?? user.orgPath}`.toLowerCase().includes(normalizedQuery))
    : availableUsers;
  const filteredSelectedIds = normalizedQuery
    ? selectedIds.filter((id) => {
      const user = userById.get(id);
      return `${user?.name ?? id} ${user?.employeeNo ?? id} ${user?.departmentHint ?? user?.orgPath ?? ''}`.toLowerCase().includes(normalizedQuery);
    })
    : selectedIds;
  const loaded = loadedEventId === eventId && Boolean(eventId);

  function toggleChecked(id: string, setter: (value: string[]) => void, current: string[]): void {
    setter(current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  function displayUser(id: string): { name: string; meta: string } {
    const user = userById.get(id);
    if (!user) return { name: id, meta: '当前员工目录中未找到' };
    return { name: displayPersonName(user.name), meta: `${user.employeeNo} · ${user.departmentHint ?? user.orgPath}` };
  }

  function addChecked(): void {
    if (!availableChecked.length) return;
    setSelectedIds([...new Set([...selectedIds, ...availableChecked])]);
    setAvailableChecked([]);
  }

  function removeChecked(): void {
    if (!selectedChecked.length) return;
    const removing = new Set(selectedChecked);
    setSelectedIds(selectedIds.filter((id) => !removing.has(id)));
    setSelectedChecked([]);
  }

  function selectAllAvailable(): void {
    setAvailableChecked(filteredAvailableUsers.map((user) => user.id));
  }

  function selectAllSelected(): void {
    setSelectedChecked(filteredSelectedIds);
  }

  function changeEvent(value: string): void {
    setEventId(value);
    setLoadedEventId('');
    setSelectedIds([]);
    setAvailableChecked([]);
    setSelectedChecked([]);
    setQuery('');
  }

  async function load(): Promise<void> {
    if (!eventId) return;
    setLoading(true);
    try {
      await onLoad(eventId);
      setLoadedEventId(eventId);
      setAvailableChecked([]);
      setSelectedChecked([]);
    } catch {
      // The parent displays the API error; keep the editor locked until a
      // successful load prevents accidentally saving an empty list.
    } finally {
      setLoading(false);
    }
  }

  const renderOption = (id: string, checked: boolean, onToggle: () => void) => {
    const user = displayUser(id);
    return <label className="participant-user-option" key={id}><input type="checkbox" checked={checked} onChange={onToggle} /><span><strong>{user.name}</strong><small>{user.meta}</small></span></label>;
  };

  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">参训名单</p><h2>参训名单</h2></div></div><section className="panel admin-card participant-editor">
    <div className="form-grid participant-context-grid"><label>训战<select value={eventId} onChange={(event) => changeEvent(event.target.value)}>{events.map((item) => <option key={item.id} value={item.id}>{item.id} · {statusLabel(item.status)}</option>)}</select></label><label>当前访问模式<input value={selectedEvent?.accessPolicy?.mode === 'RESTRICTED' ? '定向访问' : participantModeLabel(selectedEvent?.participantMode)} readOnly /></label></div>
    <div className="participant-transfer-heading"><div><strong>员工名单</strong><small>勾选员工后使用中间按钮批量添加或移除；保存后才会写入训战访问范围。</small></div><span>{loaded ? `参赛员工 ${selectedIds.length} 人` : '请先加载名单'}</span></div>
    <div className="participant-transfer-toolbar"><label className="participant-search"><span>搜索员工</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="姓名、工号或部门" disabled={!loaded} /></label><button type="button" className="secondary-button" disabled={!eventId || busy || loading} onClick={() => void load()}>{loading ? '加载中…' : '加载名单'}</button></div>
    <div className={`participant-transfer${loaded ? '' : ' participant-transfer-locked'}`}>
      {!loaded && <div className="participant-transfer-locked-note">请先点击“加载名单”，读取当前训战已经保存的参训员工。</div>}
      <section className="participant-transfer-pane"><div className="participant-transfer-pane-heading"><div><strong>可选员工</strong><small>{loaded ? `${filteredAvailableUsers.length} 人` : '—'}</small></div><button type="button" className="quiet" disabled={!loaded || !filteredAvailableUsers.length} onClick={selectAllAvailable}>全选当前</button></div><div className="participant-user-list">{loaded && filteredAvailableUsers.map((user) => renderOption(user.id, availableChecked.includes(user.id), () => toggleChecked(user.id, setAvailableChecked, availableChecked)))}{loaded && !filteredAvailableUsers.length && <div className="participant-list-empty">暂无可添加员工</div>}</div></section>
      <div className="participant-transfer-actions"><button type="button" className="primary compact" disabled={!loaded || !availableChecked.length} onClick={addChecked}>添加所选 <span aria-hidden="true">→</span></button><button type="button" className="secondary-button" disabled={!loaded || !selectedChecked.length} onClick={removeChecked}><span aria-hidden="true">←</span> 移除所选</button></div>
      <section className="participant-transfer-pane"><div className="participant-transfer-pane-heading"><div><strong>参赛员工</strong><small>{loaded ? `${filteredSelectedIds.length} 人` : '—'}</small></div><button type="button" className="quiet" disabled={!loaded || !filteredSelectedIds.length} onClick={selectAllSelected}>全选当前</button></div><div className="participant-user-list">{loaded && filteredSelectedIds.map((id) => renderOption(id, selectedChecked.includes(id), () => toggleChecked(id, setSelectedChecked, selectedChecked)))}{loaded && !filteredSelectedIds.length && <div className="participant-list-empty">暂无参赛员工</div>}</div></section>
    </div>
    <div className="editor-actions participant-editor-actions"><button type="button" className="secondary-button" disabled={!eventId || busy || loading} onClick={() => void load()}>{loading ? '加载中…' : '重新加载名单'}</button><button type="button" className="primary compact" disabled={!loaded || busy || loading} onClick={onSave}>保存名单</button></div>
  </section></section>;
}

function EventsSectionLegacy({ events, challenges, overview, eventForm, setEventForm, onCreate, onAction, busy }: { events: EventConfig[]; challenges: Challenge[]; overview: Overview | null; eventForm: EventDraft | null; setEventForm: (form: EventDraft | null) => void; onCreate: () => void; onAction: (event: EventConfig, action: 'start-grading' | 'execute-local' | 'close' | 'reveal') => void; busy: boolean }) {
  const now = Date.now();
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">场次编排</p><h2>场次编排</h2></div><button className="primary compact" onClick={() => setEventForm(blankEvent(challenges.flatMap((challenge) => challenge.versions).find((version) => version.status === 'PUBLISHED')?.id ?? '', challenges))}>＋ 新建场次</button></div>{eventForm && <EventEditorLegacy form={eventForm} setForm={setEventForm} challenges={challenges} onCancel={() => setEventForm(null)} onSave={onCreate} busy={busy} />}{!eventForm && <div className="event-admin-list">{events.map((event) => { const stat = overview?.eventStats.find((item) => item.eventId === event.id); return <article className="panel event-admin-card" key={event.id}><div className="event-admin-main"><div className="event-badge"><Icon name={event.submissionSource === 'GIT_REF' ? 'git' : 'upload'} size={18} /></div><div><div className="event-admin-title"><strong>{versionTitle(event.challengeVersion, challenges)}</strong><span className={`status-badge status-${eventDisplayStatus(event, now).toLowerCase()}`}>{eventDisplayLabel(event, now)}</span></div><small>{modeLabel(event.mode)} · {sourceLabel(event.submissionSource)} · {triggerLabel(event.trigger)} · {revealLabel(event.reveal)}</small><div className="event-admin-meta"><span>{stat?.submissionCount ?? 0} 份提交</span><span>{stat?.pendingCount ?? 0} 待处理</span>{event.deliveryConfig?.repository && <span>{event.deliveryConfig.repository}</span>}</div></div></div><div className="event-admin-actions">{event.status === 'OPEN' && event.trigger === 'MANUAL' && <button className="small" disabled={busy} onClick={() => onAction(event, 'start-grading')}>批量安排评估</button>}{event.status === 'OPEN' && <button className="small" disabled={busy} onClick={() => onAction(event, 'execute-local')}>执行评估</button>}{event.status === 'OPEN' && <button className="small danger" disabled={busy} onClick={() => onAction(event, 'close')}>结束场次</button>}{event.status === 'CLOSED' && <button className="small" disabled={busy} onClick={() => onAction(event, 'reveal')}>公布结果</button>}</div></article>; })}{!events.length && <div className="panel empty">暂无场次</div>}</div>}</section>;
}

function EventEditorLegacy({ form, setForm, challenges, onCancel, onSave, busy }: { form: EventDraft; setForm: (form: EventDraft | null) => void; challenges: Challenge[]; onCancel: () => void; onSave: () => void; busy: boolean }) {
  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setForm({ ...form, [key]: value });
  const versions = challenges.flatMap((challenge) => challenge.versions.filter((version) => version.status === 'PUBLISHED'));
  return <section className="panel admin-editor"><div className="admin-card-heading"><div><p className="kicker">场次草稿</p><h3>创建训战场次</h3></div><button className="quiet" onClick={onCancel}>取消</button></div><div className="form-grid"><label>场次 ID<input value={form.id} onChange={(event) => update('id', event.target.value)} /></label><label>赛题版本<select value={form.challengeVersion} onChange={(event) => { const challengeVersion = event.target.value; setForm({ ...form, challengeVersion, trigger: engineSupportsPlatformExecution(challengeVersion, challenges) ? form.trigger : 'IMPORT' }); }}>{versions.map((version) => <option key={version.id} value={version.id}>{version.title} · v{version.version}</option>)}</select></label><label>提交方式<select value={form.submissionSource} onChange={(event) => update('submissionSource', event.target.value as Source)}><option value="UPLOAD">上传 ZIP</option><option value="GIT_REF">Git 仓库路径</option></select></label><label>评测方式<select value={form.trigger} onChange={(event) => { const trigger = event.target.value as Trigger; setForm({ ...form, trigger, pinAt: trigger === 'AUTO' ? 'SUBMIT' : form.pinAt }); }}>{engineSupportsPlatformExecution(form.challengeVersion, challenges) && <><option value="AUTO">自动评测</option><option value="MANUAL">手动触发</option></>}<option value="IMPORT">线下评测</option></select>{!engineSupportsPlatformExecution(form.challengeVersion, challenges) && <small className="field-hint">该赛题的评测引擎为管理员本地命令，只能使用线下结果录入。</small>}</label><label>结果公布<select value={form.reveal} onChange={(event) => update('reveal', event.target.value as EventDraft['reveal'])}><option value="IMMEDIATE">评测后公布</option><option value="ON_RELEASE">公布后可见</option></select></label><label>场次类型<select value={form.mode} onChange={(event) => update('mode', event.target.value as EventDraft['mode'])}><option value="WINDOW">开放窗口</option><option value="LIVE">集中训战</option></select></label><label>开始时间<input type="datetime-local" value={form.startsAt} onChange={(event) => update('startsAt', event.target.value)} /></label><label>结束时间<input type="datetime-local" value={form.endsAt} onChange={(event) => update('endsAt', event.target.value)} /></label>{form.submissionSource === 'GIT_REF' && <><label>Git 仓库路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label><label>Git 版本固定时点<select value={form.pinAt} disabled={form.trigger === 'AUTO'} onChange={(event) => update('pinAt', event.target.value as EventDraft['pinAt'])}><option value="SUBMIT">提交时锁定</option><option value="DEADLINE">截止时锁定</option></select><small className="field-hint">自动评测在提交时锁定版本。</small></label></>}</div><div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy || !versions.length} onClick={onSave}>{busy ? '创建中…' : '创建场次'}</button></div></section>;
}

function EventsSection({ events, challenges, overview, users, orgUnits, eventForm, setEventForm, eventEditId, onNew, onEdit, onDelete, onCreate, onAction, onOpenGuide, busy }: { events: EventConfig[]; challenges: Challenge[]; overview: Overview | null; users: AdminUser[]; orgUnits: OrgUnit[]; eventForm: EventDraft | null; setEventForm: (form: EventDraft | null) => void; eventEditId: string; onNew: () => void; onEdit: (event: EventConfig) => void; onDelete: (event: EventConfig) => void; onCreate: () => void; onAction: (event: EventConfig, action: 'start-grading' | 'close' | 'reveal') => void; onOpenGuide: () => void; busy: boolean }) {
  const now = Date.now();
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">训战管理</p><h2>训战管理</h2></div><div className="admin-section-actions"><button type="button" className="secondary-button admin-guide-button" onClick={onOpenGuide}>说明指导</button><button className="primary compact" onClick={onNew}>＋ 新建训战</button></div></div>{eventForm && <EventEditor form={eventForm} setForm={setEventForm} challenges={challenges} users={users} orgUnits={orgUnits} editing={Boolean(eventEditId)} onCancel={() => setEventForm(null)} onSave={onCreate} busy={busy} />}{!eventForm && <div className="event-admin-list">{events.map((event) => { const stat = overview?.eventStats.find((item) => item.eventId === event.id); const hasSubmissions = (stat?.submissionCount ?? 0) > 0; return <article className="panel event-admin-card" key={event.id}><div className="event-admin-main"><div className="event-badge"><Icon name={event.submissionSource === 'GIT_REF' ? 'git' : 'upload'} size={18} /></div><div><div className="event-admin-title"><strong>{versionTitle(event.challengeVersion, challenges)}</strong><span className={`status-badge status-${eventDisplayStatus(event, now).toLowerCase()}`}>{eventDisplayLabel(event, now)}</span></div><small>{modeLabel(event.mode)} · {sourceLabel(event.submissionSource)} · {triggerLabel(event.trigger)} · {revealLabel(event.reveal)}</small><div className="event-admin-schedule"><strong>开放时间</strong><span>{eventScheduleLabel(event)}</span></div><div className="event-admin-meta"><span>{accessScopeLabel(event)}</span><span>{stat?.submissionCount ?? 0} 份提交</span><span>{stat?.pendingCount ?? 0} 待处理</span>{event.deliveryConfig?.repository && <span>{event.deliveryConfig.repository}</span>}</div></div></div><div className="event-admin-actions">{event.status !== 'RELEASED' && <button className="small" disabled={busy} onClick={() => onEdit(event)}>编辑训战</button>}{event.status !== 'RELEASED' && <button className="small danger" disabled={busy || hasSubmissions} title={hasSubmissions ? '已有提交的训战不能删除' : '删除训战'} onClick={() => onDelete(event)}>删除训战</button>}{event.status === 'OPEN' && (event.trigger === 'MANUAL' || event.trigger === 'IMPORT') && <button className="small" disabled={busy} onClick={() => onAction(event, 'start-grading')}>选择评测提交</button>}{event.status === 'OPEN' && <button className="small danger" disabled={busy} onClick={() => onAction(event, 'close')}>结束训战</button>}{event.status === 'CLOSED' && <button className="small" disabled={busy} onClick={() => onAction(event, 'reveal')}>公布结果</button>}</div></article>; })}{!events.length && <div className="panel empty">暂无训战</div>}</div>}</section>;
}

function EventEditor({ form, setForm, challenges, users, orgUnits, editing, onCancel, onSave, busy }: { form: EventDraft; setForm: (form: EventDraft | null) => void; challenges: Challenge[]; users: AdminUser[]; orgUnits: OrgUnit[]; editing: boolean; onCancel: () => void; onSave: () => void; busy: boolean }) {
  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setForm({ ...form, [key]: value });
  const versions = challenges.flatMap((challenge) => challenge.versions.filter((version) => version.status === 'PUBLISHED'));
  const departments = orgUnits.filter((unit) => unit.id !== 'org-root').sort((a, b) => a.path.localeCompare(b.path));
  const mentors = users.filter((user) => user.status === 'ACTIVE' && user.roles.includes('mentor')).sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
  const toggleMany = (field: 'departmentIds' | 'mentorIds', id: string) => update(field, form[field].includes(id) ? form[field].filter((value) => value !== id) : [...form[field], id]);
  return <section className="panel admin-editor"><div className="admin-card-heading"><div><p className="kicker">训战配置</p><h3>{editing ? '编辑训战' : '创建训战'}</h3><small>训战开放时间、交付方式和访问范围。</small></div><button className="quiet" onClick={onCancel}>取消</button></div><div className="form-grid"><label>训战 ID<input value={form.id} onChange={(event) => update('id', event.target.value)} disabled={editing} /></label><label>赛题版本<select value={form.challengeVersion} onChange={(event) => { const challengeVersion = event.target.value; setForm({ ...form, challengeVersion, trigger: engineSupportsPlatformExecution(challengeVersion, challenges) ? form.trigger : 'IMPORT' }); }}>{versions.map((version) => <option key={version.id} value={version.id}>{version.title} · v{version.version}</option>)}</select></label><label>提交方式<select value={form.submissionSource} onChange={(event) => update('submissionSource', event.target.value as Source)}><option value="UPLOAD">上传交付件</option><option value="GIT_REF">指定 Git 仓路径</option></select></label><label>评测方式<select value={form.trigger} onChange={(event) => { const trigger = event.target.value as Trigger; setForm({ ...form, trigger, pinAt: trigger === 'AUTO' ? 'SUBMIT' : form.pinAt }); }}>{engineSupportsPlatformExecution(form.challengeVersion, challenges) && <><option value="AUTO">自动评测</option><option value="MANUAL">管理员发起</option></>}<option value="IMPORT">导入评测结果</option></select>{!engineSupportsPlatformExecution(form.challengeVersion, challenges) && <small className="field-hint">该赛题使用外部评测引擎，评测完成后导入结果文件。</small>}</label><label>结果公布<select value={form.reveal} onChange={(event) => update('reveal', event.target.value as EventDraft['reveal'])}><option value="IMMEDIATE">评测后公布</option><option value="ON_RELEASE">公布后可见</option></select></label><label>训战类型<select value={form.mode} onChange={(event) => update('mode', event.target.value as EventDraft['mode'])}><option value="WINDOW">开放窗口</option><option value="LIVE">集中训战</option></select></label></div><div className="event-time-config"><div><strong>训战开放时间</strong><span>员工可在该时间窗口内提交交付件。</span></div><div className="form-grid"><label>开始时间 <input required type="datetime-local" value={form.startsAt} onChange={(event) => update('startsAt', event.target.value)} /></label><label>结束时间 <input required type="datetime-local" value={form.endsAt} onChange={(event) => update('endsAt', event.target.value)} /></label></div><small className="field-hint">时间按本地时区保存。</small></div><section className="event-access-config"><div><strong>训战访问范围</strong><span>配置可进入该训战的人员范围。</span></div><div className="form-grid"><label>访问模式<select value={form.accessMode} onChange={(event) => update('accessMode', event.target.value as EventDraft['accessMode'])}><option value="OPEN">全员可见（组织范围内）</option><option value="RESTRICTED">定向访问</option></select></label>{form.accessMode === 'RESTRICTED' && <><fieldset className="multi-choice-field"><legend>目标部门</legend><small className="field-hint">勾选一个或多个部门</small><div className="multi-choice-list">{departments.length ? departments.map((unit) => <label className="choice-check" key={unit.id}><input type="checkbox" checked={form.departmentIds.includes(unit.id)} onChange={() => toggleMany('departmentIds', unit.id)} /><span>{'　'.repeat(Math.max(0, unit.level - 1))}{unit.name}</span></label>) : <span className="choice-empty">暂无可选部门</span>}</div></fieldset><fieldset className="multi-choice-field"><legend>指定导师（可选）</legend><small className="field-hint">未指定时对全部导师开放</small><div className="multi-choice-list">{mentors.length ? mentors.map((user) => <label className="choice-check" key={user.id}><input type="checkbox" checked={form.mentorIds.includes(user.id)} onChange={() => toggleMany('mentorIds', user.id)} /><span>{displayPersonName(user.name)} · {user.employeeNo}</span></label>) : <span className="choice-empty">暂无可选导师</span>}</div></fieldset></>}</div><small className="event-access-help">员工、部门或导师任一范围匹配即可进入。</small></section><div className="form-grid">{form.submissionSource === 'GIT_REF' && <><label>Git 仓路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /><small className="field-hint">GitLab 项目路径。</small></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label><label>Git 版本固定时点<select value={form.pinAt} disabled={form.trigger === 'AUTO'} onChange={(event) => update('pinAt', event.target.value as EventDraft['pinAt'])}><option value="SUBMIT">提交时锁定</option><option value="DEADLINE">截止时锁定</option></select><small className="field-hint">自动评测在提交时锁定版本。</small></label></>}</div><div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy || !versions.length} onClick={onSave}>{busy ? '保存中…' : editing ? '保存训战配置' : '创建训战'}</button></div></section>;
}

const DEFAULT_CODE_AGENT_COMMAND = 'codeagent --prompt "{{prompt}}"';
const DEFAULT_CODE_AGENT_PROMPT = '';

type RuntimeEnvironmentRow = { name: string; value: string; description: string };

function RuntimeEnvironmentGuide({ diagnostics, onOpenEngineGuide }: { diagnostics: CodeAgentRuntimeDiagnostics | null; onOpenEngineGuide: () => void }) {
  const apiVariables: RuntimeEnvironmentRow[] = [
    { name: 'NODE_ENV', value: 'production / development', description: '生产环境始终禁止 API 进程直接启动 Code Agent；本地测试保持 development。' },
    { name: 'CODE_AGENT_RUNTIME_TEST_ENABLED', value: 'true', description: '显式开启管理页“测试启动命令”接口；默认关闭，生产环境即使设置也会被阻断。' },
    { name: 'CODE_AGENT_RUNTIME_TEST_MAX_SECONDS', value: '10–300', description: '配置测试的最长执行秒数，默认 120；不影响正式评测批次超时。' },
    { name: 'EMBEDDED_EVALUATION_WORKER', value: 'true / false', description: '是否在 API 进程内嵌入本地 Worker；生产环境应使用 false 并单独启动 Worker。' },
  ];
  const workerVariables: RuntimeEnvironmentRow[] = [
    { name: 'CODE_AGENT_COMMAND', value: 'codeagent', description: 'Worker 本地兜底可执行文件；平台配置未启用且没有命令行覆盖时使用。' },
    { name: 'CODE_AGENT_ARGS_JSON', value: '["--prompt","{{prompt}}"]', description: 'Worker 会自动将赛题、引擎、Skills、提交清单与输出要求组合为 prompt。' },
    { name: 'CODE_AGENT_ALLOWED_EXECUTABLES', value: 'codeagent', description: '可执行文件白名单；设置后平台配置和 Worker 命令都必须命中名称或绝对路径。' },
    { name: 'CODE_AGENT_BATCH_TIMEOUT_SECONDS', value: '3600', description: 'Worker 执行批次的超时覆盖值，优先级低于 --agent-timeout-seconds。' },
    { name: 'EVALUATION_WORKER_ID', value: 'worker-local', description: 'Worker 标识，仅用于管理端诊断和日志定位，不参与授权。' },
    { name: 'EVALUATION_HEARTBEAT_SECONDS', value: '60', description: 'Worker 续租心跳间隔；最小按 Worker 实现保护为 15 秒。' },
    { name: 'EVALUATION_BATCH_ROOT', value: 'tmp/evaluation-batches', description: 'Worker 批次清单、物化文件和结果索引目录；也可用 --batch-root 覆盖。' },
    { name: 'EVALUATION_LOG_ROOT', value: 'tmp/evaluation-logs', description: 'Worker 运行日志、Agent 输出和交互记录的独立目录；也可用 --log-root 覆盖，不会随批次清理。' },
    { name: 'EVALUATION_AGENT_OUTPUT_MAX_BYTES', value: '4194304', description: '单个 Agent stdout/stderr 日志的最大字节数，默认 4 MiB；超出部分会标记为已截断。' },
    { name: 'EVALUATION_WORKER_LOG_MAX_BYTES', value: '16777216', description: 'worker.log 的最大字节数，默认 16 MiB；达到上限后滚动保留最新记录。' },
    { name: 'EVALUATION_ARCHIVE_MAX_FILES', value: '10000', description: '单个评测引擎包或交付 ZIP 最多包含的文件项数。' },
    { name: 'EVALUATION_ARCHIVE_MAX_UNCOMPRESSED_BYTES', value: '536870912', description: '单个压缩包解压后的总字节上限，默认 512 MiB。' },
    { name: 'EVALUATION_ARCHIVE_MAX_FILE_BYTES', value: '134217728', description: '压缩包内单个文件的字节上限，默认 128 MiB。' },
    { name: 'EVALUATION_KEEP_BATCHES', value: 'true / false', description: '本地排查时保留批次目录；生产环境按存储策略清理。' },
    { name: 'PLATFORM_API', value: 'http://127.0.0.1:3000/api/v1', description: 'Worker 拉取批次使用的 API 地址，也可用 --api 覆盖。' },
    { name: 'PLATFORM_EMPLOYEE_ID', value: 'w00123', description: 'Worker 请求 API 使用的管理员/服务身份，也可用 --employee 覆盖。' },
    { name: 'PYTHON', value: '.venv/Scripts/python.exe', description: '评测引擎需要 Python 时使用的解释器路径；未设置则自动探测虚拟环境或 python。' },
  ];
  const leaseVariables: RuntimeEnvironmentRow[] = [
    { name: 'EVALUATION_LEASE_SECONDS', value: '900', description: '单个评测任务租约时长。' },
    { name: 'EVALUATION_LEASE_MAX_BATCH', value: '20', description: 'Worker 一次领取的评测任务上限。' },
    { name: 'EVALUATION_BATCH_LEASE_SECONDS', value: '1800', description: '评测批次租约时长；未设置时回退到 EVALUATION_LEASE_SECONDS。' },
    { name: 'EVALUATION_BATCH_LEASE_MAX', value: '5', description: '一次领取的评测批次数上限，也影响管理端队列并发展示。' },
  ];
  const engineVariables: RuntimeEnvironmentRow[] = [
    { name: 'ENGINE_PACKAGE_ROOT', value: 'tmp/engine-packages', description: '已发布评测引擎包的本地目录；生产环境应使用受控、不可变的包存储。' },
    { name: 'ENGINE_PACKAGE_MAX_BYTES', value: '33554432', description: '评测引擎包上传大小上限，单位字节。' },
    { name: 'EXECUTOR_ROOT', value: 'executors', description: '平台已注册评测执行器目录。' },
    { name: 'LOCAL_WORKSPACE_ROOT', value: '.', description: '本地交付件快照和评测工作区根目录。' },
    { name: 'ARTIFACT_ROOT', value: 'tmp/artifacts', description: '开发环境上传交付件的本地对象目录；生产环境应切换到对象存储。' },
    { name: 'ARTIFACT_MAX_BYTES', value: '52428800', description: '上传交付件大小上限，单位字节；赛题交付契约还可以进一步收紧。' },
    { name: 'GRADER_TIMEOUT_MS', value: '180000', description: '传统 grader 单次执行超时，单位毫秒。' },
    { name: 'EXTRACT_TIMEOUT_MS', value: '30000', description: '上传包安全解压超时，单位毫秒。' },
    { name: 'GIT_COMMAND_TIMEOUT_MS', value: '30000', description: '受控 Git 快照命令超时，单位毫秒。' },
    { name: 'LOCAL_GIT_ROOT', value: 'tmp/git-repos', description: '本地 Git fixture 根目录；生产环境不要接受客户端任意仓库路径。' },
    { name: 'LOCAL_GRADING_CONCURRENCY', value: '2', description: '仅对内嵌本地评测队列生效；独立 Worker 的并发由租约和部署实例控制。' },
    { name: 'ENGINE_MAX_WALL_SECONDS', value: '600', description: '评测引擎单次墙钟上限，不能超过平台批次超时。' },
    { name: 'ENGINE_MAX_MEMORY_MB', value: '2048', description: '评测引擎内存上限，具体沙箱仍以部署策略为准。' },
    { name: 'ENGINE_PIP_INDEX_URL / ENGINE_PIP_OFFLINE', value: '镜像地址 / true', description: 'PACKAGED 引擎依赖安装源和离线开关；生产环境建议固定内部镜像或离线包。' },
    { name: 'PYTHON', value: '.venv/Scripts/python.exe', description: '引擎/Grader 使用的 Python 解释器，Worker 与 API 需要使用各自主机可访问的路径。' },
  ];
  const renderRows = (rows: RuntimeEnvironmentRow[]) => <div className="runtime-env-table">{rows.map((row) => <div className="runtime-env-row" key={row.name}><code>{row.name}</code><span className="runtime-env-value">{row.value}</span><p>{row.description}</p></div>)}</div>;
  const workerStartCommand = '$env:CODE_AGENT_ALLOWED_EXECUTABLES = \'codeagent\'\n$env:EVALUATION_WORKER_ID = \'worker-local\'\n$env:PLATFORM_API = \'http://127.0.0.1:3000/api/v1\'\nnode scripts/evaluation-worker.mjs --api $env:PLATFORM_API --employee w00123 --worker $env:EVALUATION_WORKER_ID';
  const bridgeStartCommand = '$env:CODE_AGENT_COMMAND = (Get-Command node).Source\n$bridge = (Resolve-Path ./scripts/code-agent-local-bridge.mjs).Path\n$env:CODE_AGENT_ARGS_JSON = ConvertTo-Json @($bridge) -Compress\nnode scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123';
  return <section className="panel admin-card code-agent-runtime-card runtime-environment-panel">
    <div className="runtime-environment-intro"><div><strong>运行环境与变量说明</strong><p>平台只保存批次启动模板；真正执行发生在独立 Worker 主机。下列变量不需要填写到“运行配置”表单，按部署位置设置后重启对应进程。</p></div><div className="runtime-environment-actions"><button type="button" className="secondary-button admin-guide-button" onClick={onOpenEngineGuide}>评测引擎开发指南</button><span className="status-badge">当前 Worker：{diagnostics?.worker.workerId ?? '未设置'}</span></div></div>
    <div className="runtime-environment-grid">
      <article className="runtime-env-section"><div className="runtime-env-heading"><div><h3>平台 API</h3><p>由 API 进程读取；管理页测试和诊断只受这些变量影响。</p></div><span>API 进程</span></div>{renderRows(apiVariables)}</article>
      <article className="runtime-env-section"><div className="runtime-env-heading"><div><h3>Worker 与 Code Agent</h3><p>在运行 <code>scripts/evaluation-worker.mjs</code> 的主机设置。</p></div><span>Worker 主机</span></div>{renderRows(workerVariables)}</article>
      <article className="runtime-env-section runtime-env-section-wide"><div className="runtime-env-heading"><div><h3>领取租约与并发</h3><p>仅调整 Worker 领取频率和批次数，不会改变评分规则。</p></div><span>Worker / API</span></div>{renderRows(leaseVariables)}</article>
      <article className="runtime-env-section runtime-env-section-wide"><div className="runtime-env-heading"><div><h3>评测引擎与目录</h3><p>评测环境的路径和资源上限；修改后需重启读取这些变量的进程。</p></div><span>API / Worker</span></div>{renderRows(engineVariables)}</article>
    </div>
    <div className="runtime-help-grid">
      <div className="runtime-help-card"><strong>生效优先级</strong><p><code>--agent-command</code>（Worker 启动参数） &gt; 新建批次冻结的平台配置 &gt; <code>CODE_AGENT_COMMAND</code> + <code>CODE_AGENT_ARGS_JSON</code>。超时顺序为 <code>--agent-timeout-seconds</code> &gt; <code>CODE_AGENT_BATCH_TIMEOUT_SECONDS</code> &gt; 批次冻结值。</p></div>
      <div className="runtime-help-card"><strong>启用前检查</strong><p>1. 在 Worker 主机执行 <code>Get-Command codeagent</code>；2. 将 <code>codeagent</code> 加入允许列表（如已设置）；3. 确认默认配置并保存；4. 启动独立 Worker；5. 在受控开发环境完成连通性测试。</p></div>
    </div>
    <div className="runtime-command-guide"><div><strong>Code Agent Worker 启动示例（PowerShell）</strong><span>平台配置启用后，Worker 会按冻结命令注入批次清单和任务指令。</span></div><pre>{workerStartCommand}</pre><small>本地 bridge 仅用于验证批次目录和契约，不产生正式评测结果。</small><pre>{bridgeStartCommand}</pre></div>
    <div className="runtime-path-note"><strong>评测目录</strong><span><code>EVALUATION_BATCH_ROOT</code> 默认是项目下的 <code>tmp/evaluation-batches</code>；每个批次包含 <code>batch-manifest.json</code>、物化交付件和 <code>result-index.json</code>。日志独立写入 <code>EVALUATION_LOG_ROOT</code>（默认 <code>tmp/evaluation-logs/&lt;workerId&gt;</code>），包括 <code>worker.log</code>、每批次的 <code>interaction.jsonl</code>、<code>agent.stdout.log</code> 和 <code>agent.stderr.log</code>。目录属于 Worker 主机，不由浏览器上传。</span></div>
  </section>;
}

function CodeAgentRuntimeSection({ config, diagnostics, busy, onSave, onTest, onOpenGuide }: {
  config: CodeAgentRuntimeConfig;
  diagnostics: CodeAgentRuntimeDiagnostics | null;
  busy: boolean;
  onSave: (input: Pick<CodeAgentRuntimeConfig, 'enabled' | 'commandLine' | 'prompt' | 'timeoutSeconds'>) => void;
  onTest: (input: Pick<CodeAgentRuntimeConfig, 'commandLine' | 'prompt' | 'timeoutSeconds'>) => Promise<CodeAgentRuntimeTestResult | null>;
  onOpenGuide: () => void;
}) {
  const [form, setForm] = useState({ enabled: config.enabled, commandLine: config.commandLine, prompt: config.prompt, timeoutSeconds: config.timeoutSeconds });
  const [testResult, setTestResult] = useState<CodeAgentRuntimeTestResult | null>(null);
  const [runtimeTab, setRuntimeTab] = useState<'runtime' | 'environment'>('runtime');
  const [engineGuideOpen, setEngineGuideOpen] = useState(false);
  useEffect(() => {
    setForm({ enabled: config.enabled, commandLine: config.commandLine, prompt: config.prompt, timeoutSeconds: config.timeoutSeconds });
    setTestResult(null);
  }, [config]);
  const status = form.enabled ? '平台配置已启用' : '使用 Worker 本地配置';
  const sourceLabel: Record<CodeAgentRuntimeDiagnostics['worker']['source'], string> = {
    PLATFORM: '平台配置', ENVIRONMENT: 'Worker 环境变量', CLI_OVERRIDE_UNKNOWN: 'Worker 命令行覆盖（API 不可见）', NONE: '未找到',
  };
  const testStatusLabel: Record<CodeAgentRuntimeTestResult['status'], string> = { PASS: '通过', FAIL: '失败', BLOCKED: '已阻断', TIMEOUT: '超时' };
  const restoreDefaults = () => {
    const defaults = diagnostics?.defaults ?? { enabled: false, commandLine: DEFAULT_CODE_AGENT_COMMAND, prompt: DEFAULT_CODE_AGENT_PROMPT, timeoutSeconds: 3600 };
    setForm({ ...defaults });
    setTestResult(null);
  };
  const runTest = async () => {
    const result = await onTest({ commandLine: form.commandLine, prompt: form.prompt, timeoutSeconds: form.timeoutSeconds });
    setTestResult(result);
  };
  return <section className="admin-section">
    <div className="admin-section-heading"><div><p className="kicker">评测环境</p><h2>Code Agent 运行配置</h2></div><div className="admin-section-actions"><button type="button" className="secondary-button admin-guide-button" onClick={onOpenGuide}>说明指导</button><span className={`status-badge ${form.enabled ? 'status-open' : 'status-closed'}`}>{status}</span></div></div>
    <div className="runtime-tabs" role="tablist" aria-label="评测环境配置页签"><button type="button" role="tab" aria-selected={runtimeTab === 'runtime'} className={runtimeTab === 'runtime' ? 'active' : ''} onClick={() => setRuntimeTab('runtime')}>运行配置</button><button type="button" role="tab" aria-selected={runtimeTab === 'environment'} className={runtimeTab === 'environment' ? 'active' : ''} onClick={() => setRuntimeTab('environment')}>环境配置</button></div>
    {runtimeTab === 'environment' ? <RuntimeEnvironmentGuide diagnostics={diagnostics} onOpenEngineGuide={() => setEngineGuideOpen(true)} /> : <section className="panel admin-card code-agent-runtime-card">
      <div className="runtime-config-heading"><div><strong>批次启动配置</strong><span>新建评测批次会冻结当前配置；未启用平台配置时由 Worker 本地环境接管。</span></div><label className="check-label"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> 使用平台配置</label></div>
       <div className="runtime-diagnostics-grid">
         <article className="runtime-source-card"><div><span>平台配置（已保存）</span><b>{config.enabled ? '已启用' : '未启用'}</b></div><strong className="mono-value">{config.executable || '未配置可执行文件'}</strong><small>{config.enabled ? '新建批次会使用此可执行文件。' : config.executable ? '公司 Code Agent 默认模板，当前未启用。' : '尚未保存启动命令。'} · 校验值 {config.configHash.slice(0, 16)}</small></article>
        <article className="runtime-source-card"><div><span>Worker 本地配置</span><b>{diagnostics ? sourceLabel[diagnostics.worker.source] : '加载中…'}</b></div><strong className="mono-value">{diagnostics?.worker.executable ?? '未发现可执行文件'}</strong><small>{diagnostics?.worker.mode === 'EMBEDDED' ? '内嵌 Worker' : '外部 Worker'} · {diagnostics?.worker.commandPreview ?? 'CODE_AGENT_COMMAND 未设置'}</small>{Boolean(diagnostics?.worker.args.length) && <small className="mono-value">固定参数：{diagnostics?.worker.args.join(' ')}</small>}</article>
      </div>
      <div className="runtime-config-grid">
        <label className="span-2">启动命令<textarea className="mono-value" rows={3} value={form.commandLine} onChange={(event) => setForm({ ...form, commandLine: event.target.value })} placeholder={'codeagent --prompt "{{prompt}}"'} /><small className="field-hint">平台自动组合任务指令；无需填写模型。可用占位符：{'{{prompt}}'}、{'{{manifestPath}}'}、{'{{batchDir}}'}。</small></label>
        <label className="span-2">补充指令（可选）<textarea rows={5} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="可补充全局评测约束" /><small className="field-hint">赛题、题面、instruction、Skills、提交清单和结果契约由 Worker 自动组合，无需逐题填写。</small></label>
        <label>批次超时（秒）<input className="mono-value" type="number" min="60" max="21600" value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: Number(event.target.value) })} /></label>
          <div className="runtime-config-meta"><span>当前可执行文件（已保存）</span><strong className="mono-value">{config.executable || '未配置'}</strong><small>{config.enabled ? '已启用' : config.executable ? '默认模板，未启用' : '未配置'} · 允许列表：{diagnostics?.allowedExecutables.length ? diagnostics.allowedExecutables.join(', ') : '未设置（不限制）'}</small></div>
      </div>
      <div className="runtime-help-grid">
        <div className="runtime-help-card"><strong>为什么会显示“未配置”？</strong><p>平台默认关闭 Code Agent。启用平台配置后，新批次会使用这里的启动命令；保持关闭时，Worker 只能从启动参数 <code>--agent-command</code> 或环境变量 <code>CODE_AGENT_COMMAND</code> 加 <code>CODE_AGENT_ARGS_JSON</code> 取得命令。API 无法读取已经启动的 Worker 命令行参数，所以页面会明确标注“不可见”。平台配置是全局设置，只有全局管理员可以保存。</p></div>
        <div className="runtime-help-card"><strong>当前是否可以运行</strong><p>{diagnostics?.worker.reason ?? '正在读取 Worker 配置诊断…'}</p><p>{diagnostics?.test.enabled ? '测试安全开关已开启；点击测试时会使用当前表单内容，不要求先保存。' : diagnostics?.test.reason ?? '运行测试状态加载中…'}</p><p>外部 Worker 与 API 分离时，页面只显示 API 能看到的诊断；不会把 Worker 主机上不可读取的命令行伪装成“已配置”。</p></div>
      </div>
      <div className="runtime-security-note"><strong>安全边界</strong><span>运行测试只创建合成批次清单，不包含学员交付件；默认不允许 API 启动外部进程，开发环境需显式设置 CODE_AGENT_RUNTIME_TEST_ENABLED=true，生产环境始终由独立 Worker 执行。</span></div>
       <div className="editor-actions runtime-editor-actions"><button className="secondary-button" disabled={busy || !diagnostics} onClick={restoreDefaults}>恢复默认配置</button><button className="secondary-button" disabled={busy || !form.commandLine.trim()} onClick={() => void runTest()}>测试启动命令</button><button className="primary compact" disabled={busy || (form.enabled && !form.commandLine.trim())} onClick={() => onSave(form)}>{busy ? '保存中…' : '保存运行配置'}</button></div>
      {testResult && <section className={`runtime-test-result runtime-test-${testResult.status.toLowerCase()}`}><div className="runtime-test-result-heading"><div><strong>配置测试：{testStatusLabel[testResult.status]}</strong><span>{testResult.message}</span></div><span className="status-badge">{testResult.durationMs} ms</span></div><dl><div><dt>可执行文件</dt><dd className="mono-value">{testResult.executable ?? '未解析'}</dd></div><div><dt>退出状态</dt><dd className="mono-value">{testResult.exitCode ?? testResult.signal ?? '未启动'}</dd></div><div><dt>工作目录</dt><dd className="mono-value">{testResult.workingDirectory}</dd></div></dl>{(testResult.stdout || testResult.stderr) && <details><summary>查看进程输出</summary>{testResult.stdout && <pre>{testResult.stdout}</pre>}{testResult.stderr && <pre>{testResult.stderr}</pre>}</details>}</section>}
     </section>}
    {engineGuideOpen && <EvaluationEngineGuideDialog onClose={() => setEngineGuideOpen(false)} />}
  </section>;
}

function GradingSection({ submissions, events, challenges, users, queue, selectedIds, importText, setImportText, onToggle, onSelectEvent, onClearEvent, onPrepareInput, onStartSelected, onSubmission, onRegrade, onDownload, onImport, busy }: {
  submissions: Submission[];
  events: EventConfig[];
  challenges: Challenge[];
  users: AdminUser[];
  queue: QueueStats | null;
  selectedIds: string[];
  importText: string;
  setImportText: (text: string) => void;
  onToggle: (submissionId: string) => void;
  onSelectEvent: (eventId: string) => void;
  onClearEvent: (eventId: string) => void;
  onPrepareInput: (eventId: string) => void;
  onStartSelected: (eventId: string) => void;
  onSubmission: (submission: Submission) => void;
  onRegrade: (submission: Submission) => void;
  onDownload: (submission: Submission) => void;
  onImport: () => Promise<boolean>;
  busy: boolean;
}) {
  const now = Date.now();
  const [selectedEventId, setSelectedEventId] = useState('');
  const [expandedSubmissionId, setExpandedSubmissionId] = useState('');
  const [resultImportOpen, setResultImportOpen] = useState(false);
  const [resultFileName, setResultFileName] = useState('');
  const selectedSet = new Set(selectedIds);
  const groups = events.map((event) => ({ event, rows: submissions.filter((submission) => submission.eventId === event.id) }));
  const selectedGroup = groups.find((group) => group.event.id === selectedEventId);
  const closeResultImport = () => {
    setResultImportOpen(false);
    setResultFileName('');
    setImportText('');
  };
  const loadResultFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setResultFileName(file.name);
    setImportText(await file.text());
  };
  const submitImportedResult = async () => {
    if (await onImport()) {
      setResultImportOpen(false);
      setResultFileName('');
    }
  };
  const statusText = (submission: Submission) => submission.resultId ? '已完成' : submission.gradingStatus === 'FAILED' || submission.failureReason ? '评测失败' : submission.gradingStatus === 'RUNNING' ? '评测中' : submission.gradingStatus === 'QUEUED' ? '排队中' : statusLabel(submission.state);
  const subjectFor = (submission: Submission) => users.find((user) => user.id === submission.subjectId);
  const submissionDate = (submission: Submission) => formatDate(submission.snapshot.submittedAt ?? submission.createdAt);
  const renderSubmissionDetails = (submission: Submission) => {
    const snapshot = submission.snapshot;
    const subject = subjectFor(submission);
    return <div className="grading-submission-detail">
      <div className="grading-submission-person"><strong>{displayPersonName(subject?.name ?? submission.subjectId)}</strong><small>{subject?.employeeNo ?? submission.subjectId}</small></div>
      <dl>
        <div><dt>提交方式</dt><dd>{sourceLabel(snapshot.sourceType)}</dd></div>
        <div><dt>提交时间</dt><dd>{submissionDate(submission)}</dd></div>
        {snapshot.artifactName && <div><dt>文件名</dt><dd className="mono-value">{snapshot.artifactName}</dd></div>}
        {snapshot.artifactHash && <div><dt>交付件哈希</dt><dd className="mono-value">{snapshot.artifactHash}</dd></div>}
        {snapshot.repository && <div><dt>仓库路径</dt><dd className="mono-value">{snapshot.repository}</dd></div>}
        {snapshot.branch && <div><dt>分支</dt><dd className="mono-value">{snapshot.branch}</dd></div>}
        {snapshot.commitSha && <div><dt>提交版本</dt><dd className="mono-value">{snapshot.commitSha}</dd></div>}
        {snapshot.snapshotHash && <div><dt>版本快照</dt><dd className="mono-value">{snapshot.snapshotHash}</dd></div>}
      </dl>
      {submission.failureReason && <p className="grading-failure-note">失败原因：{submission.failureReason}</p>}
    </div>;
  };
  const renderEventDetail = ({ event, rows }: { event: EventConfig; rows: Submission[] }) => {
    const selectedCount = rows.filter((row) => selectedSet.has(row.id)).length;
    const selectedActionCount = rows.filter((row) => selectedSet.has(row.id) && !row.resultId && row.state !== 'GRADED').length;
    return <>
      <div className="grading-detail-back"><button className="quiet" onClick={() => { setSelectedEventId(''); setExpandedSubmissionId(''); closeResultImport(); }}>← 返回评测列表</button></div>
      <div className="grading-event-detail">
        <div className="grading-detail-heading"><div><p className="kicker">赛题评测</p><h3>{versionTitle(event.challengeVersion, challenges)}</h3><small>{eventScheduleLabel(event)}</small></div><span className={`status-badge status-${eventDisplayStatus(event, now).toLowerCase()}`}>{eventDisplayLabel(event, now)}</span></div>
        <div className="grading-detail-facts"><span>赛制：{modeLabel(event.mode)}</span><span>提交：{sourceLabel(event.submissionSource)}</span><span>评测方式：{triggerLabel(event.trigger)}</span><span>{rows.length} 份提交</span></div>
        <div className="grading-event-actions"><button className="quiet" disabled={busy || !rows.length} onClick={() => onSelectEvent(event.id)}>全选</button><button className="quiet" disabled={busy || !selectedCount} onClick={() => onClearEvent(event.id)}>清除</button>{event.trigger === 'MANUAL' && <button className="primary compact" disabled={busy || !selectedActionCount} onClick={() => onStartSelected(event.id)}>发起评测</button>}{event.trigger === 'IMPORT' && <button className="primary compact" disabled={busy || !selectedActionCount} onClick={() => onPrepareInput(event.id)}>导出评测任务</button>}<button className="secondary-button compact" disabled={busy} onClick={() => setResultImportOpen((current) => !current)}>{resultImportOpen ? '收起结果导入' : '导入评测结果'}</button><span className="grading-selected-count">已选 {selectedCount}/{rows.length}</span></div>
        <div className="grading-submission-list">{rows.map((submission) => { const subject = subjectFor(submission); const expanded = expandedSubmissionId === submission.id; return <div className="grading-submission-block" key={submission.id}><div className="grading-row"><label className="grading-check"><input type="checkbox" checked={selectedSet.has(submission.id)} onChange={() => onToggle(submission.id)} /><span className="grading-avatar">{(subject?.name ?? submission.subjectId).slice(-2)}</span></label><div><strong>{displayPersonName(subject?.name ?? submission.subjectId)}</strong><small>{subject?.employeeNo ?? submission.subjectId} · {sourceLabel(submission.snapshot.sourceType)} · {submissionDate(submission)}</small></div><span className={`status-badge status-${submission.state.toLowerCase()}`}>{statusText(submission)}</span><div className="row-actions"><button className="small" onClick={() => setExpandedSubmissionId(expanded ? '' : submission.id)}>{expanded ? '收起详情' : '查看提交'}</button>{submission.snapshot.artifactUri && <button className="small" disabled={busy} onClick={() => onDownload(submission)}>下载交付件</button>}{submission.resultId && <button className="small" disabled={busy} onClick={() => onRegrade(submission)}>重新评测</button>}{['WAITING_TRIGGER', 'RECEIVED', 'FAILED'].includes(submission.state) && event.trigger === 'MANUAL' && <button className="small" disabled={busy} onClick={() => onSubmission(submission)}>发起评测</button>}</div></div>{expanded && renderSubmissionDetails(submission)}</div>; })}{!rows.length && <div className="empty">暂无提交记录</div>}</div>
        {resultImportOpen && <section className="grading-result-import" aria-label="导入评测结果">
          <div className="grading-result-import-heading"><div><p className="kicker">评测结果</p><h4>导入评测结果</h4></div><button className="quiet" onClick={closeResultImport}>取消</button></div>
          <div className="grading-result-import-body">
            <label className="grading-result-file"><input type="file" accept=".json,application/json" onChange={(event) => void loadResultFile(event)} /><span>选择 JSON 文件</span><small>{resultFileName || '未选择文件'}</small></label>
            <span className="grading-result-divider">或</span>
            <label className="grading-result-json"><span>结果内容</span><textarea aria-label="评测结果内容" value={importText} onChange={(event) => { setImportText(event.target.value); setResultFileName(''); }} rows={8} placeholder="粘贴评测结果 JSON" /></label>
          </div>
          <div className="grading-result-import-actions"><button className="secondary-button" onClick={closeResultImport}>取消</button><button className="primary compact" disabled={busy || !importText.trim()} onClick={() => void submitImportedResult()}>{busy ? '导入中…' : '校验并导入'}</button></div>
        </section>}
      </div>
    </>;
  };
  return <section className="admin-section">
    <div className="admin-section-heading"><div><p className="kicker">评测中心</p><h2>评测中心</h2></div><div className="grading-queue-summary"><span className="status-pill">{submissions.filter((row) => !row.resultId).length} 条待处理</span>{queue && <small>评测队列：进行中 {queue.running}/{queue.maxConcurrency} · 等待 {queue.queued}</small>}</div></div>
    <div className="admin-grading-grid">
      <section className="panel admin-card grading-selection-card">{selectedGroup ? renderEventDetail(selectedGroup) : <><div className="admin-card-heading"><div><p className="kicker">训战列表</p><h3>选择赛题</h3></div></div><div className="grading-event-catalog">{groups.map(({ event, rows }) => { const pending = rows.filter((row) => !row.resultId).length; const completed = rows.length - pending; return <button type="button" className="grading-event-card" key={event.id} onClick={() => { setSelectedEventId(event.id); setExpandedSubmissionId(''); }}><span className="grading-event-card-main"><strong>{versionTitle(event.challengeVersion, challenges)}</strong><small>{eventScheduleLabel(event)}</small></span><span className="grading-event-card-meta"><b>{eventDisplayLabel(event, now)}</b><span>{rows.length} 份提交</span><span>{completed} 已完成 · {pending} 待处理</span></span><span className="grading-event-card-arrow">打开 →</span></button>; })}{!groups.length && <div className="empty">暂无可评测训战</div>}</div></>}</section>
    </div>
  </section>;
}

function OrganizationSection({ users, orgUnits, currentUserId, adminAccess, busy, onSaved, onMessage }: { users: AdminUser[]; orgUnits: OrgUnit[]; currentUserId: string; adminAccess: AdminAccess; busy: boolean; onSaved: () => Promise<void>; onMessage: (message: string) => void }) {
  const pageSize = 8;
  const rootUnit = orgUnits.find((unit) => unit.level === 0) ?? orgUnits[0];
  const rootUnitId = rootUnit?.id ?? 'org-root';
  const [unitForm, setUnitForm] = useState({ id: '', name: '', parentId: rootUnitId });
  const [userForm, setUserForm] = useState({ orgUnitId: '', roles: ['learner'] });
  const [editingId, setEditingId] = useState('');
  const [selectedOrgId, setSelectedOrgId] = useState(rootUnitId);
  const [collapsedOrgIds, setCollapsedOrgIds] = useState<Set<string>>(new Set());
  const [addingUnit, setAddingUnit] = useState(false);
  const [editingUnitId, setEditingUnitId] = useState('');
  const [unitEditForm, setUnitEditForm] = useState({ name: '' });
  const [deletingUnitId, setDeletingUnitIdState] = useState('');
  const setDeletingUnitId = (value: string) => {
    if (!value) {
      setDeletingUnitIdState('');
      return;
    }
    void onSaved().then(() => setDeletingUnitIdState(value)).catch((error) => onMessage(error instanceof Error ? error.message : '无法刷新部门信息，请稍后重试'));
  };
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [serverUserPage, setServerUserPage] = useState<UserPage | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [batchOrgUnitId, setBatchOrgUnitId] = useState('');
  const [saving, setSaving] = useState(false);
  const orgById = new Map(orgUnits.map((unit) => [unit.id, unit]));
  const unitTrail = (unit: OrgUnit, includeSelf = true) => {
    const trail: OrgUnit[] = [];
    const seen = new Set<string>();
    let current: OrgUnit | undefined = includeSelf ? unit : (unit.parentId ? orgById.get(unit.parentId) : undefined);
    while (current && !seen.has(current.id)) {
      trail.unshift(current);
      seen.add(current.id);
      current = current.parentId ? orgById.get(current.parentId) : undefined;
    }
    return trail;
  };
  const childrenByParent = new Map<string, OrgUnit[]>();
  for (const unit of orgUnits) {
    const parent = unit.parentId ?? '__root__';
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), unit]);
  }
  for (const children of childrenByParent.values()) children.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const visibleOrgUnits: OrgUnit[] = [];
  const appendVisible = (unit: OrgUnit) => {
    visibleOrgUnits.push(unit);
    if (!collapsedOrgIds.has(unit.id)) for (const child of childrenByParent.get(unit.id) ?? []) appendVisible(child);
  };
  for (const unit of childrenByParent.get('__root__') ?? []) appendVisible(unit);
  if (!visibleOrgUnits.length && rootUnit) appendVisible(rootUnit);
  const canManageUnit = (unit: OrgUnit) => adminAccess.level === 'GLOBAL' || adminAccess.scopeOrgPaths.some((scope) => unit.path === scope || unit.path.startsWith(scope));
  const manageableUnits = orgUnits.filter((unit) => unit.level !== 0 && canManageUnit(unit));
  const creatableParents = orgUnits.filter(canManageUnit);
  const selectedUnit = orgById.get(selectedOrgId);
  const editingUnit = editingUnitId ? orgById.get(editingUnitId) : undefined;
  const newUnitParent = orgById.get(unitForm.parentId);
  const newUnitLevel = newUnitParent ? newUnitParent.level + 1 : 0;
  const unitForUser = (user: AdminUser): OrgUnit | undefined => {
    const byId = orgById.get(user.orgUnitId);
    if (byId) return byId;
    const path = user.orgPath?.trim();
    if (!path) return undefined;
    return orgUnits
      .filter((unit) => unit.level > 0 && (path === unit.path || path.startsWith(unit.path)))
      .sort((left, right) => right.path.length - left.path.length)[0];
  };
  const unitContainsUser = (unit: OrgUnit, user: AdminUser) => {
    if (unit.level === 0) return true;
    const userUnit = unitForUser(user);
    return Boolean(userUnit && (userUnit.path === unit.path || userUnit.path.startsWith(unit.path)));
  };
  const localUsersInScope = users.filter((user) => {
    if (selectedOrgId === '__unassigned__') return !unitForUser(user);
    return selectedUnit ? unitContainsUser(selectedUnit, user) : true;
  });
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const localFilteredUsers = localUsersInScope.filter((user) => {
    if (!normalizedQuery) return true;
    const department = orgById.get(user.orgUnitId)?.name ?? user.departmentHint ?? '';
    return [user.name, user.employeeNo, department].some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
  });
  const serverPaging = selectedOrgId !== '__unassigned__';
  const filteredUsers = serverPaging && serverUserPage ? serverUserPage.items : localFilteredUsers;
  const totalPages = serverPaging && serverUserPage ? Math.max(1, serverUserPage.pageInfo.totalPages) : Math.max(1, Math.ceil(localFilteredUsers.length / pageSize));
  const totalUsers = serverPaging && serverUserPage ? serverUserPage.pageInfo.total : localFilteredUsers.length;
  const pageUsers = serverPaging && serverUserPage ? serverUserPage.items : localFilteredUsers.slice((page - 1) * pageSize, page * pageSize);
  const pageStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const pageNumbers = Array.from({ length: Math.min(5, totalPages) }, (_, index) => pageStart + index);
  const unassignedCount = users.filter((user) => !unitForUser(user)).length;
  const selectedChildCount = selectedUnit ? (childrenByParent.get(selectedUnit.id)?.length ?? 0) : 0;
  const selectedDirectUserCount = selectedUnit ? users.filter((user) => {
    const userUnit = unitForUser(user);
    return userUnit?.id === selectedUnit.id && (user.orgUnitId === selectedUnit.id || user.orgPath === selectedUnit.path);
  }).length : 0;
  const selectedIsScopeRoot = Boolean(selectedUnit && adminAccess.level === 'DEPARTMENT' && adminAccess.scopeOrgPaths.some((scope) => scope === selectedUnit.path));
  const selectedCanManage = Boolean(selectedUnit && canManageUnit(selectedUnit));
  const deleteBlockReason = !selectedUnit || selectedUnit.level === 0
    ? '根组织不可删除'
    : selectedIsScopeRoot
      ? '部门管理员不能删除管理范围的根部门'
      : selectedChildCount
        ? `请先调整 ${selectedChildCount} 个下级部门`
        : selectedDirectUserCount
          ? `请先调整 ${selectedDirectUserCount} 名直属员工的所属部门`
          : '';
  const roleOptions = [
    { value: 'learner', label: '新员工' },
    { value: 'mentor', label: '导师' },
    ...(adminAccess.level === 'GLOBAL' ? [{ value: 'global_admin', label: '全局管理员' }, { value: 'department_admin', label: '部门管理员' }] : []),
  ];
  const canConfigureUser = (user: AdminUser) => adminAccess.level === 'GLOBAL' || !editableRoles(user).some((role) => ['global_admin', 'department_admin'].includes(role));
  const selectedUserSet = new Set(selectedUserIds);
  const selectablePageUsers = pageUsers.filter(canConfigureUser);
  const allPageUsersSelected = selectablePageUsers.length > 0 && selectablePageUsers.every((user) => selectedUserSet.has(user.id));
  const editingUser = editingId ? users.find((user) => user.id === editingId) : undefined;
  const protectingSelfGlobalAdmin = Boolean(editingUser && editingUser.id === currentUserId && editableRoles(editingUser).includes('global_admin'));

  useEffect(() => { setPage((current) => Math.min(current, totalPages)); }, [totalPages]);
  useEffect(() => { setPage(1); setSelectedUserIds([]); setBatchOrgUnitId(''); }, [selectedOrgId, query]);
  useEffect(() => {
    if (!serverPaging) { setServerUserPage(null); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (selectedUnit && selectedUnit.level > 0) params.set('orgPath', selectedUnit.path);
      if (query.trim()) params.set('query', query.trim());
      void request<UserPage>(`/users?${params.toString()}`).then((next) => { if (active) setServerUserPage(next); }).catch(() => { if (active) setServerUserPage(null); });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [page, pageSize, query, selectedOrgId, selectedUnit?.path, serverPaging, users]);
  useEffect(() => { if (selectedOrgId !== '__unassigned__' && !orgById.has(selectedOrgId)) setSelectedOrgId(rootUnitId); }, [orgUnits, selectedOrgId, rootUnitId]);

  const save = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setSaving(true);
    try { await action(); await onSaved(); onMessage(success); return true; } catch (error) { onMessage(error instanceof Error ? error.message : '操作未完成'); return false; } finally { setSaving(false); }
  };
  const clearEdit = () => { setEditingId(''); setUserForm({ orgUnitId: '', roles: ['learner'] }); };
  const edit = (user: AdminUser) => {
    if (!canConfigureUser(user)) { onMessage('管理员账号需由全局管理员配置'); return; }
    setEditingId(user.id);
    setUserForm({ orgUnitId: user.orgUnitId, roles: editableRoles(user) });
  };
  const toggleRole = (role: string) => setUserForm((current) => {
    if (protectingSelfGlobalAdmin && role === 'global_admin' && current.roles.includes(role)) return current;
    return { ...current, roles: current.roles.includes(role) ? current.roles.filter((item) => item !== role) : [...current.roles, role] };
  });
  const submitUser = () => {
    if (!editingId) { onMessage('员工首次登录后自动登记'); return; }
    if (!userForm.roles.length) { onMessage('至少保留一个角色'); return; }
    if (protectingSelfGlobalAdmin && !userForm.roles.includes('global_admin')) { onMessage('全局管理员不能移除自己的全局管理员权限'); return; }
    void save(() => request(`/users/${editingId}`, { method: 'PATCH', body: JSON.stringify({ orgUnitId: userForm.orgUnitId, roles: userForm.roles }) }), '员工配置已保存').then((success) => { if (success) clearEdit(); });
  };
  const toggleUserSelection = (user: AdminUser) => {
    if (!canConfigureUser(user)) return;
    setSelectedUserIds((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id]);
  };
  const toggleCurrentPageSelection = () => {
    const pageIds = selectablePageUsers.map((user) => user.id);
    setSelectedUserIds((current) => allPageUsersSelected ? current.filter((id) => !pageIds.includes(id)) : [...new Set([...current, ...pageIds])]);
  };
  const batchMoveUsers = async () => {
    const selectedIds = [...selectedUserIds];
    const targetUnit = orgById.get(batchOrgUnitId);
    if (!selectedIds.length) { onMessage('请先勾选需要调整的员工'); return; }
    if (!targetUnit || targetUnit.level === 0) { onMessage('请选择目标部门'); return; }
    if (!canManageUnit(targetUnit)) { onMessage('目标部门不在当前管理员权限范围内'); return; }
    if (!window.confirm(`确认将已选 ${selectedIds.length} 名员工调整到“${targetUnit.name}”吗？`)) return;
    setSaving(true);
    try {
      const result = await request<{ requested: number; updated: AdminUser[] }>('/users/batch-department', {
        method: 'PATCH',
        body: JSON.stringify({ userIds: selectedIds, orgUnitId: targetUnit.id }),
      });
      await onSaved();
      setSelectedUserIds([]);
      setBatchOrgUnitId('');
      onMessage(`已将 ${result.updated.length} 名员工调整到“${targetUnit.name}”`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : '批量调整部门失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };
  const departmentFor = (user: AdminUser) => {
    const unit = unitForUser(user);
    if (unit) {
      const parentTrail = unitTrail(unit, false).map((item) => item.name);
      return { name: unit.name, meta: parentTrail.length ? parentTrail.join(' / ') : organizationLevelLabel(unit.level) };
    }
    if (user.departmentHint) return { name: '未配置部门', meta: `SSO 部门：${user.departmentHint}` };
    return { name: '未配置部门', meta: '待分配' };
  };
  const createUnit = async () => {
    if (!unitForm.id.trim() || !unitForm.name.trim()) { onMessage('请填写部门编号和名称'); return; }
    const success = await save(() => request('/org-units', { method: 'POST', body: JSON.stringify({ ...unitForm, label: organizationLevelLabel(newUnitLevel) }) }), '部门已创建');
    if (success) {
      setSelectedOrgId(unitForm.id.trim());
      setUnitForm({ id: '', name: '', parentId: rootUnitId });
      setAddingUnit(false);
    }
  };
  const startAddingUnit = (parentId?: string) => {
    const preferredParent = parentId ? orgById.get(parentId) : selectedUnit;
    const parent = preferredParent && canManageUnit(preferredParent) ? preferredParent : creatableParents[0];
    if (!parent) { onMessage('当前权限范围内暂无可维护部门'); return; }
    setUnitForm({ id: '', name: '', parentId: parent.id });
    setAddingUnit(true);
    setEditingUnitId('');
    setDeletingUnitId('');
  };
  const startEditingUnit = (unit: OrgUnit) => {
    setUnitEditForm({ name: unit.name });
    setEditingUnitId(unit.id);
    setAddingUnit(false);
    setDeletingUnitId('');
  };
  const updateUnit = async () => {
    if (!editingUnitId || !unitEditForm.name.trim()) { onMessage('请填写部门名称'); return; }
    const success = await save(() => request(`/org-units/${editingUnitId}`, { method: 'PATCH', body: JSON.stringify({ ...unitEditForm, ...(editingUnit ? { label: organizationLevelLabel(editingUnit.level) } : {}) }) }), '部门信息已保存');
    if (success) setEditingUnitId('');
  };
  const deleteUnit = async (unit: OrgUnit) => {
    if (deleteBlockReason) {
      setDeletingUnitId('');
      onMessage(deleteBlockReason);
      return;
    }
    const nextSelection = unit.parentId ?? rootUnitId;
    const success = await save(() => request(`/org-units/${unit.id}`, { method: 'DELETE' }), '部门已删除');
    if (success) {
      setSelectedOrgId(nextSelection);
      setDeletingUnitId('');
      setEditingUnitId('');
    }
  };
  const toggleOrg = (unit: OrgUnit) => setCollapsedOrgIds((current) => {
    const next = new Set(current);
    if (next.has(unit.id)) next.delete(unit.id); else next.add(unit.id);
    return next;
  });
  const selectOrg = (unitId: string) => { setSelectedOrgId(unitId); clearEdit(); setAddingUnit(false); setEditingUnitId(''); setDeletingUnitId(''); };
  const selectedLabel = selectedOrgId === '__unassigned__' ? '未配置部门' : selectedUnit?.level === 0 ? '全部员工' : selectedUnit?.name ?? '全部员工';
  return <section className="admin-section">
    <div className="admin-section-heading"><div><p className="kicker">组织与人员</p><h2>组织与人员</h2></div><span className="last-sync">{users.length} 名员工 · {Math.max(0, orgUnits.length - 1)} 个部门</span></div>
    <div className="organization-workspace">
      <section className="panel admin-card organization-users-card">
        <div className="admin-card-heading organization-users-heading"><div><p className="kicker">员工管理</p><h3>{editingId ? '配置员工' : '员工列表'}</h3></div><label className="employee-search"><span>搜索</span><input aria-label="搜索员工" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="姓名、工号或部门" /></label></div>
        {editingId && <div className="employee-editor"><div className="edit-user-summary">{(() => { const user = users.find((item) => item.id === editingId); return user ? <><strong>{displayPersonName(user.name)}</strong><span>{user.employeeNo}</span></> : null; })()}</div><div className="form-grid"><label>所属部门<select value={userForm.orgUnitId} onChange={(event) => setUserForm({ ...userForm, orgUnitId: event.target.value })}>{adminAccess.level === 'GLOBAL' && <option value="">未配置部门</option>}{manageableUnits.map((unit) => <option key={unit.id} value={unit.id}>{'　'.repeat(Math.max(0, unit.level - 1))}{unit.name}</option>)}</select></label><fieldset><legend>角色</legend><div className="checkbox-list">{roleOptions.map((role) => { const protectedRole = protectingSelfGlobalAdmin && role.value === 'global_admin'; return <label className="check-label" key={role.value}><input type="checkbox" checked={userForm.roles.includes(role.value)} disabled={protectedRole} onChange={() => toggleRole(role.value)} />{role.label}</label>; })}</div>{protectingSelfGlobalAdmin && <small className="muted">全局管理员不能移除自己的全局管理员权限</small>}</fieldset></div><div className="editor-actions"><button className="secondary-button" onClick={clearEdit}>取消</button><button className="primary compact" disabled={busy || saving} onClick={submitUser}>保存配置</button></div></div>}
        <div className="employee-list-toolbar"><div><strong>{selectedLabel}</strong><span>{totalUsers} 人</span></div>{(selectedOrgId !== rootUnitId || query) && <button className="small" onClick={() => { setSelectedOrgId(rootUnitId); setQuery(''); }}>清除筛选</button>}</div>
        <div className="employee-batch-toolbar"><div className="employee-batch-selection"><button className="small" type="button" onClick={toggleCurrentPageSelection} disabled={!selectablePageUsers.length || saving}>{allPageUsersSelected ? '取消全选本页' : '全选本页'}</button><button className="small" type="button" onClick={() => setSelectedUserIds([])} disabled={!selectedUserIds.length || saving}>清除选择</button><span>已选 {selectedUserIds.length} 人</span></div><div className="employee-batch-actions"><label><span>调整到部门</span><select aria-label="批量调整到部门" value={batchOrgUnitId} onChange={(event) => setBatchOrgUnitId(event.target.value)} disabled={saving || busy}><option value="">请选择目标部门</option>{manageableUnits.map((unit) => <option key={unit.id} value={unit.id}>{'　'.repeat(Math.max(0, unit.level - 1))}{unit.name}</option>)}</select></label><button className="primary compact" type="button" onClick={() => void batchMoveUsers()} disabled={busy || saving || !selectedUserIds.length || !batchOrgUnitId}>批量调整部门</button></div></div>
        <div className="admin-table-wrap organization-user-table"><table className="admin-table"><thead><tr><th><label className="employee-select-all"><input type="checkbox" checked={allPageUsersSelected} onChange={toggleCurrentPageSelection} disabled={!selectablePageUsers.length || saving} aria-label="全选当前页可调整员工" /><span>员工</span></label></th><th>部门</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{pageUsers.map((user) => { const department = departmentFor(user); const configurable = canConfigureUser(user); return <tr key={user.id}><td><div className="employee-row-identity"><input type="checkbox" checked={selectedUserSet.has(user.id)} onChange={() => toggleUserSelection(user)} disabled={!configurable || saving} aria-label={`选择${displayPersonName(user.name)}`} /><div><strong>{displayPersonName(user.name)}</strong><small>{user.employeeNo}</small></div></div></td><td><div className="department-cell"><strong>{department.name}</strong><small>{department.meta}</small></div></td><td><div className="role-list">{roleLabels(user.roles).map((role) => <span className="role-tag" key={role}>{role}</span>)}</div></td><td><span className={`status-badge status-${user.status.toLowerCase()}`}>{user.status === 'ACTIVE' ? '在职' : '已停用'}</span></td><td>{configurable ? <button className="small" onClick={() => edit(user)}>配置</button> : <span className="organization-action-note">权限受限</span>}</td></tr>; })}</tbody></table>{!pageUsers.length && <div className="empty">暂无员工</div>}</div>
        <div className="table-pagination"><span>第 {page} / {totalPages} 页 · 共 {totalUsers} 人</span><div><button className="small" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>{pageNumbers.map((number) => <button className={`small page-number${page === number ? ' active' : ''}`} key={number} onClick={() => setPage(number)}>{number}</button>)}<button className="small" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>下一页</button></div></div>
      </section>
      <aside className="organization-side">
        <section className="panel admin-card organization-departments-card">
          <div className="admin-card-heading organization-tree-heading"><div><p className="kicker">组织结构</p><h3>部门</h3></div>{creatableParents.length > 0 && <button className="small" onClick={() => addingUnit ? setAddingUnit(false) : startAddingUnit()}>{addingUnit ? '取消' : '新增部门'}</button>}</div>
          <div className="organization-tree" role="tree" aria-label="组织结构">{visibleOrgUnits.map((unit) => {
            const children = childrenByParent.get(unit.id) ?? [];
            const count = users.filter((user) => unitContainsUser(unit, user)).length;
            const collapsed = collapsedOrgIds.has(unit.id);
            return <div className={`organization-tree-row${selectedOrgId === unit.id ? ' selected' : ''}`} style={{ paddingLeft: `${6 + Math.max(0, unit.level) * 16}px` }} role="treeitem" aria-expanded={children.length ? !collapsed : undefined} key={unit.id}>{children.length ? <button type="button" className="organization-tree-toggle" aria-label={`${collapsed ? '展开' : '收起'}${unit.name}`} onClick={() => toggleOrg(unit)}>{collapsed ? '+' : '−'}</button> : <span className="organization-tree-spacer" />}<button type="button" className="organization-tree-select" onClick={() => selectOrg(unit.id)}><span className={`organization-tree-mark${unit.level === 0 ? ' root' : ''}`} aria-hidden="true" /><strong>{unit.name}</strong><span>{count} 人</span></button></div>;
          })}{unassignedCount > 0 && <div className={`organization-tree-row organization-unassigned${selectedOrgId === '__unassigned__' ? ' selected' : ''}`} role="treeitem"><span className="organization-tree-spacer" /><button type="button" className="organization-tree-select" onClick={() => selectOrg('__unassigned__')}><span className="organization-tree-mark unassigned" aria-hidden="true" /><strong>未配置部门</strong><span>{unassignedCount} 人</span></button></div>}</div>
          {selectedUnit && <div className="department-summary"><div className="department-summary-heading"><div><strong>{selectedUnit.name}</strong><span>{unitTrail(selectedUnit, false).map((unit) => unit.name).join(' / ') || '组织根节点'}</span></div><span className="role-tag">{organizationLevelLabel(selectedUnit.level)}</span></div><dl><div><dt>部门编号</dt><dd>{selectedUnit.id}</dd></div><div><dt>直属员工</dt><dd>{selectedDirectUserCount} 人</dd></div><div><dt>下级部门</dt><dd>{selectedChildCount} 个</dd></div></dl>{selectedCanManage && <div className="department-summary-actions"><button className="small" type="button" onClick={() => startEditingUnit(selectedUnit)}>编辑</button>{selectedUnit.level > 0 && <button className="small danger" type="button" disabled={Boolean(deleteBlockReason)} onClick={() => setDeletingUnitId(selectedUnit.id)}>删除</button>}</div>}{selectedCanManage && selectedUnit.level > 0 && deleteBlockReason && <small className="department-delete-block">{deleteBlockReason}</small>}{deletingUnitId === selectedUnit.id && <div className="department-delete-confirm"><strong>删除“{selectedUnit.name}”？</strong><span>删除后无法恢复。</span><div><button className="small" type="button" onClick={() => setDeletingUnitId('')}>取消</button><button className="small danger" type="button" disabled={busy || saving} onClick={() => void deleteUnit(selectedUnit)}>确认删除</button></div></div>}</div>}
          {editingUnitId && <div className="department-create-form department-edit-form"><strong>编辑部门</strong><label>部门名称<input value={unitEditForm.name} onChange={(event) => setUnitEditForm({ ...unitEditForm, name: event.target.value })} /></label><label>组织层级<input value={editingUnit ? organizationLevelLabel(editingUnit.level) : '自动识别'} readOnly /><small className="field-hint">根据组织树层级自动识别，不可手工修改。</small></label><div className="department-form-actions"><button className="small" type="button" onClick={() => setEditingUnitId('')}>取消</button><button className="primary compact" disabled={busy || saving} onClick={() => void updateUnit()}>保存修改</button></div></div>}
          {addingUnit && <div className="department-create-form"><strong>新增部门</strong><label>部门名称<input value={unitForm.name} onChange={(event) => setUnitForm({ ...unitForm, name: event.target.value })} /></label><label>部门编号<input value={unitForm.id} onChange={(event) => setUnitForm({ ...unitForm, id: event.target.value })} /></label><label>上级部门<select value={unitForm.parentId} onChange={(event) => setUnitForm({ ...unitForm, parentId: event.target.value })}>{creatableParents.map((unit) => <option key={unit.id} value={unit.id}>{'　'.repeat(Math.max(0, unit.level))}{unit.name}</option>)}</select></label><label>组织层级<input value={organizationLevelLabel(newUnitLevel)} readOnly /><small className="field-hint">根据所选上级部门自动识别，不可手工修改。</small></label><button className="primary compact" disabled={busy || saving} onClick={() => void createUnit()}>保存部门</button></div>}
        </section>
      </aside>
    </div>
  </section>;
}

function AnnouncementSection({ announcements, form, setForm, onCreate, onDelete, busy }: { announcements: Announcement[]; form: { title: string; summary: string; tag: Announcement['tag']; pinned: boolean }; setForm: (form: { title: string; summary: string; tag: Announcement['tag']; pinned: boolean }) => void; onCreate: () => void; onDelete: (id: string) => void; busy: boolean }) {
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">公告管理</p><h2>公告管理</h2></div></div><div className="announcement-admin-grid"><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">发布公告</p><h3>发布公告</h3></div></div><label>标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label>摘要<textarea value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} rows={4} /></label><label>类型<select value={form.tag} onChange={(event) => setForm({ ...form, tag: event.target.value as Announcement['tag'] })}><option value="平台通知">平台通知</option><option value="训战提醒">训战提醒</option><option value="规则更新">规则更新</option></select></label><label className="check-label"><input type="checkbox" checked={form.pinned} onChange={(event) => setForm({ ...form, pinned: event.target.checked })} /> 置顶公告</label><button className="primary" disabled={busy} onClick={onCreate}>发布并同步到员工首页</button></section><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">已发布</p><h3>已发布公告</h3></div><span className="dot-label">{announcements.length} 条</span></div>{announcements.map((announcement) => <article className="announcement-admin-row" key={announcement.id}><div><div><span className="announcement-tag tag-blue">{announcement.tag}</span>{announcement.pinned && <span className="pinned-label">置顶</span>}<time>{formatDate(announcement.publishedAt)}</time></div><strong>{announcement.title}</strong><p>{announcement.summary}</p></div><button className="small danger" onClick={() => onDelete(announcement.id)}>删除</button></article>)}</section></div></section>;
}

function AuditSection({ audits }: { audits: Audit[] }) {
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">审计日志</p><h2>审计日志</h2></div></div><section className="panel admin-table-card"><div className="admin-table-wrap"><table className="admin-table audit-table"><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>操作者</th><th>记录编号</th></tr></thead><tbody>{audits.map((audit) => <tr key={audit.id}><td>{formatDate(audit.createdAt)}</td><td><span className="audit-action">{auditActionLabel(audit.action)}</span></td><td>{auditTargetLabel(audit.target)}</td><td>{displayActorName(audit.actorId)}</td><td><small>{audit.id.slice(0, 22)}…</small></td></tr>)}</tbody></table>{!audits.length && <div className="empty">暂无审计记录</div>}</div></section></section>;
}
