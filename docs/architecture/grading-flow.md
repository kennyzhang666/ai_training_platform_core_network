# 评测流程

## 当前主流程

```text
UPLOAD / GIT_REF 提交
  -> 服务端校验赛题交付契约
  -> 固化 artifactHash、snapshotHash 和员工/组织快照
  -> AUTO 自动创建运行，MANUAL 等管理员选择，IMPORT 等待结果
  -> 为一份或多份提交创建不可变 GradingRun
  -> 同一训战的运行组成 EvaluationBatch
  -> 独立 Worker 以租约领取完整批次并持续心跳
  -> 物化交付件、引擎、instruction.md、Skills、输入/输出 Schema
  -> Code Agent 按 batch-manifest.json 逐份调用评测引擎
  -> 生成单人 evaluation-result 和批次结果索引
  -> Worker 回传成功项与失败项
  -> 平台校验 Schema、运行归属和幂等键
  -> 平台覆盖可信 subject 并重算 criteria -> dimensions -> total
  -> 不可变保存、状态流转、报告/画像更新和审计
```

`AUTO`、`MANUAL`、`IMPORT` 只决定何时发起或录入，不产生三套评分逻辑。线下导入与在线 Worker 回传最终都进入相同的结果可信边界。

## 不可变与幂等

`snapshotHash` 的输入是排序后的相对路径、文件内容 SHA-256 和执行权限位；忽略版本控制目录、虚拟环境和 Python 缓存。批次还会冻结赛题版本、rubric、引擎包、Code Agent 运行配置和契约哈希。

结果的 `recalculatedTotal` 由平台写入，任何评测器或线下 JSON 的算术不一致都会被拒绝。结果中的 `subject` 由平台从提交时的员工与组织快照补齐，外部结果不能覆盖。`gradingRunId` 在平台内全局唯一，只有同一运行和同一幂等键的重复回传才会返回已有结果。

重新评测会新建 `GradingRun`，不会覆盖旧结果。同一交付快照由不同员工提交时，每名员工仍有独立的运行和结果。

## 租约与失败恢复

Worker 一次领取完整批次，不把管理员选定的多份提交拆成独立队列项。Worker 崩溃或租约过期时，未完成批次重新排队；平台只有在成功验证回传后才完成对应运行。结果索引允许记录单份失败，平台分别落下完成和失败状态。

API 进程内的执行器仅在显式设置 `EMBEDDED_EVALUATION_WORKER=true` 时用于兼容测试，生产流程不得在 API 进程中执行学员代码。

批次 ABI、目录布局和 Code Agent 命令规则见 `docs/evaluation-engine-protocol.md`。
