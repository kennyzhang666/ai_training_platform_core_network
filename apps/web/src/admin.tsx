import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { richTextPreview, sanitizeRichText } from './rich-text';

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const ADMIN_EMPLOYEE_ID = import.meta.env.VITE_EMPLOYEE_ID ?? 'w00123';

type AdminSection = 'overview' | 'organization' | 'challenges' | 'events' | 'participants' | 'capabilities' | 'grading' | 'announcements' | 'audit';
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
type EvaluationEngineConfig = {
  id: string;
  version: string;
  mode: EngineMode;
  local?: LocalEvaluationConfig;
  package?: EnginePackageReference;
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
  evaluationEngine?: EvaluationEngineConfig;
  status: VersionStatus;
};

type Challenge = { id: string; ownerOrgPath: string; origin: string; category?: ChallengeCategory; status: ChallengeStatus; archivedFrom?: Exclude<ChallengeStatus, 'ARCHIVED'>; board?: { type: 'HARD_PROBLEM'; status: 'OPEN' | 'RESOLVED'; reviewStatus?: HardProblemReviewStatus; solutionVisibility?: 'PUBLIC' | 'HIDDEN'; solutionSubmissionId?: string; reviewedAt?: string; reviewedBy?: string; reviewComment?: string; submissionEventId?: string; publisherType: 'DEPARTMENT' | 'EMPLOYEE'; publisherName: string; departmentName?: string; difficulty: 'HIGH' | 'MEDIUM' | 'LOW'; resolvedBy?: string; resolvedByName?: string; solverId?: string; solverName?: string }; versions: ChallengeVersion[] };
type EventConfig = { id: string; challengeVersion: string; purpose?: 'TRAINING' | 'HARD_PROBLEM'; submissionSource: Source; trigger: Trigger; reveal: 'IMMEDIATE' | 'ON_RELEASE'; status: 'OPEN' | 'CLOSED' | 'RELEASED'; mode?: 'LIVE' | 'WINDOW'; startsAt?: string; endsAt?: string; participantMode?: 'OPEN' | 'ALLOWLIST'; accessPolicy?: { mode: 'OPEN' | 'RESTRICTED'; subjectIds?: string[]; departmentIds?: string[]; mentorIds?: string[] }; deliveryConfig?: { repository?: string; branchTemplate?: string; pinAt?: 'SUBMIT' | 'DEADLINE'; allowedFormats?: string[]; maxBytes?: number; maxFiles?: number } };
type Submission = { id: string; eventId: string; subjectId: string; state: string; createdAt: string; gradingRunId?: string; resultId?: string; gradingStatus?: string; failureReason?: string; snapshot: { sourceType: Source; snapshotHash?: string; artifactHash?: string; artifactUri?: string; artifactPath?: string; artifactName?: string; workspacePath?: string; repository?: string; branch?: string; commitSha?: string; submittedAt?: string } };
type EvaluationInputBatch = { schemaVersion: '1.0'; generatedAt: string; event: { id: string; challengeVersion: string; rubricVersion: string; trigger: 'IMPORT'; submissionSource: Source; reveal: 'IMMEDIATE' | 'ON_RELEASE' }; challenge: { id: string; title: string; version: number; evaluationEngine: EvaluationEngineConfig }; submissions: Array<{ submissionId: string; subject: { id: string; name: string; orgPath: string }; snapshot: Submission['snapshot']; grading: { runId: string; idempotencyKey: string; triggerType: 'IMPORT' } }> };
type Announcement = { id: string; title: string; summary: string; tag: '平台通知' | '训战提醒' | '规则更新'; publishedAt: string; pinned?: boolean };
type Audit = { id: string; actorId: string; action: string; target: string; createdAt: string };
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
type OrgUnit = { id: string; parentId?: string; path: string; level: number; label: string; name: string };
type AdminUser = { id: string; employeeNo: string; name: string; orgUnitId: string; orgPath: string; departmentHint?: string; departmentSource?: 'SSO' | 'ADMIN'; roles: string[]; roleBindings?: Array<{ role: string; scopeOrgPath: string }>; status: 'ACTIVE' | 'DISABLED' };
type AdminCapabilityProfile = {
  subjectId: string;
  summary: { gradedSubmissions: number; overallAverage: number | null; strongestDomain?: string | null; focusDomain?: string | null; evaluatedCapabilityDomains?: number; totalCapabilityDomains?: number };
  dimensions: Array<{ key: string; label: string; percent: number | null; evaluatedCount: number }>;
  domains: Array<{ key: string; label: string; shortLabel?: string; percent: number | null; status: string; evidenceCount: number; sampleCount: number }>;
  skills: Array<{ criterionKey: string; name: string; percent: number | null; averageLevel: string | null }>;
};
type AdminCapabilityBundle = {
  generatedAt: string;
  selection: { orgPath: string | null; mode: 'ALL' | 'SELECTED'; subjectIds: string[] };
  totalCandidates: number;
  selectedCount: number;
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
  evaluationEngineId: string;
  evaluationEngineVersion: string;
  evaluationEngineMode: EngineMode;
  enginePackage: EnginePackageReference | null;
  enginePackageSummary: string;
  localContractPath: string;
  localTestsDir: string;
  localEntry: string;
  localFunction: string;
  localLanguage: string;
  evaluationInputContract: string;
  evaluationOutputContract: string;
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
type Props = { onExit: () => void; userName: string; adminAccess: AdminAccess };

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
    [/administrator role is required/i, '当前账号无管理员权限'],
    [/published challenge.*immutable/i, '已发布赛题不可直接修改，请创建新版本'],
    [/result .*invalid|schema is invalid/i, '评测结果格式不正确'],
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1] ?? value;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const employeeId = typeof window === 'undefined' ? ADMIN_EMPLOYEE_ID : window.localStorage.getItem('ai-training.employeeId') ?? ADMIN_EMPLOYEE_ID;
  const response = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-employee-id': employeeId, ...(init?.headers ?? {}) } });
  if (!response.ok) {
    const detail = await response.text();
    let message = '';
    try {
      const payload = JSON.parse(detail) as { message?: string | string[] };
      message = Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? '';
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

function statusLabel(value: string): string {
  return ({ DRAFT: '草稿', PUBLISHED: '已发布', ARCHIVED: '垃圾箱', OPEN: '进行中', CLOSED: '已结束', RELEASED: '已公布', WAITING_TRIGGER: '等待处理', WAITING_IMPORT: '等待结果', RECEIVED: '已提交', QUEUED: '等待开始', RUNNING: '处理中', GRADED: '已完成', FAILED: '需要重试', ACTIVE: '在职', DISABLED: '已停用' } as Record<string, string>)[value] ?? (value && !/^[A-Z][A-Z0-9_]*$/.test(value) ? value : '—');
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
  return trigger === 'AUTO' ? '自动评测' : trigger === 'MANUAL' ? '手动触发' : trigger === 'IMPORT' ? '线下评测' : trigger ?? '—';
}

function revealLabel(reveal?: string): string {
  return reveal === 'IMMEDIATE' ? '评测后公布' : reveal === 'ON_RELEASE' ? '公布后可见' : reveal ?? '—';
}

function modeLabel(mode?: string): string {
  return mode === 'LIVE' ? '集中训战' : mode === 'WINDOW' ? '开放窗口' : mode ?? '—';
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
    'challenge.create': '创建赛题', 'challenge.update': '更新赛题', 'challenge.publish': '发布赛题', 'challenge.archive': '移入垃圾箱', 'challenge.restore': '恢复赛题',
    'challenge.version.create': '创建赛题版本', 'challenge.version.update': '更新赛题版本', 'challenge.version.publish': '发布赛题版本',
    'event.create': '创建训战', 'event.update': '更新训战', 'event.start-grading': '批量安排评测', 'event.execute-local': '执行线上评测', 'event.close': '结束训战', 'event.reveal': '公布评测结果',
    'submission.start-grading': '安排评测', 'grading-result.import': '录入评测结果', 'grading.regrade': '重新评测', 'org-unit.create': '创建部门', 'org-unit.update': '更新部门', 'user.create': '同步员工资料', 'user.update': '配置员工', 'user.roles.update': '配置员工权限', 'sso.user-provision': '登记员工资料', 'sso.user-sync': '同步员工资料', 'announcement.create': '发布公告', 'announcement.update': '更新公告', 'announcement.delete': '删除公告',
  } as Record<string, string>)[action] ?? action;
}

