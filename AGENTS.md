# AI 训战平台工程约束

## 开发入口

- 先阅读 `DEVELOPMENT_PLAN.md` 和本文件，再修改代码。
- 根目录使用 pnpm workspace；Python grader 使用 `grader/requirements.txt`。
- 契约文件位于 `contracts/`，是 TypeScript、Python 和 API 的事实来源。
- 本地验证优先使用 `pnpm contract:test`、`pnpm grader:test` 和受影响模块的测试。

## 架构边界

- 平台 API 使用 TypeScript/NestJS；评测执行使用 Python CLI；不在 Node API 进程中执行不可信学员代码。
- 上传和 Git 交付件在进入 grader 前必须转换成不可变快照。
- 评分结果必须通过 JSON Schema、提交归属、幂等键和服务端重算校验。
- `AUTO`、`MANUAL`、`IMPORT` 是场次配置，不得复制出三套评分逻辑。
- 已发布 Schema、rubric 和数据库迁移不可原地修改，变更必须升版本。

## 安全规则

- 不把真实员工、客户、仓库凭据或生产数据写入 fixture、日志和测试。
- Git 地址只能来自已发布场次配置；不得接受客户端任意 URL。
- 上传包必须限制大小、路径和解压后体积，拒绝路径穿越、符号链接逃逸和解压炸弹。
- 不记录 token、Cookie、SSO 断言或完整源码。

## Codex 任务规则

- 每次只实现一个可验收的纵切面，不擅自扩展范围。
- 先补测试和契约样例，再实现逻辑。
- 不通过删除测试、放宽校验或吞异常来“修复”失败。
- API 改动同步 OpenAPI；Schema 改动同步 TypeScript/Python 契约测试。
- 发布版本必须同步 `DEVELOPMENT_PLAN.md` 的当前状态、版本沿革和后续计划，并在 `CHANGELOG.md` 记录事实变更。
- 完成后报告改动文件、验证命令、结果和未解决风险。
