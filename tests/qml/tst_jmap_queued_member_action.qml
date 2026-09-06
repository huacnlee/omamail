import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../../account" as Account

// The queue must retain a rail action's single-message scope, including when
// duplicate intent is coalesced. Detached members use the same mutation and
// rollback path even when the reader marks them read automatically.
Item {
  width: 400
  height: 300

  Component {
    id: accountComponent
    Account.MailAccount {
      id: mailbox

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

  }

  TestCase {
    name: "JmapQueuedMemberAction"
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
      var body = JSON.parse(Transports.requested(process).fields[4])
      var call = body.methodCalls[0]
      compare(call[0], "Email/set")
      return Object.keys(call[1].update).sort().join(",")
    }

    property var account: null

    function init() {
      account = createTemporaryObject(accountComponent, parent)
      verify(!!account)
      account.api.session = session
      account.api.mailboxList = mailboxes
      account.api.mailboxesLoaded = true
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return account.ready }, 2000)
      account.queuedActions = []
      account.pendingAction = ""
      account.previewMessages = []
      account.selectedThread = null
      account.memberSummaries = ({})
      account.messages = [{ id: "m3", subject: "One", unread: true, starred: false,
        labelIds: ["INBOX", "UNREAD"], thread: { id: "d", count: 3,
          unread: true, flagged: false, memberIds: ["m1", "m2", "m3"] } }]
      account.listLoaded = true
      account.listLoading = false
    }

    function test_queued_rail_action_stays_one_message() {
      account.pendingAction = "markRead"
      verify(account.act("m3", "trash", false, true))
      verify(account.act("m3", "trash", false, true))
      compare(account.queuedActions.length, 1)
      var before = Transports.transports(account.api)
      account.pendingAction = ""
      account.runQueuedAction()
      var sent = Transports.newSince(account.api, before)
      compare(sent.length, 1)
      compare(updatedIds(sent[0]), "m3", "queued representative rail trash must still target one message")
    }

    function test_detached_member_automatic_read_dispatches() {
      account.messages = []
      account.selectedThread = { id: "d", count: 2, unread: true,
        flagged: false, memberIds: ["m1", "m2"] }
      account.memberSummaries = ({m1: {id: "m1", unread: true, labelIds: ["UNREAD"]}})
      var before = Transports.transports(account.api)
      verify(account.act("m1", "markRead", true))
      var sent = Transports.newSince(account.api, before)
      compare(sent.length, 1, "opening unread member after row disappears must mark it read")
      compare(updatedIds(sent[0]), "m1")
      compare(account.memberSummaries.m1.unread, false)
      Transports.answer(sent[0], 200, { methodResponses: [["Email/set",
        { accountId: "t", notUpdated: { m1: { type: "forbidden" } } }, "0"]], sessionState: "s0" })
      tryCompare(account, "pendingAction", "")
      compare(account.memberSummaries.m1.unread, true, "failed automatic read restores the member")
    }
  }
}
