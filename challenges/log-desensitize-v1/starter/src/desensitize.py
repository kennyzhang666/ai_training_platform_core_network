"""运维日志脱敏 · 交付入口。

要求见赛题 README。请先完成 SPEC.md，再实现本文件。

约定：
- 入口函数必须是本模块的 `desensitize`；
- 只使用 Python 标准库；
- 非法输入抛出继承自 ValueError 的自定义异常；
- 阈值请提取为全大写模块级常量，函数体内不要出现裸的业务数字。
"""

from __future__ import annotations

STANDARD = "standard"
STRICT = "strict"


class DesensitizeError(ValueError):
    """输入不满足脱敏函数的前置条件。"""


def desensitize(text: str, *, level: str = STANDARD) -> str:
    """对日志文本脱敏，返回行数、行顺序和非敏感字符完全不变的文本。

    Args:
        text: 原始日志文本。
        level: `"standard"` 或 `"strict"`，见变更包。

    Raises:
        DesensitizeError: `text` 不是字符串，或 `level` 不是受支持的取值。
    """
    raise NotImplementedError("请实现脱敏逻辑")
