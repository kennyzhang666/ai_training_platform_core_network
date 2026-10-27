# 超市叠加优惠计价规格 v2

金额统一使用整数“分”，时间必须带时区。模块 `pricing` 提供 `Item`、`Coupon`、`Quote`、`PricingError` 和 `quote(cart, coupons, now, member=False)`。公开接口的字段及类型见随题提供的 `src/pricing.py`，它的返回行为需要通过本规格核验。

```python
Item(sku: str, category: str, unit_price: int, quantity: int,
     member_price: int | None = None)
Coupon(code: str, kind: str, starts_at: datetime, ends_at: datetime,
       threshold: int = 0, amount: int = 0, percent: int = 100,
       cap: int | None = None, excluded_categories: frozenset[str] = frozenset())
Quote(subtotal: int, member_saving: int, discount: int,
      threshold_off: int, payable: int, applied: tuple[str, ...])
quote(cart: list[Item], coupons: list[Coupon], now: datetime,
      member: bool = False) -> Quote
```

这三种数据对象均为只读 dataclass，支持按字段比较。`PricingError` 继承 `ValueError`，其 `code` 属性提供错误码。

## R1 输入校验

- 金额和数量必须是 `int`，不能是 `bool`。
- 券的金额字段包括 `threshold`、`amount` 和非空的 `cap`；类型校验不因券种而跳过，各自取值范围按下面的券种规则。
- 商品 `sku` 为非空字符串，`unit_price ≥ 0`，`quantity ≥ 1`；会员价为 `None` 或满足 `0 ≤ member_price ≤ unit_price` 的整数。不满足时抛 `PricingError`，`code` 为 `INVALID_ITEM`。
- 券号为非空字符串且一单内不重复；`kind` 为 `THRESHOLD` 或 `PERCENT`；`starts_at < ends_at`。满减券要求整数 `threshold ≥ 0`、`amount ≥ 1`；折扣券要求整数 `1 ≤ percent ≤ 100`，`cap` 为 `None` 或非负整数。不满足时抛 `INVALID_COUPON`。
- 所有券都要校验，包括已经过期或尚未生效的券。
- `now` 和每张券的起止时间都必须是带有效时区的 `datetime`，否则抛 `NAIVE_DATETIME`。
- 先校验 `now`，再按列表顺序校验商品，最后按列表顺序校验券，遇到第一个错误即停止。空购物车合法。

## R2 小计与会员价

行原价为 `unit_price × quantity`，`subtotal` 为行原价之和。`member=True` 且该行 `member_price` 不为 `None` 时采用会员价，`member_saving` 累计 `(unit_price − member_price) × quantity`。非会员的会员优惠为 0。会员价为 0 仍然有效。

## R3 有效期

券的有效区间为 `starts_at ≤ now < ends_at`。不在区间内的券不参与选择，也不进入 `applied`。表示同一时刻的不同时区时间按实际时间比较。

## R4 用券数量

每单最多使用一张折扣券和一张满减券，没有合适的券时可以不用券。

## R5 折扣与封顶

折扣基数来自非会员价行，并排除该券 `excluded_categories` 指定的品类。品类字符串精确匹配，区分大小写。`percent=90` 表示九折。

折扣后金额四舍五入到分。折扣优惠额为折扣基数与折后额的差；设置 `cap` 时，优惠额不超过 `cap`。最终优惠额为 0 的折扣券不参与选择。

## R6 折扣券选择

先比较到期时间，最早到期的优先；到期相同时，实际优惠额大的优先；仍相同时，取 Python 字符串比较中券号最小的券。这里的优惠额已经考虑了排除品类和封顶。

## R7 满减

先应用折扣，再应用满减。订单金额达到门槛时可使用满减券。多张券满足门槛时，取券面优惠额最大者；相同取券号最小者。实际抵扣为 0 时不记录为已使用。

## R8 返回值

`Quote` 包含 `subtotal`、`member_saving`、`discount`、`threshold_off`、`payable` 六项金额以及元组 `applied`。应付金额最低为 0。券号按应用顺序记录，折扣券在前，满减券在后。所有金额仍以整数分表示。

## 规格配套材料

`CLARIFICATIONS.md` 记录已确认的三个计算口径，`CHANGE.md` 记录旧版到 v2 的变化。测试期望应由这些材料推导；随题实现的当前输出不能替代规格。
