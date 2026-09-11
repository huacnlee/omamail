import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../../account" as Account

// A reply that names a newer session state has the session fetched again.
//
// Every API reply carries `sessionState`, and one that differs from the held
// session's is the server saying its URLs, its limits or its accounts changed
// without moving. The client held the session from sign-in or from the cache
// and noticed a change only when a request came back 404; a server that kept
// its API URL and changed a limit was never re-read. One reply naming a new
// state now costs one session GET, and the held session is replaced by what it
// answers — not dropped first, so nothing in flight waits on it.
//
// Why Qt rather than node: `Jmap.movedSessionState` is asserted on its own in
// `tests/test_jmap.js`; what has to be seen here is the client acting on it
// from inside `readCall`, once per state, on the real objects with the
// transport stubbed.
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
    name: "JmapSessionState"
    when: windowShown

    function session(state) {
      return ({
        capabilities: {
          "urn:ietf:params:jmap:core": { maxObjectsInGet: state === "s0" ? 100 : 250 },
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
        state: state
      })
    }

    function countReply(sessionState) {
      return ({
        methodResponses: [["Mailbox/get", {
          accountId: "t", state: "m0", notFound: [],
          list: [{ id: "a", name: "Inbox", role: "inbox", parentId: null,
            totalEmails: 1, unreadEmails: 1 }]
        }, "0"]],
        sessionState: sessionState
      })
    }



    // One count read, answered under a reply that names each state in turn.
    function countUnder(sessionState) {
      var before = Transports.transports(account.api)
      account.api.getLabelCounts("a", function() {})
      var requests = Transports.newSince(account.api, before)
      compare(requests.length, 1, "one Mailbox/get")
      compare(Transports.requested(requests[0]).verb, "call")
      var beforeAnswer = Transports.transports(account.api)
      Transports.answer(requests[0], 200, countReply(sessionState))
      return Transports.newSince(account.api, beforeAnswer)
    }

    function test_a_reply_naming_a_newer_state_refetches_the_session_once() {
      verify(!!account.auth && !!account.api)
      account.api.session = session("s0")
      account.api.mailboxList = countReply("s0").methodResponses[0][1].list
      account.api.mailboxesLoaded = true
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return account.ready }, 2000, "the mailbox is ready")

      compare(countUnder("s0").length, 0, "the state the session already has moves nothing")

      var refetch = countUnder("s1")
      compare(refetch.length, 1, "a newer state is one session GET")
      compare(Transports.requested(refetch[0]).verb, "session")
      compare(account.api.session.state, "s0", "and the held session stands until it answers")

      compare(countUnder("s1").length, 0, "the same state again is not a second GET")

      Transports.answer(refetch[0], 200, session("s1"))
      compare(account.api.session.state, "s1", "the answer replaces the held session")
      compare(account.api.session.capabilities["urn:ietf:params:jmap:core"].maxObjectsInGet, 250,
        "limits included")
      compare(countUnder("s1").length, 0, "and the new state is now the one held")
    }
  }
}
