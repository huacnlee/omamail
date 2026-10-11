import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail
import "../../message/Html.js" as Html

// A right-click on the message body: Copy for what is selected, Open and Copy
// URL when the click lands on a link, and the message itself as a .eml file.
Item {
  width: 900
  height: 600

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
    // Save as .eml from the reader: the toolbar button and the body menu.
    property bool exportable: true
    property bool folderable: true
    property var exported: []
    function canExportEmlFor(id) { return exportable }
    readonly property bool standalone: !folderable
    function exportEml(id) { exported = exported.concat([{ id: String(id), folder: false }]); return true }
    function accountForMessage(id) { return "imap:reader@example.com" }
    function sourceIdFor(id) { return "native-" + id }
    function exportEmlToFolder(account, id) {
      exported = exported.concat([{ account: String(account), id: String(id), folder: true }])
      return true
    }
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

  TestCase {
    name: "ReaderTextMenu"
    when: windowShown

    function found(item, type) {
      if (!item) return null
      if (item.toString().indexOf(type) === 0) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var hit = found(values[i], type)
        if (hit) return hit
      }
      return null
    }

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

    function body() {
      var edit = found(reader, "QQuickTextEdit")
      verify(edit, "the reader draws its message in a TextEdit")
      return edit
    }

    function menu() {
      var found = named(reader, "reader-text-menu")
      verify(found, "the reader owns a text menu")
      return found
    }

    // Where a run of text sits in the body, by the first character of it.
    function pointOf(edit, needle) {
      var plain = edit.getText(0, edit.length)
      var at = plain.indexOf(needle)
      verify(at >= 0, "the body holds " + needle)
      var rect = edit.positionToRectangle(at)
      return { x: rect.x + 3, y: rect.y + rect.height / 2 }
    }

    function init() {
      menu().close()
      body().deselect()
      mailService.copied = []
      mailService.opened = []
      mailService.exported = []
      mailService.exportable = true
      mailService.folderable = true
    }

    function cleanup() { menu().close() }

    function test_a_right_click_on_the_body_opens_the_menu() {
      var edit = body()
      var point = pointOf(edit, "Person 1")
      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      compare(menu().opened, true)
      compare(menu().editable, false)
      compare(menu().link, "")
    }

    function test_a_right_click_keeps_the_selection_and_copy_copies_it() {
      var edit = body()
      var start = edit.getText(0, edit.length).indexOf("moved")
      edit.select(start, start + 5)
      var point = pointOf(edit, "Person 1")
      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      compare(edit.selectedText, "moved")
      compare(menu().copyRow.enabled, true)
      menu().copyRow.activated()
      compare(mailService.copied, ["moved"])
    }

    function test_a_right_click_on_a_link_offers_it() {
      var edit = body()
      var point = pointOf(edit, "Open the board")
      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      compare(menu().opened, true)
      compare(menu().link, "https://example.com/board")
      menu().copyLinkRow.activated()
      compare(mailService.copied, ["https://example.com/board"])
    }

    function test_the_body_menu_saves_the_message_as_eml() {
      var edit = body()
      var point = pointOf(edit, "Person 1")
      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      compare(menu().saveEmlRow.visible, true)
      compare(menu().saveEmlFolderRow.visible, true)
      menu().saveEmlRow.activated()
      compare(mailService.exported, [{ id: "message-9", folder: false }])
      compare(menu().opened, false)

      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      menu().saveEmlFolderRow.activated()
      compare(mailService.exported[1], { account: "imap:reader@example.com",
        id: "native-message-9", folder: true }, "the owner and native id, captured now")
    }

    function test_the_rows_follow_what_the_service_can_do() {
      mailService.folderable = false
      var edit = body()
      var point = pointOf(edit, "Person 1")
      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      compare(menu().saveEmlRow.visible, true)
      compare(menu().saveEmlFolderRow.visible, false, "no chooser, no folder row")
      menu().close()
      mailService.exportable = false
      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      compare(menu().saveEmlRow.visible, false)
    }

    function test_the_toolbar_button_saves_to_downloads() {
      var button = named(reader, "reader-save-eml-button")
      verify(button, "the reader toolbar has a save button")
      compare(button.visible, true)
      button.clicked()
      compare(mailService.exported, [{ id: "message-9", folder: false }])
      mailService.exportable = false
      compare(button.visible, false, "hidden where export is not possible")
    }

    function test_open_link_opens_it_outside() {
      var edit = body()
      var point = pointOf(edit, "Open the board")
      mouseClick(edit, point.x, point.y, Qt.RightButton)
      wait(20)
      menu().openLinkRow.activated()
      compare(mailService.opened, ["https://example.com/board"])
    }
  }
}
