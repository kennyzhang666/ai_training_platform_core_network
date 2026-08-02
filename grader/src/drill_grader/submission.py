from __future__ import annotations

import fnmatch
import re
import ast
from pathlib import Path
from typing import Any

from .diagnostics import Diagnostic, blocker, info, warning
from .schemas import assert_valid, load_json


SAFE_PATH = re.compile(r"^(?!/)(?!.*\.\.)(?!.*\\).+$")
TEMPLATE_MARKERS = re.compile(r"(?:\bTODO\b|\bFIXME\b|待补充|请在此|pass\s*$)", re.IGNORECASE | re.MULTILINE)


def _signature_shape(arguments: ast.arguments) -> list[tuple[str, str | None]]:
    positional = [*getattr(arguments, "posonlyargs", []), *arguments.args]
    defaults = [None] * (len(positional) - len(arguments.defaults)) + [ast.unparse(item) for item in arguments.defaults]
    shape = [(item.arg, default) for item, default in zip(positional, defaults)]
    shape.extend((item.arg, ast.unparse(default) if default is not None else None) for item, default in zip(arguments.kwonlyargs, arguments.kw_defaults))
    if arguments.vararg:
        shape.append((f"*{arguments.vararg.arg}", None))
    if arguments.kwarg:
        shape.append((f"**{arguments.kwarg.arg}", None))
    return shape


def _signature_matches(function: ast.FunctionDef | ast.AsyncFunctionDef, expected: str) -> bool:
    try:
        parsed = ast.parse(f"def _expected{expected}: pass")
        expected_function = parsed.body[0]
        if not isinstance(expected_function, ast.FunctionDef):
            return False
        return _signature_shape(function.args) == _signature_shape(expected_function.args)
    except (SyntaxError, ValueError):
        return False


def _looks_like_template(candidate: Path) -> bool:
    """A file is still the template if it carries a placeholder marker, or if
    every markdown heading it declares has no body underneath it."""
    try:
        content = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    if TEMPLATE_MARKERS.search(content):
        return True
    headings = [index for index, line in enumerate(content.splitlines()) if re.match(r"^#{1,6}\s+", line)]
    if not headings:
        return False
    lines = content.splitlines()
    for index in headings:
        # Collect the lines up to the next heading.
        body: list[str] = []
        for line in lines[index + 1:]:
            if re.match(r"^#{1,6}\s+", line):
                break
            if line.strip():
                body.append(line.strip())
        if body:
            return False
    return True


def _matches(path: str, pattern: str) -> bool:
    normalized = path.replace("\\", "/")
    if fnmatch.fnmatch(normalized, pattern):
        return True
    if pattern.endswith("/") and normalized.startswith(pattern):
        return True
    return Path(normalized).match(pattern)


def _iter_files(root: Path) -> list[str]:
    return sorted(
        item.relative_to(root).as_posix()
        for item in root.rglob("*")
        if item.is_file()
    )


def _source_diagnostics(candidate: Path, item: dict[str, Any], path_value: str) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    try:
        content = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [blocker("SOURCE_NOT_READABLE", str(exc), path_value)]
    must_export = item.get("mustExport")
    signature = item.get("signature")
    if must_export or signature:
        if path_value.lower().endswith(".py"):
            try:
                tree = ast.parse(content, filename=path_value)
            except SyntaxError as exc:
                diagnostics.append(blocker("SOURCE_PARSE_ERROR", str(exc), path_value))
            else:
                functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
                function = next((node for node in functions if node.name == must_export), None) if must_export else None
                if must_export and function is None:
                    diagnostics.append(blocker("REQUIRED_EXPORT_MISSING", f"source does not export {must_export}", path_value))
                if signature and function is not None:
                    if not _signature_matches(function, signature):
                        # A wrong signature already costs the hidden tests; the
                        # diagnostic explains why, it does not add a penalty.
                        diagnostics.append(warning("FUNCTION_SIGNATURE_MISMATCH", f"expected {signature}", path_value))
        else:
            if must_export and not re.search(rf"(?:export\s+)?(?:function|class|def)\s+{re.escape(must_export)}\b", content):
                diagnostics.append(blocker("REQUIRED_EXPORT_MISSING", f"source does not export {must_export}", path_value))
            if signature and signature.replace(" ", "") not in content.replace(" ", ""):
                diagnostics.append(warning("FUNCTION_SIGNATURE_MISMATCH", f"expected signature {signature}", path_value))
    return diagnostics


