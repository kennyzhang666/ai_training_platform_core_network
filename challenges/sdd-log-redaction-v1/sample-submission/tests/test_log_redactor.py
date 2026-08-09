from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.log_redactor import DEFAULT_RULES, Rule, redact_line, redact_record  # noqa: E402


class LogRedactorTest(unittest.TestCase):
    def test_plain_text(self) -> None:
        actual = redact_line("mobile=13812348000 email=alice@example.com token=secret")
        self.assertEqual(actual, "mobile=138****8000 email=a***@example.com token=***")

    def test_json(self) -> None:
        result = json.loads(redact_line('{"mobile":"13812348000","status":200,"ok":true}'))
        self.assertEqual(result["mobile"], "138****8000")
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["ok"], True)

    def test_nested(self) -> None:
        result = redact_record({"users": [{"id": "110101199001011234"}], "ip": "10.20.30.40"})
        self.assertEqual(result["users"][0]["id"], "110101********1234")
        self.assertEqual(result["ip"], "10.20.*.*")

    def test_unicode(self) -> None:
        result = json.loads(redact_line('{"message":"用户张三邮箱 zhangsan@example.cn","status":200,"ok":true}'))
        self.assertIn("用户张三", result["message"])
        self.assertIn("z***@example.cn", result["message"])
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["ok"], True)

    def test_malformed(self) -> None:
        self.assertEqual(redact_line('{"mobile":"13812348000"'), '{"mobile":"138****8000"')

    def test_idempotent(self) -> None:
        once = redact_line("ip=10.20.30.40 mobile=13812348000")
        self.assertEqual(redact_line(once), once)

    def test_invalid_rules(self) -> None:
        with self.assertRaises(ValueError):
            redact_line("value", rules=[object()])  # type: ignore[list-item]

    def test_custom_rule(self) -> None:
        custom = Rule("ORDER", __import__("re").compile(r"ORD-\d+"), "ORD-***")
        self.assertEqual(redact_line("order=ORD-123", rules=(*DEFAULT_RULES, custom)), "order=ORD-***")

    def test_rule_change(self) -> None:
        custom = Rule("HOST", __import__("re").compile(r"host-[a-z]+"), "host-***")
        self.assertEqual(redact_line("host=host-prod", rules=(*DEFAULT_RULES, custom)), "host=host-***")


if __name__ == "__main__":
    unittest.main()
