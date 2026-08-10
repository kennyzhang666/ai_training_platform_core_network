#!/usr/bin/env python3
"""评测方隐藏功能用例。

仅输出用例编号、层级和通过状态，避免把冻结输入、期望输出或密钥带入平台结果。
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Iterator


TIERS = ("core", "complex", "safety", "engineering")
TEST_KEY = "hidden-evaluator-key-v2"
OTHER_KEY = "hidden-evaluator-key-v2-other"


def _load_module(workspace: Path) -> ModuleType:
    source = workspace / "src" / "log_redactor.py"
    spec = importlib.util.spec_from_file_location("learner_log_redactor", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("MODULE_LOAD_FAILED")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _assert(condition: bool) -> None:
    if not condition:
        raise AssertionError("CHECK_FAILED")


def _alias(value: str, key: str = TEST_KEY) -> str:
    digest = hmac.new(key.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()[:24]
    return f"hmac:{digest}"


class _OnePassReader:
    def __init__(self, lines: list[str]) -> None:
        self._lines = iter(lines)

    def __iter__(self) -> "_OnePassReader":
        return self

    def __next__(self) -> str:
        return next(self._lines)

    def read(self, *_args: Any, **_kwargs: Any) -> str:
        raise AssertionError("BULK_READ_FORBIDDEN")

    def readlines(self, *_args: Any, **_kwargs: Any) -> list[str]:
        raise AssertionError("BULK_READ_FORBIDDEN")


def _run_cli(module: ModuleType, arguments: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(Path(module.__file__).resolve()), *arguments],
        cwd=Path(module.__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        env={**os.environ, **env, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def _checks(module: ModuleType, workspace: Path, policy: Any) -> list[tuple[str, str, Callable[[], None]]]:
    redact_line = getattr(module, "redact_line")
    redact_stream = getattr(module, "redact_stream")
    load_policy = getattr(module, "load_policy")

    def core_01() -> None:
        raw = "mobile=13812348000 id=110101199001011234 email=alice@example.com ip=10.20.30.40 token=plain-token"
        output = redact_line(raw, policy=policy, key=TEST_KEY)
        _assert("138****8000" in output)
        _assert("110101********1234" in output)
        _assert("a***@example.com" in output)
        _assert("10.20.*.*" in output)
        _assert("token=***" in output)
        _assert(not any(value in output for value in ("13812348000", "110101199001011234", "alice@example.com", "plain-token")))

    def core_02() -> None:
        value = json.loads(redact_line('{"mobile":"13812348000","status":200,"ok":true,"empty":null}', policy=policy, key=TEST_KEY))
        _assert(value == {"empty": None, "mobile": "138****8000", "ok": True, "status": 200})

    def core_03() -> None:
        raw = '{"items":[{"email":"a.long.name@example.cn"},{"nested":{"ip":"192.168.10.99"}}]}'
        value = json.loads(redact_line(raw, policy=policy, key=TEST_KEY))
        _assert(value["items"][0]["email"] == "a***@example.cn")
        _assert(value["items"][1]["nested"]["ip"] == "192.168.*.*")

    def core_04() -> None:
        raw = '{"Authorization":"Bearer bearer-value","api_key":"api-value","PASSWORD":123456,"safe":"ok"}'
        value = json.loads(redact_line(raw, policy=policy, key=TEST_KEY))
        _assert(value["Authorization"] == "***" and value["api_key"] == "***" and value["PASSWORD"] == "***")
        _assert(value["safe"] == "ok")

    def core_05() -> None:
        raw = "Authorization: Bearer bearer-value GET /api?token=url-token&name=alice&password=url-password"
        output = redact_line(raw, policy=policy, key=TEST_KEY)
        _assert("Authorization: ***" in output)
        _assert("token=***" in output and "password=***" in output and "name=alice" in output)
        _assert(not any(value in output for value in ("bearer-value", "url-token", "url-password")))

    def core_06() -> None:
        loaded = load_policy(workspace / "policy" / "redaction_policy.json")
        _assert(loaded["version"] == "2.0")
        _assert(isinstance(loaded["maxLineChars"], int))
        _assert("authorization" in [str(item).lower() for item in loaded["secretFields"]])
        _assert("user_id" in [str(item).lower() for item in loaded["correlationFields"]])

    def complex_07() -> None:
        output = redact_line("identity=110101199001011234 mobile=13812348000", policy=policy, key=TEST_KEY)
        _assert(output == "identity=110101********1234 mobile=138****8000")

    def complex_08() -> None:
        once = redact_line("user_id=employee-001 email=alice@example.com ip=10.20.30.40", policy=policy, key=TEST_KEY)
        twice = redact_line(once, policy=policy, key=TEST_KEY)
        _assert(once == twice)

    def complex_09() -> None:
        first = json.loads(redact_line('{"user_id":"employee-001"}', policy=policy, key=TEST_KEY))["user_id"]
        second = json.loads(redact_line('{"user_id":"employee-001"}', policy=policy, key=TEST_KEY))["user_id"]
        _assert(first == second == _alias("employee-001"))

    def complex_10() -> None:
        first = json.loads(redact_line('{"user_id":"employee-001"}', policy=policy, key=TEST_KEY))["user_id"]
        other_value = json.loads(redact_line('{"user_id":"employee-002"}', policy=policy, key=TEST_KEY))["user_id"]
        other_key = json.loads(redact_line('{"user_id":"employee-001"}', policy=policy, key=OTHER_KEY))["user_id"]
        _assert(len({first, other_value, other_key}) == 3)

    def complex_11() -> None:
        value = json.loads(redact_line('{"message":"用户张三邮箱 zhangsan@example.cn","city":"深圳"}', policy=policy, key=TEST_KEY))
        _assert(value["message"] == "用户张三邮箱 z***@example.cn")
        _assert(value["city"] == "深圳")

    def complex_12() -> None:
        raw = '{"user_id":"employee-001","events":[{"device_id":"device-a"},{"user_id":"employee-001"}]}'
        value = json.loads(redact_line(raw, policy=policy, key=TEST_KEY))
        _assert(value["user_id"] == value["events"][1]["user_id"] == _alias("employee-001"))
        _assert(value["events"][0]["device_id"] == _alias("device-a"))

    def safety_13() -> None:
        previous = os.environ.pop("LOG_REDACTION_KEY", None)
        try:
            try:
                redact_line('{"user_id":"employee-001"}', policy=policy, key=None)
            except Exception as error:  # noqa: BLE001 - learner exception type is intentionally open
                rendered = str(error)
                _assert("KEY_UNAVAILABLE" in rendered)
                _assert("employee-001" not in rendered)
            else:
                raise AssertionError("MISSING_KEY_ACCEPTED")
            try:
                redact_line('{"user_id":"employee-001"}', policy=policy, key="short")
            except Exception as error:  # noqa: BLE001
                _assert("KEY_UNAVAILABLE" in str(error))
                _assert("employee-001" not in str(error))
            else:
                raise AssertionError("WEAK_KEY_ACCEPTED")
        finally:
            if previous is not None:
                os.environ["LOG_REDACTION_KEY"] = previous

    def safety_14() -> None:
        raw = '{"password":"raw-password"'
        output = redact_line(raw, policy=policy, key=TEST_KEY)
        _assert(output == "[REDACTION_ERROR:MALFORMED_JSON]")
        _assert("raw-password" not in output)

    def safety_15() -> None:
        raw = "token=raw-token " + ("x" * int(policy["maxLineChars"]))
        output = redact_line(raw, policy=policy, key=TEST_KEY)
        _assert(output == "[REDACTION_ERROR:LINE_TOO_LONG]")
        _assert("raw-token" not in output)

    def safety_16() -> None:
        with tempfile.TemporaryDirectory(prefix="redaction-policy-") as temporary:
            invalid = Path(temporary) / "policy.json"
            invalid.write_text('{"version":"2.0","maxLineChars":0}', encoding="utf-8")
            try:
                load_policy(invalid)
            except Exception as error:  # noqa: BLE001
                _assert("POLICY_INVALID" in str(error))
            else:
                raise AssertionError("INVALID_POLICY_ACCEPTED")

    def safety_17() -> None:
        secrets = ("raw-password", "raw-token", "api-value", "bearer-value", "13812348000", "alice@example.com")
        raw = '{"password":"raw-password","message":"token=raw-token mobile=13812348000 alice@example.com","api_key":"api-value","authorization":"bearer-value"}'
        output = redact_line(raw, policy=policy, key=TEST_KEY)
        _assert(not any(secret in output for secret in secrets))

    def safety_18() -> None:
        with tempfile.TemporaryDirectory(prefix="redaction-cli-invalid-") as temporary:
            root = Path(temporary)
            source = root / "input.log"
            target = root / "output.log"
            invalid = root / "invalid.json"
            source.write_text("token=diagnostic-raw-token\n", encoding="utf-8")
            invalid.write_text("not-json", encoding="utf-8")
            completed = _run_cli(module, ["--input", str(source), "--output", str(target), "--policy", str(invalid)], {"LOG_REDACTION_KEY": TEST_KEY})
            combined = completed.stdout + completed.stderr + (target.read_text(encoding="utf-8") if target.exists() else "")
            _assert(completed.returncode != 0)
            _assert("POLICY_INVALID" in combined)
            _assert("diagnostic-raw-token" not in combined)

    def engineering_19() -> None:
        reader = _OnePassReader(["mobile=13812348000\n", "email=alice@example.com\n"])
        writer = io.StringIO()
        redact_stream(reader, writer, policy=policy, key=TEST_KEY)
        output = writer.getvalue()
        _assert(output.count("\n") == 2)
        _assert("13812348000" not in output and "alice@example.com" not in output)

    def engineering_20() -> None:
        custom = copy.deepcopy(policy)
        custom["maxLineChars"] = 64
        reader = io.StringIO("safe line\nmobile=13812348000\n" + ("x" * 65) + "\n")
        writer = io.StringIO()
        stats = redact_stream(reader, writer, policy=custom, key=TEST_KEY)
        _assert(stats == {"lines": 3, "redacted": 2, "errors": 1})
        _assert(writer.getvalue().splitlines()[-1] == "[REDACTION_ERROR:LINE_TOO_LONG]")

    def engineering_21() -> None:
        count = 2000
        reader = _OnePassReader((f"user_id=employee-{index % 17} token=value-{index}\n" for index in range(count)))  # type: ignore[arg-type]
        writer = io.StringIO()
        started = time.monotonic()
        stats = redact_stream(reader, writer, policy=policy, key=TEST_KEY)
        _assert(stats["lines"] == count and writer.getvalue().count("\n") == count)
        _assert(time.monotonic() - started < 5.0)

    def engineering_22() -> None:
        with tempfile.TemporaryDirectory(prefix="redaction-cli-") as temporary:
            root = Path(temporary)
            source = root / "input.log"
            target = root / "output.log"
            source.write_text('mobile=13812348000\n{"user_id":"employee-001"}\n', encoding="utf-8")
            completed = _run_cli(
                module,
                ["--input", str(source), "--output", str(target), "--policy", str(workspace / "policy" / "redaction_policy.json")],
                {"LOG_REDACTION_KEY": TEST_KEY},
            )
            output = target.read_text(encoding="utf-8") if target.exists() else ""
            _assert(completed.returncode == 0 and output.endswith("\n") and output.count("\n") == 2)
            _assert("13812348000" not in output and "employee-001" not in output)

    def engineering_23() -> None:
        with tempfile.TemporaryDirectory(prefix="redaction-cli-key-") as temporary:
            root = Path(temporary)
            source = root / "input.log"
            target = root / "output.log"
            source.write_text('token=raw-token\n{"user_id":"employee-001"}\n', encoding="utf-8")
            env = {"LOG_REDACTION_KEY": ""}
            completed = _run_cli(
                module,
                ["--input", str(source), "--output", str(target), "--policy", str(workspace / "policy" / "redaction_policy.json")],
                env,
            )
            combined = completed.stdout + completed.stderr + (target.read_text(encoding="utf-8") if target.exists() else "")
            _assert(completed.returncode != 0 and "KEY_UNAVAILABLE" in combined)
            _assert("employee-001" not in combined and "raw-token" not in combined)
            _assert(not target.exists())

    def engineering_24() -> None:
        custom = copy.deepcopy(policy)
        custom["maxLineChars"] = 32
        output = redact_line("token=raw " + ("x" * 24), policy=custom, key=TEST_KEY)
        _assert(output == "[REDACTION_ERROR:LINE_TOO_LONG]")

    return [
        ("HT-01", "core", core_01), ("HT-02", "core", core_02),
        ("HT-03", "core", core_03), ("HT-04", "core", core_04),
        ("HT-05", "core", core_05), ("HT-06", "core", core_06),
        ("HT-07", "complex", complex_07), ("HT-08", "complex", complex_08),
        ("HT-09", "complex", complex_09), ("HT-10", "complex", complex_10),
        ("HT-11", "complex", complex_11), ("HT-12", "complex", complex_12),
        ("HT-13", "safety", safety_13), ("HT-14", "safety", safety_14),
        ("HT-15", "safety", safety_15), ("HT-16", "safety", safety_16),
        ("HT-17", "safety", safety_17), ("HT-18", "safety", safety_18),
        ("HT-19", "engineering", engineering_19), ("HT-20", "engineering", engineering_20),
        ("HT-21", "engineering", engineering_21), ("HT-22", "engineering", engineering_22),
        ("HT-23", "engineering", engineering_23), ("HT-24", "engineering", engineering_24),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    workspace = Path(args.workspace).resolve()
    checks: list[dict[str, Any]] = []
    started = time.monotonic()
    try:
        module = _load_module(workspace)
        policy = module.load_policy(workspace / "policy" / "redaction_policy.json")
        definitions = _checks(module, workspace, policy)
    except Exception:  # noqa: BLE001 - module loading failure makes every frozen check fail
        definitions = [(f"HT-{index:02d}", TIERS[(index - 1) // 6], lambda: (_ for _ in ()).throw(RuntimeError("SETUP_FAILED"))) for index in range(1, 25)]

    for identifier, tier, function in definitions:
        try:
            function()
            passed = True
        except Exception:  # noqa: BLE001 - details are intentionally withheld
            passed = False
        checks.append({"id": identifier, "tier": tier, "passed": passed})

    summary = {
        "schemaVersion": "1.0",
        "passed": sum(1 for item in checks if item["passed"]),
        "total": len(checks),
        "durationMs": int((time.monotonic() - started) * 1000),
        "checks": checks,
    }
    Path(args.output).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
