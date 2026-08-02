from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


TIERS = {
    "basic": 1.0,
    "boundary": 2.0,
    "clarification": 2.0,
    "change": 1.6,
}

DEFAULT_VERIFY_WEIGHTS = {"basic": 8.0, "boundary": 12.0, "clarification": 12.0, "change": 8.0}


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
cases = json.load(sys.stdin)
results = []
for case in cases:
    try:
        value = fn(*case.get("args", []), **case.get("kwargs", {}))
        results.append({"name": case.get("name", "unnamed"), "passed": value == case.get("expected"), "actual": value, "expected": case.get("expected")})
    except Exception as exc:
        results.append({"name": case.get("name", "unnamed"), "passed": False, "error": f"{type(exc).__name__}: {exc}", "expected": case.get("expected")})
print(json.dumps(results, ensure_ascii=False, default=str))
'''


def _equal(actual: Any, expected: Any) -> bool:
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return abs(float(actual) - float(expected)) <= 1e-6
    return actual == expected


def run_tier(root: Path, tests_dir: Path, tier: str, entry: str, function: str, timeout: int = 10, weights: dict[str, float] | None = None) -> dict[str, Any]:
    tier_weights = weights or DEFAULT_VERIFY_WEIGHTS
    cases_path = tests_dir / f"{tier}.json"
    if not cases_path.exists():
        return {"tier": tier, "passed": 0, "total": 0, "weight": tier_weights[tier], "cases": [], "skipped": True}
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="drill-grader-") as tmp:
        runner = Path(tmp) / "runner.py"
        runner.write_text(RUNNER, encoding="utf-8")
        try:
            process = subprocess.run(
                [sys.executable, "-I", str(runner), "--entry", str((root / entry).resolve()), "--function", function],
                input=json.dumps(cases, ensure_ascii=False),
                text=True,
                capture_output=True,
                cwd=root,
                timeout=max(1, min(timeout, 300)),
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"},
            )
        except subprocess.TimeoutExpired:
            return {"tier": tier, "passed": 0, "total": len(cases), "weight": tier_weights[tier], "cases": [], "error": f"timed out after {timeout}s", "timedOut": True}
        except OSError as exc:
            return {"tier": tier, "passed": 0, "total": len(cases), "weight": tier_weights[tier], "cases": [], "error": str(exc)}
    if process.returncode != 0:
        return {"tier": tier, "passed": 0, "total": len(cases), "weight": tier_weights[tier], "cases": [], "error": process.stderr[-1000:]}
    try:
        results = json.loads(process.stdout)
    except json.JSONDecodeError:
        return {"tier": tier, "passed": 0, "total": len(cases), "weight": tier_weights[tier], "cases": [], "error": "runner returned invalid JSON"}
    for index, result in enumerate(results):
        if "actual" in result and "expected" in result:
            result["passed"] = _equal(result["actual"], result["expected"])
        result["index"] = index
    return {
        "tier": tier,
        "passed": sum(1 for result in results if result.get("passed")),
        "total": len(results),
        "weight": tier_weights[tier],
        "cases": results,
    }


def verify_submission(root: Path, tests_dir: Path, entry: str, function: str, timeout: int = 10, weights: dict[str, float] | None = None) -> dict[str, Any]:
    tier_weights = weights or DEFAULT_VERIFY_WEIGHTS
    tiers = [run_tier(root, tests_dir, tier, entry, function, timeout, tier_weights) for tier in TIERS]
    # weightedScore is the Verify dimension score: each tier contributes its own
    # configured weight in proportion to the cases it passed. A tier the
    # challenge does not ship contributes neither score nor maximum, so its
    # points are not silently deducted from the submission.
    graded = [item for item in tiers if item["total"] > 0]
    available = sum(item["weight"] for item in graded)
    earned = sum(item["weight"] * item["passed"] / item["total"] for item in graded)
    return {
        "tiers": {item["tier"]: item for item in tiers},
        "passed": sum(item["passed"] for item in tiers),
        "total": sum(item["total"] for item in tiers),
        "availableScore": round(available, 4),
        "weightedScore": round(earned, 4) if available else 0.0,
    }
