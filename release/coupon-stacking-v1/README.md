# 超市叠加优惠测试训战

这道题让学员为现成程序写测试。核心在于从规格推导期望值、核验 AI 输出、区分测试错误与实现错误，并按需求变更维护遗留断言。评测使用 Python 标准库，不需要联网安装依赖。

## 使用材料

| 材料 | 用途 |
| --- | --- |
| 网页配置内容.md | 管理后台的题名、简介、完整 Markdown 题面、目标、约束、引擎与训战设置 |
| starter/ | 发给学员的规格、澄清、变更、现成代码、旧测试、空模板与样例 |
| submission-contract.json | 约束只提交测试文件和三份文档 |
| engine/ | 可直接上传的完整评测引擎源文件 |
| engine/assets/oracle/ | 作者参考交付件，上线前提交测试用，包含四个必交文件 |
| calibration/ | 不同质量的合成对照交付件，不发给学员、不进入引擎包 |
| tools/variant-patches.json | 版本化补丁定义 |
| tools/equivalence-review.md | 等价判断、设计冲突处理及校准说明 |

## 生成与验证

在仓库根目录执行：

```powershell
python -B challenges/coupon-stacking-v1/tools/make_variants.py
python -B challenges/coupon-stacking-v1/tools/make_variants.py --check
python -B challenges/coupon-stacking-v1/tools/make_calibration.py
python -B -m unittest discover -s challenges/coupon-stacking-v1/tests -p test_engine.py
node scripts/build-engine-package.mjs coupon-stacking-v1 --out tmp/coupon-stacking-v1-engine.zip
python tools/engine-dev-kit/tools/engine_dev.py validate tmp/coupon-stacking-v1-engine.zip
python tools/engine-dev-kit/tools/engine_dev.py run tmp/coupon-stacking-v1-engine.zip --workspace challenges/coupon-stacking-v1/engine/assets/oracle --output tmp/coupon-stacking-v1-result.json
pnpm --filter @ai-training/platform-api exec tsx --test test/coupon-stacking-v1-engine.test.ts
python -B challenges/coupon-stacking-v1/tools/build_delivery.py
```

最后一条在 `release/coupon-stacking-v1/` 生成管理员交付资料、学员材料 ZIP、引擎 ZIP、参考提交 ZIP、SHA-256 清单和评测配置参考。参考配置中的平台引擎包 ID 由上传后生成，不手工预造。

## 评测如何运行

平台固定学员提交后，Worker 下载引擎与交付件，调用公司 Code Agent。Agent 读取 instruction 与 Skills，并用指定 Python 执行 `run_batch.py --manifest <批次清单>`。程序逐份调用 `judge.py`，写出单人结果与批次索引。程序自己填写 schemaVersion、batchId、runId 和相对 `results/` 路径，避免手工索引字段或路径错误。

每份学员测试先在正确实现上用不同种子与执行顺序跑三次。只有三次全过的测试方法可以计分，再用旧版规则、三种规则误读、四个独立缺陷和 40 个变异版本衡量测试强度。一个方法内任何 subTest 失败都算整个方法失败。

16 个评分点统一使用 A/B/C/D 档位，总分分配为验证 40、规格与设计 25、代码质量 20、AI 协作 15。当前全部由规则计算，Code Agent 不自行改分。AI 协作部分核对的是提交记录的结构和引用，不能验证员工是否真实执行过这些行为。

## 校准基线

| 交付件 | 总分 | 核验重点 |
| --- | --- | --- |
| oracle | 100 | 16 项全部 A，发现四项缺陷，拦截全部 40 个变异版本 |
| ai-direct | 12.5 | 实现导向合成对照，无有效缺陷发现 |
| spec-guess | 12.5 | 三项澄清误读被识别 |
| snapshot | 12.5 | 200 组错误输出录制，验证维度为 0 |
| legacy-only | 19.75 | 两项过时断言、一项固化缺陷，变更回归为 D |
| happy-path | 18 | 边界与澄清验证不足 |
| assert-false | 11.25 | 验证维度为 0 |
| cheat | 10 | 验证维度为 0，报告指出不允许的模块信息访问 |
| flaky | 15.5 | 顺序依赖测试被识别，稳定性未达 A |

这些是固定合成校准结果，不是员工成绩或 AI 模型盲测结果。评分并非只有验证维度，验证为 0 的交付件仍可能保留代码格式方面的少量分数。

## 发布约束

赛题版本 1、引擎版本 1.0.0、评分规则 1.0。首次上传前核对包哈希；正式发布后不在原版本修改评分、补丁或隐藏材料。仅把 starter ZIP 发给员工，引擎 ZIP、参考提交和本目录作者说明仅供管理员使用。

当前验收覆盖本地 Python 子进程、独立 ZIP、平台结果校验与批次适配；公司真实 Code Agent 和内网目标机需要上线前再跑一次参考提交。没有新增平台依赖或数据库迁移。
