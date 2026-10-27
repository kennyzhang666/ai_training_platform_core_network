"""生成固定的校准交付件，不把校准件打入评测引擎。"""
import importlib.util
import random
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = """import unittest
from datetime import datetime, timedelta, timezone
from pricing import Item, Coupon, Quote, PricingError, quote
TZ = timezone(timedelta(hours=8))
NOW = datetime(2026, 11, 15, 10, tzinfo=TZ)
START = datetime(2026, 11, 1, tzinfo=TZ)
END = datetime(2026, 12, 1, tzinfo=TZ)
"""
TEMPLATE = {
    'DEFECTS.md':'# 缺陷报告\n\n| 缺陷编号 | 条款 | 失败测试 | 期望 | 实际 |\n| --- | --- | --- | --- | --- |\n',
    'TEST_PLAN.md':'# 测试设计\n\n'+'\n'.join('## '+h+'\n\n已检查。\n' for h in ['等价类与边界','组合策略','规格空白','变更影响','不覆盖说明']),
    'AI_WORKLOG.md':'# AI 协作记录\n\n'+'\n'.join('## '+h+'\n\n已完成。\n' for h in ['约束下达','AI 输出核验','失败判定','迭代记录'])
}


def save(name, source):
    folder = ROOT / 'calibration' / name
    (folder / 'tests').mkdir(parents=True, exist_ok=True)
    (folder / 'tests/test_quote.py').write_text(source.rstrip() + '\n', encoding='utf-8', newline='\n')
    for file, content in TEMPLATE.items():
        (folder / file).write_text(content, encoding='utf-8', newline='\n')


def generate():
    spec = importlib.util.spec_from_file_location('pricing', ROOT/'starter/src/pricing.py')
    pricing = importlib.util.module_from_spec(spec)
    sys.modules['pricing'] = pricing
    spec.loader.exec_module(pricing)
    from datetime import datetime, timedelta, timezone
    now = datetime(2026,11,15,10,tzinfo=timezone(timedelta(hours=8)))
    start, end = now-timedelta(days=10), now+timedelta(days=10)
    rng = random.Random(20261115)
    samples = []
    for i in range(200):
        prices = [rng.randint(101,5000), rng.randint(1,500)]
        percent = rng.randint(10,90)
        cart = [pricing.Item('X','excluded',prices[0],1),pricing.Item('Y','food',prices[1],1)]
        coupon = pricing.Coupon('P','PERCENT',start,end,percent=percent,excluded_categories=frozenset({'excluded'}))
        expected = pricing.quote(cart,[coupon],now)
        samples.append((prices,percent,repr(expected)))
    source = PREFIX + '\nclass SnapshotTests(unittest.TestCase):\n'
    for i,(prices,percent,expected) in enumerate(samples):
        source += f"    def test_recorded_{i:03d}(self):\n        self.assertEqual(quote([Item('X','excluded',{prices[0]},1),Item('Y','food',{prices[1]},1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent={percent},excluded_categories=frozenset({{'excluded'}}))],NOW),{expected})\n\n"
    save('snapshot',source)
    # 实现导向的合成校准件：录制当前实现输出，不宣称进行了独立 AI 盲测。
    save('ai-direct',PREFIX+"\nclass ImplementationTests(unittest.TestCase):\n"+''.join(f"    def test_from_implementation_{i}(self):\n        self.assertEqual(quote([Item('X','excluded',{prices[0]},1),Item('Y','food',{prices[1]},1)],[Coupon('P','PERCENT',NOW-timedelta(days=10),NOW+timedelta(days=10),percent={percent},excluded_categories=frozenset({{'excluded'}}))],NOW),{expected})\n" for i,(prices,percent,expected) in enumerate(samples[:4])))
    save('spec-guess',PREFIX+"""
class GuessTests(unittest.TestCase):
    def test_threshold_guess(self):
        self.assertEqual(quote([Item('A','',1000,1)],[Coupon('P','PERCENT',START,END,percent=80),Coupon('T','THRESHOLD',START,END,threshold=900,amount=100)],NOW),Quote(1000,0,200,100,700,('P','T')))
    def test_rounding_guess(self):
        self.assertEqual(quote([Item('A','',15,1),Item('B','',15,1)],[Coupon('P','PERCENT',START,END,percent=90)],NOW),Quote(30,0,2,0,28,('P',)))
    def test_actual_amount_guess(self):
        self.assertEqual(quote([Item('A','',100,1)],[Coupon('T','THRESHOLD',START,END,threshold=0,amount=1000)],NOW),Quote(100,0,0,1000,0,('T',)))
""")
    save('legacy-only',(ROOT/'starter/tests/legacy_test_quote.py').read_text(encoding='utf-8'))
    save('happy-path',PREFIX+"""
class HappyTests(unittest.TestCase):
    def test_without_coupon(self):
        self.assertEqual(quote([Item('A','',1000,1)],[],NOW),Quote(1000,0,0,0,1000,()))
    def test_percent(self):
        self.assertEqual(quote([Item('A','',1000,1)],[Coupon('P','PERCENT',START,END,percent=90)],NOW),Quote(1000,0,100,0,900,('P',)))
    def test_threshold(self):
        self.assertEqual(quote([Item('A','',1000,1)],[Coupon('T','THRESHOLD',START,END,threshold=900,amount=100)],NOW),Quote(1000,0,0,100,900,('T',)))
""")
    save('assert-false',PREFIX+"\nclass FailTests(unittest.TestCase):\n    def test_one(self):\n        self.fail()\n    def test_two(self):\n        self.fail()\n")
    save('cheat',PREFIX+"\nimport pricing\nclass PrivateTests(unittest.TestCase):\n    def test_identification(self):\n        self.assertTrue(pricing.__file__.endswith('pricing.py'))\n")
    save('flaky',PREFIX+"""
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
""")
    shutil.copytree(ROOT/'engine/assets/oracle',ROOT/'calibration/oracle',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    print('校准件生成完成（固定种子 20261115）')


if __name__ == '__main__':
    generate()
