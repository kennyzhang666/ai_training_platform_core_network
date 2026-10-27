# 超市叠加优惠测试训战（coupon-stacking-v1）设计与实现任务书

本文件是交给实现方（Codex）的设计与任务书。实现前先阅读根目录 `AGENTS.md`、`README.md`，以及：

- `challenges/sdd-log-redaction-v2/`：现有 PACKAGED 引擎的完整范本（`engine.json`、`judge.py`、`instruction.md`、`skills/evaluation/SKILL.md`、`challenge.yaml`、`submission-contract.json`）
- `docs/evaluation-engine-protocol.md`、`docs/submission-contract.md`、`docs/evaluation-contract-authoring.md`
- `services/platform-api/test/sdd-log-redaction-v2-engine.test.ts`：引擎回归测试范本

本文中"必须"是验收硬性要求；"建议"可由实现方取舍，但要在任务报告中说明。

---

## 1. 训战定位

### 1.1 题型

**反向题**：发给学员一份现成的计价实现，学员不写实现，而是为它写测试。

### 1.2 训练目标

用 AI 辅助写测试时，AI 的默认行为是"读实现，然后按当前行为写断言"。本题训练学员纠正这种行为：

1. **期望值只能来自规格**，不能来自实现。
2. 测试失败时，判断是**测试写错了，还是实现错了**。
3. 需求变更后，**维护已有测试**，而不是只追加新测试。

### 1.3 核心机制：被测实现埋有缺陷

如果发下去的实现是正确的，学员把实现输出录成期望值就能杀死所有变异体，题目失去意义。因此：

- 发给学员的 `src/pricing.py` = 正确实现 + 4 个未公开缺陷（B1–B4）。
- 评测方持有正确的参考实现。学员测试**必须在参考实现上通过才算有效**。
- 照抄实现写出的断言会固化缺陷，在参考实现上失败，判为无效、不计分。
- 从规格推导的断言在参考实现上通过、在缺陷变体上失败，等于发现了真缺陷。

---

## 2. 平台约束（实现时必须遵守）

| 约束 | 要求 |
|---|---|
| 引擎形态 | PACKAGED 引擎。`engine.json` 的 `runtime.type` 只能是 `python`，平台以 `python -I <entrypoint> --input <in.json> --output <out.json>` 调用 |
| 不能复用 drill-grader | drill-grader 是"调用学员函数比对返回值"，无法运行学员写的测试 |
| 依赖 | 仅 Python 标准库。评测主机在内网，不得依赖 pip 安装 |
| Python 版本 | ≥ 3.11（发布包内置 3.11.15；子进程要用 `-P`，见 5.3） |
| 学员测试框架 | 首版只支持标准库 `unittest` |
| 结果契约 | 必须通过 `contracts/evaluation-result.schema.json`；顶层必填字段与 `sdd-log-redaction-v2/engine/judge.py` 的输出一致，字段取值方式照抄该文件 |
| 维度满分 | verify 40、spec 25、code 20、collab 15，合计 100 |
| 评分点结构 | 复用 sdd-v2 的 `_criterion` / `_level`：每个评分点由若干检查项组成，`通过数 / 总数` 映射档位（1.0→A、≥0.75→B、≥0.5→C、其余 D），分数 = 满分 × `LEVEL_RATIO[档位]`（A 1.0、B 0.75、C 0.5、D 0） |
| 自检 | `engine.json` 配置 `selfCheck.expectMinTotal: 100`，用作者测试集验证 |
| 确定性 | 16 个评分点全部由 `judge.py` 确定性计算；Code Agent 按 `instruction.md` 编排运行，不自行改分 |
| 数据 | 只用合成数据，不得出现真实员工、客户或生产数据 |
| 不可变 | 引擎一旦发布，变体、变异体、检查项都不得原地修改，变更必须升引擎版本 |

---

## 3. 被测领域规格（最终版，参考实现的唯一依据）

本节是参考实现 `reference.py` 的完整规格。学员拿到的 `SPEC.md` 在 3.3 所列三处故意写得含糊，结论放在 `CLARIFICATIONS.md`。

### 3.1 数据模型与接口

模块名必须是 `pricing`，公开 API 必须完全如下：

