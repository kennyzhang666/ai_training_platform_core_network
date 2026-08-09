# AI 能力训战平台开发总览

> 当前版本：`v0.9.5`
> 更新日期：2026-08-10
> 当前阶段：`v0.9.5` 已发布；单服务器业务闭环、Windows x64 / Linux x64 离线发布契约和 SDD 综合训战端到端验收已完成，尚待两类真实断网服务器 UAT
> 发布范围：收口两阶段上传、不可变快照、评测批次、引擎 Skills/Python 依赖、首位管理员与 SSO 部门匹配；新增 `0016_upload_session_subject_binding`、SDD 日志脱敏综合赛题，以及同机 PostgreSQL、本地交付件、独立 Worker 且不依赖 MinIO、Redis、Kafka 或 Docker 的单服务器部署档。
> 下一优先级：在 Windows Server x64 与 Linux x64 目标机验证离线包、真实 PostgreSQL/SSO/Code Agent 后，继续一次安装、系统服务、自动备份、离线升级和脱敏诊断。
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
  |-- PlatformStore ------> 本地开发：文件适配器；所有生产档：PostgreSQL/Prisma
  |-- ObjectStorage ------> 本地开发/单服务器：本地目录；多服务器：S3-compatible 对象存储
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
| `deploy/single-node/` | 单服务器生产档、Nginx 模板、离线配置及启停/备份/恢复脚本 |
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

## 5. 当前实现状态（v0.9.5）

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
- 交付包和引擎包开发环境与单服务器生产档可落本地目录，多服务器生产档走 S3-compatible `ObjectStorage`；两种生产档的上传会话都落在 PostgreSQL `UploadSession`，可跨 API 重启恢复，文件 Repository 仍只用于本地开发；
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

版本验证记录：`pnpm test`（127 项，126 通过、1 项显式跳过）、`pnpm contract:test`（7/7）、`pnpm grader:test`（18/18）、`pnpm kit:test`（1/1）、`pnpm ldap3:test`（19/19）、`pnpm acceptance:local`（1/1）、`pnpm lint` 和 `pnpm build` 全部通过；`git diff --check` 通过。真实浏览器上传体验仍需在目标环境复验。

### 5.13 v0.9.0 发布状态（2026-08-07）

本次以本地生产模式真实部署为验收对象，补齐从内网 LDAP3 登录到平台 API、Worker 和前端反向代理的部署闭环；不新增数据库迁移、评分 Schema 或业务数据：

- 新增 LDAP3 网关显式本地 Mock 模式，仅用于个人电脑生产验收：任意非空密码可通过，已知本地账号保留固定角色，未知工号生成确定性的测试身份；真实内网部署默认仍关闭 Mock；
- 新增 `INTRANET_HTTP_ONLY` 纯 HTTP 内网开关，默认 HTTPS；启用后由网关统一关闭 Cookie `Secure` 标志，并提供对应 Nginx 配置和部署说明；LDAP 到目录服务器仍应使用 LDAPS 或 StartTLS；
- 修复 LDAP3 网关经 WSGI/Nginx 传输中文姓名、部门时的编码边界，API 同时兼容 UTF-8 字节形式和代理已解码的 Unicode，并增加 Windows PowerShell 本地 Mock 配置乱码修复；
- Worker 支持使用独立的 `EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET`、工号、姓名和部门签发受 HMAC 保护的服务身份头；内置评测器物化时同步复制平台契约目录，不再依赖 Worker 当前工作区；
- PostgreSQL 首次登录并发建档增加进程内 single-flight 和带退避的数据库重试，确保同一工号只创建一个用户且只产生一次 first-login 事实；
- 生产构建默认通过反向代理同源访问 `/api/v1`，补充退出登录按钮；空赛题/训战目录不再携带历史演示 ID，空数据库首屏可正常加载；
- 本地生产验收目录补充 HTTP-only、LDAP3 Mock、服务身份和部署说明，并重新生成独立评测引擎资料包。

本地 PostgreSQL 中的历史“停车场计费”演示训战、提交和评测批次已清理；这属于本地运行数据，不写入版本库，重新导入旧 `seed.json` 或恢复旧备份时仍会重新出现。

