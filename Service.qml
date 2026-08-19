import QtQuick
import Quickshell

import "Cache.js" as Cache
import "Html.js" as Html
import "GmailApi.js" as Api
import "Message.js" as Mail
import "Model.js" as Model
import "OAuth.js" as OAuth

// Everything the panel knows about the mailbox. The views read properties and
// call functions here; nothing in components/ talks to Google directly.
//
// Two rhythms drive the state:
//   - a slow unread poll that runs whether or not the panel is open, because
//     the bar badge is the whole point of a mail widget
//   - a list refresh that only runs while the panel is open, or right after an
//     action, because a message list nobody is looking at is wasted quota
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
    ? String(manifest.id) : "gmail.omarchy"
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

  // The window drives this; the unread poll keeps running while it is false.
  property bool windowOpen: false

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // Reassigning the whole object is what makes the readonly settings below
  // re-evaluate. Mutating it in place would not.
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

  readonly property int refreshIntervalSec: Math.max(30, Math.min(3600,
    Math.floor(Number(setting("refreshIntervalSec", 120))) || 120))
  readonly property int maxMessages: Math.max(5, Math.min(100,
    Math.floor(Number(setting("maxMessages", 25))) || 25))
  readonly property string defaultQuery: String(setting("defaultQuery", "in:inbox")).trim()
  readonly property bool notifyNewMail: String(setting("notifyNewMail", "On")) !== "Off"
  readonly property int oauthPort: OAuth.normalizedPort(setting("oauthPort", OAuth.DEFAULT_PORT))

  readonly property alias auth: authManager
  readonly property alias api: apiClient
  readonly property alias cache: cacheStore

  // What the cache is keyed on. The page size is part of it: the same query at
  // a different size is a different result set, not a stale one.
  readonly property string cacheKey: Cache.queryKey(effectiveQuery, maxMessages)

  // ------------------------------------------------------------ mailbox

  property string mailboxKey: "inbox"
  property string searchQuery: ""
  property var messages: []
  property var labels: []
  property string nextPageToken: ""
  property int resultEstimate: 0
  property bool listLoading: false
  property bool listLoaded: false
  property var listHandle: null
  property int listSerial: 0

  property string selectedId: ""
  property var selectedMessage: null
  property var selectedBody: ({ text: "", source: "" })
  // Already sanitised by the time the reader sees it. Decoding uses Qt.atob
  // where it exists, which is native and skips the per-character base64 loop
  // that made this the one expensive step in opening a message.
  property string selectedHtml: ""
  property int selectedBlockedImages: 0
  property bool selectedTooHeavy: false
  property var selectedAttachments: []
  property bool detailLoading: false
  property var detailHandle: null
  property int detailSerial: 0

  property var profile: null
  readonly property string accountEmail: profile ? String(profile.email || "") : ""
  property int inboxUnread: 0
  property bool countLoading: false

  property string lastError: ""
  property string actionStatus: ""
  property string pendingAction: ""
  property bool sending: false

  // Notifications only start once the first successful load has established
  // what was already there.
  property var seenIds: ({})
  property bool notificationsPrimed: false
  // Mail that arrived since the list was last looked at. The bar shows a dot
  // for this and nothing else — an unread count that never reaches zero is a
  // permanent red mark, which stops meaning anything.
  property bool newMailPending: false

  readonly property string setupState: Model.setupState({
    toolsPresent: authManager.toolsPresent || !authManager.toolsChecked,
    credentialsPresent: authManager.credentialsPresent,
    signingIn: authManager.loginBusy,
    signedIn: authManager.loggedIn
  })
  readonly property bool ready: setupState === "ready"
  readonly property bool busy: listLoading || detailLoading || countLoading
    || authManager.sessionBusy || sending || pendingAction !== ""
  readonly property string effectiveQuery: searchQuery.trim() !== ""
    ? searchQuery.trim()
    : (mailboxKey === "inbox" && defaultQuery !== "" ? defaultQuery : Model.mailbox(mailboxKey).query)
  readonly property bool hasMore: nextPageToken !== ""
  readonly property string resultSummary: Model.resultSummary(messages, resultEstimate, hasMore)
  readonly property string barTooltip: Model.barTooltip(setupState, accountEmail, inboxUnread)

  // The sign-in has three waits that look identical from outside: the helper
  // script, the browser, and Google's token endpoint. Naming which one is
  // happening is the difference between "it is working" and "it is stuck".
  readonly property string signInProgress: {
    if (!authManager.toolsChecked) return "Checking for socat and secret-tool…"
    if (!authManager.credentialsPresent) return ""
    if (authManager.loginBusy) return "Finish the sign-in in your browser…"
    if (authManager.sessionBusy) return "Restoring the saved session…"
    return ""
  }

  signal listRefreshed()

  function clearNotice() {
    lastError = ""
    actionStatus = ""
  }

  function note(text) {
    actionStatus = String(text || "")
    if (actionStatus !== "") noticeTimer.restart()
  }

  function fail(text) {
    lastError = String(text || "")
    actionStatus = ""
  }

  // ------------------------------------------------------------- loading

  function refresh() {
    if (!ready) return
    refreshCounts()
    if (windowOpen || !listLoaded) loadMessages(false)
  }

  function refreshCounts() {
    if (!ready || countLoading) return
    countLoading = true
    apiClient.getLabelCounts("INBOX", function(counts, error) {
      root.countLoading = false
      if (error || !counts) return
      root.inboxUnread = counts.unread
    })
  }

  function loadProfile() {
    if (!ready || profile) return
    if (cacheStore.loaded && cacheStore.store.profile) profile = cacheStore.store.profile
    apiClient.getProfile(function(result, error) {
      if (error || !result) return
      root.profile = result
      // A cache belongs to one mailbox. Binding the address here is what stops
      // one account's mail from appearing under another's name.
      cacheStore.bindAccount(result.email)
      cacheStore.putProfile(result)
    })
  }

  function loadLabels() {
    if (!ready) return
    if (cacheStore.loaded && cacheStore.store.labels.length > 0 && labels.length === 0)
      labels = cacheStore.store.labels
    apiClient.getLabels(function(result, error) {
      if (error) return
      root.labels = result
      cacheStore.putLabels(result)
    })
  }

  // Paints whatever the last visit to this query left behind. Switching
  // mailboxes should never show an empty column while the network decides.
  function paintFromCache() {
    if (!cacheStore.loaded) return false
    var entry = cacheStore.get(cacheKey)
    if (!entry || !entry.summaries || entry.summaries.length === 0) return false

    var now = new Date()
    var restored = Cache.hydrate(entry.summaries)
    for (var i = 0; i < restored.length; i++)
      restored[i].time = Mail.relativeTime(restored[i].date, now)

    messages = restored
    resultEstimate = entry.estimate
    nextPageToken = entry.nextPageToken
    listLoaded = true
    lastError = ""

    // Cached rows count as already seen, so the first live load does not
    // announce a mailbox the user has been looking at all along.
    var seen = {}
    for (var key in seenIds) seen[key] = true
    for (var j = 0; j < restored.length; j++) seen[restored[j].id] = true
    seenIds = seen
    // The cache is also a record of what was on screen last time, so a live
    // load on top of it can tell genuinely new mail from a first look.
    notificationsPrimed = true
    listRefreshed()
    return true
  }

  function loadMessages(append) {
    if (!ready) return
    var serial = ++listSerial
    apiClient.abortRequest(listHandle)
    if (!append) {
      // Cache first: paint, then revalidate. The page tokens and the estimate
      // come back with the live answer.
      if (!paintFromCache()) {
        nextPageToken = ""
        resultEstimate = 0
      }
    }
    listLoading = true
    var token = append ? nextPageToken : ""

    listHandle = apiClient.listMessages(effectiveQuery, maxMessages, token,
      function(page, error) {
        if (serial !== root.listSerial) return
        if (error || !page) {
          root.listLoading = false
          root.fail(error || "Gmail returned nothing")
          return
        }
        root.resultEstimate = page.estimate
        root.nextPageToken = page.nextPageToken
        if (page.ids.length === 0) {
          root.listLoading = false
          root.listLoaded = true
          if (!append) root.messages = []
          root.lastError = ""
          root.listRefreshed()
          return
        }
        root.fetchSummaries(page.ids, append, serial)
      })
  }

  function fetchSummaries(ids, append, serial) {
    apiClient.getMessages(ids, false, function(payloads, error) {
      if (serial !== root.listSerial) return
      root.listLoading = false
      if (error && payloads.length === 0) {
        root.fail(error)
        return
      }
      var now = new Date()
      var summaries = []
      for (var i = 0; i < payloads.length; i++) summaries.push(Mail.summarize(payloads[i], now))
      root.applySummaries(summaries, append)
      if (!append) cacheStore.putQuery(root.cacheKey, ({
        summaries: summaries,
        estimate: root.resultEstimate,
        nextPageToken: root.nextPageToken
      }))
    }, listHandle)
  }

  function applySummaries(summaries, append) {
    var merged = append ? root.messages.concat(summaries) : summaries
    var arrivals = append ? [] : Model.newArrivals(summaries, seenIds, notificationsPrimed)

    var seen = {}
    for (var i = 0; i < merged.length; i++) seen[merged[i].id] = true
    // Ids already seen are kept so a message that scrolls off the first page
    // does not get announced again when it comes back.
    for (var key in seenIds) seen[key] = true
    seenIds = seen
    notificationsPrimed = true

    messages = merged
    listLoaded = true
    lastError = ""
    listRefreshed()

    // Looking at the list is what marks it seen.
    if (windowOpen) newMailPending = false
    else if (arrivals.length > 0) newMailPending = true

    if (notifyNewMail && arrivals.length > 0) notify(arrivals)
  }

  function loadMore() {
    if (!hasMore || listLoading) return
    loadMessages(true)
  }

  // --------------------------------------------------------------- detail

  function select(id) {
    var messageId = String(id || "")
    if (messageId === "") {
      clearSelection()
      return
    }
    selectedId = messageId
    var serial = ++detailSerial
    apiClient.abortRequest(detailHandle)
    selectedMessage = null
    selectedBody = { text: "", source: "" }
    selectedHtml = ""
    selectedAttachments = []
    detailLoading = true

    // A message that has been opened before opens instantly; the live copy
    // replaces it a moment later.
    var cached = cacheStore.body(messageId)
    if (cached) {
      // The body is already decoded here, so sanitising it costs a fraction
      // of a millisecond — worth doing inline to paint in the same frame.
      var ready = Html.sanitize(cached.html, ({ allowRemoteImages: true }))
      selectedBody = { text: cached.text, source: cached.source }
      selectedHtml = ready.html
      selectedBlockedImages = ready.blockedImages
      selectedTooHeavy = Html.tooHeavyForRichText(ready.html)
      selectedAttachments = cached.attachments
    }

    detailHandle = apiClient.getMessage(messageId, true, function(payload, error) {
      if (serial !== root.detailSerial) return
      root.detailLoading = false
      if (error || !payload) {
        root.fail(error || "Could not open that message")
        return
      }
      var summary = Mail.summarize(payload, new Date())
      root.selectedMessage = summary
      var decoded = Mail.extractBody(payload.payload)
      var ready = Html.sanitize(Mail.extractHtml(payload.payload),
        ({ allowRemoteImages: true }))
      root.selectedBody = decoded
      root.selectedHtml = ready.html
      root.selectedBlockedImages = ready.blockedImages
      root.selectedTooHeavy = Html.tooHeavyForRichText(ready.html)
      root.selectedAttachments = Mail.attachments(payload.payload)
      cacheStore.putBody(messageId, ({
        text: decoded.text,
        source: decoded.source,
        html: ready.html,
        attachments: root.selectedAttachments
      }))
      root.messages = Model.replaceById(root.messages, summary)
      // Opening a message is the one place Gmail's own clients mark it read
      // without being asked, and a reader that leaves it bold is confusing.
      if (summary.unread) root.act(messageId, "markRead", true)
    })
  }

  function clearSelection() {
    detailSerial++
    apiClient.abortRequest(detailHandle)
    detailHandle = null
    selectedId = ""
    selectedMessage = null
    selectedBody = { text: "", source: "" }
    selectedHtml = ""
    selectedBlockedImages = 0
    selectedTooHeavy = false
    selectedAttachments = []
    detailLoading = false
  }

  function selectOffset(delta) {
    if (messages.length === 0) return ""
    var index = Model.indexById(messages, selectedId)
    var next = index < 0 ? 0 : index + Math.floor(Number(delta) || 0)
    if (next < 0) next = 0
    if (next > messages.length - 1) next = messages.length - 1
    return messages[next].id
  }

  // -------------------------------------------------------------- actions

  // Every action moves the list immediately and reconciles afterwards. Waiting
  // for Google before the row moves makes the panel feel broken on a slow
  // connection, and the failure path puts the row back.
  function act(id, action, quiet) {
    var messageId = String(id || "")
    if (!ready || messageId === "") return
    var index = Model.indexById(messages, messageId)
    if (index < 0) return
    var before = messages[index]
    var updated = Model.applyLabelChange(before, action)
    var survives = Model.survivesAction(mailboxKey, action)

    if (action === "markRead" && before.unread) inboxUnread = Math.max(0, inboxUnread - 1)
    if (action === "markUnread" && !before.unread) inboxUnread = inboxUnread + 1

    if (survives) messages = Model.replaceById(messages, updated)
    else messages = Model.removeById(messages, messageId)
    if (selectedId === messageId) {
      if (survives) selectedMessage = updated
      else clearSelection()
    }

    function restore(error) {
      root.messages = survives
        ? Model.replaceById(root.messages, before)
        : root.messages.slice(0, index).concat([before], root.messages.slice(index))
      root.refreshCounts()
      root.fail(error)
    }

    pendingAction = action
    var done = function(payload, error) {
      root.pendingAction = ""
      if (error) {
        restore(error)
        return
      }
      if (!quiet) root.note(root.actionLabel(action))
      root.refreshCounts()
    }

    if (action === "trash") apiClient.trashMessage(messageId, done)
    else if (action === "untrash") apiClient.untrashMessage(messageId, done)
    else {
      var change = Model.labelChangesFor(action)
      if (!change) {
        pendingAction = ""
        return
      }
      apiClient.modifyMessage(messageId, change.add, change.remove, done)
    }
  }

  function actionLabel(action) {
    if (action === "archive") return "Archived"
    if (action === "trash") return "Moved to trash"
    if (action === "untrash") return "Restored"
    if (action === "star") return "Starred"
    if (action === "unstar") return "Unstarred"
    if (action === "markRead") return "Marked read"
    if (action === "markUnread") return "Marked unread"
    if (action === "spam") return "Reported as spam"
    return "Done"
  }

  function toggleStar(id) {
    var index = Model.indexById(messages, id)
    if (index < 0) return
    act(id, messages[index].starred ? "unstar" : "star")
  }

  function toggleRead(id) {
    var index = Model.indexById(messages, id)
    if (index < 0) return
    act(id, messages[index].unread ? "markRead" : "markUnread")
  }

  function markAllRead() {
    if (!ready || messages.length === 0) return
    var ids = []
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].unread) ids.push(messages[i].id)
    }
    if (ids.length === 0) return
    var before = messages.slice()
    var next = []
    for (var j = 0; j < messages.length; j++) next.push(Model.applyLabelChange(messages[j], "markRead"))
    messages = Model.survivesAction(mailboxKey, "markRead") ? next : []
    pendingAction = "markRead"
    apiClient.batchModify(ids, [], ["UNREAD"], function(payload, error) {
      root.pendingAction = ""
      if (error) {
        root.messages = before
        root.fail(error)
        return
      }
      root.note(Model.pluralize(ids.length, "message") + " marked read")
      root.refreshCounts()
    })
  }

  // ---------------------------------------------------------------- reply

  // One entry point for every kind of outgoing message. Reply, reply-all and
  // forward differ only in what the compose window puts in the fields, which
  // is where that decision belongs.
  function send(fields) {
    if (!ready || sending) return
    var values = fields || ({})
    var body = String(values.body || "").trim()
    if (body === "") {
      fail("Write something before sending")
      return
    }
    var to = String(values.to || "").trim()
    if (to === "") {
      fail("Add a recipient first")
      return
    }
    sending = true
    apiClient.sendMessage(Mail.buildSendPayload({
      to: to,
      cc: String(values.cc || "").trim(),
      subject: String(values.subject || ""),
      body: body,
      threadId: values.threadId,
      inReplyTo: values.inReplyTo,
      references: values.references
    }), function(payload, error) {
      root.sending = false
      if (error) {
        root.fail(error)
        return
      }
      root.note("Sent")
      root.replySent()
    })
  }

  signal replySent()

  // -------------------------------------------------------- notifications

  function notify(arrivals) {
    var list = Array.isArray(arrivals) ? arrivals : []
    if (list.length === 0) return
    if (list.length === 1) {
      Quickshell.execDetached(["notify-send", "-a", "Omarchy Gmail",
        "-i", "mail-unread", list[0].from.display, Model.notificationBody(list[0])])
      return
    }
    // One notification per message turns a batch sync into a wall of popups.
    var names = []
    for (var i = 0; i < list.length && i < 3; i++) names.push(list[i].from.display)
    Quickshell.execDetached(["notify-send", "-a", "Omarchy Gmail",
      "-i", "mail-unread", Model.pluralize(list.length, "new message"), names.join(", ")])
  }

  // ------------------------------------------------------------ navigation

  function selectMailbox(key) {
    if (mailboxKey === key && searchQuery === "") return
    mailboxKey = String(key || "inbox")
    searchQuery = ""
    clearSelection()
    messages = []
    listLoaded = false
    loadMessages(false)
  }

  function search(text) {
    var query = String(text || "").trim()
    if (query === searchQuery) return
    searchQuery = query
    clearSelection()
    messages = []
    listLoaded = false
    loadMessages(false)
  }

  function openInBrowser(id) {
    Quickshell.execDetached(["xdg-open", Api.webMessageUrl(id, 0)])
  }

  function openWebInbox() {
    Quickshell.execDetached(["xdg-open", Api.webSearchUrl(effectiveQuery, 0)])
  }

  function openCloudConsole() {
    Quickshell.execDetached(["xdg-open", "https://console.cloud.google.com/auth/clients/create"])
  }

  function openConsentScreen() {
    Quickshell.execDetached(["xdg-open", "https://console.cloud.google.com/auth/overview"])
  }

  function openGmailApiPage() {
    Quickshell.execDetached(["xdg-open",
      "https://console.cloud.google.com/apis/library/gmail.googleapis.com"])
  }

  function signIn() { authManager.beginLogin() }
  function cancelSignIn() { authManager.cancelLogin() }

  function signOut() {
    authManager.logout()
    messages = []
    labels = []
    profile = null
    inboxUnread = 0
    listLoaded = false
    seenIds = ({})
    notificationsPrimed = false
    newMailPending = false
    cacheStore.clear()
    clearSelection()
  }

  // ------------------------------------------------------------- lifecycle

  onWindowOpenChanged: {
    if (!windowOpen) return
    newMailPending = false
    clearNotice()
    if (!ready) return
    loadProfile()
    if (!listLoaded) loadMessages(false)
    else refresh()
  }

  onReadyChanged: {
    if (!ready) return
    loadProfile()
    loadLabels()
    refreshCounts()
    if (windowOpen && !listLoaded) loadMessages(false)
  }

  AuthManager {
    id: authManager
    pluginDir: root.pluginDir
    oauthPort: root.oauthPort
    loginHint: root.accountEmail

    onLoginSucceeded: {
      root.lastError = authManager.lastError
      root.loadProfile()
      root.loadLabels()
      root.refreshCounts()
      root.loadMessages(false)
    }
    onLoggedOut: root.clearNotice()
    onCredentialsSaved: root.note("OAuth client saved")
    onSessionUnavailable: function(reason) { root.fail(reason) }
  }

  GmailApiClient {
    id: apiClient
    auth: authManager
  }

  CacheStore {
    id: cacheStore
    // The file lands after the window is already up, so the first paint waits
    // for it rather than the other way round.
    onRestored: {
      if (!root.profile && store.profile) root.profile = store.profile
      if (root.labels.length === 0 && store.labels.length > 0) root.labels = store.labels
      if (root.messages.length === 0) root.paintFromCache()
    }
  }

  Component.onCompleted: authManager.restoreSession()

  Timer {
    id: noticeTimer
    interval: 4000
    onTriggered: root.actionStatus = ""
  }

  // The unread count is one label read — cheap enough to keep running while
  // the panel is closed, which is the only way the bar badge stays honest.
  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    running: root.ready
    repeat: true
    triggeredOnStart: true
    onTriggered: {
      root.refreshCounts()
      if (root.windowOpen) root.loadMessages(false)
      // A new message while the panel is closed still has to reach the
      // notification path, so the list is refreshed on the unread count going
      // up rather than on a second timer.
      else if (root.notifyNewMail && root.inboxUnread > Model.unreadCount(root.messages))
        root.loadMessages(false)
    }
  }
}
