import QtQuick
import Quickshell
import Quickshell.Io
import "../providers"
import "../cache"

import "../message/Html.js" as Html
import "../providers/GmailApi.js" as Api
import "../message/Message.js" as Mail
import "../message/Calendar.js" as Calendar
import "../message/Unsubscribe.js" as Unsub
import "../message/Outbox.js" as Outbox
import "Model.js" as Model
import "Accounts.js" as Accounts
import "../providers/Registry.js" as Provider
import "../providers/ImapProtocol.js" as Imap
import "../providers/OAuth.js" as OAuth

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
  property var backend: null
  property string syncFingerprint: ""
  property string configuredEmail: ""
  property string oauthClientId: ""

  // Which mailbox this is, and whether it is the one on screen. An inactive
  // account still counts its unread mail; it just does not fetch lists or
  // bodies nobody can see.
  property string accountId: ""

  // Which mail service this mailbox is. Everything provider-specific hangs off
  // this one string: which pair of objects gets built at the bottom of the
  // file, which mailboxes the sidebar offers, and what a query means.
  property string providerId: Provider.DEFAULT_ID
  // Server settings for an IMAP account, straight off the account entry. Unused
  // by the others, and normalised before anything can dial one.
  property var imapSettings: null
  // The same for a JMAP account, and the same rule: what is on the entry is
  // what a hand edit could have written, so it is normalised before anything
  // sends a credential to it.
  property var jmapSettings: null
  // Only the mailbox that predates multi-account may claim the old
  // client-keyed refresh token. See AuthManager.mayAdoptLegacyToken.
  property bool mayAdoptLegacyToken: true
  property bool active: false

  // Pushed down from the container, which is where the bar widget's settings
  // arrive. Kept as defaults here so an account is usable before that happens.
  readonly property var defaultSettingValues: ({
    refreshIntervalSec: 120,
    maxMessages: 50,
    defaultQuery: "in:inbox",
    notifyNewMail: "On",
    oauthPort: 9481,
    undoSendSeconds: 10
  })
  property var settings: defaultSettingValues

  // The window drives this; the unread poll keeps running while it is false.
  property bool windowOpen: false
  // The representation currently on screen. Reader mode needs its rebuild on
  // the first paint; the other modes let that work finish on the next turn.
  property string bodyMode: "reader"
  // Keyed by attachmentId, holding only the saves that are in flight.
  property var savingAttachmentIds: ({})

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // Reassigning the whole object is what makes the readonly settings below
  // re-evaluate. Mutating it in place would not.
  readonly property int refreshIntervalSec: Math.max(30, Math.min(3600,
    Math.floor(Number(setting("refreshIntervalSec", 120))) || 120))
  readonly property int maxMessages: Math.max(5, Math.min(100,
    Math.floor(Number(setting("maxMessages", 50))) || 50))
  readonly property string defaultQuery: String(setting("defaultQuery", "in:inbox")).trim()
  readonly property bool notifyNewMail: String(setting("notifyNewMail", "On")) !== "Off"
  readonly property int oauthPort: OAuth.normalizedPort(setting("oauthPort", OAuth.DEFAULT_PORT))
  readonly property int undoSendSeconds: Outbox.normalizeDelay(
    setting("undoSendSeconds", Outbox.DEFAULT_DELAY_SECONDS))

  // Built by the loaders at the bottom, so both are null for one frame while an
  // account switches provider. Every use guards for that rather than assuming.
  readonly property var auth: authLoader.item
  readonly property var api: apiLoader.item
  readonly property alias cache: cacheStore

  // What *this account* takes back from what its provider declares, and the
  // rail rows it has no mailbox for: two servers of one kind can differ, so the
  // provider list is a ceiling the client withdraws from. A client exposing
  // neither (Gmail, HEY, IMAP) leaves every answer at the ceiling.
  //
  // Both are null between clients and until the mailboxes are read, so the
  // ceiling is the default: a press against a mailbox since gone lands on the
  // client's own refusal at request time.
  readonly property var capabilityRefusals: api ? api.refusals : null
  readonly property var absentMailboxes: api ? api.absentMailboxes : null

  // Whether the client says the stored credential was refused. Only the
  // providers whose credential can be revoked out from under them raise it —
  // one whose client never declares it reads as false, which is what it was
  // before this existed. It is not a sign-out: the account, its server and its
  // cache are all still right, and the setup page draws the re-entry.
  readonly property bool credentialsRejected: !!api && api.credentialsRejected === true

  // The mailboxes this account has, which is a property of its provider rather
  // than of the panel. The sidebar and the tab row draw whatever is here.
  readonly property var mailboxes: Provider.mailboxes(providerId, absentMailboxes)

  // What the panel may offer for this account. A button the service cannot
  // honour is worse than a missing one: it fails after the user has committed
  // to it, with the row already moved.
  readonly property bool canArchive: Provider.can(providerId, "archive", capabilityRefusals)
  readonly property bool canReportSpam: Provider.can(providerId, "spam", capabilityRefusals)
  readonly property bool canStar: Provider.can(providerId, "star", capabilityRefusals)
  readonly property bool canMove: Provider.can(providerId, "move", capabilityRefusals)
  readonly property bool hasLabels: Provider.can(providerId, "labels")
  readonly property bool canOpenOnWeb: Provider.can(providerId, "web")
  // A different question from the one above: whether *this mailbox*, as it is
  // filtered right now, has an address in the provider's web app at all.
  readonly property bool canOpenWebInbox: Provider.can(providerId, "webBox")
  readonly property bool canSend: Provider.can(providerId, "send", capabilityRefusals)
  // Whether a row here stands for a conversation rather than for one message.
  // Not a button and not refinable per account: it decides what a row draws,
  // and grouping is a panel rule gated on the capability rather than anything a
  // client does on its own. Every provider that declares it hands back the
  // block the row draws from; the ones that do not report a count of 0 and the
  // row draws nothing new.
  readonly property bool showsConversations: Provider.can(providerId, "conversations")
  // The refined answers again, keyed by the capability names
  // `Model.actionCapability` speaks, so the hint row and the guard in `act`
  // read one answer rather than each asking the registry its own way.
  readonly property var actionCapabilities: ({
    archive: canArchive, star: canStar, spam: canReportSpam, move: canMove })
  // The key-bound actions this mailbox cannot honour, for the hint row. The
  // buttons are hidden by the three properties above; the keys are bound
  // whatever provider is open, so the row that says what the keyboard does here
  // has to be told as well.
  readonly property var unavailableActions: Model.unavailableActions(actionCapabilities)

  // What the cache is keyed on. The page size is part of it: the same query at
  // a different size is a different result set, not a stale one.
  readonly property string cacheKey: String(effectiveQuery || "").trim() + "|" + maxMessages

  // ------------------------------------------------------------ mailbox

  property string mailboxKey: "inbox"
  property string searchQuery: ""
  property string searchRaw: ""
  // A query picked from a list rather than typed: a Gmail label, an IMAP
  // folder. Kept apart from `searchQuery` because that one gets shaped into a
  // search — an IMAP folder wrapped in a TEXT search would go looking for the
  // folder's own name inside the inbox.
  property string rawQuery: ""
  // The label id behind that raw query. Gmail needs it to make "Move to"
  // remove the label supplying the current view; IMAP moves out of its source
  // folder inherently and therefore never passes this into a label change.
  property string rawLabelId: ""
  property var messages: []
  property var previewMessages: []
  property var labels: []
  property var sendAsAliases: []
  property bool sendAsLoading: false
  property bool sendAsLoaded: false
  property string nextPageToken: ""
  property int resultEstimate: 0
  property bool listLoading: false
  property bool listLoaded: false
  property var listHandle: null
  property int listSerial: 0

  property string selectedId: ""
  property var selectedMessage: null
  property var selectedBody: ({ text: "", source: "" })
  property bool selectedHasHtml: false
  property string selectedRenderRevision: ""
  // Opaque identity of a source retained and sanitised by the native reader.
  property string readerSourceKey: ""
  // Native safe trees are fitted to the current viewport without reparsing HTML.
  property var selectedDocument: null
  // The same message read a second way, off the same parse. Reading mode is a
  // document of its own rather than a restyling of the one above: the sender's
  // presentation is discarded and what the message says is rebuilt out of
  // paragraphs, headings, lists and links. Built whenever a body is, so
  // changing how a message is read costs neither a fetch nor a parse.
  property var selectedReaderDocument: null
  property bool selectedReaderTooHeavy: false
  // A message whose every word was inside a picture reads as nothing at all,
  // and the sender's own formatting is the honest answer for it.
  property bool selectedReaderEmpty: true
  // Reading mode drops beacons and everything a sender hid, so it has fewer
  // pictures to offer than the sanitised document does. The notice counts
  // what the reading on screen is missing, not what some other one would be.
  property int selectedReaderRemoteImages: 0
  // Fetching a sender's images tells them the mail was read, from which address
  // and when, so it happens only after the standing preference allows it.
  // The window's standing answer about remote images, which is where a
  // message starts. Off, and every message begins blocked and is asked about
  // one at a time.
  property bool alwaysShowImages: false
  property bool remoteImagesAllowed: false
  property bool remoteImagesLoading: false
  property var remoteImageData: ({})
  property var selectedRemoteImageSources: []
  property var imageFetchQueue: []
  property int imageFetchSerial: 0
  property var remoteImageAttempted: ({})
  property bool imageBatchDirty: false
  // Prepared remote bytes stay separate from the source body. Qt receives only
  // completed data URIs, never an address whose pending load would draw its
  // built-in broken placeholder or whose redirect could escape the URL gate.

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
  // The meeting this message carries, if it carries one. Null for nearly every
  // message, which is what makes the card cost nothing to have.
  property var selectedInvite: null
  property bool rsvpSending: false
  // What the message's own headers offer by way of getting off this list.
  property var selectedUnsubscribe: null
  property bool unsubscribing: false
  // What was actually done about this list, once something was. Non-empty is
  // also the flag that it has been: the button goes, the sentence stays, and
  // pressing it twice stops being a thing that can happen. A `note` would not
  // do — those clear themselves after a few seconds, and this is the answer to
  // a question the user may look back at the message to ask.
  property string unsubscribeDone: ""

  // ------------------------------------------------------- the conversation

  // The conversation the reader is inside, as a `thread` block, or null.
  //
  // Held rather than read off `selectedMessage` on every frame, because a
  // member opened on its own carries no block at all: a detail read is one
  // message and says nothing about the thread it belongs to. Walking the rail
  // would empty it otherwise, one stop at a time. `Conversation.threadAfterSelect`
  // is the whole rule — a member of the held conversation keeps it, anything
  // else replaces it with its own.
  property var selectedThread: null

  // Every member of a conversation whose summary is known, by message id.
  //
  // Seeded on select from the rows the list already drew and filled from the
  // server for the members it did not — a sent reply, a message a filter moved
  // to a user folder — through the client's `getSummaries`. Kept across selects
  // inside one conversation, so walking the rail re-reads nothing and a member
  // opened once is a settled stop the next time its conversation is opened.
  property var memberSummaries: ({})
  property var memberHandle: null

  // Whether the reader is looking at a mailbox at all. A typed search is a view
  // of the account and a label or folder is a mailbox the rail has no row for,
  // so in both every member says where it sits.
  readonly property bool viewingSearch: searchQuery !== "" || rawQuery !== ""
  property var conversationOrganisation: ({ showsRail: false, viewedMailboxKey: "" })
  readonly property string viewedMailboxKey: String(conversationOrganisation.viewedMailboxKey || "")
  readonly property bool showsRail: conversationOrganisation.showsRail === true
  property var conversationJobs: []
  property bool conversationBusy: false
  property int conversationSerial: 0
  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onReadyChanged() {
      if (root.backend && root.backend.ready) root.queueConversation("project", null, null, null)
      else {
        root.conversationSerial++
        root.conversationBusy = false
        root.conversationJobs = []
      }
    }
  }
  onSelectedThreadChanged: queueConversation("project", null, null, null)
  onMemberSummariesChanged: queueConversation("project", null, null, null)

  // Parsed trees are expensive and immutable after sanitize returns. Keep only
  // the recent working set in memory; the durable cache remains the sender's
  // source HTML so sanitizer fixes still apply after a restart.
  property int renderSerial: 0
  property int listLiveSerial: 0
  onAccountIdChanged: {
    clearSelection()
    conversationSerial++
    conversationBusy = false
    conversationJobs = []
    conversationOrganisation = ({ showsRail: false, viewedMailboxKey: "" })
    renderSerial++
    syncFingerprint = ""
  }

  // Which of this account's own addresses this message arrived at.
  //
  // A mailbox with aliases is invited as one of them, and the invitation's
  // ATTENDEE line names that one — so looking for the answer under the primary
  // address finds nothing, and sending one from it would be answering for
  // somebody the organiser never invited. An unsubscribe wants the same
  // address for the same reason: a list that only ever knew the alias has no
  // reason to honour a request from an address it has never seen.
  //
  // `Api.preferredSendAs` is called rather than the `preferredSendAs` method
  // beside it so that `availableSendAsAliases` is read inside this binding,
  // where the dependency is unmistakable. It falls back to the default address
  // when the message names none of them, which is the right answer for an
  // invitation that was forwarded by hand.
  readonly property var receivedAsAlias: {
    if (!selectedMessage) return null
    var addressed = (selectedMessage.to || []).concat(selectedMessage.cc || [])
    return Api.preferredSendAs(availableSendAsAliases, addressed)
  }
  readonly property string receivedAsAddress: {
    var chosen = receivedAsAlias ? String(receivedAsAlias.email || "") : ""
    return chosen !== "" ? chosen : ownAddress
  }
  readonly property string receivedAsName: receivedAsAlias
    ? String(receivedAsAlias.displayName || "") : ""

  // Read back out of the invitation rather than remembered separately. An
  // answer that is sent rewrites this account's ATTENDEE line in the copy kept
  // on disk, so the card and the file agree — see `rememberResponse`.
  readonly property string selectedResponse: selectedInvite
    ? Calendar.responseOf(selectedInvite, receivedAsAddress) : ""
  readonly property bool canRespondToInvite: !!selectedInvite && canSend
    && Calendar.canRespond(selectedInvite, receivedAsAddress)

  readonly property string unsubscribeLabel: unsubscribeDone !== "" ? ""
    : Unsub.label(selectedUnsubscribe, canSend)
  readonly property string unsubscribeDetail: unsubscribeDone !== "" ? unsubscribeDone
    : Unsub.explanation(selectedUnsubscribe, canSend)
  property bool detailLoading: false
  // Whether the reader has something to show yet, which is a different question
  // from whether a request is still in the air. A body already on disk answers
  // the first the moment it is read; the second stays true until the live read
  // lands, and the status bar is right to keep saying so.
  //
  // They were one property, and a message HEY serves no body for — its own
  // sign-up mail — showed the loading state for the whole round trip on every
  // open, because nothing ever arrived to make it stop looking empty.
  property bool detailPainted: false
  // Set once Gmail's own copy has landed, so a slower cache read knows not to
  // paint over it.
  property bool detailLive: false
  property bool detailCachedResource: false
  property var detailHandle: null
  // The invitation's own request, which only a message carrying one ever makes.
  property var inviteHandle: null
  property int detailSerial: 0

  property var profile: null
  readonly property string accountEmail: profile ? String(profile.email || "") : ""
  readonly property var availableSendAsAliases: {
    if (sendAsAliases.length > 0) return sendAsAliases
    if (accountEmail === "") return []
    return [{ email: accountEmail, displayName: "", isPrimary: true, isDefault: true }]
  }
  // The address this mailbox answers as when nothing more specific applies.
  // The profile is authoritative once it has loaded; until then the address the
  // account was configured with is what the user signed in as, and an RSVP sent
  // in that gap still has to name somebody.
  readonly property string ownAddress: accountEmail !== "" ? accountEmail : configuredEmail
  property int inboxUnread: 0
  property bool countLoading: false
  property var countHandle: null
  property int countSerial: 0

  // When the list last agreed with the server. Ticked separately so the label
  // ages without anything else re-evaluating.
  property double lastSyncedMs: 0
  property int syncTick: 0
  readonly property string syncedLabel: {
    var ignored = syncTick
    if (listLoading) return "Checking for mail"
    if (lastSyncedMs <= 0) return ""
    var ago = Mail.relativeTime(new Date(lastSyncedMs), new Date())
    return ago === "now" ? "Synced just now" : "Synced " + ago + " ago"
  }

  property string lastError: ""
  property string actionStatus: ""
  property string pendingAction: ""
  property int actionPreparations: 0
  property string pendingActionQuery: ""
  property var deferredListLoad: null
  property var queuedActions: []
  property bool sending: false
  readonly property alias sendQueue: sendQueue
  readonly property int sendPendingCount: sendQueue.parked.length
  readonly property bool sendPending: sendQueue.parked.length > 0
  readonly property var latestSend: sendQueue.latest
  property int sendSecondsRemaining: 0

  // Notifications only start once the first successful load has established
  // what was already there.
  property var seenIds: ({})
  property bool notificationsPrimed: false
  // The mailbox's own newest timestamp at the moment notifications were
  // primed. Set once, from the server's clock rather than this machine's, and
  // never raised — see `Model.newArrivals`.
  property double arrivalFloor: 0
  // The unread count needs a baseline of its own, separate from the message
  // cache: a mailbox that has never been opened has no cached page to prime
  // from, and would otherwise never be allowed to announce anything.
  property bool countPrimed: false
  // Mail that arrived since the list was last looked at. The bar shows a dot
  // for this and nothing else — an unread count that never reaches zero is a
  // permanent red mark, which stops meaning anything.

  readonly property string setupState: {
    // A provider with nothing behind it can never become ready, and saying so
    // here is what keeps every caller from having to ask separately.
    if (!Provider.isConnectable(providerId)) return "unavailable"
    if (!auth) return "signed_out"
    return Model.setupState({
      toolsPresent: auth.toolsPresent || !auth.toolsChecked,
      credentialsPresent: auth.credentialsPresent,
      signingIn: auth.loginBusy,
      recoveringSession: auth.recoveringSession || false,
      signedIn: auth.loggedIn
    })
  }
  // `ready` gates every function that fetches, so requiring the client here is
  // what spares each of them a null check of its own. It is not redundant with
  // the sign-in state: the two loaders build in sequence, so there is a frame
  // where the account is signed in and has nothing to fetch with.
  // Authentication can finish before the private runtime is installed or its
  // handshake lands. Waiting here makes that later transition run the same
  // metadata and active-list initialization as a restored sign-in.
  readonly property bool ready: setupState === "ready" && !!api
    && (!backend || !backend.executable || backend.ready === true)
  readonly property bool nativePolling: Provider.nativeSync(providerId) && !!backend
    && !!backend.protocolInfo && Array.isArray(backend.protocolInfo.methods)
    && backend.protocolInfo.methods.indexOf("mail.watch") >= 0
  readonly property bool busy: listLoading || detailLoading || countLoading
    || (auth ? auth.sessionBusy : false) || sending || pendingAction !== ""
  // The provider decides what a mailbox and a typed search amount to: Gmail's
  // are search operators, IMAP's name a folder. Opaque from here on — it is
  // handed back to the client that produced it, and used as a cache key.
  property string resolvedProviderQuery: ""
  property string resolvedProviderInput: ""
  property int providerQuerySerial: 0
  property int providerLabelSerial: 0
  readonly property string providerQueryInput: JSON.stringify([providerId, mailboxKey, searchQuery, defaultQuery])
  readonly property bool providerQueryNeedsResolution: searchQuery.trim() !== ""
    || (mailboxKey === "inbox" && defaultQuery.trim() !== "" && defaultQuery.trim() !== Provider.get(providerId).inheritedDefault)
  readonly property string effectiveQuery: rawQuery !== "" ? rawQuery
    : searchRaw !== "" ? searchRaw
    : resolvedProviderInput === providerQueryInput ? resolvedProviderQuery
    : Provider.mailboxFor(providerId, mailboxKey).query
  readonly property bool hasMore: nextPageToken !== ""
  // A cached search can already have rows on screen while this stays true.
  // Kept separate from the generic list state so the view can say that the
  // visible answer is still being extended by the server.
  readonly property bool serverSearchLoading: searchQuery !== ""
    && rawQuery === "" && listLoading
  readonly property string resultSummary: Model.resultSummary(messages, resultEstimate, hasMore)
  readonly property string barTooltip: Model.barTooltip(setupState, accountEmail, inboxUnread,
    Provider.badge(providerId), Provider.authKind(providerId))

  // The setup card, in this provider's words. Assembled here rather than in the
  // view so the page stays a description of the screen.
  readonly property string setupHeadline:
    Model.setupHeadline(setupState, Provider.badge(providerId), Provider.authKind(providerId))
  readonly property string setupDetail: Model.setupDetail(setupState,
    auth ? auth.missingTools : [], Provider.unavailableReason(providerId),
    Provider.badge(providerId), Provider.authKind(providerId))
  readonly property string setupActionLabel:
    Model.setupActionLabel(setupState, Provider.badge(providerId), Provider.authKind(providerId))

  // The sign-in has three waits that look identical from outside: the helper
  // script, the browser, and Google's token endpoint. Naming which one is
  // happening is the difference between "it is working" and "it is stuck".
  readonly property string signInProgress: {
    if (!auth) return ""
    if (!auth.toolsChecked)
      return "Checking for " + auth.requiredTools.slice(0, 2).join(" and ") + "…"
    if (!auth.credentialsPresent) return ""
    // Only one of these waits on a browser. An IMAP sign-in is a form and a
    // round trip, so naming a browser there would send the user looking for a
    // window that never opened.
    if (auth.loginBusy)
      return Provider.usesOAuth(providerId)
        ? "Finish the sign-in in your browser…"
        : "Checking the mailbox…"
    if (auth.sessionBusy) return "Restoring the saved session…"
    return ""
  }

  signal listRefreshed()

  // Cancelling runs on teardown and on every mailbox switch, which are exactly
  // the moments the client may already be gone — an account being removed, or
  // a provider change swapping both loaders out. A local wrapper means none of
  // the callers has to know that.
  function abortRequest(handle) {
    if (handle && typeof handle.cancelReader === "function") handle.cancelReader()
    else if (api && handle) api.abortRequest(handle)
  }

  function clearNotice() {
    lastError = ""
    actionStatus = ""
  }

  // When it was said, so a merged view can show the most recent of several
  // mailboxes' notices rather than whichever host it happened to ask first.
  property double actionStatusAt: 0

  function note(text) {
    actionStatus = String(text || "")
    actionStatusAt = actionStatus === "" ? 0 : Date.now()
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
    labelActions.refreshMonitored()
    if (active && (windowOpen || !listLoaded)) loadMessages(false)
  }

  property var monitoredIds: []

  function refreshCounts() {
    if (!ready || countLoading) return
    if (nativePolling) {
      backendSync.check()
      return
    }
    var serial = ++countSerial
    countLoading = true
    // Counted with the same query the Unread mailbox uses, not from the INBOX
    // label. The label counts every categorised message too, which is how this
    // reached 2483 on a real account — a number that is never zero, can only be
    // reported as "999+", and cannot tell anyone whether something is waiting.
    countHandle = api.listMessages(Provider.unreadQuery(providerId), 3, "", function(page, error) {
      if (serial !== root.countSerial) return
      if (error || !page) {
        root.countLoading = false
        root.countHandle = null
        return
      }
      var before = root.inboxUnread
      root.inboxUnread = page.estimate

      if (page.ids.length === 0) {
        root.previewMessages = []
        root.countLoading = false
        root.countHandle = null
      } else {
        root.countHandle = root.summarizedRead(page.ids, false, function(payloads) {
          if (serial !== root.countSerial) return
          var now = new Date()
          var summaries = []
          for (var i = 0; i < payloads.length; i++) {
            var summary = payloads[i].nativeSummary
            // The provider's unread query is authoritative. Some IMAP servers
            // omit FLAGS from metadata even when SEARCH UNSEEN found the row.
            summary.unread = true
            summaries.push(summary)
          }
          root.previewMessages = summaries
          root.countLoading = false
          root.countHandle = null
        }, root.countHandle)
      }

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
    api.getProfile(function(result, error) {
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
    api.getLabels(function(result, error) {
      if (error) return
      root.labels = result
      cacheStore.putLabels(result)
    })
  }

  // Every provider exposes the same sender-list operation. Gmail reads its
  // configured send-as aliases; an IMAP mailbox returns its one account
  // address. Keeping that distinction below this object lets the compose view
  // draw one honest From control for either provider.
  function loadSendAs() {
    if (!ready || sendAsLoading || sendAsLoaded) return
    sendAsLoading = true
    api.getSendAs(function(result, error) {
      root.sendAsLoading = false
      // Not a notice: a sender list that did not arrive costs the user a menu,
      // not a mailbox, and a banner over the inbox would be out of proportion.
      // It is not silent either — failing quietly here is indistinguishable
      // from "this account has one address", which is a question nobody could
      // answer from the window. `sendAsLoaded` stays false, so the next time
      // this account becomes ready or active it tries again.
      if (error) {
        console.warn("omamail: could not read the send-as addresses:",
          OAuth.redact(String(error)))
        return
      }
      root.sendAsAliases = result
      root.sendAsLoaded = true
    })
  }

  function hydrateSummary(summary) {
    summary.date = new Date(summary.dateMs || summary.date || 0)
    summary.time = Mail.relativeTime(summary.date, new Date())
    return summary
  }

  function hydrateSummaries(rows) {
    var values = Array.isArray(rows) ? rows : []
    for (var i = 0; i < values.length; i++) hydrateSummary(values[i])
    return values
  }

  function summarizeResources(payloads, callback) {
    var account = accountId
    var list = Array.isArray(payloads) ? payloads : []
    if (list.length === 0) { callback([], ""); return }
    if (!backend) { callback([], "Mail backend is unavailable"); return }
    backend.call("message.summaries", {messages: list, now: Date.now()}, function(result, error) {
      if (account !== root.accountId) return
      if (error || !result) { callback([], "Could not prepare message summaries"); return }
      var summaries = result.summaries || []
      if (summaries.length !== list.length) { callback([], "Incomplete message summaries"); return }
      for (var i = 0; i < list.length; i++) list[i].nativeSummary = root.hydrateSummary(summaries[i])
      callback(list, "")
    })
  }

  // Serialize delivery of progress and completion while each batch is prepared
  // in Rust. The final metadata callback cannot overtake an earlier batch.
  function summarizedRead(ids, full, callback, parent, progress, members) {
    var queued = []
    var preparing = false
    var handle = null
    var account = accountId
    function next() {
      if (preparing || queued.length === 0) return
      var item = queued.shift()
      preparing = true
      root.summarizeResources(item.payloads, function(payloads, error) {
        preparing = false
        if (account !== root.accountId || (handle && handle.aborted)) return
        if (item.final) callback(payloads, error || item.error)
        else if (typeof progress === "function") progress(payloads)
        next()
      })
    }
    function deliver(payloads, error) { queued.push({payloads: payloads, error: error, final: true}); next() }
    function arrived(payloads) { queued.push({payloads: payloads, final: false}); next() }
    handle = members ? api.getSummaries(ids, deliver)
      : api.getMessages(ids, full, deliver, parent, typeof progress === "function" ? arrived : undefined)
    return handle
  }

  property string readerRequestPrefix: String(Date.now()) + "-" + String(Math.random())
  property int readerRequestSerial: 0
  function readerOptions() {
    return {allowRemoteImages: remoteImagesAllowed,
      remoteImageData: remoteImagesAllowed ? remoteImageData : null, withReader: true}
  }

  function preparedRead(messageId, callback) {
    var account = accountId
    var client = api
    var request = readerRequestPrefix + "-" + (++readerRequestSerial)
    var handle = {aborted: false, cancelReader: function() {
      if (handle.aborted) return
      handle.aborted = true
      if (root.backend) root.backend.call("reader.cancel", {accountId: account, requestId: request}, function() {})
    }}
    function current() { return !handle.aborted && account === root.accountId && client === root.api }
    function read(cached) {
      if (!current()) return
      root.backend.call("reader.open", {accountId: account, id: messageId, requestId: request,
        cacheOnly: cached, now: Date.now(), options: root.readerOptions()}, function(resource, error) {
        if (!current()) return
        if (!error && resource && resource.nativeContent) {
          resource.nativeSummary = root.hydrateSummary(resource.nativeSummary)
          callback(resource, "", cached)
        } else if (!cached) callback(null, "Could not open that message", false)
        if (cached) read(false)
      })
    }
    if (!backend) { callback(null, "Mail backend is unavailable", false); return handle }
    read(true)
    return handle
  }

  function preferredSendAs(recipients) {
    return Api.preferredSendAs(availableSendAsAliases, recipients)
  }

  // Paints whatever the last visit to this query left behind. A new typed
  // search has no entry of its own yet, so it also searches every cached row's
  // sender, recipients, subject and snippet. The provider keeps searching the
  // server underneath; this is the immediate answer, not the final boundary of
  // what can be found.
  function paintFromCache() {
    if (!cacheStore.loaded) return false
    var serial = listSerial
    var account = accountId
    var query = cacheKey
    var liveAtStart = listLiveSerial
    cacheStore.getPreview(effectiveQuery, maxMessages,
      searchQuery !== "" && rawQuery === "" ? searchQuery : "", providerId, 0,
      function(result, error) {
        if (error || !result || serial !== root.listSerial || account !== root.accountId
            || query !== root.cacheKey || liveAtStart !== root.listLiveSerial) return
        var restored = result.summaries || []
        var entry = result.entry
        if (restored.length === 0) return
      for (var i = 0; i < restored.length; i++) {
        restored[i].date = new Date(restored[i].dateMs || restored[i].date || 0)
        restored[i].time = Mail.relativeTime(restored[i].date, new Date())
      }

      // Only when a row differs; see `Model.sameSummaries`.
      if (!Model.sameSummaries(messages, restored)) messages = restored
      resultEstimate = entry ? Math.max(entry.estimate, restored.length) : restored.length
      nextPageToken = entry ? entry.nextPageToken : ""
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
      if (arrivalFloor === 0) arrivalFloor = restored[0].date.getTime() || 0
      notificationsPrimed = true
      listRefreshed()
      })
    return false
  }

  function loadMessages(append, skipCache, preservedError) {
    // An optimistic action may have stopped this query's live list specifically
    // so its stale snapshots cannot settle over the edit. Polling and F5 for
    // that same query wait for the action callback's deliberate revalidation,
    // but navigation has a different cache key and must still be allowed to
    // load its new view.
    if (!ready) return
    if (rawQuery === "" && searchRaw === "" && providerQueryNeedsResolution
        && resolvedProviderInput !== providerQueryInput) {
      if (!backend || !backend.ready) return
      // The old list must not settle while the new opaque query is prepared.
      listSerial++
      abortRequest(listHandle)
      listHandle = null
      listLoading = true
      var queryInput = providerQueryInput
      var queryAccount = accountId
      var querySerial = ++providerQuerySerial
      backend.call("providers.resolve", {provider: providerId, operation: "query", mailbox: mailboxKey,
        search: searchQuery, defaultQuery: defaultQuery}, function(result, error) {
        if (querySerial !== root.providerQuerySerial || queryAccount !== root.accountId
            || queryInput !== root.providerQueryInput) return
        if (error) { root.listLoading = false; root.note("Could not prepare this search"); return }
        root.resolvedProviderQuery = String((result || {}).value || "")
        root.resolvedProviderInput = queryInput
        root.loadMessages(append, skipCache, preservedError)
      })
      return
    }
    if ((pendingAction !== "" || actionPreparations > 0) && cacheKey === pendingActionQuery) {
      var cleared = !listLoaded
      // A→B→A can arrive here while B still owns the active request. The
      // deferred A load needs a fresh serial now, otherwise B may settle into
      // A before the action callback gets a chance to resume it.
      if (cleared) {
        listSerial++
        abortRequest(listHandle)
        listHandle = null
        listLoading = false
      }
      deferredListLoad = ({
        cacheKey: cacheKey,
        append: append === true,
        skipCache: skipCache === true,
        preservedError: String(preservedError || ""),
        cleared: cleared
      })
      return
    }
    // A deferred refresh belongs to the view that requested it. Once the user
    // navigates somewhere else, that newer view supersedes the old request.
    if (deferredListLoad && deferredListLoad.cacheKey !== cacheKey)
      deferredListLoad = null
    var serial = ++listSerial
    var keptError = String(preservedError || "")
    abortRequest(listHandle)
    if (!append) {
      // Cache first: paint, then revalidate. The page tokens and the estimate
      // come back with the live answer. An action that interrupted the prior
      // load already has the newest optimistic state on screen and must not
      // re-import the removed row from another cached query.
      if (skipCache !== true && !paintFromCache()) {
        nextPageToken = ""
        resultEstimate = 0
      }
    }
    listLoading = true
    var token = append ? nextPageToken : ""

    // A typed search accepts ids while the provider is still finding them.
    // Mailbox and label listings have no long-running search phase, so their
    // simpler page-at-once path stays below.
    if (searchQuery !== "" && rawQuery === "") {
      loadSearchMessages(append, token, serial, keptError)
      return
    }

    listHandle = api.listMessages(effectiveQuery, maxMessages, token,
      function(page, error) {
        if (serial !== root.listSerial) return
        if (error || !page) {
          root.listLoading = false
          if (!append) root.nextPageToken = ""
          root.fail(error || "Gmail returned nothing")
          return
        }
        root.resultEstimate = page.estimate
        root.nextPageToken = page.nextPageToken
        if (page.ids.length === 0) {
          root.listLiveSerial++
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
          root.lastError = keptError
          root.listRefreshed()
          return
        }
        root.fetchSummaries(page.ids, append, serial, keptError)
      })
  }

  function deferredLoadCleared(query) {
    return !!deferredListLoad && deferredListLoad.cacheKey === query
      && deferredListLoad.cleared === true
  }

  function resumeDeferredListLoad(actionQuery, actionError) {
    var request = deferredListLoad
    deferredListLoad = null
    if (!request || request.cacheKey !== cacheKey) return false
    var sameActionQuery = cacheKey === actionQuery
    // After a failed action the repaired cache is authoritative enough to
    // repaint a navigation-cleared view. After success even an exact-query
    // cache can be broadened by local-search fallback from other cached views,
    // so revalidate without cache rather than flash the moved row again.
    var useCache = sameActionQuery && request.cleared === true
      && String(actionError || "") !== ""
    loadMessages(sameActionQuery ? false : request.append === true,
      sameActionQuery ? !useCache : request.skipCache === true,
      String(actionError || request.preservedError || ""))
    return true
  }

  // The two stages of a server search overlap here. `listMessages` reports id
  // fragments as its search windows settle; each fragment starts its metadata
  // read immediately, and those payloads paint without waiting for either the
  // rest of the ids or the slowest metadata request. The final list callback
  // remains authoritative for paging and for when "Checking" may stop.
  function loadSearchMessages(append, token, serial, preservedError) {
    var previewSearch = messages.slice()
    var settledBase = append ? messages.slice() : []
    var liveSummaries = []
    var requested = {}
    var painted = {}
    var fetchQueue = []
    var fetchActive = false
    var listingDone = false
    var finalPage = null
    var listingError = ""
    var summaryError = ""
    var paintQueue = []
    var paintActive = false
    var finishing = false

    function summariesOf(payloads) {
      var now = new Date()
      var summaries = []
      var list = Array.isArray(payloads) ? payloads : []
      for (var i = 0; i < list.length; i++) summaries.push(list[i].nativeSummary)
      return summaries
    }

    function paintPayloads(payloads) {
      if (serial !== root.listSerial) return
      var fresh = []
      var list = Array.isArray(payloads) ? payloads : []
      for (var i = 0; i < list.length; i++) {
        var id = String(list[i] && list[i].id ? list[i].id : "")
        if (id === "" || painted[id]) continue
        painted[id] = true
        fresh.push(list[i])
      }
      var summaries = summariesOf(fresh)
      if (summaries.length === 0) return
      paintQueue.push(summaries)
      pumpPaint()
    }

    function pumpPaint() {
      if (paintActive || paintQueue.length === 0 || serial !== root.listSerial) return
      paintActive = true
      var summaries = paintQueue.shift()
      root.backend.call("model.apply", {operation: "searchProgress",
        args: [previewSearch, liveSummaries, summaries]}, function(result, error) {
        if (serial !== root.listSerial) return
        paintActive = false
        if (error || !result) summaryError = "Could not prepare search results"
        else {
          liveSummaries = root.hydrateSummaries(result.live)
          root.listLiveSerial++
          root.messages = root.hydrateSummaries(result.visible)
          root.listLoaded = true
          root.lastError = preservedError
          root.listRefreshed()
        }
        if (paintQueue.length > 0) pumpPaint()
        else finishIfReady()
      })
    }

    function finishIfReady() {
      if (serial !== root.listSerial || !listingDone || fetchActive || paintActive
          || paintQueue.length > 0 || finishing || fetchQueue.length > 0) return
      root.listLoading = false
      if (!finalPage) {
        // Cache-first may have restored an old continuation, but a failed page
        // one has not revalidated the ids before it. Keeping that offset would
        // let Load more skip or duplicate rows while the preview remains.
        root.nextPageToken = ""
        root.fail(listingError || "The mail server returned nothing")
        return
      }

      root.resultEstimate = finalPage.estimate
      finishing = true
      root.backend.call("model.apply", {operation: "searchFinish",
        args: [settledBase, previewSearch, liveSummaries, finalPage.ids, append]}, function(result, error) {
      if (serial !== root.listSerial) return
      if (error || !result) { root.fail("Could not settle search results"); return }
      var missingSummaries = result.missing
      var metadataError = summaryError
      if (metadataError === "" && missingSummaries.length > 0)
        metadataError = "Some search results could not be read"
      var complete = listingError === "" && metadataError === ""
      root.nextPageToken = complete ? finalPage.nextPageToken : ""
      var settled = root.hydrateSummaries(result.settled)
      root.applySummaries(settled, false, true, complete, function() {
      if (listingError !== "") {
        root.fail(listingError)
        return
      }
      if (metadataError !== "") {
        root.fail(metadataError)
        return
      }
      cacheStore.putQuery(root.cacheKey, ({
        summaries: root.messages,
        estimate: root.resultEstimate,
        nextPageToken: root.nextPageToken
      }))
      if (preservedError !== "") root.fail(preservedError)
      })
      })
    }

    // Progress can report another id fragment while the previous fragment's
    // headers are still loading. One metadata call at a time gives the IMAP
    // client's own two-way batching a shared ceiling across the whole search,
    // rather than multiplying it by the number of settled windows.
    function startNextFetch() {
      if (serial !== root.listSerial || fetchActive || fetchQueue.length === 0) {
        finishIfReady()
        return
      }
      var wanted = fetchQueue.shift()
      fetchActive = true
      root.summarizedRead(wanted, false, function(payloads, error) {
        if (serial !== root.listSerial) return
        paintPayloads(payloads)
        if (error && summaryError === "") summaryError = error
        fetchActive = false
        startNextFetch()
      }, listHandle, paintPayloads)
    }

    function fetchIds(ids) {
      if (serial !== root.listSerial) return
      var source = Array.isArray(ids) ? ids : []
      var wanted = []
      for (var i = 0; i < source.length; i++) {
        var id = String(source[i] || "")
        if (id === "" || requested[id]) continue
        requested[id] = true
        wanted.push(id)
      }
      if (wanted.length === 0) {
        finishIfReady()
        return
      }
      fetchQueue.push(wanted)
      startNextFetch()
    }

    function idsArrived(page) {
      if (serial !== root.listSerial || !page) return
      root.resultEstimate = Math.max(root.resultEstimate,
        Math.max(0, Math.floor(Number(page.estimate)) || 0))
      root.nextPageToken = String(page.nextPageToken || "")
      fetchIds(page.ids)
    }

    listHandle = api.listMessages(effectiveQuery, maxMessages, token,
      function(page, error) {
        if (serial !== root.listSerial) return
        finalPage = page
        listingError = String(error || "")
        listingDone = true
        if (page) fetchIds(page.ids)
        finishIfReady()
      }, idsArrived)
  }

  function fetchSummaries(ids, append, serial, preservedError) {
    root.summarizedRead(ids, false, function(payloads, error) {
      if (serial !== root.listSerial) return
      root.listLoading = false
      var now = new Date()
      var summaries = []
      var list = Array.isArray(payloads) ? payloads : []
      for (var i = 0; i < list.length; i++)
        summaries.push(list[i].nativeSummary)
      root.backend.call("model.apply", {operation: "missingSearchSummaryIds", args: [summaries, ids]}, function(missingSummaries, modelError) {
      if (serial !== root.listSerial) return
      if (modelError) { root.fail("Could not prepare message list"); return }
      var metadataError = String(error || "")
      if (metadataError === "" && missingSummaries.length > 0)
        metadataError = "Some messages could not be read"
      if (metadataError !== "" && summaries.length === 0) {
        // Keep the cache-first page when no metadata arrived, but never its
        // continuation: that token follows an entirely missing live page.
        root.nextPageToken = ""
        root.fail(metadataError)
        return
      }
      root.applySummaries(summaries, append, false, metadataError === "", function() {
      if (metadataError !== "") {
        // The list endpoint's token follows every id it returned, including a
        // row whose metadata failed. Paging with it would skip that row just as
        // surely as in the streamed search path.
        root.nextPageToken = ""
        root.fail(metadataError)
        return
      }
      // The cache keeps a bounded prefix of the list the window actually
      // showed, including later pages until that cap is reached. Keeping only
      // page one made a later local search forget rows plainly seen here.
      cacheStore.putQuery(root.cacheKey, ({
        summaries: root.messages,
        estimate: root.resultEstimate,
        nextPageToken: root.nextPageToken
      }))
      if (preservedError !== "") root.fail(preservedError)
      })
      })
    }, listHandle)
  }

  function applySummaries(summaries, append, suppressArrivals, markSynced, callback) {
    var serial = ++listLiveSerial
    var account = accountId
    var list = listSerial
    var merged = append ? root.messages.concat(summaries) : summaries
    // A manual search may uncover an old unread row the current mailbox page
    // never held. That is a result, not newly arrived mail, so it must not turn
    // into a desktop notification.
    if (!backend) { fail("Mail backend is unavailable"); return }
    backend.call("model.apply", {operation: "batch", calls: [
      {operation: "newArrivals", args: [summaries, seenIds, notificationsPrimed, arrivalFloor]},
      {operation: "newestDate", args: [merged]}
    ]}, function(result, error) {
      if (serial !== root.listLiveSerial || account !== root.accountId || list !== root.listSerial) return
      if (error || !result) { root.fail("Could not update message list"); return }
      var arrivals = append || suppressArrivals === true ? [] : result[0]

    var seen = {}
    for (var i = 0; i < merged.length; i++) seen[merged[i].id] = true
    // Ids already seen are kept so a message that scrolls off the first page
    // does not get announced again when it comes back.
    for (var key in seenIds) seen[key] = true
    seenIds = seen
    if (arrivalFloor === 0) arrivalFloor = Number(result[1]) || 0
    notificationsPrimed = true

    messages = merged
    listLoaded = true
    lastError = ""
    if (markSynced !== false) lastSyncedMs = Date.now()
    listRefreshed()

    if (notifyNewMail && arrivals.length > 0) notify(arrivals)
    if (typeof callback === "function") callback()
    })
  }

  function loadMore() {
    if (!hasMore || listLoading) return
    loadMessages(true)
  }

  // --------------------------------------------------------------- detail

  // True when the selected message is only a cursor preview.
  property bool selectionIsPreview: false

  function select(id, previewOnly) {
    var messageId = String(id || "")
    if (messageId === "") {
      clearSelection()
      return
    }
    selectionIsPreview = previewOnly === true
    selectedId = messageId
    var serial = ++detailSerial
    var markedRead = false
    abortRequest(detailHandle)
    abortRequest(inviteHandle)
    inviteHandle = null
    selectedMessage = null
    selectedBody = { text: "", source: "" }
    selectedHasHtml = false
    selectedRenderRevision = ""
    selectedDocument = null
    selectedReaderDocument = null
    selectedReaderTooHeavy = false
    selectedReaderEmpty = true
    selectedReaderRemoteImages = 0
    readerSourceKey = ""
    remoteImagesAllowed = Model.showsRemoteImages(alwaysShowImages, selectionIsPreview)
    remoteImagesLoading = false
    remoteImageData = ({})
    remoteImageAttempted = ({})
    imageBatchDirty = false
    imagePaintTimer.stop()
    selectedRemoteImageSources = []
    imageFetchQueue = []
    imageFetchSerial++
    selectedBlockedImages = 0
    selectedRemoteImages = 0
    selectedImages = []
    selectedAttachments = []
    selectedInvite = null
    selectedUnsubscribe = null
    unsubscribeDone = ""
    detailLoading = true
    detailPainted = false

    // The reader opens on what the list already knows rather than a skeleton:
    // the row *is* a summary of the shape the live read produces. Without this
    // a body painted from the disk cache in milliseconds sat behind the
    // loading state until the network answered. A conversation member is not a
    // row, but the rail holds its summary, and the header paints from that.
    var knownSummary = summaryOf(messageId)
    if (knownSummary) selectedMessage = knownSummary
    // Which conversation the reader is now inside, and the stops it draws.
    // Decided from the row rather than from the read, because `memberIds` is
    // known the moment a row is opened and no summary is — so the rail draws a
    // skeleton stop per id at once and nothing moves when the summaries land.
    selectConversation(messageId, knownSummary)

    // A message that has been opened before opens from its file, usually well
    // before Gmail answers. The read is asynchronous, so the live copy can win
    // the race — in which case the cached one is simply dropped rather than
    // painted over what is already correct.
    detailLive = false
    detailCachedResource = false

    detailHandle = preparedRead(messageId, function(payload, error, cached) {
      if (serial !== root.detailSerial || (cached && root.detailLive)) return
      if (error || !payload) {
        root.detailLoading = false
        if (!root.detailPainted && !root.detailCachedResource) root.fail(error || "Could not open that message")
        return
      }
      if (cached) root.detailCachedResource = true
      else root.detailLive = true
      // Merged with the row rather than replacing it: a provider whose detail
      // read carries no subject line of its own — HEY reads a conversation, not
      // a message — would otherwise blank the one the list had drawn.
      var previous = Model.messageById(root.messages, root.previewMessages, messageId)
      root.backend.call("model.apply", {operation: "detailSummary", args: [previous, payload.nativeSummary]}, function(summary, modelError) {
      if (serial !== root.detailSerial || (cached && root.detailLive)) return
      if (modelError || !summary) {
        root.detailLoading = false
        if (!root.detailPainted) root.fail("Could not prepare message detail")
        return
      }
      function paintSummary(summary) {
      if (serial !== root.detailSerial || (cached && root.detailLive)) return
      summary = root.hydrateSummary(summary)
      root.selectedMessage = summary
      var decoded = payload.nativeContent.body
      root.renderSerial++
      root.selectedHasHtml = !!payload.hasHtml
      root.readerSourceKey = payload.hasHtml ? String(payload.readerKey) : ""
      var ready = payload.nativeRender
      root.adoptRendered(ready)
        root.detailLoading = false
        root.detailPainted = true
        root.lastError = ""
        if (ready.plainText) decoded = ({ text: ready.plainText.text, source: "html", bodyDirection: ready.plainText.bodyDirection || "" })
        root.selectedBody = decoded
        root.selectedImages = ready.plainText ? ready.plainText.images : []

      root.selectedAttachments = payload.nativeContent.attachments
      root.selectedInvite = payload.cachedInvite || Calendar.fromPayload(payload.payload)
      root.selectedUnsubscribe = Unsub.fromMessage(payload)
      // Only the invitation overlay may need persistence after its attachment
      // arrives; the complete resource remains in the native cache.
      var record = ({
        text: root.selectedBody.text,
        source: root.selectedBody.source,
        bodyDirection: String(root.selectedBody.bodyDirection || ""),
        attachments: root.selectedAttachments,
        images: root.selectedImages,
        invite: root.selectedInvite,
        unsubscribe: root.selectedUnsubscribe
      })
      // Gmail describes the calendar part rather than sending it whenever the
      // organiser's calendar named the file, which Google's own does — so the
      // meeting is one request away, and the card lands a moment after the
      // message it belongs to. The cache is written again with it, so it is
      // there at once the next time this message is opened.
      if (!payload.cachedInvite) root.loadInvite(messageId, serial, Calendar.pendingPart(payload.payload), record)
      if (!cached) {
        root.messages = Model.replaceById(root.messages, summary)
        root.previewMessages = Model.replaceById(root.previewMessages, summary)
      }
      // A message opened from somewhere other than its own row — a notification,
      // a member whose summary had not arrived when it was asked for — brings
      // its conversation with the read rather than before it.
      root.selectConversation(messageId, summary)
      root.rememberMember(summary)
      // A preview is not opening; only an opened message is marked read here.
      if (!markedRead && Model.marksReadOnArrival(summary, root.selectionIsPreview))
        markedRead = root.act(messageId, "markRead", true) === true
      }
      // A revalidation started before the optimistic read may still contain
      // UNREAD. Apply the pending read natively before it reaches list/reader,
      // and never send a second read for the same opening.
      var keepRead = markedRead && (root.actionPreparations > 0 || root.pendingAction === "markRead"
        || (root.selectedMessage && root.selectedMessage.unread === false))
      if (keepRead) {
        root.backend.call("model.apply", {operation: "applyLabelChange", args: [summary, "markRead", "", null]}, function(readSummary, readError) {
          if (serial !== root.detailSerial || (cached && root.detailLive)) return
          if (readError || !readSummary) return
          paintSummary(readSummary)
        })
      } else paintSummary(summary)
      })
    })
  }

  // Mark the message the dwell started on, if it is still unread.
  function markPreviewRead(id) {
    if (!Model.previewReadable(messages, id)) return false
    act(String(id), "markRead", true)
    return true
  }

  // ---------------------------------------------------------- the rail

  // Summaries into the store the rail draws from, bounded — and the members of
  // the conversation on screen kept through the bound's reset, because the read
  // that tips the store over is usually the one for the rail being drawn.
  function queueConversation(operation, summary, additions, after) {
    var jobs = (conversationJobs || []).slice()
    if (operation === "project" && jobs.some(function(job) { return job.operation === "project" })) {
      pumpConversation(); return
    }
    jobs.push({ operation: operation, summary: summary, additions: additions,
      after: after, account: accountId, selected: selectedId })
    conversationJobs = jobs
    pumpConversation()
  }
  function pumpConversation() {
    if (conversationBusy || !backend || !backend.ready || conversationJobs.length === 0) return
    var jobs = conversationJobs.slice()
    var job = jobs.shift()
    conversationJobs = jobs
    if (job.account !== accountId || (job.operation !== "project" && job.selected !== selectedId)) {
      pumpConversation(); return
    }
    conversationBusy = true
    var serial = ++conversationSerial
    var account = accountId
    var selected = selectedId
    var beforeMembers = JSON.stringify(memberSummaries)
    var beforeThread = JSON.stringify(selectedThread)
    backend.call("account.conversation", {
      operation: job.operation, thread: selectedThread, summaries: memberSummaries,
      selectedId: selectedId, summary: job.summary, additions: job.additions,
      messages: job.operation === "seed" ? messages : [],
      previewMessages: job.operation === "seed" ? previewMessages : [],
      conversations: showsConversations, mailboxKey: mailboxKey,
      searching: viewingSearch, mailboxes: mailboxes
    }, function(result, error) {
      if (!root || serial !== root.conversationSerial) return
      root.conversationBusy = false
      if (!error && result && account === root.accountId && selected === root.selectedId
          && beforeMembers === JSON.stringify(root.memberSummaries)
          && beforeThread === JSON.stringify(root.selectedThread)) {
        root.conversationOrganisation = result
        if (job.operation === "select" && JSON.stringify(result.thread) !== beforeThread)
          root.selectedThread = result.thread
        if ((job.operation === "merge" || job.operation === "seed")
            && JSON.stringify(result.summaries) !== beforeMembers)
          root.memberSummaries = result.summaries
        if (typeof job.after === "function") job.after(result)
      } else if (!error && account === root.accountId && selected === root.selectedId
          && (job.operation === "select" || job.operation === "seed")) {
        // A list or optimistic action changed the snapshot while Rust was
        // working. Rebase the selection plan against that newer snapshot.
        root.queueConversation(job.operation, job.summary, job.additions, job.after)
      }
      root.pumpConversation()
    })
  }
  function selectConversation(messageId, summary) {
    if (String(messageId) !== selectedId) return
    queueConversation("select", summary, null, function() { root.loadMembers() })
  }
  function mergeMembers(additions) { queueConversation("merge", null, additions, null) }
  function rememberMember(summary) {
    if (!summary || !summary.id) return
    var additions = ({})
    additions[summary.id] = summary
    mergeMembers(additions)
  }
  function loadMembers() {
    if (!api || !showsConversations) return
    queueConversation("seed", null, null, function(result) {
      var wanted = result.missing || []
      if (!result.showsRail || wanted.length === 0) return
      root.abortRequest(root.memberHandle)
      var account = root.accountId
      var selected = root.selectedId
      var serial = root.detailSerial
      root.memberHandle = root.summarizedRead(wanted, false, function(payloads, error) {
        if (!root || account !== root.accountId || selected !== root.selectedId || serial !== root.detailSerial) return
        root.memberHandle = null
        if (error || !payloads || payloads.length === 0) return
        var arrived = ({})
        for (var j = 0; j < payloads.length; j++) {
          var summary = payloads[j].nativeSummary
          if (summary && summary.id) arrived[summary.id] = summary
        }
        root.mergeMembers(arrived)
      }, null, null, true)
    })
  }

  // The invitation the message pointed at. Nothing happens for the messages
  // that are not one — `pendingPart` is null unless a calendar part arrived
  // with an id in place of its octets — and the file is asked for once, at the
  // size the part already declared.
  function loadInvite(messageId, serial, part, record) {
    if (!part) return
    inviteHandle = api.getAttachment(messageId, String(part.body.attachmentId),
      function(data, error) {
        if (serial !== root.detailSerial) return
        root.inviteHandle = null
        if (error || !data) return
        var invite = Calendar.fromAttachment(part, data)
        if (!invite) return
        root.selectedInvite = invite
        record.invite = invite
        bodyCache.put(messageId, record)
        })
  }

  // Re-render the native source by identity when display policy changes.
  // Sender markup never travels back through the UI.
  function renderSource(source, withPlainText, completeReader, callback) {
    readerSourceKey = String(source || "")
    var rendering = ++renderSerial
    var selection = selectedId
    var account = accountId
    var detail = detailSerial
    var key = readerSourceKey
    if (!backend) { fail("Mail backend is unavailable"); return }
    backend.call("reader.render", {accountId: account, id: selection,
      readerKey: readerSourceKey, now: Date.now(), options: readerOptions()}, function(result, error) {
      if (rendering !== root.renderSerial || account !== root.accountId
          || selection !== root.selectedId || detail !== root.detailSerial || key !== root.readerSourceKey) return
      if (error || !result) { root.detailLoading = false; root.fail("Could not prepare this message for display"); return }
      root.applyRendered(result.nativeRender)
      if (typeof callback === "function") callback(result.nativeRender)
    })
  }

  function adoptRendered(ready) {
    // A live response may have been prepared before cached images completed.
    // Keep the painted document until Rust incorporates the approved bytes.
    if (readerSourceKey !== "" && remoteImagesAllowed && Object.keys(remoteImageData).length > 0) {
      renderSource(readerSourceKey)
      return
    }
    applyRendered(ready)
  }

  function applyRendered(ready) {
      var revision = String(ready.revision || "")
      if (revision !== "" && revision === selectedRenderRevision) return
      selectedRenderRevision = revision
      selectedDocument = ready.document
      selectedReaderDocument = ready.reader ? ready.reader.document : null
      selectedReaderTooHeavy = !!ready.reader && ready.reader.tooHeavy
      selectedReaderEmpty = !ready.reader || ready.reader.empty
      selectedReaderRemoteImages = ready.reader ? ready.reader.blockedImages : 0
      selectedBlockedImages = ready.blockedImages
      selectedRemoteImages = ready.remoteImages
      selectedRemoteImageSources = ready.remoteImageSources || []
      selectedTooHeavy = ready.tooHeavy
      if (remoteImagesAllowed && !remoteImagesLoading
        && selectedRemoteImageSources.length > 0)
        Qt.callLater(root.prepareRemoteImages)
  }

  function showRemoteImages() {
    if (remoteImagesAllowed || readerSourceKey === "") return
    remoteImagesAllowed = true
    remoteImageData = ({})
    renderSource(readerSourceKey)
  }

  function prepareRemoteImages() {
    if (!remoteImagesAllowed || remoteImagesLoading || readerSourceKey === ""
      || selectedRemoteImageSources.length === 0) return
    var pending = []
    for (var i = 0; i < selectedRemoteImageSources.length; i++) {
      var source = String(selectedRemoteImageSources[i])
      if (!remoteImageAttempted[source] && !remoteImageData[source] && pending.indexOf(source) < 0)
        pending.push(source)
    }
    if (pending.length === 0) return
    imageFetchQueue = pending
    imageBatchDirty = false
    remoteImagesLoading = true
    imageFetchSerial++
    fetchNextImage(imageFetchSerial)
  }

  function flushRemoteImages() {
    if (!imageBatchDirty || !remoteImagesAllowed || readerSourceKey === "") return
    imageBatchDirty = false
    renderSource(readerSourceKey)
  }

  function fetchNextImage(serial) {
    if (serial !== imageFetchSerial) return
    if (imageFetchQueue.length === 0) {
      remoteImagesLoading = false
      imagePaintTimer.stop()
      flushRemoteImages()
      return
    }
    var queue = imageFetchQueue.slice(0)
    var source = String(queue.shift())
    imageFetchQueue = queue
    if (!backend || !backend.ready) { remoteImagesLoading = false; return }
    remoteImageAttempted[source] = true
    backend.call("public.image", {url:source}, function(result, error) {
      if (serial !== root.imageFetchSerial) return
      var data = result && !error ? String(result.data || "") : ""
      if (!Html.isRasterDataImage(data)) data = ""
      if (data !== "") {
        var prepared = ({})
        for (var key in root.remoteImageData) prepared[key] = root.remoteImageData[key]
        prepared[source] = data
        root.remoteImageData = prepared
        root.imageBatchDirty = true
        if (!imagePaintTimer.running) imagePaintTimer.start()
      }
      root.fetchNextImage(serial)
    })
  }

  // One picture, for the plain-text marker. The standing "always show"
  // answer is a different question: this is the reader asking for this
  // source, and the bytes still come through the public-host worker so Qt
  // never sees the address.
  function fetchDisplayImage(source, callback) {
    var wanted = String(source || "")
    var done = typeof callback === "function" ? callback : function() {}
    if (Html.isRasterDataImage(wanted)) {
      done(wanted)
      return
    }
    if (remoteImageData && Object.prototype.hasOwnProperty.call(remoteImageData, wanted)
      && Html.isRasterDataImage(String(remoteImageData[wanted] || ""))) {
      done(String(remoteImageData[wanted]))
      return
    }
    if (Html.imageSourceKind(wanted) !== "remote") {
      done("")
      return
    }
    if (!backend || !backend.ready) { done(""); return }
    var account = accountId
    var selection = selectedId
    var detail = detailSerial
    backend.call("public.image", {url:wanted}, function(result, error) {
      if (account !== root.accountId || selection !== root.selectedId || detail !== root.detailSerial) return
      var data = result && !error ? String(result.data || "") : ""
      done(Html.isRasterDataImage(data) ? data : "")
    })
  }


  function clearSelection() {
    detailSerial++
    abortRequest(detailHandle)
    detailHandle = null
    abortRequest(inviteHandle)
    inviteHandle = null
    selectedId = ""
    selectedMessage = null
    selectedBody = { text: "", source: "" }
    selectedHasHtml = false
    selectedRenderRevision = ""
    selectedDocument = null
    selectedReaderDocument = null
    selectedReaderTooHeavy = false
    selectedReaderEmpty = true
    selectedReaderRemoteImages = 0
    readerSourceKey = ""
    remoteImagesAllowed = false
    remoteImagesLoading = false
    remoteImageData = ({})
    remoteImageAttempted = ({})
    imageBatchDirty = false
    imagePaintTimer.stop()
    selectedRemoteImageSources = []
    imageFetchQueue = []
    imageFetchSerial++
    selectedImages = []
    selectedBlockedImages = 0
    selectedRemoteImages = 0
    selectedTooHeavy = false
    selectedAttachments = []
    selectedInvite = null
    selectedUnsubscribe = null
    unsubscribeDone = ""
    detailLoading = false
    // The rail goes with the reader. The member summaries do not: they are a
    // cache of what has been read, and closing one conversation is no reason to
    // pay for the next one twice.
    selectedThread = null
    abortRequest(memberHandle)
    memberHandle = null
  }

  // The cursor is the list's own position and moves relative to itself.
  // `selectedId` keeps its separate meaning: which message the reader shows.
  function cursorOffset(cursorId, delta) {
    return Model.cursorAfterOffset(messages, cursorId, delta)
  }

  // -------------------------------------------------------------- actions

  // Network sends keep their order; native intent preparation proceeds while
  // a previous send is in flight, so a slow server never blocks the next edit.
  function queueAction(messageId, action, actionQuery, quiet, memberOnly, dispatch, discard, token, sourceLabelId) {
    var queued = queuedActions.slice()
    for (var i = queued.length - 1; i >= 0; i--) {
      var previous = queued[i]
      if (previous.id !== messageId) continue
      if (previous.action === action && previous.cacheKey === actionQuery
          && previous.quiet === quiet && previous.memberOnly === memberOnly
          && previous.sourceLabelId === sourceLabelId) {
        discard(previous.token)
        return
      }
      break
    }
    queued.push({id: messageId, action: action, cacheKey: actionQuery, dispatch: dispatch,
      quiet: quiet, memberOnly: memberOnly, token: token, sourceLabelId: sourceLabelId})
    queuedActions = queued
  }

  function runQueuedAction() {
    if (pendingAction !== "" || queuedActions.length === 0) return
    var queued = queuedActions.slice()
    var next = queued.shift()
    queuedActions = queued
    next.dispatch()
  }

  function refuseUnavailableAction(action) {
    var needs = Model.actionCapability(action)
    if (needs === "" || actionCapabilities[needs] === true) return false
    var refused = Provider.refusal(providerId, needs, capabilityRefusals)
    note(refused !== "" ? refused : Model.actionUnavailable(action, Provider.badge(providerId)))
    return true
  }

  function intentView() {
    return {messages: messages, previewMessages: previewMessages,
      memberSummaries: memberSummaries, selectedId: selectedId,
      selectedMessage: selectedMessage, selectedThread: selectedThread,
      inboxUnread: inboxUnread}
  }

  // Convert native date values at the display boundary, once per returned row.
  function applyIntentView(view, query, selectedBefore) {
    if (!view) return
    if (query === cacheKey && !deferredLoadCleared(query)) {
      messages = hydrateSummaries(view.messages || [])
      previewMessages = hydrateSummaries(view.previewMessages || [])
      var members = view.memberSummaries || ({})
      for (var id in members) hydrateSummary(members[id])
      memberSummaries = members
      inboxUnread = Math.max(0, Number(view.inboxUnread) || 0)
    }
    if (selectedId === selectedBefore) {
      if (String(view.selectedId || "") === "") clearSelection()
      else if (view.selectedMessage) selectedMessage = hydrateSummary(view.selectedMessage)
    }
  }

  function act(id, action, quiet, memberOnly) {
    return runNativeAction([String(id || "")], action, quiet === true, memberOnly === true, false)
  }

  function runNativeAction(ids, action, quiet, memberOnly, allRead) {
    if (!ready || !backend || (!allRead && ids.length === 0) || (allRead && messages.length === 0)) return false
    if (refuseUnavailableAction(action)) return false
    var account = accountId
    var actionQuery = cacheKey
    var estimate = resultEstimate
    var oldPageToken = nextPageToken
    var interrupted = false
    function stopLiveList() {
      if (root.accountId !== account || root.cacheKey !== actionQuery || !root.listLoading) return
      interrupted = true
      root.listSerial++
      root.abortRequest(root.listHandle)
      root.listHandle = null
      root.listLoading = false
      root.nextPageToken = ""
      oldPageToken = ""
    }
    stopLiveList()
    var parameters = {accountId: account, query: actionQuery, action: action,
      ids: ids, allRead: allRead === true, quiet: quiet === true,
      memberOnly: memberOnly === true, mailboxKey: mailboxKey,
      rawQuery: rawQuery, hasLabels: hasLabels,
      sourceLabelId: hasLabels ? rawLabelId : "", capabilities: actionCapabilities,
      opaqueQuery: effectiveQuery !== Provider.mailboxFor(providerId, mailboxKey).query}
    var preparationEpoch = intents.epoch
    actionPreparations++
    if (pendingAction === "") pendingActionQuery = actionQuery
    intents.begin(parameters, function(prepared, error, selectedBefore) {
      if (root.accountId === account && preparationEpoch === intents.epoch)
        root.actionPreparations = Math.max(0, root.actionPreparations - 1)
      if (error || !prepared) {
        if (root.accountId === account && preparationEpoch === intents.epoch) {
          root.fail(error || "Could not prepare the action")
          if (root.actionPreparations === 0 && root.pendingAction === "") {
            var resumed = root.resumeDeferredListLoad(actionQuery, String(error || ""))
            if (!resumed && interrupted && root.cacheKey === actionQuery)
              root.loadMessages(false, true, String(error || ""))
          }
        }
        return
      }
      if (prepared.refused) {
        if (root.accountId === account && preparationEpoch === intents.epoch) {
          root.refuseUnavailableAction(action)
          if (root.actionPreparations === 0 && root.pendingAction === "") {
            var resumed = root.resumeDeferredListLoad(actionQuery, "")
            if (!resumed && interrupted && root.cacheKey === actionQuery) root.loadMessages(false, true, "")
          }
        }
        return
      }
      var targets = prepared.targets || []
      var rows = prepared.rows || []
      if (targets.length === 0) return
      if (root.accountId !== account || !root.ready || intents.generation !== prepared.generation) {
        intents.settle(account, actionQuery, prepared.token, rows, function() {}, prepared.generation)
        return
      }
      root.applyIntentView(prepared.view, actionQuery, selectedBefore)
      var invalidates = prepared.invalidatesPage === true || parameters.opaqueQuery
      if (root.cacheKey === actionQuery && invalidates) root.nextPageToken = ""
      if (root.cacheKey === actionQuery && !interrupted) root.rememberList()
      var optimisticToken = invalidates ? "" : oldPageToken
      function done(payload, failure, failedIds) {
        var failed = failure ? (Array.isArray(failedIds) ? failedIds : rows) : []
        intents.settle(account, actionQuery, prepared.token, failed, function(settled, settleError) {
          if (root.accountId !== account || intents.generation !== prepared.generation) return
          root.pendingAction = ""
          root.pendingActionQuery = ""
          var message = failure && Array.isArray(failedIds) && rows.length > 1
            ? Model.batchFailureNote(rows.length, failedIds.length, root.actionLabel(action), failure)
            : String(failure || settleError || "")
          if (failure && settled) root.applyIntentView(settled.view, actionQuery, selectedBefore)
          if (cacheStore.loaded) {
            cacheStore.invalidate(targets, function() {
              if (root.accountId !== account || !settled || !settled.view) return
              cacheStore.putQuery(actionQuery, {
                summaries: root.cacheKey === actionQuery ? root.messages
                  : root.hydrateSummaries(settled.view.messages || []), estimate: estimate,
                nextPageToken: failure && !Array.isArray(failedIds) ? oldPageToken : optimisticToken})
            })
          }
          if (message !== "") root.fail(message)
          else if (!quiet) {
            if (allRead) root.note(Model.markAllReadNote(rows.length, prepared.expanded === true))
            else root.note(rows.length > 1 ? Model.batchNote(rows.length, root.actionLabel(action)) : root.actionLabel(action))
          }
          root.refreshCounts()
          root.runQueuedAction()
          if (root.resumeDeferredListLoad(actionQuery, message)) return
          if (root.cacheKey === actionQuery && (interrupted || invalidates || message !== ""))
            root.loadMessages(false, true, message)
          else if (root.active && root.cacheKey !== actionQuery) root.loadMessages(false, true, "")
        }, prepared.generation)
      }
      function dispatch() {
        if (root.accountId !== account || !root.ready || intents.generation !== prepared.generation || !root.api) { done(null, "Account changed"); return }
        stopLiveList()
        root.pendingActionQuery = actionQuery
        root.pendingAction = action
        var change = prepared.change || {add: [], remove: []}
        if ((action === "trash" || action === "untrash") && rows.length > 1) {
          var remaining = rows.length
          var failures = []
          var firstError = ""
          function replyFor(rowId) {
            return function(payload, error) {
              if (error) { failures.push(rowId); if (firstError === "") firstError = String(error) }
              remaining--
              if (remaining === 0) done(null, firstError, failures)
            }
          }
          for (var r = 0; r < rows.length; r++) {
            var rowTargets = prepared.targetsOf[rows[r]] || [rows[r]]
            var sent = rowTargets.length > 1 ? rowTargets : rowTargets[0]
            if (action === "trash") root.api.trashMessage(sent, replyFor(rows[r]))
            else root.api.untrashMessage(sent, replyFor(rows[r]))
          }
        } else if (action === "trash") root.api.trashMessage(targets.length > 1 ? targets : targets[0], done)
        else if (action === "untrash") root.api.untrashMessage(targets.length > 1 ? targets : targets[0], done)
        else if (targets.length > 1) root.api.batchModify(targets, change.add, change.remove, done)
        else root.api.modifyMessage(targets[0], change.add, change.remove, done)
      }
      if (root.pendingAction !== "") root.queueAction(ids.join(","), action, actionQuery, quiet, memberOnly, dispatch, function(intoToken) {
        intents.coalesce(account, actionQuery, prepared.token, intoToken, prepared.generation)
      }, prepared.token, parameters.sourceLabelId)
      else dispatch()
    })
    return true
  }

  // What is on screen, written back to the query cache.
  //
  // An action changes `messages` and used to change nothing else, so the copy
  // on disk still said what the mailbox looked like before it. Anything that
  // paints from that copy — the next `loadMessages`, a mailbox switched away
  // from and back, the window reopened — put the old state back on screen: a
  // message read a moment ago, bold again. The live load corrects it a moment
  // later, which is what made it look intermittent rather than broken.
  function rememberList() {
    if (!listLoaded || !cacheStore.loaded) return
    cacheStore.putQuery(cacheKey, ({
      summaries: messages,
      estimate: resultEstimate,
      nextPageToken: nextPageToken
    }))
  }

  function actionLabel(action) {
    if (action === "archive") return "Archived"
    if (action === "trash") return "Moved to trash"
    if (action === "untrash") return "Restored"
    if (action === "star") return "Starred"
    if (action === "unstar") return "Unstarred"
    if (action === "markRead") return "Marked read"
    if (action === "markUnread") return "Marked unread"
    if (action === "unarchive") return "Moved to Inbox"
    if (action === "spam") return "Reported as spam"
    // Named, not "Moved": the destination was chosen a keystroke ago from a
    // list of thirty, and a note that does not say which one leaves the only
    // question the user has -- did it go where I meant? -- unanswered.
    var target = Model.labelTarget(action)
    if (target !== "") return "Moved to " + labelName(target)
    return "Done"
  }

  // The star of whatever this id is: a row, or a member of one open in the
  // reader. A member has no row of its own — the list is one row per
  // conversation — so looking only in `messages` made the reader's star a
  // silent no-op on every stop but the representative's. What the button draws
  // is what it toggles: a row's star is the conversation's, a member's is the
  // one message's, and `act` sends each to the scope its verb has.
  function summaryOf(id) {
    var known = Model.messageById(messages, previewMessages, id)
    if (known) return known
    return memberSummaries[String(id || "")] || null
  }

  // A label id is what the provider wants and what the caches key on; a name
  // is what the person who pressed `v` picked. Falling back to the id keeps a
  // note honest when the label list has not arrived rather than printing
  // nothing where the destination should be -- and on IMAP the two are the
  // same string anyway, because a folder's id is its name.
  function labelName(labelId) {
    var index = Model.indexById(labels, labelId)
    return index >= 0 ? labels[index].name : labelId
  }

  function toggleStar(id) {
    var summary = summaryOf(id)
    if (!summary) return
    act(id, summary.starred ? "unstar" : "star")
  }

  function toggleRead(id) {
    var summary = summaryOf(id)
    if (!summary) return
    act(id, summary.unread ? "markRead" : "markUnread")
  }

  function markAllRead() {
    return runNativeAction([], "markRead", false, false, true)
  }

  function actMany(ids, action) { return batchAction.run(ids, action) }

  BatchAction {
    id: batchAction
    account: root
    intents: intents
  }

  Intents {
    id: intents
    account: root
  }

  // ---------------------------------------------------------------- reply

  // Loads the original bytes before a forward can claim it includes them.
  // Gmail fetches each part; IMAP reads the same part from the full message.
  function loadAttachments(messageId, attachments, callback) {
    var listed = Array.isArray(attachments) ? attachments : []
    if (listed.length === 0) {
      if (typeof callback === "function") callback([], "")
      return []
    }
    var remaining = listed.length
    var loaded = new Array(listed.length)
    var handles = []
    var firstError = ""
    for (var i = 0; i < listed.length; i++) {
      (function(index) {
        var source = listed[index] || ({})
        handles.push(api.getAttachment(messageId, String(source.attachmentId || ""),
          function(data, error) {
            if (error && firstError === "")
              firstError = "Could not include " + String(source.filename || "an attachment")
                + ": " + error
            loaded[index] = ({
              filename: String(source.filename || "attachment"),
              mimeType: String(source.mimeType || "application/octet-stream"),
              size: Math.max(0, Math.floor(Number(source.size) || 0)),
              data: String(data || "")
            })
            remaining--
            if (remaining === 0 && typeof callback === "function")
              callback(loaded, firstError)
          }))
      })(i)
    }
    return handles
  }

  // Opens only after the user asks. The provider hands back base64url bytes;
  // the backend writes them to a private runtime file before the desktop opens
  // the file with its registered application.
  function openAttachment(messageId, attachment) {
    var source = attachment || ({})
    if (!ready) {
      fail("Sign in before opening an attachment")
      return
    }
    if (String(messageId || "") === "" || String(source.attachmentId || "") === "") {
      fail("That attachment is not available")
      return
    }
    clearNotice()
    loadAttachments(messageId, [source], function(loaded, error) {
      if (error || !loaded || loaded.length === 0) {
        root.fail(error || "That attachment could not be loaded")
        return
      }
      var file = loaded[0]
      if (!root.backend || !root.backend.ready) {
        root.fail("Mail backend unavailable")
        return
      }
      root.backend.call("attachment.store", {
        filename: String(file.filename || "attachment"), data: String(file.data || ""), open: true
      }, function(result, failure) {
        if (!root) return
        if (failure || !result || !result.path) {
          root.fail(failure && failure.message === "attachment_open_refused"
            ? "That attachment is not something this can open" : "That attachment could not be opened")
          return
        }
        Quickshell.execDetached(["xdg-open", String(result.path)])
        root.note("Opening " + String(file.filename || "attachment"))
      })
    })
  }

  // Keeping an attachment rather than opening it once.
  //
  // The same shape as `openAttachment` because it is the same journey up to
  // the last step: sign-in, then the provider's own fetch, then Rust stores it.
  // Saving returns the path, which the
  // notice repeats, because a saved file nobody can find is not saved.
  function saveAttachment(messageId, attachment) {
    var source = attachment || ({})
    if (!ready) {
      fail("Sign in before saving an attachment")
      return
    }
    if (String(messageId || "") === "" || String(source.attachmentId || "") === "") {
      fail("That attachment is not available")
      return
    }
    // One save at a time for one attachment. A download arrow is a single
    // click, and a double one used to start a second fetch that the script
    // then dutifully numbered: two identical files in Downloads, and a notice
    // that read the same both times, so nothing said it had happened.
    var key = String(source.attachmentId)
    if (savingAttachmentIds[key]) return
    markSavingAttachment(key, true)
    clearNotice()
    note("Saving " + String(source.filename || "attachment"))
    loadAttachments(messageId, [source], function(loaded, error) {
      if (error || !loaded || loaded.length === 0) {
        root.markSavingAttachment(key, false)
        root.fail(error || "That attachment could not be loaded")
        return
      }
      var file = loaded[0]
      if (!root.backend || !root.backend.ready) {
        root.markSavingAttachment(key, false)
        root.fail("Mail backend unavailable")
        return
      }
      root.backend.call("attachment.store", {
        filename: String(file.filename || "attachment"), data: String(file.data || ""), open: false
      }, function(result, failure) {
        if (!root) return
        root.markSavingAttachment(key, false)
        if (failure || !result || !result.path) {
          root.fail("That attachment could not be saved")
          return
        }
        // The name first, then the folder. `unique_path` numbers a name that
        // is already taken, so the file on disk is not always the one the row
        // shows — and reporting only the folder left the reader opening last
        // month's `invoice.pdf` believing it was the one just saved. The
        // notice elides from the right, so the part that can differ from what
        // was clicked has to come before the part that cannot.
        var saved = String(result.path || "")
        var at = saved.lastIndexOf("/")
        root.note(at > 0
          ? "Saved " + saved.substring(at + 1) + " to " + saved.substring(0, at)
          : "Saved")
      })
    })
  }

  // Which attachments are being saved right now, so the row that asked can
  // show it and refuse a second click. Re-assigned rather than written into: a
  // binding on a `var` does not notice a key appearing inside the object it is
  // already holding.
  function markSavingAttachment(key, saving) {
    var next = ({})
    for (var id in savingAttachmentIds)
      if (id !== key) next[id] = true
    if (saving) next[key] = true
    savingAttachmentIds = next
  }

  // One entry point for every kind of outgoing message. Reply, reply-all and
  // forward differ only in what the compose window puts in the fields, which
  // is where that decision belongs.
  // Every way out of here that is not a delivery emits `replyFailed`, because
  // by this point `deliverPending` has dropped the queued payload and the
  // composer is parked: the message exists only in the draft the panel is
  // holding, and a return that says nothing throws it away. The mailbox can
  // stop being ready during the undo window — a reload, a sign-out — so the
  // guards are reachable and not only the transport's own error.
  function reportSendFailure(error, sendId) {
    fail(error)
    // A zero-delay send can be rejected synchronously by a provider before
    // ComposeView has returned from service.send() and parked its accepted
    // draft. Cross the event-loop boundary so every terminal signal observes
    // the same state as an ordinary network reply.
    Qt.callLater(function() {
      if (root) root.replyFailed(String(sendId || ""))
    })
  }

  function reportSendSuccess(result, sendId) {
    // The sent copy is filed after the send has answered, so how the filing
    // went is a footnote on a success rather than a failure of one: the note
    // says what happened to the copy, and the reply still counts as sent.
    var warning = result && result.warning ? String(result.warning) : ""
    note(warning !== "" ? warning : "Sent")
    // Success has the same ordering requirement as failure: a provider may
    // finish locally, but the composer owns parking after send() returns.
    Qt.callLater(function() {
      if (root) root.replySent(String(sendId || ""))
    })
  }

  function sentDraftRemoved(draftId) {
    if (Model.indexById(messages, draftId) >= 0) {
      messages = Model.removeById(messages, draftId)
      rememberList()
    }
    if (selectedId === draftId) clearSelection()
    refreshCounts()
  }

  function deliverPending() { return sendQueue.deliverAll() }

  function undoSend(callback) { return sendQueue.undoLatest(callback) }

  SendQueue {
    id: sendQueue
    account: root
  }

  // A mailbox whose token was just refused is not ready until the next
  // lookup answers — and the next lookup is asked for by the next request.
  // A save or a send that arrived in that window failed as "not ready" for
  // a mailbox that was signed in a second ago. So the credentials are asked
  // for first, which is what any other request does, and the work goes on
  // once they are back; a mailbox with nothing to look up fails at once.
  function whenReady(callback) {
    if (ready) { callback(true); return }
    if (!auth || !auth.configured || auth.loginBusy || typeof auth.withCredentials !== "function") {
      callback(false)
      return
    }
    auth.withCredentials(function(credentials, error) {
      if (!root) return
      callback(!!credentials && root.ready)
    })
  }

  function saveDraft(fields, callback) {
    if (!ready) {
      whenReady(function(ok) {
        if (!root) return
        if (ok) root.saveDraft(fields, callback)
        else if (typeof callback === "function") callback(null, "The mailbox is not ready to save drafts")
      })
      return null
    }
    if (!api || typeof api.saveDraft !== "function") {
      if (typeof callback === "function") callback(null, "The mailbox is not ready to save drafts")
      return null
    }
    var values = fields || ({})
    var from = String(values.from || "").trim()
    var alias = from === "" ? null : Api.sendAsFor(availableSendAsAliases, from)
    if (from !== "" && !alias) {
      if (typeof callback === "function") callback(null, "Choose a valid From address")
      return null
    }
    var composeFields = ({
      from: from,
      fromName: alias ? String(alias.displayName || "") : "",
      // What the generated Message-ID takes its domain from when the draft
      // names no From of its own.
      accountAddress: ownAddress,
      to: String(values.to || "").trim(),
      cc: String(values.cc || "").trim(),
      bcc: String(values.bcc || "").trim(),
      replyTo: String(values.replyTo || "").trim(),
      signature: String(values.signature || ""),
      signatureHtml: String(values.signatureHtml || ""),
      subject: String(values.subject || ""),
      body: String(values.body || ""),
      attachments: Array.isArray(values.attachments) ? values.attachments : [],
      threadId: values.threadId,
      inReplyTo: values.inReplyTo,
      references: values.references,
      draftId: String(values.draftId || "")
    })
    var handle = {aborted: false, children: []}
    var account = accountId
    if (!backend) { if (typeof callback === "function") callback(null, "Mail backend is unavailable"); return handle }
    backend.call("message.compose", {fields: composeFields}, function(payload, composeError) {
      if (handle.aborted || account !== root.accountId) return
      if (composeError || !payload) {
        if (typeof callback === "function") callback(null, "Could not prepare this draft")
        return
      }
      var child = root.api.saveDraft(payload, function(saved, error) {
      if (handle.aborted || account !== root.accountId) return
      if (typeof callback === "function") callback(saved, error)
      // The Drafts list on screen is what the server had before the save: the
      // copy replaced is gone there and the new one is not yet listed, so
      // a list left as it was showed both — the old row until the next poll,
      // and a second row for every save. Read it again from the server now.
      if (!error && root && root.mailboxKey === "drafts") {
        root.listSerial++
        root.nextPageToken = ""
        root.loadMessages(false, true, "")
      } else if (!error && root) {
        root.refreshCounts()
      }
      })
      if (child) handle.children.push(child)
    })
    return handle
  }


  readonly property string sendSession: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)

  function send(fields, sendId, order) {
    var id = String(sendId || "")
    if (id === "") {
      sendQueue.serial += 1
      id = "send-" + sendSession + "-" + sendQueue.serial
    }
    if (!ready) {
      // Asked for its credentials first, like a save: a token refused a
      // moment ago is looked up again rather than the send refused.
      whenReady(function(ok) {
        if (!root) return
        if (ok) root.send(fields, id, order)
        else root.reportSendFailure("The mailbox is not ready to send", id)
      })
      return id
    }
    var values = fields || ({})
    var files = Array.isArray(values.attachments) ? values.attachments : []
    var hasFiles = false
    for (var fi = 0; fi < files.length; fi++) {
      if (files[fi] && (files[fi].data || files[fi].path)) hasFiles = true
    }
    var body = String(values.body || "").trim()
    if (body === "" && !hasFiles) {
      fail("Write something before sending")
      return false
    }
    var to = String(values.to || "").trim()
    if (to === "") {
      fail("Add a recipient first")
      return false
    }
    // The display name is read back off the alias list rather than taken from
    // the compose form: the list is what `isSendAsAllowed` just checked, so the
    // name on the message cannot disagree with the address that was allowed.
    var from = String(values.from || "").trim()
    var alias = from === "" ? null : Api.sendAsFor(availableSendAsAliases, from)
    if (from !== "" && !alias) {
      fail("Choose a valid From address")
      return false
    }
    var composeFields = ({
      from: from,
      fromName: alias ? String(alias.displayName || "") : "",
      // What the generated Message-ID takes its domain from when the compose
      // window states no From and the provider fills one in for itself.
      accountAddress: ownAddress,
      to: to,
      cc: String(values.cc || "").trim(),
      bcc: String(values.bcc || "").trim(),
      replyTo: String(values.replyTo || "").trim(),
      signature: String(values.signature || ""),
      signatureHtml: String(values.signatureHtml || ""),
      subject: String(values.subject || ""),
      body: body,
      attachments: Array.isArray(values.attachments) ? values.attachments : [],
      threadId: values.threadId,
      inReplyTo: values.inReplyTo,
      references: values.references,
      // The draft this send replaces, carried through the undo window with the
      // rest of the payload. Dropping it here is what left a sent message's
      // draft behind on every provider.
      draftId: String(values.draftId || "")
    })
    var account = accountId
    if (!backend) { reportSendFailure("Mail backend is unavailable", id); return "" }
    backend.call("message.compose", {fields: composeFields}, function(payload, error) {
      if (account !== root.accountId) return
      if (error || !payload) { root.reportSendFailure("Could not prepare this message", id); return }
      payload.draftId = String(values.draftId || "")
      payload.sendId = id
      if (!sendQueue.park(payload, id, order)) root.reportSendFailure("Could not queue this message", id)
    })
    return id
  }

  signal replySent(string sendId)

  // A send that did not happen. The panel answers it by putting the parked
  // draft back in front of the writer, which is the only remaining copy.
  signal replyFailed(string sendId)

  // ------------------------------------------------------------------ RSVP

  // See `Rsvp.qml`: the account file is at its size ceiling.
  function rsvp(response) { rsvpAction.run(response) }
  readonly property alias bodies: bodyCache

  Rsvp {
    id: rsvpAction
    account: root
  }

  // ----------------------------------------------------------- unsubscribe

  // See `Unsubscribe.qml`: the account file is at its size ceiling.
  function unsubscribe() { unsubscribeAction.run() }

  Unsubscribe {
    id: unsubscribeAction
    account: root
  }

  // -------------------------------------------------------- notifications

  property string notificationForeground: ""
  property string notificationAccent: ""
  signal notificationActivated(string targetAccountId, string messageId)

  NewMailNotification {
    id: newMailNotification
    pluginDir: root.pluginDir
    accountId: root.accountId
    notificationForeground: root.notificationForeground
    notificationAccent: root.notificationAccent
    onActivated: function(accountId, messageId) {
      root.notificationActivated(accountId, messageId)
    }
  }

  function notify(arrivals) { newMailNotification.notify(arrivals) }
  readonly property alias labelActions: labelActions
  // The watched ids after a rename or move changed what they name.
  signal monitoredMigrated(var ids)

  LabelActions {
    id: labelActions
    account: root
  }

  // ------------------------------------------------------------ navigation

  function selectMailbox(key) {
    providerLabelSerial++
    providerQuerySerial++
    if (mailboxKey === key && searchQuery === "" && rawQuery === "") return
    mailboxKey = String(key || "inbox")
    searchQuery = ""
    searchRaw = ""
    rawQuery = ""
    rawLabelId = ""
    clearSelection()
    messages = []
    previewMessages = []
    listLoaded = false
    loadMessages(false)
  }

  // `raw`: an app-built query in the provider's words, sent as it is.
  function search(text, raw) {
    providerLabelSerial++
    var serial = ++providerQuerySerial
    var query = String(text || "").trim()
    var built = String(raw || "").trim()
    if (query === searchQuery && built === searchRaw && rawQuery === "") return
    if (query !== "" && built === "") {
      if (!backend || !backend.ready) return
      var boundAccount = accountId
      var input = providerQueryInput
      backend.call("providers.resolve", {provider: providerId, operation: "query", mailbox: mailboxKey,
        search: query, defaultQuery: defaultQuery}, function(result, error) {
        if (serial !== root.providerQuerySerial || boundAccount !== root.accountId
            || input !== root.providerQueryInput) return
        if (error) { root.note("Could not prepare this search"); return }
        root.applySearch(query, String((result || {}).value || ""))
      })
      return
    }
    applySearch(query, built)
  }

  function applySearch(query, built) {
    searchQuery = query
    searchRaw = built
    rawQuery = ""
    rawLabelId = ""
    clearSelection()
    messages = []
    listLoaded = false
    loadMessages(false)
  }

  // A label on Gmail, a folder on IMAP. One entry point either way, because the
  // sidebar draws one kind of row.
  function selectLabel(name, labelId) {
    providerQuerySerial++
    if (!backend || !backend.ready) return
    var serial = ++providerLabelSerial
    var boundAccount = accountId
    var boundProvider = providerId
    backend.call("providers.resolve", {provider: providerId, operation: "labelQuery", value: String(name || "")}, function(result, error) {
      if (serial !== root.providerLabelSerial || boundAccount !== root.accountId || boundProvider !== root.providerId || error) return
      var query = String((result || {}).value || "")
      var id = String(labelId || "")
      if (query === "" || (query === root.rawQuery && id === root.rawLabelId)) return
      root.searchQuery = ""
      root.searchRaw = ""
      root.rawQuery = query
      root.rawLabelId = id
      root.clearSelection()
      root.messages = []
      root.listLoaded = false
      root.loadMessages(false)
    })
  }

  // Which web UI, and where in it, is the provider's answer rather than this
  // file's. It used to be a Gmail call, which meant the day a second provider
  // declared a web UI it would have opened Gmail's.
  function openProviderUrl(operation, value) {
    if (!backend || !backend.ready) return
    var boundAccount = accountId
    var boundProvider = providerId
    backend.call("providers.resolve", {provider: providerId, operation: operation, value: String(value || "")}, function(result, error) {
      if (error || boundAccount !== root.accountId || boundProvider !== root.providerId) return
      var url = String((result || {}).value || "")
      if (url !== "") Quickshell.execDetached(["xdg-open", url])
    })
  }

  function openInBrowser(id) { openProviderUrl("webMessageUrl", id) }
  function openWebInbox() { openProviderUrl("webBoxUrl", effectiveQuery) }

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

  // What every provider does once it is signed in. Named rather than repeated
  // in each component, because the two sign-ins differ in everything except
  // what has to happen afterwards.
  function afterSignIn() {
    loadProfile()
    loadLabels()
    loadSendAs()
    refreshCounts()
    loadMessages(false)
  }

  function signIn() { if (auth) auth.beginLogin() }
  function withAccessToken(callback) {
    if (providerId !== "gmail" || !auth) {
      callback("", "This is not a Google account")
      return
    }
    auth.withAccessToken(callback)
  }
  function cancelSignIn() { if (auth) auth.cancelLogin() }

  // The setup form's entry point for a password provider. Gmail has no use for
  // it — its sign-in is a browser — and returns false rather than pretending.
  function signInWithPassword(secret) {
    if (!auth || !Provider.usesPassword(providerId)) return false
    return auth.signIn(secret)
  }

  function signOut() {
    intents.clear()
    queuedActions = []
    actionPreparations = 0
    pendingAction = ""
    pendingActionQuery = ""
    if (auth) auth.logout()
    messages = []
    labels = []
    sendAsAliases = []
    sendAsLoading = false
    sendAsLoaded = false
    profile = null
    inboxUnread = 0
    listLoaded = false
    seenIds = ({})
    arrivalFloor = 0
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
    loadSendAs()
    if (!listLoaded) loadMessages(false)
    else refresh()
  }

  onReadyChanged: {
    if (!ready) return
    loadProfile()
    loadSendAs()
    refreshCounts()
    if (!active) return
    loadLabels()
    if (windowOpen && !listLoaded) loadMessages(false)
  }

  // Becoming the account on screen is what earns a list.
  onActiveChanged: {
    if (!active || !ready) return
    loadLabels()
    loadSendAs()
    if (!listLoaded) loadMessages(false)
    else refresh()
  }

  // The address is only known after the first profile read, and it is what the
  // cache file and the keyring entry are named after — so the id is filled in
  // here rather than waiting for the account list to be rewritten with it.
  //
  // **Named the way the list names it**, through the one function that decides.
  // An id is the bare address only for the default provider; every other one
  // carries its provider in front. Assigning the address alone is an assignment
  // rather than a binding, so it also *replaced* the id the list had given —
  // and `Service.findAccount` compares the two. A HEY mailbox therefore called
  // itself `you@hey.com` while the list called it `hey:you@hey.com`, nothing
  // matched, and switching to it silently fell back to the first mailbox.
  onAccountEmailChanged: {
    if (accountEmail !== "" && accountId === "")
      accountId = Accounts.accountId(accountEmail, providerId)
  }

  signal accountIdentified(string email)

  // The server settings a sign-in learned, for the account list to write onto
  // this account's entry. The same shape as `accountIdentified`: a fact the
  // sign-in found out that belongs on the entry, which only the list owns.
  // This object is built *from* the entry — its `jmapSettings` come down from
  // it — so writing here would be writing to a copy that the next read of the
  // file replaces, and a mailbox that had signed in perfectly well would open
  // on its setup page again after every restart.
  signal serverSettingsLearned(var jmap)

  // Which pair of objects this account actually runs on. Both loaders build the
  // same two shapes — something that signs in, and something that fetches — and
  // everything above this point calls them without knowing which it holds.
  //
  // Loaders rather than one of each kept side by side: an AuthManager probes
  // for socat and reads the keyring the moment it exists, and an IMAP account
  // has no business doing either.
  Loader {
    id: authLoader
    sourceComponent: root.providerId === "imap" ? imapAuthComponent
      : (root.providerId === "jmap" ? jmapAuthComponent
      : (root.providerId === "outlook" ? outlookAuthComponent
        : (root.providerId === "hey" ? heyAuthComponent : gmailAuthComponent)))
  }

  // The client takes the manager as a required property, so it cannot be built
  // until there is one.
  // A test's stand-in for the provider.
  property Component clientOverride: null

  Loader {
    id: apiLoader
    active: !!authLoader.item
    sourceComponent: root.clientOverride ? root.clientOverride
      : (root.providerId === "imap" || root.providerId === "outlook"
        ? imapClientComponent
        : (root.providerId === "jmap" ? jmapClientComponent
          : (root.providerId === "hey" ? heyClientComponent : gmailClientComponent)))
  }

  Component {
    id: gmailAuthComponent

    AuthManager {
      backend: root.backend
      pluginDir: root.pluginDir
      accountId: root.accountId
      mayAdoptLegacyToken: root.mayAdoptLegacyToken
      oauthPort: root.oauthPort
      loginHint: root.accountEmail

      onLoginSucceeded: {
        root.lastError = lastError
        root.afterSignIn()
      }
      onLoggedOut: root.clearNotice()
      onCredentialsSaved: root.note("OAuth client saved")
      onSessionUnavailable: function(reason) { root.fail(reason) }
    }
  }

  Component {
    id: imapAuthComponent

    ImapAuth {
      backend: root.backend
      pluginDir: root.pluginDir
      accountId: root.accountId
      // Normalised here rather than trusted from the file: a host that arrived
      // in a hand-edited accounts.json has to pass the same check as one the
      // user typed into the form.
      settings: Imap.normalizeSettings(root.imapSettings)

      onLoginSucceeded: {
        root.lastError = lastError
        root.afterSignIn()
      }
      onLoggedOut: root.clearNotice()
      onCredentialsSaved: root.note("Mailbox saved")
      onSessionUnavailable: function(reason) { root.fail(reason) }
    }
  }

  Component {
    id: jmapAuthComponent

    JmapAuth {
      backend: root.backend
      pluginDir: root.pluginDir
      accountId: root.accountId
      // Discovery runs from the address's domain when no server was typed, so
      // the address is part of this object's input rather than something it
      // learns afterwards.
      address: root.configuredEmail
      settings: Accounts.makeJmapSettings(root.jmapSettings)

      // The URL that answered, the scheme that worked and the account id, over
      // the settings this object was given. Up to the list rather than onto
      // this object: `configured` reads `settings`, and `settings` is bound to
      // the entry, so the entry is the only place the answer can land and stay.
      onSessionVerified: function(result) {
        root.serverSettingsLearned(Accounts.jmapSettingsAfterSignIn(settings, result))
      }
      onLoginSucceeded: {
        root.lastError = lastError
        root.afterSignIn()
      }
      onLoggedOut: root.clearNotice()
      onCredentialsSaved: root.note("Mailbox saved")
      onSessionUnavailable: function(reason) { root.fail(reason) }
    }
  }

  Component {
    id: heyAuthComponent

    HeyAuth {
      backend: root.backend
      pluginDir: root.pluginDir
      accountId: root.accountId

      onLoginSucceeded: {
        root.lastError = lastError
        root.afterSignIn()
      }
      onLoggedOut: root.clearNotice()
      onCredentialsSaved: root.note("Mailbox saved")
      onSessionUnavailable: function(reason) { root.fail(reason) }
    }
  }

  Component {
    id: outlookAuthComponent

    OutlookAuth {
      backend: root.backend
      pluginDir: root.pluginDir
      accountId: root.accountId
      configuredClientId: root.oauthClientId
      configuredEmail: root.configuredEmail
      entrySettings: root.imapSettings

      onLoginSucceeded: {
        root.lastError = lastError
        root.afterSignIn()
      }
      onLoggedOut: root.clearNotice()
      onSessionUnavailable: function(reason) { root.fail(reason) }
      onGraphRefused: function(reason) { root.note(reason) }
    }
  }

  Component {
    id: gmailClientComponent
    GmailApiClient { auth: authLoader.item; backend: root.backend }
  }

  Component {
    id: heyClientComponent
    HeyClient { auth: authLoader.item; backend: root.backend }
  }

  Component {
    id: imapClientComponent
    ImapClient {
      auth: authLoader.item
      email: root.configuredEmail
      backend: root.backend
    }
  }

  Component {
    id: jmapClientComponent
    JmapClient {
      backend: root.backend
      auth: authLoader.item
      email: root.configuredEmail
      // The session object is the server's answer rather than the account's
      // settings, so it is kept beside the query results rather than in
      // accounts.json.
      cache: cacheStore

      // The one provider that is told rather than asked. The plan names which
      // of the poll's own doors to knock on: `loadLabels()` re-reads the
      // mailbox list and re-binds the refusals; `refresh()` brings the counts,
      // badge, notification and list exactly as on a tick. Labels first, so a
      // message in a mailbox the rail has never heard of is not counted
      // against a row that is about to appear.
      onRemoteChanged: function(plan) {
        if (!root.ready || !plan) return
        if (plan.mailboxes) root.loadLabels()
        if (plan.mail) root.refresh()
      }
    }
  }

  CacheStore {
    id: cacheStore
    backend: root.backend
    accountId: root.accountId
    // The file lands after the window is already up, so the first paint waits
    // for it rather than the other way round.
    onRestored: {
      if (!root.profile && store.profile) root.profile = store.profile
      if (root.labels.length === 0 && store.labels.length > 0) root.labels = store.labels
      if (root.messages.length === 0) root.paintFromCache()
    }
  }

  BackendSync {
    id: backendSync
    backend: root.backend
    enabled: root.ready && root.nativePolling
    accountId: root.accountId
    query: Provider.unreadQuery(root.providerId)
    intervalSec: root.refreshIntervalSec
    pageSize: root.maxMessages
    onUpdated: function(snapshot) {
      if (snapshot.error) return
      root.summarizeResources(snapshot.messages || [], function(prepared, preparationError) {
      if (preparationError) return
      var before = root.inboxUnread
      root.inboxUnread = snapshot.estimate
      var summaries = []
      var payloads = prepared
      var now = new Date()
      for (var i = 0; i < payloads.length; i++) {
        var summary = payloads[i].nativeSummary
        summary.unread = true
        summaries.push(summary)
      }
      if (summaries.length > 0 || snapshot.estimate === 0) root.previewMessages = summaries
      var fingerprint = String(snapshot.fingerprint || "")
      var changed = fingerprint !== "" && fingerprint !== root.syncFingerprint
      root.syncFingerprint = fingerprint
      var first = !root.countPrimed
      root.countPrimed = true
      if ((first || changed || snapshot.estimate > before || (root.active && root.windowOpen)) && !root.listLoading)
        root.loadMessages(false)
      })
    }
  }

  BodyCache {
    id: bodyCache
    backend: root.backend
    pluginDir: root.pluginDir
    accountId: root.accountId
  }

  // The loader has to have built the manager first, which it has not when this
  // component completes.
  onAuthChanged: if (auth) auth.restoreSession()

  // Coalesce quick image completions without waiting for a slow next request.
  Timer {
    id: imagePaintTimer
    interval: 100
    repeat: false
    onTriggered: root.flushRemoteImages()
  }

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
    running: root.ready && !root.nativePolling
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