版本验证记录：发布前执行 `pnpm lint`、`pnpm test`、`pnpm contract:test`、`pnpm grader:test`、`pnpm kit:test`、`pnpm ldap3:test`、`pnpm build`、`git diff --check`，并通过本地 PostgreSQL、LDAP3 Mock、Nginx 反向代理和空目录 API 验收；最终结果以本次发布命令输出为准。

### 5.14 v0.9.1 发布状态（2026-08-09）

本次以“内网单服务器、少外部依赖、单场 50–100 人跑通真实训战”为边界，先修复阻断闭环的缺陷，再增加部署档：

- 本地演示训战改用稳定时间窗，并仅在无提交时修复旧演示时间；真实训战仍严格执行管理员配置的开放时间；
- 新增首位全局管理员工号引导，覆盖本地开发的空文件仓储与生产空 PostgreSQL；SSO 部门仅按组织 ID、路径或真实名称匹配，不再把“团队”等通用层级标签当作部门；
- 两阶段上传能力绑定操作者、训战和目标学员，提交时由能力证明首次交付件归属并创建不可变快照；新增 `0016_upload_session_subject_binding`，OpenAPI 同步 `uploadId` 与能力头；
- 引擎 `agent.skills` 规范化为目录，旧 `SKILL.md` 文件路径仍兼容；Worker 按包哈希缓存 Python 环境，支持内网镜像、离线 wheelhouse，并通过 `AI_TRAINING_ENGINE_PYTHON` 将解释器交给 Code Agent；
- 新增 `PLATFORM_DEPLOYMENT_PROFILE=single-node`：同机 PostgreSQL 作为业务事实来源，交付件与引擎包保存在本地目录，只运行一个 API 进程和独立 Worker；新环境不注入任何演示用户、赛题或训战；
- 单 API 内的 PostgreSQL 领域写入按序提交，避免集中提交时的快照 revision 争抢；本地对象存储的上传会话持久化到 PostgreSQL，API 重启后仍可确认已上传内容；
- LDAP3 WSGI 服务改为线程化；Windows 部署包提供配置检查、迁移、隐藏进程启动、状态、停止、PostgreSQL 与本地交付件一致性备份和可恢复还原，Linux Nginx/systemd 手册同步独立 Worker；
- 自动队列已完成 100 名学员集中提交与有界评测验收；外部 Worker + Code Agent 整批协议保持 20 名学员双引擎 20/20 验收。PostgreSQL 100 人并发写入集成用例已进入显式数据库测试和 GitLab CI，本机无数据库凭据时不伪造通过记录。

版本验证记录：`pnpm test` 141 项（140 通过、1 项按配置跳过）、`pnpm contract:test` 7/7、`pnpm grader:test` 18/18、`pnpm kit:test` 2/2、`pnpm ldap3:test` 20/20、`pnpm deployment:test` 5/5、`pnpm acceptance:local` 的 100 名学员全部完成，并通过 `pnpm lint`、`pnpm build` 和 `git diff --check`。PostgreSQL 集成套件仍需显式目标数据库，本机没有可用凭据，本轮未执行；新增的 100 人 PostgreSQL 写入用例由 GitLab 隔离数据库和目标服务器复验。

#### v0.9.1 部署成熟度结论

`v0.9.1` 已经达到“单服务器、少组件、可离线部署”，但还没有达到真正的一包安装和无人值守运维：

