# AI 训战平台开发方案

> 基于《新员工 AI 能力训战平台 · 设计方案 v1.0》整理
> 目标：把产品设计转换为可执行、可验收、适合使用 Codex 持续开发的工程计划。

## 1. 开发目标与原则

平台最终要形成一个“出题—作答—评测—报告—画像—运营”的闭环。工程建设优先保证以下四件事：

1. **评测可复现**：同一提交、同一判据版本重复运行必须得到相同结果。
2. **契约稳定**：蓝区、黄区、前端、CI 只通过版本化 Schema 交互。
3. **证据可追溯**：每个得分点必须能追溯到测试结果、代码位置或已校验的原文引用。
4. **先垂直闭环再扩功能**：先用一道题完成一次端到端评测，再扩赛制、团队、蓝区和众包。

首期不追求微服务化。平台后端采用**模块化单体**，评测引擎保持独立可执行；等业务量和团队边界稳定后再决定是否拆分服务。

### 当前实施顺序调整

为保证本地可测试性，当前开发采用“本地优先、外部适配最后”的顺序：

1. 先完成文件持久化适配器、组织/角色、题目/场次、上传/Git 快照、离线评测、报告、赛季和画像；
2. 本地评测使用受控子进程和本地 Git，不依赖 GitLab、K8s、SSO 或内部模型网关；
3. GitLab 自动评测最后只实现 `GradingExecutor` 适配接口和结果回调契约，接入真实 GitLab CI 不阻塞本地验收。

本地适配器和生产适配器必须共享同一领域服务、结果 Schema、幂等规则和状态机，不能因为最后接入 GitLab 而重写业务层。

## 2. 范围划分

### 2.1 一期必须交付

一期对应“能跑起来”，建议控制在 4–6 周：

- 黄区单区；
- 个人项目；
- 开放窗口；
- 一道固定语言样题；
- 组织树与向下继承作用域；
- 场次可配置 `UPLOAD / GIT_REF` 两种交付件来源；
- 上传文件或 Git 分支均转换为不可变提交快照；
- 提交契约校验；
- 评测执行器抽象；开发期用受控本地子进程执行隐藏测试，生产再替换为 K8s 沙箱；
- Verify 40 分与 Code 20 分规则引擎；
- 场次可配置 `AUTO / MANUAL / IMPORT` 三种评测触发方式；
- 管理员可批量触发评测，也可上传线下评测结果；
- 统一结果 Schema、rubricVersion 和幂等键；
- 自动或管理员触发时，由本地 `LocalGradingExecutor` 调用同一套评测引擎；
- 结果写入平台 API；
- 员工端详细参赛报告：提交快照、维度拆解、评分项证据、诊断、问题定位、改进建议和运行时间线；
- 员工端 AI 能力画像：保留 Verify/Spec/Code/Collab 四维评测总览与 V/S/C/P 16 个评分点矩阵，同时聚合 AI 认知与选型、任务理解与拆解、提示词与上下文工程、检索与事实核验、工具与 Agent 编排、输出评审与测试、工程交付与自动化、安全合规与风险 8 个能力域；提供历次趋势、分区计数、部门中位数对比、证据覆盖度、薄弱项和推荐练习；
- 10 人并发验证。

### 2.2 一期明确不做

- 蓝区结果导入；
- Spec、Collab 的模型抽取评分；
- 团队项目；
- 集中场次和封存揭晓；
- 生产级赛季积分与能力画像（开发期已提供文件适配器和只读 API 骨架）；
- 多语言；
- 众包题、悬赏题和探索题；
- 完整管理后台；
- 真实 GitLab CI、K8s、SSO 和内部模型网关；
- Redis、消息队列、微服务等非必要基础设施。

这些能力在数据模型和接口中预留，但不进入一期 UI 和验收范围。

## 3. 推荐技术架构

### 3.1 技术栈

具体小版本应以黄区内部制品库可获得版本为准，并在项目初始化时锁定。

| 层次 | 推荐方案 | 说明 |
|---|---|---|
| JavaScript 运行时 | 内部批准的 Node.js LTS | 前后端统一运行时基线；开发、CI、生产锁定同一主版本 |
| 包管理与工作区 | pnpm workspace | 管理 Web、API、共享类型与工具包，根目录统一执行构建和测试 |
| Web | React + TypeScript + Vite | 学员端与管理端共用一个前端工程，按路由和权限分区 |
| UI/图表 | 企业允许的组件库 + ECharts | 组件库在启动前确认内部合规版本 |
| API | TypeScript + NestJS + Fastify Adapter | 模块化单体；用模块、Guard、Interceptor 和 OpenAPI 管理复杂后台能力 |
| 数据库 | PostgreSQL | 核心关系数据；评测原始结果使用 JSONB 保存 |
| 交付件存储 | S3 兼容对象存储，开发期可用受限本地存储 | 保存上传包、不可变提交快照和原始导入文件 |
| 数据访问 | Prisma Client | 类型化访问 PostgreSQL；复杂报表和物化路径查询允许使用受审查的参数化 SQL |
| 数据迁移 | Prisma Migrate + 显式 SQL migration | 所有表、索引和约束变更必须版本化；已执行迁移不可原地修改 |
| 评测引擎 | Python 3.11+ CLI | Schema 校验、测试汇总、代码度量、定档和报告生成 |
| 代码解析 | tree-sitter | Python、Java、Go 指标查询统一实现 |
| 契约 | JSON Schema + OpenAPI | 结果、题目、提交契约均可机器校验 |
| CI | GitLab CI | 验证、沙箱测试、度量、评分、发布 |
| 沙箱 | K8s Job | 禁网、非 root、只读根、资源限制、硬超时 |
| 端到端测试 | Playwright | 验证发布题目、提交、出分和查看报告 |
| TypeScript 测试 | Vitest + NestJS/Fastify 测试工具 | API 单元、模块集成和权限测试 |
| 可观测性 | 结构化日志 + Prometheus 指标 | 一期先覆盖评测耗时、失败率和队列时间 |

