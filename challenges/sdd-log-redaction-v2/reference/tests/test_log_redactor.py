from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.log_redactor import RedactionError, load_policy, redact_line, redact_stream  # noqa: E402


class LogRedactorV2Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = load_policy(ROOT / "policy" / "redaction_policy.json")
        cls.key = "public-test-key-v2"

    def test_plain_text(self) -> None:
        actual = redact_line("mobile=13812348000 email=alice@example.com token=value ip=10.20.30.40", self.policy, self.key)
        self.assertEqual(actual, "mobile=138****8000 email=a***@example.com token=*** ip=10.20.*.*")

    def test_nested_json(self) -> None:
        actual = json.loads(redact_line('{"items":[{"password":"value"},{"mobile":"13812348000"}],"status":200}', self.policy, self.key))
        self.assertEqual(actual["items"], [{"password": "***"}, {"mobile": "138****8000"}])
        self.assertEqual(actual["status"], 200)

    def test_rule_priority(self) -> None:
        actual = redact_line("identity=110101199001011234 mobile=13812348000", self.policy, self.key)
        self.assertEqual(actual, "identity=110101********1234 mobile=138****8000")

    def test_hmac_correlation(self) -> None:
        first = json.loads(redact_line('{"user_id":"u-001"}', self.policy, self.key))["user_id"]
        second = json.loads(redact_line('{"user_id":"u-001"}', self.policy, self.key))["user_id"]
        other = json.loads(redact_line('{"user_id":"u-002"}', self.policy, self.key))["user_id"]
        self.assertEqual(first, second)
        self.assertNotEqual(first, other)
        self.assertRegex(first, r"^hmac:[0-9a-f]{24}$")

    def test_idempotent(self) -> None:
        once = redact_line("user_id=u-001 email=alice@example.com", self.policy, self.key)
        self.assertEqual(redact_line(once, self.policy, self.key), once)

    def test_unicode(self) -> None:
        actual = json.loads(redact_line('{"message":"用户邮箱 zhangsan@example.cn","city":"深圳"}', self.policy, self.key))
        self.assertEqual(actual, {"city": "深圳", "message": "用户邮箱 z***@example.cn"})

    def test_missing_key(self) -> None:
        previous = os.environ.pop("LOG_REDACTION_KEY", None)
        try:
            with self.assertRaisesRegex(RedactionError, "KEY_UNAVAILABLE"):
                redact_line('{"user_id":"u-001"}', self.policy)
        finally:
            if previous is not None:
                os.environ["LOG_REDACTION_KEY"] = previous

    def test_malformed_json(self) -> None:
        self.assertEqual(redact_line('{"password":"value"', self.policy, self.key), "[REDACTION_ERROR:MALFORMED_JSON]")

    def test_line_too_long(self) -> None:
        changed = dict(self.policy)
        changed["maxLineChars"] = 16
        self.assertEqual(redact_line("x" * 17, changed, self.key), "[REDACTION_ERROR:LINE_TOO_LONG]")

    def test_invalid_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "policy.json"
            path.write_text('{"version":"1.0"}', encoding="utf-8")
            with self.assertRaisesRegex(RedactionError, "POLICY_INVALID"):
                load_policy(path)

    def test_streaming(self) -> None:
        reader = io.StringIO("safe\nmobile=13812348000\n")
        writer = io.StringIO()
        stats = redact_stream(reader, writer, self.policy, self.key)
        self.assertEqual(stats, {"lines": 2, "redacted": 1, "errors": 0})
        self.assertEqual(writer.getvalue(), "safe\nmobile=138****8000\n")

    def test_url_and_authorization(self) -> None:
        actual = redact_line("Authorization: Bearer value GET /?token=query-value&name=ok", self.policy, self.key)
        self.assertEqual(actual, "Authorization: *** GET /?token=***&name=ok")


if __name__ == "__main__":
    unittest.main()
