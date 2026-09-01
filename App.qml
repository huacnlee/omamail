import QtQuick
import QtQuick.Controls
import QtQuick.Window
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

import "account/Model.js" as Model
import "account/Accounts.js" as Accounts
import "compose/Recovery.js" as Recovery
import "keys/Keymap.js" as Keymap
import "message/Mailto.js" as Mailto
import "message/Message.js" as Message
import "components"
import "calendar"

// The application window. The shell loads this entry point when the plugin is
// summoned and calls open()/close() on it; the FloatingWindow follows.
//
// Compose takes over the content area of this same window rather than opening
// a second one; Omarchy's panel mechanism would give an extra window a region
// of its own, which is not what a reply is.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null
  property bool opened: false
  property bool closingFromHost: false
  property string draftSavedNotice: ""

  readonly property string pluginId: manifest && manifest.id
    ? String(manifest.id) : "omamail"
  readonly property string composeRecoveryPath: {
    var config = Quickshell.env("XDG_CONFIG_HOME")
      || (Quickshell.env("HOME") + "/.config")
    return config + "/omamail/compose.json"
  }
  property var composeRecovery: Recovery.empty()
  property bool composeRecoveryLoaded: false
  property bool composeRecoveryRestoring: false
  property int composeRecoveryRevision: 0
  property bool composeDetachingForSave: false
  property string lastComposeRecoveryText: ""
  property string composeWritePayload: ""
  property bool composeWriteQueued: false

  function loadComposeRecovery(raw) {
    lastComposeRecoveryText = String(raw || "")
    composeRecovery = Recovery.parse(raw)
    composeRecoveryLoaded = true
    Qt.callLater(root.restoreComposeRecovery)
  }

  function restoreComposeRecovery() {
    if (!opened || !composeRecoveryLoaded || composeRecovery.active !== true
        || compose.opened || !composeRecovery.draft) return false
    var accountId = String(composeRecovery.draft.accountId || "")
    if (accountId !== "" && service
        && String(service.activeAccountId || "") !== accountId
        && typeof service.switchTo === "function") service.switchTo(accountId)
    composeReturnView = String(composeRecovery.returnView || "list")
    composeRecoveryRestoring = true
    compose.restoreDraft(composeRecovery.draft)
    composeRecoveryRestoring = false
    return true
  }

  function saveComposeRecovery(saved) {
    composeRecoveryTimer.stop()
    var draft = saved || (compose.opened ? compose.snapshotDraft()
      : (compose.parkedForSend ? compose.pendingDraft : null))
    var raw = Recovery.serialize(composeReturnView, draft)
    if (raw === "") {
      clearComposeRecovery()
      return composeRecoveryRevision
    }
    composeRecovery = Recovery.parse(raw)
    if (raw === lastComposeRecoveryText) return composeRecoveryRevision
    composeRecoveryRevision++
    lastComposeRecoveryText = raw
    writeComposeRecovery(raw)
    return composeRecoveryRevision
  }

  function scheduleComposeRecovery() {
    if (composeRecoveryRestoring) return
    composeRecoveryTimer.restart()
  }

  function clearComposeRecovery(expectedRevision) {
    if (expectedRevision !== undefined
        && Number(expectedRevision) !== composeRecoveryRevision) return false
    composeRecoveryTimer.stop()
    composeRecovery = Recovery.empty()
    composeRecoveryRevision++
    if (lastComposeRecoveryText === "") return true
    lastComposeRecoveryText = ""
    writeComposeRecovery('{"version":1,"active":false}')
    return true
  }

  function writeComposeRecovery(raw) {
    composeWritePayload = String(raw || "")
    if (!service || String(service.pluginDir || "") === "") return
    if (composeRecoveryWriter.running) {
      composeWriteQueued = true
      return
    }
    composeWriteQueued = false
    composeRecoveryWriter.command = [String(service.pluginDir)
      + "/scripts/config-store.sh", "compose.json"]
    composeRecoveryWriter.running = true
  }

  FileView {
    id: composeRecoveryFile
    path: root.composeRecoveryPath
    printErrors: false
    onLoaded: root.loadComposeRecovery(text())
    onLoadFailed: root.loadComposeRecovery("")
  }

  Timer {
    id: composeRecoveryTimer
    interval: 300
    repeat: false
    onTriggered: root.saveComposeRecovery()
  }

  Process {
    id: composeRecoveryWriter
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.composeWritePayload + "\n")
      root.composeWritePayload = ""
    }
    onExited: {
      if (root.composeWriteQueued) {
        root.composeWriteQueued = false
        Qt.callLater(function() {
          root.writeComposeRecovery(root.composeWritePayload)
        })
      } else root.composeWritePayload = ""
    }
  }

  readonly property color foreground: Color.foreground
  readonly property color background: Color.background
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  // Destructive controls consume a role named for their meaning. Omarchy's
  // foundational palette currently calls that source `urgent`; keeping the
  // mapping here stops account pages from confusing urgency with danger.
  readonly property color danger: Color.urgent
  readonly property color popupBackground: Color.popups.background
  readonly property color popupBorder: Color.popups.border
  readonly property color calendarBorder: Style.normalBorderColor
  readonly property color calendarTodayBackground: Style.selectedAccentFill
  readonly property int calendarBorderWidth: Style.normalBorderWidth
  // Mixed toward the ground rather than Qt.darker: on a light theme darkening
  // an almost-black foreground makes secondary text heavier than body text.
  readonly property color dim: Qt.rgba(
    foreground.r * 0.68 + background.r * 0.32,
    foreground.g * 0.68 + background.g * 0.32,
    foreground.b * 0.68 + background.b * 0.32, 1)
  readonly property color dimmer: Qt.rgba(
    foreground.r * 0.45 + background.r * 0.55,
    foreground.g * 0.45 + background.g * 0.55,
    foreground.b * 0.45 + background.b * 0.55, 1)
  // Omarchy's palette has no separate "primary": `accent` is it. This theme's
  // accent is near fully saturated, which is right for a 5px unread dot and
  // wrong for a link sitting inside a paragraph. Same hue, same lightness,
  // capped saturation — calm enough to read past, still clearly a link.
  readonly property color link: Qt.hsla(accent.hslHue,
    Math.min(accent.hslSaturation, 0.55),
    accent.hslLightness, 1.0)

  readonly property string fontFamily: Style.font.family

  function copyText(text) {
    clipboardProxy.text = String(text || "")
    clipboardProxy.selectAll()
    clipboardProxy.copy()
    clipboardProxy.deselect()
  }

  TextEdit {
    id: clipboardProxy
    visible: false
    readOnly: true
  }

  // Two breakpoints, not a continuum: three columns, list-plus-reader with the
  // sidebar collapsed to a strip, and a single column that swaps list for
  // reader.
  readonly property bool wide: window.width >= Style.space(1000)
  readonly property bool compact: window.width < Style.space(760)

  property string currentView: "list"
  readonly property bool calendarVisible: currentView === "calendar"
  property string cursorId: ""
  // Kept across messages, and across the window being closed: how somebody
  // reads their mail is a fact about them, not about the message that made them
  // reach for it. The service holds it because that is what writes it to disk.
  readonly property string bodyMode: service ? service.bodyMode : "reader"
  // Reading zoom for the message body only. The window's own chrome follows
  // the theme's font scale, which is Omarchy's to set, not this app's. The
  // service holds it because it is written to disk: a size somebody reached for
  // is theirs until they change it, not until they close the window.
  readonly property real bodyZoom: service ? service.bodyZoom : 1.0
  // 0 means "proportional"; anything else is a width somebody dragged to.
  property real listWidth: 0

  function zoomBy(step) {
    if (service) service.setBodyZoom(Model.zoomAfterStep(service.bodyZoom, step))
  }
  property bool shortcutHelpVisible: false
  property bool setupVisible: false
  // Which kind of mailbox is being added. Asked before either form, because the
  // two have nothing in common and guessing from the address would be worse
  // than asking — a Gmail address is a legitimate IMAP account too.
  property bool pickingProvider: false
  // Latched once the question has been answered, so the chooser does not come
  // back every time a half-finished setup re-renders.
  property bool providerChosen: false
  // Latched while a setup or edit page is open. Service.providerId briefly
  // falls back to Gmail while an account host is rebuilt after saving; that is
  // transport lifecycle, not a request to replace an IMAP page with Gmail's.
  property string editingProvider: ""
  // Set while a picked provider is being turned into an account row, so the
  // signal that normally lands the user in Settings leaves them on the form.
  property bool openingNewMailbox: false
  property bool accountDraftOpen: false
  property bool settingsVisible: false
  // Something the window needs to say that no account is reporting — refusing a
  // duplicate mailbox, for one. Cleared on a timer so it cannot outlive its
  // moment on the status line.
  property string notice: ""
  onNoticeChanged: if (notice !== "") noticeTimer.restart()
  // Open by default, but narrow. The longest mailbox name is "All mail" — at
  // 11px monospace that needs about 116px including the icon, the gaps and a
  // count, so the rail costs little enough to leave standing.
  //
  // The service owns it, because the service is what outlives the window: the
  // rail used to come back open on every restart, which is a preference the
  // user had already expressed and the window kept forgetting.
  readonly property bool sidebarCollapsed: !!service && service.sidebarCollapsed
  function toggleSidebar() {
    if (service) service.setSidebarCollapsed(!service.sidebarCollapsed)
  }

  function openSettings() {
    shortcutHelpVisible = false
    setupVisible = false
    settingsVisible = true
  }

  readonly property bool ready: !!service && service.ready
  // The walkthrough is for having no mailbox at all. A mailbox that has been
  // added but not signed in yet belongs in settings, next to the ones that are.
  readonly property bool anyReady: !!service && service.anyAccountReady
  readonly property bool showSetup: setupVisible || !anyReady
  // A setup already part-done answers the question by itself: an account with
  // credentials has had its kind chosen, whether or not this window asked.
  readonly property bool setupUnderway: !!service && !!service.auth
    && service.auth.credentialsPresent
  readonly property bool showPicker: showSetup
    && (pickingProvider || (!providerChosen && !anyReady && !setupUnderway))
  readonly property bool showSettings: settingsVisible && !showSetup
  // Anything the window goes *into*. The mail chrome stands down for all of it.
  readonly property bool showPage: showSetup || showSettings
  readonly property bool composing: compose.opened || eventComposer.opened

  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(String(payloadJson || "{}")) || ({}) } catch (e) {}
    closingFromHost = false
    opened = true
    if (service) service.windowOpen = true
    if (payload.mailbox && service) service.selectMailbox(String(payload.mailbox))
    if (payload.accountId && service) service.switchTo(String(payload.accountId))
    if (payload.messageId) Qt.callLater(function() {
      root.openMessage(String(payload.messageId))
    })
    if (payload.view === "calendar") {
      currentView = "calendar"
      Qt.callLater(function() {
        calendarView.showEvent(String(payload.eventId || ""), Number(payload.eventStart || 0))
      })
    }
    var draft = Mailto.draftFromPayload(payload)
    if (draft) root.openDraft(draft)
    Qt.callLater(root.restoreComposeRecovery)
    // The list is usually already loaded by the time the window is summoned —
    // the service keeps running while it is shut — so waiting for the next
    // change to seat the cursor leaves the first j with nowhere to move from.
    cursorId = Model.cursorAfterReload(service ? service.messages : [], cursorId)
    Qt.callLater(function() { focusScope.applyContextFocus() })
  }

  function close() {
    closingFromHost = true
    if (compose.opened || compose.parkedForSend) saveComposeRecovery()
    opened = false
    if (service) service.windowOpen = false
    closingFromHost = false
  }

  function requestClose() {
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
    else close()
  }

  // How a message is read is a preference and survives; the heavy-document
  // override is a per-message decision about one specific message and does not.
  function openMessage(id) {
    if (!service) return
    pendingComposeMode = ""
    pendingDraftId = ""
    reader.forceRichAnyway = false
    cursorId = String(id || "")
    service.select(cursorId)
    currentView = "reader"
  }

  function editDraft(id) {
    if (!service || service.mailboxKey !== "drafts") return false
    var draftId = String(id || "")
    if (draftId === "") return false
    composeReturnView = currentView
    pendingComposeMode = ""
    pendingDraftId = draftId
    if (service.selectedId !== draftId || service.detailLoading
        || !service.detailPainted || !service.selectedMessage) service.select(draftId)
    resumeHeldDraft()
    if (pendingDraftId !== "") Qt.callLater(root.resumeHeldDraft)
    return true
  }

  function backToList() {
    pendingComposeMode = ""
    pendingDraftId = ""
    if (service) service.clearSelection()
    currentView = "list"
    Qt.callLater(function() { focusScope.applyContextFocus() })
  }

  // Moving the cursor has to bring the row with it. The list is a Column in a
  // Flickable rather than a ListView — the panel already owns a scroller — so
  // there is no positionViewAtIndex and this has to be said out loud.
  //
  // Called from here rather than from cursorId changing, because hovering a row
  // moves the cursor too, and scrolling a half-visible row into view under the
  // pointer fights the mouse that is pointing at it.
  function revealCursorRow() {
    if (!listFlick.visible) return
    var bounds = list.boundsFor(cursorId)
    if (!bounds) return
    listFlick.contentY = Model.contentYToReveal(listFlick.contentY,
      listFlick.height, list.y + bounds.y, bounds.height,
      listFlick.contentHeight, Style.space(8))
  }

  function moveCursor(delta) {
    if (!service) return
    var next = service.cursorOffset(cursorId, delta)
    if (next === "") return
    cursorId = next
    revealCursorRow()
    // Moving is not opening. This used to open whatever it landed on while the
    // reader was up, which made stepping through a list a way to mark half of
    // it read without having looked at any of it. Enter and "o" open.
  }

  // An answer needs the message it is answering, and opening one only starts
  // the fetch — select() clears the summary and the body first. Beginning the
  // draft in the same breath addressed nobody and quoted nothing, which is what
  // the list row's own Reply menu did. Held until the fetch lands instead.
  property string pendingComposeMode: ""
  property string pendingDraftId: ""
  // Where the draft was raised from, so that leaving it goes back there.
  // Answering from the list opens the message being answered — that is the
  // reply's doing, not somewhere the reader asked to be — so closing the draft
  // has to leave the message with it. Anything raised while reading stays in
  // the reader, which is where it came from.
  property string composeReturnView: ""

  function startCompose(mode) {
    if (!service) return
    pendingDraftId = ""
    var next = String(mode || "new")
    if (next !== "new" && !service.selectedMessage) {
      pendingComposeMode = next
      return
    }
    pendingComposeMode = ""
    compose.begin(next, service.selectedMessage, service.selectedBody.text,
      service.selectedAttachments)
  }

  // A mailto: URL, or the blank draft `compose: true` asks for. The window is
  // already open when this runs — summon delivers the payload to open().
  function openDraft(draft) {
    if (!draft) return
    pendingDraftId = ""
    composeReturnView = currentView
    compose.beginDraft(draft)
  }

  function resumeHeldCompose() {
    if (pendingComposeMode === "" || !service || !service.selectedMessage) return
    var mode = pendingComposeMode
    pendingComposeMode = ""
    startCompose(mode)
  }

  function resumeHeldDraft() {
    if (pendingDraftId === "" || !service) return
    if (service.selectedId !== pendingDraftId || service.detailLoading
        || !service.detailPainted || !service.selectedMessage) return
    var messageId = pendingDraftId
    pendingDraftId = ""
    compose.beginDraft(Message.draftFields(service.selectedMessage,
      service.selectedBody.text), messageId, service.selectedAttachments)
  }

  // Answering from the list opens what is being answered first, the way the
  // row's own menu does. Anything already open is left alone: re-selecting it
  // would throw away the body that is on screen and fetch it again.
  function composeFromCursor(mode) {
    if (!service || cursorId === "") return
    composeReturnView = currentView
    if (service.selectedId !== cursorId) openMessage(cursorId)
    startCompose(mode)
  }

  // A draft closed by its own Back, by Escape, by Discard, or by having been
  // sent. All four are the same question: where was this raised from.
  function leaveCompose() {
    var from = composeReturnView
    composeReturnView = ""
    if (from === "list" && currentView === "reader") backToList()
  }

  function saveAndLeaveCompose() {
    if (!service || !compose.hasMeaningfulDraft()) {
      compose.finish()
      return
    }
    var saved = compose.snapshotDraft()
    var recoveryRevision = saveComposeRecovery(saved)
    composeDetachingForSave = true
    compose.detachForSave()
    composeDetachingForSave = false
    var fields = compose.fieldsForDraft(saved)
    service.saveDraft(fields, function(result, error) {
      if (!root) return
      if (error) {
        compose.recoverDetachedSave(saved)
        if (root.composeRecoveryRevision === recoveryRevision)
          root.saveComposeRecovery(saved)
        service.fail("Could not save draft: " + String(error))
        return
      }
      compose.completeDetachedSave(saved)
      if (compose.opened) root.scheduleComposeRecovery()
      else root.clearComposeRecovery(recoveryRevision)
      var warning = String(result && result.warning || "")
      root.draftSavedNotice = warning === "" ? "Draft saved" : warning
      if (warning !== "" && service && typeof service.note === "function")
        service.note(warning)
      draftSavedTimer.restart()
      if (service.mailboxKey === "drafts") service.refresh()
    })
  }

  function undoPendingSend() {
    if (!service || !service.undoSend()) return false
    if (!compose.resumePendingSend()) return true
    var interrupted = compose.interruptedDraft
    var fields = compose.interruptedFields()
    if (!interrupted || !fields) return true
    service.saveDraft(fields, function(saved, error) {
      if (!root) return
      if (error) {
        service.fail("Could not save the newer draft: " + String(error))
        return
      }
      if (!compose.completeInterruptedSave(interrupted)) return
      root.draftSavedNotice = "Draft saved"
      draftSavedTimer.restart()
    })
    return true
  }

  Timer {
    id: draftSavedTimer
    interval: 4000
    repeat: false
    onTriggered: root.draftSavedNotice = ""
  }

  // Acting on the open message closes it: it is about to leave this list.
  function actOnCursor(action) {
    if (!service || cursorId === "") return false
    var acted = cursorId
    var wasOpen = currentView === "reader" && service.selectedId === acted
    // Worked out before the action, while the row still has neighbours.
    var next = Model.cursorAfterRemoval(service.messages, acted)
    var leaves = !Model.survivesAction(service.mailboxKey, action)
    if (!service.act(acted, action)) return false
    if (!leaves) return true
    // The row is going and the cursor must not go with it: a cursor on a
    // message that is no longer listed cannot be found, so the next j restarts
    // at the top. Archiving one message used to send it back to the first row.
    if (wasOpen) {
      if (next !== "") openMessage(next)
      else backToList()
      return true
    }
    cursorId = next
    revealCursorRow()
    return true
  }

  function goMailbox(key) {
    if (!service) return
    service.selectMailbox(key)
    backToList()
  }

  // The rail as the keys see it: one numbered list, the same one the badges
  // are drawn from, so the number beside a row and the row a number opens are
  // the same fact rather than two.
  readonly property var sidebarSlots: service
    ? Model.sidebarSlots(service.mailboxes, service.labels, 10) : []

  function goSlot(index) {
    if (!service || index < 0 || index >= sidebarSlots.length) return
    var slot = sidebarSlots[index]
    if (slot.kind === "mailbox") return goMailbox(slot.key)
    // Not a search: the provider decides what selecting a label means, and on
    // IMAP it is a folder rather than a term to look for.
    service.selectLabel(slot.name)
    backToList()
  }

  // One answer per key id. The ids come from keys/Keymap.js; adding a key is a
  // row there and a case here, and nothing else. The sequence says which key of
  // a row fired, for the rows that bind more than one meaning.
  function runShortcut(id, sequence) {
    // The sheet is on top, so moving moves it. It is a plain overlay rather
    // than a popup, which is why its keys can come from here at all — the
    // switcher's cannot, and answers them itself.
    if (shortcutHelpVisible) {
      if (id === "cursorDown") return shortcutHelp.scrollBy(1)
      if (id === "cursorUp") return shortcutHelp.scrollBy(-1)
    }
    if (id === "cursorDown") return moveCursor(1)
    if (id === "cursorUp") return moveCursor(-1)
    if (id === "open") return openMessage(cursorId)
    if (id === "backToList") return backToList()
    if (id === "archive") return actOnCursor("archive")
    if (id === "trash") return actOnCursor("trash")
    // Through the same guard actOnCursor applies rather than around it:
    // starring with nothing selected used to call through with an empty id.
    if (id === "star") {
      if (service && cursorId !== "") service.toggleStar(cursorId)
      return
    }
    if (id === "markRead") return actOnCursor("markRead")
    if (id === "markUnread") return actOnCursor("markUnread")
    if (id === "reply") return composeFromCursor("reply")
    if (id === "replyAll") return composeFromCursor("replyAll")
    if (id === "forward") return composeFromCursor("forward")
    if (id === "compose") {
      if (service && service.mailboxKey === "drafts" && editDraft(cursorId)) return
      composeReturnView = currentView
      return startCompose("new")
    }
    if (id === "createEvent") return eventComposer.begin()
    if (id === "calendarNext") return calendarView.moveSelection(1)
    if (id === "calendarPrevious") return calendarView.moveSelection(-1)
    if (id === "openCalendarEvent") return calendarView.activateSelection()
    if (id === "calendarPreviousPeriod") return calendarView.movePeriod(-1)
    if (id === "calendarNextPeriod") return calendarView.movePeriod(1)
    if (id === "calendarToday") return calendarView.goToday()
    if (id === "calendarWeek") return calendarView.setView("week")
    if (id === "calendarMonth") return calendarView.setView("month")
    if (id === "send") return compose.submit()
    if (id === "undoSend") { undoPendingSend(); return }
    if (id === "search") return searchBar.focusField()
    if (id === "goMailbox") return goSlot(Keymap.slotFor(id, sequence))
    if (id === "goAccount") {
      var accountIndex = Keymap.slotFor(id, sequence)
      if (service && accountIndex >= 0 && accountIndex < service.accountCount)
        root.switchAccount(accountIndex)
      return
    }
    if (id === "switchAccount") return accountSwitcher.openCentered()
    if (id === "calendar") {
      if (calendarVisible) backToList()
      else {
        currentView = "calendar"
        calendarView.refresh()
      }
      return
    }
    if (id === "mailView") return backToList()
    if (id === "calendarView") {
      currentView = "calendar"
      calendarView.refresh()
      return
    }
    if (id === "toggleSidebar") return toggleSidebar()
    if (id === "zoomIn") return zoomBy(0.1)
    if (id === "zoomOut") return zoomBy(-0.1)
    if (id === "zoomReset") { if (service) service.setBodyZoom(1.0); return }
    if (id === "refresh") {
      if (calendarVisible) calendarView.refresh()
      else if (service) service.refresh()
      return
    }
    if (id === "settings") return openSettings()
    if (id === "help") {
      shortcutHelpVisible = !shortcutHelpVisible
      return
    }
    if (id === "back") return goBack()
  }

  // What Escape means, in the order the window is stacked. The row menu, the
  // app menu and the account switcher are absent on purpose: a QQC.Popup with
  // CloseOnEscape consumes the key itself, so a branch for them here would
  // never run.
  function goBack() {
    if (shortcutHelpVisible) shortcutHelpVisible = false
    // A query being typed is the nearest thing to leave: clear it if there is
    // one, then hand the keyboard back to the mailbox. This used to live in
    // SearchBar as its own Keys handler, which a window Shortcut silently beats.
    // A query being typed is the nearest thing to leave: clear it if there is
    // one, then hand the keyboard back. Parked directly rather than through
    // applyContextFocus, which would still read the context as "search" —
    // the field has not lost the focus yet at this point.
    else if (searchBar.fieldFocused) {
      if (searchBar.queryText !== "") searchBar.clear()
      focusScope.parkKeyboard()
    }
    else if (eventComposer.opened) eventComposer.close()
    else if (compose.opened) saveAndLeaveCompose()
    else if (setupVisible) setupVisible = false
    else if (settingsVisible) settingsVisible = false
    else if (currentView === "calendar" && calendarView.detailOpen) calendarView.closeDetail()
    else if (currentView === "reader" || currentView === "calendar") backToList()
    else if (service && service.searchQuery !== "") service.search("")
    else requestClose()
  }

  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onReplySent() {
      if (!compose.completePendingSend()) return
      if (compose.opened) root.scheduleComposeRecovery()
      else root.clearComposeRecovery()
    }
    // Every time the list is replaced — first arrival, a mailbox switch, a
    // search, a refresh that dropped things. A cursor whose message survived
    // keeps its place; one whose message is gone would be unfindable, and an
    // unfindable cursor sends the next j to the top of the list.
    // The message a held draft was waiting for. Both halves have to have
    // landed: the summary carries the addresses and the subject, and the body
    // is what gets quoted — so whichever of them arrives last is what starts
    // the draft, and `Qt.callLater` is what lets the fetch finish assigning the
    // rest before either is believed.
    //
    // Watching the body alone was not enough, and the case it missed was every
    // message that had been opened before. Those paint from the cache, so the
    // body changes while the summary is still null; when the summary lands the
    // markup has not changed, so the body is not written a second time and
    // nothing fires again. Reply, reply-all and forward raised from the list
    // opened the message and stopped there.
    function onSelectedBodyChanged() { Qt.callLater(function() {
      root.resumeHeldCompose()
      root.resumeHeldDraft()
    }) }
    function onSelectedMessageChanged() { Qt.callLater(function() {
      root.resumeHeldCompose()
      root.resumeHeldDraft()
    }) }

    function onMessagesChanged() {
      root.cursorId = Model.cursorAfterReload(
        root.service ? root.service.messages : [], root.cursorId)
    }
    // A new account has no mailbox yet, so the only useful place to be is the
    // page that gives it one.
    // A new mailbox appears as a row in Settings, waiting to be signed in.
    // Sending the window to the first-run walkthrough instead showed a setup
    // that was already finished, for a different account.
    function onDuplicateAccount(email) {
      root.notice = email + " is already added"
    }
    function onAccountAdded() {
      // A mailbox added through the chooser goes straight to its own form; the
      // user has already said what they want and asking them to find the new
      // row in Settings would be a step backwards. One added any other way
      // still appears there, waiting to be signed in.
      if (root.openingNewMailbox) {
        root.openingNewMailbox = false
        root.settingsVisible = false
        root.setupVisible = true
        return
      }
      root.setupVisible = false
      root.settingsVisible = true
    }
  }

  // The setup pages. Built by the Loader above, one at a time, so the ones not
  // in use hold no half-typed fields and no state to go stale.
  Component {
    id: providerPickerPage

    ProviderPicker {
      textColor: root.foreground
      dimColor: root.dim
      accentColor: root.accent
      panelFontFamily: root.fontFamily
      canLeave: root.anyReady
      onBackRequested: {
        root.pickingProvider = false
        root.editingProvider = ""
        root.setupVisible = false
      }
      onChosen: function(providerId) {
        root.pickingProvider = false
        root.providerChosen = true
        root.editingProvider = providerId
        // On first run the row already exists and only needs its kind; after
        // that, adding a mailbox is what makes one.
        if (root.service && root.service.hasSavedAccounts) {
          root.openingNewMailbox = true
          root.accountDraftOpen = true
          root.service.addAccount(providerId)
        } else if (root.service) {
          root.service.configureCurrentAccount({ provider: providerId })
        }
      }
    }
  }

  Component {
    id: gmailSetupPage

    SetupPage {
      service: root.service
      textColor: root.foreground
      dimColor: root.dim
      dangerColor: root.danger
      accentColor: root.accent
      panelFontFamily: root.fontFamily
      canLeave: root.anyReady
      accountCount: root.service ? root.service.accountCount : 1
      onBackRequested: root.leaveSetup()
      onRemoveRequested: root.removeCurrentAccountFromEditor()
    }
  }

  Component {
    id: heySetupPage

    HeySetupPage {
      service: root.service
      textColor: root.foreground
      dimColor: root.dim
      dangerColor: root.danger
      accentColor: root.accent
      panelFontFamily: root.fontFamily
      canLeave: root.anyReady
      accountCount: root.service ? root.service.accountCount : 1
      onBackRequested: root.leaveSetup()
      onRemoveRequested: root.removeCurrentAccountFromEditor()
    }
  }

  Component {
    id: imapSetupPage

    ImapSetupPage {
      service: root.service
      textColor: root.foreground
      dimColor: root.dim
      dangerColor: root.danger
      accentColor: root.accent
      panelFontFamily: root.fontFamily
      canLeave: root.anyReady
      accountCount: root.service ? root.service.accountCount : 1
      onBackRequested: root.leaveSetup()
      onRemoveRequested: root.removeCurrentAccountFromEditor()
    }
  }

  function switchAccount(index) {
    if (!service) return false
    var keepCalendar = calendarVisible
    var mailbox = service.mailboxKey
    if (service.switchToIndex(index) !== true) return false
    if (keepCalendar) {
      currentView = "calendar"
      return true
    }
    var target = Model.mailboxAfterAccountSwitch(mailbox, service.mailboxes)
    if (target !== "") service.selectMailbox(target)
    backToList()
    return true
  }

  function editAccount(index) {
    if (!service) return
    var accounts = service.accountSummaries || []
    editingProvider = index >= 0 && index < accounts.length
      ? String(accounts[index].provider || "gmail") : "gmail"
    if (!service.switchToIndex(index)) return
    providerChosen = true
    pickingProvider = false
    settingsVisible = false
    setupVisible = true
  }

  function leaveSetup() {
    if (accountDraftOpen && service) service.discardCurrentDraft()
    accountDraftOpen = false
    setupVisible = false
    editingProvider = ""
  }

  function removeCurrentAccountFromEditor() {
    if (!service || service.accountCount <= 1) return
    var index = service.indexOfActiveAccount()
    if (index < 0) return
    var values = service.accountSummaries || []
    var request = Accounts.removalRequest({ accounts: values }, index)
    if (request) accountRemovalDialog.openFor(request)
  }

  function confirmAccountRemoval(request) {
    if (!service) return
    var index = Accounts.confirmRemoval({ accounts: service.accountSummaries || [] }, request)
    if (index < 0) return
    service.removeAccountAt(index)
    accountDraftOpen = false
    leaveSetup()
    settingsVisible = true
  }

  // A delete asks first, and asks naming the target. Only the confirmation
  // reaches the controller, with the event the dialog named.
  function requestEventDelete(sourceId, event) {
    if (!event) return
    confirmDeleteDialog.openFor({
      kind: "event",
      name: String(event.summary || "Untitled event"),
      message: "This event will be permanently deleted.",
      sourceId: String(sourceId || ""),
      event: event
    })
  }

  function confirmDelete(request) {
    if (!service) return
    if (request.kind === "event" && request.event) {
      service.calendarController.deleteEvent(request.sourceId, request.event)
      calendarView.closeDetail()
    }
  }

  FloatingWindow {
    id: window
    visible: root.opened
    title: "Omamail"
    color: root.background
    implicitWidth: Style.space(980)
    implicitHeight: Style.space(720)
    minimumSize: Qt.size(Style.space(760), Style.space(520))

    onVisibleChanged: {
      if (!visible && root.opened && !root.closingFromHost) root.requestClose()
    }

    FocusScope {
      id: focusScope
      anchors.fill: parent
      focus: true

      // Where the window is, and the only thing that says what a key means.
      // A page is a form before it is anything else, a draft beats reading, a
      // query being typed beats the list underneath it.
      // Holding Ctrl names every row on the rail, so the digits are read rather
      // than remembered. A `Keys` handler, which bindings may not use — but a
      // modifier on its own cannot be a `Shortcut`, so there is no binding to
      // route and nothing for `KeyRouter` to own. It accepts nothing: whatever
      // follows Ctrl still goes exactly where it went before.
      //
      // `activeFocus` is what clears it. Ctrl+Tab can leave the window with Ctrl
      // down and the release can land somewhere else, so waiting for a release
      // that is never coming would paint the numbers on permanently.
      property bool ctrlDown: false
      readonly property bool ctrlHeld: ctrlDown && activeFocus
        && (keyContext === "list" || keyContext === "reader")

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Control) focusScope.ctrlDown = true
      }
      Keys.onReleased: function(event) {
        if (event.key === Qt.Key_Control) focusScope.ctrlDown = false
      }
      onActiveFocusChanged: if (!activeFocus) ctrlDown = false

      readonly property string keyContext: Keymap.contextFor(({
        showPage: root.showPage,
        composing: root.composing,
        searchFocused: searchBar.fieldFocused,
        calendarVisible: root.calendarVisible,
        currentView: root.currentView,
        sendPending: !!root.service && root.service.sendPending
      }))

      // The context owns the keyboard. Changing it moves the focus to whatever
      // that context types into, or parks it when the context types into
      // nothing — so a field that has been dismissed cannot go on eating keys.
      //
      // Keeping these as two things is the bug this replaces: the context came
      // from the screen while the focus stayed wherever the last click left it,
      // and a closed compose field kept swallowing j and k. One mechanism now,
      // and there is nothing to keep in step.
      onKeyContextChanged: Qt.callLater(applyContextFocus)
      function applyContextFocus() {
        if (keyContext === "compose") {
          if (eventComposer.opened) eventComposer.takeFocus()
          else compose.takeFocus()
        }
        else if (keyContext === "search") searchBar.focusField()
        else parkKeyboard()
      }

      // forceActiveFocus on the scope itself is a no-op: it re-elects the
      // scope's current focus item, which is the very field being left. It has
      // to land on a plain Item for the field to actually let go.
      function parkKeyboard() {
        keyboardHome.forceActiveFocus()
      }

      // Where the keyboard lives when nothing is being typed into.
      Item {
        id: keyboardHome
        width: 1
        height: 1
      }

      // ------------------------------------------------------------ header

      Item {
        id: header
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(48)
        visible: !root.composing

        // Identity first, controls after, with a rule between them: the mark
        // and the name say what this window is, and everything to their right
        // does something.
        Row {
          id: headerLeft
          anchors.left: parent.left
          anchors.leftMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(8)

          ActionIcon {
            anchors.verticalCenter: parent.verticalCenter
            name: "gmail"
            iconSize: Style.font.iconLarge
            color: root.foreground
            markColor: root.accent
            brand: true
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.compact
            text: "Omamail"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
          }

          // Next to the mark: this is the window's own menu, not an action on
          // the mailbox. Anchored to the button's own edge so it lands in the
          // same place however the control was pressed.
          IconButton {
            id: menuButton
            anchors.verticalCenter: parent.verticalCenter
            iconName: "menu"
            tooltipText: "Menu"
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            selected: appMenu.opened
            onClicked: {
              var scene = mapToGlobal(0, height)
              appMenu.openAt(scene.x, scene.y)
            }
          }
        }

        // The slot is whatever the two clusters leave, so the field shrinks with
        // the window instead of running underneath Check mail. Centring it in
        // the header and reserving a fixed width could not work: the reserve is
        // split evenly either side, while the controls are all on the left.
        Item {
          id: searchSlot
          anchors.left: headerLeft.right
          anchors.right: headerRight.left
          anchors.leftMargin: Style.space(12)
          anchors.rightMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          height: searchBar.implicitHeight

          SearchBar {
            id: searchBar
            anchors.verticalCenter: parent.verticalCenter
            // Centred on the header rather than on the gap, so it lines up with
            // the window instead of with whatever the controls happen to leave.
            // Clamped into the slot, which is what keeps it off Check mail when
            // the two clusters are not the same width.
            x: Math.max(0, Math.min(parent.width - width,
              (header.width - width) / 2 - parent.x))
            // Capped well short of the gap it is given: a search field as wide
            // as the window looks like the window's main event, and it is not.
            width: Math.min(Style.space(340), parent.width)
            // Below this it is a slot too small to type in; the shortcut still
            // works and reopens it as the window grows.
            visible: !root.showPage && !root.composing && !root.calendarVisible
              && parent.width >= Style.space(120)
          textColor: root.foreground
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          serverSearching: !!root.service && root.service.serverSearchLoading
          // A search replaces the list, so the message still open in the
          // reader is almost certainly not in the results any more.
          onSubmitted: function(query) {
            if (!root.service) return
            root.service.search(query)
            root.backToList()
          }
          onCleared: {
            if (!root.service) return
            root.service.search("")
            root.backToList()
          }
          }
        }

        Row {
          id: headerRight
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          // Checking for mail and writing one are both things you do to the
          // mailbox as a whole, so they sit together. The menu is the window's
          // own, and it stays on the left with the mark.
          IconButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage && !root.composing
            iconName: "refresh"
            tooltipText: root.calendarVisible
              ? (root.service && root.service.calendarController.loading
                ? "Loading calendars" : "Refresh calendars · F5")
              : (root.service && root.service.listLoading
                ? "Checking for mail" : "Check mail · F5")
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready && (root.calendarVisible
              ? !(root.service && root.service.calendarController.loading)
              : !(root.service && root.service.listLoading))
            onClicked: {
              if (root.calendarVisible) calendarView.refresh()
              else if (root.service) root.service.refresh()
            }
          }

          IconTextButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage && !root.composing && root.calendarVisible
            text: "Create event..."
            iconName: "plus"
            foreground: root.dim
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            enabled: root.ready
            onClicked: eventComposer.begin()
          }

          IconButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage && !root.composing && !root.calendarVisible
            iconName: "send"
            tooltipText: "Compose · c"
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready
            onClicked: {
              root.composeReturnView = root.currentView
              root.startCompose("new")
            }
          }

        }

        PanelSeparator {
          anchors.bottom: parent.bottom
          width: parent.width
          foreground: root.foreground
        }
      }

      // -------------------------------------------------------------- body

      Item {
        id: body
        anchors.top: header.visible ? header.bottom : parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: statusBar.top

        MailboxSidebar {
          id: sidebar
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: root.sidebarCollapsed ? Style.space(44) : Style.space(148)
          visible: !root.compact && !root.showPage && !root.composing
          collapsed: root.sidebarCollapsed
          calendarSelected: root.calendarVisible
          service: root.service
          textColor: root.foreground
          accentColor: root.accent
          dimColor: root.dim
          panelFontFamily: root.fontFamily
          switcherOpen: accountSwitcher.opened
          slots: root.sidebarSlots
          numbersVisible: focusScope.ctrlHeld
          onSwitcherRequested: function(sceneX, sceneY) { accountSwitcher.openAt(sceneX, sceneY) }
          onMailboxSelected: function(key) { root.goMailbox(key) }
          onCalendarRequested: {
            root.currentView = "calendar"
            calendarView.refresh()
          }
          // Not a search: the provider decides what selecting a label means,
          // and on IMAP it is a folder rather than a term to look for.
          onLabelSelected: function(labelId, name) {
            root.service.selectLabel(name)
            root.backToList()
          }
        }

        // Narrow windows lose the sidebar; the same mailboxes come back as a
        // scrolling strip above the list.
        MailboxTabs {
          id: tabs
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.margins: Style.space(14)
          visible: root.compact && !root.showPage && !root.composing && root.currentView === "list"
          textColor: root.foreground
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          // The account's own mailboxes, not a fixed set: this row and the
          // sidebar it replaces on a narrow window must offer the same ones.
          allMailboxes: root.service ? root.service.mailboxes : []
          current: root.service ? root.service.mailboxKey : "inbox"
          unread: root.service ? root.service.inboxUnread : 0
          onSelected: function(key) { root.goMailbox(key) }
        }

        Item {
          id: listColumn
          anchors.left: sidebar.visible ? sidebar.right : parent.left
          anchors.top: tabs.visible ? tabs.bottom : parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: tabs.visible ? Style.space(8) : 0
          // Proportional until somebody drags the divider, then whatever they
          // dragged it to. The floor is low on purpose: at a hundred pixels the
          // column is a strip of times and initials, which is a legitimate way
          // to work when the message is what you are reading. Refusing to go
          // there was the app deciding how someone else should use their screen.
          width: root.compact
            ? (root.currentView === "list" ? parent.width : 0)
            : Math.max(Style.space(100),
                Math.min(parent.width - Style.space(360),
                  root.listWidth > 0 ? root.listWidth
                    : Math.min(Style.space(460), Math.round(parent.width * 0.34))))
          visible: width > 0 && !root.showPage && !root.composing
            && !root.calendarVisible

          // The scroller fills the column so its bar sits on the column edge;
          // the breathing room is padding on the content, not a margin on the
          // viewport, which would push the bar inward with it.
          Flickable {
            id: listFlick
            anchors.fill: parent
            contentWidth: width
            contentHeight: list.implicitHeight + Style.space(16)
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            MessageList {
              id: list
              y: Style.space(8)
              // Full width, so selected and hovered rows meet the splitter.
              // Text and action breathing room belongs inside MessageRow;
              // shrinking the whole list leaves a conspicuous dead strip.
              width: listFlick.width
              service: root.service
              textColor: root.foreground
              accentColor: root.accent
              dimColor: root.dim
              panelFontFamily: root.fontFamily
              cursorId: root.cursorId
              onMessageActivated: function(id) { root.openMessage(id) }
              onMenuRequested: function(id, sceneX, sceneY) {
                root.cursorId = id
                rowMenu.openAt(id, sceneX, sceneY)
              }
            }
          }

        }

        // The divider between the list and the message, and the handle that
        // moves it. A hairline is the right thing to look at and the wrong
        // thing to aim at, so the grab area is wider than the rule it draws.
        Item {
          id: listSplitter
          anchors.left: listColumn.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: Style.space(5)
          visible: listColumn.visible && !root.compact
          z: 5

          PanelSeparator {
            // The visible rule meets the list edge. The rest of the splitter's
            // width remains to its right as an easy drag target.
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 1
            foreground: root.foreground
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.SplitHCursor
            property real grabbedAt: 0
            property real grabbedWidth: 0

            onPressed: function(mouse) {
              grabbedAt = mapToItem(body, mouse.x, mouse.y).x
              grabbedWidth = listColumn.width
            }
            onPositionChanged: function(mouse) {
              if (!pressed) return
              var moved = mapToItem(body, mouse.x, mouse.y).x - grabbedAt
              root.listWidth = grabbedWidth + moved
            }
            // Back to the proportional default, which is what most people
            // want after one bad drag.
            onDoubleClicked: root.listWidth = 0
          }
        }

        MessageReader {
          id: reader
          anchors.left: listSplitter.visible ? listSplitter.right : parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          visible: !root.showPage && !root.composing && !root.calendarVisible
            && (!root.compact || root.currentView === "reader")
          service: root.service
          textColor: root.foreground
          backgroundColor: root.background
          accentColor: root.accent
          linkColor: root.link
          dimColor: root.dim
          dimmerColor: root.dimmer
          popupBackgroundColor: root.popupBackground
          popupBorderColor: root.popupBorder
          leadingBoundaryOverlap: listSplitter.visible ? listSplitter.width : 0
          panelFontFamily: root.fontFamily
          zoom: root.bodyZoom
          showBack: root.compact
          bodyMode: root.bodyMode
          alwaysRenderHeavyMessages: !!root.service && root.service.alwaysRenderHeavyMessages
          contentDirection: root.service ? root.service.contentDirection : ""
          onBodyModeRequested: function(mode) {
            if (root.service) root.service.setBodyMode(mode)
          }
          onZoomRequested: function(step) { root.zoomBy(step) }
          onZoomResetRequested: if (root.service) root.service.setBodyZoom(1.0)
          onBackRequested: root.backToList()
          onComposeRequested: function(mode) {
            root.composeReturnView = root.currentView
            root.startCompose(mode)
          }
          onMailtoRequested: function(url) {
            root.openDraft(Mailto.parse(url))
          }
          onActionRequested: function(action) {
            if (root.service && root.service.selectedId !== "") {
              root.cursorId = root.service.selectedId
              root.actOnCursor(action)
            }
          }
        }

        // Composing takes the whole body. Omarchy's panel mechanism would give
        // a second window its own region, which is not what a reply is.
        ComposeView {
          id: compose
          anchors.fill: parent
          visible: opened && !root.showPage
          service: root.service
          textColor: root.foreground
          backgroundColor: root.background
          accentColor: root.accent
          dimColor: root.dim
          dimmerColor: root.dimmer
          popupBackgroundColor: root.popupBackground
          popupBorderColor: root.popupBorder
          panelFontFamily: root.fontFamily
          contentDirection: root.service ? root.service.contentDirection : ""
          onClosed: {
            if (!root.composeDetachingForSave) root.clearComposeRecovery()
            root.leaveCompose()
          }
          onCloseRequested: root.saveAndLeaveCompose()
          onSendQueued: {
            root.saveComposeRecovery(compose.pendingDraft)
            root.backToList()
          }
          onDraftChanged: root.scheduleComposeRecovery()
        }

        CalendarEventComposer {
          id: eventComposer
          anchors.fill: parent
          z: 20
          visible: opened && !root.showPage
          controller: root.service ? root.service.calendarController : null
          textColor: root.foreground
          backgroundColor: root.background
          accentColor: root.accent
          urgentColor: root.urgent
          dimColor: root.dim
          panelFontFamily: root.fontFamily
        }

        Rectangle {
          anchors.top: parent.top
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.left: sidebar.visible ? sidebar.right : parent.left
          visible: root.calendarVisible && !root.showPage && !root.composing
          color: root.background
          z: 10

          CalendarView {
            id: calendarView
            anchors.fill: parent
            controller: root.service ? root.service.calendarController : null
            textColor: root.foreground
            backgroundColor: root.background
            accentColor: root.accent
            urgentColor: root.urgent
            dimColor: root.dim
            calendarBorderColor: root.calendarBorder
            calendarTodayBackgroundColor: root.calendarTodayBackground
            calendarBorderWidth: root.calendarBorderWidth
            panelFontFamily: root.fontFamily
            onCreateAt: function(startMs) { eventComposer.beginAt(startMs) }
            onCopyRequested: function(text) { root.copyText(text) }
            onOpenRequested: function(url) { Qt.openUrlExternally(url) }
            onEditRequested: function(sourceId, event) { eventComposer.beginEdit(sourceId, event) }
            onDeleteRequested: function(sourceId, event) { root.requestEventDelete(sourceId, event) }
          }
        }

        // Setup takes the whole body: there is nothing else to look at until
        // the mailbox is connected.
        Flickable {
          id: setupFlick
          anchors.fill: parent
          anchors.margins: Style.space(18)
          visible: root.showSetup
          contentWidth: width
          contentHeight: setupHolder.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          // A holder the width of the viewport, so the page below can centre
          // against something real. Anchoring beats arithmetic here: a
          // Flickable reparents its children, and an x binding written against
          // the Flickable's own width lands before that reparenting settles.
          Item {
            id: setupHolder
            width: setupFlick.width
            implicitHeight: setup.implicitHeight

          // Setups that share nothing but their place on screen: a chooser for
          // a mailbox whose kind is not settled yet, then whichever page that
          // kind needs — a Cloud walkthrough, a program and a button, or a
          // server and a password. A Loader rather than four visibilities, so
          // the pages not in use hold no fields and no state.
          Loader {
            id: setup
            // A measure this long is unreadable across a wide window, so it is
            // capped rather than stretched.
            anchors.horizontalCenter: parent.horizontalCenter
            width: Math.min(setupHolder.width, Style.space(560))
            readonly property string kind: Model.setupProvider(root.editingProvider,
              root.service ? root.service.providerId : "")
            sourceComponent: root.showPicker
              ? providerPickerPage
              : (setup.kind === "imap" ? imapSetupPage
                : (setup.kind === "hey" ? heySetupPage : gmailSetupPage))
          }
          }
        }

        // The settings page, which is where mailboxes are added and removed.
        Flickable {
          id: settingsFlick
          anchors.fill: parent
          anchors.margins: Style.space(18)
          visible: root.showSettings
          contentWidth: width
          contentHeight: settingsHolder.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Item {
            id: settingsHolder
            width: settingsFlick.width
            implicitHeight: settings.implicitHeight

            SettingsPage {
              id: settings
              anchors.horizontalCenter: parent.horizontalCenter
              width: Math.min(settingsHolder.width, Style.space(560))
              service: root.service
              calendarController: root.service ? root.service.calendarController : null
              textColor: root.foreground
              dimColor: root.dim
              accentColor: root.accent
              urgentColor: root.urgent
              panelFontFamily: root.fontFamily
              onBackRequested: root.settingsVisible = false
              onClientSetupRequested: {
                root.editingProvider = "gmail"
                root.setupVisible = true
              }
              // Which kind first, then the form for it.
              onAddRequested: {
                root.editingProvider = ""
                root.pickingProvider = true
                root.setupVisible = true
              }
              onEditRequested: function(index) { root.editAccount(index) }
            }
          }
        }
      }

      UndoSendToast {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(16)
        anchors.bottom: statusBar.top
        anchors.bottomMargin: Style.space(12)
        z: 80
        visible: !!root.service && root.service.sendPending && compose.parkedForSend
        secondsRemaining: root.service ? root.service.sendSecondsRemaining : 0
        textColor: root.foreground
        dimColor: root.dim
        accentColor: root.accent
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onUndoRequested: root.undoPendingSend()
      }

      DraftSavedToast {
        anchors.right: parent.right
        anchors.rightMargin: Style.space(16)
        anchors.bottom: statusBar.top
        anchors.bottomMargin: Style.space(12)
        z: 80
        visible: root.draftSavedNotice !== ""
        message: root.draftSavedNotice
        textColor: root.foreground
        accentColor: root.accent
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
      }

      // --------------------------------------------------------- status bar

      Item {
        id: statusBar
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(28)

        PanelSeparator {
          anchors.top: parent.top
          width: parent.width
          foreground: root.foreground
        }

        // The rail's own switch, at the far left of the status line. On the rail
        // it cost a whole row above the mailboxes; in the header it was a
        // button about the sidebar sitting among buttons about the mailbox.
        // The status line is where a view toggle belongs.
        IconButton {
          id: railToggle
          anchors.left: parent.left
          anchors.leftMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          visible: !root.compact && !root.showPage && !root.composing
          iconName: "sidebar"
          tooltipText: root.sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar"
          // No fill for the open state. The sidebar standing there is the state,
          // said far better than a lit square on the status line could say it,
          // and this control has no business drawing attention to itself.
          foreground: root.dim
          hoverColor: root.foreground
          iconSize: Style.font.iconSmall
          size: Style.space(24)
          fontFamily: root.fontFamily
          onClicked: root.toggleSidebar()
        }

        Text {
          id: accountLine
          anchors.left: railToggle.visible ? railToggle.right : parent.left
          anchors.leftMargin: railToggle.visible ? Style.space(8) : Style.space(14)
          // An invisible sibling still holds its place, so the hints must only
          // take room from this line while they are actually on screen.
          anchors.right: statusBar.hasNotice
            ? notice.left
            : (keyHints.visible ? keyHints.left : parent.right)
          anchors.rightMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          // The account already has a home in the sidebar's user bar, so this
          // says something the window does not say anywhere else: how current
          // the list is. When the sidebar is hidden it takes the account back,
          // because then nothing else is carrying it.
          text: {
            if (!root.service) return "Not connected"
            if (!root.ready) return "Not connected"
            if (root.compact) return root.service.accountEmail
            return Model.statusSummary(root.service.syncedLabel)
          }
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight

        }

        // The right of the status line carries one of two things: what the
        // window most needs to say, or — when it has nothing to report — what
        // the keyboard can do from where you are standing.
        readonly property bool hasNotice: root.notice !== ""
          || (!!root.service
            && (root.service.actionStatus !== "" || root.service.lastError !== ""))

        Text {
          id: notice
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          visible: statusBar.hasNotice
          width: Math.min(implicitWidth, parent.width / 2)
          horizontalAlignment: Text.AlignRight
          textFormat: Text.PlainText
          text: {
            if (root.notice !== "") return root.notice
            if (!root.service) return ""
            if (root.service.actionStatus !== "") return root.service.actionStatus
            return root.service.lastError
          }
          color: root.service && root.service.lastError !== "" && root.service.actionStatus === ""
            ? root.urgent
            : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        KeyHints {
          id: keyHints
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          visible: !statusBar.hasNotice && !root.compact
          textColor: root.foreground
          dimColor: root.dimmer
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          hints: Keymap.hintsFor(focusScope.keyContext,
            root.service ? root.service.unavailableActions : [])
        }
      }

      // The account menu. It has no trigger of its own: the sidebar's user bar
      // opens it, and so does the status bar when the sidebar is hidden.
      AppMenu {
        id: appMenu
        anchors.fill: parent
        textColor: root.foreground
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        signedIn: root.ready
        canOpenWebInbox: !!root.service && root.service.canOpenWebInbox
        accountCount: root.service ? root.service.accountCount : 1
        onMarkAllReadRequested: if (root.service) root.service.markAllRead()
        onOpenWebRequested: if (root.service) root.service.openWebInbox()
        onShortcutsRequested: root.shortcutHelpVisible = true
        onSetupRequested: root.openSettings()
        onSwitchAccountRequested: accountSwitcher.openCentered()
        onProjectRequested: if (root.service) root.service.openProjectPage()
        onAuthorRequested: if (root.service) root.service.openAuthorPage()
      }

      // Every mailbox, with its own unread count, opened from the user bar.
      Timer {
        id: noticeTimer
        interval: 6000
        onTriggered: root.notice = ""
      }

      AccountSwitcher {
        id: accountSwitcher
        anchors.fill: parent
        textColor: root.foreground
        accentColor: root.accent
        urgentColor: root.urgent
        dimColor: root.dim
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        accounts: root.service ? root.service.accountSummaries : []
        onAccountChosen: function(index) {
          root.switchAccount(index)
        }
        onAddAccountRequested: {
          root.editingProvider = ""
          root.pickingProvider = true
          root.setupVisible = true
        }
        onManageRequested: {
          root.openSettings()
        }
      }

      AccountRemovalDialog {
        id: accountRemovalDialog
        anchors.fill: parent
        textColor: root.foreground
        dimColor: root.dim
        dangerColor: root.danger
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onConfirmed: function(request) { root.confirmAccountRemoval(request) }
      }

      ConfirmDeleteDialog {
        id: confirmDeleteDialog
        anchors.fill: parent
        textColor: root.foreground
        dimColor: root.dim
        dangerColor: root.danger
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onConfirmed: function(request) { root.confirmDelete(request) }
      }

      MessageMenu {
        id: rowMenu
        service: root.service
        textColor: root.foreground
        urgentColor: root.urgent
        dimColor: root.dim
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onComposeRequested: function(mode, id) {
          root.composeReturnView = root.currentView
          root.openMessage(id)
          root.startCompose(mode)
        }
        onActionRequested: function(action, id) {
          root.cursorId = id
          root.actOnCursor(action)
        }
      }

      ShortcutHelp {
        id: shortcutHelp
        anchors.fill: parent
        visible: root.shortcutHelpVisible
        textColor: root.foreground
        backgroundColor: root.background
        dimColor: root.dim
        panelFontFamily: root.fontFamily
        onDismissed: root.shortcutHelpVisible = false
      }

      // ---------------------------------------------------------- keyboard

      KeyRouter {
        context: focusScope.keyContext
        overlay: root.shortcutHelpVisible
        onTriggered: function(id, sequence) { root.runShortcut(id, sequence) }
      }
    }
  }

}
