#!/usr/bin/env python3
"""Verify Service's real wl-copy arguments cannot execute clipboard options."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
runner = os.environ.get("QMLTESTRUNNER") or shutil.which("qmltestrunner6")
if not runner and Path("/usr/lib/qt6/bin/qmltestrunner").exists():
    runner = "/usr/lib/qt6/bin/qmltestrunner"
if not runner:
    runner = shutil.which("qmltestrunner")
clipboard = shutil.which("wl-copy")
if not runner or not clipboard:
    print("Clipboard transport regression SKIP: requires QML test tooling and wl-copy")
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix="omamail-clipboard-") as directory:
    env = dict(os.environ, XDG_RUNTIME_DIR=directory,
               XDG_CONFIG_HOME=directory, XDG_DATA_HOME=directory,
               XDG_CACHE_HOME=directory, XDG_STATE_HOME=directory,
               WAYLAND_DISPLAY="unavailable-review-display",
               QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
               QT_QPA_PLATFORMTHEME="", GSETTINGS_BACKEND="memory")
    result = subprocess.run([runner, "-input", str(ROOT / "ui/tests/qml/tst_clipboard_arguments.qml"),
                             "-import", str(ROOT / "ui/tests/qml/imports")],
                            env=env, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    commands = [json.loads(line.split("OMAMAIL_CLIPBOARD_ARGUMENTS:", 1)[1])
                for line in result.stdout.splitlines() if "OMAMAIL_CLIPBOARD_ARGUMENTS:" in line]
    assert len(commands) == 7, result.stdout
    for command in commands:
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=5)
        assert result.returncode != 0, (command, result.stdout, result.stderr)
        assert result.stdout == "", (command, result.stdout)
        assert "Failed to connect to a Wayland server" in result.stderr, (command, result.stderr)
    # Negative control: the vulnerable argument list executes --version and
    # succeeds, even though this display cannot accept clipboard writes.
    vulnerable = subprocess.run([clipboard, "--version"], env=env,
                                text=True, capture_output=True, timeout=5)
    assert vulnerable.returncode == 0 and "wl-clipboard" in vulnerable.stdout
print("Clipboard transport regression PASS; no clipboard connection or option action")
