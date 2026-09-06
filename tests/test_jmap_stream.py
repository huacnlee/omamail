"""Bound and normalize SSE before any bytes reach the desktop's SplitParser."""
import base64
import os
from pathlib import Path
import select
import signal
import time
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StreamBoundary(unittest.TestCase):
    def run_stream(self, wire, split_at=0):
        work = tempfile.TemporaryDirectory(prefix="omamail-stream-test-")
        self.addCleanup(work.cleanup)
        directory = Path(work.name)
        (directory / "wire").write_bytes(wire)
        curl = directory / "curl"
        curl.write_text("#!/usr/bin/env python3\nimport os,sys,time\n"
                        "sys.stdin.buffer.read()\n"
                        "open(os.environ['STREAM_PID'],'w').write(str(os.getpid()))\n"
                        "wire=open(os.environ['STREAM_WIRE'],'rb').read()\n"
                        "split=int(os.environ['STREAM_SPLIT'])\n"
                        "if split:\n"
                        " sys.stdout.buffer.write(wire[:split]);sys.stdout.buffer.flush();time.sleep(.05)\n"
                        "sys.stdout.buffer.write(wire[split:]);sys.stdout.buffer.flush()\n"
                        "time.sleep(2)\n"
                        "sys.stdout.write('http 200\\n')\n")
        curl.chmod(0o700)
        fields = [b"https://example.org/events", b"basic", b"synthetic-user", b"synthetic-secret"]
        request = "stream " + " ".join(base64.b64encode(v).decode() for v in fields) + "\n"
        env = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ['PATH'],
                   STREAM_WIRE=str(directory / "wire"), STREAM_PID=str(directory / "pid"),
                   STREAM_SPLIT=str(split_at))
        process = subprocess.Popen(["sh", str(ROOT / "scripts/jmap-transport.sh")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=env)
        def cleanup():
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=4)
        self.addCleanup(cleanup)
        process.pid_file = directory / "pid"
        process.stdin.write(request.encode())
        process.stdin.close()
        process.stdin = None
        return process

    def test_crlf_and_cr_events_arrive_before_connection_closes(self):
        for ending in (b"\r\n", b"\r", b"\n"):
            with self.subTest(ending=ending):
                process = self.run_stream(ending.join([b"event: ping", b'data: {"interval":30}', b"", b""]))
                self.assertTrue(select.select([process.stdout], [], [], 1)[0], "event buffered until EOF")
                event = os.read(process.stdout.fileno(), 4096)
                self.assertEqual(event, b'event: ping\ndata: {"interval":30}\n\n')
                rest, error = process.communicate(timeout=4)
                self.assertEqual(process.returncode, 0, error)
                self.assertEqual(rest, b"http 200\n")

    def test_oversized_unfinished_event_never_reaches_desktop(self):
        process = self.run_stream(b"data: " + b"x" * (128 * 1024))
        output, error = process.communicate(timeout=4)
        self.assertEqual(output, b"", "oversized event escaped the transport boundary")
        self.assertEqual(process.returncode, 63, error)
        self.assertNotIn(b"synthetic-secret", output + error)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(process.pid_file.read_text()), 0)

    def test_crlf_split_between_reads_stays_one_delimiter(self):
        wire = b'event: ping\r\ndata: {"interval":30}\r\n\r\n'
        process = self.run_stream(wire, wire.index(b"\r") + 1)
        output, error = process.communicate(timeout=4)
        self.assertEqual(process.returncode, 0, error)
        self.assertEqual(output, b'event: ping\ndata: {"interval":30}\n\nhttp 200\n')

    def test_exact_limit_and_next_event_are_preserved(self):
        wire = b"data: " + b"x" * (65536 - 8) + b"\n\n: next\n\n"
        process = self.run_stream(wire)
        output, error = process.communicate(timeout=4)
        self.assertEqual(process.returncode, 0, error)
        self.assertEqual(output, wire + b"http 200\n")

    def test_empty_events_never_reach_splitparser(self):
        process = self.run_stream(b"\r\n\n\r" * 40000)
        output, error = process.communicate(timeout=4)
        self.assertEqual(process.returncode, 0, error)
        self.assertEqual(output, b"http 200\n")

    def test_cancellation_reaps_curl(self):
        process = self.run_stream(b": connected\n\n")
        self.assertTrue(select.select([process.stdout], [], [], 1)[0])
        os.read(process.stdout.fileno(), 4096)
        process.send_signal(signal.SIGTERM)
        output, error = process.communicate(timeout=4)
        self.assertEqual(process.returncode, 143, error)
        # The shell forwards TERM before exiting; the helper reaps curl.
        pid = int(process.pid_file.read_text())
        for _ in range(100):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.01)
        else:
            self.fail("curl survived stream cancellation")
        self.assertNotIn(b"synthetic-secret", output + error)

    def test_many_short_lines_cannot_bypass_event_limit(self):
        process = self.run_stream(b": keepalive\n" * 12000)
        output, error = process.communicate(timeout=4)
        self.assertEqual(output, b"")
        self.assertEqual(process.returncode, 63, error)
        self.assertNotIn(b"synthetic-secret", output + error)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(process.pid_file.read_text()), 0)


if __name__ == "__main__":
    unittest.main()