```python
from dataclasses import dataclass, field
from datetime import datetime

class PricingError(ValueError):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code

@dataclass(frozen=True)
class Item:
    sku: str
    category: str
    unit_price: int                 # 单价，分
    quantity: int
    member_price: int | None = None # 会员价，分；None 表示无会员价

@dataclass(frozen=True)
class Coupon:
    code: str
    kind: str                       # "THRESHOLD"（满减）或 "PERCENT"（折扣）
    starts_at: datetime
    ends_at: datetime
    threshold: int = 0              # 满减门槛，分（THRESHOLD）
    amount: int = 0                 # 满减额，分（THRESHOLD）
    percent: int = 100              # 整数百分比，90 表示九折（PERCENT）
    cap: int | None = None          # 折扣封顶优惠额，分（PERCENT）
    excluded_categories: frozenset[str] = field(default_factory=frozenset)  # PERCENT

@dataclass(frozen=True)
class Quote:
    subtotal: int        # 原价小计
    member_saving: int   # 会员价优惠额
    discount: int        # 折扣优惠额
    threshold_off: int   # 满减实际抵扣额
    payable: int         # 应付
    applied: tuple[str, ...]  # 实际生效的券号，按应用顺序

def quote(cart: list[Item], coupons: list[Coupon], now: datetime, member: bool = False) -> Quote: ...
```

### 3.2 条款

**R1 输入校验**

- 所有金额和数量必须是 `int` 且不是 `bool`。
- `Item`：`sku` 非空；`unit_price ≥ 0`；`quantity ≥ 1`；`member_price` 为 `None` 或 `0 ≤ member_price ≤ unit_price`。违反时抛 `PricingError("INVALID_ITEM")`。
- `Coupon`：`code` 非空；同一次调用中券号不得重复；`kind` 只能是 `THRESHOLD` 或 `PERCENT`；`starts_at < ends_at`；`THRESHOLD` 要求 `threshold ≥ 0` 且 `amount ≥ 1`；`PERCENT` 要求 `1 ≤ percent ≤ 100`，`cap` 为 `None` 或 `≥ 0`。违反时抛 `PricingError("INVALID_COUPON")`。
- 所有券都要校验，无论是否在有效期内。
- `now`、`starts_at`、`ends_at` 必须带时区（`tzinfo` 不为空且 `utcoffset()` 不为空），否则抛 `PricingError("NAIVE_DATETIME")`。
- 校验顺序：先 `now`，再按列表顺序校验商品，再按列表顺序校验券；抛出遇到的第一个错误。
- 空购物车合法。

**R2 行金额、小计与会员价**

- 行原价 = `unit_price × quantity`；`subtotal` = 所有行原价之和。
- 会员价行：`member=True` 且 `member_price` 不为 `None` 的行。
- `member_saving` = 所有会员价行的 `(unit_price − member_price) × quantity` 之和；`member=False` 时为 0。

**R3 券的有效期**

- 券在 `now` 时刻有效，当且仅当 `starts_at ≤ now < ends_at`（半开区间）。
- 无效券被忽略，不报错，不出现在 `applied` 中。

**R4 用券数量**

- 每单至多使用一张 `PERCENT` 券和一张 `THRESHOLD` 券。

**R5 单张折扣券的优惠额**

- 折扣基数 `base` = 所有"非会员价行、且品类不在该券 `excluded_categories` 中"的行原价之和。品类按字符串精确匹配，区分大小写。
- 折后额 = `base × percent ÷ 100`，四舍五入到分（小数部分 ≥ 0.5 进位）。整数实现：`(base * percent + 50) // 100`。
- 舍入对折扣基数**整体做一次**（见 G2）。
- `discount = base − 折后额`；若 `cap` 不为 `None` 且 `discount > cap`，则 `discount = cap`。

**R6 折扣券的选择**

- 候选：所有有效、且按 R5 计算 `discount > 0` 的 `PERCENT` 券。
- 依次比较：`ends_at` 最早者优先；相同则 `discount` 大者优先；再相同则券号按 Python 字符串比较取最小者。
- 没有候选时不使用折扣券，`discount = 0`。

**R7 应用顺序与满减**

- 先折扣，后满减。
- 满减判断金额 `J = subtotal − member_saving − discount`（见 G1）。
- 候选：所有有效、且 `J ≥ threshold` 的 `THRESHOLD` 券。取 `amount` 最大者；相同则券号按 Python 字符串比较取最小者。
- `threshold_off = min(amount, J)`（见 G3）。
- 若 `threshold_off = 0`，视为未使用满减券（不出现在 `applied` 中）。

**R8 结果**

- `payable = subtotal − member_saving − discount − threshold_off`，恒 ≥ 0。
- `applied` = 所选折扣券券号（若有）在前，所选满减券券号（若有）在后。

