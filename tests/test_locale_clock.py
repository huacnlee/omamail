#!/usr/bin/env python3
"""Real Qt clocks and widgets in independent synthetic profiles, never a desktop."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
runner = sys.argv[1]
for locale in ("en_US", "en_GB", "fi_FI", "zh_CN", "zh_TW"):
    with tempfile.TemporaryDirectory(prefix="omamail-locale-") as directory:
        profile = Path(directory)
        env = dict(os.environ, LC_ALL=locale + ".UTF-8", TZ="America/New_York",
                   QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                   QT_QPA_PLATFORMTHEME="", GSETTINGS_BACKEND="memory")
        for key, name in (("HOME", "home"), ("XDG_CONFIG_HOME", "config"),
                          ("XDG_CACHE_HOME", "cache"), ("XDG_DATA_HOME", "data"),
                          ("XDG_STATE_HOME", "state")):
            path = profile / name
            path.mkdir()
            env[key] = str(path)
        for test in ("tst_locale_clock.qml", "tst_native_locale_clock.qml", "tst_calendar_event_composer.qml", "tst_message_row_layout.qml"):
            print(f"Real Qt locale={locale}, timezone=America/New_York, {test}", flush=True)
            subprocess.run([runner, "-input", str(ROOT / "ui/tests/qml" / test),
                            "-import", str(ROOT / "ui/tests/qml/imports")],
                           cwd=ROOT, env=env, check=True)
