"""Exercise GmailApiClient's window on a page and its wait on a throttled read.

Only the API base is replaced with a loopback fixture; `request`, `getMessages`,
the retry timer, the backoff in `GmailApi.retryDelayMs` and XMLHttpRequest are
the production code. Gmail counts its quota per second, so a page goes out
through a window and a throttled read is waited out rather than handed to the
mailbox as a failed page — while a 403 waiting cannot fix, an aborted read, and
any write must not be sent twice.
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
lock = threading.Lock()
hits = {}

THROTTLED = json.dumps({
    "error": {"code": 403, "message": "User-rate limit exceeded.",
              "errors": [{"reason": "rateLimitExceeded", "message": "User-rate limit exceeded."}]},
}).encode()
FORBIDDEN = json.dumps({
    "error": {"code": 403, "message": "Request had insufficient authentication scopes.",
              "errors": [{"reason": "insufficientPermissions"}]},
}).encode()
EXHAUSTED = json.dumps({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
                                  "message": "Quota exceeded."}}).encode()


def count(name):
    with lock:
        hits[name] = hits.get(name, 0) + 1
        return hits[name]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def answer(self, status, body, headers=None):
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Aborting a read is one of the things under test.

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        # A write is refused the same way a read is, and must be left refused.
        count("modify")
        self.answer(429, EXHAUSTED, {"Retry-After": "1"})

    def do_GET(self):
        name = self.path.partition("?")[0].rsplit("/", 1)[-1]
        seen = count(name)
        if name.startswith("m"):
            self.answer(200, json.dumps({"id": name, "labelIds": ["INBOX"]}).encode())
        elif name == "throttled":
            # Refused once with the wait Google names, then answered: a read
            # that survives its own throttling is the point.
            if seen == 1:
                self.answer(403, THROTTLED, {"Retry-After": "1"})
            else:
                self.answer(200, json.dumps({"id": "throttled"}).encode())
        elif name in ("capped", "abandoned"):
            self.answer(429, EXHAUSTED, {"Retry-After": "1"})
        elif name == "forbidden":
            self.answer(403, FORBIDDEN)
        else:
            self.send_error(404)


QML = r'''
import QtQuick
import QtTest
import @PROVIDERS@ as Providers
import @API@ as Api

Item {
  QtObject {
    id: fakeAuth
    function withAccessToken(callback) { callback("synthetic-token", "") }
    function invalidateAccessToken() {}
  }
  Providers.GmailApiClient {
    id: client
    auth: fakeAuth
  }
  TestCase {
    name: "GmailThrottling"
    when: windowShown
    function initTestCase() { Api.API_BASE = @ENDPOINT@ }

    // Gmail's ceiling is counted per second, so the count that matters is how
    // many reads the client has issued at once — raised before the network is
    // involved, which is why the fixture can answer every one of them at once
    // and still measure the window.
    function test_1_a_page_is_read_through_a_window() {
      var ids = []
      for (var i = 0; i < 30; i++) ids.push("m" + i)
      var peak = 0
      var watch = function() { if (client.inFlight > peak) peak = client.inFlight }
      client.inFlightChanged.connect(watch)
      var finished = false
      var failure = "not called"
      client.getMessages(ids, false, function(messages, error) {
        finished = true
        failure = error
      })
      tryVerify(function() { return finished }, 20000)
      client.inFlightChanged.disconnect(watch)
      compare(failure, "")
      verify(peak > 1, "the reads still overlap rather than run one at a time: " + peak)
      verify(peak <= Api.MAX_PARALLEL_READS,
        "at most " + Api.MAX_PARALLEL_READS + " reads in flight, saw " + peak)
      tryCompare(client, "inFlight", 0, 5000)
    }

    function test_2_a_throttled_read_is_waited_out() {
      var message = null
      var failure = "not called"
      var started = Date.now()
      client.getMessage("throttled", false, function(payload, error) {
        message = payload
        failure = error
      })
      wait(400)
      compare(failure, "not called", "the mailbox is not told anything while the wait runs")
      verify(client.busy, "and the client stays busy across it")
      tryVerify(function() { return failure !== "not called" }, 20000)
      compare(failure, "", "the read succeeds on the answer after the wait")
      compare(message.id, "throttled")
      verify(Date.now() - started >= 1000, "Google's own Retry-After is honoured")
      tryCompare(client, "inFlight", 0, 5000)
    }

    function test_3_a_read_that_stays_throttled_fails_in_the_end() {
      var failure = "not called"
      client.getMessage("capped", false, function(payload, error) { failure = error })
      tryVerify(function() { return failure !== "not called" }, 30000)
      verify(failure.indexOf("rate limiting") >= 0, "the mailbox is told why: " + failure)
      tryCompare(client, "inFlight", 0, 5000)
    }

    function test_4_a_refusal_waiting_cannot_fix_is_not_waited_out() {
      var failure = "not called"
      var started = Date.now()
      client.getMessage("forbidden", false, function(payload, error) { failure = error })
      tryVerify(function() { return failure !== "not called" }, 8000)
      verify(failure !== "", "a missing scope is still a failure")
      verify(Date.now() - started < 1000,
        "and is not waited on: " + (Date.now() - started) + "ms")
      tryCompare(client, "inFlight", 0, 5000)
    }

    // A page abandoned mid-wait is how every mailbox switch and every poll
    // ends the previous one. The reply that would have given the in-flight
    // count back has already arrived and been refused, so the abort is the
    // only thing left to give it back.
    function test_5_an_abandoned_wait_gives_its_slot_back() {
      var handle = client.getMessage("abandoned", false, function(payload, error) {})
      tryCompare(client, "inFlight", 1, 5000)
      wait(500)
      verify(client.busy, "the read is waiting rather than finished")
      client.abortRequest(handle)
      compare(client.inFlight, 0, "an abandoned wait is not counted for ever")
      compare(client.busy, false)
      wait(1500)
      compare(client.inFlight, 0, "and the wait it dropped never runs")
    }

    // A throttling refusal can be answered by a front end with the write
    // already committed behind it, so a write is refused once and left refused.
    function test_6_a_throttled_write_is_not_sent_again() {
      var failure = "not called"
      var started = Date.now()
      client.modifyMessage("m1", ["STARRED"], [], function(payload, error) { failure = error })
      tryVerify(function() { return failure !== "not called" }, 8000)
      verify(failure.indexOf("rate limiting") >= 0, "the mailbox is told why: " + failure)
      verify(Date.now() - started < 1000, "and nothing waited on it")
      tryCompare(client, "inFlight", 0, 5000)
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
        with tempfile.TemporaryDirectory(prefix="omamail-gmail-http-") as directory:
            source = QML.replace("@PROVIDERS@", json.dumps((ROOT / "providers").as_uri()))
            source = source.replace("@API@", json.dumps((ROOT / "providers/GmailApi.js").as_uri()))
            source = source.replace("@ENDPOINT@", json.dumps(f"http://127.0.0.1:{server.server_port}"))
            fixture = Path(directory) / "tst_gmail_http.qml"
            fixture.write_text(source)
            env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                       QT_QPA_PLATFORMTHEME="", NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
            subprocess.run([runner, "-import", str(ROOT / "tests/qml/imports"),
                            "-input", str(fixture)], env=env, check=True, timeout=180)
        reads = sorted(name for name in hits if name.startswith("m") and name != "modify")
        assert len(reads) == 30, hits
        assert all(hits[name] == 1 for name in reads), hits
        assert hits.get("throttled") == 2, hits
        # Three waits and no fourth: MAX_RATE_LIMIT_RETRIES is a ceiling on the
        # retries, so the first send plus three of them is four reads.
        assert hits.get("capped") == 4, hits
        assert hits.get("forbidden") == 1, hits
        assert hits.get("abandoned") == 1, hits
        assert hits.get("modify") == 1, hits
        print("Gmail throttling: page windowed, Retry-After honoured, backoff bounded, "
              "abandoned wait released, permission failure and write not retried")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
