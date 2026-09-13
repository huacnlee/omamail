import QtQuick
import "Agent.js" as Agent
import "../account/Unified.js" as Unified

// The events the agent finds in the message being read, and the one thing
// that starts a look: the body arriving in the reader. With the setting on,
// a message whose text mentions a date is handed over once, in the
// background; the answer is the card the reader draws, and "Add" hands the
// event to the calendar's composer to be looked at before it is written
// anywhere.
//
// Rust reads the message for the look the way it does for an ask —
// `agent.context`, account-bound — and the runner starts the job with the
// `events` flag; the worker's own rules and answer parsing do the rest.
// Beside the service rather than in it, which is near its size ceiling.
Item {
  id: root

  required property var service
  required property var runner

  // The keys of the suggestions waved away this session. Not persisted: a
  // restart shows them again, which is the honest answer for a guess.
  property var dismissed: []
  // The suggestion handed to the composer, waved away once the event is
  // written — and not before, in case the composer is closed instead, which
  // forgets it: a later event written from anywhere is not this one.
  property var pending: null
  // Looks asked for that could not start yet — a read or a start already in
  // flight, or two looks running — kept by key and tried again when one
  // lands or a look finishes; and the keys of looks started but not yet
  // listed, so a body that arrives twice (from the cache, then live) asks
  // once.
  property var waiting: []
  property var started: []
  // A read of the message for the look is in flight. One at a time: the
  // runner refuses a second start until the first lands, and a read that
  // finished with nowhere to go would be a message read for nothing.
  property bool preparing: false
  property int serial: 0
  // The system AI is not one the native worker runs — Omarchy's default
  // agent is Codex, say. Rust refuses the first look with a word; the rest
  // of the session asks nothing more, silently, and turning the setting
  // off and on asks again. The panel says why when the owner opens it.
  property bool unavailable: false

  readonly property var reading: service ? service.reading : null
  readonly property var suggestions: Agent.eventSuggestions(
    Agent.lookFor(runner ? runner.eventLooks : null,
      reading ? reading.accountId : "", reading ? reading.selectedId : ""), dismissed)

  Connections {
    target: root.reading
    function onSelectedBodyChanged() { root.consider() }
  }
  Connections {
    target: root.service
    function onSuggestEventsChanged() { root.unavailable = false; root.consider() }
    // Retry when the connected backend meets this feature's fixed API requirement.
    function onBackendCanSuggestEventsChanged() { root.consider() }
  }
  Connections {
    target: root.runner
    function onStartingChanged() { if (!root.runner.starting) root.drain() }
    function onEventLooksChanged() { root.drain() }
    function onStartRefused(code) {
      if (String(code) === "agent_choose_claude") { root.unavailable = true; root.waiting = [] }
      root.started = []
    }
  }
  onPreparingChanged: if (!preparing) drain()

  function lookedAt(accountId, messageId) {
    return Agent.lookFor(runner ? runner.eventLooks : null, accountId, messageId) !== null
  }

  // Whether the open message is worth a look, and the look if so. Every
  // gate is cheap and local: the setting, text with a date in it, a message
  // from the last two months, no look at it yet, and no more than a couple
  // of looks already running.
  function consider() {
    var account = reading
    if (!account || !service || service.suggestEvents !== true || !service.hasAgent || unavailable
        || !service.backendCanSuggestEvents) return false
    var id = String(account.selectedId || "")
    var summary = account.selectedMessage
    if (id === "" || !summary || String(summary.id || "") !== id) return false
    // The subject counts: "Dinner Thursday at 7pm" over a body that says
    // only "see you there" is a message about a date. Mail from a machine
    // or a list is not asked about, however many dates it carries.
    var text = String(summary.subject || "") + "\n"
      + (account.selectedBody ? String(account.selectedBody.text || "") : "")
    if (!Agent.worthALook(summary, text, !!account.selectedUnsubscribe)) return false
    if (Agent.tooOldForEvents(Unified.messageTime(summary), Date.now())) return false
    var key = String(account.accountId || "") + " " + id
    if (started.indexOf(key) >= 0 || lookedAt(account.accountId, id)) return false
    return tryStart({ key: key, accountId: String(account.accountId || ""), id: id,
      summary: summary, folder: String(account.mailboxKey || "") })
  }

  // A look started if nothing else is starting and fewer than the ceiling
  // are running; otherwise kept, once, for the next chance.
  function tryStart(look) {
    var free = !preparing && runner && !runner.starting
      && runner.activeEventLooks < Agent.EVENTS_IN_FLIGHT
    if (free && start(look)) {
      started = started.concat([look.key])
      return true
    }
    var kept = waiting.filter(function(w) { return w.key !== look.key })
    waiting = kept.concat([look])
    return false
  }

  // The message, read by Rust inside its account and handed to the runner
  // with the flag. A read that fails is a look not taken, said on the
  // status line; the message may be looked at again later.
  function start(look) {
    if (!service || !service.backend || !service.backend.ready) return false
    var token = ++serial
    preparing = true
    service.backend.call("agent.context", { accountId: look.accountId,
      requestId: "events-" + Date.now() + "-" + token, ids: [look.id],
      summaries: [look.summary], folder: look.folder, prompt: Agent.EVENTS_PROMPT },
      function(result, failure) {
        if (token !== root.serial) return
        root.preparing = false
        var payload = result ? result.payload : null
        if (failure || !payload || String(payload.accountId || "") !== look.accountId) {
          root.started = root.started.filter(function(key) { return key !== look.key })
          return
        }
        payload.events = true
        if (!root.runner.start(payload, true))
          root.started = root.started.filter(function(key) { return key !== look.key })
      })
    return true
  }

  // The looks kept waiting, tried in order until one cannot start. A look
  // whose message was looked at meanwhile, or whose account is gone, is
  // dropped rather than asked; keys the listing now carries leave `started`.
  function drain() {
    started = started.filter(function(key) {
      var at = key.indexOf(" ")
      return !root.lookedAt(key.slice(0, at), key.slice(at + 1))
    })
    var queue = waiting
    waiting = []
    for (var i = 0; i < queue.length; i++) {
      var look = queue[i]
      if (!service || !service.findAccount(look.accountId)) continue
      if (started.indexOf(look.key) >= 0 || lookedAt(look.accountId, look.id)) continue
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
