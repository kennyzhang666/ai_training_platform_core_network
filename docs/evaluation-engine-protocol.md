# 赛题评测引擎协议

每个赛题版本独立配置一个评测引擎，`evaluationEngine` 是该赛题如何被评测的唯一事实来源；训战场次不再携带任何执行器配置。平台负责锁定交付件快照、按引擎分发执行、校验结果并写入报告。

`mode` 决定平台如何分发，也决定该赛题的训战能选哪些评测方式：

| mode | 引擎来自 | 允许的评测方式 | 必须提供 |
|---|---|---|---|
| `PLATFORM_LOCAL` | 仓库 `executors/` 目录，后台下拉选择 | 自动评估 / 管理员安排 / 线下结果录入 | `executor`（执行器 id + 参数） |
| `PACKAGED` | 出题人上传的引擎包 | 自动评估 / 管理员安排 / 线下结果录入 | `package`（内容哈希） |
| `EXTERNAL_CLI` | 平台之外，管理员自行评测 | 仅线下结果录入 | —（提供 `executor`/`package` 会被拒绝） |

内置执行器和上传引擎包**共用同一份清单格式（engine.json）和同一份调用契约**，区别只在于前者随平台发布、可被多道赛题复用并接受 `params`，后者按内容哈希固化、自带判据。

## 谁在执行

平台**不执行**赛题或引擎代码。评测环境（独立评测服务器，或管理员本机）主动领取任务：

```text
评测环境                                平台
   │  POST /evaluation-tasks:lease  ──────►│  取出排队中的任务，加租约
   │  ◄──────────────────────────────────  │  下发不可变任务描述
   │  物化引擎（内置=本地仓库 / 包=下载）      │
   │  物化交付件，沙箱内执行引擎               │
   │  POST /evaluation-tasks/{id}/complete ►│  Schema 校验 → 重算总分 → 覆盖身份 → 入库
```

worker 崩溃不需要平台感知：租约到期，任务自动回到队列，下一个 worker 拿到的是同一份不可变快照和同一个幂等键。

本地单机开发可以让 API 内嵌一个 worker（默认开启）；生产部署设 `EMBEDDED_EVALUATION_WORKER=false`，只由独立评测环境消费队列。

创建或修改训战时，如果评测方式与引擎能力不符，平台直接拒绝并返回 `ENGINE_TRIGGER_UNSUPPORTED`，不会等到执行评估时才失败。

## 赛题配置

在管理员的赛题版本配置中填写 `evaluationEngine`：

```json
{
  "id": "parking-fee-evaluator",
  "version": "1.0.0",
  "mode": "PLATFORM_LOCAL",
  "local": {
    "contractPath": "challenges/parking-fee-v1/submission-contract.json",
    "testsDir": "challenges/parking-fee-v1/hidden-tests",
    "entry": "src/parking.py",
    "function": "calculate_fee",
    "language": "python"
  },
  "input": {
    "format": "JSON",
    "schemaVersion": "1.0",
    "contractPath": "contracts/evaluation-input.schema.json"
  },
  "output": {
    "format": "JSON",
    "schemaVersion": "1.0",
    "contractPath": "contracts/evaluation-result.schema.json"
  }
}
```

所有路径（`input.contractPath`、`output.contractPath` 以及 `local` 下的各项）都是仓库内相对路径，不能使用绝对路径、盘符、反斜杠或 `..`。

`local` 只属于 `PLATFORM_LOCAL`：它是内置执行器的参数，不会出现在下发给外部评测者的输入清单里。

评测引擎标识和版本以 `id@version` 的形式参与**三种评测方式**的幂等键计算，因此修改引擎版本会让该赛题的历史结果失效并需要重跑；这一点对自动评估、管理员安排和线下录入完全一致。

## 线下评测流程

1. 训战场次选择「线下结果录入」作为评测方式。
2. 管理员在评测中心按训战/赛题打开工作台，勾选一个或多个待处理提交。
3. 调用 `POST /api/v1/events/{eventId}/grading-input`，或点击「生成评测输入」。平台只为选中的提交预留评测运行，并返回 `evaluation-input.schema.json` 清单。
4. 管理员将清单交给对应赛题的本地评测命令或 CodeAgent。管理员端清单中的本地上传交付件会额外提供 `snapshot.artifactPath`；该字段不会返回给员工端。
5. 评测引擎逐份处理交付件，生成符合 `evaluation-result.schema.json` 的结果。结果必须原样保留以下关联字段：
   - `gradingRunId`
   - `idempotencyKey`
   - `challengeVersion`
   - `rubricVersion`
   - `triggerType: "IMPORT"`
   - `submission.sourceType`、`submission.snapshotHash`，以及对应的 `artifactHash` 或 Git 引用
6. 管理员在评测中心粘贴单份结果并保存，或调用 `POST /api/v1/grading-results:import-batch` 导入多份结果。

平台会重新计算总分、校验交付件快照、覆盖结果中的员工身份，并将结果写入评测报告。重复提交同一结果会按幂等键返回已保存结果；运行编号、快照、赛题版本或评测契约不一致的结果会被拒绝。

