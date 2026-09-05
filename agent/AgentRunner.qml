import QtQuick
import Quickshell
import Quickshell.Io
import "Agent.js" as Agent

// The jobs the window can see, and the two things it can do to them: start
// one, stop one. Every job is a transient systemd user unit run by
// `scripts/agent-job.py`, so nothing here outlives or is outlived by the
// shell by accident — see docs/AGENT.md.
//
// A poll rather than a watch: a directory of small files rewritten by another
// process is the case a file watcher reports late or twice, and two seconds
// while something is running costs nothing measurable. Idle, it reads once on
// open and then only when asked.
Item {
  id: root

  required property string pluginDir

  // Every job the runner listed, newest first, and the same by message id.
  property var jobs: []
  readonly property var byMessage: Agent.jobsByMessage(jobs)
  readonly property bool anyActive: Agent.anyActive(jobs)

  // What the last listing said, so a job that crossed from running to done
  // between two listings can be reported once.
  signal jobFinished(var job)
  signal failed(string text)

  property string startPayload: ""

  // One job's output, for the pane: the id being watched and the tail the
  // runner last returned. Re-read on every poll while that job is running.
  property string shownId: ""
  property string shownOutput: ""

  function runner() { return pluginDir + "/scripts/agent-job.py" }

  function refresh() {
    if (pluginDir === "" || lister.running) return
    lister.command = ["python3", runner(), "list"]
    lister.running = true
  }

  function jobFor(messageId) { return Agent.jobFor(jobs, messageId) }

  // One line of JSON on stdin — `Agent.payload` — and the runner makes the
  // directory and the unit. The listing follows straight away, so the row
  // shows the job before the poll would have found it.
  function start(payloadLine) {
    if (pluginDir === "" || starter.running) return false
    startPayload = String(payloadLine || "")
    if (startPayload === "") return false
    starter.command = ["python3", runner(), "new"]
    starter.running = true
    return true
  }

  readonly property bool cancelling: canceller.running

  function cancel(messageId) {
    var job = jobFor(messageId)
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

  function show(jobId) {
    var id = String(jobId || "")
    if (id !== shownId) {
      shownId = id
      shownOutput = ""
    }
    if (pluginDir === "" || id === "" || shower.running) return
    shower.command = ["python3", runner(), "show", id]
    shower.running = true
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
      if (exitCode !== 0) return
      root.applyListing(String(stdout.text || ""))
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
      root.startPayload = ""
      if (exitCode !== 0) {
        root.failed("Could not start the agent: " + String(stderr.text || "").trim())
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
    id: shower
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var shown = Agent.parseShown(String(stdout.text || ""))
      if (!shown || String(shown.job.id || "") !== root.shownId) return
      root.shownOutput = shown.output
    }
  }

  Timer {
    interval: 2000
    repeat: true
    running: root.anyActive
    onTriggered: {
      root.refresh()
      if (root.shownId !== "" && Agent.isActive(root.jobFor2(root.shownId))) root.show(root.shownId)
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
