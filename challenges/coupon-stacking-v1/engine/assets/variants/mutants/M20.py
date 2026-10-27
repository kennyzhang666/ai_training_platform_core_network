"""超市订单计价。金额单位为分，时间必须带时区。"""
from dataclasses import dataclass, field
from datetime import datetime


class PricingError(ValueError):
    def __init__(self, code: str, message: str = '') -> None:
        super().__init__(message or code)
        self.code = code


@dataclass(frozen=True)
class Item:
    sku: str
    category: str
    unit_price: int
    quantity: int
    member_price: int | None = None


@dataclass(frozen=True)
class Coupon:
    code: str
    kind: str
    starts_at: datetime
    ends_at: datetime
    threshold: int = 0
    amount: int = 0
    percent: int = 100
    cap: int | None = None
    excluded_categories: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class Quote:
    subtotal: int
    member_saving: int
    discount: int
    threshold_off: int
    payable: int
    applied: tuple[str, ...]


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _aware(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise PricingError('NAIVE_DATETIME')


def _member_line(item, member):
    return member and item.member_price is not None


def _discount(cart, coupon, member):
    eligible = [item for item in cart if not _member_line(item, member) and item.category not in coupon.excluded_categories]
    base = sum(item.unit_price * item.quantity for item in eligible)
    rounded = (base * coupon.percent + 50) // 100
    discount = base - rounded
    if coupon.cap is not None and discount > coupon.cap:
        discount = coupon.cap
    return discount


def quote(cart: list[Item], coupons: list[Coupon], now: datetime, member: bool = False) -> Quote:
    if now.tzinfo is None: now = now.replace(tzinfo=coupons[0].starts_at.tzinfo)
    for item in cart:
        if not isinstance(item.sku, str) or not item.sku:
            raise PricingError('INVALID_ITEM')
        if not _integer(item.unit_price) or item.unit_price < 0:
            raise PricingError('INVALID_ITEM')
        if not _integer(item.quantity) or item.quantity < 1:
            raise PricingError('INVALID_ITEM')
        if item.member_price is not None and (not _integer(item.member_price) or not 0 <= item.member_price <= item.unit_price):
            raise PricingError('INVALID_ITEM')
    seen = set()
    for coupon in coupons:
        _aware(coupon.starts_at)
        _aware(coupon.ends_at)
        if not isinstance(coupon.code, str) or not coupon.code or coupon.code in seen:
            raise PricingError('INVALID_COUPON')
        seen.add(coupon.code)
        if coupon.kind not in ('THRESHOLD', 'PERCENT'):
            raise PricingError('INVALID_COUPON')
        if coupon.starts_at >= coupon.ends_at:
            raise PricingError('INVALID_COUPON')
        if not _integer(coupon.threshold) or not _integer(coupon.amount) or (coupon.cap is not None and not _integer(coupon.cap)):
            raise PricingError('INVALID_COUPON')
        if coupon.kind == 'THRESHOLD' and (not _integer(coupon.threshold) or coupon.threshold < 0 or not _integer(coupon.amount) or coupon.amount < 1):
            raise PricingError('INVALID_COUPON')
        if coupon.kind == 'PERCENT' and (not _integer(coupon.percent) or not 1 <= coupon.percent <= 100 or (coupon.cap is not None and (not _integer(coupon.cap) or coupon.cap < 0))):
            raise PricingError('INVALID_COUPON')
    subtotal = sum(item.unit_price * item.quantity for item in cart)
    member_saving = sum((item.unit_price - item.member_price) * item.quantity for item in cart if _member_line(item, member))
    active = [coupon for coupon in coupons if coupon.starts_at <= now < coupon.ends_at]
    percentages = [(coupon, _discount(cart, coupon, member)) for coupon in active if coupon.kind == 'PERCENT']
    percentages = [(coupon, saving) for coupon, saving in percentages if saving > 0]
    percentages.sort(key=lambda pair: (pair[0].ends_at, -pair[1], pair[0].code))
    selected = percentages[0] if percentages else None
    discount = selected[1] if selected else 0
    j = subtotal - member_saving - discount
    thresholds = [coupon for coupon in active if coupon.kind == 'THRESHOLD' and j >= coupon.threshold]
    thresholds.sort(key=lambda coupon: (-coupon.amount, coupon.code))
    threshold_off = min(thresholds[0].amount, j) if thresholds else 0
    applied = ((selected[0].code,) if selected else ()) + ((thresholds[0].code,) if threshold_off > 0 else ())
    payable = subtotal - member_saving - discount - threshold_off
    return Quote(subtotal, member_saving, discount, threshold_off, payable, applied)
