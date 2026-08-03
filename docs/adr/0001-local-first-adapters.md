# ADR 0001：外部依赖采用本地优先适配器

## 决策

在 GitLab CI、生产级 SSO 网关、PostgreSQL 和 K8s 沙箱接入前，使用文件持久化、`X-Employee-Id`、`LOCAL_GIT_ROOT`、独立 Evaluation Worker 和本地 Code Agent bridge 完成端到端验收。平台已提供 SSO 身份同步接口和网关头适配；本地身份仍使用 `X-Employee-Id`。业务状态机、结果 Schema、幂等键和快照算法不因适配器变化。

## 原因

这样可以在无内部网络和无集群权限的开发机上复现上传、Git commit 固化、自动/手动/导入、Code Agent 批次评测和报告链路，同时保留生产替换点。API 与评测执行保持进程边界，只有显式兼容测试才启用内嵌执行器。

## 后续替换点

- `LocalGitSnapshotter` → GitLab API/CI 取件适配器；
- 本地 Evaluation Worker/Code Agent bridge → 带服务身份的 Worker 与 K8s Job/受控 Code Agent；
- `LocalGradingExecutor` → 仅保留测试，不作为生产适配器；
- `PlatformStore` 文件适配器 → Prisma/PostgreSQL；
- `ArtifactStore` 本地目录 → S3 兼容对象存储；
- 本地 header 认证 → 网关校验后的 SSO/OIDC/JWT Guard；保留 `POST /api/v1/auth/sso` 的工号幂等建档逻辑。
