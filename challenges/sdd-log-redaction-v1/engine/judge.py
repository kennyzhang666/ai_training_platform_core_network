"""SDD 运维日志脱敏综合评测引擎。

平台以 ``python -I judge.py --input <invocation.json> --output <result.json>``
调用。引擎只读取冻结交付快照和包内 rubric，运行学员测试，并输出平台统一
评测结果。评分过程不访问网络，也不依赖模型的临时判断。
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


GRADER_VERSION = "sdd-log-redaction-spec-evaluator@1.0.0"
LEVEL_RATIO = {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.0}
REQUIRED_FILES = (
    "SPEC.md",
    "README.md",
    "AI_WORKLOG.md",
    "src/log_redactor.py",
    "tests/test_log_redactor.py",
)


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
        passed = output.count(" ... ok")
        return {
            "passed": completed.returncode == 0 and discovered > 0,
            "exitCode": completed.returncode,
            "testsPassed": passed,
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
            "output": "单元测试超过 45 秒时限",
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
        return len(functions) >= 4 and details["maxFunctionLines"] <= 80, details
    return True, details


def _evaluate_check(check: dict[str, Any], files: dict[str, str], unit_tests: dict[str, Any]) -> dict[str, Any]:
    kind = str(check["kind"])
    path = str(check.get("path", "SPEC.md"))
    terms = [str(item) for item in check.get("terms", [])]
    text = files.get(path, "")
    details: dict[str, Any] = {}
    if kind == "unit_tests":
        passed = bool(unit_tests["passed"])
        details = {key: value for key, value in unit_tests.items() if key != "output"}
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


def _criterion(
    definition: dict[str, Any],
    checks: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
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
        "evidenceType": "diagnostic",
        "evidence": {
            "primaryPath": definition.get("path", "SPEC.md"),
            "passed": passed,
            "total": len(checks),
            "checks": [{key: value for key, value in check.items() if key != "fix"} for check in checks],
        },
        "ruleVersion": "1.0",
    }
    findings = []
    for index, check in enumerate((item for item in checks if not item["passed"]), start=1):
        findings.append({
            "id": f"finding-{str(definition['key']).lower()}-{index}",
            "dim": definition["dim"],
            "criteria": definition["key"],
            "severity": "minor" if level == "B" else "major",
            "title": f"{definition['name']}证据不足",
            "file": check["path"],
            "line": int(check["line"]),
            "snippet": check["quote"],
            "detail": f"未满足：{check['description']}。",
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sdd-log-redaction-judge")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    workspace = Path(payload["workspace"])
    package_root = Path(payload["engine"]["packageRoot"])
    assets = payload["engine"].get("assets", {})
    rubric_root = Path(assets.get("testsDir") or package_root / "assets" / "hidden-tests")
    rubric = json.loads((rubric_root / "rubric.json").read_text(encoding="utf-8"))

    files = {relative: _read(workspace, relative) for relative in REQUIRED_FILES}
    unit_tests = _run_unit_tests(workspace)
    diagnostics: list[dict[str, Any]] = []
    for relative in REQUIRED_FILES:
        if not files[relative]:
            diagnostics.append({
                "severity": "BLOCKER",
                "code": "REQUIRED_FILE_MISSING",
                "path": relative,
                "message": f"缺少必交文件 {relative}",
            })
    if not unit_tests["passed"]:
        diagnostics.append({
            "severity": "WARNING",
            "code": "SUBMISSION_TESTS_FAILED",
            "path": "tests/test_log_redactor.py",
            "message": "交付件单元测试未全部通过",
        })

    criteria: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for definition in rubric["criteria"]:
        checks = [_evaluate_check(check, files, unit_tests) for check in definition["checks"]]
        criterion, criterion_findings = _criterion(definition, checks)
        criteria.append(criterion)
        findings.extend(criterion_findings)

    dimension_max = {"verify": 40.0, "spec": 25.0, "code": 20.0, "collab": 15.0}
    dimensions = {}
    for dimension, maximum in dimension_max.items():
        selected = [criterion for criterion in criteria if criterion["dim"] == dimension]
        dimensions[dimension] = {
            "score": round(sum(float(criterion["score"]) for criterion in selected), 4),
            "max": maximum,
            "evaluated": True,
        }
    total = round(sum(float(value["score"]) for value in dimensions.values()), 4)

    spec = files["SPEC.md"]
    test_text = files["tests/test_log_redactor.py"]
    source_text = files["src/log_redactor.py"]
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
            "requirements": len(set(__import__("re").findall(r"REQ-\d+", spec))),
            "acceptanceCriteria": len(set(__import__("re").findall(r"AC-\d+", spec))),
        },
        "metrics": {
            "specCharacters": len(spec),
            "specSections": sum(1 for line in spec.splitlines() if line.startswith("#")),
            "sourceLines": len(source_text.splitlines()),
            "testLines": len(test_text.splitlines()),
            "testFunctions": test_text.count("def test_"),
        },
        "extractions": [
            _quote_extraction("spec-fail-closed", "规格是否定义失败关闭策略？", spec, "失败关闭"),
            _quote_extraction("spec-traceability", "规格是否建立需求追踪矩阵？", spec, "追踪矩阵"),
            _quote_extraction("spec-no-raw-log", "诊断信息是否禁止记录原始日志？", spec, "不得记录原文"),
        ],
        "gradedBy": "ci",
        "startedAt": started_at,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        "durationMs": int((finished - started) * 1000),
        "metadata": {
            "primaryEvidence": "SPEC.md",
            "rubricPoints": 16,
            "unitTestOutputTail": unit_tests["output"],
        },
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
