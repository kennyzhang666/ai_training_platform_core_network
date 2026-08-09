# 独立评测引擎开发包

这个目录和下载的 `evaluation-engine-development-kit.zip` 都可以在没有平台代码仓库的电脑上使用。它提供：

- `contracts/`：平台实际使用的评测引擎、调用输入和结果 Schema；
- `examples/minimal-engine/`：完全使用 Python 标准库的最小参考引擎；
- `examples/sample-submission/`：参考引擎使用的合成提交；
- `tools/engine_dev.py`：校验、运行和打包 CLI；
- `GUIDE.md`：评测引擎开发规范和可交给其他 AI 的提示词。

## 在没有平台仓库的电脑上

只需要 Python 3.10+：

```powershell
python tools/engine_dev.py validate examples/minimal-engine
python tools/engine_dev.py run examples/minimal-engine --workspace examples/sample-submission --output tmp/sample-result.json
python tools/engine_dev.py package examples/minimal-engine --out tmp/minimal-score-engine.zip
python tools/engine_dev.py validate tmp/minimal-score-engine.zip
```

这些命令不连接平台 API，也不需要 Node、pnpm、数据库或 Worker。`jsonschema` 是可选依赖；安装 `requirements.txt` 后，CLI 会额外运行完整的 2020-12 Schema 校验。

## 开发自己的引擎

复制 `examples/minimal-engine`，修改 `engine.json`、`instruction.md`、Skills 和 Python 入口。`agent.instruction` 指向指令文件，`agent.skills` 中每一项指向一个包含 `SKILL.md` 的目录；如有第三方 Python 依赖，在 `runtime.requirements` 中声明包内 requirements 文件。入口按平台约定接收：

```text
python -I judge.py --input <invocation.json> --output <result.json>
```

引擎只能读取 invocation 指向的只读工作区和包内资源，把符合 `contracts/evaluation-result.schema.json` 的结果写到 `outputPath`。完成本地验证后，把生成的 ZIP 上传到平台赛题版本；平台仍会在独立 Worker 中重新校验和执行。

## 重要边界

这个开发包能独立完成引擎逻辑、契约检查和合成样例运行，但不能代替平台源码。真实训战、权限、批次租约、结果入库和 OpenCode 端到端测试仍需完整平台仓库和 Worker 环境。
