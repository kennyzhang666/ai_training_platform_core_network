from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Iterator


IGNORED_DIRS = {".git", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache"}
IGNORED_SUFFIXES = {".pyc", ".pyo"}


def _canonical_bytes(path: Path) -> bytes:
    raw = path.read_bytes()
    # Git archives contain LF while Windows worktrees may contain CRLF. Text
    # newline normalization keeps equivalent source trees on one hash without
    # changing binary artifacts (identified by invalid UTF-8 or NUL bytes).
    if b"\0" in raw:
        return raw
    try:
        return raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    except UnicodeDecodeError:
        return raw


def _files(root: Path) -> Iterator[Path]:
    if root.is_symlink():
        raise ValueError("snapshot root cannot be a symbolic link")
    root = root.resolve()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_symlink():
            raise ValueError(f"snapshot cannot include symbolic link: {path.relative_to(root).as_posix()}")
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in IGNORED_DIRS for part in relative.parts) or path.suffix.lower() in IGNORED_SUFFIXES:
            continue
        yield path


def snapshot_hash(root: Path) -> str:
    """Return a language-independent hash of a submission tree."""
    if root.is_symlink():
        raise ValueError("snapshot root cannot be a symbolic link")
    root = root.resolve()
    digest = hashlib.sha256()
    for path in _files(root):
        relative = path.relative_to(root).as_posix()
        content_hash = hashlib.sha256(_canonical_bytes(path)).hexdigest()
        executable = "1" if path.stat().st_mode & 0o111 else "0"
        digest.update(f"{relative}\0{content_hash}\0{executable}\n".encode("utf-8"))
    return digest.hexdigest()


def snapshot_manifest(root: Path) -> list[dict[str, str]]:
    if root.is_symlink():
        raise ValueError("snapshot root cannot be a symbolic link")
    root = root.resolve()
    return [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(_canonical_bytes(path)).hexdigest(),
            "executable": "1" if path.stat().st_mode & 0o111 else "0",
        }
        for path in _files(root)
    ]
