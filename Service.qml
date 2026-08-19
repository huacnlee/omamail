import QtQuick
import Quickshell
import Quickshell.Io

import "Accounts.js" as Accounts

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
    defaultQuery: "in:inbox",
    notifyNewMail: "On",
    oauthPort: 9481
  })
  property var settings: defaultSettingValues

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

  // ---------------------------------------------------------- the accounts

  property var accountList: Accounts.emptyList()
  property bool accountsLoaded: false
  property string accountsWritePayload: ""

  readonly property int accountCount: Accounts.count(accountList)
  readonly property string activeAccountId: accountList ? accountList.activeId : ""

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
  // each account keeps its own cache on disk.
  function switchTo(id) {
    if (String(id) === activeAccountId && activeIndex < 0) return
    activeIndex = -1
    accountList = Accounts.setActive(accountList, id)
    saveAccounts()
    refreshCurrent()
  }

  // The switcher selects by position, because that is the only handle a mailbox
  // without an address has.
  function switchToIndex(index) {
    var accounts = accountList ? accountList.accounts : []
    if (index < 0 || index >= accounts.length) return
    if (accounts[index].id !== "") {
      switchTo(accounts[index].id)
      return
    }
    activeIndex = index
    refreshCurrent()
  }

  function addAccount() {
    accountList = Accounts.add(accountList, ({ email: "", clientId: "", clientSecret: "" }))
    saveAccounts()
    // Switching to it is the whole point, and it has to happen before the page
    // opens: without this the setup page ran against whichever mailbox was
    // already on screen, so adding an account showed the *existing* account's
    // finished setup and there was no way through to signing a new one in.
    activeIndex = accountCount - 1
    refreshCurrent()
    accountAdded()
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
    var named = Accounts.accountId(email)
    if (accounts[index].id === named) return

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
      updated = Accounts.add(updated, i === index
        ? ({ email: email, clientId: accounts[i].clientId,
             clientSecret: accounts[i].clientSecret, label: accounts[i].label })
        : accounts[i])
    }
    if (updated.activeId === "" || activeIndex === index)
      updated = Accounts.setActive(updated, Accounts.accountId(email))
    if (activeIndex === index) activeIndex = -1
    accountList = updated
    saveAccounts()
  }

  // A save that arrives while one is already running is queued, never dropped.
  // Dropping it is what made adding a mailbox undo itself: the new account was
  // never written, and the watcher then read the older file back over it.
  property bool accountsSaveQueued: false

  function saveAccounts() {
    if (!accountsLoaded) return
    if (accountsWriter.running) {
      accountsSaveQueued = true
      return
    }
    accountsSaveQueued = false
    accountsWritePayload = Accounts.serialize(accountList)
    accountsWriter.command = [pluginDir + "/scripts/config-store.sh", "accounts.json"]
    accountsWriter.running = true
  }

  function applyAccounts(raw) {
    var loaded = Accounts.load(raw)
    // First run, or an install that predates several accounts: one nameless
    // row so the existing credentials file still has somewhere to live.
    if (Accounts.count(loaded) === 0)
      loaded = Accounts.add(loaded, ({ email: "", clientId: "", clientSecret: "" }))
    // Reading back our own write must change nothing. The list is watched so
    // that an edit from outside is picked up, but every save triggers that
    // watch — and reassigning the list re-derives every account's id, which
    // resets its cache and its session. That is what made adding a mailbox
    // flicker through several states: the window was rebuilding every account
    // each time the file it had just written landed back.
    if (accountsLoaded && Accounts.serialize(loaded) === Accounts.serialize(accountList))
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
  property bool windowPrefsLoaded: false
  property string windowWritePayload: ""

  function applyWindowPrefs(raw) {
    var parsed = null
    try { parsed = JSON.parse(String(raw || "")) } catch (e) { parsed = null }
    if (parsed && typeof parsed === "object")
      sidebarCollapsed = parsed.sidebarCollapsed === true
    windowPrefsLoaded = true
  }

  function saveWindowPrefs() {
    if (!windowPrefsLoaded || windowWriter.running) return
    windowWritePayload = JSON.stringify({ sidebarCollapsed: sidebarCollapsed })
    windowWriter.command = [pluginDir + "/scripts/config-store.sh", "window.json"]
    windowWriter.running = true
  }

  function setSidebarCollapsed(value) {
    var next = value === true
    if (next === sidebarCollapsed) return
    sidebarCollapsed = next
    saveWindowPrefs()
  }
  signal duplicateAccount(string email)

  // ------------------------------------------------------------ aggregates

  property int unreadTotal: 0
  // Whether any mailbox at all is signed in. The first-run walkthrough keys on
  // this rather than on the mailbox in view: once one account works, a second
  // one that has not signed in yet is a row waiting in settings, not a reason
  // to send the whole window back to the beginning.
  property bool anyAccountReady: false

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
  readonly property var accountSummaries: {
    var out = []
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      var host = accountHosts.objectAt(i)
      out.push({
        id: accounts[i].id,
        email: accounts[i].email,
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

  // ------------------------------------------------------------- forwarding

  property bool windowOpen: false
  onWindowOpenChanged: if (current) current.windowOpen = windowOpen

  readonly property var auth: current ? current.auth : null
  readonly property bool ready: !!current && current.ready
  readonly property string accountEmail: current ? current.accountEmail : ""
  readonly property int inboxUnread: current ? current.inboxUnread : 0
  readonly property var messages: current ? current.messages : []
  readonly property var labels: current ? current.labels : []
  readonly property string mailboxKey: current ? current.mailboxKey : "inbox"
  readonly property string searchQuery: current ? current.searchQuery : ""
  readonly property bool listLoading: !!current && current.listLoading
  readonly property bool listLoaded: !!current && current.listLoaded
  readonly property bool hasMore: !!current && current.hasMore
  readonly property string resultSummary: current ? current.resultSummary : ""
  readonly property string selectedId: current ? current.selectedId : ""
  readonly property var selectedMessage: current ? current.selectedMessage : null
  readonly property var selectedBody: current ? current.selectedBody : ({ text: "", source: "" })
  readonly property string selectedHtml: current ? current.selectedHtml : ""
  readonly property var selectedImages: current ? current.selectedImages : []
  readonly property var selectedAttachments: current ? current.selectedAttachments : []
  readonly property bool selectedTooHeavy: !!current && current.selectedTooHeavy
  readonly property bool detailLoading: !!current && current.detailLoading
  readonly property bool sending: !!current && current.sending
  readonly property string lastError: current ? current.lastError : ""
  readonly property string actionStatus: current ? current.actionStatus : ""
  readonly property string signInProgress: current ? current.signInProgress : ""
  readonly property string syncedLabel: current ? current.syncedLabel : ""

  function refresh() { if (current) current.refresh() }
  function loadMore() { if (current) current.loadMore() }
  function select(id) { if (current) current.select(id) }
  function clearSelection() { if (current) current.clearSelection() }
  function selectOffset(delta) { return current ? current.selectOffset(delta) : "" }
  function selectMailbox(key) { if (current) current.selectMailbox(key) }
  function search(text) { if (current) current.search(text) }
  function act(id, action, quiet) { if (current) current.act(id, action, quiet) }
  function toggleStar(id) { if (current) current.toggleStar(id) }
  function markAllRead() { if (current) current.markAllRead() }
  function send(fields) { if (current) current.send(fields) }
  function signIn() { if (current) current.signIn() }
  function cancelSignIn() { if (current) current.cancelSignIn() }
  function signOut() { if (current) current.signOut() }
  function openInBrowser(id) { if (current) current.openInBrowser(id) }
  function openWebInbox() { if (current) current.openWebInbox() }
  function openCloudConsole() { if (current) current.openCloudConsole() }
  function openGmailApiPage() { if (current) current.openGmailApiPage() }

  // Not forwarded to an account: the project exists whether or not anyone has
  // signed in, and the menu offers it on the setup page too.
  function openProjectPage() {
    Quickshell.execDetached(["xdg-open", "https://github.com/huacnlee/omamail"])
  }
  function openConsentScreen() { if (current) current.openConsentScreen() }

  signal replySent()

  // ------------------------------------------------------------- instances

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
      mayAdoptLegacyToken: index === 0
      settings: root.settings

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
}
