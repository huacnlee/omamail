import QtQuick
import Quickshell

import "Cache.js" as Cache
import "Html.js" as Html
import "GmailApi.js" as Api
import "Message.js" as Mail
import "Model.js" as Model
import "OAuth.js" as OAuth

// One mailbox: its sign-in, its cache, its messages. Service.qml owns a set of
// these and puts whichever is on screen in front of the views.
//
// Three rhythms drive the state:
//   - an unread poll that runs for every account, open window or not, because a
//     bar badge that only speaks for the mailbox you are looking at is worse
//     than no badge
//   - a list refresh for the account on screen, or right after an action
//   - nothing at all for the rest: a message list nobody can see is wasted
//     quota, and the cache means switching to it still paints instantly
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir

  // Which mailbox this is, and whether it is the one on screen. An inactive
  // account still counts its unread mail; it just does not fetch lists or
  // bodies nobody can see.
  property string accountId: ""
  // Only the mailbox that predates multi-account may claim the old
  // client-keyed refresh token. See AuthManager.mayAdoptLegacyToken.
  property bool mayAdoptLegacyToken: true
  property bool active: false

  // Pushed down from the container, which is where the bar widget's settings
  // arrive. Kept as defaults here so an account is usable before that happens.
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
  // The sender's own HTML, exactly as Gmail handed it over. This is what the
  // body cache holds and what `selectedHtml` is derived from — so asking for the
  // images is a re-render rather than another trip to Gmail, and a sanitiser
  // that learns something new applies it to every message already on disk
  // rather than only to the ones fetched afterwards.
  property string sourceHtml: ""
  // Off for every message, every time it is opened. Fetching a sender's images
  // tells them the mail was read, from which address and when, so it happens
  // only when the reader has asked — and asking covers this message alone.
  property bool remoteImagesAllowed: false
  // The sender's images, in the order htmlToText numbers them, so a marker in
  // the plain-text body can be traced back to the picture it replaced.
  property var selectedImages: []
  property int selectedBlockedImages: 0
  // How many of the blocked ones asking would actually bring back. A message
  // whose only images are beacons or point at the local network has nothing to
  // offer, so the reader says nothing.
  property int selectedRemoteImages: 0
  property bool selectedTooHeavy: false
  property var selectedAttachments: []
  property bool detailLoading: false
  // Set once Gmail's own copy has landed, so a slower cache read knows not to
  // paint over it.
  property bool detailLive: false
  property var detailHandle: null
  property int detailSerial: 0

  property var profile: null
  readonly property string accountEmail: profile ? String(profile.email || "") : ""
  property int inboxUnread: 0
  property bool countLoading: false

  // When the list last agreed with the server. Ticked separately so the label
  // ages without anything else re-evaluating.
  property double lastSyncedMs: 0
  property int syncTick: 0
  readonly property string syncedLabel: {
    var ignored = syncTick
    if (listLoading) return "Checking for mail…"
    if (lastSyncedMs <= 0) return ""
    var ago = Mail.relativeTime(new Date(lastSyncedMs), new Date())
    return ago === "now" ? "Synced just now" : "Synced " + ago + " ago"
  }

  property string lastError: ""
  property string actionStatus: ""
  property string pendingAction: ""
  property bool sending: false

  // Notifications only start once the first successful load has established
  // what was already there.
  property var seenIds: ({})
  property bool notificationsPrimed: false
  // The unread count needs a baseline of its own, separate from the message
  // cache: a mailbox that has never been opened has no cached page to prime
  // from, and would otherwise never be allowed to announce anything.
  property bool countPrimed: false
  // Mail that arrived since the list was last looked at. The bar shows a dot
  // for this and nothing else — an unread count that never reaches zero is a
  // permanent red mark, which stops meaning anything.

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
    if (active && (windowOpen || !listLoaded)) loadMessages(false)
  }

  function refreshCounts() {
    if (!ready || countLoading) return
    countLoading = true
    // Counted with the same query the Unread mailbox uses, not from the INBOX
    // label. The label counts every categorised message too, which is how this
    // reached 2483 on a real account — a number that is never zero, can only be
    // reported as "999+", and cannot tell anyone whether something is waiting.
    apiClient.listMessages(Model.mailbox("unread").query, 1, "", function(page, error) {
      root.countLoading = false
      if (error || !page) return
      var before = root.inboxUnread
      root.inboxUnread = page.estimate

      // A mailbox that gains unread mail earns a look, whether or not it is the
      // one on screen. The badge and the notification are both raised from a
      // list load, and only the active account ever performed one — so mail
      // arriving in any other mailbox went unannounced entirely, and mail
      // arriving in this one while the window was shut relied on comparing the
      // total against a single page rather than on the count actually moving.
      //
      // The first read of a session has no previous count to compare against,
      // but the cache does know which messages were already on screen — so it
      // loads once and lets the arrival check decide. Treating that first read
      // as nothing but a baseline made every shell restart a blind spot: mail
      // that landed while the shell was down would sit inside the new baseline
      // and never be announced at all. An account with no cache still says
      // nothing, because there is nothing to compare against.
      var first = !root.countPrimed
      root.countPrimed = true
      if ((first || page.estimate > before) && !root.listLoading)
        root.loadMessages(false)
    })
  }

  function loadProfile() {
    if (!ready || profile) return
    if (cacheStore.loaded && cacheStore.store.profile) profile = cacheStore.store.profile
    apiClient.getProfile(function(result, error) {
      if (error || !result) return
      // The shell can tear this account down — a reload, a removed account —
      // while the request is still in the air. The object outlives its methods
      // for a moment, so the reply has to check before it uses them.
      if (typeof cacheStore.bindAccount !== "function") return
      root.profile = result
      if (result.email !== "") root.accountIdentified(result.email)
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
          if (!append) {
            root.messages = []
            // An empty answer is an answer, and it has to reach the cache. Only
            // a non-empty result was ever written back, so a mailbox that had
            // emptied kept its old rows on disk — and cache-first painted them
            // again on every visit before the live load wiped them a moment
            // later. Reading mail elsewhere made Unread do exactly that.
            cacheStore.putQuery(root.cacheKey, ({
              summaries: [],
              estimate: root.resultEstimate,
              nextPageToken: root.nextPageToken
            }))
          }
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
    lastSyncedMs = Date.now()
    listRefreshed()

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
    sourceHtml = ""
    remoteImagesAllowed = false
    selectedBlockedImages = 0
    selectedRemoteImages = 0
    selectedImages = []
    selectedAttachments = []
    detailLoading = true

    // A message that has been opened before opens from its file, usually well
    // before Gmail answers. The read is asynchronous, so the live copy can win
    // the race — in which case the cached one is simply dropped rather than
    // painted over what is already correct.
    detailLive = false
    bodyCache.read(messageId, function(cached) {
      if (serial !== root.detailSerial) return
      if (root.detailLive || !cached) return
      root.selectedBody = { text: cached.text, source: cached.source }
      root.renderSource(cached.html)
      root.selectedAttachments = cached.attachments
      root.selectedImages = cached.images
      bodyCache.touch(messageId)
    })

    detailHandle = apiClient.getMessage(messageId, true, function(payload, error) {
      if (serial !== root.detailSerial) return
      root.detailLoading = false
      root.detailLive = true
      if (error || !payload) {
        root.fail(error || "Could not open that message")
        return
      }
      var summary = Mail.summarize(payload, new Date())
      root.selectedMessage = summary
      var decoded = Mail.extractBody(payload.payload)
      var rawHtml = Mail.extractHtml(payload.payload)
      // Both readings of the body out of one parse. The markers in the
      // plain-text one and the pictures they stand for are numbered by the same
      // walk over the same tree, so a marker cannot open somebody else's image
      // — and it is only asked for when the text came from the HTML, because a
      // message that shipped its own text/plain part never had images in it.
      var ready = root.renderSource(rawHtml, decoded.source === "html")
      if (ready.plainText) decoded = ({ text: ready.plainText.text, source: "html" })
      root.selectedBody = decoded
      root.selectedAttachments = Mail.attachments(payload.payload)
      root.selectedImages = ready.plainText ? ready.plainText.images : []
      bodyCache.put(messageId, ({
        text: decoded.text,
        source: decoded.source,
        html: rawHtml,
        attachments: root.selectedAttachments,
        images: root.selectedImages
      }))
      root.messages = Model.replaceById(root.messages, summary)
      // Opening a message is the one place Gmail's own clients mark it read
      // without being asked, and a reader that leaves it bold is confusing.
      if (summary.unread) root.act(messageId, "markRead", true)
    })
  }

  // The one place `selectedHtml` is set, and the only place the sender's markup
  // is parsed on the way to the screen. Everything else the reader needs to
  // know about this body comes back from the same call — how heavy it is, and
  // its plain-text reading — because each of those asked separately is another
  // parse of the whole message to work out what was just worked out.
  function renderSource(source, withPlainText) {
    sourceHtml = String(source || "")
    var ready = Html.sanitize(sourceHtml, ({
      allowRemoteImages: remoteImagesAllowed,
      withPlainText: withPlainText === true
    }))
    selectedHtml = ready.html
    selectedBlockedImages = ready.blockedImages
    selectedRemoteImages = ready.remoteImages
    selectedTooHeavy = ready.tooHeavy
    return ready
  }

  function showRemoteImages() {
    if (remoteImagesAllowed || sourceHtml === "") return
    remoteImagesAllowed = true
    renderSource(sourceHtml)
  }

  function clearSelection() {
    detailSerial++
    apiClient.abortRequest(detailHandle)
    detailHandle = null
    selectedId = ""
    selectedMessage = null
    selectedBody = { text: "", source: "" }
    selectedHtml = ""
    sourceHtml = ""
    remoteImagesAllowed = false
    selectedImages = []
    selectedBlockedImages = 0
    selectedRemoteImages = 0
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

    // An action the user did not ask for must never move them. Opening an
    // unread message marks it read, and being read is the very thing that
    // disqualifies it from the unread list — so evicting it there would close
    // the reader that the click had just opened. The row stays until the list
    // is next loaded, which is also what Gmail's own clients do.
    var keepOpen = quiet === true && selectedId === messageId
    var removed = !survives && !keepOpen

    if (removed) messages = Model.removeById(messages, messageId)
    else messages = Model.replaceById(messages, updated)
    if (selectedId === messageId) {
      if (removed) clearSelection()
      else selectedMessage = updated
    }

    function restore(error) {
      root.messages = removed
        ? root.messages.slice(0, index).concat([before], root.messages.slice(index))
        : Model.replaceById(root.messages, before)
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
    // "--" before the summary and body: both are written by whoever sent the
    // mail, and a display name of "-u" would otherwise be read by notify-send
    // as an option rather than as a name.
    if (list.length === 1) {
      Quickshell.execDetached(["notify-send", "-a", "Omamail", "-i", "mail-unread",
        "--", Model.notificationTitle(list[0]), Model.notificationBody(list[0])])
      return
    }
    // One notification per message turns a batch sync into a wall of popups.
    var names = []
    for (var i = 0; i < list.length && i < 3; i++) names.push(Model.notificationTitle(list[i]))
    Quickshell.execDetached(["notify-send", "-a", "Omamail", "-i", "mail-unread",
      "--", Model.pluralize(list.length, "new message"), names.join(", ")])
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
    countPrimed = false
    cacheStore.clear()
    bodyCache.clear()
    clearSelection()
  }

  // ------------------------------------------------------------- lifecycle

  onWindowOpenChanged: {
    if (!windowOpen) return
    clearNotice()
    if (!ready) return
    loadProfile()
    if (!listLoaded) loadMessages(false)
    else refresh()
  }

  onReadyChanged: {
    if (!ready) return
    loadProfile()
    refreshCounts()
    if (!active) return
    loadLabels()
    if (windowOpen && !listLoaded) loadMessages(false)
  }

  // Becoming the account on screen is what earns a list.
  onActiveChanged: {
    if (!active || !ready) return
    loadLabels()
    if (!listLoaded) loadMessages(false)
    else refresh()
  }

  // The address is only known after the first profile read, and it is what the
  // cache file and the keyring entry are named after.
  onAccountEmailChanged: {
    if (accountEmail !== "" && accountId === "") accountId = accountEmail
  }

  signal accountIdentified(string email)

  AuthManager {
    id: authManager
    pluginDir: root.pluginDir
    accountId: root.accountId
    mayAdoptLegacyToken: root.mayAdoptLegacyToken
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
    accountId: root.accountId
    // The file lands after the window is already up, so the first paint waits
    // for it rather than the other way round.
    onRestored: {
      if (!root.profile && store.profile) root.profile = store.profile
      if (root.labels.length === 0 && store.labels.length > 0) root.labels = store.labels
      if (root.messages.length === 0) root.paintFromCache()
    }
  }

  BodyCache {
    id: bodyCache
    pluginDir: root.pluginDir
    accountId: root.accountId
  }

  Component.onCompleted: authManager.restoreSession()

  // Only ages the "synced" label; nothing else depends on it.
  Timer {
    interval: 30000
    running: root.ready
    repeat: true
    onTriggered: root.syncTick++
  }

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
      // Every account polls its count, and refreshCounts loads the list for any
      // mailbox whose count has risen — that is what feeds the badge and the
      // notification. An open window keeps its own list current regardless.
      root.refreshCounts()
      if (root.active && root.windowOpen) root.loadMessages(false)
    }
  }
}
