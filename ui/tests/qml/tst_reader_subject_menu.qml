import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail
import "../../message/Html.js" as Html

// A right-click on the reader's subject: one row, the subject as written,
// copied through the host.
Item {
  width: 900
  height: 600

  readonly property string senderHtml: '<p>Person 1 moved 4 cards.</p>'

  readonly property var rendered: Html.sanitize(senderHtml, ({ withReader: true }))

  QtObject {
    id: mailService

    property var copied: []

    property string selectedId: "message-9"
    property var selectedMessage: ({
      id: "message-9",
      subject: "Activity on Sprint board",
      from: ({ display: "Boards", email: "boards@example.com" }),
      to: [({ display: "Reader", email: "reader@example.com" })],
      fullTime: "24 August 2026",
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
    function openExternal(url) { return true }
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

  TestCase {
    name: "ReaderSubjectMenu"
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

    function subjectLine() {
      var line = named(reader, "reader-subject")
      verify(line, "the reader draws its subject in a Text")
      return line
    }

    function menu() {
      var found = named(reader, "reader-subject-menu")
      verify(found, "the reader owns a subject menu")
      return found
    }

    function init() {
      menu().close()
      mailService.selectedMessage.subject = "Activity on Sprint board"
      mailService.copied = []
    }

    function cleanup() { menu().close() }

    function test_a_right_click_on_the_subject_opens_the_menu() {
      mouseClick(subjectLine(), 30, subjectLine().height / 2, Qt.RightButton)
      tryVerify(function() { return menu().opened }, 1000, "the menu opens")
      wait(20)
      compare(menu().copyRow.enabled, true)
    }

    function test_copy_copies_the_subject_through_the_service() {
      mouseClick(subjectLine(), 30, subjectLine().height / 2, Qt.RightButton)
      tryVerify(function() { return menu().opened }, 1000, "the menu opens")
      wait(20)
      menu().copyRow.activated()
      tryVerify(function() { return menu().opened === false }, 1000, "the menu closes")
      compare(mailService.copied, ["Activity on Sprint board"])
    }

    function test_the_menu_holds_one_row_named_for_what_it_copies() {
      mouseClick(subjectLine(), 30, subjectLine().height / 2, Qt.RightButton)
      tryVerify(function() { return menu().opened }, 1000, "the menu opens")
      wait(20)
      compare(menu().menuRows.length, 1)
      compare(menu().copyRow.text, "Copy subject")
    }

    function test_an_empty_subject_does_not_open_the_menu() {
      mailService.selectedMessage.subject = ""
      mouseClick(subjectLine(), 30, subjectLine().height / 2, Qt.RightButton)
      wait(20)
      compare(menu().opened, false)
      compare(mailService.copied, [])
    }

    function test_a_whitespace_only_subject_does_not_open_the_menu() {
      mailService.selectedMessage.subject = "   "
      mouseClick(subjectLine(), 30, subjectLine().height / 2, Qt.RightButton)
      wait(20)
      compare(menu().opened, false)
      compare(mailService.copied, [])
    }

    function test_the_menu_anchors_to_the_line_not_the_pointer() {
      mouseClick(subjectLine(), 120, subjectLine().height / 2, Qt.RightButton)
      tryVerify(function() { return menu().opened }, 1000, "the menu opens")
      wait(20)
      compare(menu().popup.x, subjectLine().mapToItem(menu().popup.parent, 0, 0).x,
              "the menu anchors to the line's edge, not the click point")
    }
  }
}
