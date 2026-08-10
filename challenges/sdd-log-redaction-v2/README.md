# 基于 SDD 的运维日志脱敏工具开发实战演练（进阶）

## 业务任务

生产日志会混合 JSON、普通文本、HTTP 请求头和 URL，既要彻底移除凭据与个人信息，又要保留故障定位所需的结构、类型和跨行关联。固定字段替换无法覆盖嵌套数组、字段名变体、规则重叠、畸形输入及大批量日志；无密钥的散列也无法抵抗字典反推。

本题要求以 SDD 方式交付一套 Python 3.11 标准库实现：规格先于代码，策略独立版本化，关联标识使用 HMAC-SHA256，文件按行流式处理，所有失败路径默认不回显原文。平台会运行评测方冻结的隐藏用例，学员自己的测试只作为交付证据之一。

## 必交目录

ZIP 根目录只允许以下六个文件：

```text
SPEC.md
README.md
AI_WORKLOG.md
policy/redaction_policy.json
src/log_redactor.py
tests/test_log_redactor.py
```

公开接口必须至少包含：

```python
load_policy(path)
redact_line(line, policy=None, key=None)
redact_stream(reader, writer, policy=None, key=None)
```

命令行必须支持 `--input`、`--output` 和 `--policy`。HMAC 密钥只能从策略声明的环境变量读取，也允许测试通过 `key` 参数注入；缺少密钥时必须以稳定错误码终止，不得回显待处理内容。

## 强制场景

- 普通文本中的手机号、身份证号、邮箱、IPv4、MAC、令牌和口令。
- 嵌套 JSON 对象与数组中的敏感字段、大小写字段名和非字符串值。
- `Authorization` 请求头以及 URL 中的 `token`、`access_token`、`password`、`api_key` 参数。
- `user_id`、`device_id` 等关联字段的 HMAC 稳定别名：同值同密钥结果一致，不同值或不同密钥结果不同。
- 身份证号与手机号等重叠模式的优先级、再次脱敏幂等、Unicode 保真。
- 畸形 JSON、超长行、无效策略、缺失密钥的失败关闭。
- 单次迭代读取、批量行计数、命令行成功与失败路径。

## 评分结构

总分 100，使用 V1–V4、S1–S4、C1–C4、P1–P4 共 16 个评分点。Verify 与 Code 维度直接引用 24 个隐藏用例结果；Spec 与 Collab 维度核对规格、追踪矩阵和 AI 协作事实。每个非 A 档评分点都会给出文件位置、未通过的证据类别和修改建议。

| 隐藏用例层级 | 数量 | 重点 |
| --- | ---: | --- |
| 核心 | 6 | 数据类型、结构、字段与策略入口 |
| 复杂 | 6 | 冲突、幂等、HMAC、Unicode 与跨记录关联 |
| 安全 | 6 | 密钥、畸形输入、资源边界、策略和无泄露诊断 |
| 工程 | 6 | 真流式处理、批量统计、命令行与策略变更 |

## 本地自检

```text
node scripts/build-engine-package.mjs sdd-log-redaction-v2 --out tmp/sdd-log-redaction-v2-engine.zip
python tools/engine-dev-kit/tools/engine_dev.py validate tmp/sdd-log-redaction-v2-engine.zip
python tools/engine-dev-kit/tools/engine_dev.py run tmp/sdd-log-redaction-v2-engine.zip --workspace challenges/sdd-log-redaction-v2/reference --output tmp/sdd-log-redaction-v2-result.json
```

参考交付件必须通过 24/24 个隐藏用例并获得 100 分。仓库中的 v1 风格弱实现用于强度回归：即使套用完整规格，也不得获得 75 分以上。
