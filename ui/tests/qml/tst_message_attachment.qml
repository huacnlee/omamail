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

    // Saving was the one that kept `selectedMessage.id`, so the file came down
    // from whichever mailbox was active — and on two IMAP accounts a part id
    // is a number in a tree, so A's part could arrive under B's filename.
    function test_saving_answers_with_the_id_the_service_gave_it() {
      mailService.selectedId = "b@example.net message-4"
      mailService.savedMessageId = ""

      var save = named(reader, "attachment-save-button")
      verify(save, "the save control has to be there to be pressed")
      save.clicked()

      compare(mailService.savedMessageId, "b@example.net message-4")
      compare(mailService.savedAttachment.attachmentId, "att-7")

      mailService.selectedId = "message-4"
    }

    // And the spinner is asked the same way. The service keys it by mailbox,
    // so a lookup by attachment alone found nothing and the row stayed idle
    // through the whole save.
    function test_the_row_goes_busy_for_the_mailbox_that_owns_it() {
      mailService.selectedId = "b@example.net message-4"
      var row = named(reader, "attachment-save-button").parent
      verify(row, "the save control sits in the row it belongs to")

      mailService.savingFor = ""
      compare(row.saving, false)

      mailService.savingFor = "b@example.net message-4"
      compare(row.saving, true,
        "asked by mailbox and attachment, which is how the service holds it")

      mailService.savingFor = "a@example.org message-4"
      compare(row.saving, false, "another mailbox's save is not this row's")

      mailService.savingFor = ""
      mailService.selectedId = "message-4"
    }
  }
}
