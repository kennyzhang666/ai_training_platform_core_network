#!/usr/bin/env python3
"""Extract one ZIP into a fresh directory with strict resource limits."""

from __future__ import annotations

import argparse
import os
import pathlib
import shutil
import stat
import sys
import tempfile
import zipfile


CHUNK_BYTES = 1024 * 1024


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("limit must be a positive integer")
    return parsed


def normalized_parts(name: str) -> tuple[str, ...]:
    if "\x00" in name:
        raise ValueError("archive path contains a null byte")
    path = pathlib.PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("archive path escapes root")
    parts = tuple(part for part in path.parts if part not in ("", "."))
    if not parts:
        raise ValueError("archive contains an empty path")
    if any(":" in part for part in parts):
        raise ValueError("archive path contains an unsupported colon")
    return parts


def validate_entries(
    entries: list[zipfile.ZipInfo],
    max_files: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> list[tuple[zipfile.ZipInfo, tuple[str, ...]]]:
    if len(entries) > max_files:
        raise ValueError(f"archive file count limit exceeded ({len(entries)} > {max_files})")
    checked: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
    seen: set[str] = set()
    total = 0
    for info in entries:
        parts = normalized_parts(info.filename)
        key = "/".join(parts).casefold()
        if key in seen:
            raise ValueError(f"archive contains a duplicate path: {info.filename}")
        seen.add(key)
        mode = (info.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(mode)
        if stat.S_ISLNK(mode):
            raise ValueError("archive symlink is not allowed")
        if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError("archive special file is not allowed")
        if info.flag_bits & 0x1:
            raise ValueError("encrypted archive entries are not allowed")
        if not info.is_dir():
            if info.file_size > max_file_bytes:
                raise ValueError(
                    f"archive single file size limit exceeded ({info.file_size} > {max_file_bytes})"
                )
            total += info.file_size
            if total > max_total_bytes:
                raise ValueError(
                    f"archive total uncompressed size limit exceeded ({total} > {max_total_bytes})"
                )
        checked.append((info, parts))
    return checked


def extract_archive(
    archive: pathlib.Path,
    target: pathlib.Path,
    max_files: int,
    max_total_bytes: int,
    max_file_bytes: int,
) -> None:
    archive = archive.resolve(strict=True)
    target = target.resolve(strict=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.is_symlink() or not target.is_dir() or any(target.iterdir()):
            raise ValueError("extraction target must be a new or empty directory")
        target.rmdir()
    staging = pathlib.Path(tempfile.mkdtemp(prefix=f".{target.name}-extracting-", dir=target.parent))
    try:
        with zipfile.ZipFile(archive) as source:
            checked = validate_entries(source.infolist(), max_files, max_total_bytes, max_file_bytes)
            total_written = 0
            for info, parts in checked:
                destination = staging.joinpath(*parts)
                if info.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                file_written = 0
                with source.open(info, "r") as input_stream, destination.open("xb") as output_stream:
                    while True:
                        chunk = input_stream.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        file_written += len(chunk)
                        total_written += len(chunk)
                        if file_written > max_file_bytes:
                            raise ValueError("archive single file size limit exceeded while extracting")
                        if total_written > max_total_bytes:
                            raise ValueError("archive total uncompressed size limit exceeded while extracting")
                        output_stream.write(chunk)
        os.replace(staging, target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("target")
    parser.add_argument("--max-files", type=positive_integer, required=True)
    parser.add_argument("--max-total-bytes", type=positive_integer, required=True)
    parser.add_argument("--max-file-bytes", type=positive_integer, required=True)
    args = parser.parse_args()
    try:
        extract_archive(
            pathlib.Path(args.archive),
            pathlib.Path(args.target),
            args.max_files,
            args.max_total_bytes,
            args.max_file_bytes,
        )
    except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        print(f"safe extraction failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
