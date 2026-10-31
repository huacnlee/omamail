#!/usr/bin/env python3
"""The local standalone targets use the portable backend and explicit dev paths."""
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def make(*args):
    return subprocess.run(
        ["make", "--no-print-directory", *args], cwd=ROOT, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, check=True).stdout


help_text = make("help")
assert "make app-build" in help_text
assert "make app-run" in help_text

build = make("-n", "app-build")
assert "cargo build --locked --no-default-features --features standalone" in build
assert '-DOMAMAIL_BACKEND="' in build
assert "/target/standalone/debug/omamail" in build
assert "cmake --build" in build

run = make("-n", "app-run")
launches = [
    line for line in run.splitlines()
    if "OMAMAIL_DEVELOPMENT_RESOURCES=1" in line
]
assert len(launches) == 1, run
launch = launches[0]
assert "OMAMAIL_DEVELOPMENT_RESOURCES=1" in launch
assert 'OMAMAIL_BIN="' in launch and "/target/standalone/debug/omamail" in launch
assert "/app/build/omamail-app" in launch
assert "backend-runtime.py" not in run
# Private backend installation is excluded by the helper check above, not by searching paths
# for "install": a checkout may legitimately be named "installed/omamail".
assert "PATH=" not in launch

cmake = (ROOT / "app/CMakeLists.txt").read_text()
assert 'ui/assets/*' in cmake

makefile = (ROOT / "Makefile").read_text()
assert "validate: test test-app-qml qml-check" in makefile
assert 'test-app-qml:\n\t@test -n "$(QMLTESTRUNNER)"' in makefile

# CMake may not independently find Qt's runner outside PATH. Forward the
# already resolved executable and fail instead of silently testing nothing.
qml = make("-n", "test-app-qml", "QMLTESTRUNNER=/synthetic/qt/bin/qmltestrunner")
assert '-DQMLTESTRUNNER_EXECUTABLE="/synthetic/qt/bin/qmltestrunner"' in qml
assert '--no-tests=error' in qml

print("test_app_make.py ok")
