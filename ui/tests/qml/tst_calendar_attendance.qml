import QtQuick
import QtTest
import "../../account"

TestCase {
  name: "CalendarAttendance"
  QtObject {
    id: backend
    property bool ready: true
    property int apiVersion: 6
    property var calls: []
    property var callback: null
    function call(method, params, done) {
      calls = calls.concat([{ method: method, params: params }])
      callback = done
    }
  }
  QtObject {
    id: owner
    property var backend: null
    property bool ready: true
    property bool rsvpSending: false
    property bool canRespondToInvite: true
    property string providerId: "gmail"
    property string accountId: "me@example.org"
    property string selectedId: "mail-1"
    property string receivedAsAddress: "me@example.org"
    property string receivedAsName: "Synthetic owner"
    property string ownAddress: "me@example.org"
    property var selectedMessage: ({messageId:"synthetic-message",threadId:"synthetic-thread"})
    property var sent: []
    property var api: ({sendMessage:function(payload, callback) {
      owner.sent = owner.sent.concat([payload])
      callback({}, null)
    }})
    property var selectedInvite: ({ uid: "meeting", recurrenceIdMs: 0, organizer: { email: "organizer@example.test" } })
    property string notice: ""
    property string failure: ""
    property var selectedBody: ({text:"Invitation",source:"plain"})
    property var selectedAttachments: []
    property var selectedImages: []
    property var selectedUnsubscribe: null
    property var bodies: ({put:function(id, value) { owner.cachedInvite = value.invite }})
    property var cachedInvite: null
    function clearNotice() { notice = "" }
    function note(text) { notice = text }
    function fail(text) { failure = text }
  }
  Rsvp { id: action; account: owner }

  function init() {
    owner.backend = backend
    backend.calls = []
    backend.callback = null
    backend.apiVersion = 6
    owner.rsvpSending = false
    owner.selectedId = "mail-1"
    owner.selectedInvite = { uid: "meeting", recurrenceIdMs: 0, organizer: { email: "organizer@example.test" } }
    owner.notice = ""
    owner.failure = ""
    owner.cachedInvite = null
    owner.sent = []
    action.fallbackMessageId = ""
  }

  function test_refusal_does_not_fall_back_to_a_reply_email() {
    action.run("accepted")
    compare(backend.calls.length, 1)
    compare(backend.calls[0].method, "calendar.attendance")
    compare(backend.calls[0].params.response, "accepted")
    verify(owner.rsvpSending)
    backend.callback(null, { message: "calendar_invitation_not_found" })
    verify(!owner.rsvpSending)
    verify(owner.failure !== "")
    compare(owner.notice, "")
  }

  function test_request_names_the_invitation_organizer() {
    action.run("accepted")
    compare(backend.calls[0].params.organizer, "organizer@example.test")
  }

  function test_invitation_without_organizer_makes_no_request() {
    owner.selectedInvite = { uid: "meeting", recurrenceIdMs: 0 }
    action.run("accepted")
    action.reconcile()
    compare(backend.calls.length, 0)
    verify(owner.failure !== "")
  }

  function test_organizer_mismatch_exposes_only_explicit_mail_fallback() {
    action.run("declined")
    backend.callback(null, { message: "calendar_organizer_mismatch" })
    verify(action.fallbackAvailable)
    compare(owner.cachedInvite, null)
    compare(owner.notice, "")
  }

  function test_old_backend_is_refused_before_request() {
    backend.apiVersion = 5
    action.run("TENTATIVE")
    compare(backend.calls.length, 0)
    verify(owner.failure !== "")
    compare(owner.sent.length, 0, "a native response must not silently become an email")
  }

  function test_old_backend_offers_an_explicit_email_only_reply() {
    backend.apiVersion = 5
    owner.selectedInvite = {uid:"meeting",summary:"Synthetic meeting",
      organizer:{email:"organizer@example.test"},attendees:[]}
    verify(action.fallbackAvailable)
    action.run("accepted", true)
    compare(backend.calls.length, 0)
    compare(owner.sent.length, 1)
    compare(owner.notice, "Reply email sent; Calendar attendance is not confirmed")
    compare(owner.cachedInvite, null)
    compare(owner.selectedInvite.attendees.length, 0)
    backend.apiVersion = 6
    verify(!action.fallbackAvailable)
  }

  function test_success_is_cached_only_after_readback_confirmation() {
    action.run("accepted")
    compare(owner.cachedInvite, null)
    backend.callback({response:"accepted"}, null)
    verify(owner.cachedInvite !== null)
    compare(owner.cachedInvite.attendees[0].partstat, "ACCEPTED")
  }

  function test_unmatched_invitation_exposes_only_explicit_mail_fallback() {
    action.run("tentative")
    backend.callback(null, {message:"calendar_invitation_not_found"})
    verify(action.fallbackAvailable)
    compare(owner.cachedInvite, null)
    owner.selectedId = "different-mail"
    verify(!action.fallbackAvailable)
  }

  function test_occurrence_uses_original_date_and_late_result_does_not_replace_new_mail() {
    owner.selectedInvite = { uid: "meeting", recurrenceIdMs: Date.UTC(2026, 9, 1),
      organizer: { email: "organizer@example.test" },
      source: { recurrenceId: "RECURRENCE-ID;VALUE=DATE:20261001" } }
    action.run("DECLINED")
    compare(backend.calls[0].params.originalStart, "2026-10-01")
    owner.selectedId = "mail-2"
    backend.callback({ response: "declined" }, null)
    compare(owner.selectedInvite.uid, "meeting")
    verify(owner.notice !== "")
  }
}
