from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import tempfile
import zipfile


def extended_windows_path(path: Path) -> Path:
    if os.name != "nt":
        return path
    value = os.path.abspath(path)
    if value.startswith("\\\\?\\"):
        return Path(value)
    if value.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + value[2:])
    return Path("\\\\?\\" + value)


def entries(root: Path) -> list[Path]:
    return sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix())


def normalized_epoch(root: Path) -> int:
    manifest = json.loads((root / "release-manifest.json").read_text(encoding="utf-8"))
    value = str(manifest["createdAt"]).replace("Z", "+00:00")
    return int(dt.datetime.fromisoformat(value).timestamp())


def write_zip(root: Path, destination: Path, epoch: int) -> None:
    timestamp = dt.datetime.fromtimestamp(max(epoch, 315_532_800), tz=dt.timezone.utc)
    date_time = (timestamp.year, timestamp.month, timestamp.day, timestamp.hour, timestamp.minute, timestamp.second)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in entries(root):
            relative = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(relative + ("/" if path.is_dir() else ""), date_time=date_time)
            info.create_system = 3
            mode = path.lstat().st_mode
            if path.is_symlink():
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, os.readlink(path).encode("utf-8"), compress_type=zipfile.ZIP_STORED)
            elif path.is_dir():
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
                archive.writestr(info, b"", compress_type=zipfile.ZIP_STORED)
            else:
                info.external_attr = (stat.S_IFREG | (mode & 0o777)) << 16
                archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def tar_filter(epoch: int):
    def normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
        info.mtime = epoch
        info.uid = 0
        info.gid = 0
        info.uname = ""
        info.gname = ""
        info.pax_headers = {}
        return info

    return normalize


def write_tar_gz(root: Path, destination: Path, epoch: int) -> None:
    handle, temporary_name = tempfile.mkstemp(prefix="ai-training-release-", suffix=".tar")
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        with tarfile.open(temporary, "w", format=tarfile.PAX_FORMAT, dereference=False) as archive:
            for path in entries(root):
                archive.add(path, arcname=path.relative_to(root).as_posix(), recursive=False, filter=tar_filter(epoch))
        with temporary.open("rb") as source, destination.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=epoch) as compressed:
                shutil.copyfileobj(source, compressed, length=1024 * 1024)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: archive-release.py <release-root> <archive-path> <target>")
    root = extended_windows_path(Path(sys.argv[1]).resolve(strict=True))
    destination = extended_windows_path(Path(sys.argv[2]).resolve())
    target = sys.argv[3]
    if destination.exists():
        raise SystemExit(f"archive already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    epoch = normalized_epoch(root)
    if target == "win32-x64":
        write_zip(root, destination, epoch)
    elif target == "linux-x64":
        write_tar_gz(root, destination, epoch)
    else:
        raise SystemExit(f"unsupported release target: {target}")


if __name__ == "__main__":
    main()
