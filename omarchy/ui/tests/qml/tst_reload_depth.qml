import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "NativeIntentFixture.js" as NativeIntentFixture
import "../../account" as Account

// A reload asks for the rows the view had been paged to, not for page one.
//
// `Model.reloadLimit` decides the number and has its own node test; this
// proves the number reaches the request. The account is a real `MailAccount`
// on the real `JmapClient`, and the client's backend is the recording stub in
// `transports.js`, so the `jmap.list` request the reload sends can be read
// back with the `maxResults` it asked for.
Item {
  width: 400
  height: 300

  Account.MailAccount {
    id: account

    pluginDir: "/tmp/omamail-test"
    accountId: "jmap:ada@example.org"
    configuredEmail: "ada@example.org"
    providerId: "jmap"
    jmapSettings: ({
      sessionUrl: "https://mail.example.org/jmap/session",
      username: "ada@example.org",
      authScheme: "basic",
      accountId: "t"
    })
    active: true
    windowOpen: true
  }

  TestCase {
    name: "ReloadDepth"
    function initTestCase() { account.backend = NativeIntentFixture.backend(account) }
    function settleNative() {
      wait(1)
      tryVerify(function() {return account.backend.pending.length === 0})
    }

    when: windowShown

    readonly property var session: ({
      capabilities: {
        "urn:ietf:params:jmap:core": {},
        "urn:ietf:params:jmap:mail": {}
      },
      accounts: {
        t: {
          name: "ada@example.org",
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: {
            "urn:ietf:params:jmap:mail": {
              emailQuerySortOptions: ["receivedAt"]
            }
          }
        }
      },
      primaryAccounts: {
        "urn:ietf:params:jmap:core": "t",
        "urn:ietf:params:jmap:mail": "t"
      },
      apiUrl: "https://api.example.org/jmap/",
      state: "s0"
    })

    readonly property var mailboxes: [
      { id: "a", name: "Inbox", role: "inbox", parentId: null,
        totalEmails: 120, unreadEmails: 3 },
      { id: "b", name: "Archive", role: "archive", parentId: null,
        totalEmails: 0, unreadEmails: 0 }
    ]

    function rows(count) {
      var out = []
      for (var i = 0; i < count; i++)
        out.push({ id: "m" + i, subject: "Message " + i, unread: false, labelIds: ["INBOX"] })
      return out
    }

    // The list requests the account sent since `before`, with the count each
    // asked for. The unread count asks `jmap.list` too, for three rows, and
    // is not a reload.
    function listAsks(before) {
      var out = []
      var sent = Transports.newSince(account.api, before)
      for (var i = 0; i < sent.length; i++)
        if (sent[i].method === "jmap.list" && sent[i].params.maxResults !== 3)
          out.push(sent[i].params.maxResults)
      return out
    }

    function test_reload_asks_for_the_depth_reached_and_navigation_for_a_page() {
      Transports.install(account.api)
      account.api.session = session
      account.api.mailboxList = mailboxes
      account.api.mailboxesLoaded = true
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return account.ready }, 2000,
        "a configured mailbox with a secret in memory is ready")
      settleNative()

      // Two pages of fifty on screen, the way scrolling to the foot leaves them.
      account.messages = rows(100)
      account.loadedDepth = 100
      account.listLoaded = true
      account.listLoading = false

      var before = Transports.transports(account.api)
      account.loadMessages(false)
      settleNative()
      compare(listAsks(before), [100], "a reload asks for the hundred rows the view reached")

      // Rows trashed since do not round the depth down to a page.
      account.listLoading = false
      account.loadedDepth = 63
      before = Transports.transports(account.api)
      account.loadMessages(false)
      settleNative()
      compare(listAsks(before), [63])

      // Another mailbox is a new view and starts with one page.
      account.listLoading = false
      before = Transports.transports(account.api)
      account.selectMailbox("archive")
      settleNative()
      compare(account.loadedDepth, 0, "navigation resets the depth")
      compare(listAsks(before), [account.maxMessages], "and asks for a page")
    }
  }
}
