import QtQuick
import qs.Commons
import qs.Ui

// The name a mailbox is listed by, asked for where the mailbox is set up
// rather than only in the settings list afterwards. Optional: two mailboxes
// that differ only in their domain are told apart by a name, and one on its
// own has no need of one. Empty is not a name and puts the address back.
TextField {
  id: root

  property var service: null

  objectName: "account-name-field"
  placeholderText: "Name (optional) — how this mailbox is listed, e.g. Work"

  function syncFromStore() { text = service ? String(service.accountName || "") : "" }
  function value() { return String(text || "").trim() }

  Component.onCompleted: syncFromStore()
}
