from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .diagnostics import Diagnostic
from .metrics import measure_python
from .scoring import score_criteria
from .schemas import assert_valid, load_json
from .snapshot import snapshot_hash, snapshot_manifest
from .submission import validate_submission
from .verify import DEFAULT_VERIFY_WEIGHTS, verify_submission


GRADER_VERSION = "0.3.0"


def _load_profile(zone: str) -> dict[str, Any]:
    profile_path = Path(__file__).resolve().parents[2] / "profiles" / f"{zone.lower()}.yaml"
    defaults = {
        "version": "1.0",
        "levelRatios": {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.0},
        "verifyWeights": DEFAULT_VERIFY_WEIGHTS,
        "dimensions": {"verify": 40, "spec": 25, "code": 20, "collab": 15},
        "rationale": {},
        "criteria": {},
    }
    if not profile_path.exists():
        return defaults
    try:
        import yaml

        profile = yaml.safe_load(profile_path.read_text(encoding="utf-8")) or {}
        return {
            "version": profile.get("version", defaults["version"]),
            "levelRatios": profile.get("levelRatios", defaults["levelRatios"]),
            "verifyWeights": profile.get("verifyWeights", defaults["verifyWeights"]),
            "dimensions": profile.get("dimensions", defaults["dimensions"]),
            "rationale": profile.get("rationale", defaults["rationale"]),
            "criteria": profile.get("criteria", defaults["criteria"]),
        }
    except ImportError:
        return defaults


def _write_json(path: Path | None, value: Any) -> None:
    output = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(output, encoding="utf-8")
    else:
        print(output, end="")


def cmd_validate(args: argparse.Namespace) -> int:
    diagnostics = validate_submission(Path(args.submission), Path(args.contract), args.language)
    payload = {
        "status": "BLOCKED" if any(item.severity == "BLOCKER" for item in diagnostics) else "OK",
        "diagnostics": [item.as_dict() for item in diagnostics],
    }
    _write_json(Path(args.out) if args.out else None, payload)
    return 1 if payload["status"] == "BLOCKED" else 0


def cmd_score(args: argparse.Namespace) -> int:
    criteria = load_json(Path(args.criteria))
    if not isinstance(criteria, list):
        raise ValueError("criteria input must be a JSON array")
    scored = score_criteria(criteria)
    _write_json(Path(args.out) if args.out else None, scored)
    return 0


def cmd_measure(args: argparse.Namespace) -> int:
    metrics = measure_python(Path(args.submission), args.entry)
    _write_json(Path(args.out) if args.out else None, metrics)
    return 1 if metrics.get("parseError") else 0


def cmd_snapshot(args: argparse.Namespace) -> int:
    root = Path(args.submission)
    _write_json(Path(args.out) if args.out else None, {"snapshotHash": snapshot_hash(root), "files": snapshot_manifest(root)})
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    profile = _load_profile(args.zone)
    detail = verify_submission(Path(args.submission), Path(args.tests), args.entry, args.function, args.timeout, profile["verifyWeights"])
    _write_json(Path(args.out) if args.out else None, detail)
    return 0 if detail["passed"] == detail["total"] else 1


def cmd_check(args: argparse.Namespace) -> int:
    diagnostics = validate_submission(Path(args.submission), Path(args.contract), args.language)
    payload = {"status": "BLOCKED" if any(item.severity == "BLOCKER" for item in diagnostics) else "OK", "diagnostics": [item.as_dict() for item in diagnostics]}
    _write_json(Path(args.out) if args.out else None, payload)
    return 1 if payload["status"] == "BLOCKED" else 0


def cmd_extract(args: argparse.Namespace) -> int:
    """Collect the raw documents a model extractor would read.

    Structured extraction itself (the yes/no/unclear + verbatim quote pass) is
    phase two. Until a real extractor and quote matcher exist, this command must
    not claim evidence: answering "yes" with `quoteVerified: true` for a quote it
    copied out of the file itself is a tautology, and downstream scoring would
    treat fabricated confirmations as verified evidence.
    """
    root = Path(args.submission)
    extractions: list[dict[str, Any]] = []
    for name in ("SPEC.md", "transcript.md"):
        path = root / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        extractions.append({
            "id": f"extract-{path.stem}",
            "q": "交付件是否包含可审计的需求或澄清记录？",
            "a": "unclear",
            "quote": "",
            "quoteVerified": False,
            "source": name,
            "chars": len(text),
        })
    _write_json(Path(args.out) if args.out else None, {
        "extractorStatus": "NOT_IMPLEMENTED",
        "extractions": extractions,
        "snapshotHash": snapshot_hash(root),
    })
    return 0


