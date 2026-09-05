"""Public HTTP policy, real local HTTP/TLS, and the two worker entry points."""
import base64
import http.server
import io
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import public_http as transport

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6sAAAAASUVORK5CYII=")


def answer(ip, port=443):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    address = (ip, port, 0, 0) if family == socket.AF_INET6 else (ip, port)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", address)


class Policy(unittest.TestCase):
    def test_public_addresses_and_url_semantics(self):
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]:
            self.assertTrue(transport.public_address(address))
        self.assertEqual(transport.parse_url("https://example.com:8443/中文/%2f?token=a%2Bb&x=1#ignored"),
                         ("https", "example.com", 8443, "/%E4%B8%AD%E6%96%87/%2f?token=a%2Bb&x=1"))
        with self.assertRaises(transport.Refused):
            transport.parse_url("http://example.com/", https_only=True)

    def test_control_and_private_urls_never_resolve(self):
        urls = ["http://127.0.0.1/", "https://[::1]/", "file:///etc/passwd",
                "https://user:pass@example.com/", "https://example.com:0/", "https://example.com:65536/",
                "https://example.com\\@127.0.0.1/", "https://printer/", "https://%31%32%37.0.0.1/"]
        urls += ["https://example.com/" + control + "next" for control in "\x00\t\r\n\x7f "]
        with patch.object(socket, "getaddrinfo") as resolver:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    with transport.response_for(url, "GET"):
                        self.fail("Request allowed")
            resolver.assert_not_called()

    def test_all_dns_answers_must_be_public(self):
        private = ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1",
                   "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "fe80::1",
                   "fc00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::",
                   "192.0.0.8", "192.88.99.1", "64:ff9b:1::1", "2001:1::1"]
        with patch.object(socket, "socket") as constructor:
            for ip in private:
                with self.subTest(ip=ip), patch.object(socket, "getaddrinfo", return_value=[answer("8.8.8.8"), answer(ip)]):
                    with self.assertRaises(transport.Refused):
                        transport.PublicConnection("http", "example.com", 80).connect()
            constructor.assert_not_called()

    def test_site_local_dns_answers_never_create_a_socket(self):
        # Python can label the deprecated site-local range as global. Test
        # both ends, alone and mixed with a public answer in either order.
        for ip in ["fec0::", "fec0::1234", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]:
            for answers in [[answer(ip)], [answer("8.8.8.8"), answer(ip)],
                            [answer(ip), answer("8.8.8.8")]]:
                for scheme in ["http", "https"]:
                    with self.subTest(ip=ip, answers=answers, scheme=scheme), \
                            patch.object(socket, "getaddrinfo", return_value=answers), \
                            patch.object(ssl, "create_default_context"), \
                            patch.object(socket, "socket") as constructor:
                        with self.assertRaises(transport.Refused):
                            transport.PublicConnection(scheme, "example.com", 443).connect()
                        constructor.assert_not_called()

    def test_one_lookup_numeric_connect_and_original_tls_name(self):
        with patch.object(socket, "getaddrinfo", return_value=[answer("8.8.8.8")]) as resolver, \
                patch.object(socket, "socket") as constructor, patch.object(ssl, "create_default_context") as context:
            connection = transport.PublicConnection("https", "example.com", 443)
            connection.connect()
            resolver.assert_called_once_with("example.com", 443, type=socket.SOCK_STREAM)
            constructor.return_value.connect.assert_called_once_with(("8.8.8.8", 443))
            context.return_value.wrap_socket.assert_called_once_with(constructor.return_value, server_hostname="example.com")
            connection.close()

    def test_input_is_bounded_canonical_and_keeps_controls_for_rejection(self):
        for line in [b"%%%\n", b"YQ\n", b"YR==\n", b"YQ== extra\n", b"x" * (transport.MAX_INPUT + 1)]:
            with self.subTest(line=line[:20]), self.assertRaises(ValueError):
                transport.read_fields(io.BytesIO(line), 1)
        encoded = base64.b64encode(b"https://example.com/\n") + b"\n"
        value, = transport.read_fields(io.BytesIO(encoded), 1)
        with self.assertRaises(transport.Refused):
            transport.parse_url(value)

    def test_deadline_includes_dns(self):
        # Run a stuck C call in the resolver seam, not merely a Python exception
        # from a mock. Only the child gets the production termination deadline.
        code = """import ctypes, socket
import public_http as transport
socket.getaddrinfo = lambda *a, **k: ctypes.CDLL(None).sleep(30)
with transport.deadline(0.05):
    transport.resolve_public('example.com', 443)
"""
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT / "scripts", timeout=2)
        self.assertEqual(result.returncode, -signal.SIGALRM)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    events = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.events.append(("POST", self.path, self.headers.get("Host"), self.headers.get("Content-Type"), body))
        self.reply()

    def do_GET(self):
        self.events.append(("GET", self.path))
        self.reply()

    def reply(self):
        if self.path == "/slow":
            time.sleep(0.3)
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        if self.path == "/oversize":
            self.send_header("Content-Length", str(transport.MAX_IMAGE + 1))
            self.end_headers()
            return
        data = b"<svg/>" if self.path == "/fake" else PNG
        if self.path == "/chunked":
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n0\r\n\r\n")
            return
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class LocalHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.handle_error = lambda *_args: None
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Handler.events.clear()
        # ONLY this test bypasses the IP gate to exercise the real HTTP client
        # against a local server. Production has no switch or env override.
        self.resolver = patch.object(transport, "resolve_public", return_value=[answer("127.0.0.1", self.server.server_port)])
        self.resolver.start()
        self.addCleanup(self.resolver.stop)

    def test_image_and_proxy_environment(self):
        with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1", "ALL_PROXY": "socks5://127.0.0.1:1"}):
            data = transport.fetch_image("http://example.com/image")
        self.assertEqual(data, "data:image/png;base64," + base64.b64encode(PNG).decode())

    def test_redirect_is_not_followed(self):
        with self.assertRaises(transport.Refused):
            transport.fetch_image("http://example.com/redirect")
        self.assertEqual(Handler.events, [("GET", "/redirect")])

    def test_sizes_and_image_signature(self):
        for path in ["/oversize", "/fake"]:
            with self.subTest(path=path), self.assertRaises(transport.Refused):
                transport.fetch_image("http://example.com" + path)
        self.assertTrue(transport.fetch_image("http://example.com/chunked").startswith("data:image/png;"))
        with patch.object(transport, "MAX_IMAGE", 8), self.assertRaises(transport.Refused):
            transport.fetch_image("http://example.com/chunked")

    def test_slow_response_deadline(self):
        code = """import socket
import public_http as transport
transport.resolve_public = lambda *a: [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('127.0.0.1', %d))]
with transport.deadline(0.05):
    transport.fetch_image('http://example.com/slow')
""" % self.server.server_port
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT / "scripts", timeout=2)
        self.assertEqual(result.returncode, -signal.SIGALRM)