function auditTargetLabel(target: string): string {
  return target.replace(/^challenge:/, '赛题：').replace(/^event:/, '场次：').replace(/^submission:/, '提交：').replace(/^org-unit:/, '部门：').replace(/^user:/, '员工：').replace(/^announcement:/, '公告：');
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

function blankChallenge(): ChallengeDraft {
  return { id: '', title: '', category: 'TRAINING', description: '', objectives: '', requirements: '', constraints: '', deliverables: '', tags: '', estimatedMinutes: '45', zone: 'YELLOW', languages: 'python', allowUpload: true, allowGit: true, repository: '', branchTemplate: 'drill/{subjectId}', rubricVersion: '1.0', submissionContract: 'contracts/submission-contract.schema.json', evaluationEngineId: '', evaluationEngineVersion: '1.0.0', evaluationEngineMode: 'EXTERNAL_CLI', enginePackage: null, enginePackageSummary: '', localContractPath: '', localTestsDir: '', localEntry: '', localFunction: '', localLanguage: 'python', evaluationInputContract: 'contracts/evaluation-input.schema.json', evaluationOutputContract: 'contracts/evaluation-result.schema.json' };
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
  return { id: version?.challengeId ?? '', title: version?.title ?? '', category: 'TRAINING', description: version?.description ?? '', objectives: (version?.objectives ?? []).join('\n'), requirements: (version?.requirements ?? []).join('\n'), constraints: (version?.constraints ?? []).join('\n'), deliverables: (version?.deliverables ?? []).join('\n'), tags: (version?.tags ?? []).join('\n'), estimatedMinutes: String(version?.estimatedMinutes ?? 45), zone: version?.zone ?? 'YELLOW', languages: languages.join('\n'), allowUpload: allowed.includes('UPLOAD'), allowGit: allowed.includes('GIT_REF'), repository: String(git.repository ?? ''), branchTemplate: String(git.branchTemplate ?? 'drill/{subjectId}'), rubricVersion: version?.rubricVersion ?? '1.0', submissionContract: version?.submissionContract ?? 'contracts/submission-contract.schema.json', evaluationEngineId: engine?.id ?? `${version?.challengeId ?? 'challenge'}-evaluator`, evaluationEngineVersion: engine?.version ?? '1.0.0', evaluationEngineMode: engine?.mode ?? 'EXTERNAL_CLI', enginePackage: engine?.package ?? null, enginePackageSummary: engine?.package ? `${engine.package.fileName ?? '引擎包'} · ${engine.package.packageHash.slice(0, 12)}…` : '', localContractPath: engine?.local?.contractPath ?? '', localTestsDir: engine?.local?.testsDir ?? '', localEntry: engine?.local?.entry ?? '', localFunction: engine?.local?.function ?? '', localLanguage: engine?.local?.language ?? 'python', evaluationInputContract: engine?.input.contractPath ?? 'contracts/evaluation-input.schema.json', evaluationOutputContract: engine?.output.contractPath ?? 'contracts/evaluation-result.schema.json' };
}

export function AdminWorkspace({ onExit, userName, adminAccess }: Props) {
  const [section, setSection] = useState<AdminSection>('events');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [events, setEvents] = useState<EventConfig[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [orgUnits, setOrgUnits] = useState<OrgUnit[]>([]);
  const [adminCapabilities, setAdminCapabilities] = useState<AdminCapabilityBundle | null>(null);
  const [capabilityOrgPath, setCapabilityOrgPath] = useState('');
  const [capabilitySubjectIds, setCapabilitySubjectIds] = useState<string[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [queue, setQueue] = useState<QueueStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedGradingIds, setSelectedGradingIds] = useState<string[]>([]);
  const [gradingInputText, setGradingInputText] = useState('');
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
  const [participantText, setParticipantText] = useState('');

  const visibleChallenges = useMemo(() => challenges.filter((challenge) => challengeView === 'trash' ? challenge.status === 'ARCHIVED' : challenge.status !== 'ARCHIVED'), [challenges, challengeView]);
  const selectedChallenge = useMemo(() => visibleChallenges.find((challenge) => challenge.id === selectedChallengeId), [visibleChallenges, selectedChallengeId]);
  const publishedVersions = useMemo(() => challenges.filter((challenge) => challenge.status !== 'ARCHIVED').flatMap((challenge) => challenge.versions.filter((version) => version.status === 'PUBLISHED')), [challenges]);
  const pendingSubmissions = useMemo(() => submissions.filter((submission) => ['WAITING_TRIGGER', 'WAITING_IMPORT', 'RECEIVED', 'QUEUED', 'RUNNING', 'FAILED'].includes(submission.state) || ['PENDING', 'QUEUED', 'RUNNING', 'FAILED'].includes(submission.gradingStatus ?? '')), [submissions]);
  const gradingSubmissions = useMemo(() => submissions.filter((submission) => pendingSubmissions.includes(submission) || Boolean(submission.resultId)), [submissions, pendingSubmissions]);
  const capabilityUsers = useMemo(() => {
    const prefix = capabilityOrgPath ? (capabilityOrgPath.endsWith('/') ? capabilityOrgPath : `${capabilityOrgPath}/`) : '';
    return users.filter((user) => user.status === 'ACTIVE' && user.roles.includes('learner') && (!prefix || user.orgPath === prefix || user.orgPath.startsWith(prefix)));
  }, [users, capabilityOrgPath]);

  async function refresh() {
    const [loadedOverview, loadedChallenges, loadedEvents, loadedSubmissions, loadedUsers, loadedOrgUnits, loadedCapabilities, loadedAnnouncements, loadedAudits, loadedQueue] = await Promise.all([
      request<Overview>('/admin/overview'), request<Challenge[]>('/challenges'), request<EventConfig[]>('/events'), request<Submission[]>('/submissions'), request<AdminUser[]>('/users'), request<OrgUnit[]>('/org-units'), request<AdminCapabilityBundle>('/admin/capabilities'), request<Announcement[]>('/announcements'), request<Audit[]>('/audits'), request<QueueStats>('/admin/grading-queue'),
    ]);
    setOverview(loadedOverview);
    setChallenges(loadedChallenges);
    setEvents(loadedEvents);
    setSubmissions(loadedSubmissions);
    setUsers(loadedUsers);
    setOrgUnits(loadedOrgUnits);
    setAdminCapabilities(loadedCapabilities);
    setAnnouncements(loadedAnnouncements);
    setAudits(loadedAudits);
    setQueue(loadedQueue);
    const firstActiveChallenge = loadedChallenges.find((challenge) => challenge.status !== 'ARCHIVED') ?? loadedChallenges[0];
    if (!selectedChallengeId && firstActiveChallenge) setSelectedChallengeId(firstActiveChallenge.id);
    if (!participantEventId && loadedEvents[0]) setParticipantEventId(loadedEvents[0].id);
  }

  useEffect(() => { void refresh().catch((error: Error) => setMessage(error.message)); }, []);

  async function runAction(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    setMessage('正在保存，请稍候…');
    try { await action(); setMessage(success); await refresh(); return true; } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败，请稍后重试'); return false; } finally { setBusy(false); }
  }

  async function loadAdminCapabilities(mode: 'ALL' | 'SELECTED', includeProfiles = mode === 'ALL' && !capabilityOrgPath) {
    if (mode === 'SELECTED' && !capabilitySubjectIds.length) {
      setMessage('请选择参训员工');
      return;
    }
    const params = new URLSearchParams();
    if (capabilityOrgPath) params.set('orgPath', capabilityOrgPath);
    if (mode === 'SELECTED') params.set('subjectIds', capabilitySubjectIds.join(','));
    params.set('includeProfiles', String(includeProfiles));
    setBusy(true);
      setMessage('正在加载群体能力画像…');
    try {
      const query = params.toString();
      const loaded = await request<AdminCapabilityBundle>(`/admin/capabilities${query ? `?${query}` : ''}`);
      setAdminCapabilities(loaded);
      setSection('capabilities');
      setMessage(mode === 'ALL' ? '已加载所选范围的平均画像' : `已加载 ${loaded.selectedCount} 人的平均画像`);
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
    setCapabilitySubjectIds(capabilityUsers.map((user) => user.id));
  }

  function buildVersion(form: ChallengeDraft, challengeId: string, versionNumber: number): ChallengeVersion {
    const allowedSources: Source[] = [form.allowUpload ? 'UPLOAD' : null, form.allowGit ? 'GIT_REF' : null].filter((source): source is Source => source !== null);
    const upload = form.allowUpload ? { formats: ['zip'], maxBytes: 50 * 1024 * 1024, maxFiles: 2000 } : undefined;
    const git = form.allowGit && form.repository ? { provider: 'GITLAB', repository: form.repository, branchTemplate: form.branchTemplate || 'drill/{subjectId}', pinAt: 'SUBMIT', credentialRef: 'gitlab-grader-readonly' } : undefined;
    return {
    id: `${challengeId}@${versionNumber}`, challengeId, version: versionNumber, title: form.title.trim(), description: sanitizeRichText(form.description).trim(), objectives: lines(form.objectives), requirements: lines(form.requirements), constraints: lines(form.constraints), deliverables: lines(form.deliverables), tags: lines(form.tags), estimatedMinutes: Number(form.estimatedMinutes) || 45, zone: form.zone, languagePolicy: { mode: 'fixed', languages: lines(form.languages) }, deliveryPolicy: { allowedSources, ...(upload ? { upload } : {}), ...(git ? { git } : {}) }, rubricVersion: form.rubricVersion || '1.0', submissionContract: form.submissionContract.trim(), status: 'DRAFT',
      evaluationEngine: {
        id: form.evaluationEngineId.trim() || `${challengeId}-evaluator`,
        version: form.evaluationEngineVersion.trim() || '1.0.0',
        mode: form.evaluationEngineMode,
        // Only a PLATFORM_LOCAL engine carries executor parameters; the API
        // rejects them on an EXTERNAL_CLI engine.
        ...(form.evaluationEngineMode === 'PACKAGED' && form.enginePackage ? { package: form.enginePackage } : {}),
        ...(form.evaluationEngineMode === 'PLATFORM_LOCAL' ? {
          local: {
            contractPath: form.localContractPath.trim(),
            ...(form.localTestsDir.trim() ? { testsDir: form.localTestsDir.trim() } : {}),
            entry: form.localEntry.trim(),
            function: form.localFunction.trim(),
            ...(form.localLanguage.trim() ? { language: form.localLanguage.trim() } : {}),
          },
        } : {}),
        input: { format: 'JSON', schemaVersion: '1.0', contractPath: form.evaluationInputContract.trim() || 'contracts/evaluation-input.schema.json' },
        output: { format: 'JSON', schemaVersion: '1.0', contractPath: form.evaluationOutputContract.trim() || 'contracts/evaluation-result.schema.json' },
      },
    };
  }

  async function saveChallenge() {
    if (!challengeForm) return;
    if (!challengeForm.id.trim() || !challengeForm.title.trim()) { setMessage('请填写赛题 ID 和标题'); return; }
    if (!richTextPreview(challengeForm.description)) { setMessage('请填写赛题详情'); return; }
    if (!challengeForm.allowUpload && !challengeForm.allowGit) { setMessage('至少选择一种提交方式'); return; }
    if (!lines(challengeForm.languages).length) { setMessage('至少填写一种支持的编程语言'); return; }
    if (challengeForm.allowGit && !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(challengeForm.repository.trim())) { setMessage('Git 仓库路径格式不正确'); return; }
    if (!localEngineComplete(challengeForm)) { setMessage(challengeForm.evaluationEngineMode === 'PACKAGED' ? '请先上传评测引擎包' : '平台本地执行器需要填写提交契约路径、入口文件和入口函数'); return; }
    const version = buildVersion(challengeForm, challengeForm.id.trim(), 1);
    await runAction(() => request('/challenges', { method: 'POST', body: JSON.stringify({ id: challengeForm.id.trim(), ownerOrgPath: '/', origin: challengeForm.category === 'HARD_PROBLEM' ? 'BOUNTY' : 'OFFICIAL', category: challengeForm.category, status: 'DRAFT', versions: [version], actorId: 'admin-local' }) }), '赛题草稿已创建');
    setChallengeForm(null);
  }

  function localEngineComplete(form: ChallengeDraft): boolean {
    if (form.evaluationEngineMode === 'PACKAGED') return Boolean(form.enginePackage?.packageHash);
    if (form.evaluationEngineMode !== 'PLATFORM_LOCAL') return true;
    return Boolean(form.localContractPath.trim() && form.localEntry.trim() && form.localFunction.trim());
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
        evaluationInputContract: 'contracts/engine-invocation.schema.json',
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
    if (versionForm.allowGit && !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(versionForm.repository.trim())) { setMessage('Git 仓库路径格式不正确'); return; }
    if (!localEngineComplete(versionForm)) { setMessage(versionForm.evaluationEngineMode === 'PACKAGED' ? '请先上传评测引擎包' : '平台本地执行器需要填写提交契约路径、入口文件和入口函数'); return; }
    if (versionEditId) {
      const current = selectedChallenge.versions.find((item) => item.id === versionEditId);
      if (!current) return;
      const version = buildVersion(versionForm, selectedChallenge.id, current.version);
      const { id: _id, challengeId: _challengeId, version: _version, status: _status, ...patch } = version;
      await runAction(() => request(`/challenges/${selectedChallenge.id}/versions/${versionEditId}`, { method: 'PATCH', body: JSON.stringify({ ...patch, actorId: 'admin-local' }) }), '赛题草稿已保存');
    } else {
      const nextNumber = Math.max(...selectedChallenge.versions.map((version) => version.version), 0) + 1;
      const version = buildVersion(versionForm, selectedChallenge.id, nextNumber);
      await runAction(() => request(`/challenges/${selectedChallenge.id}/versions`, { method: 'POST', body: JSON.stringify({ ...version, actorId: 'admin-local' }) }), `v${nextNumber} 草稿已创建`);
    }
    setVersionForm(null);
    setVersionEditId('');
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

  async function eventAction(event: EventConfig, action: 'start-grading' | 'execute-local' | 'close' | 'reveal') {
    if (action === 'start-grading' || action === 'execute-local') {
      setSelectedGradingIds([]);
      setSection('grading');
      setMessage(`请在评测中心选择「${versionTitle(event.challengeVersion, challenges)}」的提交`);
      return;
    }
    const body = JSON.stringify({ actorId: 'admin-local' });
    await runAction(() => request(`/events/${event.id}/${action}`, { method: 'POST', body }), action === 'close' ? '场次已结束' : '评测结果已公布');
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
      setGradingInputText(JSON.stringify(batch, null, 2));
      setSection('grading');
    }, `已生成 ${submissionIds.length} 份评测输入`);
  }

  async function startSelectedGrading(eventId: string) {
    const submissionIds = selectedGradingIds.filter((id) => pendingSubmissions.some((submission) => submission.id === id && submission.eventId === eventId));
    if (!submissionIds.length) { setMessage('请选择要评测的提交'); return; }
    await runAction(() => request(`/events/${eventId}/start-grading`, { method: 'POST', body: JSON.stringify({ submissionIds, actorId: 'admin-local' }) }), `已安排 ${submissionIds.length} 份提交进入评测队列`);
  }

  async function executeSelectedGrading(eventId: string) {
    const submissionIds = selectedGradingIds.filter((id) => pendingSubmissions.some((submission) => submission.id === id && submission.eventId === eventId));
    if (!submissionIds.length) { setMessage('请选择要执行的提交'); return; }
    await runAction(() => request(`/events/${eventId}/execute-local`, { method: 'POST', body: JSON.stringify({ submissionIds, actorId: 'admin-local' }) }), `已完成 ${submissionIds.length} 份提交的线上评测`);
  }

  async function submissionAction(submission: Submission, action: 'trigger' | 'execute') {
    const path = action === 'trigger' ? `/submissions/${submission.id}/start-grading` : `/grading-runs/${submission.gradingRunId}/execute`;
    await runAction(() => request(path, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), action === 'trigger' ? '已进入评测队列' : '线上评测已完成');
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

  async function importResult() {
    try {
      const result = JSON.parse(importText) as Record<string, unknown>;
      if (await runAction(() => request('/grading-results:import', { method: 'POST', body: JSON.stringify({ result, actorId: 'admin-local' }) }), '线下评测结果已导入')) setImportText('');
    } catch (error) { setMessage(error instanceof Error ? error.message : '评测结果格式不正确'); }
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
      setParticipantText(rows.map((row) => row.subjectId).join('\n'));
      setMessage(rows.length ? `已加载 ${rows.length} 名参赛员工` : '暂无参赛员工');
    } catch (error) { setMessage(error instanceof Error ? error.message : '参赛名单加载失败'); }
  }

  async function saveParticipants() {
    if (!participantEventId) return;
    const subjectIds = lines(participantText);
    await runAction(() => request(`/events/${participantEventId}/participants`, { method: 'PUT', body: JSON.stringify({ subjectIds }) }), `参赛名单已保存，共 ${subjectIds.length} 人`);
  }

  const menu: Array<{ id: AdminSection; label: string; icon: string; count?: number }> = [
    { id: 'overview', label: '运营总览', icon: '▦' },
    { id: 'organization', label: '组织与人员', icon: '♙', count: users.length },
    { id: 'events', label: '训战管理', icon: '◷', count: overview?.events.open },
    { id: 'challenges', label: '赛题库', icon: '◇', count: overview ? overview.challenges.total - overview.challenges.archived : undefined },
    { id: 'participants', label: '参训名单', icon: '♙' },
    { id: 'capabilities', label: 'AI 能力画像', icon: '◎', count: adminCapabilities?.selectedCount },
    { id: 'grading', label: '评测中心', icon: '✓', count: overview?.grading.queuedOrRunning },
    { id: 'announcements', label: '公告管理', icon: '✦', count: overview?.announcements },
    { id: 'audit', label: '审计日志', icon: '≡' },
  ];

  const scopeLabel = adminAccess.level === 'GLOBAL' ? '全组织' : '所属部门及下属组织';
  const roleLabel = adminAccess.level === 'GLOBAL' ? '全局管理员' : '部门管理员';
  return <main className="admin-page">
    <section className="admin-heading panel"><div><p className="kicker">管理后台</p><h1>管理后台</h1></div><button className="secondary-button" onClick={onExit}>← 返回员工首页</button></section>
    <div className="admin-layout">
      <aside className="admin-sidebar panel"><div className="admin-sidebar-title"><span className="admin-mark">A</span><div><strong>平台管理</strong><small>训战运营中心</small></div></div><nav>{menu.map((item) => <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}><span>{item.icon}</span><b>{item.label}</b>{item.count !== undefined && <em>{item.count}</em>}</button>)}</nav><div className="admin-sidebar-note"><strong>权限范围</strong><span>当前账号：{roleLabel}</span><span>组织范围：{scopeLabel}</span></div></aside>
      <section className="admin-main">
        {message && <div className="admin-message">{message}</div>}
        {section === 'overview' && <OverviewSection overview={overview} challenges={challenges} events={events} submissions={submissions} onSection={setSection} />}
        {section === 'organization' && <OrganizationSection users={users} orgUnits={orgUnits} adminAccess={adminAccess} busy={busy} onSaved={() => void refresh()} onMessage={setMessage} />}
        {section === 'challenges' && <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">赛题库</p><h2>赛题库</h2></div><button className="primary compact" onClick={() => { setChallengeView('active'); setChallengeForm(blankChallenge()); }}>＋ 新建赛题</button></div>{challengeForm && <ChallengeEditor form={challengeForm} setForm={setChallengeForm} onCancel={() => setChallengeForm(null)} onSave={() => void saveChallenge()} onUploadPackage={(file) => uploadEnginePackage(file, challengeForm, setChallengeForm)} busy={busy} title="创建赛题草稿" />}{versionForm && selectedChallenge && <ChallengeEditor form={versionForm} setForm={setVersionForm} onCancel={() => { setVersionForm(null); setVersionEditId(''); }} onSave={() => void saveVersion()} onUploadPackage={(file) => uploadEnginePackage(file, versionForm, setVersionForm)} busy={busy} title={versionEditId ? `编辑 ${selectedChallenge.id} 草稿` : `创建 ${selectedChallenge.id} 新版本`} />}{!challengeForm && !versionForm && <ChallengeList challenges={visibleChallenges} view={challengeView} activeCount={challenges.filter((challenge) => challenge.status !== 'ARCHIVED').length} trashCount={challenges.filter((challenge) => challenge.status === 'ARCHIVED').length} onViewChange={setChallengeView} selectedId={selectedChallengeId} onSelect={setSelectedChallengeId} onPublish={(id) => void runAction(() => request(`/challenges/${id}/publish`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '赛题已发布')} onTrash={(id) => void runAction(() => request(`/challenges/${id}/trash`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '赛题已移入垃圾箱')} onRestore={(id) => void runAction(() => request(`/challenges/${id}/restore`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '赛题已恢复')} />}{selectedChallenge && !challengeForm && !versionForm && <ChallengeDetail challenge={selectedChallenge} events={events} onNewVersion={() => { setVersionEditId(''); setVersionForm(draftFromVersion(selectedChallenge.versions[selectedChallenge.versions.length - 1])); }} onEditVersion={(version) => { setVersionEditId(version.id); setVersionForm(draftFromVersion(version)); }} onCategoryChange={(category) => void runAction(() => request(`/challenges/${selectedChallenge.id}`, { method: 'PATCH', body: JSON.stringify({ category, actorId: 'admin-local' }) }), '赛题类型已更新')} onSolutionVisibilityChange={(solutionVisibility) => void runAction(() => request(`/challenges/${selectedChallenge.id}`, { method: 'PATCH', body: JSON.stringify({ solutionVisibility, actorId: 'admin-local' }) }), '交付件展示策略已更新')} onPublish={(versionId) => void runAction(() => request(`/challenges/${selectedChallenge.id}/versions/${versionId}/publish`, { method: 'POST', body: JSON.stringify({ actorId: 'admin-local' }) }), '赛题版本已发布')} />}</section>}
        {section === 'events' && <EventsSection events={events} challenges={challenges} overview={overview} users={users} orgUnits={orgUnits} eventForm={eventForm} setEventForm={setEventForm} eventEditId={eventEditId} onNew={() => { setEventEditId(''); setEventForm(blankEvent(publishedVersions[0]?.id ?? '', challenges)); }} onEdit={(event) => { setEventEditId(event.id); setEventForm(draftFromEvent(event)); }} onCreate={() => void saveEvent()} onAction={(event, action) => void eventAction(event, action)} busy={busy} />}
        {section === 'participants' && <ParticipantSection events={events} eventId={participantEventId} setEventId={setParticipantEventId} text={participantText} setText={setParticipantText} onLoad={(id) => void loadParticipants(id)} onSave={() => void saveParticipants()} busy={busy} />}
        {section === 'capabilities' && <CapabilityAdminSection data={adminCapabilities} users={capabilityUsers} orgUnits={orgUnits} orgPath={capabilityOrgPath} selectedIds={capabilitySubjectIds} onOrgPathChange={(path) => { setCapabilityOrgPath(path); setCapabilitySubjectIds([]); }} onToggle={toggleCapabilitySubject} onSelectAll={selectAllCapabilityUsers} onClear={() => setCapabilitySubjectIds([])} onViewAll={() => void loadAdminCapabilities('ALL')} onViewSelected={() => void loadAdminCapabilities('SELECTED')} busy={busy} />}
        {section === 'grading' && <GradingSection submissions={gradingSubmissions} events={events} challenges={challenges} users={users} queue={queue} selectedIds={selectedGradingIds} inputText={gradingInputText} importText={importText} setInputText={setGradingInputText} setImportText={setImportText} onToggle={toggleGradingSelection} onSelectEvent={selectEventSubmissions} onClearEvent={clearEventSubmissions} onPrepareInput={(eventId) => void prepareEvaluationInput(eventId)} onStartSelected={(eventId) => void startSelectedGrading(eventId)} onExecuteSelected={(eventId) => void executeSelectedGrading(eventId)} onSubmission={(submission, action) => void submissionAction(submission, action)} onRegrade={(submission) => void regradeSubmission(submission)} onDownload={(submission) => void downloadSubmissionArtifact(submission).catch((error) => setMessage(error instanceof Error ? error.message : '交付件下载失败'))} onImport={() => void importResult()} busy={busy} />}
        {section === 'announcements' && <AnnouncementSection announcements={announcements} form={announcementForm} setForm={setAnnouncementForm} onCreate={() => void createAnnouncement()} onDelete={(id) => void runAction(() => request(`/announcements/${id}`, { method: 'DELETE', body: JSON.stringify({ actorId: 'admin-local' }) }), '公告已删除')} busy={busy} />}
        {section === 'audit' && <AuditSection audits={audits} />}
      </section>
    </div>
  </main>;
}

function OverviewSection({ overview, challenges, events, submissions, onSection }: { overview: Overview | null; challenges: Challenge[]; events: EventConfig[]; submissions: Submission[]; onSection: (section: AdminSection) => void }) {
  const title = (versionId: string) => versionTitle(versionId, challenges);
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">运营总览</p><h2>运营总览</h2></div><span className="last-sync">{overview ? `更新于 ${formatDate(overview.generatedAt)}` : '加载中…'}</span></div><div className="admin-stat-grid"><AdminStat label="已发布赛题" value={overview?.challenges.published ?? '—'} hint={`${overview?.challenges.versions ?? 0} 个赛题版本`} tone="blue" /><AdminStat label="开放训战" value={overview?.events.open ?? '—'} hint={`${overview?.events.total ?? 0} 个训战配置`} tone="violet" /><AdminStat label="待处理评测" value={overview?.grading.queuedOrRunning ?? '—'} hint={`${overview?.grading.failed ?? 0} 个需要重试`} tone="orange" /><AdminStat label="累计提交" value={overview?.submissions.total ?? '—'} hint={`${overview?.submissions.graded ?? 0} 份已完成`} tone="green" /></div><div className="admin-overview-grid"><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">训战监控</p><h3>训战运行状态</h3></div><button className="quiet" onClick={() => onSection('events')}>管理训战 →</button></div>{overview?.eventStats.map((item) => <div className="event-monitor-row" key={item.eventId}><span className={`monitor-dot monitor-${item.status.toLowerCase()}`} /><div><strong>{title(item.challengeVersion)}</strong><small>{statusLabel(item.status)}</small></div><span>{item.submissionCount} 份提交</span><b>{item.pendingCount > 0 ? `${item.pendingCount} 待处理` : '当前无待处理项'}</b></div>)}{!overview?.eventStats.length && <div className="empty">暂无训战</div>}</section><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">常用操作</p><h3>常用操作</h3></div></div><div className="quick-action-grid"><button onClick={() => onSection('challenges')}><span>◇</span><strong>创建赛题</strong><small>赛题配置</small></button><button onClick={() => onSection('events')}><span>◷</span><strong>创建训战</strong><small>训战配置</small></button><button onClick={() => onSection('grading')}><span>✓</span><strong>进入评测中心</strong><small>评测处理</small></button><button onClick={() => onSection('announcements')}><span>✦</span><strong>发布公告</strong><small>公告发布</small></button></div></section></div><div className="admin-overview-grid"><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">最近操作</p><h3>最近操作</h3></div><button className="quiet" onClick={() => onSection('audit')}>查看全部 →</button></div>{overview?.recentAudits.slice(0, 5).map((audit) => <div className="audit-mini-row" key={audit.id}><span className="audit-icon">{audit.action.includes('grading') ? '✓' : audit.action.includes('challenge') ? '◇' : '•'}</span><div><strong>{auditActionLabel(audit.action)}</strong><small>{auditTargetLabel(audit.target)} · {displayActorName(audit.actorId)}</small></div><time>{formatDate(audit.createdAt)}</time></div>)}</section><section className="panel admin-card admin-roadmap"><div className="admin-card-heading"><div><p className="kicker">运营提醒</p><h3>运营提醒</h3></div></div><div className="empty compact-empty">暂无运营提醒</div></section></div><div className="admin-footer-note">当前赛季：{overview?.activeSeason?.name ?? '尚未创建运行中赛季'}</div></section>;
}

function AdminStat({ label, value, hint, tone }: { label: string; value: string | number; hint: string; tone: string }) {
  return <article className={`admin-stat panel tone-${tone}`}><span className="admin-stat-icon">{tone === 'blue' ? '◇' : tone === 'violet' ? '◷' : tone === 'orange' ? '!' : '✓'}</span><div><strong>{value}</strong><span>{label}</span><small>{hint}</small></div></article>;
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
  onPublish: (id: string) => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
};

function ChallengeList({ challenges, view, activeCount, trashCount, onViewChange, selectedId, onSelect, onPublish, onTrash, onRestore }: ChallengeListProps) {
  const emptyText = view === 'trash' ? '垃圾箱为空' : '暂无赛题';
  return <div className="panel admin-table-card">
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
            {view === 'trash' ? <button className="small restore" onClick={(event) => { event.stopPropagation(); onRestore(challenge.id); }}>恢复赛题</button> : <>{challenge.status !== 'PUBLISHED' && <button className="small" onClick={(event) => { event.stopPropagation(); onPublish(challenge.id); }}>发布</button>}<button className="small danger" onClick={(event) => { event.stopPropagation(); onTrash(challenge.id); }}>移入垃圾箱</button></>}
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
    void request<Submission[]>(`/submissions?eventId=${encodeURIComponent(eventId)}`).then(setHardSubmissions).catch(() => setHardSubmissions([]));
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
  return <section className="panel admin-detail-card">
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
    <div className="linked-events"><strong>关联训战</strong>{events.filter((event) => challenge.versions.some((version) => version.id === event.challengeVersion)).map((event) => <span key={event.id}>{challenge.versions.find((version) => version.id === event.challengeVersion)?.title ?? '训战'} · {statusLabel(event.status)}</span>)}{challenge.board?.type === 'HARD_PROBLEM' && challenge.board.submissionEventId && <span>独立难题交付入口</span>}{!events.some((event) => challenge.versions.some((version) => version.id === event.challengeVersion)) && challenge.board?.type !== 'HARD_PROBLEM' && <small>暂无关联训战</small>}</div>
  </section>;
}

function CapabilityAdminSection({ data, users, orgUnits, orgPath, selectedIds, onOrgPathChange, onToggle, onSelectAll, onClear, onViewAll, onViewSelected, busy }: {
  data: AdminCapabilityBundle | null;
  users: AdminUser[];
  orgUnits: OrgUnit[];
  orgPath: string;
  selectedIds: string[];
  onOrgPathChange: (path: string) => void;
  onToggle: (subjectId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onViewAll: () => void;
  onViewSelected: () => void;
  busy: boolean;
}) {
  const selectedSet = new Set(selectedIds);
  const orgName = (path: string | null) => path ? (orgUnits.find((unit) => unit.path === path)?.name ?? path) : '全组织';
  const domainStatus = (percent: number | null) => percent === null ? '待评估' : percent >= 85 ? '优势' : percent >= 60 ? '稳定' : '待提升';
  const profilePageSize = 10;
  const [profilePage, setProfilePage] = useState(1);
  const profileCount = data?.profiles.length ?? 0;
  const profileTotalPages = Math.max(1, Math.ceil(profileCount / profilePageSize));
  const profilePageStart = Math.max(1, Math.min(profilePage - 2, profileTotalPages - 4));
  const profilePageNumbers = Array.from({ length: Math.min(5, profileTotalPages) }, (_, index) => profilePageStart + index);
  const visibleProfiles = data?.profiles.slice((profilePage - 1) * profilePageSize, profilePage * profilePageSize) ?? [];
  const profilePlaceholderCount = profileTotalPages > 1 ? Math.max(0, profilePageSize - visibleProfiles.length) : 0;
  useEffect(() => { setProfilePage(1); }, [data?.generatedAt]);
  useEffect(() => { setProfilePage((current) => Math.min(current, profileTotalPages)); }, [profileTotalPages]);
  return <section className="admin-section capability-admin-section">
    <div className="admin-section-heading"><div><p className="kicker">人员分析</p><h2>AI 能力画像</h2></div><span className="last-sync">{data ? `更新于 ${formatDate(data.generatedAt)}` : '加载中…'}</span></div>
    <section className="panel capability-admin-filter">
      <div className="capability-admin-filter-head"><div><strong>选择画像范围</strong><small>部门范围与参训人员</small></div><span className="status-pill">当前已选 {selectedIds.length} 人</span></div>
      <div className="capability-admin-filter-controls"><label>部门<select value={orgPath} onChange={(event) => onOrgPathChange(event.target.value)}><option value="">全组织（所有部门）</option>{orgUnits.filter((unit) => unit.path !== '/').sort((a, b) => a.path.localeCompare(b.path)).map((unit) => <option key={unit.id} value={unit.path}>{'　'.repeat(Math.max(0, unit.level - 1))}{unit.name}</option>)}</select></label><div className="capability-admin-actions"><button className="quiet" onClick={onSelectAll} disabled={busy || !users.length}>选择当前范围全部</button><button className="quiet" onClick={onClear} disabled={busy || !selectedIds.length}>清除选择</button><button className="primary compact" onClick={onViewAll} disabled={busy}>{busy ? '加载中…' : `查看${orgName(orgPath)}整体`}</button><button className="primary compact" onClick={onViewSelected} disabled={busy || !selectedIds.length}>查看所选 {selectedIds.length} 人</button></div></div>
      <div className="capability-user-picker">{users.map((user) => <label className="capability-user-check" key={user.id}><input type="checkbox" checked={selectedSet.has(user.id)} onChange={() => onToggle(user.id)} /><span><strong>{displayPersonName(user.name)}</strong><small>{user.employeeNo} · {orgName(user.orgPath)}</small></span></label>)}{!users.length && <div className="empty compact-empty">暂无在职员工</div>}</div>
    </section>
    {!data ? <div className="panel empty">能力画像加载中…</div> : <>
      <div className="admin-stat-grid capability-admin-stats"><AdminStat label="统计人数" value={data.selectedCount} hint={`${data.totalCandidates} 名范围内员工`} tone="blue" /><AdminStat label="已完成评估" value={data.gradedUsers} hint="完成过至少一场已公布评估" tone="green" /><AdminStat label="综合平均分" value={data.aggregate.overallAverage ?? '—'} hint={data.selection.mode === 'ALL' ? `${orgName(data.selection.orgPath)}整体` : '当前选定人员'} tone="violet" /><AdminStat label="综合中位数" value={data.aggregate.overallMedian ?? '—'} hint="按员工综合成绩计算" tone="orange" /><AdminStat label="综合百分位" value={data.aggregate.overallPercentile === null || data.aggregate.overallPercentile === undefined ? '—' : `${data.aggregate.overallPercentile}%`} hint="当前群体成绩分布" tone="orange" /></div>
      <section className="panel capability-admin-aggregate"><div className="admin-card-heading"><div><p className="kicker">群体画像</p><h3>{data.selection.mode === 'ALL' ? `${orgName(data.selection.orgPath)}能力画像` : '选定人员能力画像'}</h3><small className="capability-admin-average-note">平均值、中位数和百分位均按在职员工的有效评估记录计算。</small></div><span className="dot-label">{data.selectedCount} 人</span></div><div className="capability-admin-aggregate-grid">{data.aggregate.dimensions.map((dimension) => <div className="capability-admin-aggregate-row" key={dimension.key}><div><strong>{dimension.label}</strong><small>{dimension.evaluatedUsers} 人 · 中位数 {dimension.median ?? '—'} · {dimension.percentile ?? '—'} 百分位</small></div><i><span style={{ width: `${dimension.percent ?? 0}%` }} /></i><b>{dimension.percent === null ? '—' : dimension.percent}</b></div>)}</div><div className="capability-admin-domain-grid">{data.aggregate.domains.map((domain) => <div className="capability-admin-domain" key={domain.key}><div><strong>{domain.label}</strong><small>{domain.evaluatedUsers} 人 · 中位数 {domain.median ?? '—'}</small></div><b>{domain.percent === null ? '—' : domain.percent}</b><span><i style={{ width: `${domain.percent ?? 0}%` }} /></span></div>)}</div><div className="capability-admin-skill-average"><div className="mini-heading"><div><p className="kicker">16 项评分点</p><h3>评分点画像</h3></div><span>均值 / 中位数</span></div><div className="capability-admin-skill-grid">{data.aggregate.skills.map((skill) => <div className="capability-admin-skill-average-cell" key={skill.key}><strong>{skill.key}</strong><span>{skill.label}</span><b>{skill.percent === null ? '—' : skill.percent}</b><small>{skill.evaluatedUsers} 人 · 中位数 {skill.median ?? '—'}</small></div>)}</div></div></section>
       {data.profiles.length > 0 && <><div className="capability-admin-detail-title"><div><p className="kicker">个人画像</p><h3>{data.selection.mode === 'ALL' ? `${orgName(data.selection.orgPath)}个人画像` : '所选人员个人画像'}</h3></div></div><div className="capability-admin-profile-list">{visibleProfiles.map(({ subject, profile }) => { const personName = displayPersonName(subject.name); return <article className="panel capability-admin-person" key={subject.id}><div className="capability-admin-person-head"><div className="capability-admin-avatar">{personName.slice(0, 1)}</div><div><strong>{personName}</strong><small>{subject.employeeNo} · {orgName(subject.orgPath)}</small></div><div className="capability-admin-person-score"><b>{profile.summary.overallAverage ?? '—'}</b><span>{profile.summary.gradedSubmissions} 场</span></div></div><div className="capability-admin-person-dimensions">{profile.dimensions.map((dimension) => <div key={dimension.key}><span>{dimension.label}</span><i><b style={{ width: `${dimension.percent ?? 0}%` }} /></i><strong>{dimension.percent === null ? '—' : dimension.percent}</strong></div>)}</div><div className="capability-admin-person-domains">{profile.domains.map((domain) => <div key={domain.key}><span title={domain.label}>{domain.shortLabel ?? domain.label}</span><i><b style={{ width: `${domain.percent ?? 0}%` }} /></i><strong>{domain.percent === null ? '—' : domain.percent}</strong></div>)}</div><div className="capability-admin-skills">{profile.skills.map((skill) => <span className={`admin-skill admin-skill-${(skill.averageLevel ?? 'n').toLowerCase()}`} key={skill.criterionKey} title={skill.name}>{skill.criterionKey}<b>{skill.averageLevel ?? '—'}</b></span>)}</div></article>; })}{Array.from({ length: profilePlaceholderCount }, (_, index) => <article className="panel capability-admin-person capability-admin-person-placeholder" key={`profile-placeholder-${index}`} aria-hidden="true" />)}</div><div className="table-pagination capability-profile-pagination"><span>第 {profilePage} / {profileTotalPages} 页 · 共 {profileCount} 人</span><div><button className="small" disabled={profilePage <= 1} onClick={() => setProfilePage((current) => Math.max(1, current - 1))}>上一页</button>{profilePageNumbers.map((number) => <button className={`small page-number${profilePage === number ? ' active' : ''}`} key={number} onClick={() => setProfilePage(number)}>{number}</button>)}<button className="small" disabled={profilePage >= profileTotalPages} onClick={() => setProfilePage((current) => Math.min(profileTotalPages, current + 1))}>下一页</button></div></div></>}
    </>}
  </section>;
}

function ChallengeEditorLegacy({ form, setForm, onCancel, onSave, busy, title }: { form: ChallengeDraft; setForm: (form: ChallengeDraft) => void; onCancel: () => void; onSave: () => void; busy: boolean; title: string }) {
  const update = <K extends keyof ChallengeDraft>(key: K, value: ChallengeDraft[K]) => setForm({ ...form, [key]: value });
  return <section className="panel admin-editor"><div className="admin-card-heading"><div><p className="kicker">草稿编辑</p><h3>{title}</h3></div><button className="quiet" onClick={onCancel}>取消</button></div><div className="form-grid"><label>赛题 ID<input value={form.id} onChange={(event) => update('id', event.target.value)} disabled={title !== '创建赛题草稿'} /></label><label>赛题标题<input value={form.title} onChange={(event) => update('title', event.target.value)} /></label><label>分区<select value={form.zone} onChange={(event) => update('zone', event.target.value as ChallengeDraft['zone'])}><option value="YELLOW">黄区</option><option value="BLUE">蓝区</option></select></label><label>预计用时（分钟）<input type="number" min="1" value={form.estimatedMinutes} onChange={(event) => update('estimatedMinutes', event.target.value)} /></label><label className="span-2">赛题介绍<textarea value={form.description} onChange={(event) => update('description', event.target.value)} rows={3} /></label><label>训战目标<textarea value={form.objectives} onChange={(event) => update('objectives', event.target.value)} rows={4} /></label><label>赛题要求<textarea value={form.requirements} onChange={(event) => update('requirements', event.target.value)} rows={4} /></label><label>约束与评估<textarea value={form.constraints} onChange={(event) => update('constraints', event.target.value)} rows={4} /></label><label>交付件<textarea value={form.deliverables} onChange={(event) => update('deliverables', event.target.value)} rows={4} /></label><label>标签<textarea value={form.tags} onChange={(event) => update('tags', event.target.value)} rows={3} /></label><label>支持的编程语言<textarea value={form.languages} onChange={(event) => update('languages', event.target.value)} rows={3} /></label></div><div className="delivery-policy-editor"><div><strong>提交方式</strong><small>配置员工可用的提交方式。</small></div><label className="check-label"><input type="checkbox" checked={form.allowUpload} onChange={(event) => update('allowUpload', event.target.checked)} /> 上传 ZIP</label><label className="check-label"><input type="checkbox" checked={form.allowGit} onChange={(event) => update('allowGit', event.target.checked)} /> Git 仓库路径</label>{form.allowGit && <><label>Git 仓库路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label></>}<label>评分标准版本<input value={form.rubricVersion} onChange={(event) => update('rubricVersion', event.target.value)} /></label></div><div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存草稿'}</button></div></section>;
}

function RichTextEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Range | null>(null);
  useEffect(() => {
    const sanitized = sanitizeRichText(value);
    if (editorRef.current && editorRef.current.innerHTML !== sanitized) editorRef.current.innerHTML = sanitized;
  }, [value]);

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selectionRef.current = selection.getRangeAt(0).cloneRange();
  };

  const restoreSelection = () => {
    const selection = window.getSelection();
    if (!selection || !selectionRef.current) return;
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
  const preventToolbarFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  return <div className="rich-editor">
    <div className="rich-editor-toolbar" role="toolbar" aria-label="赛题详情格式工具栏">
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('bold')} title="加粗"><strong>B</strong></button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('italic')} title="斜体"><em>I</em></button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('formatBlock', '<h3>')} title="小标题">H3</button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('insertUnorderedList')} title="无序列表">• 列表</button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('insertOrderedList')} title="有序列表">1. 列表</button>
      <span className="rich-editor-divider" />
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('undo')} title="撤销">撤销</button>
      <button type="button" onMouseDown={preventToolbarFocus} onClick={toolbarCommand('redo')} title="重做">重做</button>
    </div>
    <div ref={editorRef} className="rich-editor-surface" contentEditable role="textbox" aria-multiline="true" suppressContentEditableWarning onInput={(event) => { onChange(sanitizeRichText(event.currentTarget.innerHTML)); rememberSelection(); }} onKeyUp={rememberSelection} onMouseUp={rememberSelection} />
  </div>;
}

