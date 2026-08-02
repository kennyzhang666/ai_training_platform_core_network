# AI 训战平台

基于 `AI训战平台设计方案.html` 和 `DEVELOPMENT_PLAN.md` 开发。

## 当前状态

`v0.1.0` 已实现可本地验证的训战与评测闭环：

- 版本化的题目、提交契约和评测结果 JSON Schema；
- Python `drill-grader validate/score/run` 基础命令；
- NestJS/Fastify API 的提交、管理员触发、结果导入和报告查询接口；
- AUTO / MANUAL / IMPORT 触发状态校验；
- `LocalGradingExecutor` 受控调用 Python grader，支持隐藏测试、静态度量、结果契约校验和批量本地执行；
- UPLOAD / GIT_REF 提交来源的快照元数据校验；
- Git 仓库、分支模板和 commit SHA 的场次约束；
- 本地 artifact store（开发期支持 base64 交付包保存与 SHA-256 校验）；
- 上传的 zip 可由本地执行器安全解包到临时 workspace 后直接评分（路径穿越、软链接、文件数和膨胀大小均有限制）；
- 文件持久化的组织树、角色、题目、审计、场次关闭/揭晓、赛季榜单和个人画像只读接口；
- 本地认证适配器：服务端从 `X-Employee-Id` 读取工号并按角色/组织范围授权，写接口不再信任请求体中的 `actorId`；
- 上传交付件由服务端计算内容快照哈希；配置 `LOCAL_GIT_ROOT` 后，Git 提交会在本地以 `git archive` 固化 commit、保存不可变归档并计算同口径快照哈希；
- 评测结果由服务端重算 criteria → dimension → total，错误响应包含稳定 `code` 和 `X-Request-Id`；
- 个人能力画像保留四维评测雷达和 16 个 V/S/C/P 评分点，同时提供版本化的 8 个 AI 能力域（包含提示词与上下文工程、工具与 Agent 编排、检索核验、安全合规等），展示证据覆盖度、部门中位数和待提升状态；
- React 员工首页与训战工作台：首页展示开放赛题、公告、赛季积分、榜单、最近动态和个人中心，再进入具体场次上传交付件、登记 Git commit、查看状态、管理员触发；
- 赛题由发布者配置 `Challenge.category`：`TRAINING`（训战类）、`COMPETITION`（竞赛类）或 `HARD_PROBLEM`（难题类）；难题榜与赛题库共用题目记录，`Challenge.board.type=HARD_PROBLEM` 保存部门/员工发布、审核和解决状态，员工发布的难题默认进入 `PENDING_REVIEW`，管理员通过 `POST /api/v1/hard-problems/{problemId}/review` 审核后才进入难题榜；审核通过的难题自动生成独立上传交付入口，卡片进入详情页后可提交交付件；难题榜分为“待揭榜”和“揭榜成功”，管理员/发布者揭榜时可选定提交记录，揭榜成功展示揭榜人和交付件摘要；`solutionVisibility=HIDDEN` 时仅展示揭榜人，不向员工公开交付件；解决后的赛题版本仍保留在赛题库；
- 赛题卡片先进入详情页，展示目标、要求、约束、交付件、评分版本和可选 Git 仓路径，再选择交付方式进入提交页；
- 公告只读接口 `GET /api/v1/announcements`，与赛题、赛季、画像数据一起驱动员工首页；
- 管理员工作台：运营总览、赛题草稿/版本/发布/归档、场次编排、评测队列与线下结果导入、公告运营、审计日志；
- 管理员管理 API：`/api/v1/admin/overview`、赛题版本管理、场次更新、公告增删改，所有写操作均写入审计记录；
- 本地文件适配器，便于没有 PostgreSQL、GitLab 或 K8s 时运行测试；GitLab 只保留最后接入的 `GradingExecutor` 适配接口。

## 本地准备

Git 场次支持固定 `branch` 或 `branchTemplate`；`pinAt=SUBMIT` 在提交时归档，`pinAt=DEADLINE` 在管理员关闭场次时由本地 Git 适配器锁定分支 tip（需配置 `LOCAL_GIT_ROOT`）。

需要 Node.js LTS、pnpm 和 Python 3.11+。当前 API 的开发适配器不依赖 PostgreSQL。

```powershell
pnpm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r grader/requirements.txt
```

