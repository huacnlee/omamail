#!/usr/bin/env python3
"""Give notify-send a local icon painted with the current bar theme."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from html import escape


def paint(element, color):
    # QColor stringifies translucent colors as #AARRGGBB; SVG uses #RRGGBB.
    element.set('stroke', '#' + color[-6:])
    if len(color) == 9:
        element.set('stroke-opacity', str(int(color[1:3], 16) / 255))


def summon_payload(text):
    # Only the two ids, as strings: the payload is rebuilt, never passed on.
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    account, message = value.get('accountId'), value.get('messageId')
    if (not isinstance(account, str) or not isinstance(message, str)
            or not account or not message or '\0' in account + message
            or len(account) > 512 or len(message) > 2048):
        return None
    return json.dumps({'accountId': account, 'messageId': message})


def main(args):
    calendar = bool(args and args[0] == '--calendar')
    if calendar:
        args = args[1:]
    # The message a click opens, as a summon payload. It rides on the
    # notification itself (omarchy-exec-argv), so a click still opens it after
    # the toast has timed out into the notification centre, when this
    # process's own "default" waiter is long gone.
    # A target that does not validate drops only the click target: the new
    # mail is still announced.
    summon = None
    if len(args) >= 2 and args[0] == '--summon':
        summon = summon_payload(args[1])
        args = args[2:]
    if (len(args) != 5 or args[2] != '--'
            or any(not re.fullmatch(r'#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?', c)
                   for c in args[:2])):
        return 2
    foreground, accent, _, title, body = args
    cache = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache')
    directory = cache / 'omamail' / 'notification-icons'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    # A new path per palette also prevents image caches retaining the old theme.
    path = directory / (foreground[1:] + '-' + accent[1:] + '.svg')
    svg = ET.parse(Path(__file__).resolve().parents[1] / 'ui/assets/omamail.svg')
    paint(svg.getroot()[0], foreground)
    paint(svg.getroot()[1], accent)
    # Atomic publication: concurrent accounts must never see a partial image.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as output:
            temporary = output.name
            svg.write(output, encoding='utf-8', xml_declaration=True)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    # Preserve notify-send's stdout action and lifetime for the QML waiter.
    # notify-send treats these arguments as markup. Escape sender-authored text
    # at the last boundary so native notification APIs still receive plain text.
    title = escape(title, quote=False)
    body = escape(body, quote=False)
    actions = (['--action=default=Open event...', '--action=snooze=Snooze', '--action=dismiss=Dismiss']
               if calendar else ['--action=default=Read...'])
    hints = []
    if summon is not None:
        argv = ['omarchy-shell', 'shell', 'summon', 'omamail', summon]
        hints = ['-h', 'string:omarchy-exec-argv:' + json.dumps(argv)]
    os.execvp('notify-send', ['notify-send', '-a', 'Omamail', '-i', str(path)]
              + hints + actions + ['--', title, body])


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
