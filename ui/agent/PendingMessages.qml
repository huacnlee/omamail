import QtQuick
import "Agent.js" as Agent

// A session-only queue bound to one conversation. Requests leave the queue
// only after their new turn appears, so a failed start cannot lose a message.
QtObject {
  id: root
  property var service: null
  property string currentScope: ""
  property var currentJob: null
  property string scope: ""
  property string conversationId: ""
  property string previousId: ""
  property bool waitingForTurn: false
  property bool dispatching: false
  property bool paused: false
  property string error: ""
  property var messages: []
  readonly property bool scopeMatches: scope === currentScope
  readonly property bool visibleHere: scopeMatches && (conversationId === "" || (!!currentJob && String(currentJob.conversationId || currentJob.id) === conversationId))
  readonly property bool busy: messages.length > 0
  property Timer timer: Timer {
    interval: 200
    repeat: true
    running: root.busy
    onTriggered: root.advance()
  }

  function add(text, awaitingTurn) {
    if (busy && (!visibleHere || (conversationId !== "" && currentJob
        && String(currentJob.conversationId || currentJob.id) !== conversationId))) {
      error = "Finish or remove the pending messages in the previous chat first."
      return false
    }
    var limit = Agent.pendingLimit(messages, text)
    if (limit !== "") { error = limit; return false }
    if (!busy) {
      scope = currentScope
      conversationId = currentJob ? String(currentJob.conversationId || currentJob.id) : ""
      previousId = currentJob ? String(currentJob.id) : ""
      waitingForTurn = awaitingTurn
      paused = false
      dispatching = false
    }
    messages = messages.concat([text])
    error = ""
    return true
  }
  function remove(index) {
    if (dispatching && index === 0) return ""
    if (index < 0 || index >= messages.length) return ""
    var text = messages[index]
    var next = messages.slice(); next.splice(index, 1); messages = next
    return text
  }
  function pause() { paused = true }
  function latest() {
    return Agent.pendingJob(service ? service.agentAllJobs : [], currentJob,
      scopeMatches, conversationId, previousId)
  }
  function advance() {
    if (!busy || !service) return
    var job = latest()
    if (waitingForTurn || dispatching) {
      if (!job || String(job.id) === previousId) {
        if (!service.agentStarting && service.agentError) { paused = true; error = service.agentError; dispatching = false }
        return
      }
      conversationId = String(job.conversationId || job.id)
      if (dispatching) messages = messages.slice(1)
      waitingForTurn = false
      dispatching = false
      if (!busy) return
    }
    if (paused || !job || service.agentStarting || Agent.isActive(job)) return
    if (!job.canContinue) { paused = true; error = "Queue paused. Edit or remove pending messages to start again."; return }
    if (!service.answerAgent(String(job.id), messages[0])) {
      paused = true; error = service.agentError || "Could not send the pending message."
      return
    }
    previousId = String(job.id)
    dispatching = true
  }
}
