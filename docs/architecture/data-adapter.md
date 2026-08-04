# 数据适配器边界

当前本地验收使用 `PlatformStore` 文件适配器和 `ArtifactStore` 本地不可变目录，默认不要求 PostgreSQL 或任何外部服务。这样可以在 Windows 开发机上重复执行组织、赛题、训战、提交、批次评测、报告和画像链路。

`services/platform-api/prisma/schema.prisma` 与 `prisma/migrations/` 是生产关系模型的版本化契约，覆盖组织、角色绑定、题目版本、场次、参与名单、提交快照、评测运行、批次租约、结果证据、赛季和公告。v0.7.0 实现候选已通过 `PLATFORM_REPOSITORY` 接入 Prisma/PostgreSQL：W1 的组织、人员和审计使用规范化 Repository，赛题、训战、提交和评测的过渡写路径通过请求级 Unit of Work 读取最新关系图并原子同步；`PlatformSnapshot` 只保留迁移与回滚兼容用途。文件适配器仍是本地默认，生产必须显式选择 PostgreSQL。领域服务继续保持现有状态机、快照算法、结果 Schema 和幂等规则不变。

PostgreSQL 请求级读写和 Repository transaction 使用 repeatable-read 快照，并以 `PlatformSnapshot.revision` CAS 拒绝跨实例旧状态覆盖；S3-compatible 在 PostgreSQL 模式使用持久化 `UploadSession`，文件 Repository + S3 的本地联调则使用内存上传会话。

本地适配器与生产适配器的边界：

- `PlatformStore` → Prisma Repository；
- `ArtifactStore` → S3 兼容对象存储；
- `LocalGitSnapshotter` → GitLab/受控 Git 取件；
- `Evaluation Worker` 的本地目录 → 受控 Worker 节点与临时卷；
- 本地 Code Agent bridge → 组织内 Code Agent 服务或受控 CLI；
- 内嵌 `LocalGradingExecutor` → 仅保留测试用途，生产由 K8s Job/独立沙箱执行。

本地测试不会隐式连接数据库；候选实现提供 `prisma migrate deploy`、JSON 导入 dry-run、备份和恢复命令。正式发布仍必须在独立数据库上执行迁移、升级、导入、并发租约、回滚和备份恢复演练，并保留 PostgreSQL 集成测试证据。本轮已在临时隔离 PostgreSQL 16.4 上完成迁移、导入、备份、恢复和 API 集成验收；目标环境仍需重复这些门禁，不能由本地文件或模拟适配器替代。
