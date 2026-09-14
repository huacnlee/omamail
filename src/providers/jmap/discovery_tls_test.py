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
    (root / "server.ext").write_text(
        "subjectAltName=DNS:localhost\n"
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n",
        encoding="ascii",
    )
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(root / "ca-key.pem"), "-out", str(root / "ca.pem"),
                    "-days", "1", "-subj", "/CN=Omamail test CA",
                    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                    "-addext", "keyUsage=critical,keyCertSign,cRLSign"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    subprocess.run(["openssl", "req", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(root / "key.pem"), "-out", str(root / "server.csr"),
                    "-subj", "/CN=localhost"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    subprocess.run(["openssl", "x509", "-req", "-in", str(root / "server.csr"),
                    "-CA", str(root / "ca.pem"), "-CAkey", str(root / "ca-key.pem"),
                    "-CAcreateserial", "-out", str(root / "cert.pem"), "-days", "1",
                    "-sha256", "-extfile", str(root / "server.ext")], check=True,
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
    print(root / "ca.pem", flush=True)
    server.serve_forever(poll_interval=0.05)
    server.server_close()