### 3.2 逻辑架构

```text
浏览器
  │
  ├── Web（学员端 / 管理端）
  │       │ REST API
  │       ▼
  └── Platform API（模块化单体）
          ├── identity        SSO、用户、角色
          ├── organization    组织树、作用域
          ├── challenge       题目、版本、提交契约
          ├── event           场次、参与人、时间窗
          ├── submission      上传/Git 取件、快照固化、提交契约
          ├── grading         评测运行、结果导入、幂等
          ├── report          报告查询
          ├── leaderboard     榜单与积分（二/三期）
          └── audit           操作审计
                  │
                  ├── PostgreSQL
                  ├── 交付件存储
                  └── GitLab API / Webhook
                          ├── AUTO：收到提交后立即触发评测流水线
                          └── MANUAL：管理员操作后批量触发评测流水线

GitLab CI
  └── drill-grader CLI
          ├── validate        校验提交契约
          ├── verify          调度/读取 K8s Job 测试结果
          ├── measure         tree-sitter 代码度量
          ├── extract         二期接入模型抽取
          ├── score           按 rubric profile 确定性定档
          └── publish         向 Platform API 发布结果 JSON

管理员线下评测
  └── IMPORT：上传统一 Schema 结果 JSON
          └── Platform API 校验身份、提交归属、Schema、分值和幂等键
```

### 3.3 部署单元

一期只保留以下部署单元：

1. `platform-web`：前端静态资源；
2. `platform-api`：后端模块化单体；
3. `postgresql`：优先使用现有托管实例；
4. `artifact-store`：优先使用已有 S3 兼容对象存储；一期无现成服务时可使用受限 PVC；
5. `grader-runner`：GitLab Runner 调用的评测镜像；
6. `submission-sandbox`：按提交临时创建的 K8s Job。

评测模型网关、Redis、消息队列在一期均不是强依赖。交付件上传模式需要一个持久化 artifact store，不能把大文件直接存入 PostgreSQL。

## 4. 建议仓库结构

首期建议使用 monorepo，便于契约、样例和端到端测试一起演进：

```text
AI-Training-Platform/
├── AGENTS.md                       # Codex 项目级约束
├── README.md                       # 本地启动与开发入口
├── DEVELOPMENT_PLAN.md
├── package.json                    # 根命令：lint / test / build / contract-test
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/
│   ├── architecture/
│   │   ├── context.md
│   │   ├── grading-flow.md
│   │   └── security-boundary.md
│   ├── adr/                        # 架构决策记录
│   └── api/
├── contracts/
│   ├── evaluation-result.schema.json
│   ├── challenge.schema.json
│   ├── submission-contract.schema.json
│   ├── examples/
│   └── openapi.yaml
├── apps/
│   └── web/
├── services/
│   └── platform-api/               # NestJS 模块化单体
│       ├── prisma/
│       │   ├── schema.prisma
│       │   └── migrations/
│       └── src/modules/
├── packages/
│   ├── contract-types/             # 由 Schema/OpenAPI 生成的 TypeScript 类型
│   ├── api-client/                 # 前端调用 API 的生成客户端
│   └── shared-config/
├── grader/
│   ├── SKILL.md                    # 蓝黄共用的七步评测说明
│   ├── references/
│   │   ├── rubric.md
│   │   ├── extraction.md
│   │   └── schema.md
│   ├── src/drill_grader/
│   ├── profiles/
│   │   ├── blue.yaml
│   │   └── yellow.yaml
│   ├── queries/                    # tree-sitter 查询
│   └── tests/
├── challenges/
│   └── parking-fee-v1/             # 一期黄金样题
│       ├── challenge.yaml
│       ├── README.md
│       ├── starter/
│       ├── hidden-tests/
│       ├── reference/
│       └── fixtures/
├── deploy/
│   ├── docker/
│   ├── helm/
│   └── gitlab-ci/
├── e2e/
└── scripts/
```

隐藏测试是否能与平台代码放在同一仓库，需按 GitLab 权限策略确认。若不能，应保留相同目录契约，但放入独立受限仓库，由 CI 只读拉取。

## 5. 核心领域模型

### 5.1 建模修正

设计方案中“集中场次 / 开放窗口 / 赛季”被放在同一个赛制维度中，但赛季本质上是场次容器。开发时建议拆开：

- `event.mode`：`LIVE` 或 `WINDOW`；
- `event.submission_source`：`UPLOAD` 或 `GIT_REF`；
- `event.trigger`：`AUTO`、`MANUAL` 或 `IMPORT`；
- `event.reveal`：`IMMEDIATE` 或 `ON_RELEASE`，与 trigger 完全独立；
- `season`：独立聚合根；
- `season_event`：把正式场次编排进赛季；
- 蓝区通过 `zone=BLUE + trigger=IMPORT + reveal=ON_RELEASE` 表达。

这样不会出现一个 `mode=SEASON` 的项目既像题目又像容器的歧义。

### 5.2 核心表