function ChallengeEditor({ form, setForm, onCancel, onSave, onUploadPackage, busy, title }: { form: ChallengeDraft; setForm: (form: ChallengeDraft) => void; onCancel: () => void; onSave: () => void; onUploadPackage: (file: File) => Promise<void>; busy: boolean; title: string }) {
  const update = <K extends keyof ChallengeDraft>(key: K, value: ChallengeDraft[K]) => setForm({ ...form, [key]: value });
  const creatingChallenge = title === '创建赛题草稿';
  return <section className="panel admin-editor">
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
      <label>约束与评估<textarea value={form.constraints} onChange={(event) => update('constraints', event.target.value)} rows={4} /></label>
      <label>交付件<textarea value={form.deliverables} onChange={(event) => update('deliverables', event.target.value)} rows={4} /></label>
      <label>标签<textarea value={form.tags} onChange={(event) => update('tags', event.target.value)} rows={3} /></label>
      <label>支持的编程语言<textarea value={form.languages} onChange={(event) => update('languages', event.target.value)} rows={3} /></label>
    </div>
     <div className="delivery-policy-editor"><div><strong>提交方式</strong><small>配置员工可用的提交方式。</small></div><label className="check-label"><input type="checkbox" checked={form.allowUpload} onChange={(event) => update('allowUpload', event.target.checked)} /> 上传 ZIP</label><label className="check-label"><input type="checkbox" checked={form.allowGit} onChange={(event) => update('allowGit', event.target.checked)} /> Git 仓库路径</label>{form.allowGit && <><label>Git 仓库路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label></>}<label>评分标准版本<input value={form.rubricVersion} onChange={(event) => update('rubricVersion', event.target.value)} /></label></div>
     <div className="evaluation-engine-editor"><div><strong>评测引擎</strong><small>每个赛题版本独立配置评测引擎，管理员按输入契约执行并上传标准结果。</small></div><div className="form-grid"><label>引擎标识<input value={form.evaluationEngineId} onChange={(event) => update('evaluationEngineId', event.target.value)} placeholder="例如 parking-fee-evaluator" /></label><label>引擎版本<input value={form.evaluationEngineVersion} onChange={(event) => update('evaluationEngineVersion', event.target.value)} /></label><label>执行方式<select value={form.evaluationEngineMode} onChange={(event) => update('evaluationEngineMode', event.target.value as ChallengeDraft['evaluationEngineMode'])}><option value="EXTERNAL_CLI">管理员本地命令（线下录入）</option><option value="PLATFORM_LOCAL">平台内置执行器</option><option value="PACKAGED">上传评测引擎包</option></select></label><label>输入契约路径<input value={form.evaluationInputContract} onChange={(event) => update('evaluationInputContract', event.target.value)} /></label><label className="span-2">输出契约路径<input value={form.evaluationOutputContract} onChange={(event) => update('evaluationOutputContract', event.target.value)} /></label>{form.evaluationEngineMode === 'PACKAGED' && <label className="span-2">评测引擎包<span className="field-hint">zip：engine.json + 判题脚本 + 隐藏测试 + 提交契约</span><input type="file" accept=".zip" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onUploadPackage(file); event.target.value = ''; }} />{form.enginePackageSummary ? <small className="engine-package-summary">已绑定：{form.enginePackageSummary}</small> : <small className="field-hint">上传后平台会校验 engine.json 并按内容哈希固化；引擎包变更等于判据变更，历史成绩需要重跑。</small>}</label>}{form.evaluationEngineMode === 'PLATFORM_LOCAL' && <><label>提交契约路径<span className="field-hint">仓库内相对路径</span><input value={form.localContractPath} onChange={(event) => update('localContractPath', event.target.value)} placeholder="challenges/xxx/submission-contract.json" /></label><label>隐藏测试目录<span className="field-hint">可留空</span><input value={form.localTestsDir} onChange={(event) => update('localTestsDir', event.target.value)} placeholder="challenges/xxx/hidden-tests" /></label><label>入口文件<input value={form.localEntry} onChange={(event) => update('localEntry', event.target.value)} placeholder="src/parking.py" /></label><label>入口函数<input value={form.localFunction} onChange={(event) => update('localFunction', event.target.value)} placeholder="calculate_fee" /></label><label>语言<input value={form.localLanguage} onChange={(event) => update('localLanguage', event.target.value)} /></label></>}</div><small className="field-hint">选择「平台本地执行器」后，训战可使用自动评估或管理员安排；选择「管理员本地命令」的赛题只能使用线下结果录入。</small></div>
    <div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存草稿'}</button></div>
  </section>;
}

