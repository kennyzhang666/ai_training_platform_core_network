# Code Agent 批次评测协议

每个赛题版本独立绑定评测引擎、评测指令和 skills。训战只决定开放时间、参训范围、提交方式、触发方式和结果公布策略，不携带评分逻辑。

平台负责：锁定交付快照、冻结精确选择范围、分配租约、校验回传结果、重算总分、覆盖员工身份并写入报告。评测主机负责：物化文件、调用 Code Agent、逐份运行评测引擎并回传结果。API 请求进程不执行学员代码或评测引擎。

## 评测方式

| 引擎模式 | 引擎来源 | 可用触发方式 | 赛题版本必填配置 |
|---|---|---|---|
| `PLATFORM_LOCAL` | 仓库 `executors/<id>/` | 自动评测、管理员发起评测 | `executor`、`agent` |
| `PACKAGED` | 出题人上传的不可变 ZIP | 自动评测、管理员发起评测 | `package`、`agent` |
| `EXTERNAL_CLI` | 管理员在线下自行运行 | 线下结果录入 | 输入、输出约束 |

GitLab CI 自动评测不在当前实现范围内。后续适配器复用同一批次、快照和结果契约，不改变赛题配置模型。

## 契约如何配置

赛题编辑页不再要求管理员手工填写一组含义相近的“输入路径”和“输出路径”。管理端把它们显示为“输入约束”和“输出约束”，平台把契约分成三层：

| 契约 | 配置位置 | 作用 | 在线评测路径 |
|---|---|---|---|
| 交付目录规范 | 赛题版本 → 交付目录规范 | 约束学员 ZIP / Git 快照必须有哪些文件和目录 | 随赛题版本保存，不是 Code Agent 的输入 Schema |
| Code Agent 批次输入 | 平台固定 | 描述批次、引擎、指令、Skills、所选提交和各自输出位置 | `contracts/evaluation-agent-batch-v1.1.schema.json` |
| 平台评测结果 | 平台固定 | 约束每名学员回传的总分、维度、评分点和证据链 | `contracts/evaluation-result.schema.json` |

不同赛题的评分项、证据和客观指标可以不同，但都放在统一的评测结果外层结构中。需要改变评分逻辑时，修改赛题版本绑定的评测引擎、指令、Skills 和评分标准，不新增一份平台无法识别的结果格式。

上述两个平台协议路径是仓库内的版本标识，在赛题页只读展示。Worker 领取批次后会把实际 Schema 复制到：

```text
<batch>/contracts/batch-input.schema.json
<batch>/contracts/evaluation-result.schema.json
```

并在 `batch-manifest.json` 的 `contracts.input` / `contracts.output` 中写入源路径、批次内绝对路径和 SHA-256。Code Agent 应读取清单中的物化路径，不应自行推测平台仓库位置。

`instruction.md` 和 Skills 路径使用评测引擎根目录作为基准：内置执行器对应 `executors/<executorId>/`，引擎包对应上传 ZIP 的根目录。每个 Skills 目录必须包含 `SKILL.md`。线下结果录入继续使用 `contracts/evaluation-input.schema.json` 生成清单，输出仍使用统一结果契约。

赛题版本编辑器不接受管理员手填契约路径，而是读取 Git 中的 `contracts/evaluation-contract-catalog.json` 生成输入/输出约束下拉选项。点击“查看详情”可检查固定 Schema、示例和编写说明；点击“复制给 AI 出题”可把这些内容连同约束规则复制到剪贴板。公开选项只包含与当前评测方式匹配的约束；`engine-invocation.schema.json` 等 Worker 内部调用约束仍由平台物化和校验，不作为赛题公开配置。开发赛题时可先阅读目录中的 Schema、`examplePath` 示例和 `docs/evaluation-contract-authoring.md`，再让 AI 生成配置草稿，最终仍由服务端白名单和 Schema 校验决定是否可保存。

## 平台发起评测

1. 管理员进入「评测中心」，打开某个训战的赛题评测页。
2. 管理员勾选一名或多名学员的待处理提交。
3. `POST /api/v1/events/{eventId}/start-grading` 只接收所选 `submissionIds`。
4. 平台为每份提交创建不可变 `GradingRun`，再将这些运行冻结成一个 `EvaluationBatch`。
5. 一个批次只允许包含同一训战、同一赛题版本和同一评测引擎的提交；未勾选的提交不会被扩入批次。
6. 自动评测也走相同流程，只是每次提交后由平台自动创建批次。

