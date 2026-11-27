#!/usr/bin/env python3
"""Exercise workspace IPC and browser launch without the user's compositor."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = Path(__file__).resolve().parents[1] / "scripts/mail-workspace.py"
WORKSPACE = {"name": "special:omamail-inbox"}
URL = "https://example.org/a?x=';echo%20unsafe"
STUB = """#!{python}
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["EVENTS"], "a") as log:
    print(json.dumps([name, *args]), file=log)
if name == "hyprctl":
    if args[:1] == ["-j"]:
        clients = json.loads(os.environ[args[1].upper()])
        if args[1] == "clients" and "NEW_WINDOW" in os.environ and pathlib.Path(os.environ["NEW_WINDOW"]).exists():
            clients.append(json.loads(pathlib.Path(os.environ["NEW_WINDOW"]).read_text()))
        print(json.dumps(clients))
    else:
        print("ok")
elif name == "brave" and "--new-window" in args and "NEW_WINDOW" in os.environ:
    title = next((arg.split("=", 1)[1] for arg in args if arg.startswith("--window-name=")), "")
    pathlib.Path(os.environ["NEW_WINDOW"]).write_text(json.dumps({
        "address": "0xccc", "initialClass": "brave-browser", "title": title + " - Brave",
        "workspace": {"name": "2"},
        "floating": True,
    }))
elif name == "xdg-settings":
    print(os.environ["BROWSER"])
