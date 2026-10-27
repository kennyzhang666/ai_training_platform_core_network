"""对学员唯一测试入口做 AST 检查，不执行测试。"""
import ast
import re
from collections import Counter

ALLOWED = {'unittest', 'datetime', 'dataclasses', 'decimal', 'fractions', 'itertools', 'functools', 'random', 'math', 'string', 'collections', 'typing', 'pricing'}
FORBIDDEN_CALLS = {'open', 'exec', 'eval', 'compile', '__import__', 'globals', 'locals', 'vars', 'breakpoint', 'input'}
PRIVATE = {'__file__', '__dict__', '__spec__', '__loader__', '__builtins__', '__globals__', '__subclasses__'}


def analyze(source):
    result = {'violations': [], 'syntaxError': False, 'testIds': [], 'methods': 0, 'tableMethods': 0, 'clauseMethods': 0, 'duplicates': False, 'assertions': True, 'lowInformation': False, 'swallowed': False, 'skips': False, 'floatAssertions': False, 'almostEqual': False, 'roundCalls': False, 'privateAccess': False}
    try:
        tree = ast.parse(source)
    except SyntaxError:
        result['syntaxError'] = True
        result['assertions'] = False
        return result
    aliases = {'pricing'}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split('.')[0] not in ALLOWED or '.' in alias.name:
                    result['violations'].append({'line': node.lineno, 'rule': '导入范围'})
                if alias.name == 'pricing': aliases.add(alias.asname or alias.name)
        if isinstance(node, ast.ImportFrom):
            if node.level or node.module not in ALLOWED:
                result['violations'].append({'line': node.lineno, 'rule': '导入范围'})
            if node.module == 'pricing' and any(a.name.startswith('_') or a.name == '*' for a in node.names):
                result['privateAccess'] = True
        if isinstance(node, ast.Attribute):
            if node.attr in PRIVATE or (isinstance(node.value, ast.Name) and node.value.id in aliases and node.attr.startswith('_')):
                result['privateAccess'] = True
        if isinstance(node, ast.Call):
            name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else ''
            if name in FORBIDDEN_CALLS:
                result['violations'].append({'line': node.lineno, 'rule': '禁止的调用'})
            if name in {'getattr', 'setattr', 'delattr'} and node.args:
                if (isinstance(node.args[0], ast.Name) and node.args[0].id in aliases) or any(isinstance(a, ast.Constant) and a.value in PRIVATE for a in node.args[1:2]):
                    result['privateAccess'] = True
            if name == 'round': result['roundCalls'] = True
            if name in {'skip', 'skipIf', 'skipUnless', 'skipTest', 'expectedFailure'}: result['skips'] = True
        if isinstance(node, ast.Attribute) and node.attr in {'skip', 'skipIf', 'skipUnless', 'expectedFailure'}:
            result['skips'] = True
        if isinstance(node, ast.ExceptHandler):
            if node.type is None or any(isinstance(n, ast.Name) and n.id in {'AssertionError', 'Exception', 'BaseException'} for n in ast.walk(node.type)):
                result['swallowed'] = True
    lines = source.splitlines()
    for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
        methods = [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith('test_')]
        result['duplicates'] |= any(count > 1 for count in Counter(m.name for m in methods).values())
        for method in methods:
            result['methods'] += 1
            result['testIds'].append(f'test_quote.{cls.name}.{method.name}')
            snippet = '\n'.join(lines[method.lineno-1:method.end_lineno])
            result['clauseMethods'] += bool(re.search(r'\bR[1-8]\b|R[1-8]_', snippet))
            nodes = list(ast.walk(method))
            calls = [n for n in nodes if isinstance(n, ast.Call)]
            assertions = [n for n in calls if isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == 'self' and n.func.attr.startswith('assert')]
            result['assertions'] &= bool(assertions)
            result['tableMethods'] += any(isinstance(n, (ast.For, ast.AsyncFor)) or (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == 'subTest') for n in nodes)
            for call in assertions:
                if call.func.attr in {'assertTrue', 'assertFalse'} and call.args and isinstance(call.args[0], ast.Compare): result['lowInformation'] = True
                if call.func.attr in {'assertIsNotNone', 'assertIsNone'}: result['lowInformation'] = True
                if call.func.attr == 'assertAlmostEqual': result['almostEqual'] = True
                if any(isinstance(n, ast.Constant) and isinstance(n.value, float) for arg in call.args for n in ast.walk(arg)): result['floatAssertions'] = True
    if result['privateAccess']:
        result['violations'].append({'line': 1, 'rule': '访问被测模块私有信息'})
    return result