| 项目 | v0.9.1 现状 | 极简目标 |
| --- | --- | --- |
| 基础设施 | 同机 PostgreSQL + 本地磁盘，无 MinIO/Redis/Kafka/Docker | 保持不变，不为方便安装退回 JSON/SQLite |
| 目标机安装 | 仍需人工准备 Node、pnpm、Python、PowerShell 7、Nginx、PostgreSQL 和 Code Agent | 发布包携带平台运行时与已构建产物；目标机只要求 PostgreSQL、Code Agent 和企业 LDAP 可用 |
| 初始化 | 复制并手填 `.env`，再执行依赖安装、构建和 `Prepare` | 一份配置 + `Install`；自动生成随机密钥、执行迁移并检查端口、磁盘、LDAP、数据库和 Agent |
| 进程管理 | `manage.ps1` 启停隐藏进程并保存 PID | 注册为系统服务，开机自启、异常重启，仍由一个管理入口统一操作 |
| 备份 | 已能生成 PostgreSQL 与本地交付件的一致性 ZIP | 操作系统定时任务自动备份、校验、轮转和低磁盘预警 |
| 升级 | 仍需拉代码、安装依赖和重新构建 | 使用离线版本包升级；升级前自动备份，失败后恢复版本、数据库和交付件 |
| 排障 | 已有状态与进程日志 | 增加 `Doctor` 和脱敏诊断包，普通运维不需要阅读源码或拼命令 |

因此，当前架构已经足够简洁，后续不应通过引入容器编排、消息队列或更多存储服务来“优化运维”；应优先把现有组件包装成稳定的发布和服务管理流程。

### 5.15 v0.9.5 发布状态：单服务器闭环与双平台离线发布（2026-08-10）

本版本把此前未单独推送的单服务器闭环、双平台离线发布和 SDD 真实训战验收统一收口。离线包纵切面只保证“在发布机生成可搬运运行包，目标机无需源码和构建工具”，没有提前宣称一次安装、系统服务和自动升级已经完成：

- 发布契约固定为 `win32-x64` 与 `linux-x64`。两者共用 Web/API、PostgreSQL Schema 与迁移、Worker、评分契约和本地数据目录语义，平台差异仅限运行时、归档格式和管理入口；
- 新增可复现发布组装器：发布机先构建 Web/API，并生成不含开发依赖的实体 Node 依赖树，再打包 Node、Python、Nginx、LDAP 网关、wheelhouse、迁移、Worker、契约、运维脚本、`VERSION`、逐文件 SHA-256 清单和归档校验文件；
- Windows 包增加内置 PowerShell 入口 `manage.cmd`，生产依赖不含符号链接，不要求目标机开启开发者模式；ZIP 生成支持 Windows 长路径。Linux 包增加 `manage.sh`，与 Windows 对齐 `Prepare`、`Start`、`Stop`、`Status`、`Backup`、`Restore`、`Doctor`；
- 发布任务强制在目标系统和 x64 架构上执行，避免跨平台复制 Prisma 引擎、Python 扩展或 Nginx；目标服务器仍只需准备同机 PostgreSQL、企业 LDAP 和 Code Agent；
- 发布包拒绝真实 `.env`、平台 TypeScript 源码和测试目录，允许生产依赖自身必要的 `src` 文件；发布目录与 ZIP/tar.gz 都通过清单复核，固定时间戳时归档字节可重复；
- GitLab 构建门禁已加入双平台发布契约和部署脚本测试；Linux Runner 会实际执行 Bash 语法检查，本地 Windows 会实际执行 PowerShell 语法检查。
- 新增“基于SDD的运维日志脱敏工具开发实战演练”：以 `SPEC.md` 为主要证据，交叉核对实现、测试和 AI 协作记录；提供严格五文件交付契约、Code Agent 指令、评测 Skill、四维 16 点 A/B/C/D 规则、满分参考件和合规学员样例。
- 本机已按真实角色完成管理员发布、员工上传、精确选择提交、Worker 批次物化、引擎执行、结果回传、服务端重算、报告、排名、审计和个人画像验收；样例得分 95.75，9 项交付件测试全部通过。

