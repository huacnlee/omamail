// Real IMAP cache and label migration, with only backend RPC stubbed.
import QtQuick
import QtTest
import "transports.js" as Transports
import "../../message/Message.js" as Message
import "../../providers" as Providers
import "../../account" as Account

Item {
  QtObject {
    id: auth
    property string accountId: "imap:synthetic@example.com"
    property string pluginDir: "/tmp/omamail-review113-cache"
    property var settings: ({
        imapHost: "imap.example.com",
        imapPort: 993,
        username: "synthetic",
        insecure: false
      })
    function withCredentials(cb) {
      cb("synthetic:secret", "");
    }
  }
  Providers.ImapClient {
    id: client
    auth: auth
    email: "synthetic@example.com"
  }
  QtObject {
    id: mailbox
    property bool ready: true
    property string providerId: "imap"
    property string rawQuery: ""
    property var labels: [
      {
        id: "Work",
        name: "Work",
        rawName: "Work",
        delimiter: "/"
      },
      {
        id: "Receipts",
        name: "Receipts",
        rawName: "Receipts",
        delimiter: "/"
      }
    ]
    property var monitoredIds: ["Work", "Receipts"]
    property var api: client
    property var cache: ({
        putLabels: function (x) {}
      })
    function monitoredMigrated(x) {
      monitoredIds = x;
    }
    function fail(x) {
      console.log(x);
    }
    function abortRequest(x) {
    }
  }
  Account.LabelActions {
    id: actions
    account: mailbox
  }
  TestCase {
    name: "RealImapCache"
    when: windowShown
    function test_queued_listing_is_fresh() {
      var before = mailbox.labels;
      var second;
      Transports.install(client)
      function finish(request, names) {
        if (request.method !== "imap.folders") { Transports.reply(request, {}, ""); return }
        var labels = (names || []).map(function(name) { return {id:name,name:name,rawName:name,delimiter:"/"} })
        Transports.reply(request, {folders:labels,special:{},capabilities:[],labels:labels}, "")
      }
      function listing() {
        var requests = Transports.transports(client)
        for (var i = 0; i < requests.length; i++) {
          var request = requests[i]
          if (!request.answered && request.method === "imap.folders") return request
        }
        return null
      }
      client.renameLabel("Work", "Jobs", function (x, e) {
        compare(e, "");
        actions.afterLabelMoved(before[0], "Jobs", before);
        client.renameLabel("Receipts", "Bills", function (y, f) {
          compare(f, "");
          actions.afterLabelMoved(before[1], "Bills", before);
        });
      });
      var first = Transports.transports(client)[0]
      compare(first.params.accountId, "imap:synthetic@example.com")
      compare(first.params.credential, undefined)
      finish(first)
      second = Transports.transports(client).filter(function(request) {
        return request.method === "imap.renameFolder" && !request.answered
      })[0]
      var stale = listing();
      verify(stale !== null);
      finish(second)
      finish(stale, ["Jobs", "Receipts"]);
      wait(0);
      var fresh = listing();
      verify(fresh !== null, "A mutation during LIST requires a fresh server read");
      finish(fresh, ["Jobs", "Bills"]);
      tryCompare(actions, "reloading", false, 1000);
      compare(JSON.stringify(mailbox.monitoredIds), JSON.stringify(["Jobs", "Bills"]));
    }
  }
}
