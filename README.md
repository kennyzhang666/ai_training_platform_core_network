# AI 能力训战平台开发手册

> 当前版本：`v0.9.8`
> 更新日期：2026-08-10
> 适用范围：平台开发、接口契约、测试、发布和后续 Codex 交接

企业内部 AI 训战、交付评测和能力复盘平台。当前版本已经完成赛题、训战、提交、独立 Worker 评测、详细报告、能力画像、组织权限和单服务器离线发布的本地闭环，并提供 Ubuntu 22.04 x64 原生 GitHub 发布流水线；Windows Server x64 与 Ubuntu 22.04.5 断网目标机 UAT、系统服务化、自动备份和离线升级仍是下一阶段工作。

平台级文档只保留三个入口：

- 本文件：开发、架构、测试、发布、版本和路线；
- [`DESIGN.md`](DESIGN.md)：产品、业务、评测、权限、页面、视觉与文案设计；
- [`DEPLOYMENT.html`](DEPLOYMENT.html)：Windows/Linux、单服务器、标准分离部署、认证、备份恢复和排障。

`contracts/`、`grader/`、`executors/`、`challenges/`、`tools/engine-dev-kit/` 以及 `docs/evaluation-*.md`、`docs/submission-contract.md` 中的 Markdown 属于契约、赛题或评测运行资产，不是重复的平台说明文档，不能为了减少文件数量而合并或删除。

## 1. 开发前必读

开始修改代码前，按以下顺序确认事实：

1. 阅读 [`AGENTS.md`](AGENTS.md) 与本手册；
2. 涉及产品行为或页面时阅读 [`DESIGN.md`](DESIGN.md)；
3. 涉及部署、身份、存储或 Worker 运行方式时阅读 [`DEPLOYMENT.html`](DEPLOYMENT.html)；
4. HTTP 行为以 `contracts/openapi.yaml` 为事实来源；
5. 跨进程结构以 `contracts/*.schema.json` 为事实来源；
6. 当前真实行为以实现和自动化测试为准，不以历史版本描述推断功能。

不可变工程规则：

- API 使用 TypeScript、NestJS 和 Fastify；评测执行使用独立 Worker、Python CLI 与 Code Agent；
- 不在 Node API 进程中执行学员交付件；
- 上传和 Git 交付件进入评测前必须固化为不可变快照；
- 结果必须经过 JSON Schema、运行归属、提交归属、幂等键和服务端重算校验；
- `AUTO`、`MANUAL`、`IMPORT` 只表示触发方式，最终进入同一个结果可信边界；
- 已发布的 Schema、rubric、赛题版本和数据库迁移不得原地修改，变更必须升版本；
- 管理权限由服务端认证上下文和组织范围决定，前端隐藏按钮不构成授权；
- 测试失败不能通过删除测试、吞异常或放宽校验解决。

## 2. 本地环境与快速启动

### 2.1 基础环境

- Node.js 20 或更高版本；
- pnpm 11.8.0；
- Python 3.11 或更高版本。

Windows PowerShell：

```powershell
pnpm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r grader/requirements.txt
```

Linux/macOS shell：

```bash
pnpm install
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r grader/requirements.txt
```

### 2.2 启动开发环境

分别打开两个终端：

```powershell
pnpm dev:api
```

```powershell
pnpm dev:web
```

默认地址：

| 服务 | 地址 |
| --- | --- |
| Web | `http://127.0.0.1:5173` |
| API | `http://127.0.0.1:3000/api/v1` |
| 健康检查 | `http://127.0.0.1:3000/api/v1/health` |

开发构建提供本地身份切换器，便于验收全局管理员、部门管理员、导师和学员视图。常用本地身份：

| 身份 | 工号 |
| --- | --- |
| 全局管理员 | `w00123` |
| 学员 | `w00124`–`w00132` |
| 导师 | `w00133` |

也可以在启动 Web 前固定工号：

```powershell
$env:VITE_EMPLOYEE_ID='w00124'
pnpm dev:web
```

本地身份切换只允许出现在开发构建。生产环境不能启用 `VITE_LOCAL_IDENTITY_SWITCHER=true`，不能使用 `PLATFORM_IDENTITY_MODE=LOCAL`，也不能开启匿名身份。

