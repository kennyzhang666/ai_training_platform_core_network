import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { AdminWorkspace } from './admin';
import { richTextPreview, sanitizeRichText } from './rich-text';

type View = 'home' | 'challenges' | 'hard-problems' | 'hard-problem-detail' | 'challenge-detail' | 'delivery' | 'profile' | 'report' | 'detailed-report' | 'admin';
type SubmissionSource = 'UPLOAD' | 'GIT_REF';

type EventConfig = {
  id: string;
  challengeVersion: string;
  purpose?: 'TRAINING' | 'HARD_PROBLEM';
  submissionSource: SubmissionSource;
  trigger: 'AUTO' | 'MANUAL' | 'IMPORT';
  reveal: 'IMMEDIATE' | 'ON_RELEASE';
  status: string;
  mode?: 'LIVE' | 'WINDOW';
  startsAt?: string;
  endsAt?: string;
  participantMode?: 'OPEN' | 'ALLOWLIST';
  accessPolicy?: { mode: 'OPEN' | 'RESTRICTED'; subjectIds?: string[]; departmentIds?: string[]; mentorIds?: string[] };
  deliveryConfig?: { repository?: string; branchTemplate?: string; allowedFormats?: string[] };
};

type ChallengeVersion = {
  id: string;
  title: string;
  version: number;
  description?: string;
  objectives?: string[];
  requirements?: string[];
  constraints?: string[];
  deliverables?: string[];
  tags?: string[];
  estimatedMinutes?: number;
  zone: 'YELLOW' | 'BLUE';
  rubricVersion: string;
  languagePolicy?: { languages?: string[] };
  status?: 'DRAFT' | 'PUBLISHED';
};

type ChallengeCategory = 'TRAINING' | 'COMPETITION' | 'HARD_PROBLEM';
type HardProblemSolution = { submissionId: string; solverId: string; solverName: string; submittedAt: string; state: string; sourceType: SubmissionSource; artifactName?: string; artifactHash?: string; repository?: string; branch?: string; commitSha?: string };
type Challenge = { id: string; origin: string; category?: ChallengeCategory; status: string; board?: { type: 'HARD_PROBLEM'; summary: string; details?: string; publisherType: 'DEPARTMENT' | 'EMPLOYEE'; publisherId: string; publisherName: string; departmentName?: string; orgPath?: string; difficulty: 'HIGH' | 'MEDIUM' | 'LOW'; tags: string[]; status: 'OPEN' | 'RESOLVED'; reviewStatus?: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED'; solutionVisibility?: 'PUBLIC' | 'HIDDEN'; solutionSubmissionId?: string; submissionEventId?: string; reviewedAt?: string; reviewedBy?: string; reviewComment?: string; createdAt: string; updatedAt: string; resolvedAt?: string; resolvedBy?: string; resolvedByName?: string; solverId?: string; solverName?: string }; versions: ChallengeVersion[] };

type Announcement = { id: string; title: string; summary: string; tag: string; publishedAt: string; pinned?: boolean };

type HardProblem = {
  id: string;
  challengeId?: string;
  title: string;
  summary: string;
  details?: string;
  publisherType: 'DEPARTMENT' | 'EMPLOYEE';
  publisherId: string;
  publisherName: string;
  departmentName?: string;
  orgPath?: string;
  difficulty: 'HIGH' | 'MEDIUM' | 'LOW';
  tags: string[];
  status: 'OPEN' | 'RESOLVED';
  reviewStatus: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
  solutionVisibility: 'PUBLIC' | 'HIDDEN';
  solutionSubmissionId?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComment?: string;
  submissionEventId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  solverId?: string;
  solverName?: string;
  solution?: HardProblemSolution;
};

type Submission = {
  id: string;
  eventId: string;
  subjectId: string;
  state: string;
  createdAt: string;
  snapshot: { sourceType: string; snapshotHash: string; repository?: string; branch?: string; commitSha?: string; artifactHash?: string; artifactUri?: string; artifactName?: string; workspacePath?: string };
  gradingRunId?: string;
  resultId?: string;
  gradingStatus?: string;
  failureReason?: string;
};

type Profile = {
  subject: { id: string; name: string; employeeNo: string; orgPath: string; roles: string[]; roleBindings?: Array<{ role: string; scopeOrgPath: string }> };
  stats: { submissions: number; graded: number; average: number | null; best: number | null; totalPoints?: number };
  history: Array<{ submissionId: string; eventId: string; total: number; points?: number; resultId: string; createdAt: string }>;
};

type LeaderRow = { rank: number; subjectId: string; total: number; submissions: number };
type CapabilityDimension = { key: string; label: string; description: string; score: number | null; max: number | null; percent: number | null; latestPercent: number | null; bestPercent: number | null; delta: number | null; evaluatedCount: number; peerMedianPercent?: number | null; peerCount?: number; vsPeerMedian?: number | null; samples: Array<{ submissionId: string; eventId: string; createdAt: string; score: number; max: number; percent: number }> };
type CapabilityDomain = { key: string; label: string; shortLabel: string; description: string; evidenceMode: 'derived' | 'direct'; criterionKeys: string[]; evidenceKeys: string[]; score: number | null; max: number | null; percent: number | null; latestPercent: number | null; bestPercent: number | null; delta: number | null; sampleCount: number; evidenceCount: number; peerMedianPercent?: number | null; peerCount?: number; vsPeerMedian?: number | null; status: string; samples: Array<{ submissionId: string; eventId: string; createdAt: string; score: number; max: number; percent: number; criterionKeys: string[] }> };
type CapabilityProfile = {
  subjectId: string;
  capabilityCatalogVersion?: string;
  summary: { gradedSubmissions: number; overallAverage: number | null; latestTotal: number | null; delta: number | null; strongestDimension: string | null; focusDimension: string | null; strongestDomain?: string | null; focusDomain?: string | null; capabilityCatalogVersion?: string; totalCapabilityDomains?: number; evaluatedCapabilityDomains?: number; zoneStats?: { YELLOW: number; BLUE: number }; totalSkillItems?: number; evaluatedSkillItems?: number; departmentAverage?: number | null; departmentMedian?: number | null; departmentPercentile?: number | null };
  dimensions: CapabilityDimension[];
  domains: CapabilityDomain[];
  capabilityDomains?: CapabilityDomain[];
  skills: Array<{ key: string; criterionKey: string; name: string; dimension: string; domainKeys?: string[]; description: string; max: number; averageScore: number | null; percent: number | null; latestPercent: number | null; averageLevel: string | null; sampleCount: number; status: string }>;
  gradeMatrix?: CapabilityProfile['skills'];
  weakItems?: Array<{ key: string; name: string; dimension: string; percent: number; averageLevel: string | null; recommendation: string }>;
  recommendations?: string[];
  trend: Array<{ submissionId: string; eventId: string; createdAt: string; total: number | null; zone?: 'YELLOW' | 'BLUE'; dimensionPercentages: Record<string, number | null>; domainPercentages?: Record<string, number | null> }>;
  zoneStats?: { YELLOW: number; BLUE: number };
  departmentComparison?: { orgPath: string; participantCount: number; average: number | null; median: number | null; percentile: number | null };
  lastUpdated: string | null;
};
type Report = {
  result: {
    total?: number;
    status?: string;
    challengeVersion?: string;
    rubricVersion?: string;
    graderVersion?: string;
    gradedBy?: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    submission?: { sourceType?: string; snapshotHash?: string; artifactHash?: string; artifactUri?: string; repository?: string; branch?: string; commitSha?: string; submittedAt?: string };
    dimensions?: Record<string, { score: number | null; max?: number; evaluated?: boolean }>;
    criteria?: Array<{ key: string; dim: string; name: string; score: number; max: number; source: string; level?: string; rule?: string; rationale?: string; evidenceType?: string; evidence?: unknown }>;
    validationDiagnostics?: Array<{ severity: string; code: string; message: string; path?: string }>;
    verifyDetail?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    extractions?: Array<{ id: string; q: string; a: string; quote: string; quoteVerified: boolean; source?: string }>;
    findings?: Array<{ id?: string; dim?: string; criteria?: string; title: string; severity: string; detail: string; fix?: string; file?: string; line?: number; snippet?: string }>;
  };
  report?: {
    event?: { rank: number | null; percentile: number | null; average: number | null; median?: number | null; participantCount: number };
    department?: { orgPath: string; rank: number | null; percentile: number | null; average: number | null; median: number | null; participantCount: number };
    summary?: { score: number | null; status: string | null; grade: string | null; evaluatedDimensions: number; totalDimensions: number; passRate: number | null; findingCount: number; diagnosticCount: number; durationMs: number | null };
    submission?: { id: string; eventId: string; subjectId: string; state: string; createdAt: string; sourceType: string; snapshotHash: string; artifactHash?: string; artifactUri?: string; repository?: string; branch?: string; commitSha?: string; submittedAt: string; challengeVersion?: string; rubricVersion?: string };
    timeline?: { submittedAt: string; createdAt: string; startedAt?: string | null; finishedAt?: string | null };
    dimensionBreakdown?: Array<{ key: string; label: string; score: number | null; max: number | null; evaluated: boolean; percent: number | null; criteriaCount: number; findingsCount: number }>;
    objectiveMetrics?: { metrics?: unknown; verifyDetail?: unknown; project?: unknown; validationDiagnostics?: unknown };
    commitTimeline?: Array<Record<string, unknown>>;
    gradeMatrix?: Array<{ key: string; dim: string; name: string; score: number | null; max: number | null; level: string | null; source: string | null; rule: string | null; rationale: string | null; evidenceType: string | null; evidence: unknown }>;
    criteriaByDimension?: Record<string, Array<{ key: string; dim: string; name: string; score: number; max: number; source: string; level?: string; rule?: string; rationale?: string; evidenceType?: string; evidence?: unknown }>>;
    diagnostics?: Array<{ severity: string; code: string; message: string; path?: string }>;
    recommendations?: string[];
  };
};

const API = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:3000/api/v1';
const DEFAULT_EMPLOYEE_ID = import.meta.env.VITE_EMPLOYEE_ID ?? 'w00123';

function localEmployeeId(): string {
  if (typeof window === 'undefined') return DEFAULT_EMPLOYEE_ID;
  return window.localStorage.getItem('ai-training.employeeId') ?? DEFAULT_EMPLOYEE_ID;
}

function displayPersonName(name?: string): string {
  if (!name) return '参训员工';
  if (name === '本地开发用户') return '平台管理员';
  if (name === '本地部门管理员') return '部门管理员';
  return name.replace(/^本地学员\s*/, '参训员工 ');
}

function adminAccessFor(subject?: Profile['subject']): { level: 'GLOBAL' | 'DEPARTMENT'; scopeOrgPaths: string[] } | null {
  if (!subject) return null;
  const bindings = subject.roleBindings ?? [];
  const scopedLegacyBindings = bindings.filter((binding) => binding.role === 'admin' && binding.scopeOrgPath !== '/');
  if (subject.roles.includes('global_admin') || bindings.some((binding) => ['global_admin', 'admin'].includes(binding.role) && binding.scopeOrgPath === '/') || (subject.roles.includes('admin') && scopedLegacyBindings.length === 0)) {
    return { level: 'GLOBAL', scopeOrgPaths: ['/'] };
  }
  const paths = [
    ...(subject.roles.includes('department_admin') && subject.orgPath ? [subject.orgPath] : []),
    ...bindings.filter((binding) => ['department_admin', 'admin'].includes(binding.role)).map((binding) => binding.scopeOrgPath),
  ].filter((path, index, all) => all.indexOf(path) === index);
  return paths.length ? { level: 'DEPARTMENT', scopeOrgPaths: paths } : null;
}

function adminRoleLabel(access: ReturnType<typeof adminAccessFor>): string {
  return access?.level === 'GLOBAL' ? '全局管理员' : access?.level === 'DEPARTMENT' ? '部门管理员' : '参训员工';
}

function humanizeApiMessage(message: string): string {
  const value = message.trim();
  const rules: Array<[RegExp, string]> = [
    [/event .* is not open/i, '当前训战未开放'],
    [/event .*outside.*scope|subject is not configured/i, '当前账号不在该训战参训范围内'],
    [/subject is disabled/i, '当前账号已停用'],
    [/upload requires|artifactBase64|artifactUri|workspacePath/i, '请选择有效交付件'],
    [/GIT_REF requires/i, '请填写 Git 仓路径、分支和提交版本'],
    [/repository must match/i, '仓库路径与训战配置不一致'],
    [/branch must match/i, '分支与训战配置不一致'],
    [/commitSha must/i, '提交版本格式不正确'],
    [/snapshotHash|artifactHash.*match/i, '交付件校验失败'],
    [/hard problem not found/i, '难题不存在或不可见'],
    [/challenge.*not found/i, '赛题不存在或不可见'],
    [/event.*not found/i, '训战不存在或不可见'],
    [/report not available/i, '评估报告暂不可用'],
    [/report is sealed/i, '评估报告尚未公布'],
    [/administrator role is required/i, '当前账号无管理员权限'],
    [/published challenge.*immutable/i, '已发布赛题不可直接修改，请创建新版本'],
    [/result .*invalid|schema is invalid/i, '评估结果格式不正确'],
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1] ?? value;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-employee-id': localEmployeeId(), ...(init?.headers ?? {}) },
  });
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待定';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour}:${minute}`;
}