function ParticipantSection({ events, eventId, setEventId, text, setText, onLoad, onSave, busy }: { events: EventConfig[]; eventId: string; setEventId: (value: string) => void; text: string; setText: (value: string) => void; onLoad: (eventId: string) => void; onSave: () => void; busy: boolean }) {
  const selected = events.find((event) => event.id === eventId);
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">参训名单</p><h2>参训名单</h2></div></div><section className="panel admin-card participant-editor"><div className="form-grid"><label>训战<select value={eventId} onChange={(event) => setEventId(event.target.value)}>{events.map((item) => <option key={item.id} value={item.id}>{item.id} · {statusLabel(item.status)}</option>)}</select></label><label>当前访问模式<input value={selected?.accessPolicy?.mode === 'RESTRICTED' ? '定向访问' : participantModeLabel(selected?.participantMode)} readOnly /></label></div><label>员工工号<textarea value={text} onChange={(event) => setText(event.target.value)} rows={12} /></label><div className="editor-actions"><button className="secondary-button" disabled={!eventId || busy} onClick={() => onLoad(eventId)}>加载名单</button><button className="primary compact" disabled={!eventId || busy} onClick={onSave}>保存名单</button></div></section></section>;
}

function EventsSectionLegacy({ events, challenges, overview, eventForm, setEventForm, onCreate, onAction, busy }: { events: EventConfig[]; challenges: Challenge[]; overview: Overview | null; eventForm: EventDraft | null; setEventForm: (form: EventDraft | null) => void; onCreate: () => void; onAction: (event: EventConfig, action: 'start-grading' | 'execute-local' | 'close' | 'reveal') => void; busy: boolean }) {
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">场次编排</p><h2>场次编排</h2></div><button className="primary compact" onClick={() => setEventForm(blankEvent(challenges.flatMap((challenge) => challenge.versions).find((version) => version.status === 'PUBLISHED')?.id ?? '', challenges))}>＋ 新建场次</button></div>{eventForm && <EventEditorLegacy form={eventForm} setForm={setEventForm} challenges={challenges} onCancel={() => setEventForm(null)} onSave={onCreate} busy={busy} />}{!eventForm && <div className="event-admin-list">{events.map((event) => { const stat = overview?.eventStats.find((item) => item.eventId === event.id); return <article className="panel event-admin-card" key={event.id}><div className="event-admin-main"><div className="event-badge">{event.submissionSource === 'GIT_REF' ? '⌘' : '↑'}</div><div><div className="event-admin-title"><strong>{versionTitle(event.challengeVersion, challenges)}</strong><span className={`status-badge status-${event.status.toLowerCase()}`}>{statusLabel(event.status)}</span></div><small>{modeLabel(event.mode)} · {sourceLabel(event.submissionSource)} · {triggerLabel(event.trigger)} · {revealLabel(event.reveal)}</small><div className="event-admin-meta"><span>{stat?.submissionCount ?? 0} 份提交</span><span>{stat?.pendingCount ?? 0} 待处理</span>{event.deliveryConfig?.repository && <span>{event.deliveryConfig.repository}</span>}</div></div></div><div className="event-admin-actions">{event.status === 'OPEN' && event.trigger === 'MANUAL' && <button className="small" disabled={busy} onClick={() => onAction(event, 'start-grading')}>批量安排评估</button>}{event.status === 'OPEN' && <button className="small" disabled={busy} onClick={() => onAction(event, 'execute-local')}>执行评估</button>}{event.status === 'OPEN' && <button className="small danger" disabled={busy} onClick={() => onAction(event, 'close')}>结束场次</button>}{event.status === 'CLOSED' && <button className="small" disabled={busy} onClick={() => onAction(event, 'reveal')}>公布结果</button>}</div></article>; })}{!events.length && <div className="panel empty">暂无场次</div>}</div>}</section>;
}

