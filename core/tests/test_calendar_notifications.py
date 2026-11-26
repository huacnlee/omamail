#!/usr/bin/env python3
"""Exercise real libnotify actions on a private D-Bus, never the desktop bus."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def peer():
    import dbus
    import dbus.mainloop.glib
    import dbus.service
    from gi.repository import GLib

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    loop = GLib.MainLoop()
    observed = {}

    class Notifications(dbus.service.Object):
        @dbus.service.method('org.freedesktop.Notifications', out_signature='as')
        def GetCapabilities(self):
            return ['actions', 'body', 'body-markup']

        @dbus.service.method('org.freedesktop.Notifications', out_signature='ssss')
        def GetServerInformation(self):
            return ('Synthetic calendar peer', 'Omamail tests', '1', '1.2')

        @dbus.service.method('org.freedesktop.Notifications', in_signature='susssasa{sv}i', out_signature='u')
        def Notify(self, app, replaces, icon, summary, body, actions, hints, expires):
            observed.update(summary=str(summary), body=str(body), actions=list(map(str, actions)))
            GLib.timeout_add(100, lambda: (self.ActionInvoked(1, 'snooze'), self.NotificationClosed(1, 2), False)[2])
            return dbus.UInt32(1)

        @dbus.service.signal('org.freedesktop.Notifications', signature='us')
        def ActionInvoked(self, notification_id, action):
            pass

        @dbus.service.signal('org.freedesktop.Notifications', signature='uu')
        def NotificationClosed(self, notification_id, reason):
            pass

    bus = dbus.SessionBus()
    name = dbus.service.BusName('org.freedesktop.Notifications', bus)
    server = Notifications(bus, '/org/freedesktop/Notifications')
    with tempfile.TemporaryDirectory() as directory:
        marker = Path(directory) / 'forbidden'
        child = subprocess.Popen([sys.executable, str(ROOT / 'scripts/notify-mail.py'), '--calendar',
            '#657b83', '#268bd2', '--', '<img> & Planning', f'$(touch {marker}) — 你好'],
            env=dict(os.environ, XDG_CACHE_HOME=str(Path(directory) / 'cache')),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def finish():
            if child.poll() is not None:
                loop.quit()
                return False
            return True

        GLib.timeout_add(20, finish)
        GLib.timeout_add_seconds(10, lambda: (child.kill(), loop.quit(), False)[2])
        loop.run()
        stdout, stderr = child.communicate(timeout=2)
        observed.update(exit=child.returncode, action=stdout.strip(), marker=marker.exists(), stderr=stderr)
        print(json.dumps(observed))
    # Keep the bus objects alive until the client has completed.
    del server, name


class CalendarNotifications(unittest.TestCase):
    @unittest.skipUnless(shutil.which('dbus-run-session') and shutil.which('notify-send')
                         and importlib.util.find_spec('dbus') and importlib.util.find_spec('gi'),
                         'requires notify-send, private D-Bus and Python GLib bindings')
    def test_real_notify_send_routes_snooze_and_escapes_sender_markup(self):
        result = subprocess.run(['dbus-run-session', '--', sys.executable, __file__, '--peer'],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed['exit'], 0, observed['stderr'])
        self.assertEqual(observed['action'], 'snooze')
        self.assertEqual(observed['summary'], '&lt;img&gt; &amp; Planning')
        self.assertEqual(observed['actions'], ['default', 'Open event...', 'snooze', 'Snooze', 'dismiss', 'Dismiss'])
        self.assertFalse(observed['marker'], 'sender text was executed')


if __name__ == '__main__':
    if '--peer' in sys.argv:
        peer()
    else:
        unittest.main()
