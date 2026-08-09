# API 契约

OpenAPI 入口为 [`contracts/openapi.yaml`](../../contracts/openapi.yaml)。结果、题目、提交契约分别由 `contracts/*.schema.json` 固化；新增接口先更新契约，再更新 NestJS 控制器和测试。

本地请求可使用 `X-Employee-Id: w00123`（管理员）或 `w00124`–`w00132`（学员）。所有响应会返回 `X-Request-Id`；错误响应至少包含 `code`、`message`，评分错误还包含 `details.recalculatedTotal` 与错误列表。

生产 SSO 同步使用 `POST /api/v1/auth/sso`，请求体只包含 `employeeNo`、`name` 和可选的 `department`。平台按工号幂等登记员工，能匹配组织树时自动写入部门，无法匹配时保留未配置部门；管理端不提供新增员工接口，`PATCH /api/v1/users/{userId}` 仅维护 `orgUnitId`、`roles` 和角色范围。组织使用 `POST /org-units`、`PATCH /org-units/{id}` 和 `DELETE /org-units/{id}` 维护；删除只允许没有下级部门、员工、权限绑定、训战范围或其他业务引用的非根部门。

`POST /api/v1/events/{eventId}/submissions:upload` 支持四种交付输入：`uploadId` + `X-Upload-Token`（`POST /uploads` 两阶段上传）、`artifactBase64`、同一学员在同一场次已登记的 `artifactUri`，或本地开发用 `workspacePath`。客户端提供的 `snapshotHash`/`artifactHash` 只用于一致性校验；服务端会读取实际交付件并固化不可变快照。文件提交不能只传哈希而不传实际交付件。

评测完成或线下导入后，结果中的 `subject` 由服务端根据提交记录补齐 `id/name/orgPath`；不会信任评测器或导入 JSON 自报的组织信息。`gradingRunId` 在平台内全局唯一，只有同一提交的同一幂等键可以重试。

管理员能力画像工作台使用 `GET /api/v1/admin/capabilities`：不传参数查看全员，传 `orgPath=/1/12/125/` 查看部门及其子团队；再传 `subjectIds=w00124,w00126` 即按指定人员形成群体画像。部门或选定人员场景建议传 `includeProfiles=false`，只返回四维、八域和 16 个评分点的平均聚合及有效样本数；不传或传 `true` 才返回个人明细。管理员视图可读取尚未揭晓的内部成绩，员工个人接口仍遵守场次揭晓策略。

当前 `GET /users`、`GET /submissions` 和部分管理列表仍返回权限范围内的完整集合，由前端分页；正式数据规模接入前必须为这些接口增加服务端游标或页码分页，并保持稳定排序。
