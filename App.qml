import QtQuick
import QtQuick.Controls
import QtQuick.Window
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

import "account/Model.js" as Model
import "account/Conversation.js" as Conversation
import "account/Accounts.js" as Accounts
import "account/Navigation.js" as Nav
import "compose/Recovery.js" as Recovery
import "keys/Keymap.js" as Keymap
import "providers/Registry.js" as Provider
import "agent/Agent.js" as Agent
import "message/Mailto.js" as Mailto
import "message/Message.js" as Message
import "components"
import "calendar"

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
    pendingComposeReturnTo = composeRecovery.returnView === "reader" ? Nav.depth(nav) : 1
    composeRecoveryRestoring = true
    compose.restoreDraft(composeRecovery.draft)
    composeRecoveryRestoring = false
    var parked = composeRecovery.parked || []
    if (parked.length > 0) compose.recoveryDrafts = compose.recoveryDrafts.concat(parked)
    return true
  }

  function parkedBesides(draft) {
    var out = []
    var parked = compose.parkedDrafts || []
    for (var i = 0; i < parked.length; i++) {
      if (parked[i].draft !== draft) out.push(parked[i].draft)
    }
    var recovered = compose.recoveryDrafts || []
    for (var j = 0; j < recovered.length; j++) {
      if (recovered[j] !== draft) out.push(recovered[j])
    }
    return out
  }

  function saveComposeRecovery(saved) {
    composeRecoveryTimer.stop()
    var draft = saved || (compose.opened ? compose.snapshotDraft()
      : (compose.parkedForSend ? compose.pendingDraft : null))
    var raw = Recovery.serialize(composeReturnView(), draft, parkedBesides(draft))
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
  readonly property color danger: Color.urgent
  readonly property color popupBackground: Color.popups.background
  readonly property color popupBorder: Color.popups.border
  readonly property color calendarBorder: Style.normalBorderColor
  readonly property color calendarTodayBackground: Style.selectedAccentFill
  readonly property int calendarBorderWidth: Style.normalBorderWidth
  readonly property color dim: Qt.rgba(
    foreground.r * 0.68 + background.r * 0.32,
    foreground.g * 0.68 + background.g * 0.32,
    foreground.b * 0.68 + background.b * 0.32, 1)
  readonly property color dimmer: Qt.rgba(
    foreground.r * 0.45 + background.r * 0.55,
    foreground.g * 0.45 + background.g * 0.55,
    foreground.b * 0.45 + background.b * 0.55, 1)
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

  readonly property bool assistantOpen: agentPrompt.opened || composeAgent.opened
  readonly property var activeAssistant: composeAgent.opened ? composeAgent : (agentPrompt.opened ? agentPrompt : null)
  property real preferredAssistantWidth: 0
  readonly property real assistantMaxWidth: Math.max(0, Math.min(window.width * 0.65, window.width - Style.space(320)))
  readonly property real assistantMinWidth: Math.min(Style.space(280), assistantMaxWidth)
  readonly property real assistantWidth: assistantOpen ? Math.max(assistantMinWidth, Math.min(assistantMaxWidth,
    preferredAssistantWidth > 0 ? preferredAssistantWidth : Math.min(Style.space(420), window.width * 0.45))) : 0
  property bool assistantEditing: false
  readonly property real mailWidth: window.width - assistantWidth
  readonly property bool wide: mailWidth >= Style.space(1000)
  readonly property bool compact: mailWidth < Style.space(760)

  property string cursorId: ""
  // The rows ticked for a bulk action, by id. Like the cursor, a fact about
  // this window rather than about the mailbox, and pruned the same way when
  // the list under it changes. Only the list acts on it: in the reader there
  // is one message and it is the one open.
  property var checkedIds: []
  // The mailbox the ticks belong to. An IMAP id is a UID and a folder, unique
  // only inside one account, so a tick carried across an account switch
  // would name whatever the other mailbox keeps under the same id — and a
  // batch dispatched through it would act on that. The ticks are bound to
  // the account they were made in and dropped the moment it changes, from
  // any path, before a batch can run.
  property string checkedAccountId: ""
  // Ticked rows mean the selection whenever the list is on screen: alone, or
  // beside the reader in a wide window. A plain click opens a message and
  // puts the window in the reader view, so a click, a Shift+click and `d`
  // used to trash only the open message — the ticks were there and ignored.
  readonly property bool listOnScreen: currentView === "list"
    || (currentView === "reader" && !compact)
  readonly property bool selectionActive: checkedIds.length > 0 && listOnScreen

  function toggleCheck(id) {
    var key = String(id || "")
    if (key === "") return false
    claimChecks()
    checkedIds = Model.toggleId(checkedIds, key)
    return true
  }

  // Ticks made in another mailbox are not this one's: start over.
  function claimChecks() {
    var owner = service ? String(service.activeAccountId || "") : ""
    if (checkedAccountId !== owner) checkedIds = []
    checkedAccountId = owner
  }

  function clearChecksIfForeign() {
    var owner = service ? String(service.activeAccountId || "") : ""
    if (checkedIds.length > 0 && checkedAccountId !== owner) checkedIds = []
    checkedAccountId = owner
  }

  // Shift+click applies the endpoint's next checked state across the range.
  // The cursor moves here so the next stretch starts where this one ended.
  function checkRange(id) {
    if (!service) return false
    var key = String(id || "")
    if (key === "") return false
    claimChecks()
    checkedIds = Model.toggleRange(checkedIds, service.messages, cursorId, key)
    cursorId = key
    return true
  }

  // Every loaded row, or none when every one is already ticked: one key that
  // means "all of these" has to be able to mean "none of them" as well.
  function checkAll() {
    if (!service) return false
    claimChecks()
    var all = Model.allIds(service.messages)
    checkedIds = Model.retainIds(checkedIds, service.messages).length === all.length ? [] : all
    return true
  }

  // Acting on the selection acts on every ticked row at once, then drops the
  // selection: the rows it named have moved or changed, and a selection that
  // outlived the action would be one keystroke from repeating it.
  function actOnChecked(action) {
    if (!service || checkedIds.length === 0) return false
    // Never through another mailbox: a switch that reached the service by
    // any road drops the ticks before a batch can be built from them.
    if (checkedAccountId !== String(service.activeAccountId || "")) {
      checkedIds = []
      return false
    }
    var ids = checkedIds.slice()
    var leaves = !Model.survivesAction(service.mailboxKey, action,
      service.rawQuery, service.hasLabels, service.rawLabelId)
    var next = leaves ? Model.cursorAfterRemovals(service.messages, ids, cursorId) : cursorId
    // The open message going with the selection closes the reader, the way
    // acting on it alone does: it is about to leave this list.
    var wasOpen = currentView === "reader" && ids.indexOf(service.selectedId) >= 0
    if (!service.actMany(ids, action)) return false
    checkedIds = []
    if (!leaves) return true
    if (wasOpen) {
      if (next !== "") openMessage(next)
      else backToList()
      return true
    }
    cursorId = next
    revealCursorRow()
    return true
  }

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
  // Where the two dividers were dragged to, or 0 for each pane's own default.
  // Seeded from the service's window file and written back when a drag ends.
  property real listWidth: 0
  property real sidebarWidth: 0
  readonly property real sidebarMinWidth: Style.space(110)
  readonly property real sidebarMaxWidth: Style.space(360)

  function persistPaneWidths() {
    if (service) service.setPaneWidths(sidebarWidth, listWidth)
  }

  function zoomBy(step) {
    if (service) service.setBodyZoom(Model.zoomAfterStep(service.bodyZoom, step))
  }
  // ---------------------------------------------------------- navigation
  // Views own overlay state; the navigation stack follows their open/close.
  property var nav: Nav.rootFor(({}))
  readonly property var navKinds: Nav.kinds(nav)
  readonly property var navPage: Nav.page(nav)
  readonly property var navOverlay: Nav.overlay(nav)
  readonly property string page: navPage.kind
  readonly property string overlay: navOverlay ? navOverlay.kind : ""
  readonly property string currentView: page === "reader" ? "reader"
    : ((page === "calendar" || page === "calendarDetail") ? "calendar" : "list")
  readonly property bool calendarVisible: currentView === "calendar"
  readonly property bool showSettings: page === "settings"
  readonly property bool showPicker: page === "picker"
  readonly property bool showSetup: page === "setup"
  // Anything the window goes *into*. The mail chrome stands down for all of it.
  readonly property bool showPage: showSettings || showPicker || showSetup
  onComposingChanged: { if (!composing) composeAgent.close(); else agentPrompt.close() }
  onShowPageChanged: if (showPage) { agentPrompt.close(); composeAgent.close() }
  readonly property bool composing: overlay === "compose" || overlay === "eventComposer"
  readonly property bool shortcutHelpVisible: overlay === "help"
  readonly property string editingProvider: page === "setup" ? String(navPage.provider || "") : ""
  readonly property bool accountDraftOpen: page === "setup" && navPage.draft === true

  // What the root is made of. Recomputed when a mailbox becomes usable or
  // stops being — and, before any is, whenever the service learns more about
  // the accounts it has, but only while the user has not moved off the root
  // it was given: a form they backed out of must not come back because the
  // address they typed was saved.
  readonly property var rootState: ({
    anyReady: anyReady,
    hasSavedAccounts: !!service && service.hasSavedAccounts === true,
    setupUnderway: setupUnderway,
    provider: service ? String(service.providerId || "") : "",
    view: currentView
  })
  property bool navUntouched: true
  property bool wasReady: false
  onRootStateChanged: {
    var flipped = rootState.anyReady !== wasReady
    wasReady = rootState.anyReady
    if (flipped || (!rootState.anyReady && navUntouched)) resetNavigation()
  }
  function resetNavigation() {
    nav = Nav.rootFor(rootState)
    navUntouched = true
    pendingComposeReturnTo = -1
  }
  function rootKind() {
    return nav.length > 0 && nav[0].kind === "calendar" ? "calendar" : "list"
  }

  function pushEntry(kind, fields) {
    navUntouched = false
    nav = Nav.push(nav, Nav.entry(kind, fields))
  }

  // An overlay whose view has closed, wherever it sits. Usually the top; a
  // draft can also finish under the shortcut sheet, and then the sheet goes
  // with it — it was drawn over a place that no longer exists.
  function dropOverlay(kind) {
    var stack = nav
    if (Nav.top(stack).kind === kind) {
      navUntouched = false
      nav = Nav.pop(stack)
      return
    }
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind !== kind) continue
      var keep = typeof stack[i].returnTo === "number" ? stack[i].returnTo : i
      navUntouched = false
      nav = stack.slice(0, Math.max(1, Math.min(keep, i)))
      return
    }
  }

  // Back. Whatever is on top is asked to leave; a view that owns its own open
  // state closes and pops itself, everything else pops here. Nothing to pop
  // means the root, and Back on the root is the way out of the window — after
  // clearing a search, which is the nearer thing to leave.
  function back() {
    var leaving = Nav.top(nav)
    pendingComposeReturnTo = -1
    if (leaving.kind === "compose") return saveAndLeaveCompose()
    if (leaving.kind === "eventComposer") return eventComposer.close()
    if (leaving.kind === "calendarDetail") return calendarView.closeDetail()
    if (leaving.kind === "reader") {
      pendingComposeMode = ""
      pendingDraftId = ""
      if (service) service.clearSelection()
    }
    if (leaving.kind === "setup" && leaving.draft === true && service)
      service.discardCurrentDraft()
    var next = Nav.pop(nav)
    if (next === nav) {
      if (service && service.searchQuery !== "") service.search("")
      else requestClose()
      return
    }
    navUntouched = false
    nav = next
    Qt.callLater(function() { focusScope.applyContextFocus() })
  }

  function openHelp() {
    if (overlay !== "help") pushEntry("help")
  }
  function dismissHelp() {
    if (overlay === "help") dropOverlay("help")
  }
  function toggleHelp() {
    if (overlay === "help") dismissHelp()
    else openHelp()
  }

  // The pages a mailbox stands behind. Each is a push, so Back retraces it.
  function addMailbox() {
    dismissHelp()
    pushEntry("picker")
  }
  function chooseProvider(providerId) {
    if (!service) return
    // On first run the row already exists and only needs its kind; after
    // that, adding a mailbox is what makes one — and that row is a draft
    // until it is saved, so backing out of its form discards it.
    var draft = service.hasSavedAccounts === true
    if (draft) service.addAccount(providerId)
    else service.configureCurrentAccount({ provider: providerId })
    pushEntry("setup", { provider: String(providerId || ""), draft: draft })
  }
  function openClientSetup() {
    pushEntry("setup", { provider: "gmail", draft: false })
  }
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

  // Entered at the top. The page keeps its scroll for as long as it is in
  // history — Back from a mailbox's form returns to the row that opened it —
  // but a page that was left and entered again is a new visit, and one that
  // opened where the last visit ended looked like the calendar had been
  // opened instead of settings, because that is the section a scroll past
  // Mailboxes lands in.
  function openSettings() {
    dismissHelp()
    if (page === "settings") return
    settingsScroll.stop()
    settingsFlick.contentY = 0
    pushEntry("settings")
  }

  readonly property bool ready: !!service && service.ready
  // The walkthrough is for having no mailbox at all. A mailbox that has been
  // added but not signed in yet belongs in settings, next to the ones that are.
  readonly property bool anyReady: !!service && service.anyAccountReady
  // A setup already part-done answers the question by itself: an account with
  // credentials has had its kind chosen, whether or not this window asked.
  readonly property bool setupUnderway: !!service && !!service.auth
    && service.auth.credentialsPresent === true

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
      showCalendar()
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
    // A stub service in the tests carries no widths; a real one always does.
    if (service && service.sidebarWidth !== undefined) {
      sidebarWidth = service.sidebarWidth
      listWidth = service.listWidth
    }
    // Jobs finish while the window is shut; the rows say so as soon as it opens.
    if (service && typeof service.refreshAgentJobs === "function") service.refreshAgentJobs()
    Qt.callLater(function() { focusScope.applyContextFocus() })
  }

  function close() {
    closingFromHost = true
    // A window that is gone shows nothing, so a dwell counting down in it —
    // or a fetch about to be asked for — has nothing left to be for.
    markReadDwell.stop()
    previewSettle.stop()
    // Escape at the list root closes the window without clearing what the
    // cursor had previewed, so it reopened showing a stale message beside the
    // list. A preview is not a place the window was left in.
    if (service && service.selectionIsPreview) service.clearSelection()
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
    // Opening marks it read itself, so a dwell still counting down for the
    // same message has nothing left to do.
    markReadDwell.stop()
    pendingComposeMode = ""
    pendingDraftId = ""
    reader.forceRichAnyway = false
    cursorId = String(id || "")
    service.select(cursorId)
    // A message opens over the list. From anywhere else — a notification
    // arriving while Settings is up — it opens over a fresh list, because
    // Back from a message means the list it came from.
    if (page !== "list" && page !== "reader") nav = Nav.resetTo(nav, "list")
    pushEntry("reader", { id: cursorId })
  }

  // One member of the conversation the reader is inside, opened in the same
  // reader. `openMessage` and nothing else: the header paints from the member's
  // summary at once, the body from the cache or the network, and the navigation
  // stack replaces a reader entry with a reader entry, so Back still lands on
  // the list from any member.
  //
  // The one thing that does not happen is the cursor moving. `cursorId` is
  // where the keyboard stands in the *list*, and a member is not a row — the
  // list is one row per conversation — so leaving the cursor on a message the
  // list has never drawn would send the next `j` back to the top of it.
  function openMember(id) {
    var member = String(id || "")
    if (!service || member === "") return
    var cursor = cursorId
    openMessage(member)
    cursorId = cursor
  }

  // Along the rail by keyboard: `n` to the next member, `p` to the previous,
  // stopping at the ends rather than wrapping. `j` and `k` keep moving the list
  // cursor underneath, which is the other thing in this window that moves.
  function stepMember(delta) {
    if (!service || !service.showsRail) return
    var next = Conversation.memberStep(service.selectedThread, service.selectedId, delta)
    if (next !== "" && next !== service.selectedId) openMember(next)
  }

  function openOrEdit(id) {
    if (service && service.mailboxKey === "drafts" && editDraft(id)) return true
    return openMessage(id)
  }

  function editDraft(id) {
    if (!service || service.mailboxKey !== "drafts") return false
    var draftId = String(id || "")
    if (draftId === "") return false
    pendingComposeMode = ""
    pendingDraftId = draftId
    if (service.selectedId !== draftId || service.detailLoading
        || !service.detailPainted || !service.selectedMessage) service.select(draftId)
    resumeHeldDraft()
    if (pendingDraftId !== "") Qt.callLater(root.resumeHeldDraft)
    return true
  }

  // The list, fresh: what a mailbox switch, a search, a queued send and the
  // reader's own "back to list" keys all mean. Not a Back — the history is
  // dropped because the list under it has changed.
  function backToList() {
    pendingComposeMode = ""
    pendingDraftId = ""
    pendingComposeReturnTo = -1
    if (service) service.clearSelection()
    navUntouched = false
    nav = Nav.resetTo(nav, "list")
    Qt.callLater(function() { focusScope.applyContextFocus() })
  }

  function showCalendar() {
    navUntouched = false
    nav = Nav.replaceRoot(nav, "calendar")
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
    previewCursor()
  }

  // Rechecked after the dwell because the visible surface may have changed.
  readonly property bool canPreview: !!service && service.previewOnCursor
    && !compact && !showPage && !composing && !calendarVisible
    && !labelPicker.opened

  // Moving is not opening, and this is the difference.
  //
  // It used to open whatever it landed on, which made stepping through a list
  // a way to mark half of it read without having looked at any of it. So the
  // preview is off unless it was asked for, it pushes no history — Escape and
  // Back mean what they meant — and it does not mark anything read. A dwell
  // does that, which is what stops a held arrow key from reading a mailbox.
  function previewCursor() {
    markReadDwell.stop()
    markReadDwell.dwelledOn = ""
    previewSettle.stop()
    if (!canPreview || cursorId === "") return
    // A message already open stays open on its own terms: it was opened, and
    // re-selecting it as a preview would take back the read mark it earned.
    //
    // A *preview* of the same message is not that. Moving away and back
    // inside the settle stops the dwell above and used to return here, so the
    // message the cursor was sitting on never became read at all — the id
    // matched, which is exactly what a preview does while not being open.
    if (currentView === "reader" && service.selectedId === cursorId
      && !service.selectionIsPreview) return
    // Per message, the same as opening one. Insisting on a document the bounds
    // refused is an answer about the message it was given for, and the row the
    // cursor moved to is a different message.
    reader.forceRichAnyway = false
    // Settled rather than fetched per keystroke. A held `j` starts a request
    // for every row it crosses, and on IMAP each one is a curl process, a TLS
    // handshake and a LOGIN — thirty rows was thirty connections, spawned and
    // killed as the key repeated. Cancellation was already correct; this is
    // about not asking. Short enough that a deliberate move still feels
    // immediate, long enough that a repeat rate never gets through.
    previewSettle.wanted = cursorId
    previewSettle.restart()
  }

  Timer {
    id: previewSettle
    property string wanted: ""
    interval: 180
    repeat: false
    onTriggered: root.previewSettled()
  }

  function previewSettled() {
    var id = previewSettle.wanted
    previewSettle.wanted = ""
    // The cursor may have moved on, or left the state that allows a preview
    // at all, in the time this waited.
    if (id === "" || id !== cursorId || !canPreview) return
    if (currentView === "reader" && service.selectedId === id
      && !service.selectionIsPreview) return
    // Coming back to the message that is still the preview restarts its
    // dwell rather than asking for it again.
    if (service.selectedId !== id || !service.selectionIsPreview)
      service.select(id, true)
    markReadDwell.dwelledOn = id
    armReadDwell()
  }

  // Whether the previewed message is actually on screen.
  //
  // The dwell measures time spent looking at something, so it cannot start
  // before there is anything to look at. It began when the request went out,
  // so a slow fetch spent the whole dwell loading and marked read a message
  // whose body never appeared — worst at a zero dwell, which marked it read
  // before the request had even been made. A fetch that fails never paints,
  // so it never arms this at all.
  readonly property bool previewShowing: !!service
    && service.detailPainted && !service.detailLoading

  onPreviewShowingChanged: if (previewShowing) armReadDwell()

  function armReadDwell() {
    if (!service || markReadDwell.dwelledOn === "") return
    if (!canPreview || !previewShowing) return
    // Still the message on screen: a search and a mailbox switch both drop the
    // selection without moving the cursor off the row.
    if (service.selectedId !== markReadDwell.dwelledOn) return
    if (service.markReadDelaySec <= 0) {
      var now = markReadDwell.dwelledOn
      markReadDwell.dwelledOn = ""
      service.markPreviewRead(now)
      return
    }
    markReadDwell.interval = service.markReadDelaySec * 1000
    markReadDwell.restart()
  }

  // A previewed message counts as read once the cursor has stayed on it. The
  // id is held rather than read back off the cursor when this fires: by then
  // the cursor may have moved on, and the message that was read is the one to
  // mark.
  Timer {
    id: markReadDwell
    property string dwelledOn: ""
    repeat: false
    onTriggered: {
      if (!root.service || dwelledOn === "") return
      if (!root.canPreview) return
      if (root.cursorId !== dwelledOn) return
      // And it has to still be the message on screen: a search and a mailbox
      // switch both drop the selection without moving the cursor off the row.
      if (root.service.selectedId !== dwelledOn) return
      root.service.markPreviewRead(dwelledOn)
    }
  }

  // An answer needs the message it is answering, and opening one only starts
  // the fetch — select() clears the summary and the body first. Beginning the
  // draft in the same breath addressed nobody and quoted nothing, which is what
  // the list row's own Reply menu did. Held until the fetch lands instead.
  property string pendingComposeMode: ""
  property string pendingDraftId: ""
  // Where the draft will return to, recorded before anything is pushed on its
  // behalf. Answering from the list opens the message being answered — that
  // is the reply's doing, not somewhere the reader asked to be — so the depth
  // to come back to is taken before the reader goes on. -1 means "wherever
  // the draft opens", which `push` fills in.
  property int pendingComposeReturnTo: -1

  // The draft's entry, once the view has opened. The reply raised from the
  // list has been holding its depth in pendingComposeReturnTo since before
  // the message it answers was fetched; everything else returns to the place
  // it was raised over.
  function trackComposeOpened() {
    var fields = {}
    if (pendingComposeReturnTo >= 0) fields.returnTo = pendingComposeReturnTo
    pendingComposeReturnTo = -1
    pushEntry("compose", fields)
  }

  // What compose recovery writes: the reader, if leaving the draft would keep
  // one open underneath, else the list. The file format predates the stack
  // and says only that much.
  function composeReturnView() {
    for (var i = nav.length - 1; i >= 0; i--) {
      if (nav[i].kind !== "compose") continue
      var keep = typeof nav[i].returnTo === "number" ? nav[i].returnTo : i
      return keep >= 2 && nav[keep - 1].kind === "reader" ? "reader" : "list"
    }
    return currentView === "reader" ? "reader" : "list"
  }

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
    pendingComposeReturnTo = Nav.depth(nav)
    // A preview satisfies the id test while pushing no `reader` entry, so
    // without the second half `r` on a previewed row answered a message that
    // was never opened: nothing marked it read, and closing the draft landed
    // on the list instead of on the message being answered.
    if (service.selectedId !== cursorId || service.selectionIsPreview)
      openMessage(cursorId)
    startCompose(mode)
  }

  // A draft closed by its own Back, by Escape, by Discard, or by having been
  // sent. All four are the same question: where was this raised from — and
  // the entry knows.
  function leaveCompose() {
    pendingComposeReturnTo = -1
    dropOverlay("compose")
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

  function restoreParkedDraft(sendId, oldest) {
    if (!compose.resumePendingSend(sendId, oldest)) return false
    var interrupted = compose.interruptedDraft
    var fields = compose.interruptedFields()
    if (!interrupted || !fields || !service) return true
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

  function undoPendingSend() {
    if (!service) return false
    var undone = service.undoSend()
    if (!undone) return false
    root.restoreParkedDraft(undone === true ? "" : String(undone), false)
    return true
  }

  Timer {
    id: draftSavedTimer
    interval: 4000
    repeat: false
    onTriggered: root.draftSavedNotice = ""
  }

  // Opened on the cursor rather than on the selection, the way every other
  // acting key works: `v` in the list means the row under the cursor, and in
  // the reader there is only one message it could mean. Refuse an unavailable
  // move before asking for a destination, through the same provider guard that
  // checks the final action before its optimistic update.
  // Opened on a message outside the ticks, the picker moves that one alone.
  property bool labelPickerOnlyCursor: false

  function openLabelPicker(onlyCursor) {
    if (!service || (cursorId === "" && !selectionActive)) return false
    labelPickerOnlyCursor = onlyCursor === true
    // A merged list draws no labels, so there is nothing to offer and the
    // picker would open empty on a destination list it cannot fill — and a
    // chosen id would belong to whichever mailbox happened to be active
    // rather than to the row. Refused where it cannot be honoured, which is
    // the same rule every other unavailable action follows.
    // Only the merged-list refusal belongs here. A single mailbox whose
    // provider has no move verb is the provider guard's answer, and saying
    // "needs one mailbox on screen" over it would name the wrong reason.
    if (service.unified) {
      service.fail("Moving to a label needs one mailbox on screen")
      return false
    }
    if (service.refuseUnavailableAction("label:destination", cursorId)) return false
    labelPicker.open()
    return true
  }

  // A row's own button: the selection when the row is ticked, that row alone
  // when it is not — the rule the row menu follows, so a click and a key on
  // the same row cannot mean different sets of messages.
  function actFromRow(id, action) {
    if (!service) return false
    var outside = checkedIds.indexOf(id) < 0
    cursorId = id
    if (action === "star") {
      if (selectionActive && !outside)
        return actOnChecked(Model.starActionFor(Model.summariesById(service.messages, checkedIds)))
      service.toggleStar(id)
      return true
    }
    return actOnCursor(action, outside)
  }

  // The subject the popup names, from the row or the open message.
  function agentSubjectFor(id) {
    if (!service) return ""
    var index = Model.indexById(service.messages, id)
    if (index >= 0) return String(service.messages[index].subject || "")
    if (service.selectedId === id && service.selectedMessage)
      return String(service.selectedMessage.subject || "")
    return ""
  }

  // With rows ticked, the ask is about all of them, one job with a count.
  function openAgentAt(id, sceneX, sceneY) {
    if (!service || !service.hasAgent) return false
    if (selectionActive && checkedIds.indexOf(String(id || "")) >= 0) {
      agentPrompt.openForSelection(checkedIds, sceneX, sceneY)
      return true
    }
    if (String(id || "") === "") return false
    agentPrompt.openFor(id, agentSubjectFor(id), sceneX, sceneY)
    return true
  }

  function openAgentCentered(id) {
    if (!service || !service.hasAgent) return false
    if (selectionActive) {
      var centre = root.mapToGlobal(Math.max(0, root.width / 2 - Style.space(190)),
        Math.max(0, root.height / 2 - Style.space(90)))
      agentPrompt.openForSelection(checkedIds, centre.x, centre.y)
      return true
    }
    if (String(id || "") === "") return false
    agentPrompt.openCenteredFor(id, agentSubjectFor(id))
    return true
  }

  function openAgentFromRow(id, sceneX, sceneY) {
    return openAgentAt(id, sceneX, sceneY)
  }

  // Acting on the open message closes it: it is about to leave this list.
  //
  // With rows ticked, the key means all of them rather than the one under the
  // cursor — the same key, the same guard in `MailAccount`, one more row in
  // the request. `onlyCursor` is for the row menu opened on a row outside the
  // selection, which means that row and nothing else.
  function actOnCursor(action, onlyCursor) {
    if (!service) return false
    if (selectionActive && onlyCursor !== true) return actOnChecked(action)
    if (cursorId === "") return false
    var acted = cursorId
    var row = service.messages[Model.indexById(service.messages, acted)]
    // "Was open" is the conversation's: with the rail up the reader can be
    // showing a member of the acted row rather than the row itself, and
    // archiving from a member has to open the next row or go back rather than
    // leave a message that has just moved on screen.
    //
    // And a preview is not open at all. It satisfies "is this the selected
    // one" without having been opened, which made `e` on a previewed row call
    // `openMessage` on the *next* one — an archive that reads a message, which
    // is the fault this feature exists to avoid.
    var wasOpen = currentView === "reader" && !service.selectionIsPreview
      && (service.selectedId === acted || Model.rowHoldsMember(row, service.selectedId))
    // Worked out before the action, while the row still has neighbours.
    var next = Model.cursorAfterRemoval(service.messages, acted)
    // The same six facts `MailAccount.act` decides with. Asking with three of
    // them made the cursor repair disagree with the list it repairs: moving a
    // message back to the inbox removes the row on a provider that moves, and
    // this read it as staying. The row itself is the sixth: a conversation
    // answers on its recomputed block, so a mark-read in the Unread view keeps
    // the row while a reply is still unread.
    var leaves = !Model.survivesAction(service.mailboxKey, action,
      service.rawQuery, service.hasLabels, service.rawLabelId, row)
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

  // Acting on one member from its stop on the rail: the one message and not
  // the conversation, whichever member it is. If it was the message on screen
  // and the action takes it out of this view, the reader moves to the
  // neighbouring stop — the newer one above, else the older below — rather
  // than sitting on a message that has just left; a conversation with no other
  // stop goes back to the list, as the list's own delete does.
  function actOnMember(action, id) {
    var member = String(id || "")
    if (!service || member === "") return false
    var wasOpen = currentView === "reader" && service.selectedId === member
    // Worked out before the action, while the member is still a stop.
    var next = Conversation.neighbourStop(service.selectedThread, member)
    var members = service.memberSummaries
    var summary = members && typeof members === "object" ? members[member] : null
    var leaves = !Model.survivesAction(service.mailboxKey, action,
      service.rawQuery, service.hasLabels, service.rawLabelId, summary || null)
    if (!service.act(member, action, false, true)) return false
    if (!leaves || !wasOpen) return true
    if (next !== "") openMember(next)
    else backToList()
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
    ? Model.sidebarSlots(service.mailboxes, service.visibleLabels, 10) : []

  function goSlot(index) {
    if (!service || index < 0 || index >= sidebarSlots.length) return
    var slot = sidebarSlots[index]
    if (slot.kind === "mailbox") return goMailbox(slot.key)
    // Not a search: the provider decides what selecting a label means, and on
    // IMAP it is a folder rather than a term to look for.
    service.selectLabel(slot.name, slot.id)
    backToList()
  }

  // One answer per key id. The ids come from keys/Keymap.js; adding a key is a
  // row there and a case here, and nothing else. The sequence says which key of
  // a row fired, for the rows that bind more than one meaning.
  function runShortcut(id, sequence) {
    if (id === "assistantSend") return activeAssistant ? activeAssistant.submitCurrent() : false
    if (id === "assistantCommandUp") return activeAssistant ? activeAssistant.moveCommand(-1) : false
    if (id === "assistantCommandDown") return activeAssistant ? activeAssistant.moveCommand(1) : false
    if (id === "assistantChooseCommand") return activeAssistant ? activeAssistant.chooseCommand() : false
    // The sheet is on top, so moving moves it. It is a plain overlay rather
    // than a popup, which is why its keys can come from here at all — the
    // switcher's cannot, and answers them itself.
    if (shortcutHelpVisible) {
      if (id === "cursorDown") return shortcutHelp.scrollBy(1)
      if (id === "cursorUp") return shortcutHelp.scrollBy(-1)
      if (id === "scrollDown") return shortcutHelp.scrollBy(1)
      if (id === "scrollUp") return shortcutHelp.scrollBy(-1)
    }
    if (id === "cursorDown") return moveCursor(1)
    if (id === "cursorUp") return moveCursor(-1)
    if (id === "scrollDown") return reader.scrollBy(1)
    if (id === "scrollUp") return reader.scrollBy(-1)
    // In Drafts, opening a draft from the keyboard is editing it: the
    // message is what was being written. A click still previews, so the
    // list can be read through without a composer opening on every row.
    if (id === "open") return openOrEdit(cursorId)
    if (id === "openReader") return openOrEdit(cursorId)
    if (id === "backToList") return backToList()
    if (id === "nextMember") return stepMember(1)
    if (id === "previousMember") return stepMember(-1)
    if (id === "archive") return actOnCursor("archive")
    if (id === "trash") return actOnCursor("trash")
    // Through the same guard actOnCursor applies rather than around it:
    // starring with nothing selected used to call through with an empty id.
    //
    // In the reader the star is the open message's own. Every reader action
    // resolves through the selected id and every list action through the
    // cursor, and this is the key where the difference shows: the cursor stays
    // on the row while `n` and `p` walk the rail, so `s` would otherwise star
    // the representative rather than the message on screen.
    if (id === "star") {
      if (selectionActive)
        return actOnChecked(Model.starActionFor(Model.summariesById(service.messages, checkedIds)))
      var starred = currentView === "reader" && service && service.selectedId !== ""
        ? service.selectedId : cursorId
      if (service && starred !== "") service.toggleStar(starred)
      return
    }
    if (id === "toggleCheck") return toggleCheck(cursorId)
    if (id === "askAgent") {
      if (root.composing) { composeAgent.open(); return true }
      var target = currentView === "reader" && service ? service.selectedId : cursorId
      return openAgentCentered(target)
    }
    if (id === "checkAll") return checkAll()
    if (id === "moveToLabel") return openLabelPicker()
    if (id === "markRead") return actOnCursor("markRead")
    if (id === "markUnread") return actOnCursor("markUnread")
    if (id === "reply") return composeFromCursor("reply")
    if (id === "replyAll") return composeFromCursor("replyAll")
    if (id === "forward") return composeFromCursor("forward")
    if (id === "compose") {
      if (service && service.mailboxKey === "drafts" && editDraft(cursorId)) return
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
        showCalendar()
        calendarView.refresh()
      }
      return
    }
    if (id === "mailView") return backToList()
    if (id === "calendarView") {
      showCalendar()
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
    if (id === "help") return toggleHelp()
    if (id === "back") return goBack()
  }

  // Escape. The row menu, the app menu and the account switcher are absent on
  // purpose: a QQC.Popup with CloseOnEscape consumes the key itself, so a
  // branch for them here would never run. Everything else is the history.
  function goBack() {
    if (activeAssistant && activeAssistant.commandsOpen) { activeAssistant.dismissCommands(); return }
    if (activeAssistant && activeAssistant.historyMode) { activeAssistant.historyMode = false; activeAssistant.takeFocus(); return }
    if (activeAssistant && activeAssistant.interrupt()) return
    if (composeAgent.opened) { composeAgent.close(); return }
    if (agentPrompt.opened) { agentPrompt.close(); return }
    // A query being typed is the nearest thing to leave: clear it if there is
    // one, then hand the keyboard back. Parked directly rather than through
    // applyContextFocus, which would still read the context as "search" —
    // the field has not lost the focus yet at this point. This used to live
    // in SearchBar as its own Keys handler, which a window Shortcut silently
    // beats.
    if (searchBar.fieldFocused) {
      if (searchBar.queryText !== "") searchBar.clear()
      focusScope.parkKeyboard()
      return
    }
    // A selection is the next nearest thing: Escape with rows ticked unticks
    // them and goes nowhere, which is what every file manager does with it.
    if (selectionActive) {
      checkedIds = []
      return
    }
    back()
  }

  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onReplySent(sendId) {
      if (!compose.completePendingSend(sendId)) return
      // Other sends may still be parked: recovery keeps holding them.
      if (compose.opened || compose.parkedForSend) root.scheduleComposeRecovery()
      else root.clearComposeRecovery()
    }
    function onReplyFailed(sendId) {
      if (!root.restoreParkedDraft(sendId, true)) return
      root.scheduleComposeRecovery()
    }
    // A held reply needs both summary and body, whichever arrives last.
    function onSelectedBodyChanged() { Qt.callLater(function() {
      root.resumeHeldCompose()
      root.resumeHeldDraft()
    }) }
    function onSelectedMessageChanged() { Qt.callLater(function() {
      root.resumeHeldCompose()
      root.resumeHeldDraft()
    }) }

    // The cursor is an id too, and an IMAP id names a different message in
    // another mailbox: it is dropped with the ticks, so the next `d` after
    // a switch acts on nothing rather than on whatever shares the id.
    function onActiveAccountIdChanged() {
      root.clearChecksIfForeign()
      root.cursorId = ""
      root.closeLabelPopups()
      // The agent popup is about one account's message too.
      agentPrompt.close()
      composeAgent.close()
    }
    function onSidebarWidthChanged() { root.sidebarWidth = root.service.sidebarWidth }
    function onListWidthChanged() { root.listWidth = root.service.listWidth }
    function onMessagesChanged() {
      root.clearChecksIfForeign()
      root.cursorId = Model.cursorAfterReload(
        root.service ? root.service.messages : [], root.cursorId)
      root.checkedIds = Model.retainIds(root.checkedIds,
        root.service ? root.service.messages : [])
    }
    function onDuplicateAccount(email) {
      root.notice = email + " is already added"
    }
    // accountAdded is not handled here on purpose: the chooser that added the
    // row pushes its form itself, so the stack says where the user is going
    // before the service has finished making the row.
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
      // Back is shown wherever there is something to go back to — which on
      // first run, where the chooser is the root, there is not.
      onChosen: function(providerId) { root.chooseProvider(providerId) }
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
      accountCount: root.service ? root.service.accountCount : 1
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
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeCurrentAccountFromEditor()
    }
  }

  Component {
    id: outlookSetupPage

    OutlookSetupPage {
      service: root.service
      textColor: root.foreground
      dimColor: root.dim
      dangerColor: root.danger
      accentColor: root.accent
      panelFontFamily: root.fontFamily
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeCurrentAccountFromEditor()
    }
  }

  Component {
    id: jmapSetupPage

    JmapSetupPage {
      service: root.service
      textColor: root.foreground
      dimColor: root.dim
      dangerColor: root.danger
      accentColor: root.accent
      panelFontFamily: root.fontFamily
      accountCount: root.service ? root.service.accountCount : 1
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
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeCurrentAccountFromEditor()
    }
  }

  // Every mailbox at once. The rail it lands on has to be one they all have,
  // so a row only some of them offered — Gmail's own Archive beside an IMAP
  // mailbox — does not leave the list asking for something nothing can serve.
  function chooseUnified() {
    if (!service) return false
    var keepCalendar = calendarVisible
    var mailbox = service.mailboxKey
    service.setUnifiedMailboxes(true)
    // The rail row is chosen either way. Returning early with the calendar up
    // left every mailbox on whatever it had been showing while the rail
    // claimed one, so coming back from the calendar landed on a list that was
    // not the row highlighted beside it.
    var target = Model.mailboxAfterAccountSwitch(mailbox, service.mailboxes)
    service.selectMailbox(target !== "" ? target : "inbox")
    if (keepCalendar) {
      showCalendar()
      return true
    }
    backToList()
    return true
  }

  function switchAccount(index) {
    if (!service) return false
    var keepCalendar = calendarVisible
    var mailbox = service.mailboxKey
    // Choosing one mailbox is choosing to be in it, so the combined view goes
    // off. Leaving it on would have named an account in the bar and gone on
    // showing every one of them.
    if (service.unifiedMailboxes) service.setUnifiedMailboxes(false)
    if (service.switchToIndex(index) !== true) return false
    if (keepCalendar) {
      showCalendar()
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
    var provider = index >= 0 && index < accounts.length
      ? String(accounts[index].provider || "gmail") : "gmail"
    if (!service.switchToIndex(index)) return
    pushEntry("setup", { provider: provider, draft: false })
  }

  // The row this page is editing, not the mailbox the id happens to name: with
  // a freshly added draft on screen those are different rows, and asking for
  // the second one is how Remove came to delete a working account while the
  // page in front of the user showed an empty form.
  function removeCurrentAccountFromEditor() {
    if (!service || service.accountCount <= 1) return
    var index = service.editingIndex()
    if (index < 0) return
    var values = service.accountSummaries || []
    var request = Accounts.removalRequest({ accounts: values }, index)
    if (request) {
      accountRemovalDialog.openFor(request)
      return
    }
    // No request means there is no mailbox id a confirmation can name. For the
    // form's pending row that is expected: cancel it and leave the page, the
    // way Back does. An idless persisted mailbox is different — if its damaged
    // address could not be repaired it stays here for correction rather than
    // being silently removed and mistaken for canceled setup state.
    if (service.discardCurrentDraft() !== true) return
    navUntouched = false
    nav = Nav.push(Nav.resetTo(nav, rootKind()), Nav.entry("settings"))
  }

  function confirmAccountRemoval(request) {
    if (!service) return
    var index = Accounts.confirmRemoval({ accounts: service.accountSummaries || [] }, request)
    if (index < 0) return
    service.removeAccountAt(index)
    // The editor's page is gone with its account. Settings is where the rest
    // of them are, over a fresh root: the list underneath may have changed
    // mailbox with the removal.
    navUntouched = false
    nav = Nav.push(Nav.resetTo(nav, rootKind()), Nav.entry("settings"))
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
    if (request.kind === "label" && request.labelId) service.deleteLabel(request.labelId, request.accountId)
  }

  // ------------------------------------------------------------ labels

  // Every label popup — the menu, the name prompt, the move picker, the
  // delete confirmation — is opened for one account and answers to it by
  // id, whatever the window has switched to since. An IMAP label id is a
  // folder name, which another account may well have too, so the open
  // account is no guide to whose folder was meant. And a switch closes
  // them: a prompt about a mailbox no longer on screen is a trap.
  function openLabelMenu(labelId, path, sceneX, sceneY) {
    if (!service) return
    labelMenu.accountId = service.activeAccountId
    labelMenu.canManage = service.canManageLabels
    labelMenu.monitored = service.monitoredLabelIds.indexOf(labelId) >= 0
    labelMenu.openAt(labelId, path, sceneX, sceneY)
  }

  function closeLabelPopups() {
    labelMenu.close()
    namePrompt.close()
    labelMovePicker.close()
    if (confirmDeleteDialog.request && confirmDeleteDialog.request.kind === "label") confirmDeleteDialog.close()
  }

  function labelDelimiterFor(id, accountId) {
    var label = service ? service.labelById(id, accountId) : null
    return Model.labelDelimiter(label)
  }

  function labelPathFor(id, accountId) {
    var label = service ? service.labelById(id, accountId) : null
    return label ? String(label.name || label.rawName || "") : ""
  }

  // A name asked for, then handed to the service with what it was for. The
  // prompt is one component serving three asks, told apart by `kind`.
  function askLabelName(kind, subject, title, initial, hint, accountId) {
    namePrompt.accountId = String(accountId || "")
    namePrompt.openFor(kind, subject, title, initial, hint)
  }

  function labelNamed(kind, subject, text, accountId) {
    if (!service) return
    if (kind === "rename") service.renameLabel(subject, text, accountId)
    else if (kind === "create") service.createLabel(subject, text, accountId)
  }

  function copyAddress(address) {
    var text = String(address || "").trim()
    // Straight to wl-copy as one argument: no shell, and an address that
    // starts with a dash is not an address.
    if (text === "" || text.charAt(0) === "-") return
    Quickshell.execDetached(["wl-copy", text])
    notice = "Copied " + text
    noticeTimer.restart()
  }

  function searchAddress(field, address) {
    if (!service) return
    var query = Provider.addressQuery(service.providerId, field, address)
    if (query === "") return
    // In the provider's own words, so it must not pass through the typed
    // search's wrapping a second time; the box shows the words for it.
    var text = (field === "to" ? "to: " : "from: ") + String(address || "").trim()
    service.searchAddress(query, text)
    searchBar.setQuery(text)
    backToList()
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
        assistantEditing: root.assistantOpen && root.assistantEditing,
        assistantCommands: !!root.activeAssistant && root.activeAssistant.commandsOpen,
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
      function focusWithin(container) {
        var item = focusScope.Window.activeFocusItem
        while (item) { if (item === container) return true; item = item.parent }
        return false
      }
      function applyContextFocus() {
        if (keyContext === "assistant" || keyContext === "assistantCommands") {
          if (composeAgent.opened && !composeAgent.activeFocus) composeAgent.takeFocus()
          else if (agentPrompt.opened && !agentPrompt.activeFocus) agentPrompt.takeFocus()
        }
        else if (keyContext === "compose") {
          if (focusWithin(compose)) return
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
          spacing: Style.space(8)

          // Checking for mail and writing one are both things you do to the
          // mailbox as a whole, so they sit together. The menu is the window's
          // own, and it stays on the left with the mark.
          IconButton {
            objectName: "refresh-button"
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage && !root.composing
            iconName: "refresh"
            tooltipText: root.calendarVisible
              ? (root.service && root.service.calendarController.loading
                ? "Loading calendars" : "Refresh calendars · F5 / Ctrl+R")
              : (root.service && root.service.listLoading
                ? "Checking for mail" : "Check mail · F5 / Ctrl+R")
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            busy: !!root.service && (root.calendarVisible
              ? !!(root.service.calendarController && root.service.calendarController.loading)
              : root.service.listLoading === true)
            enabled: root.ready && (root.calendarVisible
              ? !(root.service && root.service.calendarController.loading)
              : !(root.service && root.service.listLoading))
            onClicked: {
              if (root.calendarVisible) calendarView.refresh()
              else if (root.service) root.service.refresh()
            }
          }

          Button {
            objectName: "create-event-button"
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage && !root.composing && root.calendarVisible
            text: "Create event"
            tooltipText: "Create event"
            foreground: root.dim
            bordered: true
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            enabled: root.ready
            onClicked: eventComposer.begin()
          }

          Button {
            id: headerComposeButton
            objectName: "compose-button"
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage && !root.composing && !root.calendarVisible
            text: "Compose"
            tooltipText: "Compose · c"
            foreground: root.dim
            bordered: true
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            enabled: root.ready
            onClicked: root.startCompose("new")
          }

          Button {
            id: headerAgentButton
            parent: root.composing ? composeAiSlot : headerRight
            anchors.right: root.composing ? parent.right : undefined
            objectName: "header-ai-button"
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage && !root.calendarVisible && root.overlay !== "eventComposer"
            width: headerComposeButton.implicitHeight
            height: headerComposeButton.implicitHeight
            Accessible.name: "AI"
            tooltipText: "AI... · Alt+G"
            ActionIcon {
              anchors.centerIn: parent
              // The antenna makes the robot visually bottom-heavy.
              anchors.verticalCenterOffset: -Style.space(1)
              name: "agent"
              iconSize: Style.font.icon
              color: headerAgentButton.foreground
              fontFamily: root.fontFamily
            }
            foreground: root.assistantOpen ? root.foreground : root.dim
            bordered: true
            selected: root.assistantOpen
            focusable: true
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            enabled: root.ready && (root.assistantOpen || compose.opened || root.selectionActive
              || root.cursorId !== "" || (!!root.service && root.service.selectedId !== ""))
            onClicked: {
              if (root.assistantOpen) { agentPrompt.close(); composeAgent.close() }
              else root.runShortcut("askAgent", "Alt+G")
            }

          }

        }

        PanelSeparator {
          anchors.bottom: parent.bottom
          width: parent.width
          foreground: root.foreground
        }
      }

      // The same global AI control stays at the window's top-right when the
      // composer's own header replaces the mailbox header.
      Item {
        id: composeAiSlot
        anchors.top: parent.top
        anchors.right: parent.right
        anchors.rightMargin: Style.space(14)
        height: Style.space(44)
        width: headerAgentButton.width
        visible: root.composing
        z: 30
      }

      // -------------------------------------------------------------- body

      Item {
        id: body
        anchors.rightMargin: root.assistantWidth
        anchors.top: header.visible ? header.bottom : parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: statusBar.top

        MailboxSidebar {
          id: sidebar
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: root.sidebarCollapsed ? Style.space(44)
            : (root.sidebarWidth > 0
              ? Math.max(root.sidebarMinWidth, Math.min(root.sidebarMaxWidth, root.sidebarWidth))
              : Style.space(148))
          visible: !root.compact && !root.showPage && !root.composing
          collapsed: root.sidebarCollapsed
          calendarSelected: root.calendarVisible
          menuLabelPath: labelMenu.opened && !!root.service
            && labelMenu.accountId === root.service.activeAccountId ? labelMenu.labelPath : ""
          service: root.service
          textColor: root.foreground
          accentColor: root.accent
          dimColor: root.dim
          panelFontFamily: root.fontFamily
          slots: root.sidebarSlots
          numbersVisible: focusScope.ctrlHeld
          onMailboxSelected: function(key) { root.goMailbox(key) }
          onCalendarRequested: {
            root.showCalendar()
            calendarView.refresh()
          }
          // Not a search: the provider decides what selecting a label means,
          // and on IMAP it is a folder rather than a term to look for.
          onLabelSelected: function(labelId, name) {
            root.service.selectLabel(name, labelId)
            root.backToList()
          }
          onFolderToggled: function(path) { root.service.toggleFolder(path) }
          onLabelMenuRequested: function(labelId, path, sceneX, sceneY) {
            root.openLabelMenu(labelId, path, sceneX, sceneY)
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

        // The rail's own divider, the same shape as the list's: a hairline
        // that meets the rail's edge and a few pixels of drag target beside it.
        // Only while the rail is open — collapsed, its width is the glyph's.
        Item {
          id: sidebarSplitter
          anchors.left: sidebar.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: Style.space(5)
          visible: sidebar.visible && !root.sidebarCollapsed
          z: 5

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.SplitHCursor
            property real grabbedAt: 0
            property real grabbedWidth: 0

            onPressed: function(mouse) {
              grabbedAt = mapToItem(body, mouse.x, mouse.y).x
              grabbedWidth = sidebar.width
            }
            onPositionChanged: function(mouse) {
              if (!pressed) return
              var moved = mapToItem(body, mouse.x, mouse.y).x - grabbedAt
              root.sidebarWidth = Math.max(root.sidebarMinWidth,
                Math.min(root.sidebarMaxWidth, grabbedWidth + moved))
            }
            onReleased: root.persistPaneWidths()
            onDoubleClicked: {
              root.sidebarWidth = 0
              root.persistPaneWidths()
            }
          }
        }

        Item {
          id: listColumn
          // The splitter's drag target overlays the edge instead of leaving
          // an empty strip before the row's selection control.
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
                Math.min(parent.width - (sidebar.visible ? sidebar.width : 0)
                  - listSplitter.width - Style.space(200),
                  root.listWidth > 0 ? root.listWidth
                    : Math.min(Style.space(460), Math.round(parent.width * 0.34))))
          visible: width > 0 && !root.showPage && !root.composing
            && !root.calendarVisible

          // The scroller fills the column so its bar sits on the column edge;
          // the breathing room is padding on the content, not a margin on the
          // viewport, which would push the bar inward with it.
          Flickable {
            id: listFlick

            WheelScroller { view: listFlick }
            anchors.fill: parent
            contentWidth: width
            contentHeight: list.implicitHeight + Style.space(12)
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            MessageList {
              id: list
              scroller: listFlick
              // Match the sidebar's first row inset below the header.
              y: Style.space(6)
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
              checkedIds: root.checkedIds
              ctrlHeld: focusScope.ctrlHeld
              urgentColor: root.urgent
              onMessageActivated: function(id) { root.openMessage(id) }
              onAgentRequested: function(id, sceneX, sceneY) { root.openAgentFromRow(id, sceneX, sceneY) }
              onRowActionRequested: function(id, action) { root.actFromRow(id, action) }
              onCheckToggled: function(id) { root.toggleCheck(id) }
              onCheckRangeRequested: function(id) { root.checkRange(id) }
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
            onReleased: root.persistPaneWidths()
            // Back to the proportional default, which is what most people
            // want after one bad drag.
            onDoubleClicked: {
              root.listWidth = 0
              root.persistPaneWidths()
            }
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
          onBackRequested: root.back()
          onMemberRequested: function(id) { root.openMember(id) }
          onMemberMenuRequested: function(id, sceneX, sceneY) {
            rowMenu.openForMember(id, sceneX, sceneY)
          }
          onComposeRequested: function(mode) { root.startCompose(mode) }
          onMailtoRequested: function(url) {
            root.openDraft(Mailto.parse(url))
          }
          onAgentRequested: function(sceneX, sceneY) { root.openAgentAt(root.service.selectedId, sceneX, sceneY) }
          agentOpen: agentPrompt.opened && !!root.service && agentPrompt.messageId === root.service.selectedId
          agentWorking: !!root.service && root.service.selectedId !== ""
            && Agent.isActive((root.service.agentJobs || {})[root.service.selectedId])
          agentAttention: !!root.service && root.service.selectedId !== ""
            && (root.service.agentAttentionByMessage || {})[root.service.selectedId] === true
          onAddressMenuRequested: function(addresses, sceneX, sceneY) {
            addressMenu.openAt(addresses, sceneX, sceneY)
          }
          onActionRequested: function(action) {
            if (!root.service || root.service.selectedId === "") return
            // The toolbar acts on the message it is under, which is normally
            // the row the cursor is on — but with the rail up the reader can be
            // showing a *member*, and the list has no row for one. Moving the
            // cursor onto it would leave `j` unable to find where it stands, so
            // the cursor is only followed to a message the list actually drew;
            // from a member the action lands on the row the conversation was
            // opened from, which is where the reader came from. Which members
            // an action reaches from there is "Actions on a conversation row".
            var outside = root.checkedIds.indexOf(root.service.selectedId) < 0
            // A star stays on the open member unless it belongs to the visible
            // selection. It never moves the list's independent cursor.
            if (action === "star") {
              if (root.selectionActive && !outside)
                root.actOnChecked(Model.starActionFor(Model.summariesById(
                    root.service.messages, root.checkedIds)))
              else
                root.service.toggleStar(root.service.selectedId)
              return
            }
            if (!Conversation.holdsMember(root.service.selectedThread,
                root.service.selectedId) || root.cursorId === "")
              root.cursorId = root.service.selectedId
            if (action === "moveToLabel") return root.openLabelPicker(outside)
            root.actOnCursor(action, outside)
          }
        }

        // Composing takes the whole body. Omarchy's panel mechanism would give
        // a second window its own region, which is not what a reply is.
        ComposeView {
          id: compose
          anchors.fill: parent
          visible: opened && !root.showPage
          agentOpen: composeAgent.opened
          agentWorking: composeAgent.working
          agentAttention: !!root.service && !!root.service.hasAgent
            && root.service.agentJobWantsAttention(composeAgent.job) && !composeAgent.opened
          onAgentRequested: function(sceneX, sceneY) { composeAgent.openAt(sceneX, sceneY) }
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
          // The stack follows the view: opening pushes, closing pops — and
          // the pop is here rather than on `closed`, because a draft parked
          // for sending closes without saying so.
          onOpenedChanged: {
            if (opened) root.trackComposeOpened()
            else root.leaveCompose()
          }
          onClosed: {
            if (!root.composeDetachingForSave) root.clearComposeRecovery()
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
          onOpenedChanged: {
            if (opened) root.pushEntry("eventComposer", {})
            else root.dropOverlay("eventComposer")
          }
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
          anchors.left: sidebarSplitter.visible ? sidebarSplitter.right
            : (sidebar.visible ? sidebar.right : parent.left)
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
            // An event opened for reading is a place, so Back closes it before
            // it leaves the calendar. The view owns the open state; the stack
            // follows it.
            onDetailOpenChanged: {
              if (detailOpen) { if (root.page !== "calendarDetail") root.pushEntry("calendarDetail", {}) }
              else if (root.page === "calendarDetail") { root.navUntouched = false; root.nav = Nav.pop(root.nav) }
            }
            onCreateAt: function(startMs) { eventComposer.beginAt(startMs) }
            onCopyRequested: function(text) { root.copyText(text) }
            onOpenRequested: function(url) { Qt.openUrlExternally(url) }
            onEditRequested: function(sourceId, event) { eventComposer.beginEdit(sourceId, event) }
            onDeleteRequested: function(sourceId, event) { root.requestEventDelete(sourceId, event) }
          }
        }

        // The one Back for every page the window goes into — settings, the
        // chooser, a form. Always at the same height, and always on the left
        // edge of the page's own block — the rail's edge on Settings, the
        // form's on the rest — so it belongs to the page rather than to the
        // window's corner, and going a level deeper never moves it up or
        // down. A page that is the root (first run's chooser) has nothing
        // behind it and shows none.
        BackBar {
          id: pageBack
          objectName: "page-back"
          x: Style.space(18) + (root.showSettings ? settingsArea.blockLeft : setup.x)
          anchors.top: parent.top
          anchors.topMargin: Style.space(18)
          visible: root.showPage && Nav.depth(root.nav) > 1
          textColor: root.foreground
          dimColor: root.dim
          panelFontFamily: root.fontFamily
          onActivated: root.back()
        }
        // Where a page's content starts: under the Back when there is one.
        readonly property real pageTop: Style.space(18)
          + (pageBack.visible ? pageBack.height + Style.space(16) : 0)

        // Setup takes the whole body: there is nothing else to look at until
        // the mailbox is connected.
        Flickable {
          id: setupFlick

          WheelScroller { view: setupFlick }
          anchors.fill: parent
          anchors.margins: Style.space(18)
          anchors.topMargin: parent.pageTop
          // The chooser and the forms share this page: the Loader below picks
          // which. Hiding it for one of them is a blank window.
          visible: root.showSetup || root.showPicker
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
            objectName: "setup-page"
            // A measure this long is unreadable across a wide window, so it is
            // capped rather than stretched.
            anchors.horizontalCenter: parent.horizontalCenter
            width: Math.min(setupHolder.width, Style.space(560))
            // The provider is on the entry, so a service that briefly reports
            // Gmail while it rebuilds an account host cannot swap the page.
            readonly property string kind: root.editingProvider !== "" ? root.editingProvider : "gmail"
            sourceComponent: root.showPicker
              ? providerPickerPage
              : (setup.kind === "imap" ? imapSetupPage
                : (setup.kind === "jmap" ? jmapSetupPage
                : (setup.kind === "outlook" ? outlookSetupPage
                  : (setup.kind === "hey" ? heySetupPage : gmailSetupPage))))
          }
          }
        }

        // The settings page, which is where mailboxes are added and removed.
        // One long page with a rail of its section names beside it: the rail
        // scrolls the page, it does not split it. Below `compact` there is no
        // room for a rail, and the page scrolls as it always did.
        Item {
          id: settingsArea
          anchors.fill: parent
          anchors.margins: Style.space(18)
          anchors.topMargin: parent.pageTop
          visible: root.showSettings

          // The rail and the page are one block, centred together: the rail
          // sits against the page's left edge rather than against the
          // window's, so the two read as one thing with two columns.
          readonly property real railWidth: settingsRail.visible
            ? settingsRail.width + Style.space(18) : 0
          readonly property real pageWidth: Math.min(width - railWidth, Style.space(560))
          readonly property real blockLeft: Math.max(0, (width - railWidth - pageWidth) / 2)

          SettingsSidebar {
            id: settingsRail
            objectName: "settings-sidebar"
            visible: !root.compact
            // Above the Flickable, which spans the whole block and would
            // otherwise take the clicks meant for the rail under it.
            z: 1
            x: settingsArea.blockLeft
            anchors.top: parent.top
            width: Style.space(176)
            sections: settings.sections
            activeKey: Model.activeSettingsSection(settings.sections, settingsFlick.contentY)
            textColor: root.foreground
            dimColor: root.dim
            accentColor: root.accent
            panelFontFamily: root.fontFamily
            onSectionRequested: function(key) {
              var target = Model.settingsScrollTarget(settings.sections, key,
                settingsFlick.contentHeight, settingsFlick.height)
              if (target < 0) return
              settingsScroll.stop()
              settingsScroll.to = target
              settingsScroll.start()
            }
          }

          // A slide rather than a jump, so the eye can follow where the page
          // went. Not a Behavior on contentY: that would also slow the wheel.
          NumberAnimation {
            id: settingsScroll
            target: settingsFlick
            property: "contentY"
            duration: 160
            easing.type: Easing.OutQuad
          }

        Flickable {
          id: settingsFlick

          WheelScroller { view: settingsFlick }
          // The whole width, rail included: the wheel scrolls the page from
          // anywhere in the block, and the scrollbar keeps the window's edge.
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          contentWidth: width
          contentHeight: settingsHolder.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Item {
            id: settingsHolder
            width: settingsFlick.width
            // Padded under the page so the last section can reach the top,
            // which is what makes a click on it land where it says.
            implicitHeight: Model.settingsContentHeight(settings.sections,
              settings.implicitHeight, settingsFlick.height)

            SettingsPage {
              id: settings
              objectName: "settings-page"
              x: settingsArea.blockLeft + settingsArea.railWidth
              width: settingsArea.pageWidth
              service: root.service
              calendarController: root.service ? root.service.calendarController : null
              textColor: root.foreground
              dimColor: root.dim
              accentColor: root.accent
              urgentColor: root.urgent
              panelFontFamily: root.fontFamily
              onClientSetupRequested: root.openClientSetup()
              // Which kind first, then the form for it.
              onAddRequested: root.addMailbox()
              onEditRequested: function(index) { root.editAccount(index) }
            }
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
        queuedCount: root.service && root.service.sendPendingCount !== undefined
          ? root.service.sendPendingCount : 1
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
          // In line with the rail's own column of glyphs above it: those sit
          // 6 (the column's inset) + 8 (the row's) from the left, at the
          // rail's glyph size. The button is wider than its glyph, so it
          // starts that much further left.
          readonly property real railGlyphLeft: Style.space(6) + Style.space(8)
          anchors.left: parent.left
          anchors.leftMargin: railGlyphLeft - (size - iconSize) / 2
          anchors.verticalCenter: parent.verticalCenter
          visible: !root.compact && !root.showPage && !root.composing
          iconName: "sidebar"
          tooltipText: root.sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar"
          // No fill for the open state. The sidebar standing there is the state,
          // said far better than a lit square on the status line could say it,
          // and this control has no business drawing attention to itself.
          foreground: root.dim
          hoverColor: root.foreground
          iconSize: Style.font.icon
          size: Style.space(24)
          fontFamily: root.fontFamily
          onClicked: root.toggleSidebar()
        }

        // How many rows are ticked, beside the rail toggle. Said here rather
        // than in the list because the list is where the ticks already are;
        // this is the count, for a selection longer than the window.
        Text {
          id: selectionLabel
          objectName: "status-selection"
          anchors.left: railToggle.visible ? railToggle.right : parent.left
          anchors.leftMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          visible: root.selectionActive && !root.showPage && !root.composing
          text: Model.selectionStatus(root.checkedIds.length)
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        // What is still in flight — sends parked or going, actions running or
        // waiting their turn — said once, here, while any of it is true.
        Text {
          id: activityLabel
          objectName: "status-activity"
          anchors.left: selectionLabel.visible ? selectionLabel.right
            : (railToggle.visible ? railToggle.right : parent.left)
          anchors.leftMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          visible: text !== "" && !root.showPage
          text: root.service && root.service.activityStatus !== undefined
            ? root.service.activityStatus : ""
          // Capped so a long line of it cannot push the address off the bar.
          width: Math.min(implicitWidth, Style.space(360))
          elide: Text.ElideRight
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Item {
          id: accountSlot
          anchors.left: activityLabel.visible ? activityLabel.right
            : selectionLabel.visible ? selectionLabel.right
            : (railToggle.visible ? railToggle.right : parent.left)
          // The rail's labels sit 9 after their glyph; the toggle's box runs
          // past its glyph by half its slack, so the text starts that much
          // less after the box.
          anchors.leftMargin: railToggle.visible
            ? Style.space(9) - (railToggle.size - railToggle.iconSize) / 2
            : Style.space(14)
          // The address runs to the end of the line and the hints take what it
          // leaves. Stopping at the hints instead asked a question with no
          // answer: the slot wanted to know how much the hints had left over
          // while the hints wanted to know whether the address had left them
          // room. A notice is the one thing that does push the address over,
          // because a notice is what the window most needs to say and it says
          // it only while there is something wrong.
          anchors.right: statusBar.hasNotice ? notice.left : parent.right
          anchors.rightMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          height: Style.space(24)

          Item {
            id: accountControl
            objectName: "status-account-button"
            property bool selected: accountSwitcher.opened
            // One inset, counted twice, rather than asked for again as its own
            // double. `Style.space` rounds, and a theme whose spacing follows
            // the font does not round the two the same way: at `base-size 14`
            // the scale is 7/6, which makes `space(4)` 5 a side while
            // `space(8)` is 9 — a box a pixel narrower than the text it holds.
            // The text was then elided at every window width, which is what put
            // "just n..." on the line and why it looked like a fixed width: the
            // cut had nothing to do with how much room there was.
            readonly property real inset: Style.space(4)
            width: Math.min(parent.width, accountText.implicitWidth + inset * 2)
            height: parent.height

            Rectangle {
              id: accountBackground
              anchors.fill: parent
              anchors.margins: Style.space(2)
              radius: Style.cornerRadius
              color: accountMouse.pressed
                ? Style.pressedFillFor(root.foreground, root.accent)
                : (accountControl.selected
                  ? Style.selectedFillFor(root.foreground, root.accent)
                  : (accountMouse.containsMouse
                    ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"))
            }

            Text {
              id: accountText
              objectName: "status-account-label"
              anchors.left: parent.left
              anchors.leftMargin: accountControl.inset
              anchors.right: parent.right
              anchors.rightMargin: accountControl.inset
              anchors.verticalCenter: parent.verticalCenter
              // The full address lives here at every window width; the sync
              // age follows it, and the line opens the account controls.
              text: {
                if (!root.service || !root.ready) return "Not connected"
                return Model.readingStatusLine(root.service.unified,
                  root.service.accountEmail, root.service.syncedLabel)
              }
              color: accountMouse.containsMouse || accountControl.selected ? root.foreground : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }

            MouseArea {
              id: accountMouse
              anchors.fill: parent
              hoverEnabled: true
              onClicked: {
                var scene = accountControl.mapToGlobal(0, 0)
                accountSwitcher.openAt(scene.x, scene.y)
              }
            }
          }
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
          objectName: "status-key-hints"
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          // Only once the address has been given its room, and only whole:
          // hints are a nicety and the address is a fact, so the run of them
          // steps off the line rather than arriving with its last pair cut in
          // half. `accountSlot` no longer measures itself against this, which
          // is what keeps the two from asking each other.
          readonly property real roomLeft: statusBar.width
            - (accountSlot.x + accountControl.width)
            - Style.space(12) - Style.space(14)
          visible: !statusBar.hasNotice && !root.compact && roomLeft >= implicitWidth
          textColor: root.foreground
          dimColor: root.dimmer
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          hints: Keymap.hintsFor(focusScope.keyContext,
            root.service ? root.service.unavailableActions : [],
            root.cursorId !== "")
        }
      }

      // The window menu is opened by the menu button beside the mark.
      AppMenu {
        id: appMenu
        objectName: "app-menu"
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
        onShortcutsRequested: root.openHelp()
        onInboxRequested: {
          root.backToList()
          if (root.service) root.service.selectMailbox("inbox")
        }
        onCalendarRequested: {
          root.showCalendar()
          calendarView.refresh()
        }
        onSetupRequested: root.openSettings()
        onSwitchAccountRequested: accountSwitcher.openCentered()
        onProjectRequested: if (root.service) root.service.openProjectPage()
        onAuthorRequested: if (root.service) root.service.openAuthorPage()
      }

      // Every mailbox, opened from the address in the status bar.
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
        unifiedActive: !!root.service && root.service.unified
        onAccountChosen: function(index) {
          root.switchAccount(index)
        }
        onUnifiedChosen: root.chooseUnified()
        onAddAccountRequested: root.addMailbox()
        onManageRequested: {
          root.openSettings()
        }
      }

      Item {
        id: assistantDock
        objectName: "assistant-dock"
        anchors.right: parent.right
        anchors.top: root.composing ? composeAiSlot.bottom : header.bottom
        anchors.bottom: statusBar.top
        width: root.assistantWidth
        visible: root.assistantOpen
        MouseArea {
          objectName: "assistant-splitter"
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: Style.space(5)
          z: 100
          cursorShape: Qt.SplitHCursor
          property real grabbedAt: 0
          property real grabbedWidth: 0
          onPressed: function(mouse) {
            grabbedAt = mapToItem(focusScope, mouse.x, mouse.y).x
            grabbedWidth = root.assistantWidth
          }
          onPositionChanged: function(mouse) {
            if (!pressed) return
            var moved = mapToItem(focusScope, mouse.x, mouse.y).x - grabbedAt
            root.preferredAssistantWidth = Math.max(root.assistantMinWidth,
              Math.min(root.assistantMaxWidth, grabbedWidth - moved))
          }
          onDoubleClicked: root.preferredAssistantWidth = 0
        }
        AgentPrompt {
          id: agentPrompt
          onOpenedChanged: if (opened) composeAgent.close()
          objectName: "agent-prompt"
          service: root.service
          anchors.fill: parent
          textColor: root.foreground
          accentColor: root.accent
          urgentColor: root.urgent
          dimColor: root.dim
          popupBackgroundColor: root.popupBackground
          popupBorderColor: root.popupBorder
          panelFontFamily: root.fontFamily
          onFocusRequested: { root.assistantEditing = true; Qt.callLater(focusScope.applyContextFocus) }
          onKeyPressed: function(event) { keyRouter.routeKeyEvent(event) }
          onEditingChanged: function(editing) { root.assistantEditing = editing }
          onDismissed: { root.assistantEditing = false; Qt.callLater(focusScope.applyContextFocus) }
        }

        ComposeAgent {
          id: composeAgent
          onOpenedChanged: if (opened) agentPrompt.close()
          objectName: "compose-agent"
          anchors.fill: parent
          service: root.service
          composer: compose
          textColor: root.foreground
          accentColor: root.accent
          urgentColor: root.urgent
          dimColor: root.dim
          popupBackgroundColor: root.popupBackground
          popupBorderColor: root.popupBorder
          panelFontFamily: root.fontFamily
          onFocusRequested: { root.assistantEditing = true; Qt.callLater(focusScope.applyContextFocus) }
          onKeyPressed: function(event) { keyRouter.routeKeyEvent(event) }
          onEditingChanged: function(editing) { root.assistantEditing = editing }
          onDismissed: { root.assistantEditing = false; Qt.callLater(focusScope.applyContextFocus) }
        }
      }

      LabelMenu {
        id: labelMenu
        objectName: "label-menu"
        anchors.fill: parent
        textColor: root.foreground
        urgentColor: root.urgent
        dimColor: root.dim
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onRenameRequested: function(labelId) {
          var owner = labelMenu.accountId
          var path = root.labelPathFor(labelId, owner)
          var delimiter = root.labelDelimiterFor(labelId, owner)
          root.askLabelName("rename", labelId, "Rename " + path,
            Model.labelLeaf(path, delimiter), "The new name for this label. Labels beneath it move with it.", owner)
        }
        onCreateRequested: function(path, beneath) {
          var owner = labelMenu.accountId
          var labels = root.service ? root.service.labelsOf(owner) : []
          var delimiter = Model.labelDelimiter(labels.length > 0 ? labels[0] : null)
          var parent = beneath ? path : Model.labelParent(path, delimiter)
          root.askLabelName("create", parent,
            parent === "" ? "New label" : "New label under " + parent, "",
            "Its name at this level; nesting is the parent it goes under.", owner)
        }
        onMoveRequested: function(labelId) {
          var owner = labelMenu.accountId
          var delimiter = root.labelDelimiterFor(labelId, owner)
          labelMovePicker.accountId = owner
          labelMovePicker.openFor(labelId,
            Model.labelMoveTargets(root.service ? root.service.labelsOf(owner) : [], root.labelPathFor(labelId, owner), delimiter))
        }
        onMonitorToggled: function(labelId) { if (root.service) root.service.toggleMonitored(labelId, labelMenu.accountId) }
        onDeleteRequested: function(labelId) {
          var owner = labelMenu.accountId
          var path = root.labelPathFor(labelId, owner)
          confirmDeleteDialog.openFor({
            kind: "label", labelId: labelId, name: path, accountId: owner,
            message: "The label and every label beneath it are removed from the server. "
              + "On Gmail the messages keep their other labels; on IMAP the folder and its mail are deleted."
          })
        }
      }

      NamePrompt {
        id: namePrompt
        objectName: "name-prompt"
        anchors.fill: parent
        textColor: root.foreground
        dimColor: root.dim
        accentColor: root.accent
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onSubmitted: function(kind, subject, text) { root.labelNamed(kind, subject, text, namePrompt.accountId) }
      }

      LabelMovePicker {
        id: labelMovePicker
        objectName: "label-move-picker"
        anchors.fill: parent
        textColor: root.foreground
        accentColor: root.accent
        dimColor: root.dim
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onTargetChosen: function(labelId, parentPath) {
          if (root.service) root.service.moveLabel(labelId, parentPath, labelMovePicker.accountId)
        }
      }

      AddressMenu {
        id: addressMenu
        objectName: "address-menu"
        anchors.fill: parent
        textColor: root.foreground
        dimColor: root.dim
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        canSearch: !!root.service && Provider.addressQuery(root.service.providerId, "from", "a@b.c") !== ""
        onCopyRequested: function(address) { root.copyAddress(address) }
        onSearchRequested: function(field, address) { root.searchAddress(field, address) }
      }

      LabelPicker {
        id: labelPicker
        objectName: "label-picker"
        anchors.fill: parent
        textColor: root.foreground
        accentColor: root.accent
        dimColor: root.dim
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        labels: root.service ? root.service.labels : []
        currentLabelId: root.service ? String(root.service.rawLabelId || "") : ""
        onLabelChosen: function(labelId) {
          root.actOnCursor("label:" + labelId, root.labelPickerOnlyCursor)
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
        onAgentRequested: function(id, sceneX, sceneY) { root.openAgentAt(id, sceneX, sceneY) }
        id: rowMenu
        objectName: "rowMenu"
        service: root.service
        textColor: root.foreground
        urgentColor: root.urgent
        dimColor: root.dim
        popupBackgroundColor: root.popupBackground
        popupBorderColor: root.popupBorder
        panelFontFamily: root.fontFamily
        onComposeRequested: function(mode, id) {
          root.pendingComposeReturnTo = Nav.depth(root.nav)
          root.openMessage(id)
          root.startCompose(mode)
        }
        onActionRequested: function(action, id) {
          // On a ticked row the menu means the selection; on any other row it
          // means that row alone, whatever else is ticked.
          var outside = root.checkedIds.indexOf(id) < 0
          root.cursorId = id
          if (action === "moveToLabel") return root.openLabelPicker(outside)
          if ((action === "star" || action === "unstar") && root.selectionActive && !outside)
            return root.actOnChecked(Model.starActionFor(Model.summariesById(root.service.messages, root.checkedIds)))
          root.actOnCursor(action, outside)
        }
        // From a stop on the rail. A member is not a row, so the cursor stays
        // where the list has it and the action reaches the one message.
        onMemberComposeRequested: function(mode, id) {
          root.pendingComposeReturnTo = Nav.depth(root.nav)
          root.openMember(id)
          root.startCompose(mode)
        }
        onMemberActionRequested: function(action, id) { root.actOnMember(action, id) }
      }

      ShortcutHelp {
        id: shortcutHelp
        anchors.fill: parent
        visible: root.shortcutHelpVisible
        textColor: root.foreground
        backgroundColor: root.background
        dimColor: root.dim
        panelFontFamily: root.fontFamily
        onDismissed: root.dismissHelp()
      }

      // ---------------------------------------------------------- keyboard

      KeyRouter {
        id: keyRouter
        objectName: "key-router"
        context: focusScope.keyContext
        overlay: root.shortcutHelpVisible
        onTriggered: function(id, sequence) { root.runShortcut(id, sequence) }
      }
    }
  }

}
