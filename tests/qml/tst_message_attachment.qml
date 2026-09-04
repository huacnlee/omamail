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

    function toggleStar(id) { starredId = String(id) }
    function openInBrowser(id) { browsedId = String(id) }
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

    function test_attachment_filename_routes_the_message_and_part_to_the_service() {
      var link = named(reader, "attachment-open-link")
      verify(link, "the message reader must present an attachment control")

      mailService.openedMessageId = ""
      mailService.openedAttachment = null
      link.activated()
      compare(mailService.openedMessageId, "message-4")
      compare(mailService.openedAttachment.attachmentId, "att-7")
    }

    // A row in a list made of several mailboxes is addressed by mailbox and
    // id. The account that owns the message knows only its own half of that,
    // so a reader that called back with `selectedMessage.id` named no mailbox
    // and the star, the attachment and the browser link all did nothing.
    function test_the_reader_answers_with_the_id_the_service_gave_it() {
      mailService.selectedId = "b@example.net message-4"

      mailService.openedMessageId = ""
      var link = named(reader, "attachment-open-link")
      verify(link)
      link.activated()
      compare(mailService.openedMessageId, "b@example.net message-4")

      var web = named(reader, "openWebButton")
      verify(web, "the browser link has to be there to be pressed")
      web.clicked()
      compare(mailService.browsedId, "b@example.net message-4")

      mailService.selectedId = "message-4"
    }
  }
}