## 其他评测方式

- 「自动评估」由平台队列在提交后立即调度，「管理员安排」由管理员选择提交后触发；两者都要求引擎为 `PLATFORM_LOCAL`，并使用同一份 `local` 配置执行。
- GitLab 自动评测适配器不在本协议范围内，接入时复用同一 `GradingExecutor` 接口和同一结果契约，引擎配置无需改动。


## 打包评测引擎（PACKAGED）

一个引擎包（zip）= 一道题完整的评测能力。判据、隐藏测试和提交契约一起冻结，所以换一台机器、换一个执行体，同一份交付件必然同分。

### 包结构

```text
engine.json                     # 清单，必须在包根目录
judge.py                        # 判题入口，engine.json 里声明
requirements.txt                # 可选：声明式依赖
assets/submission-contract.json # 提交契约
assets/hidden-tests/*.json      # 四档隐藏测试
assets/reference/               # 可选：参考实现，用于发布前自检
```

`engine.json` 的完整字段见 `contracts/evaluation-engine-package.schema.json`。关键约束：

- 所有路径都是包内相对路径，禁止绝对路径、盘符、反斜杠和 `..`；
- 声明了却不存在的路径在**上传时**就会被拒绝，不会拖到第一份提交才暴露；
- `version` 与包内容哈希共同构成评测幂等键——换包等于换判据，历史成绩需要重跑。

### 调用约定

平台在沙箱内这样调用：

```text
python -I <entrypoint> --input <invocation.json> --output <result.json>
```

`invocation.json` 符合 `contracts/engine-invocation.schema.json`，包含只读的 `workspace`（已规范化的交付件目录）、`engine.assets`（解析成绝对路径的隐藏测试与提交契约）、`scratchDir`（唯一可写目录），以及必须原样带回结果的 `grading.runId / idempotencyKey / triggerType`。

引擎把符合 `contracts/evaluation-result.schema.json` 的结果写到 `outputPath` 即可。**引擎的输出是契约，不是可信分数**：平台会做 Schema 校验、重算 criteria→dimensions→total、覆盖员工身份，任何一项不符都会判定该次评测失败。

### 沙箱

进程级轻量隔离，不用容器：

- 独立子进程，工作目录固定在一次性 scratch 目录，交付件只读；
- 环境变量重建为最小集合，平台的数据文件路径、凭据一概不继承；
- 墙钟超时；POSIX 上另加地址空间、CPU 时间和文件大小 rlimit（Windows 开发机降级为仅超时）；
- `PYTHONHASHSEED=0`，避免字典序影响复现。

上限由 `engine.json` 的 `limits` 与平台上限取较小值，平台上限见 `ENGINE_MAX_WALL_SECONDS` / `ENGINE_MAX_MEMORY_MB` / `ENGINE_MAX_OUTPUT_BYTES`。

威胁模型是「跑飞的判题器」，不是「恶意的判题器」——引擎包由出题人上传并经管理员审核，学员代码才是不可信输入。

### 依赖

`runtime.requirements` 声明后，运行主机会为该包哈希创建一次性虚拟环境并安装，之后按哈希复用。离线环境用 `ENGINE_PIP_INDEX_URL` 指向内部源，或 `ENGINE_PIP_OFFLINE=true` 配合预置 wheel。不声明依赖时直接用平台解释器，不产生任何安装动作。

### 启动评测环境

```bash
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker eval-host-1
```

worker 轮询领取任务，按 `contracts/engine-invocation.schema.json` 组装输入，通过 `sandbox/launch.py` 执行引擎，再回传结果。加 `--once` 只跑一轮，便于排查。

### 出题流程

```bash
node scripts/build-engine-package.mjs parking-fee-v1
```

产出 `tmp/parking-fee-v1-engine.zip`，在管理后台「赛题库 → 新建赛题 → 评测引擎 → 上传评测引擎包」上传即可。平台返回 `packageHash` 并自动填入引擎标识与版本；保存赛题版本时该哈希被固化，发布后不可修改。

`challenges/parking-fee-v1/engine/` 是一个可直接参考的完整示例。


## 内置执行器（PLATFORM_LOCAL）

仓库 `executors/<id>/engine.json` 每个目录就是一个可选执行器。后台「赛题库 → 评测引擎 → 执行方式选『平台内置执行器』」会列出它们，并按清单里的 `params`（一份 JSON Schema）**动态渲染参数表单**——管理员不再手填路径。

平台在保存赛题版本时就校验：执行器必须存在、必填参数不能缺、路径参数必须是仓库内相对路径且真实存在。写错在编辑时就被拒绝，不会拖到第一份提交。

执行器目录的**内容哈希**参与评测幂等键，因此改动内置执行器等同于改判据，历史成绩需要重跑。

当前随平台发布的执行器：

| id | 说明 | 必填参数 |
|---|---|---|
| `drill-grader` | 内置通用判题器：提交契约校验 + 四档隐藏测试 + AST 代码度量 | `contractPath`、`entry`、`function` |

新增一个内置执行器 = 新建 `executors/<id>/` 目录，放 `engine.json` 和入口脚本，无需改平台代码。
