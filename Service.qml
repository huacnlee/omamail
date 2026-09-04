import QtQuick
import Quickshell
import Quickshell.Io
import "account"
import "calendar"

import "account/Accounts.js" as Accounts
import "account/Model.js" as Model
import "compose/Senders.js" as Senders
import "providers/Registry.js" as Provider
import "bar/Preview.js" as Preview
import "calendar/Sources.js" as CalendarSources
import "message/Outbox.js" as Outbox
import "message/Html.js" as Html
import "message/Direction.js" as Direction

// Every mailbox on this machine, and whichever one is on screen.
//
// The window and the bar widget were written against a single mailbox, so this
// keeps that shape: it owns one MailAccount per account and forwards the whole
// surface to the active one. The alternative — teaching every view to say
// `service.current.messages` — spreads the account model across two dozen
// files for no gain.
//
// Every account polls its unread count. Only the active one loads lists and
// bodies: a badge that speaks for one mailbox while you have three is worse
// than no badge, but fetching mail nobody can see is just spent quota.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  // Injected by the shell when it constructs the service singleton. Nothing
  // else is handed over, which is why settings arrive later from the bar
  // widget rather than as a property binding.
  property var shell: null
  property var manifest: null
  property var pluginRegistry: null
  property var barWidgetRegistry: null

  readonly property string pluginId: manifest && manifest.id
    ? String(manifest.id) : "omamail"
  readonly property string pluginDir: manifest && manifest.__sourceDir
    ? String(manifest.__sourceDir) : ""

  readonly property var defaultSettingValues: ({
    refreshIntervalSec: 120,
    maxMessages: 25,
    heavyMessageRendering: Html.HEAVY_MESSAGE_RENDERING_DEFAULT,
    contentDirection: Direction.MODE_DEFAULT,
    defaultQuery: "in:inbox",
    notifyNewMail: "On",
    oauthPort: 9481,
    undoSendSeconds: 10,
    unifiedCalendarView: false
  })
  property var settings: defaultSettingValues
  readonly property int undoSendSeconds: Outbox.normalizeDelay(
    settings ? settings.undoSendSeconds : Outbox.DEFAULT_DELAY_SECONDS)
  readonly property bool alwaysRenderHeavyMessages: Html.alwaysRenderHeavyMessages(
    settings ? settings.heavyMessageRendering : null)
  readonly property bool notifyNewMail: String(settings ? settings.notifyNewMail : "On") !== "Off"
  // Which way a message's own text is read: worked out from the text, or fixed
  // by the reader. The window's chrome is not affected either way — this is a
  // fact about the mail, not about the interface around it.
  readonly property string contentDirection: Direction.normalizeMode(
    settings ? settings.contentDirection : null)
  readonly property bool unifiedCalendarView: !!settings
    && settings.unifiedCalendarView === true

  // Thunderbird and Betterbird keep both explicit and learned addresses in
  // their local profile. The helper reads those databases without modifying
  // them. Nothing is copied into Omamail's settings or cache.
  property var recipientContacts: []

  function refreshRecipientContacts() {
    if (contactReader.running || pluginDir === "") return
    contactReader.command = [pluginDir + "/scripts/contact-suggestions.py"]
    contactReader.running = true
  }

  function registerMailtoHandler() {
    if (pluginDir === "" || mailtoInstaller.running) return
    mailtoInstaller.command = [pluginDir + "/scripts/register-mailto.sh", pluginDir]
    mailtoInstaller.running = true
  }

  function applySettings(values) {
    var next = ({})
    for (var key in defaultSettingValues) next[key] = defaultSettingValues[key]
    var source = values || ({})
    for (var name in source) {
      if (source[name] === undefined || source[name] === null) continue
      next[name] = source[name]
    }
    if (JSON.stringify(next) !== JSON.stringify(settings)) settings = next
  }

  function persistSetting(name, value) {
    var next = ({})
    for (var key in settings) if (key !== "id") next[key] = settings[key]
    next[name] = value
    applySettings(next)

    var entry = ({ id: pluginId })
    for (var field in next) entry[field] = next[field]
    if (shell && typeof shell.updateEntryInline === "function")
      shell.updateEntryInline(pluginId, entry)
  }

  function setUndoSendSeconds(value) {
    persistSetting("undoSendSeconds", Outbox.normalizeDelay(value))
  }

  function setAlwaysRenderHeavyMessages(value) {
    persistSetting("heavyMessageRendering", Html.heavyMessageRendering(value))
  }

  function setNotifyNewMail(value) {
    persistSetting("notifyNewMail", value ? "On" : "Off")
  }

  function setContentDirection(value) {
    persistSetting("contentDirection", Direction.normalizeMode(value))
  }

  function setUnifiedCalendarView(value) {
    persistSetting("unifiedCalendarView", value === true)
  }

  // ---------------------------------------------------------- the accounts

  property var accountList: Accounts.emptyList()
  property bool accountsLoaded: false
  property string accountsWritePayload: ""

  readonly property int accountCount: Accounts.count(accountList)
  readonly property bool hasSavedAccounts: Accounts.hasSavedAccounts(accountList)
  readonly property string activeAccountId: accountList ? accountList.activeId : ""
  // Read here rather than in the compose view, so the window never reaches into
  // the account list itself. A pending account has no id and so no signature,
  // which is the same answer as having set none.
  readonly property string activeSignature: {
    var entry = Accounts.find(accountList, activeAccountId)
    return entry ? String(entry.signature || "") : ""
  }
  readonly property string calendarAccountId: current && String(current.accountId || "") !== ""
    ? String(current.accountId) : "__no_google_account__"

  // The instance whose mailbox is on screen. Everything below forwards to it.
  property var current: null

  // A mailbox that has not signed in yet has no address, and the id every
  // account is addressed by *is* its address — so a half-added account cannot
  // be named by activeId at all. Position is what addresses it until it learns
  // its own name. Not persisted: a pending account that survives a restart is
  // just a row waiting to be signed in, and the window should come back to the
  // mailbox that actually has mail in it.
  property int activeIndex: -1

  function accountAt(index) {
    return accountHosts.objectAt(index)
  }

  function findAccount(id) {
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (host && host.accountId === String(id)) return host
    }
    return null
  }

  function refreshCurrent() {
    var next = activeIndex >= 0 && activeIndex < accountHosts.count
      ? accountHosts.objectAt(activeIndex)
      : findAccount(activeAccountId)
    // A pending account has no id yet, so fall back to position: without this
    // a half-added mailbox could never be the one on screen, and setup would
    // have nothing to run in.
    if (!next && accountHosts.count > 0) next = accountHosts.objectAt(0)
    if (next === current) return
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (host) host.active = host === next
    }
    current = next
    if (current) current.windowOpen = windowOpen
  }

  // The whole point of switching is that it is instant, which it is because
  // each account keeps its own cache on disk. A queued send belongs to its
  // account host and remains reachable after the visible account changes.
  function switchTo(id) {
    // A notification can outlive the account it names. Refuse it before it can
    // disturb either the visible account or what is persisted on disk.
    if (!Accounts.find(accountList, id)) return false
    // The saved account can already be active while Add account has put its
    // draft on screen. Switching back still has work to do, just no file write.
    if (String(id) === activeAccountId) {
      if (activeIndex >= 0) {
        activeIndex = -1
        refreshCurrent()
      }
      return true
    }
    activeIndex = -1
    accountList = Accounts.setActive(accountList, id)
    saveAccounts()
    refreshCurrent()
    return true
  }

  // The switcher selects by position, because that is the only handle a mailbox
  // without an address has.
  function switchToIndex(index) {
    var accounts = accountList ? accountList.accounts : []
    if (index < 0 || index >= accounts.length) return false
    // Already the row the id names — but `activeIndex` can still be holding a
    // draft opened before this call, and it outranks the id everywhere the
    // editing row is worked out. Clearing it is the same correction `switchTo`
    // makes above. Without it, Edit on a mailbox chosen while Add had a draft
    // on screen opened that draft's empty form instead, and Remove then
    // targeted the draft rather than the mailbox that was clicked.
    if (index === indexOfActiveAccount()) {
      if (activeIndex >= 0) {
        activeIndex = -1
        refreshCurrent()
      }
      return true
    }
    if (accounts[index].id !== "") {
      return switchTo(accounts[index].id)
    }
    activeIndex = index
    refreshCurrent()
    return true
  }

  // The provider is chosen before the row exists, because it decides which
  // setup page the new row opens into — and, for Gmail, whether it can borrow
  // the OAuth client an existing account already set up.
  function addAccount(provider) {
    accountList = Accounts.add(accountList, ({
      email: "", clientId: "", clientSecret: "",
      provider: provider || Provider.DEFAULT_ID,
      // Working state for the form, and it says so rather than leaving the
      // write boundary to guess from a missing id — which is what it used to
      // do, and what made it delete a mailbox whose address had been corrupted.
      // `makeAccount` clears this the moment a real address arrives.
      pending: true
    }))
    // This row is working state for the form, not an account yet. Persisting
    // it here leaves a "New account" behind when Back cancels Add; the first
    // successful configureAccount call is what saves it.
    // Switching to it is the whole point, and it has to happen before the page
    // opens: without this the setup page ran against whichever mailbox was
    // already on screen, so adding an account showed the *existing* account's
    // finished setup and there was no way through to signing a new one in.
    activeIndex = accountCount - 1
    refreshCurrent()
    accountAdded()
  }

  function discardCurrentDraft() {
    var index = editingIndex()
    var next = Accounts.discardDraftAt(accountList, index)
    if (Accounts.count(next) === accountCount) return false
    activeIndex = -1
    accountList = next
    refreshCurrent()
    return true
  }

  function removeAccount(id) {
    activeIndex = -1
    accountList = Accounts.remove(accountList, id)
    saveAccounts()
    refreshCurrent()
  }

  function removeAccountAt(index) {
    activeIndex = -1
    accountList = Accounts.removeAt(accountList, index)
    saveAccounts()
    refreshCurrent()
  }

  // An account learns its own address on its first profile read; until then the
  // list has a nameless row that nothing can select.
  function nameAccount(index, email) {
    var accounts = accountList.accounts
    if (index < 0 || index >= accounts.length) return
    // The id depends on the provider as well as the address — one address may
    // be a Gmail account and an IMAP account at once — so the entry's own
    // provider decides what it is about to be called.
    var named = Accounts.accountId(email, accounts[index].provider)
    if (accounts[index].id === named) return
    // The other place an address reaches the list, and the other place one that
    // is not an address can destroy a mailbox: an empty id means `accountId`
    // could make nothing of what the provider reported, and writing it would
    // replace a working row's address with a name that addresses nothing. A
    // rename that cannot produce an id has nothing to offer, so it is refused
    // rather than stored — the row keeps the address it already answers to.
    if (named === "") return

    // Two rows cannot hold one address. Rebuilding the list would fold them
    // together and take the row being added with it, which read as the add
    // silently undoing itself. A mailbox that is already here is a duplicate,
    // not a rename, and the row that has to go is the new one.
    for (var d = 0; d < accounts.length; d++) {
      if (d === index || accounts[d].id !== named) continue
      activeIndex = -1
      accountList = Accounts.removeAt(accountList, index)
      saveAccounts()
      refreshCurrent()
      duplicateAccount(email)
      return
    }

    var updated = Accounts.emptyList()
    updated.activeId = accountList.activeId
    for (var i = 0; i < accounts.length; i++) {
      // Everything but the address is carried over rather than listed field by
      // field: a rebuild that names the fields it keeps silently drops the ones
      // added afterwards, which is how an IMAP account would come back as a
      // Gmail one the first time it learned its own name.
      updated = Accounts.add(updated, i === index
        ? withEmail(accounts[i], email) : accounts[i])
    }
    if (updated.activeId === "" || activeIndex === index)
      updated = Accounts.setActive(updated, named)
    if (activeIndex === index) activeIndex = -1
    accountList = updated
    saveAccounts()
  }

  function withEmail(entry, email) {
    var next = {}
    for (var key in entry) next[key] = entry[key]
    next.email = email
    return next
  }

  // What the IMAP setup form saves: the address, the servers, and which
  // provider this row is. Written before the password is tried, so a mailbox
  // that fails to sign in still has its settings to correct rather than an
  // empty form to fill in again.
  function configureAccount(index, values) {
    var accounts = accountList.accounts
    if (index < 0 || index >= accounts.length) return
    var raw = values || ({})

    var entry = {}
    for (var key in accounts[index]) entry[key] = accounts[index][key]
    if (raw.provider !== undefined) entry.provider = raw.provider
    if (raw.email !== undefined) entry.email = raw.email
    if (raw.imap !== undefined) entry.imap = raw.imap
    if (raw.label !== undefined) entry.label = raw.label

    var updated = Accounts.emptyList()
    updated.activeId = accountList.activeId
    for (var i = 0; i < accounts.length; i++)
      updated = Accounts.add(updated, i === index ? entry : accounts[i])

    var id = Accounts.accountId(entry.email, entry.provider)
    if (id !== "" && (updated.activeId === "" || activeIndex === index))
      updated = Accounts.setActive(updated, id)
    if (activeIndex === index) activeIndex = -1
    accountList = updated
    saveAccounts()
    refreshCurrent()
  }

  // A save that arrives while one is already running is queued, never dropped.
  // Dropping it is what made adding a mailbox undo itself: the new account was
  // never written, and the watcher then read the older file back over it.
  property bool accountsSaveQueued: false

  // Identical text is not a write. The editor saves when it is done with
  // rather than on every keystroke, but it is also rebuilt by the write it
  // causes — so the value it hands back on the way out is routinely the one
  // already on disk, and a file round trip for it would be pure cost.
  function setAccountSignature(id, text) {
    var next = Accounts.setSignature(accountList, id, text)
    if (Accounts.serialize(next) === Accounts.serialize(accountList)) return
    accountList = next
    saveAccounts()
  }

  function saveAccounts() {
    if (!accountsLoaded) return
    // A nameless row is setup state, never a mailbox. There is no legitimate
    // path that persists only one — Add waits for configureAccount, and the UI
    // does not remove the final saved account — so refusing this write is the
    // last line of defence against replacing every account with first-run.
    //
    // Only the mailboxes, never the form's own working row: a save triggered by
    // one account used to carry whatever draft happened to be open along with
    // it, stranding a row on disk that nothing could select or remove. The
    // guard is applied to that stripped list rather than to what is in memory,
    // so it is testing the bytes that are about to be written instead of
    // trusting the two to agree.
    var writable = Accounts.savedOnly(accountList)
    if (!Accounts.hasSavedAccounts(writable)) return
    // And no mailbox the list could name may go missing on the way to the
    // payload. The guard above is about the list as a whole — one real mailbox
    // in it is enough to satisfy it, which is exactly why it let a write
    // through that had dropped a different, working account. This one is per
    // row. Removal never arrives here as an omission: it goes through
    // `remove` or `removeAt`, so the row is gone from `accountList` too.
    if (Accounts.dropsNamedMailbox(accountList, writable)) return
    if (accountsWriter.running) {
      accountsSaveQueued = true
      return
    }
    accountsSaveQueued = false
    accountsWritePayload = Accounts.serialize(writable)
    accountsWriter.command = [pluginDir + "/scripts/config-store.sh", "accounts.json"]
    accountsWriter.running = true
  }

  function applyAccounts(raw) {
    // FileView can report a failed read while an atomically replaced watched
    // file is settling. First run still gets its placeholder below, but once a
    // real list is in memory an unreadable instant must not erase the UI and
    // become the next value written back to disk.
    if (accountsLoaded && !Accounts.isSerializedList(raw)) return
    var loaded = Accounts.load(raw)
    // First run, or an install that predates several accounts: one nameless
    // row so the existing credentials file still has somewhere to live.
    if (Accounts.count(loaded) === 0)
      loaded = Accounts.add(loaded, ({ email: "", clientId: "", clientSecret: "", pending: true }))
    // Reading back our own write must change nothing. The list is watched so
    // that an edit from outside is picked up, but every save triggers that
    // watch — and reassigning the list re-derives every account's id, which
    // resets its cache and its session. That is what made adding a mailbox
    // flicker through several states: the window was rebuilding every account
    // each time the file it had just written landed back.
    //
    // Compared on the saved rows alone, because that is all the write contains.
    // Against the whole in-memory list an open draft would make every read-back
    // look like an outside edit, and adopting it would destroy the row the user
    // is typing into.
    if (accountsLoaded && Accounts.serialize(Accounts.savedOnly(loaded))
        === Accounts.serialize(Accounts.savedOnly(accountList)))
      return
    // What is on disk is behind what is in memory until the pending write
    // lands, so a reload now would be a straight revert.
    if (accountsWriter.running || accountsSaveQueued) return
    accountList = loaded
    accountsLoaded = true
  }

  signal accountAdded()

  // ------------------------------------------------------ window preferences
  //
  // Kept beside the account list rather than in plugin settings: those are
  // pushed in from the bar widget and are not the window's to write. Only what
  // the window cannot recompute lives here.

  property bool sidebarCollapsed: false
  // Somebody who needed the text bigger needs it bigger for their mail, not for
  // the message that made them reach for it. The same goes for `bodyMode`:
  // both of these are ways of reading mail, not ways of reading one message.
  property real bodyZoom: 1.0
  // How a message is read: rebuilt for reading, the sender's own formatting, or
  // text. Reading is the default because it is the one that answers the same
  // way for every sender — a newsletter, a receipt and a reply all arrive as
  // this window's type at this window's measure — and the other two are there
  // for the messages whose own layout is carrying something.
  property string bodyMode: "reader"
  // Off until somebody says otherwise, and then it stays said. Loading a
  // remote image tells its host that this address opened this message, at this
  // moment — the reason the answer was once asked for one message at a time.
  // Asked for every message, it is a decision somebody makes once and should
  // not be asked to make again on the next one; the switch that turns it on is
  // in Settings, which is also the only place that can turn it back off.
  property bool alwaysShowImages: false
  property bool windowPrefsLoaded: false
  property string windowWritePayload: ""
  property bool restoreWindow: false
  property int restoreAttempts: 0

  function applyWindowPrefs(raw) {
    var prefs = Model.windowPrefs(raw)
    sidebarCollapsed = prefs.sidebarCollapsed
    bodyZoom = prefs.bodyZoom
    bodyMode = prefs.bodyMode
    alwaysShowImages = prefs.alwaysShowImages
    restoreWindow = prefs.windowOpen
    restoreAttempts = 0
    windowPrefsLoaded = true
    if (restoreWindow) Qt.callLater(root.reopenWindow)
    else if (windowOpen) saveWindowPrefs()
  }

  function reopenWindow() {
    if (!restoreWindow || windowOpen) return
    if (restoreAttempts > 10) return
    restoreAttempts = restoreAttempts + 1
    if (!shell || typeof shell.summon !== "function") {
      restoreTimer.start()
      return
    }
    var ok = shell.summon(pluginId, "{}")
    if (!ok) restoreTimer.start()
  }

  // A toggle is written the moment it is made; a zoom is dragged, and Ctrl and
  // the wheel walk through a dozen values in a second. So the first change goes
  // out immediately and anything arriving while that write is still running
  // waits for the scrolling to stop — dropping those, which is what a bare
  // `running` guard does, loses the one value the user settled on.
  function saveWindowPrefs() {
    if (!windowPrefsLoaded) return
    if (windowWriter.running) {
      windowPrefsSettling.restart()
      return
    }
    windowPrefsSettling.stop()
    windowWritePayload = JSON.stringify({
      sidebarCollapsed: sidebarCollapsed,
      bodyZoom: bodyZoom,
      bodyMode: bodyMode,
      alwaysShowImages: alwaysShowImages,
      windowOpen: windowOpen || restoreWindow
    })
    windowWriter.command = [pluginDir + "/scripts/config-store.sh", "window.json"]
    windowWriter.running = true
  }

  function setSidebarCollapsed(value) {
    var next = value === true
    if (next === sidebarCollapsed) return
    sidebarCollapsed = next
    saveWindowPrefs()
  }

  function setBodyZoom(value) {
    var next = Model.clampZoom(value)
    if (next === bodyZoom) return
    bodyZoom = next
    saveWindowPrefs()
  }

  function setBodyMode(value) {
    // The message on screen is not read again for this: all three readings came
    // off the one parse when the body arrived, so choosing between them is a
    // preference and nothing else.
    var next = Html.bodyModeOf(value, bodyMode)
    if (next === bodyMode) return
    bodyMode = next
    saveWindowPrefs()
  }

  function setAlwaysShowImages(value) {
    var next = value === true
    if (next === alwaysShowImages) return
    alwaysShowImages = next
    saveWindowPrefs()
    // The message on screen is the one the answer was given about, so it
    // answers now rather than at the next message.
    if (next && current) current.showRemoteImages()
  }
  signal duplicateAccount(string email)

  // ------------------------------------------------------------ aggregates

  property int unreadTotal: 0
  // Whether any mailbox at all is signed in. The first-run walkthrough keys on
  // this rather than on the mailbox in view: once one account works, a second
  // one that has not signed in yet is a row waiting in settings, not a reason
  // to send the whole window back to the beginning.
  property bool anyAccountReady: false

  // Instantiator.objectAt is not a property. sendIdentities has to watch
  // something recount() updates, or From is computed once with no hosts
  // and never lists the other signed-in mailboxes.
  property int hostsEpoch: 0

  function recount() {
    var total = 0
    var signedIn = false
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (!host) continue
      total += host.inboxUnread
      if (host.ready) signedIn = true
    }
    unreadTotal = total
    anyAccountReady = signedIn
    hostsEpoch += 1
  }

  // The bar answers for all of them: a badge that counted only the mailbox you
  // happen to be looking at would be worse than none.
  readonly property string barTooltip: {
    if (!ready) return "Omamail · Not connected"
    var suffix = unreadTotal === 0 ? "No unread mail"
      : (unreadTotal === 1 ? "1 unread message" : unreadTotal + " unread messages")
    // The address, whatever the number of mailboxes. How many are configured is
    // not something a tooltip on a mail icon is asked, and the count it used to
    // give was of mailboxes rather than of anything waiting in them.
    return (accountEmail !== "" ? accountEmail : "Omamail") + " · " + suffix
  }

  // The switcher's model: every mailbox, its count, and why it is not usable.
  // Deliberately not part of accountSummaries. That array is rebuilt from
  // `unread`, `active`, `signedIn`, `busy` and `error`, so a poll replaces it
  // twice a cycle with no account having changed — and a settings field built
  // over it is destroyed and refilled under whoever is typing in it. This
  // changes only when the account list does.
  readonly property var accountSignatures: {
    var out = []
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      // A mailbox part-way through being added has no id to save against.
      if (!accounts[i].id) continue
      out.push({
        id: accounts[i].id,
        email: accounts[i].email,
        signature: String(accounts[i].signature || "")
      })
    }
    return out
  }

  readonly property var accountSummaries: {
    var out = []
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      var host = accountHosts.objectAt(i)
      out.push({
        id: accounts[i].id,
        email: accounts[i].email,
        provider: accounts[i].provider,
        label: Accounts.label(accounts[i]),
        unread: host ? host.inboxUnread : 0,
        active: host ? host.active : false,
        signedIn: host ? host.ready : false,
        busy: host ? host.listLoading : false,
        error: host ? host.lastError : ""
      })
    }
    return out
  }

  readonly property var barMessages: {
    var accounts = []
    var values = accountList ? accountList.accounts : []
    for (var i = 0; i < values.length; i++) {
      var host = accountHosts.objectAt(i)
      accounts.push({
        id: values[i].id, label: Accounts.label(values[i]), inbox: "Inbox",
        messages: host ? host.previewMessages : []
      })
    }
    return Preview.latestMessages(accounts, 3)
  }

  readonly property alias calendarController: sharedCalendar
  readonly property var barEvents: Preview.upcomingEvents(
    barCalendar.events, Date.now(), 2)

  function refreshCalendarPreview() {
    var now = new Date()
    barCalendar.refresh(now.getTime(),
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 31).getTime())
  }

  function openCalendarEditor() {
    var url = CalendarSources.calendarEditorUrl(sharedCalendar.sourceList)
    if (url !== "") Quickshell.execDetached(["xdg-open", url])
  }

  // ------------------------------------------------------------- forwarding

  property bool windowOpen: false
  onWindowOpenChanged: {
    if (current) current.windowOpen = windowOpen
    if (windowOpen) restoreWindow = false
    saveWindowPrefs()
  }

  readonly property var auth: current ? current.auth : null
  readonly property bool ready: !!current && current.ready
  readonly property string accountEmail: current ? current.accountEmail : ""
  // The short name the switcher shows for the account on screen — the label
  // the user gave it, or the local part of its address. The sidebar's user
  // bar shows this; the full address is on the status line.
  readonly property string accountLabel: {
    var entry = Accounts.find(accountList, activeAccountId)
    return entry ? Accounts.label(entry) : ""
  }
  readonly property var sendAsAliases: current ? current.availableSendAsAliases : []
  // Every address a new message may be sent as, across signed-in mailboxes.
  // Compose reads this and hides the ones that do not belong on a reply.
  readonly property var sendIdentities: {
    var _epoch = hostsEpoch
    var mailboxes = []
    var accounts = accountList ? accountList.accounts : []
    var i
    for (i = 0; i < accounts.length; i++) {
      var host = accountHosts.objectAt(i)
      mailboxes.push({
        id: accounts[i].id,
        email: host && host.accountEmail ? host.accountEmail : accounts[i].email,
        label: Accounts.label(accounts[i]),
        ready: !!(host && host.ready),
        canSend: !!(host && host.canSend),
        aliases: host ? host.availableSendAsAliases : []
      })
    }
    return Senders.identities(mailboxes)
  }
  readonly property string accountAddress: {
    var accounts = accountList ? accountList.accounts : []
    var index = editingIndex()
    return index >= 0 && index < accounts.length ? String(accounts[index].email || "") : ""
  }
  readonly property int inboxUnread: current ? current.inboxUnread : 0
  readonly property var messages: current ? current.messages : []
  readonly property var labels: current ? current.labels : []

  // Which service the mailbox on screen is, what mailboxes it has, and what it
  // can be asked to do. Forwarded like everything else so a view never has to
  // reach past `service` to find out.
  readonly property string providerId: current ? current.providerId : Provider.DEFAULT_ID
  readonly property var mailboxes: current
    ? current.mailboxes : Provider.mailboxes(Provider.DEFAULT_ID)
  readonly property bool canArchive: !current || current.canArchive
  readonly property bool canReportSpam: !current || current.canReportSpam
  readonly property bool canStar: !current || current.canStar
  readonly property bool hasLabels: !current || current.hasLabels
  readonly property bool canOpenOnWeb: !current || current.canOpenOnWeb
  readonly property bool canOpenWebInbox: !!current && current.canOpenWebInbox
  readonly property var unavailableActions: current ? current.unavailableActions : []
  readonly property var savingAttachmentIds: current ? current.savingAttachmentIds : ({})
  readonly property bool canSend: !current || current.canSend
  readonly property string mailboxKey: current ? current.mailboxKey : "inbox"
  readonly property string searchQuery: current ? current.searchQuery : ""
  readonly property string rawQuery: current ? current.rawQuery : ""
  readonly property bool listLoading: !!current && current.listLoading
  readonly property bool listLoaded: !!current && current.listLoaded
  readonly property bool serverSearchLoading: !!current && current.serverSearchLoading
  readonly property bool hasMore: !!current && current.hasMore
  readonly property string resultSummary: current ? current.resultSummary : ""
  readonly property string selectedId: current ? current.selectedId : ""
  readonly property var selectedMessage: current ? current.selectedMessage : null
  readonly property var selectedBody: current ? current.selectedBody : ({ text: "", source: "" })
  readonly property string selectedHtml: current ? current.selectedHtml : ""
  readonly property var selectedDocument: current ? current.selectedDocument : null
  readonly property var selectedReaderDocument: current ? current.selectedReaderDocument : null
  readonly property bool selectedReaderTooHeavy: !!current && current.selectedReaderTooHeavy
  readonly property bool selectedReaderEmpty: !current || current.selectedReaderEmpty
  readonly property int selectedReaderRemoteImages: current ? current.selectedReaderRemoteImages : 0
  readonly property var selectedImages: current ? current.selectedImages : []
  readonly property int selectedBlockedImages: current ? current.selectedBlockedImages : 0
  readonly property int selectedRemoteImages: current ? current.selectedRemoteImages : 0
  readonly property bool remoteImagesAllowed: !!current && current.remoteImagesAllowed
  readonly property var selectedAttachments: current ? current.selectedAttachments : []
  readonly property bool selectedTooHeavy: !!current && current.selectedTooHeavy
  // The meeting inside the message, and this account's answer to it.
  readonly property var selectedInvite: current ? current.selectedInvite : null
  readonly property string selectedResponse: current ? current.selectedResponse : ""
  readonly property bool canRespondToInvite: !!current && current.canRespondToInvite
  readonly property bool rsvpSending: !!current && current.rsvpSending
  // Empty when this message offers no way off a list, which is the answer for
  // everything that is not a newsletter.
  readonly property string unsubscribeLabel: current ? current.unsubscribeLabel : ""
  readonly property string unsubscribeDetail: current ? current.unsubscribeDetail : ""
  readonly property bool unsubscribing: !!current && current.unsubscribing
  readonly property bool detailLoading: !!current && current.detailLoading
  readonly property bool detailPainted: !!current && current.detailPainted
  readonly property bool sending: !!current && current.sending
  readonly property var pendingSendHost: {
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (host && host.sendPending) return host
    }
    return null
  }
  readonly property bool sendPending: !!pendingSendHost
  readonly property int sendSecondsRemaining: pendingSendHost
    ? pendingSendHost.sendSecondsRemaining : 0
  readonly property string lastError: current ? current.lastError : ""
  readonly property string actionStatus: current ? current.actionStatus : ""
  readonly property string signInProgress: current ? current.signInProgress : ""
  readonly property string syncedLabel: current ? current.syncedLabel : ""

  function refresh() { if (current) current.refresh() }
  function loadMore() { if (current) current.loadMore() }
  function select(id) { if (current) current.select(id) }
  function clearSelection() { if (current) current.clearSelection() }
  // The notice's own button, which is the switch: what it turns on is every
  // message, and it says so.
  function showRemoteImages() { setAlwaysShowImages(true) }
  function rsvp(response) { if (current) current.rsvp(response) }
  function unsubscribe() { if (current) current.unsubscribe() }
  function cursorOffset(cursorId, delta) {
    return current ? current.cursorOffset(cursorId, delta) : ""
  }
  function selectMailbox(key) { if (current) current.selectMailbox(key) }
  function search(text) { if (current) current.search(text) }
  function selectLabel(name) { if (current) current.selectLabel(name) }
  function act(id, action, quiet) {
    return current ? current.act(id, action, quiet) : false
  }
  function toggleStar(id) { if (current) current.toggleStar(id) }
  function markAllRead() { if (current) current.markAllRead() }
  function send(fields) { return current ? current.send(fields) : false }
  function saveDraft(fields, callback) {
    var values = fields || ({})
    var target = String(values.accountId || "")
    var host = target !== "" ? findAccount(target) : current
    if (!host) {
      if (typeof callback === "function") callback(null, "The mailbox for this draft is unavailable")
      return null
    }
    return host.saveDraft(values, callback)
  }
  function fail(text) { if (current) current.fail(text) }
  function note(text) { if (current) current.note(text) }
  function undoSend() {
    var host = pendingSendHost
    if (!host) return false
    if (host !== current) {
      for (var i = 0; i < accountHosts.count; i++) {
        if (accountHosts.objectAt(i) === host) {
          switchToIndex(i)
          break
        }
      }
    }
    return host.undoSend()
  }
  function loadAttachments(messageId, attachments, callback) {
    if (current) return current.loadAttachments(messageId, attachments, callback)
    if (typeof callback === "function") callback([], "No mailbox is selected")
    return null
  }
  function openAttachment(messageId, attachment) {
    if (current) current.openAttachment(messageId, attachment)
  }

  function saveAttachment(messageId, attachment) {
    if (current) current.saveAttachment(messageId, attachment)
  }
  function preferredSendAs(recipients) {
    return current ? current.preferredSendAs(recipients) : null
  }
  function signIn() { if (current) current.signIn() }
  function cancelSignIn() { if (current) current.cancelSignIn() }
  function signOut() { if (current) current.signOut() }

  // The password providers' sign-in. Gmail's is a browser and answers false,
  // which is what lets one setup page ask without checking first.
  function signInWithPassword(secret) {
    return !!current && current.signInWithPassword(secret)
  }

  // The setup form writes back to the account row it is editing, which is the
  // one on screen. Addressed by index because that is the only handle on a row
  // that has no address yet — which is exactly the row being filled in.
  function configureCurrentAccount(values) {
    configureAccount(editingIndex(), values)
  }

  // Saving a new address rebuilds the account host. Wait for that replacement
  // before asking it to sign in; calling through immediately targets the host
  // that the save has just retired, which made a failed attempt knock the user
  // out of the add flow on the next click.
  function configureCurrentAccountAndSignIn(values, secret) {
    configureCurrentAccount(values)
    Qt.callLater(function() { root.signInWithPassword(secret) })
  }

  function indexOfActiveAccount() {
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id !== "" && accounts[i].id === accountList.activeId) return i
    }
    // Nothing matched by id, which is what a row still being filled in looks
    // like: it has no address yet, so it has no id to match on. The first such
    // row is the one the form is editing.
    for (var j = 0; j < accounts.length; j++) {
      if (accounts[j].id === "") return j
    }
    return -1
  }

  // Which row the setup page is editing. `activeIndex` is the override a row
  // with no id needs — it cannot be named — and the active account's own
  // position answers for every other row. One function because three callers
  // used to spell this out for themselves and a fourth, the Remove button,
  // spelled it differently: it asked `indexOfActiveAccount()` alone, so on the
  // page of a freshly added mailbox it named the mailbox that was on screen
  // before the add, and removing it deleted a working account.
  function editingIndex() {
    return activeIndex >= 0 ? activeIndex : indexOfActiveAccount()
  }

  function openInBrowser(id) { if (current) current.openInBrowser(id) }
  function openWebInbox() { if (current) current.openWebInbox() }

  // The service's own website, from the setup page's hero — where everything
  // this window deliberately does not do still lives: HEY's Screener, Gmail's
  // filters and forwarding.
  //
  // Asked for by provider rather than by account: the page that offers it is
  // about a kind of mailbox, and during an add it is about one that has no
  // address yet.
  function openProviderWebsite(id) {
    var url = Provider.webHomeUrl(id)
    if (url !== "") Quickshell.execDetached(["xdg-open", url])
  }

  // The program a provider runs on, which is a different address from the
  // service — HEY is hey.com, and the client that reaches it is a repository.
  function openProviderClient(id) {
    var url = Provider.clientUrl(id)
    if (url !== "") Quickshell.execDetached(["xdg-open", url])
  }
  function openCloudConsole() { if (current) current.openCloudConsole() }
  function openGmailApiPage() { if (current) current.openGmailApiPage() }

  // Not forwarded to an account: the project exists whether or not anyone has
  // signed in, and the menu offers it on the setup page too.
  function openProjectPage() {
    Quickshell.execDetached(["xdg-open", "https://github.com/huacnlee/omamail"])
  }

  function openAuthorPage() {
    Quickshell.execDetached(["xdg-open", "https://x.com/huacnlee"])
  }
  function openConsentScreen() { if (current) current.openConsentScreen() }

  function withGoogleAccessToken(accountId, callback) {
    var accounts = accountList && accountList.accounts ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i] && accounts[i].id === accountId && accounts[i].provider === "gmail") {
        var host = accountHosts.objectAt(i)
        if (host) { host.withAccessToken(callback); return }
      }
    }
    callback("", "The Google calendar account is not signed in")
  }

  signal replySent()

  // ------------------------------------------------------------- instances

  CalendarController {
    id: sharedCalendar
    service: root
    pluginDir: root.pluginDir
    accountId: root.calendarAccountId
    onSourceListChanged: {
      barCalendar.sourceList = sourceList
      Qt.callLater(root.refreshCalendarPreview)
    }
    onSourcesLoadedChanged: barCalendar.sourcesLoaded = sourcesLoaded
  }

  CalendarController {
    id: barCalendar
    service: root
    pluginDir: root.pluginDir
    cacheName: "calendar-bar"
    Component.onCompleted: Qt.callLater(root.refreshCalendarPreview)
  }

  Timer {
    interval: 600000
    repeat: true
    running: true
    onTriggered: root.refreshCalendarPreview()
  }

  // The model is a COUNT, not the array. An Instantiator rebuilds every
  // delegate when its model changes identity, and this list is reassigned
  // whole on every save — so modelling the array tore down all the accounts
  // whenever one of them learned its own address, dropping their loaded state
  // and landing in-flight callbacks on half-destroyed objects.
  Instantiator {
    id: accountHosts
    model: root.accountCount

    delegate: MailAccount {
      required property int index

      readonly property var entry: {
        var accounts = root.accountList ? root.accountList.accounts : []
        return index < accounts.length ? accounts[index] : null
      }

      pluginDir: root.pluginDir
      accountId: entry ? entry.id : ""
      configuredEmail: entry ? entry.email : ""
      // Which service this mailbox is, and — for the one that needs them — the
      // servers it talks to. Both come off the account entry, so changing an
      // account's provider in the file rebuilds it as that provider.
      providerId: entry ? entry.provider : Provider.DEFAULT_ID
      imapSettings: entry ? entry.imap : null
      // Only a Gmail account has a client-keyed refresh token to inherit, and
      // only the first one may claim it.
      mayAdoptLegacyToken: index === 0 && (!entry || entry.provider === "gmail")
      settings: root.settings
      // Every mailbox obeys the one answer: it is about what the reader is
      // willing to tell a sender, not about which account the mail came to.
      alwaysShowImages: root.alwaysShowImages

      onAccountIdentified: function(email) { root.nameAccount(index, email) }
      onReadyChanged: root.recount()
      onInboxUnreadChanged: root.recount()
      onReplySent: root.replySent()

      Component.onCompleted: Qt.callLater(root.refreshCurrent)
      Component.onDestruction: Qt.callLater(root.refreshCurrent)
    }
  }

  onActiveAccountIdChanged: refreshCurrent()
  onAccountListChanged: Qt.callLater(refreshCurrent)

  FileView {
    id: windowFile
    path: {
      var home = Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")
      return home + "/omamail/window.json"
    }
    printErrors: false
    onLoaded: root.applyWindowPrefs(text())
    // No file yet is the ordinary first-run state, not an error.
    onLoadFailed: root.applyWindowPrefs("")
  }

  Timer {
    id: windowPrefsSettling
    interval: 500
    onTriggered: root.saveWindowPrefs()
  }

  Timer {
    id: restoreTimer
    interval: 200
    repeat: false
    onTriggered: root.reopenWindow()
  }

  Process {
    id: windowWriter
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.windowWritePayload + "\n")
      root.windowWritePayload = ""
    }
    onExited: root.windowWritePayload = ""
  }

  FileView {
    id: accountsFile
    path: {
      var home = Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")
      return home + "/omamail/accounts.json"
    }
    watchChanges: true
    printErrors: false
    onLoaded: root.applyAccounts(text())
    onFileChanged: reload()
    // No list yet is the ordinary first-run state, not an error.
    onLoadFailed: root.applyAccounts("")
  }

  Process {
    id: accountsWriter
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.accountsWritePayload + "\n")
      root.accountsWritePayload = ""
    }
    onExited: {
      root.accountsWritePayload = ""
      if (root.accountsSaveQueued) root.saveAccounts()
    }
  }

  Process {
    id: contactReader
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var parsed = null
      try { parsed = JSON.parse(String(stdout.text || "[]")) } catch (e) { parsed = null }
      if (Array.isArray(parsed)) root.recipientContacts = parsed
    }
  }

  Process {
    id: mailtoInstaller
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }

  Component.onCompleted: {
    Qt.callLater(root.refreshRecipientContacts)
    Qt.callLater(root.registerMailtoHandler)
  }
}
