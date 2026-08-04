# 评测输入/输出约束开发说明

管理员开发赛题时，不需要手写 `contractPath`。管理端把它称为“输入约束/输出约束”，选项来自 Git 中的 `contracts/evaluation-contract-catalog.json`，只展示其中 `visibility=PUBLIC` 且与评测方式匹配的条目。代码和 API 仍保留 `contractPath`、`kind` 等契约字段名，方便版本化和兼容已有配置。

## 选择规则

- `EXTERNAL_CLI` 选择“外部评测批次输入约束 v1.0”，评测程序读取 `contracts/examples/evaluation-input.external.valid.json`，完成后返回平台统一结果。
- `PLATFORM_LOCAL` 或 `PACKAGED` 选择“Code Agent 批次输入约束 v1.1”，Code Agent 先读批次清单、题目指令和 Skills，再逐份处理 `submissions`。
- 三种评测方式都选择“平台统一评测输出约束 v1.0”。输出不能自定义外层结构；评分点、证据和扩展指标放在该约束允许的字段中。
- `engine-invocation.schema.json` 只给打包引擎进程使用，包含沙箱内路径，管理员不应把它当作平台批次输入。

## 管理端查看详情和复制给 AI

输入或输出约束下拉框旁的“查看详情”会打开只读详情面板，内容来自 Git 固定的约束目录，包括：

- 约束类型、版本、适用评测方式和 Schema 路径；
- 已由服务端按 Schema 校验过的 JSON Schema 与示例；
- 本文件等编写说明。

点击“复制给 AI 出题”会把一段完整的中文提示复制到剪贴板。提示包含选中的约束、Schema、示例和编写说明，并要求 AI 只能使用目录中已发布的路径、版本、字段和枚举值。复制的内容可以直接粘贴到 AI 对话中，再补充赛题目标、学员交付物和评分偏好；管理员仍需审核 AI 草稿，最终保存时由服务端白名单和 Schema 再次校验。

## 给 AI 的配置提示

让 AI 先读取：

1. `contracts/evaluation-contract-catalog.json`；
2. 目录中所选契约的 `path` 对应 Schema；
3. 对应 `examplePath` 示例；
4. 本文件和 `docs/evaluation-engine-protocol.md`。

然后要求 AI：

- 只使用目录中存在的约束版本、字段名和枚举值，不创建新的 `contractPath`；
- 根据赛题的评测方式生成 `evaluationEngine` 配置，输入/输出约束必须与下拉选择一致；
- 为每个评分点提供 `criteria.key`、维度、上限、规则和可审计证据；
- 不把员工真实身份、令牌、仓库凭据、绝对路径或学员源码写入示例；
- 先输出配置草稿和需要管理员确认的参数，再生成题面、指令、Skills 和评测器文件。

## 推荐配置形状

```json
{
  "evaluationEngine": {
    "id": "parking-fee-evaluator",
    "version": "1.0.0",
    "mode": "PLATFORM_LOCAL",
    "input": {
      "format": "JSON",
      "schemaVersion": "1.1",
      "contractPath": "contracts/evaluation-agent-batch-v1.1.schema.json"
    },
    "output": {
      "format": "JSON",
      "schemaVersion": "1.0",
      "contractPath": "contracts/evaluation-result.schema.json"
    }
  }
}
```

约束版本、Schema、rubric 和已发布赛题版本不可原地修改；需要改变外层协议时，应新增 Git 中的 Schema、示例和目录条目并升版本。
