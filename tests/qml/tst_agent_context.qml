import QtQuick
import QtTest
import "../../agent" as AI

Item {
  width: 800; height: 600
  QtObject {
    id: api
    property var callbacks: []
    property var ids: []
    function getMessage(id, full, callback) {
      ids = ids.concat([id]); callbacks = callbacks.concat([callback]); return null
    }
  }
  QtObject {
    id: owner
    property string accountId: "imap:ada@example.com"
    property string accountEmail: "ada@example.com"
    property string providerId: "imap"
    property string mailboxKey: "inbox"
    property var api: api
    property var messages: [{id:"1:INBOX",subject:"First"},{id:"2:INBOX",subject:"Second"}]
    property var memberSummaries: ({})
    property string selectedId: ""
  }
  QtObject {
    id: service
    property bool present: true
    function findAccount(id) { return present && id === owner.accountId ? owner : null }
  }
  QtObject {
    id: runner
    property bool starting: false
    property string lastError: ""
    property string line: ""
    function start(value) { line = value; return true }
  }
  AI.AgentContext { id: context; service: service; runner: runner }
  TestCase {
    name: "AgentContext"
    when: windowShown
    function init() {
      context.finishError(""); context.error = ""; api.callbacks=[]; api.ids=[]; runner.line=""; service.present=true
    }
    function reply(index, data) {
      api.callbacks[index]({id:api.ids[index],payload:{mimeType:"text/plain",body:{data:data},headers:[]}}, "")
    }
    function test_unopened_selection_waits_for_both_real_bodies() {
      verify(context.request(owner,["1:INBOX","2:INBOX"],"Compare"))
      compare(runner.line, "")
      reply(0,"Rmlyc3QgYm9keQ")
      compare(runner.line, "")
      reply(1,"U2Vjb25kIGJvZHk")
      var payload=JSON.parse(runner.line)
      compare(payload.accountId,owner.accountId)
      verify(payload.messages[0].message.indexOf("First body")>=0)
      verify(payload.messages[1].message.indexOf("Second body")>=0)
      compare(context.busy,false)
    }
    function test_removed_owner_never_launches() {
      verify(context.request(owner,["1:INBOX"],"Read"))
      service.present=false
      reply(0,"Qm9keQ")
      compare(runner.line,"")
      verify(context.error.indexOf("no longer")>=0)
    }
    function test_failure_and_duplicate_submit_do_not_launch() {
      verify(context.request(owner,["1:INBOX"],"Read"))
      compare(context.request(owner,["2:INBOX"],"Other"),false)
      api.callbacks[0](null,"Synthetic read failure")
      compare(runner.line,"")
      compare(context.error,"Synthetic read failure")
      compare(context.busy,false)
    }
    function test_late_callback_after_timeout_does_not_launch() {
      verify(context.request(owner,["1:INBOX"],"Read"))
      context.finishError("Timed out")
      reply(0,"Qm9keQ")
      compare(runner.line,"")
      compare(context.error,"Timed out")
    }
  }
}
