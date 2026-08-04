# 评测 Skill

- 只读取 invocation.workspace 指向的提交快照。
- 不访问网络、其他提交目录、平台数据库或凭据。
- 输出必须保留 grading.runId、grading.idempotencyKey 和 grading.triggerType。
- 分数之外记录可审计的 criteria、evidence 和明确状态。
