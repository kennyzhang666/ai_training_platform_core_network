# 运维日志脱敏工具

## 运行

使用 Python 3.11 标准库处理 UTF-8 日志文件：

```text
python src/log_redactor.py --input input.log --output redacted.log
```

库调用入口为 `redact_line(line, rules=None)`。输入是单行 JSON 或普通文本，输出是确定性的脱敏字符串；JSON 使用稳定键顺序输出。工具不访问网络，也不保存原始日志副本。

## 验证

在交付件根目录执行：

```text
python -m unittest discover -s tests -p "test_*.py" -v
```

测试覆盖普通文本、JSON、嵌套结构、Unicode、畸形 JSON、幂等、无效规则与规则变更。命令退出码为 0 才视为验收通过。

## 扩展规则

自定义规则使用 `Rule(name, compiled_pattern, replacement)` 创建，并通过 `redact_line(..., rules=...)` 注入。新增或扩展规则必须使用稳定名称、明确规则优先级，并增加命中、未命中、冲突和幂等测试。扩展规则不得在替换值中保留完整敏感原文。

## 安全边界

调用方只记录处理条数、规则版本、稳定错误码和脱敏后摘要。不得把输入行、异常上下文中的原始日志、访问令牌或凭据写入控制台和诊断文件。无法读取输入文件时命令返回失败。
