import unittest
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, PricingError, quote
TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)

class SnapshotTests(unittest.TestCase):
    def test_recorded_000(self):
        self.assertEqual(quote([Item('X','excluded',2565,1),Item('Y','food',13,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=70,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2578, member_saving=0, discount=773, threshold_off=0, payable=1805, applied=('P',)))

    def test_recorded_001(self):
        self.assertEqual(quote([Item('X','excluded',1423,1),Item('Y','food',181,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=32,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1604, member_saving=0, discount=1091, threshold_off=0, payable=513, applied=('P',)))

    def test_recorded_002(self):
        self.assertEqual(quote([Item('X','excluded',3806,1),Item('Y','food',322,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=34,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4128, member_saving=0, discount=2724, threshold_off=0, payable=1404, applied=('P',)))

    def test_recorded_003(self):
        self.assertEqual(quote([Item('X','excluded',878,1),Item('Y','food',450,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=15,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1328, member_saving=0, discount=1129, threshold_off=0, payable=199, applied=('P',)))

    def test_recorded_004(self):
        self.assertEqual(quote([Item('X','excluded',2065,1),Item('Y','food',265,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=33,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2330, member_saving=0, discount=1561, threshold_off=0, payable=769, applied=('P',)))

    def test_recorded_005(self):
        self.assertEqual(quote([Item('X','excluded',1330,1),Item('Y','food',41,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=79,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1371, member_saving=0, discount=288, threshold_off=0, payable=1083, applied=('P',)))

    def test_recorded_006(self):
        self.assertEqual(quote([Item('X','excluded',4155,1),Item('Y','food',82,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=75,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4237, member_saving=0, discount=1059, threshold_off=0, payable=3178, applied=('P',)))

    def test_recorded_007(self):
        self.assertEqual(quote([Item('X','excluded',2857,1),Item('Y','food',175,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=27,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3032, member_saving=0, discount=2213, threshold_off=0, payable=819, applied=('P',)))

    def test_recorded_008(self):
        self.assertEqual(quote([Item('X','excluded',3090,1),Item('Y','food',237,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=56,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3327, member_saving=0, discount=1464, threshold_off=0, payable=1863, applied=('P',)))

    def test_recorded_009(self):
        self.assertEqual(quote([Item('X','excluded',1540,1),Item('Y','food',279,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=15,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1819, member_saving=0, discount=1546, threshold_off=0, payable=273, applied=('P',)))

    def test_recorded_010(self):
        self.assertEqual(quote([Item('X','excluded',3575,1),Item('Y','food',5,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=56,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3580, member_saving=0, discount=1575, threshold_off=0, payable=2005, applied=('P',)))

    def test_recorded_011(self):
        self.assertEqual(quote([Item('X','excluded',4648,1),Item('Y','food',154,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=51,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4802, member_saving=0, discount=2353, threshold_off=0, payable=2449, applied=('P',)))

    def test_recorded_012(self):
        self.assertEqual(quote([Item('X','excluded',4972,1),Item('Y','food',181,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=58,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5153, member_saving=0, discount=2164, threshold_off=0, payable=2989, applied=('P',)))

    def test_recorded_013(self):
        self.assertEqual(quote([Item('X','excluded',2766,1),Item('Y','food',45,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=36,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2811, member_saving=0, discount=1799, threshold_off=0, payable=1012, applied=('P',)))

    def test_recorded_014(self):
        self.assertEqual(quote([Item('X','excluded',887,1),Item('Y','food',18,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=62,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=905, member_saving=0, discount=344, threshold_off=0, payable=561, applied=('P',)))

    def test_recorded_015(self):
        self.assertEqual(quote([Item('X','excluded',876,1),Item('Y','food',228,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=67,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1104, member_saving=0, discount=364, threshold_off=0, payable=740, applied=('P',)))

    def test_recorded_016(self):
        self.assertEqual(quote([Item('X','excluded',2946,1),Item('Y','food',380,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=78,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3326, member_saving=0, discount=732, threshold_off=0, payable=2594, applied=('P',)))

    def test_recorded_017(self):
        self.assertEqual(quote([Item('X','excluded',1115,1),Item('Y','food',121,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=24,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1236, member_saving=0, discount=939, threshold_off=0, payable=297, applied=('P',)))

    def test_recorded_018(self):
        self.assertEqual(quote([Item('X','excluded',1023,1),Item('Y','food',159,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=89,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1182, member_saving=0, discount=130, threshold_off=0, payable=1052, applied=('P',)))

    def test_recorded_019(self):
        self.assertEqual(quote([Item('X','excluded',2172,1),Item('Y','food',411,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=88,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2583, member_saving=0, discount=310, threshold_off=0, payable=2273, applied=('P',)))

    def test_recorded_020(self):
        self.assertEqual(quote([Item('X','excluded',2969,1),Item('Y','food',334,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=10,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3303, member_saving=0, discount=2973, threshold_off=0, payable=330, applied=('P',)))

    def test_recorded_021(self):
        self.assertEqual(quote([Item('X','excluded',279,1),Item('Y','food',135,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=27,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=414, member_saving=0, discount=302, threshold_off=0, payable=112, applied=('P',)))

    def test_recorded_022(self):
        self.assertEqual(quote([Item('X','excluded',2659,1),Item('Y','food',458,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=47,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3117, member_saving=0, discount=1652, threshold_off=0, payable=1465, applied=('P',)))

    def test_recorded_023(self):
        self.assertEqual(quote([Item('X','excluded',1333,1),Item('Y','food',297,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=29,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1630, member_saving=0, discount=1157, threshold_off=0, payable=473, applied=('P',)))

    def test_recorded_024(self):
        self.assertEqual(quote([Item('X','excluded',2680,1),Item('Y','food',79,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=90,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2759, member_saving=0, discount=276, threshold_off=0, payable=2483, applied=('P',)))

    def test_recorded_025(self):
        self.assertEqual(quote([Item('X','excluded',4520,1),Item('Y','food',278,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=31,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4798, member_saving=0, discount=3311, threshold_off=0, payable=1487, applied=('P',)))

    def test_recorded_026(self):
        self.assertEqual(quote([Item('X','excluded',2795,1),Item('Y','food',271,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=57,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3066, member_saving=0, discount=1318, threshold_off=0, payable=1748, applied=('P',)))

    def test_recorded_027(self):
        self.assertEqual(quote([Item('X','excluded',1107,1),Item('Y','food',258,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=68,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1365, member_saving=0, discount=437, threshold_off=0, payable=928, applied=('P',)))

    def test_recorded_028(self):
        self.assertEqual(quote([Item('X','excluded',3127,1),Item('Y','food',311,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=47,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3438, member_saving=0, discount=1822, threshold_off=0, payable=1616, applied=('P',)))

    def test_recorded_029(self):
        self.assertEqual(quote([Item('X','excluded',4574,1),Item('Y','food',293,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=24,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4867, member_saving=0, discount=3699, threshold_off=0, payable=1168, applied=('P',)))

    def test_recorded_030(self):
        self.assertEqual(quote([Item('X','excluded',4962,1),Item('Y','food',198,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=87,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5160, member_saving=0, discount=671, threshold_off=0, payable=4489, applied=('P',)))

    def test_recorded_031(self):
        self.assertEqual(quote([Item('X','excluded',1074,1),Item('Y','food',418,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=17,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1492, member_saving=0, discount=1238, threshold_off=0, payable=254, applied=('P',)))

    def test_recorded_032(self):
        self.assertEqual(quote([Item('X','excluded',3479,1),Item('Y','food',228,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=33,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3707, member_saving=0, discount=2484, threshold_off=0, payable=1223, applied=('P',)))

    def test_recorded_033(self):
        self.assertEqual(quote([Item('X','excluded',1300,1),Item('Y','food',110,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=34,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1410, member_saving=0, discount=931, threshold_off=0, payable=479, applied=('P',)))

    def test_recorded_034(self):
        self.assertEqual(quote([Item('X','excluded',4707,1),Item('Y','food',440,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=43,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5147, member_saving=0, discount=2934, threshold_off=0, payable=2213, applied=('P',)))

    def test_recorded_035(self):
        self.assertEqual(quote([Item('X','excluded',3490,1),Item('Y','food',453,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=13,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3943, member_saving=0, discount=3430, threshold_off=0, payable=513, applied=('P',)))

    def test_recorded_036(self):
        self.assertEqual(quote([Item('X','excluded',3579,1),Item('Y','food',488,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=25,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4067, member_saving=0, discount=3050, threshold_off=0, payable=1017, applied=('P',)))

    def test_recorded_037(self):
        self.assertEqual(quote([Item('X','excluded',2391,1),Item('Y','food',458,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=34,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2849, member_saving=0, discount=1880, threshold_off=0, payable=969, applied=('P',)))

    def test_recorded_038(self):
        self.assertEqual(quote([Item('X','excluded',3362,1),Item('Y','food',12,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=23,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3374, member_saving=0, discount=2598, threshold_off=0, payable=776, applied=('P',)))

    def test_recorded_039(self):
        self.assertEqual(quote([Item('X','excluded',4677,1),Item('Y','food',40,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=80,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4717, member_saving=0, discount=943, threshold_off=0, payable=3774, applied=('P',)))

    def test_recorded_040(self):
        self.assertEqual(quote([Item('X','excluded',1871,1),Item('Y','food',477,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=87,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2348, member_saving=0, discount=305, threshold_off=0, payable=2043, applied=('P',)))

    def test_recorded_041(self):
        self.assertEqual(quote([Item('X','excluded',2135,1),Item('Y','food',310,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=12,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2445, member_saving=0, discount=2152, threshold_off=0, payable=293, applied=('P',)))

    def test_recorded_042(self):
        self.assertEqual(quote([Item('X','excluded',2162,1),Item('Y','food',71,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=65,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2233, member_saving=0, discount=782, threshold_off=0, payable=1451, applied=('P',)))

    def test_recorded_043(self):
        self.assertEqual(quote([Item('X','excluded',3744,1),Item('Y','food',415,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=56,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4159, member_saving=0, discount=1830, threshold_off=0, payable=2329, applied=('P',)))

    def test_recorded_044(self):
        self.assertEqual(quote([Item('X','excluded',3680,1),Item('Y','food',473,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=22,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4153, member_saving=0, discount=3239, threshold_off=0, payable=914, applied=('P',)))

    def test_recorded_045(self):
        self.assertEqual(quote([Item('X','excluded',1382,1),Item('Y','food',207,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=88,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1589, member_saving=0, discount=191, threshold_off=0, payable=1398, applied=('P',)))

    def test_recorded_046(self):
        self.assertEqual(quote([Item('X','excluded',4113,1),Item('Y','food',12,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=52,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4125, member_saving=0, discount=1980, threshold_off=0, payable=2145, applied=('P',)))

    def test_recorded_047(self):
        self.assertEqual(quote([Item('X','excluded',2039,1),Item('Y','food',61,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=13,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2100, member_saving=0, discount=1827, threshold_off=0, payable=273, applied=('P',)))

    def test_recorded_048(self):
        self.assertEqual(quote([Item('X','excluded',4383,1),Item('Y','food',499,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=25,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4882, member_saving=0, discount=3662, threshold_off=0, payable=1220, applied=('P',)))

    def test_recorded_049(self):
        self.assertEqual(quote([Item('X','excluded',4160,1),Item('Y','food',186,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=38,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4346, member_saving=0, discount=2695, threshold_off=0, payable=1651, applied=('P',)))

    def test_recorded_050(self):
        self.assertEqual(quote([Item('X','excluded',4499,1),Item('Y','food',333,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=89,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4832, member_saving=0, discount=532, threshold_off=0, payable=4300, applied=('P',)))

    def test_recorded_051(self):
        self.assertEqual(quote([Item('X','excluded',2952,1),Item('Y','food',351,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=73,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3303, member_saving=0, discount=892, threshold_off=0, payable=2411, applied=('P',)))

    def test_recorded_052(self):
        self.assertEqual(quote([Item('X','excluded',109,1),Item('Y','food',383,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=86,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=492, member_saving=0, discount=69, threshold_off=0, payable=423, applied=('P',)))

    def test_recorded_053(self):
        self.assertEqual(quote([Item('X','excluded',2025,1),Item('Y','food',209,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=42,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2234, member_saving=0, discount=1296, threshold_off=0, payable=938, applied=('P',)))

    def test_recorded_054(self):
        self.assertEqual(quote([Item('X','excluded',175,1),Item('Y','food',253,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=52,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=428, member_saving=0, discount=205, threshold_off=0, payable=223, applied=('P',)))

    def test_recorded_055(self):
        self.assertEqual(quote([Item('X','excluded',903,1),Item('Y','food',230,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=43,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1133, member_saving=0, discount=646, threshold_off=0, payable=487, applied=('P',)))

    def test_recorded_056(self):
        self.assertEqual(quote([Item('X','excluded',1698,1),Item('Y','food',27,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=40,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1725, member_saving=0, discount=1035, threshold_off=0, payable=690, applied=('P',)))

    def test_recorded_057(self):
        self.assertEqual(quote([Item('X','excluded',2079,1),Item('Y','food',140,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=21,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2219, member_saving=0, discount=1753, threshold_off=0, payable=466, applied=('P',)))

    def test_recorded_058(self):
        self.assertEqual(quote([Item('X','excluded',2386,1),Item('Y','food',357,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=55,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2743, member_saving=0, discount=1234, threshold_off=0, payable=1509, applied=('P',)))

    def test_recorded_059(self):
        self.assertEqual(quote([Item('X','excluded',2538,1),Item('Y','food',83,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=33,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2621, member_saving=0, discount=1756, threshold_off=0, payable=865, applied=('P',)))

    def test_recorded_060(self):
        self.assertEqual(quote([Item('X','excluded',765,1),Item('Y','food',450,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=54,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1215, member_saving=0, discount=559, threshold_off=0, payable=656, applied=('P',)))

    def test_recorded_061(self):
        self.assertEqual(quote([Item('X','excluded',1454,1),Item('Y','food',150,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=18,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1604, member_saving=0, discount=1315, threshold_off=0, payable=289, applied=('P',)))

    def test_recorded_062(self):
        self.assertEqual(quote([Item('X','excluded',4143,1),Item('Y','food',112,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=71,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4255, member_saving=0, discount=1234, threshold_off=0, payable=3021, applied=('P',)))

    def test_recorded_063(self):
        self.assertEqual(quote([Item('X','excluded',566,1),Item('Y','food',278,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=68,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=844, member_saving=0, discount=270, threshold_off=0, payable=574, applied=('P',)))

    def test_recorded_064(self):
        self.assertEqual(quote([Item('X','excluded',3521,1),Item('Y','food',478,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=71,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3999, member_saving=0, discount=1160, threshold_off=0, payable=2839, applied=('P',)))

    def test_recorded_065(self):
        self.assertEqual(quote([Item('X','excluded',4931,1),Item('Y','food',80,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=79,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5011, member_saving=0, discount=1052, threshold_off=0, payable=3959, applied=('P',)))

    def test_recorded_066(self):
        self.assertEqual(quote([Item('X','excluded',1425,1),Item('Y','food',307,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=53,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1732, member_saving=0, discount=814, threshold_off=0, payable=918, applied=('P',)))

    def test_recorded_067(self):
        self.assertEqual(quote([Item('X','excluded',3733,1),Item('Y','food',294,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=53,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4027, member_saving=0, discount=1893, threshold_off=0, payable=2134, applied=('P',)))

    def test_recorded_068(self):
        self.assertEqual(quote([Item('X','excluded',530,1),Item('Y','food',374,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=17,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=904, member_saving=0, discount=750, threshold_off=0, payable=154, applied=('P',)))

    def test_recorded_069(self):
        self.assertEqual(quote([Item('X','excluded',4961,1),Item('Y','food',323,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=52,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5284, member_saving=0, discount=2536, threshold_off=0, payable=2748, applied=('P',)))

    def test_recorded_070(self):
        self.assertEqual(quote([Item('X','excluded',1901,1),Item('Y','food',79,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=57,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1980, member_saving=0, discount=851, threshold_off=0, payable=1129, applied=('P',)))

    def test_recorded_071(self):
        self.assertEqual(quote([Item('X','excluded',3894,1),Item('Y','food',157,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=49,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4051, member_saving=0, discount=2066, threshold_off=0, payable=1985, applied=('P',)))

    def test_recorded_072(self):
        self.assertEqual(quote([Item('X','excluded',926,1),Item('Y','food',24,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=41,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=950, member_saving=0, discount=560, threshold_off=0, payable=390, applied=('P',)))

    def test_recorded_073(self):
        self.assertEqual(quote([Item('X','excluded',4506,1),Item('Y','food',260,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=81,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4766, member_saving=0, discount=906, threshold_off=0, payable=3860, applied=('P',)))

    def test_recorded_074(self):
        self.assertEqual(quote([Item('X','excluded',3882,1),Item('Y','food',471,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=18,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4353, member_saving=0, discount=3569, threshold_off=0, payable=784, applied=('P',)))

    def test_recorded_075(self):
        self.assertEqual(quote([Item('X','excluded',3701,1),Item('Y','food',173,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=18,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3874, member_saving=0, discount=3177, threshold_off=0, payable=697, applied=('P',)))

    def test_recorded_076(self):
        self.assertEqual(quote([Item('X','excluded',4448,1),Item('Y','food',145,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=41,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4593, member_saving=0, discount=2710, threshold_off=0, payable=1883, applied=('P',)))

    def test_recorded_077(self):
        self.assertEqual(quote([Item('X','excluded',4204,1),Item('Y','food',87,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=20,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4291, member_saving=0, discount=3433, threshold_off=0, payable=858, applied=('P',)))

    def test_recorded_078(self):
        self.assertEqual(quote([Item('X','excluded',3393,1),Item('Y','food',376,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=54,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3769, member_saving=0, discount=1734, threshold_off=0, payable=2035, applied=('P',)))

    def test_recorded_079(self):
        self.assertEqual(quote([Item('X','excluded',428,1),Item('Y','food',47,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=41,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=475, member_saving=0, discount=280, threshold_off=0, payable=195, applied=('P',)))

    def test_recorded_080(self):
        self.assertEqual(quote([Item('X','excluded',1448,1),Item('Y','food',184,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=15,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1632, member_saving=0, discount=1387, threshold_off=0, payable=245, applied=('P',)))

    def test_recorded_081(self):
        self.assertEqual(quote([Item('X','excluded',1896,1),Item('Y','food',453,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=36,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2349, member_saving=0, discount=1503, threshold_off=0, payable=846, applied=('P',)))

    def test_recorded_082(self):
        self.assertEqual(quote([Item('X','excluded',2713,1),Item('Y','food',463,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=16,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3176, member_saving=0, discount=2668, threshold_off=0, payable=508, applied=('P',)))

    def test_recorded_083(self):
        self.assertEqual(quote([Item('X','excluded',1134,1),Item('Y','food',413,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=36,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1547, member_saving=0, discount=990, threshold_off=0, payable=557, applied=('P',)))

    def test_recorded_084(self):
        self.assertEqual(quote([Item('X','excluded',1295,1),Item('Y','food',467,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=67,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1762, member_saving=0, discount=581, threshold_off=0, payable=1181, applied=('P',)))

    def test_recorded_085(self):
        self.assertEqual(quote([Item('X','excluded',3882,1),Item('Y','food',287,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=23,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4169, member_saving=0, discount=3210, threshold_off=0, payable=959, applied=('P',)))

    def test_recorded_086(self):
        self.assertEqual(quote([Item('X','excluded',1829,1),Item('Y','food',317,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=47,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2146, member_saving=0, discount=1137, threshold_off=0, payable=1009, applied=('P',)))

    def test_recorded_087(self):
        self.assertEqual(quote([Item('X','excluded',1879,1),Item('Y','food',54,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=22,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1933, member_saving=0, discount=1508, threshold_off=0, payable=425, applied=('P',)))

    def test_recorded_088(self):
        self.assertEqual(quote([Item('X','excluded',4452,1),Item('Y','food',138,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=59,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4590, member_saving=0, discount=1882, threshold_off=0, payable=2708, applied=('P',)))

    def test_recorded_089(self):
        self.assertEqual(quote([Item('X','excluded',3391,1),Item('Y','food',78,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=57,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3469, member_saving=0, discount=1492, threshold_off=0, payable=1977, applied=('P',)))

    def test_recorded_090(self):
        self.assertEqual(quote([Item('X','excluded',3040,1),Item('Y','food',253,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=35,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3293, member_saving=0, discount=2140, threshold_off=0, payable=1153, applied=('P',)))

    def test_recorded_091(self):
        self.assertEqual(quote([Item('X','excluded',4636,1),Item('Y','food',354,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=51,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4990, member_saving=0, discount=2445, threshold_off=0, payable=2545, applied=('P',)))

    def test_recorded_092(self):
        self.assertEqual(quote([Item('X','excluded',959,1),Item('Y','food',66,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=40,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1025, member_saving=0, discount=615, threshold_off=0, payable=410, applied=('P',)))

    def test_recorded_093(self):
        self.assertEqual(quote([Item('X','excluded',3749,1),Item('Y','food',214,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=82,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3963, member_saving=0, discount=713, threshold_off=0, payable=3250, applied=('P',)))

    def test_recorded_094(self):
        self.assertEqual(quote([Item('X','excluded',4845,1),Item('Y','food',80,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=85,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4925, member_saving=0, discount=739, threshold_off=0, payable=4186, applied=('P',)))

    def test_recorded_095(self):
        self.assertEqual(quote([Item('X','excluded',3524,1),Item('Y','food',338,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=24,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3862, member_saving=0, discount=2935, threshold_off=0, payable=927, applied=('P',)))

    def test_recorded_096(self):
        self.assertEqual(quote([Item('X','excluded',2507,1),Item('Y','food',46,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=49,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2553, member_saving=0, discount=1302, threshold_off=0, payable=1251, applied=('P',)))

    def test_recorded_097(self):
        self.assertEqual(quote([Item('X','excluded',1054,1),Item('Y','food',229,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=73,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1283, member_saving=0, discount=346, threshold_off=0, payable=937, applied=('P',)))

    def test_recorded_098(self):
        self.assertEqual(quote([Item('X','excluded',4027,1),Item('Y','food',190,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=41,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4217, member_saving=0, discount=2488, threshold_off=0, payable=1729, applied=('P',)))

    def test_recorded_099(self):
        self.assertEqual(quote([Item('X','excluded',1787,1),Item('Y','food',438,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=54,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2225, member_saving=0, discount=1023, threshold_off=0, payable=1202, applied=('P',)))

    def test_recorded_100(self):
        self.assertEqual(quote([Item('X','excluded',278,1),Item('Y','food',95,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=11,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=373, member_saving=0, discount=332, threshold_off=0, payable=41, applied=('P',)))

    def test_recorded_101(self):
        self.assertEqual(quote([Item('X','excluded',938,1),Item('Y','food',468,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=64,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1406, member_saving=0, discount=506, threshold_off=0, payable=900, applied=('P',)))

    def test_recorded_102(self):
        self.assertEqual(quote([Item('X','excluded',3933,1),Item('Y','food',448,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=16,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4381, member_saving=0, discount=3680, threshold_off=0, payable=701, applied=('P',)))

    def test_recorded_103(self):
        self.assertEqual(quote([Item('X','excluded',2947,1),Item('Y','food',334,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=76,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3281, member_saving=0, discount=787, threshold_off=0, payable=2494, applied=('P',)))

    def test_recorded_104(self):
        self.assertEqual(quote([Item('X','excluded',1439,1),Item('Y','food',191,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=76,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1630, member_saving=0, discount=391, threshold_off=0, payable=1239, applied=('P',)))

    def test_recorded_105(self):
        self.assertEqual(quote([Item('X','excluded',2961,1),Item('Y','food',77,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=28,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3038, member_saving=0, discount=2187, threshold_off=0, payable=851, applied=('P',)))

    def test_recorded_106(self):
        self.assertEqual(quote([Item('X','excluded',3012,1),Item('Y','food',494,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=78,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3506, member_saving=0, discount=771, threshold_off=0, payable=2735, applied=('P',)))

    def test_recorded_107(self):
        self.assertEqual(quote([Item('X','excluded',440,1),Item('Y','food',441,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=70,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=881, member_saving=0, discount=264, threshold_off=0, payable=617, applied=('P',)))

    def test_recorded_108(self):
        self.assertEqual(quote([Item('X','excluded',2163,1),Item('Y','food',420,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=19,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2583, member_saving=0, discount=2092, threshold_off=0, payable=491, applied=('P',)))

    def test_recorded_109(self):
        self.assertEqual(quote([Item('X','excluded',364,1),Item('Y','food',265,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=26,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=629, member_saving=0, discount=465, threshold_off=0, payable=164, applied=('P',)))

    def test_recorded_110(self):
        self.assertEqual(quote([Item('X','excluded',834,1),Item('Y','food',251,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=77,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1085, member_saving=0, discount=250, threshold_off=0, payable=835, applied=('P',)))

    def test_recorded_111(self):
        self.assertEqual(quote([Item('X','excluded',509,1),Item('Y','food',128,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=30,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=637, member_saving=0, discount=446, threshold_off=0, payable=191, applied=('P',)))

    def test_recorded_112(self):
        self.assertEqual(quote([Item('X','excluded',3530,1),Item('Y','food',82,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=24,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3612, member_saving=0, discount=2745, threshold_off=0, payable=867, applied=('P',)))

    def test_recorded_113(self):
        self.assertEqual(quote([Item('X','excluded',3455,1),Item('Y','food',72,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=48,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3527, member_saving=0, discount=1834, threshold_off=0, payable=1693, applied=('P',)))

    def test_recorded_114(self):
        self.assertEqual(quote([Item('X','excluded',1434,1),Item('Y','food',449,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=66,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1883, member_saving=0, discount=640, threshold_off=0, payable=1243, applied=('P',)))

    def test_recorded_115(self):
        self.assertEqual(quote([Item('X','excluded',1028,1),Item('Y','food',14,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=49,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1042, member_saving=0, discount=531, threshold_off=0, payable=511, applied=('P',)))

    def test_recorded_116(self):
        self.assertEqual(quote([Item('X','excluded',1623,1),Item('Y','food',256,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=21,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1879, member_saving=0, discount=1484, threshold_off=0, payable=395, applied=('P',)))

    def test_recorded_117(self):
        self.assertEqual(quote([Item('X','excluded',1620,1),Item('Y','food',459,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=45,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2079, member_saving=0, discount=1143, threshold_off=0, payable=936, applied=('P',)))

    def test_recorded_118(self):
        self.assertEqual(quote([Item('X','excluded',4576,1),Item('Y','food',231,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=87,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4807, member_saving=0, discount=625, threshold_off=0, payable=4182, applied=('P',)))

    def test_recorded_119(self):
        self.assertEqual(quote([Item('X','excluded',4920,1),Item('Y','food',353,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=57,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5273, member_saving=0, discount=2267, threshold_off=0, payable=3006, applied=('P',)))

    def test_recorded_120(self):
        self.assertEqual(quote([Item('X','excluded',2867,1),Item('Y','food',351,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=64,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3218, member_saving=0, discount=1158, threshold_off=0, payable=2060, applied=('P',)))

    def test_recorded_121(self):
        self.assertEqual(quote([Item('X','excluded',4034,1),Item('Y','food',446,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=62,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4480, member_saving=0, discount=1702, threshold_off=0, payable=2778, applied=('P',)))

    def test_recorded_122(self):
        self.assertEqual(quote([Item('X','excluded',1677,1),Item('Y','food',379,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=26,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2056, member_saving=0, discount=1521, threshold_off=0, payable=535, applied=('P',)))

    def test_recorded_123(self):
        self.assertEqual(quote([Item('X','excluded',4414,1),Item('Y','food',340,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=12,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4754, member_saving=0, discount=4184, threshold_off=0, payable=570, applied=('P',)))

    def test_recorded_124(self):
        self.assertEqual(quote([Item('X','excluded',1056,1),Item('Y','food',313,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=84,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1369, member_saving=0, discount=219, threshold_off=0, payable=1150, applied=('P',)))

    def test_recorded_125(self):
        self.assertEqual(quote([Item('X','excluded',4147,1),Item('Y','food',225,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=22,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4372, member_saving=0, discount=3410, threshold_off=0, payable=962, applied=('P',)))

    def test_recorded_126(self):
        self.assertEqual(quote([Item('X','excluded',1967,1),Item('Y','food',344,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=61,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2311, member_saving=0, discount=901, threshold_off=0, payable=1410, applied=('P',)))

    def test_recorded_127(self):
        self.assertEqual(quote([Item('X','excluded',2006,1),Item('Y','food',289,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=29,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2295, member_saving=0, discount=1629, threshold_off=0, payable=666, applied=('P',)))

    def test_recorded_128(self):
        self.assertEqual(quote([Item('X','excluded',1823,1),Item('Y','food',349,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=42,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2172, member_saving=0, discount=1260, threshold_off=0, payable=912, applied=('P',)))

    def test_recorded_129(self):
        self.assertEqual(quote([Item('X','excluded',3699,1),Item('Y','food',66,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=22,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3765, member_saving=0, discount=2937, threshold_off=0, payable=828, applied=('P',)))

    def test_recorded_130(self):
        self.assertEqual(quote([Item('X','excluded',3912,1),Item('Y','food',323,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=54,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4235, member_saving=0, discount=1948, threshold_off=0, payable=2287, applied=('P',)))

    def test_recorded_131(self):
        self.assertEqual(quote([Item('X','excluded',4805,1),Item('Y','food',419,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=47,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5224, member_saving=0, discount=2769, threshold_off=0, payable=2455, applied=('P',)))

    def test_recorded_132(self):
        self.assertEqual(quote([Item('X','excluded',244,1),Item('Y','food',436,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=80,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=680, member_saving=0, discount=136, threshold_off=0, payable=544, applied=('P',)))

    def test_recorded_133(self):
        self.assertEqual(quote([Item('X','excluded',1936,1),Item('Y','food',40,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=40,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1976, member_saving=0, discount=1186, threshold_off=0, payable=790, applied=('P',)))

    def test_recorded_134(self):
        self.assertEqual(quote([Item('X','excluded',1633,1),Item('Y','food',270,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=22,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1903, member_saving=0, discount=1484, threshold_off=0, payable=419, applied=('P',)))

    def test_recorded_135(self):
        self.assertEqual(quote([Item('X','excluded',4020,1),Item('Y','food',410,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=30,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4430, member_saving=0, discount=3101, threshold_off=0, payable=1329, applied=('P',)))

    def test_recorded_136(self):
        self.assertEqual(quote([Item('X','excluded',421,1),Item('Y','food',285,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=14,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=706, member_saving=0, discount=607, threshold_off=0, payable=99, applied=('P',)))

    def test_recorded_137(self):
        self.assertEqual(quote([Item('X','excluded',4711,1),Item('Y','food',354,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=76,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5065, member_saving=0, discount=1216, threshold_off=0, payable=3849, applied=('P',)))

    def test_recorded_138(self):
        self.assertEqual(quote([Item('X','excluded',4544,1),Item('Y','food',486,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=43,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5030, member_saving=0, discount=2867, threshold_off=0, payable=2163, applied=('P',)))

    def test_recorded_139(self):
        self.assertEqual(quote([Item('X','excluded',2711,1),Item('Y','food',42,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=80,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2753, member_saving=0, discount=551, threshold_off=0, payable=2202, applied=('P',)))

    def test_recorded_140(self):
        self.assertEqual(quote([Item('X','excluded',3819,1),Item('Y','food',258,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=52,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4077, member_saving=0, discount=1957, threshold_off=0, payable=2120, applied=('P',)))

    def test_recorded_141(self):
        self.assertEqual(quote([Item('X','excluded',478,1),Item('Y','food',216,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=44,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=694, member_saving=0, discount=389, threshold_off=0, payable=305, applied=('P',)))

    def test_recorded_142(self):
        self.assertEqual(quote([Item('X','excluded',4566,1),Item('Y','food',363,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=66,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4929, member_saving=0, discount=1676, threshold_off=0, payable=3253, applied=('P',)))

    def test_recorded_143(self):
        self.assertEqual(quote([Item('X','excluded',1158,1),Item('Y','food',247,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=14,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1405, member_saving=0, discount=1208, threshold_off=0, payable=197, applied=('P',)))

    def test_recorded_144(self):
        self.assertEqual(quote([Item('X','excluded',3343,1),Item('Y','food',251,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=86,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3594, member_saving=0, discount=503, threshold_off=0, payable=3091, applied=('P',)))

    def test_recorded_145(self):
        self.assertEqual(quote([Item('X','excluded',1949,1),Item('Y','food',436,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=86,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2385, member_saving=0, discount=334, threshold_off=0, payable=2051, applied=('P',)))

    def test_recorded_146(self):
        self.assertEqual(quote([Item('X','excluded',4176,1),Item('Y','food',17,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=30,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4193, member_saving=0, discount=2935, threshold_off=0, payable=1258, applied=('P',)))

    def test_recorded_147(self):
        self.assertEqual(quote([Item('X','excluded',1911,1),Item('Y','food',151,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=56,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2062, member_saving=0, discount=907, threshold_off=0, payable=1155, applied=('P',)))

    def test_recorded_148(self):
        self.assertEqual(quote([Item('X','excluded',4753,1),Item('Y','food',433,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=40,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=5186, member_saving=0, discount=3112, threshold_off=0, payable=2074, applied=('P',)))

    def test_recorded_149(self):
        self.assertEqual(quote([Item('X','excluded',2890,1),Item('Y','food',403,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=15,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3293, member_saving=0, discount=2799, threshold_off=0, payable=494, applied=('P',)))

    def test_recorded_150(self):
        self.assertEqual(quote([Item('X','excluded',4121,1),Item('Y','food',20,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=27,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4141, member_saving=0, discount=3023, threshold_off=0, payable=1118, applied=('P',)))

    def test_recorded_151(self):
        self.assertEqual(quote([Item('X','excluded',2281,1),Item('Y','food',431,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=88,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2712, member_saving=0, discount=325, threshold_off=0, payable=2387, applied=('P',)))

    def test_recorded_152(self):
        self.assertEqual(quote([Item('X','excluded',167,1),Item('Y','food',384,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=45,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=551, member_saving=0, discount=303, threshold_off=0, payable=248, applied=('P',)))

    def test_recorded_153(self):
        self.assertEqual(quote([Item('X','excluded',2953,1),Item('Y','food',415,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=24,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3368, member_saving=0, discount=2560, threshold_off=0, payable=808, applied=('P',)))

    def test_recorded_154(self):
        self.assertEqual(quote([Item('X','excluded',3023,1),Item('Y','food',378,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=58,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3401, member_saving=0, discount=1428, threshold_off=0, payable=1973, applied=('P',)))

    def test_recorded_155(self):
        self.assertEqual(quote([Item('X','excluded',523,1),Item('Y','food',240,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=15,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=763, member_saving=0, discount=649, threshold_off=0, payable=114, applied=('P',)))

    def test_recorded_156(self):
        self.assertEqual(quote([Item('X','excluded',3697,1),Item('Y','food',406,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=78,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4103, member_saving=0, discount=903, threshold_off=0, payable=3200, applied=('P',)))

    def test_recorded_157(self):
        self.assertEqual(quote([Item('X','excluded',281,1),Item('Y','food',108,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=16,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=389, member_saving=0, discount=327, threshold_off=0, payable=62, applied=('P',)))

    def test_recorded_158(self):
        self.assertEqual(quote([Item('X','excluded',1403,1),Item('Y','food',207,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=55,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1610, member_saving=0, discount=724, threshold_off=0, payable=886, applied=('P',)))

    def test_recorded_159(self):
        self.assertEqual(quote([Item('X','excluded',3020,1),Item('Y','food',325,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=20,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3345, member_saving=0, discount=2676, threshold_off=0, payable=669, applied=('P',)))

    def test_recorded_160(self):
        self.assertEqual(quote([Item('X','excluded',3856,1),Item('Y','food',109,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=30,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3965, member_saving=0, discount=2775, threshold_off=0, payable=1190, applied=('P',)))

    def test_recorded_161(self):
        self.assertEqual(quote([Item('X','excluded',1246,1),Item('Y','food',287,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=38,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1533, member_saving=0, discount=950, threshold_off=0, payable=583, applied=('P',)))

    def test_recorded_162(self):
        self.assertEqual(quote([Item('X','excluded',3769,1),Item('Y','food',226,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=58,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3995, member_saving=0, discount=1678, threshold_off=0, payable=2317, applied=('P',)))

    def test_recorded_163(self):
        self.assertEqual(quote([Item('X','excluded',3885,1),Item('Y','food',291,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=42,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4176, member_saving=0, discount=2422, threshold_off=0, payable=1754, applied=('P',)))

    def test_recorded_164(self):
        self.assertEqual(quote([Item('X','excluded',4085,1),Item('Y','food',466,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=16,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4551, member_saving=0, discount=3823, threshold_off=0, payable=728, applied=('P',)))

    def test_recorded_165(self):
        self.assertEqual(quote([Item('X','excluded',428,1),Item('Y','food',94,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=32,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=522, member_saving=0, discount=355, threshold_off=0, payable=167, applied=('P',)))

    def test_recorded_166(self):
        self.assertEqual(quote([Item('X','excluded',3730,1),Item('Y','food',73,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=65,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3803, member_saving=0, discount=1331, threshold_off=0, payable=2472, applied=('P',)))

    def test_recorded_167(self):
        self.assertEqual(quote([Item('X','excluded',2550,1),Item('Y','food',109,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=71,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2659, member_saving=0, discount=771, threshold_off=0, payable=1888, applied=('P',)))

    def test_recorded_168(self):
        self.assertEqual(quote([Item('X','excluded',1169,1),Item('Y','food',179,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=10,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1348, member_saving=0, discount=1213, threshold_off=0, payable=135, applied=('P',)))

    def test_recorded_169(self):
        self.assertEqual(quote([Item('X','excluded',3630,1),Item('Y','food',464,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=57,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4094, member_saving=0, discount=1760, threshold_off=0, payable=2334, applied=('P',)))

    def test_recorded_170(self):
        self.assertEqual(quote([Item('X','excluded',2613,1),Item('Y','food',207,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=32,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2820, member_saving=0, discount=1918, threshold_off=0, payable=902, applied=('P',)))

    def test_recorded_171(self):
        self.assertEqual(quote([Item('X','excluded',1059,1),Item('Y','food',452,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=19,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1511, member_saving=0, discount=1224, threshold_off=0, payable=287, applied=('P',)))

    def test_recorded_172(self):
        self.assertEqual(quote([Item('X','excluded',1109,1),Item('Y','food',463,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=59,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1572, member_saving=0, discount=645, threshold_off=0, payable=927, applied=('P',)))

    def test_recorded_173(self):
        self.assertEqual(quote([Item('X','excluded',4153,1),Item('Y','food',427,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=59,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4580, member_saving=0, discount=1878, threshold_off=0, payable=2702, applied=('P',)))

    def test_recorded_174(self):
        self.assertEqual(quote([Item('X','excluded',687,1),Item('Y','food',282,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=19,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=969, member_saving=0, discount=785, threshold_off=0, payable=184, applied=('P',)))

    def test_recorded_175(self):
        self.assertEqual(quote([Item('X','excluded',3172,1),Item('Y','food',226,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=34,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3398, member_saving=0, discount=2243, threshold_off=0, payable=1155, applied=('P',)))

    def test_recorded_176(self):
        self.assertEqual(quote([Item('X','excluded',1244,1),Item('Y','food',85,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=86,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1329, member_saving=0, discount=186, threshold_off=0, payable=1143, applied=('P',)))

    def test_recorded_177(self):
        self.assertEqual(quote([Item('X','excluded',1105,1),Item('Y','food',286,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=38,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1391, member_saving=0, discount=862, threshold_off=0, payable=529, applied=('P',)))

    def test_recorded_178(self):
        self.assertEqual(quote([Item('X','excluded',208,1),Item('Y','food',23,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=80,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=231, member_saving=0, discount=46, threshold_off=0, payable=185, applied=('P',)))

    def test_recorded_179(self):
        self.assertEqual(quote([Item('X','excluded',4032,1),Item('Y','food',41,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=81,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4073, member_saving=0, discount=774, threshold_off=0, payable=3299, applied=('P',)))

    def test_recorded_180(self):
        self.assertEqual(quote([Item('X','excluded',1362,1),Item('Y','food',331,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=49,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1693, member_saving=0, discount=863, threshold_off=0, payable=830, applied=('P',)))

    def test_recorded_181(self):
        self.assertEqual(quote([Item('X','excluded',1544,1),Item('Y','food',485,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=69,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2029, member_saving=0, discount=629, threshold_off=0, payable=1400, applied=('P',)))

    def test_recorded_182(self):
        self.assertEqual(quote([Item('X','excluded',2461,1),Item('Y','food',321,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=21,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2782, member_saving=0, discount=2198, threshold_off=0, payable=584, applied=('P',)))

    def test_recorded_183(self):
        self.assertEqual(quote([Item('X','excluded',4574,1),Item('Y','food',77,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=71,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4651, member_saving=0, discount=1349, threshold_off=0, payable=3302, applied=('P',)))

    def test_recorded_184(self):
        self.assertEqual(quote([Item('X','excluded',1394,1),Item('Y','food',256,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=29,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1650, member_saving=0, discount=1172, threshold_off=0, payable=478, applied=('P',)))

    def test_recorded_185(self):
        self.assertEqual(quote([Item('X','excluded',3947,1),Item('Y','food',84,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=87,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4031, member_saving=0, discount=524, threshold_off=0, payable=3507, applied=('P',)))

    def test_recorded_186(self):
        self.assertEqual(quote([Item('X','excluded',2639,1),Item('Y','food',30,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=52,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2669, member_saving=0, discount=1281, threshold_off=0, payable=1388, applied=('P',)))

    def test_recorded_187(self):
        self.assertEqual(quote([Item('X','excluded',3504,1),Item('Y','food',299,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=74,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3803, member_saving=0, discount=989, threshold_off=0, payable=2814, applied=('P',)))

    def test_recorded_188(self):
        self.assertEqual(quote([Item('X','excluded',1346,1),Item('Y','food',425,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=17,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1771, member_saving=0, discount=1470, threshold_off=0, payable=301, applied=('P',)))

    def test_recorded_189(self):
        self.assertEqual(quote([Item('X','excluded',1822,1),Item('Y','food',241,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=56,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2063, member_saving=0, discount=908, threshold_off=0, payable=1155, applied=('P',)))

    def test_recorded_190(self):
        self.assertEqual(quote([Item('X','excluded',997,1),Item('Y','food',324,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=20,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1321, member_saving=0, discount=1057, threshold_off=0, payable=264, applied=('P',)))

    def test_recorded_191(self):
        self.assertEqual(quote([Item('X','excluded',999,1),Item('Y','food',290,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=51,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1289, member_saving=0, discount=632, threshold_off=0, payable=657, applied=('P',)))

    def test_recorded_192(self):
        self.assertEqual(quote([Item('X','excluded',4379,1),Item('Y','food',38,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=26,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4417, member_saving=0, discount=3269, threshold_off=0, payable=1148, applied=('P',)))

    def test_recorded_193(self):
        self.assertEqual(quote([Item('X','excluded',1245,1),Item('Y','food',366,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=87,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1611, member_saving=0, discount=209, threshold_off=0, payable=1402, applied=('P',)))

    def test_recorded_194(self):
        self.assertEqual(quote([Item('X','excluded',1031,1),Item('Y','food',54,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=81,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=1085, member_saving=0, discount=206, threshold_off=0, payable=879, applied=('P',)))

    def test_recorded_195(self):
        self.assertEqual(quote([Item('X','excluded',2869,1),Item('Y','food',95,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=32,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2964, member_saving=0, discount=2016, threshold_off=0, payable=948, applied=('P',)))

    def test_recorded_196(self):
        self.assertEqual(quote([Item('X','excluded',3792,1),Item('Y','food',120,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=33,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=3912, member_saving=0, discount=2621, threshold_off=0, payable=1291, applied=('P',)))

    def test_recorded_197(self):
        self.assertEqual(quote([Item('X','excluded',4326,1),Item('Y','food',179,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=50,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=4505, member_saving=0, discount=2253, threshold_off=0, payable=2252, applied=('P',)))

    def test_recorded_198(self):
        self.assertEqual(quote([Item('X','excluded',1627,1),Item('Y','food',478,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=16,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2105, member_saving=0, discount=1768, threshold_off=0, payable=337, applied=('P',)))

    def test_recorded_199(self):
        self.assertEqual(quote([Item('X','excluded',2630,1),Item('Y','food',154,1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent=62,excluded_categories=frozenset({'excluded'}))],NOW),Quote(subtotal=2784, member_saving=0, discount=1058, threshold_off=0, payable=1726, applied=('P',)))
