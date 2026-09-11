// Real IMAP cache and label migration, with only the transport process stubbed.
import QtQuick
import QtTest
import "../../message/Message.js" as Message
import "../../providers" as Providers
import "../../account" as Account

Item {
  QtObject {
    id: auth
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
      function finish(process, text) {
        process.finished(0, Message.encodeBase64(text || "A1 OK done\r\n"), "");
      }
      function listing() {
        for (var i = 0; i < client.children.length; i++) {
          var p = client.children[i];
          if (p.running && p.requestLine && p.requestLine.indexOf(Message.encodeBase64('LIST "" "*"')) >= 0)
            return p;
        }
        return null;
      }
      var first = client.renameLabel("Work", "Jobs", function (x, e) {
        compare(e, "");
        actions.afterLabelMoved(before[0], "Jobs", before);
        second = client.renameLabel("Receipts", "Bills", function (y, f) {
          compare(f, "");
          actions.afterLabelMoved(before[1], "Bills", before);
        });
      });
      finish(first.process);
      var stale = listing();
      verify(stale !== null);
      finish(second.process);
      finish(stale, '* LIST () "/" "Jobs"\r\n* LIST () "/" "Receipts"\r\nA1 OK done\r\n');
      wait(0);
      var fresh = listing();
      verify(fresh !== null, "A mutation during LIST requires a fresh server read");
      finish(fresh, '* LIST () "/" "Jobs"\r\n* LIST () "/" "Bills"\r\nA1 OK done\r\n');
      tryCompare(actions, "reloading", false, 1000);
      compare(JSON.stringify(mailbox.monitoredIds), JSON.stringify(["Jobs", "Bills"]));
    }
  }
}
