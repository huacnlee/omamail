"""Controlled HTTPS discovery peer; records authorization presence, never values."""
import http.server
import socketserver
import json
import pathlib
import ssl
import threading

root = pathlib.Path(__file__).parent.parent / "testdata" / "tls"
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


# HTTPServer.server_bind resolves the bound address to a name: a reverse lookup
# that a CI host's resolver leaves to time out, ten seconds a start. The peer
# has no use for a name.
class LoopbackServer(http.server.HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.socket.getsockname()[:2]

server = LoopbackServer(("127.0.0.1", 0), Handler)
server.timeout = 10
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root / "server.pem", root / "server-key.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
print(server.server_port, flush=True)
print(root / "ca.pem", flush=True)
server.serve_forever(poll_interval=0.05)
server.server_close()