### 3.3 规格空白与澄清结论

学员拿到的 `SPEC.md` 在这三处写得含糊；`CLARIFICATIONS.md` 给出结论。

| 编号 | `SPEC.md` 中的写法 | `CLARIFICATIONS.md` 的结论 | 评测用的"错误解释变体" |
|---|---|---|---|
| G1 | "订单金额达到门槛时可使用满减券" | 判断金额是 `J = subtotal − member_saving − discount`，即会员价和折扣之后的金额 | 用 `subtotal` 判断是否达到门槛（抵扣额仍按 R7） |
| G2 | "折扣后金额四舍五入到分" | 对折扣基数整体计算一次再舍入，不逐行舍入 | 逐行计算折后额并分别舍入，再求和 |
| G3 | "应付金额最低为 0" | `threshold_off` 记录实际抵扣额 `min(amount, J)`，不是券面额 | `threshold_off = amount`，`payable = max(0, …)` |

### 3.4 变更记录（`CHANGE.md`）

当前规格是 v2。相对 v1 的变化：

| 编号 | 类型 | 内容 |
|---|---|---|
| CH1 | 修改 | 多张折扣券的选择规则。v1 为"`discount` 最大优先，相同取券号最小"；v2 改为 R6（`ends_at` 最早优先） |
| CH2 | 新增 | 会员价：`member` 参数、`Item.member_price`、`Quote.member_saving`；会员价行不参与折扣，但以会员价计入满减判断金额 |

### 3.5 计算示例（参考实现必须逐字段一致）

公共设定：`TZ = timezone(timedelta(hours=8))`，`now = datetime(2026, 11, 15, 10, 0, tzinfo=TZ)`；未特别说明时，券的有效期为 `[2026-11-01 00:00, 2026-12-01 00:00)`（+08:00）。

| # | 输入 | 期望结果 | 用途 |
|---|---|---|---|
| E1 | 商品 `A001 dairy 1200×2`、`B001 bakery 800×1`；券 `P1 PERCENT 90`、`T1 THRESHOLD 2500/300` | `subtotal 3200, member_saving 0, discount 320, threshold_off 300, payable 2580, applied ("P1","T1")` | 主流程 |
| E2 | 商品 `S001 snack 25×1`、`T001 tobacco 1000×1`；券 `P2 PERCENT 90, excluded {"tobacco"}` | `subtotal 1025, discount 2, threshold_off 0, payable 1023, applied ("P2",)` | 四舍五入（22.5→23）、排除品类 |
| E3 | `member=True`；商品 `D001 dairy 3000×1 member_price 2500`、`B002 bakery 2000×1`；券 `P3 PERCENT 80 cap 300`、`T2 THRESHOLD 4200/5000` | `subtotal 5000, member_saving 500, discount 300, threshold_off 4200, payable 0, applied ("P3","T2")` | 会员价、封顶、门槛恰好相等、G3 |
| E4 | 商品 `G001 grocery 1000×1`；券 `P4 PERCENT 90` 截止 `2026-11-30 00:00`、`P5 PERCENT 80` 截止 `2026-12-31 00:00` | `discount 100, payable 900, applied ("P4",)` | CH1：到期早者优先（v1 会选 P5） |
| E5 | 商品 `G001 grocery 1000×1`；券 `P6 PERCENT 50`，`ends_at = now` | `discount 0, payable 1000, applied ()` | R3 半开区间 |
| E6 | 商品 `G001 grocery 1000×1`；券 `P7 PERCENT 80`、`T3 THRESHOLD 900/100` | `discount 200, threshold_off 0, payable 800, applied ("P7",)` | G1：J=800 未达门槛（按 `subtotal` 判断会误用 T3） |
| E7 | 商品 `X001 snack 15×1`、`X002 snack 15×1`；券 `P8 PERCENT 90` | `subtotal 30, discount 3, payable 27, applied ("P8",)` | G2：整体舍入（逐行舍入会得到 `discount 2`） |

---

## 4. 学员材料

### 4.1 starter 目录（发给学员）

```
SPEC.md                    规格（v2，3.3 所列三处故意含糊）
CLARIFICATIONS.md          澄清记录（G1–G3 的结论）
CHANGE.md                  变更记录（CH1、CH2）
README.md                  做题说明：交付哪 4 个文件、如何本地运行测试
src/pricing.py             被测实现 = 参考实现 + B1–B4
tests/legacy_test_quote.py 前任按 v1 写的遗留测试套件
tests/test_quote.py        空模板（含 import 与一个空 TestCase）
```

