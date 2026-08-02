from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "grader" / "src"))

from drill_grader.cli import _heuristic_criteria, _load_profile  # noqa: E402
from drill_grader.metrics import measure_python  # noqa: E402
from drill_grader.snapshot import snapshot_hash  # noqa: E402
from drill_grader.submission import validate_submission  # noqa: E402
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


class ScoringBoundaryTests(unittest.TestCase):
    contract = ROOT / "challenges" / "parking-fee-v1" / "submission-contract.json"
    reference = ROOT / "challenges" / "parking-fee-v1" / "reference"

    def test_missing_tier_is_not_scored_against_the_submission(self) -> None:
        """A challenge that ships only two tiers must not lose the other two.

        The tier files are the only source of a tier's cases, so an absent tier
        cannot be earned. Emitting it as a D-level criterion with its full
        maximum deducted those points from every submission of that challenge.
        """
        with tempfile.TemporaryDirectory() as tmp:
            partial = Path(tmp) / "hidden-tests"
            partial.mkdir()
            for tier in ("basic", "boundary"):
                shutil.copyfile(GoldenFixtureTests.hidden_tests / f"{tier}.json", partial / f"{tier}.json")
            criteria, detail, _, _ = _heuristic_criteria(
                self.reference, self.contract, "python", partial, "src/parking.py", "calculate_fee", _load_profile("yellow"),
            )
        verify_keys = {item["key"] for item in criteria if item["dim"] == "verify"}
        self.assertEqual(verify_keys, {"V1", "V2"})
        verify_max = sum(item["max"] for item in criteria if item["dim"] == "verify")
        verify_score = sum(item["score"] for item in criteria if item["dim"] == "verify")
        self.assertEqual(verify_max, 20.0)
        self.assertEqual(verify_score, 20.0)
        self.assertEqual(detail["availableScore"], 20.0)
        self.assertEqual(detail["weightedScore"], 20.0)

    def test_full_matrix_still_awards_the_whole_verify_dimension(self) -> None:
        criteria, detail, _, _ = _heuristic_criteria(
            self.reference, self.contract, "python", GoldenFixtureTests.hidden_tests, "src/parking.py", "calculate_fee", _load_profile("yellow"),
        )
        self.assertEqual(sum(item["max"] for item in criteria if item["dim"] == "verify"), 40.0)
        self.assertEqual(sum(item["score"] for item in criteria if item["dim"] == "verify"), 40.0)
        self.assertEqual(detail["weightedScore"], 40.0)

    def test_format_diagnostics_do_not_double_punish(self) -> None:
        """Template and signature findings diagnose; they must not block.

        The failure policy reserves BLOCKER for deliveries that cannot be
        evaluated at all. Returning the untouched template or using the wrong
        signature already costs rubric points, so those are warnings.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src").mkdir()
            (root / "SPEC.md").write_text("# 需求理解\n\nTODO 待补充\n", encoding="utf-8")
            (root / "transcript.md").write_text("对话记录。" * 60, encoding="utf-8")
            (root / "src" / "parking.py").write_text(
                "def calculate_fee(entry_time, exit_time):\n    return 0.0\n", encoding="utf-8",
            )
            diagnostics = validate_submission(root, self.contract)
        codes = {item.code: item.severity for item in diagnostics}
        self.assertEqual(codes.get("SOURCE_IS_TEMPLATE"), "WARNING")
        self.assertEqual(codes.get("FUNCTION_SIGNATURE_MISMATCH"), "WARNING")
        self.assertNotIn("BLOCKER", codes.values())
        # tests/ and NOTES.md are declared optional, so their absence is INFO.
        self.assertEqual(codes.get("OPTIONAL_PATH_MISSING"), "INFO")
