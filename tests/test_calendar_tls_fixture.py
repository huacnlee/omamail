#!/usr/bin/env python3
"""The synthetic calendar TLS peer must not depend on a host OpenSSL CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PEER = ROOT / "src/calendar/discovery_tls_test.py"


class CalendarTlsFixtureTest(unittest.TestCase):
    def test_peer_starts_without_host_certificate_generation(self):
        with tempfile.TemporaryDirectory(prefix="omamail-calendar-peer-test-") as directory:
            for unavailable in ("PATH", "OPENSSL_CONF"):
                with self.subTest(unavailable=unavailable):
                    environment = os.environ.copy()
                    environment[unavailable] = str(Path(directory) / "nonexistent")
                    result = subprocess.run(
                        [sys.executable, str(PEER)], input='{"stop":true}\n',
                        text=True, capture_output=True, timeout=15,
                        cwd=directory, env=environment,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    info = json.loads(result.stdout)
                    self.assertGreater(info["port"], 0)
                    self.assertTrue(Path(info["certificate"]).is_file())


if __name__ == "__main__":
    unittest.main()
