"""运维日志脱敏 · 参考实现。

这份实现是赛题规则的事实来源，也是发布前引擎自检的基线。它只使用 Python 标准库。

设计要点：
- 单遍扫描、匹配不重叠。规则按特异性从高到低排列，先匹配者胜出，避免同一段
  文本被两条规则重复处理。
- 每个被脱敏的值追加稳定标记 `#<tag>`，tag 取原始值 UTF-8 字节的 SHA-256 前 6 位。
  同值同标记、异值异标记，因此脱敏后仍可做关联分析，而掩码本身不可逆。
- 幂等：掩码字符 `*` 不属于任何规则的合法字符集，已脱敏文本再次处理不会变化。
"""

from __future__ import annotations

import hashlib
import re

__all__ = ["desensitize", "DesensitizeError", "STANDARD", "STRICT"]

STANDARD = "standard"
STRICT = "strict"
_LEVELS = (STANDARD, STRICT)

TAG_LENGTH = 6
MASK = "*"
PHONE_KEEP_PREFIX = 3
PHONE_KEEP_SUFFIX = 4
ID_KEEP_PREFIX = 6
ID_KEEP_SUFFIX = 4
ID_MASK_LENGTH = 8
CARD_KEEP_SUFFIX = 4
EMAIL_LOCAL_MASK = "***"
SECRET_MASK = "***"
DOMAIN_MASK = "***"
IPV4_SEGMENTS = 4
IPV4_KEEP_SEGMENTS = 2
IPV4_MAX_OCTET = 255
IPV4_MAX_OCTET_DIGITS = 3


class DesensitizeError(ValueError):
    """输入不满足脱敏函数的前置条件。"""


# 身份证的 7–14 位必须是合法出生日期，用它把 18 位身份证和 18 位银行卡区分开。
_ID_BODY = r"\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]"
_SECRET_KEYS = r"token|secret|password|passwd|pwd|apikey|api_key|access_key"
_NAME_PREFIX = r"(?:name|username|user_name|realname)\s*[=:]\s*|(?:姓名|用户|申请人|操作人)\s*[：:]\s*"

# 规则顺序即优先级：`re` 的交替在同一起点上先匹配者胜出，且整体扫描不重叠。
# 每条规则用自己的组名，避免 Python 不允许的重名组。
_RULES: tuple[tuple[str, str], ...] = (
    # 密钥赋值整体优先：值内部即使含邮箱或 IP，也按密钥处理。
    # 分隔符吸收可选的开引号，值本身不含引号，因此 `password="p@ss"` 会被脱敏
    # 且闭引号原样保留。值的字符集排除掩码字符 `*`，`token=***#ab12cd` 不会被二次脱敏。
    ("secret", rf"(?i:\b(?P<secret_key>{_SECRET_KEYS}))(?P<secret_sep>\s*[=:]\s*[\"']?)(?P<secret_value>[^\s,;\"'*]+)"),
    ("email", r"(?<![A-Za-z0-9._%+-])(?P<email_value>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![A-Za-z0-9.-])"),
    ("idcard", rf"(?<!\d)(?P<idcard_value>{_ID_BODY})(?![\dXx])"),
    ("card", r"(?<!\d)(?P<card_value>\d{16,19})(?!\d)"),
    ("phone", r"(?<!\d)(?P<phone_value>1[3-9]\d{9})(?!\d)"),
    ("ipv4", r"(?<![\d.])(?P<ipv4_value>(?:\d{1,3}\.){3}\d{1,3})(?![\d.])"),
    ("name", rf"(?P<name_prefix>{_NAME_PREFIX})(?P<name_value>[\u4e00-\u9fa5]{{2,4}})"),
)

_SCANNER = re.compile("|".join(pattern for _, pattern in _RULES))


def _tag(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:TAG_LENGTH]


def _traced(masked: str, original: str) -> str:
    return f"{masked}#{_tag(original)}"


def _mask_phone(value: str) -> str:
    middle = len(value) - PHONE_KEEP_PREFIX - PHONE_KEEP_SUFFIX
    return f"{value[:PHONE_KEEP_PREFIX]}{MASK * middle}{value[-PHONE_KEEP_SUFFIX:]}"