def _heuristic_criteria(root: Path, contract: Path, language: str, tests_dir: Path | None, entry: str, function: str, profile: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    def snippet(line: int | None) -> str | None:
        if not line:
            return None
        try:
            lines = (root / entry).read_text(encoding="utf-8").splitlines()
            return lines[line - 1].strip()[:500] if 0 < line <= len(lines) else None
        except (OSError, UnicodeDecodeError):
            return None

    diagnostics = validate_submission(root, contract, language)
    verify_detail = verify_submission(root, tests_dir, entry, function, weights=profile["verifyWeights"]) if tests_dir else {"tiers": {}, "passed": 0, "total": 0, "weightedScore": 0.0}
    metrics = measure_python(root, entry) if language == "python" else {"magicNumbers": [], "maxComplexity": 0, "exceptionHandlers": 0, "floatLiterals": 0}
    criteria: list[dict[str, Any]] = []
    verify_max = {tier: float(weight) for tier, weight in profile["verifyWeights"].items()}
    for key, tier in zip(("V1", "V2", "V3", "V4"), ("basic", "boundary", "clarification", "change")):
        detail = verify_detail.get("tiers", {}).get(tier, {"passed": 0, "total": 0})
        total_cases = int(detail.get("total", 0) or 0)
        # A tier the challenge does not ship cannot be earned, so it must not be
        # scored either. Emitting a D-level criterion with its full maximum
        # deducted the tier's points from every submission.
        if total_cases <= 0:
            continue
        ratio = float(detail.get("passed", 0)) / float(total_cases)
        level = "A" if ratio >= 1 else "B" if ratio >= 0.75 else "C" if ratio >= 0.5 else "D"
        criteria.append({"key": key, "dim": "verify", "name": f"{tier} 验证", "max": verify_max[tier], "level": level, "score": round(verify_max[tier] * ratio, 4), "useProvidedScore": True, "source": "auto", "rule": f"{tier} 隐藏测试通过率", "evidenceType": "test", "evidence": detail})
    configured = profile.get("criteria", {})

    def criterion_config(key: str, fallback: dict[str, Any]) -> dict[str, Any]:
        value = configured.get(key, {}) if isinstance(configured, dict) else {}
        return {**fallback, **value} if isinstance(value, dict) else fallback

    c1 = criterion_config("C1", {"max": 6, "rationale": "业务数字应集中为可读的命名常量。"})
    c2 = criterion_config("C2", {"max": 5, "rationale": "外部输入和预期失败路径需要显式处理。"})
    c3 = criterion_config("C3", {"max": 4, "rationale": "精度语义应集中并避免隐式浮点误差。"})
    c4 = criterion_config("C4", {"max": 5, "rationale": "变化点应保持可拆解、可测试的复杂度。"})

    def level_from_thresholds(value: float, thresholds: dict[str, Any], default: str) -> str:
        for level in ("A", "B", "C"):
            threshold = thresholds.get(level) if isinstance(thresholds, dict) else None
            if threshold is not None and value <= float(threshold):
                return level
        return default

    magic_count = len(metrics.get("magicNumbers", []))
    c1_level = level_from_thresholds(magic_count, c1.get("thresholds", {"A": 0, "B": 2, "C": 4}), "D")
    handler_count = float(metrics.get("exceptionHandlers", 0))
    c2_level = "A" if handler_count >= float(c2.get("thresholds", {}).get("A", 1)) else "C"
    float_count = float(metrics.get("floatLiterals", 0))
    c3_level = level_from_thresholds(float_count, c3.get("thresholds", {"A": 0, "B": 2, "C": 4}), "D")
    complexity = float(metrics.get("maxComplexity", 0))
    c4_level = level_from_thresholds(complexity, c4.get("thresholds", {"A": 8, "B": 12, "C": 20}), "D")

    criteria.extend([
        {"key": "C1", "dim": "code", "name": "业务常量抽取", "max": float(c1.get("max", 6)), "level": c1_level, "source": "auto", "rule": "魔法数字数量阈值", "ruleVersion": profile.get("version", "1.0"), "rationale": c1.get("rationale"), "evidenceType": "metric", "evidence": {"magicNumbers": metrics.get("magicNumbers", [])}},
        {"key": "C2", "dim": "code", "name": "异常与边界处理", "max": float(c2.get("max", 5)), "level": c2_level, "source": "auto", "rule": "存在显式异常处理", "ruleVersion": profile.get("version", "1.0"), "rationale": c2.get("rationale"), "evidenceType": "metric", "evidence": {"exceptionHandlers": metrics.get("exceptionHandlers", 0)}},
        {"key": "C3", "dim": "code", "name": "精度与类型安全", "max": float(c3.get("max", 4)), "level": c3_level, "source": "auto", "rule": "浮点字面量数量阈值", "ruleVersion": profile.get("version", "1.0"), "rationale": c3.get("rationale"), "evidenceType": "metric", "evidence": {"floatLiterals": metrics.get("floatLiterals", 0)}},
        {"key": "C4", "dim": "code", "name": "抗变更能力", "max": float(c4.get("max", 5)), "level": c4_level, "source": "auto", "rule": "最大圈复杂度阈值", "ruleVersion": profile.get("version", "1.0"), "rationale": c4.get("rationale"), "evidenceType": "metric", "evidence": {"maxComplexity": metrics.get("maxComplexity", 0)}},
    ])
    findings: list[dict[str, Any]] = []
    for index, magic in enumerate(metrics.get("magicNumbers", []), start=1):
        line = int(magic.get("line", 1))
        finding = {"id": f"finding-magic-{index}", "dim": "code", "criteria": "C1", "severity": "minor", "title": "发现未命名业务数字", "file": entry, "line": line, "detail": f"数字 {magic.get('value')} 参与业务逻辑，降低规则可读性。", "fix": "提取为具有业务含义的全大写常量。"}
        if value := snippet(line):
            finding["snippet"] = value
        findings.append(finding)
    if metrics.get("exceptionHandlers", 0) < 1:
        findings.append({"id": "finding-code-c2", "dim": "code", "criteria": "C2", "severity": "major", "title": "缺少显式异常或边界处理", "file": entry, "detail": "静态度量未发现 try/except 或 raise，异常输入可能直接穿透到调用方。", "fix": "为外部输入和可预期失败路径增加明确的异常处理，并补充边界测试。"})
    if metrics.get("floatLiterals", 0) > 2:
        findings.append({"id": "finding-code-c3", "dim": "code", "criteria": "C3", "severity": "minor", "title": "浮点字面量过多", "file": entry, "detail": f"入口文件包含 {metrics.get('floatLiterals')} 个浮点字面量，精度语义不够集中。", "fix": "集中定义精度常量，金额计算优先使用整数最小单位或 Decimal。"})
    if metrics.get("maxComplexity", 0) > 8:
        findings.append({"id": "finding-code-c4", "dim": "code", "criteria": "C4", "severity": "major", "title": "圈复杂度超过阈值", "file": entry, "detail": f"入口函数最大圈复杂度为 {metrics.get('maxComplexity')}，超过 8 的可维护性阈值。", "fix": "拆分规则分支为小函数，并为每个变化点补充独立测试。"})
    for tier_name, tier_detail in verify_detail.get("tiers", {}).items():
        for case in tier_detail.get("cases", []):
            if not case.get("passed"):
                findings.append({"id": f"finding-{tier_name}-{case.get('index', 0)}", "dim": "verify", "criteria": {"basic": "V1", "boundary": "V2", "clarification": "V3", "change": "V4"}.get(tier_name, "V1"), "severity": "major", "title": f"{tier_name} 隐藏用例未通过", "detail": f"用例 {case.get('name', 'unnamed')} 未通过，请根据 expected/actual 定位边界行为。", "fix": "补充对应边界分支并回归全部隐藏测试。"})
    return criteria, verify_detail, metrics, findings


def _stable_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}-{digest}"