## 验证

```powershell
pnpm contract:test
pnpm grader:test
pnpm --filter @ai-training/platform-api test
pnpm acceptance:local
```

## 启动 API

```powershell
pnpm dev:api
```

默认监听 `http://127.0.0.1:3000`，健康检查地址为 `http://127.0.0.1:3000/api/v1/health`。开发期会创建一个带 `MANUAL + UPLOAD` 配置的示例场次。API 细节见 `contracts/openapi.yaml`。

本地完整评分示例：提交时附带 `workspacePath: challenges/parking-fee-v1/starter`，管理员触发后调用 `POST /api/v1/grading-runs/{runId}/execute`；也可调用 `POST /api/v1/events/{eventId}/execute-local` 批量执行。报告通过 `GET /api/v1/reports/{submissionId}` 查询。

本地开发认证使用请求头 `X-Employee-Id`（`w00123` 为本地管理员，`w00124`–`w00132` 为本地学员），缺少身份头时默认拒绝请求。仅在单机演示时可显式设置 `ALLOW_ANONYMOUS_LOCAL=true`，让无身份请求使用种子管理员。生产接入内部 SSO 时，调用 `POST /api/v1/auth/sso` 传入 SSO 返回的工号、姓名和部门；平台按工号幂等登记员工，部门名称、编号或路径能匹配组织树时自动归属，否则保留未配置部门状态，由管理员后续配置。内部 SSO 网关也可以在转发 API 请求时附带 `X-SSO-Employee-No`、`X-SSO-Name`、`X-SSO-Department`，平台会在首次请求时完成同样的同步；网关必须清理外部请求自行携带的这些头。管理员不能手工新增员工，也不能修改工号、姓名或账号状态，只能配置部门归属以及“新员工、导师、全局管理员、部门管理员”角色。生产环境不应让浏览器直接传工号。管理员可通过 `PUT /api/v1/events/{eventId}/participants` 或 `POST /api/v1/events/{eventId}/participants:import` 配置白名单；场次设为 `ALLOWLIST` 后，非名单提交会被拒绝。

前端上传场次也可以不选文件，直接填写仓库内的 `workspacePath` 做本地开发评测；有交付包时则会保存到 `tmp/artifacts/`，并在本地执行器中安全解包。

开发数据默认写入仓库 `tmp/platform-data.json` 和 `tmp/artifacts/`；可用 `PLATFORM_DATA_FILE`、`ARTIFACT_ROOT`、`LOCAL_WORKSPACE_ROOT` 覆盖路径。若要测试真实本地 Git 取件，把裸仓/工作仓放在 `LOCAL_GIT_ROOT` 下，并提交相对仓库路径、分支和 commit SHA；未配置该变量时，GitLab 仍只走后续生产适配接口，不会访问远程网络。

另开一个终端启动 Web：

```powershell
pnpm dev:web
```

默认地址为 `http://127.0.0.1:5173`。当前本地上传使用 JSON base64 适配器；接入生产对象存储时替换 `ArtifactStore` 即可。

前端默认使用 `w00123`，可用 `VITE_EMPLOYEE_ID=w00124 pnpm dev:web` 模拟学员身份（PowerShell 可先 `$env:VITE_EMPLOYEE_ID='w00124'`）。

管理员账号使用本地种子用户 `w00123` 登录后，点击顶栏“管理后台”进入管理工作台。管理员进入“AI 能力画像”后，全组织查看个人明细；选择部门或勾选部分员工时，展示的是该范围的平均能力画像，而不是逐人卡片。对应 API 为 `GET /api/v1/admin/capabilities`，支持 `orgPath`、逗号分隔的 `subjectIds` 和 `includeProfiles=false` 聚合模式。`pnpm acceptance:local` 会启动隔离内存 API，模拟 10 个学员同时提交 AUTO 场次并等待队列清空；可通过 `LOCAL_GRADING_CONCURRENCY` 调整本地有界并发。文件适配器重启时会恢复未完成的 AUTO 队列任务，不会自动执行 MANUAL/IMPORT。当前后台已经覆盖本地开发闭环；生产化阶段还需要把本地 header 认证替换为 SSO/JWT、把文件适配器替换为 PostgreSQL/Prisma，并接入 GitLab CI、K8s 沙箱、结构化指标和权限审批。
