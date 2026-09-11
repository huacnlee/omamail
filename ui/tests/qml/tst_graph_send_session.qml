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
      property var calls: []
      backend: QtObject {
        property bool ready: true
        function call(method, params, callback) {
          calls = calls.concat([{method: method, params: params, callback: callback}])
        }
      }
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

    function transports(client) { return client.calls }

    function newHandle() { return ({ aborted: false, process: null }) }

    // Rust resolves the queued account's token. UI changes cannot retarget the
    // accountId already submitted, and a stale response cannot report success
    // for whichever account the user switched to in the meantime.
    function test_account_switch_cannot_retarget_submitted_send() {
      var made=build()
      var answers=[]
      var raw=Qt.btoa("From: alice@example.test\r\n\r\nhello")
      made.client.sendViaGraph(raw,function(result,error){answers.push({result:result,error:error})},newHandle())
      compare(made.client.calls.length,1)
      var request=made.client.calls[0]
      compare(request.method,"outlook.graphSend")
      compare(request.params.accountId,"outlook:alice@example.test")
      compare(request.params.raw,raw)
      compare(request.params.token,undefined)
      compare(made.auth.waiters.length,0)
      made.auth.becomeAnotherAccount("outlook:bob@example.test")
      request.callback({sent:true},"")
      compare(made.client.calls.length,1)
      compare(request.params.accountId,"outlook:alice@example.test")
      compare(answers.length,1)
      compare(answers[0].result,null)
      verify(answers[0].error!=="")
      compare(made.client.inFlight,0)
    }
    function test_unchanged_session_receives_confirmed_send() {
      var made=build()
      var answers=[]
      made.client.sendViaGraph("synthetic",function(result,error){answers.push({result:result,error:error})},newHandle())
      compare(answers.length,0)
      made.client.calls[0].callback({sent:true},"")
      compare(answers.length,1)
      compare(answers[0].result.sent,true)
      compare(answers[0].error,"")
      compare(made.client.inFlight,0)
    }
    function test_refused_send_after_account_switch_answers_once_without_retry() {
      var made=build()
      var answers=[]
      made.client.sendViaGraph("synthetic",function(result,error){answers.push({result:result,error:error})},newHandle())
      made.auth.becomeAnotherAccount("outlook:bob@example.test")
      made.client.calls[0].callback(null,{message:"auth_signed_out"})
      compare(made.client.calls.length,1)
      compare(answers.length,1)
      compare(answers[0].result,null)
      verify(answers[0].error!=="")
      compare(made.client.inFlight,0)
    }
  }
}
