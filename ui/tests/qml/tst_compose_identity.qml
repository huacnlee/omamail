import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// Whose identity a draft writes with, when the mailbox it belongs to is not
// the mailbox on screen.
//
// `begin` gets the owner right — `accountId` comes from `composeAccountId` —
// and then two things went on asking the *active* account instead: the
// sign-off placed in the body, and the address reply-all leaves off the Cc.
// Both put one identity's details into another identity's outgoing mail, so
// they are held here rather than in tst_signature.qml, which has one account
// and cannot tell the two apart.
Item {
  width: 900
  height: 600

  readonly property string adaId: "ada@example.org"
  readonly property string bobId: "bob@example.net"

  QtObject {
    id: mailAuth
    property bool signedIn: true
  }

  // Two mailboxes, A active. The draft under test belongs to B.
  QtObject {
    id: mailService
    property bool sendPending: false
    property bool sending: false
    property int sendSecondsRemaining: 10
    property var lastSent: null
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var auth: mailAuth
    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property int undoSendSeconds: 10

    property string activeAccountId: adaId
    property string accountEmail: adaId
    property string activeSignature: "Ada\nada.example.org"

    // Which mailbox the next draft belongs to. The window seeds this from the
    // message being answered; here it is set by the test.
    property string composeAccountId: adaId

    property var accountSignatures: [
      ({ id: adaId, email: adaId, signature: "Ada\nada.example.org" }),
      ({ id: bobId, email: bobId, signature: "Bob\nbob.example.net" })
    ]

    function signatureFor(id) {
      var want = String(id || "")
      for (var i = 0; i < accountSignatures.length; i++)
        if (accountSignatures[i].id === want)
          return String(accountSignatures[i].signature || "")
      return ""
    }

    function accountEmailFor(id) {
      var want = String(id || "")
      for (var i = 0; i < accountSignatures.length; i++)
        if (accountSignatures[i].id === want)
          return String(accountSignatures[i].email || "")
      return ""
    }

    // What `submit()` handed over, so the account it named can be asserted.
    property var submitted: null
    function preferredSendAs(_recipients) { return null }
    function switchTo(_id) { return true }
    function refreshRecipientContacts() {}
    function send(fields) {
      submitted = fields
      return true
    }
    function setAlwaysShowImages(_value) {}
    function setAlwaysRenderHeavyMessages(_value) {}
    function setUndoSendSeconds(_value) {}
    function setAccountSignature(_id, _text) {}
  }

  Omamail.ComposeView {
    id: compose
    anchors.fill: parent
    service: mailService
    textColor: Qt.rgba(1, 1, 1, 1)
    backgroundColor: Qt.rgba(0.06, 0.06, 0.06, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.53, 0.53, 0.53, 1)
    panelFontFamily: "monospace"
  }

  TestCase {
    name: "ComposeIdentity"
    when: windowShown

    function init() {
      mailService.composeAccountId = adaId
      compose.reset()
      compose.opened = false
    }

    function test_ai_edit_can_be_undone_and_draft_key_survives_restore() {
      compose.begin("new", null, "", [])
      compose.replaceBody("Original body")
      var snapshot = compose.snapshotDraft()
      var key = compose.currentFields().draftKey
      compose.replaceBody("AI replacement")
      var editor = named(compose, "compose-body-editor")
      verify(editor.canUndo)
      editor.undo()
      if (editor.text === "") editor.undo()
      compare(editor.text,"Original body")
      compose.begin("new", null, "", [])
      verify(compose.currentFields().draftKey !== key)
      compose.restoreDraft(snapshot)
      compare(compose.currentFields().draftKey,key)
      compare(compose.currentFields().accountId,adaId)
    }

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

    function bodyText() { return named(compose, "compose-body-editor").text }
    function ccText() { return named(compose, "compose-cc-field").text.toLowerCase() }

    // A message addressed to both mailboxes, from somebody else.
    function incoming() {
      return {
        id: "1",
        threadId: "t1",
        messageId: "<m1@example.com>",
        subject: "Invoice",
        from: { email: "sender@example.com", display: "Sender" },
        to: [{ email: bobId, display: "Bob" }, { email: adaId, display: "Ada" }],
        cc: [],
        date: 1000
      }
    }

    // ------------------------------------------------------- the sign-off

    function test_a_draft_is_signed_by_the_mailbox_it_belongs_to() {
      mailService.composeAccountId = bobId
      compose.begin("reply", incoming(), "Original body", [])

      compare(compose.accountId, bobId, "the draft belongs to B")
      compare(compose.accountSignature, "Bob\nbob.example.net",
        "and is signed by B, not by whichever mailbox is on screen")
      verify(bodyText().indexOf("Bob") >= 0, "B's sign-off reaches the body")
      compare(bodyText().indexOf("Ada") < 0, true,
        "A's name and address are nowhere in a message A is not sending")
    }

    // The single-mailbox case, which is every account's own reply and must
    // keep working: owner and active are the same, and the answer is the same.
    function test_a_draft_from_the_active_mailbox_is_signed_by_it() {
      mailService.composeAccountId = adaId
      compose.begin("reply", incoming(), "Original body", [])

      compare(compose.accountId, adaId)
      compare(compose.accountSignature, "Ada\nada.example.org")
    }

    // ------------------------------------------------------- reply-all

    // The original went to both mailboxes. Replying from B, the Cc is
    // everybody except B — so A stays on it and B comes off. Reading the
    // active account's address inverted exactly that: it dropped A, the real
    // recipient, and copied B, the sender.
    function test_reply_all_drops_the_sender_rather_than_the_active_mailbox() {
      mailService.composeAccountId = bobId
      compose.begin("replyAll", incoming(), "Original body", [])

      var cc = ccText()
      verify(cc.indexOf(adaId) >= 0, "A was on the original and stays on the Cc")
      compare(cc.indexOf(bobId) < 0, true,
        "B is writing it, so B is not copied on it")
    }

    // ------------------------------------------------------- the send

    // The service can only route a submission to the mailbox that owns it if
    // the submission says which that is. Without it the service fell back to
    // matching the From address against each account in turn, so two
    // mailboxes sharing a send-as alias sent B's draft from whichever came
    // first — and that fallback cannot tell the difference.
    function test_a_submission_names_the_mailbox_it_belongs_to() {
      mailService.composeAccountId = bobId
      mailService.submitted = null
      compose.begin("reply", incoming(), "Original body", [])
      compose.submit()

      verify(mailService.submitted, "the draft was submitted")
      compare(String(mailService.submitted.accountId), bobId,
        "and it names B, which is the only thing that can route it")
    }

    function test_reply_all_from_the_active_mailbox_is_unchanged() {
      mailService.composeAccountId = adaId
      compose.begin("replyAll", incoming(), "Original body", [])

      var cc = ccText()
      verify(cc.indexOf(bobId) >= 0)
      compare(cc.indexOf(adaId) < 0, true)
    }
  }
}
