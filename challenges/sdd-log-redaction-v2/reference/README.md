# 运维日志脱敏工具

## 运行环境

工具仅使用 Python 3.11 标准库。处理输入前必须设置策略声明的 `LOG_REDACTION_KEY`，该值只存在于运行环境，不写入策略、源码、测试输出或交付包。输入和输出均为 UTF-8 文本文件，每一行独立处理；JSON 对象或数组输出为稳定键序，普通文本保持原有非敏感内容。

## 执行命令

Windows PowerShell：

```text
$env:LOG_REDACTION_KEY="由运行环境注入"
python src/log_redactor.py --input input.log --output output.log --policy policy/redaction_policy.json
```

Linux：

```text
LOG_REDACTION_KEY="由运行环境注入" python src/log_redactor.py --input input.log --output output.log --policy policy/redaction_policy.json
```

正常完成返回退出码 0，并以同目录临时文件原子替换目标。策略无效、文件不可读写或需要关联别名但密钥不可用时返回退出码 2，删除临时结果，不留下半成品；标准错误只包含稳定错误码。工具不会把待处理日志、HMAC 密钥或异常堆栈写入终端。

## 验证命令

```text
python -m unittest discover -s tests -p "test_*.py" -v
python -m compileall -q src tests
```

公开测试覆盖基础文本、嵌套 JSON、规则优先级、HMAC 关联、幂等、Unicode、安全失败、流式统计和协议载荷。平台另行执行冻结隐藏用例，公开测试结果不能替代平台验收。

## 策略维护

`policy/redaction_policy.json` 是随赛题版本冻结的策略入口。新增字段或调整资源上限时，先更新 `SPEC.md` 的需求、验收与追踪矩阵，再更新策略、实现和测试。`textRulePriority` 的顺序是兼容性契约，不允许只修改配置而跳过规则冲突回归。回滚时恢复上一策略版本，并重新执行全部公开测试和平台验收。