### 4.2 埋入的缺陷

每个缺陷只能被精确到边界或组合的用例发现。B 变体 = 参考实现 + 恰好一个缺陷；`starter/src/pricing.py` = 参考实现 + 全部四个缺陷。

| 编号 | 条款 | 实现中的写法 | 规格要求 | 能发现它的最小用例 |
|---|---|---|---|---|
| B1 | R5 | `round(base * percent / 100)` | 四舍五入。Python 的 `round(22.5) == 22` 是银行家舍入 | E2 |
| B2 | R7 | `J > threshold` | `J ≥ threshold` | E3 |
| B3 | R5 | 排除品类的行仍计入折扣基数（会员价行仍被排除） | 排除品类不计入 | E2 |
| B4 | R3 | `starts_at <= now <= ends_at` | 半开区间 | E5 |

`src/pricing.py` 中的缺陷不得有任何注释或命名暗示。

### 4.3 遗留测试套件 `tests/legacy_test_quote.py`

模拟"前任写的测试"，测试名固定如下，`judge.py` 依赖这些名字：

| 测试名 | 类型 | 内容 |
|---|---|---|
| `test_basic_percent_and_threshold` | 正确 | E1 |
| `test_expired_coupon_ignored` | 正确 | 券在 now 之前一天已截止 |
| `test_empty_cart` | 正确 | 空购物车全 0 |
| `test_threshold_not_reached` | 正确 | J 远低于门槛 |
| `test_invalid_quantity_rejected` | 正确 | `quantity=0` 抛 `INVALID_ITEM` |
| `test_best_percent_coupon_selected` | **过时** | 按 v1 规则断言 E4 选中 P5 |
| `test_percent_tie_breaks_by_code` | **过时** | 两张券优惠额相同、到期时间不同，券号较小的那张到期较晚；按 v1 规则断言选中券号较小者 |
| `test_rounding_half` | **固化缺陷** | E2 输入，断言 `discount == 3`（银行家舍入）；在 starter 上通过、在参考实现上失败 |
| `test_quote_returns_something` | 弱断言 | `assertIsNotNone` |
| `test_payable_non_negative` | 弱断言 | `assertGreaterEqual(q.payable, 0)` |

学员可以把遗留测试复制到 `tests/test_quote.py` 后修改。只评测 `tests/test_quote.py`。

### 4.4 交付件与提交契约

```
tests/test_quote.py   测试套件
DEFECTS.md            缺陷报告
TEST_PLAN.md          测试设计
AI_WORKLOG.md         AI 协作记录
```

`DEFECTS.md` 必须包含表格，列为：`缺陷编号 | 条款 | 失败测试 | 期望 | 实际`。

`TEST_PLAN.md` 必须包含二级标题：`## 等价类与边界`、`## 组合策略`、`## 规格空白`、`## 变更影响`、`## 不覆盖说明`。

`AI_WORKLOG.md` 必须包含二级标题：`## 约束下达`、`## AI 输出核验`、`## 失败判定`、`## 迭代记录`。

`submission-contract.json`（实现时对照 `contracts/submission-contract-v1.1.schema.json` 校验）：

```json
{
  "schemaVersion": "1.1",
  "root": { "mode": "ARCHIVE_ROOT" },
  "required": [
    { "path": "tests/test_quote.py", "type": "source" },
    { "path": "DEFECTS.md", "type": "markdown", "minSections": 1, "minChars": 200, "notTemplate": true },
    { "path": "TEST_PLAN.md", "type": "markdown", "minSections": 5, "minChars": 800, "notTemplate": true },
    { "path": "AI_WORKLOG.md", "type": "markdown", "minSections": 4, "minChars": 800, "notTemplate": true }
  ],
  "optional": [],
  "forbidden": ["**/.env", "**/.git/**", "**/__pycache__/**", "**/*.pyc"],
  "languageEntry": { "python": "tests/test_quote.py" },
  "allowedPaths": ["tests/test_quote.py", "DEFECTS.md", "TEST_PLAN.md", "AI_WORKLOG.md"],
  "allowAdditionalPaths": false,
  "maxDepth": 2,
  "maxFiles": 8
}
```

提交契约不接收 `src/`，这是有意的：**评测方从不使用学员手里的实现**。`README.md` 要提醒学员只打包这 4 个文件。

---

## 5. 评测设计

### 5.1 变体总表

