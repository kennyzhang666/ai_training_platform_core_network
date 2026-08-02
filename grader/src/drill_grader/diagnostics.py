from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any


@dataclass(frozen=True)
class Diagnostic:
    severity: str
    code: str
    message: str
    path: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}


def blocker(code: str, message: str, path: str | None = None) -> Diagnostic:
    return Diagnostic("BLOCKER", code, message, path)


def warning(code: str, message: str, path: str | None = None) -> Diagnostic:
    return Diagnostic("WARNING", code, message, path)


def info(code: str, message: str, path: str | None = None) -> Diagnostic:
    return Diagnostic("INFO", code, message, path)
