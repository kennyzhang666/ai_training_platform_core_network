"""可配置、失败关闭的流式运维日志脱敏工具。"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, TextIO


RULE_PRIORITY = (
    "authorization", "url_query_secret", "key_value_secret", "correlation_identifier",
    "identity_number", "mobile", "email", "ipv4", "mac",
)
DEFAULT_POLICY: dict[str, Any] = {
    "version": "2.0",
    "maxLineChars": 4096,
    "keyEnv": "LOG_REDACTION_KEY",
    "secretFields": ["authorization", "password", "token", "access_token", "api_key", "secret"],
    "correlationFields": ["user_id", "device_id"],
    "textRulePriority": list(RULE_PRIORITY),
}
AUTH_RE = re.compile(r"(?i)\b(authorization)\s*:\s*(?:bearer\s+)?[^\s,;]+")
QUERY_SECRET_RE = re.compile(r"(?i)([?&](?:token|access_token|password|api_key)=)[^&#\s]+")
KEY_SECRET_RE = re.compile(r"(?i)\b(token|access_token|password|api_key)\s*=\s*([^\s,;&#]+)")
CORRELATION_RE = re.compile(r"(?i)\b(user_id|device_id)=([^\s,;&#]+)")
IDENTITY_RE = re.compile(r"(?<![0-9Xx])(\d{6})\d{8}([0-9Xx]{4})(?![0-9Xx])")
MOBILE_RE = re.compile(r"(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)")
EMAIL_RE = re.compile(r"\b([A-Za-z0-9])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
IPV4_RE = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b")
MAC_RE = re.compile(r"(?i)\b([0-9a-f]{2}:[0-9a-f]{2}):[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}\b")


class RedactionError(ValueError):
    """只携带稳定错误码的处理异常。"""


class Policy(dict[str, Any]):
    """已校验的只读约定策略值；调用方不得在处理期间修改。"""


def validate_policy(value: Mapping[str, Any]) -> Policy:
    """校验策略的必需字段、类型和冻结优先级。"""
    if isinstance(value, Policy):
        return value
    try:
        version = value["version"]
        maximum = value["maxLineChars"]
        key_env = value["keyEnv"]
        secret_fields = value["secretFields"]
        correlation_fields = value["correlationFields"]
        priority = value["textRulePriority"]
        valid = (
            version == "2.0"
            and isinstance(maximum, int) and not isinstance(maximum, bool) and 16 <= maximum <= 1_048_576
            and isinstance(key_env, str) and bool(re.fullmatch(r"[A-Z][A-Z0-9_]{2,63}", key_env))
            and isinstance(secret_fields, list) and bool(secret_fields) and all(isinstance(item, str) and item for item in secret_fields)
            and isinstance(correlation_fields, list) and bool(correlation_fields) and all(isinstance(item, str) and item for item in correlation_fields)
            and priority == list(RULE_PRIORITY)
        )
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise RedactionError("POLICY_INVALID")
    return Policy(value)


def load_policy(path: str | Path) -> Policy:
    """读取 UTF-8 JSON 策略并转换成已校验对象。"""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RedactionError("POLICY_INVALID") from error
    if not isinstance(value, Mapping):
        raise RedactionError("POLICY_INVALID")
    return validate_policy(value)


def _key_bytes(policy: Policy, key: str | bytes | None) -> bytes:
    selected: str | bytes | None = key
    if selected is None:
        selected = os.environ.get(str(policy["keyEnv"]))
    if isinstance(selected, str):
        selected = selected.encode("utf-8")
    if not isinstance(selected, bytes) or len(selected) < 16:
        raise RedactionError("KEY_UNAVAILABLE")
    return selected


def _alias(value: Any, policy: Policy, key: str | bytes | None) -> str:
    text = str(value)
    if text.startswith("hmac:") and re.fullmatch(r"hmac:[0-9a-f]{24}", text):
        return text
    digest = hmac.new(_key_bytes(policy, key), text.encode("utf-8"), hashlib.sha256).hexdigest()[:24]
    return f"hmac:{digest}"


def redact_text(text: str, policy: Mapping[str, Any] | None = None, key: str | bytes | None = None) -> str:
    """按冻结优先级处理普通文本、请求头、URL 和关联标识。"""
    if not isinstance(text, str):
        raise TypeError("TEXT_TYPE_INVALID")
    selected = validate_policy(policy or DEFAULT_POLICY)
    result = AUTH_RE.sub(lambda match: f"{match.group(1)}: ***", text)
    result = QUERY_SECRET_RE.sub(lambda match: f"{match.group(1)}***", result)
    result = KEY_SECRET_RE.sub(lambda match: f"{match.group(1)}=***", result)

    def replace_correlation(match: re.Match[str]) -> str:
        return f"{match.group(1)}={_alias(match.group(2), selected, key)}"

    result = CORRELATION_RE.sub(replace_correlation, result)
    result = IDENTITY_RE.sub(r"\1********\2", result)
    result = MOBILE_RE.sub(r"\1****\2", result)
    result = EMAIL_RE.sub(r"\1***\2", result)
    result = IPV4_RE.sub(r"\1.\2.*.*", result)
    result = MAC_RE.sub(r"\1:**:**:**:**", result)
    return result


def redact_record(value: Any, policy: Mapping[str, Any] | None = None, key: str | bytes | None = None) -> Any:
    """递归处理 JSON 值，保持非敏感字段的数据类型。"""
    selected = validate_policy(policy or DEFAULT_POLICY)
    secret_fields = {str(item).casefold().replace("-", "_") for item in selected["secretFields"]}
    correlation_fields = {str(item).casefold().replace("-", "_") for item in selected["correlationFields"]}
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for raw_name, item in value.items():
            name = str(raw_name)
            normalized = name.casefold().replace("-", "_")
            if normalized in secret_fields:
                result[name] = "***"
            elif normalized in correlation_fields:
                result[name] = _alias(item, selected, key)
            else:
                result[name] = redact_record(item, selected, key)
        return result
    if isinstance(value, list):
        return [redact_record(item, selected, key) for item in value]
    if isinstance(value, str):
        return redact_text(value, selected, key)
    return value


def redact_line(line: str, policy: Mapping[str, Any] | None = None, key: str | bytes | None = None) -> str:
    """处理单行普通文本或 JSON；结构化失败时不回退原文。"""
    if not isinstance(line, str):
        raise TypeError("LINE_TYPE_INVALID")
    selected = validate_policy(policy or DEFAULT_POLICY)
    if len(line) > int(selected["maxLineChars"]):
        return "[REDACTION_ERROR:LINE_TOO_LONG]"
    structured = line.lstrip().startswith(("{", "["))
    if not structured:
        return redact_text(line, selected, key)
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return "[REDACTION_ERROR:MALFORMED_JSON]"
    redacted = redact_record(value, selected, key)
    return json.dumps(redacted, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def redact_stream(
    reader: Iterable[str],
    writer: TextIO,
    policy: Mapping[str, Any] | None = None,
    key: str | bytes | None = None,
) -> dict[str, int]:
    """逐行处理输入并返回稳定统计，禁止批量 read 或 readlines。"""
    selected = validate_policy(policy or DEFAULT_POLICY)
    stats = {"lines": 0, "redacted": 0, "errors": 0}
    for raw in reader:
        line = raw.rstrip("\r\n")
        output = redact_line(line, selected, key)
        compare = output != line
        stats["lines"] += 1
        stats["redacted"] += int(compare)
        stats["errors"] += int(output.startswith("[REDACTION_ERROR:"))
        writer.write(output + "\n")
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="运维日志流式脱敏")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--policy", required=True)
    args = parser.parse_args(argv)
    temporary_path: Path | None = None
    try:
        policy = load_policy(args.policy)
        target = Path(args.output)
        temporary_path = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        with Path(args.input).open("r", encoding="utf-8") as reader, temporary_path.open("w", encoding="utf-8", newline="\n") as writer:
            redact_stream(reader, writer, policy=policy)
        os.replace(temporary_path, target)
        return 0
    except (OSError, RedactionError, TypeError) as error:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
        code = str(error) if isinstance(error, RedactionError) else "IO_ERROR"
        sys.stderr.write(f"ERROR {code}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
