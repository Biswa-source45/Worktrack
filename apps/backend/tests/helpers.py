import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]


def run_alembic(*args: str) -> None:
    """Run Alembic in a subprocess: env.py calls asyncio.run, which cannot nest in pytest's loop."""
    subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
