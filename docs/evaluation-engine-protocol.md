# 赛题评测引擎协议

每个赛题版本独立配置一个评测引擎。平台只负责锁定交付件快照、生成输入清单、校验结果并写入报告；评测逻辑由管理员在本地命令或 CodeAgent 中执行。

## 赛题配置

在管理员的赛题版本配置中填写 `evaluationEngine`：

```json
{
  "id": "parking-fee-evaluator",
  "version": "1.0.0",
  "mode": "EXTERNAL_CLI",
  "input": {
    "format": "JSON",
    "schemaVersion": "1.0",
    "contractPath": "contracts/evaluation-input.schema.json"
  },
  "output": {
    "format": "JSON",
    "schemaVersion": "1.0",
    "contractPath": "contracts/evaluation-result.schema.json"
  }
}
```

`contractPath` 是仓库内的 JSON 契约路径，不能使用绝对路径、反斜杠或 `..`。评测引擎标识和版本会参与评测幂等键计算；修改引擎版本后，平台会把它视为新的评测契约。

## 线下评测流程

1. 训战场次选择「线下结果录入」作为评测方式。
2. 管理员在评测中心按训战/赛题打开工作台，勾选一个或多个待处理提交。
3. 调用 `POST /api/v1/events/{eventId}/grading-input`，或点击「生成评测输入」。平台只为选中的提交预留评测运行，并返回 `evaluation-input.schema.json` 清单。
4. 管理员将清单交给对应赛题的本地评测命令或 CodeAgent。管理员端清单中的本地上传交付件会额外提供 `snapshot.artifactPath`；该字段不会返回给员工端。
5. 评测引擎逐份处理交付件，生成符合 `evaluation-result.schema.json` 的结果。结果必须原样保留以下关联字段：
   - `gradingRunId`
   - `idempotencyKey`
   - `challengeVersion`
   - `rubricVersion`
   - `triggerType: "IMPORT"`
   - `submission.sourceType`、`submission.snapshotHash`，以及对应的 `artifactHash` 或 Git 引用
6. 管理员在评测中心粘贴单份结果并保存，或调用 `POST /api/v1/grading-results:import-batch` 导入多份结果。

平台会重新计算总分、校验交付件快照、覆盖结果中的员工身份，并将结果写入评测报告。重复提交同一结果会按幂等键返回已保存结果；运行编号、快照、赛题版本或评测契约不一致的结果会被拒绝。

## 其他评测方式

- 「自动评估」继续由平台队列处理，适合接入自动化执行器。
- 「手动评估」由管理员选择提交后安排运行，适合平台本地执行器。
- GitLab 自动评测适配器不在本协议范围内，后续可复用同一结果契约接入。
