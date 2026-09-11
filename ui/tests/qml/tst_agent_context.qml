import QtQuick
import QtTest
import "../../agent" as AI
Item {
  width:800; height:600
  QtObject {
    id: backend
    property bool ready: true
    property var calls: []
    function call(method,params,callback) {
      calls = calls.concat([{method:method,params:params,callback:callback}])
      return {cancel:function(){}}
    }
  }
  QtObject {
    id: owner
    property string accountId: "imap:ada@example.com"
    property string mailboxKey: "inbox"
    property var messages: [{id:"1:INBOX",subject:"First"},{id:"2:INBOX",subject:"Second"}]
    property var memberSummaries: ({})
    property string selectedId: ""
  }
  property var nativeBackend: backend
  QtObject {
    id: service
    property bool present: true
    property var backend: nativeBackend
    function findAccount(id) { return present && id === owner.accountId ? owner : null }
  }
  QtObject {
    id: runner
    property bool starting: false
    property string lastError: ""
    property string line: ""
    function start(value) { line=value;return true }
  }
  AI.AgentContext {id:context;service:service;runner:runner}
  TestCase {
    name:"AgentContext";when:windowShown
    function init(){context.finishError("");context.error="";backend.calls=[];runner.line="";service.present=true}
    function payload(){return {accountId:owner.accountId,messageId:"",messages:[{messageId:"1:INBOX",message:"First body"},{messageId:"2:INBOX",message:"Second body"}],prompt:"Compare"}}
    function test_selection_sends_one_account_bound_native_request(){
      verify(context.request(owner,["1:INBOX","2:INBOX"],"Compare"))
      compare(backend.calls.length,1);compare(backend.calls[0].method,"agent.context")
      compare(backend.calls[0].params.accountId,owner.accountId)
      compare(backend.calls[0].params.ids,["1:INBOX","2:INBOX"])
      compare(runner.line,"")
      backend.calls[0].callback({payload:payload()},null)
      compare(JSON.parse(runner.line).messages[1].message,"Second body");compare(context.busy,false)
    }
    function test_removed_owner_never_launches(){
      verify(context.request(owner,["1:INBOX"],"Read"));service.present=false
      backend.calls[0].callback({payload:payload()},null)
      compare(runner.line,"");verify(context.error.indexOf("no longer")>=0)
    }
    function test_failure_and_duplicate_submit_do_not_launch(){
      verify(context.request(owner,["1:INBOX"],"Read"))
      compare(context.request(owner,["2:INBOX"],"Other"),false)
      backend.calls[0].callback(null,{message:"synthetic failure"})
      compare(runner.line,"");compare(context.busy,false)
    }
    function test_timeout_cancels_native_work_and_late_result_cannot_launch(){
      verify(context.request(owner,["1:INBOX"],"Read"))
      var request=backend.calls[0];context.finishError("Timed out")
      compare(backend.calls[1].method,"agent.contextCancel")
      compare(backend.calls[1].params.requestId,request.params.requestId)
      compare(backend.calls[1].params.accountId,owner.accountId)
      request.callback({payload:payload()},null)
      compare(runner.line,"");compare(context.error,"Timed out")
    }
    function test_wrong_account_payload_cannot_launch(){
      verify(context.request(owner,["1:INBOX"],"Read"))
      backend.calls[0].callback({payload:{accountId:"other@example.org"}},null)
      compare(runner.line,"");verify(context.error.indexOf("does not belong")>=0)
    }
  }
}
