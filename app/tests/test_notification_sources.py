#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sources = "\n".join(
    path.read_text(encoding="utf-8")
    for path in sorted((ROOT / "src").glob("notifications*"))
)

for forbidden in (
    "QProcess",
    "system(",
    "popen(",
    "ShellExecute",
    "osascript",
    "notify-send",
):
    assert forbidden not in sources, f"notification adapter invokes a shell/process API: {forbidden}"

main = (ROOT / "src" / "main.cpp").read_text(encoding="utf-8")
assert main.index("initializeNotificationActivation();") < main.index("engine.load(mainUrl)")

windows = (ROOT / "src" / "notifications_windows.cpp").read_text(encoding="utf-8")
for required in (
    "6e420bbe, 0xa800, 0x4ff9",
    "CoRegisterClassObject",
    "INotificationActivationCallback",
    "validActivationToken(invokedArgs)",
    "std::wcscmp(appUserModelId, applicationId)",
    "trimEntries();",
    "maximumNativeNotificationEntries",
):
    assert required in windows, f"Windows cold-start activation contract missing: {required}"
assert windows.index("m_notifier.Show(toast);") < windows.index("removeEntry(key);")

linux = (ROOT / "src" / "notifications_linux.cpp").read_text(encoding="utf-8")
for required in (
    "serviceOwner(notificationService)",
    "activationNamespaceChanged(owner)",
    "notificationPlatformAlias(serviceOwner, nativeId)",
    "maximumNativeNotificationEntries",
):
    assert required in linux, f"Linux durable activation boundary missing: {required}"

print("notification adapters contain no shell/process invocation")