| 表 | 关键字段 | 说明 |
|---|---|---|
| `org_unit` | `id, parent_id, path, level, name` | 物化路径；`path` 建前缀查询索引 |
| `app_user` | `id, employee_no, name, org_unit_id, status` | SSO 用户映射 |
| `role_binding` | `user_id, role, scope_org_id` | 角色及作用域 |
| `challenge` | `id, owner_org_id, origin, status` | 题目稳定身份 |
| `challenge_version` | `challenge_id, version, zone, language_policy, contract_json, rubric_version` | 已发布版本不可修改 |
| `rubric` | `version, schema_version, status` | 判据骨架版本 |
| `rubric_profile` | `rubric_version, zone, org_scope, config_json` | 分区和组织覆盖阈值 |
| `event` | `id, challenge_version_id, mode, submission_source, delivery_config_json, trigger, reveal, starts_at, ends_at, status` | 一次正式或众包活动；交付来源与评测触发分别配置 |
| `season` | `id, name, starts_at, ends_at, status` | 赛季容器 |
| `season_event` | `season_id, event_id, weight` | 只有官方活动可加入 |
| `team` / `team_member` | `event_id, user_id, role` | 二期启用 |
| `participation` | `event_id, subject_kind, subject_id, org_path_snapshot` | 固化参赛时组织归属 |
| `submission` | `event_id, subject_id, source_type, snapshot_hash, repo, branch, commit_sha, artifact_uri, artifact_hash, submitted_at` | Git 或上传交付件最终都固化为不可变快照 |
| `grading_run` | `submission_id, trigger_type, triggered_by, rubric_version, grader_version, status, idempotency_key` | 一次评测运行；保留自动、管理员触发或导入来源 |
| `evaluation_result` | `grading_run_id, total, dimensions_json, result_json, revealed_at` | 原始结果完整保留 |
| `criterion_result` | `grading_run_id, criterion_key, level, score, source, evidence` | 为报表查询适度归一化 |
| `finding` | `criterion_result_id, file, line, severity, detail, fix` | 扣分证据链 |
| `audit_log` | `actor, action, target, before_json, after_json, created_at` | 发布、揭晓、改判必须审计 |

### 5.3 数据约束

- `org_unit.path` 一旦创建只允许通过受控迁移修改；
- 成绩记录保存 `org_path_snapshot`，组织调整不重写历史；
- `challenge_version` 发布后冻结；
- `rubric` 发布后冻结，变更必须产生新版本；
- `submission` 以 `(event_id, subject_id, snapshot_hash)` 唯一；`snapshot_hash` 统一按“排序后的相对路径 + 文件内容哈希 + 必要执行权限”计算，不使用压缩包字节或 Git commit ID，因此同一内容从上传和 Git 进入时得到同一哈希；
- `GIT_REF` 类型必须同时保存 `repo + branch + commit_sha`，评测只能读取 commit SHA，不能在运行时重新读取移动中的分支头；
- `UPLOAD` 类型必须同时保存 `artifact_uri + artifact_hash`，对象内容只读且不可覆盖；
- `delivery_config_json` 只保存仓库、分支规则和文件限制，不保存 Git token 或对象存储密钥，只引用平台 Secret；
- `grading_run.idempotency_key` 建议为：
  `sha256(commit_sha + rubric_version + grader_version + challenge_version)`；
- `evaluation_result.result_json` 必须先通过对应 `schemaVersion` 校验；
- 平台不能信任客户端上报的 `total`，必须重新计算 criteria 与 dimensions 加总。

### 5.4 评测触发模型

评测触发方式是 `event` 的配置，不由分区或赛制写死：

| trigger | 提交后的行为 | 评测执行位置 | 典型场景 |
|---|---|---|---|
| `AUTO` | 平台记录提交后立即触发 GitLab 评测流水线 | GitLab CI + K8s Job | 开放窗口、即时练习 |
| `MANUAL` | 只记录提交并进入待评测状态；管理员选择一份或一批提交后触发 | GitLab CI + K8s Job | 集中场次、统一收卷后评分 |
| `IMPORT` | 不创建 CI 评测任务；等待管理员上传线下结果 | 管理员线下工具、Codex、Claude 或人工 | 蓝区导入、线下评审、特殊场次 |

三种入口最终都写入同一套 `grading_run` 和 `evaluation_result`，并通过同一个结果导入服务完成 Schema、加总和幂等校验。

`trigger` 只决定何时及由谁启动评测，`reveal` 只决定结果何时对学员可见。例如：

- `MANUAL + ON_RELEASE`：集中收卷，管理员批量评完后统一揭晓；
- `AUTO + ON_RELEASE`：push 后后台立即评，但结果暂不展示；
- `IMPORT + IMMEDIATE`：线下结果上传并校验成功后立即可见；
- `IMPORT + ON_RELEASE`：结果先导入封存，管理员之后统一揭晓。

状态建议为：

```text
RECEIVED
  ├── AUTO   → QUEUED → RUNNING → GRADED
  ├── MANUAL → WAITING_TRIGGER → QUEUED → RUNNING → GRADED
  └── IMPORT → WAITING_IMPORT → IMPORT_VALIDATING → GRADED

GRADED
  ├── reveal=IMMEDIATE  → REVEALED
  └── reveal=ON_RELEASE → SEALED → REVEALED
```

### 5.5 交付件来源模型

交付件来源和评测触发是两个正交配置。`UPLOAD / GIT_REF` 均可与 `AUTO / MANUAL / IMPORT` 组合：

| submission_source | 场次配置 | 提交时的处理 |
|---|---|---|
| `UPLOAD` | 允许格式、单包上限、文件数量上限、是否允许覆盖提交 | 学员把交付包上传到平台；平台扫描、解包、规范化并计算 `snapshotHash` |
| `GIT_REF` | Git provider、仓库路径、分支或分支模板、凭据引用、截止策略 | 平台校验仓库和分支，在提交或收卷时解析并锁定 commit SHA，再生成 `snapshotHash` |

