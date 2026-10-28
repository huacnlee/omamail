import QtQuick
import QtTest
import "../../account"
import "../../message/Calendar.js" as Calendar

TestCase {
  name: "InvitationCalendar"
  QtObject {
    id: platform
    property var settings: ({})
  }
  QtObject {
    id: backend
    property bool ready: true
    property int apiVersion: 9
    property var calls: []
    property var callback: null
    function call(method, params, done) { calls = calls.concat([{method:method,params:params}]); callback = done }
  }
  QtObject {
    id: owner
    property var backend: null
    property var platform: null
    property bool ready: true
    property bool rsvpSending: false
    property bool canRespondToInvite: true
    property string providerId: "imap"
    property string accountId: "imap:me@example.org"
    property string selectedId: "1:INBOX"
    property string receivedAsAddress: "alias@example.org"
    property string receivedAsName: "Synthetic guest"
    property string ownAddress: "me@example.org"
    property var selectedMessage: ({messageId:"message",threadId:"thread"})
    property var selectedInvite: null
    property var selectedBody: ({text:"Invite",source:"plain"})
    property var selectedAttachments: []
    property var selectedImages: []
    property var selectedUnsubscribe: null
    property var cached: null
    property var bodies: ({put:function(id, value) { owner.cached = {id:id,body:value} }})
    property var sent: []
    property var sendError: null
    property bool deferSend: false
    property var sendCallback: null
    property var api: ({sendMessage:function(payload, done) { owner.sent = owner.sent.concat([payload]); if (owner.deferSend) owner.sendCallback = done; else done({},owner.sendError) }})
    function clearNotice() {}
    function note(text) {}
    function fail(text) {}
  }
  Rsvp { id: action; account: owner }
  function init() {
    owner.backend = backend
    owner.platform = platform
    platform.settings = {invitationCalendars:{"imap:me@example.org":{id:"google:work",name:"Work",kind:"google",accountId:"calendar@example.org",calendarId:"work"}}}
    backend.calls = []; backend.callback = null; backend.apiVersion = 9
    action.calendarSaving = false; action.calendarMessage = ""; action.calendarDone = false
    owner.sent = []; owner.sendError = null; owner.selectedId = "1:INBOX"; owner.rsvpSending = false
    owner.cached = null; owner.deferSend = false; owner.sendCallback = null
    owner.selectedInvite = {uid:"meeting",organizer:{email:"host@example.org"},summary:"Synthetic meeting",sequence:1,
      attendees:[{email:"alias@example.org",partstat:"NEEDS-ACTION"}],
      start:{ms:Date.UTC(2026,9,27,10),resolved:true},end:{ms:Date.UTC(2026,9,27,11),resolved:true}}
  }
  function test_yes_replies_as_invited_alias_then_imports_to_selected_calendar() {
    action.run("accepted")
    compare(owner.sent.length,1)
    compare(backend.calls.length,1)
    compare(backend.calls[0].method,"calendar.saveInvitation")
    compare(backend.calls[0].params.source.accountId,"calendar@example.org")
    compare(backend.calls[0].params.mailbox,"imap:me@example.org")
    compare(backend.calls[0].params.response,"accepted")
    compare(Calendar.responseOf(owner.selectedInvite,"alias@example.org"),"accepted")
    backend.callback({status:"saved"},null)
    compare(action.calendarMessage,"Saved to calendar")
    verify(!action.calendarState.canSave)
  }
  function test_failed_save_can_retry_without_another_email() {
    action.run("tentative")
    backend.callback(null,{message:"calendar_network_failed"})
    verify(action.calendarState.canSave)
    verify(action.calendarMessage.indexOf("Not saved") === 0)
    action.retryCalendar()
    compare(owner.sent.length,1)
    compare(backend.calls.length,2)
    compare(backend.calls[1].params.response,"tentative")
  }
  function test_failed_reply_does_not_save_or_claim_attendance() {
    owner.sendError = "smtp_failed"
    action.run("accepted")
    compare(backend.calls.length,0)
    compare(Calendar.responseOf(owner.selectedInvite,"alias@example.org"),"")
  }
  function test_opt_out_and_old_backend_never_import() {
    platform.settings = {}
    action.run("accepted")
    compare(backend.calls.length,0)
    init()
    backend.apiVersion = 8
    action.run("accepted")
    compare(owner.sent.length,1)
    compare(backend.calls.length,0)
    verify(!action.calendarState.canSave)
  }
  function test_cancellation_removes_only_on_explicit_action_and_sends_no_reply() {
    owner.selectedInvite = {uid:"meeting",method:"CANCEL",sequence:2,organizer:{email:"host@example.org"}}
    wait(1)
    compare(backend.calls.length,0)
    action.retryCalendar()
    compare(backend.calls.length,1)
    compare(backend.calls[0].params.response,"cancelled")
    compare(owner.sent.length,0)
  }
  function test_late_save_result_does_not_label_a_different_message() {
    action.run("accepted")
    owner.selectedId = "2:INBOX"
    backend.callback({status:"saved"},null)
    compare(action.calendarMessage,"")
  }
  function test_reply_finishing_after_navigation_keeps_answer_for_calendar_only_retry() {
    owner.deferSend = true
    action.run("accepted")
    owner.selectedId = "2:INBOX"
    owner.selectedInvite = {uid:"other",organizer:{email:"other@example.org"}}
    owner.sendCallback({},null)
    compare(owner.selectedInvite.uid,"other")
    compare(owner.cached.id,"1:INBOX")
    compare(Calendar.responseOf(owner.cached.body.invite,"alias@example.org"),"accepted")
    compare(backend.calls[0].params.uid,"meeting")
    backend.callback(null,{message:"calendar_network_failed"})
    owner.selectedId = "1:INBOX"
    owner.selectedInvite = owner.cached.body.invite
    action.retryCalendar()
    compare(owner.sent.length,1)
    compare(backend.calls.length,2)
  }
}
