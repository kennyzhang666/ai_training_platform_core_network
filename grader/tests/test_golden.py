from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "grader" / "src"))

from drill_grader.cli import _heuristic_criteria, _load_profile  # noqa: E402
from drill_grader.metrics import measure_python  # noqa: E402
from drill_grader.snapshot import snapshot_hash  # noqa: E402
from drill_grader.verify import verify_submission  # noqa: E402


class GoldenFixtureTests(unittest.TestCase):
    hidden_tests = ROOT / "challenges" / "parking-fee-v1" / "hidden-tests"
    contract = ROOT / "challenges" / "parking-fee-v1" / "submission-contract.json"

    def test_manifest_has_five_acceptance_shapes(self) -> None:
        manifest = json.loads((ROOT / "grader/tests/fixtures/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["fixtures"]), 5)
        self.assertEqual({item["kind"] for item in manifest["fixtures"]}, {"reference", "defect-basic", "magic-number", "missing-entry", "timeout"})

    def test_reference_is_full_verify_and_stable(self) -> None:
        root = ROOT / "challenges/parking-fee-v1/reference"
        first = verify_submission(root, self.hidden_tests, "src/parking.py", "calculate_fee")
        second = verify_submission(root, self.hidden_tests, "src/parking.py", "calculate_fee")
        self.assertEqual((first["passed"], first["total"], first["weightedScore"]), (25, 25, 40.0))
        self.assertEqual(first["tiers"], second["tiers"])
        self.assertEqual(len({snapshot_hash(root) for _ in range(20)}), 1)

    def test_defect_fixture_is_partial(self) -> None:
        detail = verify_submission(ROOT / "grader/tests/fixtures/defect-basic", self.hidden_tests, "src/parking.py", "calculate_fee")
        self.assertLess(detail["passed"], detail["total"])

    def test_magic_number_fixture_has_line_evidence(self) -> None:
        root = ROOT / "grader/tests/fixtures/magic-number"
        metrics = measure_python(root, "src/parking.py")
        self.assertTrue(metrics["magicNumbers"])
        criteria, _, _, findings = _heuristic_criteria(root, self.contract, "python", self.hidden_tests, "src/parking.py", "calculate_fee", _load_profile("yellow"))
        c1 = next(item for item in criteria if item["key"] == "C1")
        self.assertIn(c1["level"], {"C", "D"})
        self.assertTrue(all(item.get("line", 0) > 0 and item.get("snippet") for item in findings if item["criteria"] == "C1"))

    def test_timeout_fixture_is_terminated(self) -> None:
        detail = verify_submission(ROOT / "grader/tests/fixtures/timeout", self.hidden_tests, "src/parking.py", "calculate_fee", timeout=1)
        self.assertTrue(any(item.get("timedOut") for item in detail["tiers"].values()))


if __name__ == "__main__":
    unittest.main()
