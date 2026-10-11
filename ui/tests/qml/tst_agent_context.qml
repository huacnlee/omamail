import QtQuick
import QtTest
import "../../agent" as AI
Item {
  width:800; height:600
  QtObject {
    id: backend
    property bool ready: true
    property int apiVersion: 6
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
    property var selectedBody: ({text:"Original message"})
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
    property var line: ""
    function start(value) { line=value;return true }
  }
  AI.AgentContext {id:context;service:service;runner:runner}
  TestCase {
    name:"AgentContext";when:windowShown
    function init(){context.finishError("");context.error="";backend.calls=[];backend.apiVersion=6;runner.line="";service.present=true}
    function draft(){return {accountId:owner.accountId,draftKey:"recovered",from:"ada@example.com",to:"bob@example.com",cc:"cc@example.com",bcc:"bcc@example.com",subject:"Reply",body:"Keep my edits",envelope:{body:"Keep my edits"}}}
    function test_api5_omits_api6_reader_and_draft_fields(){
      backend.apiVersion=5
      verify(context.request(owner,["1:INBOX"],"Reply",draft(),{body:"Signature"}))
      backend.calls[0].callback({payload:payload()},null)
      var sent=JSON.parse(runner.line)
      verify(!("envelope" in sent));verify(!("cc" in sent.draft));verify(!("bcc" in sent.draft))
      compare(sent.draft.body,"Keep my edits");compare(backend.calls.length,1)
    }
    function test_api5_continuation_has_no_mail_update(){
      backend.apiVersion=5
      verify(context.request(owner,["1:INBOX"],"Continue",null,null,{parent:"chat",prompt:"Continue"}))
      backend.calls[0].callback({payload:payload()},null)
      compare(runner.line,{parent:"chat",prompt:"Continue"})
    }
    function test_api5_reader_does_not_prepare_proposal_envelope(){
      backend.apiVersion=5
      verify(context.request(owner,["1:INBOX"],"Read",null,{body:"Signature"}))
      backend.calls[0].callback({payload:payload()},null)
      verify(!("envelope" in JSON.parse(runner.line)))
      compare(backend.calls.length,1);compare(context.busy,false)
    }
    function test_recovered_reply_reads_unloaded_account_bound_id(){
      verify(context.request(owner,["9:Archive"],"Reply",draft()))
      compare(backend.calls[0].params.summaries,[{id:"9:Archive"}])
      compare(backend.calls[0].params.accountId,owner.accountId)
      backend.calls[0].callback({payload:{accountId:owner.accountId,messageId:"9:Archive",message:"Original"}},null)
      var sent=JSON.parse(runner.line)
      compare(sent.message,"Original");compare(sent.draft.body,"Keep my edits");compare(sent.draft.cc,"cc@example.com")
    }
    function test_unavailable_original_preserves_draft_and_continuation(){
      var fields=draft()
      verify(context.request(owner,["9:Archive"],"Reply",fields))
      backend.calls[0].callback(null,{message:"jmap_message_not_found"})
      compare(runner.line.draftFields,fields);compare(context.busy,false)
      verify(context.request(owner,["9:Archive"],"Continue",null,null,{parent:"chat",prompt:"Continue",draftUpdate:{draft:fields}}))
      backend.calls[1].callback(null,{message:"jmap_message_not_found"})
      compare(runner.line.parent,"chat");compare(runner.line.draftUpdate.draft,fields)
      verify(!("mailUpdate" in runner.line))
    }
    function test_size_refusal_and_wrong_draft_owner_never_fall_back(){
      var fields=draft();fields.accountId="other@example.org"
      compare(context.request(owner,["9:Archive"],"Reply",fields),false)
      compare(backend.calls.length,0)
      verify(context.request(owner,["9:Archive"],"Reply",draft()))
      backend.calls[0].callback(null,{message:"agent_context_too_large"})
      compare(runner.line,"")
    }
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
    function test_reader_reply_uses_normal_composer_history_and_signature(){
      verify(context.request(owner,["1:INBOX"],"Reply",null,{body:"Ada",subject:""}))
      backend.calls[0].callback({payload:payload()},null)
      compare(context.busy,true);compare(runner.line,"")
      var prepare=backend.calls[1]
      compare(prepare.method,"message.composeText")
      compare(prepare.params.summary.subject,"First")
      compare(prepare.params.body,"Original message")
      compare(prepare.params.signature,"Ada")
      var body="\n\nAda\n\nOn Monday, Bob wrote:\n> Original message"
      var quote="On Monday, Bob wrote:\n> Original message"
      prepare.callback({body:body,quote:quote,replySubject:"Re: First"},null)
      compare(JSON.parse(runner.line).envelope.body,"Ada")
      compare(JSON.parse(runner.line).envelope.replyQuote,quote)
      compare(JSON.parse(runner.line).envelope.subject,"Re: First")
      compare(context.busy,false)
    }
    function test_cancelled_reply_preparation_cannot_launch(){
      verify(context.request(owner,["1:INBOX"],"Reply",null,{body:"Ada"}))
      backend.calls[0].callback({payload:payload()},null)
      var prepare=backend.calls[1]
      context.finishError("Cancelled")
      prepare.callback({body:"Late quote",replySubject:"Re: First"},null)
      compare(runner.line,"")
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