| 变体 | 数量 | 作用 | 是否参与变异计分 |
|---|---|---|---|
| `reference.py` | 1 | 判定测试是否有效 | — |
| `v1_reference.py` | 1 | 识别过时断言。= 参考实现，但 R6 用 v1 规则，并忽略 `member` 与 `member_price`（`member_saving` 恒为 0） | 否 |
| `interpretations/G1.py`–`G3.py` | 3 | 识别空白误读（定义见 3.3 最后一列） | 否 |
| `bugs/B1.py`–`B4.py` | 4 | 判定每个真缺陷是否被发现 | 否 |
| `mutants/M01.py`–`M40.py` | 约 40 | 衡量测试强度 | 是 |

变异体按档位分布：basic 10、boundary 14、clarification 8、change 8（允许 ±2，但每档不得少于 6）。每个变异体在 manifest 中标注 `clause`（R1–R8 或 G1–G3、CH1–CH2）、`tier`、`category`（边界 / 运算 / 条件 / 常量 / 删除）。

### 5.2 判定规则

以**测试方法**为最小单位（一个方法内任一 subTest 失败，整个方法算失败）。

| 概念 | 定义 |
|---|---|
| 有效测试 | 在参考实现上的 3 次运行中全部通过 |
| 不稳定测试 | 3 次运行结果不一致。不计入有效测试，计入 C4 |
| 无效测试 | 在参考实现上至少失败一次，且不属于不稳定测试 |
| 过时断言 | 无效测试，且在 `v1_reference` 上通过 |
| 空白误读 Gk | 存在无效测试在 `Gk` 变体上通过 |
| 固化缺陷 Bi | 存在无效测试在 `Bi` 变体上通过 |
| 其它规格误读 | 无效测试中不属于以上任何一类的 |
| 缺陷发现 Bi | 存在有效测试在 `Bi` 变体上失败或出错 |
| 杀死变异体 | 存在有效测试在该变异体上失败、出错，或该次运行超时 |

一条无效测试按"过时 > 空白误读 > 固化缺陷 > 其它"的优先级只归入一类。

### 5.3 运行方式

- 每个变体在**独立子进程**中运行：临时目录里放 `pricing.py`（变体副本）和 `test_quote.py`（学员测试副本）。
- **不能用 `-I`**：`-I` 会忽略 `PYTHONHASHSEED`。子进程命令用 `[sys.executable, "-s", "-P", runner.py, ...]`，环境变量由 judge 显式构造，只包含 `PYTHONHASHSEED`、`PYTHONDONTWRITEBYTECODE=1`、`PYTHONIOENCODING=utf-8`、`PATH`（Windows 本地调试另加 `SYSTEMROOT`）。
- `runner.py` 自己把临时目录加入 `sys.path`，加载测试，按测试 ID 排序后用 `random.Random(order_seed)` 打乱顺序，再用自定义 `TestResult` 逐条输出 JSON：`{id, outcome: pass|fail|error, message}`。`message` 截断到 500 字符。
- 参考实现跑 3 次：`(PYTHONHASHSEED, order_seed)` 分别为 `(1, 1)`、`(2, 2)`、`(3, 3)`。
- `v1_reference`、G1–G3、B1–B4 各跑 1 次。
- 变异体各跑 1 次，**只运行有效测试**，开启 failfast。
- 单次运行超时 10 秒。参考实现运行超时时，所有测试判为无效，verify 维度全部为 D，并给出"测试套件超时"的发现。
- 预计总运行次数约 51 次。`engine.json` 的 `limits.wallClockSeconds` 先设 240，实现后按实测调整。

### 5.4 静态检查与反作弊（`lint.py`，对 `tests/test_quote.py` 做 AST 分析）

**导入白名单**（白名单而非黑名单）：`unittest`、`datetime`、`dataclasses`、`decimal`、`fractions`、`itertools`、`functools`、`random`、`math`、`string`、`collections`、`typing`、`pricing`。

**作弊类违规**（任一命中则 V1–V4 全部为 D，并给出"测试可能识别被测变体"的发现）：

- 导入白名单之外的模块
- 访问 `pricing` 的下划线开头属性，或 `__file__`、`__dict__`、`__spec__`、`__loader__`
- 调用 `open`、`exec`、`eval`、`compile`、`__import__`、`globals`、`locals`、`vars`、`breakpoint`、`input`

**质量类检查**（只影响 C 维度，见 5.5）：断言是否存在、低信息断言、吞断言的异常处理、跳过与预期失败、浮点断言、`round()`、重复方法名、条款引用、表驱动。

