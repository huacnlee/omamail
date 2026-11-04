import QtQuick
import "Model.js" as Model

// What a save or a send of a draft already says about the Drafts list and the
// reader, applied when it is known rather than when the server next lists the
// drafts. Beside the account rather than in it, which is at its size ceiling.
QtObject {
  id: draftList

  required property var account

  // A save writes a new copy and removes the old one on Gmail, IMAP, Outlook
  // and JMAP, and rewrites it in place on HEY. Either way the copy the reader
  // holds is out of date, and where the save wrote a new copy, editing the old
  // one again wrote a second draft.
  function saved(draftId) {
    var id = String(draftId || "")
    if (id !== "" && account.selectedId === id) account.clearSelection()
  }

  // A draft being sent is not a draft any more. Its row, and its copy in the
  // cache, go when the send is queued and again once the draft is removed,
  // from the Drafts list the send started on (`key`) and no other. A send
  // that is undone or does not go, and a sent draft the server kept, read the
  // list again, which shows the draft where it is.
  function drop(draftId, key) {
    var id = String(draftId || "")
    if (id === "") return
    if (account.selectedId === id) account.clearSelection()
    if (account.mailboxKey !== "drafts" || account.cacheKey !== key
        || Model.indexById(account.messages, id) < 0) return
    account.messages = Model.removeById(account.messages, id)
    account.rememberList()
  }

  // The Drafts list read from the server again, when it is the list on screen.
  function reload() {
    if (account.mailboxKey !== "drafts") return false
    account.listSerial++
    account.nextPageToken = ""
    account.loadMessages(false, true, "")
    return true
  }
}
