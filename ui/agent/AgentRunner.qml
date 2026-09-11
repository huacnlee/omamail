import QtQuick
import Quickshell
import Quickshell.Io
import "Agent.js" as Agent

// The jobs the window can see, and the two things it can do to them: start
// one, close one. Each turn runs in a background system AI process through
// `scripts/agent-job.py` and may outlive the dock — see docs/AGENT.md.
//
// A poll rather than a watch: a directory of small files rewritten by another
// process is the case a file watcher reports late or twice, and two seconds
// while something is running costs nothing measurable. Idle, it reads once on
// open and then only when asked.
Item {
  id: root

  required property string pluginDir

  // The account whose messages are being drawn: `provider:address`, from
  // the service. A message id is only unique inside one account, so the
  // jobs by message, the attention they ask for and the job a row cancels
  // are all read inside this one; the pane lists every job regardless.
  property string accountId: ""

  // Every job the runner listed, newest first, and the open account's by
  // message id.
  property var jobs: []
  readonly property var byMessage: Agent.jobsByMessage(jobs, accountId)
  readonly property bool anyActive: Agent.anyActive(jobs)

  // The jobs the owner has opened since they asked a question or finished:
  // what the glow stops for. Kept for the session; a restart glows again for
  // what is still unanswered, which is right.
  property var seenIds: []
  readonly property bool attention: Agent.anyAttention(jobs, seenIds)
  readonly property var attentionByMessage: Agent.attentionByMessage(jobs, seenIds, accountId)

  function acknowledge(jobId) { seenIds = Agent.markSeen(seenIds, jobId) }

  // What the last listing said, so a job that crossed from running to done
  // between two listings can be reported once.
  signal jobFinished(var job)
  signal failed(string text)

  property string startPayload: ""
  property string lastError: ""
  property bool startTimedOut: false
  readonly property bool starting: starter.running

  // One job's output, for the dock: the id being watched and the text the
  // runner last returned. Re-read on every poll while that job is running.
  property string shownId: ""
  property string shownOutput: ""
  property var shownTranscript: []

  function runner() { return pluginDir + "/scripts/agent-job.py" }

  // A refresh asked for while a listing is in flight is not dropped: it runs
  // as soon as that listing lands, so a job started during a poll is seen.
  property bool refreshQueued: false

  function refresh() {
    if (pluginDir === "") return
    if (lister.running) { refreshQueued = true; return }
    lister.command = ["python3", runner(), "list"]
    lister.running = true
  }

  function jobFor(messageId, owner) {
    return Agent.jobFor(jobs, messageId, String(owner || "") !== "" ? owner : accountId)
  }

  // One line of JSON on stdin — `Agent.payload` — and the runner makes the
  // directory and the background request. The listing follows straight away, so the row
  // shows the job before the poll would have found it.
  function start(payloadLine) {
    if (pluginDir === "") { lastError = "Omamail could not locate its AI helper. Reload the plugin."; return false }
    if (starter.running) { lastError = "AI is still starting. Try again shortly."; return false }
    lastError = ""
    startTimedOut = false
    startPayload = String(payloadLine || "")
    if (startPayload === "") return false
    starter.command = ["python3", runner(), "new"]
    starter.running = true
    startupDeadline.restart()
    return true
  }

  readonly property bool cancelling: canceller.running

  function cancel(messageId, owner) {
    var job = jobFor(messageId, owner)
    if (!job) return false
    return cancelById(job.id)
  }

  function cancelById(jobId) {
    var job = jobFor2(jobId)
    if (!job || !Agent.isActive(job) || canceller.running) return false
    canceller.command = ["python3", runner(), "cancel", String(job.id)]
    canceller.running = true
    return true
  }

  property bool showQueued: false

  function show(jobId) {
    var id = String(jobId || "")
    if (id !== shownId) {
      shownId = id
      shownOutput = ""
      shownTranscript = []
    }
    if (pluginDir === "" || id === "") return
    if (shower.running) { showQueued = true; return }
    shower.command = ["python3", runner(), "show", id]
    shower.running = true
  }

  // A finished job and everything it wrote, removed. Several at once go one
  // after another, each followed by a listing, so the pane empties as they go.
  property var forgetQueue: []

  function forget(jobId) {
    var id = String(jobId || "")
    if (id === "") return false
    forgetQueue = forgetQueue.concat([id])
    drainForgets()
    return true
  }

  function forgetFinished() {
    var list = jobs || []
    var ids = []
    for (var i = 0; i < list.length; i++) if (!Agent.isActive(list[i])) ids.push(String(list[i].id))
    if (ids.length === 0) return false
    forgetQueue = forgetQueue.concat(ids)
    drainForgets()
    return true
  }

  function drainForgets() {
    if (pluginDir === "" || forgetter.running || forgetQueue.length === 0) return
    var next = forgetQueue[0]
    forgetQueue = forgetQueue.slice(1)
    forgetter.command = ["python3", runner(), "forget", next]
    forgetter.running = true
  }

  function applyListing(text) {
    var next = Agent.parseJobs(text)
    var news = Agent.newlyFinished(jobs, next)
    jobs = next
    for (var i = 0; i < news.length; i++) root.jobFinished(news[i])
  }

  Process {
    id: lister
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) root.applyListing(String(stdout.text || ""))
      if (root.refreshQueued) {
        root.refreshQueued = false
        root.refresh()
      }
    }
  }

  Process {
    id: starter
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.startPayload + "\n")
      root.startPayload = ""
    }
    onExited: function(exitCode) {
      startupDeadline.stop()
      root.startPayload = ""
      if (root.startTimedOut) return
      if (exitCode !== 0) {
        root.lastError = "Could not start AI: " + String(stderr.text || "").trim()
        root.failed(root.lastError)
        return
      }
      root.refresh()
    }
  }

  Process {
    id: canceller
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.failed("Could not stop the agent: " + String(stderr.text || "").trim())
      root.refresh()
    }
  }

  Process {
    id: forgetter
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.failed("Could not remove the job: " + String(stderr.text || "").trim())
      root.refresh()
      root.drainForgets()
    }
  }

  Process {
    id: shower
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      var shown = exitCode === 0 ? Agent.parseShown(String(stdout.text || "")) : null
      if (shown && String(shown.job.id || "") === root.shownId) {
        root.shownOutput = shown.output
        if (JSON.stringify(root.shownTranscript) !== JSON.stringify(shown.transcript)) root.shownTranscript = shown.transcript
      }
      if (root.showQueued) { root.showQueued = false; root.show(root.shownId) }
    }
  }

  Timer {
    interval: 500
    repeat: true
    running: root.anyActive
    onTriggered: {
      root.refresh()
      if (root.shownId !== "" && Agent.isActive(root.jobFor2(root.shownId))) root.show(root.shownId)
    }
  }

  Timer {
    id: startupDeadline
    interval: 15000
    onTriggered: {
      root.startTimedOut = true
      root.lastError = "Starting AI timed out. Retry the request."
      starter.running = false
      root.startPayload = ""
      root.failed(root.lastError)
      root.refresh()
    }
  }

  // After a listing, the shown job's output is read once more if it just
  // finished, so the last lines land without waiting for a poll that will
  // not come.
  onJobsChanged: if (shownId !== "") show(shownId)

  function jobFor2(jobId) {
    var list = root.jobs || []
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(jobId)) return list[i]
    return null
  }

  Component.onCompleted: Qt.callLater(root.refresh)
}