"""


class MailWorkspace(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.log = self.root / "events"
        for name in ["hyprctl", "xdg-settings", "xdg-open", "brave"]:
            program = self.root / name
            program.write_text(STUB.replace("{python}", sys.executable))
            program.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.root), EVENTS=str(self.log),
                        XDG_RUNTIME_DIR=str(self.root), XDG_CONFIG_HOME=str(self.root),
                        CHROME_USER_DATA_DIR="", CHROME_CONFIG_HOME="", BROWSER="brave-browser.desktop",
                        CLIENTS="[]", MONITORS="[]", ACTIVEWINDOW='{"address":"0xccc"}')

    def run_helper(self, action, *args, success=True):
        argument_list = []
        stdin = None
        if action == "link":
            stdin = json.dumps(args[0]) + "\n"
        else:
            argument_list = args
        completed = subprocess.run([sys.executable, str(HELPER), action, *argument_list],
                                   input=stdin, env=self.env, capture_output=True,
                                   text=True, timeout=12)
        self.assertEqual(completed.returncode == 0, success, completed.stderr)
        if action == "link" and success:
            # Browser launch is asynchronous. Wait for its one observable argv.
            previous = getattr(self, "browser_launches", 0)
            for _ in range(100):
                events = self.events()
                self.browser_launches = sum(row[0] in ("brave", "xdg-open") for row in events)
                if self.browser_launches > previous:
                    break
                time.sleep(0.02)
        return self.events()

    def events(self):
        return [json.loads(row) for row in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_show_moves_only_the_omamail_window_and_tiles_it(self):
        self.env["CLIENTS"] = json.dumps([
            {"address": "0xaaa", "pid": 1234, "initialTitle": "Omamail — Drop-down",
             "workspace": {"name": "1"}, "floating": True},
            {"address": "0xbbb", "pid": 666, "initialTitle": "Omamail — Drop-down",
             "workspace": {"name": "1"}, "floating": True},
        ])
        commands = '\n'.join(row[2] for row in self.run_helper("show", "1234") if row[1] == "eval")
        self.assertIn('workspace = "special:omamail-inbox"', commands)
        self.assertIn('action = "off"', commands)
        self.assertNotIn("hl.workspace_rule", commands)
        self.assertIn('address:0xaaa', commands)
        self.assertNotIn('address:0xbbb', commands)
        self.assertIn('toggle_special("omamail-inbox")', commands)

    def test_hide_leaves_clients_running_and_is_a_noop_when_already_hidden(self):
        self.assertEqual(self.run_helper("hide"), [["hyprctl", "-j", "monitors"]])
        self.env["MONITORS"] = json.dumps([{"focused": True, "specialWorkspace": WORKSPACE}])
        actions = [command for command in self.run_helper("hide") if command[1] == "eval"]
        self.assertEqual(len(actions), 1)
        self.assertIn('toggle_special("omamail-inbox")', actions[0][2])
        self.assertNotIn("window.", actions[0][2])

    def setup_brave(self, profile):
        state = self.root / "BraveSoftware/Brave-Browser/Local State"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps({"profile": {"last_used": profile}}))
        self.env["NEW_WINDOW"] = str(self.root / "new-window")
        return state

    def test_first_link_uses_last_profile_and_places_only_the_named_browser_window(self):
        self.setup_brave("Profile 4")
        self.env["CLIENTS"] = json.dumps([
            {"address": "0xddd", "initialClass": "brave-browser",
             "title": "Existing window", "workspace": {"name": "2"}, "floating": True},
        ])
        events = self.run_helper("link", URL)
        launch = next(row for row in events if row[0] == "brave")
        self.assertIn("--new-window", launch)
        self.assertIn("--profile-directory=Profile 4", launch)
        self.assertTrue(any(arg.startswith("--window-name=Omamail") for arg in launch))
        self.assertFalse(any(arg.startswith("--user-data-dir") for arg in launch))
        self.assertEqual(launch[-2:], ["--", URL])
        commands = '\n'.join(row[2] for row in events if row[1] == "eval")
        self.assertIn('workspace = "special:omamail-inbox"', commands)
        self.assertIn('address:0xccc', commands)
        self.assertNotIn('address:0xddd', commands)

    def test_later_links_focus_the_same_window_and_keep_its_profile(self):
        state = self.setup_brave("Profile 4")
        self.run_helper("link", URL)
        state.write_text(json.dumps({"profile": {"last_used": "Profile 2"}}))
        mapped = Path(self.env["NEW_WINDOW"])
        window = json.loads(mapped.read_text())
        window["workspace"] = WORKSPACE
        mapped.write_text(json.dumps(window))

        events = self.run_helper("link", "https://example.org/next")
        self.assertEqual(len([row for row in events if row[0] == "brave"]), 2)
        launch = events[-1]
        self.assertEqual(launch[0], "brave")
        self.assertIn("--profile-directory=Profile 4", launch)
        self.assertNotIn("--new-window", launch)
        self.assertEqual(launch[-2:], ["--", "https://example.org/next"])
        self.assertIn(["hyprctl", "eval", 'hl.dispatch(hl.dsp.focus({ window = "address:0xccc" }))'], events)

    def test_switching_default_browser_does_not_reuse_the_old_browser(self):
        self.setup_brave("Default")
        self.run_helper("link", URL)
        mapped = Path(self.env["NEW_WINDOW"])
        window = json.loads(mapped.read_text())
        window["workspace"] = WORKSPACE
        mapped.write_text(json.dumps(window))
        self.env["BROWSER"] = "firefox.desktop"
        self.assertIn(["xdg-open", "https://example.org/next"],
                      self.run_helper("link", "https://example.org/next"))

    def test_omarchy_resolves_its_browser_dispatcher_to_the_real_default(self):
        resolver = self.root / "omarchy-cmd-default-browser"
        resolver.write_text("#!/bin/sh\nprintf 'brave-browser.desktop\\n'\n")
        resolver.chmod(0o700)
        self.env["BROWSER"] = "omarchy-browser.desktop"
        self.setup_brave("Default")
        self.assertTrue(any(row[0] == "brave" for row in self.run_helper("link", URL)))

    def test_unsupported_default_uses_system_handler(self):
        self.env["BROWSER"] = "firefox.desktop"
        self.assertIn(["xdg-open", URL], self.run_helper("link", URL))

    def test_unsafe_links_run_no_commands(self):
        for target in ["file:///etc/passwd", "--guest", "https://example.org/\n", "https://"]:
            with self.subTest(target=target):
                self.assertEqual(self.run_helper("link", target, success=False), [])


if __name__ == "__main__":
    unittest.main()
