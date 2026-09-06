import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../../account" as Account

// The scheme detection asks a question with its first 401 and answers with
// its last one.
//
// A sign-in tries the session GET under one scheme and, on a 401, once more
// under the other. The client records a 401 as a rejected credential for every
// request it makes — the flag the setup page draws its re-entry card from and
// the push stream reads to stop — and it recorded the detection's *first* 401
// too. On a token-only server that emptied the secret field, drew the card
// and tore the event stream down on every "Save changes", while the second
// attempt went on to succeed. An account that has signed in before also starts
// from the scheme it recorded, so the working one is tried first.
//
// Why Qt rather than node: the flag is a property of the client, the order is
// a decision in the protocol library, and the page and the stream read the
// flag through the account. `Jmap.schemeOrder` is asserted on its own in
// `tests/test_jmap.js`; what has to be seen here is the flag staying down
// between the two attempts, on the real objects, with the transport stubbed.
Item {
  width: 400
  height: 300

  // An account that recorded Bearer the last time it signed in.
  Account.MailAccount {
    id: tokenAccount

    pluginDir: "/tmp/omamail-test"
    accountId: "jmap:ada@example.org"
    configuredEmail: "ada@example.org"
    providerId: "jmap"
    jmapSettings: ({
      sessionUrl: "https://mail.example.org/jmap/session",
      username: "ada@example.org",
      authScheme: "bearer",
      accountId: "t"
    })
    active: true
    windowOpen: true
  }

  // And one signing in for the first time, with a typed server and nothing
  // learned yet.
  Account.MailAccount {
    id: freshAccount

    pluginDir: "/tmp/omamail-test"
    accountId: "jmap:grace@example.org"
    configuredEmail: "grace@example.org"
    providerId: "jmap"
    jmapSettings: ({
      sessionUrl: "https://mail.example.org/jmap/session",
      username: "",
      authScheme: "",
      accountId: ""
    })
    active: false
    windowOpen: true
  }

  TestCase {
    name: "JmapSchemeDetection"
    when: windowShown

    readonly property var session: ({
      capabilities: {
        "urn:ietf:params:jmap:core": {},
        "urn:ietf:params:jmap:mail": {}
      },
      accounts: {
        t: {
          name: "grace@example.org",
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

    readonly property var mailboxes: ({
      methodResponses: [["Mailbox/get", {
        accountId: "t", state: "m0", notFound: [],
        list: [{ id: "a", name: "Inbox", role: "inbox", parentId: null,
          totalEmails: 0, unreadEmails: 0 }]
      }, "0"]],
      sessionState: "s0"
    })



    function test_a_recorded_scheme_is_tried_first_and_only_the_last_refusal_counts() {
      verify(!!tokenAccount.auth && !!tokenAccount.api)
      tokenAccount.auth.secret = "old-token"
      tokenAccount.auth.secretChecked = true
      compare(tokenAccount.api.credentialsRejected, false)

      var before = Transports.transports(tokenAccount.api)
      verify(tokenAccount.auth.signIn("new-token"), "the check starts")
      var first = Transports.newSince(tokenAccount.api, before)
      compare(first.length, 1, "one session GET")
      compare(Transports.requested(first[0]).verb, "session")
      compare(Transports.requested(first[0]).scheme, "bearer",
        "the scheme the account recorded is the one tried first")
      compare(tokenAccount.auth.progressStep, 2, "and the page is told which wait this is")

      // Refused. That is the question, not the answer: the flag stays down and
      // the other scheme is tried.
      var beforeSecond = Transports.transports(tokenAccount.api)
      Transports.answer(first[0], 401, null)
      compare(tokenAccount.api.credentialsRejected, false,
        "one refused scheme is not a rejected credential")
      var second = Transports.newSince(tokenAccount.api, beforeSecond)
      compare(second.length, 1, "the other scheme is tried")
      compare(Transports.requested(second[0]).scheme, "basic")

      // Refused again. Now every scheme has been, and that is the answer.
      Transports.answer(second[0], 401, null)
      compare(tokenAccount.api.credentialsRejected, true,
        "a 401 from both is the rejected state")
      compare(tokenAccount.auth.loginBusy, false)
      compare(tokenAccount.auth.progressStep, 0, "and the wait is over")
      compare(tokenAccount.auth.lastError, "The server rejected that app password or API token")
    }

    function test_a_first_sign_in_that_needs_the_second_scheme_is_not_rejected() {
      verify(!!freshAccount.auth && !!freshAccount.api)
      var learned = null
      freshAccount.auth.sessionVerified.connect(function(result) { learned = result })

      var before = Transports.transports(freshAccount.api)
      verify(freshAccount.auth.signIn("api-token"))
      var first = Transports.newSince(freshAccount.api, before)
      compare(first.length, 1)
      compare(Transports.requested(first[0]).scheme, "basic", "nothing recorded: Basic first")

      var beforeSecond = Transports.transports(freshAccount.api)
      Transports.answer(first[0], 401, null)
      compare(freshAccount.api.credentialsRejected, false,
        "the token-only server's refusal of Basic draws no card")
      var second = Transports.newSince(freshAccount.api, beforeSecond)
      compare(second.length, 1)
      compare(Transports.requested(second[0]).scheme, "bearer")

      var beforeMailboxes = Transports.transports(freshAccount.api)
      Transports.answer(second[0], 200, session)
      var calls = Transports.newSince(freshAccount.api, beforeMailboxes)
      compare(calls.length, 1, "a good session is followed by one Mailbox/get")
      compare(Transports.requested(calls[0]).verb, "call")
      compare(Transports.requested(calls[0]).scheme, "bearer", "under the scheme that answered")
      Transports.answer(calls[0], 200, mailboxes)

      compare(freshAccount.api.credentialsRejected, false)
      verify(!!learned, "sign-in reported what it learned")
      compare(learned.authScheme, "bearer", "which is the scheme that worked")
      compare(learned.accountId, "t")
      compare(freshAccount.auth.lastError, "")
    }
  }
}
