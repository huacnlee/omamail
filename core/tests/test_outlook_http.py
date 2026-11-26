"""Exercise production OutlookAuth's backend adapter with synthetic RPC replies.

Native HTTP redirect, deadline and response bounds are exercised by Rust auth
socket tests. These QML tests cover cancellation and correlation across concurrent
mail and Graph requests, without endpoint overrides or real keyring access.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]

QML = r'''

import QtQuick
import QtTest
import @PROVIDERS@ as Providers
import @MICROSOFT@ as Microsoft

Item {
  Component {
    id: factory
    Providers.OutlookAuth {
      backend: bridge
      pluginDir: "/unused-outlook-http-fixture"
      accountId: "outlook:synthetic@example.com"
      configuredEmail: "synthetic@example.com"
      configuredClientId: "12345678-1234-4abc-9def-1234567890ab"
    }
  }
  TestCase {
    id: testCase
    name: "OutlookNativeHttp"
    QtObject {
      id: bridge
      property bool ready: true
      property var requests: []
      function call(method, params, callback) {
        if (method === "auth.invalidate") { callback({invalidated:true}, ""); return }
        testCase.compare(method, "auth.token")
        testCase.compare(params.provider, "outlook")
        testCase.verify(params.resource === "mail" || params.resource === "graph")
        requests = requests.concat([{ params: params, callback: callback }])
      }
      function finish(index, graph, error) {
        requests[index].callback(error ? null : {
          access_token: graph ? "graph-access" : "mail-access",
          expires_in: 60,
          scope: graph ? "https://graph.microsoft.com/Mail.Send" : "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"
        }, error || "")
      }
    }
    function readyAuth(path) {
      var auth = createTemporaryObject(factory, parent)
      verify(auth !== null)
      wait(1)
      auth.cancelLogin()
      bridge.requests = []
      return auth
    }
    function test_1_backend_timeout_completes_waiters() {
      var auth = readyAuth("/hang")
      auth.refreshWithToken("synthetic-refresh", auth.sessionContext())
      verify(auth.refreshBusy)
      verify(auth.tokenRequests.length === 1)
      var calls = 0
      auth.withCredentials(function(token, error) {
        compare(token, "")
        verify(error !== "")
        calls++
      })
      bridge.finish(0, false, "auth_timeout")
      compare(auth.refreshBusy, false)
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
      compare(bridge.requests.length, 1)
      auth.cancelLogin()
      compare(calls, 1)
      compare(auth.tokenRequests.length, 0)
      compare(auth.refreshBusy, false)
      bridge.finish(0, false, "")
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
      compare(bridge.requests.length, 1)
      var graphCalls = 0
      var graphToken = ""
      auth.graphWaiters = [function(token, error) { graphCalls++; graphToken = token }]
      auth.handleGraphLookup("synthetic-graph-refresh", auth.sessionContext())
      bridge.finish(1, true, "")
      tryVerify(function() { return graphCalls === 1 }, 8000, "the Graph exchange is answered while the refresh is out")
      compare(graphToken, "graph-access")
      compare(auth.refreshBusy, true, "the mail refresh is still its own request")
      compare(mailCalls, 0)
      compare(auth.tokenRequests.length, 1, "the refresh alone is still open")
      bridge.finish(0, false, "")
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
      compare(bridge.requests.length, 1)
      var mailCalls = 0
      auth.refreshWithToken("synthetic-refresh", auth.sessionContext())
      auth.withCredentials(function(token, error) { mailCalls++ })
      bridge.finish(1, false, "")
      tryCompare(auth, "refreshBusy", false, 8000)
      compare(mailCalls, 1, "the refresh that came second is answered")
      compare(auth.accessToken, "mail-access")
      compare(graphCalls, 0, "and does not finish the Graph exchange for it")
      compare(auth.tokenRequests.length, 1, "the Graph exchange is still open")
      bridge.finish(0, true, "")
      tryVerify(function() { return graphCalls === 1 }, 8000)
      compare(graphToken, "graph-access")
      compare(auth.tokenRequests.length, 0)
    }
  }
}
'''


def main():
    runner = sys.argv[1] if len(sys.argv) > 1 else "/usr/lib/qt6/bin/qmltestrunner"
    with tempfile.TemporaryDirectory(prefix="omamail-outlook-rpc-") as directory:
        source = QML.replace("@PROVIDERS@", json.dumps((ROOT / "ui/providers").as_uri()))
        source = source.replace("@MICROSOFT@", json.dumps((ROOT / "ui/providers/MicrosoftOAuth.js").as_uri()))
        fixture = Path(directory) / "tst_outlook_rpc.qml"
        fixture.write_text(source)
        env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software", QT_QPA_PLATFORMTHEME="")
        subprocess.run([runner, "-import", str(ROOT / "ui/tests/qml/imports"), "-input", str(fixture)],
                       env=env, check=True, timeout=30)
    print("Outlook backend adapter: timeout, cancellation and overlapping exchanges passed")


if __name__ == "__main__":
    main()