def _mask_idcard(value: str) -> str:
    return f"{value[:ID_KEEP_PREFIX]}{MASK * ID_MASK_LENGTH}{value[-ID_KEEP_SUFFIX:]}"


def _mask_card(value: str) -> str:
    return f"{MASK * (len(value) - CARD_KEEP_SUFFIX)}{value[-CARD_KEEP_SUFFIX:]}"


def _mask_email(value: str, level: str) -> str:
    local, _, domain = value.partition("@")
    masked_domain = DOMAIN_MASK if level == STRICT else domain
    return f"{local[0]}{EMAIL_LOCAL_MASK}@{masked_domain}"


def _mask_ipv4(value: str, level: str) -> str:
    if level == STRICT:
        return ".".join([MASK] * IPV4_SEGMENTS)
    octets = value.split(".")[:IPV4_KEEP_SEGMENTS]
    return ".".join(octets + [MASK] * (IPV4_SEGMENTS - IPV4_KEEP_SEGMENTS))


def _mask_name(value: str) -> str:
    return f"{value[0]}{MASK * (len(value) - 1)}"


def _is_valid_octet(part: str) -> bool:
    return part.isdigit() and len(part) <= IPV4_MAX_OCTET_DIGITS and int(part) <= IPV4_MAX_OCTET


def _is_valid_ipv4(value: str) -> bool:
    parts = value.split(".")
    return len(parts) == IPV4_SEGMENTS and all(_is_valid_octet(part) for part in parts)


def _replace_secret(match: re.Match[str], value: str, level: str) -> str:
    return f"{match.group('secret_key')}{match.group('secret_sep')}{_traced(SECRET_MASK, value)}"


def _replace_email(match: re.Match[str], value: str, level: str) -> str:
    return _traced(_mask_email(value, level), value)


def _replace_idcard(match: re.Match[str], value: str, level: str) -> str:
    return _traced(_mask_idcard(value), value)


def _replace_card(match: re.Match[str], value: str, level: str) -> str:
    return _traced(_mask_card(value), value)


def _replace_phone(match: re.Match[str], value: str, level: str) -> str:
    return _traced(_mask_phone(value), value)


def _replace_ipv4(match: re.Match[str], value: str, level: str) -> str:
    # 点分十进制但任一段越界的，不是 IP 地址，原样保留。
    if not _is_valid_ipv4(value):
        return match.group(0)
    return _traced(_mask_ipv4(value, level), value)


def _replace_name(match: re.Match[str], value: str, level: str) -> str:
    return f"{match.group('name_prefix')}{_traced(_mask_name(value), value)}"


# 规则名 -> 替换函数。新增一类敏感信息只需加一条规则和一个函数，
# 不必修改分派逻辑本身。
_REPLACERS = {
    "secret": _replace_secret,
    "email": _replace_email,
    "idcard": _replace_idcard,
    "card": _replace_card,
    "phone": _replace_phone,
    "ipv4": _replace_ipv4,
    "name": _replace_name,
}


def _replace(match: re.Match[str], level: str) -> str:
    for name, _ in _RULES:
        value = match.group(f"{name}_value")
        if value is not None:
            return _REPLACERS[name](match, value, level)
    return match.group(0)


def desensitize(text: str, *, level: str = STANDARD) -> str:
    """对日志文本脱敏，返回行数、行顺序和非敏感字符完全不变的文本。

    Args:
        text: 原始日志文本。
        level: `"standard"` 或 `"strict"`。`"strict"` 额外脱敏 IPv4 的全部四段和
            邮箱域名，其余规则不变。

    Raises:
        DesensitizeError: `text` 不是字符串，或 `level` 不是受支持的取值。
    """
    if not isinstance(text, str):
        raise DesensitizeError("text 必须是字符串")
    if level not in _LEVELS:
        raise DesensitizeError(f"level 必须是 {_LEVELS} 之一，收到 {level!r}")
    if not text:
        return text
    return _SCANNER.sub(lambda match: _replace(match, level), text)
