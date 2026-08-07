# 运维日志脱敏（SDD）· 交付压缩包

本目录存放 `log-desensitize-01@1` 的两个可分发压缩包。源文件在 [`challenges/log-desensitize-v1/`](../../challenges/log-desensitize-v1/)，压缩包由脚本生成，不要手工编辑。

```bash
node scripts/build-challenge-packages.mjs log-desensitize-v1
```

两个包都是**可重复构建**的：同一份输入恒定产出同一份字节（固定 DOS 纪元时间戳、固定 `0644` 权限位、按路径排序的条目顺序、文本条目统一 LF）。因此 `pnpm build` 或重新执行该脚本不会无谓地弄脏工作区；如果 ZIP 显示为已修改，说明输入确实变了。

## 1. `log-desensitize-v1-challenge.zip` — 题目文档包

发给学员，或作为出题资产归档。**不含隐藏测试和参考实现**，构建脚本会强制拒绝把答案打进这个包。

| 条目 | 说明 |
|---|---|
| `README.md` | 赛题说明：业务背景、七类脱敏规则、可追溯标记、不变量、8 条答疑、SDD 交付要求、评分构成 |
| `change-package.md` | 变更包，完成第一轮后再打开 |
| `challenge.yaml` | 赛题元数据：交付策略、评测引擎绑定、契约版本 |
| `submission-contract.json` | 交付目录规范（v1.1），平台在接收 ZIP/Git 快照时校验 |
| `starter/SPEC.md` | 规格骨架，七个必备章节 |
| `starter/transcript.md` | 协作记录骨架，固定轮次格式 |
| `starter/src/desensitize.py` | 入口桩，仅有签名和文档字符串 |

## 2. `log-desensitize-v1-engine.zip` — 评测引擎包

可直接在「管理后台 → 赛题版本 → 评测引擎」上传。自包含，不引用平台仓库目录。

| 条目 | 说明 |
|---|---|
| `engine.json` | 1.1 引擎清单，声明入口、限额、资产和 Agent 指令/Skills |
| `judge.py` | 判据全在这里。平台以 `python -I judge.py --input <in> --output <out>` 调用 |
| `instruction.md` | 给 Code Agent 的评测指令 |
| `skills/evaluation/SKILL.md` | 批次评测技能 |
| `assets/submission-contract.json` | 与赛题同版本的交付规范，随判据冻结 |
| `assets/hidden-tests/*.json` | 四档隐藏测试，共 56 条 |
| `assets/reference/` | 参考交付件，用于发布前自检 |

## 3. 这道题考核什么

考核对象是**规格驱动开发**，不是正则技巧。100 分中只有 20 分给代码：

| 维度 | 分值 | 依据 | 是否需要模型 |
|---|---|---|---|
| Verify | 40 | 四档隐藏测试通过率（basic 12 / boundary 18 / clarification 16 / change 10 条） | 否 |
| Spec | 25 | `SPEC.md` 的章节结构、8 个题设歧义点的覆盖、可执行验收用例条数、变更影响分析 | 否 |
| Code | 20 | `src/desensitize.py` 的 AST 度量：具名常量、异常处理、类型标注、圈复杂度 | 否 |
| Collab | 15 | `transcript.md` 的轮次格式、**阶段顺序**、提示词要素、变更回归记录 | 否 |

全部 16 个评分点都由确定性规则给出，**模型不参与打分**，同一份交付件在任何机器上必然同分。

其中 Collab 的 `P1` 会检查「首个 `IMPLEMENT` 轮是否晚于首个 `SPEC` 轮」——先让 AI 写代码再补规格，这一项直接判 D。这是本题区别于普通编码题的核心。

## 4. 引擎自检结果

发布前用四份交付件验证判据的区分度：

| 交付件 | status | total | verify | spec | code | collab |
|---|---|---|---|---|---|---|
| 参考实现（完整 SDD 流程） | COMPLETE | **100.0** | 40.0 | 25.0 | 20.0 | 15.0 |
| 未填写的 starter 骨架 | COMPLETE | **1.5** | 0.0 | 1.5 | 0.0 | 0.0 |
| 只交正确代码，无 SPEC/transcript | PARTIAL | **60.0** | 40.0 | 0.0 | 20.0 | 0.0 |
| 规格记录齐全但实现早于规格 | COMPLETE | **96.0** | 40.0 | 25.0 | 20.0 | 11.0 |

第二行是关键：未实现的骨架天然「没有魔法数字、复杂度低、类型标注齐全」，如果不做桩函数判定，它会拿到接近满分的 Code 分。引擎显式识别「函数体只有文档字符串或 `raise NotImplementedError`」并判 D。

## 5. 本地验证

```bash
# 校验引擎包（目录或 ZIP 均可）
python tools/engine-dev-kit/tools/engine_dev.py validate challenge-packages/log-desensitize-v1/log-desensitize-v1-engine.zip

# 用参考交付件跑一次完整评测
python tools/engine-dev-kit/tools/engine_dev.py run \
  challenge-packages/log-desensitize-v1/log-desensitize-v1-engine.zip \
  --workspace challenges/log-desensitize-v1/reference
```

`engine_dev.py run` 的合成清单不提供 `engine.assets`，因此隐藏测试目录不可见、Verify 维度会标记为未评测，总分显示 60 而不是 100。这是**预期行为**：没有测试证据时引擎不会凭空给分，也不会因此倒扣 Code 分。要复现完整的 100 分，需要平台 Worker 提供带 `assets` 的真实批次清单。
