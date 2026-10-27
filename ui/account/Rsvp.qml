import QtQuick
import "../message/Message.js" as Mail
import "../message/Calendar.js" as Calendar
import "../providers/Registry.js" as Provider
import "../calendar/Calendar.js" as Events
import "../calendar/Invitations.js" as Invitations
import "../backend/Plain.js" as Plain

// Native attendance is authoritative where the provider supports it. Other
// providers send an RFC 5546 reply through their mail transport.
// Beside the account rather than in it, which is at its size ceiling; the
// state the reader draws (`rsvpSending`, `selectedResponse`) stays there.
QtObject {
  id: rsvpAction

  required property var account
  property string reconciledKey: ""
  property bool reconciling: false
  property int attendanceRevision: 0
  property string fallbackMessageId: ""
  property bool calendarSaving: false
  property bool calendarDone: false
  property string calendarMessage: ""
  readonly property var destination: Provider.calendarAttendanceMethod(account.providerId) === ""
    ? Invitations.destination(account.platform ? account.platform.settings : null, account.accountId) : null
  readonly property bool calendarSupported: !!account.backend && account.backend.ready && account.backend.apiVersion >= 9
  onDestinationChanged: { calendarDone = false; calendarMessage = "" }
  readonly property var calendarState: ({
    visible: !!destination && !!account.selectedInvite,
    busy: calendarSaving,
    text: calendarMessage || (calendarSupported ? "Accepted invitations → " + String(destination && destination.name || "Google Calendar")
      : "Update the backend to save accepted invitations"),
    canSave: !!destination && calendarSupported && !calendarSaving && !calendarDone && !account.rsvpSending && !!account.selectedInvite
      && (Calendar.normalizedResponse(Calendar.responseOf(account.selectedInvite, account.receivedAsAddress)) !== ""
        || account.selectedInvite.method === "CANCEL" || account.selectedInvite.status === "CANCELLED")
  })
  readonly property bool fallbackAvailable: (fallbackMessageId !== "" && fallbackMessageId === account.selectedId)
    || (!!account.selectedInvite && account.selectedId !== ""
      && Provider.calendarAttendanceMethod(account.providerId) !== ""
      && !!account.backend && account.backend.ready
      && account.backend.apiVersion > 0 && account.backend.apiVersion < 6)
  property Connections selection: Connections {
    target: rsvpAction.account
    function onSelectedIdChanged() { rsvpAction.reconciledKey = ""; rsvpAction.attendanceRevision++; rsvpAction.fallbackMessageId = ""; rsvpAction.calendarMessage = ""; rsvpAction.calendarDone = false }
    function onSelectedInviteChanged() { rsvpAction.calendarDone = false; Qt.callLater(rsvpAction.reconcile) }
  }
  property Timer reconcileTimer: Timer {
    interval: 60000
    repeat: true
    running: !!account.selectedInvite && account.ready
    onTriggered: { rsvpAction.reconciledKey = ""; rsvpAction.reconcile() }
  }

  // The organizer travels with the UID because a UID alone is not proof: any
  // sender can reuse one, and the backend refuses a calendar copy whose
  // organizer is not the one this invitation names.
  function invitationParams(invited) {
    var organizer = Calendar.replyRecipient(invited)
    if (!organizer) return null
    var params = { accountId: account.accountId, uid: invited.uid, organizer: organizer }
    if (invited.recurrenceIdMs) {
      params.originalStart = new Date(invited.recurrenceIdMs).toISOString()
      var raw = String(invited.source && invited.source.recurrenceId || "")
      var day = /(?:^|;)VALUE=DATE(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})$/.exec(raw)
      if (day) params.originalStart = day[1] + "-" + day[2] + "-" + day[3]
    }
    return params
  }

  function reconcile() {
    var method = Provider.calendarAttendanceMethod(account.providerId)
    if (!method || !account.selectedInvite || !account.backend || !account.backend.ready
        || account.backend.apiVersion < 6 || reconciling || account.rsvpSending) return
    var invited = account.selectedInvite
    var id = account.selectedId
    var identity = account.accountId
    var revision = attendanceRevision
    var key = identity + "\n" + id + "\n" + invited.uid
    if (key === reconciledKey) return
    reconciledKey = key
    var params = invitationParams(invited)
    if (!params) return
    reconciling = true
    account.backend.call(method, params, function(result, error) {
      rsvpAction.reconciling = false
      if (identity !== account.accountId || id !== account.selectedId || account.rsvpSending
          || revision !== rsvpAction.attendanceRevision) return
      if (error || !result) return
      var updated = {}
      for (var field in invited) updated[field] = invited[field]
      if (result.cancelled) {
        updated.status = "CANCELLED"
        updated.method = "CANCEL"
      } else {
        var normalized = Events.eventsFromGoogle({ items: [result.event] }, "")
        if (!normalized.length) return
        var current = normalized[0]
        var keys = ["summary", "description", "location", "start", "end", "sequence", "status", "meetLink"]
        for (var i = 0; i < keys.length; i++) updated[keys[i]] = current[keys[i]]
        updated = Calendar.withResponse(updated, account.receivedAsAddress, String(result.response || "").toUpperCase())
        if (result.response === "needsAction") {
          updated.attendees = (updated.attendees || []).map(function(attendee) {
            if (String(attendee.email || "").toLowerCase() !== account.receivedAsAddress.toLowerCase()) return attendee
            var next = {}
            for (var key in attendee) next[key] = attendee[key]
            next.partstat = "NEEDS-ACTION"
            return next
          })
        }
      }
      rsvpAction.cacheInvite(id, updated)
    })
  }


  // Not routed through `send`: that one is the compose window's, and finishing
  // emits `replySent`, which closes it. This finishes with a card that has
  // changed its mind.
  function run(response, mailOnly) {
    if (!account.ready || account.rsvpSending || calendarSaving || !account.canRespondToInvite) return
    var answer = String(response || "")
    var method = Provider.calendarAttendanceMethod(account.providerId)
    if (mailOnly === true && !fallbackAvailable) return
    if (method !== "" && mailOnly !== true) {
      nativeAnswer(method, answer)
      return
    }
    // The alias the invitation was addressed to, not the account's primary
    // address: the ATTENDEE line has to name the person who was invited.
    var answeringAs = account.receivedAsAddress
    var answeringName = account.receivedAsName
    var fields = Calendar.replyFields(account.selectedInvite,
      ({ email: answeringAs, name: answeringName }), answer)
    if (!fields) {
      account.fail("This invitation names no organiser to answer")
      return
    }

    // The message the answer belongs to, held so a reply that lands after the
    // reader has moved on does not mark a different message answered.
    var messageId = account.selectedId
    var invited = account.selectedInvite
    var identity = account.accountId
    var target = destination ? Plain.plain(destination) : null
    var answeredBody = inviteBody(Calendar.withResponse(invited, answeringAs, answer))
    var summary = account.selectedMessage
    var payload = Mail.buildSendPayload({
      // The ATTENDEE line claims this address; the envelope has to agree, or a
      // strict organiser drops the reply as somebody answering for a third
      // party. Gmail fills a From in for itself, and the IMAP client puts the
      // account on the envelope rather than in the headers — so neither of
      // them would have written this one.
      from: answeringAs,
      fromName: answeringName,
      accountAddress: account.ownAddress,
      to: fields.to,
      subject: fields.subject,
      body: fields.body,
      calendar: fields.calendar,
      // Threaded with the invitation it answers, the way a calendar's own
      // reply is. An answer that starts a conversation of its own is one the
      // organiser reads as a second, unrelated mail.
      inReplyTo: summary ? summary.messageId : "",
      threadId: summary ? summary.threadId : ""
    })
    // Null when an address in it cannot be written into a header.
    if (!payload) {
      account.fail("An address in this answer cannot be written into a message")
      return
    }
    account.rsvpSending = true
    calendarDone = false
    account.clearNotice()

    account.api.sendMessage(payload, function(sent, error) {
      account.rsvpSending = false
      if (error) {
        account.fail(error)
        return
      }
      account.note(mailOnly === true ? "Reply email sent; Calendar attendance is not confirmed" : "Answer sent to " + fields.to)
      if (mailOnly === true) return
      if (account.accountId !== identity) return
      account.bodies.put(messageId, answeredBody)
      if (account.selectedId === messageId) account.selectedInvite = answeredBody.invite
      if (target) saveToCalendar(target, identity, messageId, invited, Calendar.normalizedResponse(answer))
    })
  }

  function retryCalendar() {
    if (!calendarState.canSave) return
    var invited = account.selectedInvite
    var response = invited.method === "CANCEL" || invited.status === "CANCELLED" ? "cancelled"
      : Calendar.normalizedResponse(Calendar.responseOf(invited, account.receivedAsAddress))
    saveToCalendar(Plain.plain(destination), account.accountId, account.selectedId, invited, response)
  }

  function saveToCalendar(target, identity, messageId, invited, response) {
    if (!calendarSupported || calendarSaving) {
      if (account.selectedId === messageId) calendarMessage = "Reply sent; update the backend to save to calendar"
      return
    }
    var params = Invitations.params(target, identity, invited, response)
    if (!params) {
      if (account.selectedId === messageId) calendarMessage = "Not saved: the invitation has incomplete dates or an unresolved time zone"
      return
    }
    calendarSaving = true
    if (account.selectedId === messageId) calendarMessage = "Saving to calendar…"
    account.backend.call("calendar.saveInvitation", params, function(result, error) {
      rsvpAction.calendarSaving = false
      if (!error && result && account.platform && typeof account.platform.invitationCalendarSaved === "function")
        account.platform.invitationCalendarSaved()
      if (identity !== account.accountId || messageId !== account.selectedId
          || !rsvpAction.destination || rsvpAction.destination.id !== target.id
          || !account.selectedInvite || account.selectedInvite.uid !== invited.uid
          || Number(account.selectedInvite.sequence || 0) !== Number(invited.sequence || 0)) return
      rsvpAction.calendarDone = !error && !!result
      rsvpAction.calendarMessage = error || !result
        ? "Not saved to calendar. Check calendar access, then retry; your reply will not be resent."
        : Invitations.outcome(result.status)
      if (error && error.message === "calendar_invitation_series_required")
        rsvpAction.calendarMessage = "Save the original series invitation before updating this occurrence"
    })
  }

  function nativeAnswer(method, answer) {
    attendanceRevision++
    if (!account.backend || !account.backend.ready || account.backend.apiVersion < 6) {
      account.fail("Update the backend to answer this invitation in Calendar")
      return
    }
    var response = Calendar.normalizedResponse(answer)
    if (!response) return
    var invited = account.selectedInvite
    var messageId = account.selectedId
    var identity = account.accountId
    var answeringAs = account.receivedAsAddress
    var params = invitationParams(invited)
    if (!params) {
      account.fail("This invitation names no organiser to answer")
      return
    }
    params.response = response
    account.rsvpSending = true
    account.clearNotice()
    account.backend.call(method, params, function(result, error) {
      account.rsvpSending = false
      if (identity !== account.accountId) return
      if (error || !result || result.response !== response) {
        if (error && (error.message === "calendar_invitation_not_found"
            || error.message === "calendar_organizer_mismatch") && account.selectedId === messageId)
          rsvpAction.fallbackMessageId = messageId
        account.fail("Calendar has not confirmed your answer. Refresh the invitation or open it in Calendar.")
        return
      }
      account.note("Attendance confirmed in Calendar")
      rsvpAction.fallbackMessageId = ""
      if (account.selectedId === messageId)
        rememberResponse(messageId, invited, answeringAs, answer)
    })
  }

  // The answer, written back into the copy of the invitation on disk.
  //
  // The `text/calendar` part is the organiser's document and this does not
  // rewrite it — but a message reopened tomorrow reading its own file would
  // otherwise show its buttons unanswered, after the answer had been sent and
  // had worked. Everything else in the row is what is already on screen, which
  // is what was cached a moment ago.
  function rememberResponse(messageId, invited, answeringAs, answer) {
    var updated = Calendar.withResponse(invited, answeringAs, answer)
    cacheInvite(messageId, updated)
  }

  function cacheInvite(messageId, updated) {
    account.selectedInvite = updated
    account.bodies.put(messageId, inviteBody(updated))
  }

  function inviteBody(updated) {
    return {
      text: account.selectedBody.text,
      source: account.selectedBody.source,
      html: "",
      attachments: account.selectedAttachments,
      images: account.selectedImages,
      invite: updated,
      unsubscribe: account.selectedUnsubscribe
    }
  }
}