function EventEditorLegacy({ form, setForm, challenges, onCancel, onSave, busy }: { form: EventDraft; setForm: (form: EventDraft | null) => void; challenges: Challenge[]; onCancel: () => void; onSave: () => void; busy: boolean }) {
  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setForm({ ...form, [key]: value });
  const versions = challenges.flatMap((challenge) => challenge.versions.filter((version) => version.status === 'PUBLISHED'));
  return <section className="panel admin-editor"><div className="admin-card-heading"><div><p className="kicker">场次草稿</p><h3>创建训战场次</h3></div><button className="quiet" onClick={onCancel}>取消</button></div><div className="form-grid"><label>场次 ID<input value={form.id} onChange={(event) => update('id', event.target.value)} /></label><label>赛题版本<select value={form.challengeVersion} onChange={(event) => { const challengeVersion = event.target.value; setForm({ ...form, challengeVersion, trigger: engineSupportsPlatformExecution(challengeVersion, challenges) ? form.trigger : 'IMPORT' }); }}>{versions.map((version) => <option key={version.id} value={version.id}>{version.title} · v{version.version}</option>)}</select></label><label>提交方式<select value={form.submissionSource} onChange={(event) => update('submissionSource', event.target.value as Source)}><option value="UPLOAD">上传 ZIP</option><option value="GIT_REF">Git 仓库路径</option></select></label><label>评测方式<select value={form.trigger} onChange={(event) => { const trigger = event.target.value as Trigger; setForm({ ...form, trigger, pinAt: trigger === 'AUTO' ? 'SUBMIT' : form.pinAt }); }}>{engineSupportsPlatformExecution(form.challengeVersion, challenges) && <><option value="AUTO">自动评测</option><option value="MANUAL">手动触发</option></>}<option value="IMPORT">线下评测</option></select>{!engineSupportsPlatformExecution(form.challengeVersion, challenges) && <small className="field-hint">该赛题的评测引擎为管理员本地命令，只能使用线下结果录入。</small>}</label><label>结果公布<select value={form.reveal} onChange={(event) => update('reveal', event.target.value as EventDraft['reveal'])}><option value="IMMEDIATE">评测后公布</option><option value="ON_RELEASE">公布后可见</option></select></label><label>场次类型<select value={form.mode} onChange={(event) => update('mode', event.target.value as EventDraft['mode'])}><option value="WINDOW">开放窗口</option><option value="LIVE">集中训战</option></select></label><label>开始时间<input type="datetime-local" value={form.startsAt} onChange={(event) => update('startsAt', event.target.value)} /></label><label>结束时间<input type="datetime-local" value={form.endsAt} onChange={(event) => update('endsAt', event.target.value)} /></label>{form.submissionSource === 'GIT_REF' && <><label>Git 仓库路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label><label>Git 版本固定时点<select value={form.pinAt} disabled={form.trigger === 'AUTO'} onChange={(event) => update('pinAt', event.target.value as EventDraft['pinAt'])}><option value="SUBMIT">提交时锁定</option><option value="DEADLINE">截止时锁定</option></select><small className="field-hint">自动评测在提交时锁定版本。</small></label></>}</div><div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy || !versions.length} onClick={onSave}>{busy ? '创建中…' : '创建场次'}</button></div></section>;
}

