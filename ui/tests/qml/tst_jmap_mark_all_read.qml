import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "NativeIntentFixture.js" as NativeIntentFixture
import "../../account" as Account

// "Mark these read" reaches the rail and the open message, and comes back.
//
// The list's rows took the change and the rail's stops did not: every member
// summary the account held kept its dot, and nothing later re-reads a member
// it already has, so the stale dot lasted the session. The same batch now
// marks every held member, gives a representative its row's own recomputed
// summary, and reads the open message the same way — and an error puts all
// three back with the rows.
//
// Why Qt rather than node: the batch is one function over four properties of
// one account, and the failure this is written against was the function
// touching three of them. The account is a real `MailAccount` on the real
// `JmapClient`; its transport is the stubbed `Process` under
// `tests/qml/imports`, which never exits on its own, so the request stays in
// flight until this test ends it.
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
    name: "JmapMarkAllRead"
    function initTestCase() {account.backend=NativeIntentFixture.backend(account)}
    function settleNative() {wait(1);tryVerify(function(){return account.backend.pending.length===0})}
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
            "urn:ietf:params:jmap:mail": { emailQuerySortOptions: ["receivedAt"] }
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
        totalEmails: 2, unreadEmails: 2 },
      { id: "b", name: "Trash", role: "trash", parentId: null,
        totalEmails: 0, unreadEmails: 0 }
    ]

    function member(id, unread) {
      return ({
        id: id, threadId: "d", subject: "The engine", snippet: "",
        from: ({ display: "Ada Lovelace", email: "ada@example.org" }),
        to: [], cc: [], bcc: [], time: "3d", fullTime: "2 September 2026",
        unread: unread, starred: false,
        labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"]
      })
    }

    function test_mark_all_read_marks_the_rail_and_the_open_member_and_restores() {
      verify(!!account.auth && !!account.api)
      Transports.install(account.api)
      account.api.session = session
      account.api.mailboxList = mailboxes
      account.api.mailboxesLoaded = true
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return account.ready }, 2000, "the mailbox is ready")

      // One conversation row of two, both unread; the reply is the one open in
      // the reader and the representative is a stop as well as a row.
      var row = member("m1", true)
      row.thread = { id: "d", count: 2, unread: true, flagged: false, memberIds: ["m1", "m2"] }
      account.messages = [row]
      account.listLoaded = true
      account.listLoading = false
      account.memberSummaries = ({ m1: row, m2: member("m2", true) })
      account.selectedId = "m2"
      account.selectedMessage = member("m2", true)

      wait(1)
      var before = Transports.transports(account.api)
      verify(account.markAllRead(), "the batch was accepted")
      settleNative()
      compare(account.pendingAction, "markRead")
      var requests = Transports.newSince(account.api, before)
      compare(requests.length, 1, "one request for the whole batch")

      compare(account.messages[0].unread, false, "the row is read")
      compare(account.messages[0].thread.unread, false, "and its block says so")
      compare(account.memberSummaries.m1.unread, false,
        "the representative's stop takes the row's own summary")
      compare(account.memberSummaries.m1.thread.unread, false)
      compare(account.memberSummaries.m2.unread, false, "the reply's stop is read too")
      compare(account.selectedMessage.unread, false, "and so is the open message")

      // The backend request fails, and everything
      // that was marked goes back: rows, stops and the open message.
      Transports.fail(requests[0])
      settleNative()
      compare(account.pendingAction, "")
      compare(account.messages[0].unread, true, "the row is back")
      compare(account.memberSummaries.m1.unread, true, "and the representative's stop")
      compare(account.memberSummaries.m2.unread, true, "and the reply's")
      compare(account.selectedMessage.unread, true, "and the open message")
    }
  }
}
