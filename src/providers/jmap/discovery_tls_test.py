"""Controlled HTTPS discovery peer; records authorization presence, never values."""
import http.server
import json
import pathlib
import ssl
import subprocess
import tempfile
import threading

with tempfile.TemporaryDirectory(prefix="omamail-jmap-tls-") as directory:
    root = pathlib.Path(directory)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"),
                    "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost",
                    "-addext", "basicConstraints=critical,CA:FALSE"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_GET(self):
            if self.path == "/report":
                payload = json.dumps(requests).encode()
                self.send_response(200)
            else:
                requests.append({"path": self.path, "authorization": self.headers.get("Authorization") is not None})
                payload = b"<html>marketing page</html>" if self.path == "/html" else b""
                self.send_response(200 if self.path == "/html" else 401)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            if self.path == "/report":
                threading.Thread(target=self.server.shutdown, daemon=True).start()
    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 10
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(root / "cert.pem", root / "key.pem")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(server.server_port, flush=True)
    print(root / "cert.pem", flush=True)
    server.serve_forever(poll_interval=0.05)
    server.server_close()