function EventsSection({ events, challenges, overview, users, orgUnits, eventForm, setEventForm, eventEditId, onNew, onEdit, onCreate, onAction, busy }: { events: EventConfig[]; challenges: Challenge[]; overview: Overview | null; users: AdminUser[]; orgUnits: OrgUnit[]; eventForm: EventDraft | null; setEventForm: (form: EventDraft | null) => void; eventEditId: string; onNew: () => void; onEdit: (event: EventConfig) => void; onCreate: () => void; onAction: (event: EventConfig, action: 'start-grading' | 'execute-local' | 'close' | 'reveal') => void; busy: boolean }) {
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">训战管理</p><h2>训战管理</h2></div><button className="primary compact" onClick={onNew}>＋ 新建训战</button></div>{eventForm && <EventEditor form={eventForm} setForm={setEventForm} challenges={challenges} users={users} orgUnits={orgUnits} editing={Boolean(eventEditId)} onCancel={() => setEventForm(null)} onSave={onCreate} busy={busy} />}{!eventForm && <div className="event-admin-list">{events.map((event) => { const stat = overview?.eventStats.find((item) => item.eventId === event.id); return <article className="panel event-admin-card" key={event.id}><div className="event-admin-main"><div className="event-badge">{event.submissionSource === 'GIT_REF' ? '⌘' : '↑'}</div><div><div className="event-admin-title"><strong>{versionTitle(event.challengeVersion, challenges)}</strong><span className={`status-badge status-${event.status.toLowerCase()}`}>{statusLabel(event.status)}</span></div><small>{modeLabel(event.mode)} · {sourceLabel(event.submissionSource)} · {triggerLabel(event.trigger)} · {revealLabel(event.reveal)}</small><div className="event-admin-schedule"><strong>开放时间</strong><span>{eventScheduleLabel(event)}</span></div><div className="event-admin-meta"><span>{accessScopeLabel(event)}</span><span>{stat?.submissionCount ?? 0} 份提交</span><span>{stat?.pendingCount ?? 0} 待处理</span>{event.deliveryConfig?.repository && <span>{event.deliveryConfig.repository}</span>}</div></div></div><div className="event-admin-actions">{event.status !== 'RELEASED' && <button className="small" disabled={busy} onClick={() => onEdit(event)}>配置训战</button>}{event.status === 'OPEN' && (event.trigger === 'MANUAL' || event.trigger === 'IMPORT') && <button className="small" disabled={busy} onClick={() => onAction(event, 'start-grading')}>选择评测提交</button>}{event.status === 'OPEN' && <button className="small danger" disabled={busy} onClick={() => onAction(event, 'close')}>结束训战</button>}{event.status === 'CLOSED' && <button className="small" disabled={busy} onClick={() => onAction(event, 'reveal')}>公布结果</button>}</div></article>; })}{!events.length && <div className="panel empty">暂无训战</div>}</div>}</section>;
}

