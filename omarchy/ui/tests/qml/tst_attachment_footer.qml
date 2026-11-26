import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  width: 900
  height: 600

  QtObject {
    id: mailService

    property string openedMessageId: ""
    property var openedAttachment: null
    property string starredId: ""
    property string browsedId: ""
    // What the service answers to. It is the summary's own id in a single
    // mailbox and the mailbox plus that id in a list made of several, and the
    // reader has to hand back this one rather than the one on the summary.
    property string selectedId: "message-4"
    property var selectedMessage: ({
      id: "message-4",
      subject: "Forwarded report",
      from: ({ display: "Sender", email: "sender@example.com" }),
      to: [({ display: "Reader", email: "reader@example.com" })],
      fullTime: "24 August 2026",
      starred: false
    })
    property bool listLoaded: true
    property var messages: []
    property string searchQuery: ""
    property bool canMoveToLabel: false
    property bool detailLoading: false
    property bool detailPainted: true
    property bool selectedHasHtml: false
    property var selectedDocument: null
    property int selectedRemoteImages: 0
    property bool remoteImagesAllowed: false
    property bool selectedTooHeavy: false
    property string unsubscribeLabel: ""
    property string unsubscribeDetail: ""
    property bool unsubscribing: false
    property var selectedBody: ({ text: "Forwarded message", source: "plain" })
    property var selectedImages: []
    property var selectedInvite: null
    property string selectedResponse: ""
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: true
    property bool canOpenOnWeb: true
    property var selectedAttachments: [({
      filename: "Quarterly report.pdf",
      mimeType: "application/pdf",
      size: 1536,
      attachmentId: "att-7"
    })]

    property int saveCalls: 0
    property string savedMessageId: ""
    property var savedAttachment: null

    // Keyed by mailbox and attachment on the real service, because two
    // mailboxes can be saving parts whose ids collide. Empty here, so a reader
    // that looks up a bare attachment id finds nothing — which is what it did.
    property var savingAttachmentIds: ({})
    property string savingFor: ""

    function openAttachment(messageId, attachment) {
      openedMessageId = messageId
      openedAttachment = attachment
    }

    function saveAttachment(messageId, attachment) {
      saveCalls++
      savedMessageId = messageId
      savedAttachment = attachment
    }

    function attachmentIsSaving(messageId, attachmentId) {
      return savingFor !== "" && String(messageId) === savingFor
        && String(attachmentId) === "att-7"
    }

    function toggleStar(id) { starredId = String(id) }
    function openInBrowser(id) { browsedId = String(id) }
  }

  Omamail.MessageReader {
    id: reader
    width: 380
    height: 360
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
  }

  TestCase {
    name: "AttachmentFooter"
    when: windowShown

    function named(item, name) {
      if (item.objectName === name) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = named(children[i], name)
        if (found) return found
      }
      return null
    }

    function attachments(count) {
      var result = []
      for (var i = 0; i < count; i++)
        result.push({filename: "Report " + (i + 1) + ".pdf", mimeType: "application/pdf",
          size: 1536, attachmentId: "att-" + i})
      return result
    }

    function show(count) {
      mailService.selectedAttachments = attachments(count)
      wait(0)
    }

    function toggle() {
      var button = named(reader, "attachment-toggle")
      verify(button && button.visible, "attachments have a visible disclosure control")
      waitForRendering(reader)
      mouseClick(button, button.width / 2, button.height / 2)
      waitForRendering(reader)
    }

    function init() {
      reader.width = 380
      reader.height = 360
      mailService.selectedId = "message-4"
      mailService.selectedAttachments = []
      mailService.savingFor = ""
      mailService.saveCalls = 0
      mailService.openedMessageId = ""
      mailService.savedMessageId = ""
      wait(0)
    }

    function test_many_real_attachments_leave_a_readable_body() {
      show(40)
      var body = named(reader, "messageBodyScroller")
      verify(body.height >= 120, "40 genuine files must not consume the message body: " + body.height)
      verify(body.y >= 0 && body.y + body.height <= reader.height)
    }

    function test_count_is_collapsed_and_zero_files_take_no_space() {
      show(0)
      var body = named(reader, "messageBodyScroller")
      var emptyHeight = body.height
      var button = named(reader, "attachment-toggle")
      verify(button)
      compare(button.visible, false)
      show(40)
      compare(button.visible, true)
      verify(button.text.indexOf("40 attachments") >= 0)
      var list = named(reader, "attachment-scroller")
      verify(list)
      compare(list.visible, false)
      verify(emptyHeight - body.height < 45, "the collapsed count costs only one control row")
      show(1)
      verify(button.text.indexOf("1 attachment") >= 0)
      verify(button.text.indexOf("1 attachments") < 0)
    }

    function test_expanded_list_is_bounded_after_resize_and_repeated_toggles() {
      show(40)
      var body = named(reader, "messageBodyScroller")
      var collapsedHeight = body.height
      toggle()
      var list = named(reader, "attachment-scroller")
      compare(list.visible, true)
      verify(list.height > 0 && list.height <= 160)
      verify(list.contentHeight > list.height)
      verify(body.height >= 100, "expanded attachments still leave reading space")
      reader.height = 280
      reader.width = 300
      // The footer Column positions its resized children on the next polish.
      tryVerify(function() { return body.height >= 60 }, 5000,
        "short narrow readers must retain body space")
      verify(list.height > 0 && list.height < 160)
      reader.height = 360
      reader.width = 380
      for (var i = 0; i < 3; i++) {
        toggle()
        compare(list.visible, false)
        compare(body.height, collapsedHeight)
        toggle()
        compare(list.visible, true)
        verify(body.height >= 100)
      }
    }

    function test_scroll_to_last_file_and_route_both_actions() {
      show(40)
      mailService.selectedId = "mailbox-b message-4"
      toggle()
      var list = named(reader, "attachment-scroller")
      waitForRendering(reader)
      mouseWheel(list, list.width / 2, list.height / 2, 0, -12000)
      tryVerify(function() { return list.atYEnd })
      var rows = list.contentItem.children[0].children
      var last = null
      for (var i = 0; i < rows.length; i++)
        if (rows[i].attachment && rows[i].attachment.attachmentId === "att-39") last = rows[i]
      verify(last, "the final file is still present")
      var link = named(last, "attachment-open-link")
      var save = named(last, "attachment-save-button")
      var point = save.mapToItem(list, 0, 0)
      verify(point.y >= 0 && point.y + save.height <= list.height + 1,
        "the final save control is fully inside the clipped viewport")
      verify(point.x >= 0 && point.x + save.width <= list.width)
      mouseClick(link, 10, link.height / 2)
      compare(mailService.openedMessageId, "mailbox-b message-4")
      compare(mailService.openedAttachment.attachmentId, "att-39")
      mouseClick(save, save.width / 2, save.height / 2)
      compare(mailService.savedMessageId, "mailbox-b message-4")
      compare(mailService.savedAttachment.attachmentId, "att-39")
    }

    function test_switching_messages_resets_disclosure_and_scroll() {
      show(40)
      toggle()
      var list = named(reader, "attachment-scroller")
      list.contentY = list.contentHeight - list.height
      mailService.selectedId = "message-5"
      show(2)
      compare(list.visible, false)
      compare(list.contentY, 0)
      toggle()
      compare(list.visible, true)
      verify(list.height >= 40 && list.height <= 60, "few files use only their natural height")
      show(0)
      compare(list.visible, false)
    }

    function test_busy_state_survives_disclosure_and_filenames_remain_plain_text() {
      mailService.selectedAttachments = [{filename: '<img src="https://example.invalid/tracker">',
        attachmentId: "att-7", mimeType: "application/pdf", size: 128}]
      mailService.selectedId = "mailbox-b message-4"
      mailService.savingFor = "mailbox-b message-4"
      wait(0)
      toggle()
      var save = named(reader, "attachment-save-button")
      compare(save.busy, true)
      mouseClick(save, save.width / 2, save.height / 2)
      compare(mailService.saveCalls, 0)
      toggle()
      toggle()
      compare(save.busy, true)
      mailService.savingFor = ""
      compare(save.busy, false)
      mouseClick(save, save.width / 2, save.height / 2)
      compare(mailService.saveCalls, 1)
      compare(named(reader, "attachment-open-link").textFormat, Text.PlainText)
    }
  }
}
