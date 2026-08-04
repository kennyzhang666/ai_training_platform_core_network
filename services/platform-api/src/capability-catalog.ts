/**
 * Versioned capability catalog used to turn rubric evidence into an employee
 * AI capability profile.  The four rubric dimensions remain the scoring
 * source of truth; these eight domains are a product-facing aggregation layer
 * and must never manufacture a score when there is no criterion evidence.
 */

export const CAPABILITY_CATALOG_VERSION = '1.1';

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
    label: 'AI 基础与工具选型',
    shortLabel: 'AI 基础',
    description: '理解模型能力边界，按任务选择合适的模型、工具与协作方式。',
    evidenceMode: 'derived',
    criterionKeys: ['collab:P1', 'collab:P2'],
  },
  {
    key: 'task_decomposition',
    label: '需求理解与任务拆解',
    shortLabel: '任务拆解',
    description: '把业务目标、约束条件、关键假设和变更点拆成可执行、可验收的任务。',
    evidenceMode: 'derived',
    criterionKeys: ['spec:S1', 'spec:S2', 'spec:S4'],
  },
  {
    key: 'prompt_engineering',
    label: '提示词工程与上下文管理',
    shortLabel: '提示词工程',
    description: '组织角色、背景、约束、示例、输出格式和自检步骤，让 AI 稳定产出。',
    evidenceMode: 'derived',
    criterionKeys: ['collab:P1', 'collab:P3'],
  },
  {
    key: 'retrieval_fact_checking',
    label: '检索增强与事实核验',
    shortLabel: '检索核验',
    description: '主动查找可信资料，核对引用、假设和边界事实，避免把模型猜测当结论。',
    evidenceMode: 'derived',
    criterionKeys: ['verify:V3', 'spec:S3'],
  },
  {
    key: 'tool_orchestration',
    label: '工具调用与 Agent 编排',
    shortLabel: '工具调用',
    description: '把 AI、代码、测试、检索和自动化工具串成可复用的工作流。',
    evidenceMode: 'derived',
    criterionKeys: ['collab:P2', 'collab:P4'],
  },
  {
    key: 'output_evaluation',
    label: 'AI 输出评审与测试',
    shortLabel: '输出评审',
    description: '用测试用例、边界场景、回归结果和证据检查 AI 产出，而不是直接照单全收。',
    evidenceMode: 'derived',
    criterionKeys: ['verify:V1', 'verify:V2', 'verify:V3', 'verify:V4'],
  },
  {
    key: 'engineering_delivery',
    label: '工程化交付与自动化',
    shortLabel: '工程化交付',
    description: '把 AI 产出沉淀为可维护、可测试、可发布、可持续迭代的工程成果。',
    evidenceMode: 'derived',
    criterionKeys: ['code:C1', 'code:C2', 'code:C3', 'code:C4'],
  },
  {
    key: 'security_compliance',
    label: '安全合规与风险控制',
    shortLabel: '安全合规',
    description: '识别数据、权限、隐私、版权和运行风险，落实最小权限和可审计措施。',
    evidenceMode: 'derived',
    criterionKeys: ['spec:S3', 'verify:V2', 'code:C2'],
  },
] as const;

export const CAPABILITY_ITEMS: readonly CapabilityCriterion[] = [
  { key: 'V1', dimension: 'verify', name: '主流程验证', max: 8, description: '覆盖核心流程和基础用例，确认主要功能按预期工作', domainKeys: ['output_evaluation'] },
  { key: 'V2', dimension: 'verify', name: '异常与边界验证', max: 12, description: '覆盖边界条件、异常输入和跨天等特殊场景', domainKeys: ['output_evaluation', 'security_compliance'] },
  { key: 'V3', dimension: 'verify', name: '需求澄清与规则验证', max: 12, description: '需求澄清后，验证隐藏规则、业务约束和边界事实', domainKeys: ['retrieval_fact_checking', 'output_evaluation'] },
  { key: 'V4', dimension: 'verify', name: '变更回归验证', max: 8, description: '需求变化后定位影响范围，并完成回归和适配验证', domainKeys: ['output_evaluation'] },
  { key: 'S1', dimension: 'spec', name: '需求澄清', max: 10, description: '识别并记录需求歧义、关键假设和最终决策', domainKeys: ['task_decomposition'] },
  { key: 'S2', dimension: 'spec', name: '验收用例设计', max: 8, description: '把需求转成可执行、可验证的验收用例', domainKeys: ['task_decomposition'] },
  { key: 'S3', dimension: 'spec', name: '异常与边界覆盖', max: 4, description: '覆盖异常、边界和失败路径，避免只验证正常流程', domainKeys: ['retrieval_fact_checking', 'security_compliance'] },
  { key: 'S4', dimension: 'spec', name: '变更影响定位', max: 3, description: '明确变更影响范围、关键回归点和验证入口', domainKeys: ['task_decomposition'] },
  { key: 'C1', dimension: 'code', name: '业务常量管理', max: 6, description: '提取业务常量，用有意义的命名表达业务规则，避免魔法数字', domainKeys: ['engineering_delivery'] },
  { key: 'C2', dimension: 'code', name: '异常与边界处理', max: 5, description: '显式处理异常、无效输入和边界状态，保证失败路径可控', domainKeys: ['engineering_delivery', 'security_compliance'] },
  { key: 'C3', dimension: 'code', name: '类型与精度安全', max: 4, description: '选择合适的类型和数值精度，避免隐式转换和精度丢失', domainKeys: ['engineering_delivery'] },
  { key: 'C4', dimension: 'code', name: '变更友好设计', max: 5, description: '控制复杂度，保持代码可维护、可扩展，降低需求变更成本', domainKeys: ['engineering_delivery'] },
  { key: 'P1', dimension: 'collab', name: '需求与验收先行', max: 4, description: '先明确目标、约束、接口和验收标准，再开始实现', domainKeys: ['ai_literacy', 'prompt_engineering'] },
  { key: 'P2', dimension: 'collab', name: '小步迭代', max: 4, description: '通过小步实现、及时验证，控制与 AI 的协作节奏和返工成本', domainKeys: ['ai_literacy', 'tool_orchestration'] },
  { key: 'P3', dimension: 'collab', name: '提示词设计', max: 4, description: '组织上下文、角色、约束、示例和检查项，形成可复用的提示词', domainKeys: ['prompt_engineering'] },
  { key: 'P4', dimension: 'collab', name: '变更定位与验证', max: 3, description: '面对新需求，快速定位影响范围并完成验证，避免只改表面', domainKeys: ['tool_orchestration'] },
] as const;

export const CAPABILITY_ITEM_BY_KEY: ReadonlyMap<string, CapabilityCriterion> = new Map<string, CapabilityCriterion>(
  CAPABILITY_ITEMS.map((item) => [`${item.dimension}:${item.key}`, item] as const),
);
