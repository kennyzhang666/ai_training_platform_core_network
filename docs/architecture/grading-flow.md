# 评测流程

```text
提交 UPLOAD/GIT_REF
  -> 服务端固化 snapshotHash
  -> AUTO 进入进程内队列，MANUAL 等待管理员，IMPORT 等待结果文件
  -> LocalGradingExecutor / 后续 GitLabGradingExecutor
  -> Schema 校验
  -> 服务端重算 criteria -> dimensions -> total
  -> 幂等保存、状态流转、报告与审计
```

`snapshotHash` 的输入是排序后的相对路径、文件内容 SHA-256 和执行权限位；忽略版本控制目录、虚拟环境和 Python 缓存。结果的 `recalculatedTotal` 由平台写入，任何客户端或线下结果的算术不一致都会被拒绝。

结果中的 `subject` 由平台从提交时的员工与组织快照补齐，线下 JSON 不能覆盖历史组织路径；`gradingRunId` 碰撞也会被拒绝。

本地队列使用有界并发（默认 2，可由 `LOCAL_GRADING_CONCURRENCY` 调整）；API 重启时只恢复未完成的 AUTO 任务，MANUAL/IMPORT 仍等待管理员。幂等键本身描述“快照 + 题目版本 + rubric + grader 版本”，结果索引还会带上 `submissionId`，因此同一快照被多人提交时每个人都有独立成绩，而同一提交重试仍只生成一份成绩。
