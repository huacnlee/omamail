#!/usr/bin/env python3
"""Calendar QML tests that need the process to run in a given local zone.

Qt reads TZ once, so a test about the local clock's DST changes cannot set its
zone from QML. Each directory under ui/tests/qml_zones runs here under the zone
its tests are written for, with the shared QML stubs and an isolated home.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ZONE = "America/Los_Angeles"


def main():
    runner = sys.argv[1]
    with tempfile.TemporaryDirectory(prefix="omamail-zones-qml-") as directory:
        home = Path(directory)
        env = dict(os.environ, TZ=ZONE, HOME=str(home), XDG_CONFIG_HOME=str(home / "config"),
                   XDG_CACHE_HOME=str(home / "cache"), XDG_DATA_HOME=str(home / "data"),
                   XDG_STATE_HOME=str(home / "state"), QT_QPA_PLATFORM="offscreen",
                   QT_QUICK_BACKEND="software", QT_QPA_PLATFORMTHEME="", GSETTINGS_BACKEND="memory")
        completed = subprocess.run([runner, "-import", str(ROOT / "ui/tests/qml/imports"),
                                    "-input", str(ROOT / "ui/tests/qml_zones")],
                                   cwd=ROOT, env=env, timeout=120)
    raise SystemExit(completed.returncode)


if __name__ == "__main__":
    main()
