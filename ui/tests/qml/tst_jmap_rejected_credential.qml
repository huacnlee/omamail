import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../../account" as Account

// A refused credential is not sent again until somebody has typed one.
//
// A 401 raises the client's `credentialsRejected`, which the setup page draws
// its re-entry card from and the event stream reads to stop. Every *request*
// went on regardless: the queue, the session fetch and a blob download all
// asked the auth object for the credential and sent it, so the poll carried
// the refused secret to the server every two minutes for as long as the
// account stood — the retry that locks an app password, which spec story 62
// exists to prevent. This is the assertion that no verb carries the secret
// while the flag is up, and that sign-in — the one request that clears the
// flag — still goes out and opens the door again.
//
// Why Qt rather than node: the flag is a property of the client, the poll's
// door is `MailAccount.refresh()`, and the four paths are four methods on the
// real objects with the transport stubbed.
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
    name: "JmapRejectedCredential"
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
      downloadUrl: "https://api.example.org/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
      uploadUrl: "https://api.example.org/jmap/upload/{accountId}/",
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

    function carriesSecret(process) {
      return process.method !== "jmap.verify"
    }

    function test_no_verb_carries_a_refused_secret_until_sign_in_clears_it() {
      verify(!!account.auth && !!account.api)
      Transports.install(account.api)
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return account.ready }, 2000, "the mailbox is ready")

      // The poll's first request — a session GET, since nothing is held yet,
      // and already in flight from the tick that fires on ready — and the
      // server refuses it.
      var first = Transports.transports(account.api).filter(carriesSecret)
      verify(first.length > 0, "the first poll carries the secret, as it must")
      var before
      compare(first[0].params.credential, undefined)
      // Several native startup reads may already be pending. Their terminal
      // refusals drain accounting; no new request may pass the rejection gate.
      for (var pending=0;pending<first.length;pending++)
        Transports.reply(first[pending], null, {message:"jmap_unauthorized"})
      compare(account.api.credentialsRejected, true, "the 401 raised the flag")
      compare(account.ready, true, "and the account still stands, card drawn")

      // The poll's door, as `pollTimer` opens it: nothing goes out.
      before = Transports.transports(account.api)
      account.refresh()
      compare(Transports.newSince(account.api, before).length, 0,
        "a poll after a 401 sends nothing")

      // Each verb on its own, with a session in hand so the queue and the
      // download have somewhere they would otherwise send to.
      account.api.session = session
      account.api.mailboxList = mailboxes.methodResponses[0][1].list
      account.api.mailboxesLoaded = true

      var answers = []
      before = Transports.transports(account.api)
      account.api.getLabels(function(result,error) { answers.push(["call",error]) })
      account.api.saveDraft({raw:"eA"},function(result,error) { answers.push(["upload",error]) })
      account.api.getAttachment("m1", "blob1",
        function(data, error) { answers.push(["download", error]) })
      account.api.session = null
      account.api.ensureSession(function(error) { answers.push(["session", error]) })
      compare(Transports.newSince(account.api, before).length, 0,
        "a call, an upload, a download and a session fetch all start no process")
      compare(answers.length, 4, "and each answers its caller at once")
      for (var i = 0; i < answers.length; i++)
        compare(answers[i][1], "Sign in to this mailbox again", answers[i][0] + " says why")
      compare(account.api.busy, false, "nothing is in flight")

      // Sign-in is the one request that still goes out, because it is what
      // clears the flag — and once it has, the poll is back.
      before = Transports.transports(account.api)
      verify(account.auth.signIn("app-password"), "sign-in starts")
      var check = Transports.newSince(account.api, before)
      compare(check.length, 1, "sign-in's session GET goes out")
      compare(check[0].method, "jmap.verify")
      Transports.verified(check[0], session, mailboxes)
      compare(account.api.credentialsRejected, false, "a good sign-in clears the flag")

      before = Transports.transports(account.api)
      account.refresh()
      tryVerify(function() { return Transports.newSince(account.api, before).length > 0 },
        1000, "and the poll sends again")
    }
  }
}
