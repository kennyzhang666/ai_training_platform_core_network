"""运维日志脱敏 · 打包评测引擎（SDD 全维度）。

平台以 `python -I judge.py --input <in.json> --output <out.json>` 调用本脚本。
输入符合 contracts/engine-invocation.schema.json，输出必须符合
contracts/evaluation-result.schema.json。

与只评 Verify + Code 的常规引擎不同，本引擎对全部 16 个评分点打分，因为本题
考核的是规格驱动开发：规格质量（Spec 25 分）和人机协作过程（Collab 15 分）
是主要考核对象，代码只占 20 分。

模型不参与打分。所有判据都是确定性的结构与度量规则，判据、隐藏测试和提交契约
一起打包冻结——同一份交付件在任何机器上必然同分。
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

GRADER_VERSION = "log-desensitize-sdd@1.0.0"

ENTRY = "src/desensitize.py"
FUNCTION = "desensitize"
SPEC_FILE = "SPEC.md"
TRANSCRIPT_FILE = "transcript.md"

LEVEL_RATIOS = {"A": 1.0, "B": 0.75, "C": 0.5, "D": 0.0}

# 四档隐藏测试即四个 Verify 评分点，权重与平台能力目录一致，合计 40。
TIER_WEIGHTS = {"basic": 8.0, "boundary": 12.0, "clarification": 12.0, "change": 8.0}
TIER_TO_CRITERION = {"basic": "V1", "boundary": "V2", "clarification": "V3", "change": "V4"}

DIMENSION_MAX = {"verify": 40.0, "spec": 25.0, "code": 20.0, "collab": 15.0}

# 中性数字不计为魔法数字：它们几乎总是索引或步长，而非业务规则。
NEUTRAL_NUMBERS = {0, 1, -1, 2}

# SPEC.md 的七个必备章节，键为章节槽位，值为标题中必须出现的关键词。
SPEC_SECTIONS = {
    "scope": "范围",
    "clarify": "澄清",
    "rules": "规则",
    "acceptance": "验收",
    "boundary": "边界",
    "change": "变更",
    "verification": "验证",
}

# 题目在 README 答疑中显式埋设的八个歧义点。规格必须逐一表态。
CLARIFICATION_ANCHORS: tuple[tuple[str, str, tuple[tuple[str, ...], ...]], ...] = (
    ("A1", "身份证与银行卡的优先级", (("身份证",), ("银行卡",))),
    ("A2", "密钥值整体优先于内部识别", (("密钥", "token", "secret"), ("优先", "整体"))),
    ("A3", "密钥值的引号处理", (("引号",),)),
    ("A4", "幂等性如何成立", (("幂等",),)),
    ("A5", "越界点分十进制不是 IP", (("255", "越界", "合法"),)),
    ("A6", "数字边界不误伤", (("边界", "相邻", "紧邻"), ("11", "十一"))),
    ("A7", "邮箱本地部分的固定掩码", (("邮箱", "本地"), ("首字符", "第一个", "***"))),
    ("A8", "非法输入抛异常", (("异常", "抛"), ("ValueError", "valueerror", "错误"))),
)

TRANSCRIPT_PHASES = ("CLARIFY", "SPEC", "ACCEPTANCE", "IMPLEMENT", "VERIFY", "CHANGE", "REGRESSION")
_ROUND_HEADING = re.compile(
    r"^#{1,4}\s*Round\s+(?P<index>\d+)\s*[·:\-]\s*(?P<phase>[A-Z]+)\s*$",
    re.MULTILINE,
)
# 提示词质量：结构化提示词通常显式给出角色、约束、示例、输出格式和检查项。
PROMPT_ELEMENTS = {
    "role": ("你是", "作为", "role", "扮演"),
    "constraint": ("约束", "要求", "不得", "必须", "限制"),
    "context": ("背景", "上下文", "规格", "SPEC", "现状"),
    "example": ("示例", "例如", "样例", "输入", "输出"),
    "check": ("检查", "验收", "验证", "自测", "确认"),
}

# 交付件在受控子进程中运行，隔离解释器并禁用用户站点包。
#
# stdin/stdout 一律走字节并显式指定 UTF-8：`python -I` 隐含 `-E`，会忽略
# PYTHONIOENCODING，因此子进程的文本流默认使用系统代码页。在中文 Windows 上
# 这会让含中文的用例在传输途中损坏，或让 JSON 解码直接失败。
RUNNER = r'''
import argparse, importlib.util, json, sys

parser = argparse.ArgumentParser()
parser.add_argument("--entry", required=True)
parser.add_argument("--function", required=True)
args = parser.parse_args()

spec = importlib.util.spec_from_file_location("submission_entry", args.entry)
module = importlib.util.module_from_spec(spec)
sys.modules["submission_entry"] = module
spec.loader.exec_module(module)
fn = getattr(module, args.function)

results = []
for case in json.loads(sys.stdin.buffer.read().decode("utf-8")):
    name = case.get("name", "unnamed")
    check = case.get("check", "equals")
    call_args = case.get("args", [])
    call_kwargs = case.get("kwargs", {})
    record = {"name": name, "check": check, "expected": case.get("expected")}
    try:
        if check == "raises":
            try:
                fn(*call_args, **call_kwargs)
            except ValueError as exc:
                record["actual"] = "ValueError"
                record["raisedType"] = type(exc).__name__
            except Exception as exc:
                record["actual"] = type(exc).__name__
                record["raisedType"] = type(exc).__name__
            else:
                record["actual"] = None
        elif check == "idempotent":
            once = fn(*call_args, **call_kwargs)
            twice = fn(once, **call_kwargs)
            record["actual"] = twice
            record["stable"] = once == twice
        else:
            record["actual"] = fn(*call_args, **call_kwargs)
    except Exception as exc:
        record["error"] = f"{type(exc).__name__}: {exc}"
    results.append(record)

sys.stdout.buffer.write(json.dumps(results, ensure_ascii=False, default=str).encode("utf-8"))
'''


# --------------------------------------------------------------------------- #
# Verify
# --------------------------------------------------------------------------- #

def _case_passed(case: dict[str, Any]) -> bool:
    if "error" in case:
        return False
    check = case.get("check", "equals")
    if check == "raises":
        return case.get("actual") == case.get("expected")
    if check == "idempotent":
        return bool(case.get("stable")) and case.get("actual") == case.get("expected")
    return case.get("actual") == case.get("expected")


def _run_tier(workspace: Path, tests_dir: Path, tier: str, scratch: Path, timeout: int) -> dict[str, Any]:
    cases_path = tests_dir / f"{tier}.json"
    if not cases_path.exists():
        return {"tier": tier, "passed": 0, "total": 0, "skipped": True, "cases": []}
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    runner = scratch / f"runner-{tier}.py"
    runner.write_text(RUNNER, encoding="utf-8")
    entry_path = (workspace / ENTRY).resolve()
    if not entry_path.exists():
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [], "error": f"缺少入口文件 {ENTRY}"}
    try:
        # 二进制管道：解释器的文本层不参与，编码由两侧显式约定为 UTF-8。
        process = subprocess.run(
            [sys.executable, "-I", str(runner), "--entry", str(entry_path), "--function", FUNCTION],
            input=json.dumps(cases, ensure_ascii=False).encode("utf-8"),
            capture_output=True, cwd=str(workspace), timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [], "timedOut": True,
                "error": f"该档位超过 {timeout}s 未完成"}
    # 学员代码的 traceback 可能是系统代码页，解码失败不得让整个引擎崩溃。
    stderr = (process.stderr or b"").decode("utf-8", errors="replace")
    if process.returncode != 0:
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [], "error": stderr[-800:]}
    try:
        results = json.loads((process.stdout or b"").decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, ValueError):
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [],
                "error": "runner 返回了非法 JSON"}
    if not isinstance(results, list):
        return {"tier": tier, "passed": 0, "total": len(cases), "cases": [],
                "error": "runner 返回的不是用例数组"}
    for index, item in enumerate(results):
        item["index"] = index
        item["passed"] = _case_passed(item)
    return {"tier": tier, "passed": sum(1 for item in results if item["passed"]), "total": len(results), "cases": results}


# --------------------------------------------------------------------------- #
# Markdown 结构解析
# --------------------------------------------------------------------------- #

def _read(workspace: Path, name: str) -> str | None:
    path = workspace / name
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def _sections(markdown: str) -> list[tuple[str, str]]:
    """把 Markdown 切成 (标题, 正文) 列表，只认 ## 及更深的标题。"""
    parts: list[tuple[str, str]] = []
    current_title = ""
    buffer: list[str] = []
    for line in markdown.splitlines():
        if re.match(r"^#{2,4}\s+\S", line):
            if current_title or buffer:
                parts.append((current_title, "\n".join(buffer)))
            current_title = line.lstrip("#").strip()
            buffer = []
        else:
            buffer.append(line)
    if current_title or buffer:
        parts.append((current_title, "\n".join(buffer)))
    return parts


