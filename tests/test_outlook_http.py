"""Exercise OutlookAuth's native QML HTTP deadline and cancellation.

Only the test engine's Microsoft endpoint is replaced with a loopback fixture;
postForm, its 30-second Timer, and XMLHttpRequest are the production code.
Process mocks prevent keyring or mail-server access. This does not claim a live
Microsoft sign-in: the fixed trusted Microsoft endpoint, native Qt redirect
handling, and absence of a response-size limit remain the production boundary.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
received = threading.Event()
release = threading.Event()
requests = []
# Two exchanges in flight at once, one held open while the other answers, in
# either order: the held one is the mail refresh under /pair and the Graph
# exchange under /pair2.
pair_seen = {"/pair": threading.Event(), "/pair2": threading.Event()}
pair_release = {"/pair": threading.Event(), "/pair2": threading.Event()}

GRAPH_TOKEN = json.dumps({
    "access_token": "graph-access", "refresh_token": "graph-refresh",
    "expires_in": 3600, "scope": "https://graph.microsoft.com/Mail.Send",
}).encode()
MAIL_TOKEN = json.dumps({
    "access_token": "mail-access", "refresh_token": "mail-refresh",
    "expires_in": 3600,
    "scope": "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
}).encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def answer(self, body):
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Aborting the native request is precisely what is tested.

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        requests.append((self.path, body))
        if self.path == "/hang":
            release.wait(40)
            return
        if self.path == "/delayed":
            received.set()
            release.wait(5)
            self.answer(b'{"access_token":"stale-access","refresh_token":"stale-refresh"}')
            return
        if self.path in pair_seen:
            forGraph = b"graph.microsoft.com" in body
            held = forGraph if self.path == "/pair2" else not forGraph
            if held:
                pair_seen[self.path].set()
                pair_release[self.path].wait(10)
            self.answer(GRAPH_TOKEN if forGraph else MAIL_TOKEN)
            return
        self.send_error(404)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/received":
            self.answer(b"true" if received.wait(5) else b"false")
        elif path == "/release":
            release.set()
            self.answer(b"true")
        elif path == "/pair-seen":
            self.answer(b"true" if pair_seen[query].wait(5) else b"false")
        elif path == "/pair-release":
            pair_release[query].set()
            self.answer(b"true")
        else:
            self.send_error(404)


QML = r'''
import QtQuick
import QtTest
import @PROVIDERS@ as Providers
import @MICROSOFT@ as Microsoft

Item {
  Component {
    id: factory
    Providers.OutlookAuth {
      pluginDir: "/unused-outlook-http-fixture"
      accountId: "outlook:synthetic@example.com"
      configuredEmail: "synthetic@example.com"
      configuredClientId: "12345678-1234-4abc-9def-1234567890ab"
    }
  }
  TestCase {
    name: "OutlookNativeHttp"
    property string endpoint: @ENDPOINT@
    function readyAuth(path) {
      var auth = createTemporaryObject(factory, parent)
      verify(auth !== null)
      wait(1)
      auth.cancelLogin()
      Microsoft.TOKEN_URL = endpoint + path
      return auth
    }
    function control(path) {
      var done = false
      var request = new XMLHttpRequest()
      request.onreadystatechange = function() {
        if (request.readyState === XMLHttpRequest.DONE) done = true
      }
      request.open("GET", endpoint + path)
      request.send()
      tryVerify(function() { return done }, 6000)
      compare(request.status, 200)
      compare(request.responseText, "true")
    }
    function test_1_native_deadline_completes_waiters() {
      var auth = readyAuth("/hang")
      compare(auth.tokenTimeoutMs, 30000)
      var started = Date.now()
      auth.refreshWithToken("synthetic-refresh", auth.sessionContext())
      verify(auth.refreshBusy)
      verify(auth.tokenRequests.length === 1)
      var calls = 0
      auth.withCredentials(function(token, error) {
        compare(token, "")
        verify(error !== "")
        calls++
      })
      tryCompare(auth, "refreshBusy", false, 35000)
      verify(Date.now() - started >= 29000, "The fixture must reach the actual deadline")
      compare(calls, 1)
      compare(auth.tokenWaiters.length, 0)
      compare(auth.tokenRequests.length, 0)
      compare(auth.loggedIn, false)
      compare(auth.accessToken, "")
      compare(auth.keyringJob, null)
      wait(100)
      compare(calls, 1, "Aborting the request must complete its waiters only once")
    }
    function test_2_cancel_discards_native_response() {
      var auth = readyAuth("/delayed")
      auth.refreshWithToken("synthetic-refresh", auth.sessionContext())
      var calls = 0
      auth.withCredentials(function(token, error) {
        compare(token, "")
        verify(error !== "")
        calls++
      })
      control("/received")
      auth.cancelLogin()
      compare(calls, 1)
      compare(auth.tokenRequests.length, 0)
      compare(auth.refreshBusy, false)
      control("/release")
      wait(300)
      compare(calls, 1)
      compare(auth.tokenWaiters.length, 0)
      compare(auth.loggedIn, false)
      compare(auth.accessToken, "")
      compare(auth.keyringJob, null, "A cancelled response must never save a refresh token")
      compare(auth.keyringJobs.length, 0)
    }
    // A mail refresh and a Graph exchange are independent requests through the
    // one postForm. Neither may take the other's answer for its own, and the
    // one still out must leave the session busy until it lands.
    function test_3_a_graph_exchange_does_not_swallow_a_mail_refresh() {
      var auth = readyAuth("/pair")
      var mailCalls = 0
      auth.refreshWithToken("synthetic-refresh", auth.sessionContext())
      verify(auth.refreshBusy)
      auth.withCredentials(function(token, error) { mailCalls++ })
      control("/pair-seen?/pair")
      var graphCalls = 0
      var graphToken = ""
      auth.graphWaiters = [function(token, error) { graphCalls++; graphToken = token }]
      auth.handleGraphLookup("synthetic-graph-refresh", auth.sessionContext())
      tryVerify(function() { return graphCalls === 1 }, 8000, "the Graph exchange is answered while the refresh is out")
      compare(graphToken, "graph-access")
      compare(auth.refreshBusy, true, "the mail refresh is still its own request")
      compare(mailCalls, 0)
      compare(auth.tokenRequests.length, 1, "the refresh alone is still open")
      control("/pair-release?/pair")
      tryCompare(auth, "refreshBusy", false, 8000)
      compare(mailCalls, 1, "and keeps its own answer")
      compare(auth.accessToken, "mail-access")
      compare(auth.tokenRequests.length, 0)
    }
    function test_4_a_mail_refresh_does_not_swallow_a_graph_exchange() {
      var auth = readyAuth("/pair2")
      var graphCalls = 0
      var graphToken = ""
      auth.graphWaiters = [function(token, error) { graphCalls++; graphToken = token }]
      auth.handleGraphLookup("synthetic-graph-refresh", auth.sessionContext())
      control("/pair-seen?/pair2")
      var mailCalls = 0
      auth.refreshWithToken("synthetic-refresh", auth.sessionContext())
      auth.withCredentials(function(token, error) { mailCalls++ })
      tryCompare(auth, "refreshBusy", false, 8000)
      compare(mailCalls, 1, "the refresh that came second is answered")
      compare(auth.accessToken, "mail-access")
      compare(graphCalls, 0, "and does not finish the Graph exchange for it")
      compare(auth.tokenRequests.length, 1, "the Graph exchange is still open")
      control("/pair-release?/pair2")
      tryVerify(function() { return graphCalls === 1 }, 8000)
      compare(graphToken, "graph-access")
      compare(auth.tokenRequests.length, 0)
    }
  }
}
'''


def main():
    runner = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/qt6/bin/qmltestrunner"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="omamail-outlook-http-") as directory:
            source = QML.replace("@PROVIDERS@", json.dumps((ROOT / "providers").as_uri()))
            source = source.replace("@MICROSOFT@", json.dumps((ROOT / "providers/MicrosoftOAuth.js").as_uri()))
            source = source.replace("@ENDPOINT@", json.dumps(f"http://127.0.0.1:{server.server_port}"))
            fixture = Path(directory) / "tst_outlook_http.qml"
            fixture.write_text(source)
            env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                       QT_QPA_PLATFORMTHEME="", NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
            subprocess.run([runner, "-import", str(ROOT / "tests/qml/imports"),
                            "-input", str(fixture)], env=env, check=True, timeout=90)
        paths = [path for path, _ in requests]
        assert paths[:2] == ["/hang", "/delayed"], requests
        # Each overlapping pair is one mail refresh and one Graph exchange.
        assert sorted(paths[2:]) == ["/pair", "/pair", "/pair2", "/pair2"], requests
        for path, body in requests:
            expected = b"refresh_token=synthetic-graph-refresh" if b"graph.microsoft.com" in body \
                else b"refresh_token=synthetic-refresh"
            assert expected in body, (path, body)
        print("Outlook native HTTP: deadline, cancellation and overlapping exchanges "
              "passed with synthetic credentials")
    finally:
        release.set()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
