# AI 训战平台 · 代码与设计文档差距分析

> 基准文档：`AI训战平台设计方案.html`（v1.0）、`DEVELOPMENT_PLAN.md`
> 代码基线：本仓库当前工作区（未提交，`git status` 全部为 untracked）
> 检查日期：2026-08-01
> 用途：交给 Codex 继续开发的待办清单。每条差距包含「现状 / 设计要求（出处）/ 建议动作」。

> 注：第三、四、五节保留本轮开发前的差距基线，实际完成状态以第七节“本轮修复记录”和末尾结论为准。

---

## 一、结论摘要

当前代码完成的是**一条本地可重复验收的纵切面**：契约 v1 → Python grader（validate/score/run）→ NestJS API（文件持久化）→ React 学员端与管理端。当前测试全绿（平台 Node 24 个用例、grader Python 15 个用例，需在 `.venv` 下运行）。

但对照设计方案与开发方案，**一期（"能跑起来"）的验收标准尚未达成**，主要缺口集中在四处：

| 缺口 | 严重度 | 一句话 |
|---|---|---|
| 无鉴权与组织作用域 | **P0 阻断** | `/me` 硬编码用户，`actorId` 由请求体自报，任何人都能以管理员身份发布、揭晓、导入结果 |
| 快照哈希由客户端计算且口径不统一 | **P0 阻断** | 前端自算 `snapshotHash`，UPLOAD 用 zip 字节、GIT_REF 用 `sha256(commitSha)`，违反"同内容同哈希"这条一期 DoD |
| 服务端不重算总分 | **P0 阻断** | `completeRun` / `importResult` 只做 JSON Schema 校验，不重算 criteria→dimensions→total，违反"平台不能信任客户端上报的 total" |
| 评分口径与设计不符 | **P0 阻断** | Verify 只有 1 个得分点（设计要求 V1–V4 四档 8/12/12/8）；Spec/Collab 用中文关键词计数打分并计入总分，属一期范围外且不可申诉 |

其余为功能缺失（无沙箱、无 tree-sitter、无 Prisma/PostgreSQL、无报告页、无赛季百分位积分、无 CI、无 e2e、无可观测性），按批次补齐即可。

---

## 二、当前已实现的基线（不要重复开发）

- monorepo 骨架：`apps/web`、`services/platform-api`、`grader`、`contracts`、`challenges`
- 三份 JSON Schema v1（challenge / submission-contract / evaluation-result），5 份合法样例 + 10 份非法样例，TS（ajv）与 Python（jsonschema）双端契约测试
- `drill-grader` 子命令：`validate` / `score` / `measure` / `run`（`--full-local` 编排完整流程）
- 隐藏测试执行器：受控子进程 + 四档权重（1.0 / 2.0 / 2.0 / 1.6）
- Python AST 度量：魔法数字、圈复杂度、异常处理数、浮点字面量
- NestJS + Fastify API：题目/版本/场次/提交/评测运行/结果导入/报告/榜单/画像/公告/审计/管理总览
- `AUTO / MANUAL / IMPORT` 与 `IMMEDIATE / ON_RELEASE` 的配置与状态流转（含非法转换拒绝）
- `LocalGradingExecutor`：受控调用 Python grader，zip 安全解包（路径穿越、软链接、文件数 2000、膨胀 100MB 限制）
- `GitLabGradingExecutor`：稳定的适配接口占位
- 本地 artifact store：base64 落盘 + SHA-256 + `local://` URI
- 文件持久化 store（`tmp/platform-data.json`），支持进程重启后恢复
- React 学员端（首页 / 训战广场 / 训战详情 / 交付 / 个人中心）与管理端（总览 / 赛题 / 场次 / 评测 / 公告 / 审计）

---

## 三、差距清单

### 3.1 契约与 Schema（`contracts/`）

