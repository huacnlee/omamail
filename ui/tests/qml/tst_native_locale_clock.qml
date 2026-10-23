import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail
import "../../message/Html.js" as Html
import "../../message/Message.js" as Mail

// Synthetic native/cached summaries rendered by the real row, reader and rail.
Item {
  width: 900
  height: 800

  readonly property string senderHtml: '<p>Person 1 moved 4 cards.</p>'
    + '<p><a href="https://example.com/board">Open the board</a></p>'

  readonly property var rendered: Html.sanitize(senderHtml, ({ withReader: true }))

  QtObject {
    id: mailService

    property var copied: []
    property var opened: []

    property string selectedId: "message-9"
    property var selectedMessage: ({
      id: "message-9",
      subject: "Activity on Sprint board",
      from: ({ display: "Boards", email: "boards@example.com" }),
      to: [({ display: "Reader", email: "reader@example.com" })],
      fullTime: "Oct 22, 2026 16:02",
      starred: false
    })
    property bool detailLoading: false
    property bool detailPainted: true
    property bool selectedHasHtml: rendered.html !== ""
    property var selectedDocument: rendered.document
    property var selectedReaderDocument: rendered.reader.document
    property bool selectedReaderTooHeavy: rendered.reader.tooHeavy
    property bool selectedReaderEmpty: rendered.reader.empty
    property int selectedRemoteImages: rendered.remoteImages
    property bool remoteImagesAllowed: false
    property bool selectedTooHeavy: rendered.tooHeavy
    property string unsubscribeLabel: ""
    property string unsubscribeDetail: ""
    property bool unsubscribing: false
    property var selectedBody: ({ text: "Person 1 moved 4 cards.", source: "html" })
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
    function copyText(text) { copied = copied.concat([String(text)]); return true }
    function openExternal(url) { opened = opened.concat([String(url)]); return true }
  }

  Omamail.MessageReader {
    id: reader
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
    bodyMode: "reader"
    onBodyModeRequested: function(mode) { reader.bodyMode = mode }
  }


  Omamail.MessageRow {
    id: row
    y: 600
    width: 600
    textColor: Qt.rgba(1,1,1,1)
    accentColor: Qt.rgba(1,0.5,0,1)
    dimColor: Qt.rgba(0.5,0.5,0.5,1)
    panelFontFamily: "monospace"
    summary: ({id:"one", subject:"Synthetic native summary", from:{display:"Sender"},
      snippet:"", time:"14:57", fullTime:"Oct 22, 2026 14:57", unread:false, starred:false})
  }
  Omamail.ConversationRail {
    id: rail
    x: 610
    y: 600
    width: 250
    height: 180
    stops: [{id:"one", known:true, open:true, sender:"Sender", time:"16:02", unread:false, flagged:false, mailbox:""}]
    caption: "1 message"
    textColor: Qt.rgba(1,1,1,1)
    backgroundColor: Qt.rgba(0,0,0,1)
    accentColor: Qt.rgba(1,0.5,0,1)
    dimColor: Qt.rgba(0.5,0.5,0.5,1)
    dimmerColor: Qt.rgba(0.5,0.5,0.5,1)
    panelFontFamily: "monospace"
  }
  TestCase {
    name: "NativeLocaleClock"
    when: windowShown
    function test_narrow_reader_keeps_the_complete_clock_visible() {
      reader.width = 360
      mailService.selectedMessage = {id:"message-9",subject:"Synthetic",from:{display:"Sender",email:"sender@example.com"},
        to:[{display:"Morgan Example",email:"morgan@example.com"},{display:"Taylor Example",email:"taylor@example.com"},
          {display:"Jordan Example",email:"jordan@example.com"}],fullTime:"Oct 22, 2026 16:02",starred:false}
      waitForRendering(reader)
      var label = findChild(reader, "message-full-time")
      verify(!label.truncated, "the date and localized day period must remain visible")
      verify(label.lineCount > 1, "a long recipient/date line wraps at narrow widths")
      verify(label.contentHeight <= label.height, "all wrapped lines fit")
      compare(label.textFormat, Text.PlainText)
      reader.width = 900
      mailService.selectedMessage = {id:"message-9",subject:"Activity on Sprint board",from:{display:"Boards",email:"boards@example.com"},
        to:[{display:"Reader",email:"reader@example.com"}],fullTime:"Oct 22, 2026 16:02",starred:false}
    }
    function test_preformatted_backend_labels_are_localized_in_real_widgets() {
      waitForRendering(reader)
      compare(findChild(row, "message-time").text, Mail.displayTimeLabel("14:57"))
      var label = findChild(reader, "message-full-time")
      verify(label)
      verify(label.text.indexOf(Mail.displayTimeLabel("Oct 22, 2026 16:02")) >= 0)
      compare(findChild(rail, "conversation-time").text, Mail.displayTimeLabel("16:02"))
      compare(findChild(row, "message-time").textFormat, Text.PlainText)
      compare(findChild(rail, "conversation-time").textFormat, Text.PlainText)
      compare(label.textFormat, Text.PlainText)
      compare(mailService.selectedMessage.fullTime, "Oct 22, 2026 16:02", "the backend summary is not mutated")
    }
    function test_timestamp_takes_precedence_over_cached_clock_in_widgets() {
      var date = new Date(2026, 9, 22, 15, 5).toISOString()
      row.summary = {id:"one",subject:"Synthetic",from:{display:"Sender"},snippet:"",time:"16:02",date:date,unread:false,starred:false}
      mailService.selectedMessage = {id:"message-9",subject:"Synthetic",from:{display:"Sender",email:"sender@example.com"},
        to:[], fullTime:"Oct 22, 2026 16:02", date:date, starred:false}
      wait(0)
      compare(findChild(row, "message-time").text, Mail.displayTimeLabel("15:05"))
      verify(findChild(reader, "message-full-time").text.indexOf(Mail.displayTimeLabel("Oct 22, 2026 15:05")) >= 0)
      compare(row.summary.time, "16:02")
      compare(mailService.selectedMessage.fullTime, "Oct 22, 2026 16:02")
    }
    function test_relative_and_unknown_labels_stay_plain_and_unchanged() {
      var inputs = ["now", "5m", "Wed", "unknown at 16:02", "<img src=https://example.test/time>16:02"]
      for (var i = 0; i < inputs.length; i++) {
        row.summary = {id:"one", subject:"Synthetic", from:{display:"Sender"}, snippet:"",time:inputs[i],unread:false,starred:false}
        rail.stops = [{id:"one",known:true,open:true,sender:"Sender",time:inputs[i],unread:false,flagged:false,mailbox:""}]
        wait(0)
        compare(findChild(row, "message-time").text, inputs[i])
        compare(findChild(rail, "conversation-time").text, inputs[i])
        compare(row.summary.time, inputs[i])
        mailService.selectedMessage = {id:"message-9", subject:"Synthetic", from:{display:"Sender",email:"sender@example.com"},
          to:[], fullTime:inputs[i], starred:false}
        wait(0)
        var label = findChild(reader, "message-full-time")
        verify(label.text.indexOf(inputs[i]) >= 0)
        compare(label.textFormat, Text.PlainText)
        compare(mailService.selectedMessage.fullTime, inputs[i])
      }
    }
  }
}
