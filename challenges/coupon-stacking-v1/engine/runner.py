"""在单独的 Python 进程中加载一个实现及学员测试，逐测试记录结果。"""
import argparse
import importlib.util
import json
import random
import sys
import unittest
from pathlib import Path


class Result(unittest.TestResult):
    def __init__(self, output, failfast):
        super().__init__()
        self.output = output
        self.failfast = failfast
        self.current = None

    def startTest(self, test):
        super().startTest(test)
        self.current = {'id': test.id(), 'outcome': 'pass', 'message': ''}

    def failure(self, outcome, err):
        line = 1
        traceback = err[2] if isinstance(err, tuple) else None
        while traceback is not None:
            if Path(traceback.tb_frame.f_code.co_filename).name == 'test_quote.py':
                line = traceback.tb_lineno
            traceback = traceback.tb_next
        message = str(err[1] if isinstance(err, tuple) else err)[:500]
        if self.current is None:
            self.output.write(json.dumps({'id':'__collection__','outcome':'error','message':message,'line':line},ensure_ascii=False)+'\n')
            self.output.flush()
        else:
            self.current.update(outcome=outcome, message=message, line=line)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.failure('fail', err)

    def addError(self, test, err):
        super().addError(test, err)
        self.failure('error', err)

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err: self.failure('fail' if issubclass(err[0], AssertionError) else 'error', err)

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.failure('error', '测试被跳过')

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.failure('error', '测试标记为预期失败')

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.failure('error', '预期失败标记不适用于本题')

    def stopTest(self, test):
        self.output.write(json.dumps(self.current, ensure_ascii=False) + '\n')
        self.output.flush()
        super().stopTest(test)
        self.current = None


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite): yield from flatten(item)
        else: yield item


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--order-seed', type=int, required=True)
    parser.add_argument('--ids')
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.directory).resolve()))
    with Path(args.output).open('w', encoding='utf-8', newline='\n') as output:
        try:
            spec = importlib.util.spec_from_file_location('test_quote', Path(args.directory) / 'test_quote.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules['test_quote'] = module
            spec.loader.exec_module(module)
            tests = sorted(flatten(unittest.defaultTestLoader.loadTestsFromModule(module)), key=lambda t: t.id())
            if not tests:
                raise ValueError('没有发现可运行的 unittest 测试：' + ','.join(dir(module)))
            if args.ids is not None:
                selected = set(json.loads(Path(args.ids).read_text(encoding='utf-8')))
                tests = [test for test in tests if test.id() in selected]
            random.Random(args.order_seed).shuffle(tests)
            result = Result(output, args.ids is not None)
            unittest.TestSuite(tests).run(result)
        except Exception as error:
            output.write(json.dumps({'id': '__collection__', 'outcome': 'error', 'message': f'{type(error).__name__}: {str(error)[:400]}'}, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