| # | 项 | 现状 | 设计要求（出处） | 建议动作 |
|---|---|---|---|---|
| C-01 | `evaluation-result` 缺 `project` 块 | 完全没有 | 设计 4.1：`project` 需含 `zone/type/mode/trigger/reveal/origin/orgPath/season/languagePolicy` | 补 `project` 对象；`origin` 决定是否计入赛季总分，是 5.3 积分制的前提 |
| C-02 | `subject` 缺 `orgPath` / `members` | 只有 `kind/id/name`，且 `additionalProperties:false` | 设计 4.1 + 2.4：成绩需固化提交时的 `orgPath` 用于榜单下钻；团队需 `members[].role` | 补字段；同时在 `submission` 表落 `org_path_snapshot` |
| C-03 | 缺 `importedBy` / `recalculatedTotal` | 只有 `triggeredBy` | 开发方案 6.3 明确列出这两项 | 补入 Schema，`recalculatedTotal` 由服务端写入 |
| C-04 | `extractions` 结构过松 | `additionalProperties:true` 的自由对象 | 设计 4.4：需 `{id,q,a,quote,quoteVerified}` 且 `a ∈ yes/no/unclear` | 冻结结构，`quoteVerified` 为防幻觉关键字段 |
| C-05 | `submission` 缺 `language`、根缺 `gradedAt` | — | 设计 4.1 示例 | 补字段 |
| C-06 | `challenge.schema.json` 缺关键段 | 只有身份/分区/语言/交付/rubric | 开发方案 6.1 要求：隐藏测试分档与权重、K8s 资源上限、变更包元数据、可见组织作用域、入口签名 | 逐项补齐；`origin` 需扩展 `bounty`/`explore`（设计 4.8） |
| C-07 | `submission-contract` 有字段但校验未实现 | Schema 定义了 `notTemplate` / `mustExport` / `signature`，`submission.py` 不校验；`optional` 缺失不产生 INFO 诊断 | 设计 4.9 三级诊断（阻断/警告/提示） | 在 grader 侧实现这三类校验并给稳定 code |
| C-08 | 无生成式类型包 | `services/.../domain.ts` 与 `apps/web/src/*.tsx` 各手写一套类型 | 开发方案 §4/§6："TypeScript DTO 和前端类型从 Schema/OpenAPI 生成，不手写第二套结构" | 新建 `packages/contract-types`（json-schema-to-typescript）+ `packages/api-client` |
| C-09 | OpenAPI 与实现不同步 | 缺 `GET /submissions`、`POST /submissions`、`GET /submissions/{id}`、`GET /grading-runs/{id}`、`GET /events/{id}`、`GET /users/{id}`；无错误响应 schema、无 securitySchemes | 开发方案 §8："OpenAPI 是接口事实来源" | 补齐并加 CI 校验（实现路由与 OpenAPI 路径集合一致性测试） |

### 3.2 评测引擎 `grader/`

