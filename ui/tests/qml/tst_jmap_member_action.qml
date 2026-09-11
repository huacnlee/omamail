import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "NativeIntentFixture.js" as NativeIntentFixture
import "../../account" as Account

// An action from a stop on the rail names one message on the wire.
//
// A verb on a conversation row reaches every counted member: the account
// expands the row to its block and hands the client the flat list. A stop is
// one message, and the same verb from its menu must name that message alone —
// including when the stop is the representative, whose id is also a row's.
// `MailAccount.act`'s fourth argument is what says so, and what has to be seen
// here is the `Email/set` the transport is handed: one id, then three.
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
    name: "JmapMemberAction"
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
      { id: "a", name: "Inbox", role: "inbox", parentId: null, totalEmails: 1, unreadEmails: 1 },
      { id: "b", name: "Trash", role: "trash", parentId: null, totalEmails: 0, unreadEmails: 0 }
    ]

    // The ids an `Email/set` request named, read off the transport line.
    function updatedIds(process) {
      verify(process.method === "jmap.trash" || process.method === "jmap.batchModify")
      compare(process.params.accountId, "jmap:ada@example.org")
      compare(process.params.credential, undefined)
      return process.params.ids.slice().sort().join(",")
    }

    function test_a_member_action_names_one_message_and_a_row_action_names_them_all() {
      verify(!!account.auth && !!account.api)
      Transports.install(account.api)
      account.api.session = session
      account.api.mailboxList = mailboxes
      account.api.mailboxesLoaded = true
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return account.ready }, 2000)

      wait(1)
      // One row, standing for a conversation of three, its own id the newest.
      var block = { id: "d", count: 3, unread: true, flagged: false,
        memberIds: ["m1", "m2", "m3"] }
      account.messages = [{ id: "m3", subject: "One", unread: true, starred: false,
        labelIds: ["INBOX", "UNREAD"], thread: block }]
      account.listLoaded = true
      account.listLoading = false

      // From the representative's own stop: the one message.
      var before = Transports.transports(account.api)
      verify(account.act("m3", "trash", false, true), "the member action was accepted")
      settleNative()
      var sent = Transports.newSince(account.api, before)
      compare(sent.length, 1, "one request")
      compare(updatedIds(sent[0]), "m3", "naming the one message, not the conversation")
      Transports.complete(sent[0], {})
      tryVerify(function() { return account.pendingAction === "" }, 2000)

      // The same verb on the row: every counted member.
      account.messages = [{ id: "m3", subject: "One", unread: true, starred: false,
        labelIds: ["INBOX", "UNREAD"], thread: block }]
      before = Transports.transports(account.api)
      verify(account.act("m3", "trash"), "the row action was accepted")
      settleNative()
      sent = Transports.newSince(account.api, before)
      compare(sent.length, 1)
      compare(updatedIds(sent[0]), "m1,m2,m3", "the row reaches the whole conversation")
    }
  }
}
