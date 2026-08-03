# 数据适配器边界

当前本地验收使用 `PlatformStore` 文件适配器和 `ArtifactStore` 本地不可变目录，默认不要求 PostgreSQL 或任何外部服务。这样可以在 Windows 开发机上重复执行组织、赛题、训战、提交、批次评测、报告和画像链路。

`services/platform-api/prisma/schema.prisma` 与 `prisma/migrations/` 是生产关系模型的版本化契约，覆盖组织、角色绑定、题目版本、场次、参与名单、提交快照、评测运行、批次租约、结果证据、赛季和公告。当前 API 尚未以 Prisma 作为运行时存储。接入 PostgreSQL 时，领域服务应保持现有状态机、快照算法、结果 Schema 和幂等规则不变，只替换存储实现。

本地适配器与生产适配器的边界：

- `PlatformStore` → Prisma Repository；
- `ArtifactStore` → S3 兼容对象存储；
- `LocalGitSnapshotter` → GitLab/受控 Git 取件；
- `Evaluation Worker` 的本地目录 → 受控 Worker 节点与临时卷；
- 本地 Code Agent bridge → 组织内 Code Agent 服务或受控 CLI；
- 内嵌 `LocalGradingExecutor` → 仅保留测试用途，生产由 K8s Job/独立沙箱执行。

迁移文件没有被本地测试自动执行，避免开发环境隐式连接数据库。生产发布流程必须在独立数据库上执行 `prisma migrate deploy`，并保留升级、回滚和备份恢复记录。切换适配器前必须先为组织人员、提交评测和租约争抢建立 PostgreSQL 集成测试。
