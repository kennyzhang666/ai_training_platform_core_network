import unittest
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, PricingError, quote
TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)

class GuessTests(unittest.TestCase):
    def test_threshold_guess(self):
        self.assertEqual(quote([Item('A','',1000,1)],[Coupon('P','PERCENT',START,END,percent=80),Coupon('T','THRESHOLD',START,END,threshold=900,amount=100)],NOW),Quote(1000,0,200,100,700,('P','T')))
    def test_rounding_guess(self):
        self.assertEqual(quote([Item('A','',15,1),Item('B','',15,1)],[Coupon('P','PERCENT',START,END,percent=90)],NOW),Quote(30,0,2,0,28,('P',)))
    def test_actual_amount_guess(self):
        self.assertEqual(quote([Item('A','',100,1)],[Coupon('T','THRESHOLD',START,END,threshold=0,amount=1000)],NOW),Quote(100,0,0,1000,0,('T',)))