| # | 项 | 现状 | 设计要求（出处） | 建议动作 |
|---|---|---|---|---|
| G-01 | **Verify 只有 1 个得分点** | `cli.py::_heuristic_criteria` 产出 `V1 max=40`，直接用加权通过率 | 设计 4.2：V1 基础 8 · V2 边界 12 · V3 澄清 12 · V4 变更 8，共 4 个得分点 | 按档拆成 V1–V4，各自 A/B/C/D 定档；`verifyDetail.tiers` 已有数据可直接映射 |
| G-02 | **Spec/Collab 用关键词计数打分** | `"规格" in transcript`、`len(transcript) >= 200`、`"变更" in spec_text` 等，且计入 `total`（测试断言 88.5 分） | 开发方案 2.2：一期**不做** Spec/Collab 评分；设计 4.4 禁止自由/不可复现打分 | 一期把 spec/collab 维度置 `evaluated:false, score:null`，`total` 只含 Verify+Code；关键词逻辑删除或移到 `--experimental` 开关后 |
| G-03 | **无 tree-sitter** | 用 Python `ast`，只支持 Python | 开发方案 3.1 技术栈 + Sprint 2；设计 4.5 需 Python/Java/Go 同一套查询 | 接入 tree-sitter，建 `grader/queries/`，先落 Python 的 C1，再扩 Java/Go |
| G-04 | **魔法数字定义不符** | `metrics.py` 只排除中性值 `{0,1,-1,2}`，模块级常量定义中的字面量也被计为魔法数字 | 设计 4.2 精确定义：排除 ①模块级常量定义 ②具名常量上的单位换算因子 ③中性值 | 修正判定；同时需要 `reference/` 参考实现的常量数基准（A 档要求 ≥ 参考实现 80%） |
| G-05 | **无 rubric profile** | 所有阈值硬编码在 `cli.py` 里；`PyYAML` 在 requirements 中但未使用 | 设计 4.3 + 开发方案 §4：`grader/profiles/blue.yaml` `yellow.yaml`，含 `rationale` 字段并展示给学员 | 抽出 profile YAML，引擎读配置定档，不改代码即可加分区 |
| G-06 | **无 SKILL.md 与 references/** | 目录不存在 | 设计 4.4「打分规则的唯一载体是一个 skill」；开发方案 §4 列出 `SKILL.md` / `references/rubric.md` / `extraction.md` / `schema.md` | 建立 skill 目录，蓝黄共用；这是"换 Claude/Codex/DeepSeek 同分"的前提 |
| G-07 | 缺 `verify` / `extract` / `check` 子命令 | 只有 validate/score/measure/run；`verify_submission` 只能通过 `run --full-local` 触发 | 开发方案 7.1 列出 7 个子命令，且"所有阶段都必须可以独立执行和重试" | 补三个子命令；`check` 即设计 4.9 的 `drill check` 本地预检，必须与 CI validate 同一份代码 |
| G-08 | **无 findings 产出** | Schema 有 `findings`，grader 从不生成 | 设计 4.2/5.1：每处魔法数字生成一条 finding（文件、行号、片段、为什么错、怎么改） | C1–C4 每个扣分点生成 finding，串起"扣分证据链" |
| G-09 | **黄金样本缺失** | 只有 1 份参考实现 `starter/` | 开发方案 7.3 要求 5 类 fixture：参考实现满分 / 基础实现 / 魔法数字 / 入口缺失 PARTIAL / 恶意超时被终止；外加同输入重复 20 次哈希一致 | 补 `grader/tests/fixtures/`，加重复运行一致性测试（需排除 `startedAt/finishedAt/durationMs`） |
| G-10 | 隐藏测试量不足 | 共 10 条（3/3/2/2） | 设计 6.2：25 条（基础 8 / 边界 6 / 澄清 6 / 变更 5） | 补齐到 25 条并与档位严格对应 |
| G-11 | `snapshotHash` 计算不符规范 | `cli.py` 用 `path + 文件全字节 hex` 拼接后哈希，无执行权限位；平台侧完全不复算 | 开发方案 5.3：`排序后的相对路径 + 文件内容哈希 + 必要执行权限`，不使用压缩包字节或 commit ID | 抽成共享算法，grader 与平台各实现一次并用同一批 fixture 对拍 |
| G-12 | 沙箱不达标 | `subprocess.run(sys.executable, -I, timeout=10)`，跑在宿主机 | 开发方案 10.1：非 root、只读根、禁网、drop caps、内存/CPU/磁盘限额、active deadline、提交目录只读挂载 | 一期至少加：禁网（环境隔离）、内存限额、输出目录隔离；生产接 K8s Job |
| G-13 | 无模型抽取与引用校验 | 无 | 设计 4.4（二期）：`verify_quotes.py` 精确匹配、`quoteVerified` | 二期任务，但 Schema 与 skill 目录应一期预留 |

### 3.3 平台 API 与数据层 `services/platform-api/`

| # | 项 | 现状 | 设计要求（出处） | 建议动作 |
|---|---|---|---|---|
| A-01 | **无鉴权 / 无授权** | `GET /me` 返回硬编码 `w00123`；所有写接口的 `actorId` 从请求体读取；无 Guard、无角色校验、无组织作用域校验 | 设计 2.4 权限按层级收敛；开发方案 8/10.2："管理接口实施资源级授权，不能只依赖前端隐藏按钮" | **P0**：加本地开发用认证适配层（可先用 header 里的工号 + 服务端角色表），加 `RolesGuard` + `OrgScopeGuard`；`actorId` 一律取自认证上下文，禁止从 body 读 |
| A-02 | **role_binding / 作用域缺失** | `AppUser.roles` 是字符串数组，无 `scope_org_id`；`orgPath` 前缀匹配只用于 `listUsers` | 开发方案 5.2 `role_binding(user_id, role, scope_org_id)`；设计 2.4「出题人只能发布到本节点或下级」 | 建 `role_binding`，实现 `employee.orgPath.startsWith(challenge.orgPath)` 的可见性判定 |
| A-03 | **客户端提供 snapshotHash** | `submissions:upload` 接受 body 里的 `snapshotHash`；UPLOAD 无值时回落为 zip 字节 sha256；前端 GIT_REF 用 `sha256(commitSha)` | 开发方案 5.3 + 一期 DoD："同内容通过上传和 Git 提交时，评测引擎得到等价 workspace" | **P0**：服务端解包/取件后自行计算 `snapshotHash`，客户端传的值仅作校验；两条路径必须产出同一哈希，配对拍测试 |
| A-04 | **服务端不重算总分** | `completeRun` / `importResult` 只跑 `validateEvaluationResult`（JSON Schema） | 开发方案 5.3："平台不能信任客户端上报的 total，必须重新计算 criteria 与 dimensions 加总" | **P0**：在 TS 侧实现与 `scoring.validate_score_consistency` 等价的重算，不一致则拒绝并写 `recalculatedTotal` |
| A-05 | **幂等键计算不符** | `idempotencyKey(snapshotHash, '1.0', '0.1.0')`，rubricVersion / graderVersion 硬编码，未含 challengeVersion | 开发方案 5.3：`sha256(commit_sha + rubric_version + grader_version + challenge_version)` | 改为取 event/challengeVersion 的真实值；否则不同判据版本重跑会撞键返回旧结果 |
| A-06 | **AUTO 不会真的自动评** | `createSubmission` 建 run 置 `QUEUED` 后无人执行，必须手动调 `/grading-runs/{id}/execute` | 一期 DoD："AUTO 模式下上传完成或有效 Git 提交能自动触发评测" | 加进程内队列/worker（一期不引入 Redis/MQ，用有界并发队列即可），AUTO 提交后异步派发到 `GradingExecutor` |
| A-07 | **GIT_REF 不真取件** | 只保存 `repository/branch/commitSha` 元数据，不 clone、不校验 commit 存在、不生成归档 | 设计 9.2 GIT_REF 第 5 步；一期 DoD："从指定仓库和指定分支锁定 commit 并形成不可变快照" | 实现本地 Git 适配器（`git archive` 到只读 workspace + 计算 snapshotHash），先支持本地裸仓做测试 |
| A-08 | `pinAt` 未实现 | `deliveryConfig` 无 `pinAt`；`closeEvent` 不锁定截止 commit | 开发方案 5.5：`trigger=AUTO` 时 `pinAt` 必须为 `SUBMIT`；`DEADLINE` 只用于 MANUAL/IMPORT，且收卷时统一锁定 | 补 `pinAt` 配置 + 组合校验 + 收卷锁定逻辑 |
| A-09 | **Prisma / PostgreSQL 未接入** | `schema.prisma` 存在但无 `migrations/`、无 PrismaClient 调用；运行时全靠 `tmp/platform-data.json` | 开发方案 Sprint 3 + 3.1 技术栈 | 建首个 migration，加 Repository 抽象层（保留文件适配器供无 DB 环境测试）；prisma schema 还缺 `RoleBinding` / `Season` / `SeasonEvent` / `Participation` / `Team` / `Announcement` / `ChallengeVersion.status` / `Submission.orgPathSnapshot` |
| A-10 | 参与名单接口缺失 | 无 `POST /events/{id}/participants:import`，无 `participation` 表 | 开发方案 §8 一期接口列表 | 实现名单导入 + 参赛时固化 `org_path_snapshot` |
| A-11 | 批量结果导入缺失 | `grading-results:import` 只收单条 | 开发方案 §8："批量导入支持逐条返回成功或失败，不能因为一条非法结果回滚整批" | 加批量端点，逐条返回 `{index, ok, code, message}` |
| A-12 | 错误码不稳定 | 除 `RESULT_SCHEMA_INVALID` 外全是自然语言 `BadRequestException('...')` | 开发方案 §8："返回稳定错误码、字段路径和可读说明" | 定义错误码表 + 全局 ExceptionFilter |
| A-13 | 无请求 ID / 幂等头 | 无 | 开发方案 §8："所有写接口支持请求 ID" | 加 `X-Request-Id` 中间件 + 写接口 `Idempotency-Key` 支持 |
| A-14 | 状态机不完整 | `IMPORT_VALIDATING`、`GRADED` 状态定义了但从未使用；`failRun` 把 submission 退回 `RECEIVED`（无失败态） | 开发方案 5.4 状态图 | 补齐状态与非法转换测试矩阵 |
| A-15 | **赛季积分算法错误** | `leaderboard()` 直接累加原始 `total` | 设计 5.3：`场次积分 = round(100 × (1 − (名次−1)/参赛数))`，赛季总分 = Σ 场次积分；只算 `origin=official` | 重写为百分位积分；补场均积分、部门百分位、`season_event.weight` |
| A-16 | 能力画像太薄 | 已修复：四维评测证据 + 8 个版本化 AI 能力域、16 个评分点、趋势、分区、中位数、证据覆盖度、薄弱项和推荐动作 | 设计 5.2：四维雷达 vs 部门中位数、16 得分点历史平均档位、薄弱项识别 + 推荐练习题、分区计数、积分趋势；产品扩展要求提示词工程、工具编排等能力域 | 已实现员工 `GET /profiles/{id}/capabilities` 和管理员 `GET /admin/capabilities`；管理员全组织可看个人明细，部门/选定人员默认返回群体平均与有效样本，能力域无证据时返回待评测 |
| A-17 | 报告接口太薄 | 返回原始 `StoredResult` | 设计 5.1 四板块：总览（含本场平均对比、档位分布）/ 逐条判据（四档阶梯 + 判定来源）/ 客观指标 / 扣分证据链 | 加聚合字段（本场平均、名次、档位分布），findings 依赖 G-08 |
| A-18 | 审计能力不足 | `listAudits` 无分页、无时间/actor 过滤、无作用域限制；`reveal` 硬编码 `admin-local` | 开发方案 §8：发布、揭晓、重评、人工改判写审计 | 补分页与过滤，`reveal`/`close` 从认证上下文取 actor |
| A-19 | body 大小限制冲突 | Fastify 默认 `bodyLimit = 1MB`，但 `event.deliveryConfig.maxBytes = 50MB` 且走 JSON base64 | 开发方案 10.2：外部输入限制大小并做内容类型校验 | 改 multipart 上传（`@fastify/multipart`），或显式设置 `bodyLimit` 并把 base64 膨胀算进去；当前 >~750KB 的包会直接 413 |
| A-20 | 上传限额校验顺序 | `saveBase64` 先落盘再比对 `event.maxBytes` | — | 先校验声明大小再落盘；解包阶段的 `maxFiles`/膨胀限制应在提交时执行而非仅在评测时 |

### 3.4 安全

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| S-01 | 学员代码在宿主机执行 | `verify.py` 子进程，无禁网/内存/权限限制 | 见 G-12；一期至少加资源限额与网络隔离 |
| S-02 | `workspacePath` 可指向仓库任意目录 | `resolveInside(workspaceRoot=projectRoot)` 只防越界，不防读 `challenges/*/hidden-tests` | 加白名单前缀或把隐藏测试移出 `LOCAL_WORKSPACE_ROOT` |
| S-03 | `POST /submissions` 绕过来源校验 | 可直接构造 snapshot，跳过上传格式/大小检查 | 收敛为内部用途或加同等校验 |
| S-04 | Git 仓库白名单不足 | 仅当 `deliveryConfig.repository` 已配置时才比对，未配置时不校验 | 强制场次必须配置 repository，并限制在允许的 host/group（防 SSRF） |
| S-05 | 无速率限制、无 CORS 收敛 | `enableCors({origin:true})` | 生产化前收敛 |

### 3.5 前端 `apps/web/`

| # | 项 | 现状 | 设计要求 | 建议 |
|---|---|---|---|---|
| W-01 | 无路由 | `useState<View>` 切换，刷新丢状态、无法分享链接 | — | 引入 react-router |
| W-02 | 前端本地身份仍为开发适配 | 本地使用 `X-Employee-Id`；API 已支持 SSO 工号首次登录建档和网关 `x-sso-*` 头同步 | 设计 §SSO | 生产接入 SSO/OIDC/JWT 网关后替换本地身份适配 |
| W-03 | **无评测报告页** | 已修复：详细报告包含总览、维度拆解、提交快照、评分项证据、findings、诊断、运行时间线和技术度量 | 设计 5.1 四板块 + 四维雷达 + 16 点档位色块 + findings 代码片段卡 + commit 时间线 | 已实现本地报告页；ECharts 仍可作为后续组件化替换 |
| W-04 | 画像页无图表 | 已修复：四维雷达、综合趋势、8 域能力卡片、16 点档位矩阵、薄弱项推荐 | 设计 5.2：趋势折线（分区着色）、四维雷达、档位色块矩阵 | 已实现本地画像页；分区点位和更细粒度历史域趋势可在后续增强 |
| W-05 | 管理端缺 7 个模块 | 已有：总览/赛题/场次/评测/公告/审计 | 设计 5.4 还需：组织管理、分组与开局（名单导入/团队编排/批量建分支）、人工复核台、出题工作台、出题终审台、挑战评审台、题库管理（疲劳度、模型基准）、赛季与报表 | 按二/三期优先级排期，一期先补「组织管理 + 名单导入」 |
| W-06 | 前端自算哈希 | 见 A-03 | — | 改为上传后由服务端返回快照信息 |
| W-07 | 无组件库、无 e2e | 纯手写 CSS；无 Playwright | 开发方案 3.1 / 11.1 | 确认黄区允许的组件库后引入；建 `e2e/` |
| W-08 | `lint`/`test` 都只是 `tsc --noEmit` | — | — | 加 ESLint + 组件测试 |

### 3.6 工程化 / CI / 可观测性

| # | 项 | 现状 | 设计要求 | 建议 |
|---|---|---|---|---|
| E-01 | 缺目录 | 无 `docs/`（architecture / adr / api）、`deploy/`（docker / helm / gitlab-ci）、`e2e/`、`scripts/`、`packages/` | 开发方案 §4 仓库结构 | 逐步补建；ADR 模板是 Sprint 0 验收项 |
| E-02 | **无 CI** | 无 `.gitlab-ci.yml` | Sprint 0："建立 CI 基础流水线"；§11.2 合并门禁 8 项 | 建流水线：format/lint → 单测 → 契约测试 → grader 黄金样本 → 迁移校验 |
| E-03 | **仓库无提交** | 所有文件 untracked | Sprint 0 第一项 | `git add` + 首次提交，之后按任务分支开发 |
| E-04 | `pnpm grader:test` 在系统 Python 下失败 | 缺 `jsonschema`，必须先激活 `.venv`（实测系统 Python 3.13 直接 ImportError） | README 的验证命令应可复现 | 脚本改为优先使用 `.venv`，或在 README 明确前置步骤 |
| E-05 | 无 Python / TS lint | `lint` 仅 `tsc --noEmit` | §11.2 "格式化与静态检查" | 加 ruff + ESLint + prettier |
| E-06 | **无可观测性** | 0 个指标、无结构化日志 | 开发方案 §12 列 8 个指标；日志需带 `requestId/eventId/submissionId/snapshotHash/gradingRunId/commitSha/rubricVersion` | 加 pino 结构化日志 + Prometheus 端点 |
| E-07 | 无并发/性能验证 | — | 一期 DoD："10 人同时提交时服务稳定" | 建并发演练脚本（`scripts/`） |

### 3.7 题库与出题资产 `challenges/`

| # | 项 | 现状 | 设计要求（6.4 出题清单） | 建议 |
|---|---|---|---|---|
| Q-01 | 缺题面 `README.md` | 无 | 学员看到的题面：交付物、硬性要求、提交纪律 | 补 |
| Q-02 | 缺 `reference/` | 无 | 参考实现 + C1/C4 归一化所需常量数基准 | 补（G-04 依赖它） |
| Q-03 | 缺口头需求稿 / 澄清答案卡 / 变更包 | 无 | 6.4 明确列为出题产出物 | 补 |
| Q-04 | `starter/SPEC.md` 是空模板、`transcript.md` 是单段样例文本 | 当前它同时充当"参考实现"，导致 Spec/Collab 关键词判定拿高分 | — | 与 G-02 一并处理 |
| Q-05 | 缺三道样题 | 设计 §07 给了日志脱敏、会员积分、遗留限流器、绿灯陷阱四道 | — | 二期补，一期先做透一道 |

---

## 四、一期 Definition of Done 对照

| DoD 条目（开发方案 §18） | 状态 |
|---|---|
| 新用户能看到自己组织范围内的题 | ❌ 无鉴权、无作用域过滤（A-01/A-02） |
| 场次可配置 UPLOAD / GIT_REF | ✅ |
| UPLOAD 安全接收并形成不可变快照 | ⚠️ 可接收，但快照哈希由客户端提供（A-03），大包会 413（A-19） |
| GIT_REF 锁定 commit 并形成不可变快照 | ❌ 只存元数据，不取件（A-07） |
| 分支移动不改变已评快照 | ⚠️ 因为根本不取件，未真正验证 |
| 同内容两种来源得到等价 workspace | ❌ 哈希口径不同（A-03/G-11） |
| 可配置 AUTO / MANUAL / IMPORT + 独立 reveal | ✅ |
| AUTO 能自动触发评测 | ❌ 无 worker（A-06） |
| MANUAL 单份/批量触发 | ✅ |
| IMPORT 不启 CI，可上传单份结果 | ⚠️ 单份可以，批量缺失（A-11） |
| 提交代码在隔离沙箱内运行 | ❌ 宿主机子进程（G-12） |
| 5 分钟内得到 Verify + Code 报告 | ⚠️ 能出分，但 Verify 口径错（G-01）、Code 定义错（G-04） |
| 每项扣分都有机器证据 | ❌ 无 findings（G-08） |
| 同 snapshot 同判据重复运行结果一致 | ❌ 无一致性测试（G-09） |
| 非法结果不能导入 | ✅ Schema 层面可以 |
| 结果与 event/subject/commit 不匹配时拒绝 | ⚠️ 校验 snapshotHash 与 subject，未校验 commitSha |
| 重复导入不产生重复成绩 | ✅ |
| 10 人同时提交服务稳定 | ❌ 未验证（E-07） |
| 超时/禁网/越权/资源耗尽测试通过 | ❌ 未实现 |
| 迁移、部署、回滚文档 | ❌ 无 |
| 真实演练与验收记录 | ❌ 无 |

**结论：22 条中通过 5 条。**

---

## 五、建议开发批次（可直接切成 Codex 任务）

按依赖顺序执行，每批独立可验收。

### 批次 1 · 修正评分口径与确定性（grader，最高优先）
- **T1.1** Verify 拆成 V1–V4 四档得分点（8/12/12/8），由 `verifyDetail.tiers` 定档
- **T1.2** 一期关闭 Spec/Collab 自动打分，两个维度置 `evaluated:false / score:null`，`total` 只含 Verify+Code；更新 `api.test.ts` 中的 88.5 断言
- **T1.3** 抽出 `grader/profiles/{blue,yellow}.yaml`，阈值与 `rationale` 全部走配置
- **T1.4** 建 `grader/tests/fixtures/` 五类黄金样本 + 重复运行 20 次哈希一致性测试
- 验收：`python -m unittest discover -s grader/tests` 全绿；参考实现 Verify 40 满分；缺陷实现按预期扣分

### 批次 2 · 快照口径统一与服务端重算（P0 阻断项）
- **T2.1** 抽出统一 `snapshotHash` 算法（排序相对路径 + 内容哈希 + 执行权限），grader 与 API 双端实现并对拍
- **T2.2** 服务端解包后自算 `snapshotHash`，客户端值降级为校验用；前端不再自算
- **T2.3** 服务端重算 criteria→dimensions→total，不一致拒绝并写 `recalculatedTotal`
- **T2.4** 修正 `idempotencyKey` 为 `sha256(snapshotHash/commitSha + rubricVersion + graderVersion + challengeVersion)`
- 验收：同一份 `starter/` 分别以 zip 上传与本地 Git 提交，得到同一 `snapshotHash` 与同一分数；篡改 `total` 的结果被拒绝

### 批次 3 · 鉴权与组织作用域（P0 阻断项）
- **T3.1** 认证适配层（本地开发用工号 header，接口形态预留 OIDC/SAML）
- **T3.2** `role_binding` 模型 + `RolesGuard` + `OrgScopeGuard`；`actorId` 一律取自认证上下文
- **T3.3** 题目/场次按 `orgPath` 前缀可见性过滤；`POST /events/{id}/participants:import` + `org_path_snapshot` 固化
- 验收：非管理员调用发布/揭晓/导入返回 403；跨组织题目不可见；越权测试用例通过

### 批次 4 · 交付件真实取件与自动评测
- **T4.1** GIT_REF 本地 Git 适配器：解析分支模板 → 锁定 commit → `git archive` → 只读 workspace
- **T4.2** `pinAt: SUBMIT | DEADLINE` 配置与组合校验；收卷时批量锁定
- **T4.3** AUTO 触发：有界并发队列 + worker，提交后异步派发
- **T4.4** multipart 上传替换 base64，提交阶段执行 maxFiles/膨胀/格式校验
- 验收：AUTO 场次 push/上传后无需人工操作即可出分；分支移动不改变已评快照

### 批次 5 · 证据链与报告
- **T5.1** grader 生成 findings（文件/行号/片段/原因/修复）
- **T5.2** 修正魔法数字定义（排除模块级常量与单位换算因子），补 `reference/` 常量基准
- **T5.3** 接入 tree-sitter（先 Python），建 `grader/queries/`
- **T5.4** 报告 API 聚合（本场平均、名次、档位分布）+ 前端报告页（雷达图、档位色块、findings 卡片）
- 验收：魔法数字实现稳定命中 C1 findings 且能指到行号

### 批次 6 · 数据层与工程化
- **T6.1** Prisma 首个 migration + Repository 抽象（保留文件适配器）
- **T6.2** 补 `role_binding` / `season` / `season_event` / `participation` / `announcement` / `orgPathSnapshot` 等模型
- **T6.3** `.gitlab-ci.yml` 基础流水线（lint → 单测 → 契约 → 黄金样本 → 迁移校验）
- **T6.4** 结构化日志 + Prometheus 指标（§12 八项）
- **T6.5** `packages/contract-types` 由 Schema 生成，前后端删除手写类型
- **T6.6** `docs/`（architecture / adr / api）+ ADR 模板

### 批次 7 · 赛季积分与画像
- **T7.1** 场次百分位积分算法（`round(100 × (1 − (rank−1)/n))`），只算 `origin=official`
- **T7.2** 画像扩展：四维雷达 vs 部门中位数、8 个版本化 AI 能力域（含提示词工程/工具编排等域）、16 点历史档位、证据覆盖度、薄弱项 + 推荐题
- **T7.3** 榜单口径切换（全域 / 本级 / 下钻）
- 验收：赛季榜与设计 5.3 公式一致；组织调整不改写历史成绩

### 批次 8 · 一期收尾
- **T8.1** Playwright e2e：建题 → 上传/Git 提交 → 触发 → 出分 → 看报告
- **T8.2** 10 人并发演练脚本 + 安全测试（超时、禁网、越权、解压炸弹、路径穿越、SSRF）
- **T8.3** 迁移/部署/回滚文档 + 一期验收报告

---

## 六、需要人来拍板的决策点

以下问题不确定就继续开发会返工（对应开发方案 §17）：

1. **一期是否保留 Spec/Collab 的启发式打分？** 当前它进了 `total`，与"一期只自动评 Verify+Code"冲突。建议关闭（批次 1 T1.2），但这会让演示分数从 88.5 掉到 ~60，需确认演示预期。
2. **生产认证适配**：本地继续使用 header 传工号；生产接入 SSO/OIDC/JWT 网关并由网关向 API 注入已校验身份。
3. **是否现在就上 PostgreSQL**，还是继续用文件适配器直到 GitLab 接入前。
4. **前端组件库与图表库**（黄区合规版本）——报告页与画像页强依赖，未定则无法开工。
5. **一期样题最终语言**（现状全 Python，`challenge.schema.json` 已允许 java/go）。
6. **隐藏测试是否与平台同仓**——影响 `challenges/` 目录策略与 CI 拉取方式。

---

## 七、本轮修复记录（2026-08-01）

本轮已按“本地可测试优先、GitLab/K8s/生产 SSO 网关最后适配”的约定落地以下差距修复：

- **P0 鉴权与作用域**：服务端从 `X-Employee-Id` 解析本地身份，管理写接口不再信任请求体 `actorId`；增加角色绑定、组织前缀可见性、场次参与白名单、提交/评测运行/报告的自有资源边界；Git 场次必须由管理员配置仓库和分支策略。
- **快照与结果可信度**：上传包和本地工作区由服务端计算统一快照哈希，Git 本地适配器用固定 commit 归档；增加符号链接真实路径边界、客户端哈希校验、挑战版本/来源/commit 关联校验；服务端重算 criteria→dimension→total 并写入 `recalculatedTotal`。
- **评测闭环**：Verify 已拆为 V1–V4（8/12/12/8），一期 Spec/Collab 不自动计分；支持 `verify/check/extract/snapshot` 独立命令、黄区/蓝区 profile、稳定诊断和 C1–C4/隐藏测试 findings；隐藏测试扩充为 25 条，AUTO 使用本地有界异步队列。
- **平台能力**：补齐参与名单管理、批量结果导入逐条返回、`IMPORT_VALIDATING` 失败可重试、幂等键、稳定错误码和 `X-Request-Id`、报告聚合、赛季百分位积分/个人积分；补充管理端赛题版本、场次、公告、参与名单工作台和员工端报告入口。
- **参赛报告与能力画像**：报告 API 增加提交快照、评测摘要、维度拆解、评分项证据、诊断、运行时间线、问题定位和改进建议；个人能力画像 API 不再只返回四个大维度，同时返回版本化的 8 个 AI 能力域（AI 认知与选型、任务拆解、提示词与上下文工程、检索核验、工具编排、输出评审与测试、工程交付、安全合规）、设计中的 V1–V4、S1–S4、C1–C4、P1–P4 十六个评分点历史档位、黄/蓝区计数、部门中位数对比、证据覆盖度、薄弱项和推荐练习；员工端增加四维雷达、8 域能力卡片、趋势图、16 点档位矩阵、薄弱项卡片、详细评分表和技术度量展示。无证据能力域显示待评测，不将关联证据冒充直接测量。
- **工程化与本地验证**：补充 CI、ADR/架构/API 文档、题面/参考实现/变更包、Windows 可用的 grader 测试脚本；根命令、API、Web、契约和 grader 均可本地验证。
- **并发与不可变性**：本地队列支持有界并发；执行前再次核验 workspace/artifact 快照，篡改会留下 FAILED 运行；幂等索引按 `submissionId + idempotencyKey` 建立，10 个参赛者提交相同 starter 也会分别出分。
- **结果上下文可信度**：服务端在本地执行和线下导入时统一补齐提交人的 `subject.id/name/orgPath`，不接受结果 JSON 覆盖历史组织快照；同一 `gradingRunId` 的非幂等重用会被拒绝。
- **管理员画像范围**：新增管理员能力画像工作台和 `GET /admin/capabilities`，支持全组织个人明细、部门（含子团队）平均画像或指定员工群体平均；聚合包含四维、八域、16 点和有效样本数，并拒绝越过部门范围的人员选择。
- **SSO 用户建档**：新增 `POST /api/v1/auth/sso` 及网关 `x-sso-*` 头适配，首次登录按工号幂等登记员工并按部门名称/编号/路径自动匹配组织；未匹配部门保留空归属，由全局管理员配置。移除管理员新增员工接口和表单，人员管理仅保留部门与角色配置。

仍明确保留为生产适配项（不是本地验收的假完成）：

- OIDC/SAML SSO/JWT、PostgreSQL/Prisma migration、真实 GitLab pipeline/webhook；
- K8s 非 root/禁网/资源限额沙箱（本地当前为受控超时子进程和环境隔离）；
- tree-sitter 多语言度量、Spec/Collab 模型抽取与引用校验；
- Playwright 浏览器 e2e、30 人以上集中演练、Prometheus 指标/结构化日志、完整 ESLint/ruff 门禁（10 人本地 API 并发已由 `pnpm acceptance:local` 验证）；
- 管理端组织树、团队编排、人工复核台、题库疲劳度/模型基准和报表导出。

因此，Sprint 1–4 的本地实现与验收已完成；当前状态已达到“本地纵切面可重复验收”，尚未宣称达到真实黄区生产部署验收。GitLab CI、生产 SSO 网关断言/JWT、PostgreSQL/Prisma、K8s 沙箱和生产可观测性继续按 Sprint 5/生产适配项推进。
