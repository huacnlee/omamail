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
  property string startedMessageId: ""

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

  function cancel(messageId) {
    var job = jobFor(messageId)
    if (!job || !Agent.isActive(job) || canceller.running) return false
    canceller.command = ["python3", runner(), "cancel", String(job.id)]
    canceller.running = true
    return true
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

  Timer {
    interval: 2000
    repeat: true
    running: root.anyActive
    onTriggered: root.refresh()
  }

  Component.onCompleted: Qt.callLater(root.refresh)
}
