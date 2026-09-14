#!/usr/bin/env python3
"""Exercise the icon writer and its exact notify-send argv, without a desktop."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


class NotificationTest(unittest.TestCase):
    def test_theme_and_sender_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            notify = tmp / 'notify-send'
            notify.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                              'open(os.environ["CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\n'
                              'print("default")\n')
            notify.chmod(0o700)
            env = dict(os.environ, PATH=str(tmp) + ':' + os.environ['PATH'],
                       XDG_CACHE_HOME=str(tmp / 'cache'), CAPTURE=str(tmp / 'argv'))
            for foreground, accent in [('#eeeeee', '#abcdef'), ('#222222', '#fedcba'),
                                       ('#80eeeeee', '#40abcdef')]:
                result = subprocess.run(['python3', str(ROOT / 'scripts/notify-mail.py'),
                    foreground, accent, '--', '-u critical $(touch forbidden)',
                    'Quotes " \\ 你好\nbody'], env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, 'default\n')
                args = json.loads((tmp / 'argv').read_text())
                self.assertEqual(args[-3:], ['--', '-u critical $(touch forbidden)',
                                            'Quotes " \\ 你好\nbody'])
                self.assertIn('--action=default=Read...', args)
                svg = ET.parse(args[args.index('-i') + 1]).getroot()
                self.assertEqual(svg[0].get('stroke'), '#' + foreground[-6:])
                if len(foreground) == 9:
                    self.assertAlmostEqual(float(svg[0].get('stroke-opacity')), 128 / 255)
                self.assertEqual(svg[1].get('stroke'), '#' + accent[-6:])
                if len(accent) == 9:
                    self.assertAlmostEqual(float(svg[1].get('stroke-opacity')), 64 / 255)
            before = sorted((tmp / 'cache').rglob('*'))
            (tmp / 'argv').unlink()
            for bad in ['red"/><image href="https://example.org"', '#ffffff\n', '#ffffff\r', '#fff']:
                result = subprocess.run(['python3', str(ROOT / 'scripts/notify-mail.py'),
                    bad, '#abcdef', '--', 'title', 'body'], env=env, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((tmp / 'argv').exists(), 'invalid color started notify-send')
                self.assertEqual(sorted((tmp / 'cache').rglob('*')), before)
            self.assertFalse((ROOT / 'forbidden').exists())

    def test_sender_markup_is_escaped_only_at_notify_send(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            notify = tmp / 'notify-send'
            notify.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                              'open(os.environ["CAPTURE"],"w").write(json.dumps(sys.argv[1:]))\n')
            notify.chmod(0o700)
            env = dict(os.environ, PATH=str(tmp) + ':' + os.environ['PATH'],
                       XDG_CACHE_HOME=str(tmp / 'cache'), CAPTURE=str(tmp / 'argv'))
            result = subprocess.run(['python3', str(ROOT / 'scripts/notify-mail.py'),
                '#eeeeee', '#abcdef', '--', '<img> & sender', 'body <b>&'], env=env)
            self.assertEqual(result.returncode, 0)
            args = json.loads((tmp / 'argv').read_text())
            self.assertEqual(args[-2:], ['&lt;img&gt; &amp; sender', 'body &lt;b&gt;&amp;'])


if __name__ == '__main__':
    unittest.main()
