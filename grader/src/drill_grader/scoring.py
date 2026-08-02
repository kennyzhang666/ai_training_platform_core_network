from __future__ import annotations

from collections import defaultdict
from typing import Any


DEFAULT_LEVEL_RATIOS = {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.0}
DIMENSION_MAX = {"verify": 40.0, "spec": 25.0, "code": 20.0, "collab": 15.0}


def score_criteria(criteria: list[dict[str, Any]], level_ratios: dict[str, float] | None = None) -> dict[str, Any]:
    ratios = level_ratios or DEFAULT_LEVEL_RATIOS
    normalized: list[dict[str, Any]] = []
    dimension_scores: dict[str, float] = defaultdict(float)
    dimension_max: dict[str, float] = defaultdict(float)
    for item in criteria:
        level = item.get("level", "D")
        if level not in ratios:
            raise ValueError(f"unknown level: {level}")
        max_score = float(item["max"])
        score = float(item["score"]) if item.get("useProvidedScore") else round(max_score * float(ratios[level]), 4)
        normalized_item = dict(item)
        normalized_item["score"] = score
        normalized_item.pop("useProvidedScore", None)
        normalized.append(normalized_item)
        dimension_scores[item["dim"]] += score
        dimension_max[item["dim"]] += max_score

    dimensions: dict[str, dict[str, Any]] = {}
    for dim, max_score in DIMENSION_MAX.items():
        if dim in dimension_max:
            dimensions[dim] = {
                "score": round(dimension_scores[dim], 4),
                "max": round(dimension_max[dim], 4),
                "evaluated": True,
            }
        else:
            dimensions[dim] = {"score": None, "max": max_score, "evaluated": False}

    return {
        "dimensions": dimensions,
        "criteria": normalized,
        "total": round(sum(d["score"] for d in dimensions.values() if d["evaluated"]), 4),
    }


def validate_score_consistency(result: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    dimensions = result.get("dimensions", {})
    criteria_sums: dict[str, float] = defaultdict(float)
    criteria_max: dict[str, float] = defaultdict(float)
    criteria_keys: set[str] = set()
    for criterion in result.get("criteria", []):
        key = str(criterion.get("key", ""))
        dim = str(criterion.get("dim", ""))
        if key in criteria_keys:
            errors.append(f"duplicate criterion key: {key}")
        criteria_keys.add(key)
        try:
            score = float(criterion["score"])
            maximum = float(criterion["max"])
        except (KeyError, TypeError, ValueError):
            errors.append(f"criterion has invalid score/max: {key}")
            continue
        if score < 0 or score > maximum:
            errors.append(f"criterion score out of range: {key}")
        criteria_sums[dim] += score
        criteria_max[dim] += maximum
    expected_total = 0.0
    for name in DIMENSION_MAX:
        dimension = dimensions.get(name)
        if not dimension:
            errors.append(f"missing dimension: {name}")
            continue
        if dimension.get("evaluated"):
            if dimension.get("score") is None:
                errors.append(f"evaluated dimension has null score: {name}")
            else:
                score = float(dimension["score"])
                expected_total += score
                if abs(score - criteria_sums[name]) > 0.0001:
                    errors.append(f"dimension mismatch: {name} expected {criteria_sums[name]}, got {score}")
                if abs(float(dimension.get("max", 0)) - criteria_max[name]) > 0.0001:
                    errors.append(f"dimension max mismatch: {name} expected {criteria_max[name]}, got {dimension.get('max')}")
        elif dimension.get("score") is not None:
            errors.append(f"unevaluated dimension must have null score: {name}")
        elif criteria_sums[name] != 0 or criteria_max[name] != 0:
            errors.append(f"criteria exist for unevaluated dimension: {name}")
    if abs(expected_total - float(result.get("total", -1))) > 0.0001:
        errors.append(f"total mismatch: expected {expected_total}, got {result.get('total')}")
    return errors