批次状态为 `QUEUED → RUNNING → COMPLETED | PARTIAL | FAILED`。运行状态为 `QUEUED → RUNNING → GRADED | FAILED`。租约超时后，尚未完成的整个批次一起回到队列，不能被单份任务接口拆开。

## Worker 拉取与物化

评测主机运行 `scripts/evaluation-worker.mjs`，通过以下接口工作：

```text
POST /api/v1/evaluation-batches:lease
POST /api/v1/evaluation-batches/{batchId}/heartbeat
POST /api/v1/evaluation-batches/{batchId}/complete
POST /api/v1/evaluation-batches/{batchId}/fail
```

Worker 对每个批次创建独立目录，并验证所有不可变内容的 SHA-256：

```text
<batch>/
├─ batch-manifest.json
├─ contracts/
│  ├─ batch-input.schema.json
│  └─ evaluation-result.schema.json
├─ engine/
│  ├─ engine.json
│  ├─ instruction.md
│  ├─ skills/<skill>/SKILL.md
│  ├─ <judge entrypoint>
│  └─ _platform/                 # 内置引擎声明的冻结运行依赖
├─ challenge-assets/             # 内置通用引擎的本题契约、隐藏测试等
├─ submissions/
│  └─ <submissionId>/
│     ├─ delivery.zip            # 上传型提交保留原始归档
│     ├─ workspace/              # 解包后的不可变交付快照
│     └─ scratch/                # 单份提交独立可写目录
└─ results/
   ├─ <runId>.json
   └─ index.json
```

上传交付件会同时校验归档字节哈希和规范化目录树哈希。内置引擎的仓库依赖也参与引擎内容哈希，并随引擎复制到批次目录；依赖变化会导致哈希变化，避免评测主机使用未冻结代码。

## Code Agent 启动配置

全局管理员在「管理后台 → 评测环境」配置 Code Agent；部门管理员无权查看或修改。可直接使用一条带引号参数的单行命令，例如：

```text
opencode -m deepseek/deepseek-v4-pro --prompt "请根据约束使用skills和cli评测submission并返回结果"
```

Worker 会解析为可执行文件和参数，并以 `spawn(..., { shell: false })` 启动。上述写法可以直接使用：Worker 会在原 `--prompt` 内容后追加不可省略的批次清单、指令、Skills、提交范围、结果路径和结果契约要求。更推荐把可变任务指令放在单独的「任务指令」字段，并使用占位符：

```text
opencode -m deepseek/deepseek-v4-pro --prompt "{{prompt}}"
```

可用占位符只有：

| 占位符 | Worker 替换内容 |
|---|---|
| `{{prompt}}` | 管理员任务指令 + 平台强制评测协议 |
| `{{manifestPath}}` | `batch-manifest.json` 的绝对路径 |
| `{{batchDir}}` | 本批次工作目录的绝对路径 |

如果命令没有 Prompt 参数和占位符，Worker 将它视为 bridge，并追加 `--manifest <absolute-path>`。无论哪种方式，Worker 都会设置 `AI_TRAINING_BATCH_MANIFEST`。

平台运行配置包含启用状态、启动命令、任务指令和批次超时，并记录修改人、修改时间与配置校验值。创建评测批次时会冻结当时启用的配置；之后修改只影响新批次，不会改变已经排队或运行中的批次。命令来源优先级为：

```text
Worker --agent-command 显式覆盖
  > 批次冻结的平台配置
  > Worker 主机 CODE_AGENT_COMMAND / CODE_AGENT_ARGS_JSON 兜底
```

批次超时的覆盖顺序为 `--agent-timeout-seconds`、`CODE_AGENT_BATCH_TIMEOUT_SECONDS`、批次冻结值、引擎时限自动计算值。

命令不会经过系统 Shell，因此管道、重定向、命令拼接和环境变量赋值不会被解释。模型令牌等凭据只能由 Worker 运行环境注入。生产主机可设置 `CODE_AGENT_ALLOWED_EXECUTABLES=opencode,...`，限制平台配置允许启动的程序。

## 管理端配置诊断与连通性测试

全局管理员可以在“管理后台 → 评测环境”查看三组信息：

