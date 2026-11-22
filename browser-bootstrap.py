#!/usr/bin/env python3
"""Start or stop the persistent Chromium instance using the browser-use setup."""

import json
import os
import subprocess
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent


def has_drission_page(python):
    try:
        return subprocess.run(
            [str(python), "-c", "import DrissionPage"],
            capture_output=True,
            timeout=30,
        ).returncode == 0
    except Exception:
        return False


def ensure_python():
    if has_drission_page(sys.executable):
        return None

    for candidate in (Path.cwd() / ".venv", Path.cwd() / "venv"):
        python = candidate / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if python.exists() and has_drission_page(python):
            return str(python)

    venv = PLUGIN_DIR / ".venv"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "-q",
                "--disable-pip-version-check",
                "drissionpage",
            ],
            check=True,
        )
    elif not has_drission_page(python):
        subprocess.run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "-q",
                "--disable-pip-version-check",
                "drissionpage",
            ],
            check=True,
        )
    return str(python)


def get_browser(port):
    from DrissionPage import Chromium, ChromiumOptions

    options = ChromiumOptions().set_local_port(port)
    options.set_load_mode("eager")

    user_data = os.environ.get("DP_USER_DATA", "")
    if user_data:
        Path(user_data).mkdir(parents=True, exist_ok=True)
        options.set_user_data_path(user_data)

    headless = os.environ.get("DP_HEADLESS", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )
    if headless:
        options.headless(True)

    return Chromium(options)


def main():
    python = ensure_python()
    if python:
        environment = dict(os.environ)
        environment["DP_BROWSER_REEXEC"] = "1"
        os.execve(python, [python, str(Path(__file__).resolve()), *sys.argv[1:]], environment)

    port = int(os.environ.get("DP_BROWSER_PORT", "9333"))
    action = sys.argv[1] if len(sys.argv) > 1 else "start"
    browser = get_browser(port)

    if action == "quit":
        browser.quit(2, True)
        print(json.dumps({"ok": True, "action": "quit"}))
        return

    print(json.dumps({"ok": True, "action": "start", "port": port}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        sys.exit(1)
