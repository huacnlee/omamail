import QtQuick

// Presentation state for native background jobs. Rust owns process lifetime,
// deadlines, persisted output and job validation; the UI owns the open result.
Item {
  id: root
  required property string pluginDir
  property var backend: null
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
  property int projectionSerial: 0
  property var pendingJobs: null
  function acknowledge(jobId) {
    var id = String(jobId || "")
    if (id !== "" && seenIds.indexOf(id) < 0) seenIds = seenIds.concat([id])
  }
  signal jobFinished(var job)
  signal failed(string text)

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
    request("agent.jobsList", {}, function(result, error) {
      root.listing = false
      if (!error && Array.isArray(result)) root.applyListing(result)
      if (root.refreshQueued) { root.refreshQueued = false; root.refresh() }
    })
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
      root.pendingJobs = null
      root.jobs = next
      var news = result.newlyFinished || []
      for (var i = 0; i < news.length; i++) root.jobFinished(news[i])
    })
  }
  onAccountIdChanged: {
    byMessage = ({})
    attentionByMessage = ({})
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

  function start(payloadLine) {
    if (!available()) { lastError = "Mail backend is unavailable"; return false }
    if (starting) { lastError = "AI is still starting. Try again shortly."; return false }
    var payload = payloadLine
    if (payload === null || payload === undefined || payload === "") return false
    if (typeof payload !== "string" && (typeof payload !== "object" || Array.isArray(payload))) return false
    lastError = ""
    starting = true
    request("agent.jobStart", {payload: payload}, function(result, error) {
      root.starting = false
      if (error) {
        root.lastError = "Could not confirm AI started. Check the conversation before retrying."
        root.failed(root.lastError)
        root.refresh()
        return
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
    if (id !== shownId) { shownId = id; shownOutput = ""; shownTranscript = [] }
    if (!available() || id === "") return
    if (showing) { showQueued = true; return }
    showing = true
    request("agent.jobShow", {id: id}, function(result, error) {
      root.showing = false
      if (!error && result && result.job && String(result.job.id || "") === root.shownId) {
        root.shownOutput = String(result.output || "")
        var transcript = result.transcript || []
        if (JSON.stringify(root.shownTranscript) !== JSON.stringify(transcript)) root.shownTranscript = transcript
      }
      if (root.showQueued) { root.showQueued = false; root.show(root.shownId) }
    })
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
    Qt.callLater(root.drainForgets)
  }
  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onReadyChanged() { if (root.available()) {root.refresh();root.drainForgets()} }
  }
  function jobFor2(jobId) {
    for (var i = 0; i < jobs.length; i++) if (String(jobs[i].id) === String(jobId)) return jobs[i]
    return null
  }
  Component.onCompleted: Qt.callLater(root.refresh)
}
