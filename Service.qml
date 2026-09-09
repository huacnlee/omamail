import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "account"
import "calendar"
import "agent"
import "agent/Agent.js" as Agent

import "account/Accounts.js" as Accounts
import "account/Model.js" as Model
import "account/Unified.js" as Unified
import "account/Conversation.js" as Conversation
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
  // Modern Omarchy strips private manifest metadata for third-party plugins.
  // Helpers belong beside this component, independently of host internals.
  readonly property string pluginDir: decodeURIComponent(String(Qt.resolvedUrl("."))
    .replace(/^file:\/\//, "")).replace(/\/$/, "")
  // Shown in the empty reader, so a screenshot in a bug report says which build
  // it came from. The shell's manifest validation requires both fields, so a
  // loaded plugin always has them; the fallbacks are for a harness that
  // constructs the service with a stub manifest, and an empty version makes the
  // interface say nothing rather than guess a number.
  readonly property string pluginName: manifest && manifest.name
    ? String(manifest.name) : "Omamail"
  readonly property string version: manifest && manifest.version
    ? String(manifest.version) : ""

  readonly property var defaultSettingValues: ({
    refreshIntervalSec: 120,
    maxMessages: 25,
    heavyMessageRendering: Html.HEAVY_MESSAGE_RENDERING_DEFAULT,
    contentDirection: Direction.MODE_DEFAULT,
    defaultQuery: "in:inbox",
    notifyNewMail: "On",
    oauthPort: 9481,
    undoSendSeconds: 10,
    unifiedCalendarView: false,
    showBarIcon: true,
    unifiedMailboxes: false,
    previewOnCursor: false,
    markReadDelaySec: 2
  })
  property var settings: defaultSettingValues
  readonly property int undoSendSeconds: Outbox.normalizeDelay(
    settings ? settings.undoSendSeconds : Outbox.DEFAULT_DELAY_SECONDS)
  readonly property bool alwaysRenderHeavyMessages: Html.alwaysRenderHeavyMessages(
    settings ? settings.heavyMessageRendering : null)
  readonly property bool notifyNewMail: String(settings ? settings.notifyNewMail : "On") !== "Off"
  // System AI is always reachable. The launcher explains missing setup.
  readonly property bool hasAgent: true
  readonly property string agentError: agentContext.error !== "" ? agentContext.error : agentRunner.lastError
  readonly property bool agentStarting: agentContext.busy || agentRunner.starting
  // The open account's jobs by message id — another account's job about
  // the same id is not this row's, however the id reads.
  readonly property var agentJobs: agentRunner.byMessage
  // Whether any job wants the owner, and which messages' jobs do: what the
  // agent buttons pulse for. Opening a job's popup or card is what stops it.
  readonly property bool agentAttention: agentRunner.attention
  readonly property var agentAttentionByMessage: agentRunner.attentionByMessage
  function agentJobWantsAttention(job) { return Agent.wantsAttention(job, agentRunner.seenIds) }
  function acknowledgeAgentJob(jobId) { agentRunner.acknowledge(jobId) }
  readonly property bool agentBusy: agentRunner.anyActive

  function agentJobFor(messageId, accountId) {
    var target = agentTarget(messageId, accountId)
    return target.owner ? Agent.selectionJob(agentRunner.jobs, [target.id], target.owner.accountId) : null
  }

  function agentHistoryFor(fields, ids, accountId) {
    if (fields && fields.draftKey) {
      var sender = sendHostFor(fields)
      return sender ? Agent.historyFor(agentRunner.jobs, sender.accountId, [], fields.draftKey) : []
    }
    if (!ids || !ids.length) return []
    var target = agentTarget(ids[0], accountId)
    if (!target.owner) return []
    var own = []
    for (var i = 0; i < ids.length; i++) {
      var item = agentTarget(ids[i], accountId)
      if (item.owner !== target.owner) return []
      own.push(item.id)
    }
    return Agent.historyFor(agentRunner.jobs, target.owner.accountId, own, "")
  }

  function agentSelectionJob(ids, accountId) {
    var target = ids && ids.length ? agentTarget(ids[0], accountId) : null
    if (!target || !target.owner) return null
    var own = []
    for (var i = 0; i < ids.length; i++) {
      var item = agentTarget(ids[i], accountId)
      if (item.owner !== target.owner) return null
      own.push(item.id)
    }
    return Agent.selectionJob(agentRunner.jobs, own, target.owner.accountId)
  }

  // Whose message an ask or a cancel is about: the account the popup was
  // opened on, by id, or the one a unified row's id names — never simply
  // the account open when the answer arrives, which may hold a different
  // message under the same id. No id at all means the open account.
  function agentOwner(accountId) {
    var id = String(accountId || "")
    if (id === "") return current
    var owner = findAccount(id)
    if (!owner) {
      agentContext.error = "That mailbox is no longer set up, so AI was not asked."
      if (current) current.fail(agentContext.error)
    }
    return owner
  }

  // A row in the merged view carries its account in its id; a row in one
  // mailbox does not. Either way: the account, and the id it knows.
  function agentTarget(messageId, accountId) {
    var split = Unified.splitUnifiedId(messageId)
    if (split.accountId !== "") return { owner: agentOwner(split.accountId), id: split.id }
    return { owner: agentOwner(accountId), id: String(messageId || "") }
  }

  function askAgent(messageId, prompt, accountId) {
    var target = agentTarget(messageId, accountId)
    if (!target.owner || target.id === "") return false
    return agentContext.request(target.owner, [target.id], prompt)
  }

  // Contextual results, forwarded so a view never
  // reaches past `service`.
  readonly property var agentAllJobs: agentRunner.jobs
  readonly property string agentShownId: agentRunner.shownId
  readonly property string agentShownOutput: agentRunner.shownOutput
  readonly property var agentShownTranscript: agentRunner.shownTranscript

  function showAgentJob(jobId) { agentRunner.show(jobId) }

  // The answer to a question, or a follow-up: a new job that continues the
  // one named, with the runner rebuilding the prompt from it.
  function answerAgent(jobId, answer) {
    if (!hasAgent) return false
    var job = agentRunner.jobFor2(jobId)
    if (!job || !job.canContinue || Agent.isActive(job) || !findAccount(job.accountId)
        || String(answer || "").trim() === "") return false
    agentContext.error = ""
    if (!agentRunner.start(Agent.continuationPayload(job, answer))) return false
    return true
  }

  // One job over several messages, as the list knows them.
  function askAgentMany(ids, prompt, accountId) {
    if (!hasAgent) return false
    // One job is one account's: rows ticked across the merged view are
    // handed over only when they all come from the same mailbox.
    var list = Array.isArray(ids) ? ids : []
    var owner = null
    var own = []
    for (var i = 0; i < list.length; i++) {
      var target = agentTarget(list[i], accountId)
      if (!target.owner) return false
      if (owner && target.owner !== owner) {
        agentContext.error = "Select messages from one mailbox at a time."
        owner.fail(agentContext.error)
        return false
      }
      owner = target.owner
      own.push(target.id)
    }
    if (!owner) return false
    return agentContext.request(owner, own, prompt)
  }

  function forgetAgentJob(jobId) { return agentRunner.forget(jobId) }
  function forgetFinishedAgentJobs() { return agentRunner.forgetFinished() }

  // The composer's asks: the draft as it stands and what to do with it.
  function agentJobsForDraft(fields) {
    var owner = sendHostFor(fields)
    return owner ? Agent.draftJobs(agentRunner.jobs, owner.accountId, fields.draftKey) : []
  }

  function askAgentDraft(fields, ask) {
    var owner = sendHostFor(fields)
    if (!owner || !fields || !fields.draftKey || String(ask || "").trim() === "") return false
    agentContext.error = ""
    return agentRunner.start(Agent.draftPayload(fields, ask, owner.accountEmail, owner.accountId))
  }

  function cancelAgentJob(jobId) {
    var job = agentRunner.jobFor2(jobId)
    if (!job || !Agent.isActive(job) || agentRunner.cancelling) return false
    return agentRunner.cancelById(jobId)
  }

  function cancelAgent(messageId, accountId) {
    var target = agentTarget(messageId, accountId)
    if (!target.owner) return false
    if (!agentRunner.cancel(target.id, target.owner.accountId)) return false
    target.owner.note("Stopping AI")
    return true
  }

  function refreshAgentJobs() { agentRunner.refresh() }
  // Which way a message's own text is read: worked out from the text, or fixed
  // by the reader. The window's chrome is not affected either way — this is a
  // fact about the mail, not about the interface around it.
  readonly property string contentDirection: Direction.normalizeMode(
    settings ? settings.contentDirection : null)
  readonly property bool unifiedCalendarView: !!settings
    && settings.unifiedCalendarView === true
  readonly property bool unifiedMailboxes: !!settings
    && settings.unifiedMailboxes === true

  // Whether the bar draws an envelope for this.
  //
  // A settings file written before this existed keeps its icon because
  // `applySettings` lays every default down first, so a missing key is
  // already the manifest's `true` — the same way `unifiedCalendarView` gets
  // its `false`. What "anything but a stored false" buys instead is the
  // hand-edited `shell.json`: a `"false"` or a `0` in there is somebody's
  // typo rather than an answer given in the interface, and a typo should not
  // be what takes the icon away.
  readonly property bool showBarIcon: !settings || settings.showBarIcon !== false

  // Whether the cursor reaching a message is enough to show it.
  readonly property bool previewOnCursor: !!settings
    && settings.previewOnCursor === true

  // How long the cursor has to stay before a previewed message counts as
  // read. Clamped rather than trusted: this is a hand-editable file, and a
  // negative interval on a Timer never fires at all.
  //
  // A number or nothing, because `Number` reads `null`, `false` and `""` as
  // zero and zero is a real answer here — "mark it read the moment it is
  // previewed". A settings file that lost the key, or holds a word where a
  // count should be, must not be read as somebody having asked for that.
  readonly property int markReadDelaySec: {
    var raw = settings ? settings.markReadDelaySec : 2
    if (typeof raw !== "number") return 2
    var value = Math.floor(raw)
    if (!isFinite(value) || value < 0) return 2
    return Math.min(30, value)
  }

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

  // The default agent's command line, from Settings. Empty is no agent.

  function setShowBarIcon(value) {
    persistSetting("showBarIcon", value === true)
  }

  // One list out of every mailbox, rather than the one that is on screen.
  //
  // Persisted rather than held for the session, because it is a way of reading
  // mail rather than a place in the window: somebody who wants every mailbox
  // at once wants it again tomorrow, and the switcher's own selection already
  // survives a restart.
  function setUnifiedMailboxes(value) {
    persistSetting("unifiedMailboxes", value === true)
  }

  function setPreviewOnCursor(value) {
    persistSetting("previewOnCursor", value === true)
  }

  // The same rule on the way in: what cannot be read as a count is written as
  // the default rather than as the shortest dwell there is.
  function setMarkReadDelaySec(value) {
    var next = Math.floor(Number(value))
    if (!isFinite(next) || next < 0) next = 2
    persistSetting("markReadDelaySec", Math.min(30, next))
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
  readonly property string activeSignature: signatureFor(activeAccountId)

  // The sign-off and the address of a *named* mailbox, which is not always the
  // one on screen: a draft belongs to the mailbox the message it answers
  // arrived in, and in a merged list that is routinely not the active account.
  // Signing B's reply with A's name, or leaving A on the Cc of a reply from B,
  // puts one identity's details into another's outgoing mail.
  //
  // Kept here rather than in the compose view for the same reason
  // `activeSignature` was: the window never reaches into the account list.
  function signatureFor(accountId) {
    var entry = Accounts.find(accountList, String(accountId || ""))
    return entry ? String(entry.signature || "") : ""
  }

  function accountEmailFor(accountId) {
    var entry = Accounts.find(accountList, String(accountId || ""))
    return entry ? String(entry.email || "") : ""
  }
  readonly property string activeSignatureHtml: {
    var entry = Accounts.find(accountList, activeAccountId)
    return entry ? String(entry.signatureHtml || "") : ""
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
    if (next !== current) current = next
    applyLiveHosts()
  }

  // Which mailboxes are live, which is what earns a list.
  //
  // `active` gates every list load there is: `refresh` will not reload an
  // already-loaded list without it, `onActiveChanged` is what asks for the
  // first one, and the poll timer checks it before extending one. Leaving it
  // on the visible account meant a merged list refreshed one mailbox's rows
  // and left the others as they were — counts moved, mail did not. A merged
  // view has every mailbox on screen at once, so every mailbox gets one.
  //
  // `windowOpen` travels with it for the same reason: `refresh` reloads a
  // loaded list only for a mailbox the window is showing.
  function applyLiveHosts() {
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (!host) continue
      // A mailbox part-way through being added has no id and no rows to
      // contribute, so it is live only when it is the one on screen — which
      // is what setup runs in.
      var live = host === current
        || (unified && String(host.accountId || "") !== "")
      host.active = live
      if (live) host.windowOpen = windowOpen
    }
  }

  // Turning the merged view on or off changes which mailboxes are live, and
  // `refreshCurrent` does not run for it: the account on screen has not moved.
  onUnifiedChanged: applyLiveHosts()

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

  function openNotification(accountId, messageId) {
    if (!Accounts.find(accountList, accountId) || !messageId) return
    if (shell && typeof shell.summon === "function")
      shell.summon("omamail", JSON.stringify({ accountId: accountId, messageId: messageId }))
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
    saveAccounts({ allowDrop: true })
    refreshCurrent()
  }

  function removeAccountAt(index) {
    activeIndex = -1
    accountList = Accounts.removeAt(accountList, index)
    saveAccounts({ allowDrop: true })
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

    // A profile may replace a configured alias with its canonical address,
    // or identify this row as a duplicate. Only this row's old id is released;
    // every other persisted mailbox must still survive the following save.
    lastPersistedIds = Accounts.withoutId(lastPersistedIds, String(accounts[index].id || ""))

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

    // Everything but the address is carried over rather than listed field by
    // field: a rebuild that names the fields it keeps silently drops the ones
    // added afterwards, which is how an IMAP account would come back as a
    // Gmail one the first time it learned its own name. The selection stays
    // where it was unless this is the draft on screen, the same as a save.
    var updated = Accounts.replaceAt(accountList, index, withEmail(accounts[index], email))
    if (activeIndex === index)
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

  // What a provider setup form saves: the address, non-secret client or server
  // configuration, and which provider this row is. Written before the secret
  // is tried, so a mailbox that fails to sign in still has its settings to
  // correct rather than an empty form to fill in again.
  // Answers whether the configuration was taken. A refused one — a
  // collision with another mailbox — changes nothing, and the callers that
  // go on to sign in must not: the secret just typed belongs to the mailbox
  // that was refused, not to the one still standing at this row.
  function configureAccount(index, values) {
    var accounts = accountList.accounts
    if (index < 0 || index >= accounts.length) return false
    var raw = values || ({})

    var entry = {}
    for (var key in accounts[index]) entry[key] = accounts[index][key]
    if (raw.provider !== undefined) entry.provider = raw.provider
    if (raw.email !== undefined) entry.email = raw.email
    if (raw.clientId !== undefined) entry.clientId = raw.clientId
    if (raw.clientSecret !== undefined) entry.clientSecret = raw.clientSecret
    if (raw.imap !== undefined) entry.imap = raw.imap
    if (raw.jmap !== undefined) entry.jmap = raw.jmap
    if (raw.label !== undefined) entry.label = raw.label

    // Never rebuild through `add`: a colliding id replaces the *other* row
    // and drops this one, which is how re-authing Proton deleted iCloud.
    if (Accounts.collidingId(accountList, index, entry)) {
      duplicateAccount(String(entry.email || ""))
      return false
    }

    // The selection stays with the row that had it — `Accounts.replaceAt`
    // decides that — and moves to this row only when it is the draft on
    // screen, which is addressed by position because it had no id until now.
    var updated = Accounts.replaceAt(accountList, index, entry)
    var id = Accounts.accountId(entry.email, entry.provider)
    if (id !== "" && activeIndex === index)
      updated = Accounts.setActive(updated, id)
    if (activeIndex === index) activeIndex = -1
    // An address corrected on this row is a new id for the same mailbox, so
    // the old one is released from the persisted set on purpose: the write
    // guard would otherwise read its absence as a mailbox dropped by mistake
    // and refuse every save from here on.
    var oldId = String(accounts[index].id || "")
    if (oldId !== "" && id !== oldId)
      lastPersistedIds = Accounts.withoutId(lastPersistedIds, oldId)
    accountList = updated
    saveAccounts()
    refreshCurrent()
    return true
  }

  // A save that arrives while one is already running is queued, never dropped.
  // Dropping it is what made adding a mailbox undo itself: the new account was
  // never written, and the watcher then read the older file back over it.
  property bool accountsSaveQueued: false
  property bool accountsSaveQueuedAllowDrop: false
  // Ids last successfully loaded or written. `dropsNamedMailbox` only sees
  // memory, so once a buggy save has already dropped a row in memory it will
  // not refuse the write. This snapshot is what stops that reaching disk.
  property var lastPersistedIds: []

  // Identical text is not a write. The editor saves when it is done with
  // rather than on every keystroke, but it is also rebuilt by the write it
  // causes — so the value it hands back on the way out is routinely the one
  // already on disk, and a file round trip for it would be pure cost.
  // The labels the open mailbox watches, and the switch for one of them.
  readonly property var monitoredLabelIds: {
    var entry = Accounts.find(accountList, activeAccountId)
    return entry && Array.isArray(entry.monitored) ? entry.monitored : []
  }

  function toggleMonitored(labelId, accountId) {
    var owner = labelOwner(accountId)
    if (!owner) return
    var next = Accounts.toggleMonitored(accountList, owner.accountId, labelId)
    if (Accounts.serialize(next) === Accounts.serialize(accountList)) return
    accountList = next
    saveAccounts()
    owner.labelActions.refreshMonitored()
  }

  // The watched ids an account's rename or move left behind, written to its
  // entry: a watch follows the folder it named to that folder's new id.
  function setMonitoredIds(index, ids) {
    var account = accountAt(index)
    if (!account) return
    var next = Accounts.setMonitored(accountList, account.accountId, ids)
    if (Accounts.serialize(next) === Accounts.serialize(accountList)) return
    accountList = next
    saveAccounts()
  }

  function setAccountLabel(id, text) {
    var next = Accounts.setLabel(accountList, id, text)
    if (Accounts.serialize(next) === Accounts.serialize(accountList)) return
    accountList = next
    saveAccounts()
  }

  function setAccountSignatureHtml(id, html) {
    var next = Accounts.setSignatureHtml(accountList, id, html)
    if (Accounts.serialize(next) === Accounts.serialize(accountList)) return
    accountList = next
    saveAccounts()
  }

  function setAccountSignature(id, text) {
    var next = Accounts.setSignature(accountList, id, text)
    if (Accounts.serialize(next) === Accounts.serialize(accountList)) return
    accountList = next
    saveAccounts()
  }

  function saveAccounts(opts) {
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
    var allowDrop = !!(opts && opts.allowDrop)
    if (!allowDrop && Accounts.dropsAnyId(lastPersistedIds, writable)) return
    if (accountsWriter.running) {
      accountsSaveQueued = true
      if (allowDrop) accountsSaveQueuedAllowDrop = true
      return
    }
    accountsSaveQueued = false
    accountsSaveQueuedAllowDrop = false
    lastPersistedIds = Accounts.namedIds(writable)
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
    lastPersistedIds = Accounts.namedIds(Accounts.savedOnly(loaded))
  }

  signal accountAdded()

  // ------------------------------------------------------ window preferences
  //
  // Kept beside the account list rather than in plugin settings: those are
  // pushed in from the bar widget and are not the window's to write. Only what
  // the window cannot recompute lives here.

  property bool sidebarCollapsed: false
  // How wide the rail and the list were dragged to, in pixels; 0 is "never
  // dragged", which each pane reads as its own default.
  property real sidebarWidth: 0
  property real listWidth: 0
  // The label paths folded shut in the rail, by path rather than by account:
  // "Archive" folded is a way of reading the rail, and it reads the same in
  // every mailbox that has one.
  property var collapsedFolders: []
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
    sidebarWidth = prefs.sidebarWidth
    listWidth = prefs.listWidth
    collapsedFolders = prefs.collapsedFolders
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
      sidebarWidth: sidebarWidth,
      listWidth: listWidth,
      collapsedFolders: collapsedFolders,
      bodyZoom: bodyZoom,
      bodyMode: bodyMode,
      alwaysShowImages: alwaysShowImages,
      windowOpen: windowOpen || restoreWindow
    })
    windowWriter.command = [pluginDir + "/scripts/config-store.sh", "window.json"]
    windowWriter.running = true
  }

  // Written when a drag ends, not while it runs: a drag is a hundred values
  // in a second and the file wants the one settled on.
  function setPaneWidths(sidebar, list) {
    var nextSidebar = Model.paneWidth(sidebar)
    var nextList = Model.paneWidth(list)
    if (nextSidebar === sidebarWidth && nextList === listWidth) return
    sidebarWidth = nextSidebar
    listWidth = nextList
    saveWindowPrefs()
  }

  function toggleFolder(path) {
    var key = String(path || "")
    if (key === "") return
    collapsedFolders = Model.togglePath(collapsedFolders, key)
    saveWindowPrefs()
  }

  // The rail's labels in the order it draws them, folded rows left out — the
  // list the Ctrl digits number.
  readonly property var visibleLabels: Model.visibleLabels(labels, collapsedFolders)

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
        // The name as it was typed, empty when none was, so a field editing
        // it shows what is there rather than the address standing in for it.
        label: String(accounts[i].label || ""),
        signature: String(accounts[i].signature || ""),
        signatureHtml: String(accounts[i].signatureHtml || "")
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
        // The name that was chosen, if one was. `label` always answers —
        // falling through to the local part — so it cannot say whether
        // anything was named, and the switcher has to know the difference.
        name: String(accounts[i].label || ""),
        // One more line about this particular mailbox, in its provider's own
        // words. Empty for the three that have nothing to add, and the row
        // draws it only when it is not.
        detail: Provider.detail(accounts[i].provider, accounts[i]),
        unread: host ? host.inboxUnread : 0,
        active: host ? host.active : false,
        signedIn: host ? host.ready : false,
        busy: host ? host.listLoading : false,
        error: host ? host.lastError : ""
      })
    }
    return out
  }

  // ------------------------------------------------------- every mailbox at once
  //
  // On, and there is more than one mailbox to combine. One account in a
  // unified view is the account, and answering it through the merge would
  // spend a copy of every row to arrive at the same list.
  readonly property bool unified: unifiedMailboxes && accountCount > 1

  // `Instantiator.objectAt` is not a property, so nothing below re-evaluates
  // when a host's own list changes. `hostsEpoch` already exists for the same
  // reason and is bumped when a mailbox signs in or its unread moves; this one
  // is bumped by the delegate whenever a list, a load or an error changes,
  // which is far more often and must not drag `sendIdentities` along with it.
  property int listEpoch: 0

  function bumpListEpoch() {
    listEpoch += 1
  }

  // What the merge reads: one entry per mailbox, labelled so a row can say
  // where it came from.
  readonly property var unifiedSources: {
    // Nothing reads this list unless the merged view is on — every consumer
    // is `unified ? Unified.something(...) : the account's own answer` — and
    // building it is not free: a list change bumps `listEpoch` several times
    // for every mailbox opened, and each bump walked every account's rows for
    // a list nobody was looking at.
    if (!unified) return []
    var _epoch = listEpoch
    var out = []
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (!accounts[i].id) continue
      var host = accountHosts.objectAt(i)
      out.push({
        id: accounts[i].id,
        label: Accounts.label(accounts[i]),
        messages: host ? host.messages : [],
        // Whether this mailbox has more to come, which is what decides where
        // the merge has to stop: a source still holding mail below its last
        // row would leave a hole in the middle of the list.
        hasMore: !!(host && host.hasMore)
      })
    }
    return out
  }

  // What the merge reads for everything that is not a row: whether each
  // mailbox is still working, has more to offer, or has something to say.
  readonly property var unifiedStates: {
    if (!unified) return []
    var _epoch = listEpoch
    var out = []
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (!accounts[i].id) continue
      var host = accountHosts.objectAt(i)
      out.push({
        label: Accounts.label(accounts[i]),
        loading: !!(host && host.listLoading),
        loaded: !!(host && host.listLoaded),
        serverSearchLoading: !!(host && host.serverSearchLoading),
        hasMore: !!(host && host.hasMore),
        error: host ? String(host.lastError || "") : ""
      })
    }
    return out
  }

  // Which services are involved, which is what decides the rail and every
  // button on it. Two Gmail mailboxes ask one provider's questions.
  // What every mailbox in the merge can actually do, and which rail rows it
  // has. Read off the hosts rather than their provider ids: each one has
  // already narrowed its provider by the refusals its server reported and the
  // mailboxes that turned out not to be there, and those arrive while the app
  // is running. Reading them here is what makes the intersection follow them.
  readonly property var unifiedAbilities: {
    if (!unified) return []
    var _epoch = listEpoch
    var out = []
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (!accounts[i].id) continue
      var host = accountHosts.objectAt(i)
      out.push({
        archive: !!(host && host.canArchive),
        spam: !!(host && host.canReportSpam),
        star: !!(host && host.canStar),
        labels: !!(host && host.hasLabels),
        web: !!(host && host.canOpenOnWeb),
        move: !!(host && host.canMove),
        conversations: !!(host && host.showsConversations),
        mailboxes: host ? host.mailboxes : []
      })
    }
    return out
  }


  readonly property var unifiedMessages: unified
    ? Unified.mergeMessages(unifiedSources) : []

  // The mailbox every account is showing. A unified view puts them all on the
  // same rail row, so this is the row rather than one account's idea of it —
  // and it survives a mailbox that has not finished switching.
  property string unifiedMailboxKey: "inbox"

  // The account that owns the open message. A reader shows one message, which
  // belongs to one mailbox however many the list came from, so everything
  // about the selection is forwarded from here rather than from `current`.
  property var selectionHost: null

  // Where an action goes. In a unified view the id says which mailbox owns the
  // row; otherwise there is only one it could mean.
  function hostForId(id) {
    if (!unified) return current
    var target = Unified.accountOf(id)
    return target === "" ? null : findAccount(target)
  }

  // What that mailbox calls the same message.
  function sourceIdFor(id) {
    return unified ? Unified.sourceIdOf(id) : String(id === undefined || id === null ? "" : id)
  }

  // Every signed-in mailbox, for the actions that are not about one row.
  function eachHost(callback) {
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (host) callback(host)
    }
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
    applyLiveHosts()
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
  readonly property int inboxUnread: unified
    ? Unified.totalUnread(accountSummaries) : (current ? current.inboxUnread : 0)
  readonly property var messages: unified
    ? unifiedMessages : (current ? current.messages : [])
  // A label belongs to one service and one mailbox within it, so a merged list
  // has none to draw and #83's picker has nothing to offer: `v` is refused
  // rather than opening an empty list, which is what `canMoveToLabel` says.
  readonly property var labels: unified ? [] : (current ? current.labels : [])
  // #83's move needs a label list and a mailbox to take one from, so a merged
  // view cannot offer it: the picker would open on an empty list, and a chosen
  // id would belong to whichever mailbox happened to be active.
  readonly property bool canMoveToLabel: !unified
    && !!current && current.canMove

  // Which service the mailbox on screen is, what mailboxes it has, and what it
  // can be asked to do. Forwarded like everything else so a view never has to
  // reach past `service` to find out.
  //
  // `providerId` stays the *visible* mailbox's even in a merged view: it
  // decides what a query string means and what a setup page offers, both of
  // which belong to one account. What a merged list may *do* comes from
  // `Unified.everyMailboxCan` rather than from here.
  readonly property string providerId: current ? current.providerId : Provider.DEFAULT_ID
  readonly property var mailboxes: unified
    ? Unified.sharedMailboxRows(unifiedAbilities)
    : (current ? current.mailboxes : Provider.mailboxes(Provider.DEFAULT_ID))
  readonly property bool canArchive: unified
    ? Unified.everyMailboxCan(unifiedAbilities, "archive")
    : (!current || current.canArchive)
  readonly property bool canReportSpam: unified
    ? Unified.everyMailboxCan(unifiedAbilities, "spam")
    : (!current || current.canReportSpam)
  readonly property bool canStar: unified
    ? Unified.everyMailboxCan(unifiedAbilities, "star")
    : (!current || current.canStar)
  readonly property bool hasLabels: unified
    ? Unified.everyMailboxCan(unifiedAbilities, "labels")
    : (!current || current.hasLabels)
  // Intersected like every other capability: a merged list holds rows from
  // mailboxes whose provider has no web UI at all, and "Open in browser" on
  // one of those is a button that cannot be honoured.
  readonly property bool canOpenOnWeb: unified
    ? Unified.everyMailboxCan(unifiedAbilities, "web")
    : (!current || current.canOpenOnWeb)
  readonly property bool canOpenWebInbox: !unified && !!current && current.canOpenWebInbox
  // A key is not a button: `e` and `s` are bound whatever mailbox is open, so
  // the status row's hints are filtered by this. In a merged list the answer
  // has to come from the same intersection the buttons use — one account's
  // own list would offer an archive the mailbox the cursor is on refuses.
  readonly property var unavailableActions: unified
    ? Model.unavailableActions({
        archive: canArchive, star: canStar, spam: canReportSpam })
    : (current ? current.unavailableActions : [])

  // #91's set of attachments being saved, keyed the way the panel addresses a
  // row: an account keys its own by the id it issued, so in a merged list the
  // sets are joined and re-keyed rather than read off whichever mailbox is
  // active — which would have shown a spinner on the wrong row, or none.
  readonly property var savingAttachmentIds: {
    if (!unified) return current ? current.savingAttachmentIds : ({})
    var _epoch = listEpoch
    var out = ({})
    var accounts = accountList ? accountList.accounts : []
    for (var i = 0; i < accounts.length; i++) {
      if (!accounts[i].id) continue
      var host = accountHosts.objectAt(i)
      var own = host ? host.savingAttachmentIds : ({})
      for (var key in own) out[Unified.unifiedId(accounts[i].id, key)] = own[key]
    }
    return out
  }
  // Whether a message can be written at all, which is a question about the
  // mailbox it would be sent from — and compose picks that from the From
  // address rather than from the list. Intersecting it would hide the compose
  // button because one mailbox in the merge cannot send.
  readonly property bool canSend: !current || current.canSend
  // Whether this account's listing is one row per conversation, and everything
  // the reader's rail is drawn from. Forwarded like every other account fact:
  // the views are given one object and never reach past it, so a property the
  // facade does not name is a property the window reads as `undefined` — which
  // is what the conversation count on a row was doing.
  //
  // `showsConversations` is `Provider.can(..., "conversations")`, so a merged
  // list intersects it like every other capability: a list holding a JMAP
  // account's threads beside a mailbox that has none would draw a member count
  // on the rows that happened to carry one and nothing on the rest.
  readonly property bool showsConversations: unified
    ? Unified.everyMailboxCan(unifiedAbilities, "conversations")
    : (!!current && current.showsConversations)
  // The rail and its members are about the message being read, so they come
  // from the mailbox holding the selection — the same place `selectedMessage`
  // and `detailPainted` come from.
  readonly property bool showsRail: !!reading && reading.showsRail
  // Composed on the way out, like `selectedId` and for the same reason: the
  // rail hands a member id back to `select` and to `act`, and compares the
  // open one against `selectedId`. A raw one reached no mailbox at all.
  readonly property var selectedThread: {
    if (!reading) return null
    if (!unified) return reading.selectedThread
    return Unified.composeThread(reading.accountId, reading.selectedThread)
  }
  readonly property var memberSummaries: {
    if (!reading) return ({})
    if (!unified) return reading.memberSummaries
    return Unified.composeMembers(reading.accountId, reading.memberSummaries)
  }
  readonly property string mailboxKey: unified
    ? unifiedMailboxKey : (current ? current.mailboxKey : "inbox")
  // What `mailboxKey` means for a reader that is looking at a thread, which is
  // the same question of the merged list as of one mailbox — so it is asked of
  // the service's own `mailboxKey` rather than of whichever account is
  // underneath it.
  readonly property string viewedMailboxKey: unified
    ? Conversation.viewedMailboxKey(mailboxKey, searchQuery !== "")
    : (current ? current.viewedMailboxKey : "")
  // The typed search and the query behind it. A merged search asks every
  // mailbox the same words, so one account's copy is every account's — and
  // reading it from the visible one keeps the box showing what was typed.
  readonly property string searchQuery: current ? current.searchQuery : ""
  readonly property string rawQuery: current ? current.rawQuery : ""
  // A unified view draws no labels, so it can never be showing one.
  readonly property string rawLabelId: unified || !current ? "" : current.rawLabelId
  readonly property bool listLoading: unified
    ? Unified.anyLoading(unifiedStates) : (!!current && current.listLoading)
  // A mailbox that cannot load is not a mailbox still loading, which is the
  // distinction `Unified.allLoaded` draws: requiring every one of them left a
  // signed-out account holding the placeholder blank indefinitely.
  readonly property bool listLoaded: unified
    ? Unified.allLoaded(unifiedStates) : (!!current && current.listLoaded)
  // Still coming from any server. A unified search asks every mailbox, so the
  // spinner must remain visible while any of them is still answering.
  readonly property bool serverSearchLoading: unified
    ? Unified.anyServerSearchLoading(unifiedStates)
    : (!!current && current.serverSearchLoading)
  readonly property bool hasMore: unified
    ? Unified.anyHasMore(unifiedStates) : (!!current && current.hasMore)
  // "12 results" for the visible mailbox. Left alone deliberately rather than
  // summed: a merged count would have to wait for every mailbox to finish
  // searching, and a number that keeps growing while it is read is worse than
  // one that is honest about being one mailbox's.
  readonly property bool selectionIsPreview: !!reading && reading.selectionIsPreview


  readonly property string resultSummary: current ? current.resultSummary : ""
  // ------------------------------------------------------- the open message
  //
  // A reader shows one message, and a message belongs to one mailbox however
  // many the list was made of. `reading` is that mailbox: the one the
  // selection was routed to in a unified view, and the visible one otherwise.
  // Everything below forwards from it, so the reader, the invitation card and
  // the attachment row never learn which of the two they are in.
  readonly property var reading: unified ? selectionHost : current

  // Composed on the way back out, because the panel compares this against the
  // ids in the list it was given — and in a unified view those carry the
  // mailbox. The account only ever knows its own.
  readonly property string selectedId: {
    if (!reading) return ""
    if (!unified) return reading.selectedId
    return Unified.unifiedId(reading.accountId, reading.selectedId)
  }
  readonly property var selectedMessage: reading ? reading.selectedMessage : null
  readonly property var selectedBody: reading ? reading.selectedBody : ({ text: "", source: "" })
  readonly property string selectedHtml: reading ? reading.selectedHtml : ""
  readonly property var selectedDocument: reading ? reading.selectedDocument : null
  readonly property var selectedReaderDocument: reading ? reading.selectedReaderDocument : null
  readonly property bool selectedReaderTooHeavy: !!reading && reading.selectedReaderTooHeavy
  readonly property bool selectedReaderEmpty: !reading || reading.selectedReaderEmpty
  readonly property int selectedReaderRemoteImages: reading ? reading.selectedReaderRemoteImages : 0
  readonly property var selectedImages: reading ? reading.selectedImages : []
  readonly property int selectedBlockedImages: reading ? reading.selectedBlockedImages : 0
  readonly property int selectedRemoteImages: reading ? reading.selectedRemoteImages : 0
  readonly property bool remoteImagesAllowed: !!reading && reading.remoteImagesAllowed
  readonly property var selectedAttachments: reading ? reading.selectedAttachments : []
  readonly property bool selectedTooHeavy: !!reading && reading.selectedTooHeavy
  // The meeting inside the message, and this account's answer to it.
  readonly property var selectedInvite: reading ? reading.selectedInvite : null
  readonly property string selectedResponse: reading ? reading.selectedResponse : ""
  readonly property bool canRespondToInvite: !!reading && reading.canRespondToInvite
  readonly property bool rsvpSending: !!reading && reading.rsvpSending
  // Empty when this message offers no way off a list, which is the answer for
  // everything that is not a newsletter.
  readonly property string unsubscribeLabel: reading ? reading.unsubscribeLabel : ""
  readonly property string unsubscribeDetail: reading ? reading.unsubscribeDetail : ""
  readonly property bool unsubscribing: !!reading && reading.unsubscribing
  readonly property bool detailLoading: !!reading && reading.detailLoading
  readonly property bool detailPainted: !!reading && reading.detailPainted
  // ComposeView owns one parked draft for the whole service, so an in-flight
  // send is global even though the request belongs to one account host. This
  // also keeps the visible Send button honest after switching accounts — and
  // in a merged list it is the reason the button goes busy for a send from a
  // mailbox that is not the active one, which `current.sending` could not say.
  readonly property var sendingHost: {
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (host && host.sending) return host
    }
    return null
  }
  readonly property bool sending: !!sendingHost
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
  readonly property string lastError: unified
    ? Unified.firstError(unifiedStates) : (current ? current.lastError : "")
  // The last thing a mailbox said it did, and the undo that goes with it. Read
  // from `current` alone, archiving a row from a non-active mailbox in a merged
  // list produced no confirmation and no undo affordance at all — so the most
  // recent of them wins, which is the one the press just produced.
  readonly property string actionStatus: {
    if (!unified) return current ? current.actionStatus : ""
    var _epoch = listEpoch
    var newest = ""
    var at = -1
    for (var i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (!host || String(host.actionStatus || "") === "") continue
      if (host.actionStatusAt > at) {
        at = host.actionStatusAt
        newest = String(host.actionStatus)
      }
    }
    return newest
  }
  readonly property string signInProgress: current ? current.signInProgress : ""
  // Whether the mailbox on screen has had its credential refused. The setup
  // page draws the re-entry card from this; nothing signs out over it.
  readonly property bool credentialsRejected: !!current && current.credentialsRejected
  // How long ago the visible mailbox was checked. The status line does not
  // draw this in a merged view — `Model.readingStatusLine` omits it, because
  // an age from one mailbox is not a claim about all of them.
  readonly property string syncedLabel: current ? current.syncedLabel : ""

  function refresh() {
    if (!unified) {
      if (current) current.refresh()
      return
    }
    eachHost(function(host) { host.refresh() })
  }
  // Every mailbox that still has more, rather than the one whose rows happen
  // to be at the bottom: the merge cannot extend past the oldest row of the
  // shortest source without leaving a gap in the middle of the list.
  function loadMore() {
    if (!unified) {
      if (current) current.loadMore()
      return
    }
    eachHost(function(host) { if (host.hasMore) host.loadMore() })
  }
  function select(id, previewOnly) {
    if (!unified) {
      if (current) current.select(id, previewOnly)
      return
    }
    var host = hostForId(id)
    if (!host) return
    // Whatever was open elsewhere is no longer what the reader shows, and a
    // second mailbox holding a selection would keep answering for the
    // attachment row after the reader had moved on.
    eachHost(function(other) { if (other !== host) other.clearSelection() })
    selectionHost = host
    host.select(sourceIdFor(id), previewOnly)
  }
  function clearSelection() {
    if (!unified) {
      if (current) current.clearSelection()
      return
    }
    eachHost(function(host) { host.clearSelection() })
    selectionHost = null
  }
  function markPreviewRead(id) {
    if (!id) return false
    if (unified) {
      var host = hostForId(id)
      return host ? host.markPreviewRead(sourceIdFor(id)) : false
    }
    return current ? current.markPreviewRead(id) : false
  }
  // The notice's own button, which is the switch: what it turns on is every
  // message, and it says so.
  function showRemoteImages() { setAlwaysShowImages(true) }
  function rsvp(response) { if (reading) reading.rsvp(response) }
  function unsubscribe() { if (reading) reading.unsubscribe() }
  function cursorOffset(cursorId, delta) {
    if (unified) return Unified.cursorOffset(unifiedMessages, cursorId, delta)
    return current ? current.cursorOffset(cursorId, delta) : ""
  }
  function selectMailbox(key) {
    if (!unified) {
      if (current) current.selectMailbox(key)
      return
    }
    unifiedMailboxKey = String(key)
    clearSelection()
    eachHost(function(host) { host.selectMailbox(key) })
  }
  function search(text) {
    if (!unified) {
      if (current) current.search(text)
      return
    }
    eachHost(function(host) { host.search(text) })
  }
  readonly property bool canManageLabels: !!current && current.labelActions.canManageLabels

  // A label change is dispatched to the account that owned the menu or
  // dialog it was asked in, named by its id — not to whichever account is
  // open when the answer arrives. A label id is a folder name on IMAP and
  // two accounts can hold the same one, so the open account is no guide;
  // and an account removed in the meantime gets nothing, with a word about
  // it. No id at all means the open account, for a caller with no menu.
  function labelOwner(accountId, mustBeReady) {
    var id = String(accountId || "")
    var owner = id === "" ? current : findAccount(id)
    if (!owner) {
      if (current) current.fail("That mailbox is no longer set up, so nothing was changed")
      return null
    }
    if (mustBeReady === true && !owner.ready) {
      owner.fail("That mailbox is signed out, so nothing was changed")
      return null
    }
    return owner
  }
  function labelById(id, accountId) {
    var owner = String(accountId || "") === "" ? current : findAccount(accountId)
    return owner ? owner.labelActions.labelById(id) : null
  }
  function labelsOf(accountId) {
    var owner = String(accountId || "") === "" ? current : findAccount(accountId)
    return owner ? owner.labels : []
  }
  function createLabel(parentPath, leaf, accountId) {
    var owner = labelOwner(accountId, true)
    return owner ? owner.labelActions.createLabel(parentPath, leaf) : false
  }
  function renameLabel(id, leaf, accountId) {
    var owner = labelOwner(accountId, true)
    return owner ? owner.labelActions.renameLabel(id, leaf) : false
  }
  function moveLabel(id, parentPath, accountId) {
    var owner = labelOwner(accountId, true)
    return owner ? owner.labelActions.moveLabel(id, parentPath) : false
  }
  function deleteLabel(id, accountId) {
    var owner = labelOwner(accountId, true)
    return owner ? owner.labelActions.deleteLabel(id) : false
  }

  // An address search is built in one provider's words, so a merged list
  // — several providers at once — is refused the way a move is.
  function searchAddress(query, text) {
    if (unified) {
      fail("Searching by address needs one mailbox on screen")
      return
    }
    if (current) current.search(text, query)
  }
  // Labels belong to one service and one mailbox within it, so a unified view
  // draws none and this cannot be reached from one. `main`'s second argument
  // is kept: dropping it would have left #83's picker unable to say which
  // label a list is showing.
  function selectLabel(name, labelId) {
    if (current && !unified) current.selectLabel(name, labelId)
  }
  // Asked of the mailbox that owns the row rather than of the visible one: in
  // a merged list `e` and `s` reach `act` for a message whose provider may not
  // have the verb, and the refusal has to name that provider.
  function refuseUnavailableAction(action, id) {
    var host = id === undefined ? current : hostForId(id)
    if (!host) host = current
    return host ? host.refuseUnavailableAction(action) : true
  }
  function act(id, action, quiet, memberOnly) {
    var host = hostForId(id)
    return host ? host.act(sourceIdFor(id), action, quiet, memberOnly) : false
  }
  function toggleStar(id) {
    var host = hostForId(id)
    if (host) host.toggleStar(sourceIdFor(id))
  }
  function markAllRead() {
    if (!unified) {
      if (current) current.markAllRead()
      return
    }
    eachHost(function(host) { host.markAllRead() })
  }
  // Several ticked rows at once. A merged list draws rows from several
  // mailboxes, and a batch is one mailbox's request, so it is refused there
  // the way a move is: the rule every unavailable action follows.
  function actMany(ids, action) {
    if (unified) {
      fail("Acting on several messages needs one mailbox on screen")
      return false
    }
    return current ? current.actMany(ids, action) : false
  }
  // The mailbox the From address belongs to, which compose already names:
  // `sendIdentities` spans every account and carries the id, so a unified
  // view needed the routing rather than a new question.
  function send(fields) {
    // The button has the same guard, but Ctrl+Return reaches this function
    // directly. Enforce the one-global-parked-draft invariant at the action
    // boundary so another account cannot overwrite it.
    if (pendingSendHost) {
      if (current) current.fail("Another message is waiting to be sent")
      return false
    }
    if (sendingHost) {
      if (current) current.fail("Another message is still being sent")
      return false
    }
    // The mailbox the From address belongs to. `sendIdentities` spans every
    // account and carries the id, so compose can already name one; this is the
    // routing it was missing.
    var values = fields || ({})
    var host = sendHostFor(values)
    return host ? host.send(withSignatures(withSourceDraftId(values), host)) : false
  }

  // The mailbox a submission is sent from.
  //
  // A named one is the answer, and a named one that is not here is a refusal
  // rather than permission to guess: falling through to matching the address
  // sent the message from whichever mailbox matched first, which for two that
  // share a send-as alias is not the one the composer chose. The address is
  // only consulted when nothing named a mailbox at all.
  //
  // Resolved in one place so the choice can be asserted, rather than inferred
  // from what happened after it.
  function sendHostFor(fields) {
    var values = fields || ({})
    var target = draftOwner(values)
    if (target !== "") return findAccount(target)
    var host = senderFor(String(values.from || ""))
    return host ? host : current
  }

  // The mailbox a submission belongs to: the one it names, or — for a draft
  // raised from a merged list — the one its id was composed from.
  function draftOwner(values) {
    var named = String(values.accountId || "")
    if (named !== "") return named
    return Unified.accountOf(String(values.draftId || ""))
  }

  // The same submission with its draft id as the owning provider issued it.
  //
  // Asked of the id rather than of `unified`, because the composer can be
  // opened from a merged list and saved after the reader has left it — and a
  // provider handed a composed id answers that the draft is no longer there
  // and writes nothing. A bare id cannot hold the separator, so this is safe
  // to ask of any of them.
  function withSourceDraftId(values) {
    var id = String(values.draftId || "")
    if (Unified.accountOf(id) === "") return values
    var out = ({})
    for (var key in values) out[key] = values[key]
    out.draftId = Unified.sourceIdOf(id)
    return out
  }

  // Which mailbox owns an address, for a From that named no account. Asked of
  // each host rather than of the saved entry, because an alias is something a
  // signed-in mailbox reports and the entry does not carry.
  function senderFor(address) {
    var wanted = String(address || "").trim().toLowerCase()
    if (wanted === "") return null
    var i
    for (i = 0; i < accountHosts.count; i++) {
      var host = accountHosts.objectAt(i)
      if (host && String(host.accountEmail || "").toLowerCase() === wanted) return host
    }
    for (i = 0; i < accountHosts.count; i++) {
      var other = accountHosts.objectAt(i)
      if (!other) continue
      var aliases = other.availableSendAsAliases || []
      for (var j = 0; j < aliases.length; j++) {
        var alias = aliases[j]
        var email = String((alias && alias.email) || alias || "").trim().toLowerCase()
        if (email === wanted) return other
      }
    }
    return null
  }

  // The signatures ride with the fields rather than being read by the
  // account: the account holds no copy of its own entry, and the window
  // holds no signature. Both readings — text and markup — go, because the
  // message carries both.
  function withSignatures(fields, host) {
    var values = {}
    var source = fields || ({})
    for (var key in source) values[key] = source[key]
    var entry = Accounts.find(accountList, host ? String(host.accountId || "") : activeAccountId)
    values.signature = entry ? String(entry.signature || "") : ""
    values.signatureHtml = entry ? String(entry.signatureHtml || "") : ""
    return values
  }

  function saveDraft(fields, callback) {
    var values = fields || ({})
    var target = draftOwner(values)
    var host = target !== "" ? findAccount(target) : current
    if (!host) {
      if (typeof callback === "function") callback(null, "The mailbox for this draft is unavailable")
      return null
    }
    return host.saveDraft(withSignatures(withSourceDraftId(values), host), callback)
  }
  function fail(text) { if (current) current.fail(text) }
  function note(text) { if (current) current.note(text) }
  function undoSend() {
    var host = pendingSendHost
    if (!host) return false
    // Same reason as `forwardReplyFailure`: the draft names its mailbox, so a
    // merged view has no need to change what is on screen to undo a send.
    if (host !== current && !unified) {
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
    var host = hostForId(messageId)
    if (host) return host.loadAttachments(sourceIdFor(messageId), attachments, callback)
    if (typeof callback === "function") callback([], "No mailbox is selected")
    return null
  }
  function openAttachment(messageId, attachment) {
    var host = hostForId(messageId)
    if (host) host.openAttachment(sourceIdFor(messageId), attachment)
  }

  function saveAttachment(messageId, attachment) {
    var host = hostForId(messageId)
    if (host) host.saveAttachment(sourceIdFor(messageId), attachment)
  }

  // Whether this attachment of this message is being written out.
  //
  // The merged map is keyed by mailbox and attachment, because two mailboxes
  // can be saving attachments whose ids collide — an IMAP part id is a number
  // in a tree, not something unique across servers. A view holds an attachment
  // and the message it hangs off; composing the key from those is the
  // service's job, like every other id it issues.
  function attachmentIsSaving(messageId, attachmentId) {
    var key = String(attachmentId || "")
    if (key === "") return false
    if (!unified) return !!savingAttachmentIds[key]
    var owner = Unified.accountOf(messageId)
    if (owner === "") return false
    return !!savingAttachmentIds[Unified.unifiedId(owner, key)]
  }
  // Asked of the mailbox the message arrived in rather than of the visible
  // one. Replying from a merged list otherwise composed from whichever
  // account was active underneath, with nothing on screen saying so — which
  // is the failure a unified inbox most has to avoid.
  function preferredSendAs(recipients) {
    var host = reading || current
    return host ? host.preferredSendAs(recipients) : null
  }

  // Which mailbox a draft raised from the current selection belongs to. The
  // window seeds `ComposeView.accountId` from this rather than from
  // `activeAccountId`, so a reply to a message that arrived in mailbox B is
  // written and sent from B.
  readonly property string composeAccountId: {
    var host = reading || current
    return host ? String(host.accountId || "") : ""
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
    return configureAccount(editingIndex(), values)
  }

  // Saving a new address rebuilds the account host. Wait for that replacement
  // before asking it to sign in; calling through immediately targets the host
  // that the save has just retired, which made a failed attempt knock the user
  // out of the add flow on the next click.
  function configureCurrentAccountAndSignIn(values, secret) {
    if (!configureCurrentAccount(values)) return false
    Qt.callLater(function() { root.signInWithPassword(secret) })
    return true
  }

  // OAuth providers save their non-secret client configuration before the
  // account host that owns the browser flow is built.
  function configureCurrentAccountAndSignInOAuth(values) {
    if (!configureCurrentAccount(values)) return false
    Qt.callLater(function() { root.signIn() })
    return true
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

  // Routed and taken apart like every other action on a row: the composed id
  // names the mailbox, and the account builds the address out of its own
  // half of it. Sent to `current` it built one Gmail URL out of another
  // mailbox's id.
  function openInBrowser(id) {
    var host = hostForId(id)
    if (host) host.openInBrowser(sourceIdFor(id))
  }
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
  signal replyFailed()

  // A queued send keeps running on its own account when the visible mailbox
  // changes. Put that account back in front before App restores the draft, so
  // a retry cannot be addressed to whichever mailbox happened to be visible.
  function forwardReplyFailure(index) {
    var host = accountAt(index)
    // Not in a merged list. The switch exists so a retry cannot be addressed
    // to whichever mailbox happened to be visible, and in a merged view the
    // draft already names its own — `composeAccountId` seeded it from the
    // message it answers. Switching there would also drop the reader out of
    // the combined view to report a failure, which is not what was asked for,
    // and it would do it behind `App.switchAccount`'s back.
    if (host && host !== current && !unified) switchToIndex(index)
    replyFailed()
  }

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

      notificationForeground: root.shell && root.shell.bar
        ? root.shell.bar.barForeground : Color.foreground
      notificationAccent: Color.accent
      pluginDir: root.pluginDir
      accountId: entry ? entry.id : ""
      configuredEmail: entry ? entry.email : ""
      oauthClientId: entry ? entry.clientId : ""
      // Which service this mailbox is, and — for the one that needs them — the
      // servers it talks to. Both come off the account entry, so changing an
      // account's provider in the file rebuilds it as that provider.
      providerId: entry ? entry.provider : Provider.DEFAULT_ID
      imapSettings: entry ? entry.imap : null
      jmapSettings: entry ? entry.jmap : null
      // Only a Gmail account has a client-keyed refresh token to inherit, and
      // only the first one may claim it.
      mayAdoptLegacyToken: index === 0 && (!entry || entry.provider === "gmail")
      settings: root.settings
      bodyMode: root.bodyMode
      // The labels this mailbox watches for new mail, off its own entry.
      monitoredIds: entry ? entry.monitored : []
      // Every mailbox obeys the one answer: it is about what the reader is
      // willing to tell a sender, not about which account the mail came to.
      alwaysShowImages: root.alwaysShowImages

      onNotificationActivated: function(accountId, messageId) {
        root.openNotification(accountId, messageId)
      }
      onAccountIdentified: function(email) { root.nameAccount(index, email) }
      // What a JMAP sign-in learned about its server, written onto the entry
      // the same way the setup form's own save is: the row keeps everything
      // else it had, and the file follows.
      onServerSettingsLearned: function(jmap) { root.configureAccount(index, { jmap: jmap }) }
      onReadyChanged: root.recount()
      onInboxUnreadChanged: root.recount()
      onReplySent: root.replySent()
      onReplyFailed: root.forwardReplyFailure(index)
      onMonitoredMigrated: function(ids) { root.setMonitoredIds(index, ids) }

      // What a merged list is made of, and everything a merged list says
      // about itself. `recount` is not enough and is deliberately not used:
      // it also drives `sendIdentities`, which would be rebuilt on every
      // arriving row rather than when a mailbox signs in.
      onMessagesChanged: root.bumpListEpoch()
      onListLoadingChanged: root.bumpListEpoch()
      onListLoadedChanged: root.bumpListEpoch()
      onHasMoreChanged: root.bumpListEpoch()
      onLastErrorChanged: root.bumpListEpoch()

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

  AgentContext {
    id: agentContext
    service: root
    runner: agentRunner
  }

  AgentRunner {
    id: agentRunner
    pluginDir: root.pluginDir
    // The open account owns what the rows show and cancel: an IMAP id is
    // only unique inside one account, and two accounts can share an address.
    accountId: root.current ? root.current.accountId : ""
    onJobFinished: function(job) {
      var text = Agent.finishedNote(job)
      // On the account the job was about; the open one only for a job that
      // named none.
      var owner = findAccount(String(job && job.accountId || "")) || root.current
      if (text !== "" && owner) owner.note(text)
    }
    onFailed: function(text) { if (root.current) root.current.fail(text) }
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
      if (root.accountsSaveQueued) {
        var drop = root.accountsSaveQueuedAllowDrop
        root.saveAccounts(drop ? { allowDrop: true } : undefined)
      }
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
