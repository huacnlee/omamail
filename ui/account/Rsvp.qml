import QtQuick
import "../message/Message.js" as Mail
import "../message/Calendar.js" as Calendar

// Answering an invitation is sending a mail, which is the whole reason this
// needs no calendar API, no second OAuth scope, and works the same on IMAP
// as on Gmail: an RFC 5546 REPLY addressed to the organiser is what every
// calendar server is already listening for. Not routed through the account's
// `send`: that one is the compose window's, and finishing emits `replySent`,
// which closes it. This finishes with a card that has changed its mind.
// Beside the account rather than in it, which is at its size ceiling; the
// state the reader draws (`rsvpSending`, `selectedResponse`) stays there.
QtObject {
  id: rsvpAction

  required property var account


  // Answering an invitation is sending a mail, which is the whole reason this
  // needs no calendar API, no second OAuth scope, and works the same on IMAP
  // as on Gmail: an RFC 5546 REPLY addressed to the organiser is what every
  // calendar server is already listening for.
  //
  // Not routed through `send`: that one is the compose window's, and finishing
  // emits `replySent`, which closes it. This finishes with a card that has
  // changed its mind.
  function run(response) {
    if (!account.ready || account.rsvpSending || !account.canRespondToInvite) return
    var answer = String(response || "")
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
    var summary = account.selectedMessage
    account.rsvpSending = true
    account.clearNotice()

    account.api.sendMessage(Mail.buildSendPayload({
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
    }), function(payload, error) {
      account.rsvpSending = false
      if (error) {
        account.fail(error)
        return
      }
      account.note("Answer sent to " + fields.to)
      if (account.selectedId !== messageId) return
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
    account.selectedInvite = updated
    account.bodies.put(messageId, ({
      text: account.selectedBody.text,
      source: account.selectedBody.source,
      html: "",
      attachments: account.selectedAttachments,
      images: account.selectedImages,
      invite: updated,
      unsubscribe: account.selectedUnsubscribe
    }))
  }
}
