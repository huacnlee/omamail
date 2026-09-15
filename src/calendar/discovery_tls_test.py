"""Loopback-only HTTPS peer for discovery tests; all credentials are synthetic."""
import http.server
import json
import ssl
import sys
import threading
from pathlib import Path


# Like the mail-provider peers, use a fixed test chain rather than whichever
# OpenSSL certificate generator and configuration the native runner provides.
fixtures = Path(__file__).resolve().parent / "testdata" / "tls"
state = {"responses": [], "requests": [], "connections": 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        length = int(self.headers.get("Content-Length", "0"))
        state["requests"].append({
            "host": self.headers.get("Host"), "path": self.path,
            "method": self.command, "authorization": self.headers.get("Authorization"),
            "depth": self.headers.get("Depth"),
            "body": self.rfile.read(length).decode(),
        })
        response = state["responses"].pop(0) if state["responses"] else {"status": 500}
        body = response.get("body", "").encode()
        self.send_response(response.get("status", 200))
        if "location" in response:
            self.send_header("Location", response["location"])
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_PROPFIND = do_GET

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(fixtures / "server.pem", fixtures / "server-key.pem")

class Server(http.server.ThreadingHTTPServer):
    def get_request(self):
        connection, address = super().get_request()
        state["connections"] += 1
        connection.settimeout(3)
        try:
            return context.wrap_socket(connection, server_side=True), address
        except OSError:
            connection.close()
            raise

server = Server(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps({"port": server.server_port, "certificate": str(fixtures / "ca.pem")}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    if command.get("stop"):
        break
    if "responses" in command:
        state["responses"] = command["responses"]
        state["requests"] = []
        state["connections"] = 0
    print(json.dumps({"requests": state["requests"], "connections": state["connections"]}), flush=True)
server.shutdown()
server.server_close()
