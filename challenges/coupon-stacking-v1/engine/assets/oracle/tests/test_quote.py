"""所有断言来自规格条款，金额一律用整数分。"""
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, PricingError, quote

TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)


def p(code='P', percent=90, **kw):
    return Coupon(code, 'PERCENT', START, END, percent=percent, **kw)


def t(code='T', threshold=900, amount=100):
    return Coupon(code, 'THRESHOLD', START, END, threshold=threshold, amount=amount)


class QuoteTests(unittest.TestCase):
    def test_R1_invalid_items(self):
        for patch in [dict(unit_price=-1), dict(unit_price=True), dict(unit_price=1.5), dict(quantity=0), dict(quantity=False), dict(quantity=True), dict(quantity=1.5), dict(member_price=1001), dict(member_price=-1), dict(member_price=True), dict(sku='')]:
            with self.subTest(patch=patch), self.assertRaises(PricingError) as caught:
                quote([replace(Item('A', 'food', 1000, 1), **patch)], [], NOW)
            self.assertEqual(caught.exception.code, 'INVALID_ITEM')

    def test_R1_invalid_coupons(self):
        for patch in [dict(code=''), dict(kind='OTHER'), dict(percent=0), dict(percent=101), dict(percent=True), dict(cap=-1), dict(cap=True), dict(starts_at=END), dict(ends_at=START)]:
            with self.subTest(patch=patch), self.assertRaises(PricingError) as caught:
                quote([], [replace(p(), **patch)], NOW)
            self.assertEqual(caught.exception.code, 'INVALID_COUPON')
        for patch in [dict(threshold=-1), dict(threshold=True), dict(amount=0), dict(amount=True)]:
            with self.subTest(patch=patch), self.assertRaises(PricingError) as caught:
                quote([], [replace(t(), **patch)], NOW)
            self.assertEqual(caught.exception.code, 'INVALID_COUPON')

    def test_R1_validation_order_and_dates(self):
        for field in ['now', 'starts_at', 'ends_at']:
            with self.subTest(field=field), self.assertRaises(PricingError) as caught:
                coupon = replace(p(), **{field: NOW.replace(tzinfo=None)}) if field != 'now' else p()
                quote([], [coupon], NOW.replace(tzinfo=None) if field == 'now' else NOW)
            self.assertEqual(caught.exception.code, 'NAIVE_DATETIME')
        for coupons in [[p(), p()], [replace(p(), ends_at=NOW-timedelta(days=1), percent=0)]]:
            with self.subTest(coupons=coupons), self.assertRaises(PricingError) as caught:
                quote([], coupons, NOW)
            self.assertEqual(caught.exception.code, 'INVALID_COUPON')
        with self.assertRaises(PricingError) as caught:
            quote([Item('bad', '', -1, 1)], [replace(p(), code='')], NOW)
        self.assertEqual(caught.exception.code, 'INVALID_ITEM')

    def test_R1_all_money_fields_are_integer(self):
        for coupon in [replace(p(),threshold=True),replace(p(),amount=1.5),replace(t(),cap=False)]:
            with self.subTest(coupon=coupon), self.assertRaises(PricingError) as caught:
                quote([], [coupon], NOW)
            self.assertEqual(caught.exception.code, 'INVALID_COUPON')

    def test_R2_member_prices_CH2(self):
        for member, price, quantity, saving in [(True, 800, 2, 400), (False, 800, 2, 0), (True, 0, 1, 1000), (True, None, 3, 0)]:
            with self.subTest(member=member, price=price):
                q = quote([Item('A', 'food', 1000, quantity, price)], [], NOW, member)
                self.assertEqual(q, Quote(1000*quantity, saving, 0, 0, 1000*quantity-saving, ()))

    def test_R3_validity_half_open(self):
        for now, discount in [(START-timedelta(microseconds=1), 0), (START, 100), (END-timedelta(microseconds=1), 100), (END, 0), (END+timedelta(days=1), 0)]:
            with self.subTest(now=now):
                self.assertEqual(quote([Item('A', 'food', 1000, 1)], [p()], now).discount, discount)

    def test_R3_not_yet_active(self):
        for days in [1, 2, 3]:
            with self.subTest(days=days):
                self.assertEqual(quote([Item('A', '', 1000, 1)], [p()], START-timedelta(days=days)).discount, 0)

    def test_R3_starts_inclusive(self):
        for tz in [TZ, timezone.utc, timezone(timedelta(hours=-3))]:
            with self.subTest(tz=tz):
                self.assertEqual(quote([Item('A', '', 1000, 1)], [p()], START.astimezone(tz)).discount, 100)

    def test_R4_only_one_each(self):
        for extra in [[], [p('Q', 80)], [t('U', 0, 70), t('V', 0, 60)]]:
            with self.subTest(extra=extra):
                q = quote([Item('A', 'food', 1000, 1)], [p(), t('T', 0, 100)] + extra, NOW)
                expected = Quote(1000, 0, 200 if extra and extra[0].kind == 'PERCENT' else 100, 100, 700 if extra and extra[0].kind == 'PERCENT' else 800, ('Q', 'T') if extra and extra[0].kind == 'PERCENT' else ('P', 'T'))
                self.assertEqual(q, expected)

    def test_R5_rounding(self):
        for base, percent, discount in [(25, 90, 2), (15, 90, 1), (101, 50, 50), (31, 90, 3), (34, 90, 3), (19, 90, 2)]:
            with self.subTest(base=base, percent=percent):
                self.assertEqual(quote([Item('A', 'food', base, 1)], [p(percent=percent)], NOW).discount, discount)

    def test_R5_excluded_and_case(self):
        for category, discount in [('tobacco', 2), ('Tobacco', 102), ('other', 102)]:
            with self.subTest(category=category):
                q = quote([Item('A', 'snack', 25, 1), Item('B', category, 1000, 1)], [p(excluded_categories=frozenset({'tobacco'}))], NOW)
                self.assertEqual(q.discount, discount)

    def test_R5_cap_and_zero(self):
        for cap, expected in [(None, 200), (0, 0), (1, 1), (199, 199), (200, 200), (201, 200)]:
            with self.subTest(cap=cap):
                q = quote([Item('A', '', 1000, 1)], [p(percent=80, cap=cap)], NOW)
                self.assertEqual(q.discount, expected)
                self.assertEqual(q.applied, ('P',) if expected else ())

    def test_R6_selection_CH1(self):
        for coupons, expected, discount in [([replace(p('EARLY'), ends_at=END-timedelta(days=1)), p('LATE', 80)], 'EARLY', 100), ([p('A'), replace(p('Z'), ends_at=END-timedelta(days=1))], 'Z', 100), ([p('A'), p('Z', 80)], 'Z', 200), ([p('Z'), p('A')], 'A', 100)]:
            with self.subTest(expected=expected):
                q = quote([Item('A', '', 1000, 1)], coupons, NOW)
                self.assertEqual((q.applied, q.discount), ((expected,), discount))

    def test_R7_thresholds(self):
        for threshold, amount, off in [(900, 100, 100), (1000, 100, 100), (1001, 100, 0), (0, 1200, 1000)]:
            with self.subTest(threshold=threshold):
                q = quote([Item('A', '', 1000, 1)], [t(threshold=threshold, amount=amount)], NOW)
                self.assertEqual((q.threshold_off, q.payable), (off, 1000-off))
        for coupons, expected in [([t('A', 0, 50), t('B', 0, 60)], 'B'), ([t('B', 0, 50), t('A', 0, 50)], 'A'), ([t('X', 2000, 500), t('Y', 0, 40)], 'Y')]:
            with self.subTest(expected=expected):
                self.assertEqual(quote([Item('A', '', 1000, 1)], coupons, NOW).applied, (expected,))

    def test_G1_threshold_after_reductions_R7(self):
        for member, member_price, percent, threshold, off in [(False, None, 80, 900, 0), (True, 800, 90, 900, 0), (True, 800, 80, 1500, 0), (True, 800, 80, 1600, 0)]:
            with self.subTest(member=member, threshold=threshold):
                q = quote([Item('A', '', 1000, 1, member_price)], [p(percent=percent), t(threshold=threshold)], NOW, member)
                self.assertEqual(q.threshold_off, off)
        q = quote([Item('D', 'dairy', 3000, 1, 2500), Item('B', 'bakery', 2000, 1)], [p(percent=80, cap=300), t(threshold=4200, amount=5000)], NOW, True)
        self.assertEqual(q, Quote(5000, 500, 300, 4200, 0, ('P', 'T')))

    def test_G2_aggregate_rounding_R5(self):
        for prices, percent, expected in [([15, 15], 90, 3), ([25, 25], 90, 5), ([1, 1, 1], 50, 1)]:
            with self.subTest(prices=prices):
                self.assertEqual(quote([Item(str(i), '', v, 1) for i, v in enumerate(prices)], [p(percent=percent)], NOW).discount, expected)

    def test_G3_actual_off_and_zero_R8(self):
        for price, amount in [(0, 100), (100, 1000), (10, 11)]:
            with self.subTest(price=price):
                q = quote([Item('A', '', price, 1)], [t(threshold=0, amount=amount)], NOW)
                self.assertEqual(q, Quote(price, 0, 0, price, 0, ('T',) if price else ()))

    def test_CH2_member_excluded_from_percent_R5(self):
        for member_price in [0, 500, 1000]:
            with self.subTest(member_price=member_price):
                q = quote([Item('A', '', 1000, 1, member_price), Item('B', '', 1000, 1)], [p()], NOW, True)
                self.assertEqual(q, Quote(2000, 1000-member_price, 100, 0, member_price+900, ('P',)))

    def test_R8_complete_examples(self):
        cases = [([Item('A001', 'dairy', 1200, 2), Item('B001', 'bakery', 800, 1)], [p('P1'), t('T1', 2500, 300)], Quote(3200, 0, 320, 300, 2580, ('P1', 'T1'))), ([], [], Quote(0, 0, 0, 0, 0, ())), ([Item('A', '', 0, 2)], [p(), t(threshold=0)], Quote(0, 0, 0, 0, 0, ()))]
        for cart, coupons, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(quote(cart, coupons, NOW), expected)

    def test_R8_published_examples(self):
        cases = [
            ([Item('A001','dairy',1200,2),Item('B001','bakery',800,1)],[p('P1'),t('T1',2500,300)],False,Quote(3200,0,320,300,2580,('P1','T1'))),
            ([Item('S001','snack',25,1),Item('T001','tobacco',1000,1)],[p('P2',excluded_categories=frozenset({'tobacco'}))],False,Quote(1025,0,2,0,1023,('P2',))),
            ([Item('D001','dairy',3000,1,2500),Item('B002','bakery',2000,1)],[p('P3',80,cap=300),t('T2',4200,5000)],True,Quote(5000,500,300,4200,0,('P3','T2'))),
            ([Item('G001','grocery',1000,1)],[replace(p('P4'),ends_at=datetime(2026,11,30,tzinfo=TZ)),replace(p('P5',80),ends_at=datetime(2026,12,31,tzinfo=TZ))],False,Quote(1000,0,100,0,900,('P4',))),
            ([Item('G001','grocery',1000,1)],[replace(p('P6',50),ends_at=NOW)],False,Quote(1000,0,0,0,1000,())),
            ([Item('G001','grocery',1000,1)],[p('P7',80),t('T3',900,100)],False,Quote(1000,0,200,0,800,('P7',))),
            ([Item('X001','snack',15,1),Item('X002','snack',15,1)],[p('P8')],False,Quote(30,0,3,0,27,('P8',))),
        ]
        for cart,coupons,member,expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(quote(cart,coupons,NOW,member),expected)


if __name__ == '__main__':
    unittest.main()
