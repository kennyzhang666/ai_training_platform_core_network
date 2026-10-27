# 超市叠加优惠测试训战

本次交付是测试套件和测试记录。阅读 `SPEC.md`、`CLARIFICATIONS.md`、`CHANGE.md`，为 `pricing.quote` 编写测试，并维护遗留测试。随题实现可能有错误，不要求修改实现；请在报告中记录测试发现。

建议用时 120 分钟。可以使用 AI，但应保留自己的判断、期望值计算和复测记录。仅支持 Python 3.11+ 标准库 `unittest`。

## 本地运行

Windows PowerShell，在材料根目录运行：

```powershell
$env:PYTHONPATH = (Resolve-Path src).Path
python -m unittest discover -s tests -p test_quote.py -v
```

Linux：

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -p test_quote.py -v
```

只运行 `tests/test_quote.py`。遗留套件可复制、修改和整理。测试失败时，先核对规格和期望值，再判断是否属于实现错误。最终测试不必在随题实现上全部通过。

## 提交 ZIP

ZIP 根目录只放以下四个文件，不要包含材料外层目录、`src/`、遗留套件或缓存：

```text
tests/test_quote.py
DEFECTS.md
TEST_PLAN.md
AI_WORKLOG.md
```

- `tests/test_quote.py`：可以独立加载的 `unittest.TestCase` 测试，使用公开接口，不能读取被测文件或识别评测版本。可按规格实现自己的计算器辅助验证。
- `DEFECTS.md`：至少 200 字，包含表头“缺陷编号 | 条款 | 失败测试 | 期望 | 实际”的表格。自行编号 B1、B2 等，并写明条款与测试方法名。
- `TEST_PLAN.md`：至少 800 字，包含“等价类与边界、组合策略、规格空白、变更影响、不覆盖说明”五个二级标题。
- `AI_WORKLOG.md`：至少 800 字，包含“约束下达、AI 输出核验、失败判定、迭代记录”四个二级标题，记录提示词、核验依据、失败分析和迭代。

发现的问题由你自行编号，评测按条款与实际测试进行关联，不要求猜测出题方的内部编号。不得跳过测试、标记预期失败或吞掉断言异常。

## 评分

验证 40 分，规格理解与测试设计 25 分，测试代码质量 20 分，AI 协作记录 15 分。测试先在正确实现上确认有效，再衡量其发现错误的能力。文档按明确章节和记录要求检查，不按篇幅额外加分。