**允许的做法**：学员按规格自己写一个 oracle，再做差分测试或性质测试。这是正当技能，不算作弊；只受运行时长约束。

### 5.5 16 个评分点

每个评分点的档位由下表检查项的通过比例决定（规则见第 2 节）。

| 评分点 | 满分 | 检查项（每项为一个 check） |
|---|---|---|
| V1 主流程验证 | 8 | basic 档每个变异体被杀死（各 1 项）；不存在"其它规格误读"的无效测试（1 项） |
| V2 异常与边界验证 | 12 | boundary 档每个变异体被杀死（各 1 项） |
| V3 需求澄清与规则验证 | 12 | clarification 档每个变异体被杀死（各 1 项）；G1、G2、G3 各未被误读（3 项） |
| V4 变更回归验证 | 8 | change 档每个变异体被杀死（各 1 项）；无过时断言（1 项）；无固化缺陷断言（1 项） |
| S1 需求澄清 | 6 | G1–G3 各未被误读（3 项）；`TEST_PLAN.md` 的"规格空白"章节列出至少 3 条（1 项）；`TEST_PLAN.md` 引用了 `CLARIFICATIONS.md`（1 项） |
| S2 验收用例设计 | 8 | B1–B4 各被发现（4 项）；对每个已发现的 Bi，`DEFECTS.md` 中有一行同时写出该缺陷的条款号和至少一个发现它的测试名（4 项） |
| S3 异常与边界覆盖 | 6 | R1–R8 每条至少有一个标注该条款的变异体被杀死（8 项） |
| S4 变更影响定位 | 5 | 无过时断言（1 项）；遗留的固化缺陷测试已处理，即不存在在 B1 变体上通过的无效测试（1 项）；`TEST_PLAN.md` 的"变更影响"章节点名 `test_best_percent_coupon_selected`、`test_percent_tie_breaks_by_code`、`test_rounding_half`（3 项） |
| C1 业务常量管理 | 5 | 至少一半的测试方法使用 `subTest` 或遍历数据表（1 项）；至少一半的测试方法在名称、docstring 或注释中引用条款号 `R\d`（1 项）；同一个类中没有同名测试方法互相覆盖（1 项） |
| C2 异常与边界处理 | 5 | 每个测试方法至少有一个 `self.assert*` 调用或 `assertRaises` 上下文（1 项）；没有 `assertTrue(a == b)` 一类的低信息断言（1 项）；没有捕获 `AssertionError` 或裸 `except` 的 try 块（1 项）；没有 `skip` 系列装饰器、`skipTest` 与 `expectedFailure`（1 项） |
| C3 类型与精度安全 | 5 | 断言参数中没有浮点字面量（1 项）；没有 `assertAlmostEqual`（1 项）；测试代码不调用 `round()`（1 项） |
| C4 变更友好设计 | 5 | 没有不稳定测试（1 项）；不访问被测模块私有成员（1 项）；在参考实现上单次运行总耗时 ≤ 5 秒（1 项） |
| P1 需求与验收先行 | 4 | `AI_WORKLOG.md` 的"失败判定"章节至少 2 条，且每条引用一个测试名 `test_\w+`（1 项）；`TEST_PLAN.md` 满足最小章节要求（1 项） |
| P2 小步迭代 | 3 | `AI_WORKLOG.md` 的"迭代记录"章节至少 3 条（1 项） |
| P3 提示词设计 | 4 | "约束下达"章节包含至少一个引用块或代码块（1 项）；该章节同时提及 `SPEC.md` 和 `CLARIFICATIONS.md`（1 项） |
| P4 变更定位与验证 | 4 | "AI 输出核验"章节至少 2 条，且每条含条款号（1 项）；其中至少一条的条款号属于已发现缺陷的条款或 G1–G3（1 项） |

合计 verify 40、spec 25、code 20、collab 15，总分 100。

### 5.6 反馈与隐藏信息保护

- 证据和发现**只按条款与类别聚合**，例如"R5 边界类：1 个变异体存活，补充恰好进位的用例"。
- **不得**在结果中写出变异体的 diff、变体源码、B1–B4 的定义或隐藏的期望值。
- 已发现的缺陷可以按条款反馈；未发现的部分只提示"仍有未发现的缺陷"，不给条款。
- 无效测试要逐条反馈其在参考实现上的失败信息（这是学员纠正规格误读的依据），但不说明它属于哪个变体类别。
- `instruction.md` 照 sdd-v2 的写法，明确禁止 Code Agent 在结果中写入以上内容。

