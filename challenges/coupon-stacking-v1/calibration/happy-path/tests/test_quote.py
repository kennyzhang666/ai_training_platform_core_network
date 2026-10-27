import unittest
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, PricingError, quote
TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)

class HappyTests(unittest.TestCase):
    def test_without_coupon(self):
        self.assertEqual(quote([Item('A','',1000,1)],[],NOW),Quote(1000,0,0,0,1000,()))
    def test_percent(self):
        self.assertEqual(quote([Item('A','',1000,1)],[Coupon('P','PERCENT',START,END,percent=90)],NOW),Quote(1000,0,100,0,900,('P',)))
    def test_threshold(self):
        self.assertEqual(quote([Item('A','',1000,1)],[Coupon('T','THRESHOLD',START,END,threshold=900,amount=100)],NOW),Quote(1000,0,0,100,900,('T',)))
