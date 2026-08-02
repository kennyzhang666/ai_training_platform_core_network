"""Run a packaged evaluation engine under lightweight process isolation.

This is deliberately not a container. The platform is internal and the engine
package is uploaded by an author, not by a trainee, so the threat model is
"a buggy or runaway judge", not "a hostile one". What must not happen is a
single bad package taking down the API host, reading platform credentials, or
writing outside its own scratch directory.

The launcher therefore:

* replaces the environment with a minimal one, so no platform secret, token or
  data-file path is inherited by the engine;
* applies address-space, CPU and file-size limits where the OS supports them
  (POSIX ``resource``); on Windows these are unavailable and the wall clock in
  the caller remains the backstop;
* runs the engine with the interpreter's isolated mode so the invoking user's
  site-packages and PYTHON* variables cannot change its behaviour;
* pins the working directory to the scratch directory, never the repository.

Usage::

    python launch.py --entry <engine.py> --input <in.json> --output <out.json>
                     --cwd <scratch> [--python <interpreter>]
                     [--memory-mb N] [--cpu-seconds N] [--output-bytes N]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def _preexec(memory_mb: int, cpu_seconds: int, output_bytes: int):
    """Build a POSIX pre-exec hook applying rlimits, or None where unsupported."""
    try:
        import resource
    except ImportError:  # Windows
        return None

    def apply() -> None:
        # A runaway allocation must fail inside the engine, not by pushing the
        # evaluation host into swap.
        if memory_mb > 0:
            limit = memory_mb * 1024 * 1024
            for name in ("RLIMIT_AS", "RLIMIT_DATA"):
                value = getattr(resource, name, None)
                if value is not None:
                    try:
                        resource.setrlimit(value, (limit, limit))
                    except (ValueError, OSError):
                        pass
        if cpu_seconds > 0 and hasattr(resource, "RLIMIT_CPU"):
            # One second of head room so SIGXCPU lands before the caller's wall
            # clock kill, which produces a clearer error.
            try:
                resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
            except (ValueError, OSError):
                pass
        if output_bytes > 0 and hasattr(resource, "RLIMIT_FSIZE"):
            try:
                resource.setrlimit(resource.RLIMIT_FSIZE, (output_bytes, output_bytes))
            except (ValueError, OSError):
                pass
        if hasattr(os, "setsid"):
            # Own process group, so a timeout kills the engine's children too.
            os.setsid()

    return apply


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="engine-sandbox")
    parser.add_argument("--entry", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--memory-mb", type=int, default=512)
    parser.add_argument("--cpu-seconds", type=int, default=120)
    parser.add_argument("--wall-seconds", type=int, default=180)
    parser.add_argument("--output-bytes", type=int, default=5 * 1024 * 1024)
    args = parser.parse_args(argv)

    scratch = Path(args.cwd).resolve()
    scratch.mkdir(parents=True, exist_ok=True)

    # A minimal environment: nothing the platform holds is visible to the engine.
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONHASHSEED": "0",  # deterministic iteration order across runs
        "TMPDIR": str(scratch),
        "TEMP": str(scratch),
        "TMP": str(scratch),
        "HOME": str(scratch),
        "USERPROFILE": str(scratch),
        "LANG": "C.UTF-8",
    }
    if sys.platform == "win32":
        for name in ("SYSTEMROOT", "COMSPEC", "PATHEXT", "SYSTEMDRIVE"):
            if name in os.environ:
                environment[name] = os.environ[name]

    command = [args.python, "-I", "-B", str(Path(args.entry).resolve()),
               "--input", str(Path(args.input).resolve()),
               "--output", str(Path(args.output).resolve())]

    preexec = _preexec(args.memory_mb, args.cpu_seconds, args.output_bytes)
    try:
        completed = subprocess.run(
            command,
            cwd=str(scratch),
            env=environment,
            capture_output=True,
            text=True,
            timeout=max(1, args.wall_seconds),
            **({"preexec_fn": preexec} if preexec else {}),
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({"sandbox": "TIMEOUT", "wallSeconds": args.wall_seconds}), file=sys.stderr)
        return 124
    except OSError as error:
        print(json.dumps({"sandbox": "SPAWN_FAILED", "error": str(error)}), file=sys.stderr)
        return 125

    # The engine's own streams are diagnostics only; the result is the file.
    if completed.stdout:
        sys.stdout.write(completed.stdout[-8000:])
    if completed.stderr:
        sys.stderr.write(completed.stderr[-8000:])
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
