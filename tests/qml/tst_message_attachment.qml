import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  width: 700
  height: 500

  QtObject {
    id: mailService

    property string openedMessageId: ""
    property var openedAttachment: null
    property var selectedMessage: ({
      id: "message-4",
      subject: "Forwarded report",
      from: ({ display: "Sender", email: "sender@example.com" }),
      to: [({ display: "Reader", email: "reader@example.com" })],
      fullTime: "24 August 2026",
      starred: false
    })
    property bool detailLoading: false
    property bool detailPainted: true
    property string selectedHtml: ""
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
    property bool canStar: true
    property bool canSend: true
    property bool readOnly: false
    property bool canOpenOnWeb: true
    property var selectedAttachments: [({
      filename: "Quarterly report.pdf",
      mimeType: "application/pdf",
      size: 1536,
      attachmentId: "att-7"
    })]

    function openAttachment(messageId, attachment) {
      openedMessageId = messageId
      openedAttachment = attachment
    }
  }

  Omamail.MessageReader {
    id: reader
    anchors.fill: parent
    visible: false
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
    name: "MessageAttachment"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function init() {
      reader.visible = false
      mailService.readOnly = false
      mailService.canSend = true
      mailService.canOpenOnWeb = true
      mailService.selectedHtml = ""
      wait(20)
    }

    function test_attachment_filename_routes_the_message_and_part_to_the_service() {
      var link = named(reader, "attachment-open-link")
      verify(link, "the message reader must present an attachment control")

      mailService.openedMessageId = ""
      mailService.openedAttachment = null
      link.activated()
      compare(mailService.openedMessageId, "message-4")
      compare(mailService.openedAttachment.attachmentId, "att-7")
    }

    function test_read_only_reader_draws_no_message_mutation_buttons() {
      var star = named(reader, "message-reader-star")
      var archive = named(reader, "message-reader-archive")
      var trash = named(reader, "message-reader-trash")
      verify(star && archive && trash)
      compare(reader.starActionVisible, true)
      compare(reader.archiveActionVisible, true)
      compare(reader.trashActionVisible, true)

      mailService.readOnly = true
      wait(20)
      compare(reader.starActionVisible, false)
      compare(reader.archiveActionVisible, false)
      compare(reader.trashActionVisible, false)
    }

    function test_reader_draws_no_reply_controls_when_the_mailbox_cannot_send() {
      var reply = named(reader, "message-reader-reply")
      var replyAll = named(reader, "message-reader-reply-all")
      var forward = named(reader, "message-reader-forward")
      verify(reply && replyAll && forward)
      compare(reader.canCompose, true)

      mailService.canSend = false
      wait(20)
      compare(reader.canCompose, false)
      compare(reply.visible, false)
      compare(replyAll.visible, false)
      compare(forward.visible, false)
    }

    function test_reader_modes_keep_the_toolbar_when_writing_is_unavailable() {
      var toolbar = named(reader, "readerToolbar")
      var viewTools = named(reader, "readerViewTools")
      var track = named(reader, "bodyModeTrack")
      verify(toolbar && viewTools && track)

      mailService.selectedHtml = "<p>Formatted message</p>"
      mailService.readOnly = true
      mailService.canSend = false
      mailService.canOpenOnWeb = false
      reader.visible = true
      wait(20)

      verify(track.width > 0, "the three reading modes remain available")
      compare(viewTools.y, 0, "hidden message actions leave no empty row")
      compare(viewTools.height, viewTools.implicitHeight)
      compare(toolbar.implicitHeight, viewTools.implicitHeight,
        "the view tools still give the toolbar its height")
    }
  }
}