def _section_body(sections: list[tuple[str, str]], keyword: str) -> str | None:
    for title, body in sections:
        if keyword in title:
            return body
    return None


def _table_rows(body: str) -> list[list[str]]:
    """提取 Markdown 表格的数据行，跳过表头和分隔行。"""
    rows: list[list[str]] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or all(re.fullmatch(r":?-{2,}:?", cell) for cell in cells if cell):
            continue
        rows.append(cells)
    return rows[1:] if rows else []


def _list_items(body: str) -> list[str]:
    return [re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", line).strip()
            for line in body.splitlines()
            if re.match(r"^\s*(?:[-*+]|\d+[.)])\s+\S", line)]


def _level_from_ratio(ratio: float) -> str:
    return "A" if ratio >= 1 else "B" if ratio >= 0.75 else "C" if ratio >= 0.5 else "D"


def _level_from_count(value: int, thresholds: tuple[int, int, int]) -> str:
    """value 越大越好；thresholds 为 (A 门槛, B 门槛, C 门槛)。"""
    a, b, c = thresholds
    return "A" if value >= a else "B" if value >= b else "C" if value >= c else "D"


# --------------------------------------------------------------------------- #
# Spec
# --------------------------------------------------------------------------- #

def _analyze_spec(spec_text: str | None) -> dict[str, Any]:
    if spec_text is None:
        return {"present": False, "missingSections": list(SPEC_SECTIONS.values()), "anchors": [],
                "acceptanceRows": 0, "concreteRows": 0, "boundaryRows": 0, "changeSignals": []}
    sections = _sections(spec_text)
    missing = [keyword for keyword in SPEC_SECTIONS.values() if _section_body(sections, keyword) is None]

    clarify_body = _section_body(sections, SPEC_SECTIONS["clarify"]) or ""
    clarify_scope = clarify_body + "\n" + (_section_body(sections, SPEC_SECTIONS["rules"]) or "")
    anchors = []
    for anchor_id, label, groups in CLARIFICATION_ANCHORS:
        covered = all(any(token in clarify_scope for token in group) for group in groups)
        anchors.append({"id": anchor_id, "label": label, "covered": covered})

    acceptance_body = _section_body(sections, SPEC_SECTIONS["acceptance"]) or ""
    rows = _table_rows(acceptance_body)
    concrete: list[list[str]] = []
    for row in rows:
        filled = [cell for cell in row if cell and cell not in {"-", "—", "N/A", "TBD", "待定"}]
        # 可执行用例必须同时给出确切输入和确切期望输出。
        if len(filled) >= 3 and any("`" in cell or "*" in cell or "\"" in cell for cell in row):
            concrete.append(row)
    boundary_markers = ("边界", "异常", "非法", "空", "越界", "幂等", "X", "重复", "相邻")
    boundary_rows = [row for row in concrete if any(marker in cell for cell in row for marker in boundary_markers)]

    change_body = _section_body(sections, SPEC_SECTIONS["change"]) or ""
    change_signals = [name for name, tokens in (
        ("影响规则", ("IP", "ip", "邮箱")),
        ("回归", ("回归", "standard", "既有", "不变")),
        ("影响用例", ("用例", "验收", "测试")),
    ) if any(token in change_body for token in tokens)]

    return {
        "present": True,
        "missingSections": missing,
        "anchors": anchors,
        "acceptanceRows": len(rows),
        "concreteRows": len(concrete),
        "boundaryRows": len(boundary_rows),
        "changeSignals": change_signals,
    }


