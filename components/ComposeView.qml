import QtQuick
import QtQuick.Controls
import QtQuick.Controls as QQC
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "../message/Direction.js" as Direction
import "../message/Message.js" as Mail
import "../compose/Recipients.js" as Recipients
import "../compose/Senders.js" as Senders

// Composing takes over the whole content area of the one window rather than
// opening a second one: Omarchy's panel mechanism would give an extra window
// its own region, which is not what a reply is. Two mail accounts would
// justify two windows; a reply does not.
//
// Compose, reply, reply-all and forward are the same form with different
// starting values, so `begin()` fills the fields and everything after that is
// one code path.
DropArea {
  id: root

  required property var service
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color dimColor
  required property color dimmerColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  readonly property int formInset: Style.space(18)
  readonly property int formLabelWidth: Style.space(52)
  readonly property int formLabelGap: Style.space(10)

  property bool opened: false
  property bool parkedForSend: false
  // The timer owns this draft while the visible composer remains free.
  property var pendingDraft: null
  // Undo temporarily replaces a newer draft. Closing or resending returns here.
  property var interruptedDraft: null
  // A failed provider save stays reachable after Back or Escape.
  property var recoveryDrafts: []
  property string accountId: ""
  // The provider message that this form replaces when it is saved.
  property string sourceDraftId: ""
  // Both popups reparent themselves into the window overlay, so their state is
  // not reachable by walking this view's children. Named here so the tests can
  // ask whether a control put its own popup away.
  readonly property bool fromMenuOpened: fromMenu.opened
  readonly property bool contactsPickerOpened: contactsPicker.opened
  property int restoreRevision: 0
  property real restoreFlashOpacity: 0
  property string mode: "new"
  property string threadId: ""
  property string inReplyTo: ""
  property bool ccVisible: false
  property bool bccVisible: false
  property string fromEmail: ""
  property var replyRecipients: []
  property bool fromWasChosen: false
  property var toSuggestions: []
  property var ccSuggestions: []
  property var bccSuggestions: []
  property var originalAttachments: []
  property var forwardedAttachments: []
  property bool forwardAttachmentsLoading: false
  property string forwardAttachmentError: ""
  property int forwardLoadSerial: 0
  property var draftAttachments: []
  property var attachJobs: []
  property bool attaching: false
  property bool pasteInFlight: false

  function noteDraftChanged() {
    if (opened) draftChanged()
  }

  onAccountIdChanged: noteDraftChanged()
  onModeChanged: noteDraftChanged()
  onThreadIdChanged: noteDraftChanged()
  onInReplyToChanged: noteDraftChanged()
  onCcVisibleChanged: noteDraftChanged()
  onBccVisibleChanged: noteDraftChanged()
  onFromEmailChanged: noteDraftChanged()
  onDraftAttachmentsChanged: noteDraftChanged()
  onForwardedAttachmentsChanged: noteDraftChanged()

  readonly property string attachScript: service && service.pluginDir
    ? service.pluginDir + "/scripts/attachment.sh" : ""
  readonly property string composeDir: {
    var cache = Quickshell.env("XDG_CACHE_HOME")
    var home = Quickshell.env("HOME")
    var rootDir = cache !== "" ? cache : (home + "/.cache")
    return rootDir + "/omamail/compose"
  }

  readonly property var contactBook: root.service
    && Array.isArray(root.service.recipientContacts)
    ? root.service.recipientContacts : []

  readonly property var fromAliases: {
    if (!root.service || !Array.isArray(root.service.sendAsAliases)) return []
    return root.service.sendAsAliases
  }

  readonly property var fromIdentities: Senders.visible(
    root.service ? root.service.sendIdentities : [],
    root.service ? String(root.service.activeAccountId || "") : "",
    root.mode)

  readonly property bool canChooseFrom: fromIdentities.length > 1

  readonly property string title: {
    if (mode === "reply") return "Reply"
    if (mode === "replyAll") return "Reply all"
    if (mode === "forward") return "Forward"
    if (mode === "draft") return "Draft"
    return "New message"
  }

  function forgetOwned(attachments) {
    var owned = Array.isArray(attachments) ? attachments : []
    for (var i = 0; i < owned.length; i++) {
      if (owned[i] && owned[i].owned && owned[i].path)
        enqueueAttach("forget", owned[i].path)
    }
  }

  function clearCurrentDraft(forgetAttachments) {
    forwardLoadSerial++
    fromMenu.close()
    // Both of these live in the window overlay, and this view is hidden rather
    // than destroyed — so a popup left open outlives the draft it belonged to
    // and sits over the message list.
    contactsPicker.close()
    toField.text = ""
    ccField.text = ""
    bccField.text = ""
    subjectField.text = ""
    bodyEdit.text = ""
    accountId = ""
    sourceDraftId = ""
    mode = "new"
    threadId = ""
    inReplyTo = ""
    ccVisible = false
    bccVisible = false
    fromEmail = ""
    replyRecipients = []
    fromWasChosen = false
    toSuggestions = []
    ccSuggestions = []
    bccSuggestions = []
    originalAttachments = []
    forwardedAttachments = []
    forwardAttachmentsLoading = false
    forwardAttachmentError = ""
    var owned = draftAttachments
    draftAttachments = []
    attachJobs = []
    attaching = false
    pasteInFlight = false
    if (forgetAttachments) forgetOwned(owned)
  }

  function snapshotDraft() {
    return ({
      to: toField.text,
      cc: ccField.text,
      bcc: bccField.text,
      subject: subjectField.text,
      body: bodyEdit.text,
      accountId: accountId,
      sourceDraftId: sourceDraftId,
      mode: mode,
      threadId: threadId,
      inReplyTo: inReplyTo,
      ccVisible: ccVisible,
      bccVisible: bccVisible,
      fromEmail: fromEmail,
      replyRecipients: replyRecipients.slice(),
      fromWasChosen: fromWasChosen,
      originalAttachments: originalAttachments.slice(),
      forwardedAttachments: forwardedAttachments.slice(),
      draftAttachments: draftAttachments.slice()
    })
  }

  function restoreDraft(draft) {
    var saved = draft || ({})
    mode = String(saved.mode || "new")
    accountId = String(saved.accountId || "")
    sourceDraftId = String(saved.sourceDraftId || "")
    threadId = String(saved.threadId || "")
    inReplyTo = String(saved.inReplyTo || "")
    ccVisible = saved.ccVisible === true
    bccVisible = saved.bccVisible === true
    fromEmail = String(saved.fromEmail || "")
    replyRecipients = Array.isArray(saved.replyRecipients)
      ? saved.replyRecipients.slice() : []
    fromWasChosen = saved.fromWasChosen === true
    originalAttachments = Array.isArray(saved.originalAttachments)
      ? saved.originalAttachments.slice() : []
    forwardedAttachments = Array.isArray(saved.forwardedAttachments)
      ? saved.forwardedAttachments.slice() : []
    draftAttachments = Array.isArray(saved.draftAttachments)
      ? saved.draftAttachments.slice() : []
    toField.text = String(saved.to || "")
    ccField.text = String(saved.cc || "")
    bccField.text = String(saved.bcc || "")
    subjectField.text = String(saved.subject || "")
    bodyEdit.text = String(saved.body || "")
    opened = true
    rehydrateDraftAttachments()
  }

  function rehydrateDraftAttachments() {
    var listed = draftAttachments.slice()
    var kept = []
    var recover = []
    for (var i = 0; i < listed.length; i++) {
      var file = listed[i] || ({})
      if (String(file.path || "") !== "" && String(file.data || "") === "")
        recover.push(file)
      else kept.push(file)
    }
    if (recover.length === 0) return
    draftAttachments = kept
    for (var r = 0; r < recover.length; r++)
      enqueueAttach(recover[r].owned === true ? "recover-owned" : "recover",
        String(recover[r].path || ""))
  }

  function reset() {
    clearCurrentDraft(true)
    forgetOwned(pendingDraft ? pendingDraft.draftAttachments : [])
    forgetOwned(interruptedDraft ? interruptedDraft.draftAttachments : [])
    for (var i = 0; i < recoveryDrafts.length; i++)
      forgetOwned(recoveryDrafts[i] ? recoveryDrafts[i].draftAttachments : [])
    pendingDraft = null
    interruptedDraft = null
    recoveryDrafts = []
    parkedForSend = false
    restoreRevision = 0
    restoreFlashOpacity = 0
  }

  function selectPreferredFrom() {
    var choice = root.service ? root.service.preferredSendAs(replyRecipients) : null
    fromEmail = choice ? String(choice.email || "") : ""
  }

  function chooseFrom(identity) {
    var row = identity && typeof identity === "object" ? identity : ({ email: identity })
    fromEmail = String(row.email || "")
    fromWasChosen = true
    fromMenu.close()
    var accountId = String(row.accountId || "")
    if (accountId === "" || !root.service) return
    root.accountId = accountId
    if (String(root.service.activeAccountId || "") === accountId) return
    if (typeof root.service.switchTo === "function") root.service.switchTo(accountId)
  }

  // When a control opens a popup that closes on a press outside itself, the
  // press that reaches the control has already closed it — so by the time the
  // release becomes a click, `opened` reads false and the toggle opens it
  // straight back up. The control could never be used to put its own popup
  // away, and it flickers instead. The moment it closed is what tells "the
  // user wants this open" apart from "this just closed under the same press".
  property double fromMenuClosedAt: 0

  function reopeningAfterOutsidePress(closedAt) {
    return Date.now() - closedAt < 250
  }

  function toggleFromMenu() {
    if (fromMenu.opened) {
      fromMenu.close()
      return
    }
    if (reopeningAfterOutsidePress(fromMenuClosedAt)) return
    fromMenu.open()
  }

  function placeFromMenu() {
    if (!fromMenu.visible) return
    var global = fromButton.mapToGlobal(0, 0)
    var at = root.mapFromGlobal(global.x, global.y)
    var tall = fromMenu.height > 0 ? fromMenu.height : fromMenu.implicitHeight
    var x = Math.max(0, Math.min(at.x, root.width - fromMenu.width))
    var y = at.y + fromButton.height
    if (y + tall > root.height) y = at.y - tall
    if (y + tall > root.height) y = root.height - tall
    if (y < 0) y = 0
    fromMenu.x = x
    fromMenu.y = y
  }

  // Everyone on the original except this mailbox: replying to yourself is
  // never what reply-all was for.
  function otherRecipients(summary) {
    if (!summary) return ""
    var mine = String(root.service ? root.service.accountEmail : "").toLowerCase()
    var list = Array.isArray(summary.to) ? summary.to : []
    var kept = []
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].email || "").toLowerCase() === mine) continue
      kept.push(list[i].email)
    }
    return kept.join(", ")
  }

  function updateRecipientSuggestions() {
    toSuggestions = toField.activeFocus
      ? Recipients.suggest(contactBook, toField.text, 5) : []
    ccSuggestions = ccField.activeFocus
      ? Recipients.suggest(contactBook, ccField.text, 5) : []
    bccSuggestions = bccField.activeFocus
      ? Recipients.suggest(contactBook, bccField.text, 5) : []
  }

  function acceptTo(contact) {
    toField.text = Recipients.accept(toField.text, contact)
    toSuggestions = []
    toField.forceActiveFocus()
  }

  function acceptCc(contact) {
    ccField.text = Recipients.accept(ccField.text, contact)
    ccSuggestions = []
    ccField.forceActiveFocus()
  }

  function acceptBcc(contact) {
    bccField.text = Recipients.accept(bccField.text, contact)
    bccSuggestions = []
    bccField.forceActiveFocus()
  }

  function focusAfterTo() {
    if (root.ccVisible) ccField.forceActiveFocus()
    else if (root.bccVisible) bccField.forceActiveFocus()
    else subjectField.forceActiveFocus()
  }

  function focusAfterCc() {
    if (root.bccVisible) bccField.forceActiveFocus()
    else subjectField.forceActiveFocus()
  }

  function loadForwardAttachments() {
    if (!service || originalAttachments.length === 0) return
    var serial = ++forwardLoadSerial
    forwardAttachmentsLoading = true
    forwardAttachmentError = ""
    forwardedAttachments = []
    service.loadAttachments(service.selectedId, originalAttachments,
      function(loaded, error) {
        if (serial !== root.forwardLoadSerial || !root.opened || root.mode !== "forward") return
        root.forwardAttachmentsLoading = false
        root.forwardAttachmentError = String(error || "")
        root.forwardedAttachments = error ? [] : loaded
      })
  }

  function loadDraftAttachments(messageId, attachments) {
    var listed = Array.isArray(attachments) ? attachments.slice() : []
    originalAttachments = listed
    if (!service || listed.length === 0) return
    var serial = ++forwardLoadSerial
    forwardAttachmentsLoading = true
    forwardAttachmentError = ""
    service.loadAttachments(messageId, listed, function(loaded, error) {
      if (serial !== root.forwardLoadSerial || !root.opened || root.mode !== "draft") return
      root.forwardAttachmentsLoading = false
      root.forwardAttachmentError = String(error || "")
      if (error) {
        if (root.service && typeof root.service.fail === "function") root.service.fail(error)
        return
      }
      root.draftAttachments = Array.isArray(loaded) ? loaded : []
    })
  }

  function begin(nextMode, summary, bodyText, attachments) {
    clearCurrentDraft(true)
    mode = String(nextMode || "new")
    accountId = root.service ? String(root.service.activeAccountId || "") : ""
    opened = true

    if (summary && mode !== "new") {
      var replyTo = summary.replyTo && summary.replyTo.email
        ? summary.replyTo.email : summary.from.email
      threadId = summary.threadId
      inReplyTo = summary.messageId
      // Cc as well as To: an alias is just as often the address a thread
      // copied you on as the one it was sent to, and answering from the
      // account's default instead is how a thread ends up split in two.
      if (mode === "reply" || mode === "replyAll") {
        replyRecipients = (Array.isArray(summary.to) ? summary.to : [])
          .concat(Array.isArray(summary.cc) ? summary.cc : [])
      }

      if (mode === "forward") {
        subjectField.text = "Fwd: " + summary.subject
        originalAttachments = Array.isArray(attachments) ? attachments.slice() : []
        if (originalAttachments.length > 0) loadForwardAttachments()
      } else {
        toField.text = replyTo
        subjectField.text = Mail.replySubject(summary.subject)
        if (mode === "replyAll") {
          ccField.text = otherRecipients(summary)
          ccVisible = ccField.text !== ""
        }
      }
      bodyEdit.text = "\n\n" + Mail.quoteBody(summary, String(bodyText || ""))
    }

    selectPreferredFrom()
    if (root.service) root.service.refreshRecipientContacts()

    // Focus is not placed here. Opening this changes the window's key context,
    // and the context is what moves the keyboard — one mechanism, so the two
    // cannot disagree about where the typing goes.
  }

  // A mailto: link is a new message with the fields already named. Reply and
  // forward stay on `begin`; they fill from a message, not from a URL.
  function beginDraft(draft, messageId, attachments) {
    begin("new", null, "", [])
    var values = draft || ({})
    mode = String(values.mode || "new") === "draft" ? "draft" : "new"
    sourceDraftId = String(messageId || values.sourceDraftId || "")
    threadId = String(values.threadId || "")
    inReplyTo = String(values.inReplyTo || "")
    toField.text = String(values.to || "")
    ccField.text = String(values.cc || "")
    ccVisible = ccField.text !== ""
    bccField.text = String(values.bcc || "")
    bccVisible = bccField.text !== ""
    subjectField.text = String(values.subject || "")
    bodyEdit.text = String(values.body || "")
    var chosenFrom = String(values.from || "")
    if (chosenFrom !== "") {
      fromEmail = chosenFrom
      fromWasChosen = true
    }
    if (mode === "draft") loadDraftAttachments(messageId, attachments)
  }

  // Where the keyboard goes when composing becomes the context. A reply starts
  // in the body above the quote; a new message starts at the address.
  function takeFocus() {
    if (mode === "reply" || mode === "replyAll") {
      bodyEdit.forceActiveFocus()
      bodyEdit.cursorPosition = 0
    } else if (toField.text === "") {
      toField.forceActiveFocus()
    } else if (subjectField.text === "") {
      subjectField.forceActiveFocus()
    } else {
      bodyEdit.forceActiveFocus()
    }
  }

  // The Back control asks the window to save. Discard stays local and
  // destructive. The window owns the save because it owns the provider.
  // Which way what is being written runs. Qt resolves an editable field from
  // the text already in it, so Auto needs nothing added; a direction the writer
  // has chosen has to be carried to the fields, including the empty ones — a
  // reply begun in a right-to-left mailbox should put the caret on the right
  // before there is any text to work it out from.
  property string contentDirection: Direction.MODE_DEFAULT
  readonly property string writingDirection: Direction.forced(root.contentDirection)
  readonly property var composeAlignment: Direction.hasAnswer(root.writingDirection)
    ? (Direction.isRightToLeft(root.writingDirection) ? Text.AlignRight : Text.AlignLeft)
    : undefined

  signal closed()
  signal closeRequested()
  signal sendQueued()
  signal draftChanged()

  function finish() {
    clearCurrentDraft(true)
    if (interruptedDraft) {
      var held = interruptedDraft
      interruptedDraft = null
      restoreDraft(held)
      return
    }
    if (recoveryDrafts.length > 0) {
      var queued = recoveryDrafts.slice()
      var recovered = queued.shift()
      recoveryDrafts = queued
      restoreDraft(recovered)
      restoreRevision++
      restoreFlash.restart()
      return
    }
    opened = false
    closed()
  }

  function hasMeaningfulDraft() {
    if (String(toField.text || "").trim() !== "") return true
    if (String(ccField.text || "").trim() !== "") return true
    if (String(bccField.text || "").trim() !== "") return true
    if (String(subjectField.text || "").trim() !== "") return true
    if (String(bodyEdit.text || "").trim() !== "") return true
    return allOutgoingAttachments().length > 0
  }

  function fieldsForDraft(saved) {
    var draft = saved || ({})
    var attachments = []
    var forwarded = draft.mode === "forward" && Array.isArray(draft.forwardedAttachments)
      ? draft.forwardedAttachments : []
    var owned = Array.isArray(draft.draftAttachments) ? draft.draftAttachments : []
    var i
    for (i = 0; i < forwarded.length; i++) attachments.push(forwarded[i])
    for (i = 0; i < owned.length; i++) attachments.push(owned[i])
    return ({
      accountId: String(draft.accountId || ""),
      draftId: String(draft.sourceDraftId || ""),
      from: String(draft.fromEmail || ""),
      to: String(draft.to || ""),
      cc: String(draft.cc || ""),
      bcc: String(draft.bcc || ""),
      subject: String(draft.subject || ""),
      body: String(draft.body || ""),
      attachments: attachments,
      threadId: draft.mode === "forward" ? "" : String(draft.threadId || ""),
      inReplyTo: draft.mode === "forward" ? "" : String(draft.inReplyTo || "")
    })
  }

  function detachForSave() {
    var saved = snapshotDraft()
    clearCurrentDraft(false)
    if (interruptedDraft) {
      var held = interruptedDraft
      interruptedDraft = null
      restoreDraft(held)
    } else {
      opened = false
      closed()
    }
    return saved
  }

  function completeDetachedSave(saved) {
    forgetOwned(saved && saved.draftAttachments ? saved.draftAttachments : [])
  }

  function recoverDetachedSave(saved) {
    if (!saved) return
    if (!opened) {
      restoreDraft(saved)
      restoreRevision++
      restoreFlash.restart()
      return
    }
    var queued = recoveryDrafts.slice()
    queued.push(saved)
    recoveryDrafts = queued
  }

  function parkForSend() {
    pendingDraft = snapshotDraft()
    clearCurrentDraft(false)
    opened = false
    parkedForSend = true
    if (interruptedDraft) {
      var held = interruptedDraft
      interruptedDraft = null
      restoreDraft(held)
    } else {
      sendQueued()
    }
  }

  function resumePendingSend() {
    if (!parkedForSend || !pendingDraft) return false
    if (opened) interruptedDraft = snapshotDraft()
    clearCurrentDraft(false)
    var draft = pendingDraft
    pendingDraft = null
    parkedForSend = false
    restoreDraft(draft)
    restoreRevision++
    restoreFlash.restart()
    return true
  }

  function interruptedFields() {
    var saved = interruptedDraft
    if (!saved) return null
    return fieldsForDraft(saved)
  }

  function completeInterruptedSave(expected) {
    if (!interruptedDraft || interruptedDraft !== expected) return false
    forgetOwned(interruptedDraft.draftAttachments)
    interruptedDraft = null
    return true
  }

  function completePendingSend() {
    if (!parkedForSend || !pendingDraft) return false
    forgetOwned(pendingDraft.draftAttachments)
    pendingDraft = null
    parkedForSend = false
    return true
  }

  function cancelOrFinish() {
    closeRequested()
  }

  function submit() {
    // The send key is answered by action id, and the compose keyboard context
    // also covers the calendar event form — a composer that is not open must
    // not answer it, or a draft parked for the undo window would send twice.
    if (!opened || !service) return
    if (forwardAttachmentsLoading || forwardAttachmentError !== "") return
    var accepted = service.send(({
      from: root.fromEmail,
      to: toField.text,
      cc: ccField.text,
      bcc: bccField.text,
      subject: subjectField.text,
      body: bodyEdit.text,
      attachments: root.allOutgoingAttachments(),
      // A forward starts a new conversation; a reply must stay in the old one.
      threadId: root.mode === "forward" ? "" : root.threadId,
      inReplyTo: root.mode === "forward" ? "" : root.inReplyTo
    }))
    if (accepted === true) parkForSend()
  }

  function allOutgoingAttachments() {
    var out = []
    var forwarded = root.mode === "forward" ? root.forwardedAttachments : []
    var i
    for (i = 0; i < forwarded.length; i++) out.push(forwarded[i])
    for (i = 0; i < root.draftAttachments.length; i++) out.push(root.draftAttachments[i])
    return out
  }

  function chooseFiles() {
    enqueueAttach("pick")
  }

  function paste() {
    if (root.pasteInFlight) return
    root.pasteInFlight = true
    enqueueAttach("clipboard", "")
  }

  function pasteKey(event) {
    if (!event) return
    if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_V) {
      event.accepted = true
      root.paste()
    }
  }

  function pasteText() {
    if (toField.activeFocus) toField.paste()
    else if (ccField.activeFocus) ccField.paste()
    else if (bccField.activeFocus) bccField.paste()
    else if (subjectField.activeFocus) subjectField.paste()
    else bodyEdit.paste()
  }

  function enqueueAttach(mode, path) {
    var jobs = root.attachJobs.slice()
    jobs.push({ mode: String(mode || "read"), path: String(path || "") })
    root.attachJobs = jobs
    pumpAttach()
  }

  function pumpAttach() {
    if (attacher.running || root.attachJobs.length === 0) return
    if (root.attachScript === "") {
      root.attachJobs = []
      if (service && typeof service.fail === "function")
        service.fail("The attachment helper is missing")
      return
    }
    var job = root.attachJobs[0]
    var rest = root.attachJobs.slice(1)
    root.attachJobs = rest
    root.attaching = true
    attacher.jobMode = job.mode
    if (job.mode === "clipboard")
      attacher.command = [root.attachScript, "clipboard", root.composeDir]
    else if (job.mode === "pick")
      attacher.command = [root.attachScript, "pick"]
    else if (job.mode === "forget")
      attacher.command = [root.attachScript, "forget", root.composeDir, job.path]
    else
      attacher.command = [root.attachScript, "read", job.path]
    attacher.running = true
  }

  function finishAttach(mode, text) {
    var result = null
    try { result = JSON.parse(String(text || "")) }
    catch (e) { result = null }

    if (mode === "clipboard") root.pasteInFlight = false

    if (mode === "forget") {
      root.attaching = root.attachJobs.length > 0
      pumpAttach()
      return
    }

    if (mode === "pick" || (mode === "clipboard" && result && result.ok === true
        && Array.isArray(result.paths))) {
      root.attaching = root.attachJobs.length > 0
      if (result && result.ok === true && Array.isArray(result.paths)) {
        for (var p = 0; p < result.paths.length; p++)
          enqueueAttach("read", String(result.paths[p] || ""))
      }
      pumpAttach()
      return
    }

    if (mode === "clipboard" && result && result.ok !== true
        && String(result.error || "") === "no-image") {
      root.attaching = root.attachJobs.length > 0
      root.pasteText()
      pumpAttach()
      return
    }

    if (!result || result.ok !== true) {
      root.attaching = root.attachJobs.length > 0
      if (service && typeof service.fail === "function")
        service.fail(result && result.error ? String(result.error)
          : "That file could not be attached")
      pumpAttach()
      return
    }

    var entry = ({
      filename: String(result.filename || "attachment"),
      mimeType: String(result.mimeType || "application/octet-stream"),
      size: Math.max(0, Math.floor(Number(result.size) || 0)),
      data: String(result.data || ""),
      path: String(result.path || ""),
      owned: mode === "clipboard" || mode === "recover-owned"
    })
    var next = root.draftAttachments.slice()
    next.push(entry)
    root.draftAttachments = next
    root.attaching = root.attachJobs.length > 0
    pumpAttach()
  }

  function removeAttachment(at) {
    var list = root.draftAttachments.slice()
    if (at < 0 || at >= list.length) return
    var entry = list[at]
    list.splice(at, 1)
    root.draftAttachments = list
    if (entry && entry.owned && entry.path)
      enqueueAttach("forget", entry.path)
  }

  function attachDroppedUrls(urls) {
    var list = urls || []
    for (var i = 0; i < list.length; i++) {
      var url = String(list[i] || "")
      var path = url.indexOf("file://") === 0 ? decodeURIComponent(url.substring(7)) : url
      if (path !== "") enqueueAttach("read", path)
    }
  }

  anchors.fill: parent
  keys: ["text/uri-list"]
  onDropped: function(drop) {
    if (!drop.hasUrls) return
    drop.acceptProposedAction()
    root.attachDroppedUrls(drop.urls)
  }
  // Only while it is actually in use. A component that declares `focus: true`
  // owns the window's focus even when invisible — Qt does not exclude hidden
  // items — and an owner that accepts keys is a sink. This swallowed every
  // Escape in the window, which is why Esc looked intermittent: whether it
  // worked depended on where the user had last clicked.
  focus: root.opened

  onFromAliasesChanged: {
    if (opened && !fromWasChosen) selectPreferredFrom()
  }
  onContactBookChanged: updateRecipientSuggestions()

  SequentialAnimation {
    id: restoreFlash
    running: false
    NumberAnimation {
      target: root
      property: "restoreFlashOpacity"
      from: 0.32
      to: 0
      duration: 720
      easing.type: Easing.OutCubic
    }
  }

  // ----------------------------------------------------------- header
  //
  // One compact title band. Back is the exit path and the title names the
  // draft; splitting them into two stacked bands gave one short decision the
  // hierarchy of a whole settings page.
  Item {
    id: head
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    height: Style.space(44)

    BackBar {
      id: backBar
      anchors.left: parent.left
      anchors.leftMargin: Style.space(14)
      anchors.verticalCenter: parent.verticalCenter
      textColor: root.textColor
      dimColor: root.dimColor
      panelFontFamily: root.panelFontFamily
      onActivated: root.cancelOrFinish()
    }

    Row {
      id: titleRow
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(10)

      PanelSectionHeader {
        anchors.verticalCenter: parent.verticalCenter
        text: root.title
        foreground: root.textColor
        fontFamily: root.panelFontFamily
      }
    }

    PanelSeparator {
      anchors.bottom: parent.bottom
      width: parent.width
      foreground: root.textColor
    }
  }

  // ----------------------------------------------------------- fields
  //
  // A label column wide enough for the longest of To / Cc / Subject keeps
  // the three inputs aligned without a grid.

  Column {
    id: fields
    objectName: "compose-fields"
    anchors.top: head.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    // Suggestions extend below this column into the message body. Raising only
    // the row cannot cross the sibling boundary, so the body painted over the
    // popup even though the popup itself had a high z value.
    z: 10

    Item {
      width: parent.width
      implicitHeight: fromButton.implicitHeight + Style.space(14)

      Text {
        id: fromLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "From"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      // Sized to the address rather than to the row: a full-width trigger puts
      // the chevron a screen away from the name it belongs to. The extra width
      // is the room the chevron is drawn into, over the button's own trailing
      // padding, so the two read as one control.
      Button {
        id: fromButton
        objectName: "compose-from-button"
        readonly property real trailing: root.canChooseFrom
          ? Style.font.iconSmall + Style.spacing.controlGap : 0

        anchors.left: fromLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.verticalCenter: parent.verticalCenter
        width: Math.min(implicitWidth + trailing,
          parent.width - fromLabel.width - Style.space(46))
        text: root.fromEmail
        foreground: root.textColor
        accent: root.accentColor
        background: Style.normalFillFor(root.textColor, root.accentColor)
        bordered: true
        fontFamily: root.panelFontFamily
        fontSize: Style.font.bodySmall
        verticalPadding: Style.spacing.inputPaddingY
        leftAlign: true
        selected: fromMenu.opened
        enabled: root.canChooseFrom
        onClicked: root.toggleFromMenu()

        // The kit's own chevron is a font glyph, which at this size renders
        // thinner than every other mark in the window. This is the app's drawn
        // set, at the size the rest of the icons use.
        ActionIcon {
          anchors.right: parent.right
          anchors.rightMargin: fromButton.horizontalPadding
          anchors.verticalCenter: parent.verticalCenter
          visible: root.canChooseFrom
          enabled: false
          name: "chevronDown"
          iconSize: Style.font.iconSmall
          color: root.dimColor
        }
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      width: parent.width
      z: root.toSuggestions.length > 0 ? 100 : 0
      // The field plus the same breathing room it carries inside itself, so
      // its border is not crowded against the rules above and below. Derived
      // rather than a fixed height: the field grows with the theme's font
      // scale, and a fixed row would scale that growth a second time.
      implicitHeight: toField.implicitHeight + Style.space(14)

      Text {
        id: toLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "To"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Row {
        id: copyToggles
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)

        Button {
          id: contactsButton
          objectName: "compose-contacts-button"
          text: "Contacts"
          foreground: contactsPicker.opened ? root.textColor : root.dimColor
          bordered: false
          fontSize: Style.font.caption
          onClicked: {
            var global = contactsButton.mapToGlobal(0, contactsButton.height)
            contactsPicker.toggleAt(global.x, global.y)
          }
        }

        Button {
          id: ccToggle
          objectName: "compose-cc-toggle"
          text: "Cc"
          foreground: root.ccVisible ? root.textColor : root.dimColor
          bordered: false
          fontSize: Style.font.caption
          onClicked: root.ccVisible = !root.ccVisible
        }

        Button {
          id: bccToggle
          objectName: "compose-bcc-toggle"
          text: "Bcc"
          foreground: root.bccVisible ? root.textColor : root.dimColor
          bordered: false
          fontSize: Style.font.caption
          onClicked: root.bccVisible = !root.bccVisible
        }
      }

      TextField {
        id: toField
        objectName: "compose-to-field"
        anchors.left: toLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: copyToggles.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "recipient@example.com"
        onTextChanged: {
          root.updateRecipientSuggestions()
          root.noteDraftChanged()
        }
        onActiveFocusChanged: root.updateRecipientSuggestions()
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          root.pasteKey(event)
          if (event.accepted) return
          if (root.toSuggestions.length === 0) return
          if (event.key === Qt.Key_Down) {
            toSuggestionsPopup.moveSelection(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            toSuggestionsPopup.moveSelection(-1)
            event.accepted = true
          }
        }
        onAccepted: {
          if (root.toSuggestions.length > 0) toSuggestionsPopup.acceptSelection()
          else root.focusAfterTo()
        }
      }

      RecipientSuggestions {
        id: toSuggestionsPopup
        objectName: "compose-to-suggestions"
        x: toField.x
        y: parent.height - Style.space(2)
        width: toField.width
        z: 60
        contacts: root.toSuggestions
        textColor: root.textColor
        dimColor: root.dimColor
        accentColor: root.accentColor
        popupBackgroundColor: root.popupBackgroundColor
        popupBorderColor: root.popupBorderColor
        panelFontFamily: root.panelFontFamily
        onChosen: function(contact) { root.acceptTo(contact) }
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      visible: root.ccVisible
      width: parent.width
      z: root.ccSuggestions.length > 0 ? 100 : 0
      // The field plus the same breathing room it carries inside itself, so
      // its border is not crowded against the rules above and below. Derived
      // rather than a fixed height: the field grows with the theme's font
      // scale, and a fixed row would scale that growth a second time.
      implicitHeight: ccField.implicitHeight + Style.space(14)

      Text {
        id: ccLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Cc"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: ccField
        objectName: "compose-cc-field"
        anchors.left: ccLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        onTextChanged: {
          root.updateRecipientSuggestions()
          root.noteDraftChanged()
        }
        onActiveFocusChanged: root.updateRecipientSuggestions()
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          root.pasteKey(event)
          if (event.accepted) return
          if (root.ccSuggestions.length === 0) return
          if (event.key === Qt.Key_Down) {
            ccSuggestionsPopup.moveSelection(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            ccSuggestionsPopup.moveSelection(-1)
            event.accepted = true
          }
        }
        onAccepted: {
          if (root.ccSuggestions.length > 0) ccSuggestionsPopup.acceptSelection()
          else root.focusAfterCc()
        }
      }

      RecipientSuggestions {
        id: ccSuggestionsPopup
        x: ccField.x
        y: parent.height - Style.space(2)
        width: ccField.width
        z: 60
        contacts: root.ccSuggestions
        textColor: root.textColor
        dimColor: root.dimColor
        accentColor: root.accentColor
        popupBackgroundColor: root.popupBackgroundColor
        popupBorderColor: root.popupBorderColor
        panelFontFamily: root.panelFontFamily
        onChosen: function(contact) { root.acceptCc(contact) }
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      visible: root.bccVisible
      width: parent.width
      z: root.bccSuggestions.length > 0 ? 100 : 0
      implicitHeight: bccField.implicitHeight + Style.space(14)

      Text {
        id: bccLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Bcc"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: bccField
        objectName: "compose-bcc-field"
        anchors.left: bccLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        onTextChanged: {
          root.updateRecipientSuggestions()
          root.noteDraftChanged()
        }
        onActiveFocusChanged: root.updateRecipientSuggestions()
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          root.pasteKey(event)
          if (event.accepted) return
          if (root.bccSuggestions.length === 0) return
          if (event.key === Qt.Key_Down) {
            bccSuggestionsPopup.moveSelection(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            bccSuggestionsPopup.moveSelection(-1)
            event.accepted = true
          }
        }
        onAccepted: {
          if (root.bccSuggestions.length > 0) bccSuggestionsPopup.acceptSelection()
          else subjectField.forceActiveFocus()
        }
      }

      RecipientSuggestions {
        id: bccSuggestionsPopup
        objectName: "compose-bcc-suggestions"
        x: bccField.x
        y: parent.height - Style.space(2)
        width: bccField.width
        z: 60
        contacts: root.bccSuggestions
        textColor: root.textColor
        dimColor: root.dimColor
        accentColor: root.accentColor
        popupBackgroundColor: root.popupBackgroundColor
        popupBorderColor: root.popupBorderColor
        panelFontFamily: root.panelFontFamily
        onChosen: function(contact) { root.acceptBcc(contact) }
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      width: parent.width
      // The field plus the same breathing room it carries inside itself, so
      // its border is not crowded against the rules above and below. Derived
      // rather than a fixed height: the field grows with the theme's font
      // scale, and a fixed row would scale that growth a second time.
      implicitHeight: subjectField.implicitHeight + Style.space(14)

      Text {
        id: subjectLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.verticalCenter: parent.verticalCenter
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Subject"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: subjectField
        objectName: "compose-subject-field"
        anchors.left: subjectLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.verticalCenter: parent.verticalCenter
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Subject"
        horizontalAlignment: root.composeAlignment
        KeyNavigation.tab: bodyEdit
        onTextChanged: root.noteDraftChanged()
        onAccepted: bodyEdit.forceActiveFocus()
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: root.pasteKey(event)
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }

    Item {
      visible: root.mode === "forward" && root.originalAttachments.length > 0
      width: parent.width
      implicitHeight: attachmentSummary.implicitHeight + Style.space(14)

      Text {
        id: attachmentLabel
        anchors.left: parent.left
        anchors.leftMargin: root.formInset
        anchors.top: parent.top
        anchors.topMargin: Style.space(9)
        width: root.formLabelWidth
        horizontalAlignment: Text.AlignRight
        text: "Files"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Column {
        id: attachmentSummary
        anchors.left: attachmentLabel.right
        anchors.leftMargin: root.formLabelGap
        anchors.right: retryAttachments.left
        anchors.rightMargin: Style.space(8)
        anchors.top: parent.top
        anchors.topMargin: Style.space(7)
        spacing: Style.space(3)

        Text {
          width: parent.width
          text: root.forwardAttachmentsLoading
            ? "Loading original attachments..."
            : (root.forwardAttachmentError !== ""
              ? root.forwardAttachmentError
              : Mail.formatCount(root.forwardedAttachments.length, "original attachment")
                + " will be forwarded")
          textFormat: Text.PlainText
          color: root.forwardAttachmentError !== "" ? root.accentColor : root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Repeater {
          model: root.originalAttachments
          Text {
            required property var modelData
            width: attachmentSummary.width
            textFormat: Text.PlainText
            text: String(modelData.filename || "attachment") + "  "
              + Mail.formatSize(modelData.size)
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideMiddle
          }
        }
      }

      Button {
        id: retryAttachments
        visible: root.forwardAttachmentError !== ""
        anchors.right: parent.right
        anchors.rightMargin: Style.space(18)
        anchors.top: parent.top
        anchors.topMargin: Style.space(6)
        text: "Retry"
        foreground: root.textColor
        bordered: false
        fontSize: Style.font.caption
        onClicked: root.loadForwardAttachments()
      }

      PanelSeparator {
        anchors.bottom: parent.bottom
        width: parent.width
        foreground: root.textColor
      }
    }
  }

  Rectangle {
    objectName: "compose-fields-restore-flash"
    anchors.fill: fields
    z: 20
    enabled: false
    color: root.accentColor
    opacity: root.restoreFlashOpacity
  }

  QQC.Popup {
    id: fromMenu
    objectName: "compose-from-menu"
    width: Math.min(Style.space(360), root.width - Style.space(36))
    implicitHeight: Math.min(fromRows.implicitHeight + Style.space(8), Style.space(260))
    padding: Style.space(4)
    modal: false
    focus: opened
    z: 50
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.placeFromMenu()
    onOpened: root.placeFromMenu()
    onClosed: root.fromMenuClosedAt = Date.now()
    background: Rectangle {
      radius: Style.cornerRadius
      color: Qt.rgba(root.popupBackgroundColor.r, root.popupBackgroundColor.g,
        root.popupBackgroundColor.b, 1)
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: ListView {
      id: fromRows
      implicitHeight: contentHeight
      clip: true
      model: root.fromIdentities

      delegate: Rectangle {
        id: fromRow
        required property var modelData

        width: fromMenu.width - fromMenu.leftPadding - fromMenu.rightPadding
        implicitHeight: Style.space(42)
        radius: Style.cornerRadius
        color: root.fromEmail.toLowerCase() === String(modelData.email || "").toLowerCase()
          ? Style.selectedFillFor(root.textColor, root.accentColor)
          : (fromHover.hovered
            ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

        Column {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(9)
          anchors.right: parent.right
          anchors.rightMargin: Style.space(9)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(1)

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: String(fromRow.modelData.email || "")
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: root.fromEmail.toLowerCase()
              === String(fromRow.modelData.email || "").toLowerCase()
            elide: Text.ElideMiddle
          }

          Text {
            width: parent.width
            visible: text !== ""
            textFormat: Text.PlainText
            text: Senders.subtitle(fromRow.modelData)
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        HoverHandler { id: fromHover }
        TapHandler { onTapped: root.chooseFrom(fromRow.modelData) }
      }
    }
  }

  ContactsPicker {
    id: contactsPicker
    objectName: "compose-contacts-picker"
    contacts: root.contactBook
    textColor: root.textColor
    dimColor: root.dimColor
    accentColor: root.accentColor
    popupBackgroundColor: root.popupBackgroundColor
    popupBorderColor: root.popupBorderColor
    panelFontFamily: root.panelFontFamily
    onContactChosen: function(contact, target) {
      if (target === "cc") {
        root.ccVisible = true
        ccField.text = Recipients.append(ccField.text, contact)
        ccField.forceActiveFocus()
      } else if (target === "bcc") {
        root.bccVisible = true
        bccField.text = Recipients.append(bccField.text, contact)
        bccField.forceActiveFocus()
      } else {
        toField.text = Recipients.append(toField.text, contact)
        toField.forceActiveFocus()
      }
    }
  }

  // ------------------------------------------------------------- body
  //
  // The kit has no multi-line field, so this is a TextEdit on the plain
  // window ground; the rows above already carry the structure.
  Flickable {
    id: bodyFlick
    objectName: "compose-body"
    anchors.top: fields.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: attachStrip.top
    anchors.leftMargin: Style.space(18)
    anchors.rightMargin: Style.space(18)
    anchors.topMargin: Style.space(12)
    contentWidth: width
    contentHeight: bodyEdit.height
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    TextEdit {
      id: bodyEdit
      objectName: "compose-body-editor"
      activeFocusOnTab: true
      width: bodyFlick.width
      // Tall enough to fill the visible area even when the draft is short.
      // A TextEdit sized to its text leaves the space below it belonging to
      // the Flickable, so clicking into the empty part of a mostly-empty
      // message does nothing at all.
      height: Math.max(implicitHeight, bodyFlick.height)
      selectByMouse: true
      wrapMode: TextEdit.Wrap
      textFormat: TextEdit.PlainText
      horizontalAlignment: root.composeAlignment
      color: root.textColor
      selectionColor: Style.selectionFillFor(root.textColor, root.accentColor)
      selectedTextColor: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      onTextChanged: root.noteDraftChanged()
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: root.pasteKey(event)
    }
  }

  Rectangle {
    objectName: "compose-body-restore-flash"
    anchors.fill: bodyFlick
    z: bodyFlick.z + 1
    enabled: false
    color: root.accentColor
    opacity: root.restoreFlashOpacity
  }

  Item {
    id: attachStrip
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: actions.top
    height: root.draftAttachments.length > 0
      ? Math.min(attachFlick.contentHeight, Style.space(240)) + Style.space(12)
      : 0

    Flickable {
      id: attachFlick
      anchors.fill: parent
      anchors.leftMargin: Style.space(18)
      anchors.rightMargin: Style.space(18)
      anchors.topMargin: Style.space(4)
      visible: root.draftAttachments.length > 0
      clip: true
      contentWidth: width
      contentHeight: attachList.height
      boundsBehavior: Flickable.StopAtBounds
      ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

      Column {
        id: attachList
        width: attachFlick.width
        spacing: Style.space(8)

        Repeater {
          model: root.draftAttachments

          Column {
            id: attachItem
            required property var modelData
            required property int index
            width: attachList.width
            spacing: Style.space(4)

            Image {
              visible: String(attachItem.modelData.mimeType || "").indexOf("image/") === 0
                && String(attachItem.modelData.path || "") !== ""
              width: parent.width
              height: visible
                ? Math.min(Math.max(sourceSize.height, Style.space(72)), Style.space(200))
                : 0
              fillMode: Image.PreserveAspectFit
              asynchronous: true
              cache: false
              source: visible ? ("file://" + String(attachItem.modelData.path || "")) : ""
            }

            Row {
              spacing: Style.space(6)
              width: parent.width

              ActionIcon {
                anchors.verticalCenter: parent.verticalCenter
                name: "attachment"
                iconSize: Style.font.iconSmall
                color: root.dimColor
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                width: Math.max(0, parent.width - Style.space(120))
                textFormat: Text.PlainText
                text: String(attachItem.modelData.filename || "attachment")
                color: root.textColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideMiddle
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Mail.formatSize(attachItem.modelData.size)
                color: root.dimmerColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
              }

              IconButton {
                anchors.verticalCenter: parent.verticalCenter
                iconName: "close"
                tooltipText: "Remove"
                foreground: root.dimColor
                hoverColor: root.textColor
                fontFamily: root.panelFontFamily
                iconSize: Style.font.iconSmall
                onClicked: root.removeAttachment(attachItem.index)
              }
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------- actions

  Item {
    id: actions
    anchors.bottom: parent.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    height: Style.space(52)

    PanelSeparator {
      anchors.top: parent.top
      width: parent.width
      foreground: root.textColor
    }

    Row {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(18)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(10)

      IconTextButton {
        iconName: "send"
        tooltipText: "Send · Ctrl+Enter"
        text: root.service && root.service.sending ? "Sending" : "Send"
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        enabled: !!root.service && !root.service.sending && !root.service.sendPending
          && !root.forwardAttachmentsLoading && root.forwardAttachmentError === ""
        onClicked: root.submit()
      }

      IconTextButton {
        iconName: "attachment"
        tooltipText: "Attach files..."
        text: root.attaching ? "Attaching" : "Attach..."
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        enabled: !!root.service && !root.attaching
        onClicked: root.chooseFiles()
      }

      Button {
        text: "Discard"
        foreground: root.dimColor
        bordered: false
        fontSize: Style.font.bodySmall
        onClicked: root.finish()
      }
    }

  }

  Process {
    id: attacher
    property string jobMode: ""
    stdinEnabled: false
    stdout: StdioCollector { id: attachOut; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      root.finishAttach(jobMode, String(attachOut.text || ""))
    }
  }

}
