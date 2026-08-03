"""内置通用判题器 · 调用适配层。

评测环境按统一约定调用本脚本：

    python -I judge.py --input <invocation.json> --output <result.json>

输入符合 `contracts/engine-invocation.schema.json`，输出符合
`contracts/evaluation-result.schema.json`。三种评测方式（线下录入、内置执行器、
上传引擎包）因此共用同一组契约——内置执行器不再靠命令行参数被特殊对待。

判据本身仍在 `grader/src/drill_grader` 里；这里只做参数适配和结果拼装，
不重复实现任何评分逻辑。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

GRADER_VERSION = "drill-grader@0.3.0"


def _grader_root() -> Path:
    """定位仓库内的 drill_grader 包。

    内置执行器随仓库发布，因此按本脚本相对位置回溯即可
    （executors/drill-grader/judge.py -> 仓库根）；评测环境把仓库放在别处时可用
    DRILL_GRADER_SRC 覆盖。
    """
    explicit = os.environ.get("DRILL_GRADER_SRC")
    if explicit:
        return Path(explicit)
    return Path(__file__).resolve().parents[2] / "grader" / "src"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="drill-grader-judge")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))

    params: dict[str, Any] = payload.get("params") or {}
    workspace = Path(payload["workspace"])
    assets = payload["engine"].get("assets", {})
    grader_source = Path(assets["graderSource"]).parent if assets.get("graderSource") else _grader_root()
    sys.path.insert(0, str(grader_source))
    from drill_grader.cli import _heuristic_criteria, _load_profile  # noqa: E402
    from drill_grader.scoring import score_criteria  # noqa: E402
    from drill_grader.submission import validate_submission  # noqa: E402

    # 平台已经把参数里的仓库路径解析成沙箱内的绝对路径放进 engine.assets，
    # 因此判题器不需要知道仓库根在哪。
    contract = Path(assets["submissionContract"]) if assets.get("submissionContract") else Path(params["contractPath"])
    tests_dir = Path(assets["testsDir"]) if assets.get("testsDir") else (Path(params["testsDir"]) if params.get("testsDir") else None)
    entry = params["entry"]
    function = params["function"]
    language = params.get("language", "python")
    profile = _load_profile(params.get("zone", "yellow"))

    diagnostics = validate_submission(workspace, contract, language)
    criteria, verify_detail, metrics, findings = _heuristic_criteria(
        workspace, contract, language, tests_dir, entry, function, profile,
    )
    scored = score_criteria(criteria, profile["levelRatios"])
    blocked = any(item.severity == "BLOCKER" for item in diagnostics)
    finished = time.time()

    result = {
        "schemaVersion": "1.0",
        "resultId": f"result-{hashlib.sha256((payload['submission']['snapshotHash'] + payload['grading']['runId']).encode()).hexdigest()[:24]}",
        "gradingRunId": payload["grading"]["runId"],
        "challengeVersion": payload["challenge"]["challengeVersion"],
        "rubricVersion": payload["challenge"]["rubricVersion"],
        "graderVersion": GRADER_VERSION,
        "idempotencyKey": payload["grading"]["idempotencyKey"],
        "triggerType": payload["grading"]["triggerType"],
        "status": "PARTIAL" if blocked or not criteria else "COMPLETE",
        "submission": {
            key: value
            for key, value in payload["submission"].items()
            if key in {"sourceType", "repository", "branch", "commitSha", "snapshotHash", "artifactHash", "submittedAt"}
        },
        "dimensions": scored["dimensions"],
        "criteria": scored["criteria"],
        "total": scored["total"],
        "findings": findings,
        "validationDiagnostics": [item.as_dict() for item in diagnostics],
        "verifyDetail": verify_detail,
        "metrics": metrics,
        "gradedBy": "ci",
        "startedAt": started_at,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        "durationMs": int((finished - started) * 1000),
        "metadata": {
            "profile": params.get("zone", "yellow"),
            "profileVersion": profile.get("version", "1.0"),
            "executor": GRADER_VERSION,
        },
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
