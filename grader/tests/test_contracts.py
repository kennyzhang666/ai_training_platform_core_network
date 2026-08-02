from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "grader" / "src"))

from drill_grader.scoring import score_criteria, validate_score_consistency  # noqa: E402
from drill_grader.schemas import load_json, validate_schema  # noqa: E402
from drill_grader.metrics import measure_python  # noqa: E402
from drill_grader.snapshot import snapshot_hash  # noqa: E402
from drill_grader.submission import validate_submission  # noqa: E402
from drill_grader.verify import verify_submission  # noqa: E402


class ContractTests(unittest.TestCase):
    examples = ROOT / "contracts" / "examples"

    def test_valid_challenge_and_submission_contract(self) -> None:
        self.assertEqual(validate_schema("challenge", load_json(self.examples / "challenge.valid.json")), [])
        self.assertEqual(validate_schema("submission-contract", load_json(self.examples / "submission-contract.valid.json")), [])

    def test_invalid_challenge_and_submission_contract(self) -> None:
        self.assertTrue(validate_schema("challenge", load_json(self.examples / "challenge.invalid.json")))
        self.assertTrue(validate_schema("submission-contract", load_json(self.examples / "submission-contract.invalid.json")))

    def test_five_valid_evaluation_results(self) -> None:
        samples = load_json(self.examples / "evaluation-results.valid.json")
        self.assertEqual(len(samples), 5)
        for sample in samples:
            self.assertEqual(validate_schema("evaluation-result", sample), [])

    def test_ten_invalid_evaluation_results(self) -> None:
        samples = load_json(self.examples / "evaluation-results.invalid.json")
        self.assertEqual(len(samples), 10)
        for sample in samples:
            self.assertTrue(validate_schema("evaluation-result", sample))

    def test_score_is_deterministic_and_consistent(self) -> None:
        criteria = [
            {"key": "V1", "dim": "verify", "name": "基础", "max": 40, "level": "A", "source": "auto", "rule": "all"},
            {"key": "C1", "dim": "code", "name": "常量", "max": 20, "level": "B", "source": "auto", "rule": "most"},
        ]
        first = score_criteria(criteria)
        second = score_criteria(criteria)
        self.assertEqual(first, second)
        result = {**first}
        self.assertEqual(validate_score_consistency(result), [])
        self.assertEqual(first["total"], 55.0)

    def test_reference_submission_passes_all_local_tiers(self) -> None:
        submission = ROOT / "challenges" / "parking-fee-v1" / "starter"
        tests = ROOT / "challenges" / "parking-fee-v1" / "hidden-tests"
        detail = verify_submission(submission, tests, "src/parking.py", "calculate_fee")
        self.assertEqual(detail["passed"], detail["total"])
        self.assertEqual(detail["weightedScore"], 40.0)

    def test_python_metrics_support_current_runtime(self) -> None:
        metrics = measure_python(ROOT / "challenges" / "parking-fee-v1" / "starter", "src/parking.py")
        self.assertIsNone(metrics.get("parseError"))
        self.assertGreaterEqual(metrics["maxComplexity"], 1)

    def test_snapshot_hash_is_stable_for_repeated_runs(self) -> None:
        submission = ROOT / "challenges" / "parking-fee-v1" / "starter"
        hashes = {snapshot_hash(submission) for _ in range(20)}
        self.assertEqual(len(hashes), 1)

    def test_reference_submission_passes_the_full_hidden_matrix(self) -> None:
        tests = ROOT / "challenges" / "parking-fee-v1" / "hidden-tests"
        detail = verify_submission(ROOT / "challenges" / "parking-fee-v1" / "reference", tests, "src/parking.py", "calculate_fee")
        self.assertEqual(detail["total"], 25)
        self.assertEqual(detail["passed"], 25)

    def test_submission_contract_checks_signature_without_requiring_annotations(self) -> None:
        contract = ROOT / "challenges" / "parking-fee-v1" / "submission-contract.json"
        diagnostics = validate_submission(ROOT / "challenges" / "parking-fee-v1" / "starter", contract)
        self.assertFalse([item for item in diagnostics if item.severity == "BLOCKER"])


if __name__ == "__main__":
    unittest.main()
