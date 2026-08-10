"""SDD 运维日志脱敏 v2 确定性评测引擎。"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


GRADER_VERSION = "sdd-log-redaction-spec-evaluator@2.0.0"
LEVEL_RATIO = {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.0}
REQUIRED_FILES = (
    "SPEC.md",
    "README.md",
    "AI_WORKLOG.md",
    "policy/redaction_policy.json",
    "src/log_redactor.py",
    "tests/test_log_redactor.py",
)
HIDDEN_IDS = tuple(f"HT-{index:02d}" for index in range(1, 25))


def _read(workspace: Path, relative: str) -> str:
    path = workspace / relative
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def _line_for(text: str, terms: list[str]) -> tuple[int, str]:
    lines = text.splitlines()
    for index, line in enumerate(lines, start=1):
        if any(term in line for term in terms):
            return index, line.strip()[:300]
    for index, line in enumerate(lines, start=1):
        if line.strip():
            return index, line.strip()[:300]
    return 1, ""


def _run_unit_tests(workspace: Path) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        output = f"{completed.stdout}\n{completed.stderr}".strip()
        discovered = output.count(" ... ok") + output.count(" ... FAIL") + output.count(" ... ERROR")
        return {
            "passed": completed.returncode == 0 and discovered > 0,
            "exitCode": completed.returncode,
            "testsPassed": output.count(" ... ok"),
            "testsDiscovered": discovered,
            "durationMs": int((time.monotonic() - started) * 1000),
            "output": output[-2000:],
        }
    except subprocess.TimeoutExpired:
        return {
            "passed": False,
            "exitCode": None,
            "testsPassed": 0,
            "testsDiscovered": 0,
            "durationMs": int((time.monotonic() - started) * 1000),
            "output": "公开测试超过 45 秒时限",
        }


def _failed_hidden_result(duration_ms: int = 0) -> dict[str, Any]:
    return {
        "passed": 0,
        "total": len(HIDDEN_IDS),
        "durationMs": duration_ms,
        "checks": [{"id": identifier, "tier": ("core", "complex", "safety", "engineering")[(index - 1) // 6], "passed": False} for index, identifier in enumerate(HIDDEN_IDS, start=1)],
    }


def _run_hidden_tests(workspace: Path, tests_root: Path) -> dict[str, Any]:
    runner = tests_root / "run_hidden_tests.py"
    if not runner.is_file():
        return _failed_hidden_result()
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="sdd-hidden-result-") as temporary:
        output = Path(temporary) / "hidden-result.json"
        try:
            completed = subprocess.run(
                [sys.executable, "-I", str(runner), "--workspace", str(workspace), "--output", str(output)],
                cwd=tests_root,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
        except subprocess.TimeoutExpired:
            return _failed_hidden_result(int((time.monotonic() - started) * 1000))
        if completed.returncode != 0 or not output.is_file():
            return _failed_hidden_result(int((time.monotonic() - started) * 1000))
        try:
            raw = json.loads(output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return _failed_hidden_result(int((time.monotonic() - started) * 1000))

    supplied = {str(item.get("id")): item for item in raw.get("checks", []) if isinstance(item, dict)}
    checks = []
    for index, identifier in enumerate(HIDDEN_IDS, start=1):
        item = supplied.get(identifier, {})
        checks.append({
            "id": identifier,
            "tier": ("core", "complex", "safety", "engineering")[(index - 1) // 6],
            "passed": bool(item.get("passed")),
        })
    return {
        "passed": sum(1 for item in checks if item["passed"]),
        "total": len(checks),
        "durationMs": int(raw.get("durationMs", (time.monotonic() - started) * 1000)),
        "checks": checks,
    }


def _ast_check(text: str, test_name: str) -> tuple[bool, dict[str, Any]]:
    try:
        tree = ast.parse(text)
    except SyntaxError as error:
        return False, {"syntaxError": str(error)}
    functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    details = {
        "functionCount": len(functions),
        "maxFunctionLines": max((int(getattr(node, "end_lineno", node.lineno)) - node.lineno + 1 for node in functions), default=0),
    }
    if test_name == "functions":
        return len(functions) >= 8 and details["maxFunctionLines"] <= 80, details
    return True, details


def _hidden_check(ids: list[str], hidden_tests: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    states = {str(item["id"]): bool(item["passed"]) for item in hidden_tests["checks"]}
    passed_ids = [identifier for identifier in ids if states.get(identifier, False)]
    return len(passed_ids) == len(ids), {
        "hiddenIds": ids,
        "passedIds": passed_ids,
        "failedIds": [identifier for identifier in ids if identifier not in passed_ids],
    }


def _evaluate_check(
    check: dict[str, Any],
    files: dict[str, str],
    unit_tests: dict[str, Any],
    hidden_tests: dict[str, Any],
) -> dict[str, Any]:
    kind = str(check["kind"])
    path = str(check.get("path", "SPEC.md"))
    terms = [str(item) for item in check.get("terms", [])]
    text = files.get(path, "")
    details: dict[str, Any] = {}
    if kind == "unit_tests":
        passed = bool(unit_tests["passed"])
        details = {key: value for key, value in unit_tests.items() if key != "output"}
    elif kind == "hidden_all":
        passed, details = _hidden_check([str(item) for item in check.get("ids", [])], hidden_tests)
    elif kind == "all":
        missing = [term for term in terms if term not in text]
        passed = not missing
        details = {"matched": [term for term in terms if term in text], "missing": missing}
    elif kind == "any":
        matched = [term for term in terms if term in text]
        passed = bool(matched)
        details = {"matched": matched, "expectedAny": terms}
    elif kind == "not_any":
        matched = [term for term in terms if term in text]
        passed = not matched
        details = {"forbiddenMatches": matched}
    elif kind == "headings":
        headings = [line.lstrip("# ").strip() for line in text.splitlines() if line.lstrip().startswith("#")]
        missing = [term for term in terms if not any(term in heading for heading in headings)]
        passed = not missing
        details = {"matchedHeadings": [term for term in terms if term not in missing], "missing": missing}
    elif kind == "ast":
        passed, details = _ast_check(text, str(check.get("test", "parse")))
    else:
        passed = False
        details = {"error": f"unknown check kind: {kind}"}
    line, quote = _line_for(text, terms)
    return {
        "description": str(check["description"]),
        "passed": passed,
        "path": path,
        "line": line,
        "quote": quote,
        "fix": str(check.get("fix", "补充可验证证据。")),
        "kind": kind,
        **details,
    }


def _level(passed: int, total: int) -> str:
    ratio = passed / total if total else 0
    if ratio >= 1:
        return "A"
    if ratio >= 0.75:
        return "B"
    if ratio >= 0.5:
        return "C"
    return "D"


def _criterion(definition: dict[str, Any], checks: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    passed = sum(1 for check in checks if check["passed"])
    level = _level(passed, len(checks))
    maximum = float(definition["max"])
    score = round(maximum * LEVEL_RATIO[level], 4)
    criterion = {
        "key": definition["key"],
        "dim": definition["dim"],
        "name": definition["name"],
        "max": maximum,
        "level": level,
        "score": score,
        "source": "auto",
        "rule": definition["rule"],
        "rationale": f"{passed}/{len(checks)} 项冻结证据满足判据，档位 {level}。",
        "evidenceType": "test" if any(check["kind"] == "hidden_all" for check in checks) else "diagnostic",
        "evidence": {
            "primaryPath": definition.get("path", "SPEC.md"),
            "passed": passed,
            "total": len(checks),
            "checks": [{key: value for key, value in check.items() if key not in {"fix", "kind"}} for check in checks],
        },
        "ruleVersion": "2.0",
    }
    findings = []
    for index, check in enumerate((item for item in checks if not item["passed"]), start=1):
        hidden = check["kind"] == "hidden_all"
        findings.append({
            "id": f"finding-{str(definition['key']).lower()}-{index}",
            "dim": definition["dim"],
            "criteria": definition["key"],
            "severity": "minor" if level == "B" else "major",
            "title": f"{definition['name']}证据不足",
            "file": check["path"],
            "line": int(check["line"]),
            "snippet": check["quote"],
            "detail": f"未满足：{'评测方隐藏用例未通过' if hidden else check['description']}。",
            "fix": check["fix"],
        })
    return criterion, findings


def _quote_extraction(identifier: str, question: str, spec: str, term: str) -> dict[str, Any]:
    line, quote = _line_for(spec, [term])
    found = term in spec
    return {
        "id": identifier,
        "q": question,
        "a": "yes" if found else "no",
        "quote": quote if found else "未找到对应规格原文",
        "quoteVerified": found,
        "source": f"SPEC.md:{line}",
    }


def _hidden_summary(hidden_tests: dict[str, Any]) -> dict[str, Any]:
    by_tier: dict[str, dict[str, int]] = {}
    for tier in ("core", "complex", "safety", "engineering"):
        selected = [item for item in hidden_tests["checks"] if item["tier"] == tier]
        by_tier[tier] = {"passed": sum(1 for item in selected if item["passed"]), "total": len(selected)}
    return {"passed": hidden_tests["passed"], "total": hidden_tests["total"], "byTier": by_tier}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sdd-log-redaction-v2-judge")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    workspace = Path(payload["workspace"])
    package_root = Path(payload["engine"]["packageRoot"])
    assets = payload["engine"].get("assets", {})
    tests_root = Path(assets.get("testsDir") or package_root / "assets" / "hidden-tests")
    rubric = json.loads((tests_root / "rubric.json").read_text(encoding="utf-8"))

    files = {relative: _read(workspace, relative) for relative in REQUIRED_FILES}
    unit_tests = _run_unit_tests(workspace)
    hidden_tests = _run_hidden_tests(workspace, tests_root)
    diagnostics: list[dict[str, Any]] = []
    for relative in REQUIRED_FILES:
        if not files[relative]:
            diagnostics.append({"severity": "BLOCKER", "code": "REQUIRED_FILE_MISSING", "path": relative, "message": f"缺少必交文件 {relative}"})
    if not unit_tests["passed"]:
        diagnostics.append({"severity": "WARNING", "code": "SUBMISSION_TESTS_FAILED", "path": "tests/test_log_redactor.py", "message": "交付件公开测试未全部通过"})
    if hidden_tests["passed"] < hidden_tests["total"]:
        diagnostics.append({"severity": "WARNING", "code": "HIDDEN_ACCEPTANCE_FAILED", "path": "src/log_redactor.py", "message": "部分评测方验收用例未通过"})

    criteria: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for definition in rubric["criteria"]:
        checks = [_evaluate_check(check, files, unit_tests, hidden_tests) for check in definition["checks"]]
        criterion, criterion_findings = _criterion(definition, checks)
        criteria.append(criterion)
        findings.extend(criterion_findings)

    dimension_max = {"verify": 40.0, "spec": 25.0, "code": 20.0, "collab": 15.0}
    dimensions = {}
    for dimension, maximum in dimension_max.items():
        selected = [criterion for criterion in criteria if criterion["dim"] == dimension]
        dimensions[dimension] = {"score": round(sum(float(criterion["score"]) for criterion in selected), 4), "max": maximum, "evaluated": True}
    total = round(sum(float(value["score"]) for value in dimensions.values()), 4)

    spec = files["SPEC.md"]
    source_text = files["src/log_redactor.py"]
    test_text = files["tests/test_log_redactor.py"]
    snapshot_hash = payload["submission"]["snapshotHash"]
    finished = time.time()
    submission = {key: value for key, value in payload["submission"].items() if key != "id"}
    result = {
        "schemaVersion": "1.0",
        "resultId": f"result-{hashlib.sha256((snapshot_hash + payload['grading']['runId']).encode()).hexdigest()[:24]}",
        "gradingRunId": payload["grading"]["runId"],
        "challengeVersion": payload["challenge"]["challengeVersion"],
        "rubricVersion": payload["challenge"]["rubricVersion"],
        "graderVersion": GRADER_VERSION,
        "idempotencyKey": payload["grading"]["idempotencyKey"],
        "triggerType": payload["grading"]["triggerType"],
        "status": "PARTIAL" if any(item["severity"] == "BLOCKER" for item in diagnostics) else "COMPLETE",
        "submission": submission,
        "dimensions": dimensions,
        "criteria": criteria,
        "total": total,
        "validationDiagnostics": diagnostics,
        "findings": findings,
        "verifyDetail": {
            "unitTests": {key: value for key, value in unit_tests.items() if key != "output"},
            "hiddenTests": _hidden_summary(hidden_tests),
            "requirements": len(set(re.findall(r"REQ-\d+", spec))),
            "acceptanceCriteria": len(set(re.findall(r"AC-\d+", spec))),
        },
        "metrics": {
            "specCharacters": len(spec),
            "specSections": sum(1 for line in spec.splitlines() if line.startswith("#")),
            "sourceLines": len(source_text.splitlines()),
            "testLines": len(test_text.splitlines()),
            "testFunctions": test_text.count("def test_"),
            "hiddenTestsPassed": hidden_tests["passed"],
            "hiddenTestsTotal": hidden_tests["total"],
        },
        "extractions": [
            _quote_extraction("spec-fail-closed", "规格是否定义失败关闭策略？", spec, "失败关闭"),
            _quote_extraction("spec-hmac", "规格是否定义 HMAC 关联策略？", spec, "HMAC-SHA256"),
            _quote_extraction("spec-stream", "规格是否定义逐行流式处理？", spec, "逐行"),
        ],
        "gradedBy": "ci",
        "startedAt": started_at,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        "durationMs": int((finished - started) * 1000),
        "metadata": {
            "primaryEvidence": "SPEC.md",
            "rubricPoints": 16,
            "hiddenTestCount": hidden_tests["total"],
            "failedHiddenIds": [item["id"] for item in hidden_tests["checks"] if not item["passed"]],
            "unitTestExitCode": unit_tests["exitCode"],
        },
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
