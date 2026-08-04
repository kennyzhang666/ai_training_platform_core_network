"""No-dependency reference engine for the standalone development kit."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    started = time.time()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    answer_path = Path(payload["workspace"]) / "answer.txt"
    answer = answer_path.read_text(encoding="utf-8").strip() if answer_path.is_file() else ""
    correct = answer == "42"
    score = 100 if correct else 0
    finished = time.time()
    run_id = payload["grading"]["runId"]
    result_id = "result-" + hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:24]
    result = {
        "schemaVersion": "1.0",
        "resultId": result_id,
        "gradingRunId": run_id,
        "challengeVersion": payload["challenge"]["challengeVersion"],
        "rubricVersion": payload["challenge"]["rubricVersion"],
        "graderVersion": "minimal-score-engine@1.0.0",
        "idempotencyKey": payload["grading"]["idempotencyKey"],
        "triggerType": payload["grading"]["triggerType"],
        "status": "COMPLETE" if correct else "PARTIAL",
        "submission": {
            "sourceType": payload["submission"]["sourceType"],
            "snapshotHash": payload["submission"]["snapshotHash"],
            "artifactHash": payload["submission"]["artifactHash"],
            "submittedAt": payload["submission"]["submittedAt"],
        },
        "dimensions": {
            "verify": {"score": score, "max": 100, "evaluated": True},
            "spec": {"score": 0, "max": 1, "evaluated": True},
            "code": {"score": 0, "max": 1, "evaluated": True},
            "collab": {"score": 0, "max": 1, "evaluated": True},
        },
        "criteria": [{
            "key": "VERIFY_ANSWER",
            "dim": "verify",
            "name": "答案校验",
            "max": 100,
            "level": "A" if correct else "D",
            "score": score,
            "source": "auto",
            "rule": "answer.txt 必须只包含 42",
            "evidence": {"path": str(answer_path), "actual": answer},
            "evidenceType": "test",
            "ruleVersion": "1.0",
        }],
        "total": score,
        "validationDiagnostics": [] if answer_path.is_file() else [{
            "severity": "BLOCKER",
            "code": "MISSING_INPUT",
            "message": "workspace/answer.txt 不存在",
        }],
        "gradedBy": "ci",
        "startedAt": now(),
        "finishedAt": now(),
        "durationMs": int((finished - started) * 1000),
        "metadata": {"standalone": True, "answerChecked": True},
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