本地证据：`pnpm test` 144 项（143 通过、1 项 PostgreSQL 集成按配置跳过），契约 7/7、Python grader 18/18、SDD 专项 3/3、评测资料包 2/2、发布 5/5；`pnpm deployment:test` 在 Windows 为 8 项通过、Linux Bash 项按平台跳过；100 人集中提交和有界队列通过。Windows 实际生产 Node 依赖曾完成 13,530 文件、零符号链接的布局与 ZIP/SHA-256 验证；本机当前未提供正式双平台运行时输入，因此不把测试归档冒充目标服务器发布包。Linux 原生生产依赖、真实运行时、断网启动、真实 LDAP/PostgreSQL/Code Agent 仍必须在目标机复验。

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
| `v0.9.0` | 2026-08-07 | 收口本地生产模式与内网部署：LDAP3 Mock/中文身份传输、纯 HTTP 开关、Worker 服务身份、并发建档重试、反向代理同源 API、退出登录和空目录初始化。 |
| `v0.9.1` | 2026-08-09 | 修复首次管理员、上传快照、Skills/依赖和 SSO 匹配；新增同机 PostgreSQL 单服务器生产档、离线 Worker 环境、统一运维脚本及 100 人集中提交验收。 |
| `v0.9.5` | 2026-08-10 | 收口单服务器闭环、Windows/Linux 可复现离线发布契约和 SDD 日志脱敏综合赛题真实端到端验收；真实目标机 UAT 与无人值守运维继续推进。 |

## 7. 后续开发路线

路线以“先完成可部署的核心平台，再接最后的 GitLab 自动评测接口”为原则。每次只实现一个有契约、有测试、可演示的纵切面。

### 7.1 v0.9.6：目标机验收与极简运维（下一阶段）

目标：在一台干净的内网服务器上，不访问互联网、不拉源码、不执行前端构建，运维人员使用 `v0.9.5` 对应平台的离线发布包和一份配置，在 30 分钟内完成安装并获得可自动恢复的长期运行服务。

保持以下架构约束：

- 正式业务数据继续使用同机 PostgreSQL，交付件和引擎包继续使用本地磁盘；
- API 与 Worker 继续分进程，Code Agent 不进入 API 进程；
- 不引入 Docker、Kubernetes、Redis、Kafka、MinIO 或额外配置中心；
- 不为了少装 PostgreSQL 而把正式数据改回 JSON 文件或 SQLite；
- 所有安装、诊断、备份和升级输出必须脱敏，不打印数据库密码、SSO 断言、Cookie、令牌或完整源码。

按以下纵切面依次实现，每一项独立补测试和验收：

1. **离线发布包（代码完成，目标机 UAT 待完成）**：已新增可复现的 Windows x64 ZIP 与 Linux x64 tar.gz 发布任务，包含已构建 Web/API、实体生产 Node 依赖、数据库迁移、平台 Python 运行时、固定依赖、wheelhouse、Nginx、Windows PowerShell/服务包装器、Worker、契约、双平台运维脚本、版本清单和 SHA-256 校验；目标机不再运行 `pnpm install`、`pnpm build` 或 `git pull`。PostgreSQL 与 Code Agent 使用公司统一软件包，不由平台联网下载。
2. **一次安装与自检**：将 `manage.ps1` 扩展为 `Install`、`Doctor` 和 `Uninstall`；安装时生成内部随机密钥，校验并保存一份正式配置，执行数据库迁移，检查端口、目录权限、剩余磁盘、PostgreSQL、LDAP、Nginx、Worker 身份和 Code Agent 命令。`Doctor` 只输出检查结论和脱敏原因。
3. **系统服务**：随发布包携带单个服务包装器，把 API、LDAP 网关、Worker 和 Nginx 注册为自动启动、异常重启的 Windows 服务；Linux 继续生成等价 systemd 单元。运维仍只使用 `Start`、`Stop`、`Restart`、`Status`，不直接管理各子进程。
4. **自动备份与保留**：增加 `Schedule-Backup`、`Verify-Backup` 和 `Prune-Backups`，复用 Windows 任务计划或 systemd timer，不新增常驻服务；默认每日备份、保留最近 7 份，备份前检查空间，备份后校验 manifest、数据库图谱和 ZIP 可读性。
5. **离线升级与失败回退**：增加 `Upgrade -Package`，校验版本和哈希后自动停止服务、生成恢复点、部署新版本、执行迁移并做健康检查；失败时恢复旧程序、数据库和 `data/`。已发布迁移不反向修改，数据库回退始终使用升级前恢复点。
6. **诊断与日志轮转**：增加 `Collect-Diagnostics`，收集版本、健康检查、迁移状态、磁盘容量、服务状态和截断日志；自动过滤密钥与身份头。日志按大小轮转并设置保留天数，避免单机长期运行耗尽磁盘。
7. **目标环境验收**：分别在断网的全新 Windows Server x64 与 Linux x64 服务器上验证安装、重启、自启动、100 人提交、真实 Code Agent 全批次回传、定时备份、整机恢复和故意升级失败回退；记录安装时间、峰值 CPU/内存/磁盘和评测总时长。