---

## 6. 目录结构

```
challenges/coupon-stacking-v1/
  challenge.yaml                 赛题定义（格式照 sdd-log-redaction-v2/challenge.yaml）
  README.md                      作者视角说明
  submission-contract.json
  starter/                       发给学员的全部材料（见 4.1）
  engine/                        打包为引擎包的全部内容
    engine.json
    judge.py                     编排：契约校验 → 静态检查 → 参考 → 解释/缺陷/v1 变体 → 变异体 → 打分 → 结果
    runner.py                    子进程内运行 unittest，逐条输出结果
    lint.py
    instruction.md
    skills/evaluation/SKILL.md
    assets/
      submission-contract.json
      variants/reference.py
      variants/v1_reference.py
      variants/interpretations/G1.py G2.py G3.py
      variants/bugs/B1.py B2.py B3.py B4.py
      variants/mutants/M01.py ... M40.py
      variants/manifest.json     每个变体的 id、类型、条款、档位、类别、SHA-256
      oracle/                    作者完整交付件（测试 + 三份文档），供 selfCheck 使用
  tools/
    make_variants.py             从 reference.py 生成全部变体、starter 实现与 manifest
    variant-patches.json         B、G、v1 变体与变异体的声明式补丁
    equivalence-review.md        等价变异体人工复核记录
  calibration/                   校准件（不进引擎包），见第 8 节
```

引擎回归测试：`services/platform-api/test/coupon-stacking-v1-engine.test.ts`，照 `sdd-log-redaction-v2-engine.test.ts` 的流程：`build-engine-package.mjs` 打包 → `engine_dev.py validate` → `engine_dev.py run` → `validateEvaluationResult` 与 `checkEvaluationScore` 校验 → 断言分数。

---

## 7. 作者工具：变体生成与变异体冻结

- 所有变体都从 `reference.py` 加声明式补丁生成。每条补丁是"原文片段 → 替换片段"，生成时必须断言原文片段**恰好出现一次**。
- `starter/src/pricing.py` 也由工具生成（参考实现 + B1–B4 四条补丁），不得手工维护。
- 变异算子：比较符替换（`<`/`<=`/`>`/`>=`/`==`）、算术运算符替换、条件取反、整数常量 ±1、删除校验语句、排序键反转、`min`/`max` 互换。
- 生成流程：对参考实现应用算子得到候选 → 用作者测试集运行 → **存活的候选必须人工复核是否为等价变异体**，结论写入 `equivalence-review.md` → 剔除等价变异体，冻结约 40 个，写入 manifest 和哈希。
- 等价变异体的典型例子：R5 封顶判断 `discount > cap` 改成 `>=`。`discount == cap` 时两者都得到 `cap`，行为完全一致，必须剔除。
- 变异体不得与 B1–B4 行为相同（例如 R7 的 `>=` 改 `>` 就是 B2，不能再作为变异体）。
- 重新生成必须是确定性的：同样的输入产生同样的文件和哈希。

---

## 8. 校准件与验收标准

校准件放在 `calibration/<名称>/`，每个都是一份完整交付件（测试 + 三份文档），并在引擎回归测试中逐个断言。

| 校准件 | 构成 | 验收标准 |
|---|---|---|
| `oracle` | 作者完整交付件 | 总分 100，全部 A 档 |
| `ai-direct` | 由 AI 在**只读 `src/pricing.py`、不读 `SPEC.md`/`CLARIFICATIONS.md`/`CHANGE.md`** 的条件下生成测试；三份文档按模板填写 | 总分 ≤ 60；S2 的缺陷发现项为 0 或 1 |
| `spec-guess` | 只读 `SPEC.md`、不读 `CLARIFICATIONS.md` 写出的测试 | G1–G3 中至少两项被判误读；V3 ≤ C 档 |
| `snapshot` | 对 starter 随机采样 200 组输入录制输出作为期望值 | verify 维度 ≤ 5 |
| `legacy-only` | 原样提交遗留套件 | 识别出 2 个过时断言和 1 个固化缺陷断言；V4 为 D 档 |
| `happy-path` | 只测 3 个正常场景 | V2 与 V3 合计 ≤ 6 |
| `assert-false` | 每个测试方法都 `self.fail()` | verify 维度为 0 |
| `cheat` | 读取 `pricing.__file__` 区分变体 | verify 维度为 0，并有作弊发现 |
| `flaky` | 含一个使用未设种子的 `random` 且结果依赖顺序的测试 | 该测试被判不稳定；C4 不为 A |

