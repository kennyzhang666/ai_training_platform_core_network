# AI 评测引擎开发资料包

> 版本：0.8.8。此文件是自包含的开发上下文，不是可直接运行的源码仓库。它嵌入了指南、真实契约、样例和参考实现；要运行测试，仍需取得项目源码并按 README 配置环境。

## 使用方式

1. 先阅读下方的评测引擎开发指南。
2. 按 BEGIN FILE / END FILE 标记把需要的内容还原成对应路径；AI 也可以直接把整个文件作为上下文阅读。
3. 以 contracts/ 中的已发布 Schema 为事实来源，不要根据示例臆造字段。
4. 真正执行 pnpm、Python grader 或 Worker 测试时，必须在完整项目源码目录中运行。

## 评测引擎开发指南

# 评测引擎开发指南

> 版本：0.8.8
> 用途：供评测引擎开发者和其他 AI 阅读。仓库内 contracts/ 是最终事实来源；本文档不包含员工信息、凭据或运行日志。

## 1. 平台边界

评测引擎是受控、可复现的批处理程序。平台 API 只冻结赛题、rubric、提交快照和运行配置并创建批次；不可信的学员代码和 Code Agent 必须由独立 Worker 在沙箱或受控主机执行。

Worker 读取批次清单，准备只读输入，启动引擎，校验 JSON 结果，再按幂等键回写平台。服务端会重新校验提交归属、Schema、批次状态和评分结果。

- 不要在 NestJS/API 进程中执行学员代码、任意 Git 命令或 Code Agent。
- 上传包和 Git 交付件进入引擎前必须生成不可变快照，评测期间不得回读可变分支。
- 已发布 Schema、rubric 和引擎版本不可原地修改；修复必须新建版本。
- AUTO、MANUAL、IMPORT 是触发方式，不是三套评分逻辑；评分逻辑应复用同一引擎。

## 2. 引擎包目录

PACKAGED 引擎以 ZIP 交付，根目录建议如下。路径只能是包内相对路径，不允许盘符、绝对路径、.. 或符号链接逃逸。

~~~text
parking-fee-engine/
├─ engine.json
├─ instruction.md
├─ skills/evaluation/SKILL.md
├─ judge.py
├─ requirements.txt
└─ assets/
   ├─ tests/
   └─ reference/
~~~

engine.json 是元数据和限制的事实来源；instruction.md 说明 Agent 如何读取清单和写回结果；Skills 只放可审查、可版本化的评测知识。依赖应固定版本，生产优先使用内部镜像或离线包。

## 3. engine.json 最小配置

发布后的 id + version + packageHash 是不可变坐标。入口不能拼接用户输入或调用系统 Shell。

~~~json
{
  "schemaVersion": "1.1",
  "id": "parking-fee-engine",
  "version": "1.0.0",
  "runtime": {
    "type": "python",
    "entrypoint": "judge.py",
    "requirements": "requirements.txt"
  },
  "input": "contracts/evaluation-input.schema.json",
  "output": "contracts/evaluation-result.schema.json",
  "instruction": "instruction.md",
  "skills": ["skills/evaluation/SKILL.md"],
  "limits": {
    "wallClockSeconds": 600,
    "memoryMB": 2048,
    "outputBytes": 4194304
  }
}
~~~

平台内置执行器使用 PLATFORM_LOCAL；完整引擎包使用 PACKAGED；EXTERNAL_CLI 仅用于线下结果导入。新增字段前先升级 Schema 版本，并补齐 TypeScript、Python 和 API 契约测试。

## 4. 输入契约与批次清单

每个批次目录包含 batch-manifest.json，冻结赛题版本、rubric 版本、引擎、提交快照和每次运行的幂等键。引擎只读取清单指向的文件，不得根据客户端 URL 或未冻结工作区重新拉取内容。

评测输入契约是 contracts/evaluation-input.schema.json；交付件上传/Git 规则是 docs/submission-contract.md。前者回答“引擎如何消费快照”，后者回答“作品如何交付和冻结”。

~~~json
{
  "schemaVersion": "1.0",
  "event": {
    "id": "event-parking-fee",
    "challengeVersion": "parking-fee:v1",
    "rubricVersion": "parking-fee-rubric:v1",
    "trigger": "IMPORT"
  },
  "challenge": {
    "id": "parking-fee",
    "version": 1,
    "evaluationEngine": {
      "id": "parking-fee-engine",
      "version": "1.0.0",
      "mode": "PACKAGED"
    }
  },
  "submissions": [{
    "submissionId": "sub_001",
    "subject": { "id": "w00001", "name": "参赛员工", "orgPath": "企业业务/云计算" },
    "snapshot": { "sourceType": "UPLOAD", "snapshotHash": "sha256:...", "artifactPath": "snapshots/sub_001" },
    "grading": { "runId": "run_001", "idempotencyKey": "event:sub_001:sha256:...", "triggerType": "IMPORT" }
  }]
}
~~~

输入中的 subject 只用于归属和审计；日志不要输出不必要的真实姓名、工号。snapshotHash、rubricVersion 和引擎版本必须进入结果证据。

## 5. 启动 Code Agent

运行配置中的命令只能是“可执行文件 + 参数”，不会经过系统 Shell。Worker 替换占位符并注入批次清单和任务指令。

~~~text
opencode --prompt "{{prompt}}"

占位符：
  {{prompt}}       任务指令
  {{manifestPath}} 批次清单路径
  {{batchDir}}     批次工作目录

Worker 示例：
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker worker-local
~~~

Code Agent 应读取 instruction.md、Skills、batch-manifest.json 和只读提交快照，并将结果写到 manifest.resultIndexPath。命令优先级是 Worker --agent-command > 新批次冻结的平台配置 > CODE_AGENT_COMMAND/CODE_AGENT_ARGS_JSON。可执行文件必须存在于 Worker 主机并通过白名单。超时必须受批次、Worker、引擎三层上限约束。

## 6. 输出契约、幂等与失败

单次结果必须符合 contracts/evaluation-result.schema.json。批次汇总使用 contracts/evaluation-agent-result-index.schema.json：每个 runId 只能出现在 results 或 failures 一处，失败必须有稳定 reason，不能用空分数伪装成功。

~~~json
{
  "schemaVersion": "1.0",
  "batchId": "batch_001",
  "results": [{
    "runId": "run_001",
    "idempotencyKey": "event:sub_001:sha256:...",
    "status": "SUCCEEDED",
    "score": 86,
    "rubricVersion": "parking-fee-rubric:v1",
    "criteria": [{ "key": "boundary", "score": 18, "maxScore": 20, "evidence": ["tests/boundary.json"] }]
  }],
  "failures": []
}
~~~

结果必须携带 runId、幂等键、引擎 id/version、rubricVersion 和证据引用。重复领取同一批次时返回已有结果，不重复扣分。结果落盘应先写临时文件再原子替换。平台会服务端重算汇总分和排名。

## 7. 评分实现规范

- 先采集测试用例、输入、输出、日志摘要和规则命中，再按 rubric 计算分数。
- 固定随机种子、时区、依赖版本和舍入规则，保证重复运行一致。
- 正常、边界、异常、资源限制和输出格式错误都要有测试。
- 分数之外输出可解释证据和失败原因，便于复核、重跑和生成 AI 能力画像。
- 不读取其他参赛者目录、隐藏答案、平台数据库或 Worker 凭据目录。
- AI 评审只能使用清单、题面允许上下文和公开规则；模型输出必须结构化解析并通过 Schema。

## 8. 安全、快照与日志

默认批次目录为 tmp/evaluation-batches，日志目录为 tmp/evaluation-logs/<workerId>。提交快照、引擎包、临时工作区和日志必须分开。

- 拒绝路径穿越、符号链接逃逸、超大压缩包和解压炸弹；限制包大小、文件数、解压体积和单次输出。
- 日志不得记录 token、Cookie、SSO 断言、完整源码或未脱敏敏感信息；保留必要的 worker.log、interaction.jsonl、agent.stdout.log、agent.stderr.log。
- Git 地址只能来自已发布训战配置；引擎不得接受客户端任意仓库 URL。
- API 进程不执行不可信代码；本地调试使用 scripts/code-agent-local-bridge.mjs 或独立 Worker。
- 评测目录属于 Worker 主机，不由浏览器上传；保留和清理由 Worker 配置负责。

## 9. 本地开发与验证

先补契约样例和测试，再实现逻辑；不要通过删除测试、放宽 Schema 或吞异常来“修复”失败。

~~~powershell
pnpm install
pnpm contract:test
pnpm grader:test
pnpm --filter @ai-training/platform-api test
pnpm --filter @ai-training/web lint
pnpm build

# 仅在受控开发环境打开 Code Agent 测试
$env:CODE_AGENT_RUNTIME_TEST_ENABLED = "true"
$env:CODE_AGENT_COMMAND = "opencode"
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker worker-local
~~~

真实端到端测试准备已发布训战、测试员工和无敏感信息的样例提交。测试后检查 tmp/evaluation-batches/<batchId> 和 tmp/evaluation-logs/<workerId>，确认每个 runId 只有一份结果；不要使用生产账号、仓库或凭据。

## 10. 推荐实现顺序

1. 阅读 DEVELOPMENT_PLAN.md、AGENTS.md、contracts/ 和 docs/evaluation-engine-protocol.md。
2. 新增或升级 engine.json、输入输出样例、rubric 映射和契约测试，发布版本号而不是修改旧 Schema。
3. 实现只读快照读取、测试执行、证据收集、结果索引和幂等写回。
4. 用本地 bridge 验证目录与契约，再用真实 OpenCode Worker 做一次端到端测试；日志不提交 Git。
5. 同步 OpenAPI、CHANGELOG.md、DEVELOPMENT_PLAN.md，并记录验证命令和剩余风险。

## 11. 可直接交给其他 AI 的提示词

把下面提示词连同本 Markdown 和仓库交给 AI。AI 必须以 contracts/ 为事实来源，不凭记忆发明字段。

~~~text
你是本项目的评测引擎开发者。请先阅读：
- AGENTS.md
- DEVELOPMENT_PLAN.md
- docs/evaluation-engine-protocol.md
- docs/submission-contract.md
- contracts/evaluation-input.schema.json
- contracts/evaluation-result.schema.json
- contracts/evaluation-agent-result-index.schema.json

目标：实现一个可复现、可审计、只读取冻结提交快照的评测引擎。
要求：
1. engine.json 声明 id、版本、Python 入口、依赖、资源限制和契约路径；
2. 不执行任意 Shell，不访问公网，不读取其他参赛者和平台凭据；
3. 每次运行输出符合 Schema 的结果、证据、runId 和幂等键；
4. 失败写入 failures 并提供稳定 reason，不伪造分数；
5. 先补 fixture、契约测试和安全测试，再实现逻辑；
6. 最后报告改动文件、验证命令、结果和剩余风险。
~~~

## 12. 仓库文档索引

- contracts/：TypeScript、Python 和 API 共用的输入输出 Schema、样例和契约测试。
- docs/evaluation-engine-protocol.md：评测引擎与 Worker 的批次、执行和结果协议。
- docs/submission-contract.md：上传包和 Git 交付件的冻结、路径和安全规则。
- scripts/evaluation-worker.mjs：独立 Worker 的领取、执行、日志和结果写回流程。
- scripts/code-agent-local-bridge.mjs：本地目录/契约桥接器，不代表真实模型评测。
- grader/：Python grader 运行时及 requirements.txt；API 不直接执行其中的不可信代码。

## 变更前检查清单

- [ ] 新增/修改 Schema 已升级版本，并补齐 TS/Python/API 测试。
- [ ] 引擎包路径没有绝对路径、..、符号链接或未固定依赖。
- [ ] 结果包含 runId、幂等键、rubricVersion、证据和明确状态。
- [ ] 失败、超时、取消都有可审计 reason，日志已脱敏。
- [ ] 已执行 pnpm contract:test、pnpm grader:test 和受影响模块测试。
- [ ] 已更新 CHANGELOG.md、DEVELOPMENT_PLAN.md，并记录剩余风险。

## 嵌入的仓库文件

共 66 个文件，按仓库相对路径嵌入。

--- BEGIN FILE: AGENTS.md ---

# AI 训战平台工程约束

## 开发入口

- 先阅读 `DEVELOPMENT_PLAN.md` 和本文件，再修改代码。
- 根目录使用 pnpm workspace；Python grader 使用 `grader/requirements.txt`。
- 契约文件位于 `contracts/`，是 TypeScript、Python 和 API 的事实来源。
- 本地验证优先使用 `pnpm contract:test`、`pnpm grader:test` 和受影响模块的测试。

## 架构边界

- 平台 API 使用 TypeScript/NestJS；评测执行使用 Python CLI；不在 Node API 进程中执行不可信学员代码。
- 上传和 Git 交付件在进入 grader 前必须转换成不可变快照。
- 评分结果必须通过 JSON Schema、提交归属、幂等键和服务端重算校验。
- `AUTO`、`MANUAL`、`IMPORT` 是场次配置，不得复制出三套评分逻辑。
- 已发布 Schema、rubric 和数据库迁移不可原地修改，变更必须升版本。

## 安全规则

- 不把真实员工、客户、仓库凭据或生产数据写入 fixture、日志和测试。
- Git 地址只能来自已发布场次配置；不得接受客户端任意 URL。
- 上传包必须限制大小、路径和解压后体积，拒绝路径穿越、符号链接逃逸和解压炸弹。
- 不记录 token、Cookie、SSO 断言或完整源码。

## Codex 任务规则

- 每次只实现一个可验收的纵切面，不擅自扩展范围。
- 先补测试和契约样例，再实现逻辑。
- 不通过删除测试、放宽校验或吞异常来“修复”失败。
- API 改动同步 OpenAPI；Schema 改动同步 TypeScript/Python 契约测试。
- 发布版本必须同步 `DEVELOPMENT_PLAN.md` 的当前状态、版本沿革和后续计划，并在 `CHANGELOG.md` 记录事实变更。
- 完成后报告改动文件、验证命令、结果和未解决风险。

--- END FILE: AGENTS.md ---


--- BEGIN FILE: DEVELOPMENT_PLAN.md ---

# AI 能力训战平台开发总览

> 当前版本：`v0.8.8`
> 更新日期：2026-08-06
> 当前阶段：v0.8.8 赛题说明富文本图片能力已发布；生产目标环境仍需完成身份网关、Worker 服务身份、对象存储策略、沙箱资源限制和发布回滚门禁
> 发布范围：在 v0.8.7 评测锁定和提交状态反馈基础上，补齐赛题说明编辑器的图片插入、预览和服务端安全校验，不修改评分 Schema 和数据库迁移。
> 文档职责：项目架构、整体设计、版本沿革、当前边界、后续路线和 Codex 交接入口

## 1. 如何使用和维护本文档

本文档是后续开发者和 Codex 接手项目时的第一入口。开始修改代码前，必须先阅读根目录 `AGENTS.md` 和本文档。

事实来源按以下优先级处理：

1. `contracts/openapi.yaml` 与 `contracts/*.schema.json`：API 和跨进程数据契约的事实来源；
2. 已提交的代码与自动化测试：当前真实行为；
3. 本文档：架构、当前状态和下一步计划；
4. `CHANGELOG.md`：每个发布版本的详细变更记录；
5. `AI训战平台设计方案.html`：原始业务设计基线，不代表所有功能都已实现。

每次形成可发布版本时，提交者必须同时完成：

- 更新根目录、Web、API 三个 `package.json` 的版本号；
- 更新本文档顶部版本、当前状态、版本沿革和后续计划；
- 在 `CHANGELOG.md` 顶部增加该版本的事实记录；
- API 变更同步 OpenAPI，跨语言数据变更同步 JSON Schema 和 TypeScript/Python 契约测试；
- 运行第 11 节的验证命令并记录尚未解决的风险；
- 不保留已经失效、会误导接手者的阶段性盘点文档。

## 2. 产品目标与业务边界

平台服务企业内部新员工、导师、出题人和管理员，用统一的训战、交付、评测和复盘链路，把员工使用 AI 完成真实工程任务的能力变成可追溯的数据。

核心业务对象：

- **赛题**：可复用的题目资产，分为训战类、竞赛类和难题类；具有不可变版本、交付契约、评测引擎和评分规则版本。
- **训战**：赛题版本的一次运行安排，配置开放时间、分区、赛制、交付方式、评测方式、参与范围和揭晓策略。
- **提交**：员工通过 ZIP 或受控 Git 分支提交的交付件；平台在接收时固化为不可变快照。
- **评测运行**：某份提交的一次评分尝试；重新评测会新增运行记录，不覆盖历史结果。
- **评测批次**：管理员从同一训战中选择一名或多名员工后创建的完整 Worker 工作单元。
- **评测结果**：由平台校验、重算并绑定可信员工快照后的结构化结果。
- **报告与能力画像**：从单场证据、四维能力、16 个评分点和八个 AI 能力域逐层聚合。
- **难题榜**：复用赛题库中的难题类题目，经过审核、交付和揭榜形成闭环。

本项目明确不在平台 API 进程中直接执行不可信学员代码。API 负责状态、契约、权限和结果可信性；独立评测 Worker、Code Agent 与沙箱负责实际评测。

## 3. 总体架构

```text
员工 / 导师 / 管理员
        |
        v
React + Vite Web
        |
        | REST / JSON（开发期 X-Employee-Id，生产期 SSO 网关）
        v
NestJS + Fastify Platform API
  |-- 身份、角色与组织范围
  |-- 赛题、训战、名单、提交状态机
  |-- 交付契约与结果契约校验
  |-- 评测批次租约与结果幂等录入
  |-- 报告、画像、公告与审计
  |
  |-- PlatformStore ------> 开发：文件适配器；生产：PostgreSQL/Prisma 规范化表（快照信封仅作迁移兼容）
  |-- ObjectStorage ------> 开发：本地目录；生产：S3-compatible 对象存储
  |-- GitSnapshotter -----> 当前：受控本地 Git；目标：GitLab 适配器
  |
  v
独立 Evaluation Worker
  |-- 领取完整批次并续租
  |-- 校验和解包不可变交付件
  |-- 物化引擎、instruction、Skills 与 Schema
  |-- 创建隔离批次目录
  v
Code Agent Bridge / Agent CLI
  |-- 按清单逐份调用赛题评测引擎
  |-- 写出单人结果和批次结果索引
  v
Platform API 校验、重算、幂等保存
```

### 3.1 代码目录

| 路径 | 职责 |
| --- | --- |
| `apps/web/` | React 员工端和管理端；当前为单应用、客户端视图切换 |
| `services/platform-api/` | NestJS/Fastify API、领域状态机、本地持久化与适配器 |
| `contracts/` | OpenAPI、题目、提交、引擎调用、批次和结果 JSON Schema |
| `grader/` | Python CLI、评分计算、快照与交付校验、Python 契约测试 |
| `scripts/evaluation-worker.mjs` | 独立拉取式评测 Worker |
| `scripts/code-agent-local-bridge.mjs` | 本地 Code Agent 批次协议适配器，仅用于联调和验收 |
| `executors/` | 随平台发布的内置评测执行器 |
| `challenges/` | 示例赛题、版本化引擎包、instruction 和 Skills |
| `services/platform-api/prisma/` | 生产关系模型和版本化迁移契约；PostgreSQL 运行时已接入，快照信封仅作兼容 |
| `docs/` | 稳定的专项协议、架构决策和能力模型说明 |
| `tmp/` | 本地运行数据、交付件和临时工作区，不进入版本库 |

### 3.2 API 内部边界

- `PlatformController`：HTTP 入口、认证上下文和请求响应映射；
- `PlatformStore`：当前领域状态、授权校验、审计和文件持久化实现；
- `ArtifactStore`：上传包的不可变保存、哈希与读取；
- `SubmissionContractService`：ZIP/Git 目录契约校验；
- `LocalGitSnapshotter`：只允许从配置根目录固化指定仓库、分支和 commit；
- `EvaluationBatchService`：批次创建、领取、心跳、完成、失败和租约恢复；
- `EvaluationTaskService`：兼容旧的单份拉取协议；新流程优先使用批次协议；
- `EnginePackageStore` / `ExecutorRegistry`：上传引擎包和内置执行器的不可变版本；
- `ScoreValidator`：结果 Schema、归属、幂等键和分数重算可信边界；
- `AutoGradingQueue` / 内嵌执行器：只用于显式开启的兼容测试，不是生产评测路径。

## 4. 关键领域设计

### 4.1 角色、SSO 与组织权限

内部 SSO 只提供工号、姓名和部门。首次登录时平台按工号幂等登记：

- 部门名称、编号或路径能匹配组织树时自动归属；
- 无法匹配时保留未配置部门，等待全局管理员处理；
- 管理员不能手工新增员工，也不能修改 SSO 主数据；
- 管理员只配置员工的所属部门及新员工、导师、部门管理员、全局管理员角色。

权限层级：

- **全局管理员**：可维护全组织、所有管理员角色、全局 Code Agent 运行配置和跨部门数据；
- **部门管理员**：只能访问授权组织路径及子组织，不能配置其他管理员，也不能删除其权限范围根部门；
- **导师**：进入面向自己的训战并查看后续明确授权的数据；
- **新员工**：进入面向自己的训战、提交交付件、查看已揭晓结果和个人画像。

组织删除只允许空的非根部门。存在下级部门、直属员工、管理员范围、训战面向对象或其他业务引用时必须拒绝。

开发期请求使用 `X-Employee-Id`；生产环境必须由可信网关验证 SSO/OIDC/JWT，并清除外部请求伪造的身份头。

### 4.2 赛题、训战与难题榜

赛题和训战必须分开：

- 赛题库管理题目资产、类别、富文本详情、版本、交付契约和评测引擎；
- 训战管理时间、分区、赛制、交付方式、评测方式、参与对象、关闭和揭晓；
- 训战始终引用一个已发布赛题版本，发布后的 Schema、rubric 和引擎包不可原地修改；
- `TRAINING`、`COMPETITION`、`HARD_PROBLEM` 是后台资产分类，员工卡片只显示对参与决策有价值的信息；
- 难题榜只展示审核通过的难题类赛题，分为待揭榜和揭榜成功；揭榜成功可按配置公开解决者和交付摘要。

### 4.3 交付件状态机

```text
选择 ZIP / 受控 Git 版本
  -> 校验训战开放、参与权限和交付方式
  -> 校验大小、路径、目录结构和赛题交付契约
  -> 固化 artifactHash + snapshotHash + 提交人/组织快照
  -> 保存不可变提交
  -> QUEUED / 等待管理员发起 / 等待导入
  -> GRADING
  -> GRADED 或 FAILED
```

安全不变量：

- Git 地址只能来自已发布训战配置，客户端不能提交任意 URL；
- ZIP 拒绝路径穿越、符号链接逃逸、过多文件和解压炸弹；
- 同一份提交创建新评测运行时不得覆盖旧结果；
- 快照哈希覆盖排序后的相对路径、文件内容哈希和执行权限位；
- 重新评测产生新运行，结果幂等只消除同一运行的重复回传。

交付目录规范详见 `docs/submission-contract.md`。

### 4.4 Code Agent 批次评测

管理员在评测中心进入某一训战，查看每名员工的不可变提交，并精确勾选一人或多人发起评测。当前主流程为：

1. API 为选中提交创建 `GradingRun`，再创建一个不可拆分的 `EvaluationBatch`；
2. 批次冻结赛题版本、引擎版本、运行配置、输入/输出约束和提交快照；
3. Worker 通过租约领取完整批次，定期心跳；租约过期后未完成批次重新排队；
4. Worker 在隔离目录物化引擎、`instruction.md`、Skills、Schema 和所有交付件；
5. Worker 使用 `shell: false` 调用管理员配置或主机兜底的 Code Agent 命令；
6. Code Agent 读取批次清单，逐份评分，生成单人结果和结果索引；
7. Worker 回传成功项与失败项；平台逐项验证 Schema、提交归属、运行 ID、幂等键并重算总分；
8. 平台保存不可变结果，更新提交状态、报告、画像和审计记录。

`AUTO`、`MANUAL`、`IMPORT` 只是训战的触发策略，不复制评分逻辑：

- `AUTO`：提交后自动创建待领取任务；
- `MANUAL`：管理员精确选择提交并发起批次；
- `IMPORT`：管理员在线下完成评测后导入同一输出约束；
- 三者最终都经过同一个可信结果录入边界。

完整 ABI、目录布局、命令占位符和结果索引见 `docs/evaluation-engine-protocol.md`。

### 4.5 结果、报告与能力画像

评测结果不能只返回一个总分。平台当前模型保留：

- 总分、排名、部门对比和结果状态；
- Verify、Schema、Code Quality、Prompting 四维能力；
- 16 个评分点的 A/B/C/D 档位；
- 判据、判定来源、文件、行号、代码片段、问题说明和修改建议；
- 客观指标、提交和 commit 时间线；
- 八个 AI 能力域及证据覆盖度；
- 个人趋势、蓝区/黄区分布、部门中位数和百分位；
- 管理员按部门、训战或指定员工集合查看聚合平均画像；选择训战时只汇总该训战的提交与 AI 评测结果，并保留个人明细卡片。

员工只能看到按训战揭晓策略开放的结果；管理员在权限范围内可进行运营和复核。

## 5. 当前实现状态（v0.8.8）

### 5.1 已可本地验收

- 员工首页、训战广场、赛题详情、提交、报告、个人中心和能力画像；
- 赛题草稿、版本、发布、归档、垃圾箱、恢复和富文本详情；
- 赛题说明富文本编辑器支持 PNG、JPEG、WebP 图片插入，图片以受限 data URL 嵌入并在服务端校验类型、大小、文件魔数和 HTML 属性；
- 训战时间、分区、赛制、交付方式、评测方式、参与部门/人员和导师范围；
- ZIP 与 Git 固定版本提交、不可变快照和赛题级目录结构校验；
- 管理员按训战和员工精确选择提交，创建 Code Agent 评测批次；
- 评测状态锁定：同一学员在同一训战已有排队中或评测中的提交时，交付页显示“评测中，已锁定”并弹出可关闭提示，服务端拒绝新的上传或 Git 提交，评测完成或失败后恢复提交；
- Worker 租约、心跳、批次恢复、交付件下载、引擎和 Agent 资产物化；
- 结构化结果导入、Schema 校验、分数重算、可信身份覆盖和幂等保存；
- 单场详细报告、四维/16 点/八能力域画像及组织聚合画像；管理员能力画像支持按训战筛选全体提交者的 AI 评测聚合；
- 部门、员工角色、训战名单、公告和审计管理；
- 全局管理员与部门管理员的组织范围隔离；
- 组织新增、编辑和安全删除；员工配置分页、固定页面高度和可读部门路径；
- 难题发布审核、待揭榜/揭榜成功、解决方案提交和展示控制；
- OpenAPI、TypeScript 契约测试、Python 契约测试和本地端到端批次测试。

### 5.2 当前适配器和限制

当前代码仍可“无需外部依赖即可验收”，但尚未完成目标环境生产发布门禁，不应直接暴露到生产网络：

- 开发环境仍可由 `PlatformStore` 写入 `tmp/platform-data.json`；生产配置下由 PostgreSQL/Prisma 规范化表作为运行时事实来源；
- 交付包和引擎包开发环境仍可落本地目录；生产上传、读取和 Worker 物化走 S3-compatible `ObjectStorage`；PostgreSQL 模式的上传会话落在 `UploadSession`，文件适配器仍只用于本地开发；
- 身份认证仍以开发请求头为主，SSO 同步接口不等于完整的生产登录会话；
- 本地 Git 适配器只访问 `LOCAL_GIT_ROOT`，尚未接入真实 GitLab；
- Code Agent 本地 bridge 用确定性评测器验证协议，真实 Agent、沙箱和凭据治理由部署环境提供；
- Web 仍集中在两个较大的 TSX 文件中，尚未进行路由、模块和设计组件拆分；
- 员工、提交、审计和管理端列表已接入服务端分页；个人画像历史和管理端能力聚合也已提供分页契约与前端接入；PostgreSQL 下提交/审计使用规范化表查询，画像聚合仍需后续容量验证；
- 日志、指标、告警、数据保留和容量压测尚未生产化；本轮已补齐可在目标数据库执行的备份/恢复命令和回归入口，真实演练仍待目标环境。

### 5.3 v0.7.0 发布状态（历史，2026-08-04）

本轮已按 `docs/v0.7-development-manual.md` 落地以下代码纵切面：

- W0/W1：Repository/Unit of Work 边界、Prisma 组织/人员/审计适配器、人员服务端分页、角色与 SSO 同事务审计；
- W2：LOCAL/OIDC/TRUSTED_GATEWAY 身份模式、JWT/JWKS 与网关签名校验、Nest 全局身份 Guard；
- W3/W4：新增不可变字段迁移、规范化 PostgreSQL Repository/Unit of Work、运行/批次租约 CAS、结果幂等与事务回滚路径；
- W5：本地与 S3-compatible 对象存储的两阶段上传、大小/哈希/对象归属校验、过期清理及 Worker 物化闭环；
- W6：提交、审计和管理端人员列表的分页响应及前端服务端分页接入；补齐个人画像历史分页、画像趋势分页和管理端能力聚合分页，候选人员选择器改为服务端分页并增加请求序列保护；
- 管理端写操作回归：修复用户编辑成功后刷新提交/审计列表因 `PlatformReadService` 依赖未显式注入而返回 500、进而被前端误报失败的问题，并为全部刷新接口增加回归覆盖；
- 评测输入/输出约束配置纵切面：新增 Git 版本化约束目录和示例，管理端按评测方式以下拉选择输入/输出约束；可点击查看固定 Schema、示例和编写说明，并一键复制 AI 出题提示；服务端启动时校验 Schema/示例并在赛题写入时拒绝目录外路径；新增约束详情 OpenAPI 接口和 AI 配置说明。
- 训战能力画像纵切面：`/admin/capabilities` 增加 `eventId` 契约与权限校验，服务端按训战过滤提交、评测、能力域和群体聚合，管理端增加训战下拉并展示该训战的全体提交者 AI 评测画像。
- 赛题/训战管理闭环：管理端提供赛题编辑（草稿原地修改、已发布版本创建新版本）与回收站删除/恢复；训战支持编辑和安全删除，已公布、系统管理或已有提交的训战拒绝删除并写入审计。
- W7：备份/恢复命令覆盖规范化表、迁移脚本、生产环境禁止静默回退到文件适配器；已提供迁移、导入 dry-run、备份/恢复命令和回归入口。
- CI：GitLab pipeline 增加隔离 PostgreSQL 16 service，等待数据库就绪后运行正式迁移路径的 `test:integration:postgres`。
- PostgreSQL 集成测试进一步覆盖同一 SSO 工号首次建档、同级组织名称、运行幂等键、批次/运行租约 CAS 和 10 次重复结果回调的并发竞争；所有记录使用后缀隔离并在 finally 清理。
- SSO 首次建档重试同时处理唯一冲突与 repeatable-read 写冲突（`P2002`/`P2034`），并保持每次同步的审计事实。
- 生产身份契约在 OpenAPI 中同时声明 OIDC Bearer 与可信网关签名头；OIDC 畸形签名按 401 认证失败处理，JSON 导入按组织层级满足自引用外键，交付件下载会再次核对内容哈希。
- 上传会话响应的 `subjectId` 已纳入 OpenAPI required 字段，并由契约测试锁定实际控制器返回形状。

本轮新增的数据库事实变更为：`0009_upload_sessions`（上传会话）、`0010_platform_snapshot_revision`（快照版本 CAS）、`0011_org_unit_name_scope` 和 `0012_org_unit_root_name_scope`（同级组织名称唯一约束，含根组织并发场景）、`0013_submission_current_pointers`（提交当前运行/结果指针与历史结果关系分离）、`0014_capacity_query_indexes`（员工、提交和审计高基数分页索引）。HTTP 请求在成功响应前等待 PostgreSQL 持久化完成；组织、人员和审计写入通过同一事务提交，并同步快照版本，避免旧实例静默覆盖新数据。提交和审计高基数列表在 PostgreSQL 读服务中使用数据库分页及组织范围过滤。

本地真实 PostgreSQL 验证记录：使用临时 PostgreSQL 16.4 独立实例从空库成功部署 14 个迁移；`POSTGRES_INTEGRATION=true pnpm --filter @ai-training/platform-api test:integration:postgres` 通过（1/1）；JSON 正式导入、v2 备份、故意修改后的恢复、以及 PostgreSQL 模式 API 的员工分页和组织/人员/审计同事务 HTTP 验收通过。带真实 ZIP 二进制的 PostgreSQL HTTP 闭环也已通过：上传、启动评测、服务端结果契约校验和结果入库均进入 `GRADED`。临时 MinIO S3-compatible endpoint 的生产配置 HTTP 验收也已通过：原始二进制上传、确认幂等、staging 篡改拒绝和 API 重启后的上传会话恢复均有记录。上述 PostgreSQL 记录形成于本轮新增并发断言之前；并发扩展已进入 CI 集成入口，当前工作区没有可用数据库可重新执行。

另补充生产执行边界回归：当 `EMBEDDED_EVALUATION_WORKER=false` 时，已废弃的单运行执行入口立即返回 `CODE_AGENT_WORKER_REQUIRED`，运行保持 `QUEUED`，API 不会在进程内执行评测引擎。

可观测性最低实现也已落地：`GET /api/v1/metrics` 只向全局管理员返回进程级聚合请求/延迟指标，路由标签有数量上限且不记录敏感输入。指标拦截器保留异常过滤器设置的 4xx 客户端错误，仅把错误路径上未设置状态的响应归为 5xx，并用已知路由参数错误回归验证错误率不会失真。
生产 OIDC 配置同时校验 `OIDC_ISSUER` 与 `OIDC_JWKS_URL` 的 URL 格式和 HTTPS 要求，避免身份边界因明文或畸形配置启动；两类配置错误均返回稳定启动错误。
JSON 导入 dry-run 现在会在数据库连接前校验关系引用、唯一键、日期、提交快照哈希、批次 run/submission 配对及完成/失败集合、结果归属和当前/历史指针，并以失败退出码拒绝坏图谱。

上传清理也已接入 API 生命周期：过期 staging 会按 `OBJECT_STORAGE_CLEANUP_INTERVAL_SECONDS` 周期幂等清理，生产对象存储生命周期规则仍是最终兜底。S3-compatible 工厂会区分未启用的 Prisma UploadSession provider 与真正的 PostgreSQL 持久化，文件 Repository + S3 的本地联调不会误走不可用的数据库会话。

异常日志已收敛为结构化失败事件，仅保留请求 ID、状态码、稳定错误码和异常类型，避免评测 stderr、对象存储 URL 或数据库细节进入日志。

`v0.7.0` 代码版本已发布。代码门禁已覆盖文件适配器、模拟/真实 S3-compatible、身份校验、临时隔离 PostgreSQL、容量基线和安全扫描；目标环境上线前仍需完成最终验收，并保留以下边界：

- `PlatformSnapshot` 仍保留作迁移/回滚兼容信封；生产启动优先从规范化表加载，W1 组织/人员/审计已走领域 Repository，W3/W4 HTTP 写入已走请求级 Unit of Work；
- W3/W4 的低卡读取、上传授权和提交主体校验在 PostgreSQL 模式下使用请求内最新事务图；生产配置显式拒绝 `EMBEDDED_EVALUATION_WORKER=true`，避免 API 进程执行学员交付件。
- 当前 PostgreSQL 适配器对尚未拆分为窄领域 Repository 的部分仍以 `PlatformStore` 完整状态同步；快照版本 CAS 会拒绝旧实例覆盖，但这仍不是高可用多副本方案，后续需要继续拆分并补容量证据；
- PostgreSQL 请求级读取/写入和窄 Repository transaction 使用 repeatable-read 快照，revision CAS 仍是跨实例冲突的最终保护；这不替代后续多副本容量与故障演练。
- 使用 10 万员工、10 万提交和 100 万审计的合成数据完成查询计划复核；新增 `0014_capacity_query_indexes`，提交列表先读取排序键再按页回表，避免为深分页加载全部 JSON/历史列。临时实例 30 次并发 count+page 样本的 P50/P95：员工 13.54/18.19ms、提交 83.81/92.94ms、审计 149.30/172.82ms；这些是本地基线，不是目标环境 SLA；
- PostgreSQL 模式的 S3 上传会话已落 `UploadSession`，可跨 API 重启和实例恢复；文件适配器仍为本地进程状态，生产对象存储还需在目标环境验证预签名/凭据、清理和故障重试；
- 真实目标 S3-compatible endpoint、网关 OIDC/JWKS 和生产 Worker 身份尚未在本工作区提供；本地已用真实 S3 协议兼容服务完成生产配置 HTTP 验收，目标凭据、网络策略、生命周期和故障重试仍需复验；
- 本地已完成 10 万/100 万规模容量与查询计划基线、14 迁移版本的备份/恢复回滚演练，以及 `pnpm audit --registry=https://registry.npmjs.org --audit-level=high`（无已知高危漏洞）；目标环境仍需按同一清单复测并留存生产证据；
- v2 备份恢复在打开数据库事务前完成图谱预检，避免将明显损坏的备份带入目标库清空/写入阶段。
- 根目录、Web 和 API 版本号已同步为 `0.7.0`；目标环境的对象存储策略、身份网关/Worker 服务身份、备份恢复和回滚门禁仍需复验。

### 5.4 v0.8.0 发布状态（历史，2026-08-05）

本轮围绕“评测环境可配置、运行可观测、管理可运营、品牌可识别”完成以下代码纵切面：

- **评测环境配置**：管理后台提供 OpenCode 默认启动命令、默认任务指令和恢复默认按钮；展示已保存的平台配置、Worker 本地环境配置、当前可执行文件、来源、允许列表和可运行诊断。运行配置与环境变量说明拆分为独立页签，生产环境仍禁止 API 进程直接启动 Agent。
- **连通性测试**：新增受 `CODE_AGENT_RUNTIME_TEST_ENABLED` 保护的配置测试接口，只创建合成批次清单并以 `shell: false` 启动当前配置；返回可执行文件、退出状态、工作目录和截断后的脱敏输出，生产环境始终阻断该入口。
- **Worker 可观测性**：Worker 将生命周期日志、Agent stdout/stderr 和脱敏交互事件写入 `EVALUATION_LOG_ROOT`，按 Worker、批次和租约隔离，并支持输出大小上限、生命周期日志滚动和保留策略。
- **评测引擎独立开发**：新增管理端评测引擎开发指南、Markdown/ZIP 下载和独立资料包，资料包包含 OpenAPI/Schema、示例、参考引擎与 Python CLI，可脱离平台仓库开发并通过契约校验。
- **组织与人员运营**：员工资料支持昵称与头像，姓名/工号仍由统一认证提供；组织编辑按父子层级自动识别组织级别；支持员工多选、全选当前页和批量调整部门，后端批量接口继续执行组织范围和管理员账号保护。
- **权限与流程修复**：补齐全局管理员自保护、空部门删除约束、管理员操作刷新回归和训战时间窗口服务端校验；窗口外员工不能进入训战或创建提交。
- **本地开发体验**：开发构建提供右上角本地多身份切换，生产构建默认关闭；管理端、员工端和评测配置页统一调整字号、间距、图标和提示框交互。
- **品牌更新**：网站标题、favicon 和全局导航统一使用“分组核心网AI能力提升平台”及蓝色云网连接 Logo。

本版本仍保留以下生产边界：真实 Worker 服务身份、禁网非 root 沙箱、目标 S3-compatible endpoint、OIDC/TRUSTED_GATEWAY 网关策略、容量压测和发布回滚演练必须在目标内网环境复验；平台配置测试只适用于受控开发环境，不是生产评测通道。

版本验证记录：`pnpm lint`、`pnpm build`、`pnpm contract:test`、`pnpm grader:test`、`pnpm test`、`pnpm acceptance:local` 和 `git diff --check` 均应在发布前通过；本次发布还需确认根目录、Web、API 版本号一致且 Git 标签为 `v0.8.0`。

### 5.5 v0.8.1 发布状态（2026-08-05）

本次补丁版本聚焦管理端不可点击状态和赛题生命周期：

- 所有 `button:disabled`、禁用表单控件和 `aria-disabled="true"` 控件统一显示 `not-allowed` 鼠标样式，移除禁用按钮的 `wait` 旋转光标，避免把“不可操作”和“正在处理”混淆；
- 垃圾箱赛题新增永久删除 API `DELETE /api/v1/challenges/{challengeId}/permanent` 和管理端操作按钮；
- 永久删除仅接受 `ARCHIVED` 赛题；如果赛题版本仍关联训战则返回 `409`，不删除历史提交、评测证据或关联关系；成功操作写入 `challenge.purge` 审计记录；
- OpenAPI、独立评测资料包、中文错误提示和存储/API 回归测试已同步。

版本验证记录：`pnpm --filter @ai-training/platform-api test`（123 项，122 通过、1 项显式跳过）、`pnpm contract:test`（7/7）、`pnpm grader:test`（18/18）、`pnpm lint`、`pnpm --filter @ai-training/web build` 和 `git diff --check` 通过；根目录、Web、API 版本均为 `0.8.1`。

### 5.6 v0.8.2 发布状态（2026-08-05）

本次为全局代码评审后的缺陷修复版本，不含新功能。四个问题都属于「代码看起来正确、但在真实目标环境才会暴露」的类型，因此每项都补齐了能复现该缺陷的回归测试：

- **OIDC `ES256` 验签恒失败**（`services/platform-api/src/identity.ts`）。`ES256` 一直在允许算法列表中，但 JOSE 的裸 `r||s` 签名转 DER 时对长度使用了长格式（`0x30 0x81 len`）。ES256 的 DER body 恒小于 128 字节，而 OpenSSL 只接受该区间的最短长度格式，因此每一个 `ES256` 令牌都会以 `identity token signature is invalid` 被拒。缺陷「失败关闭」，不构成绕过，但任何使用 EC 签名密钥的身份提供方都无法登录。已改为按长度选择最短 DER 编码，并新增使用真实 P-256 密钥对的回归测试；同时验证长度合法的伪造签名仍被拒绝。
- **JWKS 密钥轮换期间认证中断**（同文件）。签名密钥集缓存 5 分钟且遇到未知 `kid` 直接 401，身份提供方轮换密钥后全部请求会失败到缓存过期。已改为未知 `kid` 时强制刷新一次缓存后再判定，并新增轮换回归测试（断言只额外拉取一次、真正未知的 `kid` 仍被拒）。
- **Prisma Client 未生成导致全新克隆和 CI 失败**。`pnpm install` 之后没有任何环节执行 `prisma generate`，`pnpm test` 会在 `repository-factory.test.ts` 抛出 `@prisma/client did not initialize yet`。已为 API 包增加 `postinstall` 钩子；由于 `postinstall` 只在安装真正执行时触发，GitLab CI 的 `before_script` 另外显式执行一次 `prisma:generate`，覆盖 `node_modules` 命中缓存的情况。
- **身份 Guard 健康检查豁免过宽**（`identity-guard.ts`）。原先按 `url.endsWith('/health')` 放行，任何未来以 `/health` 结尾的路由都会被无声地放进免认证范围。已改为精确匹配 `/api/v1/health`（先剥离查询串和结尾斜杠）。

另清理了本地对象存储 `put` 中位于严格相等校验之后、永远不可达的大小分支，并修正了 `DEVELOPMENT_PLAN.md` / `README.md` 专项文档索引中 `+` 误写为 `-` 的列表项与缺失的标题前空行。

本轮没有数据库迁移、没有 API 契约变更，也没有 JSON Schema 变更；`contracts/openapi.yaml` 与实现保持一致。

版本验证记录：`pnpm lint`、`pnpm test`（125 项，124 通过、1 项显式跳过）、`pnpm contract:test`（7/7）、`pnpm grader:test`（18/18）、`pnpm build`、`pnpm acceptance:local`（1/1）和 `git diff --check` 全部通过；根目录、Web、API 版本均为 `0.8.2`。两个身份缺陷的回归测试均已用「先还原缺陷、确认测试失败，再恢复修复、确认测试通过」的方式验证过其有效性。

尚未解决的风险（本轮未改变）：服务端仍未对赛题富文本做完整标签白名单清洗，本轮仅对图片节点、危险标签和危险属性增加边界校验，浏览器端 `sanitizeRichText` 也不构成完整服务端保证；Worker 的 `safeExtract` 不再独立校验解压后体积，依赖 API 入库前的校验；真实目标环境的身份网关、Worker 服务身份、对象存储策略和沙箱资源限制仍待验收。

### 5.7 v0.8.3 发布状态（2026-08-05）

本次只修复构建产物问题，不触碰平台运行时代码、API 契约、JSON Schema 和数据库迁移：

- **资料包 ZIP 构建不可重复。** `scripts/build-evaluation-engine-kit.mjs` 用 `ZipFile.write` 写入条目会带上源文件 mtime，`writestr` 写 `GUIDE.md` 则会带上构建当时的系统时间。结果是内容一字未改、任何一次 `pnpm build` 也会产出不同字节，工作区被弄脏，容易让人误判资料包真的变了，也可能把无意义的二进制 diff 提交进版本库。改为对每个条目显式构造 `ZipInfo`，固定 DOS 纪元 `1980-01-01`、固定 `0644` 权限位并按目标路径排序，构建结果不再依赖构建机的文件系统时间和平台。已验证连续两次构建 SHA-256 一致，且 57 个条目的名称与内容与修复前逐字节相同。
- **资料包版本号漂移。** 版本行 `> 版本：0.8.1` 是构建脚本里的字面量，`0.8.2` 发布后没有同步。改为构建时从根 `package.json` 读取。

发布检查表因此新增一条：`pnpm build` 之后工作区应当保持干净；若 `evaluation-engine-development-kit.zip` 仍被标记为已修改，说明资料包的输入确实发生了变化，应当一并提交，而不是丢弃。

版本验证记录：`pnpm lint`、`pnpm test`（125 项，124 通过、1 项显式跳过）、`pnpm kit:test`（CRLF/LF 资料包回归通过）、`pnpm contract:test`（7/7）、`pnpm grader:test`（18/18）、`pnpm build`、`pnpm acceptance:local`（1/1）和 `git diff --check` 全部通过；根目录、Web、API 版本均为 `0.8.3`。

### 5.8 v0.8.4 发布状态（2026-08-05）

本次修复评测引擎资料包的跨平台构建一致性，不涉及平台运行时代码、API 契约、JSON Schema 或数据库迁移：

- ZIP 写入前统一所有文本条目和开发指南的换行符为 LF，避免 Windows CRLF 工作区与 Linux LF 工作区产生不同归档内容；
- 显式固定 DEFLATE 压缩级别，保留固定 DOS 时间戳、权限位和条目顺序；
- 新增 `scripts/evaluation-engine-kit.test.mjs` 与 `pnpm kit:test`，将 CRLF/LF 字节一致性回归接入 GitLab CI 构建阶段；
- README、v0.8 开发手册、CHANGELOG 和独立评测资料包已同步到 `v0.8.4`。

版本验证记录：`pnpm kit:test`（1/1）、`pnpm lint`、`pnpm test`（125 项，124 通过、1 项显式跳过）、`pnpm contract:test`（7/7）、`pnpm grader:test`（18/18）、`pnpm build`、连续构建 SHA-256 一致性和 `git diff --check` 全部通过；根目录、Web、API 版本均为 `0.8.4`。

### 5.9 v0.8.5 发布状态（2026-08-06）

本次补齐内网 LDAP3 登录接入和 Windows 个人电脑生产模式验收，不涉及 API 业务状态机、评分 Schema、OpenAPI 契约或数据库迁移：

- 新增 LDAP3 网关服务，按内网示例完成域账号绑定、工号/姓名/部门解析、HttpOnly 会话、CSRF 和 `TRUSTED_GATEWAY` HMAC 身份头；
- 生产 Web/API 在可信网关返回 401 时跳转 `/auth/login`，登录页复用平台品牌并提供独立云图标；
- 新增 Linux Nginx + LDAP3 单服务器部署手册和 Windows Nginx + PostgreSQL + MinIO 生产模式端到端验收手册；
- 评测引擎资料包、README、CI 和 LDAP3 回归测试同步到 `v0.8.5`。

版本验证记录：`pnpm ldap3:test`（15/15）和 `git diff --check` 已通过；完整构建、全量测试和真实内网 LDAP 登录需在目标环境继续执行。

### 5.10 v0.8.6 发布状态（2026-08-06）

本次仅调整前端视觉反馈，不涉及 API、数据、评分和认证逻辑：

- 统一卡片、统计块、列表行、按钮、导航和表单控件的过渡时长与缓动曲线；
- 增加卡片 hover 抬升、图标轻微缩放、按钮按压、导航指示线、列表高亮和进度条缓动；
- 增加页面区块进入过渡，并在 `prefers-reduced-motion` 下自动降低动态效果；
- 仅修改 `apps/web/src/styles.css`，构建产物和资料包版本同步到 `0.8.6`。

版本验证记录：`pnpm build`、`pnpm lint`、`pnpm test`、`pnpm contract:test`、`pnpm grader:test`、`pnpm kit:test`、`pnpm ldap3:test`、`pnpm acceptance:local` 和 `git diff --check` 全部通过。

### 5.11 v0.8.7 发布状态（2026-08-06）

本次补齐评测进行中的提交锁定和学员端提醒，不新增数据库迁移：

- 同一学员在同一训战存在 `QUEUED` 或 `RUNNING` 评测时，服务端统一拒绝新的上传、Git 和通用提交，并返回稳定错误码 `SUBMISSION_EVALUATION_LOCKED`；相同快照重试仍按原幂等规则返回；
- 交付页按训战轮询提交状态，显示“评测中，已锁定”并禁用提交按钮；收到跨页面状态变化或竞态 409 时，右上角显示可关闭的锁定提示；
- OpenAPI、评测引擎资料包、TypeScript 回归测试和版本资料同步更新。

版本验证记录：`pnpm test`（125 项通过、1 项显式跳过）、`pnpm contract:test`（7/7）、`pnpm grader:test`（18/18）、`pnpm kit:test`（1/1）、`pnpm acceptance:local`（1/1）、`pnpm lint`、`pnpm build` 和 `git diff --check` 全部通过。

### 5.12 v0.8.8 发布状态（2026-08-06）

本次补齐赛题说明富文本中的图片能力，不新增数据库迁移和评分契约：

- 管理端富文本编辑器新增图片选择和插入控件，支持 PNG、JPEG、WebP，单张图片上限 2 MiB；图片会保留编辑光标位置、替代文本，并在编辑器和赛题详情中按容器宽度展示；
- 前端富文本白名单允许经过校验的图片节点，拒绝远程地址、SVG 和危险属性；
- 平台 API 对赛题创建、版本创建和版本更新统一执行富文本大小、危险标签、图片 data URL、文件魔数和大小校验，避免绕过浏览器直接写入不安全内容；
- API 回归测试覆盖合法内嵌图片持久化和远程图片拒绝，资料包版本从根 `package.json` 自动同步。

版本验证记录：`pnpm test`（126 项，125 通过、1 项显式跳过）、`pnpm contract:test`（7/7）、`pnpm grader:test`（18/18）、`pnpm kit:test`（1/1）、`pnpm ldap3:test`（15/15）、`pnpm acceptance:local`（1/1）、`pnpm lint` 和 `pnpm build` 全部通过；`git diff --check` 通过。真实浏览器上传体验仍需在目标环境复验。

## 6. 版本沿革

详细变更和修复见 `CHANGELOG.md`，这里仅保留交接所需的架构演进。

| 版本 | 日期 | 主要成果 |
| --- | --- | --- |
| `v0.1.0` | 2026-08-02 | 建立 pnpm workspace、React Web、NestJS API、Python grader、JSON Schema、本地存储，以及训战/提交/报告/画像/管理后台的首个纵切面。 |
| `v0.2.0` | 2026-08-02 | 加固 ZIP、路径和快照安全；统一服务端哈希；补齐错误响应、并发和契约回归。 |
| `v0.2.1` | 2026-08-02 | 将每次评测结果改为不可变历史，重新评测不覆盖旧运行。 |
| `v0.3.0` | 2026-08-02 | 赛题评测引擎成为评分事实来源，版本、幂等键和结果验证统一。 |
| `v0.4.0` | 2026-08-02 | 支持出题人上传不可变评测引擎包，增加沙箱启动层和引擎调用契约。 |
| `v0.5.0` | 2026-08-02 | 评测改为独立 Worker 拉取任务；内置执行器可选择；AUTO/MANUAL/IMPORT 共用契约。 |
| `v0.6.0` | 2026-08-03 | 完成多员工 Code Agent 批次协议、赛题级交付目录契约、评测环境配置和评测中心详情流程。 |
| `v0.6.1` | 2026-08-03 | 修复浏览器人员配置失败和 CORS 方法限制；补齐组织编辑、安全删除、权限边界与回归测试；重建持续维护的开发交接文档。 |
| `v0.7.0` | 2026-08-04 | 发布生产数据与身份底座纵切面、规范化 PostgreSQL 迁移、W1 组织/人员 Repository、持久化上传会话、CAS 写入保护及备份恢复演练；目标环境上线门禁仍待执行。 |
| `v0.8.0` | 2026-08-05 | 发布正式评测运行环境纵切面、OpenCode 配置诊断与测试、Worker 日志/交互记录、独立评测引擎资料包、批量调部门和品牌体验更新；生产沙箱与目标环境门禁仍待复验。 |
| `v0.8.1` | 2026-08-05 | 修复禁用控件鼠标反馈，新增垃圾箱赛题永久删除、关联训战保护、审计记录及对应契约和回归测试。 |
| `v0.8.2` | 2026-08-05 | 全局代码评审缺陷修复：修复 OIDC `ES256` 验签恒失败、JWKS 密钥轮换认证中断、Prisma Client 生成缺失导致的 CI 失败，并收紧身份 Guard 健康检查豁免范围。 |
| `v0.8.3` | 2026-08-05 | 修复评测引擎资料包 ZIP 的构建不确定性（固定时间戳、权限位和条目顺序）及资料包版本号漂移。 |
| `v0.8.4` | 2026-08-05 | 修复资料包 ZIP 的 CRLF/LF 跨平台差异，固定压缩级别，新增构建回归测试并接入 CI。 |
| `v0.8.5` | 2026-08-06 | 新增 LDAP3 `TRUSTED_GATEWAY` 登录适配器、Nginx 部署手册、Windows 生产模式验收手册和生产 401 登录跳转。 |
| `v0.8.6` | 2026-08-06 | 统一管理端和员工端的卡片 hover、按钮反馈、导航指示、列表高亮、进度缓动和页面进入动效。 |
| `v0.8.7` | 2026-08-06 | 增加评测进行中的同训战提交锁定、跨页面状态同步和可关闭锁定提示。 |
| `v0.8.8` | 2026-08-06 | 赛题说明富文本支持 PNG/JPEG/WebP 图片插入，并在浏览器和 API 边界执行大小、类型、魔数与危险属性校验。 |

## 7. 后续开发路线

路线以“先完成可部署的核心平台，再接最后的 GitLab 自动评测接口”为原则。每次只实现一个有契约、有测试、可演示的纵切面。

### 7.1 v0.7.0：生产数据与身份底座（最高优先级）

目标：移除单机文件和浏览器身份头对正式环境的依赖。本轮已完成代码候选与本地适配器级证据，剩余工作集中在真实 PostgreSQL、对象存储和目标环境发布门禁。

- 实现 `PlatformRepository` 边界，将 `PlatformStore` 的持久化职责迁移到 Prisma/PostgreSQL（W1 组织/人员/审计已完成，其他高频领域继续迁移）；
- 为提交、评测运行、批次租约、结果导入和审计增加数据库事务与唯一约束；
- 接入真实内部 SSO 网关会话或 OIDC/JWT Guard，保留按工号首次建档逻辑；
- 对员工、提交、审计、画像实现服务端分页、筛选和稳定排序；
- 将 ArtifactStore 替换为对象存储，上传改为流式/预签名方式（S3 两阶段上传与 PostgreSQL 会话持久化已完成适配器级实现）；
- 建立迁移、备份、恢复和种子数据隔离流程。

验收证据：PostgreSQL 集成测试、并发唯一性测试、SSO 越权矩阵、对象存储集成测试、迁移回滚演练记录。

### 7.2 v0.8.x：正式评测运行环境（已发布，2026-08-05）

v0.8.x 已完成运行配置、Worker 诊断、受控配置测试、日志目录、独立评测引擎资料包、管理端运行详情和赛题生命周期管理的代码纵切面。目标环境还需要继续完成以下部署级工作：

- Worker 使用服务身份和短期令牌，不再借用员工身份头；
- Code Agent 命令在部署环境使用受控模板/注册表，禁止任意可执行文件和参数逃逸；
- 接入 K8s Job 或等价沙箱，落实禁网、非 root、只读根文件系统、CPU/内存/磁盘/时限；
- 凭据只由运行环境注入，平台和日志不保存 token、Cookie 或完整源码；
- 在目标环境补齐批次队列指标、心跳、失败原因、重试策略、告警和容量基线；
- 对大包、恶意 ZIP、超时 Agent、部分失败、重复回传和租约争抢做故障注入。

验收证据：沙箱安全测试、Worker 身份测试、故障恢复测试、批次观测面板、容量基线和生产回滚记录。v0.8.0 已提供本地/受控开发验证入口，但不将本地 bridge 或 API 内嵌执行器视为生产证据。

### 7.3 v0.9.0：业务完整性与可运营性

目标：满足真实部门试点的日常配置、复核和复盘需求。

- 拆分前端路由、领域模块和通用表格/表单/状态组件，保留既定 UI 与文案规范；
- 完成导师工作台、出题人权限、报告复核和结果申诉流程；
- 完善富文本存储、完整标签白名单清洗、附件和版本差异；
- 增加公告定向范围、站内通知和关键截止提醒；
- 完善赛季、榜单、部门下钻、画像导出和结果可见性策略；
- 为组织调整、员工转部门、管理员权限回收建立历史快照和审批规则；
- 建立员工端与管理端关键路径的浏览器端到端测试。

验收证据：角色化 UAT 脚本、可访问性检查、XSS 安全测试、跨部门隔离测试、浏览器 E2E。

### 7.4 v1.0.0：试点发布与生产验收

目标：完成一个部门到多部门试点的生产发布准备。

- 性能和容量压测、依赖和镜像安全扫描、审计留存与数据脱敏；
- 灰度、回滚、备份恢复、故障应急和运维手册；
- 产品指标、SLA/SLO、告警阈值和版本发布清单；
- 用真实但脱敏的训战完成从建题到能力画像的全链路验收。

### 7.5 后置接口：GitLab CI 自动评测

根据当前产品决策，GitLab CI 自动评测接口放在核心平台完成之后。它应作为新的 `GradingExecutor`/Worker 适配器接入，不得复制一套评分或结果入库逻辑。接口仍必须输出同一 `evaluation-result` 契约，并经过平台的 Schema、归属、幂等和重算校验。

## 8. 下一位 Codex 的推荐起点

当前代码纵切面已经覆盖 PostgreSQL Repository/Unit of Work、服务端员工分页、赛题/训战与提交/评测的关键约束、对象存储物化和规范化备份恢复；本地临时 PostgreSQL 已完成迁移、集成、导入和恢复演练，容量与安全基线也已记录。下一步不再重复 W1 迁移，而是进入发布环境门禁与剩余领域收口：

1. 在目标环境接入真实 S3 兼容对象存储，验证上传确认、哈希、下载物化、Worker 清理和故障重试（本地 MinIO 生产配置验收已完成）；
2. 接入真实 OIDC/JWKS 与 Worker 服务身份，执行组织/角色/场次访问矩阵及审计留存验收；
3. 在目标环境复验 PostgreSQL 迁移、JSON 导入、备份恢复、并发租约，并补容量压测和安全扫描；
4. 复核 OpenAPI、Schema、迁移、CHANGELOG 和回滚清单后，在目标环境完成 v0.8.x 的身份、对象存储、Worker 沙箱和回滚门禁。

### 8.1 v0.8.2 评审提出的优先事项

以下条目来自 v0.8.2 的全局代码评审，按建议顺序排列。前两项是本轮发现但未修复的真实缺口，应优先于 §7.3 的功能开发。

1. **服务端富文本白名单清洗（安全，最高优先级）。** 赛题详情 `description` 以 `dangerouslySetInnerHTML` 渲染给全体参与者，但清洗只发生在浏览器端的 `apps/web/src/rich-text.ts`。任何能调用赛题写接口的账号都可以绕过前端直接 POST 原始 HTML，存储的内容会原样返回给所有人。应在 API 写入路径上做同一套标签/属性白名单清洗，并对已有数据做一次性回填；前端清洗保留为纵深防御，但不能当作保证。§7.3 已列出该项，建议提前到下一个版本。
2. **Worker 解压的独立体积上限。** `scripts/evaluation-worker.mjs` 的 `safeExtract` 正确拒绝了绝对路径、`..` 和符号链接，但没有自己的解压后体积上限，完全依赖 API 入库前的 `validateArchive`。Worker 是独立进程且未来会从对象存储直接物化，应在解压侧也强制 `maxFiles` / `maxExpandedBytes`，让防护不依赖调用方。
3. **拆分 `store.ts` 与 `admin.tsx`。** 两个文件分别为 240KB 和 228KB，`PlatformStore` 同时承担状态机、授权、审计和持久化四种职责。这是当前最大的可维护性风险，也是 §7.3 前端模块化的前置条件。建议按领域（赛题/训战、提交/评测、组织/人员、报告/画像）逐个切出窄接口，每次迁移保持测试绿色，不要一次性重写。
4. **补齐身份层的算法矩阵测试。** 本轮的 `ES256` 缺陷之所以能发布，是因为 `identity.test.ts` 只覆盖了 `RS256`。允许列表中的每个算法（`RS256`/`RS384`/`RS512`/`ES256`）都应有一条使用真实密钥对的正向用例，新增算法时同步补充。
5. **让契约测试覆盖 `postinstall` 之类的环境前置。** 建议在 CI 增加一个从干净容器执行 `pnpm install && pnpm test` 的作业，避免再次出现「本地绿、全新克隆红」的偏差。

开始任务前还应检查：

```powershell
git status --short --branch
git log -5 --oneline --decorate
pnpm install
pnpm contract:test
pnpm grader:test
pnpm test
```

不要仅凭本文档断言某功能存在；先从 OpenAPI、实现和测试三处交叉验证。

## 9. 环境和运行方式

要求 Node.js 20+、pnpm 11 和 Python 3.11+。

```powershell
pnpm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r grader/requirements.txt
```

启动 API 和 Web：

```powershell
pnpm dev:api
pnpm dev:web
```

- API：`http://127.0.0.1:3000/api/v1`
- 健康检查：`http://127.0.0.1:3000/api/v1/health`
- Web：`http://127.0.0.1:5173`
- 本地管理员：`w00123`
- 本地学员：`w00124`–`w00132`

环境变量和 Worker 示例见 `.env.example` 与 `README.md`。开发数据默认写入 `tmp/`。

## 10. 工程约束

- 契约先行：新增 API 先改 OpenAPI，跨进程结构先改版本化 JSON Schema；
- 测试先行：先写合法/非法样例和失败测试，再实现业务逻辑；
- 不可信代码隔离：不在 Node API 进程内执行学员代码；
- 不可变性：提交快照、引擎包、已发布 Schema/rubric、历史评测结果不可原地修改；
- 权限在服务端执行：前端隐藏按钮不是授权；所有管理写操作必须审计；
- 组织范围统一使用规范化路径，部门管理员只能作用于授权路径及子路径；
- 不信任评测器自报的员工、组织和总分；平台以提交快照覆盖并重算；
- 不将真实员工、客户、仓库凭据、生产源码或 SSO 断言写入测试、日志和 fixture；
- 失败要显式返回稳定错误，不吞异常、不放宽校验、不通过删除测试修复失败。

## 11. 验证与发布清单

受影响模块至少运行对应测试；发布版本运行完整检查：

```powershell
pnpm contract:test
pnpm grader:test
pnpm test
pnpm build
pnpm acceptance:local
git diff --check
```

涉及真实批次协议时还要运行 `services/platform-api/test/evaluation-worker.test.ts` 所覆盖的 Worker/Code Agent 端到端场景。涉及 UI 时应在浏览器中以全局管理员、部门管理员和学员身份分别验证关键路径。

提交前确认：

- 工作区没有误提交 `tmp/`、凭据、构建产物或个人文件；
- 根目录、Web、API 版本一致；
- 本文档、`CHANGELOG.md` 和实际行为一致；
- OpenAPI、JSON Schema、样例和实现一致；
- 新增迁移没有修改已发布迁移；
- 明确记录未解决风险，不用“已完成”掩盖本地适配器限制。

## 12. 专项文档索引

- `CHANGELOG.md`：逐版本详细变更；
- `contracts/openapi.yaml`：HTTP API 事实来源；
- `contracts/evaluation-contract-catalog.json`：Git 固定的评测输入/输出下拉目录；
- `docs/evaluation-contract-authoring.md`：管理员与 AI 开发赛题时的契约选择、示例和配置说明；
- `docs/evaluation-engine-protocol.md`：评测引擎、Worker 与 Code Agent ABI；
- `docs/v0.8-development-manual.md`：v0.8.x 评测运行环境、Worker 可观测性、管理运营和身份层约束开发手册；
- `docs/submission-contract.md`：赛题交付目录规范；
- `docs/capability-model.md`：四维、16 点与八能力域计算模型；
- `docs/architecture/grading-flow.md`：当前评测数据流；
- `docs/architecture/data-adapter.md`：本地/生产适配器边界；
- `docs/architecture/security-boundary.md`：身份、文件、Worker 和网络安全边界；
- `docs/adr/0001-local-first-adapters.md`：本地优先适配器的架构决策；
- `AI训战平台设计方案.html`：原始业务设计参考。

--- END FILE: DEVELOPMENT_PLAN.md ---


--- BEGIN FILE: README.md ---

# 分组核心网AI能力提升平台

企业内部 AI 训战、交付评测和能力复盘平台。当前版本为 `v0.8.8`，核心业务闭环可在本地验收，生产化边界和后续路线见 [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)。

## 当前能力

- 赛题库、版本发布、富文本详情、归档、垃圾箱和难题榜；
- 训战时间、分区、赛制、交付方式、评测策略和参与范围；
- ZIP / 受控 Git 提交、不可变快照和赛题级目录结构校验；
- 管理员精确选择一名或多名员工，发起 Code Agent 批次评测；
- Worker 物化交付件、引擎、`instruction.md`、Skills 和契约，回传结构化结果；
- 结果 Schema、提交归属、幂等和服务端分数重算；
- 详细报告、个人画像、部门或指定员工集合的聚合画像；
- SSO 首次建档、组织树、角色、名单、公告和操作审计；
- 全局管理员与部门管理员的分层权限。
- 评测环境默认 OpenCode 配置、平台/Worker 诊断、受控启动命令测试和 Worker 日志目录；
- 评测引擎开发指南与独立 Markdown/ZIP 资料包，可脱离代码仓库交给其他 AI 开发；
- 员工昵称/头像、多人批量调部门、部门层级自动识别和本地多身份切换；
- 服务端统一校验训战时间窗口，窗口外不可进入或提交。
- 垃圾箱赛题支持带审计的永久删除；所有禁用控件统一显示禁止点击光标。

当前数据、交付件、身份和 Git 均使用本地适配器，不能直接作为生产部署方案。完整架构、限制和版本沿革见开发总览。

## 环境

- Node.js 20+
- pnpm 11
- Python 3.11+

```powershell
pnpm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r grader/requirements.txt
```

## 启动

分别启动 API 和 Web：

```powershell
pnpm dev:api
pnpm dev:web
```

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3000/api/v1`
- 健康检查：`http://127.0.0.1:3000/api/v1/health`
- 本地全局管理员：`w00123`
- 本地学员：`w00124`、`w00126`
- 本地导师：`w00133`

前端默认使用 `w00123`。可设置 `VITE_EMPLOYEE_ID` 模拟其他身份：

```powershell
$env:VITE_EMPLOYEE_ID='w00124'
pnpm dev:web
```

使用 `pnpm dev:web` 时，页面右上角会显示“本地身份”下拉框，可直接切换已初始化的管理员、部门管理员、导师和参训员工。切换后页面会刷新并使用对应工号重新请求 API。该入口只用于本地测试，生产构建默认不显示；不要在生产环境设置 `VITE_LOCAL_IDENTITY_SWITCHER=true`。

开发数据默认写入 `tmp/platform-data.json` 和 `tmp/artifacts/`。所有可配置项见 [`.env.example`](.env.example)。

## 本地批次评测

管理员在“评测中心”选择同一训战中的提交并发起评测后，平台创建不可变 `EvaluationBatch`。另开终端启动 Worker：

```powershell
$env:CODE_AGENT_COMMAND=(Get-Command node).Source
$bridge=(Resolve-Path .\scripts\code-agent-local-bridge.mjs).Path
$env:CODE_AGENT_ARGS_JSON=(ConvertTo-Json @($bridge) -Compress)
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker local-eval-host
```

本地 bridge 只用于验证批次 ABI。正式环境由全局管理员配置受控的 Code Agent 启动命令，并由独立 Worker 主机提供凭据和沙箱。API 内嵌执行器默认关闭，只保留兼容测试。

## 验证

```powershell
pnpm contract:test
pnpm grader:test
pnpm test
pnpm kit:test
pnpm ldap3:test
pnpm build
pnpm acceptance:local
```

## 文档

- [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)：架构、设计、版本沿革、当前状态和下一步；
- [`CHANGELOG.md`](CHANGELOG.md)：逐版本详细记录；
- [`contracts/openapi.yaml`](contracts/openapi.yaml)：API 契约；
- [`docs/evaluation-engine-protocol.md`](docs/evaluation-engine-protocol.md)：Worker、Code Agent 和评测引擎协议；
- [`docs/v0.8-development-manual.md`](docs/v0.8-development-manual.md)：v0.8.x 评测运行环境、管理运营与身份层约束开发手册；
- [`docs/deployment/ldap3-trusted-gateway.md`](docs/deployment/ldap3-trusted-gateway.md)：LDAP3 统一认证网关接入说明；
- [`docs/deployment/ldap3-nginx-intranet-deployment.md`](docs/deployment/ldap3-nginx-intranet-deployment.md)：内网单服务器 Nginx + LDAP3 部署手册（可直接交给弱模型执行）；
- [`docs/deployment/windows-production-smoke-test.md`](docs/deployment/windows-production-smoke-test.md)：Windows 个人电脑上的生产模式端到端验收手册；
- [`docs/submission-contract.md`](docs/submission-contract.md)：交付目录契约；
- [`docs/capability-model.md`](docs/capability-model.md)：能力模型；
- [`AI训战平台设计方案.html`](AI训战平台设计方案.html)：原始产品设计参考。

开始开发前先阅读 [`AGENTS.md`](AGENTS.md) 和 [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)。

--- END FILE: README.md ---


--- BEGIN FILE: contracts/challenge.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/challenge.schema.json",
  "title": "Challenge",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "id",
    "version",
    "title",
    "origin",
    "zone",
    "languagePolicy",
    "deliveryPolicy",
    "rubricVersion",
    "submissionContract"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{2,63}$" },
    "version": { "type": "integer", "minimum": 1 },
    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
    "description": { "type": "string", "maxLength": 2000 },
    "objectives": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 20 },
    "requirements": { "type": "array", "items": { "type": "string", "maxLength": 1000 }, "maxItems": 50 },
    "constraints": { "type": "array", "items": { "type": "string", "maxLength": 1000 }, "maxItems": 50 },
    "deliverables": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 20 },
    "tags": { "type": "array", "items": { "type": "string", "maxLength": 50 }, "uniqueItems": true, "maxItems": 20 },
    "estimatedMinutes": { "type": "integer", "minimum": 1, "maximum": 10080 },
    "origin": { "enum": ["official", "crowdsourced", "bounty", "explore"] },
    "zone": { "enum": ["blue", "yellow"] },
    "ownerOrgPath": { "type": "string", "pattern": "^(/[A-Za-z0-9_-]+)+/$" },
    "languagePolicy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mode", "languages"],
      "properties": {
        "mode": { "enum": ["fixed", "free"] },
        "languages": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["python", "java", "go"] }
        }
      }
    },
    "deliveryPolicy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["allowedSources"],
      "properties": {
        "allowedSources": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["UPLOAD", "GIT_REF"] }
        },
        "upload": {
          "type": "object",
          "additionalProperties": false,
          "required": ["formats", "maxBytes", "maxFiles"],
          "properties": {
            "formats": { "type": "array", "minItems": 1, "items": { "enum": ["zip", "tar.gz"] } },
            "maxBytes": { "type": "integer", "minimum": 1, "maximum": 1073741824 },
            "maxFiles": { "type": "integer", "minimum": 1, "maximum": 100000 },
            "allowResubmit": { "type": "boolean", "default": true }
          }
        },
        "git": {
          "type": "object",
          "additionalProperties": false,
          "required": ["provider", "repository", "pinAt", "credentialRef"],
          "properties": {
            "provider": { "const": "GITLAB" },
            "repository": { "type": "string", "pattern": "^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$" },
            "branch": { "type": "string", "minLength": 1, "maxLength": 200 },
            "branchTemplate": { "type": "string", "pattern": "^[A-Za-z0-9_./{}-]+$" },
            "pinAt": { "enum": ["SUBMIT", "DEADLINE"] },
            "credentialRef": { "type": "string", "pattern": "^[A-Za-z0-9_.-]+$" }
          },
          "oneOf": [
            { "required": ["branch"] },
            { "required": ["branchTemplate"] }
          ]
        }
      },
      "allOf": [
        {
          "if": { "properties": { "allowedSources": { "contains": { "const": "UPLOAD" } } } },
          "then": { "required": ["upload"] }
        },
        {
          "if": { "properties": { "allowedSources": { "contains": { "const": "GIT_REF" } } } },
          "then": { "required": ["git"] }
        }
      ]
    },
    "rubricVersion": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+$" },
    "submissionContract": { "type": "string", "minLength": 1 },
    "requiredRepos": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
    "tests": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "public": { "type": "array", "items": { "type": "string" } },
        "hidden": { "type": "array", "items": { "type": "string" } },
        "golden": { "type": "array", "items": { "type": "string" } }
      }
    },
    "resources": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "starter": { "type": "string" },
        "reference": { "type": "string" },
        "attachments": { "type": "array", "items": { "type": "string" } }
      }
    },
    "resourceLimits": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 3600 },
        "memoryMb": { "type": "integer", "minimum": 64, "maximum": 65536 },
        "maxOutputBytes": { "type": "integer", "minimum": 1024, "maximum": 1073741824 }
      }
    },
    "changePackage": { "type": "object", "additionalProperties": true },
    "visibility": { "enum": ["PUBLIC", "ORG", "PRIVATE"] },
    "bounty": { "type": "number", "minimum": 0 },
    "explore": { "type": "boolean" },
    "metadata": { "type": "object", "additionalProperties": true }
  }
}

--- END FILE: contracts/challenge.schema.json ---


--- BEGIN FILE: contracts/engine-invocation.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/engine-invocation.schema.json",
  "title": "Engine Invocation Input",
  "description": "平台在沙箱内交给打包评测引擎的单份输入（`--input` 指向的 JSON）。与 evaluation-input.schema.json 的区别：那份是下发给平台外评测者的批量清单，这份是引擎进程一次调用的输入，含沙箱内的真实路径。",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "generatedAt",
    "engine",
    "challenge",
    "grading",
    "subject",
    "submission",
    "workspace",
    "outputPath"
  ],
  "properties": {
    "schemaVersion": {
      "const": "1.0"
    },
    "generatedAt": {
      "type": "string",
      "format": "date-time"
    },
    "engine": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "version",
        "packageHash",
        "packageRoot"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        },
        "packageHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$",
          "description": "上传引擎包的内容哈希；内置执行器为其目录内容哈希。"
        },
        "packageRoot": {
          "type": "string",
          "minLength": 1,
          "description": "解包后的引擎目录，隐藏测试和提交契约都在其中。"
        },
        "assets": {
          "type": "object",
          "additionalProperties": false,
          "description": "engine.json 声明的资产，已解析为沙箱内的绝对路径。",
          "properties": {
            "submissionContract": {
              "type": "string"
            },
            "testsDir": {
              "type": "string"
            },
            "referenceDir": {
              "type": "string"
            }
          }
        },
        "source": {
          "enum": [
            "BUILT_IN",
            "PACKAGE"
          ],
          "description": "BUILT_IN 来自仓库 executors/ 目录，PACKAGE 来自上传的引擎包。"
        }
      }
    },
    "challenge": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "challengeVersion",
        "rubricVersion"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "title": {
          "type": "string"
        },
        "challengeVersion": {
          "type": "string",
          "minLength": 1
        },
        "rubricVersion": {
          "type": "string",
          "minLength": 1
        },
        "zone": {
          "enum": [
            "YELLOW",
            "BLUE"
          ]
        },
        "languagePolicy": {
          "type": "object",
          "additionalProperties": true
        }
      }
    },
    "grading": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "runId",
        "idempotencyKey",
        "triggerType",
        "attempt"
      ],
      "description": "结果 JSON 必须原样带回 runId / idempotencyKey / triggerType，平台据此确认结果归属。",
      "properties": {
        "runId": {
          "type": "string",
          "minLength": 1
        },
        "idempotencyKey": {
          "type": "string",
          "pattern": "^[a-f0-9]{16,128}$"
        },
        "triggerType": {
          "enum": [
            "AUTO",
            "MANUAL",
            "IMPORT"
          ]
        },
        "attempt": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "subject": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id"
      ],
      "description": "引擎不得用它改写身份；平台在入库时以登记值为准覆盖。仅用于生成可读报告。",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string"
        },
        "orgPath": {
          "type": "string"
        }
      }
    },
    "submission": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "sourceType",
        "snapshotHash",
        "submittedAt"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "sourceType": {
          "enum": [
            "UPLOAD",
            "GIT_REF"
          ]
        },
        "snapshotHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "artifactHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "repository": {
          "type": "string"
        },
        "branch": {
          "type": "string"
        },
        "commitSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{7,64}$"
        },
        "submittedAt": {
          "type": "string",
          "format": "date-time"
        }
      }
    },
    "workspace": {
      "type": "string",
      "minLength": 1,
      "description": "已规范化的交付件目录，引擎只读。"
    },
    "outputPath": {
      "type": "string",
      "minLength": 1,
      "description": "引擎必须把符合 evaluation-result.schema.json 的结果写到这里。"
    },
    "scratchDir": {
      "type": "string",
      "minLength": 1,
      "description": "引擎唯一可写的临时目录；沙箱退出后清除。"
    },
    "limits": {
      "type": "object",
      "additionalProperties": false,
      "description": "沙箱实际生效的上限，供引擎自行留出余量。",
      "properties": {
        "wallClockSeconds": {
          "type": "integer",
          "minimum": 1
        },
        "memoryMB": {
          "type": "integer",
          "minimum": 1
        },
        "outputBytes": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "params": {
      "type": "object",
      "additionalProperties": true,
      "description": "赛题为该执行器填写的参数值，形状由执行器清单的 params 声明。"
    }
  }
}

--- END FILE: contracts/engine-invocation.schema.json ---


--- BEGIN FILE: contracts/evaluation-agent-batch-v1.1.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/evaluation-agent-batch-v1.1.schema.json",
  "title": "Code Agent Evaluation Batch Manifest v1.1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "generatedAt", "batch", "agent", "contracts", "engine", "challenge", "submissions", "resultIndexPath"],
  "properties": {
    "schemaVersion": { "const": "1.1" },
    "generatedAt": { "type": "string", "format": "date-time" },
    "batch": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "leaseId", "challengeVersion"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "leaseId": { "type": "string", "minLength": 1 },
        "challengeVersion": { "type": "string", "minLength": 1 }
      }
    },
    "agent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["instructionPath", "skillPaths"],
      "properties": {
        "instructionPath": { "type": "string", "minLength": 1 },
        "skillPaths": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } }
      }
    },
    "contracts": {
      "type": "object",
      "additionalProperties": false,
      "required": ["input", "output"],
      "properties": {
        "input": { "$ref": "#/$defs/materializedContract" },
        "output": { "$ref": "#/$defs/materializedContract" }
      }
    },
    "engine": {
      "type": "object",
      "additionalProperties": true,
      "required": ["id", "version", "source", "packageHash", "root", "entrypoint", "assets", "params", "limits"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "version": { "type": "string", "minLength": 1 },
        "source": { "enum": ["BUILT_IN", "PACKAGE"] },
        "packageHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "root": { "type": "string", "minLength": 1 },
        "entrypoint": { "type": "string", "minLength": 1 },
        "assets": { "type": "object" },
        "params": { "type": "object" },
        "limits": { "type": "object" }
      }
    },
    "challenge": { "type": "object" },
    "submissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": true,
        "required": ["runId", "idempotencyKey", "subject", "submission", "workspace", "outputPath", "scratchDir"],
        "properties": {
          "runId": { "type": "string", "minLength": 1 },
          "idempotencyKey": { "type": "string", "minLength": 1 },
          "subject": { "type": "object" },
          "submission": { "type": "object" },
          "workspace": { "type": "string", "minLength": 1 },
          "outputPath": { "type": "string", "minLength": 1 },
          "scratchDir": { "type": "string", "minLength": 1 }
        }
      }
    },
    "resultIndexPath": { "type": "string", "minLength": 1 }
  },
  "$defs": {
    "materializedContract": {
      "type": "object",
      "additionalProperties": false,
      "required": ["format", "schemaVersion", "sourcePath", "path", "sha256"],
      "properties": {
        "format": { "const": "JSON" },
        "schemaVersion": { "type": "string", "minLength": 1 },
        "sourcePath": { "type": "string", "minLength": 1 },
        "path": { "type": "string", "minLength": 1 },
        "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
      }
    }
  }
}

--- END FILE: contracts/evaluation-agent-batch-v1.1.schema.json ---


--- BEGIN FILE: contracts/evaluation-agent-batch.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/evaluation-agent-batch.schema.json",
  "title": "Code Agent Evaluation Batch Manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "generatedAt", "batch", "agent", "engine", "challenge", "submissions", "resultIndexPath"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "generatedAt": { "type": "string", "format": "date-time" },
    "batch": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "leaseId", "challengeVersion"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "leaseId": { "type": "string", "minLength": 1 },
        "challengeVersion": { "type": "string", "minLength": 1 }
      }
    },
    "agent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["instructionPath", "skillPaths"],
      "properties": {
        "instructionPath": { "type": "string", "minLength": 1 },
        "skillPaths": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } }
      }
    },
    "engine": {
      "type": "object",
      "additionalProperties": true,
      "required": ["id", "version", "source", "packageHash", "root", "entrypoint", "assets", "params", "limits"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "version": { "type": "string", "minLength": 1 },
        "source": { "enum": ["BUILT_IN", "PACKAGE"] },
        "packageHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "root": { "type": "string", "minLength": 1 },
        "entrypoint": { "type": "string", "minLength": 1 },
        "assets": { "type": "object" },
        "params": { "type": "object" },
        "limits": { "type": "object" }
      }
    },
    "challenge": { "type": "object" },
    "submissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": true,
        "required": ["runId", "idempotencyKey", "subject", "submission", "workspace", "outputPath", "scratchDir"],
        "properties": {
          "runId": { "type": "string", "minLength": 1 },
          "idempotencyKey": { "type": "string", "minLength": 1 },
          "subject": { "type": "object" },
          "submission": { "type": "object" },
          "workspace": { "type": "string", "minLength": 1 },
          "outputPath": { "type": "string", "minLength": 1 },
          "scratchDir": { "type": "string", "minLength": 1 }
        }
      }
    },
    "resultIndexPath": { "type": "string", "minLength": 1 }
  }
}

--- END FILE: contracts/evaluation-agent-batch.schema.json ---


--- BEGIN FILE: contracts/evaluation-agent-result-index.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/evaluation-agent-result-index.schema.json",
  "title": "Code Agent Evaluation Batch Result Index",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "batchId", "results", "failures"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "batchId": { "type": "string", "minLength": 1 },
    "results": {
      "type": "array",
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["runId"],
        "properties": {
          "runId": { "type": "string", "minLength": 1 },
          "result": { "type": "object" },
          "resultPath": { "type": "string", "minLength": 1 }
        },
        "oneOf": [
          { "required": ["result"] },
          { "required": ["resultPath"] }
        ]
      }
    },
    "failures": {
      "type": "array",
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["runId", "reason"],
        "properties": {
          "runId": { "type": "string", "minLength": 1 },
          "reason": { "type": "string", "minLength": 1, "maxLength": 2000 }
        }
      }
    }
  }
}

--- END FILE: contracts/evaluation-agent-result-index.schema.json ---


--- BEGIN FILE: contracts/evaluation-contract-catalog.json ---

{
  "schemaVersion": "1.0",
  "contracts": [
    {
      "id": "external-evaluation-input-v1",
      "kind": "INPUT",
      "visibility": "PUBLIC",
      "modes": ["EXTERNAL_CLI"],
      "schemaVersion": "1.0",
      "path": "contracts/evaluation-input.schema.json",
      "label": "外部评测批次输入约束 v1.0",
      "description": "EXTERNAL_CLI 线下评测使用的批次清单；评测完成后通过统一结果约束导入。",
      "examplePath": "contracts/examples/evaluation-input.external.valid.json",
      "guidePath": "docs/evaluation-contract-authoring.md"
    },
    {
      "id": "code-agent-batch-input-v1.1",
      "kind": "INPUT",
      "visibility": "PUBLIC",
      "modes": ["PLATFORM_LOCAL", "PACKAGED"],
      "schemaVersion": "1.1",
      "path": "contracts/evaluation-agent-batch-v1.1.schema.json",
      "label": "Code Agent 批次输入约束 v1.1",
      "description": "平台 Worker 交给 Code Agent 的批次清单；在线内置执行器和打包引擎共用。",
      "examplePath": "contracts/examples/evaluation-agent-batch.valid.json",
      "guidePath": "docs/evaluation-contract-authoring.md"
    },
    {
      "id": "platform-evaluation-result-v1",
      "kind": "OUTPUT",
      "visibility": "PUBLIC",
      "modes": ["EXTERNAL_CLI", "PLATFORM_LOCAL", "PACKAGED"],
      "schemaVersion": "1.0",
      "path": "contracts/evaluation-result.schema.json",
      "label": "平台统一评测输出约束 v1.0",
      "description": "所有评测方式最终都必须返回的平台结果信封；平台会重新校验归属、Schema 和总分。",
      "examplePath": "contracts/examples/evaluation-result.valid.json",
      "guidePath": "docs/evaluation-contract-authoring.md"
    },
    {
      "id": "engine-invocation-input-v1",
      "kind": "INPUT",
      "visibility": "INTERNAL",
      "modes": ["PACKAGED"],
      "schemaVersion": "1.0",
      "path": "contracts/engine-invocation.schema.json",
      "label": "打包引擎单份调用输入约束 v1.0",
      "description": "仅供平台桥接器传给引擎进程，包含沙箱路径；不是管理员赛题编辑器的可选批次输入约束。",
      "examplePath": "contracts/examples/engine-invocation.valid.json",
      "guidePath": "docs/evaluation-contract-authoring.md"
    },
    {
      "id": "legacy-platform-local-input-v1",
      "kind": "INPUT",
      "visibility": "INTERNAL",
      "modes": ["PLATFORM_LOCAL"],
      "schemaVersion": "1.0",
      "path": "contracts/evaluation-input.schema.json",
      "label": "旧版内置评测输入约束 v1.0",
      "description": "兼容历史文件适配器数据；新建或编辑赛题时应选择 Code Agent 批次输入约束 v1.1。",
      "examplePath": "contracts/examples/evaluation-input.external.valid.json",
      "guidePath": "docs/evaluation-contract-authoring.md"
    }
  ]
}

--- END FILE: contracts/evaluation-contract-catalog.json ---


--- BEGIN FILE: contracts/evaluation-contract-catalog.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/evaluation-contract-catalog.schema.json",
  "title": "Evaluation Contract Catalog",
  "description": "平台随 Git 发布的评测输入/输出约束目录。管理员只能选择 visibility=PUBLIC 的约束。",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "contracts"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "contracts": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": { "$ref": "#/$defs/contract" }
    }
  },
  "$defs": {
    "contract": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "kind", "visibility", "modes", "schemaVersion", "path", "label", "description", "examplePath", "guidePath"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z][a-z0-9.-]{2,95}$" },
        "kind": { "enum": ["INPUT", "OUTPUT"] },
        "visibility": { "enum": ["PUBLIC", "INTERNAL"] },
        "modes": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["EXTERNAL_CLI", "PLATFORM_LOCAL", "PACKAGED"] }
        },
        "schemaVersion": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$" },
        "path": { "type": "string", "pattern": "^contracts/[A-Za-z0-9_.-]+\\.schema\\.json$" },
        "label": { "type": "string", "minLength": 1, "maxLength": 120 },
        "description": { "type": "string", "minLength": 1, "maxLength": 500 },
        "examplePath": { "type": "string", "pattern": "^contracts/examples/[A-Za-z0-9_.-]+\\.json$" },
        "guidePath": { "type": "string", "pattern": "^(docs|contracts)/[A-Za-z0-9_./-]+\\.(md|txt)$" }
      }
    }
  }
}

--- END FILE: contracts/evaluation-contract-catalog.schema.json ---


--- BEGIN FILE: contracts/evaluation-engine-package.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/evaluation-engine-package.schema.json",
  "title": "Evaluation Engine Package Manifest",
  "description": "engine.json：评测引擎清单。仓库内置执行器（executors/<id>/engine.json）和出题人上传的引擎包共用这一份格式，区别只在于前者随平台发布、可被多道赛题选用并接受 params，后者按内容哈希固化、通常自带判据。",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "id",
    "version",
    "runtime"
  ],
  "properties": {
    "schemaVersion": {
      "enum": ["1.0", "1.1"]
    },
    "id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$",
      "description": "引擎标识，同一道题的不同版本应保持一致。"
    },
    "version": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$",
      "description": "引擎版本。它与包内容哈希共同决定评测幂等键；改判据必须升版本。"
    },
    "title": {
      "type": "string",
      "maxLength": 120,
      "description": "下拉框里展示的名称。内置执行器必填。"
    },
    "description": {
      "type": "string",
      "maxLength": 500
    },
    "runtime": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type",
        "entrypoint"
      ],
      "properties": {
        "type": {
          "const": "python"
        },
        "entrypoint": {
          "$ref": "#/$defs/packagePath",
          "description": "包内的判题入口脚本。平台以 `python -I <entrypoint> --input <in.json> --output <out.json>` 调用。"
        },
        "requirements": {
          "$ref": "#/$defs/packagePath",
          "description": "可选。声明式依赖清单；运行主机会为该引擎版本创建一次性虚拟环境并安装，之后按包哈希复用。"
        },
        "pythonVersion": {
          "type": "string",
          "maxLength": 32,
          "description": "可选的建议解释器版本，仅记录与提示，不参与执行选择。"
        }
      }
    },
    "params": {
      "type": "object",
      "description": "每道赛题选用该执行器时需要填写的参数，本身是一份 JSON Schema，管理后台据此动态渲染表单。通用的内置执行器靠它接收入口文件、隐藏测试目录等题目相关配置；自带判据的引擎包通常不需要。",
      "additionalProperties": true,
      "required": [
        "type"
      ],
      "properties": {
        "type": {
          "const": "object"
        },
        "required": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "properties": {
          "type": "object",
          "additionalProperties": true
        }
      }
    },
    "limits": {
      "type": "object",
      "additionalProperties": false,
      "description": "单份提交的执行上限。平台会与全局上限取较小值。",
      "properties": {
        "wallClockSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1800
        },
        "memoryMB": {
          "type": "integer",
          "minimum": 64,
          "maximum": 4096
        },
        "outputBytes": {
          "type": "integer",
          "minimum": 1024,
          "maximum": 33554432
        }
      }
    },
    "assets": {
      "type": "object",
      "additionalProperties": false,
      "description": "包内随判据一起冻结的资产。路径相对于包根目录。",
      "properties": {
        "submissionContract": {
          "$ref": "#/$defs/packagePath"
        },
        "testsDir": {
          "$ref": "#/$defs/packagePath"
        },
        "referenceDir": {
          "$ref": "#/$defs/packagePath",
          "description": "可选的参考实现目录。提供后，发布赛题版本时平台会用它自检引擎。"
        }
      }
    },
    "agent": {
      "type": "object",
      "additionalProperties": false,
      "description": "Code Agent 读取的评测指令与 skills，路径相对于冻结后的引擎根目录。1.1 引擎包必须声明。",
      "required": ["instruction", "skills"],
      "properties": {
        "instruction": {
          "$ref": "#/$defs/packagePath"
        },
        "skills": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/packagePath"
          }
        }
      }
    },
    "selfCheck": {
      "type": "object",
      "additionalProperties": false,
      "description": "发布前自检的期望结果。参考实现跑不出期望分数，说明判据或测试本身有问题。",
      "properties": {
        "expectMinTotal": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "expectStatus": {
          "enum": [
            "COMPLETE",
            "PARTIAL"
          ]
        }
      }
    },
    "platformDependencies": {
      "type": "object",
      "description": "仅限仓库内置执行器：需要随引擎一起冻结到评测批次的仓库目录。上传引擎包必须自包含，禁止声明此字段。",
      "maxProperties": 20,
      "propertyNames": {
        "pattern": "^[A-Za-z][A-Za-z0-9_.-]{1,63}$"
      },
      "additionalProperties": {
        "$ref": "#/$defs/packagePath"
      }
    },
    "metadata": {
      "type": "object",
      "additionalProperties": true
    }
  },
  "allOf": [
    {
      "if": {
        "properties": { "schemaVersion": { "const": "1.1" } },
        "required": ["schemaVersion"]
      },
      "then": {
        "required": ["agent"]
      }
    }
  ],
  "$defs": {
    "packagePath": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "pattern": "^(?!/)(?!.*\\.\\.)(?!.*\\\\)(?![A-Za-z]:).+$",
      "description": "包内相对路径，禁止绝对路径、盘符、反斜杠和 `..`。"
    }
  }
}

--- END FILE: contracts/evaluation-engine-package.schema.json ---


--- BEGIN FILE: contracts/evaluation-input.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/evaluation-input.schema.json",
  "title": "Evaluation Input Batch",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "generatedAt", "event", "challenge", "submissions"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "generatedAt": { "type": "string", "format": "date-time" },
    "event": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "challengeVersion", "rubricVersion", "trigger", "submissionSource", "reveal"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "challengeVersion": { "type": "string", "minLength": 1 },
        "rubricVersion": { "type": "string", "minLength": 1 },
        "trigger": { "const": "IMPORT" },
        "submissionSource": { "enum": ["UPLOAD", "GIT_REF"] },
        "reveal": { "enum": ["IMMEDIATE", "ON_RELEASE"] }
      }
    },
    "challenge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "title", "version", "evaluationEngine"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "title": { "type": "string", "minLength": 1 },
        "version": { "type": "integer", "minimum": 1 },
        "evaluationEngine": {
          "type": "object",
          "additionalProperties": false,
          "required": ["id", "version", "mode", "input", "output"],
          "properties": {
            "id": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$" },
            "version": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$" },
            "mode": { "enum": ["EXTERNAL_CLI", "PLATFORM_LOCAL"] },
            "input": { "$ref": "#/$defs/contract" },
            "output": { "$ref": "#/$defs/contract" }
          }
        }
      }
    },
    "submissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 500,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["submissionId", "subject", "snapshot", "grading"],
        "properties": {
          "submissionId": { "type": "string", "minLength": 1 },
          "subject": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "name", "orgPath"],
            "properties": {
              "id": { "type": "string", "minLength": 1 },
              "name": { "type": "string", "minLength": 1 },
              "orgPath": { "type": "string", "minLength": 1 }
            }
          },
          "snapshot": { "type": "object", "additionalProperties": true },
          "grading": {
            "type": "object",
            "additionalProperties": false,
            "required": ["runId", "idempotencyKey", "triggerType"],
            "properties": {
              "runId": { "type": "string", "minLength": 1 },
              "idempotencyKey": { "type": "string", "pattern": "^[a-f0-9]{16,128}$" },
              "triggerType": { "const": "IMPORT" }
            }
          }
        }
      }
    }
  },
  "$defs": {
    "contract": {
      "type": "object",
      "additionalProperties": false,
      "required": ["format", "schemaVersion", "contractPath"],
      "properties": {
        "format": { "const": "JSON" },
        "schemaVersion": { "type": "string", "minLength": 1 },
        "contractPath": { "type": "string", "minLength": 1 }
      }
    }
  }
}

--- END FILE: contracts/evaluation-input.schema.json ---


--- BEGIN FILE: contracts/evaluation-result.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/evaluation-result.schema.json",
  "title": "Evaluation Result",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "resultId",
    "gradingRunId",
    "challengeVersion",
    "rubricVersion",
    "graderVersion",
    "idempotencyKey",
    "triggerType",
    "status",
    "submission",
    "dimensions",
    "criteria",
    "total",
    "validationDiagnostics",
    "gradedBy",
    "startedAt",
    "finishedAt",
    "durationMs"
  ],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "resultId": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$" },
    "gradingRunId": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$" },
    "challengeVersion": { "type": "string", "minLength": 1 },
    "rubricVersion": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+$" },
    "graderVersion": { "type": "string", "minLength": 1 },
    "idempotencyKey": { "type": "string", "pattern": "^[a-f0-9]{16,128}$" },
    "triggerType": { "enum": ["AUTO", "MANUAL", "IMPORT"] },
    "status": { "enum": ["COMPLETE", "PARTIAL", "FAILED"] },
    "submission": { "$ref": "#/$defs/submission" },
    "project": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "zone", "type", "mode", "trigger", "reveal", "origin", "orgPath", "season", "languagePolicy"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "name": { "type": "string" },
        "repository": { "type": "string" },
        "branch": { "type": "string" },
        "commitSha": { "type": "string" },
        "path": { "type": "string" }
        ,"zone": { "enum": ["BLUE", "YELLOW", "blue", "yellow"] }
        ,"type": { "type": "string" }
        ,"mode": { "type": "string" }
        ,"trigger": { "enum": ["AUTO", "MANUAL", "IMPORT"] }
        ,"reveal": { "enum": ["IMMEDIATE", "ON_RELEASE"] }
        ,"origin": { "type": "string" }
        ,"orgPath": { "type": "string" }
        ,"season": { "type": ["string", "object"] }
        ,"languagePolicy": { "type": "object", "additionalProperties": true }
      }
    },
    "subject": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "id"],
      "properties": {
        "kind": { "enum": ["person", "team"] },
        "id": { "type": "string", "minLength": 1 },
        "name": { "type": "string" },
        "orgPath": { "type": "string" },
        "members": {
          "type": "array",
          "uniqueItems": true,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "role"],
            "properties": {
              "id": { "type": "string", "minLength": 1 },
              "name": { "type": "string" },
              "role": { "type": "string", "minLength": 1 }
            }
          }
        }
      }
    },
    "dimensions": {
      "type": "object",
      "additionalProperties": false,
      "required": ["verify", "spec", "code", "collab"],
      "properties": {
        "verify": { "$ref": "#/$defs/dimension" },
        "spec": { "$ref": "#/$defs/dimension" },
        "code": { "$ref": "#/$defs/dimension" },
        "collab": { "$ref": "#/$defs/dimension" }
      }
    },
    "total": { "type": "number", "minimum": 0, "maximum": 100 },
    "recalculatedTotal": { "type": "number", "minimum": 0, "maximum": 100 },
    "criteria": {
      "type": "array",
      "items": { "$ref": "#/$defs/criterion" }
    },
    "validationDiagnostics": {
      "type": "array",
      "items": { "$ref": "#/$defs/diagnostic" }
    },
    "findings": {
      "type": "array",
      "items": { "$ref": "#/$defs/finding" }
    },
    "verifyDetail": {
      "type": "object",
      "description": "本地或 CI 验证器的分档明细；具体字段由验证器版本决定。",
      "additionalProperties": true
    },
    "metrics": {
      "type": "object",
      "description": "静态分析指标；具体字段由分析器版本决定。",
      "additionalProperties": true
    },
    "extractions": {
      "type": "array",
      "description": "从交付件中抽取的可审计事实。",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "q", "a", "quote", "quoteVerified"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "q": { "type": "string", "minLength": 1 },
          "a": { "enum": ["yes", "no", "unclear"] },
          "quote": { "type": "string" },
          "quoteVerified": { "type": "boolean" },
          "source": { "type": "string" }
        }
      }
    },
    "anchor": {
      "type": "object",
      "description": "规格、代码和对话证据之间的定位锚点。",
      "additionalProperties": true
    },
    "gradedBy": { "enum": ["ci", "claude", "codex", "human"] },
    "triggeredBy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "kind": { "enum": ["system", "admin", "import"] },
        "actorId": { "type": "string" }
      }
    },
    "importedBy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["actorId", "importedAt"],
      "properties": {
        "actorId": { "type": "string", "minLength": 1 },
        "importedAt": { "type": "string", "format": "date-time" }
      }
    },
    "startedAt": { "type": "string", "format": "date-time" },
    "finishedAt": { "type": "string", "format": "date-time" },
    "gradedAt": { "type": "string", "format": "date-time" },
    "durationMs": { "type": "integer", "minimum": 0 },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "sha256"],
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
          "uri": { "type": "string" }
        }
      }
    },
    "metadata": {
      "type": "object",
      "additionalProperties": true
    }
  },
  "$defs": {
    "submission": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sourceType", "snapshotHash", "submittedAt"],
      "properties": {
        "sourceType": { "enum": ["UPLOAD", "GIT_REF"] },
        "snapshotHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "repository": { "type": "string" },
        "branch": { "type": "string" },
        "commitSha": { "type": "string", "pattern": "^[a-f0-9]{7,64}$" },
        "artifactUri": { "type": "string" },
        "artifactHash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "language": { "type": "string", "minLength": 1 },
        "root": { "type": "string", "minLength": 1 },
        "gradedAt": { "type": "string", "format": "date-time" },
        "submittedAt": { "type": "string", "format": "date-time" }
      },
      "allOf": [
        {
          "if": { "properties": { "sourceType": { "const": "GIT_REF" } } },
          "then": { "required": ["repository", "branch", "commitSha"] }
        },
        {
          "if": { "properties": { "sourceType": { "const": "UPLOAD" } } },
          "then": { "required": ["artifactHash"] }
        }
      ]
    },
    "dimension": {
      "type": "object",
      "additionalProperties": false,
      "required": ["score", "max", "evaluated"],
      "properties": {
        "score": { "type": ["number", "null"], "minimum": 0 },
        "max": { "type": "number", "exclusiveMinimum": 0 },
        "evaluated": { "type": "boolean" }
      },
      "oneOf": [
        { "properties": { "evaluated": { "const": true }, "score": { "type": "number", "minimum": 0 } } },
        { "properties": { "evaluated": { "const": false }, "score": { "type": "null" } } }
      ]
    },
    "criterion": {
      "type": "object",
      "additionalProperties": false,
      "required": ["key", "dim", "name", "max", "level", "score", "source", "rule"],
      "properties": {
        "key": { "type": "string", "pattern": "^[A-Z][A-Z0-9_-]{1,31}$" },
        "dim": { "enum": ["verify", "spec", "code", "collab"] },
        "name": { "type": "string", "minLength": 1 },
        "max": { "type": "number", "exclusiveMinimum": 0 },
        "level": { "enum": ["A", "B", "C", "D"] },
        "score": { "type": "number", "minimum": 0 },
        "source": { "enum": ["auto", "model", "human"] },
        "rule": { "type": "string", "minLength": 1 },
        "rationale": { "type": "string" },
        "evidence": {},
        "evidenceType": { "enum": ["test", "metric", "extraction", "human", "diagnostic"] },
        "ruleVersion": { "type": "string" }
      }
    },
    "diagnostic": {
      "type": "object",
      "additionalProperties": false,
      "required": ["severity", "code", "message"],
      "properties": {
        "severity": { "enum": ["BLOCKER", "WARNING", "INFO"] },
        "code": { "type": "string", "pattern": "^[A-Z0-9_]{2,64}$" },
        "path": { "type": "string" },
        "message": { "type": "string", "minLength": 1 }
      }
    },
    "finding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "dim", "criteria", "severity", "title", "detail"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "dim": { "enum": ["verify", "spec", "code", "collab"] },
        "criteria": { "type": "string", "minLength": 1 },
        "severity": { "enum": ["minor", "major", "critical"] },
        "title": { "type": "string", "minLength": 1 },
        "file": { "type": "string" },
        "line": { "type": "integer", "minimum": 1 },
        "snippet": { "type": "string" },
        "detail": { "type": "string", "minLength": 1 },
        "fix": { "type": "string" }
      }
    }
  }
}

--- END FILE: contracts/evaluation-result.schema.json ---


--- BEGIN FILE: contracts/examples/challenge.invalid.json ---

{
  "schemaVersion": "2.0",
  "id": "Bad ID",
  "version": 0,
  "title": "",
  "origin": "official",
  "zone": "yellow",
  "languagePolicy": { "mode": "fixed", "languages": [] },
  "deliveryPolicy": { "allowedSources": ["FTP"] },
  "rubricVersion": "latest",
  "submissionContract": ""
}

--- END FILE: contracts/examples/challenge.invalid.json ---


--- BEGIN FILE: contracts/examples/challenge.valid.json ---

{
  "schemaVersion": "1.0",
  "id": "parking-fee-01",
  "version": 1,
  "title": "停车场计费",
  "origin": "official",
  "zone": "yellow",
  "ownerOrgPath": "/1/12/125/",
  "languagePolicy": { "mode": "fixed", "languages": ["python"] },
  "deliveryPolicy": {
    "allowedSources": ["UPLOAD", "GIT_REF"],
    "upload": { "formats": ["zip"], "maxBytes": 52428800, "maxFiles": 2000, "allowResubmit": true },
    "git": {
      "provider": "GITLAB",
      "repository": "training/parking-fee",
      "branchTemplate": "drill/{subjectId}",
      "pinAt": "SUBMIT",
      "credentialRef": "gitlab-grader-readonly"
    }
  },
  "rubricVersion": "1.0",
  "submissionContract": "contracts/parking-fee-submission.json"
}

--- END FILE: contracts/examples/challenge.valid.json ---


--- BEGIN FILE: contracts/examples/engine-invocation.valid.json ---

{
  "schemaVersion": "1.0",
  "generatedAt": "2026-08-04T09:00:00.000Z",
  "engine": {
    "id": "example-packaged-evaluator",
    "version": "1.0.0",
    "packageHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "packageRoot": "/sandbox/engine",
    "source": "PACKAGE",
    "assets": {
      "submissionContract": "/sandbox/engine/assets/submission-contract.json",
      "testsDir": "/sandbox/engine/assets/hidden-tests"
    }
  },
  "challenge": {
    "id": "example-parking",
    "title": "示例：停车费计算",
    "challengeVersion": "example-parking@1",
    "rubricVersion": "1.0",
    "zone": "YELLOW",
    "languagePolicy": { "mode": "fixed", "languages": ["python"] }
  },
  "grading": {
    "runId": "run-example-001",
    "idempotencyKey": "0123456789abcdef0123456789abcdef",
    "triggerType": "MANUAL",
    "attempt": 1
  },
  "subject": { "id": "example-person-001", "name": "示例学员", "orgPath": "/example/" },
  "submission": {
    "id": "submission-example-001",
    "sourceType": "UPLOAD",
    "snapshotHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "artifactHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "submittedAt": "2026-08-04T08:55:00.000Z"
  },
  "workspace": "/sandbox/submission/workspace",
  "outputPath": "/sandbox/submission/result.json",
  "scratchDir": "/sandbox/submission/scratch",
  "limits": { "wallClockSeconds": 120, "memoryMB": 512, "outputBytes": 1048576 },
  "params": { "entry": "src/parking.py", "function": "calculate_fee" }
}

--- END FILE: contracts/examples/engine-invocation.valid.json ---


--- BEGIN FILE: contracts/examples/evaluation-agent-batch.valid.json ---

{
  "schemaVersion": "1.1",
  "generatedAt": "2026-08-04T09:00:00.000Z",
  "batch": {
    "id": "batch-example-001",
    "leaseId": "lease-example-001",
    "challengeVersion": "example-parking@1"
  },
  "agent": {
    "instructionPath": "engine/instruction.md",
    "skillPaths": ["engine/skills/evaluation"]
  },
  "contracts": {
    "input": {
      "format": "JSON",
      "schemaVersion": "1.1",
      "sourcePath": "contracts/evaluation-agent-batch-v1.1.schema.json",
      "path": "contracts/batch-input.schema.json",
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "output": {
      "format": "JSON",
      "schemaVersion": "1.0",
      "sourcePath": "contracts/evaluation-result.schema.json",
      "path": "contracts/evaluation-result.schema.json",
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  },
  "engine": {
    "id": "example-code-agent-evaluator",
    "version": "1.0.0",
    "source": "BUILT_IN",
    "packageHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "root": "engine",
    "entrypoint": "engine/judge.py",
    "assets": {},
    "params": {},
    "limits": { "wallClockSeconds": 120, "outputBytes": 1048576 }
  },
  "challenge": {
    "challengeVersion": "example-parking@1",
    "rubricVersion": "1.0"
  },
  "submissions": [
    {
      "runId": "run-example-001",
      "idempotencyKey": "0123456789abcdef0123456789abcdef",
      "subject": { "id": "example-person-001", "name": "示例学员", "orgPath": "/example/" },
      "submission": { "id": "submission-example-001", "snapshotHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      "workspace": "submissions/submission-example-001/workspace",
      "outputPath": "results/run-example-001.json",
      "scratchDir": "submissions/submission-example-001/scratch"
    }
  ],
  "resultIndexPath": "results/index.json"
}

--- END FILE: contracts/examples/evaluation-agent-batch.valid.json ---


--- BEGIN FILE: contracts/examples/evaluation-input.external.valid.json ---

{
  "schemaVersion": "1.0",
  "generatedAt": "2026-08-04T09:00:00.000Z",
  "event": {
    "id": "event-example-external",
    "challengeVersion": "example-parking@1",
    "rubricVersion": "1.0",
    "trigger": "IMPORT",
    "submissionSource": "UPLOAD",
    "reveal": "IMMEDIATE"
  },
  "challenge": {
    "id": "example-parking",
    "title": "示例：停车费计算",
    "version": 1,
    "evaluationEngine": {
      "id": "example-external-evaluator",
      "version": "1.0.0",
      "mode": "EXTERNAL_CLI",
      "input": {
        "format": "JSON",
        "schemaVersion": "1.0",
        "contractPath": "contracts/evaluation-input.schema.json"
      },
      "output": {
        "format": "JSON",
        "schemaVersion": "1.0",
        "contractPath": "contracts/evaluation-result.schema.json"
      }
    }
  },
  "submissions": [
    {
      "submissionId": "submission-example-001",
      "subject": {
        "id": "example-person-001",
        "name": "示例学员",
        "orgPath": "/example/"
      },
      "snapshot": {
        "sourceType": "UPLOAD",
        "snapshotHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "artifactHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "submittedAt": "2026-08-04T08:55:00.000Z"
      },
      "grading": {
        "runId": "run-example-001",
        "idempotencyKey": "0123456789abcdef0123456789abcdef",
        "triggerType": "IMPORT"
      }
    }
  ]
}

--- END FILE: contracts/examples/evaluation-input.external.valid.json ---


--- BEGIN FILE: contracts/examples/evaluation-result.invalid.json ---

{
  "schemaVersion": "1.0",
  "resultId": "bad",
  "gradingRunId": "bad",
  "challengeVersion": "parking-fee-01@1",
  "rubricVersion": "latest",
  "graderVersion": "",
  "idempotencyKey": "not-a-key",
  "triggerType": "PUSH",
  "status": "DONE",
  "submission": { "sourceType": "GIT_REF", "snapshotHash": "bad", "submittedAt": "not-date" },
  "dimensions": {},
  "criteria": [],
  "total": 101,
  "validationDiagnostics": [],
  "gradedBy": "robot",
  "startedAt": "not-date",
  "finishedAt": "not-date",
  "durationMs": -1
}

--- END FILE: contracts/examples/evaluation-result.invalid.json ---


--- BEGIN FILE: contracts/examples/evaluation-result.valid.json ---

{
  "schemaVersion": "1.0",
  "resultId": "result-001",
  "gradingRunId": "run-001",
  "challengeVersion": "parking-fee-01@1",
  "rubricVersion": "1.0",
  "graderVersion": "0.1.0",
  "idempotencyKey": "0123456789abcdef0123456789abcdef",
  "triggerType": "AUTO",
  "status": "COMPLETE",
  "submission": {
    "sourceType": "GIT_REF",
    "snapshotHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "repository": "training/parking-fee",
    "branch": "drill/w00123",
    "commitSha": "abcdef1234567",
    "submittedAt": "2026-08-01T10:00:00Z"
  },
  "subject": { "kind": "person", "id": "w00123", "name": "测试用户" },
  "dimensions": {
    "verify": { "score": 40, "max": 40, "evaluated": true },
    "spec": { "score": null, "max": 25, "evaluated": false },
    "code": { "score": 20, "max": 20, "evaluated": true },
    "collab": { "score": null, "max": 15, "evaluated": false }
  },
  "total": 60,
  "criteria": [
    { "key": "V1", "dim": "verify", "name": "基础档", "max": 40, "level": "A", "score": 40, "source": "auto", "rule": "基础测试全部通过", "evidenceType": "test", "evidence": { "passed": 8, "total": 8 } },
    { "key": "C1", "dim": "code", "name": "业务常量抽取", "max": 20, "level": "A", "score": 20, "source": "auto", "rule": "无业务魔法数字", "evidenceType": "metric", "evidence": { "magicNumbers": 0 } }
  ],
  "validationDiagnostics": [],
  "gradedBy": "ci",
  "triggeredBy": { "kind": "system" },
  "startedAt": "2026-08-01T10:00:01Z",
  "finishedAt": "2026-08-01T10:00:03Z",
  "durationMs": 2000
}

--- END FILE: contracts/examples/evaluation-result.valid.json ---


--- BEGIN FILE: contracts/examples/evaluation-results.invalid.json ---

[
  {},
  { "schemaVersion": "2.0" },
  { "schemaVersion": "1.0", "resultId": "x" },
  { "schemaVersion": "1.0", "rubricVersion": "latest" },
  { "schemaVersion": "1.0", "triggerType": "PUSH" },
  { "schemaVersion": "1.0", "status": "DONE" },
  { "schemaVersion": "1.0", "total": 101 },
  { "schemaVersion": "1.0", "submission": { "sourceType": "UPLOAD" } },
  { "schemaVersion": "1.0", "submission": { "sourceType": "GIT_REF", "snapshotHash": "bad" } },
  { "schemaVersion": "1.0", "dimensions": { "verify": { "score": -1, "max": 40, "evaluated": true } } }
]

--- END FILE: contracts/examples/evaluation-results.invalid.json ---


--- BEGIN FILE: contracts/examples/evaluation-results.valid.json ---

[
  {
    "schemaVersion": "1.0", "resultId": "result-valid-01", "gradingRunId": "run-valid-01", "challengeVersion": "challenge@1", "rubricVersion": "1.0", "graderVersion": "0.1.0", "idempotencyKey": "11111111111111111111111111111111", "triggerType": "IMPORT", "status": "PARTIAL",
    "submission": { "sourceType": "UPLOAD", "snapshotHash": "1111111111111111111111111111111111111111111111111111111111111111", "artifactHash": "2222222222222222222222222222222222222222222222222222222222222222", "submittedAt": "2026-08-01T10:00:00Z" },
    "dimensions": { "verify": { "score": null, "max": 40, "evaluated": false }, "spec": { "score": null, "max": 25, "evaluated": false }, "code": { "score": null, "max": 20, "evaluated": false }, "collab": { "score": null, "max": 15, "evaluated": false } }, "criteria": [], "total": 0, "validationDiagnostics": [{ "severity": "INFO", "code": "WAITING_IMPORT", "message": "等待线下结果" }], "gradedBy": "human", "startedAt": "2026-08-01T10:00:00Z", "finishedAt": "2026-08-01T10:00:00Z", "durationMs": 0
  },
  {
    "schemaVersion": "1.0", "resultId": "result-valid-02", "gradingRunId": "run-valid-02", "challengeVersion": "challenge@1", "rubricVersion": "1.0", "graderVersion": "0.1.0", "idempotencyKey": "33333333333333333333333333333333", "triggerType": "MANUAL", "status": "PARTIAL",
    "submission": { "sourceType": "UPLOAD", "snapshotHash": "3333333333333333333333333333333333333333333333333333333333333333", "artifactHash": "4444444444444444444444444444444444444444444444444444444444444444", "submittedAt": "2026-08-01T10:01:00Z" },
    "dimensions": { "verify": { "score": null, "max": 40, "evaluated": false }, "spec": { "score": null, "max": 25, "evaluated": false }, "code": { "score": null, "max": 20, "evaluated": false }, "collab": { "score": null, "max": 15, "evaluated": false } }, "criteria": [], "total": 0, "validationDiagnostics": [], "gradedBy": "ci", "startedAt": "2026-08-01T10:01:00Z", "finishedAt": "2026-08-01T10:01:00Z", "durationMs": 0
  },
  {
    "schemaVersion": "1.0", "resultId": "result-valid-03", "gradingRunId": "run-valid-03", "challengeVersion": "challenge@1", "rubricVersion": "1.0", "graderVersion": "0.1.0", "idempotencyKey": "55555555555555555555555555555555", "triggerType": "AUTO", "status": "PARTIAL",
    "submission": { "sourceType": "UPLOAD", "snapshotHash": "5555555555555555555555555555555555555555555555555555555555555555", "artifactHash": "6666666666666666666666666666666666666666666666666666666666666666", "submittedAt": "2026-08-01T10:02:00Z" },
    "dimensions": { "verify": { "score": null, "max": 40, "evaluated": false }, "spec": { "score": null, "max": 25, "evaluated": false }, "code": { "score": null, "max": 20, "evaluated": false }, "collab": { "score": null, "max": 15, "evaluated": false } }, "criteria": [], "total": 0, "validationDiagnostics": [], "gradedBy": "ci", "startedAt": "2026-08-01T10:02:00Z", "finishedAt": "2026-08-01T10:02:00Z", "durationMs": 0
  },
  {
    "schemaVersion": "1.0", "resultId": "result-valid-04", "gradingRunId": "run-valid-04", "challengeVersion": "challenge@1", "rubricVersion": "1.0", "graderVersion": "0.1.0", "idempotencyKey": "77777777777777777777777777777777", "triggerType": "IMPORT", "status": "PARTIAL",
    "submission": { "sourceType": "UPLOAD", "snapshotHash": "7777777777777777777777777777777777777777777777777777777777777777", "artifactHash": "8888888888888888888888888888888888888888888888888888888888888888", "submittedAt": "2026-08-01T10:03:00Z" },
    "dimensions": { "verify": { "score": null, "max": 40, "evaluated": false }, "spec": { "score": null, "max": 25, "evaluated": false }, "code": { "score": null, "max": 20, "evaluated": false }, "collab": { "score": null, "max": 15, "evaluated": false } }, "criteria": [], "total": 0, "validationDiagnostics": [], "gradedBy": "human", "startedAt": "2026-08-01T10:03:00Z", "finishedAt": "2026-08-01T10:03:00Z", "durationMs": 0
  },
  {
    "schemaVersion": "1.0", "resultId": "result-valid-05", "gradingRunId": "run-valid-05", "challengeVersion": "challenge@1", "rubricVersion": "1.0", "graderVersion": "0.1.0", "idempotencyKey": "99999999999999999999999999999999", "triggerType": "MANUAL", "status": "PARTIAL",
    "submission": { "sourceType": "UPLOAD", "snapshotHash": "9999999999999999999999999999999999999999999999999999999999999999", "artifactHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "submittedAt": "2026-08-01T10:04:00Z" },
    "dimensions": { "verify": { "score": null, "max": 40, "evaluated": false }, "spec": { "score": null, "max": 25, "evaluated": false }, "code": { "score": null, "max": 20, "evaluated": false }, "collab": { "score": null, "max": 15, "evaluated": false } }, "criteria": [], "total": 0, "validationDiagnostics": [], "gradedBy": "ci", "startedAt": "2026-08-01T10:04:00Z", "finishedAt": "2026-08-01T10:04:00Z", "durationMs": 0
  }
]

--- END FILE: contracts/examples/evaluation-results.valid.json ---


--- BEGIN FILE: contracts/examples/submission-contract.invalid.json ---

{
  "schemaVersion": "1.0",
  "required": [{ "path": "../secret", "type": "unknown" }],
  "forbidden": [],
  "languageEntry": { "ruby": "main.rb" }
}

--- END FILE: contracts/examples/submission-contract.invalid.json ---


--- BEGIN FILE: contracts/examples/submission-contract.skills.valid.json ---

{
  "schemaVersion": "1.1",
  "root": {
    "mode": "ARCHIVE_ROOT"
  },
  "required": [
    {
      "path": "skills",
      "type": "directory",
      "minFiles": 1
    },
    {
      "path": "skills/*/SKILL.md",
      "type": "markdown"
    }
  ],
  "optional": [
    {
      "path": "README.md",
      "type": "markdown"
    },
    {
      "path": "skills/**",
      "type": "text"
    }
  ],
  "forbidden": [
    "**/.env",
    "**/.git/**",
    "**/__pycache__/**",
    "**/*.pyc"
  ],
  "allowedPaths": [
    "README.md",
    "skills/**"
  ],
  "allowAdditionalPaths": false,
  "maxDepth": 8,
  "maxFiles": 500
}

--- END FILE: contracts/examples/submission-contract.skills.valid.json ---


--- BEGIN FILE: contracts/examples/submission-contract.valid.json ---

{
  "schemaVersion": "1.0",
  "required": [
    { "path": "SPEC.md", "type": "markdown", "minSections": 7, "notTemplate": true },
    { "path": "transcript.md", "type": "markdown", "minChars": 200 },
    { "path": "src/parking.py", "type": "source", "mustExport": "calculate_fee", "signature": "(entry_time, exit_time, is_member=False)" }
  ],
  "optional": [
    { "path": "tests/", "type": "directory" },
    { "path": "NOTES.md", "type": "markdown" }
  ],
  "forbidden": ["**/.env", "**/*credential*", "hidden_*"] ,
  "languageEntry": { "python": "src/parking.py" }
}

--- END FILE: contracts/examples/submission-contract.valid.json ---


--- BEGIN FILE: contracts/openapi.yaml ---

openapi: 3.0.3
info:
  title: AI 训战平台 API
  version: 0.6.1
  description: 训战、交付目录校验、Code Agent 批次评测与结果录入接口
servers:
  - url: http://localhost:3000
security:
  - localEmployee: []
  - oidcBearer: []
  - trustedGatewayEmployeeNo: []
    trustedGatewayIssuedAt: []
    trustedGatewaySignature: []
paths:
  /api/v1/health:
    get:
      operationId: health
      security: []
      responses:
        '200':
          description: 服务状态
  /api/v1/metrics:
    get:
      operationId: getPlatformMetrics
      description: 仅全局管理员可读取的进程级聚合运行指标，不包含令牌、源码、员工号或对象存储凭据。
      responses:
        '200':
          description: 聚合运行指标
          content:
            application/json:
              schema:
                type: object
                required: [schemaVersion, generatedAt, uptimeSeconds, requests, latencyMs, routes]
                properties:
                  schemaVersion: { type: string, enum: ['1.0'] }
                  generatedAt: { type: string, format: date-time }
                  uptimeSeconds: { type: integer, minimum: 0 }
                  requests: { type: object, additionalProperties: { type: integer, minimum: 0 } }
                  latencyMs: { type: object, additionalProperties: { type: number, minimum: 0 } }
                  routes: { type: object, additionalProperties: { type: object, additionalProperties: { type: number, minimum: 0 } } }
  /api/v1/me:
    get:
      operationId: getCurrentUser
      responses:
        '200':
          description: 当前用户
  /api/v1/me/profile:
    patch:
      operationId: updateCurrentUserProfile
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UpdateMyProfile' }
      responses:
        '200':
          description: current user profile updated
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
        '400': { description: invalid nickname or avatar }
        '403': { description: only the current user may update this profile }
  /api/v1/auth/sso:
    post:
      operationId: syncSsoIdentity
      description: >-
        本地开发可用请求体完成显式同步；生产环境必须先通过 OIDC/JWT 或可信网关身份校验，
        请求体中的 employeeNo/name/department 不得覆盖已验证的操作者。
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/SsoIdentity' } }
      responses:
        '201': { description: SSO 用户已同步 }
  /api/v1/announcements:
    get:
      operationId: listAnnouncements
      responses:
        '200':
          description: 员工首页公告
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Announcement' }
    post:
      operationId: createAnnouncement
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/Announcement' } }
      responses:
        '201': { description: 公告已创建 }
  /api/v1/announcements/{announcementId}:
    patch:
      operationId: updateAnnouncement
      parameters:
        - name: announcementId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/Announcement' } }
      responses:
        '200': { description: 公告已更新 }
    delete:
      operationId: deleteAnnouncement
      parameters:
        - name: announcementId
          in: path
          required: true
          schema: { type: string }
      responses:
        '204': { description: 公告已删除 }
  /api/v1/evaluation-engines:
    post:
      operationId: uploadEvaluationEnginePackage
      summary: 上传评测引擎包
      description: >-
        上传 zip 形式的评测引擎包（判题脚本 + 隐藏测试 + 提交契约）。平台按内容哈希
        固化并解析 engine.json，返回的 packageHash 由管理员绑定到赛题版本的
        evaluationEngine.package。相同字节重复上传是幂等的。仅管理员可调用。
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [packageBase64]
              properties:
                packageBase64: { type: string, description: zip 文件的 base64 编码 }
                fileName: { type: string, description: 原始文件名，必须以 .zip 结尾 }
      responses:
        '201':
          description: 引擎包已入库
          content:
            application/json:
              schema:
                type: object
                required: [packageHash, size, engine, runtime]
                properties:
                  packageHash: { type: string, pattern: '^[a-f0-9]{64}$' }
                  size: { type: integer, minimum: 1 }
                  fileName: { type: string }
                  engine:
                    type: object
                    properties:
                      id: { type: string }
                      version: { type: string }
                      description: { type: string }
                  runtime: { type: object, additionalProperties: true }
                  limits: { type: object, nullable: true, additionalProperties: true }
                  assets: { type: object, nullable: true, additionalProperties: true }
                  selfCheck: { type: object, nullable: true, additionalProperties: true }
        '400': { description: 引擎包格式、清单或声明路径不合法 }
        '403': { description: 需要管理员权限 }
  /api/v1/evaluation-executors:
    get:
      operationId: listEvaluationExecutors
      summary: 列出仓库内置执行器
      description: 供赛题编辑器的下拉框使用。每项含 id、版本、标题、内容哈希和 params（JSON Schema，用于动态渲染参数表单）。
      responses:
        '200':
          description: 内置执行器清单
        '403': { description: 需要管理员权限 }
  /api/v1/evaluation-contracts:
    get:
      operationId: listEvaluationContracts
      summary: 列出 Git 固定的评测约束
      description: >-
        返回管理员赛题编辑器可选的输入/输出约束。约束目录、Schema、示例和 AI 开发说明
        都随平台 Git 版本发布；内部桥接约束不会出现在列表中。
      responses:
        '200':
          description: 评测约束目录
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/EvaluationContractOption' }
        '403': { description: 需要管理员权限 }
  /api/v1/evaluation-contracts/{contractId}:
    get:
      operationId: getEvaluationContract
      summary: 查看 Git 固定的评测约束详情
      description: >-
        返回管理员点击查看的公开评测约束详情，包含 Git 固定 Schema、已校验示例和
        供 AI 出题使用的编写说明；内部桥接约束不会通过此接口暴露。
      parameters:
        - name: contractId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: 评测约束详情
          content:
            application/json:
              schema: { $ref: '#/components/schemas/EvaluationContractDetail' }
        '403': { description: 需要管理员权限 }
        '404': { description: 评测约束不存在或不是公开约束 }
  /api/v1/evaluation-tasks:lease:
    post:
      operationId: leaseEvaluationTasks
      summary: 领取评测任务
      deprecated: true
      description: >-
        单份任务兼容接口。新的评测环境应使用 evaluation-batches:lease，确保管理员
        精确选择的多份提交在同一个 Code Agent 工作目录中逐份处理。
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [workerId]
              properties:
                workerId: { type: string, description: 评测环境标识，用于审计与租约归属 }
                limit: { type: integer, minimum: 1, maximum: 20, default: 1 }
                executorIds:
                  type: array
                  items: { type: string }
                  description: 只领取使用指定执行器的任务；留空表示不限
      responses:
        '200': { description: 已领取的任务列表 }
        '403': { description: 需要管理员权限 }
  /api/v1/evaluation-tasks/{runId}/heartbeat:
    post:
      operationId: heartbeatEvaluationTask
      parameters: [{ name: runId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json: { schema: { type: object, required: [leaseId], properties: { leaseId: { type: string } } } }
      responses:
        '200': { description: 租约已续期 }
        '409': { description: 租约已失效 }
  /api/v1/evaluation-tasks/{runId}/complete:
    post:
      operationId: completeEvaluationTask
      description: 回传符合 evaluation-result.schema.json 的结果。平台仍会做 Schema 校验、重算总分并覆盖员工身份。
      parameters: [{ name: runId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [leaseId, result]
              properties:
                leaseId: { type: string }
                result: { $ref: '#/components/schemas/EvaluationResult' }
      responses:
        '201': { description: 结果已入库 }
        '400': { description: 结果 Schema 或分数校验未通过 }
        '409': { description: 租约已失效或任务已完成 }
  /api/v1/evaluation-tasks/{runId}/fail:
    post:
      operationId: failEvaluationTask
      parameters: [{ name: runId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json: { schema: { type: object, required: [leaseId], properties: { leaseId: { type: string }, reason: { type: string } } } }
      responses:
        '200': { description: 任务已标记失败 }
        '409': { description: 租约已失效 }
  /api/v1/evaluation-batches:
    get:
      operationId: listEvaluationBatches
      summary: 查询评测批次
      parameters:
        - name: eventId
          in: query
          schema: { type: string }
      responses:
        '200': { description: 当前管理员范围内的评测批次 }
        '403': { description: 需要管理员权限 }
  /api/v1/evaluation-batches/{batchId}:
    get:
      operationId: getEvaluationBatch
      parameters: [{ name: batchId, in: path, required: true, schema: { type: string } }]
      responses:
        '200': { description: 评测批次状态 }
        '403': { description: 需要管理员权限 }
        '404': { description: 批次不存在 }
  /api/v1/evaluation-batches:lease:
    post:
      operationId: leaseEvaluationBatches
      summary: 领取 Code Agent 评测批次
      description: >-
        一个批次只包含同一训战、同一赛题版本和同一评测引擎下由管理员精确选中的提交。
        Worker 将不可变交付件、完整评测引擎、instruction.md 和 skills 物化到一个隔离目录，
        再调用 Code Agent bridge。部门管理员只能领取其管理范围内的批次。
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [workerId]
              properties:
                workerId: { type: string }
                limit: { type: integer, minimum: 1, maximum: 5, default: 1 }
                executorIds: { type: array, items: { type: string } }
      responses:
        '200': { description: 已领取的完整批次任务 }
        '403': { description: 需要管理员权限 }
  /api/v1/evaluation-batches/{batchId}/heartbeat:
    post:
      operationId: heartbeatEvaluationBatch
      parameters: [{ name: batchId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json: { schema: { type: object, required: [leaseId], properties: { leaseId: { type: string } } } }
      responses:
        '200': { description: 批次租约已续期 }
        '409': { description: 批次租约已失效 }
  /api/v1/evaluation-batches/{batchId}/complete:
    post:
      operationId: completeEvaluationBatch
      summary: 回传 Code Agent 批次结果
      parameters: [{ name: batchId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [leaseId, results]
              properties:
                leaseId: { type: string }
                results:
                  type: array
                  maxItems: 500
                  items:
                    type: object
                    required: [runId, result]
                    properties:
                      runId: { type: string }
                      result: { $ref: '#/components/schemas/EvaluationResult' }
                failures:
                  type: array
                  maxItems: 500
                  items:
                    type: object
                    required: [runId, reason]
                    properties:
                      runId: { type: string }
                      reason: { type: string, maxLength: 2000 }
      responses:
        '201': { description: 批次结果已逐份校验并录入 }
        '400': { description: 结果不属于本批次或结果校验未通过 }
        '409': { description: 批次租约已失效 }
  /api/v1/evaluation-batches/{batchId}/fail:
    post:
      operationId: failEvaluationBatch
      parameters: [{ name: batchId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json: { schema: { type: object, required: [leaseId], properties: { leaseId: { type: string }, reason: { type: string } } } }
      responses:
        '200': { description: 批次及未完成运行已标记失败 }
        '409': { description: 批次租约已失效 }
  /api/v1/evaluation-engines/{packageHash}/package:
    get:
      operationId: downloadEvaluationEnginePackage
      description: 评测环境据此拉取引擎包字节，在本地物化引擎。
      parameters: [{ name: packageHash, in: path, required: true, schema: { type: string, pattern: '^[a-f0-9]{64}$' } }]
      responses:
        '200': { description: 引擎包 zip }
        '400': { description: 引擎包不存在 }
        '403': { description: 需要管理员权限 }
  /api/v1/admin/overview:
    get:
      operationId: getAdminOverview
      responses:
        '200': { description: 管理后台汇总指标 }
  /api/v1/admin/grading-queue:
    get:
      operationId: getAdminGradingQueue
      responses:
        '200':
          description: Code Agent 评测批次队列状态
          content:
            application/json:
              schema:
                type: object
                required: [queued, running, maxConcurrency, scheduled]
                properties:
                  queued: { type: integer, minimum: 0 }
                  running: { type: integer, minimum: 0 }
                  maxConcurrency: { type: integer, minimum: 1 }
                  scheduled: { type: integer, minimum: 0 }
  /api/v1/admin/code-agent-runtime:
    get:
      operationId: getCodeAgentRuntime
      summary: 查询 Code Agent 运行配置
      description: 仅全局管理员可查询。命令会被解析为 executable 与 argv，Worker 不通过系统 Shell 执行。
      responses:
        '200':
          description: 当前 Code Agent 运行配置
          content:
            application/json: { schema: { $ref: '#/components/schemas/CodeAgentRuntimeConfig' } }
        '403': { description: 需要全局管理员权限 }
    put:
      operationId: updateCodeAgentRuntime
      summary: 更新 Code Agent 运行配置
      description: 仅影响更新后创建的评测批次；已创建批次继续使用其冻结配置。
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/CodeAgentRuntimeInput' } }
      responses:
        '200':
          description: 配置已保存
          content:
            application/json: { schema: { $ref: '#/components/schemas/CodeAgentRuntimeConfig' } }
        '400': { description: 命令或超时配置不合法 }
        '403': { description: 需要全局管理员权限 }
  /api/v1/admin/code-agent-runtime/diagnostics:
    get:
      operationId: getCodeAgentRuntimeDiagnostics
      summary: 查看 Code Agent 平台与 Worker 配置诊断
      description: 返回默认配置、平台冻结配置、Worker 环境变量可见配置和运行测试安全开关；Worker 命令行参数不会被 API 读取。
      responses:
        '200':
          description: Code Agent 配置诊断
          content:
            application/json: { schema: { $ref: '#/components/schemas/CodeAgentRuntimeDiagnostics' } }
        '403': { description: 需要全局管理员权限 }
  /api/v1/admin/code-agent-runtime/test:
    post:
      operationId: testCodeAgentRuntime
      summary: 受控试运行 Code Agent 配置
      description: 仅在非生产环境并显式设置 CODE_AGENT_RUNTIME_TEST_ENABLED=true 时执行管理员配置的可执行文件；测试使用合成清单，不包含学员交付件，且不经过系统 Shell。
      requestBody:
        required: false
        content:
          application/json: { schema: { $ref: '#/components/schemas/CodeAgentRuntimeTestInput' } }
      responses:
        '200':
          description: 试运行结果（通过、失败、超时或被安全开关阻断）
          content:
            application/json: { schema: { $ref: '#/components/schemas/CodeAgentRuntimeTestResult' } }
        '400': { description: 命令、任务指令或超时配置不合法 }
        '403': { description: 需要全局管理员权限 }
  /api/v1/org-units:
    get:
      operationId: listOrgUnits
      parameters:
        - name: parentId
          in: query
          schema: { type: string }
      responses:
        '200': { description: 组织树节点 }
    post:
      operationId: createOrgUnit
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/OrgUnitInput' } }
      responses:
        '201': { description: 组织节点已创建 }
  /api/v1/org-units/{orgUnitId}:
    get:
      operationId: getOrgUnit
      parameters:
        - name: orgUnitId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: 组织节点 }
    patch:
      operationId: updateOrgUnit
      parameters:
        - name: orgUnitId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/OrgUnitPatch' } }
      responses:
        '200': { description: 组织节点已更新 }
    delete:
      operationId: deleteOrgUnit
      summary: 删除空部门
      description: 根组织、含下级部门、仍有员工或仍被业务配置引用的部门不可删除。
      parameters:
        - name: orgUnitId
          in: path
          required: true
          schema: { type: string }
      responses:
        '204': { description: 部门已删除 }
        '400': { description: 根组织不可删除 }
        '403': { description: 超出管理员组织范围 }
        '409': { description: 部门仍有下级部门、员工或业务引用 }
  /api/v1/users:
    get:
      operationId: listUsers
      parameters:
        - name: page
          in: query
          description: 1-based page number.
          schema: { type: integer, minimum: 1, default: 1 }
        - name: pageSize
          in: query
          description: Number of users per page.
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
        - name: orgPath
          in: query
          description: Organization path including descendants.
          schema: { type: string, maxLength: 512 }
        - name: query
          in: query
          description: Case-insensitive fuzzy match against employee number or name.
          schema: { type: string, maxLength: 200 }
        - name: role
          in: query
          description: Comma-separated exact role names (a user matches when any role is present).
          style: form
          explode: false
          schema: { type: string, maxLength: 512 }
        - name: status
          in: query
          schema: { type: string, enum: [ACTIVE, DISABLED] }
        - name: sortBy
          in: query
          description: Whitelisted primary sort field; id is always used as the final tie-breaker.
          schema: { type: string, enum: [employeeNo, name, orgPath, status, id], default: employeeNo }
        - name: sortOrder
          in: query
          schema: { type: string, enum: [asc, desc], default: asc }
      responses:
        '200':
          description: 服务端分页用户列表
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserPage' }
        '400': { description: 分页或筛选参数不合法 }
        '403': { description: 需要管理员权限或超出管理员组织范围 }
  /api/v1/users/batch-department:
    patch:
      operationId: batchUpdateUserDepartment
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/UserDepartmentBatchPatch' } }
      responses:
        '200':
          description: 批量调整部门完成
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserDepartmentBatchResult' }
        '400': { description: 员工列表或目标部门不合法 }
        '403': { description: 需要管理员权限或超出管理员组织范围 }
        '404': { description: 员工或目标部门不存在 }
  /api/v1/users/{userId}:
    get:
      operationId: getUser
      parameters:
        - name: userId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: 用户详情 }
    patch:
      operationId: updateUser
      parameters:
        - name: userId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/UserPatch' } }
      responses:
        '200': { description: 用户已更新 }
  /api/v1/hard-problems:
    get:
      operationId: listHardProblems
      parameters:
        - name: status
          in: query
          schema: { type: string, enum: [OPEN, RESOLVED] }
        - name: reviewStatus
          in: query
          schema: { type: string, enum: [PENDING_REVIEW, APPROVED, REJECTED] }
      responses:
        '200': { description: 赛题库中难题榜视图 }
    post:
      operationId: createHardProblemChallenge
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/HardProblemInput' } }
      responses:
        '201': { description: 已创建赛题；审核通过后进入难题榜 }
  /api/v1/hard-problems/{problemId}:
    get:
      operationId: getHardProblemChallenge
      parameters:
        - name: problemId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: 赛题库中的难题详情 }
  /api/v1/hard-problems/{problemId}/review:
    post:
      operationId: reviewHardProblem
      parameters:
        - name: problemId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/HardProblemReview' }
      responses:
        '201': { description: 难题审核结果已保存 }
  /api/v1/hard-problems/{problemId}/resolve:
    post:
      operationId: resolveHardProblemChallenge
      parameters:
        - name: problemId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                submissionId: { type: string, description: 选中的揭榜交付提交；不传时使用最近一份提交 }
      responses:
        '201': { description: 难题已揭榜并进入揭榜成功列表 }
  /api/v1/challenges:
    get:
      operationId: listChallenges
      responses:
        '200': { description: 题目列表 }
    post:
      operationId: createChallenge
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/Challenge' } }
      responses:
        '201': { description: 题目已创建 }
  /api/v1/challenges/{challengeId}:
    get:
      operationId: getChallenge
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: 题目详情 }
    patch:
      operationId: updateChallenge
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ChallengePatch' }
      responses:
        '200': { description: 赛题类型已更新 }
    delete:
      operationId: deleteChallenge
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: 赛题已移入回收站，可通过恢复接口撤销 }
        '403': { description: 管理员无权操作该赛题 }
        '409': { description: 赛题仍有关联的开放训战 }
  /api/v1/challenges/{challengeId}/permanent:
    delete:
      operationId: permanentlyDeleteChallenge
      summary: 永久删除垃圾箱中的赛题
      description: 仅允许删除已在垃圾箱中的赛题；存在关联训战时拒绝删除，以保护历史提交和评测证据。
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: 赛题已永久删除
          content:
            application/json:
              schema: { $ref: '#/components/schemas/PermanentlyDeletedChallenge' }
        '403': { description: 管理员无权操作该赛题 }
        '404': { description: 赛题不存在 }
        '409': { description: 赛题未在垃圾箱中或仍有关联训战 }
  /api/v1/challenges/{challengeId}/publish:
    post:
      operationId: publishChallenge
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      responses:
        '201': { description: 题目已发布 }
  /api/v1/challenges/{challengeId}/archive:
    post:
      operationId: archiveChallenge
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      responses:
        '201': { description: 题目已归档 }
  /api/v1/challenges/{challengeId}/trash:
    post:
      operationId: trashChallenge
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      responses:
        '201': { description: 题目已移入垃圾箱 }
  /api/v1/challenges/{challengeId}/restore:
    post:
      operationId: restoreChallenge
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      responses:
        '201': { description: 题目已恢复 }
  /api/v1/challenges/{challengeId}/versions:
    post:
      operationId: createChallengeVersion
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/ChallengeVersion' } }
      responses:
        '201': { description: 题目版本草稿已创建 }
  /api/v1/challenges/{challengeId}/versions/{versionId}:
    patch:
      operationId: updateChallengeVersion
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
        - name: versionId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json: { schema: { type: object, additionalProperties: true } }
      responses:
        '200': { description: 题目版本草稿已更新 }
  /api/v1/challenges/{challengeId}/versions/{versionId}/publish:
    post:
      operationId: publishChallengeVersion
      parameters:
        - name: challengeId
          in: path
          required: true
          schema: { type: string }
        - name: versionId
          in: path
          required: true
          schema: { type: string }
      responses:
        '201': { description: 题目版本已发布 }
  /api/v1/seasons:
    get:
      operationId: listSeasons
      responses:
        '200': { description: 赛季列表 }
    post:
      operationId: createSeason
      requestBody:
        required: true
        content:
          application/json: { schema: { type: object, additionalProperties: true } }
      responses:
        '201': { description: 赛季已创建 }
  /api/v1/seasons/{seasonId}:
    get:
      operationId: getSeason
      parameters:
        - name: seasonId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: 赛季详情 }
  /api/v1/seasons/{seasonId}/leaderboard:
    get:
      operationId: getLeaderboard
      parameters:
        - name: seasonId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: 仅返回赛季前三名；普通员工只返回昵称，管理员额外返回姓名和工号
          content:
            application/json:
              schema:
                type: array
                maxItems: 3
                items: { $ref: '#/components/schemas/LeaderboardRow' }
  /api/v1/profiles/{subjectId}:
    get:
      operationId: getProfile
      parameters:
        - name: subjectId
          in: path
          required: true
          schema: { type: string }
        - name: includeHistory
          in: query
          required: false
          schema: { type: boolean, default: true }
      responses:
        '200': { description: 能力画像与成绩历史 }
  /api/v1/profiles/{subjectId}/history:
    get:
      operationId: getProfileHistory
      parameters:
        - name: subjectId
          in: path
          required: true
          schema: { type: string }
        - name: page
          in: query
          required: false
          schema: { type: integer, minimum: 1, default: 1 }
        - name: pageSize
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: server-side paginated profile result history
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ProfileHistoryPage' }
        '400': { description: invalid pagination parameters }
        '403': { description: profile history is outside the caller scope }
  /api/v1/profiles/{subjectId}/capabilities:
    get:
      operationId: getCapabilityProfile
      parameters:
        - name: subjectId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: 个人 AI 能力画像、四维评测证据、八个能力域和能力项统计
          content:
            application/json:
              schema: { $ref: '#/components/schemas/CapabilityProfile' }
  /api/v1/admin/capabilities:
    get:
      operationId: getAdminCapabilityProfiles
      parameters:
        - name: orgPath
          in: query
          required: false
          schema: { type: string }
          description: 部门物化路径；不传表示全组织
        - name: subjectIds
          in: query
          required: false
          schema: { type: string }
          description: 逗号分隔的员工 ID；不传表示所选部门全部员工
        - name: eventId
          in: query
          required: false
          schema: { type: string }
          description: 训战 ID；传入后只聚合该训战中有提交的员工及其 AI 评测结果
        - name: includeProfiles
          in: query
          required: false
          schema: { type: boolean, default: true }
          description: 是否返回个人明细；部门或选定人员的群体画像可设为 false，仅返回平均聚合
        - name: page
          in: query
          required: false
          schema: { type: integer, minimum: 1, default: 1 }
          description: profile page number
        - name: pageSize
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
          description: profile page size
        - name: historyPage
          in: query
          required: false
          schema: { type: integer, minimum: 1, default: 1 }
          description: result history page for each profile
        - name: historyPageSize
          in: query
          required: false
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
          description: result history page size for each profile
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AdminCapabilityBundle' }
          description: 管理员选择的部门或训战范围内的个人画像、AI 评测聚合和 16 个评分点
        '400': { description: 选定员工不在部门范围内或 eventId 不是训战 }
        '403': { description: 需要管理员权限 }
  /api/v1/events:
    get:
      operationId: listEvents
      responses:
        '200':
          description: 场次列表
    post:
      operationId: createEvent
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/EventConfig'
      responses:
        '201':
          description: 场次已创建
  /api/v1/events/{eventId}:
    get:
      operationId: getEvent
      parameters:
        - $ref: '#/components/parameters/EventId'
      responses:
        '200': { description: 场次详情 }
    patch:
      operationId: updateEvent
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/EventConfig' } }
      responses:
        '200': { description: 场次已更新 }
    delete:
      operationId: deleteEvent
      parameters:
        - $ref: '#/components/parameters/EventId'
      responses:
        '204': { description: 训战已删除 }
        '403': { description: 管理员无权操作该训战 }
        '404': { description: 训战不存在 }
        '409': { description: 已公布、系统管理或已有提交的训战不能删除 }
  /api/v1/events/{eventId}/participants:
    get:
      operationId: listEventParticipants
      parameters:
        - $ref: '#/components/parameters/EventId'
      responses:
        '200': { description: 场次参与者 }
    put:
      operationId: replaceEventParticipants
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [subjectIds]
              properties:
                subjectIds: { type: array, maxItems: 10000, items: { type: string } }
      responses:
        '200': { description: 参与者名单已替换 }
  /api/v1/events/{eventId}/participants:import:
    post:
      operationId: importEventParticipants
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [participants]
              properties:
                participants: { type: array, maxItems: 10000, items: { type: object, required: [subjectId], properties: { subjectId: { type: string } } } }
      responses:
        '201': { description: 参与者已导入 }
  /api/v1/events/{eventId}/submissions:upload:
    post:
      operationId: uploadSubmissionMetadata
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UploadSubmission'
      responses:
        '201':
          description: 上传快照已登记
        '409':
          description: 该学员已有提交正在评测，暂不能提交新的作品
  /api/v1/events/{eventId}/submissions:register-git:
    post:
      operationId: registerGitSubmission
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/GitSubmission'
      responses:
        '201':
          description: Git 快照已登记
        '409':
          description: 该学员已有提交正在评测，暂不能提交新的作品
  /api/v1/submissions/{submissionId}/start-grading:
    post:
      operationId: startSubmissionGrading
      parameters:
        - $ref: '#/components/parameters/SubmissionId'
      responses:
        '201':
          description: 评测已排队
  /api/v1/submissions/{submissionId}/regrade:
    post:
      operationId: regradeSubmission
      parameters:
        - $ref: '#/components/parameters/SubmissionId'
      responses:
        '201': { description: 新评估任务已创建 }
  /api/v1/submissions:
    get:
      operationId: listSubmissions
      description: Server-side paginated submission listing.
      parameters:
        - name: eventId
          in: query
          schema: { type: string }
        - name: subjectId
          in: query
          schema: { type: string }
        - name: state
          in: query
          schema: { type: string, enum: [RECEIVED, QUEUED, WAITING_TRIGGER, WAITING_IMPORT, IMPORT_VALIDATING, FAILED, GRADED, SEALED, REVEALED] }
        - name: page
          in: query
          schema: { type: integer, minimum: 1, default: 1 }
        - name: pageSize
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: 提交列表
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SubmissionPage' }
    post:
      operationId: createSubmission
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/Submission' } }
      responses:
        '201': { description: 提交已登记 }
        '409': { description: 该学员已有提交正在评测，暂不能提交新的作品 }
  /api/v1/submissions/{submissionId}:
    get:
      operationId: getSubmission
      parameters:
        - $ref: '#/components/parameters/SubmissionId'
      responses:
        '200': { description: 提交详情 }
  /api/v1/submissions/{submissionId}/artifact:
    get:
      operationId: downloadSubmissionArtifact
      description: 管理员下载指定提交的交付件，用于线下评测。
      parameters:
        - $ref: '#/components/parameters/SubmissionId'
      responses:
        '200':
          description: 交付件文件
          content:
            application/octet-stream:
              schema: { type: string, format: binary }
        '404': { description: 交付件不存在 }
  /api/v1/events/{eventId}/start-grading:
    post:
      operationId: startEventGrading
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                submissionIds:
                  type: array
                  minItems: 1
                  maxItems: 500
                  uniqueItems: true
                  items: { type: string }
      responses:
        '201':
          description: 批量评测已排队
  /api/v1/events/{eventId}/regrade:
    post:
      operationId: regradeEvent
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                submissionIds:
                  type: array
                  maxItems: 500
                  uniqueItems: true
                  items: { type: string }
      responses:
        '201': { description: 新评估任务已创建 }
  /api/v1/events/{eventId}/grading-input:
    post:
      operationId: prepareEvaluationInput
      description: 为指定提交生成赛题评测引擎使用的输入清单；仅管理员可调用。
      parameters:
        - $ref: '#/components/parameters/EventId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [submissionIds]
              properties:
                submissionIds:
                  type: array
                  minItems: 1
                  maxItems: 500
                  uniqueItems: true
                  items: { type: string }
      responses:
        '201':
          description: 评测输入清单已生成
          content:
            application/json:
              schema: { $ref: '#/components/schemas/EvaluationInputBatch' }
        '400':
          description: 提交选择或评测契约无效
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /api/v1/grading-results:import:
    post:
      operationId: importGradingResult
      parameters:
        - $ref: '#/components/parameters/IdempotencyKey'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [result]
              properties:
                result:
                  $ref: '#/components/schemas/EvaluationResult'
                actorId:
                  type: string
      responses:
        '201':
          description: 结果已导入
        '400':
          description: Schema 或关联校验失败
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorResponse' }
  /api/v1/grading-results:import-batch:
    post:
      operationId: importGradingResultsBatch
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [results]
              properties:
                results:
                  type: array
                  maxItems: 500
                  items:
                    type: object
                    required: [result]
                    properties:
                      result: { $ref: '#/components/schemas/EvaluationResult' }
                      eventId: { type: string }
                      subjectId: { type: string }
      responses:
        '201': { description: 批量结果导入汇总 }
  /api/v1/grading-runs/{runId}:
    get:
      operationId: getGradingRun
      parameters:
        - name: runId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200': { description: 评测运行状态 }
  /api/v1/grading-runs/{runId}/execute:
    post:
      operationId: executeLocalGrading
      deprecated: true
      description: 仅在 EMBEDDED_EVALUATION_WORKER=true 时用于本地兼容测试；正式评测使用 Code Agent 批次 Worker。
      parameters:
        - name: runId
          in: path
          required: true
          schema: { type: string }
      responses:
        '201': { description: 本地兼容评测结果已写入 }
        '400': { description: 本地工作区或结果契约无效 }
  /api/v1/events/{eventId}/reveal:
    post:
      operationId: revealEvent
      parameters:
        - $ref: '#/components/parameters/EventId'
      responses:
        '201':
          description: 结果已揭晓
  /api/v1/events/{eventId}/close:
    post:
      operationId: closeEvent
      parameters:
        - $ref: '#/components/parameters/EventId'
      responses:
        '201': { description: 场次已关闭 }
  /api/v1/events/{eventId}/execute-local:
    post:
      operationId: executeEventLocally
      deprecated: true
      description: 仅在 EMBEDDED_EVALUATION_WORKER=true 时可用；正式评测由独立 Worker 领取批次。
      parameters:
        - $ref: '#/components/parameters/EventId'
      responses:
        '201': { description: 场次内排队运行已由内嵌兼容执行器处理 }
  /api/v1/audits:
    get:
      operationId: listAudits
      description: Server-side paginated audit listing.
      parameters:
        - name: target
          in: query
          schema: { type: string }
        - name: page
          in: query
          schema: { type: integer, minimum: 1, default: 1 }
        - name: pageSize
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: 操作审计记录
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AuditPage' }
  /api/v1/uploads:
    post:
      operationId: createUpload
      description: 创建绑定身份、场次和大小限制的短期上传句柄。
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UploadRequest' }
      responses:
        '201':
          description: 上传句柄已创建
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UploadSession' }
  /api/v1/uploads/{uploadId}:
    put:
      operationId: putUpload
      parameters:
        - $ref: '#/components/parameters/UploadId'
        - $ref: '#/components/parameters/UploadToken'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [bytesBase64]
              properties:
                bytesBase64: { type: string }
          application/octet-stream:
            schema:
              type: string
              format: binary
          application/zip:
            schema:
              type: string
              format: binary
          application/x-zip-compressed:
            schema:
              type: string
              format: binary
      responses:
        '200':
          description: 上传内容已接收
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UploadMetadata' }
  /api/v1/uploads/{uploadId}/confirm:
    post:
      operationId: confirmUpload
      parameters:
        - $ref: '#/components/parameters/UploadId'
        - $ref: '#/components/parameters/UploadToken'
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: '#/components/schemas/UploadMetadata' }
      responses:
        '201':
          description: 对象已固化
          content:
            application/json:
              schema: { $ref: '#/components/schemas/StoredArtifact' }
  /api/v1/reports/{submissionId}:
    get:
      operationId: getSubmissionReport
      parameters:
        - $ref: '#/components/parameters/SubmissionId'
      responses:
        '200':
          description: 评测报告
components:
  securitySchemes:
    localEmployee:
      type: apiKey
      in: header
      name: X-Employee-Id
    oidcBearer:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: 生产 OIDC/JWT 身份；服务端校验 issuer、audience、JWKS、有效期和签名。
    trustedGatewayEmployeeNo:
      type: apiKey
      in: header
      name: X-Trusted-Employee-No
    trustedGatewayIssuedAt:
      type: apiKey
      in: header
      name: X-Trusted-Issued-At
    trustedGatewaySignature:
      type: apiKey
      in: header
      name: X-Trusted-Identity-Signature
  parameters:
    EventId:
      name: eventId
      in: path
      required: true
      schema: { type: string }
    SubmissionId:
      name: submissionId
      in: path
      required: true
      schema: { type: string }
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: false
      schema: { type: string, minLength: 16, maxLength: 128 }
    UploadId:
      name: uploadId
      in: path
      required: true
      schema: { type: string, format: uuid }
    UploadToken:
      name: X-Upload-Token
      in: header
      required: true
      schema: { type: string, minLength: 32 }
  schemas:
    CodeAgentRuntimeInput:
      type: object
      additionalProperties: false
      required: [enabled, commandLine, prompt, timeoutSeconds]
      properties:
        enabled: { type: boolean }
        commandLine:
          type: string
          maxLength: 4096
          description: 单行启动命令；支持 {{prompt}}、{{manifestPath}}、{{batchDir}} 占位符
        prompt: { type: string, maxLength: 16000 }
        timeoutSeconds: { type: integer, minimum: 60, maximum: 21600 }
    CodeAgentRuntimeConfig:
      allOf:
        - $ref: '#/components/schemas/CodeAgentRuntimeInput'
        - type: object
          required: [schemaVersion, executable, args, configHash, updatedAt, updatedBy]
          properties:
            schemaVersion: { type: string, enum: ['1.0'] }
            executable: { type: string }
            args: { type: array, maxItems: 64, items: { type: string } }
            configHash: { type: string, pattern: '^[a-f0-9]{64}$' }
            updatedAt: { type: string, format: date-time }
            updatedBy: { type: string }
    CodeAgentRuntimeDiagnostics:
      type: object
      additionalProperties: false
      required: [schemaVersion, defaults, platform, worker, allowedExecutables, test]
      properties:
        schemaVersion: { type: string, enum: ['1.0'] }
        defaults: { $ref: '#/components/schemas/CodeAgentRuntimeInput' }
        platform: { $ref: '#/components/schemas/CodeAgentRuntimeConfig' }
        worker:
          type: object
          additionalProperties: false
          required: [mode, workerId, source, commandConfigured, executable, args, commandPreview, cliOverrideVisible, canResolveExecutable, reason]
          properties:
            mode: { type: string, enum: [EMBEDDED, EXTERNAL] }
            workerId: { type: [string, 'null'] }
            source: { type: string, enum: [PLATFORM, ENVIRONMENT, CLI_OVERRIDE_UNKNOWN, NONE] }
            commandConfigured: { type: boolean }
            executable: { type: [string, 'null'] }
            args: { type: array, items: { type: string } }
            commandPreview: { type: [string, 'null'] }
            cliOverrideVisible: { type: boolean, enum: [false] }
            canResolveExecutable: { type: boolean }
            reason: { type: string }
        allowedExecutables: { type: array, items: { type: string } }
        test:
          type: object
          additionalProperties: false
          required: [enabled, maxTimeoutSeconds, canExecute, reason]
          properties:
            enabled: { type: boolean }
            maxTimeoutSeconds: { type: integer, minimum: 10, maximum: 300 }
            canExecute: { type: boolean }
            reason: { type: string }
    CodeAgentRuntimeTestInput:
      type: object
      additionalProperties: false
      properties:
        commandLine: { type: string, maxLength: 4096 }
        prompt: { type: string, maxLength: 16000 }
        timeoutSeconds: { type: integer, minimum: 60, maximum: 21600 }
    CodeAgentRuntimeTestResult:
      type: object
      additionalProperties: false
      required: [schemaVersion, status, message, executable, args, workingDirectory, manifestPath, startedAt, finishedAt, durationMs, exitCode, signal, stdout, stderr]
      properties:
        schemaVersion: { type: string, enum: ['1.0'] }
        status: { type: string, enum: [PASS, FAIL, BLOCKED, TIMEOUT] }
        message: { type: string }
        executable: { type: [string, 'null'] }
        args: { type: array, maxItems: 64, items: { type: string } }
        workingDirectory: { type: string }
        manifestPath: { type: [string, 'null'] }
        startedAt: { type: string, format: date-time }
        finishedAt: { type: string, format: date-time }
        durationMs: { type: integer, minimum: 0 }
        exitCode: { type: [integer, 'null'] }
        signal: { type: [string, 'null'] }
        stdout: { type: string, maxLength: 32768 }
        stderr: { type: string, maxLength: 32768 }
    OrgUnitInput:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        parentId: { type: string }
        label: { type: string }
        name: { type: string }
    OrgUnitPatch:
      type: object
      additionalProperties: false
      properties:
        label: { type: string }
        name: { type: string }
    UploadRequest:
      type: object
      additionalProperties: false
      required: [eventId, fileName, declaredSize]
      properties:
        eventId: { type: string }
        subjectId: { type: string }
        fileName: { type: string, minLength: 1, maxLength: 200 }
        declaredSize: { type: integer, minimum: 1 }
    UploadSession:
      type: object
      additionalProperties: false
      required: [uploadId, uploadToken, objectKey, actorId, eventId, subjectId, fileName, declaredSize, expiresAt]
      properties:
        uploadId: { type: string, format: uuid }
        uploadToken: { type: string }
        objectKey: { type: string }
        actorId: { type: string }
        eventId: { type: string }
        subjectId: { type: string }
        fileName: { type: string }
        declaredSize: { type: integer, minimum: 1 }
        expiresAt: { type: string, format: date-time }
    UploadMetadata:
      type: object
      additionalProperties: false
      required: [size, sha256]
      properties:
        size: { type: integer, minimum: 1 }
        sha256: { type: string, pattern: '^[a-f0-9]{64}$' }
    StoredArtifact:
      allOf:
        - $ref: '#/components/schemas/UploadMetadata'
        - type: object
          required: [uri]
          properties:
            uri: { type: string }
    SsoIdentity:
      type: object
      additionalProperties: false
      required: [employeeNo, name]
      properties:
        employeeNo: { type: string, minLength: 1 }
        name: { type: string, minLength: 1 }
        department: { type: string }
    UserPatch:
      type: object
      additionalProperties: false
      description: 管理员只能维护员工的部门归属和角色，员工账号由内部 SSO 首次登录自动登记
      properties:
        orgUnitId: { type: string }
        roles: { type: array, items: { type: string } }
        roleBindings:
          type: array
          items:
            type: object
            additionalProperties: false
              required: [role, scopeOrgPath]
            properties:
              role: { type: string }
              scopeOrgPath: { type: string }
    UserDepartmentBatchPatch:
      type: object
      additionalProperties: false
      required: [userIds, orgUnitId]
      properties:
        userIds:
          type: array
          minItems: 1
          maxItems: 100
          uniqueItems: true
          items: { type: string, minLength: 1 }
        orgUnitId: { type: string, description: 目标部门编号；仅全局管理员可传空字符串解除部门归属 }
    UserDepartmentBatchResult:
      type: object
      additionalProperties: false
      required: [requested, updated]
      properties:
        requested: { type: integer, minimum: 1 }
        updated:
          type: array
          items: { $ref: '#/components/schemas/User' }
    UpdateMyProfile:
      type: object
      additionalProperties: false
      minProperties: 1
      properties:
        nickname: { type: [string, 'null'], maxLength: 32, description: employee display nickname; null clears it }
        avatarDataUrl: { type: [string, 'null'], maxLength: 349551, description: validated PNG JPEG or WebP data URL; null clears it }
    User:
      type: object
      additionalProperties: false
      required: [id, employeeNo, name, orgUnitId, orgPath, roles, status]
      properties:
        id: { type: string }
        employeeNo: { type: string }
        name: { type: string }
        nickname: { type: string }
        avatarDataUrl: { type: string, description: validated avatar data URL }
        orgUnitId: { type: string }
        orgPath: { type: string }
        departmentHint: { type: string }
        departmentSource: { type: string, enum: [SSO, ADMIN] }
        roles: { type: array, items: { type: string } }
        roleBindings:
          type: array
          items:
            type: object
            additionalProperties: false
            required: [role, scopeOrgPath]
            properties:
              role: { type: string }
              scopeOrgPath: { type: string }
        status: { type: string, enum: [ACTIVE, DISABLED] }
    UserPageInfo:
      type: object
      additionalProperties: false
      required: [page, pageSize, total, totalPages, hasNext, hasPrevious]
      properties:
        page: { type: integer, minimum: 1 }
        pageSize: { type: integer, minimum: 1, maximum: 100 }
        total: { type: integer, minimum: 0 }
        totalPages: { type: integer, minimum: 0 }
        hasNext: { type: boolean }
        hasPrevious: { type: boolean }
    UserPage:
      type: object
      additionalProperties: false
      required: [items, pageInfo]
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/User' }
        pageInfo: { $ref: '#/components/schemas/UserPageInfo' }
    ListPageInfo:
      type: object
      additionalProperties: false
      required: [page, pageSize, total, totalPages, hasNext, hasPrevious]
      properties:
        page: { type: integer, minimum: 1 }
        pageSize: { type: integer, minimum: 1, maximum: 100 }
        total: { type: integer, minimum: 0 }
        totalPages: { type: integer, minimum: 0 }
        hasNext: { type: boolean }
        hasPrevious: { type: boolean }
    SubmissionPage:
      type: object
      additionalProperties: false
      required: [items, pageInfo]
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/Submission' }
        pageInfo: { $ref: '#/components/schemas/ListPageInfo' }
    Audit:
      type: object
      additionalProperties: false
      required: [id, actorId, action, target, createdAt]
      properties:
        id: { type: string }
        actorId: { type: string }
        action: { type: string }
        target: { type: string }
        before: {}
        after: {}
        createdAt: { type: string, format: date-time }
    AuditPage:
      type: object
      additionalProperties: false
      required: [items, pageInfo]
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/Audit' }
        pageInfo: { $ref: '#/components/schemas/ListPageInfo' }
    Submission:
      type: object
      required: [eventId, subjectId, snapshot]
      properties:
        eventId: { type: string }
        subjectId: { type: string }
        snapshot: { type: object, additionalProperties: true }
        challengeVersionSnapshot: { type: string, readOnly: true }
        rubricVersionSnapshot: { type: string, readOnly: true }
        gradingAttempt: { type: integer, minimum: 1, readOnly: true }
        failureReason: { type: string, readOnly: true }
    EventConfig:
      type: object
      required: [id, challengeVersion, submissionSource, trigger, reveal]
      properties:
        id: { type: string }
        challengeVersion: { type: string }
        purpose: { type: string, enum: [TRAINING, HARD_PROBLEM], description: 场次用途；难题榜交付入口使用 HARD_PROBLEM }
        submissionSource: { type: string, enum: [UPLOAD, GIT_REF] }
        trigger: { type: string, enum: [AUTO, MANUAL, IMPORT] }
        reveal: { type: string, enum: [IMMEDIATE, ON_RELEASE] }
        mode: { type: string, enum: [LIVE, WINDOW] }
        startsAt: { type: string, format: date-time }
        endsAt: { type: string, format: date-time }
        participantMode: { type: string, enum: [OPEN, ALLOWLIST] }
        rubricVersion: { type: string }
        deliveryConfig:
          type: object
          additionalProperties: true
          properties:
            repository: { type: string }
            branch: { type: string }
            branchTemplate: { type: string }
            pinAt: { type: string, enum: [SUBMIT, DEADLINE] }
            allowedFormats: { type: array, items: { type: string } }
            maxBytes: { type: integer, minimum: 1 }
            maxFiles: { type: integer, minimum: 1 }
        localGrading:
          type: object
          additionalProperties: true
          deprecated: true
          description: >-
            已废弃。执行器配置改由赛题版本的 evaluationEngine.local 承载，
            平台只在加载历史数据时读取一次以完成迁移，写入时会被忽略。
    UploadSubmission:
      type: object
      required: [subjectId, snapshot]
      properties:
        subjectId: { type: string }
        artifactBase64: { type: string, format: byte, description: 开发期 JSON 上传适配；生产替换为对象存储直传 }
        fileName: { type: string }
        snapshot:
          type: object
          required: [submittedAt]
          properties:
            sourceType: { type: string, enum: [UPLOAD] }
            snapshotHash: { type: string, pattern: '^[a-f0-9]{64}$', description: 服务端计算；客户端提供值会被忽略 }
            artifactHash: { type: string, pattern: '^[a-f0-9]{64}$' }
            artifactUri: { type: string }
            artifactName: { type: string }
            workspacePath: { type: string, description: 本地开发工作区相对路径 }
            submittedAt: { type: string, format: date-time }
    GitSubmission:
      type: object
      required: [subjectId, snapshot]
      properties:
        subjectId: { type: string }
        snapshot:
          type: object
          required: [repository, branch, submittedAt]
          properties:
            sourceType: { type: string, enum: [GIT_REF] }
            snapshotHash: { type: string, pattern: '^[a-f0-9]{64}$', description: 服务端根据提交引用计算 }
            repository: { type: string }
            branch: { type: string }
            commitSha: { type: string, description: SUBMIT 场次必填；DEADLINE 场次可由平台收卷时锁定 }
            submittedAt: { type: string, format: date-time }
    EvaluationResult:
      type: object
      description: 与 contracts/evaluation-result.schema.json 完全一致
      required: [schemaVersion, resultId, gradingRunId, challengeVersion, rubricVersion, graderVersion, idempotencyKey, triggerType, status, submission, dimensions, criteria, total, validationDiagnostics, gradedBy, startedAt, finishedAt, durationMs]
      properties:
        schemaVersion: { type: string, enum: ['1.0'] }
        resultId: { type: string }
        gradingRunId: { type: string }
        challengeVersion: { type: string }
        rubricVersion: { type: string }
        graderVersion: { type: string }
        idempotencyKey: { type: string }
        triggerType: { type: string, enum: [AUTO, MANUAL, IMPORT] }
        status: { type: string, enum: [COMPLETE, PARTIAL, FAILED] }
        submission: { type: object, additionalProperties: true }
        subject:
          type: object
          additionalProperties: false
          required: [kind, id]
          properties:
            kind: { type: string, enum: [person, team] }
            id: { type: string }
            name: { type: string }
            orgPath: { type: string }
            members:
              type: array
              items:
                type: object
                required: [id, role]
                properties:
                  id: { type: string }
                  name: { type: string }
                  role: { type: string }
        dimensions: { type: object, additionalProperties: true }
        criteria: { type: array, items: { type: object, additionalProperties: true } }
        total: { type: number, minimum: 0, maximum: 100 }
        recalculatedTotal: { type: number, minimum: 0, maximum: 100 }
        project: { type: object, additionalProperties: true }
        importedBy: { type: object, additionalProperties: true }
        validationDiagnostics: { type: array, items: { type: object, additionalProperties: true } }
        gradedBy: { type: string, enum: [ci, claude, codex, human] }
        startedAt: { type: string, format: date-time }
        finishedAt: { type: string, format: date-time }
        gradedAt: { type: string, format: date-time }
        durationMs: { type: integer, minimum: 0 }
        metadata: { type: object, additionalProperties: true }
        verifyDetail: { type: object, additionalProperties: true }
        metrics: { type: object, additionalProperties: true }
        findings: { type: array, items: { type: object, additionalProperties: true } }
    Challenge:
      type: object
      required: [id, ownerOrgPath, origin, category, status, versions]
      properties:
        id: { type: string }
        ownerOrgPath: { type: string }
        origin: { type: string, enum: [OFFICIAL, USER, IMPORTED, BOUNTY, EXPLORE] }
        category: { $ref: '#/components/schemas/ChallengeCategory' }
        status: { type: string, enum: [DRAFT, PUBLISHED, ARCHIVED] }
        board: { $ref: '#/components/schemas/ChallengeBoard' }
        versions: { type: array, items: { $ref: '#/components/schemas/ChallengeVersion' } }
    PermanentlyDeletedChallenge:
      type: object
      additionalProperties: false
      required: [id, status]
      properties:
        id: { type: string }
        status: { type: string, enum: [PURGED] }
    ChallengeCategory:
      type: string
      enum: [TRAINING, COMPETITION, HARD_PROBLEM]
      description: 发布者配置的赛题业务类型
    ChallengePatch:
      type: object
      additionalProperties: false
      properties:
        category: { $ref: '#/components/schemas/ChallengeCategory' }
        solutionVisibility: { type: string, enum: [PUBLIC, HIDDEN], description: 揭榜成功后是否公开交付件 }
    ChallengeBoard:
      type: object
      required: [type, summary, publisherType, publisherId, publisherName, difficulty, tags, status, reviewStatus, solutionVisibility, createdAt, updatedAt]
      properties:
        type: { type: string, enum: [HARD_PROBLEM] }
        summary: { type: string }
        details: { type: string }
        publisherType: { type: string, enum: [DEPARTMENT, EMPLOYEE] }
        publisherId: { type: string }
        publisherName: { type: string }
        departmentName: { type: string }
        orgPath: { type: string }
        difficulty: { type: string, enum: [HIGH, MEDIUM, LOW] }
        tags: { type: array, items: { type: string } }
        status: { type: string, enum: [OPEN, RESOLVED] }
        reviewStatus: { type: string, enum: [PENDING_REVIEW, APPROVED, REJECTED] }
        solutionVisibility: { type: string, enum: [PUBLIC, HIDDEN], description: 揭榜成功后是否公开交付件 }
        solutionSubmissionId: { type: string, description: 揭榜成功时选中的提交 ID }
        reviewedAt: { type: string, format: date-time }
        reviewedBy: { type: string }
        reviewComment: { type: string }
        submissionEventId: { type: string, description: 独立难题交付入口对应的上传场次 ID }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }
        resolvedAt: { type: string, format: date-time }
        resolvedBy: { type: string }
        resolvedByName: { type: string }
        solverId: { type: string, description: 揭榜人的员工 ID }
        solverName: { type: string, description: 揭榜人的姓名 }
        solution: { $ref: '#/components/schemas/HardProblemSolution' }
    HardProblemInput:
      type: object
      required: [title, summary, publisherType, publisherId, publisherName, difficulty, tags]
      properties:
        id: { type: string }
        title: { type: string }
        summary: { type: string }
        details: { type: string }
        publisherType: { type: string, enum: [DEPARTMENT, EMPLOYEE] }
        publisherId: { type: string }
        publisherName: { type: string }
        departmentName: { type: string }
        orgPath: { type: string }
        difficulty: { type: string, enum: [HIGH, MEDIUM, LOW] }
        tags: { type: array, items: { type: string } }
        solutionVisibility: { type: string, enum: [PUBLIC, HIDDEN], default: PUBLIC, description: 揭榜成功后是否公开交付件 }
    HardProblemReview:
      type: object
      required: [decision]
      additionalProperties: false
      properties:
        decision: { type: string, enum: [APPROVE, REJECT] }
        comment: { type: string, description: 审核意见；驳回时建议填写 }
    HardProblemSolution:
      type: object
      required: [submissionId, solverId, solverName, submittedAt, state, sourceType]
      properties:
        submissionId: { type: string }
        solverId: { type: string }
        solverName: { type: string }
        submittedAt: { type: string, format: date-time }
        state: { type: string }
        sourceType: { type: string, enum: [UPLOAD, GIT_REF] }
        artifactName: { type: string }
        artifactHash: { type: string, pattern: '^[a-f0-9]{64}$' }
        repository: { type: string }
        branch: { type: string }
        commitSha: { type: string }
    ChallengeVersion:
      type: object
      required: [id, challengeId, version, title, zone, languagePolicy, deliveryPolicy, rubricVersion, submissionContract, status]
      properties:
        id: { type: string }
        challengeId: { type: string }
        version: { type: integer, minimum: 1 }
        title: { type: string }
        description: { type: string }
        objectives: { type: array, items: { type: string } }
        requirements: { type: array, items: { type: string } }
        constraints: { type: array, items: { type: string } }
        deliverables: { type: array, items: { type: string } }
        tags: { type: array, items: { type: string } }
        estimatedMinutes: { type: integer, minimum: 1 }
        zone: { type: string, enum: [YELLOW, BLUE] }
        languagePolicy: { type: object, additionalProperties: true }
        deliveryPolicy: { type: object, additionalProperties: true }
        rubricVersion: { type: string }
        submissionContract: { type: string }
        submissionContractDefinition: { $ref: '#/components/schemas/SubmissionContractDefinition' }
        evaluationEngine: { $ref: '#/components/schemas/EvaluationEngineConfig' }
        tests: { type: object, additionalProperties: true }
        resources: { type: object, additionalProperties: true }
        resourceLimits: { type: object, additionalProperties: true }
        changePackage: { type: object, additionalProperties: true }
        visibility: { type: string, enum: [PUBLIC, ORG, PRIVATE] }
        bounty: { type: number, minimum: 0 }
        explore: { type: boolean }
        status: { type: string, enum: [DRAFT, PUBLISHED] }
    SubmissionContractDefinition:
      type: object
      required: [schemaVersion, required, forbidden]
      properties:
        schemaVersion: { type: string, enum: ['1.0', '1.1'] }
        root:
          type: object
          properties:
            mode: { type: string, enum: [ARCHIVE_ROOT, SINGLE_DIRECTORY] }
            directoryName: { type: string }
        required:
          type: array
          minItems: 1
          items: { $ref: '#/components/schemas/SubmissionContractItem' }
        optional:
          type: array
          items: { $ref: '#/components/schemas/SubmissionContractItem' }
        forbidden: { type: array, items: { type: string } }
        languageEntry: { type: object, additionalProperties: { type: string } }
        allowedPaths: { type: array, items: { type: string } }
        allowAdditionalPaths: { type: boolean }
        maxDepth: { type: integer, minimum: 1, maximum: 30 }
        maxFiles: { type: integer, minimum: 1, maximum: 10000 }
    SubmissionContractItem:
      type: object
      required: [path, type]
      properties:
        path: { type: string }
        type: { type: string, enum: [markdown, source, directory, text, json, yaml] }
        minSections: { type: integer, minimum: 1 }
        minChars: { type: integer, minimum: 0 }
        notTemplate: { type: boolean }
        mustExport: { type: string }
        signature: { type: string }
        minFiles: { type: integer, minimum: 1 }
        allowedExtensions: { type: array, items: { type: string } }
    EvaluationEngineConfig:
      type: object
      required: [id, version, mode, input, output]
      properties:
        id: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$' }
        version: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$' }
        mode:
          type: string
          enum: [EXTERNAL_CLI, PLATFORM_LOCAL, PACKAGED]
          description: >-
            PLATFORM_LOCAL 由评测 Worker 物化仓库内置执行器，必须提供 executor；
            PACKAGED 由评测 Worker 下载并验证出题人上传的引擎包，必须提供 package；
            EXTERNAL_CLI 由管理员在平台外运行，禁止提供 local/package，
            且该赛题的训战只能使用 trigger=IMPORT。
        local:
          type: object
          description: PLATFORM_LOCAL 引擎的执行参数，路径均为仓库内相对路径。
          required: [contractPath, entry, function]
          properties:
            contractPath: { type: string }
            testsDir: { type: string }
            entry: { type: string }
            function: { type: string, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }
            language: { type: string }
        executor:
          type: object
          description: PLATFORM_LOCAL 引擎选用的仓库内置执行器及其参数。
          required: [id]
          properties:
            id: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$' }
            version: { type: string }
            params: { type: object, additionalProperties: true }
        package:
          type: object
          description: PACKAGED 引擎绑定的不可变引擎包，由上传接口返回的内容哈希指定。
          required: [packageHash]
          properties:
            packageHash: { type: string, pattern: '^[a-f0-9]{64}$' }
            size: { type: integer, minimum: 1 }
            fileName: { type: string }
            uploadedAt: { type: string, format: date-time }
            uploadedBy: { type: string }
        agent:
          type: object
          description: 评测 Worker 交给 Code Agent 的赛题级指令和 skills，路径相对于评测引擎根目录。
          required: [instructionPath, skillPaths]
          properties:
            instructionPath: { type: string }
            skillPaths: { type: array, minItems: 1, items: { type: string } }
        input:
          type: object
          required: [format, schemaVersion, contractPath]
          properties:
            format: { type: string, enum: [JSON] }
            schemaVersion: { type: string }
            contractPath: { type: string }
        output:
          type: object
          required: [format, schemaVersion, contractPath]
          properties:
            format: { type: string, enum: [JSON] }
            schemaVersion: { type: string }
            contractPath: { type: string }
    EvaluationContractOption:
      type: object
      additionalProperties: false
      required: [id, kind, visibility, modes, schemaVersion, path, label, description, examplePath, guidePath]
      properties:
        id: { type: string }
        kind: { type: string, enum: [INPUT, OUTPUT] }
        visibility: { type: string, enum: [PUBLIC] }
        modes: { type: array, minItems: 1, items: { type: string, enum: [EXTERNAL_CLI, PLATFORM_LOCAL, PACKAGED] } }
        schemaVersion: { type: string }
        path: { type: string }
        label: { type: string }
        description: { type: string }
        examplePath: { type: string }
        guidePath: { type: string }
    EvaluationContractDetail:
      type: object
      additionalProperties: false
      required: [id, kind, visibility, modes, schemaVersion, path, label, description, examplePath, guidePath, schema, example, guide]
      properties:
        id: { type: string }
        kind: { type: string, enum: [INPUT, OUTPUT] }
        visibility: { type: string, enum: [PUBLIC] }
        modes: { type: array, minItems: 1, items: { type: string, enum: [EXTERNAL_CLI, PLATFORM_LOCAL, PACKAGED] } }
        schemaVersion: { type: string }
        path: { type: string }
        label: { type: string }
        description: { type: string }
        examplePath: { type: string }
        guidePath: { type: string }
        schema: { type: object, additionalProperties: true }
        example: {}
        guide: { type: string }
    EvaluationInputBatch:
      type: object
      required: [schemaVersion, generatedAt, event, challenge, submissions]
      properties:
        schemaVersion: { type: string, enum: ['1.0'] }
        generatedAt: { type: string, format: date-time }
        event:
          type: object
          required: [id, challengeVersion, rubricVersion, trigger, submissionSource, reveal]
          properties:
            id: { type: string }
            challengeVersion: { type: string }
            rubricVersion: { type: string }
            trigger: { type: string, enum: [IMPORT] }
            submissionSource: { type: string, enum: [UPLOAD, GIT_REF] }
            reveal: { type: string, enum: [IMMEDIATE, ON_RELEASE] }
        challenge:
          type: object
          required: [id, title, version, evaluationEngine]
          properties:
            id: { type: string }
            title: { type: string }
            version: { type: integer, minimum: 1 }
            evaluationEngine: { $ref: '#/components/schemas/EvaluationEngineConfig' }
        submissions:
          type: array
          minItems: 1
          maxItems: 500
          items:
            type: object
            required: [submissionId, subject, snapshot, grading]
            properties:
              submissionId: { type: string }
              subject: { type: object, required: [id, name, orgPath], additionalProperties: true }
              snapshot: { type: object, additionalProperties: true }
              grading:
                type: object
                required: [runId, idempotencyKey, triggerType]
                properties:
                  runId: { type: string }
                  idempotencyKey: { type: string }
                  triggerType: { type: string, enum: [IMPORT] }
    Announcement:
      type: object
      required: [id, title, summary, tag, publishedAt]
      properties:
        id: { type: string }
        title: { type: string }
        summary: { type: string }
        tag: { type: string, enum: [平台通知, 训战提醒, 规则更新] }
        publishedAt: { type: string, format: date-time }
        pinned: { type: boolean }
    ProfileHistoryPage:
      type: object
      required: [items, pageInfo]
      properties:
        items:
          type: array
          items:
            type: object
            required: [submissionId, eventId, total, resultId, createdAt]
            properties:
              submissionId: { type: string }
              eventId: { type: string }
              total: { type: number, minimum: 0, maximum: 100 }
              points: { type: number }
              resultId: { type: string }
              createdAt: { type: string, format: date-time }
        pageInfo: { $ref: '#/components/schemas/ListPageInfo' }
    AdminCapabilityBundle:
      type: object
      required: [generatedAt, selection, totalCandidates, selectedCount, gradedUsers, aggregate, profiles, profilePageInfo]
      properties:
        generatedAt: { type: string, format: date-time }
        selection:
          type: object
          required: [orgPath, eventId, mode, subjectIds]
          properties:
            orgPath: { type: [string, 'null'] }
            eventId: { type: [string, 'null'] }
            mode: { type: string, enum: [ALL, SELECTED] }
            subjectIds: { type: array, items: { type: string } }
          additionalProperties: true
        totalCandidates: { type: integer, minimum: 0 }
        selectedCount: { type: integer, minimum: 0 }
        gradedUsers: { type: integer, minimum: 0 }
        aggregate: { type: object, additionalProperties: true }
        profiles: { type: array, items: { type: object, additionalProperties: true } }
        profilePageInfo: { $ref: '#/components/schemas/ListPageInfo' }
    LeaderboardRow:
      type: object
      additionalProperties: false
      required: [rank, nickname, score, points, total, submissions, isSelf]
      properties:
        rank: { type: integer, minimum: 1, maximum: 3 }
        nickname: { type: string, description: 榜单公开展示昵称；未设置时返回未设置昵称 }
        score: { type: number, description: 赛季累计成绩 }
        points: { type: integer, minimum: 0, description: 赛季积分 }
        total: { type: integer, minimum: 0, description: 赛季积分兼容字段 }
        submissions: { type: integer, minimum: 0, description: 已计入榜单的参赛场次 }
        isSelf: { type: boolean, description: 当前登录员工是否为该榜单项 }
        subjectId: { type: string, description: 仅管理员可见的用户标识 }
        name: { type: string, description: 仅管理员可见的真实姓名 }
        employeeNo: { type: string, description: 仅管理员可见的工号 }
    CapabilityProfile:
      type: object
      required: [subjectId, summary, dimensions, domains, skills, trend, capabilityCatalogVersion]
      properties:
        subjectId: { type: string }
        capabilityCatalogVersion: { type: string, example: '1.0' }
        summary:
          type: object
          required: [gradedSubmissions, overallAverage, latestTotal, delta, strongestDimension, focusDimension, strongestDomain, focusDomain, totalCapabilityDomains, evaluatedCapabilityDomains, departmentStatsVisible]
          properties:
            gradedSubmissions: { type: integer, minimum: 0 }
            overallAverage: { type: [number, 'null'], minimum: 0, maximum: 100 }
            latestTotal: { type: [number, 'null'], minimum: 0, maximum: 100 }
            delta: { type: [number, 'null'] }
            strongestDimension: { type: [string, 'null'] }
            focusDimension: { type: [string, 'null'] }
            strongestDomain: { type: [string, 'null'] }
            focusDomain: { type: [string, 'null'] }
            totalCapabilityDomains: { type: integer, minimum: 0 }
            evaluatedCapabilityDomains: { type: integer, minimum: 0 }
            totalSkillItems: { type: integer, minimum: 0 }
            evaluatedSkillItems: { type: integer, minimum: 0 }
            zoneStats: { type: object, additionalProperties: { type: integer, minimum: 0 } }
            departmentAverage: { type: [number, 'null'], minimum: 0, maximum: 100, description: 普通员工无权限时返回 null，前端显示 * }
            departmentMedian: { type: [number, 'null'], minimum: 0, maximum: 100, description: 普通员工无权限时返回 null，前端显示 * }
            departmentPercentile: { type: [number, 'null'], minimum: 0, maximum: 100, description: 普通员工无权限时返回 null，前端显示 * }
            departmentStatsVisible: { type: boolean, description: 是否有权查看部门平均、中位数和百分位等统计 }
        dimensions:
          type: array
          items: { $ref: '#/components/schemas/CapabilityDimension' }
        domains:
          type: array
          minItems: 8
          maxItems: 8
          items: { $ref: '#/components/schemas/CapabilityDomain' }
        capabilityDomains:
          type: array
          description: domains 的兼容别名
          items: { $ref: '#/components/schemas/CapabilityDomain' }
        skills: { type: array, items: { $ref: '#/components/schemas/CapabilitySkill' } }
        gradeMatrix: { type: array, items: { $ref: '#/components/schemas/CapabilitySkill' } }
        weakItems: { type: array, items: { type: object, additionalProperties: true } }
        recommendations: { type: array, items: { type: string } }
        trend: { type: array, items: { type: object, additionalProperties: true } }
        zoneStats: { type: object, additionalProperties: { type: integer, minimum: 0 } }
        departmentComparison:
          type: object
          required: [orgPath, participantCount, average, median, percentile]
          properties:
            orgPath: { type: string }
            participantCount: { type: integer, minimum: 0 }
            average: { type: [number, 'null'], minimum: 0, maximum: 100 }
            median: { type: [number, 'null'], minimum: 0, maximum: 100 }
            percentile: { type: [number, 'null'], minimum: 0, maximum: 100 }
        departmentStatsVisible: { type: boolean }
        lastUpdated: { type: [string, 'null'], format: date-time }
    CapabilityDimension:
      type: object
      required: [key, label, description, percent, samples]
      properties:
        key: { type: string }
        label: { type: string }
        description: { type: string }
        score: { type: [number, 'null'] }
        max: { type: [number, 'null'] }
        percent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        latestPercent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        bestPercent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        delta: { type: [number, 'null'] }
        evaluatedCount: { type: integer, minimum: 0 }
        peerMedianPercent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        peerCount: { type: integer, minimum: 0 }
        vsPeerMedian: { type: [number, 'null'] }
        samples: { type: array, items: { type: object, additionalProperties: true } }
    CapabilityDomain:
      type: object
      required: [key, label, shortLabel, description, evidenceMode, criterionKeys, evidenceKeys, percent, sampleCount, evidenceCount, status, samples]
      properties:
        key: { type: string }
        label: { type: string }
        shortLabel: { type: string }
        description: { type: string }
        evidenceMode: { type: string, enum: [derived, direct] }
        criterionKeys: { type: array, items: { type: string } }
        evidenceKeys: { type: array, items: { type: string } }
        score: { type: [number, 'null'] }
        max: { type: [number, 'null'] }
        percent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        latestPercent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        bestPercent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        delta: { type: [number, 'null'] }
        sampleCount: { type: integer, minimum: 0 }
        evidenceCount: { type: integer, minimum: 0 }
        peerMedianPercent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        peerCount: { type: integer, minimum: 0 }
        vsPeerMedian: { type: [number, 'null'] }
        status: { type: string }
        samples: { type: array, items: { type: object, additionalProperties: true } }
    CapabilitySkill:
      type: object
      required: [key, criterionKey, name, dimension, description, max, percent, sampleCount, status]
      properties:
        key: { type: string }
        criterionKey: { type: string }
        name: { type: string }
        dimension: { type: string, enum: [verify, spec, code, collab] }
        domainKeys: { type: array, items: { type: string } }
        description: { type: string }
        max: { type: number, exclusiveMinimum: 0 }
        averageScore: { type: [number, 'null'] }
        percent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        latestPercent: { type: [number, 'null'], minimum: 0, maximum: 100 }
        averageLevel: { type: [string, 'null'], enum: [A, B, C, D, null] }
        sampleCount: { type: integer, minimum: 0 }
        status: { type: string }
    ErrorResponse:
      type: object
      required: [code, message]
      properties:
        code: { type: string, example: RESULT_SCORE_INCONSISTENT }
        message: { type: string }
        requestId: { type: string }
        details: { type: object, additionalProperties: true }

--- END FILE: contracts/openapi.yaml ---


--- BEGIN FILE: contracts/submission-contract-v1.1.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/submission-contract-v1.1.schema.json",
  "title": "Submission Contract 1.1",
  "description": "赛题版本冻结的交付目录规范。平台在接收 ZIP 或固定 Git 版本时先校验，未通过的交付不会进入评测队列。",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "required", "forbidden"],
  "properties": {
    "schemaVersion": { "const": "1.1" },
    "root": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mode"],
      "properties": {
        "mode": { "enum": ["ARCHIVE_ROOT", "SINGLE_DIRECTORY"] },
        "directoryName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100,
          "pattern": "^[^/\\\\]+$"
        }
      }
    },
    "required": {
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "items": { "$ref": "#/$defs/item" }
    },
    "optional": {
      "type": "array",
      "maxItems": 200,
      "items": { "$ref": "#/$defs/item" }
    },
    "forbidden": {
      "type": "array",
      "maxItems": 200,
      "items": { "$ref": "#/$defs/path" },
      "uniqueItems": true
    },
    "languageEntry": {
      "type": "object",
      "additionalProperties": false,
      "patternProperties": {
        "^(python|java|go)$": { "$ref": "#/$defs/path" }
      }
    },
    "allowedPaths": {
      "type": "array",
      "maxItems": 300,
      "items": { "$ref": "#/$defs/path" },
      "uniqueItems": true
    },
    "allowAdditionalPaths": { "type": "boolean", "default": true },
    "maxDepth": { "type": "integer", "minimum": 1, "maximum": 30 },
    "maxFiles": { "type": "integer", "minimum": 1, "maximum": 10000 }
  },
  "$defs": {
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)(?![A-Za-z]:).+$"
    },
    "item": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "type"],
      "properties": {
        "path": { "$ref": "#/$defs/path" },
        "type": { "enum": ["markdown", "source", "directory", "text", "json", "yaml"] },
        "minSections": { "type": "integer", "minimum": 1 },
        "minChars": { "type": "integer", "minimum": 0 },
        "notTemplate": { "type": "boolean" },
        "mustExport": { "type": "string", "minLength": 1 },
        "signature": { "type": "string", "minLength": 1 },
        "minFiles": { "type": "integer", "minimum": 1 },
        "allowedExtensions": {
          "type": "array",
          "minItems": 1,
          "maxItems": 50,
          "uniqueItems": true,
          "items": { "type": "string", "pattern": "^\\.[A-Za-z0-9][A-Za-z0-9._+-]{0,20}$" }
        }
      }
    }
  }
}

--- END FILE: contracts/submission-contract-v1.1.schema.json ---


--- BEGIN FILE: contracts/submission-contract.schema.json ---

{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ai-training-platform.local/contracts/submission-contract.schema.json",
  "title": "Submission Contract",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "required", "forbidden", "languageEntry"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "required": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/requiredItem" }
    },
    "optional": {
      "type": "array",
      "items": { "$ref": "#/$defs/optionalItem" }
    },
    "forbidden": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "uniqueItems": true
    },
    "languageEntry": {
      "type": "object",
      "minProperties": 1,
      "additionalProperties": false,
      "patternProperties": {
        "^(python|java|go)$": { "type": "string", "minLength": 1 }
      }
    }
  },
  "$defs": {
    "path": { "type": "string", "minLength": 1, "pattern": "^(?!/)(?!.*\\.\\.)(?!.*\\\\).+$" },
    "requiredItem": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path", "type"],
      "properties": {
        "path": { "$ref": "#/$defs/path" },
        "type": { "enum": ["markdown", "source", "directory", "text"] },
        "minSections": { "type": "integer", "minimum": 1 },
        "minChars": { "type": "integer", "minimum": 0 },
        "notTemplate": { "type": "boolean" },
        "mustExport": { "type": "string", "minLength": 1 },
        "signature": { "type": "string", "minLength": 1 }
      }
    },
    "optionalItem": {
      "type": "object",
      "additionalProperties": false,
      "required": ["path"],
      "properties": {
        "path": { "$ref": "#/$defs/path" },
        "type": { "enum": ["markdown", "source", "directory", "text"] }
      }
    }
  }
}

--- END FILE: contracts/submission-contract.schema.json ---


--- BEGIN FILE: docs/deployment/ldap3-nginx-intranet-deployment.md ---

# 内网单服务器部署手册：Nginx + LDAP3 + AI 能力提升平台

> 给内网部署 AI 使用。请严格按顺序执行，不要自行替换认证方案、删除身份头或把 API 端口暴露给用户。

## 0. 目标结果

部署完成后，用户只访问一个地址：

~~~text
https://ai-platform.intra.example/
~~~

请求流向固定为：

~~~text
浏览器
  ├─ /                 → Nginx → Web 静态文件
  ├─ /auth/login      → Nginx → LDAP3 网关
  ├─ /login-logo.png  → Nginx → LDAP3 网关
  └─ /api/v1/*        → Nginx → LDAP3 /auth/verify → Platform API
~~~

LDAP3 网关使用内网 LDAP 域账号校验登录，成功后保存 HttpOnly 会话 Cookie。Nginx 每次转发 API 前调用 /auth/verify，把网关返回的签名身份头写入 API 请求。Platform API 只信任签名身份头。

## 1. 不能违反的规则

1. PLATFORM_IDENTITY_MODE 必须是 TRUSTED_GATEWAY。
2. Platform API 的 3000 端口和 LDAP3 网关的 8081 端口只监听 127.0.0.1，不允许办公网直接访问。
3. TRUSTED_GATEWAY_HMAC_SECRET 必须在 API 和 LDAP3 网关中完全相同。
4. LDAP_GATEWAY_SESSION_SECRET 只能放在 LDAP3 网关，不能和 HMAC 密钥复用。
5. LDAP 密码不能写入 Git、日志、数据库、Nginx 配置或前端代码。
6. 生产环境使用 HTTPS，并设置 LDAP_GATEWAY_COOKIE_SECURE=true。
7. 不要设置 PLATFORM_IDENTITY_MODE=LOCAL，不要设置 ALLOW_ANONYMOUS_LOCAL=true。

## 2. 服务器准备

以下命令适用于 Ubuntu/Debian 类 Linux。若内网系统不同，请让系统管理员提供等价的软件包，不要让 AI 自行更换部署方式。

需要的软件：

- Node.js 20 或更高版本；
- pnpm 11.8.0；
- Python 3.11 或更高版本；
- Nginx；
- Git；
- OpenSSL；
- PostgreSQL 和生产对象存储（平台生产模式要求）。

检查版本：

~~~bash
node --version
pnpm --version
python3 --version
nginx -v
git --version
~~~

如果 Node.js 低于 20，先停止部署并升级 Node.js。

创建运行用户和目录：

~~~bash
sudo useradd --system --home-dir /opt/ai-training-platform --shell /usr/sbin/nologin ai-platform
sudo mkdir -p /opt/ai-training-platform/deploy
sudo mkdir -p /etc/nginx/tls
sudo chown -R ai-platform:ai-platform /opt/ai-training-platform
~~~

## 3. 获取代码和安装依赖

把 <内网 Git 地址> 替换为实际仓库地址：

~~~bash
sudo git clone <内网 Git 地址> /opt/ai-training-platform
sudo chown -R ai-platform:ai-platform /opt/ai-training-platform
cd /opt/ai-training-platform

sudo -u ai-platform corepack enable
sudo -u ai-platform corepack prepare pnpm@11.8.0 --activate
sudo -u ai-platform pnpm install --frozen-lockfile

sudo -u ai-platform python3 -m venv services/ldap3-gateway/.venv
sudo -u ai-platform services/ldap3-gateway/.venv/bin/python -m pip install --upgrade pip
sudo -u ai-platform services/ldap3-gateway/.venv/bin/pip install -r services/ldap3-gateway/requirements.txt
~~~

## 4. 创建 API 环境变量

创建文件：

~~~bash
sudo install -o ai-platform -g ai-platform -m 600 /dev/null /opt/ai-training-platform/deploy/platform-api.env
sudo nano /opt/ai-training-platform/deploy/platform-api.env
~~~

写入下面内容，并替换尖括号中的值：

platform-api.env 会被 systemd 和迁移命令读取；含有空格、# 或 $ 的值必须使用单引号包住。数据库密码中的特殊字符必须先按 URL 规则编码后再放入 DATABASE_URL。

~~~env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000

PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=<复制同一条随机密钥到 LDAP3 网关>
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90

PLATFORM_REPOSITORY=postgres
DATABASE_URL=postgresql://<数据库用户>:<数据库密码>@<数据库地址>:5432/<数据库名>

OBJECT_STORAGE_MODE=s3
OBJECT_STORAGE_BUCKET=<对象存储桶>
OBJECT_STORAGE_REGION=<对象存储区域>
OBJECT_STORAGE_ENDPOINT=<内网对象存储地址>
OBJECT_STORAGE_ACCESS_KEY_ID=<对象存储访问密钥>
OBJECT_STORAGE_SECRET_ACCESS_KEY=<对象存储私钥>
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_PREFIX=platform

PROJECT_ROOT=/opt/ai-training-platform
ARTIFACT_ROOT=/opt/ai-training-platform/tmp/artifacts
ENGINE_PACKAGE_ROOT=/opt/ai-training-platform/tmp/engine-packages
LOCAL_WORKSPACE_ROOT=/opt/ai-training-platform
EMBEDDED_EVALUATION_WORKER=false
CORS_ORIGINS=https://ai-platform.intra.example
~~~

生成 HMAC 密钥的方法：

~~~bash
openssl rand -hex 32
~~~

执行一次，把输出复制到 TRUSTED_GATEWAY_HMAC_SECRET。再执行一次，把输出作为 LDAP_GATEWAY_SESSION_SECRET。不要把生成结果发给 AI 或写入聊天记录。

## 5. 创建 LDAP3 网关环境变量

创建文件：

~~~bash
sudo install -o ai-platform -g ai-platform -m 600 /dev/null /opt/ai-training-platform/deploy/ldap3-gateway.env
sudo nano /opt/ai-training-platform/deploy/ldap3-gateway.env
~~~

写入下面内容：

~~~env
LDAP_GATEWAY_HOST=127.0.0.1
LDAP_GATEWAY_PORT=8081

LDAP_SERVER=china.huawei.com
LDAP_PORT=389
LDAP_USE_SSL=false
LDAP_START_TLS=true
LDAP_CA_CERT_FILE=/etc/ssl/certs/company-ldap-ca.pem
LDAP_BASE_DN=dc=china,dc=huawei,dc=com
# systemd 环境文件中写两个反斜杠，进程最终收到一个反斜杠。
LDAP_BIND_PREFIX=China\\
LDAP_ACCOUNT_ATTRIBUTE=sAMAccountName
LDAP_TITLE_ATTRIBUTE=title
LDAP_DEPARTMENT_ATTRIBUTE=department
LDAP_NAME_ATTRIBUTE=displayName
LDAP_TIMEOUT_SECONDS=5

LDAP_GATEWAY_SESSION_SECRET=<第二条独立随机密钥>
TRUSTED_GATEWAY_HMAC_SECRET=<必须与 platform-api.env 完全相同>
LDAP_GATEWAY_SESSION_TTL_SECONDS=28800
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
LDAP_GATEWAY_COOKIE_SECURE=true
~~~

将企业 LDAP CA 证书复制到配置中的路径：

~~~bash
sudo install -o ai-platform -g ai-platform -m 644 <企业 LDAP CA 证书> /etc/ssl/certs/company-ldap-ca.pem
~~~

如果内网 LDAP 只提供 LDAPS，将配置改为：

~~~env
LDAP_PORT=636
LDAP_USE_SSL=true
LDAP_START_TLS=false
~~~

LDAP_USE_SSL 和 LDAP_START_TLS 不能同时为 true。

## 6. 构建 Web 和 API

构建前必须设置同域 API 地址，否则浏览器会错误访问用户电脑自己的 127.0.0.1：

~~~bash
cd /opt/ai-training-platform
export VITE_API_BASE=/api/v1
export VITE_AUTH_LOGIN_PATH=/auth/login
sudo -u ai-platform env VITE_API_BASE="$VITE_API_BASE" VITE_AUTH_LOGIN_PATH="$VITE_AUTH_LOGIN_PATH" pnpm build
~~~

构建成功后必须存在：

~~~text
/opt/ai-training-platform/apps/web/dist/index.html
/opt/ai-training-platform/apps/web/dist/brand-logo.png
/opt/ai-training-platform/services/platform-api/dist/main.js
~~~

首次使用 PostgreSQL 时，在启动 API 前执行迁移：

~~~bash
cd /opt/ai-training-platform
sudo -u ai-platform bash -lc 'set -a; source /opt/ai-training-platform/deploy/platform-api.env; set +a; cd /opt/ai-training-platform; pnpm --filter @ai-training/platform-api prisma:migrate:deploy'
~~~

如果这条命令报错，不要删除迁移目录；先检查 DATABASE_URL、数据库网络和数据库权限。

## 7. 创建 systemd 服务

### 7.1 Platform API

~~~bash
sudo tee /etc/systemd/system/ai-platform-api.service > /dev/null <<'EOF'
[Unit]
Description=AI Training Platform API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ai-platform
Group=ai-platform
WorkingDirectory=/opt/ai-training-platform
EnvironmentFile=/opt/ai-training-platform/deploy/platform-api.env
ExecStart=/usr/bin/node /opt/ai-training-platform/services/platform-api/dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
~~~

### 7.2 LDAP3 网关

~~~bash
sudo tee /etc/systemd/system/ai-platform-ldap3.service > /dev/null <<'EOF'
[Unit]
Description=AI Training Platform LDAP3 Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ai-platform
Group=ai-platform
WorkingDirectory=/opt/ai-training-platform/services/ldap3-gateway
EnvironmentFile=/opt/ai-training-platform/deploy/ldap3-gateway.env
ExecStart=/opt/ai-training-platform/services/ldap3-gateway/.venv/bin/python /opt/ai-training-platform/services/ldap3-gateway/ldap3_gateway.py
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
~~~

启动服务：

~~~bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-platform-api.service
sudo systemctl enable --now ai-platform-ldap3.service
sudo systemctl status ai-platform-api.service --no-pager
sudo systemctl status ai-platform-ldap3.service --no-pager
~~~

## 8. 配置 Nginx

先把平台 HTTPS 证书放到：

~~~text
/etc/nginx/tls/ai-platform.crt
/etc/nginx/tls/ai-platform.key
~~~

创建 Nginx 配置：

~~~bash
sudo nano /etc/nginx/sites-available/ai-platform
~~~

完整内容如下。只需要替换 server_name、证书路径和项目路径；不要删除 auth_request、X-Trusted-* 或清理浏览器身份头的配置。

~~~nginx
server {
    listen 80;
    server_name ai-platform.intra.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ai-platform.intra.example;

    ssl_certificate     /etc/nginx/tls/ai-platform.crt;
    ssl_certificate_key /etc/nginx/tls/ai-platform.key;

    client_max_body_size 75m;

    # 只允许 Nginx 内部子请求调用，浏览器不能直接访问。
    location = /_ldap_verify {
        internal;
        proxy_pass http://127.0.0.1:8081/auth/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Host $host;
        proxy_set_header Cookie $http_cookie;
    }

    # 登录页和登录页图标不需要先登录。
    location = /auth/login {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie $http_cookie;
    }

    location = /auth/logout {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Cookie $http_cookie;
    }

    location = /login-logo.png {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
    }

    # 主站 Logo 也是公共静态资源。
    location = /brand-logo.png {
        root /opt/ai-training-platform/apps/web/dist;
    }

    # API 必须先通过 LDAP3 会话校验。
    location /api/ {
        auth_request /_ldap_verify;
        auth_request_set $trusted_employee_no $upstream_http_x_trusted_employee_no;
        auth_request_set $trusted_name $upstream_http_x_trusted_name;
        auth_request_set $trusted_department $upstream_http_x_trusted_department;
        auth_request_set $trusted_issued_at $upstream_http_x_trusted_issued_at;
        auth_request_set $trusted_signature $upstream_http_x_trusted_identity_signature;

        # 删除浏览器可能伪造的身份头，再写入网关签名头。
        proxy_set_header X-Employee-Id "";
        proxy_set_header X-Trusted-Employee-No $trusted_employee_no;
        proxy_set_header X-Trusted-Name $trusted_name;
        proxy_set_header X-Trusted-Department $trusted_department;
        proxy_set_header X-Trusted-Issued-At $trusted_issued_at;
        proxy_set_header X-Trusted-Identity-Signature $trusted_signature;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_pass http://127.0.0.1:3000;
        proxy_read_timeout 300s;
    }

    # 未登录打开主站时跳转 LDAP3 登录页。
    location / {
        auth_request /_ldap_verify;
        error_page 401 =302 /auth/login?returnTo=$request_uri;
        root /opt/ai-training-platform/apps/web/dist;
        try_files $uri $uri/ /index.html;
    }
}
~~~

启用并检查配置：

~~~bash
sudo ln -s /etc/nginx/sites-available/ai-platform /etc/nginx/sites-enabled/ai-platform
sudo nginx -t
sudo systemctl reload nginx
~~~

如果 ln 报“文件已存在”，不要重复创建；先检查：

~~~bash
ls -l /etc/nginx/sites-enabled/ai-platform
~~~

## 9. 按顺序验收

### 9.1 检查本机服务

~~~bash
curl -fsS http://127.0.0.1:3000/api/v1/health
curl -fsS http://127.0.0.1:8081/healthz
curl -I https://ai-platform.intra.example/login-logo.png
~~~

三个命令都应成功。LDAP3 网关健康检查只代表进程存活，不代表 LDAP 网络已连通。

### 9.2 检查未登录跳转

~~~bash
curl -k -I https://ai-platform.intra.example/
~~~

响应应为 302，并且 Location 包含：

~~~text
/auth/login?returnTo=/
~~~

### 9.3 检查浏览器登录

1. 使用浏览器打开 https://ai-platform.intra.example/。
2. 应自动跳转到登录页。
3. 页面显示云图标、登录、工号、密码。
4. 输入真实 LDAP 工号和密码。
5. 登录成功后回到原页面。
6. 打开“个人中心”，确认工号、姓名、部门正确。

### 9.4 检查安全边界

~~~bash
curl -i http://127.0.0.1:3000/api/v1/me
~~~

此请求只能在服务器本机看到；不要把 3000 端口配置为 0.0.0.0，不要把它加入防火墙入站白名单。

## 10. 常见故障：只按表格排查

| 现象 | 检查顺序 |
| --- | --- |
| 打开主站没有跳登录页 | nginx -t；location / 是否有 auth_request；/_ldap_verify 是否 internal |
| 登录页能打开但 Logo 不显示 | systemctl status ai-platform-ldap3；curl -I http://127.0.0.1:8081/login-logo.png；Nginx 是否配置 /login-logo.png |
| 登录后马上又回到登录页 | HTTPS 是否启用；LDAP_GATEWAY_COOKIE_SECURE 是否为 true；浏览器是否保存 Cookie |
| LDAP 登录失败 | LDAP 主机、端口、CA 证书、LDAP_START_TLS/LDAP_USE_SSL、LDAP_BIND_PREFIX |
| 页面能打开但 API 返回 401 | API 和网关的 HMAC 密钥是否完全相同；Nginx 是否复制五个 X-Trusted-* 头 |
| API 返回 trusted gateway identity is expired | 两个服务的系统时间；NTP；TRUSTED_GATEWAY_MAX_AGE_SECONDS |
| 员工姓名或部门为空 | 检查 AD title 格式是否为 工号,姓名,部门，以及 department、displayName 字段 |
| Nginx 返回 413 | 增大 client_max_body_size，当前平台示例为 75m |
| API 服务启动失败 | journalctl -u ai-platform-api -n 100 --no-pager；重点检查数据库和对象存储变量 |

查看日志：

~~~bash
sudo journalctl -u ai-platform-api -f
sudo journalctl -u ai-platform-ldap3 -f
sudo tail -f /var/log/nginx/error.log
~~~

日志中不得出现 LDAP 密码、会话 Cookie、HMAC 密钥或完整 SSO 断言。发现后立即停止服务并清理日志。

## 11. 更新版本

更新前先备份数据库、对象存储和 deploy/*.env：

~~~bash
cd /opt/ai-training-platform
sudo systemctl stop ai-platform-api.service ai-platform-ldap3.service
sudo -u ai-platform git pull --ff-only
sudo -u ai-platform pnpm install --frozen-lockfile
sudo -u ai-platform services/ldap3-gateway/.venv/bin/pip install -r services/ldap3-gateway/requirements.txt
export VITE_API_BASE=/api/v1
export VITE_AUTH_LOGIN_PATH=/auth/login
sudo -u ai-platform env VITE_API_BASE="$VITE_API_BASE" VITE_AUTH_LOGIN_PATH="$VITE_AUTH_LOGIN_PATH" pnpm build
sudo systemctl start ai-platform-api.service ai-platform-ldap3.service
sudo nginx -t && sudo systemctl reload nginx
~~~

如果数据库迁移失败，停止后续操作，恢复备份并联系平台开发人员。不要删除 prisma/migrations。

## 12. 部署完成回报模板

弱模型完成后只回报下面信息，不要回报密钥、密码、Cookie 或完整日志：

~~~text
部署结果：
- 代码目录：
- 平台域名：
- API health：通过 / 失败
- LDAP3 health：通过 / 失败
- 未登录跳转：通过 / 失败
- 浏览器 LDAP 登录：通过 / 失败
- /api/v1/me 返回员工信息：通过 / 失败
- 未解决问题：
~~~

相关详细协议：

- ldap3-trusted-gateway.md：LDAP3 网关实现和 HMAC 细节；
- trusted-gateway-sso.md：平台可信网关身份协议；
- windows-production-smoke-test.md：Windows 个人电脑上的生产模式端到端验收步骤。

--- END FILE: docs/deployment/ldap3-nginx-intranet-deployment.md ---


--- BEGIN FILE: docs/deployment/ldap3-trusted-gateway.md ---

# LDAP3 统一认证接入平台

这份文档把内网提供的 LDAP3 示例接入现有平台登录链路。平台不直接接收 LDAP 密码，也不在平台数据库保存 LDAP 凭据；LDAP3 运行在内网认证网关或同一安全域的身份适配器中。

## 1. 登录链路

```text
浏览器
  |
  | 访问平台，未登录
  v
LDAP3 网关 /auth/login
  |-- ldap3.Connection(auto_bind=True, user="China\\" + 工号, password=密码)
  |-- 查询 sAMAccountName
  |-- 从 title 解析 工号,姓名,部门
  |-- department 作为部门兜底
  `-- 设置 HttpOnly 会话 Cookie
          |
          | /auth/verify 供反向代理校验
          v
反向代理
  |-- 生成五个 X-Trusted-* 请求头
  `-- /api/ 转发 Platform API
          |
          `-- TRUSTED_GATEWAY Guard 验签并按工号幂等建档
```

平台 Web 和 API 建议使用同一个内网域名，例如 `https://ai-platform.intra/` 和 `https://ai-platform.intra/api/v1`。API 端口只允许反向代理或网关访问。

## 2. LDAP 配置映射

示例代码对应的默认配置如下：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `LDAP_SERVER` | `china.huawei.com` | LDAP/AD 主机名 |
| `LDAP_PORT` | `389` | 生产建议改为 LDAPS 的 `636`，或由网关启用 StartTLS |
| `LDAP_USE_SSL` | `false` | 使用 LDAPS 时设为 `true`，通常配合端口 `636` |
| `LDAP_START_TLS` | `false` | 使用 LDAP StartTLS 时设为 `true`，与 `LDAP_USE_SSL` 不能同时开启 |
| `LDAP_BASE_DN` | `dc=china,dc=huawei,dc=com` | 搜索根 DN |
| `LDAP_BIND_PREFIX` | `China\` | 与示例的 `China\` + 工号一致 |
| `LDAP_ACCOUNT_ATTRIBUTE` | `sAMAccountName` | 工号搜索字段 |
| `LDAP_TITLE_ATTRIBUTE` | `title` | 按 `工号,姓名,部门` 解析 |
| `LDAP_DEPARTMENT_ATTRIBUTE` | `department` | `title` 没有部门时的兜底字段 |
| `LDAP_NAME_ATTRIBUTE` | `displayName` | `title` 没有姓名时的兜底字段 |
| `LDAP_CA_CERT_FILE` | 空 | LDAPS/StartTLS 的企业 CA 证书文件；启用 TLS 时按网关证书策略配置 |

代码对 LDAP 搜索值做 RFC 4515 转义，避免把工号直接拼入过滤器造成 LDAP 注入；只请求上述三个属性，不使用 `ALL_ATTRIBUTES`。

## 3. 网关配置

在网关环境中注入：

```env
LDAP_SERVER=china.huawei.com
LDAP_PORT=389
LDAP_USE_SSL=false
LDAP_START_TLS=true
LDAP_BASE_DN=dc=china,dc=huawei,dc=com
LDAP_CA_CERT_FILE=/etc/ssl/certs/company-ldap-ca.pem
LDAP_BIND_PREFIX=China\
LDAP_ACCOUNT_ATTRIBUTE=sAMAccountName
LDAP_TITLE_ATTRIBUTE=title
LDAP_DEPARTMENT_ATTRIBUTE=department
LDAP_NAME_ATTRIBUTE=displayName
LDAP_TIMEOUT_SECONDS=5

# 两个用途不同的密钥，均由密钥管理系统注入，不要复用或提交 Git
LDAP_GATEWAY_SESSION_SECRET=<至少 32 字符随机值>
TRUSTED_GATEWAY_HMAC_SECRET=<至少 32 字符随机值>
LDAP_GATEWAY_SESSION_TTL_SECONDS=28800
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
LDAP_GATEWAY_COOKIE_SECURE=true
```

启动参考实现：

```bash
cd services/ldap3-gateway
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python ldap3_gateway.py
```

参考实现默认监听 `127.0.0.1:8081`，生产应由 HTTPS 反向代理承载，不要直接暴露给办公网。

## 4. 反向代理契约

反向代理对每一个发往 Platform API 的请求都要：

1. 删除浏览器传入的 `X-Employee-Id`、`X-Trusted-*` 等身份头；
2. 以当前会话调用网关 `GET /auth/verify`；
3. 将验证响应中的五个 `X-Trusted-*` 头复制到 API 请求；
4. API 请求只转发到内网 Platform API 地址。

Nginx `auth_request` 适配示意：

```nginx
location = /_ldap_verify {
    internal;
    proxy_pass http://ldap-gateway:8081/auth/verify;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
}

location /api/ {
    auth_request /_ldap_verify;
    auth_request_set $trusted_employee_no $upstream_http_x_trusted_employee_no;
    auth_request_set $trusted_name $upstream_http_x_trusted_name;
    auth_request_set $trusted_department $upstream_http_x_trusted_department;
    auth_request_set $trusted_issued_at $upstream_http_x_trusted_issued_at;
    auth_request_set $trusted_signature $upstream_http_x_trusted_identity_signature;

    proxy_set_header X-Employee-Id "";
    proxy_set_header X-Trusted-Employee-No $trusted_employee_no;
    proxy_set_header X-Trusted-Name $trusted_name;
    proxy_set_header X-Trusted-Department $trusted_department;
    proxy_set_header X-Trusted-Issued-At $trusted_issued_at;
    proxy_set_header X-Trusted-Identity-Signature $trusted_signature;
    proxy_pass http://platform-api:3000;
}

location = /auth/login {
    proxy_pass http://ldap-gateway:8081;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
}

location = /auth/logout {
    proxy_pass http://ldap-gateway:8081;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
}

# 品牌资源要允许未登录访问，否则浏览器加载登录页时会被
# auth_request 再次重定向。
location = /brand-logo.png {
    proxy_pass http://platform-web:5173/brand-logo.png;
    proxy_set_header Host $host;
}

location = /login-logo.png {
    proxy_pass http://ldap-gateway:8081/login-logo.png;
    proxy_set_header Host $host;
}

location / {
    auth_request /_ldap_verify;
    error_page 401 =302 /auth/login?returnTo=$request_uri;
    proxy_pass http://platform-web:5173;
}
```

实际网关若不是 Nginx，必须实现同样的“会话校验—重新生成签名头—转发”语义。不要把 `/auth/verify` 响应头直接暴露给浏览器作为登录凭据。

## 5. 平台配置和首次登录

Platform API：

```env
NODE_ENV=production
PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=<与网关一致>
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
VITE_API_BASE=/api/v1
```

用户登录成功后，平台第一次收到该工号的可信请求时会自动登记员工，并同步姓名和部门提示：

- 工号、姓名来自 LDAP，平台员工和管理员不能修改；
- 部门匹配组织树时自动归属，匹配不到时由全局管理员处理；
- 昵称和头像仍由员工在平台个人资料中维护；
- LDAP 部门字段不会自动赋予管理员权限。

## 6. 安全验收

- LDAP 只使用 LDAPS/StartTLS 或等价的内网加密通道；
- 登录失败只返回统一错误，不区分用户不存在、密码错误和 LDAP 细节；
- 工号搜索值经过 LDAP filter 转义；
- 密码、会话 Cookie、LDAP 断言和身份头不写入日志；
- 浏览器伪造 `X-Employee-Id` 或修改任意 `X-Trusted-*` 但不改签名时返回 401；
- 签名超过 `TRUSTED_GATEWAY_MAX_AGE_SECONDS` 时返回 401；
- Platform API 端口不能绕过网关直连；
- 网关会话过期后 `/auth/verify` 返回 401，并由前端跳转 `/auth/login`。

## 7. 相关文件

- `services/ldap3-gateway/ldap3_gateway.py`：LDAP3 绑定、属性解析、会话和网关验签头；
- `services/ldap3-gateway/requirements.txt`：网关运行依赖；
- `services/ldap3-gateway/test_ldap3_gateway.py`：不连接真实 LDAP 的回归测试；
- `docs/deployment/trusted-gateway-sso.md`：平台 HMAC 身份协议总说明。

--- END FILE: docs/deployment/ldap3-trusted-gateway.md ---


--- BEGIN FILE: docs/deployment/trusted-gateway-sso.md ---

# TRUSTED_GATEWAY 统一认证接入手册

本文给内网网络、统一认证和平台部署团队使用。平台不负责实现登录页；统一认证网关负责登录，平台 API 只接收网关验证后转发的签名身份。

## 1. 推荐部署拓扑

```text
浏览器
  |
  v
内网统一认证网关
  |-- 校验 SSO 会话
  |-- 读取工号、姓名、部门
  |-- 生成 HMAC 身份签名
  |-- /       -> Web 静态资源
  `-- /api/   -> Platform API
                  |
                  `-- PostgreSQL / 对象存储 / Evaluation Worker
```

Web 和 API 尽量使用同一个域名，例如：

```text
https://ai-platform.intra/
https://ai-platform.intra/api/v1
```

API 只允许统一认证网关访问，不要把 API 端口直接暴露给普通用户。现有平台代码已经实现 `TRUSTED_GATEWAY` 校验，接入侧主要是网关配置和生产环境变量。

## 2. 网关到 API 的身份协议

网关对每个转发到 API 的请求加入以下请求头：

| 请求头 | 内容 |
| --- | --- |
| `X-Trusted-Employee-No` | SSO 返回的固定工号 |
| `X-Trusted-Name` | SSO 返回的真实姓名 |
| `X-Trusted-Department` | SSO 返回的部门名称、部门 ID 或组织路径 |
| `X-Trusted-Issued-At` | UTC ISO-8601 时间，例如 `2026-08-05T03:00:00.000Z` |
| `X-Trusted-Identity-Signature` | HMAC-SHA256 签名，小写十六进制 |

签名原文必须严格按照下面格式拼接，字段之间是单个换行：

```text
employeeNo\nissuedAt\nname\ndepartment
```

签名算法：

```text
HMAC-SHA256(TRUSTED_GATEWAY_HMAC_SECRET, canonicalText)
```

姓名或部门为空时仍保留空字段和换行，不能省略字段。平台默认只接受 90 秒内的签名，可通过 `TRUSTED_GATEWAY_MAX_AGE_SECONDS` 调整。

## 3. 网关必须做的安全处理

1. 先完成 SSO 会话校验，再读取员工字段。
2. 删除浏览器原始请求里的 `X-Employee-Id`、`X-Trusted-*` 和其他同名身份头，防止用户伪造。
3. 只由网关重新生成并写入签名身份头。
4. 网关与 API 之间使用内网 ACL、TLS 或服务网格策略限制来源。
5. 共享密钥只存放在网关和 API 的密钥管理系统中，不写入前端、Git、日志或浏览器 Cookie。
6. 不要把姓名、工号、部门和签名写入普通访问日志；如必须审计，按公司隐私要求脱敏。

`X-Trusted-*` 不是给浏览器使用的登录协议。浏览器只携带网关的登录会话，身份头只存在于网关到 API 的内网请求段。

## 4. 平台 API 配置

生产 API 的环境变量至少包括：

```env
NODE_ENV=production
PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=替换为密钥管理系统注入的随机密钥
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90

# 生产存储，不要使用 file 适配器
PLATFORM_REPOSITORY=postgres
DATABASE_URL=postgresql://platform:***@postgres.internal:5432/ai_training_platform

# Web 与 API 同域时使用相对地址
# Web 构建阶段：VITE_API_BASE=/api/v1
CORS_ORIGINS=https://ai-platform.intra
```

不要在生产环境设置 `PLATFORM_IDENTITY_MODE=LOCAL`，也不要启用 `ALLOW_ANONYMOUS_LOCAL=true`。

## 5. 网关适配器伪代码

下面是语言无关的流程，不能把密钥硬编码到配置仓库：

```text
claims = sso.authenticate(request)
employeeNo = claims.employeeNo
name = claims.name
department = claims.department
issuedAt = utcNowIso()
canonical = employeeNo + "\\n" + issuedAt + "\\n" + name + "\\n" + department
signature = hmacSha256Hex(secretFromKeyStore, canonical)

removeRequestHeader("X-Employee-Id")
removeRequestHeaders("X-Trusted-*")
proxyRequest.headers["X-Trusted-Employee-No"] = employeeNo
proxyRequest.headers["X-Trusted-Name"] = name
proxyRequest.headers["X-Trusted-Department"] = department
proxyRequest.headers["X-Trusted-Issued-At"] = issuedAt
proxyRequest.headers["X-Trusted-Identity-Signature"] = signature
forward(proxyRequest)
```

如果现有网关不能执行 HMAC，可以在网关同一内网增加一个很小的身份适配器服务；适配器只负责“验证 SSO 会话 + 生成签名头”，不承载平台业务权限。

## 6. 身份同步和权限规则

平台第一次收到某工号的可信请求时，会按工号幂等登记员工，并同步 SSO 姓名和部门提示。

- 工号是平台身份主键，员工不能在平台修改。
- 姓名是统一认证主数据，员工不能在平台修改。
- 部门会尝试匹配平台组织树；匹配不到时保留 SSO 部门提示，由全局管理员处理。
- 昵称和头像是平台个人资料，可以由员工自行维护。
- 管理员角色、角色范围和部门管理员权限仍由平台管理，不建议直接由 SSO 部门字段授予管理员权限。

生产环境不要调用 `POST /api/v1/auth/sso` 来伪造登录身份；该接口只保留给本地适配器和测试，生产请求身份以 Guard 校验后的网关头为准。

## 7. 前端和反向代理配置

前端构建时使用同域 API：

```env
VITE_API_BASE=/api/v1
```

网关需要把 `/api/` 转发到 Platform API，把其他路径转发到 Web 静态服务，并正确传递：

- `GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS`；
- `Content-Type`、上传请求体和响应状态码；
- 平台返回的 `X-Request-Id`，方便问题追踪。

不要让浏览器跨域直连 API；同域部署可以减少 CORS、Cookie 和身份头泄露风险。

## 8. 上线前验收

### 认证正向用例

- 未登录访问平台会跳转统一认证。
- 登录后 `/api/v1/me` 返回对应工号的员工资料。
- 新工号首次访问自动建档，重复访问不会产生重复员工。
- SSO 姓名变化会同步；平台昵称不被覆盖。
- 部门能匹配组织树时自动归属，不能匹配时显示待管理员处理。

### 安全反向用例

- 浏览器直接伪造 `X-Employee-Id` 不能冒充其他员工。
- 修改任意 `X-Trusted-*` 字段但不改签名时返回 401。
- 签名超过有效时间返回 401。
- 直接访问 API（绕过网关）被网络策略拒绝。
- 网关和 API 日志中不出现密钥、Cookie、SSO Token 或完整身份断言。

### 管理权限用例

- 普通员工不能访问管理接口。
- 部门管理员只能访问授权组织范围。
- 全局管理员才能配置组织、角色和评测环境。
- SSO 部门字段变化不会自动扩大管理员权限范围。

## 9. 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 401 `trusted gateway identity is missing` | 网关是否向 API 转发了五个 `X-Trusted-*` 请求头 |
| 401 `trusted gateway identity is invalid` | 两端密钥、签名原文、换行、字段顺序和大小写 |
| 401 `trusted gateway identity is expired` | 网关服务器时钟、`X-Trusted-Issued-At` 和最大年龄 |
| 登录成功但员工不存在 | API 是否运行在 `TRUSTED_GATEWAY`，数据库是否可写，工号字段映射是否正确 |
| 员工显示未配置部门 | SSO 部门没有匹配平台组织树，需要全局管理员处理 |
| 页面能打开但 API 失败 | `VITE_API_BASE`、网关 `/api/` 路由和 API 来源 ACL |

## 10. 相关实现文件

- `services/platform-api/src/identity.ts`：模式配置、HMAC 验证和 OIDC 验证。
- `services/platform-api/src/identity-guard.ts`：请求级身份校验和 SSO 首次建档。
- `services/platform-api/src/user-directory.ts`：工号幂等同步、部门匹配和用户资料。
- `docs/deployment/ldap3-trusted-gateway.md`：使用内网 LDAP3 校验账号并接入本手册定义的网关协议。
- `docs/deployment/ldap3-nginx-intranet-deployment.md`：单服务器 Nginx + LDAP3 的逐步部署手册。
- `.env.example`：本地和生产身份环境变量示例。
- `docs/architecture/security-boundary.md`：平台整体安全边界。

--- END FILE: docs/deployment/trusted-gateway-sso.md ---


--- BEGIN FILE: docs/deployment/windows-production-smoke-test.md ---

# Windows 个人电脑生产模式验收手册

> 这是一套“生产模式本地验收”方案，不等于正式生产部署。它让 Windows 电脑上的 API 使用生产约束（PostgreSQL、S3 兼容对象存储、`TRUSTED_GATEWAY`），再通过 Nginx HTTPS 接入 LDAP3 网关。正式内网部署仍建议使用 Linux 服务器、独立 Worker、密钥管理和备份策略。

## 0. 完成后的访问链路

浏览器只打开一个地址：

~~~text
https://localhost/
        |
        +-- Nginx 443
             +-- /             -> apps/web/dist 静态文件
             +-- /auth/login   -> LDAP3 网关 127.0.0.1:8081
             +-- /api/         -> auth_request -> LDAP3 /auth/verify -> API 127.0.0.1:3000
             +-- /login-logo.png -> LDAP3 网关
             +-- /brand-logo.png  -> Web 静态文件
~~~

API 只监听 `127.0.0.1:3000`，LDAP3 网关只监听 `127.0.0.1:8081`，用户不能直接访问这两个端口。Nginx 从 LDAP3 网关取得签名身份头，再转发给 API；API 不接收 LDAP 密码。

## 1. 先确认是否具备真实 LDAP 条件

在 Windows 电脑上连接公司内网或 VPN，然后在 PowerShell 执行：

~~~powershell
Test-NetConnection china.huawei.com -Port 389
Test-NetConnection china.huawei.com -Port 636
~~~

如果 389/636 都失败，不能做真实 LDAP 登录，只能先做假 LDAP 单元测试或开发模式验收。不要为了绕过网络问题把 `PLATFORM_IDENTITY_MODE` 改回 `LOCAL` 后声称已经完成生产验收。

LDAP 使用 StartTLS 时，需要企业 LDAP CA 的 PEM 文件；使用 LDAPS 时，也需要 CA 文件（除非企业明确提供了可信系统证书链）。向内网管理员取得例如：

~~~text
C:\certs\company-ldap-ca.pem
~~~

## 2. 安装依赖

建议安装以下软件：

- Git for Windows；
- Node.js 20 或更高版本；
- pnpm 11.8.0；
- Python 3.11 或更高版本；
- Nginx for Windows；
- Docker Desktop（只用来运行 PostgreSQL 和 MinIO，最省事）；
- OpenSSL（Git for Windows 通常已带有 `usr\bin\openssl.exe`）。

检查版本：

~~~powershell
node --version
corepack --version
python --version
git --version
docker version
~~~

如果 Node.js 小于 20，或 Docker Desktop 没有运行，先停止，不要继续执行后面的启动命令。

## 3. 获取代码和安装依赖

下面假设代码目录为 `D:\ai-training-platform`，可以换成自己的目录，但后面的路径必须保持一致：

~~~powershell
git clone <内网 Git 地址> D:\ai-training-platform
Set-Location D:\ai-training-platform

corepack enable
corepack prepare pnpm@11.8.0 --activate
pnpm install --frozen-lockfile

py -3.11 -m venv services\ldap3-gateway\.venv
.\services\ldap3-gateway\.venv\Scripts\python.exe -m pip install --upgrade pip
.\services\ldap3-gateway\.venv\Scripts\pip.exe install -r services\ldap3-gateway\requirements.txt
~~~

## 4. 用 Docker Desktop 准备 PostgreSQL 和 MinIO

生产模式禁止使用 `tmp/platform-data.json` 和本地对象目录。个人电脑上最简单的等价替身是本机 Docker 容器：

~~~powershell
docker run -d --name ai-platform-postgres `
  -e POSTGRES_USER=platform `
  -e POSTGRES_PASSWORD=change-this-local-password `
  -e POSTGRES_DB=ai_training_platform `
  -p 127.0.0.1:5432:5432 `
  postgres:16

docker run -d --name ai-platform-minio `
  -e MINIO_ROOT_USER=platformminio `
  -e MINIO_ROOT_PASSWORD=change-this-minio-password `
  -p 127.0.0.1:9000:9000 `
  -p 127.0.0.1:9001:9001 `
  quay.io/minio/minio server /data --console-address ":9001"
~~~

打开 `http://127.0.0.1:9001`，使用上面的 MinIO 用户和密码登录，创建一个名为 `ai-training-platform` 的 bucket。不要勾选公开访问，平台使用 S3 API 访问。

检查容器：

~~~powershell
docker ps --filter "name=ai-platform-postgres"
docker ps --filter "name=ai-platform-minio"
~~~

这两个容器停止后，生产模式 API 会因为数据库或对象存储不可用而启动失败，这是预期行为。

## 5. 生成两条独立密钥

打开一个 PowerShell 窗口，执行：

~~~powershell
function New-RandomSecret {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToHexString($bytes).ToLowerInvariant()
}

$trustedGatewaySecret = New-RandomSecret
$ldapSessionSecret = New-RandomSecret
$trustedGatewaySecret
$ldapSessionSecret
~~~

把两条结果临时保存到密码管理器：

- `trustedGatewaySecret`：API 和 LDAP3 网关必须使用同一条；
- `ldapSessionSecret`：只给 LDAP3 网关使用，不能与第一条复用。

不要把真实密钥写进 Git、截图、聊天记录、前端代码或 Nginx 配置。下面示例中的 `REPLACE_ME` 必须替换成真实值。

## 6. 启动 API 的生产环境变量

为 API 单独打开 PowerShell 窗口，在仓库根目录执行。变量只对这个窗口及其子进程生效，不会写入系统环境变量：

~~~powershell
Set-Location D:\ai-training-platform

$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '3000'

$env:PLATFORM_IDENTITY_MODE = 'TRUSTED_GATEWAY'
$env:TRUSTED_GATEWAY_HMAC_SECRET = 'REPLACE_WITH_trustedGatewaySecret'
$env:TRUSTED_GATEWAY_MAX_AGE_SECONDS = '90'

$env:PLATFORM_REPOSITORY = 'postgres'
$env:DATABASE_URL = 'postgresql://platform:change-this-local-password@127.0.0.1:5432/ai_training_platform'

$env:OBJECT_STORAGE_MODE = 's3'
$env:OBJECT_STORAGE_BUCKET = 'ai-training-platform'
$env:OBJECT_STORAGE_REGION = 'us-east-1'
$env:OBJECT_STORAGE_ENDPOINT = 'http://127.0.0.1:9000'
$env:OBJECT_STORAGE_ACCESS_KEY_ID = 'platformminio'
$env:OBJECT_STORAGE_SECRET_ACCESS_KEY = 'change-this-minio-password'
$env:OBJECT_STORAGE_FORCE_PATH_STYLE = 'true'
$env:OBJECT_STORAGE_PREFIX = 'platform'

$env:PROJECT_ROOT = 'D:\ai-training-platform'
$env:ARTIFACT_ROOT = 'D:\ai-training-platform\tmp\artifacts'
$env:ENGINE_PACKAGE_ROOT = 'D:\ai-training-platform\tmp\engine-packages'
$env:LOCAL_WORKSPACE_ROOT = 'D:\ai-training-platform'
$env:EMBEDDED_EVALUATION_WORKER = 'false'
$env:CORS_ORIGINS = 'https://localhost'
~~~

注意：不要设置 `PLATFORM_DATA_FILE`、`PLATFORM_REPOSITORY=file`、`OBJECT_STORAGE_MODE=local`、`PLATFORM_IDENTITY_MODE=LOCAL` 或 `ALLOW_ANONYMOUS_LOCAL=true`。

## 7. 执行 PostgreSQL 迁移并构建生产前端

仍在 API PowerShell 窗口执行：

~~~powershell
pnpm --filter @ai-training/platform-api prisma:migrate:deploy

$env:VITE_API_BASE = '/api/v1'
$env:VITE_AUTH_LOGIN_PATH = '/auth/login'
pnpm build
~~~

构建完成后检查：

~~~powershell
Test-Path .\apps\web\dist\index.html
Test-Path .\apps\web\dist\brand-logo.png
Test-Path .\services\platform-api\dist\main.js
~~~

三个结果都必须是 `True`。生产构建默认不会显示右上角的本地多用户切换器。

## 8. 启动 LDAP3 网关

在第二个 PowerShell 窗口执行。把 `trustedGatewaySecret` 填成第 5 节的第一条密钥：

~~~powershell
Set-Location D:\ai-training-platform

$env:LDAP_GATEWAY_HOST = '127.0.0.1'
$env:LDAP_GATEWAY_PORT = '8081'
$env:LDAP_SERVER = 'china.huawei.com'
$env:LDAP_PORT = '389'
$env:LDAP_USE_SSL = 'false'
$env:LDAP_START_TLS = 'true'
$env:LDAP_CA_CERT_FILE = 'C:\certs\company-ldap-ca.pem'
$env:LDAP_BASE_DN = 'dc=china,dc=huawei,dc=com'
$env:LDAP_BIND_PREFIX = 'China\'
$env:LDAP_ACCOUNT_ATTRIBUTE = 'sAMAccountName'
$env:LDAP_TITLE_ATTRIBUTE = 'title'
$env:LDAP_DEPARTMENT_ATTRIBUTE = 'department'
$env:LDAP_NAME_ATTRIBUTE = 'displayName'
$env:LDAP_TIMEOUT_SECONDS = '5'

$env:LDAP_GATEWAY_SESSION_SECRET = 'REPLACE_WITH_ldapSessionSecret'
$env:TRUSTED_GATEWAY_HMAC_SECRET = 'REPLACE_WITH_trustedGatewaySecret'
$env:LDAP_GATEWAY_SESSION_TTL_SECONDS = '28800'
$env:TRUSTED_GATEWAY_MAX_AGE_SECONDS = '90'
$env:LDAP_GATEWAY_COOKIE_SECURE = 'true'

.\services\ldap3-gateway\.venv\Scripts\python.exe .\services\ldap3-gateway\ldap3_gateway.py
~~~

如果企业目录只开放 LDAPS，改为：

~~~powershell
$env:LDAP_PORT = '636'
$env:LDAP_USE_SSL = 'true'
$env:LDAP_START_TLS = 'false'
~~~

`LDAP_USE_SSL` 和 `LDAP_START_TLS` 不能同时为 `true`。登录网关启动后会监听 `127.0.0.1:8081`；`/healthz` 成功只表示进程存活，不表示 LDAP 登录已经验证成功。

## 9. 启动生产 API

回到第 6 节的 API PowerShell 窗口执行：

~~~powershell
pnpm --filter @ai-training/platform-api start
~~~

保持这个窗口打开。另开窗口检查：

~~~powershell
Invoke-WebRequest http://127.0.0.1:3000/api/v1/health | Select-Object -ExpandProperty Content
Invoke-WebRequest http://127.0.0.1:8081/healthz | Select-Object -ExpandProperty Content
~~~

两个服务都应返回 JSON。不要把 3000 或 8081 端口直接发给同事访问；必须经过 Nginx。

## 10. 安装并配置 Windows Nginx

1. 从 Nginx 官方 Windows 压缩包解压到 `C:\nginx`；
2. 创建 `C:\nginx\conf\tls`；
3. 使用 OpenSSL 生成本机 HTTPS 证书：

~~~powershell
New-Item -ItemType Directory -Force C:\nginx\conf\tls | Out-Null
& 'C:\Program Files\Git\usr\bin\openssl.exe' req -x509 -nodes -newkey rsa:2048 `
  -keyout C:/nginx/conf/tls/localhost.key `
  -out C:/nginx/conf/tls/localhost.crt `
  -days 365 -subj '/CN=localhost'
~~~

如果 OpenSSL 不在该路径，使用 `Get-Command openssl` 找到实际路径。个人电脑测试可以接受浏览器的自签名证书提示；如果希望不再提示，可把 `localhost.crt` 导入当前用户的“受信任的根证书颁发机构”。

把 `C:\nginx\conf\nginx.conf` 替换为下面的内容：

~~~nginx
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    client_max_body_size 75m;

    server {
        listen 80;
        server_name localhost;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name localhost;

        ssl_certificate     C:/nginx/conf/tls/localhost.crt;
        ssl_certificate_key C:/nginx/conf/tls/localhost.key;

        # 只允许 Nginx 内部 auth_request 调用。
        location = /_ldap_verify {
            internal;
            proxy_pass http://127.0.0.1:8081/auth/verify;
            proxy_pass_request_body off;
            proxy_set_header Content-Length '';
            proxy_set_header Host $host;
            proxy_set_header Cookie $http_cookie;
        }

        # 登录、退出和登录页图标不需要先登录。
        location = /auth/login {
            proxy_pass http://127.0.0.1:8081;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Cookie $http_cookie;
        }

        location = /auth/logout {
            proxy_pass http://127.0.0.1:8081;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Cookie $http_cookie;
        }

        location = /login-logo.png {
            proxy_pass http://127.0.0.1:8081;
            proxy_set_header Host $host;
        }

        location = /brand-logo.png {
            root D:/ai-training-platform/apps/web/dist;
        }

        # API 请求必须先校验 LDAP3 会话，再写入网关签名身份头。
        location /api/ {
            auth_request /_ldap_verify;
            auth_request_set $trusted_employee_no $upstream_http_x_trusted_employee_no;
            auth_request_set $trusted_name $upstream_http_x_trusted_name;
            auth_request_set $trusted_department $upstream_http_x_trusted_department;
            auth_request_set $trusted_issued_at $upstream_http_x_trusted_issued_at;
            auth_request_set $trusted_signature $upstream_http_x_trusted_identity_signature;

            proxy_set_header X-Employee-Id '';
            proxy_set_header X-Trusted-Employee-No $trusted_employee_no;
            proxy_set_header X-Trusted-Name $trusted_name;
            proxy_set_header X-Trusted-Department $trusted_department;
            proxy_set_header X-Trusted-Issued-At $trusted_issued_at;
            proxy_set_header X-Trusted-Identity-Signature $trusted_signature;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_pass http://127.0.0.1:3000;
            proxy_read_timeout 300s;
        }

        # 未登录访问主站时跳转到 LDAP3 登录页。
        location / {
            auth_request /_ldap_verify;
            error_page 401 =302 /auth/login?returnTo=$request_uri;
            root D:/ai-training-platform/apps/web/dist;
            try_files $uri $uri/ /index.html;
        }
    }
}
~~~

检查并启动 Nginx：

~~~powershell
Set-Location C:\nginx
.\nginx.exe -t -p C:/nginx/ -c conf/nginx.conf
Start-Process .\nginx.exe
~~~

后续修改配置使用：

~~~powershell
.\nginx.exe -t -p C:/nginx/ -c conf/nginx.conf
.\nginx.exe -s reload
~~~

## 11. 按顺序做真实端到端验收

### 11.1 未登录跳转

~~~powershell
curl.exe -k -I https://localhost/
~~~

应返回 `302`，并跳转到 `/auth/login?returnTo=/`。如果直接显示前端页面，说明 Nginx 的 `auth_request` 没有生效。

### 11.2 LDAP3 登录

1. 浏览器打开 `https://localhost/`；
2. 接受本机自签名证书提示；
3. 页面应显示“登录”、工号、密码和“LDAP3域账号统一认证”；
4. 输入真实 LDAP3 域账号和密码；
5. 登录成功后回到首页；
6. 打开个人中心，检查工号、姓名、部门是否来自 LDAP；
7. 打开管理后台，确认权限来自平台数据库中的角色，而不是浏览器自带身份头。

### 11.3 API 和上传验收

浏览器登录后，至少验证：

- 查看训战、赛题和个人中心；
- 创建或编辑一个仅用于测试的赛题；
- 在开放时间窗口内提交一个小 ZIP；
- 查看对象存储 bucket 中出现对象；
- 查看 PostgreSQL 中出现提交、上传会话和审计记录；
- 退出登录后重新打开 `/api/v1/me`，应回到登录页而不是继续返回用户数据。

### 11.4 评测验收边界

生产模式 API 不允许在 API 进程中启动 Code Agent，也不允许使用右上角本地多身份切换。真实评测还需要单独启动 Evaluation Worker，并配置受控的 Code Agent 可执行文件；个人 Windows 只建议先验证登录、训战、提交、对象存储和权限链路。

## 12. 常见故障

| 现象 | 检查 |
| --- | --- |
| API 启动报 `file repository is not allowed in production` | `PLATFORM_REPOSITORY=postgres`、`DATABASE_URL` 是否在同一 PowerShell 窗口设置 |
| API 启动报 `local object storage is not allowed in production` | `OBJECT_STORAGE_MODE=s3`、bucket、MinIO 地址和密钥是否正确 |
| 首页不跳登录 | `nginx -t`、`location /` 是否包含 `auth_request` 和 401 跳转 |
| 登录页能打开但登录失败 | `Test-NetConnection`、LDAP CA、389/636、StartTLS/LDAPS 配置和 LDAP 属性映射 |
| 登录成功但 API 返回 401 | API 与网关的 HMAC 必须完全相同；检查系统时间和 Nginx 的五个 `X-Trusted-*` 头 |
| 登录后反复跳转登录页 | 必须使用 `https://localhost`，并保持 `LDAP_GATEWAY_COOKIE_SECURE=true`；不要用 `http://localhost` |
| Nginx 502 | API/LDAP3 网关进程是否仍在运行，3000/8081 是否只监听本机 |
| 页面有前端但 API 请求到了用户电脑的 127.0.0.1 | 构建时必须设置 `$env:VITE_API_BASE='/api/v1'`，不能使用默认开发地址 |

查看进程日志：

~~~powershell
Get-Process node,python,nginx -ErrorAction SilentlyContinue
Get-Content C:\nginx\logs\error.log -Wait
~~~

不要把 LDAP 密码、Cookie、HMAC、完整请求头或员工敏感信息贴到日志和聊天窗口。

## 13. 停止和清理

停止 Nginx：

~~~powershell
Set-Location C:\nginx
.\nginx.exe -s quit
~~~

API 和 LDAP3 网关在各自 PowerShell 窗口按 `Ctrl+C` 停止。停止测试依赖容器：

~~~powershell
docker stop ai-platform-postgres ai-platform-minio
~~~

如果要彻底清空本次测试数据，确认不再需要后再删除容器和对应 volume；这会不可恢复地删除本地 PostgreSQL/MinIO 数据。

## 14. 给弱模型 AI 的执行顺序

弱模型只需要按以下顺序执行，不要自行替换组件：

1. 确认 Windows 已连接内网/VPN，LDAP 端口可达；
2. 安装 Node、pnpm、Python、Docker Desktop、Nginx、OpenSSL；
3. clone 仓库并安装依赖；
4. 启动 PostgreSQL 和 MinIO，创建私有 bucket；
5. 生成两条独立密钥；
6. 设置 API 生产环境变量并执行迁移；
7. 设置 LDAP3 网关环境变量并启动网关；
8. 构建 Web/API；
9. 启动 API；
10. 配置 HTTPS Nginx，执行 `nginx -t` 后启动；
11. 按“未登录跳转 → LDAP 登录 → `/api/v1/me` → 提交 → 对象存储 → 退出登录”验收；
12. 失败时只按第 12 节排查，不要改成 `LOCAL`、匿名身份或绕过 Nginx。

--- END FILE: docs/deployment/windows-production-smoke-test.md ---


--- BEGIN FILE: docs/evaluation-contract-authoring.md ---

# 评测输入/输出约束开发说明

管理员开发赛题时，不需要手写 `contractPath`。管理端把它称为“输入约束/输出约束”，选项来自 Git 中的 `contracts/evaluation-contract-catalog.json`，只展示其中 `visibility=PUBLIC` 且与评测方式匹配的条目。代码和 API 仍保留 `contractPath`、`kind` 等契约字段名，方便版本化和兼容已有配置。

## 选择规则

- `EXTERNAL_CLI` 选择“外部评测批次输入约束 v1.0”，评测程序读取 `contracts/examples/evaluation-input.external.valid.json`，完成后返回平台统一结果。
- `PLATFORM_LOCAL` 或 `PACKAGED` 选择“Code Agent 批次输入约束 v1.1”，Code Agent 先读批次清单、题目指令和 Skills，再逐份处理 `submissions`。
- 三种评测方式都选择“平台统一评测输出约束 v1.0”。输出不能自定义外层结构；评分点、证据和扩展指标放在该约束允许的字段中。
- `engine-invocation.schema.json` 只给打包引擎进程使用，包含沙箱内路径，管理员不应把它当作平台批次输入。

## 管理端查看详情和复制给 AI

输入或输出约束下拉框旁的“查看详情”会打开只读详情面板，内容来自 Git 固定的约束目录，包括：

- 约束类型、版本、适用评测方式和 Schema 路径；
- 已由服务端按 Schema 校验过的 JSON Schema 与示例；
- 本文件等编写说明。

点击“复制给 AI 出题”会把一段完整的中文提示复制到剪贴板。提示包含选中的约束、Schema、示例和编写说明，并要求 AI 只能使用目录中已发布的路径、版本、字段和枚举值。复制的内容可以直接粘贴到 AI 对话中，再补充赛题目标、学员交付物和评分偏好；管理员仍需审核 AI 草稿，最终保存时由服务端白名单和 Schema 再次校验。

## 给 AI 的配置提示

让 AI 先读取：

1. `contracts/evaluation-contract-catalog.json`；
2. 目录中所选契约的 `path` 对应 Schema；
3. 对应 `examplePath` 示例；
4. 本文件和 `docs/evaluation-engine-protocol.md`。

然后要求 AI：

- 只使用目录中存在的约束版本、字段名和枚举值，不创建新的 `contractPath`；
- 根据赛题的评测方式生成 `evaluationEngine` 配置，输入/输出约束必须与下拉选择一致；
- 为每个评分点提供 `criteria.key`、维度、上限、规则和可审计证据；
- 不把员工真实身份、令牌、仓库凭据、绝对路径或学员源码写入示例；
- 先输出配置草稿和需要管理员确认的参数，再生成题面、指令、Skills 和评测器文件。

## 推荐配置形状

```json
{
  "evaluationEngine": {
    "id": "parking-fee-evaluator",
    "version": "1.0.0",
    "mode": "PLATFORM_LOCAL",
    "input": {
      "format": "JSON",
      "schemaVersion": "1.1",
      "contractPath": "contracts/evaluation-agent-batch-v1.1.schema.json"
    },
    "output": {
      "format": "JSON",
      "schemaVersion": "1.0",
      "contractPath": "contracts/evaluation-result.schema.json"
    }
  }
}
```

约束版本、Schema、rubric 和已发布赛题版本不可原地修改；需要改变外层协议时，应新增 Git 中的 Schema、示例和目录条目并升版本。

--- END FILE: docs/evaluation-contract-authoring.md ---


--- BEGIN FILE: docs/evaluation-engine-protocol.md ---

# Code Agent 批次评测协议

每个赛题版本独立绑定评测引擎、评测指令和 skills。训战只决定开放时间、参训范围、提交方式、触发方式和结果公布策略，不携带评分逻辑。

平台负责：锁定交付快照、冻结精确选择范围、分配租约、校验回传结果、重算总分、覆盖员工身份并写入报告。评测主机负责：物化文件、调用 Code Agent、逐份运行评测引擎并回传结果。API 请求进程不执行学员代码或评测引擎。

## 评测方式

| 引擎模式 | 引擎来源 | 可用触发方式 | 赛题版本必填配置 |
|---|---|---|---|
| `PLATFORM_LOCAL` | 仓库 `executors/<id>/` | 自动评测、管理员发起评测 | `executor`、`agent` |
| `PACKAGED` | 出题人上传的不可变 ZIP | 自动评测、管理员发起评测 | `package`、`agent` |
| `EXTERNAL_CLI` | 管理员在线下自行运行 | 线下结果录入 | 输入、输出约束 |

GitLab CI 自动评测不在当前实现范围内。后续适配器复用同一批次、快照和结果契约，不改变赛题配置模型。

## 契约如何配置

赛题编辑页不再要求管理员手工填写一组含义相近的“输入路径”和“输出路径”。管理端把它们显示为“输入约束”和“输出约束”，平台把契约分成三层：

| 契约 | 配置位置 | 作用 | 在线评测路径 |
|---|---|---|---|
| 交付目录规范 | 赛题版本 → 交付目录规范 | 约束学员 ZIP / Git 快照必须有哪些文件和目录 | 随赛题版本保存，不是 Code Agent 的输入 Schema |
| Code Agent 批次输入 | 平台固定 | 描述批次、引擎、指令、Skills、所选提交和各自输出位置 | `contracts/evaluation-agent-batch-v1.1.schema.json` |
| 平台评测结果 | 平台固定 | 约束每名学员回传的总分、维度、评分点和证据链 | `contracts/evaluation-result.schema.json` |

不同赛题的评分项、证据和客观指标可以不同，但都放在统一的评测结果外层结构中。需要改变评分逻辑时，修改赛题版本绑定的评测引擎、指令、Skills 和评分标准，不新增一份平台无法识别的结果格式。

上述两个平台协议路径是仓库内的版本标识，在赛题页只读展示。Worker 领取批次后会把实际 Schema 复制到：

```text
<batch>/contracts/batch-input.schema.json
<batch>/contracts/evaluation-result.schema.json
```

并在 `batch-manifest.json` 的 `contracts.input` / `contracts.output` 中写入源路径、批次内绝对路径和 SHA-256。Code Agent 应读取清单中的物化路径，不应自行推测平台仓库位置。

`instruction.md` 和 Skills 路径使用评测引擎根目录作为基准：内置执行器对应 `executors/<executorId>/`，引擎包对应上传 ZIP 的根目录。每个 Skills 目录必须包含 `SKILL.md`。线下结果录入继续使用 `contracts/evaluation-input.schema.json` 生成清单，输出仍使用统一结果契约。

赛题版本编辑器不接受管理员手填契约路径，而是读取 Git 中的 `contracts/evaluation-contract-catalog.json` 生成输入/输出约束下拉选项。点击“查看详情”可检查固定 Schema、示例和编写说明；点击“复制给 AI 出题”可把这些内容连同约束规则复制到剪贴板。公开选项只包含与当前评测方式匹配的约束；`engine-invocation.schema.json` 等 Worker 内部调用约束仍由平台物化和校验，不作为赛题公开配置。开发赛题时可先阅读目录中的 Schema、`examplePath` 示例和 `docs/evaluation-contract-authoring.md`，再让 AI 生成配置草稿，最终仍由服务端白名单和 Schema 校验决定是否可保存。

## 平台发起评测

1. 管理员进入「评测中心」，打开某个训战的赛题评测页。
2. 管理员勾选一名或多名学员的待处理提交。
3. `POST /api/v1/events/{eventId}/start-grading` 只接收所选 `submissionIds`。
4. 平台为每份提交创建不可变 `GradingRun`，再将这些运行冻结成一个 `EvaluationBatch`。
5. 一个批次只允许包含同一训战、同一赛题版本和同一评测引擎的提交；未勾选的提交不会被扩入批次。
6. 自动评测也走相同流程，只是每次提交后由平台自动创建批次。

批次状态为 `QUEUED → RUNNING → COMPLETED | PARTIAL | FAILED`。运行状态为 `QUEUED → RUNNING → GRADED | FAILED`。租约超时后，尚未完成的整个批次一起回到队列，不能被单份任务接口拆开。

## Worker 拉取与物化

评测主机运行 `scripts/evaluation-worker.mjs`，通过以下接口工作：

```text
POST /api/v1/evaluation-batches:lease
POST /api/v1/evaluation-batches/{batchId}/heartbeat
POST /api/v1/evaluation-batches/{batchId}/complete
POST /api/v1/evaluation-batches/{batchId}/fail
```

Worker 对每个批次创建独立目录，并验证所有不可变内容的 SHA-256：

```text
<batch>/
├─ batch-manifest.json
├─ contracts/
│  ├─ batch-input.schema.json
│  └─ evaluation-result.schema.json
├─ engine/
│  ├─ engine.json
│  ├─ instruction.md
│  ├─ skills/<skill>/SKILL.md
│  ├─ <judge entrypoint>
│  └─ _platform/                 # 内置引擎声明的冻结运行依赖
├─ challenge-assets/             # 内置通用引擎的本题契约、隐藏测试等
├─ submissions/
│  └─ <submissionId>/
│     ├─ delivery.zip            # 上传型提交保留原始归档
│     ├─ workspace/              # 解包后的不可变交付快照
│     └─ scratch/                # 单份提交独立可写目录
└─ results/
   ├─ <runId>.json
   └─ index.json
```

上传交付件会同时校验归档字节哈希和规范化目录树哈希。内置引擎的仓库依赖也参与引擎内容哈希，并随引擎复制到批次目录；依赖变化会导致哈希变化，避免评测主机使用未冻结代码。

## Code Agent 启动配置

全局管理员在「管理后台 → 评测环境」配置 Code Agent；部门管理员无权查看或修改。可直接使用一条带引号参数的单行命令，例如：

```text
opencode -m deepseek/deepseek-v4-pro --prompt "请根据约束使用skills和cli评测submission并返回结果"
```

Worker 会解析为可执行文件和参数，并以 `spawn(..., { shell: false })` 启动。上述写法可以直接使用：Worker 会在原 `--prompt` 内容后追加不可省略的批次清单、指令、Skills、提交范围、结果路径和结果契约要求。更推荐把可变任务指令放在单独的「任务指令」字段，并使用占位符：

```text
opencode -m deepseek/deepseek-v4-pro --prompt "{{prompt}}"
```

可用占位符只有：

| 占位符 | Worker 替换内容 |
|---|---|
| `{{prompt}}` | 管理员任务指令 + 平台强制评测协议 |
| `{{manifestPath}}` | `batch-manifest.json` 的绝对路径 |
| `{{batchDir}}` | 本批次工作目录的绝对路径 |

如果命令没有 Prompt 参数和占位符，Worker 将它视为 bridge，并追加 `--manifest <absolute-path>`。无论哪种方式，Worker 都会设置 `AI_TRAINING_BATCH_MANIFEST`。

平台运行配置包含启用状态、启动命令、任务指令和批次超时，并记录修改人、修改时间与配置校验值。创建评测批次时会冻结当时启用的配置；之后修改只影响新批次，不会改变已经排队或运行中的批次。命令来源优先级为：

```text
Worker --agent-command 显式覆盖
  > 批次冻结的平台配置
  > Worker 主机 CODE_AGENT_COMMAND / CODE_AGENT_ARGS_JSON 兜底
```

批次超时的覆盖顺序为 `--agent-timeout-seconds`、`CODE_AGENT_BATCH_TIMEOUT_SECONDS`、批次冻结值、引擎时限自动计算值。

命令不会经过系统 Shell，因此管道、重定向、命令拼接和环境变量赋值不会被解释。模型令牌等凭据只能由 Worker 运行环境注入。生产主机可设置 `CODE_AGENT_ALLOWED_EXECUTABLES=opencode,...`，限制平台配置允许启动的程序。

## 管理端配置诊断与连通性测试

全局管理员可以在“管理后台 → 评测环境”查看三组信息：

- **默认配置**：平台内置为关闭平台配置、OpenCode 默认启动命令 `opencode --prompt "{{prompt}}"`、默认任务指令“请读取批次清单、instruction.md 和 Skills，逐份评测 submissions，并将符合结果契约的结果写入 manifest.resultIndexPath。”和 3600 秒超时；“恢复 OpenCode 默认”只会把表单恢复为这组值，点击保存后才会写入平台。默认模板不会自动启用，需先确认 Worker 已安装并允许启动 `opencode`。
- **平台配置**：启用后由 API 在创建评测批次时解析并冻结 `executable` 与 `args`；页面显示当前可执行文件、配置校验值和允许列表。
- **Worker 本地配置**：读取 API 进程可见的 `CODE_AGENT_COMMAND`、`CODE_AGENT_ARGS_JSON`、`EMBEDDED_EVALUATION_WORKER` 和 `EVALUATION_WORKER_ID`。Worker 启动参数 `--agent-command` 只存在于 Worker 进程，API 无法读取，因此诊断会明确标注为“命令行覆盖（API 不可见）”，不能把它误认为未配置。

当 Worker 与 API 部署在不同主机或容器时，API 只能展示它实际收到的进程级诊断；Worker 主机上的环境变量和命令行不会自动同步到管理页。此时应在 Worker 主机按“本地联调”示例配置，并以 Worker 启动输出和批次租约状态为准。

页面的“测试启动命令”使用管理员当前表单内容创建合成清单，并只在非生产环境且显式设置 `CODE_AGENT_RUNTIME_TEST_ENABLED=true` 时以 `shell: false` 启动一次。测试不会带入学员交付件，也不会创建评测批次；输出仅保留截断后的标准输出/错误并遮蔽常见凭据字段。未打开安全开关时接口仍返回 `BLOCKED` 及原因，便于区分“配置错误”和“执行权限未开放”。

## Worker 日志与 Agent 交互记录

Worker 默认将运行日志写入项目下的 `tmp/evaluation-logs/<workerId>/`，也可以通过 `EVALUATION_LOG_ROOT` 或 `--log-root` 指定独立目录。日志目录不会随评测批次清理，便于追查领取、续租、Agent 启动、退出和批次完成状态：

```text
tmp/evaluation-logs/
└─ <workerId>/
   ├─ worker.log                         # Worker 生命周期和批次状态（JSON Lines）
   └─ batches/<batchId>/<leaseId>/
      ├─ interaction.jsonl               # Agent 启动参数（脱敏）、阶段事件、输出预览、退出信息
      ├─ agent.stdout.log                 # Agent 标准输出（脱敏、默认最多 4 MiB）
      └─ agent.stderr.log                 # Agent 标准错误（脱敏、默认最多 4 MiB）
```

`EVALUATION_AGENT_OUTPUT_MAX_BYTES` 可调整单个 stdout/stderr 文件上限（16 KiB–64 MiB），`EVALUATION_WORKER_LOG_MAX_BYTES` 控制 `worker.log` 上限（256 KiB–256 MiB，默认 16 MiB，达到上限后滚动保留最新记录）。日志会遮蔽常见 token、密钥、密码、Cookie 和 Authorization 字段，并在超过上限时写入截断标记；不要把学员源码或长期凭据主动写进任务指令。日志仅落在 Worker 主机，不会通过 API 返回给浏览器。

## Code Agent 批次职责

Worker 不直接判断得分。Code Agent 或 bridge 必须：

1. 读取 `manifest.agent.instructionPath`；
2. 加载 `manifest.agent.skillPaths` 中每个目录的 `SKILL.md`；
3. 只处理 `manifest.submissions` 列出的提交；
4. 为每份提交使用独立 `workspace`、`scratchDir` 和 `outputPath`；
5. 逐份运行该赛题冻结的评测引擎；
6. 将批次结果索引写入 `manifest.resultIndexPath`。

批次清单和结果索引分别符合：

- `contracts/evaluation-agent-batch-v1.1.schema.json`
- `contracts/evaluation-agent-result-index.schema.json`

结果索引示例：

```json
{
  "schemaVersion": "1.0",
  "batchId": "batch-...",
  "results": [
    { "runId": "run-...", "resultPath": "results/run-....json" }
  ],
  "failures": [
    { "runId": "run-...", "reason": "交付件无法完成验收测试" }
  ]
}
```

平台逐份校验 `evaluation-result.schema.json`，重新计算 `criteria → dimensions → total`，并以提交记录中的员工和部门快照覆盖结果身份。缺失结果、重复 `runId`、批次外 `runId`、快照不匹配和分数不一致都会被拒绝或标记失败。

完成回调以批次租约为凭据；同一租约重复提交会返回已冻结结果，不会重复写入。重新评测会创建新的运行和新的幂等键，历史结果保留。

## 赛题版本配置

```json
{
  "id": "parking-fee-evaluator",
  "version": "1.0.0",
  "mode": "PLATFORM_LOCAL",
  "executor": {
    "id": "drill-grader",
    "params": {
      "contractPath": "challenges/parking-fee-v1/submission-contract.json",
      "testsDir": "challenges/parking-fee-v1/hidden-tests",
      "entry": "src/parking.py",
      "function": "calculate_fee",
      "language": "python",
      "zone": "yellow"
    }
  },
  "agent": {
    "instructionPath": "instruction.md",
    "skillPaths": ["skills/evaluation"]
  },
  "input": {
    "format": "JSON",
    "schemaVersion": "1.1",
    "contractPath": "contracts/evaluation-agent-batch-v1.1.schema.json"
  },
  "output": {
    "format": "JSON",
    "schemaVersion": "1.0",
    "contractPath": "contracts/evaluation-result.schema.json"
  }
}
```

保存赛题版本时，平台立即校验执行器、参数、引擎包、`instruction.md` 和全部 skills 是否存在。在线评测的输入、输出路径由平台规范化为上面的固定协议；已发布版本不可原地修改，评分逻辑变化必须创建新版本并提升引擎版本。

## 引擎包结构

上传引擎包必须自包含，不能引用平台仓库目录。推荐使用 1.1 清单：

```text
engine.json
instruction.md
skills/evaluation/SKILL.md
judge.py
requirements.txt                 # 可选
assets/submission-contract.json
assets/hidden-tests/
assets/reference/                # 可选，自检用
```

`engine.json` 见 `contracts/evaluation-engine-package.schema.json`。1.1 清单必须声明 `agent.instruction` 与 `agent.skills`；管理员也可以在赛题版本中覆盖这些相对路径。

## 线下结果录入

`EXTERNAL_CLI` 仍保留管理员线下评测流程：使用 `POST /api/v1/events/{eventId}/grading-input` 为精确选择的提交生成输入清单，评测后通过 `POST /api/v1/grading-results:import-batch` 批量录入。线下结果与线上批次结果经过同一份 Schema、快照、身份和总分校验。

## 本地联调

`scripts/code-agent-local-bridge.mjs` 是本地协议适配器，只用于验证端到端 ABI。它读取 instruction 和 skills，再逐份调用确定性评测引擎。本地可以在全局管理员的「评测环境」中配置启动命令；以下环境变量方式保留为 Worker 主机兜底。

```powershell
$env:EMBEDDED_EVALUATION_WORKER='false'
$env:CODE_AGENT_COMMAND=(Get-Command node).Source
$bridge=(Resolve-Path .\scripts\code-agent-local-bridge.mjs).Path
$env:CODE_AGENT_ARGS_JSON=(ConvertTo-Json @($bridge) -Compress)
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker local-eval-host
```

加 `--once` 只领取一轮。加 `--keep-batches` 保留物化目录以便排查；正式环境不应默认保留学员交付件。

--- END FILE: docs/evaluation-engine-protocol.md ---


--- BEGIN FILE: docs/submission-contract.md ---

# 赛题交付目录规范

每个赛题版本可以冻结一份 `submissionContractDefinition`。员工上传 ZIP 或平台固定 Git 版本时，会先校验目录结构；未通过的交付不会创建提交记录，也不会进入评测队列。

管理后台「赛题库 → 赛题版本 → 交付目录规范」提供源码项目和 Skills 交付模板，也可逐条配置必需文件、目录、扩展名、数量、禁止路径、额外文件策略和压缩包根目录。

## 1.1 字段

| 字段 | 作用 |
|---|---|
| `root.mode` | `ARCHIVE_ROOT`：文件直接位于 ZIP 根目录；`SINGLE_DIRECTORY`：只允许一个顶层目录 |
| `root.directoryName` | `SINGLE_DIRECTORY` 模式下约束顶层目录名称 |
| `required` | 必需文件、目录或 glob 匹配规则 |
| `optional` | 可选文件、目录或 glob 匹配规则 |
| `forbidden` | 禁止出现的路径规则 |
| `allowedPaths` | `allowAdditionalPaths=false` 时的路径白名单 |
| `allowAdditionalPaths` | 是否允许规则之外的文件 |
| `maxFiles` | 最大文件数 |
| `maxDepth` | 最大目录层级 |
| `languageEntry` | 不同语言必须存在的入口文件 |

规则类型支持 `directory`、`markdown`、`source`、`text`、`json` 和 `yaml`。`minFiles` 可约束目录内文件数或 glob 的最少匹配数；`allowedExtensions` 会校验匹配文件以及目录内的所有后代文件。

路径使用 `/`，支持 `*`、`**` 和 `?`，禁止绝对路径、盘符、反斜杠和 `..`。

## Skills 交付示例

```json
{
  "schemaVersion": "1.1",
  "root": { "mode": "ARCHIVE_ROOT" },
  "required": [
    { "path": "skills", "type": "directory", "minFiles": 1 },
    { "path": "skills/*/SKILL.md", "type": "markdown" }
  ],
  "optional": [
    { "path": "README.md", "type": "markdown" },
    { "path": "skills/**", "type": "text" }
  ],
  "forbidden": [
    "**/.env",
    "**/.git/**",
    "**/__pycache__/**",
    "**/*.pyc"
  ],
  "allowedPaths": ["README.md", "skills/**"],
  "allowAdditionalPaths": false,
  "maxDepth": 8,
  "maxFiles": 500
}
```

完整 Schema：`contracts/submission-contract-v1.1.schema.json`。可直接复用的模板：`contracts/examples/submission-contract.skills.valid.json`。

## 校验边界

平台接收提交时做结构预检：归档安全、根目录、路径、文件数、目录深度、必需项、禁止项、白名单、类型和扩展名。`minChars`、`minSections`、`mustExport`、函数签名等内容语义由该赛题的评测引擎继续校验，并写入详细评测报告。

校验失败返回 `DELIVERY_STRUCTURE_INVALID`，具体问题位于 `details.issues`。员工端会直接展示缺少的文件或不允许的路径，不显示内部路径和开发者说明。

--- END FILE: docs/submission-contract.md ---


--- BEGIN FILE: docs/v0.7-development-manual.md ---

# v0.7.0 生产数据与身份底座开发手册

> 面向开发者：Luna 及后续参与 v0.7.0 的工程人员
> 基线版本：`v0.6.1`（提交 `f557592`）
> 文档状态：v0.7.0 已发布；文档同时记录目标环境上线门禁
> 对应版本：`v0.7.0`
> 最后核对日期：2026-08-04

## 1. 使用方式

开始任何修改前，必须依次阅读：

1. 根目录 `AGENTS.md`；
2. 根目录 `DEVELOPMENT_PLAN.md`；
3. 本手册；
4. 当前纵切面涉及的 OpenAPI、JSON Schema、实现和测试。

本手册把 v0.7.0 拆成多个可独立验收的纵切面。每个开发任务只完成一个纵切面，不在一个变更中同时重写存储、身份、上传和前端。版本发布后，剩余门禁仍必须在目标环境逐项复验。

若本手册与代码或契约冲突，事实来源优先级为：

1. `contracts/openapi.yaml` 与 `contracts/*.schema.json`；
2. 已提交实现和自动化测试；
3. `DEVELOPMENT_PLAN.md`；
4. 本手册。

发现冲突时不要静默选择一种行为，应先用失败测试固定现状，再在当前任务中明确迁移策略。

## 2. 版本目标

v0.7.0 的目标是让核心平台摆脱单机 JSON 文件、浏览器可伪造身份头和本地交付目录对生产环境的依赖，同时保留无需外部依赖的本地开发能力。

版本完成后应具备：

- 通过配置选择文件 Repository 或 PostgreSQL/Prisma Repository；
- PostgreSQL 成为生产环境的唯一业务数据事实来源；
- 组织、人员、赛题、训战、提交、评测运行、批次、结果和审计的关键写操作具有事务与唯一约束；
- 员工、提交、审计和画像相关列表使用服务端分页、筛选和稳定排序；
- 生产身份由可信网关会话或经验证的 OIDC/JWT 提供，请求体与普通外部请求头不能声明操作者；
- 交付件通过流式上传或预签名上传进入对象存储，平台只接受服务端签发并确认的对象；
- 数据迁移、种子隔离、备份、恢复和回滚流程可重复演练；
- v0.6.1 的领域状态机、权限边界、快照算法、评测契约和历史不可变性保持不变。

v0.7.0 不负责：

- GitLab CI 自动评测；
- K8s Job、正式 Code Agent 沙箱和 Worker 服务身份；
- 导师工作台、申诉、通知等 v0.9.0 功能；
- 大规模前端路由或设计系统重构；
- 修改评分口径、rubric、能力模型或现有 JSON Schema；
- 为文件和 PostgreSQL 分别实现两套领域状态机。

## 3. 当前基线

### 3.1 当前运行时

- `services/platform-api/src/store.ts` 同时承担领域规则、权限、审计、内存状态和 JSON 文件持久化；
- 默认数据文件是 `tmp/platform-data.json`，写入采用临时文件加原子重命名；
- `services/platform-api/prisma/schema.prisma` 与 `prisma/migrations/0001`–`0004` 已存在，但 API 运行时没有使用 Prisma；
- `GET /api/v1/users` 只支持 `orgPath`，返回完整数组；
- 管理端在 `apps/web/src/admin.tsx` 中对人员数组做客户端筛选和分页；
- 身份主要来自 `X-Employee-Id`，`POST /auth/sso` 是本地身份同步入口，不等同于生产登录会话；
- `ArtifactStore` 使用本地目录，浏览器上传使用 JSON base64；
- Worker/Code Agent 批次链路已经存在，不能因本次存储迁移改变 ABI。

### 3.2 必须保持的不变量

- 上传和 Git 交付件进入 grader 前必须成为不可变快照；
- 同一提交重新评测必须新建 `GradingRun`，不得覆盖旧结果；
- 评测结果必须经过 Schema、归属、幂等键和服务端重算校验；
- `AUTO`、`MANUAL`、`IMPORT` 共享结果录入边界；
- 评测批次必须保留管理员精确选择的完整集合，不得被 Worker 拆分或扩大；
- 部门管理员只能操作授权组织路径及其子路径；
- 管理写操作与对应审计必须在同一事务中成功或失败；
- 已发布 Schema、rubric 和数据库迁移不可原地修改。

## 4. 开发总顺序

必须按以下顺序推进。后一个工作包依赖前一个工作包的契约和测试基线。

| 顺序 | 工作包 | 交付结果 |
| --- | --- | --- |
| W0 | 数据模型差距审计与测试基座 | 新迁移方案、PostgreSQL 测试环境、Repository 装配骨架 |
| W1 | 组织与人员 Repository 纵切面 | 组织读取、员工分页、角色更新、审计同事务 |
| W2 | 生产身份纵切面 | Nest Guard、可信身份上下文、首次建档事务、越权矩阵 |
| W3 | 赛题与训战 Repository 纵切面 | 已发布版本不可变、训战与参与范围持久化 |
| W4 | 提交与评测 Repository 纵切面 | 提交、运行、批次租约、结果录入事务和并发唯一性 |
| W5 | 对象存储与上传纵切面 | 流式/预签名上传、不可变对象确认、本地与对象存储适配器 |
| W6 | 分页补齐与前端接入 | 提交、审计、画像相关列表服务端分页 |
| W7 | 数据迁移与运维验收 | 导入、校验、备份、恢复、回滚演练和发布文档 |

每个工作包可以拆成多个 PR，但一个 PR 只承载一个可验收纵切面。不要创建长期存在的“大重构分支”。

## 5. W0：模型差距审计与测试基座

### 5.1 先做差距审计

逐项比较以下三处：

- `services/platform-api/src/domain.ts`；
- `services/platform-api/src/store.ts` 的实际读写字段；
- `services/platform-api/prisma/schema.prisma` 与已有迁移。

当前已知需要重点核对的字段和语义包括：

- `AppUser.departmentHint`、`departmentSource`、角色列表与 `RoleBinding` 的映射；
- `Challenge.category`、`archivedFrom`、难题榜 `board` 元数据；
- `Event.purpose`、`accessPolicy`、可选的 delivery 配置；
- `Submission.artifactName`、赛题/rubric 快照、当前 grading 状态、尝试次数、失败原因和历史结果引用；
- `GradingRun.attempt`、失败原因、运行租约字段和幂等语义；
- `EvaluationBatch` 租约、完成回调幂等和部分失败字段；
- `EvaluationResult` 多次重新评测历史，不得重新引入 `submissionId` 唯一约束；
- 公告组织范围、审计 before/after 数据；
- `CodeAgentRuntimeConfig` 的系统设置与批次冻结快照。

已有 `0003_evaluation_batches_and_delivery_contracts` 已移除 `EvaluationResult.submissionId` 的唯一索引。任何新迁移都必须保留“一份提交可拥有多个历史结果”的行为。

### 5.2 迁移规则

- 不修改 `0001`–`0004`；
- 从新的顺序迁移开始补齐字段和约束；
- 每个迁移只表达一个可回滚的事实变更；
- 先让 `prisma migrate deploy` 能从空数据库完整执行，再测试从 v0.6.1 数据结构升级；
- Schema 中的约束必须与迁移后的真实数据库一致，不能只修改 `schema.prisma`；
- 发布前使用独立数据库执行升级和回滚演练，不能以开发数据库代替。

### 5.3 PostgreSQL 测试基座

新增显式的 PostgreSQL 集成测试入口，要求：

- 每次测试使用独立数据库或独立 schema；
- 测试启动时执行正式迁移，不使用 `db push` 代替迁移；
- 测试结束后清理自己的数据库，不删除开发者未明确指定的数据；
- 数据库不可用时集成测试应明确失败或由显式环境开关跳过，不得假装通过；
- CI 中必须运行 PostgreSQL 集成测试；
- 单元测试仍可使用文件或内存适配器，保持快速反馈。

建议增加独立命令，例如：

```powershell
pnpm --filter @ai-training/platform-api test:integration:postgres
```

具体依赖版本在实现时统一锁定，根锁文件必须提交。不得依赖开发者机器全局安装的 Prisma CLI。

## 6. Repository 设计

### 6.1 设计原则

不要把 `PlatformStore` 的 3700 多行方法逐个机械复制成 Repository。Repository 只负责持久化、查询、事务和原子状态转换；权限、状态机和业务校验仍属于领域服务。

过渡期允许 `PlatformStore` 继续作为控制器使用的门面，但它应逐个纵切面委托给明确的服务和 Repository。不得让控制器根据适配器类型分支。

推荐边界：

```text
Controller
  -> Application/Domain Service
       -> PlatformRepository / narrow repository ports
            -> FilePlatformRepository
            -> PrismaPlatformRepository
```

可以在 `PlatformRepository` 下按领域拆分窄接口，例如：

- `OrganizationRepository`；
- `IdentityRepository`；
- `ChallengeRepository`；
- `SubmissionRepository`；
- `EvaluationRepository`；
- `AuditRepository`。

共享事务必须通过统一的 Unit of Work 完成，不能在多个 Repository 各自提交后再补偿。

### 6.2 适配器选择

通过显式环境变量选择实现，例如：

```dotenv
PLATFORM_REPOSITORY=file
# PLATFORM_REPOSITORY=postgres
DATABASE_URL=postgresql://...
```

约束：

- 本地默认仍可使用 `file`；
- `NODE_ENV=production` 时禁止默认回退到文件 Repository；
- 选择 `postgres` 但缺少或无法连接 `DATABASE_URL` 时启动失败；
- 不得在运行期间切换 Repository；
- API 日志可记录适配器类型，但不得记录数据库连接串。

### 6.3 事务边界

至少以下操作必须形成单个数据库事务：

- SSO 首次建档或身份同步；
- 部门新增、修改、删除及审计；
- 员工部门、角色和角色绑定更新及审计；
- 提交快照登记与对应状态初始化；
- 创建 `GradingRun` 与更新提交当前评测状态；
- 创建批次并绑定所有运行；
- 原子领取或续租批次；
- 结果校验通过后的结果写入、运行完成、提交状态和审计更新；
- 失败回传后的运行、批次和提交状态更新。

外部网络和对象存储调用不能长时间占用数据库事务。先完成外部操作，再以不可变标识进入短事务；失败时保留可安全重试的中间状态。

## 7. W1：组织与人员首个纵切面

这是 v0.7.0 的第一个业务纵切面，必须在迁移其他领域前独立验收。

### 7.1 API 契约

先修改 OpenAPI，再修改实现。`GET /api/v1/users` 改为服务端分页响应。

建议查询参数：

| 参数 | 默认值 | 规则 |
| --- | --- | --- |
| `page` | `1` | 正整数 |
| `pageSize` | `20` | `1`–`100` |
| `orgPath` | 无 | 包含该组织及子组织 |
| `query` | 无 | 工号或姓名的规范化模糊搜索 |
| `role` | 无 | 精确角色过滤，可重复或逗号分隔时必须在契约中固定一种 |
| `status` | 无 | `ACTIVE` 或 `DISABLED` |
| `sortBy` | `employeeNo` | 只允许白名单字段 |
| `sortOrder` | `asc` | `asc` 或 `desc` |

响应使用固定包装：

```json
{
  "items": [],
  "pageInfo": {
    "page": 1,
    "pageSize": 20,
    "total": 0,
    "totalPages": 0,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

排序必须稳定：业务排序字段相同时，以 `id` 作为最终排序键。禁止把客户端传入字段直接拼接为 SQL。

本次响应从数组改为分页对象时，必须在同一纵切面同步管理端、OpenAPI 和 API 测试。不要保留“传 page 返回对象、不传 page 返回数组”的双形态响应。

### 7.2 权限行为

- 全局管理员可以查询全部员工；
- 部门管理员只能查询授权路径及子路径；
- 普通员工不能通过分页接口枚举全员；
- 请求的 `orgPath` 超出管理员范围时返回稳定的 403，不返回空数组掩盖越权；
- 部门管理员不能修改管理员账号或授予管理员角色；
- 全局管理员可以维护角色绑定；
- 管理员不能修改 SSO 主数据 `employeeNo` 和 `name`；
- 未匹配部门的 SSO 用户保留空组织路径和 `departmentHint`，等待全局管理员配置。

### 7.3 同事务审计

员工角色更新必须在同一事务中：

1. 锁定并读取目标员工；
2. 校验操作者权限和目标组织范围；
3. 更新部门字段；
4. 替换或增量更新角色绑定；
5. 写入 before/after 审计；
6. 提交事务。

任一步失败时，员工和审计都不得产生部分更新。

### 7.4 必测场景

- 分页边界：空列表、最后一页、超过末页、非法 page/pageSize；
- 姓名与工号查询、角色/状态/组织组合过滤；
- 相同排序值下跨页无重复、无遗漏；
- 全局管理员与部门管理员组织范围矩阵；
- 部门管理员请求范围外组织明确返回 403；
- 两个并发请求为同一 SSO 工号首次建档，只产生一个用户；
- 角色更新失败时审计不落库；
- 审计写入失败时角色更新回滚；
- 文件与 PostgreSQL 适配器对同一领域用例返回一致结果；
- 管理端翻页、查询、组织树筛选和保存后保持当前筛选条件。

## 8. W2：生产身份纵切面

### 8.1 统一身份上下文

新增 Nest 身份 Guard 或等价请求级适配器，控制器只消费可信的 `AuthenticatedActor`，不再自行解析 `X-Employee-Id`。

建议上下文至少包含：

```ts
interface AuthenticatedActor {
  employeeNo: string;
  authenticationType: 'LOCAL' | 'OIDC' | 'TRUSTED_GATEWAY';
  issuedAt?: string;
}
```

角色和组织范围必须从平台数据库读取，不能信任令牌或网关传入的管理员角色。

### 8.2 运行模式

- `LOCAL`：仅用于开发和自动化测试，允许 `X-Employee-Id`；
- `OIDC`：验证签名、issuer、audience、有效期和必要 claims；
- `TRUSTED_GATEWAY`：仅在部署网络明确保证请求只能来自可信网关时使用，并清除外部请求伪造的身份头。

生产环境必须显式配置一种生产身份模式。`NODE_ENV=production` 时如果仍选择 `LOCAL`，API 应拒绝启动。

内部 IdP 的 issuer、audience、JWKS、claim 名称或网关断言协议是外部输入。在这些信息没有确定前，不得猜测企业协议并把假实现标记为完成。

### 8.3 SSO 建档

- 工号是幂等键；
- 首次登录默认只赋予 `learner`；
- 姓名和部门提示可按可信 claims 同步；
- 管理员手工配置过的部门不能被后续无法匹配的 SSO 部门覆盖；
- 禁用账号即使令牌有效也不能登录；
- 首次建档、角色初始化和审计在同一事务中；
- `/auth/sso` 在生产模式下不得作为匿名、可任意提交身份的公开入口。

### 8.4 安全测试矩阵

至少覆盖：缺失身份、伪造本地头、错误签名、错误 issuer/audience、过期令牌、未来生效令牌、缺少工号、禁用账号、首次登录竞争、跨部门管理员、普通员工冒充管理员、网关头直连绕过。

测试和日志不得保存真实令牌、Cookie、SSO 断言或员工数据。

## 9. W3：赛题与训战持久化

迁移时保持当前 API 和领域规则，不顺便重做赛题编辑器。

必须验证：

- 赛题发布后版本、Schema、rubric、引擎引用不可原地修改；
- 新版本通过新增记录实现；
- 训战始终引用已发布的赛题版本；
- `AUTO`、`MANUAL`、`IMPORT` 与引擎能力匹配校验不变；
- 训战参与部门、人员、导师和参与名单持久化完整；
- 难题榜仍复用赛题数据，不创建第二套题库；
- 部门删除引用检查在 PostgreSQL 下仍覆盖赛题、训战、难题和公告；
- 所有管理写操作写入同事务审计。

管理端编辑/删除边界：

- 赛题列表的“编辑”优先打开已有草稿；没有草稿时从最新发布版本创建下一版本草稿，已发布版本、Schema、rubric 和评测引擎引用仍不可原地修改。
- 赛题的“删除”是可恢复的回收站操作（`DELETE /api/v1/challenges/{challengeId}`，兼容保留旧的 archive/trash 路由）；存在开放训战时拒绝归档。
- 训战通过 `PATCH /api/v1/events/{eventId}` 编辑；`DELETE /api/v1/events/{eventId}` 只删除无提交、未公布且非系统管理的训战，同时清理参与记录和赛季引用并写入 `event.delete` 审计。
- 删除训战不会级联删除提交、运行或评测结果；一旦存在提交，服务端返回冲突并要求保留训战历史。

需要把当前 JSON 嵌套字段映射到关系字段或 JSONB 时，先定义哪个表示规范是事实来源。不要在读取时同时合并两套可能冲突的数据。

## 10. W4：提交与评测持久化

这是 v0.7.0 风险最高的纵切面，必须在组织人员和赛题训战稳定后进行。

### 10.1 提交

- 数据库只登记已经完成服务端校验的不可变快照；
- `snapshotHash`、`artifactHash`、提交人和组织快照不可更新；
- 同一员工提交相同快照的幂等规则必须由数据库唯一约束和领域规则共同保证；
- 客户端提供的员工、组织、哈希和 artifact URI 都不能直接成为可信值；
- 重新提交与重新评测是两个不同动作，不得混淆。

### 10.2 评测运行和批次

- 创建运行时计算并保存幂等键；
- 重新评测通过 attempt 或等价不可变输入生成新幂等键；
- 一个未完成运行不能同时属于两个活动批次；
- 批次创建必须原子绑定全部选中运行；
- 批次领取必须是数据库原子状态转换，不能先查询再逐条更新；
- 多 Worker 并发领取时，同一批次只能产生一个有效租约；
- 心跳必须同时匹配批次 ID 和租约 ID；
- 过期恢复只能重新排队未完成项，已成功录入结果不能丢失；
- 完成回调重复提交时返回已有事实，不重复创建结果。

Prisma 普通读后写不足以保证租约竞争时，允许在短事务中使用参数化原生 SQL、行锁或数据库支持的跳锁语义，但必须封装在 Repository 内并有并发测试。禁止在领域服务中散落原生 SQL。

### 10.3 结果录入

顺序必须保持：

1. JSON Schema 校验；
2. 运行、提交和批次归属校验；
3. 幂等键校验；
4. 服务端覆盖可信 subject/组织快照；
5. 服务端重算 criterion、dimension 和 total；
6. 在短事务中写入不可变结果并更新运行、提交、批次和审计。

任何校验失败都不得写入部分结果。数据库中必须允许同一 `submissionId` 对应多个不同 `gradingRunId` 的历史结果，同时保证一个运行最多一个结果。

### 10.4 并发验收

至少包含：

- 10 个并发提交的唯一性；
- 两个请求同时创建同一运行；
- 两个 Worker 同时领取一个批次；
- 租约续期与过期回收竞争；
- 同一完成回调重复 10 次；
- 回调中途失败后重试；
- 一批次部分成功、部分失败；
- 重新评测保留旧运行和旧结果；
- API 重启后队列、租约、结果和审计状态一致。

## 11. W5：对象存储与上传

### 11.1 存储边界

抽象对象存储接口，至少提供：

- 创建待上传对象；
- 确认对象大小、校验和和元数据；
- 固化或复制为内容寻址的不可变对象；
- 受权读取或短期下载地址；
- 删除未完成的临时对象；
- 按生命周期清理过期临时对象。

实现：

- `LocalArtifactStore`：本地开发和快速测试；
- S3 兼容对象存储实现：生产；
- 业务服务只依赖接口，不读取本地绝对路径。

### 11.2 推荐的两阶段上传

1. 员工先请求上传授权，平台校验身份、训战开放状态、参与资格、交付方式、文件名和声明大小；
2. 平台签发短期上传 URL 或接受流式上传；
3. 客户端完成上传；
4. 客户端提交上传句柄，不提交任意 URL；
5. 平台从对象存储读取可信元数据，重新校验大小、归档安全、交付契约和快照哈希；
6. 平台固化不可变对象并登记提交。

上传句柄必须绑定操作者、训战、文件大小上限、过期时间和对象 key。客户端不能拿其他人的上传句柄创建提交。

### 11.3 安全门禁

- 限制请求体、单文件、文件数和解压后总体积；
- 拒绝路径穿越、绝对路径、符号链接逃逸和解压炸弹；
- MIME 类型和文件扩展名不能代替真实归档检查；
- 对象 key 由服务端生成，不能使用客户端路径；
- 下载地址短期有效且按权限签发；
- 日志不记录预签名 URL、凭据或完整源码；
- 数据库提交失败时，临时对象进入可重试清理队列，不在请求中做危险的广泛删除；
- Worker 下载后仍须再次验证快照哈希。

对象存储集成测试应使用隔离 bucket 或前缀，覆盖过期授权、篡改对象、超大对象、重复确认和跨用户句柄。

## 12. W6：分页与前端接入

除员工外，逐步为以下列表增加服务端分页：

- `GET /submissions`；
- `GET /audits`；
- 管理端画像涉及的员工候选列表和结果历史列表；
- 后续经容量测试确认的其他高基数列表。

统一使用 `PageInfo` 契约、相同的 page/pageSize 上限和稳定排序规则。不要让每个接口发明不同分页结构。

前端要求：

- 查询条件变化时回到第一页；
- 保存或刷新后保留合理的查询与组织筛选；
- 请求竞态通过取消、请求序号或等价方式处理，旧响应不能覆盖新条件；
- 空态、加载态、错误态和无权限状态明确区分；
- 不再先下载全量用户后前端分页；
- 不在本阶段顺便拆分全部路由和组件。

### 12.1 训战维度的 AI 能力画像

管理员能力画像同时支持组织范围和训战范围。实现时使用同一个聚合逻辑，不复制一套评分规则：

- `GET /api/v1/admin/capabilities?eventId=<eventId>` 必须先校验管理员对训战的可见范围；
- 训战筛选只使用该训战的提交、评测结果、四维能力、16 个评分点和八个能力域；
- “整体”模式默认展示该训战已有提交的员工；明确勾选员工时允许显示尚未完成评测的空画像，方便管理员识别待评测人员；
- 返回 `selection.eventId`，让 Web 端能够明确标注当前数据是训战 AI 评测，而不是跨训战历史平均；
- 管理端训战下拉只能使用管理员可见的非难题榜训战，并与部门/员工筛选共同生效。

验收至少覆盖：训战结果只包含目标 `eventId`、无效训战返回 404、跨管理员组织范围返回 403、无结果员工不会被错误计入已完成评估，以及分页和原有部门聚合语义保持不变。

## 13. W7：数据迁移、备份与恢复

### 13.1 JSON 到 PostgreSQL 导入工具

提供显式 CLI，不得在 API 启动时自动导入。CLI 至少支持：

- `--source` 指定 JSON 文件；
- `--dry-run` 只校验和输出统计；
- 重复执行幂等；
- 逐领域统计读取、写入、跳过和失败数量；
- 校验外键、唯一键、快照字段和历史结果数量；
- 失败时返回非零退出码；
- 不输出完整源码、令牌或交付内容。

建议导入顺序：组织 → 用户和角色 → 赛题版本 → 训战和名单 → 提交 → 运行和批次 → 结果 → 公告和审计 → 系统设置。

导入完成后至少核对：

- 每类记录数量；
- 每个提交的运行和结果历史数量；
- 未完成批次和租约状态；
- 管理员角色范围；
- 赛题版本与训战引用；
- 结果总分重算抽样；
- 文件适配器与 PostgreSQL 关键 API 响应的语义一致性。

### 13.2 种子数据

- 本地演示种子与生产迁移完全分离；
- 生产启动不能自动创建 `w00123` 等演示账号；
- 集成测试使用虚构员工和组织；
- 种子脚本必须显式运行并仅作用于指定数据库。

### 13.3 备份恢复和回滚

发布前完成并记录：

1. 空数据库部署迁移；
2. v0.6.1 数据导入；
3. 数据库备份；
4. 故意破坏测试数据；
5. 从备份恢复到新实例；
6. 对比关键记录数量和哈希；
7. 应用回滚到上一可运行版本的流程。

数据库迁移如果包含不可逆数据变换，必须提供前滚修复方案和恢复步骤，不能声称简单执行 down migration 即可回滚。

## 14. OpenAPI 与错误契约

新增或修改 API 时：

- 先改 `contracts/openapi.yaml`；
- 为分页响应、身份错误和上传会话建立可复用 schema；
- 保留稳定业务错误码，不能依赖数据库原始错误文本；
- 唯一约束冲突映射为明确的 409；
- 参数非法映射为 400；
- 未认证为 401；
- 已认证但越权为 403；
- 数据不存在为 404；
- 不向客户端暴露 SQL、表名、连接信息、堆栈或对象存储内部 key。

`services/platform-api/test/contract.test.ts` 必须继续保证控制器路由与 OpenAPI 一致。

## 15. 测试策略

### 15.1 测试层次

- Repository 契约测试：同一套用例分别运行文件和 PostgreSQL 适配器；
- 领域单元测试：状态机、权限和不变量，不依赖真实数据库；
- PostgreSQL 集成测试：事务、唯一约束、锁和迁移；
- API 测试：HTTP 契约、身份、分页和错误映射；
- Worker 端到端测试：批次租约和结果录入迁移后仍通过；
- Web 测试或浏览器验收：分页、筛选、权限与上传；
- 数据迁移测试：固定的虚构 v0.6.1 JSON fixture 导入后语义一致。

### 15.2 每个纵切面的最低验证

```powershell
pnpm contract:test
pnpm --filter @ai-training/platform-api test
pnpm grader:test
pnpm --filter @ai-training/platform-api test:integration:postgres
git diff --check
```

涉及前端时增加：

```powershell
pnpm --filter @ai-training/web test
pnpm --filter @ai-training/web build
```

涉及批次、租约或结果录入时必须运行 `evaluation-worker.test.ts` 所覆盖的真实 API/Worker/Code Agent bridge 场景。

发布候选必须运行：

```powershell
pnpm contract:test
pnpm grader:test
pnpm test
pnpm build
pnpm acceptance:local
pnpm --filter @ai-training/platform-api test:integration:postgres
git diff --check
```

## 16. 可观测性最低要求

v0.7.0 不建设完整监控平台，但生产数据链路至少提供结构化日志和基本指标接口，且不得泄露敏感信息。

建议记录：

- Repository 类型和数据库连接成功/失败；
- 请求关联 ID；
- 操作者平台用户 ID、动作和目标 ID，不记录令牌；
- 数据库事务冲突和重试次数；
- 上传授权、确认和清理的计数与失败原因码；
- 批次领取、租约过期、重复回调和结果校验失败计数；
- 分页查询耗时和返回数量，不记录完整查询结果。

## 17. 性能与容量基线

至少使用虚构数据建立以下基线：

- 10 万员工下的组织范围分页和姓名/工号查询；
- 10 万提交下按训战、员工和状态分页；
- 100 万审计记录下按时间和目标查询；
- 多 Worker 并发领取批次；
- 结果批量导入和报告读取；
- 最大允许上传包的确认与校验。

本阶段不要求达到最终 SLA，但必须记录数据量、并发数、P50/P95、数据库规格和测试方法。发现全表扫描时先补索引和查询计划证据，不通过把 pageSize 上限调小掩盖问题。

## 18. 禁止事项

- 禁止修改已发布迁移、Schema 或 rubric；
- 禁止让 Prisma model 直接穿透到控制器响应；
- 禁止在 Controller 中编写 SQL、事务或权限规则；
- 禁止保留文件状态机和数据库状态机两套业务实现；
- 禁止生产环境静默回退到文件 Repository 或本地身份模式；
- 禁止信任客户端的 actorId、员工身份、组织路径、artifact URI、哈希或总分；
- 禁止先查询后更新实现租约竞争；
- 禁止把外部对象存储调用放入长数据库事务；
- 禁止通过删除测试、放宽校验或吞异常解决迁移失败；
- 禁止在日志、fixture 或文档中写真实员工、客户、仓库凭据和生产数据；
- 禁止为了 v0.7.0 提前实现 GitLab CI 或正式评测沙箱。

## 19. 每个 PR 的交付模板

Luna 每完成一个纵切面，应在交付说明中提供：

```text
目标纵切面：
行为变化：
契约变化：
数据库迁移：
改动文件：
验证命令与结果：
兼容性说明：
数据迁移/回滚方式：
未解决风险：
下一纵切面建议：
```

PR 合并条件：

- 范围与本工作包一致；
- 测试先于或伴随实现；
- OpenAPI、代码和测试一致；
- 新迁移从空库和升级库均可执行；
- 文件适配器没有被无意破坏；
- 没有生产凭据、临时数据或构建产物；
- 风险被明确记录，不以“后续优化”隐藏正确性问题。

## 20. v0.7.0 发布验收

代码版本发布已完成；以下清单用于复核发布事实，并作为目标环境上线门禁：

- PostgreSQL 下完成从组织人员到结果报告的核心闭环；
- 所有关键写操作具有事务和数据库唯一约束；
- 员工、提交、审计和画像相关高基数列表完成服务端分页；
- 生产身份模式通过完整越权矩阵；
- 对象存储上传、下载、篡改和跨用户测试通过；
- JSON 到 PostgreSQL 导入经过 dry-run、正式导入和一致性校验；
- 备份恢复和回滚演练有记录；
- 本地文件适配器仍可完成快速验收；
- 完整测试、构建、本地验收和 PostgreSQL 集成测试通过；
- 根目录、Web、API 三个 `package.json` 同步为 `0.7.0`；
- `DEVELOPMENT_PLAN.md` 更新当前状态、版本沿革和下一阶段；
- `CHANGELOG.md` 只记录实际完成的事实变更；
- 未解决风险在发布说明中明确列出。

## 21. Luna 的推荐起手任务

第一个任务只做 **W0 + W1 中的最小组织人员纵切面**，不要同时接入生产 SSO 或对象存储：

1. 为 `GET /users` 补分页 OpenAPI 和失败契约；
2. 增加分页、范围越权、稳定排序和事务审计的失败测试；
3. 建立 Repository/Unit of Work 最小边界；
4. 实现文件适配器，保持现有测试速度；
5. 补齐 Prisma 模型差距并新增迁移；
6. 实现 PostgreSQL 组织人员 Repository；
7. 更新管理端使用服务端分页；
8. 运行文件/PostgreSQL 契约测试和角色越权矩阵；
9. 报告尚未迁移的领域，不能把目标环境上线门禁误写成已完成。

这个起手任务的验收句应是：

> 在不改变既有组织权限语义的前提下，同一套组织与人员领域用例可以运行在文件和 PostgreSQL Repository 上；员工列表由服务端分页，员工角色更新与审计在 PostgreSQL 中同事务提交。

## 22. 本轮实现记录（2026-08-04）

W0/W1 及相关生产底座已随 v0.7.0 发布：

- `0005_v07_identity_fields` 至 `0008_announcement_scope` 补齐身份、生命周期和公告范围字段；`0013_submission_current_pointers` 分离提交当前运行/结果指针与历史关系，避免重新评测重启恢复旧结果；
- `0009_upload_sessions` 持久化 PostgreSQL 上传会话，`0010_platform_snapshot_revision` 为过渡快照增加 CAS 版本，`0011_org_unit_name_scope`/`0012_org_unit_root_name_scope` 固化同级组织名称唯一约束（包括根组织的 `NULL` parentId），`0014_capacity_query_indexes` 为高基数分页补充索引；
- W1 组织、人员和审计写入经 Repository/Unit of Work 在同一事务提交，HTTP 成功响应会等待持久化完成；
- PostgreSQL 模式的提交、审计和人员管理列表通过规范化表的 `COUNT + 稳定排序键分页/回表` 查询，并在数据库侧施加组织范围过滤；
- W3/W4 结果同步会根据不可变结果 JSON 重建 criteria/finding 关系投影；S3 确认先提交完成状态，再删除 staging 对象，重复确认可返回同一不可变对象；
- W3/W4 的低卡读取、上传授权和提交主体校验会在 PostgreSQL 模式下从请求内最新事务图复核；生产配置拒绝启用内嵌评测执行器，避免 API 进程执行学员交付件；备份恢复会复原 Prisma DateTime 类型，JSON 导入同步重建结果证据投影；
- PostgreSQL Domain Unit of Work、兼容状态持久化和窄 Repository transaction 使用 repeatable-read 快照，配合 revision CAS 把跨实例写冲突显式返回，而不是静默覆盖。
- OpenAPI 已声明本地、OIDC Bearer 和可信网关三种身份契约；OIDC 畸形签名统一映射认证失败，JSON 导入按组织层级满足自引用外键，管理员下载交付件再次校验内容哈希。
- 上传会话 OpenAPI 已声明控制器返回的 `subjectId`，并有契约回归防止额外字段与 required 列表漂移。
- 已提供迁移、JSON dry-run、备份/恢复命令，以及租约/结果幂等、组织 CAS 冲突和上传会话重启恢复的适配器级回归；临时隔离 PostgreSQL 已完成真实迁移、集成、导入和恢复演练。
- GitLab CI 已增加隔离 PostgreSQL 16 service，并在集成测试前等待数据库端口就绪，再执行正式 `prisma migrate deploy` 路径，避免 CI 只覆盖文件适配器。
- PostgreSQL 集成测试已补齐并发验收：同一 SSO 工号首次建档、同级组织名称、运行幂等键、批次/运行租约 CAS，以及 10 次重复结果回调均使用后缀隔离数据验证并清理。
- SSO 首次建档重试同时覆盖 PostgreSQL 唯一冲突与 repeatable-read 写冲突（`P2002`/`P2034`），并保持每次同步的审计事实。
- W6 分页补齐已落地：`GET /profiles/:subjectId/history` 返回统一 `PageInfo`，个人画像支持 `includeHistory=false`，`/admin/capabilities` 对候选人员、画像和趋势返回服务端分页信息；Web 管理端的候选人员和画像列表使用服务端分页，并用请求序列号丢弃过期响应。
- 管理端操作回归已补齐：Web 写操作会在成功后刷新提交、审计、队列和人员等数据；修复刷新链路使用的 `PlatformReadService` 未显式注入 `PlatformStore` 导致的 500 误报，并为本地 Git 快照器补齐同类显式注入。
- 评测契约配置已落地：`contracts/evaluation-contract-catalog.json` 固定可选输入/输出契约，Web 管理端按评测方式以下拉选择，API 通过 `/api/v1/evaluation-contracts` 提供公开选项并在写入赛题版本时执行白名单校验；Schema、示例和 AI 配置说明分别位于 `contracts/`、`contracts/examples/` 与 `docs/evaluation-contract-authoring.md`。
- 当前分页已经限制 HTTP 响应和前端渲染数量，但画像统计仍从规范化图加载后计算聚合；目标环境的高基数容量复测以及进一步拆分画像窄读模型仍是正式发布门槛，不能用本地分页回归代替。
- 使用临时 MinIO S3-compatible endpoint 完成生产配置 HTTP 验收：`application/octet-stream` 原始二进制上传、确认后的内容寻址对象、重复确认幂等、staging 对象篡改拒绝，以及 API 重启后依靠 PostgreSQL `UploadSession` 恢复并确认。
- 代码版本已正式标记为 `v0.7.0`：本地已完成容量基线、查询计划和依赖安全扫描；真实目标环境的 S3 策略、OIDC/JWKS、Worker 服务身份和生产回滚证据仍需补齐，作为上线门禁。

本工作区最终验证记录：

- `pnpm test`：API 107 项（106 通过、1 项显式跳过）和 Web 类型测试通过；
- W6 分页回归覆盖个人画像历史、`includeHistory=false`、管理端能力聚合页码和候选人员服务端分页；评测契约目录与管理员下拉选择回归也已覆盖；平台 API 全量测试为 107 项（106 通过、1 项显式跳过）。
- `pnpm contract:test`：7/7；`pnpm grader:test`：18/18；`pnpm build`、`pnpm lint`、`pnpm acceptance:local`（1/1）和 `git diff --check` 通过；
- `pnpm --filter @ai-training/platform-api prisma:validate` 和 `migrate:json -- --dry-run` 通过（读取组织 4、用户 12、赛题 6、训战 5、赛季 1、公告 3，错误 0）；
- 临时 PostgreSQL 16.4 实例上执行 `prisma migrate deploy`（14/14）和 `POSTGRES_INTEGRATION=true pnpm --filter @ai-training/platform-api test:integration:postgres`（1/1）通过；JSON 正式导入、v2 备份、故意修改后的恢复，以及 PostgreSQL 模式 API 员工分页/组织人员审计事务验收通过。该记录形成于本轮新增并发断言之前；并发扩展已进入 CI 集成入口，当前工作区没有可用数据库可重新执行。
- 带真实 ZIP 二进制的 PostgreSQL HTTP 闭环已通过：上传、启动评测、服务端结果 Schema 校验和结果入库均进入 `GRADED`；回归覆盖了内部 `artifactName`/`workspacePath` 不得进入 `evaluation-result.submission` 的投影约束。
- 已补充内嵌执行器安全回归：`EMBEDDED_EVALUATION_WORKER=false` 时，废弃的单运行执行入口返回 `CODE_AGENT_WORKER_REQUIRED` 且运行保持 `QUEUED`，API 不会绕过外部 Worker 执行评测引擎。
- 最低可观测性已提供：`GET /api/v1/metrics` 仅全局管理员可读，返回进程级请求错误率、延迟分位数和受限路由计数，不保留令牌、员工号、源码或对象存储凭据。
- 指标拦截器会保留异常过滤器设置的 4xx 客户端错误，仅将错误路径上未设置状态的响应归为 5xx；已知路由参数错误回归覆盖该分类，避免运维错误率失真。
- 生产 OIDC 配置会在启动阶段校验 `OIDC_ISSUER` 与 `OIDC_JWKS_URL` 的 URL 格式，并要求两者使用 HTTPS；两类格式/安全错误都会以稳定配置错误失败关闭。
- JSON→PostgreSQL dry-run 会在连接数据库前校验关系引用、唯一键、日期、批次集合（含完成/失败集合）、run/submission 配对、结果归属、当前/历史指针和提交快照哈希；坏图谱返回非零退出码并不输出交付内容。
- 过期上传 staging 清理已接入 API 生命周期，按 `OBJECT_STORAGE_CLEANUP_INTERVAL_SECONDS` 幂等运行，生产 bucket 生命周期策略作为最终兜底。
- S3-compatible 工厂会区分未启用的 Prisma UploadSession provider 与真正的 PostgreSQL 持久化；文件 Repository + S3 的本地联调使用内存会话，生产 PostgreSQL 才启用 durable upload-session persistence。
- 异常日志已结构化并脱敏，仅记录请求 ID、HTTP 状态、稳定错误码和异常类型，不记录堆栈、评测 stderr、对象存储 URL 或数据库连接细节。
- 临时 MinIO S3-compatible endpoint 上生产配置 API 验收通过：原始 `application/octet-stream` 上传（此前 415 回归已修复）、确认/重复确认均返回同一不可变 URI；篡改 staging 对象返回 400；停止并重启 API 后仍可用原上传 token 完成确认。
- 使用合成的 10 万员工、10 万提交和 100 万审计数据复核查询计划；提交分页先读取排序键再按页回表。30 次 count+page 样本 P50/P95：员工 13.54/18.19ms、提交 83.81/92.94ms、审计 149.30/172.82ms；仅作为本地基线，目标环境仍须按同一方法复测。
- 14 个迁移已部署的 PostgreSQL 实例完成 v2 备份、故意修改用户后的恢复回滚演练；`pnpm audit --registry=https://registry.npmjs.org --audit-level=high` 报告无已知高危漏洞。
- v2 恢复脚本会在连接目标数据库前校验主键、外键、批次 run/submission 配对、结果归属和日期；坏备份不会进入目标数据删除事务。

--- END FILE: docs/v0.7-development-manual.md ---


--- BEGIN FILE: docs/v0.8-development-manual.md ---

# v0.8.x 评测运行环境与管理运营开发手册

> 面向开发者：Luna 及后续参与 v0.8.x 的工程人员
> 基线版本：`v0.8.0`
> 当前版本：`v0.8.8`
> 文档状态：v0.8.8 已发布；目标环境沙箱、Worker 服务身份和回滚门禁仍需在内网复验
> 最后核对日期：2026-08-06

## 1. 使用方式

开始修改前依次阅读：

1. `AGENTS.md`；
2. `DEVELOPMENT_PLAN.md`；
3. 本手册；
4. 当前纵切面对应的 `contracts/openapi.yaml`、JSON Schema、实现和测试。

契约和已提交实现优先于本手册。本版本不修改已发布的评分口径、rubric、Schema 或迁移；任何契约变更必须升版本并同步 TypeScript/Python 测试。

## 2. 版本目标

v0.8.8 延续 v0.8.x 的评测环境和管理运营能力，并补齐赛题说明富文本图片能力：

- 管理员可以恢复 OpenCode 默认启动命令和任务指令，查看平台配置与 Worker 本地配置来源；
- 配置测试只在受控开发环境执行合成批次，不得让 API 进程在生产环境启动 Agent；
- Worker 将生命周期、Agent 输出和脱敏交互事件写入独立日志目录，日志有大小上限和滚动策略；
- 其他 AI 可以只拿 Markdown/ZIP 资料包开发评测引擎，并以固定契约验证；
- 管理员可批量调整员工部门，员工可设置昵称和头像，姓名/工号仍由统一认证提供；
- 本地开发可切换测试身份，生产构建默认隐藏该入口；
- 网站品牌统一为“分组核心网AI能力提升平台”。
- 所有禁用控件统一使用 `not-allowed` 鼠标样式；垃圾箱赛题支持带审计的永久删除，存在关联训战时保留并拒绝删除。
- 赛题说明编辑器支持选择 PNG、JPEG、WebP 图片，单张不超过 2 MiB，图片以内嵌 data URL 保存并在详情页自适应展示；
- 浏览器和 API 双重校验图片类型、文件魔数、大小及危险 HTML 属性，拒绝远程图片、SVG 和脚本载荷。

## 3. 纵切面与事实来源

| 纵切面 | 主要实现 | 契约/文档 | 验收重点 |
| --- | --- | --- | --- |
| 运行配置 | `services/platform-api/src/code-agent-runtime.ts`、`apps/web/src/admin.tsx` | `docs/evaluation-engine-protocol.md`、`contracts/openapi.yaml` | 默认值、来源诊断、启用开关和配置测试 |
| Worker 日志 | `scripts/evaluation-worker.mjs` | `.env.example`、协议文档 | 日志脱敏、大小上限、批次/租约隔离 |
| 引擎资料包 | `scripts/build-evaluation-engine-kit.mjs`、`tools/engine-dev-kit/` | `contracts/`、`docs/evaluation-engine-protocol.md` | 独立 ZIP 可还原、Schema 校验通过 |
| 组织运营 | `services/platform-api/src/user-directory.ts`、`apps/web/src/admin.tsx` | `/api/v1/users/batch-department` | 全量预校验、组织范围、审计和管理员保护 |
| 品牌与本地体验 | `apps/web/src/main.tsx`、`apps/web/public/brand-logo.png` | `apps/web/index.html` | 标题、favicon、Logo 和生产身份开关 |

### 3.1 赛题说明图片

图片不是独立上传到对象存储，而是经过前端读取和校验后以受限 data URL 嵌入赛题说明 HTML。这样可以保持赛题版本不可变，且不新增上传接口或数据库迁移。编辑器只接受 PNG、JPEG、WebP，单张上限 2 MiB；服务端还会检查 Base64 规范、图片文件魔数和危险属性，因此不能通过手工请求写入远程地址、SVG 或脚本。

图片使用示例：

```html
<p>请参考下图完成任务：</p>
<img alt="任务流程示意图" src="data:image/png;base64,...">
```

详情页按容器宽度缩放图片，不能依赖图片中的文字传递唯一业务要求；关键要求仍应写入可复制的正文。

## 4. 运行配置规则

### 4.1 默认配置

平台默认关闭 Code Agent 平台配置，默认模板为：

```text
opencode --prompt "{{prompt}}"
```

可用占位符为 `{{prompt}}`、`{{manifestPath}}` 和 `{{batchDir}}`。命令解析不得经过 Shell；只能启动可执行文件并传递参数。配置在创建评测批次时冻结，后续编辑不影响已排队批次。

### 4.2 配置来源

优先级保持：Worker `--agent-command` 显式参数 > 批次冻结的平台配置 > Worker 主机的 `CODE_AGENT_COMMAND` 与 `CODE_AGENT_ARGS_JSON`。API 无法读取另一个主机的命令行，因此页面必须标注“命令行覆盖（API 不可见）”，不能伪造已配置状态。

### 4.3 安全测试

`POST /api/v1/admin/code-agent-runtime/test` 只接受当前表单的命令、任务指令和测试超时，创建合成清单，不带入学员交付件。只有非生产环境且显式设置 `CODE_AGENT_RUNTIME_TEST_ENABLED=true` 时允许执行；仍使用 `shell: false`、可执行文件白名单和输出截断。生产环境必须保持阻断。

## 5. Worker 日志规范

默认目录为 `tmp/evaluation-logs/<workerId>/`，可通过 `EVALUATION_LOG_ROOT` 或 `--log-root` 覆盖：

```text
<workerId>/worker.log
<workerId>/batches/<batchId>/<leaseId>/interaction.jsonl
<workerId>/batches/<batchId>/<leaseId>/agent.stdout.log
<workerId>/batches/<batchId>/<leaseId>/agent.stderr.log
```

日志必须：

- 脱敏 token、Cookie、Authorization、密码和常见密钥字段；
- 不记录完整学员源码、长期凭据或任意 Git URL；
- 记录领取、续租、启动、退出、回传和失败原因，支持按 `batchId`/`leaseId` 追踪；
- 遵守 `EVALUATION_AGENT_OUTPUT_MAX_BYTES` 和 `EVALUATION_WORKER_LOG_MAX_BYTES`，超限写入截断事件；
- 只写 Worker 主机，不通过 API 返回浏览器。

## 6. 组织与人员批量操作

批量接口：

```http
PATCH /api/v1/users/batch-department
Content-Type: application/json
X-Employee-Id: <开发环境管理员工号>
```

请求体必须包含 `userIds` 和具体 `orgUnitId`，单次最多 100 人。服务端先校验整批员工存在、目标部门存在且在管理员范围内，再沿用单员工更新逻辑写入部门路径、角色保护和审计。部门管理员不能调整管理员账号，也不能把员工移出其授权范围；全局管理员不能清理自己的全局管理员属性。

员工姓名和工号是统一认证事实，不允许员工或管理员在资料页修改；昵称和头像属于平台展示字段。组织层级由父部门路径自动计算，不提供手工填写的“组织类型”。

## 7. 本地开发身份与品牌

开发构建（`import.meta.env.DEV`）显示右上角本地身份下拉框，用于管理员、学员和导师验收；生产构建默认不显示，不能依赖该入口提供生产鉴权。生产身份必须来自 OIDC/JWT 或 `TRUSTED_GATEWAY`，详见 `docs/deployment/trusted-gateway-sso.md`。

网站标题和 favicon 使用 `apps/web/public/brand-logo.png`，全局导航品牌文案为“分组核心网 / AI能力提升平台”。更换 Logo 时同时检查 32px favicon、42px 导航图标和浅色背景下的对比度。

## 8. 验收清单

提交前至少运行：

```powershell
pnpm lint
pnpm build
pnpm contract:test
pnpm grader:test
pnpm test
pnpm kit:test
pnpm acceptance:local
git diff --check
```

还应手工确认：

- 关闭测试安全开关时接口返回 `BLOCKED`，生产环境不会启动外部进程；
- 日志中没有 token、Cookie、完整源码和未脱敏 Agent 输出；
- 多人调部门失败时不会绕过组织范围，成功后员工列表和审计均刷新；
- 训战开始前/结束后无法进入和提交；
- 生产构建没有本地身份切换入口；
- 根目录、Web、API 三个 `package.json` 均为 `0.8.8`；资料包版本行由构建脚本从根 `package.json` 读取，不需要手工同步。
- `pnpm build` 之后工作区应保持干净。资料包 ZIP 已是可重复构建（文本统一为 LF，并固定时间戳、权限位、条目顺序和 DEFLATE 压缩级别），若它仍显示为已修改，说明输入确实变了，应当一并提交。

`pnpm test` 依赖已生成的 Prisma Client。全新克隆由 `@ai-training/platform-api` 的 `postinstall` 自动生成；如果 `node_modules` 命中缓存导致 `pnpm install` 判定「Already up to date」，`postinstall` 不会触发，需要手工执行一次：

```powershell
pnpm --filter @ai-training/platform-api prisma:generate
```

CI 的 `before_script` 已固定执行该命令，不依赖 `postinstall` 是否触发。

## 9. v0.8.2 缺陷修复与身份层约束

v0.8.2 是全局代码评审后的缺陷修复版本，不含新功能。四个问题的共同点是「本地测试全绿、只有真实目标环境才会暴露」，后续改动身份层时需要特别注意：

| 缺陷 | 位置 | 根因 | 约束 |
| --- | --- | --- | --- |
| `ES256` 令牌恒验签失败 | `src/identity.ts` `ecdsaJoseToDer` | JOSE 裸 `r||s` 转 DER 时用了长格式长度；OpenSSL 对 <128 字节只接受最短格式 | 允许列表中的每个算法都必须有真实密钥对的正向测试 |
| 密钥轮换期间认证中断 | `src/identity.ts` `loadJwks` | JWKS 缓存 5 分钟，未知 `kid` 直接 401 | 未知 `kid` 必须强制刷新一次再判定，且只刷新一次 |
| CI/全新克隆失败 | `services/platform-api/package.json`、`.gitlab-ci.yml` | 没有任何环节执行 `prisma generate` | 环境前置不能只靠开发机既有状态 |
| 健康检查豁免过宽 | `src/identity-guard.ts` | 用 `endsWith('/health')` 匹配 | 免认证路由必须精确匹配，不能用后缀 |

身份层的三条硬性约束：

- **失败关闭不等于正确。** `ES256` 缺陷全程返回 401，所有既有测试都是绿的。凡是「验证通过」这一侧的分支，必须有正向用例，否则一个恒为 false 的实现看起来和安全实现完全一样。
- **免认证清单必须精确枚举。** 目前只有 `/api/v1/health`。新增任何免认证路由都要同步更新 `identity-guard.ts` 并补越权回归。
- **缓存不得成为可用性单点。** JWKS 缓存的每一条失败路径都要问一次「身份提供方在这一刻轮换密钥会怎样」。

修改 `src/identity.ts` 后，验证回归测试确实有效的方法是：先手工还原缺陷、确认新测试失败，再恢复修复、确认通过。仅确认测试通过不足以说明它能捕获该缺陷。

## 10. 未解决的生产门禁

本地 bridge、文件适配器和 API 配置测试只用于开发验收，不构成生产安全证据。上线前必须在内网目标环境完成：Worker 服务身份和短期令牌、禁网非 root 沙箱、CPU/内存/磁盘/时限限制、S3-compatible 生命周期、OIDC/TRUSTED_GATEWAY 头清理、容量压测、告警和回滚演练。

--- END FILE: docs/v0.8-development-manual.md ---


--- BEGIN FILE: executors/drill-grader/engine.json ---

{
  "schemaVersion": "1.0",
  "id": "drill-grader",
  "version": "0.3.0",
  "title": "内置通用判题器（隐藏测试 + 代码度量）",
  "description": "平台自带的确定性判题器：按提交契约校验交付件，分四档执行隐藏测试得到 Verify，用 AST 度量得到 Code，并逐条产出扣分证据。适用于「有隐藏测试可跑」的赛题。",
  "runtime": {
    "type": "python",
    "entrypoint": "judge.py"
  },
  "params": {
    "type": "object",
    "required": ["contractPath", "entry", "function"],
    "properties": {
      "contractPath": {
        "type": "string",
        "title": "提交契约路径",
        "description": "仓库内相对路径，例如 challenges/parking-fee-v1/submission-contract.json"
      },
      "testsDir": {
        "type": "string",
        "title": "隐藏测试目录",
        "description": "仓库内相对路径，目录内按 basic/boundary/clarification/change 四档存放 JSON 用例"
      },
      "entry": {
        "type": "string",
        "title": "入口文件",
        "description": "交付件内的相对路径，例如 src/parking.py"
      },
      "function": {
        "type": "string",
        "title": "入口函数",
        "description": "隐藏测试调用的函数名，例如 calculate_fee"
      },
      "language": {
        "type": "string",
        "title": "语言",
        "default": "python"
      },
      "zone": {
        "type": "string",
        "title": "阈值 profile",
        "description": "选择 grader/profiles 下的阈值配置",
        "enum": ["yellow", "blue"],
        "default": "yellow"
      }
    }
  },
  "limits": {
    "wallClockSeconds": 180,
    "memoryMB": 512,
    "outputBytes": 4194304
  },
  "platformDependencies": {
    "graderSource": "grader/src/drill_grader"
  }
}

--- END FILE: executors/drill-grader/engine.json ---


--- BEGIN FILE: executors/drill-grader/instruction.md ---

# 批次评测指令

你是该赛题的评测执行代理。只处理批次清单 `submissions` 中列出的提交，不得扩展或替换人员范围。

1. 先读取批次清单中的赛题、评测引擎、参数、交付目录和结果路径。
2. 加载清单声明的全部 skills。
3. 按清单顺序逐份处理学员交付件；每份提交必须使用自己的 `runId`、`idempotencyKey` 和不可变快照。
4. 使用本目录的评测引擎与赛题参数获取客观结果，再补齐判据证据、文件位置和改进建议。
5. 不得修改学员交付件，不得访问清单之外的目录，不得复用另一名学员的证据。
6. 每份成功结果写入该提交声明的 `outputPath`；无法完成时在结果索引中记录 `runId` 和明确原因。
7. 最后写入清单指定的 `resultIndexPath`。结果索引必须覆盖本批次的每个 `runId`，且不得包含批次外的运行。

平台会重新校验结果 JSON、总分、身份归属和幂等键；不符合契约的结果会被拒绝。

--- END FILE: executors/drill-grader/instruction.md ---


--- BEGIN FILE: executors/drill-grader/judge.py ---

"""内置通用判题器 · 调用适配层。

评测环境按统一约定调用本脚本：

    python -I judge.py --input <invocation.json> --output <result.json>

输入符合 `contracts/engine-invocation.schema.json`，输出符合
`contracts/evaluation-result.schema.json`。三种评测方式（线下录入、内置执行器、
上传引擎包）因此共用同一组契约——内置执行器不再靠命令行参数被特殊对待。

判据本身仍在 `grader/src/drill_grader` 里；这里只做参数适配和结果拼装，
不重复实现任何评分逻辑。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

GRADER_VERSION = "drill-grader@0.3.0"


def _grader_root() -> Path:
    """定位仓库内的 drill_grader 包。

    内置执行器随仓库发布，因此按本脚本相对位置回溯即可
    （executors/drill-grader/judge.py -> 仓库根）；评测环境把仓库放在别处时可用
    DRILL_GRADER_SRC 覆盖。
    """
    explicit = os.environ.get("DRILL_GRADER_SRC")
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parents[2] / "grader" / "src"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="drill-grader-judge")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))

    params: dict[str, Any] = payload.get("params") or {}
    workspace = Path(payload["workspace"])
    assets = payload["engine"].get("assets", {})
    grader_source = Path(assets["graderSource"]).parent if assets.get("graderSource") else _grader_root()
    sys.path.insert(0, str(grader_source))
    from drill_grader.cli import _heuristic_criteria, _load_profile  # noqa: E402
    from drill_grader.scoring import score_criteria  # noqa: E402
    from drill_grader.submission import validate_submission  # noqa: E402

    # 平台已经把参数里的仓库路径解析成沙箱内的绝对路径放进 engine.assets，
    # 因此判题器不需要知道仓库根在哪。
    contract = Path(assets["submissionContract"]) if assets.get("submissionContract") else Path(params["contractPath"])
    tests_dir = Path(assets["testsDir"]) if assets.get("testsDir") else (Path(params["testsDir"]) if params.get("testsDir") else None)
    entry = params["entry"]
    function = params["function"]
    language = params.get("language", "python")
    profile = _load_profile(params.get("zone", "yellow"))

    diagnostics = validate_submission(workspace, contract, language)
    criteria, verify_detail, metrics, findings = _heuristic_criteria(
        workspace, contract, language, tests_dir, entry, function, profile,
    )
    scored = score_criteria(criteria, profile["levelRatios"])
    blocked = any(item.severity == "BLOCKER" for item in diagnostics)
    finished = time.time()

    result = {
        "schemaVersion": "1.0",
        "resultId": f"result-{hashlib.sha256((payload['submission']['snapshotHash'] + payload['grading']['runId']).encode()).hexdigest()[:24]}",
        "gradingRunId": payload["grading"]["runId"],
        "challengeVersion": payload["challenge"]["challengeVersion"],
        "rubricVersion": payload["challenge"]["rubricVersion"],
        "graderVersion": GRADER_VERSION,
        "idempotencyKey": payload["grading"]["idempotencyKey"],
        "triggerType": payload["grading"]["triggerType"],
        "status": "PARTIAL" if blocked or not criteria else "COMPLETE",
        "submission": {
            key: value
            for key, value in payload["submission"].items()
            if key in {"sourceType", "repository", "branch", "commitSha", "snapshotHash", "artifactHash", "submittedAt"}
        },
        "dimensions": scored["dimensions"],
        "criteria": scored["criteria"],
        "total": scored["total"],
        "findings": findings,
        "validationDiagnostics": [item.as_dict() for item in diagnostics],
        "verifyDetail": verify_detail,
        "metrics": metrics,
        "gradedBy": "ci",
        "startedAt": started_at,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        "durationMs": int((finished - started) * 1000),
        "metadata": {
            "profile": params.get("zone", "yellow"),
            "profileVersion": profile.get("version", "1.0"),
            "executor": GRADER_VERSION,
        },
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

--- END FILE: executors/drill-grader/judge.py ---


--- BEGIN FILE: executors/drill-grader/skills/evaluation/SKILL.md ---

# 训战交付评测

## 工作范围

- 以批次清单为唯一人员与文件范围。
- 评测引擎输出是客观评分输入，最终结果仍须符合平台评测结果契约。
- 逐份提交独立取证，禁止跨学员复制证据。

## 执行顺序

1. 核对 `snapshotHash`、赛题版本、评分标准版本和评测引擎身份。
2. 调用批次清单声明的引擎入口，输入当前提交的工作区、参数和结果路径。
3. 检查评分项与维度合计，确保总分可以由评分项重算。
4. 每条扣分记录包含判据、实际证据、文件相对路径、行号（可确定时）和可执行的修改建议。
5. 结果只写入当前提交的 `outputPath`。

## 失败处理

- 交付件无法读取、目录规范不符、引擎异常或结果契约不合法时，不伪造分数。
- 在批次结果索引的 `failures` 中记录当前 `runId` 和简洁原因，继续处理下一份提交。

--- END FILE: executors/drill-grader/skills/evaluation/SKILL.md ---


--- BEGIN FILE: grader/SKILL.md ---

# Drill grader skill

This package is the deterministic local grader used by the platform. The
public commands are `check`, `verify`, `measure`, `extract`, `snapshot`, and
`run`.

The `run --full-local` path evaluates hidden tests and static code evidence.
It intentionally leaves `spec` and `collab` unevaluated for human or model
review; those dimensions must not be inferred from keywords in a transcript.
Rubric profiles live in `profiles/` and are versioned with the grader.

Every result contains a canonical snapshot hash. The hash is calculated from
sorted POSIX paths, file content SHA-256 values, and executable bits. Do not
replace it with a client-provided digest.

--- END FILE: grader/SKILL.md ---


--- BEGIN FILE: grader/requirements.txt ---

jsonschema>=4.23,<5
PyYAML>=6.0,<7

--- END FILE: grader/requirements.txt ---


--- BEGIN FILE: grader/references/extraction.md ---

# Evidence extraction

Extraction output is advisory evidence, never a score by itself. Each quote or
metric must identify its source and remain reproducible from the submitted
snapshot. Model-generated observations must be marked for human review.

--- END FILE: grader/references/extraction.md ---


--- BEGIN FILE: grader/references/rubric.md ---

# Rubric reference

Yellow-zone automatic scoring is capped at 60 points: Verify (40) and Code
(20). Verify is split into V1 basic (8), V2 boundary (12), V3 clarification
(12), and V4 change regression (8). Spec (25) and Collaboration (15) are
represented as unevaluated dimensions until evidence is reviewed.

All criterion scores must be within `[0, max]`; dimension scores equal the sum
of their criteria; total equals the sum of evaluated dimensions.

--- END FILE: grader/references/rubric.md ---


--- BEGIN FILE: grader/references/schema.md ---

# Result schema

`contracts/evaluation-result.schema.json` is the interchange contract. The API
validates imported results and recomputes score consistency before persistence.

--- END FILE: grader/references/schema.md ---


--- BEGIN FILE: package.json ---

{
  "name": "ai-training-platform",
  "version": "0.8.8",
  "private": true,
  "packageManager": "pnpm@11.8.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "pnpm -r build",
    "dev:api": "pnpm --filter @ai-training/platform-api dev",
    "dev:web": "pnpm --filter @ai-training/web dev",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "kit:test": "node --test scripts/evaluation-engine-kit.test.mjs",
    "ldap3:test": "python services/ldap3-gateway/test_ldap3_gateway.py",
    "contract:test": "pnpm --filter @ai-training/platform-api contract:test",
    "grader:test": "node scripts/run-grader-tests.mjs",
    "acceptance:local": "pnpm --filter @ai-training/platform-api exec tsx --test test/concurrency.test.ts"
  }
}

--- END FILE: package.json ---


--- BEGIN FILE: pnpm-workspace.yaml ---

packages:
  - apps/*
  - services/*
  - packages/*
overrides:
  find-my-way: 9.7.0
allowBuilds:
  '@prisma/client': true
  '@prisma/engines': true
  esbuild: true
  prisma: true

--- END FILE: pnpm-workspace.yaml ---


--- BEGIN FILE: scripts/build-engine-package.mjs ---

#!/usr/bin/env node
/**
 * Build an evaluation engine package (zip) from a challenge's engine source.
 *
 * The package is what an author uploads: judge script, hidden tests and the
 * submission contract frozen together. Keeping the assets in the challenge
 * directory avoids duplicating them in the repository, while the produced zip
 * stays fully self-contained.
 *
 *   node scripts/build-engine-package.mjs parking-fee-v1 [--out tmp/engine.zip]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [challengeName, ...rest] = process.argv.slice(2);
if (!challengeName) {
  console.error('usage: node scripts/build-engine-package.mjs <challenge-dir> [--out <zip>]');
  process.exit(2);
}
const outIndex = rest.indexOf('--out');
const output = resolve(root, outIndex >= 0 ? rest[outIndex + 1] : join('tmp', `${challengeName}-engine.zip`));
const challengeRoot = join(root, 'challenges', challengeName);
const engineRoot = join(challengeRoot, 'engine');
if (!existsSync(join(engineRoot, 'engine.json'))) {
  console.error(`missing ${join(engineRoot, 'engine.json')}`);
  process.exit(2);
}

// Copy the engine sources plus the assets engine.json points at, then zip.
const build = [
  'import json, pathlib, shutil, sys, tempfile, zipfile',
  'engine_root, challenge_root, output = (pathlib.Path(p) for p in sys.argv[1:4])',
  'manifest = json.loads((engine_root / "engine.json").read_text(encoding="utf-8"))',
  'assets = manifest.get("assets", {})',
  'sources = {',
  '    "assets/submission-contract.json": challenge_root / "submission-contract.json",',
  '    "assets/hidden-tests": challenge_root / "hidden-tests",',
  '    "assets/reference": challenge_root / "reference",',
  '}',
  'with tempfile.TemporaryDirectory() as tmp:',
  '    staging = pathlib.Path(tmp) / "package"',
  '    shutil.copytree(engine_root, staging)',
  '    for declared in assets.values():',
  '        source = sources.get(declared)',
  '        if source is None: raise SystemExit(f"engine.json declares an asset this builder does not know: {declared}")',
  '        if not source.exists(): raise SystemExit(f"missing asset source: {source}")',
  '        target = staging / declared',
  '        target.parent.mkdir(parents=True, exist_ok=True)',
  '        shutil.copytree(source, target) if source.is_dir() else shutil.copyfile(source, target)',
  '    output.parent.mkdir(parents=True, exist_ok=True)',
  '    if output.exists(): output.unlink()',
  '    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:',
  '        for path in sorted(p for p in staging.rglob("*") if p.is_file() and "__pycache__" not in p.parts):',
  '            archive.write(path, path.relative_to(staging).as_posix())',
  'print(output)',
].join('\n');

const python = process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
mkdirSync(dirname(output), { recursive: true });
const built = execFileSync(python, ['-c', build, engineRoot, challengeRoot, output], { encoding: 'utf8', cwd: root });
console.log(`engine package: ${built.trim()}`);

--- END FILE: scripts/build-engine-package.mjs ---


--- BEGIN FILE: scripts/code-agent-local-bridge.mjs ---

#!/usr/bin/env node
/**
 * Local contract adapter for end-to-end development only.
 *
 * Production sets CODE_AGENT_COMMAND to the organization's Code Agent bridge.
 * This adapter proves the same batch ABI locally by reading the instruction and
 * skills, then invoking the frozen deterministic engine once per submission.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const manifestIndex = args.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? resolve(args[manifestIndex + 1] ?? '') : resolve(process.env.AI_TRAINING_BATCH_MANIFEST ?? '');
if (!manifestPath || !existsSync(manifestPath)) throw new Error('缺少 --manifest <batch-manifest.json>');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!['1.0', '1.1'].includes(manifest.schemaVersion)) throw new Error('不支持的批次清单版本');

// Loading these files is part of the bridge ABI. A real Code Agent bridge adds
// their contents to the agent context; this deterministic adapter only checks
// that the frozen assets are present and readable.
readFileSync(manifest.agent.instructionPath, 'utf8');
for (const skillPath of manifest.agent.skillPaths) readFileSync(join(skillPath, 'SKILL.md'), 'utf8');

const python = process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
const launcher = join(root, 'sandbox', 'launch.py');
const results = [];
const failures = [];
for (const item of manifest.submissions) {
  try {
    const inputPath = join(dirname(item.outputPath), `${item.runId}.input.json`);
    writeFileSync(inputPath, JSON.stringify({
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      engine: {
        id: manifest.engine.id,
        version: manifest.engine.version,
        source: manifest.engine.source,
        packageHash: manifest.engine.packageHash,
        packageRoot: manifest.engine.root,
        assets: manifest.engine.assets,
      },
      challenge: manifest.challenge,
      grading: { runId: item.runId, idempotencyKey: item.idempotencyKey, triggerType: item.triggerType, attempt: item.attempt },
      subject: item.subject,
      submission: item.submission,
      workspace: item.workspace,
      outputPath: item.outputPath,
      scratchDir: item.scratchDir,
      limits: manifest.engine.limits,
      params: manifest.engine.params,
    }, null, 2), 'utf8');
    execFileSync(python, [
      launcher,
      '--entry', manifest.engine.entrypoint,
      '--input', inputPath,
      '--output', item.outputPath,
      '--cwd', item.scratchDir,
      '--python', python,
      '--memory-mb', String(manifest.engine.limits.memoryMB),
      '--cpu-seconds', String(manifest.engine.limits.wallClockSeconds),
      '--wall-seconds', String(manifest.engine.limits.wallClockSeconds),
      '--output-bytes', String(manifest.engine.limits.outputBytes),
    ], { cwd: root, windowsHide: true, stdio: 'pipe' });
    results.push({ runId: item.runId, result: JSON.parse(readFileSync(item.outputPath, 'utf8')) });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    failures.push({ runId: item.runId, reason: details.slice(-2000) });
  }
}
writeFileSync(manifest.resultIndexPath, JSON.stringify({ schemaVersion: '1.0', batchId: manifest.batch.id, results, failures }, null, 2), 'utf8');

--- END FILE: scripts/code-agent-local-bridge.mjs ---


--- BEGIN FILE: scripts/evaluation-worker.mjs ---

#!/usr/bin/env node
/**
 * Pull-based evaluation host worker.
 *
 * The worker never judges a delivery itself. It leases one same-challenge
 * batch, materialises the frozen engine and every selected learner delivery in
 * one isolated folder, then invokes the configured Code Agent bridge with a
 * batch manifest. The bridge writes a result index and this worker returns the
 * whole batch to the platform for schema, score, identity and idempotency
 * validation.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith('--')) continue;
  const next = process.argv[index + 1];
  options.set(key.slice(2), next && !next.startsWith('--') ? (index += 1, next) : 'true');
}

const api = options.get('api') ?? process.env.PLATFORM_API ?? 'http://127.0.0.1:3000/api/v1';
const employeeId = options.get('employee') ?? process.env.PLATFORM_EMPLOYEE_ID ?? 'w00123';
const workerId = options.get('worker') ?? process.env.EVALUATION_WORKER_ID ?? `worker-${process.pid}`;
const intervalSeconds = Math.max(1, Number(options.get('interval') ?? 5));
const once = options.has('once');
const engineCache = resolve(options.get('cache') ?? join(root, 'tmp', 'worker-engines'));
const batchRoot = resolve(options.get('batch-root') ?? process.env.EVALUATION_BATCH_ROOT ?? join(root, 'tmp', 'evaluation-batches'));
const logRoot = resolve(options.get('log-root') ?? process.env.EVALUATION_LOG_ROOT ?? join(root, 'tmp', 'evaluation-logs'));
const keepBatches = options.has('keep-batches') || process.env.EVALUATION_KEEP_BATCHES === 'true';
const python = process.env.PYTHON ?? (existsSync(join(root, '.venv', 'Scripts', 'python.exe')) ? join(root, '.venv', 'Scripts', 'python.exe') : 'python');
const commandLineOverride = options.get('agent-command');
const environmentCodeAgentCommand = process.env.CODE_AGENT_COMMAND;
const DEFAULT_AGENT_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_WORKER_LOG_MAX_BYTES = 16 * 1024 * 1024;
const configuredAgentOutputMaxBytes = Number(process.env.EVALUATION_AGENT_OUTPUT_MAX_BYTES ?? DEFAULT_AGENT_OUTPUT_MAX_BYTES);
const agentOutputMaxBytes = Number.isFinite(configuredAgentOutputMaxBytes)
  ? Math.max(16 * 1024, Math.min(64 * 1024 * 1024, Math.floor(configuredAgentOutputMaxBytes)))
  : DEFAULT_AGENT_OUTPUT_MAX_BYTES;
const configuredWorkerLogMaxBytes = Number(process.env.EVALUATION_WORKER_LOG_MAX_BYTES ?? DEFAULT_WORKER_LOG_MAX_BYTES);
const workerLogMaxBytes = Number.isFinite(configuredWorkerLogMaxBytes)
  ? Math.max(256 * 1024, Math.min(256 * 1024 * 1024, Math.floor(configuredWorkerLogMaxBytes)))
  : DEFAULT_WORKER_LOG_MAX_BYTES;

function safeLogSegment(value, fallback = 'unknown') {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+|\.+$/g, '').slice(0, 96);
  return normalized || fallback;
}

function redactLogText(value, maxBytes = 8192) {
  let text = String(value ?? '');
  text = text
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|proxy-authorization)\s+bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:"?(?:authorization|proxy-authorization|token|access[_-]?token|api[_-]?key|secret|password|cookie|credential)"?)\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/((?:token|access[_-]?token|api[_-]?key|secret|password|cookie|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]+)\b/g, '[REDACTED]');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  return `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}…[TRUNCATED]`;
}

let loggingUnavailable = false;
function appendLogFile(path, content) {
  if (loggingUnavailable) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, content, 'utf8');
  } catch (error) {
    loggingUnavailable = true;
    console.error(`[${workerId}] 日志目录不可写，后续日志仅输出到控制台: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const workerLogDirectory = join(logRoot, safeLogSegment(workerId, 'worker'));
const workerLogPath = join(workerLogDirectory, 'worker.log');
function writeWorkerLog(event, details = {}) {
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    workerId: safeLogSegment(workerId, 'worker'),
    event,
    ...details,
  })}\n`;
  try {
    if (existsSync(workerLogPath) && lstatSync(workerLogPath).size + Buffer.byteLength(line, 'utf8') > workerLogMaxBytes) {
      writeFileSync(workerLogPath, `${JSON.stringify({ timestamp: new Date().toISOString(), workerId: safeLogSegment(workerId, 'worker'), event: 'worker.log_truncated', maxBytes: workerLogMaxBytes })}\n`, 'utf8');
    }
  } catch {
    // appendLogFile below remains the single error-reporting path.
  }
  appendLogFile(workerLogPath, line);
}

function createBatchLog(task) {
  const batchDirectory = join(workerLogDirectory, 'batches', safeLogSegment(task.batchId, 'batch'), safeLogSegment(task.leaseId, 'lease'));
  const interactionPath = join(batchDirectory, 'interaction.jsonl');
  const stdoutPath = join(batchDirectory, 'agent.stdout.log');
  const stderrPath = join(batchDirectory, 'agent.stderr.log');
  appendLogFile(stdoutPath, '');
  appendLogFile(stderrPath, '');
  const outputBytes = { stdout: 0, stderr: 0 };
  const outputTruncated = { stdout: false, stderr: false };
  const writeInteraction = (event, details = {}) => appendLogFile(interactionPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    workerId: safeLogSegment(workerId, 'worker'),
    batchId: task.batchId,
    leaseId: task.leaseId,
    event,
    ...details,
  })}\n`);
  const appendAgentOutput = (stream, value) => {
    const redacted = redactLogText(value, agentOutputMaxBytes);
    const bytes = Buffer.byteLength(redacted, 'utf8');
    const remaining = Math.max(0, agentOutputMaxBytes - outputBytes[stream]);
    if (!remaining) {
      if (!outputTruncated[stream]) {
        outputTruncated[stream] = true;
        writeInteraction('agent.output_truncated', { stream, maxBytes: agentOutputMaxBytes });
      }
      return;
    }
    const truncationMarker = '\n[TRUNCATED]\n';
    const clipLimit = Math.max(0, remaining - Buffer.byteLength(truncationMarker, 'utf8'));
    const clipped = bytes > remaining ? `${Buffer.from(redacted, 'utf8').subarray(0, clipLimit).toString('utf8')}${truncationMarker}` : redacted;
    const path = stream === 'stdout' ? stdoutPath : stderrPath;
    appendLogFile(path, clipped);
    outputBytes[stream] += Buffer.byteLength(clipped, 'utf8');
    if (bytes > remaining) outputTruncated[stream] = true;
    writeInteraction('agent.output', {
      stream,
      bytes: Buffer.byteLength(clipped, 'utf8'),
      preview: redactLogText(value, 4096),
      truncated: bytes > remaining,
    });
  };
  return {
    directory: batchDirectory,
    writeInteraction,
    appendAgentOutput,
    paths: { interaction: interactionPath, stdout: stdoutPath, stderr: stderrPath },
  };
}

let codeAgentArgs;
try {
  codeAgentArgs = JSON.parse(options.get('agent-args-json') ?? process.env.CODE_AGENT_ARGS_JSON ?? '[]');
  if (!Array.isArray(codeAgentArgs) || codeAgentArgs.some((value) => typeof value !== 'string')) throw new Error('must be a JSON string array');
} catch (error) {
  writeWorkerLog('worker.config_error', { reason: redactLogText(error instanceof Error ? error.message : String(error), 1000) });
  throw new Error(`CODE_AGENT_ARGS_JSON 配置错误: ${error.message}`);
}

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-employee-id': employeeId, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`);
  return response;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJsonFile(path, maxBytes, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${label}不存在`);
  const size = lstatSync(path).size;
  if (size > maxBytes) throw new Error(`${label}超过大小限制（${size} > ${maxBytes}）`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function canonicalBytes(value) {
  if (value.includes(0)) return value;
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) return value;
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

function directoryHash(value) {
  const directory = realpathSync(resolve(value));
  const ignoredDirectories = new Set(['.git', '.venv', '__pycache__', '.mypy_cache', '.pytest_cache']);
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (ignoredDirectories.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).split('\\').join('/');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && !/\.(?:pyc|pyo)$/i.test(entry.name)) entries.push({ path, absolute });
      else if (entry.isSymbolicLink()) throw new Error(`目录中包含符号链接: ${path}`);
    }
  };
  walk(directory);
  const digest = createHash('sha256');
  for (const entry of entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const contentHash = sha256(canonicalBytes(readFileSync(entry.absolute)));
    const executable = lstatSync(entry.absolute).mode & 0o111 ? '1' : '0';
    digest.update(`${entry.path}\0${contentHash}\0${executable}\n`, 'utf8');
  }
  return digest.digest('hex');
}

function builtInEngineHash(engineHash, dependencies = []) {
  const digest = createHash('sha256');
  digest.update(`engine\0${engineHash}\n`, 'utf8');
  for (const dependency of [...dependencies].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    digest.update(`${dependency.name}\0${dependency.repositoryPath}\0${dependency.contentHash}\n`, 'utf8');
  }
  return digest.digest('hex');
}

function safeExtract(archive, target) {
  mkdirSync(target, { recursive: true });
  execFileSync(python, ['-c', [
    'import pathlib, stat, sys, zipfile',
    'archive, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()',
    'with zipfile.ZipFile(archive) as z:',
    '    for info in z.infolist():',
    '        path = pathlib.PurePosixPath(info.filename.replace("\\\\", "/"))',
    '        if path.is_absolute() or ".." in path.parts: raise SystemExit("archive path escapes root")',
    '        mode = (info.external_attr >> 16) & 0xffff',
    '        if stat.S_ISLNK(mode): raise SystemExit("archive symlink is not allowed")',
    '        destination = (target / path).resolve()',
    '        if destination != target and target not in destination.parents: raise SystemExit("archive path escapes root")',
    '        if info.is_dir(): destination.mkdir(parents=True, exist_ok=True); continue',
    '        destination.parent.mkdir(parents=True, exist_ok=True)',
    '        destination.write_bytes(z.read(info))',
  ].join('\n'), archive, target], { cwd: root, windowsHide: true, stdio: 'pipe' });
}

function assertInside(base, target, label) {
  const resolvedBase = existsSync(base) ? realpathSync(resolve(base)) : resolve(base);
  const resolvedTarget = existsSync(target) ? realpathSync(resolve(target)) : resolve(target);
  const relativePath = relative(resolvedBase, resolvedTarget);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} 超出允许目录`);
  }
}

function materializeProtocolContract(reference, target, label) {
  if (!reference || reference.format !== 'JSON' || !reference.schemaVersion || !reference.contractPath) {
    throw new Error(`${label}配置不完整`);
  }
  const source = resolve(root, reference.contractPath);
  assertInside(root, source, label);
  if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`${label}不存在: ${reference.contractPath}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  return {
    format: 'JSON',
    schemaVersion: reference.schemaVersion,
    sourcePath: reference.contractPath,
    path: target,
    sha256: sha256(readFileSync(target)),
  };
}

/** Materialise one verified engine copy inside this batch folder. */
async function materializeEngine(task, target) {
  let source;
  const runtimeAssets = {};
  if (task.engine.source === 'BUILT_IN') {
    source = join(root, 'executors', task.engine.id);
    if (!existsSync(join(source, 'engine.json'))) throw new Error(`内置执行器不存在: ${task.engine.id}`);
    const dependencies = task.engine.platformDependencies ?? [];
    for (const dependency of dependencies) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(dependency.name)) throw new Error(`评测引擎依赖名称不合法: ${dependency.name}`);
      const dependencySource = resolve(root, dependency.repositoryPath);
      assertInside(root, dependencySource, `评测引擎依赖 ${dependency.name}`);
      if (!existsSync(dependencySource) || directoryHash(dependencySource) !== dependency.contentHash) {
        throw new Error(`评测引擎依赖哈希不一致: ${dependency.name}`);
      }
    }
    const actualHash = builtInEngineHash(directoryHash(source), dependencies);
    if (actualHash !== task.engine.packageHash) throw new Error(`内置执行器哈希不一致: ${task.engine.id}`);
  } else {
    const cached = join(engineCache, task.engine.packageHash);
    if (!existsSync(join(cached, 'engine.json'))) {
      mkdirSync(engineCache, { recursive: true });
      const response = await call(`/evaluation-engines/${task.engine.packageHash}/package`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== task.engine.packageHash) throw new Error('下载的评测引擎包哈希不一致');
      const archive = join(engineCache, `${task.engine.packageHash}.zip`);
      const staging = `${cached}.${process.pid}.staging`;
      rmSync(staging, { recursive: true, force: true });
      writeFileSync(archive, bytes);
      safeExtract(archive, staging);
      if (!existsSync(join(staging, 'engine.json'))) throw new Error('评测引擎包缺少 engine.json');
      if (!existsSync(cached)) cpSync(staging, cached, { recursive: true, dereference: false });
      rmSync(staging, { recursive: true, force: true });
    }
    source = cached;
  }
  cpSync(source, target, { recursive: true, dereference: false });
  for (const dependency of task.engine.platformDependencies ?? []) {
    const destination = join(target, '_platform', dependency.name, basename(dependency.repositoryPath));
    cpSync(resolve(root, dependency.repositoryPath), destination, { recursive: true, dereference: false });
    runtimeAssets[dependency.name] = destination;
  }
  return { root: target, runtimeAssets };
}

async function materializeSubmission(item, target) {
  const workspace = join(target, 'workspace');
  mkdirSync(workspace, { recursive: true });
  if (item.submission.artifactUrl) {
    const response = await call(item.submission.artifactUrl.replace('/api/v1', ''));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (item.submission.artifactHash && sha256(bytes) !== item.submission.artifactHash) {
      throw new Error(`交付件字节哈希不一致: ${item.submission.id}`);
    }
    const archive = join(target, 'delivery.zip');
    writeFileSync(archive, bytes);
    safeExtract(archive, workspace);
  } else if (item.submission.workspacePath) {
    const source = resolve(root, item.submission.workspacePath);
    assertInside(root, source, '本地交付目录');
    cpSync(source, workspace, { recursive: true, dereference: false });
  } else {
    throw new Error(`提交没有可物化的交付件: ${item.submission.id}`);
  }
  const actualSnapshotHash = directoryHash(workspace);
  if (actualSnapshotHash !== item.submission.snapshotHash) {
    throw new Error(`交付快照哈希不一致: ${item.submission.id}`);
  }
  return workspace;
}

function copyChallengeAssets(task, target) {
  const assets = {};
  for (const [key, value] of Object.entries(task.engine.assets ?? {})) {
    if (value) assets[key] = join(target, 'engine', value);
  }
  if (task.engine.source !== 'BUILT_IN') return assets;
  const challengeAssetsRoot = join(target, 'challenge-assets');
  for (const [key, value] of Object.entries(task.engine.params ?? {})) {
    if (typeof value !== 'string' || !/(?:Path|Dir)$/.test(key)) continue;
    const source = resolve(root, value);
    assertInside(root, source, `评测参数 ${key}`);
    if (!existsSync(source)) throw new Error(`评测参数路径不存在: ${value}`);
    const destination = join(challengeAssetsRoot, `${key}-${basename(source)}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: false });
    if (key === 'contractPath') assets.submissionContract = destination;
    else if (key === 'testsDir') assets.testsDir = destination;
    else assets[key] = destination;
  }
  return assets;
}

function mandatoryAgentPrompt(configuredPrompt, manifestPath) {
  return [
    configuredPrompt?.trim(),
    '执行 AI 训战平台评测批次。',
    `批次清单：${manifestPath}`,
    '读取清单中的 instructionPath 和全部 skillPaths，只处理 submissions 中列出的交付件。',
    '逐份使用清单指定的评测引擎，将单人结果写入 outputPath，最后将批次索引写入 resultIndexPath。',
    '输出必须符合清单中 contracts.output.path 指向的 JSON Schema；不得修改交付快照、评测引擎或契约。',
  ].filter(Boolean).join('\n\n');
}

function platformInvocation(runtime, manifestPath, cwd) {
  const prompt = mandatoryAgentPrompt(runtime.prompt, manifestPath);
  let promptInjected = false;
  let manifestInjected = false;
  const values = { prompt, manifestPath, batchDir: cwd };
  const args = runtime.args.map((raw) => raw.replace(/\{\{(prompt|manifestPath|batchDir)\}\}/g, (_match, key) => {
    if (key === 'prompt') promptInjected = true;
    if (key === 'manifestPath') manifestInjected = true;
    return values[key];
  }));
  if (!promptInjected) {
    const promptFlag = args.findIndex((value) => value === '--prompt' || value === '-p');
    const inlinePrompt = args.findIndex((value) => value.startsWith('--prompt='));
    if (promptFlag >= 0) {
      if (args[promptFlag + 1] === undefined) args.push(prompt);
      else args[promptFlag + 1] = `${args[promptFlag + 1]}\n\n${prompt}`;
      promptInjected = true;
    } else if (inlinePrompt >= 0) {
      args[inlinePrompt] = `${args[inlinePrompt]}\n\n${prompt}`;
      promptInjected = true;
    }
  }
  // A bridge generally has no prompt option and expects the legacy manifest
  // flag. A direct agent command receives the path inside the mandatory prompt.
  if (!promptInjected && !manifestInjected) args.push('--manifest', manifestPath);

  const allowed = (process.env.CODE_AGENT_ALLOWED_EXECUTABLES ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (allowed.length) {
    const executable = runtime.executable.toLowerCase();
    const executableName = basename(runtime.executable).toLowerCase();
    if (!allowed.includes(executable) && !allowed.includes(executableName)) {
      throw new Error(`平台配置的 Code Agent 可执行文件不在 Worker 允许列表中: ${basename(runtime.executable)}`);
    }
  }
  return { command: runtime.executable, args };
}

function resolveCodeAgentInvocation(task, manifestPath, cwd) {
  if (commandLineOverride) return { command: commandLineOverride, args: [...codeAgentArgs, '--manifest', manifestPath] };
  if (task.codeAgentRuntime?.executable) return platformInvocation(task.codeAgentRuntime, manifestPath, cwd);
  if (environmentCodeAgentCommand) return { command: environmentCodeAgentCommand, args: [...codeAgentArgs, '--manifest', manifestPath] };
  return null;
}

function runCodeAgent(task, manifestPath, cwd, timeoutMs, batchLog) {
  const invocation = resolveCodeAgentInvocation(task, manifestPath, cwd);
  if (!invocation) {
    throw new Error('未配置 CODE_AGENT_COMMAND；请将它指向实现 Code Agent batch bridge 契约的可执行文件');
  }
  const promptIndex = invocation.args.findIndex((value) => value === '--prompt' || value === '-p' || value.startsWith('--prompt='));
  const prompt = promptIndex >= 0
    ? (invocation.args[promptIndex].startsWith('--prompt=') ? invocation.args[promptIndex].slice('--prompt='.length) : invocation.args[promptIndex + 1])
    : null;
  batchLog.writeInteraction('agent.start', {
    command: redactLogText(invocation.command, 1024),
    args: invocation.args.map((value) => redactLogText(value, 4096)),
    prompt: prompt ? redactLogText(prompt, 8192) : null,
    workingDirectory: redactLogText(cwd, 2048),
    manifestPath: redactLogText(manifestPath, 2048),
    timeoutSeconds: Math.ceil(timeoutMs / 1000),
  });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, AI_TRAINING_BATCH_MANIFEST: manifestPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      batchLog.writeInteraction('agent.timeout', { timeoutSeconds: Math.ceil(timeoutMs / 1000) });
      reject(new Error(`Code Agent bridge 批次执行超时（${Math.ceil(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      if (stdout.length < agentOutputMaxBytes) stdout += value.slice(0, agentOutputMaxBytes - stdout.length);
      batchLog.appendAgentOutput('stdout', value);
    });
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString();
      if (stderr.length < agentOutputMaxBytes) stderr += value.slice(0, agentOutputMaxBytes - stderr.length);
      batchLog.appendAgentOutput('stderr', value);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      batchLog.writeInteraction('agent.error', { reason: redactLogText(error.message, 2000) });
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      batchLog.writeInteraction('agent.exit', {
        code: code ?? null,
        signal: signal ?? null,
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
      });
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`Code Agent bridge 退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）: ${redactLogText(stderr.trim().slice(-1000), 1000)}`));
    });
  });
}

async function runBatch(task) {
  mkdirSync(batchRoot, { recursive: true });
  const directory = mkdtempSync(join(batchRoot, `${task.batchId}-`));
  const batchLog = createBatchLog(task);
  batchLog.writeInteraction('batch.start', {
    submissions: task.submissions.length,
    engine: `${task.engine.id}@${task.engine.version}`,
    batchDirectory: redactLogText(directory, 2048),
    logDirectory: redactLogText(batchLog.directory, 2048),
  });
  writeWorkerLog('batch.start', { batchId: task.batchId, leaseId: task.leaseId, submissions: task.submissions.length, engine: `${task.engine.id}@${task.engine.version}` });
  let heartbeat;
  try {
    const materializedEngine = await materializeEngine(task, join(directory, 'engine'));
    const engineRoot = materializedEngine.root;
    const assets = { ...copyChallengeAssets(task, directory), ...materializedEngine.runtimeAssets };
    const resultsRoot = join(directory, 'results');
    mkdirSync(resultsRoot, { recursive: true });
    const submissions = [];
    for (const item of task.submissions) {
      const submissionRoot = join(directory, 'submissions', item.submission.id);
      const workspace = await materializeSubmission(item, submissionRoot);
      submissions.push({
        ...item,
        workspace,
        outputPath: join(resultsRoot, `${item.runId}.json`),
        scratchDir: join(submissionRoot, 'scratch'),
      });
      mkdirSync(submissions.at(-1).scratchDir, { recursive: true });
    }
    const resultIndexPath = join(resultsRoot, 'index.json');
    const manifestPath = join(directory, 'batch-manifest.json');
    const contractsRoot = join(directory, 'contracts');
    const contracts = {
      input: materializeProtocolContract(task.contracts?.input, join(contractsRoot, 'batch-input.schema.json'), '批次输入契约'),
      output: materializeProtocolContract(task.contracts?.output, join(contractsRoot, 'evaluation-result.schema.json'), '评测结果契约'),
    };
    const instructionPath = join(engineRoot, task.engine.agent.instruction);
    const skillPaths = task.engine.agent.skills.map((path) => join(engineRoot, path));
    const manifest = {
      schemaVersion: '1.1',
      generatedAt: new Date().toISOString(),
      batch: { id: task.batchId, leaseId: task.leaseId, challengeVersion: task.challenge.challengeVersion },
      agent: { instructionPath, skillPaths },
      contracts,
      engine: {
        id: task.engine.id,
        version: task.engine.version,
        source: task.engine.source,
        packageHash: task.engine.packageHash,
        root: engineRoot,
        entrypoint: join(engineRoot, task.engine.entrypoint),
        assets,
        params: task.engine.params ?? {},
        limits: task.engine.limits,
      },
      challenge: task.challenge,
      submissions,
      resultIndexPath,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    batchLog.writeInteraction('batch.manifest_ready', {
      manifestPath: redactLogText(manifestPath, 2048),
      resultIndexPath: redactLogText(resultIndexPath, 2048),
      instructionPath: redactLogText(instructionPath, 2048),
      skillCount: skillPaths.length,
    });
    const heartbeatMs = Math.max(15_000, Number(process.env.EVALUATION_HEARTBEAT_SECONDS ?? 60) * 1000);
    heartbeat = setInterval(() => {
      void call(`/evaluation-batches/${task.batchId}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ leaseId: task.leaseId }),
      }).catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[${workerId}] 批次心跳失败 ${task.batchId}: ${reason}`);
        batchLog.writeInteraction('batch.heartbeat_failed', { reason: redactLogText(reason, 2000) });
        writeWorkerLog('batch.heartbeat_failed', { batchId: task.batchId, leaseId: task.leaseId, reason: redactLogText(reason, 2000) });
      });
    }, heartbeatMs);
    const defaultBatchTimeoutSeconds = Math.max(300, Math.min(
      21_600,
      Number(task.engine.limits?.wallClockSeconds ?? 600) * task.submissions.length + 300,
    ));
    const batchTimeoutSeconds = Number(
      options.get('agent-timeout-seconds')
      ?? process.env.CODE_AGENT_BATCH_TIMEOUT_SECONDS
      ?? task.codeAgentRuntime?.timeoutSeconds
      ?? defaultBatchTimeoutSeconds,
    );
    if (!Number.isFinite(batchTimeoutSeconds) || batchTimeoutSeconds <= 0) {
      throw new Error('CODE_AGENT_BATCH_TIMEOUT_SECONDS 必须是正数');
    }
    batchLog.writeInteraction('batch.timeout_configured', { timeoutSeconds: batchTimeoutSeconds, heartbeatSeconds: Math.ceil(heartbeatMs / 1000) });
    await runCodeAgent(task, manifestPath, directory, batchTimeoutSeconds * 1000, batchLog);
    if (!existsSync(resultIndexPath)) throw new Error('Code Agent 未生成批次结果索引');
    const perResultLimit = Math.max(1024, Number(task.engine.limits?.outputBytes ?? 5 * 1024 * 1024));
    const resultIndexLimit = Math.min(
      64 * 1024 * 1024,
      Math.max(1024 * 1024, perResultLimit * task.submissions.length + 1024 * 1024),
    );
    const index = readJsonFile(resultIndexPath, resultIndexLimit, 'Code Agent 批次结果索引');
    if (index.schemaVersion !== '1.0' || index.batchId !== task.batchId || !Array.isArray(index.results) || !Array.isArray(index.failures ?? [])) {
      throw new Error('Code Agent 批次结果索引不符合契约');
    }
    const expectedRunIds = new Set(task.submissions.map((item) => item.runId));
    const returnedRunIds = new Set();
    for (const item of [...index.results, ...(index.failures ?? [])]) {
      if (!item || typeof item.runId !== 'string' || !expectedRunIds.has(item.runId)) {
        throw new Error('Code Agent 批次结果包含范围外的 runId');
      }
      if (returnedRunIds.has(item.runId)) throw new Error(`Code Agent 批次结果重复返回 runId：${item.runId}`);
      returnedRunIds.add(item.runId);
    }
    for (const item of index.failures ?? []) {
      if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error(`Code Agent 未提供失败原因：${item.runId}`);
    }
    const results = index.results.map((item) => {
      let resultFile;
      if (item.resultPath) {
        resultFile = resolve(directory, item.resultPath);
        assertInside(resultsRoot, resultFile, '评测结果路径');
      }
      const output = item.result ?? readJsonFile(resultFile ?? join(resultsRoot, `${item.runId}.json`), perResultLimit, '单份评测结果');
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error(`单份评测结果必须是 JSON 对象：${item.runId}`);
      if (item.result && Buffer.byteLength(JSON.stringify(item.result), 'utf8') > perResultLimit) {
        throw new Error(`单份评测结果超过大小限制：${item.runId}`);
      }
      return { runId: item.runId, result: output };
    });
    batchLog.writeInteraction('batch.results_validated', { results: results.length, failures: (index.failures ?? []).length });
    writeWorkerLog('batch.agent_completed', { batchId: task.batchId, leaseId: task.leaseId, results: results.length, failures: (index.failures ?? []).length });
    return { directory, results, failures: index.failures ?? [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    batchLog.writeInteraction('batch.failed', { reason: redactLogText(reason, 4000) });
    writeWorkerLog('batch.failed', { batchId: task.batchId, leaseId: task.leaseId, reason: redactLogText(reason, 2000) });
    if (!keepBatches) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function pump() {
  writeWorkerLog('lease.request', { api: redactLogText(api, 1024), limit: Number(options.get('batches') ?? 1) });
  const response = await call('/evaluation-batches:lease', {
    method: 'POST',
    body: JSON.stringify({ workerId, limit: Number(options.get('batches') ?? 1) }),
  });
  const { batches } = await response.json();
  writeWorkerLog('lease.response', { count: batches.length });
  for (const task of batches) {
    console.log(`[${workerId}] 领取批次 ${task.batchId} · ${task.submissions.length} 份提交 · ${task.engine.id}@${task.engine.version}`);
    writeWorkerLog('batch.leased', { batchId: task.batchId, leaseId: task.leaseId, submissions: task.submissions.length, engine: `${task.engine.id}@${task.engine.version}` });
    let output;
    try {
      output = await runBatch(task);
      const completed = await call(`/evaluation-batches/${task.batchId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ leaseId: task.leaseId, results: output.results, failures: output.failures }),
      });
      const summary = await completed.json();
      console.log(`[${workerId}] 完成批次 ${task.batchId} · 成功 ${summary.accepted?.length ?? 0} · 失败 ${summary.rejected?.length ?? 0}`);
      writeWorkerLog('batch.completed', { batchId: task.batchId, leaseId: task.leaseId, accepted: summary.accepted?.length ?? 0, rejected: summary.rejected?.length ?? 0 });
      if (!keepBatches) rmSync(output.directory, { recursive: true, force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[${workerId}] 批次失败 ${task.batchId}: ${reason}`);
      writeWorkerLog('batch.failure_reported', { batchId: task.batchId, leaseId: task.leaseId, reason: redactLogText(reason, 2000) });
      await call(`/evaluation-batches/${task.batchId}/fail`, {
        method: 'POST',
        body: JSON.stringify({ leaseId: task.leaseId, reason }),
      }).catch(() => undefined);
    }
  }
  return batches.length;
}

console.log(`[${workerId}] 评测 Worker 已启动 · API ${redactLogText(api, 1024)} · 日志 ${redactLogText(workerLogDirectory, 1024)}${once ? ' · 单次模式' : ` · 轮询 ${intervalSeconds}s`}`);
writeWorkerLog('worker.start', {
  api: redactLogText(api, 1024),
  once,
  intervalSeconds,
  batchRoot: redactLogText(batchRoot, 1024),
  logRoot: redactLogText(logRoot, 1024),
  logDirectory: redactLogText(workerLogDirectory, 1024),
  keepBatches,
  agentOutputMaxBytes,
});
do {
  const handled = await pump().catch((error) => {
    console.error(`[${workerId}] 领取批次失败: ${error.message}`);
    writeWorkerLog('worker.pump_error', { reason: redactLogText(error instanceof Error ? error.message : String(error), 2000) });
    return 0;
  });
  if (once) break;
  if (!handled) await new Promise((done) => setTimeout(done, intervalSeconds * 1000));
} while (true);

--- END FILE: scripts/evaluation-worker.mjs ---


--- BEGIN FILE: services/ldap3-gateway/.env.example ---

LDAP_SERVER=china.huawei.com
LDAP_PORT=389
LDAP_USE_SSL=false
LDAP_START_TLS=true
LDAP_CA_CERT_FILE=/etc/ssl/certs/company-ldap-ca.pem
LDAP_BASE_DN=dc=china,dc=huawei,dc=com
LDAP_BIND_PREFIX=China\
LDAP_ACCOUNT_ATTRIBUTE=sAMAccountName
LDAP_TITLE_ATTRIBUTE=title
LDAP_DEPARTMENT_ATTRIBUTE=department
LDAP_NAME_ATTRIBUTE=displayName
LDAP_TIMEOUT_SECONDS=5

# Generate independent random values; never commit real secrets.
LDAP_GATEWAY_SESSION_SECRET=replace-with-a-random-32-plus-character-secret
TRUSTED_GATEWAY_HMAC_SECRET=replace-with-the-platform-shared-secret
LDAP_GATEWAY_SESSION_TTL_SECONDS=28800
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
LDAP_GATEWAY_COOKIE_SECURE=true
LDAP_GATEWAY_HOST=0.0.0.0
LDAP_GATEWAY_PORT=8081

--- END FILE: services/ldap3-gateway/.env.example ---


--- BEGIN FILE: services/ldap3-gateway/Dockerfile ---

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LDAP_GATEWAY_HOST=0.0.0.0 \
    LDAP_GATEWAY_PORT=8081

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && useradd --system --uid 10001 --create-home gateway

COPY ldap3_gateway.py ./ldap3_gateway.py
COPY static ./static

USER gateway
EXPOSE 8081
CMD ["python", "ldap3_gateway.py"]

--- END FILE: services/ldap3-gateway/Dockerfile ---


--- BEGIN FILE: services/ldap3-gateway/README.md ---

# LDAP3 统一认证网关适配器

这个目录把内网提供的 LDAP3 登录逻辑接到平台已经实现的 `TRUSTED_GATEWAY` 身份协议。LDAP 密码只在网关的 `/auth/login` 请求中短暂存在，不会进入 Platform API、浏览器 Cookie、日志或平台数据库。

## 运行

```powershell
cd services/ldap3-gateway
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

$env:LDAP_SERVER = 'china.huawei.com'
$env:LDAP_PORT = '389'
$env:LDAP_USE_SSL = 'false'
$env:LDAP_START_TLS = 'true'
$env:LDAP_CA_CERT_FILE = 'C:\certs\company-ldap-ca.pem'
$env:LDAP_BASE_DN = 'dc=china,dc=huawei,dc=com'
$env:LDAP_BIND_PREFIX = 'China\'
$env:LDAP_GATEWAY_SESSION_SECRET = '<随机生成的至少 32 字符会话密钥>'
$env:TRUSTED_GATEWAY_HMAC_SECRET = '<与 Platform API 相同的密钥>'
$env:LDAP_GATEWAY_COOKIE_SECURE = 'true'
python ldap3_gateway.py
```

生产环境应使用 LDAPS 或 StartTLS，并通过进程环境注入密钥；不要把真实密钥、账号或员工信息写入仓库。`LDAP_GATEWAY_COOKIE_SECURE=false` 只适合本机 HTTP 验收。

### 直接 clone 后用 Docker 部署

仓库已经包含登录页、依赖和 Dockerfile，不需要再单独开发登录前端：

```bash
cd services/ldap3-gateway
cp .env.example .env
# 编辑 .env，至少替换两个密钥，并填写 LDAP CA 证书路径
docker build -t platform-ldap-gateway:local .
docker run --rm --name platform-ldap-gateway \
  --env-file .env \
  -p 127.0.0.1:8081:8081 \
  platform-ldap-gateway:local
```

如果启用了 `LDAP_CA_CERT_FILE`，还要把宿主机证书以只读方式挂载到容器内同一路径，例如：

```bash
docker run --rm --name platform-ldap-gateway \
  --env-file .env \
  -v /etc/company/certs/ldap-ca.pem:/etc/ssl/certs/company-ldap-ca.pem:ro \
  -p 127.0.0.1:8081:8081 \
  platform-ldap-gateway:local
```

登录页面地址是 `/auth/login`，登录成功后由反向代理调用 `/auth/verify`，再把可信身份头转发给 Platform API。完整的 Nginx 配置和验收清单见仓库的 LDAP3 接入指南。

## 网关接入方式

- `GET /auth/login`：返回登录页；`POST /auth/login` 接收 `userId`、`password`，LDAP 绑定成功后设置 HttpOnly 会话 Cookie。
- `GET /auth/verify`：供 Nginx、Ingress 或现有统一认证网关的 `auth_request` 调用。成功时返回五个 `X-Trusted-*` 响应头，反向代理必须把它们复制到发往 Platform API 的请求头。
- `GET /auth/session`：返回不含签名的当前会话信息，仅用于登录页调试。
- `POST /auth/logout`：清理会话 Cookie。
- `GET /brand-logo.png`：提供与主站一致的品牌 Logo，不需要登录。
- `GET /login-logo.png`：提供登录页使用的云图标，不需要登录。
- `GET /healthz`：健康检查，不需要登录。

平台 API 配置仍然是：

```env
NODE_ENV=production
PLATFORM_IDENTITY_MODE=TRUSTED_GATEWAY
TRUSTED_GATEWAY_HMAC_SECRET=<与网关相同的密钥>
TRUSTED_GATEWAY_MAX_AGE_SECONDS=90
```

反向代理必须先删除浏览器传入的 `X-Employee-Id` 和 `X-Trusted-*`，再从 `/auth/verify` 的响应头重新写入。具体 HMAC 字段、Nginx `auth_request` 示例和上线验收请阅读 [`docs/deployment/ldap3-trusted-gateway.md`](../../docs/deployment/ldap3-trusted-gateway.md) 和 [`docs/deployment/trusted-gateway-sso.md`](../../docs/deployment/trusted-gateway-sso.md)。

## 测试

测试使用假的 LDAP 连接，不会连接真实内网目录：

```powershell
python services/ldap3-gateway/test_ldap3_gateway.py
```

--- END FILE: services/ldap3-gateway/README.md ---


--- BEGIN FILE: services/ldap3-gateway/ldap3_gateway.py ---

#!/usr/bin/env python3
"""LDAP3-backed identity adapter for the platform's trusted gateway.

The platform API does not receive LDAP credentials.  This small WSGI service
authenticates a browser session against Active Directory, then exposes a
session verification endpoint for the reverse proxy.  The reverse proxy
copies the signed identity headers returned by that endpoint to the platform
API, which remains in ``TRUSTED_GATEWAY`` mode.

The module intentionally has no framework dependency.  Install ``ldap3`` from
``requirements.txt`` and run it behind the internal HTTPS gateway.  It does
not log passwords, LDAP assertions, cookies or identity headers.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import ssl
import time
from dataclasses import dataclass
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from typing import Any, Callable, Mapping, MutableMapping, Sequence
from urllib.parse import parse_qs


class LdapGatewayError(Exception):
    """Base class for errors that should not expose LDAP internals."""


class LdapAuthenticationError(LdapGatewayError):
    """The supplied credentials cannot be authenticated."""


class LdapProfileError(LdapGatewayError):
    """The account authenticated but its platform profile is incomplete."""


class InvalidSessionError(LdapGatewayError):
    """The gateway session cookie is missing, invalid or expired."""


@dataclass(frozen=True)
class LdapConfig:
    server: str = "china.huawei.com"
    port: int = 389
    use_ssl: bool = False
    start_tls: bool = False
    base_dn: str = "dc=china,dc=huawei,dc=com"
    bind_prefix: str = "China\\"
    account_attribute: str = "sAMAccountName"
    title_attribute: str = "title"
    department_attribute: str = "department"
    name_attribute: str = "displayName"
    ca_cert_file: str | None = None
    timeout_seconds: int = 5

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "LdapConfig":
        values = os.environ if env is None else env
        server = values.get("LDAP_SERVER", "china.huawei.com").strip()
        base_dn = values.get("LDAP_BASE_DN", "dc=china,dc=huawei,dc=com").strip()
        if not server:
            raise ValueError("LDAP_SERVER is required")
        if not base_dn:
            raise ValueError("LDAP_BASE_DN is required")
        port = _positive_int(values, "LDAP_PORT", 389, 1, 65535)
        timeout = _positive_int(values, "LDAP_TIMEOUT_SECONDS", 5, 1, 60)
        use_ssl = _boolean(values.get("LDAP_USE_SSL"), False)
        start_tls = _boolean(values.get("LDAP_START_TLS"), False)
        if use_ssl and start_tls:
            raise ValueError("LDAP_USE_SSL and LDAP_START_TLS cannot both be enabled")
        return cls(
            server=server,
            port=port,
            use_ssl=use_ssl,
            start_tls=start_tls,
            base_dn=base_dn,
            bind_prefix=values.get("LDAP_BIND_PREFIX", "China\\"),
            account_attribute=_attribute_name(values.get("LDAP_ACCOUNT_ATTRIBUTE", "sAMAccountName")),
            title_attribute=_attribute_name(values.get("LDAP_TITLE_ATTRIBUTE", "title")),
            department_attribute=_attribute_name(values.get("LDAP_DEPARTMENT_ATTRIBUTE", "department")),
            name_attribute=_attribute_name(values.get("LDAP_NAME_ATTRIBUTE", "displayName")),
            ca_cert_file=values.get("LDAP_CA_CERT_FILE", "").strip() or None,
            timeout_seconds=timeout,
        )


@dataclass(frozen=True)
class GatewayConfig:
    ldap: LdapConfig
    trusted_gateway_secret: str
    session_secret: str
    session_ttl_seconds: int = 8 * 60 * 60
    trusted_gateway_max_age_seconds: int = 90
    cookie_name: str = "platform_ldap_session"
    csrf_cookie_name: str = "platform_ldap_csrf"
    cookie_secure: bool = True

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "GatewayConfig":
        values = os.environ if env is None else env
        trusted_secret = values.get("TRUSTED_GATEWAY_HMAC_SECRET", "").strip()
        session_secret = values.get("LDAP_GATEWAY_SESSION_SECRET", "").strip()
        if len(trusted_secret) < 32:
            raise ValueError("TRUSTED_GATEWAY_HMAC_SECRET must contain at least 32 characters")
        if len(session_secret) < 32:
            raise ValueError("LDAP_GATEWAY_SESSION_SECRET must contain at least 32 characters")
        return cls(
            ldap=LdapConfig.from_env(values),
            trusted_gateway_secret=trusted_secret,
            session_secret=session_secret,
            session_ttl_seconds=_positive_int(values, "LDAP_GATEWAY_SESSION_TTL_SECONDS", 8 * 60 * 60, 300, 7 * 24 * 60 * 60),
            trusted_gateway_max_age_seconds=_positive_int(values, "TRUSTED_GATEWAY_MAX_AGE_SECONDS", 90, 1, 300),
            cookie_name=values.get("LDAP_GATEWAY_COOKIE_NAME", "platform_ldap_session").strip() or "platform_ldap_session",
            csrf_cookie_name=values.get("LDAP_GATEWAY_CSRF_COOKIE_NAME", "platform_ldap_csrf").strip() or "platform_ldap_csrf",
            cookie_secure=_boolean(values.get("LDAP_GATEWAY_COOKIE_SECURE"), True),
        )


@dataclass(frozen=True)
class LdapUser:
    employee_no: str
    name: str
    department: str = ""


def _positive_int(values: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = values.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _boolean(raw: str | None, default: bool) -> bool:
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError("boolean environment values must be true or false")


def _attribute_name(value: str) -> str:
    candidate = value.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", candidate):
        raise ValueError("LDAP attribute names must contain only ASCII letters, digits, underscores or hyphens")
    return candidate


def _load_ldap3() -> Any:
    try:
        import ldap3  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - exercised by deployment, not unit tests
        raise LdapGatewayError("ldap3 is not installed in the gateway environment") from exc
    return ldap3


def escape_filter_value(value: str) -> str:
    """Escape an RFC 4515 filter value, including UTF-8 octets."""

    escaped: list[str] = []
    for byte in value.encode("utf-8"):
        if byte in {0x00, 0x28, 0x29, 0x2A, 0x5C} or byte >= 0x80:
            escaped.append(f"\\{byte:02x}")
        else:
            escaped.append(chr(byte))
    return "".join(escaped)


def _safe_user_id(user_id: str) -> str:
    value = user_id.strip()
    # The bind name is a Windows DOMAIN\\user value.  Keep it deliberately
    # narrow and reject separators/control characters before LDAP is called.
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value):
        raise LdapAuthenticationError("工号格式不正确")
    return value


def _entry_value(entry: Any, attribute: str) -> str:
    if isinstance(entry, Mapping):
        value = entry.get(attribute)
    else:
        try:
            value = getattr(entry, attribute)
        except AttributeError:
            return ""
    if hasattr(value, "value"):
        value = value.value
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    return str(value).strip() if value is not None else ""


def _safe_identity_value(value: str, label: str, required: bool = False) -> str:
    candidate = value.strip()
    if not candidate and required:
        raise LdapProfileError(f"LDAP 用户资料缺少{label}")
    if len(candidate) > 256 or any(ord(char) < 0x20 or ord(char) == 0x7F for char in candidate):
        raise LdapProfileError(f"LDAP 用户资料中的{label}格式不正确")
    return candidate


def parse_user_entry(user_id: str, entry: Any, config: LdapConfig) -> LdapUser:
    """Map the supplied AD entry to the platform's three identity fields."""

    title = _entry_value(entry, config.title_attribute)
    name = ""
    department = ""
    if title and "," in title:
        parts = title.split(",", 2)
        if len(parts) >= 3:
            name = parts[1].strip()
            department = parts[2].strip()
    if not name:
        name = _entry_value(entry, config.name_attribute)
    if not department:
        department = _entry_value(entry, config.department_attribute)
    name = _safe_identity_value(name, "姓名", required=True)
    department = _safe_identity_value(department, "部门")
    return LdapUser(employee_no=_safe_user_id(user_id), name=name, department=department)


def _is_bind_error(error: BaseException, ldap_module: Any) -> bool:
    exception_root = getattr(getattr(ldap_module, "core", None), "exceptions", None)
    bind_error = getattr(exception_root, "LDAPBindError", None)
    return bool(bind_error and isinstance(error, bind_error)) or error.__class__.__name__ == "LDAPBindError"


def authenticate_ldap_user(config: LdapConfig, user_id: str, password: str, ldap_module: Any | None = None) -> LdapUser:
    """Bind to AD and return only the fields trusted by the platform."""

    safe_user_id = _safe_user_id(user_id)
    if not isinstance(password, str) or not password:
        raise LdapAuthenticationError("工号或密码错误")
    ldap3 = ldap_module or _load_ldap3()
    connection: Any | None = None
    try:
        tls = None
        if config.use_ssl or config.start_tls:
            tls = ldap3.Tls(validate=ssl.CERT_REQUIRED, ca_certs_file=config.ca_cert_file)
        server = ldap3.Server(
            config.server,
            port=config.port,
            use_ssl=config.use_ssl,
            tls=tls,
            get_info=getattr(ldap3, "NONE", None),
            connect_timeout=config.timeout_seconds,
        )
        connection = ldap3.Connection(
            server,
            auto_bind=not config.start_tls,
            user=f"{config.bind_prefix}{safe_user_id}",
            password=password,
            receive_timeout=config.timeout_seconds,
            raise_exceptions=True,
        )
        if config.start_tls:
            if connection.start_tls() is False:
                raise LdapGatewayError("LDAP TLS negotiation failed")
            if connection.bind() is False:
                raise LdapAuthenticationError("工号或密码错误")
        search_filter = f"({config.account_attribute}={escape_filter_value(safe_user_id)})"
        attributes = [config.title_attribute, config.department_attribute, config.name_attribute]
        connection.search(
            search_base=config.base_dn,
            search_filter=search_filter,
            search_scope=getattr(ldap3, "SUBTREE", None),
            attributes=attributes,
        )
        entries = list(getattr(connection, "entries", []) or [])
        if len(entries) != 1:
            raise LdapProfileError("LDAP 用户资料不存在或不唯一")
        return parse_user_entry(safe_user_id, entries[0], config)
    except LdapGatewayError:
        raise
    except Exception as error:
        if _is_bind_error(error, ldap3):
            raise LdapAuthenticationError("工号或密码错误") from error
        raise LdapGatewayError("LDAP 服务暂时不可用") from error
    finally:
        if connection is not None:
            try:
                connection.unbind()
            except Exception:
                pass


def utc_timestamp(now: float | None = None) -> str:
    from datetime import datetime, timezone

    moment = datetime.fromtimestamp(time.time() if now is None else now, tz=timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def trusted_gateway_signature(user: LdapUser, issued_at: str, secret: str) -> str:
    employee_no = _safe_user_id(user.employee_no)
    name = _safe_identity_value(user.name, "姓名", required=True)
    department = _safe_identity_value(user.department, "部门")
    if "\r" in issued_at or "\n" in issued_at or len(issued_at) > 64:
        raise ValueError("issued_at is not a safe header value")
    canonical = f"{employee_no}\n{issued_at}\n{name}\n{department}"
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def trusted_gateway_headers(user: LdapUser, secret: str, issued_at: str | None = None) -> dict[str, str]:
    issued = issued_at or utc_timestamp()
    return {
        "X-Trusted-Employee-No": user.employee_no,
        "X-Trusted-Name": user.name,
        "X-Trusted-Department": user.department,
        "X-Trusted-Issued-At": issued,
        "X-Trusted-Identity-Signature": trusted_gateway_signature(user, issued, secret),
    }


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise InvalidSessionError("登录会话无效")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def encode_session(user: LdapUser, expires_at: int, secret: str) -> str:
    payload = json.dumps(
        {"employeeNo": user.employee_no, "name": user.name, "department": user.department, "exp": expires_at},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    body = _b64(payload)
    signature = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def decode_session(token: str, secret: str, now: int | None = None) -> LdapUser:
    try:
        body, signature = token.split(".", 1)
        expected = hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise InvalidSessionError("登录会话无效")
        payload = json.loads(_unb64(body).decode("utf-8"))
        if not isinstance(payload, dict):
            raise InvalidSessionError("登录会话无效")
        expires_at = payload.get("exp")
        if not isinstance(expires_at, int) or expires_at <= int(time.time() if now is None else now):
            raise InvalidSessionError("登录会话已过期")
        employee_no = payload.get("employeeNo")
        name = payload.get("name")
        department = payload.get("department", "")
        if not all(isinstance(value, str) for value in (employee_no, name, department)):
            raise InvalidSessionError("登录会话无效")
        return LdapUser(employee_no=employee_no, name=name, department=department)
    except InvalidSessionError:
        raise
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise InvalidSessionError("登录会话无效") from error


def _parse_cookies(raw: str) -> dict[str, str]:
    cookie = SimpleCookie()
    try:
        cookie.load(raw or "")
    except CookieError:
        return {}
    return {key: morsel.value for key, morsel in cookie.items()}


def _relative_return_to(value: str | None) -> str:
    candidate = value or "/"
    if not candidate.startswith("/") or candidate.startswith("//") or "\r" in candidate or "\n" in candidate:
        return "/"
    return candidate


def _cookie(name: str, value: str, max_age: int, secure: bool, http_only: bool = True) -> str:
    parts = [f"{name}={value}", "Path=/", "SameSite=Lax", f"Max-Age={max_age}"]
    if secure:
        parts.append("Secure")
    if http_only:
        parts.append("HttpOnly")
    return "; ".join(parts)


def _read_body(environ: Mapping[str, Any], limit: int = 32 * 1024) -> bytes:
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError as error:
        raise ValueError("请求体长度无效") from error
    if length < 0 or length > limit:
        raise ValueError("请求体过大")
    stream = environ.get("wsgi.input")
    return stream.read(length) if stream is not None else b""


def _json_response(start_response: Callable[..., Any], status: str, payload: Mapping[str, Any], headers: Sequence[tuple[str, str]] = ()) -> list[bytes]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    response_headers = [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"), *headers]
    start_response(status, response_headers)
    return [body]


def _html_response(start_response: Callable[..., Any], status: str, body_text: str, headers: Sequence[tuple[str, str]] = ()) -> list[bytes]:
    body = body_text.encode("utf-8")
    response_headers = [("Content-Type", "text/html; charset=utf-8"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"), *headers]
    start_response(status, response_headers)
    return [body]


class LdapGatewayApp:
    """A small WSGI app for login and reverse-proxy auth subrequests."""

    def __init__(self, config: GatewayConfig, authenticator: Callable[[LdapConfig, str, str], LdapUser] = authenticate_ldap_user, clock: Callable[[], float] = time.time, template_path: Path | None = None) -> None:
        self.config = config
        self.authenticator = authenticator
        self.clock = clock
        self.template_path = template_path or Path(__file__).with_name("static") / "login.html"
        self.brand_logo_path = Path(__file__).with_name("static") / "brand-logo.png"
        self.login_logo_path = Path(__file__).with_name("static") / "login-logo.png"

    def _verify_cookie(self, environ: Mapping[str, Any]) -> LdapUser:
        cookies = _parse_cookies(str(environ.get("HTTP_COOKIE", "")))
        token = cookies.get(self.config.cookie_name, "")
        if not token:
            raise InvalidSessionError("未登录")
        return decode_session(token, self.config.session_secret, int(self.clock()))

    def _login_page(self, csrf: str, return_to: str, start_response: Callable[..., Any], error: str = "", status: str = "200 OK") -> list[bytes]:
        escaped_return = html.escape(return_to, quote=True)
        escaped_csrf = html.escape(csrf, quote=True)
        escaped_error = html.escape(error, quote=True)
        error_state = "visible" if error else "hidden"
        try:
            template = self.template_path.read_text(encoding="utf-8")
        except OSError:
            # Keep the service diagnosable even when a packaging mistake omits
            # the template; the Docker image and source checkout both include
            # the real static page.
            template = """<!doctype html><meta charset=\"utf-8\"><title>平台登录</title><h1>平台登录</h1><form method=\"post\" action=\"/auth/login\"><input type=\"hidden\" name=\"csrf\" value=\"{{CSRF}}\"><input type=\"hidden\" name=\"returnTo\" value=\"{{RETURN_TO}}\"><div class=\"form-error\" data-state=\"{{ERROR_STATE}}\">{{ERROR_MESSAGE}}</div><label>工号<input name=\"userId\" required></label><label>密码<input name=\"password\" type=\"password\" required></label><button>登录</button></form>"""
        page = (
            template
            .replace("{{CSRF}}", escaped_csrf)
            .replace("{{RETURN_TO}}", escaped_return)
            .replace("{{ERROR_STATE}}", error_state)
            .replace("{{ERROR_MESSAGE}}", escaped_error)
        )
        csrf_cookie = _cookie(self.config.csrf_cookie_name, csrf, 600, self.config.cookie_secure, http_only=False)
        return _html_response(start_response, status, page, [("Set-Cookie", csrf_cookie)])

    def __call__(self, environ: MutableMapping[str, Any], start_response: Callable[..., Any]) -> list[bytes]:
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        path = str(environ.get("PATH_INFO", "/"))
        if method == "GET" and path == "/brand-logo.png":
            return self._logo(start_response, self.brand_logo_path)
        if method == "GET" and path == "/login-logo.png":
            return self._logo(start_response, self.login_logo_path)
        if method == "GET" and path in {"/healthz", "/auth/health"}:
            return _json_response(start_response, "200 OK", {"status": "ok"})
        if method == "GET" and path in {"/auth/login", "/login"}:
            csrf = secrets.token_urlsafe(24)
            query = parse_qs(str(environ.get("QUERY_STRING", "")), keep_blank_values=True)
            return_to = _relative_return_to(query.get("returnTo", ["/"])[-1])
            return self._login_page(csrf, return_to, start_response)
        if method == "POST" and path in {"/auth/login", "/login"}:
            return self._login(environ, start_response)
        if method == "POST" and path == "/auth/logout":
            expired = _cookie(self.config.cookie_name, "", 0, self.config.cookie_secure)
            return _json_response(start_response, "200 OK", {"loggedOut": True}, [("Set-Cookie", expired)])
        if method == "GET" and path in {"/auth/session", "/auth/verify"}:
            return self._verify(environ, start_response, include_body=path == "/auth/session")
        return _json_response(start_response, "404 Not Found", {"message": "not found"})

    def _logo(self, start_response: Callable[..., Any], path: Path) -> list[bytes]:
        try:
            body = path.read_bytes()
        except OSError:
            return _json_response(start_response, "404 Not Found", {"message": "not found"})
        start_response(
            "200 OK",
            [
                ("Content-Type", "image/png"),
                ("Content-Length", str(len(body))),
                ("Cache-Control", "public, max-age=3600"),
            ],
        )
        return [body]

    def _login(self, environ: MutableMapping[str, Any], start_response: Callable[..., Any]) -> list[bytes]:
        cookies = _parse_cookies(str(environ.get("HTTP_COOKIE", "")))
        content_type = str(environ.get("CONTENT_TYPE", ""))
        wants_json = content_type.startswith("application/json") or "application/json" in str(environ.get("HTTP_ACCEPT", ""))
        return_to = "/"

        def failure(status: str, message: str) -> list[bytes]:
            if wants_json:
                return _json_response(start_response, status, {"message": message})
            csrf = secrets.token_urlsafe(24)
            return self._login_page(csrf, return_to, start_response, message, status=status)

        try:
            body = _read_body(environ).decode("utf-8")
            if content_type.startswith("application/json"):
                fields = json.loads(body)
            else:
                parsed = parse_qs(body, keep_blank_values=True)
                fields = {key: values[-1] if values else "" for key, values in parsed.items()}
            if not isinstance(fields, dict):
                raise ValueError("请求体格式无效")
            csrf = str(fields.get("csrf", ""))
            if not csrf or not hmac.compare_digest(csrf, cookies.get(self.config.csrf_cookie_name, "")):
                return failure("403 Forbidden", "登录请求已失效，请刷新后重试")
            user_id = str(fields.get("userId", fields.get("user_id", "")))
            password = fields.get("password", "")
            if not isinstance(password, str):
                password = str(password)
            return_to = _relative_return_to(str(fields.get("returnTo", "/")))
            user = self.authenticator(self.config.ldap, user_id, password)
        except LdapAuthenticationError:
            return failure("401 Unauthorized", "工号或密码错误")
        except LdapProfileError:
            return failure("401 Unauthorized", "统一认证失败，请检查工号和密码或联系管理员")
        except LdapGatewayError:
            return failure("503 Service Unavailable", "统一认证服务暂时不可用")
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return failure("400 Bad Request", "登录请求格式无效")
        expires_at = int(self.clock()) + self.config.session_ttl_seconds
        token = encode_session(user, expires_at, self.config.session_secret)
        session_cookie = _cookie(self.config.cookie_name, token, self.config.session_ttl_seconds, self.config.cookie_secure)
        csrf_expired = _cookie(self.config.csrf_cookie_name, "", 0, self.config.cookie_secure, http_only=False)
        start_response("302 Found", [("Location", return_to), ("Set-Cookie", session_cookie), ("Set-Cookie", csrf_expired), ("Content-Length", "0"), ("Cache-Control", "no-store")])
        return [b""]

    def _verify(self, environ: Mapping[str, Any], start_response: Callable[..., Any], include_body: bool) -> list[bytes]:
        try:
            user = self._verify_cookie(environ)
        except InvalidSessionError:
            return _json_response(start_response, "401 Unauthorized", {"message": "未登录"})
        issued_at = utc_timestamp(self.clock())
        headers = trusted_gateway_headers(user, self.config.trusted_gateway_secret, issued_at)
        if include_body:
            return _json_response(start_response, "200 OK", {"authenticated": True, "employeeNo": user.employee_no, "name": user.name, "department": user.department})
        start_response("200 OK", [("Content-Length", "0"), ("Cache-Control", "no-store"), *headers.items()])
        return [b""]


def main() -> None:
    from wsgiref.simple_server import make_server

    config = GatewayConfig.from_env()
    host = os.environ.get("LDAP_GATEWAY_HOST", "127.0.0.1")
    port = _positive_int(os.environ, "LDAP_GATEWAY_PORT", 8081, 1, 65535)
    application = LdapGatewayApp(config)
    with make_server(host, port, application) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()

--- END FILE: services/ldap3-gateway/ldap3_gateway.py ---


--- BEGIN FILE: services/ldap3-gateway/requirements.txt ---

ldap3>=2.9,<3

--- END FILE: services/ldap3-gateway/requirements.txt ---


--- BEGIN FILE: services/ldap3-gateway/static/login.html ---

<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <link rel="icon" type="image/png" href="/login-logo.png">
  <title>登录 · 分组核心网 AI能力提升平台</title>
  <style>
    :root {
      color-scheme: light;
      font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #172640;
      background: #f9f9f7;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f9f9f7;
    }
    .login-card {
      width: min(100%, 420px);
      overflow: hidden;
      border: 1px solid #e5eaf2;
      border-radius: 18px;
      background: #fff;
      box-shadow: 0 12px 34px rgba(20, 48, 90, .055);
    }
    .login-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 27px 32px 24px;
      border-bottom: 1px solid #edf1f6;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      overflow: hidden;
      border: 0;
      border-radius: 12px;
      background: transparent;
    }
    .brand-mark img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      border-radius: inherit;
    }
    .brand-mark-fallback {
      color: #fff;
      background: linear-gradient(145deg, #3288e6 0%, #1555a4 100%);
    }
    .brand-fallback {
      display: none;
      font-size: 15px;
      font-weight: 900;
      letter-spacing: -.08em;
    }
    .brand-mark-fallback .brand-fallback { display: block; }
    .brand-mark-fallback img { display: none; }
    }
    .brand-copy { min-width: 0; }
    .brand-kicker {
      display: block;
      margin-bottom: 4px;
      color: #8290a3;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .08em;
      line-height: 1.1;
    }
    .brand-title {
      display: block;
      color: #172640;
      font-family: "JetBrains Mono", "PingFang SC", "Microsoft YaHei", ui-monospace, Consolas, monospace;
      font-size: 17px;
      font-weight: 850;
      letter-spacing: -.045em;
      line-height: 1.2;
    }
    .login-body { padding: 27px 32px 30px; }
    h1 {
      margin: 0 0 7px;
      color: #12213a;
      font-size: 24px;
      letter-spacing: -.055em;
    }
    .login-subtitle {
      margin: 0 0 22px;
      color: #7b8899;
      font-size: 13px;
    }
    .form-error {
      display: none;
      margin: 0 0 15px;
      padding: 10px 12px;
      border: 1px solid rgba(208, 59, 59, .28);
      border-radius: 7px;
      color: #b23b3b;
      background: rgba(208, 59, 59, .05);
      font-size: 12px;
      line-height: 1.55;
    }
    .form-error[data-state="visible"] { display: block; }
    label {
      display: grid;
      gap: 7px;
      margin: 14px 0;
      color: #536276;
      font-size: 13px;
      font-weight: 700;
    }
    input {
      width: 100%;
      min-height: 44px;
      padding: 10px 11px;
      border: 1px solid #d8e1ec;
      border-radius: 7px;
      color: #1f2a3d;
      background: #fff;
      outline: none;
      font: inherit;
    }
    input:focus {
      border-color: #176bc2;
      box-shadow: 0 0 0 3px #e7f2ff;
    }
    button {
      width: 100%;
      min-height: 44px;
      margin-top: 9px;
      border: 0;
      border-radius: 7px;
      color: #fff;
      background: #176bc2;
      box-shadow: 0 5px 13px rgba(23, 107, 194, .22);
      cursor: pointer;
      font: inherit;
      font-weight: 800;
    }
    button:hover { background: #13599e; }
    button:focus-visible {
      outline: 3px solid #e7f2ff;
      outline-offset: 2px;
    }
    .login-foot {
      margin: 18px 0 0;
      color: #9aa8bb;
      font-size: 11px;
      text-align: center;
    }
    @media (max-width: 520px) {
      body { padding: 12px; }
      .login-header, .login-body { padding-left: 24px; padding-right: 24px; }
      .login-card { border-radius: 14px; }
    }
  </style>
</head>
<body>
  <main class="login-card">
    <header class="login-header">
      <div class="brand-mark" aria-hidden="true">
        <img src="/login-logo.png" alt="" onerror="this.hidden=true; this.parentElement.classList.add('brand-mark-fallback')">
        <span class="brand-fallback">AI</span>
      </div>
      <div class="brand-copy">
        <span class="brand-kicker">分组核心网</span>
        <strong class="brand-title">AI能力提升平台</strong>
      </div>
    </header>
    <section class="login-body">
      <h1>登录</h1>
      <div class="form-error" role="alert" data-state="{{ERROR_STATE}}">{{ERROR_MESSAGE}}</div>
      <form method="post" action="/auth/login" autocomplete="on">
        <input type="hidden" name="csrf" value="{{CSRF}}">
        <input type="hidden" name="returnTo" value="{{RETURN_TO}}">
        <label for="userId">
          工号
          <input id="userId" name="userId" autocomplete="username" placeholder="请输入工号" maxlength="128" required autofocus>
        </label>
        <label for="password">
          密码
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required>
        </label>
        <button type="submit">登录</button>
      </form>
      <p class="login-foot">LDAP3域账号统一认证</p>
    </section>
  </main>
</body>
</html>

--- END FILE: services/ldap3-gateway/static/login.html ---


--- BEGIN FILE: services/ldap3-gateway/test_ldap3_gateway.py ---

import io
import hashlib
import hmac
import unittest
from types import SimpleNamespace
from urllib.parse import urlencode

from ldap3_gateway import (
    GatewayConfig,
    InvalidSessionError,
    LdapAuthenticationError,
    LdapConfig,
    LdapGatewayApp,
    LdapProfileError,
    LdapUser,
    authenticate_ldap_user,
    decode_session,
    encode_session,
    escape_filter_value,
    trusted_gateway_headers,
)


class FakeBindError(Exception):
    pass


class FakeEntry:
    def __init__(self, **attributes):
        for key, value in attributes.items():
            setattr(self, key, SimpleNamespace(value=value))


class FakeConnection:
    last = None

    def __init__(self, server, auto_bind, user, password, receive_timeout, **kwargs):
        FakeConnection.last = self
        self.user = user
        self.password = password
        self.entries = [FakeEntry(title="w00123,张三,云计算", department="备用部门", displayName="张三")]
        if password == "bad":
            raise FakeBindError("bad credentials")

    def search(self, **kwargs):
        self.search_kwargs = kwargs
        return True

    def start_tls(self):
        self.start_tls_called = True
        return True

    def bind(self):
        self.bind_called = True
        return True

    def unbind(self):
        self.unbound = True


class FakeLdap:
    NONE = "NONE"
    SUBTREE = "SUBTREE"
    Tls = staticmethod(lambda **kwargs: kwargs)
    Server = staticmethod(lambda *args, **kwargs: (args, kwargs))
    Connection = FakeConnection
    core = SimpleNamespace(exceptions=SimpleNamespace(LDAPBindError=FakeBindError))


class LdapGatewayTests(unittest.TestCase):
    def setUp(self):
        self.ldap = LdapConfig()
        self.user = LdapUser("w00123", "张三", "云计算")

    def test_filter_value_escapes_ldap_metacharacters(self):
        self.assertEqual(escape_filter_value("a*)(b\\"), r"a\2a\29\28b\5c")

    def test_authentication_maps_title_and_uses_narrow_search(self):
        user = authenticate_ldap_user(self.ldap, "w00123", "secret", FakeLdap)
        self.assertEqual(user, self.user)
        self.assertEqual(FakeConnection.last.user, r"China\w00123")
        self.assertEqual(FakeConnection.last.search_kwargs["search_filter"], "(sAMAccountName=w00123)")
        self.assertEqual(FakeConnection.last.search_kwargs["attributes"], ["title", "department", "displayName"])
        self.assertTrue(FakeConnection.last.unbound)

    def test_bad_credentials_are_generic(self):
        with self.assertRaises(LdapAuthenticationError):
            authenticate_ldap_user(self.ldap, "w00123", "bad", FakeLdap)

    def test_start_tls_is_negotiated_before_bind(self):
        user = authenticate_ldap_user(LdapConfig(start_tls=True), "w00123", "secret", FakeLdap)
        self.assertEqual(user.name, "张三")
        self.assertTrue(FakeConnection.last.start_tls_called)
        self.assertTrue(FakeConnection.last.bind_called)

    def test_incomplete_profile_is_rejected(self):
        class MissingNameConnection(FakeConnection):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.entries = [FakeEntry(title="w00123,,云计算", department="云计算", displayName="")]

        class MissingNameLdap(FakeLdap):
            Connection = MissingNameConnection

        with self.assertRaises(LdapProfileError):
            authenticate_ldap_user(self.ldap, "w00123", "secret", MissingNameLdap)

    def test_gateway_signature_matches_platform_canonical_text(self):
        headers = trusted_gateway_headers(self.user, "s" * 32, "2026-08-05T03:00:00.000Z")
        self.assertEqual(headers["X-Trusted-Employee-No"], "w00123")
        expected = hmac.new(b"s" * 32, "w00123\n2026-08-05T03:00:00.000Z\n张三\n云计算".encode("utf-8"), hashlib.sha256).hexdigest()
        self.assertEqual(headers["X-Trusted-Identity-Signature"], expected)

    def test_identity_header_values_reject_line_breaks(self):
        with self.assertRaises(LdapProfileError):
            trusted_gateway_headers(LdapUser("w00123", "张三\n伪造", "云计算"), "s" * 32)

    def test_session_round_trip_and_tamper_detection(self):
        token = encode_session(self.user, 200, "s" * 32)
        self.assertEqual(decode_session(token, "s" * 32, now=100), self.user)
        with self.assertRaises(InvalidSessionError):
            decode_session(token[:-1] + ("0" if token[-1] != "0" else "1"), "s" * 32, now=100)
        with self.assertRaises(InvalidSessionError):
            decode_session(token, "s" * 32, now=200)

    def test_verify_endpoint_returns_signed_headers(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        token = encode_session(self.user, 200, config.session_secret)
        app = LdapGatewayApp(config, clock=lambda: 100)
        environ = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/auth/verify",
            "HTTP_COOKIE": f"{config.cookie_name}={token}",
        }
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = dict(headers)

        body = b"".join(app(environ, start_response))
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(body, b"")
        self.assertEqual(captured["headers"]["X-Trusted-Employee-No"], "w00123")

    @staticmethod
    def _call(app, environ):
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = headers

        body = b"".join(app(environ, start_response)).decode("utf-8")
        return captured, body

    def test_login_page_renders_csrf_and_return_target(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        captured, body = self._call(app, {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/auth/login",
            "QUERY_STRING": "returnTo=%2Fdrills%2Fparking",
        })
        self.assertEqual(captured["status"], "200 OK")
        self.assertIn("分组核心网", body)
        self.assertIn("AI能力提升平台", body)
        self.assertIn("登录", body)
        self.assertIn("工号", body)
        self.assertIn("密码", body)
        self.assertIn("LDAP3域账号统一认证", body)
        self.assertIn('src="/login-logo.png"', body)
        self.assertIn('name="password"', body)
        self.assertIn('name="csrf" value="', body)
        self.assertIn('name="returnTo" value="/drills/parking"', body)
        self.assertNotIn("{{CSRF}}", body)
        self.assertNotIn("{{ERROR_", body)
        self.assertTrue(any(name == "Set-Cookie" and config.csrf_cookie_name in value for name, value in captured["headers"]))

    def test_brand_logo_route_serves_the_platform_asset(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = dict(headers)

        body = b"".join(app({"REQUEST_METHOD": "GET", "PATH_INFO": "/brand-logo.png"}, start_response))
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(captured["headers"]["Content-Type"], "image/png")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_login_logo_route_serves_the_login_asset(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = dict(headers)

        body = b"".join(app({"REQUEST_METHOD": "GET", "PATH_INFO": "/login-logo.png"}, start_response))
        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(captured["headers"]["Content-Type"], "image/png")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_form_login_shows_generic_error_without_exposing_password(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)

        def reject(_config, _user_id, _password):
            raise LdapAuthenticationError("internal detail")

        app = LdapGatewayApp(config, authenticator=reject, clock=lambda: 100)
        initial, page = self._call(app, {"REQUEST_METHOD": "GET", "PATH_INFO": "/auth/login", "QUERY_STRING": ""})
        csrf_cookie = next(value for name, value in initial["headers"] if name == "Set-Cookie" and value.startswith(config.csrf_cookie_name))
        csrf = csrf_cookie.split("=", 1)[1].split(";", 1)[0]
        password = "never-render-this-password"
        form = urlencode({"csrf": csrf, "returnTo": "/", "userId": "w00123", "password": password}).encode("utf-8")
        captured, body = self._call(app, {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/auth/login",
            "CONTENT_TYPE": "application/x-www-form-urlencoded",
            "CONTENT_LENGTH": str(len(form)),
            "HTTP_COOKIE": f"{config.csrf_cookie_name}={csrf}",
            "wsgi.input": io.BytesIO(form),
        })
        self.assertEqual(captured["status"], "401 Unauthorized")
        self.assertIn("工号或密码错误", body)
        self.assertNotIn(password, body)
        self.assertNotIn("{{ERROR_", body)
        self.assertNotIn('"message"', body)

    def test_form_login_rejects_expired_csrf_with_login_page(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)
        app = LdapGatewayApp(config, clock=lambda: 100)
        form = urlencode({"csrf": "wrong", "returnTo": "/", "userId": "w00123", "password": "secret"}).encode("utf-8")
        captured, body = self._call(app, {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/auth/login",
            "CONTENT_TYPE": "application/x-www-form-urlencoded",
            "CONTENT_LENGTH": str(len(form)),
            "wsgi.input": io.BytesIO(form),
        })
        self.assertEqual(captured["status"], "403 Forbidden")
        self.assertIn("登录请求已失效", body)
        self.assertIn('name="csrf" value="', body)

    def test_json_login_keeps_machine_readable_error_response(self):
        config = GatewayConfig(self.ldap, "t" * 32, "s" * 32, cookie_secure=False)

        def reject(_config, _user_id, _password):
            raise LdapAuthenticationError("internal detail")

        app = LdapGatewayApp(config, authenticator=reject, clock=lambda: 100)
        form = b'{"csrf":"wrong","userId":"w00123","password":"secret"}'
        captured, body = self._call(app, {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/auth/login",
            "CONTENT_TYPE": "application/json",
            "HTTP_ACCEPT": "application/json",
            "CONTENT_LENGTH": str(len(form)),
            "wsgi.input": io.BytesIO(form),
        })
        self.assertEqual(captured["status"], "403 Forbidden")
        self.assertIn('"message":"登录请求已失效，请刷新后重试"', body)


if __name__ == "__main__":
    unittest.main()

--- END FILE: services/ldap3-gateway/test_ldap3_gateway.py ---


--- BEGIN FILE: tools/engine-dev-kit/README.md ---

# 独立评测引擎开发包

这个目录和下载的 `evaluation-engine-development-kit.zip` 都可以在没有平台代码仓库的电脑上使用。它提供：

- `contracts/`：平台实际使用的评测引擎、调用输入和结果 Schema；
- `examples/minimal-engine/`：完全使用 Python 标准库的最小参考引擎；
- `examples/sample-submission/`：参考引擎使用的合成提交；
- `tools/engine_dev.py`：校验、运行和打包 CLI；
- `GUIDE.md`：评测引擎开发规范和可交给其他 AI 的提示词。

## 在没有平台仓库的电脑上

只需要 Python 3.10+：

```powershell
python tools/engine_dev.py validate examples/minimal-engine
python tools/engine_dev.py run examples/minimal-engine --workspace examples/sample-submission --output tmp/sample-result.json
python tools/engine_dev.py package examples/minimal-engine --out tmp/minimal-score-engine.zip
python tools/engine_dev.py validate tmp/minimal-score-engine.zip
```

这些命令不连接平台 API，也不需要 Node、pnpm、数据库或 Worker。`jsonschema` 是可选依赖；安装 `requirements.txt` 后，CLI 会额外运行完整的 2020-12 Schema 校验。

## 开发自己的引擎

复制 `examples/minimal-engine`，修改 `engine.json`、`instruction.md`、Skills 和 Python 入口。入口按平台约定接收：

```text
python -I judge.py --input <invocation.json> --output <result.json>
```

引擎只能读取 invocation 指向的只读工作区和包内资源，把符合 `contracts/evaluation-result.schema.json` 的结果写到 `outputPath`。完成本地验证后，把生成的 ZIP 上传到平台赛题版本；平台仍会在独立 Worker 中重新校验和执行。

## 重要边界

这个开发包能独立完成引擎逻辑、契约检查和合成样例运行，但不能代替平台源码。真实训战、权限、批次租约、结果入库和 OpenCode 端到端测试仍需完整平台仓库和 Worker 环境。

--- END FILE: tools/engine-dev-kit/README.md ---


--- BEGIN FILE: tools/engine-dev-kit/examples/minimal-engine/engine.json ---

{
  "schemaVersion": "1.1",
  "id": "minimal-score-engine",
  "version": "1.0.0",
  "title": "最小独立评测引擎",
  "description": "读取样例提交的 answer.txt，演示输入、评分、证据和结果契约。",
  "runtime": {
    "type": "python",
    "entrypoint": "judge.py"
  },
  "agent": {
    "instruction": "instruction.md",
    "skills": ["skills/evaluation/SKILL.md"]
  },
  "limits": {
    "wallClockSeconds": 60,
    "memoryMB": 512,
    "outputBytes": 4194304
  }
}

--- END FILE: tools/engine-dev-kit/examples/minimal-engine/engine.json ---


--- BEGIN FILE: tools/engine-dev-kit/examples/minimal-engine/instruction.md ---

# 最小引擎说明

这是一个独立开发包示例。引擎读取平台传入的 invocation JSON，打开 workspace/answer.txt，答案为 42 时给出 100 分，否则给出 0 分。真实引擎应使用题目自己的只读快照、测试资产和 rubric。

运行入口必须保持：

```text
python -I judge.py --input <invocation.json> --output <result.json>
```

--- END FILE: tools/engine-dev-kit/examples/minimal-engine/instruction.md ---


--- BEGIN FILE: tools/engine-dev-kit/examples/minimal-engine/judge.py ---

"""No-dependency reference engine for the standalone development kit."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    started = time.time()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    answer_path = Path(payload["workspace"]) / "answer.txt"
    answer = answer_path.read_text(encoding="utf-8").strip() if answer_path.is_file() else ""
    correct = answer == "42"
    score = 100 if correct else 0
    finished = time.time()
    run_id = payload["grading"]["runId"]
    result_id = "result-" + hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:24]
    result = {
        "schemaVersion": "1.0",
        "resultId": result_id,
        "gradingRunId": run_id,
        "challengeVersion": payload["challenge"]["challengeVersion"],
        "rubricVersion": payload["challenge"]["rubricVersion"],
        "graderVersion": "minimal-score-engine@1.0.0",
        "idempotencyKey": payload["grading"]["idempotencyKey"],
        "triggerType": payload["grading"]["triggerType"],
        "status": "COMPLETE" if correct else "PARTIAL",
        "submission": {
            "sourceType": payload["submission"]["sourceType"],
            "snapshotHash": payload["submission"]["snapshotHash"],
            "artifactHash": payload["submission"]["artifactHash"],
            "submittedAt": payload["submission"]["submittedAt"],
        },
        "dimensions": {
            "verify": {"score": score, "max": 100, "evaluated": True},
            "spec": {"score": 0, "max": 1, "evaluated": True},
            "code": {"score": 0, "max": 1, "evaluated": True},
            "collab": {"score": 0, "max": 1, "evaluated": True},
        },
        "criteria": [{
            "key": "VERIFY_ANSWER",
            "dim": "verify",
            "name": "答案校验",
            "max": 100,
            "level": "A" if correct else "D",
            "score": score,
            "source": "auto",
            "rule": "answer.txt 必须只包含 42",
            "evidence": {"path": str(answer_path), "actual": answer},
            "evidenceType": "test",
            "ruleVersion": "1.0",
        }],
        "total": score,
        "validationDiagnostics": [] if answer_path.is_file() else [{
            "severity": "BLOCKER",
            "code": "MISSING_INPUT",
            "message": "workspace/answer.txt 不存在",
        }],
        "gradedBy": "ci",
        "startedAt": now(),
        "finishedAt": now(),
        "durationMs": int((finished - started) * 1000),
        "metadata": {"standalone": True, "answerChecked": True},
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

--- END FILE: tools/engine-dev-kit/examples/minimal-engine/judge.py ---


--- BEGIN FILE: tools/engine-dev-kit/examples/minimal-engine/skills/evaluation/SKILL.md ---

# 评测 Skill

- 只读取 invocation.workspace 指向的提交快照。
- 不访问网络、其他提交目录、平台数据库或凭据。
- 输出必须保留 grading.runId、grading.idempotencyKey 和 grading.triggerType。
- 分数之外记录可审计的 criteria、evidence 和明确状态。

--- END FILE: tools/engine-dev-kit/examples/minimal-engine/skills/evaluation/SKILL.md ---


--- BEGIN FILE: tools/engine-dev-kit/examples/sample-submission/answer.txt ---

42

--- END FILE: tools/engine-dev-kit/examples/sample-submission/answer.txt ---


--- BEGIN FILE: tools/engine-dev-kit/requirements.txt ---

jsonschema>=4.23,<5

--- END FILE: tools/engine-dev-kit/requirements.txt ---


--- BEGIN FILE: tools/engine-dev-kit/tools/engine_dev.py ---

#!/usr/bin/env python3
"""独立评测引擎开发 CLI。

这个工具只使用 Python 标准库即可完成三件事：

  python tools/engine_dev.py validate path/to/engine
  python tools/engine_dev.py run path/to/engine --workspace ./sample-submission
  python tools/engine_dev.py package path/to/engine --out dist/engine.zip

它不连接平台 API，也不依赖平台仓库；用于在交付引擎前检查包结构、运行
一个合成 invocation，并生成可上传的 ZIP。安装 jsonschema 后会额外执行
完整 JSON Schema 校验，未安装时仍会执行内置的安全和结果结构检查。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


MAX_FILES = 2000
MAX_BYTES = 64 * 1024 * 1024
ENGINE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$")
ENGINE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
HEX_32 = "a" * 32
HASH_64 = "b" * 64
ARTIFACT_HASH_64 = "c" * 64


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fail(message: str) -> int:
    print(f"ERROR: {message}", file=sys.stderr)
    return 2


def safe_package_path(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value.startswith(("/", "\\")):
        raise ValueError(f"{field} 必须是包内相对路径")
    if re.match(r"^[A-Za-z]:", value) or "\\" in value:
        raise ValueError(f"{field} 不允许盘符或反斜杠：{value}")
    parts = Path(value).parts
    if ".." in parts or "." in parts:
        raise ValueError(f"{field} 不允许 . 或 ..：{value}")
    return value


def iter_package_files(root: Path) -> Iterator[Path]:
    count = 0
    total = 0
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"引擎包禁止符号链接：{path.relative_to(root)}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        safe_package_path(relative, relative)
        count += 1
        total += path.stat().st_size
        if count > MAX_FILES:
            raise ValueError(f"文件数量超过上限 {MAX_FILES}")
        if total > MAX_BYTES:
            raise ValueError(f"包内容超过上限 {MAX_BYTES} bytes")
        yield path


def package_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in iter_package_files(root):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def load_manifest(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        raise ValueError(f"不是引擎目录：{root}")
    manifest_path = root / "engine.json"
    if not manifest_path.is_file():
        raise ValueError("引擎根目录缺少 engine.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"engine.json 不是有效 JSON：{error}") from error
    if not isinstance(manifest, dict):
        raise ValueError("engine.json 顶层必须是对象")

    schema_version = manifest.get("schemaVersion")
    if schema_version not in {"1.0", "1.1"}:
        raise ValueError("schemaVersion 必须是 1.0 或 1.1")
    engine_id = manifest.get("id")
    version = manifest.get("version")
    if not isinstance(engine_id, str) or not ENGINE_ID.fullmatch(engine_id):
        raise ValueError("id 不符合引擎标识规则")
    if not isinstance(version, str) or not ENGINE_VERSION.fullmatch(version):
        raise ValueError("version 不符合引擎版本规则")
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("type") != "python":
        raise ValueError("runtime.type 必须是 python")
    entrypoint = safe_package_path(runtime.get("entrypoint"), "runtime.entrypoint")
    if not (root / entrypoint).is_file():
        raise ValueError(f"找不到入口文件：{entrypoint}")
    if runtime.get("requirements") is not None:
        requirements = safe_package_path(runtime["requirements"], "runtime.requirements")
        if not (root / requirements).is_file():
            raise ValueError(f"找不到依赖文件：{requirements}")
    if schema_version == "1.1":
        agent = manifest.get("agent")
        if not isinstance(agent, dict):
            raise ValueError("1.1 引擎必须声明 agent")
        instruction = safe_package_path(agent.get("instruction"), "agent.instruction")
        skills = agent.get("skills")
        if not isinstance(skills, list) or not skills:
            raise ValueError("agent.skills 至少需要一个路径")
        paths = [instruction, *(safe_package_path(item, "agent.skills") for item in skills)]
        for path in paths:
            if not (root / path).is_file():
                raise ValueError(f"找不到 Agent 文件：{path}")
    if manifest.get("platformDependencies"):
        raise ValueError("独立上传引擎不能声明 platformDependencies")

    # 遍历一次，拒绝符号链接、路径穿越和过大的包。
    list(iter_package_files(root))
    return manifest


def kit_root() -> Path:
    # kit/tools/engine_dev.py -> kit/
    return Path(__file__).resolve().parents[1]


def schema_path(name: str) -> Path:
    bundled = kit_root() / "contracts" / name
    if bundled.is_file():
        return bundled
    # 直接在本项目源码目录运行时，契约位于仓库根 contracts/；ZIP 解压后
    # 则会优先命中上面的 kit/contracts/。
    repository_contract = Path(__file__).resolve().parents[3] / "contracts" / name
    return repository_contract


def optional_schema_validate(value: Any, schema_name: str) -> str | None:
    path = schema_path(schema_name)
    if not path.is_file():
        return f"未找到 {path}，跳过完整 Schema 校验"
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return "未安装 jsonschema，仅执行内置结构校验；可运行 python -m pip install -r requirements.txt"
    schema = json.loads(path.read_text(encoding="utf-8"))
    try:
        jsonschema.Draft202012Validator(schema).validate(value)
    except jsonschema.ValidationError as error:  # type: ignore[attr-defined]
        raise ValueError(f"{schema_name} 校验失败：{error.message} at {list(error.absolute_path)}") from error
    return None


def validate_result_shape(result: Any, invocation: dict[str, Any]) -> None:
    if not isinstance(result, dict):
        raise ValueError("结果顶层必须是 JSON 对象")
    required = {
        "schemaVersion", "resultId", "gradingRunId", "challengeVersion", "rubricVersion",
        "graderVersion", "idempotencyKey", "triggerType", "status", "submission",
        "dimensions", "criteria", "total", "validationDiagnostics", "gradedBy",
        "startedAt", "finishedAt", "durationMs",
    }
    missing = sorted(required - result.keys())
    if missing:
        raise ValueError(f"结果缺少字段：{', '.join(missing)}")
    if result["schemaVersion"] != "1.0":
        raise ValueError("结果 schemaVersion 必须是 1.0")
    if result["gradingRunId"] != invocation["grading"]["runId"]:
        raise ValueError("gradingRunId 没有原样带回 invocation")
    if result["idempotencyKey"] != invocation["grading"]["idempotencyKey"]:
        raise ValueError("idempotencyKey 没有原样带回 invocation")
    if result["triggerType"] != invocation["grading"]["triggerType"]:
        raise ValueError("triggerType 没有原样带回 invocation")
    if result["status"] not in {"COMPLETE", "PARTIAL", "FAILED"}:
        raise ValueError("status 不在契约允许范围")
    if not isinstance(result["total"], (int, float)) or not 0 <= result["total"] <= 100:
        raise ValueError("total 必须是 0 到 100 的数字")
    if not isinstance(result["dimensions"], dict) or not isinstance(result["criteria"], list):
        raise ValueError("dimensions 和 criteria 类型不正确")
    if not isinstance(result["validationDiagnostics"], list):
        raise ValueError("validationDiagnostics 必须是数组")


@contextmanager
def materialize_package(source: Path) -> Iterator[Path]:
    if source.is_dir():
        yield source.resolve()
        return
    if source.suffix.lower() != ".zip" or not source.is_file():
        raise ValueError(f"引擎包必须是目录或 ZIP：{source}")
    with tempfile.TemporaryDirectory(prefix="engine-kit-") as temporary:
        target = Path(temporary) / "package"
        with zipfile.ZipFile(source) as archive:
            names = archive.namelist()
            if len(names) > MAX_FILES:
                raise ValueError(f"ZIP 文件数量超过上限 {MAX_FILES}")
            uncompressed_total = 0
            for name in names:
                safe_package_path(name.rstrip("/"), "ZIP 条目")
                info = archive.getinfo(name)
                if info.file_size > MAX_BYTES:
                    raise ValueError("ZIP 单文件超过大小上限")
                uncompressed_total += info.file_size
                if uncompressed_total > MAX_BYTES:
                    raise ValueError(f"ZIP 解压后内容超过上限 {MAX_BYTES} bytes")
                # Unix symlink 的文件类型位为 0o120000。
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError(f"ZIP 禁止符号链接：{name}")
            archive.extractall(target)
        # 允许 ZIP 有一个包根目录，也允许直接以 engine.json 为根。
        candidates = [target, *(path for path in target.iterdir() if path.is_dir())]
        package_root = next((path for path in candidates if (path / "engine.json").is_file()), None)
        if package_root is None:
            raise ValueError("ZIP 中找不到包含 engine.json 的包根目录")
        yield package_root


def command_validate(source: Path) -> int:
    try:
        with materialize_package(source) as root:
            manifest = load_manifest(root)
            warning = optional_schema_validate(manifest, "evaluation-engine-package.schema.json")
            print(f"PASS engine={manifest['id']} version={manifest['version']} hash={package_hash(root)}")
            if warning:
                print(f"WARN {warning}")
        return 0
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        return fail(str(error))


def sample_invocation(root: Path, workspace: Path, output: Path, scratch: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "generatedAt": utc_now(),
        "engine": {
            "id": manifest["id"],
            "version": manifest["version"],
            "packageHash": package_hash(root),
            "packageRoot": str(root),
            "source": "PACKAGE",
        },
        "challenge": {
            "id": "standalone-sample",
            "challengeVersion": "standalone-sample:1",
            "rubricVersion": "1.0",
            "zone": "YELLOW",
        },
        "grading": {"runId": "standalone-run-001", "idempotencyKey": HEX_32, "triggerType": "MANUAL", "attempt": 1},
        "subject": {"id": "sample-user"},
        "submission": {
            "id": "sample-submission",
            "sourceType": "UPLOAD",
            "snapshotHash": HASH_64,
            "artifactHash": ARTIFACT_HASH_64,
            "submittedAt": utc_now(),
        },
        "workspace": str(workspace),
        "outputPath": str(output),
        "scratchDir": str(scratch),
        "limits": {"wallClockSeconds": 60, "memoryMB": 512, "outputBytes": 4 * 1024 * 1024},
        "params": {},
    }


def command_run(source: Path, workspace_arg: str | None, output_arg: str | None, keep: bool) -> int:
    try:
        with materialize_package(source) as root:
            manifest = load_manifest(root)
            default_workspace = root.parent / "sample-submission"
            workspace = Path(workspace_arg).resolve() if workspace_arg else default_workspace.resolve()
            if not workspace.is_dir():
                raise ValueError(f"找不到工作区：{workspace}")
            output = Path(output_arg).resolve() if output_arg else Path.cwd() / "engine-result.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            scratch_context = tempfile.TemporaryDirectory(prefix="engine-scratch-")
            scratch = Path(scratch_context.name)
            invocation_path = scratch / "invocation.json"
            invocation = sample_invocation(root, workspace, output, scratch, manifest)
            invocation_path.write_text(json.dumps(invocation, ensure_ascii=False, indent=2), encoding="utf-8")
            entrypoint = root / manifest["runtime"]["entrypoint"]
            timeout = int(manifest.get("limits", {}).get("wallClockSeconds", 600))
            command = [sys.executable, "-I", str(entrypoint), "--input", str(invocation_path), "--output", str(output)]
            completed = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=timeout, check=False)
            if completed.returncode:
                print(completed.stdout, end="")
                print(completed.stderr, end="", file=sys.stderr)
                return fail(f"引擎进程退出码为 {completed.returncode}")
            if not output.is_file():
                return fail("引擎没有生成 output 文件")
            try:
                result = json.loads(output.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                return fail(f"output 不是有效 JSON：{error}")
            validate_result_shape(result, invocation)
            warning = optional_schema_validate(result, "evaluation-result.schema.json")
            print(f"PASS status={result['status']} total={result['total']} output={output}")
            if warning:
                print(f"WARN {warning}")
            if keep:
                print(f"INVOCATION {invocation_path}")
            else:
                scratch_context.cleanup()
            return 0
    except subprocess.TimeoutExpired:
        return fail("引擎运行超时")
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        return fail(str(error))


def command_package(source: Path, output_arg: str | None) -> int:
    try:
        with materialize_package(source) as root:
            manifest = load_manifest(root)
            output = Path(output_arg).resolve() if output_arg else Path.cwd() / f"{manifest['id']}-{manifest['version']}.zip"
            output.parent.mkdir(parents=True, exist_ok=True)
            if output.exists():
                output.unlink()
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for path in iter_package_files(root):
                    archive.write(path, path.relative_to(root).as_posix())
            print(f"PASS package={output} engine={manifest['id']} version={manifest['version']}")
            return 0
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        return fail(str(error))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="engine_dev", description="独立评测引擎校验、运行和打包工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="校验引擎目录或 ZIP")
    validate.add_argument("package", type=Path)

    run = subparsers.add_parser("run", help="运行一个合成 invocation 并校验结果")
    run.add_argument("package", type=Path)
    run.add_argument("--workspace", help="只读提交工作区；默认使用示例工作区")
    run.add_argument("--output", help="结果 JSON 输出路径；默认当前目录 engine-result.json")
    run.add_argument("--keep-invocation", action="store_true", dest="keep")

    package = subparsers.add_parser("package", help="把引擎目录打成 ZIP")
    package.add_argument("package", type=Path)
    package.add_argument("--out", help="ZIP 输出路径")

    args = parser.parse_args(argv)
    if args.command == "validate":
        return command_validate(args.package)
    if args.command == "run":
        return command_run(args.package, args.workspace, args.output, args.keep)
    return command_package(args.package, args.out)


if __name__ == "__main__":
    raise SystemExit(main())

--- END FILE: tools/engine-dev-kit/tools/engine_dev.py ---
