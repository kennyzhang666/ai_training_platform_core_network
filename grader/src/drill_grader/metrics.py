from __future__ import annotations

import ast
from pathlib import Path
from typing import Any


NEUTRAL_NUMBERS = {0, 1, -1, 2}


class PythonMetrics(ast.NodeVisitor):
    def __init__(self) -> None:
        self.magic_numbers: list[dict[str, Any]] = []
        self.max_complexity = 1
        self.exception_handlers = 0
        self.float_literals = 0
        self._complexity_stack: list[int] = []
        self._module_level = False

    @staticmethod
    def _is_named_constant(target: ast.AST) -> bool:
        return isinstance(target, ast.Name) and target.id.isupper()

    def visit_Module(self, node: ast.Module) -> None:
        self._module_level = True
        for child in node.body:
            self.visit(child)
        self._module_level = False

    def visit_Assign(self, node: ast.Assign) -> None:
        # An upper-case assignment is an explicit named constant. This is
        # intentionally allowed both at module scope and inside a helper so a
        # unit-conversion factor such as MINUTES_PER_HOUR does not become a
        # C1 finding merely because it is scoped locally.
        if node.targets and all(self._is_named_constant(target) for target in node.targets):
            for target in node.targets:
                self.visit(target)
            return
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if self._is_named_constant(node.target):
            self.visit(node.target)
            return
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, float):
            self.float_literals += 1
        if isinstance(node.value, (int, float)) and node.value not in NEUTRAL_NUMBERS:
            self.magic_numbers.append({"line": node.lineno, "value": node.value})
        self.generic_visit(node)

    def visit_Try(self, node: ast.Try) -> None:
        self.exception_handlers += len(node.handlers)
        self.generic_visit(node)

    def visit_Raise(self, node: ast.Raise) -> None:
        self.exception_handlers += 1
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        complexity = 1
        branch_nodes = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.With, ast.AsyncWith, ast.IfExp)
        match_case = getattr(ast, "match_case", None) or getattr(ast, "MatchCase", None)
        if match_case is not None:
            branch_nodes = (*branch_nodes, match_case)
        for child in ast.walk(node):
            if isinstance(child, branch_nodes):
                complexity += 1
            if isinstance(child, ast.BoolOp):
                complexity += max(0, len(child.values) - 1)
        self.max_complexity = max(self.max_complexity, complexity)
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef


def measure_python(root: Path, entry: str) -> dict[str, Any]:
    path = root / entry
    if not path.exists():
        return {"language": "python", "entry": entry, "parseError": "entry file missing", "magicNumbers": [], "maxComplexity": 0, "exceptionHandlers": 0, "floatLiterals": 0}
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        return {"language": "python", "entry": entry, "parseError": str(exc), "magicNumbers": [], "maxComplexity": 0, "exceptionHandlers": 0, "floatLiterals": 0}
    visitor = PythonMetrics()
    visitor.visit(tree)
    return {
        "language": "python",
        "entry": entry,
        "magicNumbers": visitor.magic_numbers,
        "maxComplexity": visitor.max_complexity,
        "exceptionHandlers": visitor.exception_handlers,
        "floatLiterals": visitor.float_literals,
    }