完成标准：目标机日常只需要 `Status`、`Backup`、`Upgrade`、`Restore`、`Doctor` 五类操作；除 PostgreSQL、Code Agent 和企业 LDAP 外，不要求运维理解 Node、pnpm、Python 虚拟环境或平台源码。

### 7.2 生产数据与身份底座（长期演进）

目标：为生产运行提供 PostgreSQL 事实来源，并为需要多 API 实例和独立存储服务的标准生产档提供 S3 能力。v0.9.5 的单服务器档固定使用同机 PostgreSQL、真实 SSO、一个 API 进程、独立 Worker 和本地交付件目录，不引入 MinIO、Redis、Kafka 或 Docker；多 API 实例再切换独立 PostgreSQL 与 S3-compatible 对象存储。

- 实现 `PlatformRepository` 边界，将 `PlatformStore` 的持久化职责迁移到 Prisma/PostgreSQL（W1 组织/人员/审计已完成，其他高频领域继续迁移）；
- 为提交、评测运行、批次租约、结果导入和审计增加数据库事务与唯一约束；
- 接入真实内部 SSO 网关会话或 OIDC/JWT Guard，保留按工号首次建档逻辑；
- 对员工、提交、审计、画像实现服务端分页、筛选和稳定排序；
- 将 ArtifactStore 替换为对象存储，上传改为流式/预签名方式（S3 两阶段上传与 PostgreSQL 会话持久化已完成适配器级实现）；
- 建立迁移、备份、恢复和种子数据隔离流程。

验收证据：PostgreSQL 集成测试、并发唯一性测试、SSO 越权矩阵、对象存储集成测试、迁移回滚演练记录。

### 7.3 正式评测运行环境（长期演进）

v0.8.x 已完成运行配置、Worker 诊断、受控配置测试、日志目录、独立评测引擎资料包、管理端运行详情和赛题生命周期管理的代码纵切面。目标环境还需要继续完成以下部署级工作：

- Worker 使用服务身份和短期令牌，不再借用员工身份头；
- Code Agent 命令在部署环境使用受控模板/注册表，禁止任意可执行文件和参数逃逸；
- 接入 K8s Job 或等价沙箱，落实禁网、非 root、只读根文件系统、CPU/内存/磁盘/时限；
- 凭据只由运行环境注入，平台和日志不保存 token、Cookie 或完整源码；
- 在目标环境补齐批次队列指标、心跳、失败原因、重试策略、告警和容量基线；
- 对大包、恶意 ZIP、超时 Agent、部分失败、重复回传和租约争抢做故障注入。

验收证据：沙箱安全测试、Worker 身份测试、故障恢复测试、批次观测面板、容量基线和生产回滚记录。v0.8.0 已提供本地/受控开发验证入口，但不将本地 bridge 或 API 内嵌执行器视为生产证据。

### 7.4 v0.9.x：业务完整性与可运营性（单服务器基础档已完成，业务扩展继续排期）

v0.9.5 已完成单服务器基础档、真实 SSO 边界、独立 Worker、离线引擎依赖、100 人集中提交验收、20 人外部 Worker 协议验收和 SDD 综合赛题单人真实端到端验收；以下业务完整性工作仍是后续迭代目标，目标环境仍需使用真实 LDAP、PostgreSQL 与 Code Agent 复验。

目标：满足真实部门试点的日常配置、复核和复盘需求。

