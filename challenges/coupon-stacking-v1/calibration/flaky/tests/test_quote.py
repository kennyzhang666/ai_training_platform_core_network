import unittest
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, PricingError, quote
TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)

import random
SEEN = []
class OrderTests(unittest.TestCase):
    def test_a_random(self):
        self.assertEqual(len(SEEN),1)
        SEEN.append(random.random())
    def test_b(self):
        SEEN.append('b')
        self.assertEqual(1,1)
    def test_c(self):
        SEEN.append('c')
        self.assertEqual(1,1)
    def test_d(self):
        SEEN.append('d')
        self.assertEqual(1,1)
