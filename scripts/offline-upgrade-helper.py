#!/usr/bin/env python3
"""Offline release verification and PostgreSQL recovery for single-node upgrades.

The helper deliberately accepts secrets only through an environment file and
never prints the database URL.  Upgrade launchers use its small CLI on both
Windows and Linux so package and database safety rules have one implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, unquote, urlparse


PRODUCT = "ai-training-platform"
TARGETS = {"win32-x64", "linux-x64"}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$")


def fail(message: str) -> None:
    raise ValueError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative_path(value: object) -> Path:
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        fail("发布清单包含无效路径")
    path = Path(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        fail("发布清单路径越界")
    return path


def version_tuple(value: str) -> tuple[int, int, int]:
    match = VERSION.fullmatch(value.strip())
    if not match:
        fail("版本号格式无效")
    return tuple(int(part) for part in match.groups())


def load_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"无法读取发布清单：{path.name}")
    if not isinstance(payload, dict):
        fail(f"发布清单结构无效：{path.name}")
    return payload


def verify_release(release_root: Path, source_root: Path | None = None) -> dict:
    root = release_root.resolve(strict=True)
    if not root.is_dir():
        fail("新版本根目录不存在")
    manifest_path = root / "release-manifest.json"
    upgrade_path = root / "upgrade-manifest.json"
    version_path = root / "VERSION"
    if not manifest_path.is_file() or not upgrade_path.is_file() or not version_path.is_file():
        fail("新版本缺少发布清单、升级清单或 VERSION")

    manifest = load_json(manifest_path)
    upgrade = load_json(upgrade_path)
    version = version_path.read_text(encoding="utf-8").strip()
    if manifest.get("schemaVersion") != "1.0" or manifest.get("product") != PRODUCT:
        fail("发布清单产品或格式不受支持")
    if manifest.get("target") not in TARGETS or manifest.get("version") != version:
        fail("发布清单目标平台或版本不一致")
    expected_target = "win32-x64" if os.name == "nt" else "linux-x64" if sys.platform.startswith("linux") else None
    if expected_target is None or manifest.get("target") != expected_target:
        fail("发布包目标平台与当前操作系统不一致")
    if upgrade.get("schemaVersion") != "1.0" or upgrade.get("product") != PRODUCT:
        fail("升级清单产品或格式不受支持")
    if upgrade.get("target") != manifest.get("target") or upgrade.get("targetVersion") != version:
        fail("升级清单目标平台或版本不一致")
    supported = upgrade.get("supportedSourceVersions")
    if not isinstance(supported, list) or not supported or any(not isinstance(item, str) for item in supported):
        fail("升级清单没有声明支持的来源版本")
    if upgrade.get("minimumPostgresMajor") != 14:
        fail("升级清单 PostgreSQL 基线不受支持")
    if upgrade.get("requiresSameFilesystem") is not True:
        fail("升级清单必须要求同文件系统目录切换")
    if upgrade.get("migrationStrategy") != "prisma-migrate-deploy-with-native-postgres-rollback":
        fail("升级清单迁移策略不受支持")

    expected: dict[str, dict] = {}
    expected_casefolded: set[str] = set()
    reject_casefold_collisions = manifest.get("target") == "win32-x64"
    files = manifest.get("files")
    if not isinstance(files, list):
        fail("发布清单文件列表无效")
    for item in files:
        if not isinstance(item, dict):
            fail("发布清单文件项无效")
        relative = safe_relative_path(item.get("path"))
        key = relative.as_posix()
        if key in expected:
            fail("发布清单包含重复路径")
        if reject_casefold_collisions:
            folded = key.casefold()
            if folded in expected_casefolded:
                fail("发布清单包含大小写冲突路径")
            expected_casefolded.add(folded)
        if item.get("type") not in {"file", "symlink"}:
            fail("发布清单包含不支持的文件类型")
        if (
            not isinstance(item.get("size"), int)
            or item["size"] < 0
            or not isinstance(item.get("sha256"), str)
            or not SHA256.fullmatch(item["sha256"])
            or not isinstance(item.get("mode"), int)
            or not 0 <= item["mode"] <= 0o7777
        ):
            fail("发布清单文件属性无效")
        expected[key] = item

    actual: set[str] = set()
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_dir() and not path.is_symlink():
            continue
        if relative == "release-manifest.json":
            continue
        actual.add(relative)
        item = expected.get(relative)
        if item is None:
            fail(f"发布包包含未登记文件：{relative}")
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            if item["type"] != "symlink":
                fail(f"发布包文件类型不一致：{relative}")
            target = os.readlink(path)
            resolved = (path.parent / target).resolve()
            if root != resolved and root not in resolved.parents:
                fail(f"发布包符号链接越界：{relative}")
            content = target.encode("utf-8")
            size = len(content)
            digest = hashlib.sha256(content).hexdigest()
        elif stat.S_ISREG(info.st_mode):
            if item["type"] != "file":
                fail(f"发布包文件类型不一致：{relative}")
            size = info.st_size
            digest = sha256_file(path)
        else:
            fail(f"发布包包含特殊文件：{relative}")
        if os.name != "nt" and isinstance(item.get("mode"), int) and stat.S_IMODE(info.st_mode) != item["mode"]:
            fail(f"发布包文件权限校验失败：{relative}")
        if size != item["size"] or digest != item["sha256"]:
            fail(f"发布包文件校验失败：{relative}")
    missing = sorted(set(expected) - actual)
    if missing:
        fail(f"发布包缺少登记文件：{missing[0]}")

    source_version = None
    if source_root is not None:
        source = source_root.resolve(strict=True)
        source_version_file = source / "VERSION"
        if not source_version_file.is_file():
            fail("现有安装缺少 VERSION")
        source_version = source_version_file.read_text(encoding="utf-8").strip()
        version_tuple(source_version)
        if source_version not in supported:
            fail(f"不支持从当前版本 {source_version} 升级")
        if version_tuple(version) <= version_tuple(source_version):
            fail("目标版本必须高于当前版本")

    return {"product": PRODUCT, "target": manifest["target"], "sourceVersion": source_version, "targetVersion": version}


def read_dotenv(path: Path) -> dict[str, str]:
    if not path.is_file():
        fail("现有环境配置不存在")
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            fail("环境配置包含无效行")
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            fail("环境配置包含无效名称")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[name] = value
    return values


def database_settings(environment_file: Path) -> dict[str, object]:
    raw = read_dotenv(environment_file).get("DATABASE_URL", "")
    parsed = urlparse(raw)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or not parsed.path.strip("/") or not parsed.username:
        fail("DATABASE_URL 必须是完整 PostgreSQL 地址")
    host = parsed.hostname.lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        fail("全自动升级只支持同机 PostgreSQL；远程数据库请使用 DBA 升级流程")
    schema = parse_qs(parsed.query).get("schema", ["public"])[0]
    if schema != "public":
        fail("全自动升级只支持 public schema；其他 schema 请使用 DBA 升级流程")
    return {
        "host": host,
        "port": parsed.port or 5432,
        "database": unquote(parsed.path.lstrip("/").split("/", 1)[0]),
        "user": unquote(parsed.username),
        "password": unquote(parsed.password or ""),
        "schema": schema,
    }


def environment_layout(environment_file: Path, install_root: Path) -> dict[str, object]:
    values = read_dotenv(environment_file)
    root = install_root.resolve(strict=True)
    if not root.is_dir():
        fail("现有安装根目录不存在")

    def child(name: str, default: str) -> str:
        configured = values.get(name, default).strip() or default
        candidate = Path(configured)
        resolved = (candidate if candidate.is_absolute() else root / candidate).resolve()
        if resolved == root or root not in resolved.parents:
            fail(f"{name} 必须位于安装根目录内")
        return resolved.relative_to(root).as_posix()

    def port(name: str, default: int) -> int:
        value = values.get(name, str(default)).strip()
        if not value.isdigit() or not 1 <= int(value) <= 65535:
            fail(f"{name} 必须是有效端口")
        return int(value)

    result = {
        "dataRelative": child("SINGLE_NODE_DATA_ROOT", "data"),
        "backupRelative": child("SINGLE_NODE_BACKUP_ROOT", "backups"),
        "runtimeRelative": child("SINGLE_NODE_RUNTIME_ROOT", "runtime-state"),
        "apiHost": values.get("HOST", "127.0.0.1").strip() or "127.0.0.1",
        "apiPort": port("PORT", 3000),
        "ldapHost": values.get("LDAP_GATEWAY_HOST", "127.0.0.1").strip() or "127.0.0.1",
        "ldapPort": port("LDAP_GATEWAY_PORT", 8081),
        "listenPort": port("SINGLE_NODE_LISTEN_PORT", 8080),
    }
    relatives = [result["dataRelative"], result["backupRelative"], result["runtimeRelative"]]
    for index, left in enumerate(relatives):
        for right in relatives[index + 1:]:
            if left == right or left.startswith(f"{right}/") or right.startswith(f"{left}/"):
                fail("数据、备份和运行状态目录不能相同或互相包含")
    return result


def postgres_tool(name: str) -> str:
    configured = os.environ.get(f"AI_TRAINING_{name.upper().replace('-', '_')}", "").strip()
    resolved = configured or shutil.which(name)
    if not resolved and os.name == "nt":
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        candidates = sorted((program_files / "PostgreSQL").glob(f"*/bin/{name}.exe"), reverse=True)
        resolved = str(candidates[0]) if candidates else None
    if not resolved:
        fail(f"找不到 PostgreSQL 工具：{name}")
    return resolved


def run_postgres(tool: str, args: list[str], settings: dict[str, object]) -> str:
    environment = postgres_environment(settings)
    command = [postgres_tool(tool), *args]
    try:
        result = subprocess.run(command, env=environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip().splitlines()
        suffix = f"：{detail[-1][:300]}" if detail else ""
        fail(f"PostgreSQL {tool} 执行失败{suffix}")
    return result.stdout


def postgres_environment(settings: dict[str, object]) -> dict[str, str]:
    environment = os.environ.copy()
    if settings["password"]:
        environment["PGPASSWORD"] = str(settings["password"])
    return environment


def connection_args(settings: dict[str, object]) -> list[str]:
    return [
        "--host", str(settings["host"]),
        "--port", str(settings["port"]),
        "--username", str(settings["user"]),
        "--dbname", str(settings["database"]),
    ]


def database_check(environment_file: Path) -> dict[str, object]:
    settings = database_settings(environment_file)
    for name in ("pg_dump", "pg_restore", "psql"):
        postgres_tool(name)
    version = run_postgres(
        "psql",
        [*connection_args(settings), "--tuples-only", "--no-align", "--command", "SHOW server_version_num"],
        settings,
    ).strip()
    if not version.isdigit() or int(version) < 140000:
        fail("PostgreSQL 服务端版本必须为 14 或更高版本")
    ownership = run_postgres(
        "psql",
        [
            *connection_args(settings),
            "--tuples-only",
            "--no-align",
            "--command",
            (
                "SELECT CASE WHEN pg_get_userbyid(datdba) = current_user "
                "THEN 'true' ELSE 'false' END "
                "FROM pg_database WHERE datname = current_database()"
            ),
        ],
        settings,
    ).strip()
    if ownership != "true":
        fail("自动升级要求 DATABASE_URL 用户是当前专用数据库的所有者")
    return {key: value for key, value in settings.items() if key != "password"}


def database_backup(environment_file: Path, output: Path) -> None:
    settings = database_settings(environment_file)
    destination = output.resolve()
    if destination.exists():
        fail("数据库恢复点已存在，拒绝覆盖")
    destination.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "--format=custom", "--no-owner", "--no-acl", "--schema", "public", "--file", str(destination),
        *connection_args(settings),
    ]
    run_postgres("pg_dump", args, settings)
    if not destination.is_file() or destination.stat().st_size == 0:
        fail("数据库恢复点为空")
    run_postgres("pg_restore", ["--list", str(destination)], settings)
    digest = sha256_file(destination)
    destination.with_suffix(destination.suffix + ".sha256").write_text(f"{digest}  {destination.name}\n", encoding="utf-8")


def active_evaluation_count(environment_file: Path) -> int:
    settings = database_settings(environment_file)
    output = run_postgres(
        "psql",
        [
            *connection_args(settings), "--tuples-only", "--no-align", "--command",
            'SELECT COUNT(*) FROM "EvaluationBatch" WHERE status = \'RUNNING\'',
        ],
        settings,
    ).strip()
    if not output.isdigit():
        fail("无法确认运行中评测数量")
    return int(output)


def database_size(environment_file: Path) -> int:
    settings = database_settings(environment_file)
    output = run_postgres(
        "psql",
        [*connection_args(settings), "--tuples-only", "--no-align", "--command", "SELECT pg_database_size(current_database())"],
        settings,
    ).strip()
    if not output.isdigit():
        fail("无法确认数据库占用空间")
    return int(output)


def database_restore(environment_file: Path, source: Path, confirm: bool) -> None:
    if not confirm:
        fail("数据库恢复必须显式确认")
    settings = database_settings(environment_file)
    backup = source.resolve(strict=True)
    checksum = backup.with_suffix(backup.suffix + ".sha256")
    if not checksum.is_file() or checksum.read_text(encoding="utf-8").split()[0].lower() != sha256_file(backup):
        fail("数据库恢复点校验失败")
    environment = postgres_environment(settings)
    psql_command = [postgres_tool("psql"), *connection_args(settings), "--set", "ON_ERROR_STOP=1"]
    restore_command = [postgres_tool("pg_restore"), "--no-owner", "--no-acl", "--schema", "public", "--file", "-", str(backup)]
    with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as psql_errors:
        psql = subprocess.Popen(
            psql_command,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=psql_errors,
        )
        if psql.stdin is None:
            fail("无法启动 PostgreSQL 恢复事务")
        try:
            psql.stdin.write(b"BEGIN;\nDROP SCHEMA public CASCADE;\nCREATE SCHEMA public AUTHORIZATION CURRENT_USER;\n")
            psql.stdin.flush()
            restore = subprocess.Popen(restore_command, env=environment, stdout=psql.stdin, stderr=subprocess.PIPE)
            _, restore_errors = restore.communicate()
            if restore.returncode == 0:
                psql.stdin.write(b"\nCOMMIT;\n")
            else:
                psql.stdin.write(b"\nROLLBACK;\n")
            psql.stdin.close()
            psql_status = psql.wait()
        except (BrokenPipeError, OSError):
            try:
                psql.stdin.close()
            except OSError:
                pass
            psql_status = psql.wait()
            restore_errors = b""
            restore = None
        if restore is None or restore.returncode != 0 or psql_status != 0:
            psql_errors.seek(0)
            details = [line for line in psql_errors.read().strip().splitlines() if line]
            restore_detail = (restore_errors or b"").decode("utf-8", errors="replace").strip().splitlines()
            detail = (details + restore_detail)[-1:] or []
            suffix = f"：{detail[0][:300]}" if detail else ""
            fail(f"PostgreSQL 恢复事务失败{suffix}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="AI 训战平台离线升级辅助工具")
    commands = root.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify-release")
    verify.add_argument("--release-root", required=True, type=Path)
    verify.add_argument("--source-root", type=Path)
    layout = commands.add_parser("environment-layout")
    layout.add_argument("--environment-file", required=True, type=Path)
    layout.add_argument("--install-root", required=True, type=Path)
    for command in ("database-check", "database-size", "database-active-evaluations", "database-backup", "database-restore"):
        item = commands.add_parser(command)
        item.add_argument("--environment-file", required=True, type=Path)
        if command == "database-backup":
            item.add_argument("--output", required=True, type=Path)
        if command == "database-restore":
            item.add_argument("--source", required=True, type=Path)
            item.add_argument("--confirm", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "verify-release":
            print(json.dumps(verify_release(args.release_root, args.source_root), ensure_ascii=False, separators=(",", ":")))
        elif args.command == "environment-layout":
            print(json.dumps(environment_layout(args.environment_file, args.install_root), ensure_ascii=False, separators=(",", ":")))
        elif args.command == "database-check":
            print(json.dumps(database_check(args.environment_file), ensure_ascii=False, separators=(",", ":")))
        elif args.command == "database-backup":
            database_backup(args.environment_file, args.output)
            print("数据库恢复点已创建")
        elif args.command == "database-active-evaluations":
            print(active_evaluation_count(args.environment_file))
        elif args.command == "database-size":
            print(database_size(args.environment_file))
        else:
            database_restore(args.environment_file, args.source, args.confirm)
            print("数据库恢复点已还原")
        return 0
    except (OSError, ValueError) as error:
        print(f"升级检查失败：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
