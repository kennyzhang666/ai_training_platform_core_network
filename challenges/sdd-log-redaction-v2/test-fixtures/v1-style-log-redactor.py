"""仅用于评测引擎强度回归的旧式实现。"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping


RULES = (
    (re.compile(r"(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)"), r"\1****\2"),
    (re.compile(r"\b([A-Za-z0-9])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"), r"\1***\2"),
    (re.compile(r"(?i)\b(token|password)=([^\s,;]+)"), r"\1=***"),
)


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        result = value
        for pattern, replacement in RULES:
            result = pattern.sub(replacement, result)
        return result
    if isinstance(value, Mapping):
        return {str(key): _redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def redact_line(line: str, rules: Any = None) -> str:
    """旧版仅处理基础文本与 JSON，不支持策略、HMAC、失败关闭和流式接口。"""
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return _redact(line)
    return json.dumps(_redact(parsed), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
