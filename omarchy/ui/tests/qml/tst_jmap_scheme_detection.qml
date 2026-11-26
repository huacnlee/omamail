import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../../account" as Account

// Scheme detection now belongs to Rust. The real account must preserve its
// credential state while verification is pending, pass the previous scheme,
// show a rejection only after the final backend refusal, and retain the scheme
// returned by a successful verification. Rust discovery tests cover HTTP order.
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
      compare(first.length, 1, "one native verification")
      compare(first[0].method, "jmap.verify")
      compare(first[0].params.settings.authScheme, "bearer",
        "the backend receives the previously successful scheme")
      compare(tokenAccount.api.credentialsRejected, false,
        "pending verification does not reject the credential")
      Transports.reply(first[0], null, {message:"jmap_unauthorized"})
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
      compare(first[0].method, "jmap.verify")
      compare(first[0].params.settings.authScheme, "basic")
      compare(freshAccount.api.credentialsRejected, false,
        "scheme detection stays private to the backend until it settles")
      Transports.verified(first[0], session, mailboxes, "bearer")

      compare(freshAccount.api.credentialsRejected, false)
      verify(!!learned, "sign-in reported what it learned")
      compare(learned.authScheme, "bearer", "which is the scheme that worked")
      compare(learned.accountId, "t")
      compare(freshAccount.auth.lastError, "")
    }
  }
}
