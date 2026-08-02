from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def schema_path(name: str) -> Path:
    paths = {
        "challenge": CONTRACTS / "challenge.schema.json",
        "submission-contract": CONTRACTS / "submission-contract.schema.json",
        "evaluation-result": CONTRACTS / "evaluation-result.schema.json",
    }
    try:
        return paths[name]
    except KeyError as exc:
        raise ValueError(f"unknown schema: {name}") from exc


def validate_schema(name: str, document: Any) -> list[dict[str, Any]]:
    schema = load_json(schema_path(name))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors: list[dict[str, Any]] = []
    for error in sorted(validator.iter_errors(document), key=lambda item: list(item.path)):
        path = ".".join(str(part) for part in error.path) or "$"
        errors.append({"path": path, "message": error.message, "validator": error.validator})
    return errors


def assert_valid(name: str, document: Any) -> None:
    errors = validate_schema(name, document)
    if errors:
        details = "; ".join(f"{item['path']}: {item['message']}" for item in errors)
        raise ValueError(f"{name} schema validation failed: {details}")
