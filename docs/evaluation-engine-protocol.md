# 赛题评测引擎协议

每个赛题版本独立配置一个评测引擎，`evaluationEngine` 是该赛题如何被评测的唯一事实来源；训战场次不再携带任何执行器配置。平台负责锁定交付件快照、按引擎分发执行、校验结果并写入报告。

`mode` 决定平台如何分发，也决定该赛题的训战能选哪些评测方式：

| mode | 执行者 | 允许的评测方式 | 必须提供 `local` |
|---|---|---|---|
| `PLATFORM_LOCAL` | 平台内置执行器 | 自动评估 / 管理员安排 / 线下结果录入 | 是 |
| `EXTERNAL_CLI` | 管理员本地命令或 CodeAgent | 仅线下结果录入 | 否（提供会被拒绝） |

创建或修改训战时，如果评测方式与引擎能力不符，平台直接拒绝并返回 `ENGINE_TRIGGER_UNSUPPORTED`，不会等到执行评估时才失败。

## 赛题配置

在管理员的赛题版本配置中填写 `evaluationEngine`：

```json
{
  "id": "parking-fee-evaluator",
  "version": "1.0.0",
  "mode": "PLATFORM_LOCAL",
  "local": {
    "contractPath": "challenges/parking-fee-v1/submission-contract.json",
    "testsDir": "challenges/parking-fee-v1/hidden-tests",
    "entry": "src/parking.py",
    "function": "calculate_fee",
    "language": "python"
  },
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

所有路径（`input.contractPath`、`output.contractPath` 以及 `local` 下的各项）都是仓库内相对路径，不能使用绝对路径、盘符、反斜杠或 `..`。

`local` 只属于 `PLATFORM_LOCAL`：它是内置执行器的参数，不会出现在下发给外部评测者的输入清单里。

评测引擎标识和版本以 `id@version` 的形式参与**三种评测方式**的幂等键计算，因此修改引擎版本会让该赛题的历史结果失效并需要重跑；这一点对自动评估、管理员安排和线下录入完全一致。

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

- 「自动评估」由平台队列在提交后立即调度，「管理员安排」由管理员选择提交后触发；两者都要求引擎为 `PLATFORM_LOCAL`，并使用同一份 `local` 配置执行。
- GitLab 自动评测适配器不在本协议范围内，接入时复用同一 `GradingExecutor` 接口和同一结果契约，引擎配置无需改动。
