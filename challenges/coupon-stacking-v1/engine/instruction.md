# 超市叠加优惠测试训战评测

使用本引擎的确定性评分，不自行解释评分标准或修改分数。

1. 读取平台提供的 batch-manifest.json 以及清单中全部 Skills。
2. 使用环境变量 `AI_TRAINING_ENGINE_PYTHON` 指定的解释器执行包内 `run_batch.py --manifest <清单绝对路径>`。建议通过 Code Agent 的执行工具传入参数数组；不要手写批次结果索引。
3. 等待程序处理清单中的每份提交。程序会写入指定 outputPath 和 resultIndexPath，单份失败不会扩大或终止其余范围。
4. 只核对索引包含本批次每个 runId 恰好一次，结果路径位于批次 results 目录。不得更改提交、隐藏材料、生成结果或幂等标识。

平台调用单份入口时，格式为 `python -I judge.py --input <invocation.json> --output <result.json>`。这是程序内部调用输入，不要把批次清单直接传给 judge.py。

不得把变体源码、补丁、内部版本编号、内部缺陷定义或隐藏期望写到结果、终端摘要或平台报告。学员测试在正确实现上的失败消息可由判题器按规则反馈，不能自行展开隐藏材料。发现内部错误时保留失败状态，不能改成默认分或自行“修正”测试。
