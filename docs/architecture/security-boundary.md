# 安全边界（本地适配器）

本地开发默认使用 `X-Employee-Id` 作为认证适配器输入，服务端从文件适配器读取角色、状态和组织路径。生产接入内部 SSO 时，`POST /api/v1/auth/sso` 根据工号、姓名和部门幂等登记员工；网关也可以附带 `X-SSO-Employee-No`、`X-SSO-Name`、`X-SSO-Department`，由 API 首次请求时同步身份。请求体中的 `actorId` 只为兼容旧客户端保留，所有管理操作都会忽略它并使用认证上下文中的操作者。

员工账号不能通过管理接口创建。管理员只能为 SSO 已登记的员工配置部门归属和角色；部门匹配失败时员工保留空组织路径，只能由全局管理员完成首次归属。

提交路径有三层边界：

1. `workspacePath` 必须位于 `LOCAL_WORKSPACE_ROOT`，并拒绝 `grader`、`hidden-tests`、`contracts`、`.git`、`node_modules` 和 `tmp`；
2. 上传归档先检查声明大小，再在解包时检查路径穿越、软链接、文件数量和膨胀总量；
3. `LOCAL_GIT_ROOT` 只允许相对仓库路径，Git 通过 `rev-parse` 锁定 commit 后由 `git archive` 生成只读归档。

生产环境仍需要在网关层校验 SSO 断言或 OIDC/JWT，并清理外部请求自带的 `x-sso-*` 头；同时把本地执行器替换为禁网、非 root、资源受限的 K8s Job。本地实现不应被直接暴露到生产网络。
