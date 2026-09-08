import QtQuick
import "Agent.js" as Agent
import "../account/Unified.js" as Unified

// The events the agent finds in the message being read, and the one thing
// that starts a look: the body arriving in the reader. With the setting on
// and an agent set, a message whose text mentions a date is handed over
// once, in the background; the answer is the card the reader draws, and
// "Add" hands the event to the calendar's composer to be looked at before
// it is written anywhere.
//
// Beside the service rather than in it, which is near its size ceiling.
Item {
  id: root

  required property var service

  // The keys of the suggestions waved away this session. Not persisted: a
  // restart shows them again, which is the honest answer for a guess.
  property var dismissed: []
  // The suggestion handed to the composer, waved away once the event is
  // written — and not before, in case the composer is closed instead, which
  // forgets it: a later event written from anywhere is not this one.
  property var pending: null
  // Looks asked for that the runner could not start yet — a start already
  // in flight, or two looks running — kept by key and tried again when a
  // start lands or a look finishes; and the keys of looks started but not
  // yet listed, so a body that arrives twice (from the cache, then live)
  // asks once.
  property var waiting: []
  property var started: []

  readonly property var reading: service ? service.reading : null
  readonly property var suggestions: Agent.eventSuggestions(service ? service.agentPaneJobs : [],
    reading ? reading.accountId : "", reading ? reading.selectedId : "", dismissed)

  Connections {
    target: root.reading
    function onSelectedBodyChanged() { root.consider() }
  }
  Connections {
    target: root.service
    function onSuggestEventsChanged() { root.consider() }
    function onAgentStartingChanged() { if (!root.service.agentStarting) root.drain() }
    function onAgentPaneJobsChanged() { root.drain() }
  }

  // Whether the open message is worth a look, and the look if so. Every
  // gate is cheap and local: the setting, an agent, text with a date in
  // it, a message from the last two months, no look at it yet, and no more
  // than a couple of looks already running.
  function consider() {
    var account = reading
    if (!account || !service || service.suggestEvents !== true || !service.hasAgent) return false
    var id = String(account.selectedId || "")
    var summary = account.selectedMessage
    if (id === "" || !summary || String(summary.id || "") !== id) return false
    var text = account.selectedBody ? String(account.selectedBody.text || "") : ""
    if (!Agent.mentionsDate(text)) return false
    if (Agent.tooOldForEvents(Unified.messageTime(summary), Date.now())) return false
    var key = String(account.accountId || "") + " " + id
    if (started.indexOf(key) >= 0 || Agent.hasEventsJob(service.agentPaneJobs, id, account.accountId)) return false
    return tryStart({ key: key, account: account, summary: summary, text: text })
  }

  // A look started if the runner is free and fewer than the ceiling are
  // running; otherwise kept, once, for the next chance.
  function tryStart(look) {
    var jobs = service.agentPaneJobs
    var free = !service.agentStarting && Agent.activeEventsJobs(jobs) < Agent.EVENTS_IN_FLIGHT
    if (free && service.startEventsJob(look.account, look.summary, look.text)) {
      started = started.concat([look.key])
      return true
    }
    var kept = waiting.filter(function(w) { return w.key !== look.key })
    waiting = kept.concat([look])
    return false
  }

  // The looks kept waiting, tried in order until one cannot start. A look
  // whose message was looked at meanwhile, or whose account is gone, is
  // dropped rather than asked; keys the listing now carries leave `started`.
  function drain() {
    var jobs = service ? service.agentPaneJobs : []
    started = started.filter(function(key) {
      var at = key.indexOf(" ")
      return !Agent.hasEventsJob(jobs, key.slice(at + 1), key.slice(0, at))
    })
    var queue = waiting
    waiting = []
    for (var i = 0; i < queue.length; i++) {
      var look = queue[i]
      if (!look.account || !service.findAccount(look.account.accountId)) continue
      if (started.indexOf(look.key) >= 0 || Agent.hasEventsJob(jobs, String(look.summary.id || ""), look.account.accountId)) continue
      if (!tryStart(look)) { waiting = waiting.concat(queue.slice(i + 1)); return }
    }
  }

  function dismiss(key) {
    var value = String(key || "")
    if (value !== "" && dismissed.indexOf(value) < 0) dismissed = dismissed.concat([value])
  }

  // Add: the composer opens on the suggestion, unless the owner is in the
  // middle of another event there, or there is no calendar to write to —
  // either is said on the status line rather than swallowed.
  function compose(suggestion) {
    var controller = service ? service.calendarController : null
    if (!suggestion || !controller) return false
    var groups = controller.writableSourceGroups || []
    if (groups.length === 0) {
      if (reading) reading.fail("No calendar to add it to: add one in the calendar's settings first")
      return false
    }
    if (controller.composerHeld) {
      if (reading) reading.fail("Finish the event you are editing first")
      return false
    }
    pending = suggestion
    controller.composeRequested(Agent.eventPrefill(suggestion, reading ? reading.accountId : ""))
    return true
  }

  Connections {
    target: root.service ? root.service.calendarController : null
    function onEventCreated(ok, error) {
      if (!ok || !root.pending) return
      root.dismiss(root.pending.key)
      root.pending = null
    }
    function onComposeEnded() { root.pending = null }
  }
}
