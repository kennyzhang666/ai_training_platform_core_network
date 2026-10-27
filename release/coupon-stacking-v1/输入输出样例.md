# 计价输入输出

金额单位为分。公共时间如下：

```python
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, quote
TZ = timezone(timedelta(hours=8))
now = datetime(2026, 11, 15, 10, tzinfo=TZ)
start = datetime(2026, 11, 1, tzinfo=TZ)
end = datetime(2026, 12, 1, tzinfo=TZ)
```

## 正常叠加

```python
cart = [Item('A001', 'dairy', 1200, 2), Item('B001', 'bakery', 800, 1)]
coupons = [Coupon('P1', 'PERCENT', start, end, percent=90),
           Coupon('T1', 'THRESHOLD', start, end, threshold=2500, amount=300)]
quote(cart, coupons, now)
# Quote(subtotal=3200, member_saving=0, discount=320,
#       threshold_off=300, payable=2580, applied=('P1', 'T1'))
```

## 规格结果对照

表中没有填写的会员节省额、折扣、满减默认为 0；每行均从同一公共时间重新构造输入。

| 场景 | 输入 | 完整金额结果（小计 / 会员节省 / 折扣 / 满减 / 应付） | applied |
| --- | --- | --- | --- |
| 排除品类与舍入 | snack 25×1，tobacco 1000×1；P2 九折且排除 tobacco | 1025 / 0 / 2 / 0 / 1023 | `('P2',)` |
| 会员、封顶与满减 | 会员，dairy 3000×1 会员价2500，bakery 2000×1；P3 八折封顶300；T2 满4200减5000 | 5000 / 500 / 300 / 4200 / 0 | `('P3','T2')` |
| 最早到期优先 | grocery 1000×1；P4 九折、11月30日到期；P5 八折、12月31日到期 | 1000 / 0 / 100 / 0 / 900 | `('P4',)` |
| 截止时刻 | grocery 1000×1；P6 五折，ends_at 恰好等于 now | 1000 / 0 / 0 / 0 / 1000 | `()` |
| 折扣后未达门槛 | grocery 1000×1；P7 八折；T3 满900减100 | 1000 / 0 / 200 / 0 / 800 | `('P7',)` |
| 整体舍入 | snack 15×1 两行；P8 九折 | 30 / 0 / 3 / 0 / 27 | `('P8',)` |
| 空购物车 | 空商品、空券 | 0 / 0 / 0 / 0 / 0 | `()` |

## 异常输入

```python
# quantity=0：抛 PricingError，code == 'INVALID_ITEM'
quote([Item('A', 'food', 100, 0)], [], now)

# percent=0：即使券已过期也抛 INVALID_COUPON
quote([], [Coupon('P', 'PERCENT', start, now-timedelta(days=1), percent=0)], now)

# 无时区 now：先抛 NAIVE_DATETIME，不继续检查商品与券
quote([], [], now.replace(tzinfo=None))
```

这些结果来自规格，不是对随题程序的输出录制。测试不应只覆盖表中输入，还需自行设计边界与组合。
