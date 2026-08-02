"""停车场计费 · 打包评测引擎。

平台以 `python -I judge.py --input <in.json> --output <out.json>` 调用本脚本。
输入符合 contracts/engine-invocation.schema.json，输出必须符合
contracts/evaluation-result.schema.json。

判据全部在本文件内，跟隐藏测试和提交契约一起打包冻结——这正是「一个包 = 一道题
完整的评测能力」的含义：换一台机器、换一个执行体，同一份交付件必然同分。

模型不参与打分。脚本只做三件确定性的事：契约校验、隐藏测试执行、静态度量。
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

GRADER_VERSION = "parking-fee-packaged@1.0.0"

# 四档权重即四个 Verify 得分点的满分，合计 40。
TIER_WEIGHTS = {"basic": 8.0, "boundary": 12.0, "clarification": 12.0, "change": 8.0}
TIER_TO_CRITERION = {"basic": "V1", "boundary": "V2", "clarification": "V3", "change": "V4"}
LEVEL_RATIOS = {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.0}
NEUTRAL_NUMBERS = {0, 1, -1, 2}

RUNNER = r'''
import argparse, importlib.util, json, sys
parser = argparse.ArgumentParser()
parser.add_argument("--entry", required=True)
parser.add_argument("--function", required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location("submission_entry", args.entry)
module = importlib.util.module_from_spec(spec)
sys.modules["submission_entry"] = module
spec.loader.exec_module(module)
fn = getattr(module, args.function)
results = []
for case in json.load(sys.stdin):
    try:
        value = fn(*case.get("args", []), **case.get("kwargs", {}))
        results.append({"name": case.get("name", "unnamed"), "actual": value, "expected": case.get("expected")})
    except Exception as exc:
        results.append({"name": case.get("name", "unnamed"), "error": f"{type(exc).__name__}: {exc}", "expected": case.get("expected")})
print(json.dumps(results, ensure_ascii=False, default=str))
'''


def _equal(actual: Any, expected: Any) -> bool:
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return abs(float(actual) - float(expected)) <= 1e-6
    return actual == expected


def _run_tier(workspace: Path, tests_dir: Path, tier: str, entry: str, function: str, scratch: Path, timeout: int) -> dict[str, Any]:
    cases_path = tests_dir / f"{tier}.json"
    if not cases_path.exists():
        return {"tier": tier, "passed": 0, "total": 0, "skipped": True, "cases": []}
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    runner = scratch / f"runner-{tier}.py"
    runner.write_text(RUNNER, encoding="utf-8")
    try:
        process = subprocess.run(
            [sys.executable, "-I", str(runner), "--entry", str((workspace / entry).resolve()), "--function", function],
            input=json.dumps(cases, ensure_ascii=False),
            text=True, capture_output=True, cwd=str(workspace), timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [], "timedOut": True, "error": f"tier timed out after {timeout}s"}
    if process.returncode != 0:
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [], "error": process.stderr[-800:]}
    try:
        results = json.loads(process.stdout)
    except json.JSONDecodeError:
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [], "error": "runner returned invalid JSON"}
    for index, item in enumerate(results):
        item["index"] = index
        item["passed"] = "error" not in item and _equal(item.get("actual"), item.get("expected"))
    return {"tier": tier, "passed": sum(1 for item in results if item["passed"]), "total": len(results), "cases": results}


def _measure(workspace: Path, entry: str) -> dict[str, Any]:
    path = workspace / entry
    if not path.exists():
        return {"parseError": "entry file missing", "magicNumbers": [], "maxComplexity": 0, "exceptionHandlers": 0}
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        return {"parseError": str(exc), "magicNumbers": [], "maxComplexity": 0, "exceptionHandlers": 0}
    magic: list[dict[str, Any]] = []
    handlers = 0
    complexity = 1
    named_constant_lines: set[int] = set()
    for node in ast.walk(tree):
        # 模块级具名常量里的字面量不算魔法数字。
        if isinstance(node, ast.Assign) and node.targets and all(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets):
            for child in ast.walk(node):
                if isinstance(child, ast.Constant):
                    named_constant_lines.add(child.lineno)
        if isinstance(node, ast.Try):
            handlers += len(node.handlers)
        if isinstance(node, ast.Raise):
            handlers += 1
        if isinstance(node, (ast.If, ast.For, ast.While, ast.ExceptHandler, ast.IfExp)):
            complexity += 1
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            if node.value in NEUTRAL_NUMBERS or node.lineno in named_constant_lines:
                continue
            magic.append({"line": node.lineno, "value": node.value})
    return {"magicNumbers": magic, "maxComplexity": complexity, "exceptionHandlers": handlers}


def _contract_diagnostics(workspace: Path, contract_path: Path | None) -> list[dict[str, str]]:
    if not contract_path or not contract_path.exists():
        return []
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    diagnostics: list[dict[str, str]] = []
    for item in contract.get("required", []):
        target = workspace / item["path"].rstrip("/")
        if not target.exists():
            diagnostics.append({"severity": "BLOCKER", "code": "REQUIRED_FILE_MISSING", "path": item["path"], "message": f"缺少必交文件 {item['path']}"})
            continue
        if target.is_file() and item.get("minChars"):
            text = target.read_text(encoding="utf-8", errors="replace")
            if len(text) < item["minChars"]:
                diagnostics.append({"severity": "WARNING", "code": "REQUIRED_FILE_TOO_SHORT", "path": item["path"], "message": f"{item['path']} 内容过短"})
    for item in contract.get("optional", []):
        if not (workspace / item["path"].rstrip("/")).exists():
            diagnostics.append({"severity": "INFO", "code": "OPTIONAL_PATH_MISSING", "path": item["path"], "message": f"未提交可选项 {item['path']}"})
    return diagnostics


def _level(ratio: float) -> str:
    return "A" if ratio >= 1 else "B" if ratio >= 0.75 else "C" if ratio >= 0.5 else "D"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="parking-fee-judge")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    workspace = Path(payload["workspace"])
    scratch = Path(payload.get("scratchDir") or Path(args.output).parent)
    assets = payload["engine"].get("assets", {})
    tests_dir = Path(assets["testsDir"]) if assets.get("testsDir") else None
    contract_path = Path(assets["submissionContract"]) if assets.get("submissionContract") else None
    tier_timeout = max(5, int(payload.get("limits", {}).get("wallClockSeconds", 120)) // 4)
    entry, function = "src/parking.py", "calculate_fee"

    diagnostics = _contract_diagnostics(workspace, contract_path)
    tiers = {tier: _run_tier(workspace, tests_dir, tier, entry, function, scratch, tier_timeout) for tier in TIER_WEIGHTS} if tests_dir else {}
    metrics = _measure(workspace, entry)

    criteria: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for tier, weight in TIER_WEIGHTS.items():
        detail = tiers.get(tier, {"passed": 0, "total": 0})
        total_cases = int(detail.get("total") or 0)
        if total_cases <= 0:
            continue  # 未提供的档位不计分也不计满分
        ratio = detail["passed"] / total_cases
        criteria.append({
            "key": TIER_TO_CRITERION[tier], "dim": "verify", "name": f"{tier} 验证", "max": weight,
            "level": _level(ratio), "score": round(weight * ratio, 4), "source": "auto",
            "rule": f"{tier} 隐藏测试通过率", "evidenceType": "test", "evidence": detail,
        })
        for case in detail.get("cases", []):
            if not case.get("passed"):
                findings.append({
                    "id": f"finding-{tier}-{case.get('index', 0)}", "dim": "verify", "criteria": TIER_TO_CRITERION[tier],
                    "severity": "major", "title": f"{tier} 用例未通过：{case.get('name', 'unnamed')}",
                    "detail": f"expected={case.get('expected')!r} actual={case.get('actual', case.get('error'))!r}",
                    "fix": "补充该边界分支并回归全部隐藏测试。",
                })

    magic_count = len(metrics.get("magicNumbers", []))
    c1_level = "A" if magic_count == 0 else "B" if magic_count <= 2 else "C" if magic_count <= 4 else "D"
    complexity = metrics.get("maxComplexity", 0)
    c2_level = "A" if complexity <= 8 else "B" if complexity <= 12 else "C"
    criteria.extend([
        {"key": "C1", "dim": "code", "name": "业务常量抽取", "max": 12.0, "level": c1_level,
         "score": round(12.0 * LEVEL_RATIOS[c1_level], 4), "source": "auto", "rule": "函数体内魔法数字数量阈值",
         "evidenceType": "metric", "evidence": {"magicNumbers": metrics.get("magicNumbers", [])}},
        {"key": "C4", "dim": "code", "name": "抗变更能力", "max": 8.0, "level": c2_level,
         "score": round(8.0 * LEVEL_RATIOS[c2_level], 4), "source": "auto", "rule": "最大圈复杂度阈值",
         "evidenceType": "metric", "evidence": {"maxComplexity": complexity}},
    ])
    for index, magic in enumerate(metrics.get("magicNumbers", []), start=1):
        findings.append({
            "id": f"finding-magic-{index}", "dim": "code", "criteria": "C1", "severity": "minor",
            "title": "发现未命名业务数字", "file": entry, "line": int(magic["line"]),
            "detail": f"数字 {magic['value']} 参与业务逻辑，降低规则可读性。",
            "fix": "提取为具有业务含义的全大写常量。",
        })

    dimension_max = {"verify": 40.0, "spec": 25.0, "code": 20.0, "collab": 15.0}
    dimensions: dict[str, Any] = {}
    for name, maximum in dimension_max.items():
        scored = [item for item in criteria if item["dim"] == name]
        if scored:
            dimensions[name] = {"score": round(sum(item["score"] for item in scored), 4), "max": round(sum(item["max"] for item in scored), 4), "evaluated": True}
        else:
            dimensions[name] = {"score": None, "max": maximum, "evaluated": False}
    total = round(sum(item["score"] for item in dimensions.values() if item["evaluated"]), 4)

    blocked = any(item["severity"] == "BLOCKER" for item in diagnostics)
    snapshot_hash = payload["submission"]["snapshotHash"]
    finished = time.time()
    result = {
        "schemaVersion": "1.0",
        "resultId": f"result-{hashlib.sha256((snapshot_hash + payload['grading']['runId']).encode()).hexdigest()[:24]}",
        "gradingRunId": payload["grading"]["runId"],
        "challengeVersion": payload["challenge"]["challengeVersion"],
        "rubricVersion": payload["challenge"]["rubricVersion"],
        "graderVersion": GRADER_VERSION,
        "idempotencyKey": payload["grading"]["idempotencyKey"],
        "triggerType": payload["grading"]["triggerType"],
        "status": "PARTIAL" if blocked or not criteria else "COMPLETE",
        "submission": {k: v for k, v in payload["submission"].items() if k != "id"},
        "dimensions": dimensions,
        "criteria": criteria,
        "total": total,
        "findings": findings,
        "validationDiagnostics": diagnostics,
        "verifyDetail": {"tiers": tiers, "passed": sum(t.get("passed", 0) for t in tiers.values()), "total": sum(t.get("total", 0) for t in tiers.values())},
        "metrics": metrics,
        "gradedBy": "ci",
        "startedAt": started_at,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        "durationMs": int((finished - started) * 1000),
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
