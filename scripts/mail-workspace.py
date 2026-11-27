#!/usr/bin/env python3
"""Place Omamail and its dedicated browser in a Hyprland special workspace."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

NAME = "omamail-inbox"
WORKSPACE = f"special:{NAME}"
MAIL_TITLE = "Omamail — Drop-down"
BROWSERS = {
    "brave-browser.desktop": (("brave", "brave-browser"), "BraveSoftware/Brave-Browser"),
    "chromium.desktop": (("chromium",), "chromium"),
    "google-chrome.desktop": (("google-chrome-stable", "google-chrome"), "google-chrome"),
}


def query(name):
    output = subprocess.check_output(["hyprctl", "-j", name], text=True, timeout=2)
    return json.loads(output)


def evaluate(code):
    output = subprocess.check_output(["hyprctl", "eval", code], text=True, timeout=2)
    if output.strip() != "ok":
        raise RuntimeError("Hyprland rejected the workspace operation")


def dispatch(*actions):
    evaluate("; ".join(f"hl.dispatch({action})" for action in actions))


def in_workspace(client):
    return client.get("workspace", {}).get("name") == WORKSPACE


def address_of(client):
    address = client.get("address", "")
    if not re.fullmatch(r"0x[0-9a-fA-F]+", address):
        raise RuntimeError("Hyprland returned an invalid window address")
    return address


def place(client):
    selector = f'"address:{address_of(client)}"'
    actions = []
    if not in_workspace(client):
        actions.append(f'hl.dsp.window.move({{ workspace = "{WORKSPACE}", follow = false, window = {selector} }})')
    if client.get("floating"):
        actions.append(f'hl.dsp.window.float({{ action = "off", window = {selector} }})')
    if actions:
        dispatch(*actions)


def wait_for_client(matches, seconds):
    deadline = time.monotonic() + seconds
    while True:
        for client in query("clients"):
            if matches(client):
                return client
        if time.monotonic() >= deadline:
            raise RuntimeError("The workspace window did not appear")
        time.sleep(0.15)


def visible_monitor(monitors):
    return next((monitor for monitor in monitors
                 if monitor.get("specialWorkspace", {}).get("name") == WORKSPACE), None)


def change_visibility(action):
    visible = visible_monitor(query("monitors"))
    if (action == "show" and visible is not None) or (action == "hide" and visible is None):
        return visible is not None
    actions = []
    if visible is not None and not visible.get("focused"):
        name = visible.get("name", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            raise RuntimeError("Hyprland returned an invalid monitor name")
        actions.append(f'hl.dsp.focus({{ monitor = "{name}" }})')
    actions.append(f'hl.dsp.workspace.toggle_special("{NAME}")')
    dispatch(*actions)
    return visible is None


def start_browser(arguments):
    subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


def read_json(path):
    try:
        with path.open(encoding="utf-8") as file:
            data = json.loads(file.read(8 * 1024 * 1024))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def is_profile(name):
    # Chromium's normal profile directories are Default and numbered Profile
    # directories. Guest and system profiles must never be selected here.
    return isinstance(name, str) and re.fullmatch(r"(?:Default|Profile [1-9][0-9]{0,6})", name)


def last_profile(directory):
    config = Path(os.environ.get("CHROME_CONFIG_HOME") or os.environ.get("XDG_CONFIG_HOME")
                  or Path.home() / ".config")
    user_data = Path(os.environ.get("CHROME_USER_DATA_DIR") or config / directory)
    profiles = read_json(user_data / "Local State").get("profile")
    name = profiles.get("last_used") if isinstance(profiles, dict) else None
    return name if is_profile(name) else "Default"


def has_browser_title(client, title):
    window_title = client.get("title", "")
    # Chromium uses the requested title verbatim or adds the browser name,
    # depending on the build. The unique title is assigned by the browser.
    return window_title == title or window_title.startswith(title + " - ")


def browser_executable(desktop):
    candidates, _ = BROWSERS.get(desktop, ((), ""))
    return next((path for candidate in candidates if (path := shutil.which(candidate))), None)


def default_browser():
    try:
        return subprocess.check_output(
            ["omarchy-cmd-default-browser"], text=True, timeout=3, stderr=subprocess.DEVNULL
        ).strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        return subprocess.check_output(
            ["xdg-settings", "get", "default-web-browser"], text=True, timeout=3
        ).strip()


def open_link(url):
    # The reader checks the destination before invoking us. The argv boundary
    # also rejects controls and everything other than a complete HTTP(S) URL.
    if re.search(r"[\x00-\x20\x7f\\]", url):
        raise ValueError("Invalid browser URL")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Expected an HTTP(S) browser URL")

    desktop = default_browser()
    executable = browser_executable(desktop)
    if not executable:
        start_browser(["xdg-open", url])
        return

    runtime = Path(os.environ["XDG_RUNTIME_DIR"])
    instance = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE", "")
    state_path = runtime / "omamail" / ("browser-" + hashlib.sha256(instance.encode()).hexdigest()[:16] + ".json")
    saved = read_json(state_path)
    clients = query("clients")
    title = saved.get("title", "")
    profile = saved.get("profile", "")
    if (saved.get("desktop") == desktop and is_profile(profile) and isinstance(title, str)
            and re.fullmatch(r"Omamail [0-9a-f]{24}", title)):
        matches = [client for client in clients if in_workspace(client) and has_browser_title(client, title)]
        if len(matches) == 1:
            address = address_of(matches[0])
            dispatch(f'hl.dsp.focus({{ window = "address:{address}" }})')
            # Chromium sends external URLs to the profile's last active
            # tabbed window. Wait until the compositor reports focus.
            deadline = time.monotonic() + 1
            while query("activewindow").get("address") != address:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Could not focus the workspace browser")
                time.sleep(0.05)
            start_browser([executable, f"--profile-directory={profile}", "--", url])
            return

    profile = last_profile(BROWSERS[desktop][1])
    title = "Omamail " + secrets.token_hex(12)
    old_addresses = {client.get("address") for client in clients}
    start_browser([executable, f"--profile-directory={profile}", "--new-window",
                   f"--window-name={title}", "--", url])
    window = wait_for_client(lambda client: client.get("address") not in old_addresses
                             and has_browser_title(client, title), 7)
    place(window)
    state_path.parent.mkdir(mode=0o700, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=state_path.parent, delete=False) as file:
        json.dump({"desktop": desktop, "title": title, "profile": profile}, file)
    os.replace(file.name, state_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("show", "toggle"):
        commands.add_parser(action).add_argument("mail_pid", type=int, nargs="?", default=os.getppid())
    commands.add_parser("hide")
    commands.add_parser("link")
    commands.add_parser("status")
    args = parser.parse_args()
    try:
        if args.action == "link":
            # A length-limited line avoids spreading clicked URLs through
            # the Omamail helper's process arguments or logs.
            target = sys.stdin.readline(131073)
            if not target.endswith("\n") or len(target) > 131072:
                raise ValueError("Invalid link input")
            url = json.loads(target)
            if not isinstance(url, str):
                raise ValueError("Invalid link URL")
            open_link(url)
        elif args.action == "status":
            print("shown" if visible_monitor(query("monitors")) is not None else "hidden")
        else:
            if args.action != "hide":
                mail = wait_for_client(lambda client: client.get("pid") == args.mail_pid
                                       and client.get("initialTitle") == MAIL_TITLE, 3)
                place(mail)
            print("shown" if change_visibility(args.action) else "hidden")
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        # Never print argv or the clicked URL in shell logs.
        print(f"Omamail workspace {args.action} failed ({type(error).__name__})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
