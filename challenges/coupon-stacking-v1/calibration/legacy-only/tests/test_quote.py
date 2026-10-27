import unittest
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, PricingError, quote

TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)


class LegacyTests(unittest.TestCase):
    def test_basic_percent_and_threshold(self):
        q = quote([Item('A', 'dairy', 1200, 2), Item('B', 'bakery', 800, 1)], [Coupon('P1', 'PERCENT', START, END, percent=90), Coupon('T1', 'THRESHOLD', START, END, threshold=2500, amount=300)], NOW)
        self.assertEqual(q.payable, 2580)

    def test_expired_coupon_ignored(self):
        q = quote([Item('A', '', 1000, 1)], [Coupon('P', 'PERCENT', START, NOW-timedelta(days=1), percent=90)], NOW)
        self.assertEqual(q.discount, 0)

    def test_empty_cart(self):
        self.assertEqual(quote([], [], NOW).payable, 0)

    def test_threshold_not_reached(self):
        q = quote([Item('A', '', 100, 1)], [Coupon('T', 'THRESHOLD', START, END, threshold=900, amount=100)], NOW)
        self.assertEqual(q.threshold_off, 0)

    def test_invalid_quantity_rejected(self):
        with self.assertRaises(PricingError) as caught:
            quote([Item('A', '', 100, 0)], [], NOW)
        self.assertEqual(caught.exception.code, 'INVALID_ITEM')

    def test_best_percent_coupon_selected(self):
        q = quote([Item('A', '', 1000, 1)], [Coupon('P4', 'PERCENT', START, END-timedelta(days=1), percent=90), Coupon('P5', 'PERCENT', START, END+timedelta(days=30), percent=80)], NOW)
        self.assertEqual(q.applied, ('P5',))

    def test_percent_tie_breaks_by_code(self):
        q = quote([Item('A', '', 1000, 1)], [Coupon('A', 'PERCENT', START, END, percent=90), Coupon('Z', 'PERCENT', START, END-timedelta(days=1), percent=90)], NOW)
        self.assertEqual(q.applied, ('A',))

    def test_rounding_half(self):
        self.assertEqual(quote([Item('S001', 'snack', 25, 1)], [Coupon('P2', 'PERCENT', START, END, percent=90, excluded_categories=frozenset({'tobacco'}))], NOW).discount, 3)

    def test_quote_returns_something(self):
        self.assertIsNotNone(quote([], [], NOW))

    def test_payable_non_negative(self):
        self.assertGreaterEqual(quote([], [], NOW).payable, 0)
