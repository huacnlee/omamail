#!/usr/bin/env python3
"""Give notify-send a local icon painted with the current bar theme."""
import os
from pathlib import Path
import re
import sys
import tempfile
import xml.etree.ElementTree as ET


def paint(element, color):
    # QColor stringifies translucent colors as #AARRGGBB; SVG uses #RRGGBB.
    element.set('stroke', '#' + color[-6:])
    if len(color) == 9:
        element.set('stroke-opacity', str(int(color[1:3], 16) / 255))


def main(args):
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
    os.execvp('notify-send', ['notify-send', '-a', 'Omamail', '-i', str(path),
                            '--action=default=Read...', '--', title, body])


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