开发数据默认写入 `tmp/platform-data.json`、`tmp/artifacts/` 和 `tmp/evaluation-*`。正式环境必须使用 PostgreSQL；部署方式见 [`DEPLOYMENT.html`](DEPLOYMENT.html)。

## 3. 产品与领域边界

平台服务四类正式用户：新员工、导师、出题人和管理员。管理员分为全局管理员与部门管理员。完整产品设计见 [`DESIGN.md`](DESIGN.md)，开发实现必须保持以下领域边界：

- **赛题**是可复用资产，包含类别、题面、版本、交付契约、评测引擎和评分规则；
- **训战**是赛题版本的一次运行安排，包含时间、分区、赛制、交付方式、评测方式、参与范围和揭晓策略；
- **提交**是员工通过 ZIP 或受控 Git 分支交付的不可变快照；
- **评测运行**是一份提交的一次评分尝试，重新评测新增运行，不覆盖历史；
- **评测批次**是管理员从同一训战中精确选择一人或多人后创建的完整 Worker 工作单元；
- **评测结果**是通过平台可信边界保存的结构化证据；
- **报告与画像**从单场证据、四维能力、16 个评分点和八个能力域逐层聚合；
- **难题榜**复用赛题库中的难题类资产，经过审核、提交、发布者评审和揭榜形成闭环。

赛题和训战不能合并成一个模型。后台资产标签 `TRAINING`、`COMPETITION`、`HARD_PROBLEM` 不能作为员工卡片上的主要信息；员工看到的是训战主题、简介、分区、状态、开放时间、交付方式和可执行操作。

## 4. 总体架构

```text
员工 / 导师 / 出题人 / 管理员
                |
                v
          React + Vite Web
                |
                | REST / JSON
                v
       NestJS + Fastify Platform API
       |-- 身份、角色、组织范围
       |-- 赛题、训战、名单、提交状态机
       |-- 交付契约与结果契约校验
       |-- 批次租约、幂等录入、报告画像
       |-- 公告与操作审计
       |
       |-- PostgreSQL / Prisma
       |-- 本地不可变目录或 S3-compatible 存储
       `-- 受控 Git 快照适配器
                |
                v
        独立 Evaluation Worker
       |-- 领取完整批次并续租
       |-- 校验、解包并复核快照
       |-- 物化引擎、instruction、Skills、Schema
       `-- 创建隔离批次目录
                |
                v
          Code Agent / Agent CLI
       |-- 按清单逐份调用赛题评测引擎
       `-- 写出单人结果与批次结果索引
                |
                v
        Platform API 校验、重算、保存
