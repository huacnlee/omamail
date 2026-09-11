import QtQuick
import QtTest
import "../../providers" as Providers

// A Graph send is bound to the mailbox that queued it. The token comes back
// from a sign-in that may take as long as it likes, and in between the window
// may have been pointed at another account: the MIME waiting here is the first
// mailbox's, and nothing of it may be carried to the second.
Item {
  // The mail session, as much of it as a send consumer touches: a Graph token
  // asked for and answered when the test says so, and a session identity that
  // changes the way `OutlookAuth`'s does.
  Component {
    id: authFactory
    QtObject {
      property string pluginDir: "/tmp/omamail-test"
      property string authMode: "oauth2"
      property var settings: ({ username: "alice@example.test", send: "graph" })
      property int generation: 0
      property string accountId: "outlook:alice@example.test"
      property var waiters: []
      function sessionContext() {
        return { generation: generation, accountId: accountId, clientId: "client-1" }
      }
      function isCurrent(context) {
        return !!context && context.generation === generation && context.accountId === accountId
      }
      function withGraphToken(callback) { waiters = waiters.concat([callback]) }
      // What `changeIdentity` does to a session: the account is another one,
      // and everything bound to the old one is stale.
      function becomeAnotherAccount(id) {
        generation++
        accountId = id
      }
    }
  }

  Component {
    id: clientFactory
    Providers.ImapClient {
      required property var authObject
      auth: authObject
      email: "alice@example.test"
    }
  }

  TestCase {
    name: "GraphSendSession"

    function build() {
      var auth = createTemporaryObject(authFactory, parent)
      verify(auth !== null)
      var client = createTemporaryObject(clientFactory, parent, { authObject: auth })
      verify(client !== null)
      return { auth: auth, client: client }
    }

    // A transport is a Process the client started against mail-transport.sh.
    // Counting them is how "nothing was sent" is asserted.
    function transports(client) {
      var out = []
      for (var i = 0; i < client.children.length; i++) {
        var child = client.children[i]
        if (child.command && String(child.command[0] || "").indexOf("mail-transport.sh") >= 0) out.push(child)
      }
      return out
    }

    function newHandle() { return ({ aborted: false, process: null }) }

    // The reviewer's report: Alice's MIME is queued, the mailbox becomes
    // Bob's, Bob's token exchange completes, and the old callback builds a
    // running transport carrying Bob's token and Alice's message.
    function test_a_send_queued_before_an_account_switch_starts_no_transport() {
      var made = build()
      var answers = []
      made.client.sendViaGraph(Qt.btoa("From: alice@example.test\r\n\r\nhello"),
        function(result, error) { answers.push({ result: result, error: error }) }, newHandle())
      compare(made.auth.waiters.length, 1, "the send is waiting on a Graph token")
      compare(answers.length, 0)
      compare(made.client.inFlight, 1)

      made.auth.becomeAnotherAccount("outlook:bob@example.test")
      // Bob's exchange completes and answers the waiter it inherited.
      made.auth.waiters[0]("bob-graph-token", "")

      compare(transports(made.client).length, 0,
        "no transport may start for a mailbox that is no longer this one")
      compare(answers.length, 1, "the send is refused rather than left hanging")
      compare(answers[0].result, null)
      verify(answers[0].error !== "")
      compare(made.client.inFlight, 0, "and the client is not left busy")
    }

    // The same session throughout: the send goes, so the guard above is not
    // simply refusing everything.
    function test_a_send_on_the_session_that_queued_it_is_carried() {
      var made = build()
      var answers = []
      made.client.sendViaGraph(Qt.btoa("From: alice@example.test\r\n\r\nhello"),
        function(result, error) { answers.push({ result: result, error: error }) }, newHandle())
      made.auth.waiters[0]("alice-graph-token", "")

      var started = transports(made.client)
      compare(started.length, 1, "the mailbox that queued it sends")
      compare(started[0].running, true)
      compare(answers.length, 0, "and waits on the transport rather than answering early")
    }

    // A token refused for a session that has moved on says so once, and still
    // starts nothing.
    function test_a_refused_token_after_a_switch_starts_no_transport() {
      var made = build()
      var answers = []
      made.client.sendViaGraph(Qt.btoa("From: alice@example.test\r\n\r\nhello"),
        function(result, error) { answers.push({ result: result, error: error }) }, newHandle())
      made.auth.becomeAnotherAccount("outlook:bob@example.test")
      made.auth.waiters[0]("", "Signed out")

      compare(transports(made.client).length, 0)
      compare(answers.length, 1)
      verify(answers[0].error !== "")
      compare(made.client.inFlight, 0)
    }
  }
}