建议的场次配置：

```yaml
delivery:
  source: GIT_REF                 # UPLOAD | GIT_REF
  git:
    provider: GITLAB
    repository: group/project
    branchTemplate: drill/{subjectId}
    pinAt: SUBMIT                 # SUBMIT | DEADLINE
    credentialRef: gitlab-grader-readonly

# 上传模式示例
delivery:
  source: UPLOAD
  upload:
    formats: [zip]
    maxBytes: 52428800
    maxFiles: 2000
    allowResubmit: true
```

指定固定 Git 路径和固定分支时，直接使用 `repository + branch`；个人或团队各自分支时使用 `branchTemplate`。模板只允许平台定义的占位符，例如 `{subjectId}`、`{teamId}`，不能执行任意表达式。

配置校验要求：`trigger=AUTO` 时 Git 的 `pinAt` 必须为 `SUBMIT`；`pinAt=DEADLINE` 只适用于统一收卷后处理的 `MANUAL` 或 `IMPORT`，否则自动评测时无法确定该评哪个版本。

两种来源在进入评测前都转换为统一结构：

```text
SubmissionSnapshot
  ├── submissionId
  ├── sourceType: UPLOAD | GIT_REF
  ├── snapshotHash
  ├── sourceMetadata（repo/branch/commit 或 artifact/hash）
  └── workspace/                  # 只读、已规范化的评测目录
```

从 `validate` 开始，评测引擎只读取 `workspace/`，不再区分交付件来自平台上传还是 Git。这保证两种提交方式使用完全相同的规则和分数口径。

## 6. 契约优先设计

在编写业务代码之前先冻结以下三个契约的 v1：

### 6.1 题目契约 `challenge.schema.json`

至少包括：

- 题目身份、版本和来源；
- 分区、语言策略；
- 允许的交付来源及上传/Git 配置约束；
- 交付物和入口签名；
- required / optional / forbidden 文件；
- 隐藏测试分档和权重；
- 判据版本；
- K8s 资源上限；
- 可见组织作用域；
- 变更包元数据。

### 6.2 提交契约 `submission-contract.schema.json`

用于本地 `drill check` 和 CI `validate` 共用，要求：

- 同一份实现代码在本地预检和 CI 产生相同诊断；
- 所有诊断具有稳定的 `code`，不能只返回自然语言；
- 诊断分为 `BLOCKER / WARNING / INFO`；
- 格式问题不重复扣分。

### 6.3 评测结果契约 `evaluation-result.schema.json`

在原设计基础上补充：

- `resultId` 和 `gradingRunId`；
- `challengeVersion`、`graderVersion`；
- `idempotencyKey`；
- `submission.sourceType`、`submission.snapshotHash` 及对应来源元数据；
- `triggerType: AUTO | MANUAL | IMPORT`；
- `triggeredBy` 与 `importedBy` 审计信息；
- `status: COMPLETE | PARTIAL | FAILED`；
- `validationDiagnostics`；
- `startedAt / finishedAt / durationMs`；
- `artifacts` 的哈希与位置；
- `criteria[].evidenceType`；
- `criteria[].ruleVersion`；
- `recalculatedTotal` 或服务端校验结果。

Schema v1 冻结门槛：至少准备 5 份合法样例、10 份非法样例，并在 TypeScript 与 Python 两侧执行契约测试。TypeScript DTO 和前端类型从 Schema/OpenAPI 生成，不手写第二套结构。

## 7. 评测引擎设计

### 7.1 CLI 接口

```text
drill-grader validate   --challenge challenge.yaml --submission ./work
drill-grader verify     --challenge challenge.yaml --submission ./work --out verify.json
drill-grader measure    --challenge challenge.yaml --submission ./work --out metrics.json
drill-grader extract    --profile yellow --transcript transcript.md --out extraction.json
drill-grader score      --inputs ./run --out result.json
drill-grader run        --challenge challenge.yaml --submission ./work --out ./result
drill-grader check      --challenge challenge.yaml --submission .
```

`run` 只是顺序编排，所有阶段都必须可以独立执行和重试。

### 7.2 确定性边界

脚本负责：

- 目录和文件契约校验；
- 隐藏测试执行与分档汇总；
- AST/tree-sitter 度量；
- 引用精确匹配；
- 档位映射和分数计算；
- Schema 校验；
- 结果哈希。

模型只负责把对话记录抽取为 `yes / no / unclear + quote`。模型不得直接产生分数、档位或总评。

### 7.3 黄金样本

评测引擎必须建立 `golden fixtures`：

- 参考实现：预期 Verify 40、Code 20；
- 基础实现：基础档通过、边界和澄清档失败；
- 魔法数字实现：能稳定命中 C1 findings；
- 入口缺失实现：产生阻断诊断但仍能输出 PARTIAL 结果；
- 恶意/超时实现：被沙箱终止；
- 同一实现重复运行 20 次：结果 JSON 在排除运行时间字段后哈希一致。

## 8. API 初稿

一期优先实现以下接口：

