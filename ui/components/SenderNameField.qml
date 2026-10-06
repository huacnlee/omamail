import QtQuick
import qs.Commons
import qs.Ui

// The name recipients see beside this mailbox's address, asked for where the
// mailbox is set up so its first message is not sent nameless. Only on the
// pages for mailboxes whose server does not name the sender
// (`Accounts.namesSender`), and only on a backend that writes it.
TextField {
  id: root

  property var service: null
  readonly property bool available: !!service && !!service.backendCanNameSender

  objectName: "sender-name-field"
  visible: available
  placeholderText: "Your name (optional) — shown to recipients as the sender"

  function syncFromStore() { text = service ? String(service.accountSenderName || "") : "" }
  // Left out of the form while unavailable, so the entry keeps what it has.
  function value() { return available ? String(text || "").trim() : undefined }

  Component.onCompleted: syncFromStore()
}