def validate_submission(root: Path, contract_path: Path, language: str = "python") -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    if not root.exists() or not root.is_dir():
        return [blocker("SUBMISSION_DIR_MISSING", "submission directory does not exist")]

    try:
        contract = load_json(contract_path)
        assert_valid("submission-contract", contract)
    except (OSError, ValueError) as exc:
        return [blocker("CONTRACT_INVALID", str(exc), str(contract_path))]

    files = _iter_files(root)
    for item in contract["required"]:
        path_value = item["path"]
        if not SAFE_PATH.match(path_value):
            diagnostics.append(blocker("CONTRACT_PATH_UNSAFE", "required path is unsafe", path_value))
            continue
        if "*" in path_value or "?" in path_value:
            found = any(_matches(name, path_value) for name in files)
        else:
            found = (root / path_value.rstrip("/")).exists()
        if not found:
            diagnostics.append(blocker("REQUIRED_FILE_MISSING", f"required path is missing: {path_value}", path_value))
            continue
        candidate = root / path_value.rstrip("/")
        if candidate.is_file() and "minChars" in item:
            try:
                content = candidate.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                diagnostics.append(blocker("REQUIRED_FILE_NOT_TEXT", f"file is not UTF-8 text: {path_value}", path_value))
            else:
                if len(content) < item["minChars"]:
                    diagnostics.append(warning("REQUIRED_FILE_TOO_SHORT", f"{path_value} has fewer than {item['minChars']} characters", path_value))
        if candidate.is_file() and item.get("minSections"):
            content = candidate.read_text(encoding="utf-8", errors="replace")
            sections = len(re.findall(r"^#{1,6}\s+", content, flags=re.MULTILINE))
            if sections < item["minSections"]:
                diagnostics.append(warning("REQUIRED_SECTIONS_MISSING", f"{path_value} has {sections} sections, needs {item['minSections']}", path_value))
        # `notTemplate` used to be checked only for `type: source`, so the flag
        # the parking-fee contract sets on SPEC.md was never enforced. It is a
        # warning, not a blocker: an untouched specification already scores low
        # on the rubric, and format checks must diagnose rather than deduct a
        # second time.
        if candidate.is_file() and item.get("notTemplate") and _looks_like_template(candidate):
            diagnostics.append(warning("SOURCE_IS_TEMPLATE", f"{path_value} still looks like the unmodified template", path_value))
        if candidate.is_file() and item.get("type") == "source":
            diagnostics.extend(_source_diagnostics(candidate, item, path_value))

    entry = contract.get("languageEntry", {}).get(language)
    if entry and not (root / entry).exists():
        diagnostics.append(blocker("LANGUAGE_ENTRY_MISSING", f"entry file for {language} is missing: {entry}", entry))
    elif not entry:
        diagnostics.append(info("LANGUAGE_NOT_DECLARED", f"language entry is not declared for {language}"))

    # Optional deliverables are informational only. The contract declares them,
    # so a missing one has to be reported as INFO rather than silently dropped:
    # employees need to know that skipping tests/ costs rubric points elsewhere.
    for item in contract.get("optional", []):
        path_value = item.get("path", "")
        if not path_value or not SAFE_PATH.match(path_value):
            continue
        if "*" in path_value or "?" in path_value:
            found = any(_matches(name, path_value) for name in files)
        elif path_value.endswith("/"):
            found = any(name.startswith(path_value) for name in files)
        else:
            found = (root / path_value).exists()
        if not found:
            diagnostics.append(info("OPTIONAL_PATH_MISSING", f"optional path was not submitted: {path_value}", path_value))

    for pattern in contract.get("forbidden", []):
        matches = [name for name in files if _matches(name, pattern)]
        for name in matches:
            diagnostics.append(blocker("FORBIDDEN_PATH", f"forbidden path submitted: {name}", name))

    return diagnostics