```text
GET    /api/v1/me
GET    /api/v1/org-units/{id}
GET    /api/v1/challenges
POST   /api/v1/challenges
POST   /api/v1/challenges/{id}/versions
POST   /api/v1/challenge-versions/{id}/publish
POST   /api/v1/events
POST   /api/v1/events/{id}/participants:import
GET    /api/v1/events/{id}
POST   /api/v1/submissions
POST   /api/v1/events/{id}/submissions:upload
POST   /api/v1/events/{id}/submissions:register-git
GET    /api/v1/submissions/{id}
POST   /api/v1/submissions/{id}/start-grading
POST   /api/v1/events/{id}/start-grading
POST   /api/v1/grading-runs/{id}/execute       # 本地 LocalGradingExecutor
POST   /api/v1/events/{id}/execute-local       # 本地批量执行
POST   /api/v1/grading-results:import
POST   /api/v1/events/{id}/close
POST   /api/v1/events/{id}/reveal
GET    /api/v1/grading-runs/{id}
GET    /api/v1/reports/{submissionId}
GET    /api/v1/seasons/{id}/leaderboard
GET    /api/v1/profiles/{userId}
GET    /api/v1/audits
```

二期再加入：

```text
POST   /api/v1/grading-runs/{id}:review
GET    /api/v1/leaderboards/events/{id}
GET    /api/v1/profiles/{userId}
```

接口规则：

- 所有写接口支持请求 ID；
- `submissions:upload` 只接受 `submission_source=UPLOAD` 的场次；
- `submissions:register-git` 只接受 `submission_source=GIT_REF` 的场次，并由服务端校验场次配置的仓库、分支模板和已锁定 commit；
- 客户端不得通过提交接口传入任意 Git URL；仓库路径必须来自管理员发布并校验过的场次配置；
- 导入接口必须支持幂等重试；
- `start-grading` 仅接受 `trigger=MANUAL` 的场次，支持单份和批量提交；
- `trigger=AUTO` 的场次由提交事件自动创建运行记录，执行器通过 `GradingExecutor` 注入；本地用 `LocalGradingExecutor`，最后再接 GitLab；
- `trigger=IMPORT` 的场次禁止启动 CI 评测，只能通过导入接口产生结果；
- 批量导入支持逐条返回成功或失败，不能因为一条非法结果回滚整批合法结果；
- 错误响应返回稳定错误码、字段路径和可读说明；
- 管理操作校验组织作用域；
- 发布、揭晓、重评和人工改判写入审计日志；
- OpenAPI 是接口事实来源，前端类型由契约生成。

## 9. 一期关键流程

### 9.1 题目发布

1. 管理员创建题目草稿；
2. 上传或选择 `challenge.yaml`；
3. 平台校验题目 Schema；
4. 运行参考实现自检；
5. 创建不可变 `challenge_version`；
6. 创建开放窗口 event，并配置 `trigger` 与 `reveal`；
7. 按组织作用域生成可参与列表；
8. 发布后记录审计事件。

一期可以先通过种子数据或管理 API 发布题目，不必先实现完整工作台。

### 9.2 黄区提交与评测

先按场次的 `submission_source` 接收交付件：

#### UPLOAD：上传到评测平台

1. 学员上传交付包；
2. 平台校验大小、格式和文件数量，执行安全扫描和安全解包；
3. 平台按提交契约规范化目录，计算 artifact hash 与 snapshot hash；
4. 不可变交付包写入 artifact store，形成 `SubmissionSnapshot`。

#### GIT_REF：指定 Git 路径和分支

1. 学员 push 到场次预先配置的仓库和分支；
2. GitLab Webhook 通知平台，或学员在平台点击“提交”；
3. 平台从场次配置解析仓库与分支并校验参与人归属；
4. 按 `pinAt=SUBMIT` 或 `pinAt=DEADLINE` 解析准确 commit SHA；
5. 平台用只读凭据获取该 commit，生成不可变归档和 snapshot hash，形成 `SubmissionSnapshot`。

形成快照后，再按场次的 `trigger` 进入以下流程：

#### AUTO：自动评测

1. 上传完成或 Git 快照固化后，平台立即调用 GitLab Pipeline API，并传入 submission ID 与 snapshot hash；
2. GitLab CI 获取只读快照，运行 `validate → verify → measure → score`；
3. CI 使用受限服务账号回传结果；
4. API 校验 Schema、提交归属、snapshot hash、幂等键和分数加总；
5. 按 `reveal` 设置立即展示或封存。

#### MANUAL：管理员触发

1. 快照进入 `WAITING_TRIGGER`，提交或 push 不执行评分；
2. 管理员在平台选择一份或一批提交快照；
3. 若 Git 场次配置为 `pinAt=DEADLINE`，平台先统一锁定各分支的截止 commit；
4. 平台批量调用与 AUTO 完全相同的 GitLab 评测流水线；
5. 后续校验、保存和揭晓逻辑与 AUTO 相同。

#### IMPORT：管理员上传线下结果

1. 快照进入 `WAITING_IMPORT`，平台不触发 GitLab 评测；
2. 管理员使用线下工具、Codex、Claude 或人工流程完成评分；
3. 管理员上传一份或一批统一 Schema 结果 JSON；
4. 平台校验管理员权限、event/subject/snapshot 关联、rubricVersion、Schema、证据字段和分值加总；
5. 合法结果写入统一成绩表，原始上传文件计算哈希并保留审计记录；
6. 按 `reveal` 设置立即展示或封存。

线下上传不能绕过平台校验，也不能直接修改总分。需要人工调整时，应产生新的评测版本或复核记录，保留原始结果。

### 9.3 失败策略

| 失败点 | 处理方式 |
|---|---|
| 契约阻断 | Verify 为 0，其余可评项继续，输出 PARTIAL |
| K8s Job 超时 | 记录统一错误码，Verify 为 0，不自动无限重试 |
| tree-sitter 解析失败 | Code 维度标记不可用，整体 PARTIAL |
| 结果 Schema 非法 | API 拒绝导入，CI 失败并保存原始产物 |
| API 暂时不可达 | CI 按幂等键有限重试，结果文件保留为 artifact |
| 同一结果重复上传 | 返回原结果，不新建第二条成绩 |
| 批量人工触发部分失败 | 成功项继续执行，失败项逐条返回原因并允许幂等重试 |
| 导入结果与提交不匹配 | 拒绝该条结果，记录导入人和失败原因 |

