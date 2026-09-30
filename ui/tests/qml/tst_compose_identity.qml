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
    property bool holdNativeText: false
    property var pendingNativeText: []
    property var backend: ({call: function(method, params, callback) {
      if (method !== "message.composeText") return
      var result = {body: String(params.signature || ""), quote: "", replySubject: "Re: Invoice"}
      if (mailService.holdNativeText) mailService.pendingNativeText.push({callback:callback,result:result})
      else callback(result, null)
    }})
    property bool sendPending: false
    property bool sending: false
    property int sendSecondsRemaining: 10
    property var lastSent: null
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var senderSources: []
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
    function sendAgentProposal(id, fields) { return "agent-" + id }
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
      mailService.senderSources = []
      mailService.sendIdentities = []
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

    function test_proposal_apply_is_draft_bound() {
      compose.begin("new", null, "", [])
      compose.replaceBody("Manual body\n\nAda")
      var before = compose.currentFields()
      var proposal = compose.outgoingEnvelope()
      proposal.subject = "Proposed subject"
      proposal.body = "Proposed body\n\nAda"
      verify(compose.applyProposal(proposal))
      compare(compose.currentFields().subject, "Proposed subject")
      compare(bodyText(), proposal.body)
      proposal.draftKey = "another-draft"
      compare(compose.applyProposal(proposal), false)
      compare(bodyText(), proposal.body)
      proposal.draftKey = before.draftKey
      proposal.accountId = bobId
      compare(compose.applyProposal(proposal), false)
      compare(bodyText(), proposal.body)
    }

    function test_open_proposal_uses_recoverable_draft_data() {
      return [{tag:"new", replyMessageId:"", mode:"new"},
        {tag:"reply", replyMessageId:"original", mode:"reply"}]
    }

    function test_open_proposal_uses_recoverable_draft(data) {
      var attachment = {filename:"notes.txt",mimeType:"text/plain",data:"SGVsbG8=",
        path:"/synthetic/editor-file",owned:true}
      var envelope = {accountId:bobId,from:bobId,to:adaId,cc:"cc@example.org",bcc:"bcc@example.org",
        replyTo:"reply@example.org",subject:"Proposal",body:"Exact body",attachments:[attachment],
        threadId:"thread",inReplyTo:"message",replyMessageId:data.replyMessageId}
      compose.beginProposal(envelope, "chat")
      compare(compose.mode, data.mode)
      compare(compose.currentFields().accountId, bobId)
      compare(bodyText(), envelope.body)
      compare(compose.currentFields().cc, envelope.cc)
      compare(compose.currentFields().bcc, envelope.bcc)
      compare(compose.agentParentJobId, "chat")
      verify(compose.userModified)
      compare(compose.draftAttachments[0].data, attachment.data)
      compare(compose.draftAttachments[0].path, "")
      compare(compose.draftAttachments[0].owned, false)
      compare(attachment.owned, true)
      var saved = compose.snapshotDraft()
      compose.clearCurrentDraft(false)
      compose.restoreDraft(saved)
      compare(bodyText(), envelope.body)
      compare(compose.mode, data.mode)
    }

    function test_ai_reply_keeps_quote_separate() {
      compose.begin("new", null, "", [])
      compose.mode = "reply"
      compose.replyMessageId = "original"
      compose.bodyQuote = "On Monday, Bob wrote:\n> Original message"
      var quote = compose.bodyQuote
      var manual = "My manual answer\n\nAda"
      compose.replaceBody(manual + "\n\n" + quote)
      compare(compose.currentFields().body, manual)
      var proposal = compose.outgoingEnvelope()
      compare(proposal.replyQuote, quote)
      proposal.body = "Revised answer\n\nAda\n\n" + quote
      verify(compose.applyProposal(proposal))
      compare(bodyText(), proposal.body)
      compare(compose.currentFields().body, "Revised answer\n\nAda")
      compose.replaceBody(manual)
      compare(compose.currentFields().envelope.replyQuote, "")
      compare(compose.currentFields().body, manual)
    }

    function test_quote_snapshot_restore_data() {
      return [{tag:"intact", tail:""}, {tag:"edited", tail:" edited"},
        {tag:"removed", removed:true}, {tag:"legacy", legacy:true}]
    }

    function test_quote_snapshot_restore(data) {
      compose.begin("new", null, "", [])
      compose.mode = "reply"
      compose.replyMessageId = "original"
      var quote = "On Monday, Bob wrote:\n> Original message"
      compose.bodyQuote = quote
      var body = data.removed ? "My answer" : "My answer\n\n" + quote + (data.tail || "")
      compose.replaceBody(body)
      var saved = compose.snapshotDraft()
      compare(saved.bodyQuote, quote)
      if (data.legacy) delete saved.bodyQuote
      compose.clearCurrentDraft(false)
      compose.bodyQuote = "Stale quote from another draft"
      compose.restoreDraft(saved)
      compare(bodyText(), body)
      var retained = !data.removed && !data.legacy && !data.tail
      compare(compose.currentFields().body, retained ? "My answer" : body)
      compare(compose.currentFields().envelope.replyQuote, retained ? quote : "")
    }

    function test_proposal_send_undo_preserves_quote() {
      var quote = "On Monday, Bob wrote:\n> Original message"
      var envelope = {accountId:adaId,from:adaId,to:bobId,subject:"Re: Invoice",
        body:"Proposed reply\n\n"+quote,replyQuote:quote,replyMessageId:"original",
        threadId:"thread",inReplyTo:"message",attachments:[]}
      var id = compose.sendProposal(envelope, "proposal", "chat")
      verify(!!id)
      verify(compose.resumePendingSend(id))
      compare(bodyText(), envelope.body)
      compare(compose.currentFields().body, "Proposed reply")
      compare(compose.currentFields().envelope.replyQuote, quote)
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

    function test_late_native_body_does_not_overwrite_typing() {
      mailService.holdNativeText = true
      mailService.pendingNativeText = []
      mailService.composeAccountId = bobId
      compose.begin("reply", incoming(), "Original body", [])
      var field = named(compose, "compose-body-editor")
      verify(field !== null)
      field.text = "Text entered while the backend was preparing the quote"
      for (var i = 0; i < mailService.pendingNativeText.length; i++) {
        var pending = mailService.pendingNativeText[i]
        pending.callback(pending.result, null)
      }
      compare(field.text, "Text entered while the backend was preparing the quote")
      mailService.holdNativeText = false
      mailService.pendingNativeText = []
    }

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
    function test_sent_follow_up_data() {
      return [
        {tag: "reply", mode: "reply", cc: ""},
        {tag: "reply-all", mode: "replyAll", cc: "copied@example.com"}
      ]
    }

    function test_sent_follow_up(data) {
      mailService.composeAccountId = bobId
      var original = incoming()
      original.from = {email: bobId}
      original.replyTo = {email: bobId}
      original.to = [{email: "recipient@example.com"}, {email: bobId}]
      original.cc = [{email: "copied@example.com"}, {email: "RECIPIENT@example.com"}]
      original.bcc = [{email: "private@example.com"}]
      compose.begin(data.mode, original, "Original body", [])
      compare(compose.currentFields().to, "recipient@example.com")
      compare(compose.snapshotDraft().cc, data.cc)
      compare(compose.snapshotDraft().bcc, "")
      compare(compose.inReplyTo, original.messageId)
    }

    function test_reply_all_keeps_original_cc_without_duplicates() {
      mailService.composeAccountId = bobId
      var original = incoming()
      original.cc = [{email: "copied@example.com"}, {email: bobId},
        {email: "SENDER@example.com"}, {email: adaId}]
      compose.begin("replyAll", original, "Original body", [])
      compare(compose.currentFields().to, "sender@example.com")
      compare(compose.snapshotDraft().cc, adaId + ", copied@example.com")
    }

    function test_sent_alias_is_self_even_when_another_mailbox_is_active() {
      mailService.composeAccountId = bobId
      mailService.senderSources = [{id: bobId, email: bobId,
        aliases: [{email: "alias@example.net"}]}]
      var original = incoming()
      original.from = {email: "ALIAS@example.net"}
      original.to = [{email: "recipient@example.com"}]
      original.cc = [{email: "alias@example.net"}, {email: bobId}, {email: adaId}]
      compose.begin("replyAll", original, "Original body", [])
      compare(compose.currentFields().to, "recipient@example.com")
      compare(compose.snapshotDraft().cc, adaId)
      compare(compose.replyRecipients[0].email, "ALIAS@example.net")
    }
  }
}
