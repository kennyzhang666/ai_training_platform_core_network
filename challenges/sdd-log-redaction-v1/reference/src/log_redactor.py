"""确定性的单行运维日志脱敏工具。"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]
    replacement: str | Any


DEFAULT_RULES: tuple[Rule, ...] = (
    Rule("MOBILE", re.compile(r"(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)"), r"\1****\2"),
    Rule("IDENTITY", re.compile(r"(?<!\d)(\d{6})\d{8}([0-9Xx]{4})(?![0-9Xx])"), r"\1********\2"),
    Rule("EMAIL", re.compile(r"\b([A-Za-z0-9])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"), r"\1***\2"),
    Rule("IP", re.compile(r"\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b"), r"\1.\2.*.*"),
    Rule("TOKEN", re.compile(r"(?i)\b(token|authorization|password)=([^\s,;]+)"), r"\1=***"),
)


def redact_text(text: str, rules: Sequence[Rule] | None = None) -> str:
    """按稳定顺序执行全部规则；再次调用不会恢复或扩大敏感信息。"""
    if not isinstance(text, str):
        raise TypeError("text must be str")
    selected = DEFAULT_RULES if rules is None else tuple(rules)
    if any(not isinstance(rule, Rule) for rule in selected):
        raise ValueError("rules must contain Rule values")
    result = text
    for rule in selected:
        result = rule.pattern.sub(rule.replacement, result)
    return result


def redact_record(value: Any, rules: Sequence[Rule] | None = None) -> Any:
    """递归处理 JSON 值，只替换字符串并保持其他字段类型。"""
    if isinstance(value, str):
        return redact_text(value, rules)
    if isinstance(value, Mapping):
        return {str(key): redact_record(item, rules) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray, str)):
        return [redact_record(item, rules) for item in value]
    return value


def redact_line(line: str, rules: Sequence[Rule] | None = None) -> str:
    """脱敏一行 JSON 或普通文本日志。"""
    if not isinstance(line, str):
        raise TypeError("line must be str")
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return redact_text(line, rules)
    redacted = redact_record(parsed, rules)
    return json.dumps(redacted, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="运维日志脱敏")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    source = Path(args.input)
    target = Path(args.output)
    with source.open("r", encoding="utf-8") as reader, target.open("w", encoding="utf-8", newline="\n") as writer:
        for raw_line in reader:
            writer.write(redact_line(raw_line.rstrip("\r\n")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