## 10. 安全设计

### 10.1 沙箱基线

每次提交独立 K8s Job，至少满足：

- `runAsNonRoot: true`；
- root filesystem 只读；
- 禁止 privilege escalation；
- 删除全部 Linux capabilities；
- 默认拒绝网络；
- CPU、内存、临时磁盘限额；
- active deadline；
- 提交目录只读挂载，输出目录单独可写；
- 使用专用 service account，不挂载平台凭据；
- Job 完成后自动清理。

### 10.2 平台安全

- SSO 只负责身份认证，平台维护角色与组织作用域；
- 管理接口实施资源级授权，不能只依赖前端隐藏按钮；
- GitLab CI 使用短期或受限 token；
- Git 仓库地址只能由管理员在场次中配置，并限制在允许的 Git host/group，防止利用任意 URL 发起 SSRF；
- Git 凭据只授予目标仓库只读权限，评测运行读取固定 commit SHA；
- 上传包限制总大小、解压后大小、文件数和路径深度，拒绝绝对路径、`..`、符号链接逃逸和解压炸弹；
- 上传原包、Git 归档和评测 workspace 均做哈希校验，评测过程中只读；
- 评测结果导入验证 event、subject、snapshot 的关联；Git 来源额外核对 commit SHA；
- transcript、代码片段和 findings 按内部数据处理；
- 日志中不得记录源码全文、token、Cookie 和 SSO 断言；
- 所有外部输入限制大小并做内容类型校验。

## 11. 测试与质量门禁

### 11.1 测试分层

| 层次 | 重点 |
|---|---|
| 单元测试 | 定档计算、作用域判断、幂等键、路径/签名校验 |
| 契约测试 | JSON Schema、OpenAPI、TypeScript/Python 双端兼容 |
| 集成测试 | PostgreSQL、artifact store、GitLab 回调、Git 快照、K8s Job 状态转换 |
| 黄金测试 | grader 固定输入对应固定结果；上传与 Git 的同内容快照必须同分 |
| 端到端测试 | 建题—上传或 Git 提交—触发—出分—查看报告 |
| 安全测试 | 超时、内存耗尽、禁网、越权、恶意文件路径、解压炸弹、Git URL SSRF |
| 性能测试 | 30 人集中 push、API 导入和报告查询 |

### 11.2 合并门禁

每个合并请求至少通过：

- 格式化与静态检查；
- 单元测试；
- Schema 契约测试；
- 数据迁移校验；
- grader 黄金样本；
- 受影响模块的集成测试；
- 无新增高危依赖问题；
- 文档与 OpenAPI 同步。

## 12. 可观测性

一期至少记录以下指标：

- `grading_runs_total{status,stage}`；
- `grading_duration_seconds{stage}`；
- `grading_queue_seconds`；
- `sandbox_terminated_total{reason}`；
- `result_import_total{status}`；
- `idempotency_hit_total`；
- `schema_validation_failed_total{schemaVersion}`；
- 单场同时评测数量和峰值资源使用。

日志统一携带：`requestId, eventId, submissionId, snapshotHash, gradingRunId, commitSha, rubricVersion`。不得用员工姓名作为主检索键。

## 13. 迭代计划

### Sprint 0：工程与契约地基（3–5 天）

- 初始化 Git 仓库；
- 创建 monorepo 目录；
- 编写根 `AGENTS.md`；
- 建立 pnpm workspace、NestJS API、React Web 和 Python grader 基础构建；
- 建立 CI 基础流水线；
- 产出三份 JSON Schema v1 草案；
- 产出 5 份合法、10 份非法结果样例；
- 建立 ADR 模板；
- 锁定一期样题和语言。

验收：本地一条命令跑完格式检查与契约测试，CI 同样通过。

### Sprint 1：评测引擎最小闭环（5–7 天）

- 实现 `validate / verify / score / run`；
- 完成一期样题、参考实现和隐藏测试；
- 用本地容器模拟沙箱；
- 生成统一结果 JSON；
- 建立黄金样本和重复运行一致性测试。

验收：参考实现满分；缺陷实现按预期扣分；同一输入重复 20 次结果一致。

### Sprint 2：代码度量与证据链（5–7 天）

- 接入 tree-sitter；
- 实现一期语言的魔法数字、复杂度、异常处理等指标；
- findings 精确到文件和行号；
- 补齐 Code 20 分；
- 将度量规则写入 rubric 文档和 profile。

验收：Verify + Code 共 60 分全部自动评；黄金实现、典型缺陷实现均命中预期档位。

### Sprint 3：平台 API 与数据库（5–7 天）

- 组织、用户、题目版本、event、submission、grading run 表；
- Prisma schema 与版本化 migration；
- artifact store 适配器；
- 上传交付件的安全解包、哈希与不可变快照；
- Git 仓库/分支解析、commit 固化与只读快照；
- 结果导入 API；
- `AUTO / MANUAL / IMPORT` 触发策略与状态机；
- 单份、批量管理员触发 API；
- Schema 和加总二次校验；
- 幂等导入；
- 报告查询 API；
- 最小权限校验与审计。

验收：同一份交付件通过上传和 Git 提交时得到相同 snapshot 内容；移动分支不会改变已提交快照；三种 trigger 的非法状态转换会被拒绝；CI 或管理员上传的结果可重复提交而不产生重复成绩；错误 Schema 被明确拒绝。

