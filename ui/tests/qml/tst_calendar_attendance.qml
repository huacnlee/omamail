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
    property var selectedInvite: ({ uid: "meeting", recurrenceIdMs: 0 })
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
    owner.selectedInvite = { uid: "meeting", recurrenceIdMs: 0 }
    owner.notice = ""
    owner.failure = ""
    owner.cachedInvite = null
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

  function test_old_backend_is_refused_before_request() {
    backend.apiVersion = 5
    action.run("TENTATIVE")
    compare(backend.calls.length, 0)
    verify(owner.failure !== "")
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
      source: { recurrenceId: "RECURRENCE-ID;VALUE=DATE:20261001" } }
    action.run("DECLINED")
    compare(backend.calls[0].params.originalStart, "2026-10-01")
    owner.selectedId = "mail-2"
    backend.callback({ response: "declined" }, null)
    compare(owner.selectedInvite.uid, "meeting")
    verify(owner.notice !== "")
  }
}
