import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail

// A sign-in message opens with its code drawn large above the body, copied
// once by itself when the message is fresh, and copied again on request.
Item {
  id: top
  width: 900
  height: 600

  readonly property string codeBody: "Use this code to sign in to Example.\n\nVerification code: 482913\n\n"
    + "If you did not ask for it, ignore this message."

  function summaryFor(id, subject, date, extra) {
    var summary = {
      id: id,
      subject: subject,
      from: ({ display: "Example", email: "no-reply@example.com" }),
      to: [({ display: "Reader", email: "reader@example.com" })],
      fullTime: "6 November 2026",
      date: date,
      starred: false,
      inSpam: false
    }
    for (var key in (extra || {})) summary[key] = extra[key]
    return summary
  }

  QtObject {
    id: mailService

    property var copied: []

    property string selectedId: ""
    property var selectedMessage: null
    property bool detailLoading: false
    property bool detailPainted: false
    property bool selectedHasHtml: false
    property var selectedDocument: null
    property var selectedReaderDocument: null
    property bool selectedReaderTooHeavy: false
    property bool selectedReaderEmpty: true
    property int selectedRemoteImages: 0
    property int selectedReaderRemoteImages: 0
    property bool remoteImagesAllowed: false
    property bool selectedTooHeavy: false
    property string unsubscribeLabel: ""
    property string unsubscribeDetail: ""
    property bool unsubscribing: false
    property var selectedBody: ({ text: "", source: "" })
    property var selectedImages: []
    property var selectedInvite: null
    property string selectedResponse: ""
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: true
    property bool canOpenOnWeb: false
    property var selectedAttachments: []

    function getMessage() {}
    function showRemoteImages() {}
    property var argvCopied: []
    // false refuses to start; "fail" starts and then reports failure.
    property var copyAnswer: true
    function copySecretText(text, done) {
      if (copyAnswer === false) return false
      if (copyAnswer === "fail") { done(false); return true }
      copied = copied.concat([String(text)])
      done(true)
      return true
    }
    // The argv route every other copy takes. A code must never take it.
    function copyText(text) { argvCopied = argvCopied.concat([String(text)]); return true }
    function openExternal(url) { return true }
  }

  property int codeCopiedCount: 0

  Omamail.MessageReader {
    id: reader
    onCodeCopied: codeCopiedCount++
    width: 900
    height: 600
    service: mailService
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    linkColor: Qt.rgba(0.3, 0.7, 1, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    leadingBoundaryOverlap: 0
    dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    panelFontFamily: "monospace"
    bodyMode: "plain"
  }

  TestCase {
    name: "ReaderOtp"
    when: windowShown

    function named(item, name) {
      if (!item) return null
      if (item.objectName === name) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var hit = named(values[i], name)
        if (hit) return hit
      }
      return null
    }

    function card() {
      var found = named(reader, "otpCard")
      verify(found, "the reader owns a code card")
      return found
    }

    // What the account does when a message opens: the summary first, the
    // body after it, with the body painted flag between.
    function open(id, subject, body, date, extra) {
      mailService.detailPainted = false
      mailService.selectedBody = ({ text: "", source: "" })
      mailService.selectedId = id
      mailService.selectedMessage = summaryFor(id, subject, date, extra)
      mailService.selectedBody = ({ text: body, source: "plain" })
      mailService.detailPainted = true
      wait(0)
    }

    function init() {
      mailService.copied = []
      mailService.copyAnswer = true
      codeCopiedCount = 0
      mailService.argvCopied = []
      reader.otpCopiedKey = ""
      reader.otpAutoCopied = ({})
      mailService.selectedId = ""
      mailService.selectedMessage = null
      mailService.detailPainted = false
      wait(0)
    }

    function test_a_fresh_code_is_shown_and_copied_once() {
      open("m-1", "Your sign-in code", codeBody, new Date())
      verify(card().visible, "the card is up")
      compare(named(card(), "otpCode").text, "482913")
      tryCompare(mailService, "copied", ["482913"])
      verify(named(card(), "otpCopied").visible, "the card says the copy happened, in words")
      compare(mailService.argvCopied, [], "the code never travels in argv")

      // The same message rendered again is not a second copy.
      mailService.selectedBody = ({ text: codeBody + "\n", source: "plain" })
      wait(50)
      compare(mailService.copied, ["482913"])
    }

    function test_the_body_sits_below_the_card() {
      open("m-2", "Your sign-in code", codeBody, new Date())
      var body = null
      var kids = reader.children
      var flick = named(reader, "messageBodyScroller")
      verify(flick)
      var items = flick.contentItem.children
      for (var i = 0; i < items.length; i++)
        if (items[i].toString().indexOf("QQuickTextEdit") === 0) body = items[i]
      verify(body, "the body is a TextEdit")
      verify(body.y >= card().y + card().height, "the message starts under the code")
    }

    function test_an_old_code_is_shown_but_not_copied() {
      open("m-3", "Your sign-in code", codeBody, new Date(Date.now() - 2 * 60 * 60 * 1000))
      verify(card().visible)
      wait(50)
      compare(mailService.copied, [], "a code from hours ago is read, not used")
      verify(!named(card(), "otpCopied").visible)

      mouseClick(named(card(), "otpCopy"))
      compare(mailService.copied, ["482913"], "asking still copies it")
      verify(named(card(), "otpCopied").visible)
    }

    function test_the_key_copies_the_code() {
      open("m-4", "Your sign-in code", codeBody, new Date(0))
      verify(reader.copyCode(), "y copies what the card shows")
      compare(mailService.copied, ["482913"])
    }

    function test_spam_never_copies_by_itself() {
      open("m-5", "Your sign-in code", codeBody, new Date(), ({ inSpam: true }))
      verify(card().visible)
      wait(50)
      compare(mailService.copied, [])
    }

    function test_a_draft_or_promotion_has_no_card() {
      open("m-6", "Draft", codeBody, new Date(), ({ isDraft: true }))
      verify(!card().visible, "a draft is the owner's own words")
      open("m-7", "Summer sale", "Take 20% off. Use code SUMMER20 or 482913 at checkout.", new Date())
      verify(!card().visible)
      wait(50)
      compare(mailService.copied, [])
      verify(!reader.copyCode(), "the key has nothing to copy")
    }

    function test_nothing_before_the_body_is_painted() {
      mailService.selectedId = "m-8"
      mailService.selectedMessage = summaryFor("m-8", "Your code: 771204", new Date())
      mailService.detailPainted = false
      wait(50)
      verify(!card().visible, "the subject alone is not read before the body arrives")
      compare(mailService.copied, [])
    }

    function test_a_refused_copy_does_not_say_copied() {
      mailService.copyAnswer = false
      open("m-9", "Your sign-in code", codeBody, new Date())
      wait(50)
      verify(card().visible)
      verify(!named(card(), "otpCopied").visible)
      compare(codeCopiedCount, 0)
    }

    // The process started, and wl-copy then failed: no display, no binary.
    function test_a_failed_copy_does_not_say_copied() {
      mailService.copyAnswer = "fail"
      open("m-12", "Your sign-in code", codeBody, new Date(0))
      verify(reader.copyCode(), "the copy started")
      verify(!named(card(), "otpCopied").visible, "but nothing says it arrived")
      compare(codeCopiedCount, 0)
    }

    function test_the_window_is_told_about_a_copy() {
      open("m-13", "Your sign-in code", codeBody, new Date())
      tryCompare(top, "codeCopiedCount", 1)
    }

    // Back and forth between two fresh code mails copies each once; coming
    // back to the first neither copies it again nor claims it is still there.
    function test_returning_to_a_message_does_not_copy_again() {
      open("m-14", "Your sign-in code", codeBody, new Date())
      tryCompare(mailService, "copied", ["482913"])
      open("m-15", "Your sign-in code", codeBody.replace("482913", "771204"), new Date())
      tryCompare(mailService, "copied", ["482913", "771204"])
      open("m-14", "Your sign-in code", codeBody, new Date())
      wait(50)
      compare(mailService.copied, ["482913", "771204"])
      verify(!named(card(), "otpCopied").visible, "something else was copied since")
    }

    function test_a_hidden_reader_does_not_copy() {
      reader.visible = false
      open("m-16", "Your sign-in code", codeBody, new Date())
      wait(50)
      reader.visible = true
      compare(mailService.copied, [])
    }

    function test_a_new_message_starts_uncopied() {
      open("m-10", "Your sign-in code", codeBody, new Date(0))
      mouseClick(named(card(), "otpCopy"))
      verify(named(card(), "otpCopied").visible)
      open("m-11", "Your sign-in code", codeBody, new Date(0))
      verify(!named(card(), "otpCopied").visible, "copied is about that message, not the code")
    }
  }
}