### Sprint 4：本地平台闭环与体验（5–7 天）

- 文件持久化适配器、组织树、角色、题目版本、场次和审计记录；
- `LocalGradingExecutor` 调用同一套 Python grader，支持单份和场次批量执行；
- 报告查询、封存/揭晓、赛季榜单和个人画像只读 API；
- 报告 API 返回评分项证据、findings、运行诊断和推荐动作；画像 API 返回四维归一化分数、8 个版本化 AI 能力域、16 个评分点历史档位、分区统计、部门中位数、证据覆盖度、薄弱项和趋势序列；能力域无证据时必须返回待评测，不得由平台推断分数；
- 员工首页（开放赛题、公告、赛季积分、榜单、最近动态）、个人中心与赛题/提交工作台；
- 管理员触发、本地执行和结果展示；
- 管理员工作台（运营总览、赛题版本发布、场次编排、评测队列、结果导入、公告和审计）；
- 10 人并发演练的本地状态机测试。

验收：UPLOAD 与 GIT_REF 均能形成只读快照；AUTO/MANUAL/IMPORT 的状态转换、结果幂等、详细报告和能力画像数据均可重复测试；GitLab/K8s 不在本轮本地验收依赖中。

### 当前完成状态（2026-08-01）

Sprint 1–4 的本地实现已完成并通过验收：Python grader 的黄金样本、重复快照哈希、超时与 findings；服务端统一快照、Git commit 固化、上传归档限制、结果二次计分校验、服务端补齐员工/组织快照并拒绝 `gradingRunId` 碰撞、AUTO 有界队列、MANUAL/IMPORT 状态机、权限/组织边界、详细报告与 8 域能力画像；员工端与管理员端的本地工作台（含 Git 提交时/截止时锁定配置）；管理员可按全组织查看个人明细，按部门或选定人员查看四维/8 域/16 点的群体平均画像与有效样本覆盖；SSO 工号首次登录幂等建档、部门自动匹配及管理员角色/部门配置；以及 10 个本地种子学员同时提交 AUTO 场次的并发演练。使用 `pnpm acceptance:local` 可单独重跑并发验收。

本地实现使用文件持久化和受控 Python 子进程，生产关系模型已同步到 `services/platform-api/prisma/` 的 schema 与首个 migration，但不会在本地测试时隐式连接数据库。真实 GitLab CI、K8s 沙箱、SSO 网关断言/JWT、PostgreSQL Repository 和生产观测按 Sprint 5/生产适配项处理；本地已经提供 SSO 身份同步接口和网关头适配。

### Sprint 5：GitLab 适配接口与生产接入（最后进行，5–7 天）

- 实现 `GradingExecutor` 的 GitLab Pipeline 客户端；
- GitLab Webhook/结果回调签名校验、流水线变量和失败重试；
- 构建 grader 镜像、K8s Job 沙箱、产物留存和并发演练；
- 用同一结果 Schema、幂等键和状态机替换本地执行器，不改领域层；
- SSO、部署文档、运维手册和生产故障演练。

验收：一道题、10 名真实用户验证 UPLOAD/GIT_REF 与三种 trigger 的关键组合；本地与 GitLab 执行结果契约一致；同一 snapshot 重跑同分；每个扣分点可定位证据。

## 14. 二期与三期路线

### 二期：评得准（6–8 周）

- SPEC.md 七节结构扫描；
- transcript 结构化抽取；
- 引用精确匹配；
- 20 份人工标注校准集；
- 人工复核台；
- Spec 25 + Collab 15；
- 集中场次、封存、一键揭晓；
- 完整学员端和管理端；
- 30 人集中训战。

进入自动抽取的门槛不是“模型能返回 JSON”，而是与人工金标准的一致率达到既定阈值。

### 三期：比得出（6–8 周）

- 蓝区批量评分工具和结果导入；
- 团队项目；
- season、百分位积分和能力画像；
- 多语言与按参考实现归一化；
- 模型基准库；
- 众包出题、自动体检、终审；
- bounty / explore Verify 插槽；
- 挑战榜和部门报表。

## 15. Codex 开发方式

### 15.1 任务切分规则

Codex 每次接收一个可独立验收的任务，理想大小为半天到两天。任务必须包含：

- 背景；
- 明确范围；
- 不做什么；
- 输入与输出契约；
- 允许修改的目录；
- 验收命令；
- 兼容性或安全约束。

避免一次让 Codex “实现整个平台”。大任务应按“契约—领域—接口—UI—端到端”拆开。

### 15.2 推荐开发顺序

```text
契约样例
  → Schema 校验器
  → grader 黄金测试
  → grader 实现
  → 数据库迁移
  → API 契约与服务实现
  → GitLab/K8s 集成
  → UI
  → 端到端测试
```

先写样例与验收测试，再让 Codex 实现，可以显著降低其对模糊规则的自由解释。

### 15.3 每轮 Codex 工作模板

```text
目标：实现 drill-grader validate 子命令。

上下文：
- 读取 contracts/submission-contract.schema.json
- 读取 challenges/parking-fee-v1/challenge.yaml
- 遵守根目录 AGENTS.md

范围：
- 只修改 grader/ 和相关 tests/
- 实现 required、optional、forbidden、入口文件检查
- 输出稳定 JSON 诊断码

不做：
- 不执行隐藏测试
- 不接数据库或网络
- 不实现其他语言

验收：
- 运行指定测试命令全部通过
- 合法 fixture 返回 0
- blocker fixture 返回非 0 且 JSON 符合 Schema
- 更新必要文档

完成后：
- 汇总改动文件
- 报告测试结果
- 列出仍存在的风险，不要自行扩大范围
```

