/**
 * Versioned capability catalog used to turn rubric evidence into an employee
 * AI capability profile.  The four rubric dimensions remain the scoring
 * source of truth; these eight domains are a product-facing aggregation layer
 * and must never manufacture a score when there is no criterion evidence.
 */

export const CAPABILITY_CATALOG_VERSION = '1.0';

export type RubricDimension = 'verify' | 'spec' | 'code' | 'collab';

export type CapabilityCriterion = {
  key: string;
  dimension: RubricDimension;
  name: string;
  max: number;
  description: string;
  /** Product-facing domain(s) that can use this rubric evidence. */
  domainKeys: readonly string[];
};

export type CapabilityDomain = {
  key: string;
  label: string;
  shortLabel: string;
  description: string;
  /**
   * Current v1 domains are derived from existing V/S/C/P rubric evidence.
   * Future direct evidence can be added without changing the profile shape.
   */
  evidenceMode: 'derived' | 'direct';
  criterionKeys: readonly string[];
};

export const CAPABILITY_DOMAINS: readonly CapabilityDomain[] = [
  {
    key: 'ai_literacy',
    label: 'AI 认知与选型',
    shortLabel: 'AI 认知',
    description: '理解 AI 的能力边界，能根据任务选择合适的模型、工具和协作方式。',
    evidenceMode: 'derived',
    criterionKeys: ['collab:P1', 'collab:P2'],
  },
  {
    key: 'task_decomposition',
    label: '任务理解与拆解',
    shortLabel: '任务拆解',
    description: '把目标、约束、假设和变化点拆成可执行、可验收的任务。',
    evidenceMode: 'derived',
    criterionKeys: ['spec:S1', 'spec:S2', 'spec:S4'],
  },
  {
    key: 'prompt_engineering',
    label: '提示词与上下文工程',
    shortLabel: '提示词',
    description: '组织角色、上下文、约束、示例、输出格式和自检步骤，帮助 AI 稳定产出。',
    evidenceMode: 'derived',
    criterionKeys: ['collab:P1', 'collab:P3'],
  },
  {
    key: 'retrieval_fact_checking',
    label: '检索与事实核验',
    shortLabel: '检索核验',
    description: '主动检索可信资料，验证引用、假设和边界事实，避免把模型猜测当结论。',
    evidenceMode: 'derived',
    criterionKeys: ['verify:V3', 'spec:S3'],
  },
  {
    key: 'tool_orchestration',
    label: '工具与 Agent 编排',
    shortLabel: '工具编排',
    description: '将 AI 与代码、测试、检索、自动化工具组合成可重复的工作流。',
    evidenceMode: 'derived',
    criterionKeys: ['collab:P2', 'collab:P4'],
  },
  {
    key: 'output_evaluation',
    label: '输出评审与测试',
    shortLabel: '评审测试',
    description: '用测试、边界用例、回归和证据检查 AI 产出，而不是直接照单全收。',
    evidenceMode: 'derived',
    criterionKeys: ['verify:V1', 'verify:V2', 'verify:V3', 'verify:V4'],
  },
  {
    key: 'engineering_delivery',
    label: '工程交付与自动化',
    shortLabel: '工程交付',
    description: '把 AI 产出沉淀为可维护、可测试、可发布和可持续迭代的工程交付物。',
    evidenceMode: 'derived',
    criterionKeys: ['code:C1', 'code:C2', 'code:C3', 'code:C4'],
  },
  {
    key: 'security_compliance',
    label: '安全、合规与风险',
    shortLabel: '安全合规',
    description: '识别数据、权限、隐私、版权和运行风险，并采取最小权限与可审计措施。',
    evidenceMode: 'derived',
    criterionKeys: ['spec:S3', 'verify:V2', 'code:C2'],
  },
] as const;

export const CAPABILITY_ITEMS: readonly CapabilityCriterion[] = [
  { key: 'V1', dimension: 'verify', name: '功能验证', max: 8, description: '核心功能与基础用例验证', domainKeys: ['output_evaluation'] },
  { key: 'V2', dimension: 'verify', name: '边界验证', max: 12, description: '边界条件、异常输入与跨天行为', domainKeys: ['output_evaluation', 'security_compliance'] },
  { key: 'V3', dimension: 'verify', name: '澄清验证', max: 12, description: '需求澄清后对隐含规则的验证', domainKeys: ['retrieval_fact_checking', 'output_evaluation'] },
  { key: 'V4', dimension: 'verify', name: '变更验证', max: 8, description: '需求变化后的回归与适应能力', domainKeys: ['output_evaluation'] },
  { key: 'S1', dimension: 'spec', name: '歧义澄清', max: 10, description: '识别并记录需求歧义、假设和决策', domainKeys: ['task_decomposition'] },
  { key: 'S2', dimension: 'spec', name: '验收用例', max: 8, description: '把需求转成可执行、可验证的验收用例', domainKeys: ['task_decomposition'] },
  { key: 'S3', dimension: 'spec', name: '边界覆盖', max: 4, description: '覆盖异常、边界和失败路径', domainKeys: ['retrieval_fact_checking', 'security_compliance'] },
  { key: 'S4', dimension: 'spec', name: '变更锚点', max: 3, description: '定位变更影响范围和回归锚点', domainKeys: ['task_decomposition'] },
  { key: 'C1', dimension: 'code', name: '业务常量抽取', max: 6, description: '抽取业务常量并表达领域语义', domainKeys: ['engineering_delivery'] },
  { key: 'C2', dimension: 'code', name: '异常与边界', max: 5, description: '显式处理异常、无效输入和边界状态', domainKeys: ['engineering_delivery', 'security_compliance'] },
  { key: 'C3', dimension: 'code', name: '精度与类型', max: 4, description: '选择正确的精度策略和类型表达', domainKeys: ['engineering_delivery'] },
  { key: 'C4', dimension: 'code', name: '变更适应', max: 5, description: '保持低复杂度、可维护和可扩展', domainKeys: ['engineering_delivery'] },
  { key: 'P1', dimension: 'collab', name: '规格先行', max: 4, description: '先确认目标、约束、接口和验收标准', domainKeys: ['ai_literacy', 'prompt_engineering'] },
  { key: 'P2', dimension: 'collab', name: '迭代节奏', max: 4, description: '通过小步验证控制与 AI 的协作节奏', domainKeys: ['ai_literacy', 'tool_orchestration'] },
  { key: 'P3', dimension: 'collab', name: '提示词结构', max: 4, description: '上下文、角色、约束、示例和检查项组织', domainKeys: ['prompt_engineering'] },
  { key: 'P4', dimension: 'collab', name: '变更响应', max: 3, description: '面对新需求时准确定位并验证影响', domainKeys: ['tool_orchestration'] },
] as const;

export const CAPABILITY_ITEM_BY_KEY: ReadonlyMap<string, CapabilityCriterion> = new Map<string, CapabilityCriterion>(
  CAPABILITY_ITEMS.map((item) => [`${item.dimension}:${item.key}`, item] as const),
);
