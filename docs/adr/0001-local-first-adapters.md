# ADR 0001：外部依赖采用本地优先适配器

## 决策

在 GitLab CI、生产级 SSO 网关、PostgreSQL 和 K8s 沙箱接入前，使用文件持久化、`X-Employee-Id`、`LOCAL_GIT_ROOT`、受控本地 Python 子进程完成端到端验收。平台已提供 SSO 身份同步接口和网关头适配；本地身份仍使用 `X-Employee-Id`。业务状态机、结果 Schema、幂等键和快照算法不因适配器变化。

## 原因

这样可以在无内部网络和无集群权限的开发机上复现上传、Git commit 固化、自动/手动/导入评测和报告链路，同时保留生产替换点。

## 后续替换点

- `LocalGitSnapshotter` → GitLab API/CI 取件适配器；
- `LocalGradingExecutor` → K8s Job 或 GitLab Runner；
- `PlatformStore` 文件适配器 → Prisma/PostgreSQL；
- 本地 header 认证 → 网关校验后的 SSO/OIDC/JWT Guard；保留 `POST /api/v1/auth/sso` 的工号幂等建档逻辑。
