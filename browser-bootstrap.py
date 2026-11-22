#!/usr/bin/env python3
"""Backward-compatible entry point for older plugin runtime versions."""

import os
import subprocess
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
BROWSER_SCRIPT = PLUGIN_DIR / "scripts" / "dp_browser.py"


def main():
    action = sys.argv[1].lower() if len(sys.argv) > 1 else "start"
    if action in ("start", "status", "tabs"):
        command = "tabs"
    elif action in ("stop", "quit"):
        command = "quit"
    else:
        raise ValueError(f"Unsupported browser action: {action}")

    if not BROWSER_SCRIPT.is_file():
        raise FileNotFoundError(f"Browser backend not found: {BROWSER_SCRIPT}")

    result = subprocess.run(
        [sys.executable, str(BROWSER_SCRIPT), command],
        cwd=str(PLUGIN_DIR),
        env=os.environ.copy(),
        check=False,
    )
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            f'{{"ok": false, "error": "{type(error).__name__}: {error}"}}',
            file=sys.stdout,
        )
        raise SystemExit(1)