- 拆分前端路由、领域模块和通用表格/表单/状态组件，保留既定 UI 与文案规范；
- 完成导师工作台、出题人权限、报告复核和结果申诉流程；
- 完善富文本存储、完整标签白名单清洗、附件和版本差异；
- 增加公告定向范围、站内通知和关键截止提醒；
- 完善赛季、榜单、部门下钻、画像导出和结果可见性策略；
- 为组织调整、员工转部门、管理员权限回收建立历史快照和审批规则；
- 建立员工端与管理端关键路径的浏览器端到端测试。

验收证据：角色化 UAT 脚本、可访问性检查、XSS 安全测试、跨部门隔离测试、浏览器 E2E。

### 7.5 v1.0.0：试点发布与生产验收

目标：完成一个部门到多部门试点的生产发布准备。

- 性能和容量压测、依赖和镜像安全扫描、审计留存与数据脱敏；
- 灰度、回滚、备份恢复、故障应急和运维手册；
- 产品指标、SLA/SLO、告警阈值和版本发布清单；
- 用真实但脱敏的训战完成从建题到能力画像的全链路验收。

### 7.6 后置接口：GitLab CI 自动评测

根据当前产品决策，GitLab CI 自动评测接口放在核心平台完成之后。它应作为新的 `GradingExecutor`/Worker 适配器接入，不得复制一套评分或结果入库逻辑。接口仍必须输出同一 `evaluation-result` 契约，并经过平台的 Schema、归属、幂等和重算校验。

## 8. 下一位 Codex 的推荐起点

当前代码已覆盖单服务器训战所需的 SSO 首次建档、组织与角色、赛题/训战、不可变提交、100 人集中提交队列、20 人外部 Worker 协议评测、报告画像和 PostgreSQL/本地交付件一致性备份恢复。下一位 Codex 应优先执行 §7.1，并保持每次只交付一个可验收纵切面：

1. 在 Windows x64 与 Linux x64 发布机分别准备固定版本的 Node、Python、Nginx、PowerShell/服务包装器和平台 wheelhouse，生成两个候选包并把输入版本、SHA-256 和系统 ABI 记录到发布清单；
2. 在两台干净、断网的目标服务器上执行 `Prepare`、`Doctor`、`Start`、SSO 登录、提交、批次评测、备份和恢复，确认目标机没有隐式源码、pnpm、网络或符号链接依赖；
3. UAT 通过后实现 `Install` 与配置生成，再接入 Windows 服务和 Linux systemd、自动备份；不要同时重写业务模块；
4. 完成 `Upgrade` 和失败恢复后，使用真实 LDAP、同机 PostgreSQL、Nginx 和目标 Code Agent 执行 50–100 人全链路 UAT；
5. 记录实际赛题引擎的批次耗时与资源占用；只有单 API 或本地磁盘达到容量边界时，才切换独立 PostgreSQL 与 S3-compatible 对象存储的多服务器生产档。

### 8.1 v0.8.2 评审提出的优先事项

以下条目来自 v0.8.2 的全局代码评审，按建议顺序排列；已完成项保留为证据，未完成项继续作为后续门禁。

1. **服务端富文本白名单清洗（已在 v0.8.8 完成）。** 赛题详情 `description` 的 API 写入路径现在与浏览器端共用危险标签、属性、图片 data URL、文件魔数和大小边界校验；前端清洗仍保留为纵深防御，已有数据回填和目标环境复验仍需按数据治理要求执行。
2. **Worker 解压的独立体积上限。** `scripts/evaluation-worker.mjs` 的 `safeExtract` 正确拒绝了绝对路径、`..` 和符号链接，但没有自己的解压后体积上限，完全依赖 API 入库前的 `validateArchive`。Worker 是独立进程且未来会从对象存储直接物化，应在解压侧也强制 `maxFiles` / `maxExpandedBytes`，让防护不依赖调用方。
3. **拆分 `store.ts` 与 `admin.tsx`。** 两个文件分别为 240KB 和 228KB，`PlatformStore` 同时承担状态机、授权、审计和持久化四种职责。这是当前最大的可维护性风险，也是 §7.4 前端模块化的前置条件。建议按领域（赛题/训战、提交/评测、组织/人员、报告/画像）逐个切出窄接口，每次迁移保持测试绿色，不要一次性重写。
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