function EventEditor({ form, setForm, challenges, users, orgUnits, editing, onCancel, onSave, busy }: { form: EventDraft; setForm: (form: EventDraft | null) => void; challenges: Challenge[]; users: AdminUser[]; orgUnits: OrgUnit[]; editing: boolean; onCancel: () => void; onSave: () => void; busy: boolean }) {
  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setForm({ ...form, [key]: value });
  const versions = challenges.flatMap((challenge) => challenge.versions.filter((version) => version.status === 'PUBLISHED'));
  const departments = orgUnits.filter((unit) => unit.id !== 'org-root').sort((a, b) => a.path.localeCompare(b.path));
  const mentors = users.filter((user) => user.status === 'ACTIVE' && user.roles.includes('mentor')).sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
  const selectMany = (field: 'departmentIds' | 'mentorIds', event: ChangeEvent<HTMLSelectElement>) => update(field, [...event.target.selectedOptions].map((option) => option.value));
  return <section className="panel admin-editor"><div className="admin-card-heading"><div><p className="kicker">训战配置</p><h3>{editing ? '编辑训战' : '创建训战'}</h3><small>训战开放时间、交付方式和访问范围。</small></div><button className="quiet" onClick={onCancel}>取消</button></div><div className="form-grid"><label>训战 ID<input value={form.id} onChange={(event) => update('id', event.target.value)} disabled={editing} /></label><label>赛题版本<select value={form.challengeVersion} onChange={(event) => { const challengeVersion = event.target.value; setForm({ ...form, challengeVersion, trigger: engineSupportsPlatformExecution(challengeVersion, challenges) ? form.trigger : 'IMPORT' }); }}>{versions.map((version) => <option key={version.id} value={version.id}>{version.title} · v{version.version}</option>)}</select></label><label>提交方式<select value={form.submissionSource} onChange={(event) => update('submissionSource', event.target.value as Source)}><option value="UPLOAD">上传交付件</option><option value="GIT_REF">指定 Git 仓路径</option></select></label><label>评测方式<select value={form.trigger} onChange={(event) => { const trigger = event.target.value as Trigger; setForm({ ...form, trigger, pinAt: trigger === 'AUTO' ? 'SUBMIT' : form.pinAt }); }}>{engineSupportsPlatformExecution(form.challengeVersion, challenges) && <><option value="AUTO">自动评测</option><option value="MANUAL">手动触发</option></>}<option value="IMPORT">线下评测</option></select>{!engineSupportsPlatformExecution(form.challengeVersion, challenges) && <small className="field-hint">该赛题的评测引擎为管理员本地命令，只能使用线下结果录入。</small>}</label><label>结果公布<select value={form.reveal} onChange={(event) => update('reveal', event.target.value as EventDraft['reveal'])}><option value="IMMEDIATE">评测后公布</option><option value="ON_RELEASE">公布后可见</option></select></label><label>训战类型<select value={form.mode} onChange={(event) => update('mode', event.target.value as EventDraft['mode'])}><option value="WINDOW">开放窗口</option><option value="LIVE">集中训战</option></select></label></div><div className="event-time-config"><div><strong>训战开放时间</strong><span>员工可在该时间窗口内提交交付件。</span></div><div className="form-grid"><label>开始时间 <input required type="datetime-local" value={form.startsAt} onChange={(event) => update('startsAt', event.target.value)} /></label><label>结束时间 <input required type="datetime-local" value={form.endsAt} onChange={(event) => update('endsAt', event.target.value)} /></label></div><small className="field-hint">时间按本地时区保存。</small></div><section className="event-access-config"><div><strong>训战访问范围</strong><span>配置可进入该训战的人员范围。</span></div><div className="form-grid"><label>访问模式<select value={form.accessMode} onChange={(event) => update('accessMode', event.target.value as EventDraft['accessMode'])}><option value="OPEN">全员可见（组织范围内）</option><option value="RESTRICTED">定向访问</option></select></label>{form.accessMode === 'RESTRICTED' && <><label>目标部门<span className="field-hint">可多选</span><select multiple value={form.departmentIds} onChange={(event) => selectMany('departmentIds', event)}>{departments.map((unit) => <option key={unit.id} value={unit.id}>{'　'.repeat(Math.max(0, unit.level - 1))}{unit.name}</option>)}</select></label><label>指定导师（可选）<span className="field-hint">未指定时对全部导师开放</span><select multiple value={form.mentorIds} onChange={(event) => selectMany('mentorIds', event)}>{mentors.map((user) => <option key={user.id} value={user.id}>{displayPersonName(user.name)} · {user.employeeNo}</option>)}</select></label></>}</div><small className="event-access-help">员工、部门或导师任一范围匹配即可进入。</small></section><div className="form-grid">{form.submissionSource === 'GIT_REF' && <><label>Git 仓路径<input value={form.repository} onChange={(event) => update('repository', event.target.value)} /><small className="field-hint">GitLab 项目路径。</small></label><label>分支模板<input value={form.branchTemplate} onChange={(event) => update('branchTemplate', event.target.value)} /></label><label>Git 版本固定时点<select value={form.pinAt} disabled={form.trigger === 'AUTO'} onChange={(event) => update('pinAt', event.target.value as EventDraft['pinAt'])}><option value="SUBMIT">提交时锁定</option><option value="DEADLINE">截止时锁定</option></select><small className="field-hint">自动评测在提交时锁定版本。</small></label></>}</div><div className="editor-actions"><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary compact" disabled={busy || !versions.length} onClick={onSave}>{busy ? '保存中…' : editing ? '保存训战配置' : '创建训战'}</button></div></section>;
}

function GradingSection({ submissions, events, challenges, users, queue, selectedIds, inputText, importText, setInputText, setImportText, onToggle, onSelectEvent, onClearEvent, onPrepareInput, onStartSelected, onExecuteSelected, onSubmission, onRegrade, onDownload, onImport, busy }: {
  submissions: Submission[];
  events: EventConfig[];
  challenges: Challenge[];
  users: AdminUser[];
  queue: QueueStats | null;
  selectedIds: string[];
  inputText: string;
  importText: string;
  setInputText: (text: string) => void;
  setImportText: (text: string) => void;
  onToggle: (submissionId: string) => void;
  onSelectEvent: (eventId: string) => void;
  onClearEvent: (eventId: string) => void;
  onPrepareInput: (eventId: string) => void;
  onStartSelected: (eventId: string) => void;
  onExecuteSelected: (eventId: string) => void;
  onSubmission: (submission: Submission, action: 'trigger' | 'execute') => void;
  onRegrade: (submission: Submission) => void;
  onDownload: (submission: Submission) => void;
  onImport: () => void;
  busy: boolean;
}) {
  const [selectedEventId, setSelectedEventId] = useState('');
  const [expandedSubmissionId, setExpandedSubmissionId] = useState('');
  const selectedSet = new Set(selectedIds);
  const groups = events.map((event) => ({ event, rows: submissions.filter((submission) => submission.eventId === event.id) }));
  const selectedGroup = groups.find((group) => group.event.id === selectedEventId);
  const copyInput = () => { if (inputText) void navigator.clipboard?.writeText(inputText); };
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
    const canExecute = event.trigger !== 'IMPORT' && rows.some((row) => row.gradingRunId && !row.resultId);
    return <>
      <div className="grading-detail-back"><button className="quiet" onClick={() => { setSelectedEventId(''); setExpandedSubmissionId(''); }}>← 返回评测列表</button></div>
      <section className="panel admin-card grading-event-detail">
        <div className="grading-detail-heading"><div><p className="kicker">赛题评测</p><h3>{versionTitle(event.challengeVersion, challenges)}</h3><small>{event.id} · {eventScheduleLabel(event)}</small></div><span className={`status-badge status-${event.status.toLowerCase()}`}>{statusLabel(event.status)}</span></div>
        <div className="grading-detail-facts"><span>赛制：{modeLabel(event.mode)}</span><span>提交：{sourceLabel(event.submissionSource)}</span><span>评测：{event.trigger === 'IMPORT' ? '线下评测' : '线上评测'}</span><span>{rows.length} 份提交</span></div>
        <div className="grading-event-actions"><button className="quiet" disabled={busy || !rows.length} onClick={() => onSelectEvent(event.id)}>全选</button><button className="quiet" disabled={busy || !selectedCount} onClick={() => onClearEvent(event.id)}>清除</button>{event.trigger === 'MANUAL' && <button className="primary compact" disabled={busy || !selectedActionCount} onClick={() => onStartSelected(event.id)}>线上评测选中提交</button>}{event.trigger === 'IMPORT' && <button className="primary compact" disabled={busy || !selectedActionCount} onClick={() => onPrepareInput(event.id)}>生成线下评测清单</button>}{canExecute && <button className="small" disabled={busy || !selectedActionCount} onClick={() => onExecuteSelected(event.id)}>执行选中评测</button>}<span className="grading-selected-count">已选 {selectedCount}/{rows.length}</span></div>
        <div className="grading-submission-list">{rows.map((submission) => { const subject = subjectFor(submission); const expanded = expandedSubmissionId === submission.id; return <div className="grading-submission-block" key={submission.id}><div className="grading-row"><label className="grading-check"><input type="checkbox" checked={selectedSet.has(submission.id)} onChange={() => onToggle(submission.id)} /><span className="grading-avatar">{(subject?.name ?? submission.subjectId).slice(-2)}</span></label><div><strong>{displayPersonName(subject?.name ?? submission.subjectId)}</strong><small>{subject?.employeeNo ?? submission.subjectId} · {sourceLabel(submission.snapshot.sourceType)} · {submissionDate(submission)}</small></div><span className={`status-badge status-${submission.state.toLowerCase()}`}>{statusText(submission)}</span><div className="row-actions"><button className="small" onClick={() => setExpandedSubmissionId(expanded ? '' : submission.id)}>{expanded ? '收起详情' : '查看提交'}</button>{submission.snapshot.artifactUri && <button className="small" disabled={busy} onClick={() => onDownload(submission)}>下载交付件</button>}{submission.resultId && <button className="small" disabled={busy} onClick={() => onRegrade(submission)}>重新评测</button>}{['WAITING_TRIGGER', 'RECEIVED', 'FAILED'].includes(submission.state) && event.trigger === 'MANUAL' && <button className="small" disabled={busy} onClick={() => onSubmission(submission, 'trigger')}>线上评测</button>}{submission.gradingRunId && !submission.resultId && ['QUEUED', 'RUNNING', 'FAILED'].includes(submission.state) && event.trigger !== 'IMPORT' && <button className="small" disabled={busy} onClick={() => onSubmission(submission, 'execute')}>执行线上评测</button>}</div></div>{expanded && renderSubmissionDetails(submission)}</div>; })}{!rows.length && <div className="empty">暂无提交记录</div>}</div>
      </section>
    </>;
  };
  return <section className="admin-section">
    <div className="admin-section-heading"><div><p className="kicker">评测中心</p><h2>评测中心</h2></div><div className="grading-queue-summary"><span className="status-pill">{submissions.filter((row) => !row.resultId).length} 条待处理</span>{queue && <small>评测队列：进行中 {queue.running}/{queue.maxConcurrency} · 等待 {queue.queued}</small>}</div></div>
    <div className="admin-grading-grid">
      <section className="panel admin-card grading-selection-card">{selectedGroup ? renderEventDetail(selectedGroup) : <><div className="admin-card-heading"><div><p className="kicker">训战列表</p><h3>选择赛题</h3><small>打开单个训战，查看提交内容并处理评测。</small></div></div><div className="grading-event-catalog">{groups.map(({ event, rows }) => { const pending = rows.filter((row) => !row.resultId).length; const completed = rows.length - pending; return <button type="button" className="grading-event-card" key={event.id} onClick={() => { setSelectedEventId(event.id); setExpandedSubmissionId(''); }}><span className="grading-event-card-main"><strong>{versionTitle(event.challengeVersion, challenges)}</strong><small>{event.id} · {eventScheduleLabel(event)}</small></span><span className="grading-event-card-meta"><b>{statusLabel(event.status)}</b><span>{rows.length} 份提交</span><span>{completed} 已完成 · {pending} 待处理</span></span><span className="grading-event-card-arrow">打开 →</span></button>; })}{!groups.length && <div className="empty">暂无可评测训战</div>}</div></>}</section>
      <div className="grading-tools"><section className="panel admin-card import-card"><div className="admin-card-heading"><div><p className="kicker">线下评测</p><h3>评测输入清单</h3><small>将选定提交交给对应赛题的评测引擎。</small></div><button className="quiet" disabled={!inputText} onClick={copyInput}>复制</button></div><textarea value={inputText} onChange={(event) => setInputText(event.target.value)} rows={10} placeholder="选择提交后生成清单" readOnly={!inputText} /></section><section className="panel admin-card import-card"><div className="admin-card-heading"><div><p className="kicker">评测结果</p><h3>导入线下结果</h3></div></div><textarea value={importText} onChange={(event) => setImportText(event.target.value)} rows={10} placeholder="粘贴评测结果 JSON" /><button className="primary" disabled={busy || !importText.trim()} onClick={onImport}>校验并保存结果</button></section></div>
    </div>
  </section>;
}

