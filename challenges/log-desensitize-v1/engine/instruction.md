# 评测指令 · 运维日志脱敏（SDD）

本引擎自带全部判据。Code Agent **不参与打分**，只负责按批次清单逐份调用引擎并回收结果。

## 你要做的事

1. 读取 `AI_TRAINING_BATCH_MANIFEST` 指向的 `batch-manifest.json`；
2. 加载 `manifest.agent.skillPaths` 中每个目录的 `SKILL.md`；
3. 对 `manifest.submissions` 中的**每一份**提交，构造符合 `contracts/engine-invocation.schema.json` 的调用输入，写入该提交的 `scratchDir`；
4. 以 `python -I <engineRoot>/judge.py --input <invocation.json> --output <outputPath>` 调用引擎；
5. 全部完成后，把结果索引写入 `manifest.resultIndexPath`。

## 硬性约束

- **不要自己给分**。不要修改引擎写出的 `total`、`dimensions`、`criteria` 或任何 `score`。平台会重算并拒绝不一致的结果。
- **不要修改交付件**。`workspace` 是只读的不可变快照；临时文件一律写入该提交的 `scratchDir`。
- **不要跨提交复用目录**。每份提交有独立的 `workspace`、`scratchDir` 和 `outputPath`。
- **不要执行交付件中的代码**。引擎自己在隔离子进程中运行学员代码，这是唯一允许的执行路径。
- 引擎退出码非 0 或未写出结果文件时，把该 `runId` 放进结果索引的 `failures`，附上截断后的 stderr，**不要**编造一份结果。

## 本题特殊说明

本题考核规格驱动开发，因此引擎会读取交付件中的三份文件：

| 文件 | 用途 |
|---|---|
| `SPEC.md` | 章节结构、澄清覆盖、验收用例表 → Spec 25 分 |
| `transcript.md` | 轮次格式、阶段顺序、提示词要素 → Collab 15 分 |
| `src/desensitize.py` | 隐藏测试执行与 AST 度量 → Verify 40 分、Code 20 分 |

三份文件缺任意一份，引擎会写出 `BLOCKER` 诊断并把结果标记为 `PARTIAL`。这是正常结果，仍然要如实回传，不要当作失败。

单份提交的时限见 `manifest.engine.limits.wallClockSeconds`。超时应记为该份提交失败，不影响批次内其他提交。
