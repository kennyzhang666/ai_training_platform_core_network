# 分组核心网AI能力提升平台

企业内部 AI 训战、交付评测和能力复盘平台。当前版本为 `v0.9.5`，核心业务闭环与单服务器离线发布契约已完成本地验收，生产环境边界和后续路线见 [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)。

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
- LDAP3 `TRUSTED_GATEWAY` 登录、中文身份传输、Worker HMAC 服务身份和本地 Mock 验收；
- 默认 HTTPS 的 Nginx 部署与隔离内网纯 HTTP 开关，生产 Web 自动通过反向代理同源访问 API。
- 面向单场 50–100 人的单服务器生产档：同机 PostgreSQL、本地交付件目录、独立 Worker，并提供统一迁移、启停、状态、备份与恢复脚本。
- `v0.9.5` 双平台离线发布：Windows x64 ZIP 与 Linux x64 tar.gz 均携带平台运行时、生产依赖、版本清单和 SHA-256，目标机无需源码、pnpm 或前端构建。

生产可选择两种模式：单场 50–100 人、单 API 实例使用[单服务器部署](deploy/single-node/README.md)，PostgreSQL 与平台运行在同一台服务器，交付件保存在本地磁盘；需要多 API 实例时改用独立 PostgreSQL 与 S3-compatible 对象存储。两种模式都使用真实 SSO、独立 Worker 和 Code Agent，不能把本地 Mock 或 API 内嵌评测当作生产证据。完整架构、限制和版本沿革见开发总览。

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
pnpm deployment:test
pnpm release:test
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
- [`docs/deployment/intranet-http-only.md`](docs/deployment/intranet-http-only.md)：隔离内网纯 HTTP 开关和 Nginx 配置；
- [`docs/deployment/windows-production-smoke-test.md`](docs/deployment/windows-production-smoke-test.md)：Windows 个人电脑上的生产模式端到端验收手册；
- [`docs/deployment/offline-dual-platform-release.md`](docs/deployment/offline-dual-platform-release.md)：Windows / Linux 离线发布包输入、生成和验收门禁；
- [`docs/submission-contract.md`](docs/submission-contract.md)：交付目录契约；
- [`docs/capability-model.md`](docs/capability-model.md)：能力模型；
- [`AI训战平台设计方案.html`](AI训战平台设计方案.html)：原始产品设计参考。

开始开发前先阅读 [`AGENTS.md`](AGENTS.md) 和 [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md)。
