"""赛题、变体与判题规则的回归验收，不使用真实人员数据。"""
import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'engine'))
import judge
import lint


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = {}

    def grade(self, name):
        if name not in self.results:
            workspace = ROOT / ('engine/assets/oracle' if name == 'oracle' else f'calibration/{name}')
            self.results[name] = judge.evaluate_workspace(workspace)
        return self.results[name]

    def test_oracle_and_all_variants(self):
        result = self.grade('oracle')
        self.assertEqual(result['total'], 100)
        self.assertTrue(all(c['level'] == 'A' for c in result['criteria']))
        detail = result['verifyDetail']
        self.assertEqual(detail['invalidTests'], [])
        self.assertEqual(detail['mutation']['killed'], 40)
        self.assertEqual(detail['defectsFound'], 4)

    def test_calibration(self):
        result = self.grade('ai-direct')
        self.assertLessEqual(result['total'], 60)
        self.assertLessEqual(result['verifyDetail']['defectsFound'], 1)
        result = self.grade('spec-guess')
        self.assertGreaterEqual(result['metrics']['misreadGaps'], 2)
        self.assertIn(next(c for c in result['criteria'] if c['key'] == 'V3')['level'], ['C', 'D'])
        result = self.grade('snapshot')
        self.assertLessEqual(result['dimensions']['verify']['score'], 5)
        self.assertGreaterEqual(len(result['verifyDetail']['invalidTests']), 180)
        result = self.grade('legacy-only')
        self.assertEqual(result['metrics']['outdatedAssertions'], 2)
        self.assertEqual(result['metrics']['fixedBugAssertions'], 1)
        self.assertEqual(next(c for c in result['criteria'] if c['key'] == 'V4')['level'], 'D')
        result = self.grade('happy-path')
        self.assertLessEqual(sum(c['score'] for c in result['criteria'] if c['key'] in ['V2', 'V3']), 6)
        self.assertEqual(self.grade('assert-false')['dimensions']['verify']['score'], 0)
        result = self.grade('cheat')
        self.assertEqual(result['dimensions']['verify']['score'], 0)
        self.assertTrue(any('识别被测变体' in f['title'] for f in result['findings']))
        result = self.grade('flaky')
        self.assertTrue(result['verifyDetail']['unstableTests'])
        self.assertNotEqual(next(c for c in result['criteria'] if c['key'] == 'C4')['level'], 'A')

    def test_frozen_manifest_and_no_duplicate_bug_signatures(self):
        variants = ROOT / 'engine/assets/variants'
        manifest = json.loads((variants / 'manifest.json').read_text(encoding='utf-8'))
        for item in manifest['variants']:
            self.assertEqual(hashlib.sha256((variants / item['path']).read_bytes()).hexdigest(), item['sha256'])
        detail = judge.inspect_variants(ROOT / 'engine/assets/oracle')
        bugs = [set(detail['failedByVariant'][f'B{i}']) for i in range(1, 5)]
        combined = set(detail['starterFailed'])
        self.assertEqual(combined, set().union(*bugs))
        for item in manifest['variants']:
            if item['type'] == 'mutant':
                failures = set(detail['failedByVariant'][item['id']])
                self.assertTrue(failures)
                self.assertNotIn(failures, bugs)

    def test_static_checks_and_no_hidden_source_in_results(self):
        for source in ['import os', 'from pricing import __file__', 'import pricing as p\nx = p.__dict__', 'open("x")', 'getattr(pricing, "__file__")']:
            self.assertTrue(lint.analyze(source)['violations'], source)
        for name in ['oracle', 'legacy-only', 'spec-guess', 'cheat']:
            serialized = json.dumps(self.grade(name), ensure_ascii=False)
            self.assertNotRegex(serialized, r'(?<![A-Za-z0-9])(?:M\d{2}|B[1-4])(?:[^A-Za-z0-9]|$)')
            self.assertNotIn('variants/', serialized)
            self.assertNotIn('round(base * coupon.percent / 100)', serialized)

    def test_empty_and_syntax_error_receive_no_validation_credit(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / 'tests').mkdir()
            for source in ['', 'def test_broken(:']:
                (root / 'tests/test_quote.py').write_text(source, encoding='utf-8')
                result = judge.evaluate_workspace(root)
                self.assertEqual(result['dimensions']['verify']['score'], 0)

    def test_subtest_failure_invalidates_the_whole_method(self):
        source = '''import unittest
class Cases(unittest.TestCase):
    def test_data(self):
        for actual in [1, 2]:
            with self.subTest(actual=actual):
                self.assertEqual(actual, 1)
'''
        result = judge.run_suite(ROOT/'engine/assets/variants/reference.py',source)
        self.assertEqual(len(result['records']),1)
        self.assertEqual(result['records'][0]['outcome'],'fail')
        self.assertEqual(result['records'][0]['line'],6)

    def test_class_fixture_error_is_not_silently_accepted(self):
        source = '''import unittest
class Cases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raise ValueError('fixture failed')
    def test_data(self):
        self.assertEqual(1,1)
'''
        result = judge.run_suite(ROOT/'engine/assets/variants/reference.py',source)
        self.assertTrue(any(row['id']=='__collection__' for row in result['records']))

    def test_reference_timeout_invalidates_even_previously_passed_methods(self):
        with patch.object(judge,'run_suite',return_value={'records':[{'id':'test_quote.QuoteTests.test_R5_rounding','outcome':'pass','message':''}],'timeout':True,'processFailed':True,'seconds':10}):
            result = judge.evaluate_workspace(ROOT/'engine/assets/oracle')
        self.assertEqual(result['dimensions']['verify']['score'],0)
        self.assertEqual(result['verifyDetail']['validTests'],[])
        self.assertTrue(any(item['title']=='测试套件超时' for item in result['findings']))


if __name__ == '__main__':
    unittest.main()