def _spec_criteria(spec: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    criteria: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []

    covered = [item for item in spec["anchors"] if item["covered"]]
    total_anchors = len(CLARIFICATION_ANCHORS)
    # 缺失必备章节直接压低澄清得分：没有澄清章节就谈不上澄清质量。
    penalty = 0.5 if SPEC_SECTIONS["clarify"] in spec["missingSections"] else 1.0
    s1_ratio = (len(covered) / total_anchors) * penalty if spec["present"] else 0.0
    s1_level = _level_from_ratio(s1_ratio)
    criteria.append({
        "key": "S1", "dim": "spec", "name": "需求澄清", "max": 10.0, "level": s1_level,
        "score": round(10.0 * s1_ratio, 4), "source": "auto",
        "rule": f"SPEC.md 澄清章节覆盖 {total_anchors} 个题设歧义点的比例",
        "evidenceType": "extraction", "evidence": {"anchors": spec["anchors"], "missingSections": spec["missingSections"]},
    })
    for item in spec["anchors"]:
        if not item["covered"]:
            findings.append({
                "id": f"finding-spec-{item['id']}", "dim": "spec", "criteria": "S1", "severity": "major",
                "title": f"规格未澄清：{item['label']}", "file": SPEC_FILE,
                "detail": f"README 答疑已明确该歧义点，但 SPEC.md 的澄清章节没有对应决策。",
                "fix": "在「需求澄清与假设」中写明该歧义、你的决策和依据。",
            })

    s2_level = _level_from_count(spec["concreteRows"], (8, 6, 4))
    criteria.append({
        "key": "S2", "dim": "spec", "name": "验收用例设计", "max": 8.0, "level": s2_level,
        "score": round(8.0 * LEVEL_RATIOS[s2_level], 4), "source": "auto",
        "rule": "验收章节中含确切输入与确切期望输出的用例条数（A≥8 B≥6 C≥4）",
        "evidenceType": "extraction",
        "evidence": {"tableRows": spec["acceptanceRows"], "executableRows": spec["concreteRows"]},
    })
    if spec["concreteRows"] < 8:
        findings.append({
            "id": "finding-spec-acceptance", "dim": "spec", "criteria": "S2", "severity": "major",
            "title": f"可执行验收用例仅 {spec['concreteRows']} 条", "file": SPEC_FILE,
            "detail": "题目要求至少 8 条给出确切输入与确切期望输出的验收用例。",
            "fix": "把「应正确处理手机号」这类描述改写为具体输入串和具体期望输出串。",
        })

    s3_level = _level_from_count(spec["boundaryRows"], (3, 2, 1))
    criteria.append({
        "key": "S3", "dim": "spec", "name": "异常与边界覆盖", "max": 4.0, "level": s3_level,
        "score": round(4.0 * LEVEL_RATIOS[s3_level], 4), "source": "auto",
        "rule": "验收用例中覆盖异常或边界的条数（A≥3 B≥2 C≥1）",
        "evidenceType": "extraction", "evidence": {"boundaryRows": spec["boundaryRows"]},
    })

    s4_level = _level_from_count(len(spec["changeSignals"]), (3, 2, 1))
    criteria.append({
        "key": "S4", "dim": "spec", "name": "变更影响定位", "max": 3.0, "level": s4_level,
        "score": round(3.0 * LEVEL_RATIOS[s4_level], 4), "source": "auto",
        "rule": "变更章节是否说明受影响规则、受影响用例和回归结论（A=3 项齐全）",
        "evidenceType": "extraction", "evidence": {"changeSignals": spec["changeSignals"]},
    })
    return criteria, findings


# --------------------------------------------------------------------------- #
# Collab
# --------------------------------------------------------------------------- #

def _analyze_transcript(text: str | None) -> dict[str, Any]:
    if text is None:
        return {"present": False, "rounds": [], "substantiveRounds": 0, "phases": [], "promptRounds": 0,
                "structuredPrompts": 0, "specBeforeImplement": False,
                "acceptanceBeforeImplement": False, "regressionVerified": False}
    matches = list(_ROUND_HEADING.finditer(text))
    rounds: list[dict[str, Any]] = []
    for position, match in enumerate(matches):
        start = match.end()
        end = matches[position + 1].start() if position + 1 < len(matches) else len(text)
        body = text[start:end]
        phase = match.group("phase")
        prompt = ""
        prompt_match = re.search(r"\*\*Prompt\*\*(?P<prompt>.*?)(?=\*\*Response\*\*|\*\*Verification\*\*|\Z)", body, re.DOTALL)
        if prompt_match:
            prompt = prompt_match.group("prompt").strip()
        verification = ""
        verify_match = re.search(r"\*\*Verification\*\*(?P<body>.*)", body, re.DOTALL)
        if verify_match:
            verification = verify_match.group("body").strip()
        elements = [name for name, tokens in PROMPT_ELEMENTS.items() if any(token in prompt for token in tokens)]
        rounds.append({
            "order": position,
            "index": int(match.group("index")),
            "phase": phase if phase in TRANSCRIPT_PHASES else f"UNKNOWN:{phase}",
            "promptChars": len(prompt),
            "promptElements": elements,
            "hasVerification": len(verification) >= 20,
            # 只有写了实质提示词并给出验证结论的轮次才算数。未填写的模板骨架
            # 同样带着 Round 标题和阶段名，不做这一层过滤就会白送 Collab 分。
            "substantive": len(prompt) >= 40 and len(verification) >= 20,
        })

    substantive = [item for item in rounds if item["substantive"]]
    phases = [item["phase"] for item in substantive]

    def first(phase: str) -> int | None:
        return next((item["order"] for item in substantive if item["phase"] == phase), None)

    first_spec, first_impl, first_accept = first("SPEC"), first("IMPLEMENT"), first("ACCEPTANCE")
    regression = [item for item in substantive if item["phase"] == "REGRESSION"]
    return {
        "present": True,
        "rounds": rounds,
        "substantiveRounds": len(substantive),
        "phases": phases,
        "promptRounds": sum(1 for item in rounds if item["promptChars"] >= 40),
        # 结构化提示词：至少命中 3 类要素且有实质长度。
        "structuredPrompts": sum(1 for item in substantive if len(item["promptElements"]) >= 3 and item["promptChars"] >= 80),
        "specBeforeImplement": first_spec is not None and first_impl is not None and first_spec < first_impl,
        "acceptanceBeforeImplement": first_accept is not None and first_impl is not None and first_accept < first_impl,
        "regressionVerified": any(item["hasVerification"] for item in regression),
    }


def _collab_criteria(record: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    criteria: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    rounds = [item for item in record["rounds"] if item["substantive"]]
    phases = set(record["phases"])

    has_implement = "IMPLEMENT" in phases
    if record["specBeforeImplement"] and record["acceptanceBeforeImplement"]:
        p1_level = "A"
    elif record["specBeforeImplement"]:
        p1_level = "B"
    elif "SPEC" in phases and not has_implement:
        # 有规格但还没进入实现，流程未走完，无法判定顺序。
        p1_level = "C"
    else:
        # 实现轮不晚于规格轮，即先写代码再补规格——README 已明确判 D。
        p1_level = "D"
    criteria.append({
        "key": "P1", "dim": "collab", "name": "需求与验收先行", "max": 4.0, "level": p1_level,
        "score": round(4.0 * LEVEL_RATIOS[p1_level], 4), "source": "auto",
        "rule": "首个 IMPLEMENT 轮是否晚于首个 SPEC 轮和首个 ACCEPTANCE 轮",
        "evidenceType": "extraction",
        "evidence": {"phases": record["phases"], "specBeforeImplement": record["specBeforeImplement"],
                     "acceptanceBeforeImplement": record["acceptanceBeforeImplement"],
                     "hasImplement": has_implement},
    })
    if not record["specBeforeImplement"]:
        findings.append({
            "id": "finding-collab-order", "dim": "collab", "criteria": "P1", "severity": "critical",
            "title": "实现早于规格，不符合 SDD 流程", "file": TRANSCRIPT_FILE,
            "detail": "transcript.md 中首个 IMPLEMENT 轮没有出现在首个 SPEC 轮之后。",
            "fix": "先完成澄清与规格轮次并留下记录，再进入实现轮次。",
        })

    required_phases = {"SPEC", "IMPLEMENT", "VERIFY"}
    covered_phases = len(required_phases & phases)
    if len(rounds) >= 5 and covered_phases == 3 and len(phases) >= 5:
        p2_level = "A"
    elif len(rounds) >= 5 and covered_phases == 3:
        p2_level = "B"
    elif len(rounds) >= 3:
        p2_level = "C"
    else:
        p2_level = "D"
    criteria.append({
        "key": "P2", "dim": "collab", "name": "小步迭代", "max": 4.0, "level": p2_level,
        "score": round(4.0 * LEVEL_RATIOS[p2_level], 4), "source": "auto",
        "rule": "轮次数量与阶段覆盖（A：≥5 轮、含 SPEC/IMPLEMENT/VERIFY 且阶段种类≥5）",
        "evidenceType": "extraction", "evidence": {"roundCount": len(rounds), "distinctPhases": sorted(phases)},
    })

    ratio = record["structuredPrompts"] / len(rounds) if rounds else 0.0
    p3_level = _level_from_ratio(ratio) if rounds else "D"
    criteria.append({
        "key": "P3", "dim": "collab", "name": "提示词设计", "max": 4.0, "level": p3_level,
        "score": round(4.0 * LEVEL_RATIOS[p3_level], 4), "source": "auto",
        "rule": "提示词同时含背景/约束/示例/检查等≥3 类要素且≥80 字的轮次占比",
        "evidenceType": "extraction",
        "evidence": {"structuredPrompts": record["structuredPrompts"], "substantiveRounds": len(rounds)},
    })

    has_change = "CHANGE" in phases
    has_regression = "REGRESSION" in phases
    if has_change and has_regression and record["regressionVerified"]:
        p4_level = "A"
    elif has_change and has_regression:
        p4_level = "B"
    elif has_change or has_regression:
        p4_level = "C"
    else:
        p4_level = "D"
    criteria.append({
        "key": "P4", "dim": "collab", "name": "变更定位与验证", "max": 3.0, "level": p4_level,
        "score": round(3.0 * LEVEL_RATIOS[p4_level], 4), "source": "auto",
        "rule": "是否同时存在 CHANGE 与 REGRESSION 轮，且回归轮写明验证结论",
        "evidenceType": "extraction",
        "evidence": {"hasChange": has_change, "hasRegression": has_regression,
                     "regressionVerified": record["regressionVerified"]},
    })
    return criteria, findings


# --------------------------------------------------------------------------- #
# Code
# --------------------------------------------------------------------------- #

def _measure(workspace: Path) -> dict[str, Any]:
    path = workspace / ENTRY
    empty = {"parseError": None, "magicNumbers": [], "maxComplexity": 0, "raises": 0,
             "customValueError": False, "guardChecks": 0, "annotatedRatio": 0.0, "functions": 0,
             "namedConstants": 0, "stub": True}
    if not path.is_file():
        return {**empty, "parseError": f"缺少入口文件 {ENTRY}"}
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"), filename=str(path))
    except SyntaxError as exc:
        return {**empty, "parseError": f"语法错误：{exc}"}

    named_constant_lines: set[int] = set()
    named_constants = 0
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if targets and all(isinstance(item, ast.Name) and item.id.isupper() for item in targets):
                named_constants += 1
                for child in ast.walk(node):
                    if isinstance(child, ast.Constant):
                        named_constant_lines.add(child.lineno)

    magic: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            if node.value in NEUTRAL_NUMBERS or node.lineno in named_constant_lines:
                continue
            magic.append({"line": node.lineno, "value": node.value})

    raises_count = sum(1 for node in ast.walk(tree) if isinstance(node, ast.Raise))
    custom_error = any(
        isinstance(node, ast.ClassDef) and any(
            isinstance(base, ast.Name) and base.id in {"ValueError", "Exception"} for base in node.bases)
        for node in ast.walk(tree)
    )
    guard_checks = sum(
        1 for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"isinstance", "issubclass"}
    )

    functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]

    # 未实现的桩：入口函数体只有文档字符串、pass 或 raise NotImplementedError。
    # 骨架代码天然「没有魔法数字、复杂度低、标注齐全」，不做这一层判定就会
    # 让一份什么都没做的交付拿到接近满分的 Code 分。
    def _is_stub(function: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
        body = [node for node in function.body
                if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                        and isinstance(node.value.value, str))]
        if not body:
            return True
        return all(
            isinstance(node, ast.Pass)
            or (isinstance(node, ast.Raise) and isinstance(node.exc, (ast.Name, ast.Call))
                and "NotImplementedError" in ast.dump(node.exc))
            for node in body
        )

    entry_functions = [item for item in functions if item.name == FUNCTION]
    stub = bool(entry_functions) and all(_is_stub(item) for item in entry_functions)
    if not entry_functions:
        stub = True
    annotated = 0
    for function in functions:
        arguments = [*function.args.args, *function.args.kwonlyargs]
        has_args = all(argument.annotation is not None for argument in arguments) if arguments else True
        if has_args and function.returns is not None:
            annotated += 1

    max_complexity = 0
    for function in functions:
        complexity = 1
        for node in ast.walk(function):
            if isinstance(node, (ast.If, ast.For, ast.While, ast.ExceptHandler, ast.IfExp, ast.BoolOp)):
                complexity += 1
        max_complexity = max(max_complexity, complexity)

    return {
        "parseError": None,
        "magicNumbers": magic,
        "maxComplexity": max_complexity,
        "raises": raises_count,
        "customValueError": custom_error,
        "guardChecks": guard_checks,
        "functions": len(functions),
        "annotatedRatio": round(annotated / len(functions), 4) if functions else 0.0,
        "namedConstants": named_constants,
        "stub": stub,
    }