```

生产环境的 API 和 Worker 必须分进程。单服务器部署只是把 PostgreSQL、API、Web、认证网关和 Worker 放在同一台服务器上，不代表把它们合并成一个进程。

## 5. 代码目录

| 路径 | 职责 |
| --- | --- |
| `apps/web/` | React 员工端和管理端 |
| `services/platform-api/` | NestJS/Fastify API、领域状态机、权限与持久化 |
| `services/platform-api/prisma/` | PostgreSQL Schema 与版本化迁移 |
| `services/ldap3-gateway/` | LDAP3 登录、会话和可信身份头适配器 |
| `contracts/` | OpenAPI、输入输出 JSON Schema、示例和评测契约目录 |
| `grader/` | Python CLI、评分计算、快照与交付校验 |
| `executors/` | 平台内置的版本化评测执行器 |
| `challenges/` | 示例赛题、引擎、Skill、参考件和样例交付件 |
| `scripts/evaluation-worker.mjs` | 拉取式批次 Worker |
| `scripts/code-agent-local-bridge.mjs` | 仅用于联调的本地 Code Agent 适配器 |
| `scripts/build-single-node-release.mjs` | Windows/Linux 离线发布包组装器 |
| `scripts/prepare-linux-release-runtime.sh` | Ubuntu 22.04 x64 固定版本运行时与离线 wheelhouse 准备器 |
| `.github/workflows/release-linux-ubuntu-22.04.yml` | 从不可变版本标签构建并发布 Linux 离线包 |
| `deploy/single-node/` | 单服务器运维脚本、配置模板与 Nginx 模板 |
| `tools/engine-dev-kit/` | 可独立交付给评测引擎开发者的工具包 |
| `tmp/` | 本地数据、日志和临时工作区，不进入版本库 |

API 内部关键边界：

- `PlatformController`：HTTP 入口、认证上下文和请求响应映射；
- `PlatformStore`：领域状态机、授权、审计和开发期文件适配；
- `PostgresPlatformStore` / Repository：生产关系事实与请求级事务；
- `ArtifactStore` / ObjectStorage：交付件和引擎包的不可变字节；
- `SubmissionContractService`：ZIP/Git 目录结构和赛题交付契约；
- `EvaluationBatchService`：创建、领取、心跳、完成、失败和租约恢复；
- `EnginePackageStore` / `ExecutorRegistry`：上传引擎包和内置执行器版本；
- `ScoreValidator`：Schema、归属、幂等与分数重算；
- `IdentityGuard`：LOCAL、OIDC、TRUSTED_GATEWAY 认证上下文。

## 6. 身份、人员与组织权限

内部 SSO 只提供工号、姓名和部门。首次可信请求按工号幂等登记：

- 工号和姓名由 SSO 管理，平台不能修改；
- 部门名称、编号或路径能匹配组织树时自动归属；
- 无法匹配时保留为空，由全局管理员配置；
- 管理员不能手工新增员工，只能配置部门、角色和角色范围；
- 昵称和头像属于平台个人资料，可以由员工维护。

权限层级：

| 角色 | 服务端范围 |
| --- | --- |
| 全局管理员 | 全组织、所有管理员角色、全局评测环境和跨部门数据 |
| 部门管理员 | 授权组织路径及子路径，不能配置其他管理员 |
| 导师 | 明确面向自己的训战和授权数据 |
| 出题人 | 授权范围内的赛题与难题评审 |
| 新员工 | 面向自己的训战、提交、已揭晓报告和个人画像 |

组织路径使用物化路径。部门管理员范围以规范化路径前缀计算。删除组织只允许空的非根节点；存在下级组织、直属员工、管理员范围、训战对象或其他业务引用时必须返回冲突。

开发期使用 `X-Employee-Id`。生产期只能使用 OIDC/JWT 或 `TRUSTED_GATEWAY`；反向代理必须清除浏览器传入的 `X-Employee-Id` 与 `X-Trusted-*`，再写入可信身份。

## 7. 提交与不可变快照

```text
选择 ZIP / 受控 Git 分支
  -> 校验训战开放时间、参与权限和交付方式
  -> 校验大小、路径、目录结构和赛题交付契约
  -> 固化 artifactHash + snapshotHash + 提交人/组织快照
  -> 保存不可变提交
  -> QUEUED / 等待管理员 / 等待导入
  -> GRADING
  -> GRADED 或 FAILED