class LocalTLS(unittest.TestCase):
    def test_tls_verification_post_and_redirect(self):
        with tempfile.TemporaryDirectory(prefix="omamail-tls-test-") as directory:
            cert, key = Path(directory) / "cert.pem", Path(directory) / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-keyout", str(key), "-out", str(cert), "-days", "1",
                            "-subj", "/CN=example.com", "-addext", "subjectAltName=DNS:example.com"],
                           check=True, capture_output=True)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            server.handle_error = lambda *_args: None
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.object(transport, "resolve_public", return_value=[answer("127.0.0.1", server.server_port)]):
                    Handler.events.clear()
                    with self.assertRaises(ssl.SSLCertVerificationError):
                        transport.unsubscribe("https://example.com/ok")
                    self.assertEqual(Handler.events, [])
                    # Trust just the generated test certificate, retaining name verification.
                    trusted = ssl.create_default_context(cafile=str(cert))
                    with patch.object(ssl, "create_default_context", return_value=trusted):
                        with self.assertRaises(ssl.SSLCertVerificationError):
                            transport.unsubscribe("https://wrong.example.com/ok")
                        self.assertEqual(transport.unsubscribe("https://example.com/ok"), 200)
                        self.assertEqual(transport.unsubscribe("https://example.com/redirect"), 302)
                    self.assertEqual([event[1] for event in Handler.events], ["/ok", "/redirect"])
                    self.assertEqual(Handler.events[0][2:], ("example.com:443", "application/x-www-form-urlencoded", b"List-Unsubscribe=One-Click"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


class Entrypoints(unittest.TestCase):
    def test_hostile_requests_fail_without_network_or_token_disclosure(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(0.05)
            urls = [f"https://127.0.0.1:{listener.getsockname()[1]}/secret-token",
                    "https://example.com/secret-token\nurl = https://127.0.0.1/\n#"]
            for script in ["unsubscribe.py", "image-fetch.py"]:
                for url in urls:
                    fields = [url]
                    if script == "unsubscribe.py":
                        fields += ["application/x-www-form-urlencoded", "List-Unsubscribe=One-Click"]
                    result = subprocess.run([sys.executable, str(ROOT / "scripts" / script)],
                                            input=" ".join(base64.b64encode(f.encode()).decode() for f in fields) + "\n",
                                            capture_output=True, text=True, timeout=3)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn("secret-token", result.stdout + result.stderr)
            with self.assertRaises(socket.timeout):
                listener.accept()


if __name__ == "__main__":
    unittest.main()
