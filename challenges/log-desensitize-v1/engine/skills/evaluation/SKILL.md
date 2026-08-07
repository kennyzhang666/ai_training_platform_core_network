---
name: log-desensitize-evaluation
description: 运维日志脱敏（SDD）赛题的批次评测技能。用于按批次清单逐份调用自带判据的评测引擎，并回收符合平台结果契约的结构化结果。
---

# 运维日志脱敏 · 批次评测技能

## 适用场景

Worker 已经物化好批次目录，你需要对清单中的每份提交调用一次评测引擎并回收结果。

## 前置事实

- 引擎自带全部判据，**模型不参与打分**；
- 同一份交付件在任何机器上必然同分，因此结果不可「酌情调整」；
- 平台会重算 `criteria → dimensions → total`，任何人工修改都会被拒绝。

## 步骤

### 1. 读取清单

```text
manifest = read_json(env.AI_TRAINING_BATCH_MANIFEST)
```

关注 `manifest.engine.packageRoot`、`manifest.submissions[]`、`manifest.resultIndexPath`。

### 2. 逐份构造调用输入

对每个 `submission`，写一份 `invocation.json` 到 `submission.scratchDir`：

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "<ISO8601>",
  "engine": {
    "id": "log-desensitize-sdd",
    "version": "1.0.0",
    "packageHash": "<manifest.engine.packageHash>",
    "packageRoot": "<manifest.engine.packageRoot>",
    "assets": {
      "submissionContract": "<packageRoot>/assets/submission-contract.json",
      "testsDir": "<packageRoot>/assets/hidden-tests",
      "referenceDir": "<packageRoot>/assets/reference"
    },
    "source": "PACKAGE"
  },
  "challenge": { "id": "...", "challengeVersion": "...", "rubricVersion": "..." },
  "grading": { "runId": "...", "idempotencyKey": "...", "triggerType": "...", "attempt": 1 },
  "subject": { "id": "..." },
  "submission": { "id": "...", "sourceType": "...", "snapshotHash": "...", "submittedAt": "..." },
  "workspace": "<submission.workspace>",
  "outputPath": "<submission.outputPath>",
  "scratchDir": "<submission.scratchDir>",
  "limits": { "wallClockSeconds": 180, "memoryMB": 512, "outputBytes": 4194304 }
}
```

字段一律取自清单，不要自己推测路径或补默认值。

### 3. 调用引擎

```text
python -I <packageRoot>/judge.py --input <scratchDir>/invocation.json --output <outputPath>
```

`shell: false`，不要拼接命令字符串。

### 4. 判定单份结果

| 情况 | 处理 |
|---|---|
| 退出码 0 且结果文件存在 | 记入 `results` |
| 退出码非 0 | 记入 `failures`，`reason` 用截断后的 stderr |
| 超过时限 | 记入 `failures`，`reason` 写明超时 |
| 结果文件缺失或非法 JSON | 记入 `failures`，不要重试打分 |

结果里出现 `status: "PARTIAL"` 和 `BLOCKER` 诊断是**正常业务结果**（通常是学员漏交 `SPEC.md` 或 `transcript.md`），应记入 `results` 而不是 `failures`。

### 5. 写结果索引

```json
{
  "schemaVersion": "1.0",
  "batchId": "<manifest.batchId>",
  "results": [{ "runId": "...", "resultPath": "results/<runId>.json" }],
  "failures": [{ "runId": "...", "reason": "..." }]
}
```

清单里的每个 `runId` 必须恰好出现一次，出现在 `results` 或 `failures` 之一。

## 禁止事项

- 不修改 `workspace` 中的任何文件；
- 不改写引擎输出的分数、等级或证据；
- 不把学员源码、交付件内容或凭据写入日志和结果 `reason`；
- 不为失败的提交编造结果。
