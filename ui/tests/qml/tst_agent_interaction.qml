import QtQuick
import QtTest
import "../../components" as C
import "../../agent" as AI
import "../../agent/Agent.js" as Agent
import "../oracles/agent/Agent.js" as Oracle

Item {
  width: 800; height: 650
  QtObject {
    id: service
    property bool hasAgent: true
    property bool agentStarting: false
    property string agentError: ""
    property string activeAccountId: "imap:ada@example.com"
    property string agentShownId: ""
    property string agentShownOutput: ""
    property var agentShownTranscript: []
    property string parentId: ""
    property string cancelledId: ""
    function cancelAgentJob(id) { cancelledId=id; return true }
    property var jobs: []
    readonly property var agentAllJobs: jobs
    property bool accept: true
    property int calls: 0
    property string requestedId: ""
    function agentJobFor(id, account) { return Oracle.selectionJob(jobs,[id],account) }
    function agentSelectionJob(ids, account) { return Oracle.selectionJob(jobs,ids,account) }
    function agentHistoryFor(fields, ids, account) { return Oracle.historyFor(jobs, fields ? fields.accountId : account, ids, fields ? fields.draftKey : "") }
    function agentJobsForDraft(fields) { return Oracle.draftJobs(jobs,fields.accountId,fields.draftKey) }
    function showAgentJob(id) { agentShownId=id }
    function acknowledgeAgentJob(id) {}
    function askAgent(id, prompt, account) { requestedId=id; calls++; if (accept) agentStarting=true; return accept }
    function answerAgent(id, prompt) { parentId=id; calls++; if (!accept) return false; agentStarting=true;return true }
    function askAgentMany(ids, prompt, account) { return askAgent(ids[0],prompt,account) }
    function askAgentDraft(fields, prompt) { return askAgent("",prompt,fields.accountId) }
  }
  QtObject {
    id: draft
    property var fields: ({accountId:"imap:ada@example.com",draftKey:"d1",body:"Original",subject:"Plan"})
    property string applied: ""
    function currentFields() { return fields }
    function insertAtCursor(text) { applied=text }
    function replaceBody(text) { applied=text }
  }
  C.AgentPrompt {
    id: popup
    service: service
    onFocusRequested: takeFocus()
    textColor: Qt.rgba(0.93,0.93,0.93,1); accentColor: Qt.rgba(0.66,0.8,0.93,1); urgentColor: Qt.rgba(0.93,0.66,0.66,1); dimColor: Qt.rgba(0.6,0.6,0.6,1)
    popupBackgroundColor: Qt.rgba(0.13,0.13,0.13,1); popupBorderColor: Qt.rgba(0.26,0.26,0.26,1); panelFontFamily: "monospace"
  }
  QtObject {
    id: runnerBackend
    property bool ready: true
    property var requests: []
    function call(method, params, callback) {requests=requests.concat([{method:method,params:params,callback:callback}])}
  }
  AI.AgentRunner { id: runner; pluginDir:"/synthetic"; backend:runnerBackend }
  TestCase {
    name: "AgentInteraction"
    when: windowShown
    function init() {
      findChild(popup,"agent-pending-queue").messages=[]
      popup.close(); popup.composer=null
      service.jobs=[];service.agentStarting=false;service.agentError="";service.calls=0;service.accept=true
      service.agentShownOutput="";service.agentShownTranscript=[];service.parentId="";service.agentShownId="";draft.applied=""
      popup.ignoredJobId="";popup.submittedPrompt="";popup.viewedJobId="";popup.viewedConversationId="";popup.historyMode=false
      findChild(popup,"agent-more-menu").close()
      draft.fields={accountId:service.activeAccountId,draftKey:"d1",body:"Original",subject:"Plan"}
    }
    function test_stream_retains_selected_text() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"running"}]
      popup.openCenteredFor("m1","Mail")
      service.agentShownTranscript=[{role:"assistant",text:"Earlier complete reply"},{role:"status",text:"Reading"}]
      verify(waitForRendering(popup))
      var reply=findChild(popup,"agent-result")
      reply.select(0,7)
      compare(reply.selectedText,"Earlier")
      service.agentShownTranscript=[{role:"assistant",text:"Earlier complete reply"},{role:"status",text:"Reading more"}]
      verify(waitForRendering(popup))
      compare(findChild(popup,"agent-result").selectedText,"Earlier")
    }
    function test_stream_retains_reader_scroll() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"running"}]
      popup.openCenteredFor("m1","Mail")
      var body=Array(100).join("A long chat line\n")
      service.agentShownTranscript=[{role:"assistant",text:body}]
      verify(waitForRendering(popup))
      wait(30)
      var reply=findChild(popup,"agent-result")
      var flick=reply.parent
      while(flick && flick.followEnd === undefined) flick=flick.parent
      verify(flick!==null)
      flick.contentY=150
      compare(flick.followEnd,false)
      service.agentShownTranscript=[{role:"assistant",text:body+"New words"}]
      verify(waitForRendering(popup))
      wait(30)
      compare(flick.contentY,150)
    }
    function test_submit_keeps_popup_and_shows_async_error() {
      popup.openCenteredFor("m1","Mail")
      tryCompare(popup,"opened",true)
      var field=findChild(popup,"agent-prompt-field")
      field.text="Summarize"
      verify(popup.submitCurrent())
      compare(service.calls,1)
      compare(popup.opened,true)
      service.agentStarting=false
      service.agentError="The system terminal could not launch"
      compare(popup.errorText,service.agentError)
      compare(field.text,"Summarize")
    }
    function test_slash_command_is_editable_and_does_not_submit() {
      popup.openCenteredFor("m1", "Mail")
      var field = findChild(popup, "agent-prompt-field")
      field.text = "/"
      tryCompare(popup, "commandsOpen", true)
      var prompt = popup.commandMatches.items[0].prompt
      verify(popup.chooseCommand(0))
      compare(field.text, prompt)
      compare(service.calls, 0)
      compare(popup.commandsOpen, false)
      field.forceActiveFocus()
      field.cursorPosition = field.text.length
      keyClick(Qt.Key_Return)
      verify(field.text.endsWith("\n"))
      compare(service.calls, 0)
      verify(popup.submitCurrent())
      compare(service.calls, 1)
    }
    function test_more_menu_and_full_width_input() {
      popup.openCenteredFor("m1", "Mail")
      verify(waitForRendering(popup))
      var field = findChild(popup, "agent-prompt-field")
      compare(findChild(popup, "agent-ask-button"), null)
      verify(field.width > popup.width - 40)
      var bottom = popup.height - field.mapToItem(popup, 0, field.height).y
      verify(bottom >= 10 && bottom <= 14, "bottom gap " + bottom)
      var more = findChild(popup, "agent-more-button")
      mouseClick(more, more.width / 2, more.height / 2)
      tryCompare(findChild(popup, "agent-more-menu"), "visible", true)
      compare(more.selected, true)
      compare(popup.opened, true)
    }
    function test_copy_raw_reply_and_show_check_without_button_chrome() {
      service.jobs=[{id:"reply",messageId:"m1",accountId:service.activeAccountId,state:"done"}]
      popup.openCenteredFor("m1","Mail")
      service.agentShownTranscript=[{role:"assistant",text:"**Bold** and <b>literal</b>"}]
      verify(waitForRendering(popup))
      var copy=findChild(popup,"agent-copy-reply")
      compare(copy.padding,0)
      compare(copy.background,null)
      mouseClick(copy,copy.width/2,copy.height/2)
      compare(copy.copied,true)
      compare(copy.contentItem.name,"check")
      var field=findChild(popup,"agent-prompt-field")
      field.text=""
      field.paste()
      compare(field.text,"**Bold** and <b>literal</b>")
      tryCompare(copy,"copied",false,2500)
      compare(copy.contentItem.name,"copy")
    }
    function test_pending_messages_continue_in_order_and_wait_for_ack() {
      service.jobs=[{id:"first",conversationId:"chat",messageId:"m1",accountId:service.activeAccountId,state:"running",created:1}]
      popup.openCenteredFor("m1","Mail")
      verify(popup.submit("Second question"))
      verify(popup.submit("Third question"))
      var queue=findChild(popup,"agent-pending-queue")
      compare(queue.messages.length,2)
      compare(findChild(popup,"agent-prompt-field").text,"")
      queue.advance()
      compare(service.calls,0)
      service.jobs=[{id:"first",conversationId:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:1}]
      queue.advance()
      compare(service.calls,1)
      compare(service.parentId,"first")
      compare(queue.messages.length,2)
      queue.advance()
      compare(service.calls,1)
      service.jobs=[{id:"second",conversationId:"chat",messageId:"m1",accountId:service.activeAccountId,state:"running",created:2}]
      service.agentStarting=false
      queue.advance()
      compare(queue.messages.length,1)
      compare(queue.messages[0],"Third question")
      service.jobs=[{id:"second",conversationId:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:2}]
      queue.advance()
      compare(service.parentId,"second")
      compare(service.calls,2)
    }
    function test_pending_during_startup_waits_for_the_new_turn() {
      popup.openCenteredFor("m1","Mail")
      verify(popup.submit("Initial question"))
      verify(popup.submit("Follow up"))
      var queue=findChild(popup,"agent-pending-queue")
      queue.advance()
      compare(service.calls,1)
      service.agentStarting=false
      queue.advance()
      compare(service.calls,1)
      service.jobs=[{id:"initial",conversationId:"initial",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:1}]
      queue.advance()
      compare(service.calls,2)
      compare(service.parentId,"initial")
    }
    function test_pending_pauses_after_cancel_and_does_not_cross_context() {
      service.jobs=[{id:"first",conversationId:"chat",messageId:"m1",accountId:service.activeAccountId,state:"running",created:1}]
      popup.openCenteredFor("m1","Mail")
      verify(popup.submit("Keep this pending"))
      var queue=findChild(popup,"agent-pending-queue")
      verify(popup.interrupt())
      service.jobs=[{id:"first",conversationId:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:1}]
      queue.advance()
      compare(service.calls,0)
      popup.openCenteredFor("m2","Other mail")
      service.jobs=[{id:"other",conversationId:"other",messageId:"m2",accountId:service.activeAccountId,state:"done",canContinue:true,created:2}]
      queue.advance()
      compare(service.calls,0)
      compare(queue.messages[0],"Keep this pending")
      compare(popup.submit("Different conversation"),false)
      compare(queue.remove(0),"Keep this pending")
      compare(queue.busy,false)
    }
    function test_failed_pending_start_keeps_message_for_editing() {
      service.jobs=[{id:"first",messageId:"m1",accountId:service.activeAccountId,state:"running",created:1}]
      popup.openCenteredFor("m1","Mail")
      verify(popup.submit("Keep me"))
      var queue=findChild(popup,"agent-pending-queue")
      service.jobs=[{id:"first",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:1}]
      service.accept=false
      queue.advance()
      compare(queue.paused,true)
      compare(queue.messages[0],"Keep me")
      queue.advance()
      compare(service.calls,1)
    }
    function test_copy_appears_only_after_response_finishes() {
      service.jobs=[{id:"reply",messageId:"m1",accountId:service.activeAccountId,state:"running"}]
      popup.openCenteredFor("m1","Mail")
      service.agentShownTranscript=[{role:"assistant",text:"Partial reply"}]
      verify(waitForRendering(popup))
      compare(findChild(popup,"agent-copy-reply").visible,false)
      service.jobs=[{id:"reply",messageId:"m1",accountId:service.activeAccountId,state:"done"}]
      compare(findChild(popup,"agent-copy-reply").visible,true)
    }
    function test_working_status_elapsed_and_interrupt() {
      service.jobs=[{id:"active",messageId:"m1",accountId:service.activeAccountId,state:"running",created:100,progress:"Reading supplied context"}]
      popup.openCenteredFor("m1","Mail")
      popup.statusNow=2580000
      var status=findChild(popup,"agent-chat-status")
      verify(status.text.indexOf("• Working (41m 20s • Esc to interrupt • / show commands)") === 0)
      verify(status.text.indexOf("Reading supplied context") > 0)
      verify(popup.interrupt())
      compare(service.cancelledId,"active")
      compare(popup.opened,true)
    }
    function test_input_starts_one_line_and_grows_for_newlines() {
      popup.openCenteredFor("m1", "Mail")
      var field=findChild(popup,"agent-prompt-field")
      field.text="One line"
      verify(waitForRendering(popup))
      var single=field.parent.height
      field.text="One line\nSecond line\nThird line"
      verify(waitForRendering(popup))
      verify(field.parent.height > single)
      field.text=""
      verify(waitForRendering(popup))
      compare(field.parent.height,single)
    }
    function test_history_selects_contextual_conversation() {
      service.jobs=[{id:"old",conversationId:"old",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:1},
        {id:"new",conversationId:"new",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:2}]
      popup.openCenteredFor("m1","Mail")
      popup.showHistory()
      compare(popup.historyMode,true)
      compare(popup.historyJobs.length,2)
      popup.selectHistory("old")
      compare(popup.historyMode,false)
      compare(popup.job.id,"old")
      compare(service.agentShownId,"old")
      verify(popup.submit("Continue older chat"))
      compare(service.parentId,"old")
    }
    function test_history_continuation_does_not_switch_to_other_running_chat() {
      var other={id:"other",conversationId:"other",messageId:"m1",accountId:service.activeAccountId,state:"running",created:2}
      service.jobs=[{id:"old",conversationId:"old",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:1},other]
      popup.openCenteredFor("m1","Mail")
      popup.selectHistory("old")
      verify(popup.submit("Continue this chat"))
      service.agentStarting=false
      service.jobs=[other,{id:"child",conversationId:"old",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true,created:3}]
      compare(popup.job.id,"child")
      compare(service.agentShownId,"child")
      compare(findChild(popup,"agent-prompt-field").text,"")
    }
    function test_chat_continues_same_job_and_clears_sent_prompt() {
      service.jobs=[{id:"first",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.openCenteredFor("m1","Mail")
      service.agentShownTranscript=[{role:"user",text:"Explain"},{role:"assistant",text:"A reply"}]
      compare(popup.conversation.length,2)
      verify(popup.submit("Make it shorter"))
      compare(service.parentId,"first")
      service.jobs=[{id:"second",messageId:"m1",accountId:service.activeAccountId,state:"running",created:2}]
      compare(findChild(popup,"agent-prompt-field").text,"")
      compare(popup.working,true)
    }
    function test_new_chat_reloads_changed_draft_and_old_session_cannot_continue() {
      popup.composer=draft
      service.jobs=[{id:"old",kind:"draft",draftKey:"d1",accountId:service.activeAccountId,state:"done"}]
      popup.open()
      compare(popup.submit("Follow up"),false)
      compare(service.calls,0)
      popup.newChat()
      compare(popup.job,null)
      verify(popup.submit("Review current draft"))
      compare(service.parentId,"")
      compare(service.calls,1)
    }
    function test_chat_input_stays_below_the_conversation() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.openCenteredFor("m1","Mail")
      service.agentShownTranscript=[{role:"user",text:"Question"},{role:"status",text:"Reading supplied context"},{role:"assistant",text:"Answer"}]
      verify(waitForRendering(popup))
      var field=findChild(popup,"agent-prompt-field")
      var reply=findChild(popup,"agent-result")
      verify(field.mapToItem(popup,0,0).y > reply.mapToItem(popup,0,0).y + reply.height)
      verify(field.mapToItem(popup,0,0).y + field.height <= popup.height)
      compare(popup.conversation[1].role,"status")
    }
    function test_return_cannot_submit_while_starting() {
      popup.openCenteredFor("m1","Mail")
      tryCompare(popup,"opened",true)
      verify(popup.submit("First"))
      var field=findChild(popup,"agent-prompt-field")
      field.forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(service.calls,1)
      verify(popup.submit("Second"))
      compare(findChild(popup,"agent-pending-queue").messages.length,1)
    }
    function test_rejected_request_stays_open_with_prompt() {
      service.accept=false
      popup.openCenteredFor("m1","Mail")
      tryCompare(popup,"opened",true)
      compare(popup.submit("Keep my question"),false)
      verify(popup.errorText.length>0)
      compare(findChild(popup,"agent-prompt-field").text,"Keep my question")
      compare(popup.opened,true)
    }
    function test_full_plaintext_result_and_draft_identity() {
      popup.composer=draft
      popup.open()
      tryCompare(popup,"opened",true)
      service.jobs=[{id:"j1",accountId:service.activeAccountId,draftKey:"d1",kind:"draft",state:"running",resultReady:true,draftFingerprint:Agent.draftFingerprint(draft.fields)}]
      service.agentShownOutput="<b>Plain text</b>\n" + Array(100).join("Whole answer\n")
      var result = findChild(popup,"agent-result")
      compare(result.getText(0, result.length).replace(/[\u2028\u2029]/g, "\n"), service.agentShownOutput.replace(/\s+$/, ""))
      verify(popup.applyAnswer(false))
      compare(draft.applied,service.agentShownOutput)
      draft.fields={accountId:service.activeAccountId,draftKey:"d2",body:"Different"}
      tryCompare(popup,"opened",false)
      draft.applied=""
      compare(popup.applyAnswer(true),false)
      compare(draft.applied,"")
    }
    function test_one_checked_message_submits_its_id() {
      popup.openForSelection(["only"],0,0)
      tryCompare(popup,"opened",true)
      verify(popup.submit("Explain"))
      compare(service.requestedId,"only")
    }

    function test_selection_does_not_show_single_message_result() {
      service.jobs=[{id:"old",messageId:"m1",accountId:service.activeAccountId,state:"running"}]
      popup.openForSelection(["m1","m2"],0,0)
      tryCompare(popup,"opened",true)
      compare(popup.job,null)
      compare(popup.working,false)
      verify(popup.submit("Compare both"))
    }

    function test_switching_result_while_reading_retries_latest_id() {
      runnerBackend.requests=[]
      runner.show("one")
      compare(runnerBackend.requests.length,1)
      compare(runnerBackend.requests[0].method,"agent.jobShow")
      runner.show("two")
      runnerBackend.requests[0].callback({job:{id:"one"},output:"Old",transcript:[]}, "")
      compare(runnerBackend.requests[1].params.id,"two")
      compare(runner.showing,true)
      compare(runner.shownOutput,"")
      runnerBackend.requests[1].callback({job:{id:"two"},output:"Latest",transcript:[]}, "")
      compare(runner.shownOutput,"Latest")
    }
  }
}