function eventTimeLabel(event?: EventConfig): string {
  if (!event?.startsAt && !event?.endsAt) return '时间待定';
  if (event.startsAt && event.endsAt) {
    const start = new Date(event.startsAt);
    const end = new Date(event.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '时间待定';
    const startDate = formatDateTime(event.startsAt).split(' ')[0];
    const endDate = formatDateTime(event.endsAt).split(' ')[0];
    const startClock = formatDateTime(event.startsAt).split(' ')[1];
    const endClock = formatDateTime(event.endsAt).split(' ')[1];
    return startDate === endDate ? `${startDate} ${startClock}–${endClock}开放` : `${startDate} ${startClock} — ${endDate} ${endClock}开放`;
  }
  return event.startsAt ? `${formatDateTime(event.startsAt)}起开放` : `截至 ${formatDateTime(event.endsAt ?? '')}`;
}

function eventTitle(event: EventConfig, challenges: Challenge[]): string {
  return challenges.flatMap((challenge) => challenge.versions).find((version) => version.id === event.challengeVersion)?.title ?? event.challengeVersion;
}

function sourceLabel(source: SubmissionSource): string {
  return source === 'UPLOAD' ? '上传交付件' : '指定 Git 仓库';
}

function zoneLabel(zone?: string): string {
  return zone === 'BLUE' ? '蓝区' : '黄区';
}

function triggerLabel(trigger?: string): string {
  return trigger === 'MANUAL' ? '管理员安排' : trigger === 'IMPORT' ? '结果录入' : '自动评估';
}

function branchDisplayLabel(template?: string): string {
  if (!template || template.includes('{subjectId}')) return '按参训员工分配';
  return template;
}

function eventModeLabel(mode?: string): string {
  return mode === 'LIVE' ? '集中训战' : '开放窗口';
}

function statusLabel(status?: string): string {
  return ({
    OPEN: '进行中', CLOSED: '已结束', RELEASED: '已公布', REVEALED: '已公布',
    WAITING_TRIGGER: '等待评估', WAITING_IMPORT: '等待结果录入', RECEIVED: '已提交',
    QUEUED: '排队中', RUNNING: '评估中', GRADED: '已完成', FAILED: '评估未完成',
    COMPLETE: '已完成', PASSED: '通过', PARTIAL: '部分完成', REJECTED: '未通过', PUBLISHED: '已发布', DRAFT: '草稿',
    PENDING: '等待评估', PROCESSING: '评估中', SUCCESS: '已完成', ERROR: '评估未完成', CANCELED: '已取消', CANCELLED: '已取消',
  } as Record<string, string>)[status ?? ''] ?? (status && !/^[A-Z][A-Z0-9_]*$/.test(status) ? status : '—');
}

function severityLabel(severity?: string): string {
  return ({ error: '错误', warning: '提醒', info: '信息', ERROR: '错误', WARNING: '提醒', INFO: '信息' } as Record<string, string>)[severity ?? ''] ?? severity ?? '信息';
}

function languageLabel(language?: string): string {
  return language?.toLowerCase() === 'python' ? 'Python' : language ?? '未指定';
}

function dimensionLabel(key?: string): string {
  return ({ verify: '验证能力', spec: '规格能力', code: '工程能力', collab: '协作能力' } as Record<string, string>)[key ?? ''] ?? key ?? '能力维度';
}

function evidenceSourceLabel(source?: string): string {
  return ({ auto: '自动评估', human: '人工复核', metric: '代码指标', system: '平台校验' } as Record<string, string>)[source?.toLowerCase() ?? ''] ?? '评估记录';
}

function evidenceTypeLabel(type?: string): string {
  return ({ test: '测试结果', metric: '指标记录', quote: '原文引用', extraction: '内容提取', 'model-extraction': '内容提取' } as Record<string, string>)[type?.toLowerCase() ?? ''] ?? '相关证据';
}

function graderLabel(grader?: string): string {
  return ({ 'local-grader': '自动评估', 'manual-review': '人工复核', imported: '线下评估结果' } as Record<string, string>)[grader ?? ''] ?? '评估记录';
}

function evidenceSummary(evidence: unknown): string {
  if (!evidence) return '—';
  if (typeof evidence === 'string') return evidence;
  if (Array.isArray(evidence)) return evidence.map((item) => evidenceSummary(item)).filter((item) => item !== '—').join('；') || '已记录相关证据';
  if (typeof evidence === 'object') {
    const record = evidence as Record<string, unknown>;
    const preferred = ['quote', 'text', 'content', 'detail', 'message', 'value', 'path', 'file'];
    const values = preferred.map((key) => record[key]).filter((value) => typeof value === 'string' && value.trim()).map((value) => String(value));
    if (values.length) return values.join(' · ');
  }
  return '已记录相关证据';
}

function App() {
  const [view, setView] = useState<View>('home');
  const [events, setEvents] = useState<EventConfig[]>([]);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [hardProblems, setHardProblems] = useState<HardProblem[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityProfile | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const [eventId, setEventId] = useState('event-local');
  const [challengeVersionId, setChallengeVersionId] = useState('parking-fee-01@1');
  const [challengeDetailBackView, setChallengeDetailBackView] = useState<'challenges' | 'hard-problems'>('challenges');
  const [selectedHardProblemId, setSelectedHardProblemId] = useState<string | null>(null);
  const [deliveryBackView, setDeliveryBackView] = useState<'challenges' | 'hard-problem-detail'>('challenges');
  const [subjectId] = useState(localEmployeeId);
  const [source, setSource] = useState<SubmissionSource>('UPLOAD');
  const [file, setFile] = useState<File | null>(null);
  const [git, setGit] = useState({ repository: '', branch: '', commitSha: '' });
  const [reports, setReports] = useState<Record<string, Report>>({});
  const [reportSubmissionId, setReportSubmissionId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedEvent = useMemo(() => events.find((item) => item.id === eventId), [events, eventId]);
  const selectedVersion = useMemo(() => challenges.flatMap((challenge) => challenge.versions).find((version) => version.id === challengeVersionId) ?? (selectedEvent && challenges.flatMap((challenge) => challenge.versions).find((version) => version.id === selectedEvent.challengeVersion)), [challenges, challengeVersionId, selectedEvent]);
  const selectedChallenge = useMemo(() => challenges.find((challenge) => challenge.versions.some((version) => version.id === selectedVersion?.id)), [challenges, selectedVersion]);
  const selectedHardProblem = useMemo(() => hardProblems.find((problem) => problem.id === selectedHardProblemId), [hardProblems, selectedHardProblemId]);
  const totalPoints = profile?.stats.totalPoints ?? profile?.history.reduce((sum, item) => sum + (item.points ?? item.total), 0) ?? 0;
  const currentRank = leaderboard.find((row) => row.subjectId === subjectId)?.rank;
  const adminAccess = adminAccessFor(profile?.subject);

  async function refresh() {
    const [loadedEvents, loadedChallenges, loadedAnnouncements, loadedHardProblems, loadedSubmissions, loadedProfile, loadedCapabilities, loadedLeaderboard] = await Promise.all([
      request<EventConfig[]>('/events'),
      request<Challenge[]>('/challenges'),
      request<Announcement[]>('/announcements'),
      request<HardProblem[]>('/hard-problems'),
      request<Submission[]>('/submissions'),
      request<Profile>(`/profiles/${subjectId}`),
      request<CapabilityProfile>(`/profiles/${subjectId}/capabilities`),
      request<LeaderRow[]>('/seasons/season-local-2026/leaderboard'),
    ]);
    // The normal event listing intentionally excludes HARD_PROBLEM upload
    // entries. Keep any independently opened hard-problem event in memory so
    // the delivery workbench remains usable after a submit/refresh.
    const retainedHardEvents = events.filter((event) => event.purpose === 'HARD_PROBLEM' && !loadedEvents.some((item) => item.id === event.id));
    const nextEvents = [...loadedEvents, ...retainedHardEvents];
    setEvents(nextEvents);
    setChallenges(loadedChallenges);
    setAnnouncements(loadedAnnouncements.map((item) => item.id === 'announcement-local-grading' ? { ...item, title: '本周训战提交提醒', summary: '本期训战支持上传交付件或提交 Git 版本，请按题目要求完成提交；评估结果生成后会同步到个人中心。' } : item.id === 'announcement-welcome' ? { ...item, title: '本期训战安排', summary: '本期训战已开放，提交后可在个人中心查看评估报告。' } : item));
    setHardProblems(loadedHardProblems.map((problem) => ({ ...problem, publisherName: displayPersonName(problem.publisherName), ...(problem.solverName ? { solverName: displayPersonName(problem.solverName) } : {}) })));
    setSubmissions(loadedSubmissions);
    setProfile({ ...loadedProfile, subject: { ...loadedProfile.subject, name: displayPersonName(loadedProfile.subject.name) } });
    setCapabilities(loadedCapabilities);
    setLeaderboard(loadedLeaderboard);
    const reportEntries = await Promise.all(loadedSubmissions.filter((item) => item.resultId).map(async (item) => {
      try { return [item.id, await request<Report>(`/reports/${item.id}`)] as const; } catch { return null; }
    }));
    setReports(Object.fromEntries(reportEntries.filter((item): item is readonly [string, Report] => item !== null)));
    if (!nextEvents.some((item) => item.id === eventId) && nextEvents[0]) setEventId(nextEvents[0].id);
  }

  useEffect(() => { void refresh().catch((error: Error) => setMessage(error.message)); }, []);

  function openDelivery(nextEventId = eventId, backView: 'challenges' | 'hard-problem-detail' = 'challenges') {
    const next = events.find((item) => item.id === nextEventId);
    setEventId(nextEventId);
    if (next) {
      setChallengeVersionId(next.challengeVersion);
      setSource(next.submissionSource);
      if (next.deliveryConfig?.repository) setGit((current) => ({ ...current, repository: next.deliveryConfig?.repository ?? current.repository, branch: next.deliveryConfig?.branchTemplate?.replace('{subjectId}', subjectId) ?? current.branch }));
    }
    setDeliveryBackView(backView);
    setView('delivery');
    setMessage('');
  }

  function openChallenge(nextVersionId: string) {
    const versionEvent = events.find((event) => event.challengeVersion === nextVersionId);
    if (!versionEvent) {
      setMessage('当前账号未被配置为该训战参与者，无法进入。');
      return;
    }
    setChallengeVersionId(nextVersionId);
    setEventId(versionEvent.id);
    setChallengeDetailBackView('challenges');
    setSource(versionEvent.submissionSource);
    if (versionEvent.deliveryConfig?.repository) setGit((current) => ({ ...current, repository: versionEvent.deliveryConfig?.repository ?? current.repository, branch: versionEvent.deliveryConfig?.branchTemplate?.replace('{subjectId}', subjectId) ?? current.branch }));
    setView('challenge-detail');
    setMessage('');
  }

  async function openHardProblem(problemId: string) {
    const problem = hardProblems.find((item) => item.id === problemId);
    if (!problem) {
      setMessage('难题详情暂不可用，请稍后刷新重试。');
      return;
    }
    setSelectedHardProblemId(problemId);
    setView('hard-problem-detail');
    setMessage('');
    if (problem.submissionEventId && !events.some((event) => event.id === problem.submissionEventId)) {
      try {
        const event = await request<EventConfig>(`/events/${problem.submissionEventId}`);
        setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
      } catch {
        setMessage('当前难题的交付入口暂未准备好，请联系管理员。');
      }
    }
  }

  const openHardProblemChallenge = (problemId: string) => { void openHardProblem(problemId); };

  async function submit() {
    if (!selectedEvent) return;
    setBusy(true);
    setMessage('正在提交交付件…');
    try {
      let snapshot: Record<string, string>;
      if (source === 'UPLOAD') {
        if (file) {
          const bytes = await file.arrayBuffer();
          snapshot = { sourceType: 'UPLOAD', artifactHash: '', submittedAt: new Date().toISOString() };
          await request(`/events/${selectedEvent.id}/submissions:upload`, {
            method: 'POST',
            body: JSON.stringify({ subjectId, snapshot, fileName: file.name, artifactBase64: toBase64(new Uint8Array(bytes)) }),
          });
        } else {
          throw new Error('请选择一个交付包');
        }
      } else {
        if (!git.commitSha) throw new Error('请输入提交版本');
        snapshot = { sourceType: 'GIT_REF', submittedAt: new Date().toISOString(), ...git };
        await request(`/events/${selectedEvent.id}/submissions:register-git`, { method: 'POST', body: JSON.stringify({ subjectId, snapshot }) });
      }
      setMessage('提交已登记，等待评估');
      setFile(null);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  async function openReport(submissionId: string) {
    setReportSubmissionId(submissionId);
    setView('detailed-report');
    if (!reports[submissionId]) {
      try {
        const report = await request<Report>(`/reports/${submissionId}`);
        setReports((current) => ({ ...current, [submissionId]: report }));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '报告暂未生成或不可见');
      }
    }
  }

  const challengeCards = challenges.filter((challenge) => challenge.status === 'PUBLISHED').flatMap((challenge) => challenge.versions.filter((version) => version.status === 'PUBLISHED').map((version) => ({
     challenge,
     version,
     title: version.title,
     event: events.find((event) => event.purpose !== 'HARD_PROBLEM' && event.challengeVersion === version.id),
  }))).filter((card) => Boolean(card.event)).sort((left, right) => {
    const weight = (event?: EventConfig) => event?.status === 'OPEN' ? 0 : event?.status === 'RELEASED' ? 1 : 2;
    return weight(left.event) - weight(right.event);
  });
  const currentEventCard = challengeCards.find((card) => card.event?.status === 'OPEN');
  const selectedUploadEvent = events.find((event) => event.purpose !== 'HARD_PROBLEM' && event.challengeVersion === selectedVersion?.id && event.submissionSource === 'UPLOAD');
  const selectedGitEvent = events.find((event) => event.purpose !== 'HARD_PROBLEM' && event.challengeVersion === selectedVersion?.id && event.submissionSource === 'GIT_REF');
  const deliveryEvents = selectedEvent?.purpose === 'HARD_PROBLEM' ? events.filter((event) => event.purpose === 'HARD_PROBLEM') : events.filter((event) => event.purpose !== 'HARD_PROBLEM');

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView('home')}><span className="brand-mark">AI</span><span><span className="eyebrow">训战平台</span><strong>AI 能力训战平台</strong></span></button>
        <nav className="main-nav" aria-label="主导航">
          <button className={view === 'home' ? 'active' : ''} onClick={() => setView('home')}>首页</button>
          <button className={view === 'challenges' || view === 'challenge-detail' || view === 'delivery' ? 'active' : ''} onClick={() => setView('challenges')}>训战广场</button>
          <button className={view === 'hard-problems' || view === 'hard-problem-detail' ? 'active' : ''} onClick={() => setView('hard-problems')}>难题榜</button>
          <button className={view === 'profile' || view === 'detailed-report' ? 'active' : ''} onClick={() => setView('profile')}>个人中心</button>
        </nav>
        {adminAccess && <button className={`admin-entry ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>管理后台 <span>↗</span></button>}
         <button className="user-chip" onClick={() => setView('profile')}><span className="avatar">本</span><span>{displayPersonName(profile?.subject.name)}<br /><small>{adminAccess ? `${adminRoleLabel(adminAccess)} · 参训员工` : profile?.subject.roles.includes('mentor') ? '导师 · 参训员工' : '参训员工'}</small></span><span className="chevron">⌄</span></button>
      </header>

      {view === 'admin' && adminAccess && <AdminWorkspace userName={profile?.subject.name ?? ''} adminAccess={adminAccess} onExit={() => setView('home')} />}

      {view === 'home' && <main className="home-page">
        <section className="home-current panel">
          <div className="home-current-main">
            <p className="kicker">当前训战</p>
            {currentEventCard ? <>
              <div className="home-current-tags"><span className="zone-tag">{zoneLabel(currentEventCard.version.zone)}</span><span className="challenge-status">进行中</span></div>
              <h1>{currentEventCard.title}</h1>
              <p className="home-current-time">时间：{eventTimeLabel(currentEventCard.event)}</p>
              <button className="primary compact" onClick={() => openChallenge(currentEventCard.version.id)}>进入训战</button>
            </> : <>
              <h1>暂无进行中的训战</h1>
              <p className="home-current-time">训战安排</p>
              <button className="secondary-button" onClick={() => setView('challenges')}>查看训战安排</button>
            </>}
          </div>
          <div className="home-current-summary" aria-label="赛季数据">
            <div><span>赛季积分</span><strong>{Math.round(totalPoints)}</strong></div>
            <div><span>部门排名</span><strong>{currentRank ? `第 ${currentRank} 名` : '—'}</strong></div>
          </div>
        </section>

        <section className="stat-grid">
          <article className="stat-card"><div><strong>{Math.round(totalPoints)}</strong><span>赛季积分</span></div><em>{currentRank ? `第 ${currentRank} 名` : '—'}</em></article>
          <article className="stat-card"><div><strong>{profile?.stats.submissions ?? 0}</strong><span>参与场次</span></div><em>本赛季</em></article>
          <article className="stat-card"><div><strong>{profile?.stats.average ?? '—'}</strong><span>平均成绩</span></div><em>满分 100 分</em></article>
          <article className="stat-card"><div><strong>{profile?.stats.graded ?? 0}</strong><span>已完成评估</span></div><em>{profile?.stats.best ? `最高 ${profile.stats.best} 分` : '—'}</em></article>
        </section>

        <div className="home-columns">
           <section className="panel section-panel"><div className="section-title"><div><p className="kicker">训战安排</p><h2>本期训战</h2></div><button className="quiet" onClick={() => setView('challenges')}>查看全部场次 →</button></div><div className="challenge-list">{challengeCards.slice(0, 3).map(({ event, title, version }) => <ChallengeCard key={version.id} event={event} title={title} version={version} onOpen={openChallenge} />)}{challengeCards.length === 0 && <div className="empty">暂无可参加训战</div>}</div></section>
          <aside className="home-side">
             <section className="panel section-panel announcement-panel"><div className="section-title"><div><p className="kicker">平台动态</p><h2>平台公告</h2></div><span className="dot-label">{announcements.length} 条</span></div>{announcements.slice(0, 3).map((item) => <article className="announcement" key={item.id}><div className="announcement-head"><span className={`announcement-tag tag-${item.tag === '规则更新' ? 'orange' : item.tag === '训战提醒' ? 'blue' : 'green'}`}>{item.tag}</span><time>{formatDate(item.publishedAt)}</time></div><strong>{item.title}</strong><p>{item.summary}</p></article>)}</section>
           <section className="panel section-panel leaderboard-panel"><div className="section-title"><div><p className="kicker">赛季排名</p><h2>赛季榜单</h2></div><button className="quiet" onClick={() => setView('profile')}>查看我的积分</button></div>{leaderboard.slice(0, 4).map((row) => <div className="leader-row" key={row.subjectId}><span className={`rank rank-${row.rank}`}>{row.rank}</span><span className="leader-avatar">{row.subjectId === subjectId ? '本' : row.subjectId.slice(-1)}</span><span className="leader-name">{row.subjectId === subjectId ? displayPersonName(profile?.subject.name) : '参训员工'}<small>{row.submissions} 场</small></span><strong>{Math.round(row.total)}<small>分</small></strong></div>)}{leaderboard.length === 0 && <div className="empty">暂无排名数据</div>}</section>
          <section className="panel section-panel hard-problem-teaser"><div className="section-title"><div><p className="kicker">难题榜</p><h2>难题榜</h2></div><button className="quiet" onClick={() => setView('hard-problems')}>查看全部 →</button></div>{hardProblems.filter((problem) => problem.status === 'OPEN').slice(0, 2).map((problem) => <article className="hard-problem-teaser-row" key={problem.id}><span className={`problem-difficulty difficulty-${problem.difficulty.toLowerCase()}`}>{hardProblemDifficultyLabel(problem.difficulty)}</span><div><strong>{problem.title}</strong><small>{hardProblemPublisherLabel(problem)} · {formatDate(problem.createdAt)}</small></div></article>)}{hardProblems.filter((problem) => problem.status === 'OPEN').length === 0 && <div className="empty compact-empty">暂无待揭榜难题</div>}</section>
          </aside>
        </div>

          <section className="activity panel section-panel"><div className="section-title"><div><p className="kicker">最近动态</p><h2>最近动态</h2></div><button className="quiet" onClick={() => setView('profile')}>查看全部 →</button></div>{submissions.slice().reverse().slice(0, 4).map((submission) => <div className="activity-row" key={submission.id}><span className="activity-icon">{submission.resultId ? '✓' : '…'}</span><div><strong>{eventTitle(events.find((event) => event.id === submission.eventId) ?? { id: '', challengeVersion: '', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE', status: '' }, challenges)}</strong><span>{sourceLabel(submission.snapshot.sourceType === 'UPLOAD' ? 'UPLOAD' : 'GIT_REF')} · {formatDate(submission.createdAt)}</span></div><span className={`state state-${submission.state.toLowerCase()}`}>{statusLabel(submission.state)}</span>{reports[submission.id] && <b className="activity-score">{reports[submission.id].result.total}</b>}</div>)}{submissions.length === 0 && <div className="empty">暂无训战记录</div>}</section>
      </main>}

      {view === 'challenges' && <main className="content-page"><section className="page-heading"><div><p className="kicker">训战广场</p><h1>训战广场</h1></div><div className="heading-count"><strong>{challengeCards.length}</strong><span>场训战</span></div></section><div className="challenge-grid">{challengeCards.map(({ event, title, version }) => <ChallengeCard key={version.id} event={event} title={title} version={version} onOpen={openChallenge} large />)}</div></main>}

      {view === 'hard-problems' && <HardProblemsPageV2 problems={hardProblems} onRefresh={() => void refresh()} onOpenChallenge={openHardProblemChallenge} />}

      {view === 'hard-problem-detail' && selectedHardProblem && <HardProblemDetailPageV2 problem={selectedHardProblem} event={events.find((item) => item.id === selectedHardProblem.submissionEventId)} onBack={() => setView('hard-problems')} onSubmit={() => { const event = events.find((item) => item.id === selectedHardProblem.submissionEventId); if (event) openDelivery(event.id, 'hard-problem-detail'); else setMessage('交付入口准备中，请稍后重试。'); }} />}

      {view === 'challenge-detail' && <main className="content-page challenge-detail-page"><button className="back-link" onClick={() => setView(challengeDetailBackView)}>← 返回{challengeDetailBackView === 'hard-problems' ? '难题榜' : '训战广场'}</button>{selectedVersion ? <><section className="detail-hero panel"><div><div className="detail-tags"><span className="zone-tag">{zoneLabel(selectedVersion.zone)}</span>{(selectedVersion.tags ?? []).map((tag) => <span className="detail-tag" key={tag}>{tag}</span>)}</div><h1>{selectedVersion.title}</h1><div className="detail-hero-description" dangerouslySetInnerHTML={{ __html: sanitizeRichText(selectedVersion.description ?? '<p>暂无赛题详情。</p>') }} /></div><div className="detail-facts"><strong>{selectedVersion.estimatedMinutes ?? '—'}</strong><span>预计用时（分钟）</span><strong>v{selectedVersion.version}</strong><span>赛题版本</span></div></section><div className="detail-grid"><section className="panel detail-content"><div className="detail-section"><p className="kicker">训战目标</p><h2>训战目标</h2><ul>{(selectedVersion.objectives ?? ['暂无训战目标']).map((item) => <li key={item}>{item}</li>)}</ul></div><div className="detail-section"><p className="kicker">赛题要求</p><h2>赛题要求</h2><ul>{(selectedVersion.requirements ?? ['暂无赛题要求']).map((item) => <li key={item}>{item}</li>)}</ul></div><div className="detail-section"><p className="kicker">约束与评估</p><h2>约束与评估</h2><ul>{(selectedVersion.constraints ?? ['暂无评估说明']).map((item) => <li key={item}>{item}</li>)}</ul></div><div className="detail-section"><p className="kicker">交付内容</p><h2>交付内容</h2><ul>{(selectedVersion.deliverables ?? ['暂无交付说明']).map((item) => <li key={item}>{item}</li>)}</ul></div></section><aside className="panel delivery-choice"><p className="kicker">可选交付方式</p><h2>选择交付方式</h2><p className="choice-intro">提交后会锁定本次交付内容，后续评估以该版本为准。</p>{selectedUploadEvent && <button className="choice-card" onClick={() => openDelivery(selectedUploadEvent.id)}><span className="choice-icon">↑</span><span><strong>上传交付件</strong><small>支持 {selectedUploadEvent.deliveryConfig?.allowedFormats?.join(' / ') ?? 'zip'} 文件</small></span><b>→</b></button>}{selectedGitEvent && <div className="git-choice"><button className="choice-card" onClick={() => openDelivery(selectedGitEvent.id)}><span className="choice-icon git">⌘</span><span><strong>指定 Git 仓库</strong><small>提交时锁定分支版本</small></span><b>→</b></button><label>Git 仓库路径<input value={selectedGitEvent.deliveryConfig?.repository ?? ''} readOnly /><small className="muted">默认分支：{branchDisplayLabel(selectedGitEvent.deliveryConfig?.branchTemplate)}</small></label></div>}{!selectedUploadEvent && !selectedGitEvent && <div className="coming-box">交付尚未开放</div>}</aside></div></> : <div className="panel empty">训战不存在或尚未加载</div>}</main>}

      {view === 'profile' && <main className="content-page"><section className="profile-hero panel"><div className="profile-avatar">本</div><div><p className="kicker">个人资料</p><h1>{profile?.subject.name ?? '参训员工'}</h1><p>{profile?.subject.employeeNo ?? '参训员工'}</p></div><button className="primary compact" onClick={() => setView('challenges')}>继续参加训战</button></section><section className="profile-stats"><article className="panel"><span>赛季总积分</span><strong>{Math.round(totalPoints)}</strong><small>{currentRank ? `当前排名第 ${currentRank} 名` : '暂无排名'}</small></article><article className="panel"><span>平均成绩</span><strong>{profile?.stats.average ?? '—'}</strong><small>已完成 {profile?.stats.graded ?? 0} 场评估</small></article><article className="panel"><span>最高成绩</span><strong>{profile?.stats.best ?? '—'}</strong><small>赛季最高分</small></article></section><section className="panel section-panel history-panel"><div className="section-title"><div><p className="kicker">参赛历程</p><h2>参赛记录</h2></div></div>{profile?.history.slice().reverse().map((item) => <div className="history-row" key={item.submissionId}><span className="history-date">{formatDate(item.createdAt)}</span><div><strong>{eventTitle(events.find((event) => event.id === item.eventId) ?? { id: '', challengeVersion: '', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE', status: '' }, challenges)}</strong><small>评估结果已生成</small></div><b>{item.total} 分</b>{reports[item.submissionId] && <button className="small" onClick={() => void openReport(item.submissionId)}>查看报告</button>}</div>)}{(!profile || profile.history.length === 0) && <div className="empty">暂无参赛记录</div>}</section></main>}

       {view === 'report' && <main className="content-page report-page"><button className="back-link" onClick={() => setView('profile')}>← 返回个人中心</button>{reportSubmissionId && reports[reportSubmissionId] ? <><section className="report-hero panel"><div><p className="kicker">评估报告</p><h1>{eventTitle(events.find((event) => event.id === submissions.find((item) => item.id === reportSubmissionId)?.eventId) ?? { id: '', challengeVersion: '', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE', status: '' }, challenges)}</h1><p>本次交付 · {statusLabel(reports[reportSubmissionId].result.status)}</p></div><strong className="report-total">{reports[reportSubmissionId].result.total ?? '—'}<small>/100</small></strong></section><section className="report-grid"><div className="panel report-dimensions"><div className="section-title"><div><p className="kicker">能力维度</p><h2>评分拆解</h2></div></div>{Object.entries(reports[reportSubmissionId].result.dimensions ?? {}).map(([name, dimension]) => <div className="report-dimension" key={name}><span>{dimensionLabel(name)}</span><b>{dimension.evaluated === false ? '待补充评估' : `${dimension.score ?? '—'} / ${dimension.max ?? '—'}`}</b><div className="progress"><i style={{ width: `${dimension.evaluated === false ? 0 : ((dimension.score ?? 0) / (dimension.max ?? 100)) * 100}%` }} /></div></div>)}{reports[reportSubmissionId].report?.event && <p className="muted">本场排名第 {reports[reportSubmissionId].report.event.rank ?? '—'} 名 · 超过 {reports[reportSubmissionId].report.event.percentile ?? '—'}% 的参训员工 · 共 {reports[reportSubmissionId].report.event.participantCount} 人</p>}</div><div className="panel report-findings"><div className="section-title"><div><p className="kicker">问题摘要</p><h2>评估发现</h2></div></div>{(reports[reportSubmissionId].result.findings ?? []).map((finding, index) => <article className="finding" key={`${finding.title}-${index}`}><div><strong>{finding.title}</strong><span>{finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : severityLabel(finding.severity)}</span></div><p>{finding.detail}</p>{finding.fix && <small>改进建议：{finding.fix}</small>}</article>)}{(reports[reportSubmissionId].result.findings ?? []).length === 0 && <div className="empty">暂无改进项</div>}</div></section></> : <div className="panel empty">报告尚未生成，或当前不可见。</div>}</main>}
      {view === 'delivery' && <main className="content-page"><button className="back-link" onClick={() => setView(deliveryBackView)}>← 返回{deliveryBackView === 'hard-problem-detail' ? '难题详情' : '训战广场'}</button><section className="delivery-heading panel"><div><p className="kicker">提交交付 · {zoneLabel(selectedVersion?.zone)}</p><h1>{selectedVersion?.title ?? selectedEvent?.challengeVersion}</h1><p>提交后会锁定本次交付内容，后续评估以该版本为准。</p></div><div className="delivery-meta"><span>{eventModeLabel(selectedEvent?.mode)}</span><span>{selectedEvent ? sourceLabel(selectedEvent.submissionSource) : '—'}</span><span>{triggerLabel(selectedEvent?.trigger)}</span></div></section><div className="delivery-grid"><section className="panel delivery-form"><div className="section-title"><div><p className="kicker">提交交付</p><h2>创建提交</h2></div><span className="status-pill">{statusLabel(selectedEvent?.status ?? '—')}</span></div><label>{selectedEvent?.purpose === 'HARD_PROBLEM' ? '难题交付场次' : '训战场次'}<select value={eventId} onChange={(event) => openDelivery(event.target.value, deliveryBackView)}>{deliveryEvents.map((item) => <option key={item.id} value={item.id}>{eventTitle(item, challenges)}</option>)}</select></label><div className="segmented"><button className={source === 'UPLOAD' ? 'active' : ''} onClick={() => setSource('UPLOAD')}>上传交付件</button><button className={source === 'GIT_REF' ? 'active' : ''} onClick={() => setSource('GIT_REF')}>指定 Git 仓库</button></div>{source === 'UPLOAD' ? <label className="file-drop">交付包<input type="file" accept=".zip,.tar,.gz" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span>{file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : '未选择文件'}</span></label> : <div className="git-fields"><label>仓库路径<input value={git.repository} onChange={(event) => setGit({ ...git, repository: event.target.value })} /></label><label>分支<input value={git.branch} onChange={(event) => setGit({ ...git, branch: event.target.value })} /></label><label>提交版本<input value={git.commitSha} onChange={(event) => setGit({ ...git, commitSha: event.target.value })} /></label></div>}<button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在提交…' : selectedEvent?.purpose === 'HARD_PROBLEM' ? '提交解决方案' : '提交交付件'}</button>{message && <p className="message">{message}</p>}</section><section className="panel submissions"><div className="section-title"><div><p className="kicker">提交记录</p><h2>我的提交</h2></div><button className="quiet" onClick={() => void refresh()}>刷新</button></div>{submissions.filter((item) => item.eventId === eventId).length === 0 ? <div className="empty">暂无提交记录</div> : submissions.filter((item) => item.eventId === eventId).map((item) => <article className="submission" key={item.id}><div><strong>{item.subjectId === subjectId ? (profile?.subject.name ?? '参训员工') : '参训员工'}</strong><span className="muted">{sourceLabel(item.snapshot.sourceType === 'UPLOAD' ? 'UPLOAD' : 'GIT_REF')} · {formatDate(item.createdAt)}</span>{reports[item.id] && <span className="score">总分 {reports[item.id].result.total ?? '—'} / 100</span>}</div><div className="submission-actions"><span className={`state state-${item.state.toLowerCase()}`}>{item.resultId ? '已完成' : item.failureReason || item.gradingStatus === 'FAILED' ? '评估失败' : item.gradingStatus === 'RUNNING' ? '评估中' : item.gradingStatus === 'QUEUED' ? '排队中' : statusLabel(item.state)}</span>{item.resultId && reports[item.id] && <button className="small" onClick={() => void openReport(item.id)}>查看报告</button>}</div></article>)}</section></div></main>}

      {view === 'profile' && <div className="capability-standalone"><CapabilityPanel capabilities={capabilities} /></div>}
      {view === 'detailed-report' && <main className="content-page report-page"><button className="back-link" onClick={() => setView('profile')}>← 返回个人中心</button>{reportSubmissionId && reports[reportSubmissionId] ? <div className="report-standalone"><DetailedReport submissionId={reportSubmissionId} report={reports[reportSubmissionId]} title={eventTitle(events.find((event) => event.id === submissions.find((item) => item.id === reportSubmissionId)?.eventId) ?? { id: '', challengeVersion: '', submissionSource: 'UPLOAD', trigger: 'MANUAL', reveal: 'IMMEDIATE', status: '' }, challenges)} /></div> : <div className="panel empty">报告尚未生成，或当前不可见。</div>}</main>}
      <footer>AI 训战平台 · 企业内部训战与复盘</footer>
    </div>
  );
}

function CapabilityPanel({ capabilities }: { capabilities: CapabilityProfile | null }) {
  const dimensionLabels: Record<string, string> = { verify: '验证', spec: '规格', code: '工程', collab: '协作' };
  const strongest = capabilities?.dimensions.find((item) => item.key === capabilities.summary.strongestDimension);
  const focus = capabilities?.dimensions.find((item) => item.key === capabilities.summary.focusDimension);
  const strongestDomain = capabilities?.domains.find((item) => item.key === capabilities.summary.strongestDomain);
  const focusDomain = capabilities?.domains.find((item) => item.key === capabilities.summary.focusDomain);
  return <section className="panel capability-panel">
     <div className="section-title"><div><p className="kicker">AI 能力画像</p><h2>我的 AI 能力画像</h2><p className="capability-subtitle">基于训战评估记录汇总。</p></div>{capabilities?.lastUpdated && <span className="muted">最近更新 {formatDate(capabilities.lastUpdated)}</span>}</div>
    {!capabilities ? <div className="empty">能力画像加载中…</div> : <>
      <div className="capability-summary-grid">
        <div className="capability-radar-card"><CapabilityRadar dimensions={capabilities.dimensions} /><div className="radar-caption"><span><i className="radar-caption-me" />我的能力</span>{capabilities.dimensions.some((dimension) => dimension.peerMedianPercent !== null && dimension.peerMedianPercent !== undefined) && <span><i className="radar-caption-peer" />部门中位数</span>}</div></div>
        <div className="capability-overview">
           <div className="capability-score-head"><span>综合能力</span><strong>{capabilities.summary.overallAverage ?? '—'}<small>/100</small></strong><em>{capabilities.summary.delta === null ? '趋势数据不足' : `${capabilities.summary.delta >= 0 ? '↑' : '↓'} ${Math.abs(capabilities.summary.delta)} 分 · 最近两场`}</em></div>
          <div className="capability-fact-grid"><div><span>已评估场次</span><strong>{capabilities.summary.gradedSubmissions}</strong></div><div><span>最近成绩</span><strong>{capabilities.summary.latestTotal ?? '—'}</strong></div><div><span>优势维度</span><strong>{strongest?.label ?? '待形成'}</strong></div><div><span>提升重点</span><strong>{focus?.label ?? '待形成'}</strong></div><div><span>优势能力域</span><strong>{strongestDomain?.shortLabel ?? '待形成'}</strong></div><div><span>提升重点域</span><strong>{focusDomain?.shortLabel ?? '待形成'}</strong></div><div><span>黄区 / 蓝区场次</span><strong>{capabilities.zoneStats?.YELLOW ?? 0} / {capabilities.zoneStats?.BLUE ?? 0}</strong></div><div><span>已完成评估的能力项</span><strong>{capabilities.summary.evaluatedSkillItems ?? 0} / {capabilities.summary.totalSkillItems ?? 16}</strong></div></div>
          <div className="capability-peer-stats"><div><span>部门平均</span><strong>{capabilities.summary.departmentAverage ?? '—'}</strong></div><div><span>部门中位数</span><strong>{capabilities.summary.departmentMedian ?? '—'}</strong></div><div><span>部门百分位</span><strong>{capabilities.summary.departmentPercentile === null || capabilities.summary.departmentPercentile === undefined ? '—' : `${capabilities.summary.departmentPercentile}%`}</strong></div></div>
          <div className="capability-dimension-list">{capabilities.dimensions.map((dimension) => <div className="capability-dimension-row" key={dimension.key}><span className="capability-dot" data-tone={dimension.key} /><div><strong>{dimension.label}</strong><small>{dimension.description}{dimension.peerMedianPercent !== null && dimension.peerMedianPercent !== undefined ? ` · 部门中位数 ${dimension.peerMedianPercent}` : ''}</small></div><b>{dimension.percent === null ? '待评估' : `${dimension.percent} 分`}{dimension.vsPeerMedian !== null && dimension.vsPeerMedian !== undefined && <em className={dimension.vsPeerMedian >= 0 ? 'capability-up' : 'capability-down'}>{dimension.vsPeerMedian >= 0 ? ' ↑' : ' ↓'}{Math.abs(dimension.vsPeerMedian)}</em>}</b></div>)}</div>
        </div>
      </div>
      <section className="capability-domains-card"><div className="mini-heading"><div><p className="kicker">8 个 AI 能力域</p><h3>AI 能力域总览</h3></div><span>{capabilities.summary.evaluatedCapabilityDomains ?? 0} / {capabilities.summary.totalCapabilityDomains ?? 8} 个能力域已评估</span></div><p className="capability-domain-note">按已公布评估记录汇总。</p><div className="capability-domain-grid">{capabilities.domains.map((domain, index) => <article className={`capability-domain-card capability-domain-${domain.percent === null ? 'pending' : domain.percent >= 85 ? 'strong' : domain.percent >= 60 ? 'stable' : 'focus'}`} key={domain.key}><div className="capability-domain-head"><span className="capability-domain-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{domain.label}</strong><small>{domain.description}</small></div><b>{domain.percent === null ? '—' : `${domain.percent}`}</b></div><div className="domain-track"><i style={{ width: `${domain.percent ?? 0}%` }} /></div><div className="capability-domain-meta"><span>{domain.status}</span><span>已评估 {domain.evidenceCount} / {domain.criterionKeys.length} 项能力</span>{domain.peerMedianPercent !== null && domain.peerMedianPercent !== undefined && <span>部门中位数 {domain.peerMedianPercent}</span>}</div></article>)}</div></section>
       <div className="capability-detail-grid"><section className="capability-chart-card"><div className="mini-heading"><div><p className="kicker">能力趋势</p><h3>综合能力趋势</h3></div><span>按参训记录</span></div><CapabilityTrend trend={capabilities.trend} /></section><section className="capability-chart-card"><div className="mini-heading"><div><p className="kicker">评分点明细</p><h3>能力项明细</h3></div><span>{capabilities.summary.evaluatedSkillItems ?? 0} / {capabilities.summary.totalSkillItems ?? 16} 已评估</span></div><div className="skill-list">{capabilities.skills.filter((skill) => skill.percent !== null).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0)).slice(0, 6).map((skill) => <div className="skill-row" key={skill.key}><div><strong>{skill.name}</strong><small>{dimensionLabels[skill.dimension] ?? skill.dimension} · {skill.averageLevel ?? '—'} 档 · {skill.sampleCount} 次</small></div><div className="skill-track"><i style={{ width: `${skill.percent ?? 0}%` }} /></div><b>{skill.percent ?? '—'}</b></div>)}{capabilities.skills.every((skill) => skill.percent === null) && <div className="empty compact-empty">暂无评分点数据</div>}</div></section></div>
       <section className="capability-matrix-card"><div className="mini-heading"><div><p className="kicker">16 项能力评分点</p><h3>16 个评分点的历史档位</h3></div><span>四类能力</span></div><div className="grade-matrix">{capabilities.skills.map((skill) => <div className={`grade-cell grade-${(skill.averageLevel ?? 'N').toLowerCase()}`} key={skill.key} title={skill.description}><strong>{skill.name}</strong><b>{skill.averageLevel ?? '—'}</b><small>{skill.percent === null ? '待评估' : `${skill.percent} · ${skill.sampleCount} 场`}</small></div>)}</div><div className="grade-legend"><span><i className="legend-a" />A 优秀</span><span><i className="legend-b" />B 合格</span><span><i className="legend-c" />C 待提升</span><span><i className="legend-d" />D 未做到</span><span><i className="legend-n" />— 待评估</span></div></section>
       <section className="capability-recommendation-card"><div className="mini-heading"><div><p className="kicker">提升重点</p><h3>薄弱项与练习建议</h3></div><span>基于历史平均档位</span></div>{(capabilities.weakItems ?? []).length === 0 ? <div className="empty compact-empty">暂无练习建议</div> : <div className="weak-item-list">{capabilities.weakItems?.map((item) => <article className="weak-item" key={item.key}><span className={`weak-score weak-score-${(item.averageLevel ?? 'n').toLowerCase()}`}>{item.averageLevel ?? '—'}</span><div><strong>{item.name}</strong><p>{item.recommendation}</p></div><b>{item.percent} 分</b></article>)}</div>}</section>
    </>}
  </section>;
}

function CapabilityRadar({ dimensions }: { dimensions: CapabilityDimension[] }) {
  const width = 260;
  const center = width / 2;
  const radius = 82;
  const items = dimensions.length ? dimensions : [
    { key: 'verify', label: '验证能力', percent: null },
    { key: 'spec', label: '规格能力', percent: null },
    { key: 'code', label: '工程能力', percent: null },
    { key: 'collab', label: '协作能力', percent: null },
  ] as CapabilityDimension[];
  const hasPeerMedian = items.some((dimension) => dimension.peerMedianPercent !== null && dimension.peerMedianPercent !== undefined);
  const point = (index: number, value: number): [number, number] => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / items.length;
    return [center + Math.cos(angle) * radius * value, center + Math.sin(angle) * radius * value];
  };
  const polygon = (value: (dimension: CapabilityDimension) => number): string => items.map((dimension, index) => point(index, value(dimension)).join(',')).join(' ');
  return <div className="radar-wrap"><svg className="capability-radar" viewBox={`0 0 ${width} ${width}`} role="img" aria-label="AI 能力雷达图">
    {[0.25, 0.5, 0.75, 1].map((ring) => <polygon key={ring} points={polygon(() => ring)} className="radar-ring" />)}
    {items.map((dimension, index) => { const [x, y] = point(index, 1); const [lx, ly] = point(index, 1.18); return <g key={dimension.key}><line x1={center} y1={center} x2={x} y2={y} className="radar-axis" /><text x={lx} y={ly} className="radar-label" textAnchor="middle">{dimension.label.replace('能力', '')}</text></g>; })}
    {hasPeerMedian && <polygon points={polygon((dimension) => (dimension.peerMedianPercent ?? 0) / 100)} className="radar-peer" />}
    <polygon points={polygon((dimension) => (dimension.percent ?? 0) / 100)} className="radar-value" />
    {items.map((dimension, index) => { const [x, y] = point(index, (dimension.percent ?? 0) / 100); return <circle key={dimension.key} cx={x} cy={y} r="3.5" className="radar-point" />; })}
  </svg><div className="radar-scale"><span>100</span><span>75</span><span>50</span><span>25</span></div></div>;
}

function CapabilityTrend({ trend }: { trend: CapabilityProfile['trend'] }) {
  if (!trend.length) return <div className="empty compact-empty">暂无趋势数据</div>;
  const width = 520;
  const height = 150;
  const points = trend.map((item, index) => {
    const x = trend.length === 1 ? width / 2 : 22 + (index / (trend.length - 1)) * (width - 44);
    const total = item.total ?? 0;
    const y = height - 24 - Math.max(0, Math.min(100, total)) / 100 * (height - 45);
    return { x, y, item };
  });
  return <div className="trend-wrap"><svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="综合能力趋势图"><line x1="22" y1={height - 24} x2={width - 22} y2={height - 24} className="trend-axis" /><line x1="22" y1="18" x2="22" y2={height - 24} className="trend-axis" /><polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} className="trend-line" />{points.map((point) => <g key={point.item.submissionId}><circle cx={point.x} cy={point.y} r="4" className={`trend-point trend-point-${point.item.zone === 'BLUE' ? 'blue' : 'yellow'}`} /><text x={point.x} y={height - 7} className="trend-label" textAnchor="middle">{formatDate(point.item.createdAt)}</text><text x={point.x} y={point.y - 9} className="trend-value" textAnchor="middle">{point.item.total ?? '—'}</text></g>)}</svg><div className="trend-legend"><span>100</span><span>50</span><span>0</span><span className="trend-zone-legend"><i className="trend-legend-blue" />蓝区 <i className="trend-legend-yellow" />黄区</span></div></div>;
}

function DetailedReport({ submissionId, report, title }: { submissionId: string; report: Report; title: string }) {
  const summary = report.report?.summary;
  const event = report.report?.event;
  const details = report.report?.dimensionBreakdown ?? Object.entries(report.result.dimensions ?? {}).map(([key, dimension]) => ({ key, label: key, score: dimension.score, max: dimension.max ?? null, evaluated: dimension.evaluated !== false, percent: dimension.max ? Number(((dimension.score ?? 0) / dimension.max * 100).toFixed(2)) : null, criteriaCount: 0, findingsCount: 0 }));
  const criteria = report.result.criteria ?? [];
  const findings = report.result.findings ?? [];
  const diagnostics = report.report?.diagnostics ?? report.result.validationDiagnostics ?? [];
  const recommendations = report.report?.recommendations ?? [];
  return <>
    <section className="report-hero panel report-hero-detailed"><div><p className="kicker">详细评估报告</p><h1>{title}</h1><p>本次交付 · {statusLabel(report.result.status)} · {summary?.grade ?? '评估完成'}</p></div><strong className="report-total">{report.result.total ?? '—'}<small>/100</small></strong></section>
    <section className="report-summary-cards"><article className="panel report-summary-card"><span>本次得分率</span><strong>{summary?.passRate ?? '—'}<small>%</small></strong><em>已评估维度</em></article><article className="panel report-summary-card"><span>场次排名</span><strong>{event?.rank ?? '—'}<small>{event?.participantCount ? ` / ${event.participantCount}` : ''}</small></strong><em>{event?.percentile ? `超过 ${event.percentile}% 的参训员工` : '暂无排名数据'}</em></article><article className="panel report-summary-card"><span>部门对比</span><strong>{report.report?.department?.average ?? '—'}<small>{report.report?.department?.percentile === null || report.report?.department?.percentile === undefined ? '' : ` · ${report.report.department.percentile}%`}</small></strong><em>{report.report?.department?.participantCount ? `部门平均 · ${report.report.department.participantCount} 人` : '暂无部门数据'}</em></article><article className="panel report-summary-card"><span>问题与提示</span><strong>{summary?.findingCount ?? findings.length}<small> 项问题</small></strong><em>{summary?.diagnosticCount ?? diagnostics.length} 条处理提示</em></article></section>
    <section className="report-detail-grid"><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">能力维度</p><h3>能力维度拆解</h3></div><span>{summary?.evaluatedDimensions ?? details.filter((item) => item.evaluated).length} / {summary?.totalDimensions ?? details.length} 已评估</span></div>{details.map((dimension) => <div className="detail-dimension-row" key={dimension.key}><div className="detail-dimension-head"><span>{dimension.label}</span><b>{dimension.evaluated ? `${dimension.score ?? '—'} / ${dimension.max ?? '—'}` : '待补充评估'}</b></div><div className="progress"><i style={{ width: `${dimension.percent ?? 0}%` }} /></div><small>{dimension.evaluated ? `${dimension.percent ?? 0}% · ${dimension.criteriaCount} 个评分项 · ${dimension.findingsCount} 项问题` : '待补充评估'}</small></div>)}</section><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">提交信息</p><h3>交付与评估信息</h3></div><span>{statusLabel(report.report?.submission?.state)}</span></div><dl className="report-meta-list"><dt>提交来源</dt><dd>{report.report?.submission?.sourceType === 'GIT_REF' ? '指定 Git 仓库' : '上传交付件'}</dd><dt>提交时间</dt><dd>{report.report?.submission?.submittedAt ? new Date(report.report.submission.submittedAt).toLocaleString('zh-CN') : '—'}</dd>{report.report?.submission?.repository && <><dt>仓库 / 分支</dt><dd className="mono">{report.report.submission.repository} · {report.report.submission.branch}</dd></>}{report.report?.submission?.commitSha && <><dt>提交版本</dt><dd className="mono">{report.report.submission.commitSha}</dd></>}<dt>评分标准</dt><dd>{report.result.rubricVersion ?? '已配置'}</dd></dl></section></section>
    <section className="panel report-criteria-card"><div className="mini-heading"><div><p className="kicker">16 个评分点</p><h3>评分点档位矩阵</h3></div><span>{report.report?.gradeMatrix?.length ?? criteria.length} 个评分点</span></div>{report.report?.gradeMatrix?.length ? <div className="grade-matrix report-grade-matrix">{report.report.gradeMatrix.map((criterion) => <div className={`grade-cell grade-${(criterion.level ?? 'n').toLowerCase()}`} key={`${criterion.dim}:${criterion.key}`}><strong>{criterion.name}</strong><b>{criterion.level ?? '—'}</b><small>{criterion.score === null ? '未提供评分' : `${criterion.score} / ${criterion.max}`}</small></div>)}</div> : <div className="empty compact-empty">暂无评分点数据</div>}</section>
    <section className="panel report-criteria-card"><div className="mini-heading"><div><p className="kicker">评分项证据</p><h3>评分项与证据</h3></div><span>{criteria.length} 个评分项</span></div>{criteria.length === 0 ? <div className="empty compact-empty">暂无可展示的评分项</div> : <div className="report-table-wrap"><table className="report-table"><thead><tr><th>维度与评分项</th><th>档位</th><th>得分</th><th>来源</th><th>判据</th><th>证据</th></tr></thead><tbody>{criteria.map((criterion) => <tr key={criterion.key}><td><strong>{criterion.name}</strong><small>{dimensionLabel(criterion.dim)}</small></td><td><span className="level-badge">{criterion.level ?? '—'}</span></td><td><b>{criterion.score} / {criterion.max}</b></td><td>{evidenceSourceLabel(criterion.source)}</td><td><span>{criterion.rule ?? '—'}</span>{criterion.rationale && <small>{criterion.rationale}</small>}</td><td className="evidence-cell">{criterion.evidence ? evidenceSummary(criterion.evidence) : evidenceTypeLabel(criterion.evidenceType)}</td></tr>)}</tbody></table></div>}</section>
    <section className="report-detail-grid"><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">问题与改进</p><h3>问题定位与改进建议</h3></div><span>{findings.length} 项问题</span></div>{findings.length === 0 ? <div className="empty compact-empty">暂无需要改进的问题</div> : findings.map((finding, index) => <article className="finding finding-detailed" key={`${finding.id ?? finding.title}-${index}`}><div><strong>{finding.title}</strong><span>{finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : severityLabel(finding.severity)}</span></div><p>{finding.detail}</p>{finding.snippet && <code>{finding.snippet}</code>}{finding.fix && <small>改进建议：{finding.fix}</small>}</article>)}{recommendations.length > 0 && <div className="recommendation-box"><strong>优先改进建议</strong>{recommendations.slice(0, 5).map((recommendation) => <p key={recommendation}>→ {recommendation}</p>)}</div>}</section><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">评估提示</p><h3>处理过程与提示</h3></div><span>{diagnostics.length} 条提示</span></div>{diagnostics.length === 0 ? <div className="empty compact-empty">暂无评估提示</div> : diagnostics.map((diagnostic, index) => <div className="diagnostic-row" key={`${diagnostic.code}-${index}`}><span className={`diagnostic-severity severity-${diagnostic.severity.toLowerCase()}`}>{severityLabel(diagnostic.severity)}</span><div><p>{diagnostic.message}</p>{diagnostic.path && <small>{diagnostic.path}</small>}</div></div>)}<div className="runtime-facts"><span>开始时间 {report.result.startedAt ? new Date(report.result.startedAt).toLocaleString('zh-CN') : '—'}</span><span>结束时间 {report.result.finishedAt ? new Date(report.result.finishedAt).toLocaleString('zh-CN') : '—'}</span><span>评估方式 {graderLabel(report.result.gradedBy)}</span></div></section></section>
    <section className="report-detail-grid report-objective-grid"><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">客观指标</p><h3>验证与交付指标</h3></div></div><pre className="report-json">{JSON.stringify(report.report?.objectiveMetrics ?? { metrics: report.result.metrics ?? null, verifyDetail: report.result.verifyDetail ?? null }, null, 2)}</pre></section><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">提交时间线</p><h3>版本与提交记录</h3></div></div><div className="commit-timeline">{(report.report?.commitTimeline ?? []).map((item, index) => <div className="commit-timeline-row" key={`${String(item.commitSha ?? item.at ?? index)}-${index}`}><span>{String(item.at ?? item.createdAt ?? '—')}</span><code>{String(item.commitSha ?? '交付件版本')}</code><small>{String(item.repository ?? '')}{item.branch ? ` · ${String(item.branch)}` : ''}</small></div>)}</div>{!(report.report?.commitTimeline?.length) && <div className="empty compact-empty">暂无版本记录</div>}</section></section>
    {(report.result.verifyDetail || report.result.metrics || (report.result.extractions && report.result.extractions.length > 0)) && <details className="report-technical-details"><summary>查看原始评估明细</summary><section className="report-detail-grid report-technical-grid"><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">评估明细</p><h3>验证结果</h3></div></div><pre className="report-json">{JSON.stringify(report.result.verifyDetail ?? {}, null, 2)}</pre></section><section className="panel report-detail-card"><div className="mini-heading"><div><p className="kicker">评估明细</p><h3>代码与交付指标</h3></div></div><pre className="report-json">{JSON.stringify(report.result.metrics ?? {}, null, 2)}</pre></section></section></details>}
  </>;
}


function hardProblemDifficultyLabel(difficulty: HardProblem['difficulty']): string {
  return ({ HIGH: '高优先级', MEDIUM: '中优先级', LOW: '一般' } as Record<HardProblem['difficulty'], string>)[difficulty];
}

function hardProblemPublisherLabel(problem: HardProblem): string {
  return `${problem.publisherType === 'DEPARTMENT' ? '部门发布' : '员工发布'} · ${displayPersonName(problem.publisherName)}`;
}

function hardProblemSolutionVisibilityLabel(visibility: HardProblem['solutionVisibility']): string {
  return visibility === 'HIDDEN' ? '交付件不公开' : '交付件公开';
}

function hardProblemSolutionSourceLabel(solution?: HardProblemSolution): string {
  if (!solution) return '未记录交付件';
  if (solution.sourceType === 'GIT_REF') return solution.repository ? `Git：${solution.repository}${solution.branch ? ` · ${solution.branch}` : ''}` : 'Git 仓库交付';
  return solution.artifactName ? `上传：${solution.artifactName}` : '上传交付件';
}

function HardProblemDetailPageV2({ problem, event, onBack, onSubmit }: { problem: HardProblem; event?: EventConfig; onBack: () => void; onSubmit: () => void }) {
  const resolved = problem.status === 'RESOLVED';
  const canSubmit = !resolved && event?.status === 'OPEN';
  return <main className="content-page hard-problem-detail-page">
    <button className="back-link" onClick={onBack}>← 返回难题榜</button>
     <section className="hard-problem-detail-hero panel"><div><div className="detail-tags"><span className="problem-source-label">难题榜</span><span className={`problem-difficulty difficulty-${problem.difficulty.toLowerCase()}`}>{hardProblemDifficultyLabel(problem.difficulty)}</span><span className={`problem-open-label ${resolved ? 'resolved' : ''}`}>{resolved ? '揭榜成功' : '待揭榜'}</span></div><h1>{problem.title}</h1><p>{problem.summary}</p></div><div className="hard-problem-detail-action"><span>{resolved ? `揭榜人：${problem.solverName ?? '参训员工'}` : `发布者：${hardProblemPublisherLabel(problem)}`}</span></div></section>
     <div className="hard-problem-detail-grid"><section className="panel hard-problem-detail-content"><div className="detail-section"><p className="kicker">问题背景</p><h2>问题详情</h2><p>{problem.details ?? problem.summary}</p></div><div className="detail-section"><p className="kicker">交付说明</p><h2>解决方案要求</h2><ul><li>提交可复现的解决方案交付件。</li><li>说明关键假设、验证方式和已知风险。</li><li>提交后会按照本题规则完成评估，并保留复盘记录。</li></ul></div><div className="detail-section"><p className="kicker">问题标签</p><div className="hard-problem-tags">{problem.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div>{resolved && <section className="hard-problem-solution panel"><div className="mini-heading"><div><p className="kicker">揭榜结果</p><h2>揭榜成功</h2></div><span className="problem-open-label resolved">已完成</span></div><dl className="hard-problem-solution-facts"><dt>揭榜人</dt><dd>{problem.solverName ?? '参训员工'}</dd><dt>揭榜时间</dt><dd>{problem.resolvedAt ? formatDateTime(problem.resolvedAt) : '—'}</dd><dt>交付件策略</dt><dd>{hardProblemSolutionVisibilityLabel(problem.solutionVisibility)}</dd></dl>{problem.solutionVisibility === 'HIDDEN' ? <div className="solution-hidden-note">交付件不公开，仅展示揭榜人和完成状态。</div> : problem.solution ? <div className="solution-artifact"><strong>{hardProblemSolutionSourceLabel(problem.solution)}</strong><span>提交时间：{formatDateTime(problem.solution.submittedAt)}</span></div> : <div className="empty compact-empty">暂无可展示交付件</div>}</section>}</section><aside className="panel hard-problem-detail-aside"><p className="kicker">{resolved ? '揭榜结果' : '交付入口'}</p><h2>{resolved ? '已揭榜' : '提交解决方案'}</h2><p>{resolved ? '该难题已经有解决方案完成揭榜。' : '支持上传 ZIP 交付件，提交后会锁定本次交付内容。'}</p><dl className="hard-problem-facts"><dt>当前状态</dt><dd>{resolved ? '揭榜成功' : '等待解决'}</dd>{resolved && <><dt>揭榜人</dt><dd>{problem.solverName ?? '参训员工'}</dd><dt>交付展示</dt><dd>{hardProblemSolutionVisibilityLabel(problem.solutionVisibility)}</dd></>}{!resolved && <><dt>交付状态</dt><dd>{event?.status === 'OPEN' ? '可提交' : '交付入口准备中'}</dd></>}</dl>{!resolved && <button className="primary" disabled={!canSubmit} onClick={onSubmit}>{canSubmit ? '提交解决方案' : '暂不可提交'}</button>}</aside></div>
  </main>;
}

function HardProblemsPageV2({ problems, onRefresh, onOpenChallenge }: { problems: HardProblem[]; onRefresh: () => void; onOpenChallenge: (problemId: string) => void }) {
  const [tab, setTab] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const openProblems = problems.filter((problem) => problem.status === 'OPEN');
  const resolvedProblems = problems.filter((problem) => problem.status === 'RESOLVED');
  const visibleProblems = tab === 'OPEN' ? openProblems : resolvedProblems;
  return <main className="content-page hard-problems-page">
    <section className="page-heading"><div><p className="kicker">难题榜</p><h1>难题榜</h1></div><div className="heading-count"><strong>{visibleProblems.length}</strong><span>{tab === 'OPEN' ? '个待揭榜难题' : '个揭榜成功难题'}</span></div></section>
    <section className="hard-problem-toolbar panel"><div><strong>难题状态</strong><span>{tab === 'OPEN' ? '待揭榜' : '揭榜成功'}</span></div><button className="quiet" onClick={onRefresh}>刷新难题榜</button></section>
    <div className="hard-problem-tabs" role="tablist" aria-label="难题榜状态"><button className={tab === 'OPEN' ? 'active' : ''} role="tab" aria-selected={tab === 'OPEN'} onClick={() => setTab('OPEN')}>待揭榜 <em>{openProblems.length}</em></button><button className={tab === 'RESOLVED' ? 'active' : ''} role="tab" aria-selected={tab === 'RESOLVED'} onClick={() => setTab('RESOLVED')}>揭榜成功 <em>{resolvedProblems.length}</em></button></div>
     {visibleProblems.length === 0 ? <section className="panel empty hard-problem-empty">{tab === 'OPEN' ? '暂无待揭榜难题' : '暂无揭榜成功难题'}</section> : <section className="hard-problem-list">{visibleProblems.map((problem, index) => <article className="hard-problem-card panel is-clickable" key={problem.id} role="button" tabIndex={0} onClick={() => onOpenChallenge(problem.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenChallenge(problem.id); } }}><div className="hard-problem-card-head"><div className="hard-problem-rank">{String(index + 1).padStart(2, '0')}</div><div className="hard-problem-title-wrap"><div className="hard-problem-labels"><span className="problem-source-label">难题榜</span><span className={`problem-difficulty difficulty-${problem.difficulty.toLowerCase()}`}>{hardProblemDifficultyLabel(problem.difficulty)}</span><span className={`problem-open-label ${problem.status === 'RESOLVED' ? 'resolved' : ''}`}>{problem.status === 'RESOLVED' ? '揭榜成功' : '待揭榜'}</span></div><h2>{problem.title}</h2><p>{problem.summary}</p></div><button className="problem-expand" onClick={(event) => { event.stopPropagation(); onOpenChallenge(problem.id); }}>{problem.status === 'RESOLVED' ? '查看揭榜 →' : '进入难题 →'}</button></div><div className="hard-problem-meta"><span><b>发布者</b>{hardProblemPublisherLabel(problem)}</span><span><b>{problem.status === 'RESOLVED' ? '揭榜人' : '所属部门'}</b>{problem.status === 'RESOLVED' ? (problem.solverName ?? '参训员工') : (problem.departmentName ?? '未注明')}</span><span><b>{problem.status === 'RESOLVED' ? '揭榜时间' : '发布时间'}</b>{formatDateTime(problem.status === 'RESOLVED' ? (problem.resolvedAt ?? problem.updatedAt) : problem.createdAt)}</span><span><b>{problem.status === 'RESOLVED' ? '交付件' : '最近更新'}</b>{problem.status === 'RESOLVED' ? hardProblemSolutionSourceLabel(problem.solutionVisibility === 'HIDDEN' ? undefined : problem.solution) : formatDateTime(problem.updatedAt)}</span></div><div className="hard-problem-tags">{problem.tags.map((tag) => <span key={tag}>{tag}</span>)}{problem.status === 'RESOLVED' && <span className="solution-visibility-tag">{hardProblemSolutionVisibilityLabel(problem.solutionVisibility)}</span>}</div></article>)}</section>}
  </main>;
}

function ChallengeCard({ event, title, version, onOpen, large = false }: { event?: EventConfig; title: string; version?: ChallengeVersion; onOpen: (versionId: string) => void; large?: boolean }) {
  const canOpen = Boolean(version && event && ['OPEN', 'RELEASED'].includes(event.status));
  const status = event?.status === 'OPEN' ? '进行中' : event?.status === 'RELEASED' ? '已完成' : event?.status === 'CLOSED' ? '已关闭' : '即将开放';
  const statusClass = event?.status === 'RELEASED' ? 'completed' : event?.status === 'CLOSED' ? 'closed' : !event ? 'upcoming' : '';
  const language = languageLabel(version?.languagePolicy?.languages?.[0]);
  const openFromCard = () => { if (canOpen && version) onOpen(version.id); };
  return <article className={`challenge-card panel ${large ? 'large' : ''} ${canOpen ? 'is-clickable' : ''}`} onClick={(clickEvent) => { if (!(clickEvent.target as HTMLElement).closest('button')) openFromCard(); }} onKeyDown={(keyEvent) => { if ((keyEvent.key === 'Enter' || keyEvent.key === ' ') && canOpen) { keyEvent.preventDefault(); openFromCard(); } }} tabIndex={canOpen ? 0 : undefined} aria-label={canOpen ? `进入训战：${title}` : undefined}>
    <div className="challenge-top"><span className="zone-tag">{zoneLabel(version?.zone)}</span><span className={`challenge-status ${statusClass}`}>{status}</span></div>
    <h3>{title}</h3>
    <p className="challenge-desc">{richTextPreview(version?.description ?? '') || '暂无赛题简介'}</p>
     <div className="challenge-meta"><span>类型：{event ? eventModeLabel(event.mode) : '类型待定'}</span><span>时间：{eventTimeLabel(event)}</span><span>提交：{event ? sourceLabel(event.submissionSource) : '提交方式待定'}</span><span>评估：{event ? triggerLabel(event.trigger) : '评估方式待定'}</span><span>语言：{language}</span></div>
     <div className="challenge-footer"><span>评分标准</span>{canOpen && version ? <button className="small" onClick={() => onOpen(version.id)}>{event?.status === 'OPEN' ? '进入训战 →' : '查看训战 →'}</button> : <span className={`challenge-lock-note ${statusClass}`}>暂不可查看</span>}</div>
  </article>;
}

createRoot(document.getElementById('root')!).render(<App />);