- **默认配置**：平台内置为关闭平台配置、OpenCode 默认启动命令 `opencode --prompt "{{prompt}}"`、默认任务指令“请读取批次清单、instruction.md 和 Skills，逐份评测 submissions，并将符合结果契约的结果写入 manifest.resultIndexPath。”和 3600 秒超时；“恢复 OpenCode 默认”只会把表单恢复为这组值，点击保存后才会写入平台。默认模板不会自动启用，需先确认 Worker 已安装并允许启动 `opencode`。
- **平台配置**：启用后由 API 在创建评测批次时解析并冻结 `executable` 与 `args`；页面显示当前可执行文件、配置校验值和允许列表。
- **Worker 本地配置**：读取 API 进程可见的 `CODE_AGENT_COMMAND`、`CODE_AGENT_ARGS_JSON`、`EMBEDDED_EVALUATION_WORKER` 和 `EVALUATION_WORKER_ID`。Worker 启动参数 `--agent-command` 只存在于 Worker 进程，API 无法读取，因此诊断会明确标注为“命令行覆盖（API 不可见）”，不能把它误认为未配置。

当 Worker 与 API 部署在不同主机或容器时，API 只能展示它实际收到的进程级诊断；Worker 主机上的环境变量和命令行不会自动同步到管理页。此时应在 Worker 主机按“本地联调”示例配置，并以 Worker 启动输出和批次租约状态为准。

页面的“测试启动命令”使用管理员当前表单内容创建合成清单，并只在非生产环境且显式设置 `CODE_AGENT_RUNTIME_TEST_ENABLED=true` 时以 `shell: false` 启动一次。测试不会带入学员交付件，也不会创建评测批次；输出仅保留截断后的标准输出/错误并遮蔽常见凭据字段。未打开安全开关时接口仍返回 `BLOCKED` 及原因，便于区分“配置错误”和“执行权限未开放”。

## Worker 日志与 Agent 交互记录

Worker 默认将运行日志写入项目下的 `tmp/evaluation-logs/<workerId>/`，也可以通过 `EVALUATION_LOG_ROOT` 或 `--log-root` 指定独立目录。日志目录不会随评测批次清理，便于追查领取、续租、Agent 启动、退出和批次完成状态：

```text
tmp/evaluation-logs/
└─ <workerId>/
   ├─ worker.log                         # Worker 生命周期和批次状态（JSON Lines）
   └─ batches/<batchId>/<leaseId>/
      ├─ interaction.jsonl               # Agent 启动参数（脱敏）、阶段事件、输出预览、退出信息
      ├─ agent.stdout.log                 # Agent 标准输出（脱敏、默认最多 4 MiB）
      └─ agent.stderr.log                 # Agent 标准错误（脱敏、默认最多 4 MiB）
```

`EVALUATION_AGENT_OUTPUT_MAX_BYTES` 可调整单个 stdout/stderr 文件上限（16 KiB–64 MiB），`EVALUATION_WORKER_LOG_MAX_BYTES` 控制 `worker.log` 上限（256 KiB–256 MiB，默认 16 MiB，达到上限后滚动保留最新记录）。日志会遮蔽常见 token、密钥、密码、Cookie 和 Authorization 字段，并在超过上限时写入截断标记；不要把学员源码或长期凭据主动写进任务指令。日志仅落在 Worker 主机，不会通过 API 返回给浏览器。

## Code Agent 批次职责

Worker 不直接判断得分。Code Agent 或 bridge 必须：

1. 读取 `manifest.agent.instructionPath`；
2. 加载 `manifest.agent.skillPaths` 中每个目录的 `SKILL.md`；
3. 只处理 `manifest.submissions` 列出的提交；
4. 为每份提交使用独立 `workspace`、`scratchDir` 和 `outputPath`；
5. 逐份运行该赛题冻结的评测引擎；
6. 将批次结果索引写入 `manifest.resultIndexPath`。

批次清单和结果索引分别符合：

- `contracts/evaluation-agent-batch-v1.1.schema.json`
- `contracts/evaluation-agent-result-index.schema.json`

结果索引示例：

```json
{
  "schemaVersion": "1.0",
  "batchId": "batch-...",
  "results": [
    { "runId": "run-...", "resultPath": "results/run-....json" }
  ],
  "failures": [
    { "runId": "run-...", "reason": "交付件无法完成验收测试" }
  ]
}
```