### 15.4 根 `AGENTS.md` 应包含的规则

- 先读本目录及父目录的约束；
- 契约文件是事实来源；
- 已发布 Schema 和数据库迁移不可原地修改；
- 所有评分逻辑必须有黄金测试；
- 禁止模型直接生成分数；
- 禁止在日志和 fixture 中放真实员工或生产数据；
- 新依赖需说明用途并通过内部制品可用性检查；
- 不绕过测试，不以删除测试修复失败；
- 修改 API 必须同步 OpenAPI；
- 修改结果结构必须同步 TypeScript/Python 契约测试；
- 完成任务后运行最小充分验证并报告结果。

## 16. 首批可直接交给 Codex 的任务

按顺序执行，前一项验收通过后再做下一项：

1. 初始化 Git 仓库、monorepo 目录和根 `AGENTS.md`；
2. 编写 `evaluation-result.schema.json` v1 与合法/非法样例；
3. 编写 `challenge.schema.json` 和一期样题 `challenge.yaml`；
4. 编写 `submission-contract.schema.json`；
5. 搭建 Python grader 包和测试框架；
6. 实现 `drill-grader validate`；
7. 准备一期样题参考实现及四档隐藏测试；
8. 实现 `verify` 与测试结果标准化；
9. 实现 `score` 和结果 JSON 汇总；
10. 建立重复运行一致性测试；
11. 接入 tree-sitter 并只实现一种语言的 C1；
12. 补齐该语言 Code 维度；
13. 搭建 NestJS + Fastify API、Prisma schema 和首个 migration；
14. 实现 artifact store 接口与本地/S3 适配器；
15. 实现 UPLOAD 安全解包和不可变快照；
16. 实现 GIT_REF 仓库/分支解析和 commit 快照；
17. 实现 grading result 幂等导入；
18. 实现 `AUTO / MANUAL / IMPORT` 状态机和非法转换测试；
19. 实现单份、批量管理员触发接口；
20. 实现报告查询和统一揭晓接口；
21. 编写可由平台调用的 GitLab CI 模板；
22. 接入 K8s Job 沙箱；
23. 完成上传/Git 提交、报告页、待评测列表和结果上传页；
24. 完成交付来源与 trigger 组合的端到端测试及 10 人并发测试；
25. 输出一期验收报告。

## 17. 开工前必须确认的决策

下列问题不会阻碍 Sprint 0 建契约和 grader 骨架，但必须在进入真实环境集成前确认：

1. 一期样题固定使用 Java、Go 还是 Python（与平台 Node.js 后端技术栈无关）；
2. 黄区内部允许的前端组件库及具体依赖版本；
3. 黄区内部批准的 Node.js LTS、pnpm、NestJS、Prisma 等依赖版本；
4. PostgreSQL 是否已有托管实例；
5. 是否已有 S3 兼容对象存储；若没有，一期 artifact PVC 的容量、备份和清理策略；
6. GitLab 是否允许项目级 Runner 创建 K8s Job；
7. 可读取的 Git host/group 范围以及只读凭据发放方式；
8. Git 场次使用固定分支还是按个人/团队生成分支；
9. 隐藏测试独立仓库的权限与拉取方式；
10. SSO 采用 OIDC 还是 SAML；
11. 内部镜像仓和制品库地址；
12. 组织数据由 SSO 字段提供还是另有 HR/组织接口；
13. 一期样题最终选择及验收负责人。

在这些信息未确认前，采用可替换适配器：开发期本地认证、模拟 GitLab 回调、本地容器沙箱和内存组织数据，避免阻塞核心评测闭环。

## 18. 一期 Definition of Done

一期只有同时满足以下条件才算完成：

- 一个新用户可以看到自己组织范围内的题；
- 场次可以配置 `UPLOAD` 或 `GIT_REF` 交付来源；
- UPLOAD 模式可以安全接收交付包并形成不可变快照；
- GIT_REF 模式可以从指定仓库和指定分支锁定 commit，并形成不可变快照；
- Git 分支后续移动不会改变已提交、已评测的快照；
- 同内容通过上传和 Git 提交时，评测引擎得到等价 workspace；
- 场次可以配置 `AUTO / MANUAL / IMPORT`，并可独立配置揭晓方式；
- AUTO 模式下上传完成或有效 Git 提交能自动触发评测；
- MANUAL 模式下提交只形成快照，管理员可以单份或批量触发评测；
- IMPORT 模式下不会启动 CI，管理员可以上传单份或批量线下结果；
- 提交代码在隔离沙箱内运行；
- 5 分钟内得到 Verify + Code 报告；
- 每项扣分都有机器证据；
- 同一 snapshot、同一判据版本重复运行结果一致；
- 非法结果不能导入；
- 导入结果与 event、subject 或 commit 不匹配时必须拒绝；
- 重复导入不会生成重复成绩；
- 10 人同时提交时服务稳定；
- 超时、禁网、越权和资源耗尽测试通过；
- 数据库迁移、部署、回滚和故障排查有文档；
- 一期真实演练完成并形成验收记录。

## 19. 建议的第一步

第一轮开发不要从页面开始。应先完成：

1. 初始化 Git 和 monorepo；
2. 建立根 `AGENTS.md`；
3. 冻结三个 Schema v1 草案；
4. 选定一期样题和单一语言；
5. 用黄金 fixture 跑通 `drill-grader run` 的本地最小闭环。

完成这五项后，平台 API、GitLab CI 和 K8s 都有稳定契约可以对接，Codex 后续的任务边界也会非常清楚。
