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
    property bool backendCanAgentProposals: true
    property bool agentStarting: false
    property string agentError: ""
    property string activeAccountId: "imap:ada@example.com"
    property string agentShownId: ""
    property string agentShownOutput: ""
    property var agentShownTranscript: []
    property var agentShownProposals: []
    property var sentEnvelope: null
    function send(envelope) { sentEnvelope = envelope; return "synthetic-send" }
    function sendAgentProposal(id, envelope) { return send(envelope) }
    function agentReplyEnvelope(proposal) {
      return {accountId:proposal.accountId,from:"ada@example.com",to:"bob@example.com",cc:"",bcc:"",
        subject:proposal.subject,body:proposal.body,attachments:[],threadId:"thread",inReplyTo:"message"}
    }
    property string parentId: ""
    property string cancelledId: ""
    function cancelAgentJob(id) { cancelledId=id; return true }
    property var jobs: []
    readonly property var agentAllJobs: jobs
    property bool accept: true
    property int calls: 0
    property int diagnoses: 0
    property int agentSelectionRevision: 0
    property bool selectionOwnsJobs: true
    function canContinueAgentJob(job) { return selectionOwnsJobs }
    function diagnoseError() { diagnoses++ }
    property bool agentHasEarlier: false
    property bool agentLoadingEarlier: false
    property int earlierRequests: 0
    function loadEarlierAgentMessages() { earlierRequests++; agentLoadingEarlier = true }
    function agentProposalQueue(accountId) { return deliveryQueue }
    property string requestedId: ""
    property string requestedPrompt: ""
    property var requestedDraft: null
    function agentJobFor(id, account) { return Oracle.selectionJob(jobs,[id],account) }
    function agentSelectionJob(ids, account) { return Oracle.selectionJob(jobs,ids,account) }
    function agentHistoryFor(fields, ids, account) { return Oracle.historyFor(jobs, fields ? fields.accountId : account, ids, fields ? fields.draftKey : "") }
    function agentJobsForDraft(fields) { return Oracle.draftJobs(jobs,fields.accountId,fields.draftKey) }
    function showAgentJob(id) { agentShownId=id }
    function acknowledgeAgentJob(id) {}
    function askAgent(id, prompt, account) { requestedId=id; requestedPrompt=prompt; calls++; if (accept) agentStarting=true; return accept }
    function answerAgent(id, prompt, fields) { parentId=id; requestedDraft=fields || null; calls++; if (!accept) return false; agentStarting=true;return true }
    function askAgentMany(ids, prompt, account) { return askAgent(ids[0],prompt,account) }
    function askAgentDraft(fields, prompt) { return askAgent("",prompt,fields.accountId) }
  }
  QtObject {
    id: deliveryQueue
    property var deliveryStates: ({})
    property bool undoBusy: false
    function watchDelivery(id) {}
  }
  QtObject {
    id: draft
    property var fields: ({accountId:"imap:ada@example.com",draftKey:"d1",body:"Original",subject:"Plan"})
    property string applied: ""
    property string agentParentJobId: ""
    function currentFields() { return fields }
    function insertAtCursor(text) { applied=text }
    function replaceBody(text) { applied=text }
  }
  C.AgentPrompt {
    id: popup
    service: service
    proposalComposer: QtObject {
      function sendProposal(envelope, id, parentId) { return service.sendAgentProposal(id, envelope) }
    }
    onFocusRequested: takeFocus()
    textColor: Qt.rgba(0.93,0.93,0.93,1); accentColor: Qt.rgba(0.66,0.8,0.93,1); urgentColor: Qt.rgba(0.93,0.66,0.66,1); dimColor: Qt.rgba(0.6,0.6,0.6,1)
    popupBackgroundColor: Qt.rgba(0.13,0.13,0.13,1); popupBorderColor: Qt.rgba(0.26,0.26,0.26,1); panelFontFamily: "monospace"
  }
  QtObject {
    id: runnerBackend
    property bool ready: true
    property int apiVersion: 6
    property var requests: []
    function call(method, params, callback) {
      if (method === "agent.providerStatus") { callback({available:true,provider:params.provider || "claude"}, ""); return }
      requests=requests.concat([{method:method,params:params,callback:callback}])
    }
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
      service.requestedDraft=null
      service.selectionOwnsJobs=true
      service.agentHasEarlier=false;service.agentLoadingEarlier=false;service.earlierRequests=0
      deliveryQueue.deliveryStates=({})
      draft.agentParentJobId=""
      service.agentShownProposals=[];service.sentEnvelope=null;popup.sentProposals=({})
      popup.ignoredJobId="";popup.submittedPrompt="";popup.viewedJobId="";popup.viewedConversationId="";popup.historyMode=false
      draft.fields={accountId:service.activeAccountId,draftKey:"d1",body:"Original",subject:"Plan"}
    }
    function test_proposal_send_uses_displayed_snapshot_and_cannot_double_send() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.openCenteredFor("m1","Mail")
      var proposal={id:"proposal",jobId:"chat",accountId:service.activeAccountId,messageId:"m1",
        draftKey:"",subject:"Re: Hello",body:"Exact displayed body <img src='http://invalid.example'>",applicable:true}
      proposal.envelope=service.agentReplyEnvelope(proposal)
      proposal.envelope.from='Ada <ada@example.com>'
      proposal.envelope.to='"李 <img>" <bob@example.com>'
      proposal.envelope.cc='cc@example.com'
      proposal.envelope.bcc='bcc@example.com'
      proposal.envelope.replyTo='replies@example.com'
      service.agentShownProposals=[proposal]
      verify(waitForRendering(popup))
      verify(findChild(popup,"agent-draft-proposal")!==null)
      var recipients=findChild(popup,"agent-proposal-recipients")
      compare(recipients.textFormat,Text.PlainText)
      compare(recipients.text,'From: Ada <ada@example.com>\nTo: "李 <img>" <bob@example.com>\nCc: cc@example.com\nBcc: bcc@example.com\nReply-To: replies@example.com')
      var displayed=JSON.parse(JSON.stringify(proposal.envelope))
      displayed.subject=proposal.subject;displayed.body=proposal.body
      verify(popup.useProposal(proposal,true))
      compare(service.sentEnvelope,displayed)
      compare(service.sentEnvelope.body,proposal.body)
      compare(service.sentEnvelope.to,proposal.envelope.to)
      compare(popup.useProposal(proposal,true),false)
    }
    function test_reply_card_keeps_history_out_of_preview_and_adds_it_on_send() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.openCenteredFor("m1","Mail")
      var proposal={id:"reply",jobId:"chat",accountId:service.activeAccountId,messageId:"m1",
        draftKey:"",subject:"Re: Hello",body:"Thursday works.\n\nAda",applicable:true}
      proposal.envelope=service.agentReplyEnvelope(proposal)
      proposal.envelope.replyQuote="On Monday, Bob wrote:\n> Is Thursday good?"
      service.agentShownProposals=[proposal]
      verify(waitForRendering(popup))
      compare(findChild(popup,"agent-proposal-body").text,proposal.body)
      verify(popup.useProposal(proposal,true))
      compare(service.sentEnvelope.body,proposal.body+"\n\n"+proposal.envelope.replyQuote)
      compare(service.sentEnvelope.threadId,"thread")
      compare(service.agentShownProposals[0].body,proposal.body)
    }
    function test_incomplete_proposal_cannot_apply_or_send() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"running"}]
      popup.openCenteredFor("m1","Mail")
      var proposal={id:"proposal",jobId:"chat",accountId:service.activeAccountId,messageId:"m1",draftKey:"",
        subject:"Hello",body:"Incomplete turn",applicable:false}
      proposal.envelope=service.agentReplyEnvelope(proposal)
      service.agentShownProposals=[proposal]
      compare(popup.useProposal(proposal,true),false)
      compare(popup.useProposal(proposal,false),false)
      compare(service.sentEnvelope,null)
    }
    function test_second_reply_draft_does_not_inherit_first_draft_chat() {
      popup.composer=draft
      draft.fields={accountId:service.activeAccountId,draftKey:"d1",replyMessageId:"m1",body:"First"}
      service.jobs=[{id:"chat",messageId:"m1",draftKey:"",accountId:service.activeAccountId,state:"done",canContinue:true}]
      compare(popup.defaultJob.id,"chat")
      service.jobs=[{id:"chat",messageId:"m1",draftKey:"d1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      compare(popup.defaultJob.id,"chat")
      draft.fields={accountId:service.activeAccountId,draftKey:"d2",replyMessageId:"m1",body:"Second"}
      draft.agentParentJobId="chat"
      compare(popup.defaultJob,null)
      popup.open()
      verify(popup.submit("Revise second draft",true))
      compare(service.parentId,"");compare(service.calls,1)
    }
    function test_followup_captures_manual_edits_only_when_submitted() {
      popup.composer=draft
      service.jobs=[{id:"chat",kind:"draft",draftKey:"d1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.open()
      draft.fields={accountId:service.activeAccountId,draftKey:"d1",body:"Manually edited",subject:"Updated"}
      compare(service.calls,0)
      verify(popup.submit("Use this version",true))
      compare(service.requestedDraft.body,"Manually edited")
      compare(service.requestedDraft.subject,"Updated")
    }
    function test_queued_followup_captures_draft_at_dispatch() {
      popup.composer=draft
      service.jobs=[{id:"chat",conversationId:"conversation",kind:"draft",draftKey:"d1",accountId:service.activeAccountId,state:"running"}]
      popup.open()
      verify(popup.submit("Revise when finished",true))
      compare(service.calls,0)
      draft.fields={accountId:service.activeAccountId,draftKey:"d1",body:"Edited while waiting",subject:"Updated"}
      service.jobs=[{id:"chat",conversationId:"conversation",kind:"draft",draftKey:"d1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      findChild(popup,"agent-pending-queue").advance()
      compare(service.calls,1)
      compare(service.requestedDraft.body,"Edited while waiting")
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

    function test_history_pages_prepend_once_and_survive_stream_refresh() {
      runnerBackend.requests=[]
      runner.show("paged-chat")
      var request=runnerBackend.requests[runnerBackend.requests.length-1]
      request.callback({job:{id:"paged-chat"},output:"New",transcript:[{role:"assistant",text:"New"}],
        proposals:[{id:"new-card",afterTurn:1}],previous:"older"},null)
      verify(runner.loadEarlier())
      request=runnerBackend.requests[runnerBackend.requests.length-1]
      compare(request.params.before,"older")
      request.callback({job:{id:"paged-chat"},transcript:[{role:"user",text:"Old question"},{role:"assistant",text:"Old answer"}],
        proposals:[{id:"old-card",afterTurn:2}],previous:""},null)
      compare(runner.shownTranscript.length,3)
      compare(runner.shownProposals[0].afterTurn,2)
      compare(runner.shownProposals[1].afterTurn,3)
      compare(runner.previousPage,"")
      runner.show("paged-chat")
      request=runnerBackend.requests[runnerBackend.requests.length-1]
      request.callback({job:{id:"paged-chat"},output:"Updated",transcript:[{role:"assistant",text:"Updated"}],
        proposals:[{id:"new-card",afterTurn:1}],previous:"older"},null)
      compare(runner.shownTranscript.length,3)
      compare(runner.shownTranscript[0].text,"Old question")
      compare(runner.shownTranscript[2].text,"Updated")
      compare(runner.previousPage,"")
      compare(runner.loadEarlier(),false)
    }

    function test_history_page_for_old_selection_cannot_enter_new_chat() {
      runnerBackend.requests=[]
      runner.show("old-page")
      runnerBackend.requests[runnerBackend.requests.length-1].callback({job:{id:"old-page"},transcript:[],previous:"older"},null)
      verify(runner.loadEarlier())
      var old=runnerBackend.requests[runnerBackend.requests.length-1]
      runner.show("new-page")
      runnerBackend.requests[runnerBackend.requests.length-1].callback({job:{id:"new-page"},transcript:[{role:"assistant",text:"New chat"}],previous:""},null)
      old.callback({job:{id:"old-page"},transcript:[{role:"assistant",text:"Wrong chat"}],previous:""},null)
      compare(runner.shownTranscript.length,1)
      compare(runner.shownTranscript[0].text,"New chat")
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
    function test_slash_text_is_submitted_literally() {
      popup.openCenteredFor("m1", "Mail")
      var field = findChild(popup, "agent-prompt-field")
      field.text = "/summarize this in my own words"
      compare(service.calls, 0)
      verify(popup.submitCurrent())
      compare(service.calls, 1)
      compare(service.requestedPrompt, "/summarize this in my own words")
    }
    function test_clear_starts_fresh_without_changing_draft_or_history() {
      popup.composer=draft
      service.jobs=[{id:"old",kind:"draft",draftKey:"d1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.open()
      service.agentShownTranscript=[{role:"user",text:"Old question"},{role:"assistant",text:"Old answer"}]
      var before=JSON.stringify(draft.fields)
      var field=findChild(popup,"agent-prompt-field")
      field.text=" /clear "
      verify(popup.submitCurrent())
      compare(popup.job,null)
      compare(popup.conversation.length,0)
      compare(field.text,"")
      compare(popup.opened,true)
      compare(JSON.stringify(draft.fields),before)
      compare(service.jobs.length,1)
      compare(service.calls,0)
      verify(popup.submit("A fresh question",true))
      compare(service.parentId,"")
      compare(service.calls,1)
    }
    function test_clear_during_response_is_not_sent_or_queued() {
      service.jobs=[{id:"running",messageId:"m1",accountId:service.activeAccountId,state:"running"}]
      popup.openCenteredFor("m1","Mail")
      var field=findChild(popup,"agent-prompt-field")
      field.text="/clear"
      compare(popup.submitCurrent(),false)
      compare(popup.job.id,"running")
      compare(field.text,"/clear")
      compare(service.calls,0)
      compare(findChild(popup,"agent-pending-queue").messages.length,0)
      verify(popup.localError.indexOf("Stop")>=0)
    }
    function test_slash_text_keeps_normal_editing_and_async_restore() {
      popup.openCenteredFor("m1", "Mail")
      var field = findChild(popup, "agent-prompt-field")
      field.text = "Please\n/sum"
      field.cursorPosition = field.length
      field.forceActiveFocus()
      keyClick(Qt.Key_Backspace)
      compare(field.text, "Please\n/su")
      service.accept = false
      compare(popup.submitCurrent(), false)
      compare(field.text, "Please\n/su")
      service.accept = true
      verify(popup.submitCurrent())
      service.agentStarting = false
      service.agentError = "Synthetic launch failure"
      compare(field.text, "Please\n/su")
    }
    function test_more_menu_and_full_width_input() {
      popup.openCenteredFor("m1", "Mail")
      verify(waitForRendering(popup))
      var field = findChild(popup, "agent-prompt-field")
      compare(findChild(popup, "agent-ask-button"), null)
      verify(field.width > popup.width - 40)
      var bottom = popup.height - field.mapToItem(popup, 0, field.height).y
      verify(bottom >= 10 && bottom <= 14, "bottom gap " + bottom)
      compare(findChild(popup, "agent-more-button"), null)
      compare(popup.opened, true)
    }
    function test_exact_commands_execute_and_partial_commands_complete() {
      popup.openCenteredFor("m1", "Mail")
      var field = findChild(popup, "agent-prompt-field")
      field.text = "/cl"
      verify(popup.chooseCommand())
      compare(field.text, "/clear ")
      field.text = "/clear"
      verify(popup.chooseCommand())
      compare(field.text, "")
      field.text = "/"
      popup.moveCommand(1)
      verify(popup.chooseCommand())
      compare(field.text, "/history ")
      verify(popup.submitCurrent())
      compare(popup.historyMode, true)
      compare(service.calls, 0)
    }
    function test_restart_keeps_unsent_input() {
      service.jobs=[{id:"ended",messageId:"m1",accountId:service.activeAccountId,state:"failed",canContinue:false}]
      popup.openCenteredFor("m1", "Mail")
      var field = findChild(popup, "agent-prompt-field")
      field.text = "Keep this follow-up"
      compare(popup.submitCurrent(), false)
      var restart = findChild(popup, "agent-restart-chat")
      verify(restart.visible)
      restart.clicked()
      compare(field.text, "Keep this follow-up")
      compare(popup.job, null)
      compare(service.calls, 0)
    }
    function test_agent_switch_clears_queue_preserves_input_and_archives_chat() {
      service.jobs=[{id:"old",messageId:"m1",accountId:service.activeAccountId,state:"running",canContinue:false}]
      popup.openCenteredFor("m1", "Mail")
      verify(popup.submit("Old queued question"))
      var field=findChild(popup,"agent-prompt-field")
      field.text="Unsent question"
      service.selectionOwnsJobs=false
      service.agentSelectionRevision++
      compare(field.text,"Unsent question")
      compare(findChild(popup,"agent-pending-queue").messages.length,0)
      compare(popup.job,null)
      compare(service.calls,0)
      service.jobs=[{id:"old",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.selectHistory("old")
      compare(popup.submitCurrent(),false)
      compare(service.calls,0)
    }
    function test_scroll_top_loads_once_and_preserves_position() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.openCenteredFor("m1", "Mail")
      service.agentShownTranscript=[{role:"assistant",text:Array(120).join("Visible conversation\n")}]
      service.agentHasEarlier=true
      verify(waitForRendering(popup))
      var scroll=findChild(popup,"agent-transcript-scroll")
      tryVerify(function() { return scroll.contentY > 24 })
      scroll.contentY=0
      compare(service.earlierRequests,1)
      var height=scroll.contentHeight
      compare(popup.loadEarlier(),false)
      service.agentShownTranscript=[{role:"assistant",text:"Earlier conversation\n"}].concat(service.agentShownTranscript)
      service.agentLoadingEarlier=false
      tryCompare(popup,"restoringEarlier",false)
      verify(Math.abs(scroll.contentY - (scroll.contentHeight-height)) < 2)
      compare(service.earlierRequests,1)
    }
    function test_delivery_card_tracks_receipt_and_allows_recovery() {
      service.jobs=[{id:"chat",messageId:"m1",accountId:service.activeAccountId,state:"done",canContinue:true}]
      popup.openCenteredFor("m1", "Mail")
      var proposal={id:"p",subject:"Subject",body:"Body",applicable:true,accountId:service.activeAccountId}
      proposal.envelope=service.agentReplyEnvelope(proposal)
      service.agentShownProposals=[proposal]
      verify(waitForRendering(popup))
      var send=findChild(popup,"agent-send-email")
      var edit=findChild(popup,"agent-apply-draft")
      deliveryQueue.deliveryStates=({"agent-p":"queued"})
      compare(send.text,"Queued for sending")
      compare(send.enabled,false)
      deliveryQueue.deliveryStates=({"agent-p":"sent"})
      compare(send.text,"Sent")
      deliveryQueue.deliveryStates=({"agent-p":"cancelled"})
      compare(send.text,"Send undone")
      compare(edit.enabled,true)
      compare(send.enabled,false)
      compare(service.calls,0)
    }
    function test_error_has_independent_diagnosis_entry() {
      service.diagnoses = 0
      service.agentError = "Could not confirm AI started."
      popup.openCenteredFor("m1", "Mail")
      var field = findChild(popup, "agent-prompt-field")
      field.text = "/diagnose"
      verify(popup.submitCurrent())
      compare(service.diagnoses, 1)
      compare(service.calls, 0)
      compare(field.text, "")
    }
    function test_reply_remains_selectable_without_copy_button() {
      service.jobs=[{id:"reply",messageId:"m1",accountId:service.activeAccountId,state:"done"}]
      popup.openCenteredFor("m1","Mail")
      service.agentShownTranscript=[{role:"assistant",text:"**Bold** and <b>literal</b>"}]
      verify(waitForRendering(popup))
      compare(findChild(popup,"agent-copy-reply"),null)
      compare(findChild(popup,"agent-result").selectByMouse,true)
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
      compare(findChild(popup,"agent-copy-reply"),null)
      service.jobs=[{id:"reply",messageId:"m1",accountId:service.activeAccountId,state:"done"}]
      compare(findChild(popup,"agent-copy-reply"),null)
    }
    function test_working_status_elapsed_and_interrupt() {
      service.jobs=[{id:"active",messageId:"m1",accountId:service.activeAccountId,state:"running",created:100,progress:"Reading supplied context"}]
      popup.openCenteredFor("m1","Mail")
      popup.statusNow=2580000
      var status=findChild(popup,"agent-chat-status")
      verify(status.text.indexOf("• Working (41m 20s • Esc to interrupt)") === 0)
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
