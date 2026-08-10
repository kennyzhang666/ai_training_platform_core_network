export const EVALUATION_ENGINE_GUIDE_MARKDOWN = String.raw`
# 评测引擎开发指南

> 版本：0.9.0
> 用途：供评测引擎开发者和其他 AI 阅读。仓库内 contracts/ 是最终事实来源；本文档不包含员工信息、凭据或运行日志。

## 1. 平台边界

评测引擎是受控、可复现的批处理程序。平台 API 只冻结赛题、rubric、提交快照和运行配置并创建批次；不可信的学员代码和 Code Agent 必须由独立 Worker 在沙箱或受控主机执行。

Worker 读取批次清单，准备只读输入，启动引擎，校验 JSON 结果，再按幂等键回写平台。服务端会重新校验提交归属、Schema、批次状态和评分结果。

- 不要在 NestJS/API 进程中执行学员代码、任意 Git 命令或 Code Agent。
- 上传包和 Git 交付件进入引擎前必须生成不可变快照，评测期间不得回读可变分支。
- 已发布 Schema、rubric 和引擎版本不可原地修改；修复必须新建版本。
- AUTO、MANUAL、IMPORT 是触发方式，不是三套评分逻辑；评分逻辑应复用同一引擎。

## 2. 引擎包目录

PACKAGED 引擎以 ZIP 交付，根目录建议如下。路径只能是包内相对路径，不允许盘符、绝对路径、.. 或符号链接逃逸。

~~~text
parking-fee-engine/
├─ engine.json
├─ instruction.md
├─ skills/evaluation/SKILL.md
├─ judge.py
├─ requirements.txt
└─ assets/
   ├─ tests/
   └─ reference/
~~~

engine.json 是元数据和限制的事实来源；instruction.md 说明 Agent 如何读取清单和写回结果；Skills 只放可审查、可版本化的评测知识。依赖应固定版本，生产优先使用内部镜像或离线包。

## 3. engine.json 最小配置

发布后的 id + version + packageHash 是不可变坐标。入口不能拼接用户输入或调用系统 Shell。

~~~json
{
  "schemaVersion": "1.1",
  "id": "parking-fee-engine",
  "version": "1.0.0",
  "runtime": {
    "type": "python",
    "entrypoint": "judge.py",
    "requirements": "requirements.txt"
  },
  "input": "contracts/evaluation-input.schema.json",
  "output": "contracts/evaluation-result.schema.json",
  "instruction": "instruction.md",
  "skills": ["skills/evaluation/SKILL.md"],
  "limits": {
    "wallClockSeconds": 600,
    "memoryMB": 2048,
    "outputBytes": 4194304
  }
}
~~~

平台内置执行器使用 PLATFORM_LOCAL；完整引擎包使用 PACKAGED；EXTERNAL_CLI 仅用于线下结果导入。新增字段前先升级 Schema 版本，并补齐 TypeScript、Python 和 API 契约测试。

## 4. 输入契约与批次清单

每个批次目录包含 batch-manifest.json，冻结赛题版本、rubric 版本、引擎、提交快照和每次运行的幂等键。引擎只读取清单指向的文件，不得根据客户端 URL 或未冻结工作区重新拉取内容。

评测输入契约是 contracts/evaluation-input.schema.json；交付件上传/Git 规则是 docs/submission-contract.md。前者回答“引擎如何消费快照”，后者回答“作品如何交付和冻结”。

~~~json
{
  "schemaVersion": "1.0",
  "event": {
    "id": "event-parking-fee",
    "challengeVersion": "parking-fee:v1",
    "rubricVersion": "parking-fee-rubric:v1",
    "trigger": "IMPORT"
  },
  "challenge": {
    "id": "parking-fee",
    "version": 1,
    "evaluationEngine": {
      "id": "parking-fee-engine",
      "version": "1.0.0",
      "mode": "PACKAGED"
    }
  },
  "submissions": [{
    "submissionId": "sub_001",
    "subject": { "id": "w00001", "name": "参赛员工", "orgPath": "企业业务/云计算" },
    "snapshot": { "sourceType": "UPLOAD", "snapshotHash": "sha256:...", "artifactPath": "snapshots/sub_001" },
    "grading": { "runId": "run_001", "idempotencyKey": "event:sub_001:sha256:...", "triggerType": "IMPORT" }
  }]
}
~~~

输入中的 subject 只用于归属和审计；日志不要输出不必要的真实姓名、工号。snapshotHash、rubricVersion 和引擎版本必须进入结果证据。

## 5. 启动 Code Agent

运行配置中的命令只能是“可执行文件 + 参数”，不会经过系统 Shell。Worker 替换占位符并注入批次清单和任务指令。

~~~text
codeagent --prompt "{{prompt}}"

占位符：
  {{prompt}}       任务指令
  {{manifestPath}} 批次清单路径
  {{batchDir}}     批次工作目录

Worker 示例：
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker worker-local
~~~

Code Agent 应读取 instruction.md、Skills、batch-manifest.json 和只读提交快照，并将结果写到 manifest.resultIndexPath。命令优先级是 Worker --agent-command > 新批次冻结的平台配置 > CODE_AGENT_COMMAND/CODE_AGENT_ARGS_JSON。可执行文件必须存在于 Worker 主机并通过白名单。超时必须受批次、Worker、引擎三层上限约束。

生产内网的独立 Worker 不应借用浏览器身份。启用 EVALUATION_WORKER_TRUSTED_GATEWAY_SECRET 后，Worker 会使用工号、姓名和部门生成受 HMAC 保护的身份头；该密钥只注入 Worker 和 Platform API，不写入批次清单、日志或前端。完整 LDAP3/TRUSTED_GATEWAY、Nginx 与双平台部署配置见根目录 DEPLOYMENT.html。

## 6. 输出契约、幂等与失败

单次结果必须符合 contracts/evaluation-result.schema.json。批次汇总使用 contracts/evaluation-agent-result-index.schema.json：每个 runId 只能出现在 results 或 failures 一处，失败必须有稳定 reason，不能用空分数伪装成功。

~~~json
{
  "schemaVersion": "1.0",
  "batchId": "batch_001",
  "results": [{
    "runId": "run_001",
    "idempotencyKey": "event:sub_001:sha256:...",
    "status": "SUCCEEDED",
    "score": 86,
    "rubricVersion": "parking-fee-rubric:v1",
    "criteria": [{ "key": "boundary", "score": 18, "maxScore": 20, "evidence": ["tests/boundary.json"] }]
  }],
  "failures": []
}
~~~

结果必须携带 runId、幂等键、引擎 id/version、rubricVersion 和证据引用。重复领取同一批次时返回已有结果，不重复扣分。结果落盘应先写临时文件再原子替换。平台会服务端重算汇总分和排名。

## 7. 评分实现规范

- 先采集测试用例、输入、输出、日志摘要和规则命中，再按 rubric 计算分数。
- 固定随机种子、时区、依赖版本和舍入规则，保证重复运行一致。
- 正常、边界、异常、资源限制和输出格式错误都要有测试。
- 分数之外输出可解释证据和失败原因，便于复核、重跑和生成 AI 能力画像。
- 不读取其他参赛者目录、隐藏答案、平台数据库或 Worker 凭据目录。
- AI 评审只能使用清单、题面允许上下文和公开规则；模型输出必须结构化解析并通过 Schema。

## 8. 安全、快照与日志

默认批次目录为 tmp/evaluation-batches，日志目录为 tmp/evaluation-logs/<workerId>。提交快照、引擎包、临时工作区和日志必须分开。

- 拒绝路径穿越、符号链接逃逸、超大压缩包和解压炸弹；限制包大小、文件数、解压体积和单次输出。
- 日志不得记录 token、Cookie、SSO 断言、完整源码或未脱敏敏感信息；保留必要的 worker.log、interaction.jsonl、agent.stdout.log、agent.stderr.log。
- Git 地址只能来自已发布训战配置；引擎不得接受客户端任意仓库 URL。
- API 进程不执行不可信代码；本地调试使用 scripts/code-agent-local-bridge.mjs 或独立 Worker。
- 评测目录属于 Worker 主机，不由浏览器上传；保留和清理由 Worker 配置负责。

## 9. 本地开发与验证

先补契约样例和测试，再实现逻辑；不要通过删除测试、放宽 Schema 或吞异常来“修复”失败。

~~~powershell
pnpm install
pnpm contract:test
pnpm grader:test
pnpm --filter @ai-training/platform-api test
pnpm --filter @ai-training/web lint
pnpm build

# 仅在受控开发环境打开 Code Agent 测试
$env:CODE_AGENT_RUNTIME_TEST_ENABLED = "true"
$env:CODE_AGENT_COMMAND = "codeagent"
node scripts/evaluation-worker.mjs --api http://127.0.0.1:3000/api/v1 --employee w00123 --worker worker-local
~~~

真实端到端测试准备已发布训战、测试员工和无敏感信息的样例提交。测试后检查 tmp/evaluation-batches/<batchId> 和 tmp/evaluation-logs/<workerId>，确认每个 runId 只有一份结果；不要使用生产账号、仓库或凭据。

## 10. 推荐实现顺序

1. 阅读 README.md、AGENTS.md、contracts/ 和 docs/evaluation-engine-protocol.md。
2. 新增或升级 engine.json、输入输出样例、rubric 映射和契约测试，发布版本号而不是修改旧 Schema。
3. 实现只读快照读取、测试执行、证据收集、结果索引和幂等写回。
4. 用本地 bridge 验证目录与契约，再用公司 Code Agent Worker 做一次端到端测试；日志不提交 Git。
5. 同步 OpenAPI 与 README.md；产品或部署行为变化时同步 DESIGN.md 或 DEPLOYMENT.html，并记录验证命令和剩余风险。

## 11. 可直接交给其他 AI 的提示词

把下面提示词连同本 Markdown 和仓库交给 AI。AI 必须以 contracts/ 为事实来源，不凭记忆发明字段。

~~~text
你是本项目的评测引擎开发者。请先阅读：
- AGENTS.md
- README.md
- docs/evaluation-engine-protocol.md
- docs/submission-contract.md
- contracts/evaluation-input.schema.json
- contracts/evaluation-result.schema.json
- contracts/evaluation-agent-result-index.schema.json

目标：实现一个可复现、可审计、只读取冻结提交快照的评测引擎。
要求：
1. engine.json 声明 id、版本、Python 入口、依赖、资源限制和契约路径；
2. 不执行任意 Shell，不访问公网，不读取其他参赛者和平台凭据；
3. 每次运行输出符合 Schema 的结果、证据、runId 和幂等键；
4. 失败写入 failures 并提供稳定 reason，不伪造分数；
5. 先补 fixture、契约测试和安全测试，再实现逻辑；
6. 最后报告改动文件、验证命令、结果和剩余风险。
~~~

## 12. 仓库文档索引

- contracts/：TypeScript、Python 和 API 共用的输入输出 Schema、样例和契约测试。
- docs/evaluation-engine-protocol.md：评测引擎与 Worker 的批次、执行和结果协议。
- docs/submission-contract.md：上传包和 Git 交付件的冻结、路径和安全规则。
- scripts/evaluation-worker.mjs：独立 Worker 的领取、执行、日志和结果写回流程。
- scripts/code-agent-local-bridge.mjs：本地目录/契约桥接器，不代表真实模型评测。
- grader/：Python grader 运行时及 requirements.txt；API 不直接执行其中的不可信代码。

## 变更前检查清单

- [ ] 新增/修改 Schema 已升级版本，并补齐 TS/Python/API 测试。
- [ ] 引擎包路径没有绝对路径、..、符号链接或未固定依赖。
- [ ] 结果包含 runId、幂等键、rubricVersion、证据和明确状态。
- [ ] 失败、超时、取消都有可审计 reason，日志已脱敏。
- [ ] 已执行 pnpm contract:test、pnpm grader:test 和受影响模块测试。
- [ ] 已更新 README.md；产品或部署行为变化时已同步 DESIGN.md 或 DEPLOYMENT.html，并记录剩余风险。
`;
