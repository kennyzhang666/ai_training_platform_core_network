# 最小引擎说明

这是一个独立开发包示例。引擎读取平台传入的 invocation JSON，打开 workspace/answer.txt，答案为 42 时给出 100 分，否则给出 0 分。真实引擎应使用题目自己的只读快照、测试资产和 rubric。

运行入口必须保持：

```text
python -I judge.py --input <invocation.json> --output <result.json>
```
