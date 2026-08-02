from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from drill_grader.cli import main

raise SystemExit(main())
