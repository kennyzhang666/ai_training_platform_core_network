# 基于 SDD 的运维日志脱敏工具开发实战演练

## 业务背景

运维日志常同时包含故障定位信息和员工、客户或系统凭据。简单删除整行会破坏排障价值，只替换固定字段又无法覆盖普通文本、嵌套 JSON 和格式异常。参训员工需要使用规格驱动开发（SDD）方法，先把目标、边界、规则、接口、验收和回滚写成可追踪规格，再完成一个可运行的 Python 脱敏工具。

评测以 `SPEC.md` 为主要证据，并交叉核对实现、自动测试、运行说明和 AI 协作记录。仅写出能运行的代码但无法说明为什么这样设计、如何验证和如何应对变更，不会获得完整分数。

## 交付要求

ZIP 根目录必须只包含以下文件：

```text
SPEC.md
README.md
AI_WORKLOG.md
src/log_redactor.py
tests/test_log_redactor.py
```

`SPEC.md` 至少覆盖目标与非目标、范围与约束、关键假设、决策记录、敏感数据分类、规则优先级、输入输出契约、组件设计、失败策略、验收标准、需求追踪、可观测性、变更影响和回滚。实现必须使用 Python 3.11 标准库，支持 JSON 与普通文本日志；测试必须覆盖主流程、边界、异常、幂等和规则变化。

## 评分结构

总分 100，沿用平台统一四维和 16 个评分点：

| 维度 | 评分点 | 分值 | 本题证据重点 |
| --- | --- | ---: | --- |
| Verify | V1–V4 | 40 | 主流程、边界、规则核验、变更回归 |
| Spec | S1–S4 | 25 | 需求澄清、验收追踪、失败策略、变更与回滚 |
| Code | C1–C4 | 20 | 规则建模、安全边界、类型保真、模块化 |
| Collab | P1–P4 | 15 | 规格先行、小步迭代、提示词设计、变更定位 |

每个评分点按 A/B/C/D 档给分，并保留判据、证据、文件位置和修改建议。平台会重新计算各维度和总分，评测引擎自报的总分不是可信事实。

## 目录说明

- `challenge.yaml`：赛题定义与正式题面字段。
- `submission-contract.json`：平台提交前执行的目录契约。
- `engine/`：评测入口、Code Agent 指令和评测 Skill。
- `hidden-tests/rubric.json`：冻结的 16 点确定性判据。
- `reference/`：发布前自检用满分参考交付件。
- `sample-submission/`：本地端到端验收使用的合规学员交付件，保留少量可追踪改进项。

## 本地自检

```text
node scripts/build-engine-package.mjs sdd-log-redaction-v1 --out tmp/sdd-log-redaction-engine.zip
python tools/engine-dev-kit/tools/engine_dev.py validate tmp/sdd-log-redaction-engine.zip
python tools/engine-dev-kit/tools/engine_dev.py run tmp/sdd-log-redaction-engine.zip --workspace challenges/sdd-log-redaction-v1/reference --output tmp/sdd-log-redaction-reference-result.json
```

参考交付件应得到 100 分；`sample-submission` 应得到 95.75 分，并产生 SPEC 变更回滚与 AI 变更复测相关的可定位改进项。