```

必须保持的安全与一致性规则：

- Git 地址只能来自已发布训战配置，客户端不能提供任意 URL；
- ZIP 拒绝绝对路径、路径穿越、软链接逃逸、文件数量超限和解压炸弹；
- Worker 解包时必须再次检查路径、软链接、数量、体积和快照哈希；
- `snapshotHash` 覆盖排序后的相对路径、内容 SHA-256 和执行权限位；
- 提交进入排队或评测中后锁定，完成或失败后才能重新交付；
- 重新评测创建新的 `GradingRun`，历史结果不可覆盖；
- 相同快照由不同员工提交时，仍然各自拥有独立运行和结果。

赛题交付契约属于管理后台和评测运行资产，详见 `docs/submission-contract.md`。

## 8. 批次评测协议

管理员在评测中心进入具体训战，查看每名员工的提交，精确勾选一人或多人后发起批次：

1. API 为选中提交创建不可变 `GradingRun`；
2. 同一训战的运行组成一个不可拆分的 `EvaluationBatch`；
3. 批次冻结赛题版本、引擎版本、输入输出契约、运行配置和提交快照；
4. Worker 通过租约领取完整批次并持续心跳；
5. Worker 物化 `batch-manifest.json`、引擎、`instruction.md`、Skills、Schema 和全部交付件；
6. Worker 以 `shell: false` 启动白名单内的 Code Agent；
7. Code Agent 按清单逐份评分，写出单人结果和批次索引；
8. Worker 回传成功项和失败项；
9. API 逐项校验 Schema、运行归属、提交归属和幂等键；
10. API 以提交快照覆盖结果中的人员信息，按 criteria 重算 dimensions 和 total；
11. 结果不可变保存，更新报告、画像和审计。

`AUTO`、`MANUAL`、`IMPORT` 的区别只在第 1 步由谁触发：

| 模式 | 触发方式 | 结果入口 |
| --- | --- | --- |
| `AUTO` | 提交后自动建运行 | 同一 Worker 回传边界 |
| `MANUAL` | 管理员勾选后发起 | 同一 Worker 回传边界 |
| `IMPORT` | 管理员线下评测后导入 | 同一 Schema、归属、幂等与重算边界 |

完整 ABI、命令占位符、目录布局、日志和结果索引保留在 `docs/evaluation-engine-protocol.md`，因为该文件会随管理后台的评测引擎开发包交付。

### 8.1 本地批次联调

管理员发起批次后，另开终端启动 Worker：

```powershell
$env:CODE_AGENT_COMMAND=(Get-Command node).Source
$bridge=(Resolve-Path .\scripts\code-agent-local-bridge.mjs).Path
$env:CODE_AGENT_ARGS_JSON=(ConvertTo-Json @($bridge) -Compress)
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker local-eval-host
```

本地 bridge 只验证批次 ABI，不能作为真实生产评测证据。生产使用管理员配置的受控 Code Agent 命令、独立 Worker 身份和部署环境提供的隔离措施。

## 9. 结果、报告与能力画像

评测结果不能只有总分。当前结果模型至少保留：

- 总分、排名、部门对比、结果状态与版本；
- Verify、Spec、Code、Collab 四维汇总；
- V1–V4、S1–S4、C1–C4、P1–P4 共 16 个评分点；
- 判据、实际证据、判定来源、文件、行号、代码片段、问题说明和修改建议；
- 验收测试、代码度量、提交时间线和 commit 时间线；
- 八个 AI 能力域及有效证据覆盖度；
- 个人趋势、蓝区/黄区分布、部门平均、中位数和百分位；
- 管理员按部门、训战或指定员工集合查看的聚合平均画像。

八个能力域是对已有评分点的归一化聚合，不是第二套评分规则：

1. AI 基础与工具选型；
2. 需求理解与任务拆解；
3. 提示词工程与上下文管理；
4. 检索增强与事实核验；
5. 工具调用与 Agent 编排；
6. AI 输出评审与测试；
7. 工程化交付与自动化；
8. 安全合规与风险控制。

无有效证据的能力域返回 `null` 和“待评测”，不能用默认分或相邻能力推断。员工结果遵守揭晓策略；管理员只能在自己的组织范围内查看内部结果。

## 10. 数据与运行适配器

| 边界 | 本地开发 | 单服务器生产 | 标准分离生产 |
| --- | --- | --- | --- |
| 业务数据 | 文件或内存 | PostgreSQL | PostgreSQL |
| 交付件 | 本地目录 | 本地不可变目录 | S3-compatible 对象存储 |
| 上传会话 | 进程内/文件 | PostgreSQL | PostgreSQL |
| 身份 | `X-Employee-Id` | LDAP3 + `TRUSTED_GATEWAY` 或 OIDC | 企业网关/OIDC |
| Worker | 本地独立进程 | 同机独立进程 | 独立 Worker 节点 |
| Code Agent | 本地 bridge | 受控 CLI | 受控 CLI/Agent 服务 |

所有生产档都必须设置 `PLATFORM_REPOSITORY=postgres`。只有 `PLATFORM_DEPLOYMENT_PROFILE=single-node` 的生产模式允许 `OBJECT_STORAGE_MODE=local`；标准生产默认要求 S3-compatible 存储和持久化上传会话。

PostgreSQL 请求级读写使用 repeatable-read 事务并以 revision CAS 拒绝旧状态覆盖。当前单服务器档只运行一个 API 实例；虽然标准模式存在数据库和 S3 适配器，但多 API 实例仍需继续拆分领域 Repository 并完成容量与故障演练，不能把现有 CAS 当成完整高可用方案。

## 11. API 与契约开发

契约事实来源：

- `contracts/openapi.yaml`：HTTP API；
- `contracts/*.schema.json`：题目、提交、引擎调用、批次和评测结果；
- `contracts/examples/`：合法样例；
- `contracts/evaluation-contract-catalog.json`：管理后台可选择的输入/输出约束；
- `services/platform-api/prisma/migrations/`：数据库事实变更。

API 修改顺序：

1. 先修改 OpenAPI 或版本化 JSON Schema；
2. 增加合法、非法和边界样例；
3. 先补失败测试；
4. 实现服务端行为；
5. 更新 TypeScript 和 Python 契约测试；
6. 接入前端并验证权限、空状态、失败状态和分页；
7. 若发布 Schema、rubric 或迁移发生变化，新增版本，禁止覆盖旧文件。

所有错误响应至少包含稳定 `code` 和正式业务 `message`。服务端异常日志只记录请求 ID、状态码、稳定错误码和异常类型，不记录 token、Cookie、SSO 断言、数据库密码、评测完整 stderr 或学员完整源码。

## 12. 测试策略

### 12.1 常用命令

```powershell
pnpm contract:test
pnpm grader:test
pnpm test
pnpm kit:test
pnpm ldap3:test
pnpm deployment:test
pnpm release:test
pnpm lint
pnpm build
pnpm acceptance:local
git diff --check
```

测试分层：

| 层级 | 目的 |
| --- | --- |
| 契约测试 | 锁定 OpenAPI、JSON Schema、跨语言样例和响应形状 |
| 领域单元测试 | 状态机、权限、幂等、分页、哈希和校验规则 |
| PostgreSQL 集成测试 | 迁移、事务、唯一性、租约 CAS、备份恢复和并发 |
| Worker 端到端 | 批次领取、物化、Agent 启动、结果回传和部分失败 |
| 本地验收 | 100 人集中提交、有界队列与完整业务闭环 |
| 部署/发布测试 | Windows/Linux 脚本、运行时门禁、可复现归档和清单 |
| 浏览器验收 | 全局管理员、部门管理员、导师和学员关键路径 |

PostgreSQL 集成测试需要显式数据库，不得因本机没有数据库而伪造通过：

```powershell
$env:POSTGRES_INTEGRATION='true'
$env:DATABASE_URL='postgresql://...'
pnpm --filter @ai-training/platform-api test:integration:postgres
```

受影响模块至少运行对应测试。发布版本必须运行完整检查；涉及 UI 时还要用浏览器验证不同角色、分页固定高度、空状态和窄屏布局。

### 12.2 v0.9.8 已验证基线

- Workspace：152 项，151 通过，1 项 PostgreSQL 集成按显式配置跳过；
- Web 交付方式规则：3/3；
- 契约：7/7；
- Python grader：18/18；
- LDAP 网关：20/20；
- 评测资料包：2/2；
- 离线发布：9/9；
- Windows 部署门禁：15 项通过；Linux Bash 原生语法项在 Windows 上按平台跳过；
- 100 人集中提交与有界评测队列：通过；
- 构建、类型检查和 `git diff --check`：通过。

这些是本地与自动化证据，不替代 Windows Server、Linux Server、真实 PostgreSQL、真实 LDAP 和真实 Code Agent 的断网 UAT。

## 13. 开发工作流

每次只实现一个可验收纵切面：

1. 确认业务行为与权限范围；
2. 更新契约和样例；
3. 增加失败测试；
4. 实现后端状态机和持久化；
5. 实现前端正式业务文案和交互；
6. 运行受影响模块测试；
7. 检查部署、迁移、文档和兼容性影响；
8. 记录已完成事实与未解决风险。

代码审查重点：

- 是否绕过不可变快照或结果可信边界；
- 是否信任客户端或评测器自报的身份、组织或总分；
- 是否遗漏部门管理员的组织范围；
- 是否在生产配置中回退到 file、LOCAL 或 API 内嵌评测；
- 是否出现无稳定排序的分页；
- 是否记录敏感信息或完整源码；
- 是否修改已发布迁移、Schema、rubric 或赛题版本；
- 是否新增依赖却没有进入离线发布包和 wheelhouse；
- 是否把开发者说明、示例提示或元描述渲染到正式页面。

## 14. 发布规则

形成可发布版本时必须同时完成：

- 同步根目录、Web 和 API 三个 `package.json` 版本；
- 更新本手册顶部状态、已验证基线、版本沿革和后续路线；
- 产品或 UI 规则变化时更新 `DESIGN.md`；
- 部署变量、命令、拓扑或运维动作变化时更新 `DEPLOYMENT.html`；
- API 和跨进程结构同步 OpenAPI、Schema、样例与双语言契约测试；
- 数据结构新增版本化迁移，不修改历史迁移；
- 重新生成并验证管理后台评测引擎 Markdown/ZIP 资料包；
- 运行完整发布检查，确认构建后工作区没有意外产物；
- 提交前确认没有 `.env`、密码、员工数据、生产仓库地址、运行日志或 `tmp/` 内容。

历史发布细节以 Git 标签和提交为准；`CHANGELOG.md` 只保留发布事实，不承载架构、开发或部署说明。

## 15. 当前实现状态

### 15.1 已可本地验收

- 员工首页、训战广场、赛题详情、提交、报告、个人中心和能力画像；
- 赛题草稿、版本、发布、封存、垃圾箱、恢复、永久删除和富文本；
- 训战时间、分区、赛制、交付方式、评测方式、参与部门、人员和导师范围；
- ZIP 与受控 Git 固定版本提交、不可变快照和赛题级目录校验；
- 提交页面按训战配置锁定上传或 Git 交付方式，未开放选项不可交互；
- 管理员按训战和员工精确选择提交并创建评测批次；
- Worker 租约、心跳、恢复、引擎缓存、交付件下载和 Agent 资产物化；
- 在线回传与线下导入共用 Schema、重算、归属和幂等边界；
- 单场详细报告、四维/16 点/八能力域个人与组织聚合画像；
- SSO 首次建档、组织编辑和安全删除、角色、名单、公告与审计；
- 全局管理员与部门管理员的组织范围隔离；
- 难题审核、待揭榜、揭榜成功、解决方案提交和公开控制；
- Windows x64/Linux x64 离线发布布局、双平台管理命令和一致性备份恢复；
- Ubuntu 22.04 x64 原生 GitHub Actions 构建、SHA-256 校验、运行时冒烟和 Release 附件发布；
- SDD 运维日志脱敏综合训战的真实角色端到端验收，以及版本化 v2 进阶赛题的 24 项隐藏强度用例。

### 15.2 当前限制

- Windows Server x64 与 Linux x64 真实断网目标机 UAT 尚未完成；
- 一次 `Install`、系统服务、开机自启、自动备份、离线升级和诊断包尚未实现；
- 单服务器档固定一个 API 实例；标准模式的多实例容量和故障切换尚未形成生产证据；
- 真实 GitLab 取件与 GitLab CI 自动评测适配器按产品决策后置；
- 真实 Agent 沙箱、凭据、网络和资源限制由部署环境提供，当前本地 bridge 不是生产沙箱；
- Web 管理端和部分领域仍集中在大文件中，需要按领域渐进拆分；
- 画像聚合、日志、指标、数据保留和真实评测耗时仍需目标环境容量验证；
- Worker 解压还应继续强化独立的文件数和解压后体积门禁。

## 16. 后续路线

### 16.1 v0.9.9：目标机验收与极简运维

目标：运维人员在全新断网服务器上使用离线包和一份配置，在 30 分钟内完成部署，并能长期运行。

按纵切面推进：

1. Windows Server x64 原生发布包，以及 Ubuntu 22.04.5 断网目标机 UAT；
2. `Install` / `Uninstall`、随机密钥、目录权限、磁盘、LDAP、数据库和 Agent 自检；
3. Windows 服务与 Linux systemd，开机自启和异常重启；
4. 定时备份、校验、轮转和低磁盘预警；
5. 离线 `Upgrade`、升级前恢复点与失败回退；
6. 脱敏诊断包和日志轮转；
7. 50–100 人真实提交、Code Agent 评测、备份恢复与故障演练。

保持单服务器边界：同机 PostgreSQL、本地交付件、一个 API、独立 Worker；不引入 Docker、Kubernetes、Redis、Kafka、MinIO 或额外配置中心。

### 16.2 v0.9.x：业务完整性

- 拆分前端路由、领域模块和通用表格/表单组件；
- 完成导师工作台、出题人权限、报告复核和申诉；
- 完善富文本附件、版本差异和数据治理；
- 增加定向公告、站内通知和截止提醒；
- 完善赛季、榜单、部门下钻、画像导出和可见性策略；
- 建立组织调整与管理员权限回收的历史快照规则；
- 增加员工端与管理端关键路径浏览器 E2E。

### 16.3 v1.0.0：试点发布

- 目标环境容量、依赖、安全、备份恢复和故障应急验收；
- 灰度、回滚、SLA/SLO、告警阈值和发布清单；
- 用真实但脱敏的训战完成从建题到能力画像的生产闭环。

### 16.4 后置：GitLab CI 自动评测

GitLab CI 作为新的 `GradingExecutor` 或 Worker 适配器接入，继续输出同一评测结果契约，必须经过平台的 Schema、归属、幂等和重算校验；不能复制一套评分或结果入库逻辑。

## 17. 版本沿革

| 版本 | 日期 | 主要成果 |
| --- | --- | --- |
| `v0.1.0` | 2026-08-02 | 建立 Workspace、Web、API、Python grader、契约和本地业务闭环。 |
| `v0.2.x` | 2026-08-02 | 加固 ZIP、路径、快照、错误响应、并发与不可变历史结果。 |
| `v0.3.0` | 2026-08-02 | 赛题评测引擎成为评分事实来源，统一版本、幂等与结果验证。 |
| `v0.4.0` | 2026-08-02 | 支持不可变评测引擎包、沙箱启动层和引擎调用契约。 |
| `v0.5.0` | 2026-08-02 | 评测改为独立 Worker；AUTO/MANUAL/IMPORT 共用契约。 |
| `v0.6.x` | 2026-08-03 | 完成多员工批次协议、交付契约、评测中心、组织编辑和权限修复。 |
| `v0.7.0` | 2026-08-04 | 接入 PostgreSQL/Prisma、上传会话、事务/CAS、分页和备份恢复。 |
| `v0.8.0` | 2026-08-05 | 评测运行配置、Worker 日志、独立引擎资料包和管理运营能力。 |
| `v0.8.1`–`v0.8.8` | 2026-08-05–06 | 修复赛题生命周期、OIDC/JWKS、资料包可复现、UI 反馈、提交锁定和富文本图片。 |
| `v0.9.0` | 2026-08-07 | 收口 LDAP3、可信网关、HTTP 内网、Worker 服务身份和本地生产模式。 |
| `v0.9.1` | 2026-08-09 | 建立同机 PostgreSQL、本地交付件、独立 Worker 的单服务器生产档并完成 100 人验收。 |
| `v0.9.5` | 2026-08-10 | 完成 Windows/Linux 可复现离线发布契约和 SDD 综合训战端到端验收。 |
| `v0.9.6` | 2026-08-10 | 修复首次部署端口、进程回滚、Windows OpenCode、离线依赖和评分 profile 一致性。 |
| `v0.9.7` | 2026-08-10 | 将平台说明收口为开发、设计、部署三份核心文档，并补齐交付方式禁用规则与前端回归测试。 |
| `v0.9.8` | 2026-08-10 | 发布 SDD 日志脱敏 v2 进阶赛题，以 24 项评测方隐藏用例强化 HMAC、失败关闭、复杂载荷和流式批处理验收，并稳定 Windows 本地验收端口分配。 |

## 18. 交接检查表

下一位开发者或 Codex 开始工作前：

```powershell
git status --short --branch
git log -5 --oneline --decorate
pnpm install
pnpm contract:test
pnpm grader:test
pnpm test
```

然后从 OpenAPI、实现和测试三处交叉确认目标功能。不要仅凭本手册断言某功能存在，也不要重新创建阶段性 GAP、PLAN 或部署说明；长期说明只更新本手册、`DESIGN.md` 或 `DEPLOYMENT.html`，发布事实只追加到 `CHANGELOG.md`。