def _code_criteria(metrics: dict[str, Any], verify_passed: int, verify_total: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    criteria: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    broken = metrics.get("parseError") is not None or metrics.get("stub", False)

    def capped(level: str) -> str:
        """测试确实跑了却一条都没过时，代码质量最多算 C：结构再干净也没有可运行的实现。

        `verify_total > 0` 这个前提不能省：隐藏测试缺失（例如在没有 assets 的
        合成清单里运行）意味着「没有证据」，不是「实现不可用」，此时不应扣分。
        """
        if broken:
            return "D"
        if verify_total > 0 and verify_passed <= 0 and level in {"A", "B"}:
            return "C"
        return level

    magic_count = len(metrics["magicNumbers"])
    c1_level = "D" if broken else "A" if magic_count == 0 else "B" if magic_count <= 2 else "C" if magic_count <= 4 else "D"
    criteria.append({
        "key": "C1", "dim": "code", "name": "业务常量管理", "max": 6.0, "level": capped(c1_level),
        "score": round(6.0 * LEVEL_RATIOS[capped(c1_level)], 4), "source": "auto",
        "rule": "具名常量之外的业务数字个数（A=0 B≤2 C≤4）",
        "evidenceType": "metric",
        "evidence": {"magicNumbers": metrics["magicNumbers"], "namedConstants": metrics["namedConstants"]},
    })
    for index, magic in enumerate(metrics["magicNumbers"], start=1):
        findings.append({
            "id": f"finding-magic-{index}", "dim": "code", "criteria": "C1", "severity": "minor",
            "title": "发现未命名业务数字", "file": ENTRY, "line": int(magic["line"]),
            "detail": f"数字 {magic['value']} 直接参与业务逻辑，降低脱敏规则的可读性。",
            "fix": "提取为具有业务含义的全大写常量，例如 PHONE_KEEP_PREFIX。",
        })

    guard_signal = int(metrics["customValueError"]) + min(metrics["guardChecks"], 2) + min(metrics["raises"], 2)
    c2_level = "D" if broken else _level_from_count(guard_signal, (4, 3, 2))
    criteria.append({
        "key": "C2", "dim": "code", "name": "异常与边界处理", "max": 5.0, "level": capped(c2_level),
        "score": round(5.0 * LEVEL_RATIOS[capped(c2_level)], 4), "source": "auto",
        "rule": "自定义 ValueError 子类、输入类型校验和显式 raise 的综合信号",
        "evidenceType": "metric",
        "evidence": {"customValueError": metrics["customValueError"], "guardChecks": metrics["guardChecks"],
                     "raises": metrics["raises"]},
    })
    if not broken and not metrics["customValueError"]:
        findings.append({
            "id": "finding-code-exception", "dim": "code", "criteria": "C2", "severity": "major",
            "title": "未定义专用异常类型", "file": ENTRY,
            "detail": "题目要求非法输入抛出继承自 ValueError 的自定义异常，便于调用方区分错误来源。",
            "fix": "定义 class DesensitizeError(ValueError) 并在入参校验处抛出。",
        })

    ratio = 0.0 if broken else metrics["annotatedRatio"]
    c3_level = _level_from_ratio(ratio)
    criteria.append({
        "key": "C3", "dim": "code", "name": "类型与精度安全", "max": 4.0, "level": capped(c3_level),
        "score": round(4.0 * LEVEL_RATIOS[capped(c3_level)], 4), "source": "auto",
        "rule": "参数与返回值均有类型标注的函数占比",
        "evidenceType": "metric",
        "evidence": {"annotatedRatio": ratio, "functions": metrics["functions"]},
    })

    complexity = metrics["maxComplexity"]
    c4_level = "D" if broken else "A" if complexity <= 8 else "B" if complexity <= 12 else "C" if complexity <= 18 else "D"
    criteria.append({
        "key": "C4", "dim": "code", "name": "变更友好设计", "max": 5.0, "level": capped(c4_level),
        "score": round(5.0 * LEVEL_RATIOS[capped(c4_level)], 4), "source": "auto",
        "rule": "单函数最大圈复杂度（A≤8 B≤12 C≤18）",
        "evidenceType": "metric", "evidence": {"maxComplexity": complexity},
    })
    if metrics.get("parseError") is not None:
        findings.append({
            "id": "finding-code-parse", "dim": "code", "criteria": "C1", "severity": "critical",
            "title": "入口文件无法解析", "file": ENTRY,
            "detail": str(metrics["parseError"]),
            "fix": "确认交付包含可解析的 src/desensitize.py。",
        })
    elif metrics.get("stub", False):
        findings.append({
            "id": "finding-code-stub", "dim": "code", "criteria": "C1", "severity": "critical",
            "title": f"{FUNCTION} 仍是未实现的骨架", "file": ENTRY,
            "detail": "入口函数体只有文档字符串或 raise NotImplementedError，没有实际实现。",
            "fix": "按 SPEC.md 第 3 节的规则表实现脱敏逻辑。",
        })
    return criteria, findings


# --------------------------------------------------------------------------- #
# 交付契约
# --------------------------------------------------------------------------- #

def _contract_diagnostics(workspace: Path, contract_path: Path | None) -> list[dict[str, str]]:
    if not contract_path or not contract_path.exists():
        return []
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    diagnostics: list[dict[str, str]] = []
    for item in contract.get("required", []):
        target = workspace / item["path"].rstrip("/")
        if not target.exists():
            diagnostics.append({"severity": "BLOCKER", "code": "REQUIRED_FILE_MISSING", "path": item["path"],
                                "message": f"缺少必交文件 {item['path']}"})
            continue
        if target.is_file() and item.get("minChars"):
            text = target.read_text(encoding="utf-8", errors="replace")
            if len(text) < item["minChars"]:
                diagnostics.append({"severity": "WARNING", "code": "REQUIRED_FILE_TOO_SHORT", "path": item["path"],
                                    "message": f"{item['path']} 内容过短，可能是未填写的模板"})
    for item in contract.get("optional", []):
        if not (workspace / item["path"].rstrip("/")).exists():
            diagnostics.append({"severity": "INFO", "code": "OPTIONAL_PATH_MISSING", "path": item["path"],
                                "message": f"未提交可选项 {item['path']}"})
    return diagnostics


# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="log-desensitize-judge")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    started = time.time()
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    workspace = Path(payload["workspace"])
    scratch = Path(payload.get("scratchDir") or Path(args.output).parent)
    scratch.mkdir(parents=True, exist_ok=True)
    assets = payload["engine"].get("assets", {})
    tests_dir = Path(assets["testsDir"]) if assets.get("testsDir") else None
    contract_path = Path(assets["submissionContract"]) if assets.get("submissionContract") else None
    tier_timeout = max(10, int(payload.get("limits", {}).get("wallClockSeconds", 180)) // 4)

    diagnostics = _contract_diagnostics(workspace, contract_path)
    tiers = {tier: _run_tier(workspace, tests_dir, tier, scratch, tier_timeout) for tier in TIER_WEIGHTS} if tests_dir else {}

    criteria: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []

    for tier, weight in TIER_WEIGHTS.items():
        detail = tiers.get(tier, {"passed": 0, "total": 0})
        total_cases = int(detail.get("total") or 0)
        if total_cases <= 0:
            continue  # 未提供的档位不计分，也不白送满分
        ratio = detail["passed"] / total_cases
        evidence: dict[str, Any] = {
            "passed": detail["passed"],
            "total": total_cases,
            "failed": [case.get("name") for case in detail.get("cases", []) if not case.get("passed")],
        }
        if detail.get("error"):
            evidence["error"] = detail["error"]
        criteria.append({
            "key": TIER_TO_CRITERION[tier], "dim": "verify", "name": f"{tier} 验证", "max": weight,
            "level": _level_from_ratio(ratio), "score": round(weight * ratio, 4), "source": "auto",
            "rule": f"{tier} 档隐藏测试通过率", "evidenceType": "test", "evidence": evidence,
        })
        for case in detail.get("cases", []):
            if not case.get("passed"):
                findings.append({
                    "id": f"finding-{tier}-{case.get('index', 0)}", "dim": "verify",
                    "criteria": TIER_TO_CRITERION[tier], "severity": "major",
                    "title": f"{tier} 用例未通过：{case.get('name', 'unnamed')}",
                    "detail": f"expected={case.get('expected')!r} actual={case.get('actual', case.get('error'))!r}",
                    "fix": "补齐该规则分支后回归全部档位。",
                })

    spec = _analyze_spec(_read(workspace, SPEC_FILE))
    spec_criteria, spec_findings = _spec_criteria(spec)
    criteria.extend(spec_criteria)
    findings.extend(spec_findings)

    transcript = _analyze_transcript(_read(workspace, TRANSCRIPT_FILE))
    collab_criteria, collab_findings = _collab_criteria(transcript)
    criteria.extend(collab_criteria)
    findings.extend(collab_findings)

    metrics = _measure(workspace)
    code_criteria, code_findings = _code_criteria(
        metrics,
        sum(item.get("passed", 0) for item in tiers.values()),
        sum(item.get("total", 0) for item in tiers.values()),
    )
    criteria.extend(code_criteria)
    findings.extend(code_findings)

    dimensions: dict[str, Any] = {}
    for name, maximum in DIMENSION_MAX.items():
        scored = [item for item in criteria if item["dim"] == name]
        if scored:
            dimensions[name] = {
                "score": round(sum(item["score"] for item in scored), 4),
                "max": round(sum(item["max"] for item in scored), 4),
                "evaluated": True,
            }
        else:
            dimensions[name] = {"score": None, "max": maximum, "evaluated": False}
    total = round(sum(item["score"] for item in dimensions.values() if item["evaluated"]), 4)

    blocked = any(item["severity"] == "BLOCKER" for item in diagnostics)
    snapshot_hash = payload["submission"]["snapshotHash"]
    finished = time.time()
    result = {
        "schemaVersion": "1.0",
        "resultId": f"result-{hashlib.sha256((snapshot_hash + payload['grading']['runId']).encode()).hexdigest()[:24]}",
        "gradingRunId": payload["grading"]["runId"],
        "challengeVersion": payload["challenge"]["challengeVersion"],
        "rubricVersion": payload["challenge"]["rubricVersion"],
        "graderVersion": GRADER_VERSION,
        "idempotencyKey": payload["grading"]["idempotencyKey"],
        "triggerType": payload["grading"]["triggerType"],
        "status": "PARTIAL" if blocked or not criteria else "COMPLETE",
        "submission": {key: value for key, value in payload["submission"].items() if key != "id"},
        "dimensions": dimensions,
        "criteria": criteria,
        "total": total,
        "findings": findings,
        "validationDiagnostics": diagnostics,
        "verifyDetail": {
            "tiers": tiers,
            "passed": sum(item.get("passed", 0) for item in tiers.values()),
            "total": sum(item.get("total", 0) for item in tiers.values()),
        },
        "metrics": {"code": metrics, "spec": spec, "collab": transcript},
        "gradedBy": "ci",
        "startedAt": started_at,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished)),
        "durationMs": int((finished - started) * 1000),
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
