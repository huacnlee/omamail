import QtQuick
import "Options.js" as Options

// Presentation state for native background jobs. Rust owns process lifetime,
// deadlines, persisted output and job validation; the UI owns the open result.
Item {
  id: root
  required property string pluginDir
  property var backend: null
  property string selectedAgent: "System default"
  property string selectedModel: ""
  property bool providerAvailable: false
  property string resolvedProvider: ""
  property string availabilityError: "Checking the selected AI agent..."
  property int availabilitySerial: 0
  function refreshAvailability() {
    var serial = ++availabilitySerial
    if (!available()) {
      providerAvailable = false
      availabilityError = "Mail backend is unavailable."
      return
    }
    if (Number(backend.apiVersion) < 6) {
      // The published backend still supports Claude through Omarchy's default.
      // It validates that default at jobStart; providerStatus is API-6 only.
      resolvedProvider = ""
      providerAvailable = selectedAgent === "System default" && selectedModel === ""
      availabilityError = providerAvailable ? ""
        : "Update the mail backend to choose an AI agent or model (API 6 required)."
      return
    }
    if (!providerAvailable) availabilityError = "Checking the selected AI agent..."
    request("agent.providerStatus", {provider: Options.provider(selectedAgent)}, function(result, error) {
      if (serial !== root.availabilitySerial) return
      root.resolvedProvider = !error && result ? String(result.provider || "") : ""
      root.providerAvailable = !error && !!result && result.available === true
      root.availabilityError = root.providerAvailable ? "" : error
        ? "Could not check the selected AI agent."
        : "Your system-default agent is not supported. Choose Claude, Codex or OpenCode in Settings → AI."
    })
  }
  property int selectionRevision: 0
  property double selectionResetAt: 0
  property var selectionJobs: ({})
  function resetSelection() { selectionRevision++; selectionJobs = ({}) }
  onSelectedAgentChanged: { providerAvailable = false; resetSelection(); refreshAvailability() }
  onResolvedProviderChanged: resetSelection()
  onSelectedModelChanged: { resetSelection(); refreshAvailability() }
  onSelectionResetAtChanged: resetSelection()
  function canContinueSelection(job) {
    if (!job) return false
    var provider = Options.provider(selectedAgent) || resolvedProvider
    if (provider !== "" && provider !== String(job.provider || "claude")) return false
    if (String(job.model || "") !== selectedModel) return false
    if (selectionJobs[String(job.id)] === selectionRevision) return true
    var created = job.createdOrder ? Number(job.createdOrder) / 1000000 : Number(job.created || 0) * 1000
    return created > selectionResetAt
  }
  property string accountId: ""
  property var jobs: []
  property var byMessage: ({})
  property var byAccount: ({})
  property var scopesByAccount: ({})
  property var attentionIds: []
  property bool anyActive: false
  property var activeIds: []
  property var finishedIds: []
  property var seenIds: []
  property bool attention: false
  property var attentionByMessage: ({})
  // Looks for events by account and message — running or finished — and how
  // many are running: a look draws no row, so it is read from here and not
  // from byMessage.
  property var eventLooks: ({})
  property int activeEventLooks: 0
  property int projectionSerial: 0
  property var pendingJobs: null
  function acknowledge(jobId) {
    var id = String(jobId || "")
    if (id !== "" && seenIds.indexOf(id) < 0) seenIds = seenIds.concat([id]).slice(-4096)
  }
  signal jobFinished(var job)
  signal failed(string text)
  // A start that Rust refused, by its code, for a caller that asked quietly:
  // a background look has nobody to tell and must not put an error on the
  // status line every time a message opens.
  signal startRefused(string code)

  property string lastError: ""
  property bool starting: false
  property bool cancelling: false
  property bool listing: false
  property bool showing: false
  property bool forgetting: false
  property bool refreshQueued: false
  property bool showQueued: false
  property var forgetQueue: []
  property string shownId: ""
  property string shownOutput: ""
  property var shownTranscript: []
  property var shownProposals: []
  property string previousPage: ""
  property bool loadingEarlier: false
  property var earlierTranscript: []
  property var earlierProposals: []
  property var latestTranscript: []
  property var latestProposals: []
  property int listingOffset: 0
  property bool hasMoreJobs: false
  property int generation: 0
  Component.onDestruction: generation++

  function available() { return !!backend && backend.ready }
  function request(method, params, callback) {
    var epoch = generation
    var owner = backend
    owner.call(method, params, function(result, error) {
      if (!root || epoch !== root.generation || owner !== root.backend) return
      callback(result, error)
    })
  }

  function refresh() {
    if (!available()) return
    if (listing) { refreshQueued = true; return }
    listing = true
    var paged = Number(backend.apiVersion) >= 6
    request("agent.jobsList", paged ? {paged:true,offset:listingOffset,watchIds:activeIds} : {}, function(result, error) {
      root.listing = false
      if (!error && result) {
        root.hasMoreJobs = result.hasMore === true
        if (Array.isArray(result)) root.applyListing(result)
        else if (Array.isArray(result.jobs)) root.applyListing(result.jobs)
      }
      if (root.refreshQueued) { root.refreshQueued = false; root.refresh() }
    })
  }

  function pageChats(older) {
    if (listing || (older && !hasMoreJobs)) return
    listingOffset = older ? listingOffset + 32 : Math.max(0, listingOffset - 32)
    refresh()
  }

  function applyListing(next) {
    pendingJobs = next
    projectJobs()
  }

  function projectJobs() {
    if (!available()) return
    var next = pendingJobs || jobs
    var serial = ++projectionSerial
    request("agent.jobsProjection", {jobs: next, before: jobs,
      accountId: accountId, seenIds: seenIds}, function(result, error) {
      if (serial !== root.projectionSerial || error || !result) return
      root.byMessage = result.byMessage || ({})
      root.byAccount = result.byAccount || ({})
      root.scopesByAccount = result.scopesByAccount || ({})
      root.attentionIds = result.attentionIds || []
      root.anyActive = result.anyActive === true
      root.activeIds = result.activeIds || []
      root.finishedIds = result.finishedIds || []
      root.attention = result.attention === true
      root.attentionByMessage = result.attentionByMessage || ({})
      root.eventLooks = result.eventLooks || ({})
      root.activeEventLooks = Number(result.activeEventLooks) || 0
      root.pendingJobs = null
      root.jobs = next
      var news = result.newlyFinished || []
      for (var i = 0; i < news.length; i++) root.jobFinished(news[i])
    })
  }
  onAccountIdChanged: {
    byMessage = ({})
    attentionByMessage = ({})
    eventLooks = ({})
    projectJobs()
  }
  onSeenIdsChanged: projectJobs()

  function jobFor(messageId, owner) {
    var account = String(owner || "") !== "" ? String(owner) : accountId
    var messages = account === accountId ? byMessage : (byAccount[account] || ({}))
    return messages[String(messageId || "")] || null
  }

  function scope(owner, ids, draftKey) {
    var scopes = scopesByAccount[String(owner || accountId)] || ({})
    var key = draftKey ? "draft:" + String(draftKey) : JSON.stringify((ids || []).slice().sort())
    return scopes[key] || ({})
  }
  function selectionJob(ids, owner) { return scope(owner, ids, "").job || null }
  function historyFor(owner, ids, draftKey) { return scope(owner, ids, draftKey).history || [] }
  function draftJobs(owner, draftKey) { return scope(owner, [], draftKey).jobs || [] }
  function wantsAttention(job) { return !!job && attentionIds.indexOf(String(job.id)) >= 0 }
  function isActive(job) { return !!job && activeIds.indexOf(String(job.id)) >= 0 }

  function selection() { return {agent: selectedAgent, model: selectedModel, revision: selectionRevision} }
  function start(payloadLine, quiet, capturedSelection) {
    if (!available()) { lastError = "Mail backend is unavailable"; return false }
    if (!providerAvailable) { lastError = availabilityError; return false }
    if (starting) { lastError = "AI is still starting. Try again shortly."; return false }
    var payload = payloadLine
    if (payload === null || payload === undefined || payload === "") return false
    if (typeof payload !== "string" && (typeof payload !== "object" || Array.isArray(payload))) return false
    var selected = capturedSelection || selection()
    if (selected.agent !== selectedAgent || selected.model !== selectedModel
        || (selected.revision !== undefined && selected.revision !== selectionRevision)) {
      lastError = "AI selection changed. Start a new chat."
      return false
    }
    var parsed = payload
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) } catch (e) {} }
    if (parsed && parsed.parent && !canContinueSelection(jobFor2(parsed.parent))) {
      lastError = "This chat belongs to a previous AI selection. Start a new chat."
      return false
    }
    var revision = selectionRevision
    var options = Options.startOptions(payload, selected.agent, selected.model, backend.apiVersion)
    if (options.error) { lastError = options.error; return false }
    lastError = ""
    starting = true
    request("agent.jobStart", options.params, function(result, error) {
      root.starting = false
      if (error) {
        if (quiet === true) {
          root.startRefused(String(error && error.message ? error.message : error))
        } else {
          var code = String(error && error.message ? error.message : "")
          root.lastError = code === "agent_choose_claude"
            ? (Number(root.backend.apiVersion) >= 6
              ? "Choose OpenCode, Codex or Claude in Settings → AI, or select one as Omarchy's default."
              : "This backend supports Claude only. Select Claude as Omarchy's default AI agent.")
            : "Could not confirm AI started. Check the conversation before retrying."
          root.failed(root.lastError)
        }
        root.refresh()
        return
      }
      root.listingOffset = 0
      if (revision === root.selectionRevision && result && result.id) {
        var owned = Object.assign({}, root.selectionJobs)
        owned[String(result.id)] = revision
        root.selectionJobs = owned
      }
      root.refresh()
    })
    return true
  }

  function cancel(messageId, owner) {
    var job = jobFor(messageId, owner)
    return job ? cancelById(job.id) : false
  }

  function cancelById(jobId) {
    var job = jobFor2(jobId)
    if (!available() || !job || activeIds.indexOf(String(job.id)) < 0 || cancelling) return false
    cancelling = true
    request("agent.jobCancel", {id: String(job.id)}, function(result, error) {
      root.cancelling = false
      if (error) root.failed("Could not stop the agent. Try again shortly.")
      root.refresh()
    })
    return true
  }

  function show(jobId) {
    var id = String(jobId || "")
    if (id !== shownId) {
      shownId = id; shownOutput = ""; shownTranscript = []; shownProposals = []
      earlierTranscript = []; earlierProposals = []; latestTranscript = []; latestProposals = []
      previousPage = ""; loadingEarlier = false
    }
    if (!available() || id === "") return
    if (showing) { showQueued = true; return }
    showing = true
    request("agent.jobShow", {id: id}, function(result, error) {
      root.showing = false
      if (!error && result && result.job && String(result.job.id || "") === root.shownId) {
        root.shownOutput = String(result.output || "")
        root.latestTranscript = result.transcript || []
        root.latestProposals = result.proposals || []
        if (root.earlierTranscript.length === 0) root.previousPage = String(result.previous || "")
        root.publishHistory()
      }
      if (root.showQueued) { root.showQueued = false; root.show(root.shownId) }
    })
  }

  function offsetProposals(proposals, offset) {
    return proposals.map(function(proposal) {
      return Object.assign({}, proposal, {afterTurn: Number(proposal.afterTurn || 0) + offset})
    })
  }
  function publishHistory() {
    var transcript = earlierTranscript.concat(latestTranscript)
    var proposals = earlierProposals.concat(offsetProposals(latestProposals, earlierTranscript.length))
    if (JSON.stringify(shownTranscript) !== JSON.stringify(transcript)) shownTranscript = transcript
    if (JSON.stringify(shownProposals) !== JSON.stringify(proposals)) shownProposals = proposals
  }
  function loadEarlier() {
    if (!available() || Number(backend.apiVersion) < 6 || loadingEarlier || previousPage === "") return false
    var id = shownId
    var before = previousPage
    loadingEarlier = true
    request("agent.jobShow", {id:id,before:before}, function(result, error) {
      if (id !== root.shownId || before !== root.previousPage) return
      root.loadingEarlier = false
      if (error || !result) {root.failed("Could not load earlier messages."); return}
      var transcript = result.transcript || []
      root.earlierProposals = (result.proposals || []).concat(root.offsetProposals(root.earlierProposals, transcript.length))
      root.earlierTranscript = transcript.concat(root.earlierTranscript)
      root.previousPage = String(result.previous || "")
      root.publishHistory()
    })
    return true
  }

  function forget(jobId) {
    var id = String(jobId || "")
    if (!available() || id === "") return false
    forgetQueue = forgetQueue.concat([id])
    drainForgets()
    return true
  }

  function forgetFinished() {
    if (!available()) return false
    var ids = finishedIds.slice()
    if (ids.length === 0) return false
    forgetQueue = forgetQueue.concat(ids)
    drainForgets()
    return true
  }

  function drainForgets() {
    if (!available() || forgetting || forgetQueue.length === 0) return
    var id = forgetQueue[0]
    forgetQueue = forgetQueue.slice(1)
    forgetting = true
    request("agent.jobForget", {id: id}, function(result, error) {
      root.forgetting = false
      if (error) root.failed("Could not remove the job. Try again shortly.")
      root.refresh()
      root.drainForgets()
    })
  }

  Timer {
    interval: 15000
    repeat: true
    running: root.available() && root.selectedAgent === "System default"
    onTriggered: root.refreshAvailability()
  }
  Timer {
    interval: 500
    repeat: true
    running: root.available() && root.anyActive
    onTriggered: {
      root.refresh()
      if (root.shownId !== "" && root.activeIds.indexOf(root.shownId) >= 0) root.show(root.shownId)
    }
  }
  onJobsChanged: if (shownId !== "") show(shownId)
  onBackendChanged: {
    generation++
    starting = false; cancelling = false; listing = false; showing = false; forgetting = false
    refreshQueued = false; showQueued = false
    Qt.callLater(root.refresh)
    Qt.callLater(root.refreshAvailability)
    Qt.callLater(root.drainForgets)
  }
  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onReadyChanged() { root.refreshAvailability(); if (root.available()) {root.refresh();root.drainForgets()} }
    function onApiVersionChanged() { root.refreshAvailability() }
  }
  function jobFor2(jobId) {
    for (var i = 0; i < jobs.length; i++) if (String(jobs[i].id) === String(jobId)) return jobs[i]
    return null
  }
  Component.onCompleted: Qt.callLater(root.refresh)
}