function OrganizationSection({ users, orgUnits, adminAccess, busy, onSaved, onMessage }: { users: AdminUser[]; orgUnits: OrgUnit[]; adminAccess: AdminAccess; busy: boolean; onSaved: () => void; onMessage: (message: string) => void }) {
  const pageSize = 8;
  const [unitForm, setUnitForm] = useState({ id: '', name: '', label: '部门', parentId: orgUnits.find((unit) => unit.id !== 'org-root')?.id ?? 'org-root' });
  const [userForm, setUserForm] = useState({ orgUnitId: '', roles: ['learner'] });
  const [editingId, setEditingId] = useState('');
  const [page, setPage] = useState(1);
  const [saving, setSaving] = useState(false);
  const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
  const pageUsers = users.slice((page - 1) * pageSize, page * pageSize);
  const pageStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const pageNumbers = Array.from({ length: Math.min(5, totalPages) }, (_, index) => pageStart + index);
  const manageableUnits = orgUnits.filter((unit) => unit.id !== 'org-root' && (adminAccess.level === 'GLOBAL' || adminAccess.scopeOrgPaths.some((scope) => unit.path === scope || unit.path.startsWith(scope))));
  const sortedOrgUnits = orgUnits.slice().sort((a, b) => a.path.localeCompare(b.path));
  const roleOptions = [
    { value: 'learner', label: '新员工' },
    { value: 'mentor', label: '导师' },
    ...(adminAccess.level === 'GLOBAL' ? [{ value: 'global_admin', label: '全局管理员' }, { value: 'department_admin', label: '部门管理员' }] : []),
  ];

  useEffect(() => { setPage((current) => Math.min(current, totalPages)); }, [totalPages]);

  const save = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setSaving(true);
    try { await action(); onMessage(success); onSaved(); return true; } catch (error) { onMessage(error instanceof Error ? error.message : '操作未完成'); return false; } finally { setSaving(false); }
  };
  const clearEdit = () => { setEditingId(''); setUserForm({ orgUnitId: '', roles: ['learner'] }); };
  const edit = (user: AdminUser) => { setEditingId(user.id); setUserForm({ orgUnitId: user.orgUnitId, roles: editableRoles(user) }); };
  const toggleRole = (role: string) => setUserForm((current) => ({ ...current, roles: current.roles.includes(role) ? current.roles.filter((item) => item !== role) : [...current.roles, role] }));
  const submitUser = () => {
    if (!editingId) { onMessage('员工首次登录后自动登记'); return; }
    if (!userForm.roles.length) { onMessage('至少保留一个角色'); return; }
    void save(() => request(`/users/${editingId}`, { method: 'PATCH', body: JSON.stringify({ orgUnitId: userForm.orgUnitId, roles: userForm.roles }) }), '员工配置已保存').then((success) => { if (success) clearEdit(); });
  };
  const departmentFor = (user: AdminUser) => {
    const unit = orgUnits.find((item) => item.id === user.orgUnitId);
    if (unit) return { name: unit.name, meta: `${unit.label} · ${unit.path}` };
    if (user.departmentHint) return { name: '未配置部门', meta: `SSO 部门：${user.departmentHint}` };
    return { name: '未配置部门', meta: '等待管理员配置' };
  };
  return <section className="admin-section">
    <div className="admin-section-heading"><div><p className="kicker">组织与人员</p><h2>组织与人员</h2></div><span className="last-sync">{users.length} 名员工 · {Math.max(0, orgUnits.length - 1)} 个部门</span></div>
    <div className="admin-overview-grid">
      <section className="panel admin-card organization-departments-card">
        <div className="admin-card-heading"><div><p className="kicker">部门维护</p><h3>新增部门</h3></div></div>
        <div className="form-grid"><label>部门编号<input value={unitForm.id} onChange={(event) => setUnitForm({ ...unitForm, id: event.target.value })} /></label><label>部门名称<input value={unitForm.name} onChange={(event) => setUnitForm({ ...unitForm, name: event.target.value })} /></label><label>组织层级<select value={unitForm.parentId} onChange={(event) => setUnitForm({ ...unitForm, parentId: event.target.value })}>{orgUnits.map((unit) => <option key={unit.id} value={unit.id}>{'　'.repeat(Math.max(0, unit.level))}{unit.name}</option>)}</select></label><label>组织标签<input value={unitForm.label} onChange={(event) => setUnitForm({ ...unitForm, label: event.target.value })} /></label></div>
        <button className="primary compact" disabled={busy || saving} onClick={() => void save(() => request('/org-units', { method: 'POST', body: JSON.stringify({ ...unitForm, actorId: 'admin-local' }) }), '部门已创建')}>保存部门</button>
        <div className="org-unit-list-heading"><strong>组织结构</strong><span>{Math.max(0, orgUnits.length - 1)} 个部门</span></div>
        <div className="org-unit-list">{sortedOrgUnits.map((unit) => <div className="org-unit-row" data-level={unit.level} key={unit.id}><span className="org-unit-branch" aria-hidden="true" /><div className="org-unit-main"><strong>{unit.name}</strong><small>{unit.id} · {unit.path}</small></div><span className="org-unit-label">{unit.label}</span></div>)}</div>
      </section>
      <section className="panel admin-card organization-users-card">
        <div className="admin-card-heading"><div><p className="kicker">员工配置</p><h3>{editingId ? '配置员工' : '员工角色与部门'}</h3><small>员工首次登录后自动登记；管理员仅配置部门和角色。</small></div></div>
        {editingId ? <><div className="edit-user-summary">{(() => { const user = users.find((item) => item.id === editingId); return user ? <><strong>{displayPersonName(user.name)}</strong><span>{user.employeeNo}</span></> : null; })()}</div><div className="form-grid"><label>所属部门<select value={userForm.orgUnitId} onChange={(event) => setUserForm({ ...userForm, orgUnitId: event.target.value })}><option value="">未配置部门</option>{manageableUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label><fieldset><legend>角色</legend><div className="checkbox-list">{roleOptions.map((role) => <label className="check-label" key={role.value}><input type="checkbox" checked={userForm.roles.includes(role.value)} onChange={() => toggleRole(role.value)} />{role.label}</label>)}</div></fieldset></div><div className="editor-actions"><button className="secondary-button" onClick={clearEdit}>取消</button><button className="primary compact" disabled={busy || saving} onClick={submitUser}>保存配置</button></div></> : <div className="empty compact-empty">员工通过内部 SSO 首次登录后自动登记</div>}
        <div className="admin-table-wrap organization-user-table"><table className="admin-table"><thead><tr><th>员工</th><th>部门</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{pageUsers.map((user) => { const department = departmentFor(user); return <tr key={user.id}><td><strong>{displayPersonName(user.name)}</strong><small>{user.employeeNo}</small></td><td><div className="department-cell"><strong>{department.name}</strong><small>{department.meta}</small></div></td><td><div className="role-list">{roleLabels(user.roles).map((role) => <span className="role-tag" key={role}>{role}</span>)}</div></td><td><span className={`status-badge status-${user.status.toLowerCase()}`}>{user.status === 'ACTIVE' ? '在职' : '已停用'}</span></td><td><button className="small" onClick={() => edit(user)}>配置</button></td></tr>; })}</tbody></table>{!pageUsers.length && <div className="empty">暂无员工</div>}</div>
        <div className="table-pagination"><span>第 {page} / {totalPages} 页 · 共 {users.length} 人</span><div><button className="small" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>{pageNumbers.map((number) => <button className={`small page-number${page === number ? ' active' : ''}`} key={number} onClick={() => setPage(number)}>{number}</button>)}<button className="small" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>下一页</button></div></div>
      </section>
    </div>
  </section>;
}

function AnnouncementSection({ announcements, form, setForm, onCreate, onDelete, busy }: { announcements: Announcement[]; form: { title: string; summary: string; tag: Announcement['tag']; pinned: boolean }; setForm: (form: { title: string; summary: string; tag: Announcement['tag']; pinned: boolean }) => void; onCreate: () => void; onDelete: (id: string) => void; busy: boolean }) {
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">公告管理</p><h2>公告管理</h2></div></div><div className="announcement-admin-grid"><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">发布公告</p><h3>发布公告</h3></div></div><label>标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label>摘要<textarea value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} rows={4} /></label><label>类型<select value={form.tag} onChange={(event) => setForm({ ...form, tag: event.target.value as Announcement['tag'] })}><option value="平台通知">平台通知</option><option value="训战提醒">训战提醒</option><option value="规则更新">规则更新</option></select></label><label className="check-label"><input type="checkbox" checked={form.pinned} onChange={(event) => setForm({ ...form, pinned: event.target.checked })} /> 置顶公告</label><button className="primary" disabled={busy} onClick={onCreate}>发布并同步到员工首页</button></section><section className="panel admin-card"><div className="admin-card-heading"><div><p className="kicker">已发布</p><h3>已发布公告</h3></div><span className="dot-label">{announcements.length} 条</span></div>{announcements.map((announcement) => <article className="announcement-admin-row" key={announcement.id}><div><div><span className="announcement-tag tag-blue">{announcement.tag}</span>{announcement.pinned && <span className="pinned-label">置顶</span>}<time>{formatDate(announcement.publishedAt)}</time></div><strong>{announcement.title}</strong><p>{announcement.summary}</p></div><button className="small danger" onClick={() => onDelete(announcement.id)}>删除</button></article>)}</section></div></section>;
}

function AuditSection({ audits }: { audits: Audit[] }) {
  return <section className="admin-section"><div className="admin-section-heading"><div><p className="kicker">审计日志</p><h2>审计日志</h2></div></div><section className="panel admin-table-card"><div className="admin-table-wrap"><table className="admin-table audit-table"><thead><tr><th>时间</th><th>操作</th><th>目标</th><th>操作者</th><th>记录编号</th></tr></thead><tbody>{audits.map((audit) => <tr key={audit.id}><td>{formatDate(audit.createdAt)}</td><td><span className="audit-action">{auditActionLabel(audit.action)}</span></td><td>{auditTargetLabel(audit.target)}</td><td>{displayActorName(audit.actorId)}</td><td><small>{audit.id.slice(0, 22)}…</small></td></tr>)}</tbody></table>{!audits.length && <div className="empty">暂无审计记录</div>}</div></section></section>;
}
