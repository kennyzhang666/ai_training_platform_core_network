import unittest
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, PricingError, quote
TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)

class ImplementationTests(unittest.TestCase):
    def test_from_implementation_0(self):
        self.assertEqual(quote([Item('X','excluded',2565,1),Item('Y','food',13,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=70,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2578, member_saving=0, discount=773, threshold_off=0, payable=1805, applied=('P',)))
    def test_from_implementation_1(self):
        self.assertEqual(quote([Item('X','excluded',1423,1),Item('Y','food',181,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=32,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1604, member_saving=0, discount=1091, threshold_off=0, payable=513, applied=('P',)))
    def test_from_implementation_2(self):
        self.assertEqual(quote([Item('X','excluded',3806,1),Item('Y','food',322,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=34,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4128, member_saving=0, discount=2724, threshold_off=0, payable=1404, applied=('P',)))
    def test_from_implementation_3(self):
        self.assertEqual(quote([Item('X','excluded',878,1),Item('Y','food',450,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=15,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1328, member_saving=0, discount=1129, threshold_off=0, payable=199, applied=('P',)))