def cmd_run(args: argparse.Namespace) -> int:
    diagnostics = validate_submission(Path(args.submission), Path(args.contract), args.language)
    profile = _load_profile(args.zone)
    if args.full_local:
        criteria, verify_detail, metrics, findings = _heuristic_criteria(Path(args.submission), Path(args.contract), args.language, Path(args.tests) if args.tests else None, args.entry, args.function, profile)
    else:
        criteria = load_json(Path(args.criteria)) if args.criteria else []
        verify_detail, metrics, findings = {}, {}, []
    scored = score_criteria(criteria, profile["levelRatios"])
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    snapshot_hash_value = snapshot_hash(Path(args.submission))
    status = "PARTIAL" if any(item.severity == "BLOCKER" for item in diagnostics) or not criteria else "COMPLETE"
    result = {
        "schemaVersion": "1.0",
        "resultId": _stable_id("result", snapshot_hash_value),
        "gradingRunId": _stable_id("run", snapshot_hash_value, args.rubric_version, args.challenge_version),
        "challengeVersion": args.challenge_version,
        "rubricVersion": args.rubric_version,
        "graderVersion": GRADER_VERSION,
        "idempotencyKey": hashlib.sha256(f"{snapshot_hash_value}|{args.rubric_version}|{GRADER_VERSION}|{args.challenge_version}".encode()).hexdigest(),
        "triggerType": args.trigger_type,
        "status": status,
        "submission": {
            "sourceType": args.source_type,
            "snapshotHash": snapshot_hash_value,
            "submittedAt": now,
            **({"repository": args.repository, "branch": args.branch, "commitSha": args.commit_sha} if args.source_type == "GIT_REF" else {"artifactHash": snapshot_hash_value}),
        },
        "dimensions": scored["dimensions"],
        "criteria": scored["criteria"],
        "total": scored["total"],
        "validationDiagnostics": [item.as_dict() for item in diagnostics],
        "gradedBy": "ci",
        "startedAt": now,
        "finishedAt": now,
        "durationMs": 0,
        "gradedAt": now,
        "metadata": {
            "profile": args.zone.lower(),
            "profileVersion": profile.get("version", "1.0"),
            "evaluatedDimensions": [name for name, dimension in scored["dimensions"].items() if dimension["evaluated"]],
            "unevaluatedDimensions": [name for name, dimension in scored["dimensions"].items() if not dimension["evaluated"]],
        },
    }
    if args.full_local:
        result["verifyDetail"] = verify_detail
        result["metrics"] = metrics
        result["findings"] = findings
    assert_valid("evaluation-result", result)
    _write_json(Path(args.out) if args.out else None, result)
    return 1 if any(item.severity == "BLOCKER" for item in diagnostics) else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="drill-grader")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate")
    validate.add_argument("--submission", required=True)
    validate.add_argument("--contract", required=True)
    validate.add_argument("--language", default="python")
    validate.add_argument("--out")
    validate.set_defaults(handler=cmd_validate)

    score = subparsers.add_parser("score")
    score.add_argument("--criteria", required=True)
    score.add_argument("--out")
    score.set_defaults(handler=cmd_score)

    run = subparsers.add_parser("run")
    run.add_argument("--submission", required=True)
    run.add_argument("--contract", required=True)
    run.add_argument("--challenge-version", default="local@1")
    run.add_argument("--rubric-version", default="1.0")
    run.add_argument("--trigger-type", choices=["AUTO", "MANUAL", "IMPORT"], default="AUTO")
    run.add_argument("--source-type", choices=["UPLOAD", "GIT_REF"], default="UPLOAD")
    run.add_argument("--repository")
    run.add_argument("--branch")
    run.add_argument("--commit-sha")
    run.add_argument("--language", default="python")
    run.add_argument("--criteria")
    run.add_argument("--full-local", action="store_true")
    run.add_argument("--tests")
    run.add_argument("--entry", default="src/parking.py")
    run.add_argument("--function", default="calculate_fee")
    run.add_argument("--zone", choices=["yellow", "blue"], default="yellow")
    run.add_argument("--out")
    run.set_defaults(handler=cmd_run)

    measure = subparsers.add_parser("measure")
    measure.add_argument("--submission", required=True)
    measure.add_argument("--entry", required=True)
    measure.add_argument("--out")
    measure.set_defaults(handler=cmd_measure)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--submission", required=True)
    snapshot.add_argument("--out")
    snapshot.set_defaults(handler=cmd_snapshot)

    verify = subparsers.add_parser("verify")
    verify.add_argument("--submission", required=True)
    verify.add_argument("--tests", required=True)
    verify.add_argument("--entry", default="src/parking.py")
    verify.add_argument("--function", default="calculate_fee")
    verify.add_argument("--timeout", type=int, default=10)
    verify.add_argument("--zone", choices=["yellow", "blue"], default="yellow")
    verify.add_argument("--out")
    verify.set_defaults(handler=cmd_verify)

    check = subparsers.add_parser("check")
    check.add_argument("--submission", required=True)
    check.add_argument("--contract", required=True)
    check.add_argument("--language", default="python")
    check.add_argument("--out")
    check.set_defaults(handler=cmd_check)

    extract = subparsers.add_parser("extract")
    extract.add_argument("--submission", required=True)
    extract.add_argument("--out")
    extract.set_defaults(handler=cmd_extract)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