平台逐份校验 `evaluation-result.schema.json`，重新计算 `criteria → dimensions → total`，并以提交记录中的员工和部门快照覆盖结果身份。缺失结果、重复 `runId`、批次外 `runId`、快照不匹配和分数不一致都会被拒绝或标记失败。

完成回调以批次租约为凭据；同一租约重复提交会返回已冻结结果，不会重复写入。重新评测会创建新的运行和新的幂等键，历史结果保留。

## 赛题版本配置

```json
{
  "id": "parking-fee-evaluator",
  "version": "1.0.0",
  "mode": "PLATFORM_LOCAL",
  "executor": {
    "id": "drill-grader",
    "params": {
      "contractPath": "challenges/parking-fee-v1/submission-contract.json",
      "testsDir": "challenges/parking-fee-v1/hidden-tests",
      "entry": "src/parking.py",
      "function": "calculate_fee",
      "language": "python",
      "zone": "yellow"
    }
  },
  "agent": {
    "instructionPath": "instruction.md",
    "skillPaths": ["skills/evaluation"]
  },
  "input": {
    "format": "JSON",
    "schemaVersion": "1.1",
    "contractPath": "contracts/evaluation-agent-batch-v1.1.schema.json"
  },
  "output": {
    "format": "JSON",
    "schemaVersion": "1.0",
    "contractPath": "contracts/evaluation-result.schema.json"
  }
}
```

保存赛题版本时，平台立即校验执行器、参数、引擎包、`instruction.md` 和全部 skills 是否存在。在线评测的输入、输出路径由平台规范化为上面的固定协议；已发布版本不可原地修改，评分逻辑变化必须创建新版本并提升引擎版本。

## 引擎包结构

上传引擎包必须自包含，不能引用平台仓库目录。推荐使用 1.1 清单：

```text
engine.json
instruction.md
skills/evaluation/SKILL.md
judge.py
requirements.txt                 # 可选
assets/submission-contract.json
assets/hidden-tests/
assets/reference/                # 可选，自检用
```

`engine.json` 见 `contracts/evaluation-engine-package.schema.json`。1.1 清单必须声明 `agent.instruction` 与 `agent.skills`；管理员也可以在赛题版本中覆盖这些相对路径。`agent.instruction` 指向文件，`agent.skills` 中每一项指向一个包含 `SKILL.md` 的目录。平台兼容旧包中直接指向 `SKILL.md` 的写法，并在生成批次时统一为目录路径。

`runtime.requirements` 可指向包内的 Python requirements 文件。Worker 按引擎包哈希创建并缓存隔离环境，通过 `AI_TRAINING_ENGINE_PYTHON` 把解释器交给 Code Agent；Code Agent 不应改用系统 Python。内网离线部署可设置 `ENGINE_PIP_OFFLINE=true`，并使用 `ENGINE_PIP_FIND_LINKS` 或 `ENGINE_PIP_FIND_LINKS_JSON` 指定预下载的 wheel 目录。引擎升级依赖时必须发布新版本和新包，不能修改已上传包。

## 线下结果录入

`EXTERNAL_CLI` 仍保留管理员线下评测流程：使用 `POST /api/v1/events/{eventId}/grading-input` 为精确选择的提交生成输入清单，评测后通过 `POST /api/v1/grading-results:import-batch` 批量录入。线下结果与线上批次结果经过同一份 Schema、快照、身份和总分校验。

## 本地联调

`scripts/code-agent-local-bridge.mjs` 是本地协议适配器，只用于验证端到端 ABI。它读取 instruction 和 skills，再逐份调用确定性评测引擎。本地可以在全局管理员的「评测环境」中配置启动命令；以下环境变量方式保留为 Worker 主机兜底。

```powershell
$env:EMBEDDED_EVALUATION_WORKER='false'
$env:CODE_AGENT_COMMAND=(Get-Command node).Source
$bridge=(Resolve-Path .\scripts\code-agent-local-bridge.mjs).Path
$env:CODE_AGENT_ARGS_JSON=(ConvertTo-Json @($bridge) -Compress)
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker local-eval-host
```

加 `--once` 只领取一轮。加 `--keep-batches` 保留物化目录以便排查；正式环境不应默认保留学员交付件。