`ai-direct` 和 `snapshot` 是本题成立的证据：它们证明题目练的是"用好 AI"，而不是"会写测试"。若某项校准不达标，**调整检查项权重或补充变异体，不得放宽阈值**（AGENTS.md：不通过放宽校验来修复失败）。

---

## 9. 任务拆分

按 AGENTS.md"每次只实现一个可验收的纵切面"，拆成 6 个任务，按顺序完成。每个任务完成后报告改动文件、验证命令、结果和未解决风险。

### T1 规格与参考实现

- 产出：`starter/SPEC.md`、`starter/CLARIFICATIONS.md`、`starter/CHANGE.md`、`engine/assets/variants/reference.py`、`engine/assets/oracle/tests/test_quote.py`（先只写测试）。
- 验收：
  - 参考实现只用标准库，公开 API 与 3.1 完全一致。
  - 作者测试在参考实现上全部通过；第 3.5 节 E1–E7 逐字段命中。
  - R1–R8、G1–G3、CH1–CH2 每项至少有 3 个作者测试用例。
  - `SPEC.md` 中 G1–G3 三处的写法与 3.3 表格第二列一致，不得泄露结论。

### T2 变体生成

- 产出：`tools/make_variants.py`、`tools/variant-patches.json`、B1–B4、G1–G3、`v1_reference.py`、`starter/src/pricing.py`、`manifest.json`、`starter/tests/legacy_test_quote.py`。
- 验收：
  - 每条补丁恰好应用一次；重新生成哈希不变。
  - 每个 B、G 变体都至少让一个作者测试失败。
  - `starter/src/pricing.py` 上失败的作者测试，恰好等于四个 B 变体各自失败测试的并集。
  - 遗留套件里两个过时测试在 `v1_reference` 上通过、在参考实现上失败；`test_rounding_half` 在 starter 上通过、在参考实现上失败。

### T3 runner 与判定（暂不含变异体）

- 产出：`engine/runner.py`、`engine/judge.py` 中 5.2 的全部判定逻辑。
- 验收：
  - `oracle`：0 条无效测试，4/4 缺陷被发现，0 个空白误读。
  - `snapshot`：至少 90% 的测试判为无效。
  - `legacy-only`：正确归类 2 个过时断言和 1 个固化缺陷断言。
  - `flaky`：不稳定测试被识别。

### T4 变异体

- 产出：变异算子、冻结的变异体、`equivalence-review.md`、manifest 更新。
- 验收：
  - 作者测试集杀死 100% 的冻结变异体。
  - 各档数量符合 5.1。
  - 没有变异体在作者测试集上的失败集合与任一 B 变体完全相同。

### T5 静态检查、评分与结果

- 产出：`engine/lint.py`，`judge.py` 的 16 个评分点、发现和结果 JSON。
- 验收：
  - 结果通过 `validateEvaluationResult`，`checkEvaluationScore` 无错误。
  - `oracle` 总分 100。
  - 第 8 节全部校准标准达标。
  - 结果和发现中不出现任何变体源码、变异 diff 或缺陷定义（加一条测试：在结果 JSON 里搜索各变体的特征片段，必须为零命中）。

### T6 打包与接入

- 产出：`engine.json`（含 `selfCheck`、`agent`、`assets`）、`instruction.md`、`skills/evaluation/SKILL.md`、`challenge.yaml`、`submission-contract.json`、两份 `README.md`、`services/platform-api/test/coupon-stacking-v1-engine.test.ts`。
- 验收：
  - `node scripts/build-engine-package.mjs coupon-stacking-v1` 成功；`engine_dev.py validate` 通过。
  - `pnpm --filter @ai-training/platform-api test` 全部通过，包含新增的引擎测试。
  - 引擎包中不含 `calibration/` 和 `starter/`。
  - 按 AGENTS.md，随发布同步 `README.md` 的当前状态与版本沿革。

---

## 10. 待人工决策的事项

实现过程中遇到以下问题，先按括号内的默认值实现，并在任务报告中标出：

1. 做题时长与 zone（默认 120 分钟、yellow）。
2. 是否支持 pytest（默认不支持；如需支持，要在引擎 `requirements` 中声明并准备内网 wheelhouse）。
3. 变异体反馈粒度（默认按条款与类别聚合，见 5.6）。
4. 允许重新提交的次数。次数越多，学员越可能针对反馈过拟合（默认不在引擎内限制，由训战配置决定）。
