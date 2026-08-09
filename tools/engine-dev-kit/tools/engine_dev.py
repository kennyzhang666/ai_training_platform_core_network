#!/usr/bin/env python3
"""独立评测引擎开发 CLI。

这个工具只使用 Python 标准库即可完成三件事：

  python tools/engine_dev.py validate path/to/engine
  python tools/engine_dev.py run path/to/engine --workspace ./sample-submission
  python tools/engine_dev.py package path/to/engine --out dist/engine.zip

它不连接平台 API，也不依赖平台仓库；用于在交付引擎前检查包结构、运行
一个合成 invocation，并生成可上传的 ZIP。安装 jsonschema 后会额外执行
完整 JSON Schema 校验，未安装时仍会执行内置的安全和结果结构检查。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


MAX_FILES = 2000
MAX_BYTES = 64 * 1024 * 1024
ENGINE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$")
ENGINE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
HEX_32 = "a" * 32
HASH_64 = "b" * 64
ARTIFACT_HASH_64 = "c" * 64


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fail(message: str) -> int:
    print(f"ERROR: {message}", file=sys.stderr)
    return 2


def safe_package_path(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value.startswith(("/", "\\")):
        raise ValueError(f"{field} 必须是包内相对路径")
    if re.match(r"^[A-Za-z]:", value) or "\\" in value:
        raise ValueError(f"{field} 不允许盘符或反斜杠：{value}")
    parts = Path(value).parts
    if ".." in parts or "." in parts:
        raise ValueError(f"{field} 不允许 . 或 ..：{value}")
    return value


def iter_package_files(root: Path) -> Iterator[Path]:
    count = 0
    total = 0
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"引擎包禁止符号链接：{path.relative_to(root)}")
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        safe_package_path(relative, relative)
        count += 1
        total += path.stat().st_size
        if count > MAX_FILES:
            raise ValueError(f"文件数量超过上限 {MAX_FILES}")
        if total > MAX_BYTES:
            raise ValueError(f"包内容超过上限 {MAX_BYTES} bytes")
        yield path


def package_hash(root: Path) -> str:
    digest = hashlib.sha256()
    for path in iter_package_files(root):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def load_manifest(root: Path) -> dict[str, Any]:
    if not root.is_dir():
        raise ValueError(f"不是引擎目录：{root}")
    manifest_path = root / "engine.json"
    if not manifest_path.is_file():
        raise ValueError("引擎根目录缺少 engine.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"engine.json 不是有效 JSON：{error}") from error
    if not isinstance(manifest, dict):
        raise ValueError("engine.json 顶层必须是对象")

    schema_version = manifest.get("schemaVersion")
    if schema_version not in {"1.0", "1.1"}:
        raise ValueError("schemaVersion 必须是 1.0 或 1.1")
    engine_id = manifest.get("id")
    version = manifest.get("version")
    if not isinstance(engine_id, str) or not ENGINE_ID.fullmatch(engine_id):
        raise ValueError("id 不符合引擎标识规则")
    if not isinstance(version, str) or not ENGINE_VERSION.fullmatch(version):
        raise ValueError("version 不符合引擎版本规则")
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("type") != "python":
        raise ValueError("runtime.type 必须是 python")
    entrypoint = safe_package_path(runtime.get("entrypoint"), "runtime.entrypoint")
    if not (root / entrypoint).is_file():
        raise ValueError(f"找不到入口文件：{entrypoint}")
    if runtime.get("requirements") is not None:
        requirements = safe_package_path(runtime["requirements"], "runtime.requirements")
        if not (root / requirements).is_file():
            raise ValueError(f"找不到依赖文件：{requirements}")
    if schema_version == "1.1":
        agent = manifest.get("agent")
        if not isinstance(agent, dict):
            raise ValueError("1.1 引擎必须声明 agent")
        instruction = safe_package_path(agent.get("instruction"), "agent.instruction")
        skills = agent.get("skills")
        if not isinstance(skills, list) or not skills:
            raise ValueError("agent.skills 至少需要一个路径")
        if not (root / instruction).is_file():
            raise ValueError(f"找不到 Agent 指令文件：{instruction}")
        for item in skills:
            path = safe_package_path(item, "agent.skills")
            target = root / path
            skill_file = target / "SKILL.md" if target.is_dir() else target
            if not skill_file.is_file() or skill_file.name != "SKILL.md":
                raise ValueError(f"Skill 必须指向包含 SKILL.md 的目录：{path}")
    if manifest.get("platformDependencies"):
        raise ValueError("独立上传引擎不能声明 platformDependencies")

    # 遍历一次，拒绝符号链接、路径穿越和过大的包。
    list(iter_package_files(root))
    return manifest


def kit_root() -> Path:
    # kit/tools/engine_dev.py -> kit/
    return Path(__file__).resolve().parents[1]


def schema_path(name: str) -> Path:
    bundled = kit_root() / "contracts" / name
    if bundled.is_file():
        return bundled
    # 直接在本项目源码目录运行时，契约位于仓库根 contracts/；ZIP 解压后
    # 则会优先命中上面的 kit/contracts/。
    repository_contract = Path(__file__).resolve().parents[3] / "contracts" / name
    return repository_contract


def optional_schema_validate(value: Any, schema_name: str) -> str | None:
    path = schema_path(schema_name)
    if not path.is_file():
        return f"未找到 {path}，跳过完整 Schema 校验"
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return "未安装 jsonschema，仅执行内置结构校验；可运行 python -m pip install -r requirements.txt"
    schema = json.loads(path.read_text(encoding="utf-8"))
    try:
        jsonschema.Draft202012Validator(schema).validate(value)
    except jsonschema.ValidationError as error:  # type: ignore[attr-defined]
        raise ValueError(f"{schema_name} 校验失败：{error.message} at {list(error.absolute_path)}") from error
    return None


def validate_result_shape(result: Any, invocation: dict[str, Any]) -> None:
    if not isinstance(result, dict):
        raise ValueError("结果顶层必须是 JSON 对象")
    required = {
        "schemaVersion", "resultId", "gradingRunId", "challengeVersion", "rubricVersion",
        "graderVersion", "idempotencyKey", "triggerType", "status", "submission",
        "dimensions", "criteria", "total", "validationDiagnostics", "gradedBy",
        "startedAt", "finishedAt", "durationMs",
    }
    missing = sorted(required - result.keys())
    if missing:
        raise ValueError(f"结果缺少字段：{', '.join(missing)}")
    if result["schemaVersion"] != "1.0":
        raise ValueError("结果 schemaVersion 必须是 1.0")
    if result["gradingRunId"] != invocation["grading"]["runId"]:
        raise ValueError("gradingRunId 没有原样带回 invocation")
    if result["idempotencyKey"] != invocation["grading"]["idempotencyKey"]:
        raise ValueError("idempotencyKey 没有原样带回 invocation")
    if result["triggerType"] != invocation["grading"]["triggerType"]:
        raise ValueError("triggerType 没有原样带回 invocation")
    if result["status"] not in {"COMPLETE", "PARTIAL", "FAILED"}:
        raise ValueError("status 不在契约允许范围")
    if not isinstance(result["total"], (int, float)) or not 0 <= result["total"] <= 100:
        raise ValueError("total 必须是 0 到 100 的数字")
    if not isinstance(result["dimensions"], dict) or not isinstance(result["criteria"], list):
        raise ValueError("dimensions 和 criteria 类型不正确")
    if not isinstance(result["validationDiagnostics"], list):
        raise ValueError("validationDiagnostics 必须是数组")


@contextmanager
def materialize_package(source: Path) -> Iterator[Path]:
    if source.is_dir():
        yield source.resolve()
        return
    if source.suffix.lower() != ".zip" or not source.is_file():
        raise ValueError(f"引擎包必须是目录或 ZIP：{source}")
    with tempfile.TemporaryDirectory(prefix="engine-kit-") as temporary:
        target = Path(temporary) / "package"
        with zipfile.ZipFile(source) as archive:
            names = archive.namelist()
            if len(names) > MAX_FILES:
                raise ValueError(f"ZIP 文件数量超过上限 {MAX_FILES}")
            uncompressed_total = 0
            for name in names:
                safe_package_path(name.rstrip("/"), "ZIP 条目")
                info = archive.getinfo(name)
                if info.file_size > MAX_BYTES:
                    raise ValueError("ZIP 单文件超过大小上限")
                uncompressed_total += info.file_size
                if uncompressed_total > MAX_BYTES:
                    raise ValueError(f"ZIP 解压后内容超过上限 {MAX_BYTES} bytes")
                # Unix symlink 的文件类型位为 0o120000。
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError(f"ZIP 禁止符号链接：{name}")
            archive.extractall(target)
        # 允许 ZIP 有一个包根目录，也允许直接以 engine.json 为根。
        candidates = [target, *(path for path in target.iterdir() if path.is_dir())]
        package_root = next((path for path in candidates if (path / "engine.json").is_file()), None)
        if package_root is None:
            raise ValueError("ZIP 中找不到包含 engine.json 的包根目录")
        yield package_root


def command_validate(source: Path) -> int:
    try:
        with materialize_package(source) as root:
            manifest = load_manifest(root)
            warning = optional_schema_validate(manifest, "evaluation-engine-package.schema.json")
            print(f"PASS engine={manifest['id']} version={manifest['version']} hash={package_hash(root)}")
            if warning:
                print(f"WARN {warning}")
        return 0
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        return fail(str(error))


def sample_invocation(root: Path, workspace: Path, output: Path, scratch: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "generatedAt": utc_now(),
        "engine": {
            "id": manifest["id"],
            "version": manifest["version"],
            "packageHash": package_hash(root),
            "packageRoot": str(root),
            "source": "PACKAGE",
        },
        "challenge": {
            "id": "standalone-sample",
            "challengeVersion": "standalone-sample:1",
            "rubricVersion": "1.0",
            "zone": "YELLOW",
        },
        "grading": {"runId": "standalone-run-001", "idempotencyKey": HEX_32, "triggerType": "MANUAL", "attempt": 1},
        "subject": {"id": "sample-user"},
        "submission": {
            "id": "sample-submission",
            "sourceType": "UPLOAD",
            "snapshotHash": HASH_64,
            "artifactHash": ARTIFACT_HASH_64,
            "submittedAt": utc_now(),
        },
        "workspace": str(workspace),
        "outputPath": str(output),
        "scratchDir": str(scratch),
        "limits": {"wallClockSeconds": 60, "memoryMB": 512, "outputBytes": 4 * 1024 * 1024},
        "params": {},
    }


def command_run(source: Path, workspace_arg: str | None, output_arg: str | None, keep: bool) -> int:
    try:
        with materialize_package(source) as root:
            manifest = load_manifest(root)
            default_workspace = root.parent / "sample-submission"
            workspace = Path(workspace_arg).resolve() if workspace_arg else default_workspace.resolve()
            if not workspace.is_dir():
                raise ValueError(f"找不到工作区：{workspace}")
            output = Path(output_arg).resolve() if output_arg else Path.cwd() / "engine-result.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            scratch_context = tempfile.TemporaryDirectory(prefix="engine-scratch-")
            scratch = Path(scratch_context.name)
            invocation_path = scratch / "invocation.json"
            invocation = sample_invocation(root, workspace, output, scratch, manifest)
            invocation_path.write_text(json.dumps(invocation, ensure_ascii=False, indent=2), encoding="utf-8")
            entrypoint = root / manifest["runtime"]["entrypoint"]
            timeout = int(manifest.get("limits", {}).get("wallClockSeconds", 600))
            command = [sys.executable, "-I", str(entrypoint), "--input", str(invocation_path), "--output", str(output)]
            completed = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=timeout, check=False)
            if completed.returncode:
                print(completed.stdout, end="")
                print(completed.stderr, end="", file=sys.stderr)
                return fail(f"引擎进程退出码为 {completed.returncode}")
            if not output.is_file():
                return fail("引擎没有生成 output 文件")
            try:
                result = json.loads(output.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                return fail(f"output 不是有效 JSON：{error}")
            validate_result_shape(result, invocation)
            warning = optional_schema_validate(result, "evaluation-result.schema.json")
            print(f"PASS status={result['status']} total={result['total']} output={output}")
            if warning:
                print(f"WARN {warning}")
            if keep:
                print(f"INVOCATION {invocation_path}")
            else:
                scratch_context.cleanup()
            return 0
    except subprocess.TimeoutExpired:
        return fail("引擎运行超时")
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        return fail(str(error))


def command_package(source: Path, output_arg: str | None) -> int:
    try:
        with materialize_package(source) as root:
            manifest = load_manifest(root)
            output = Path(output_arg).resolve() if output_arg else Path.cwd() / f"{manifest['id']}-{manifest['version']}.zip"
            output.parent.mkdir(parents=True, exist_ok=True)
            if output.exists():
                output.unlink()
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for path in iter_package_files(root):
                    archive.write(path, path.relative_to(root).as_posix())
            print(f"PASS package={output} engine={manifest['id']} version={manifest['version']}")
            return 0
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        return fail(str(error))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="engine_dev", description="独立评测引擎校验、运行和打包工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="校验引擎目录或 ZIP")
    validate.add_argument("package", type=Path)

    run = subparsers.add_parser("run", help="运行一个合成 invocation 并校验结果")
    run.add_argument("package", type=Path)
    run.add_argument("--workspace", help="只读提交工作区；默认使用示例工作区")
    run.add_argument("--output", help="结果 JSON 输出路径；默认当前目录 engine-result.json")
    run.add_argument("--keep-invocation", action="store_true", dest="keep")

    package = subparsers.add_parser("package", help="把引擎目录打成 ZIP")
    package.add_argument("package", type=Path)
    package.add_argument("--out", help="ZIP 输出路径")

    args = parser.parse_args(argv)
    if args.command == "validate":
        return command_validate(args.package)
    if args.command == "run":
        return command_run(args.package, args.workspace, args.output, args.keep)
    return command_package(args.package, args.out)


if __name__ == "__main__":
    raise SystemExit(main())
