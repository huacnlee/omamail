import QtQuick 2.15
import QtTest 1.3
import "transports.js" as Transports
import "../../account" as Account

// A request abandoned in flight gives its concurrency slot back.
//
// The client keeps the server's `maxConcurrentRequests` with a FIFO of its
// own, and a slot used to be returned inside each request's callback — which
// an abandoned request never reaches, because the transport returns early on
// the aborted flag. Every reselect abandons the previous body read and member
// read, so four of them in flight filled the server's four slots for good:
// every later call waited on a queue nothing would drain, and the reader and
// the rail sat on their skeletons with no error to show. Run on the real
// account and client over the stubbed transport, whose `running = false`
// exits nothing — the release has to come from the abort itself.
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
    name: "JmapRequestQueue"
    when: windowShown

    readonly property var session: ({
      capabilities: {
        "urn:ietf:params:jmap:core": { maxConcurrentRequests: 100 },
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

    function oneCall(callback) {
      var handle = account.api.newHandle()
      account.api.call([["Mailbox/get", { accountId: "t", ids: null }, "0"]], handle,
        callback || function() {})
      return handle
    }

    function running() { return account.api.callQueue.running }

    function test_an_abandoned_call_gives_its_slot_back() {
      verify(!!account.auth && !!account.api)
      account.api.session = session
      account.api.mailboxList = [{ id: "a", name: "Inbox", role: "inbox", parentId: null,
        totalEmails: 1, unreadEmails: 1 }]
      account.api.mailboxesLoaded = true
      account.auth.secret = "app-password"
      account.auth.secretChecked = true
      tryVerify(function() { return account.ready }, 2000, "the mailbox is ready")
      // The account's own first reads hold whatever they hold; everything
      // below is measured against that.
      var held = running()

      // Four reads abandoned in flight, the way a reselect abandons the
      // previous body read and member read.
      for (var i = 0; i < 4; i++) {
        var before = Transports.transports(account.api)
        var handle = oneCall()
        compare(Transports.newSince(account.api, before).length, 1, "read " + i + " reaches the transport")
        compare(running(), held + 1, "and holds a slot while it runs")
        account.api.abortRequest(handle)
        compare(running(), held, "which the abort gives back")
      }

      // The killed process may still report its exit afterwards — the real
      // transport does — and that must not give the slot back a second time.
      var beforeLate = Transports.transports(account.api)
      var late = oneCall()
      var process = Transports.newSince(account.api, beforeLate)[0]
      account.api.abortRequest(late)
      compare(running(), held)
      process.stdout.text = ""
      process.exited(0)
      compare(running(), held, "an exit after the abort releases nothing more")

      // So a read after them still goes out, and still answers.
      var beforeNext = Transports.transports(account.api)
      var answered = false
      oneCall(function() { answered = true })
      var next = Transports.newSince(account.api, beforeNext)
      compare(next.length, 1, "a read after four abandoned ones reaches the transport")
      compare(running(), held + 1)
      Transports.answer(next[0], 200, { methodResponses: [["Mailbox/get",
        { accountId: "t", state: "m0", notFound: [], list: [] }, "0"]], sessionState: "s0" })
      verify(answered, "and calls back")
      compare(running(), held, "a finished read gives its slot back once")
    }
  }
}
