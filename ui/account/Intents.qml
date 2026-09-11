import QtQuick

// Only serializes desktop snapshots across IPC. The backend owns pending
// intents, optimistic list rules and replay after an out-of-order refusal.
QtObject {
  id: intents
  required property var account
  property var queue: []
  property bool running: false
  property var generation: -1
  property int epoch: 0
  property string boundAccountId: account ? String(account.accountId || "") : ""
  property string previousAccountId: ""
  onBoundAccountIdChanged: {
    epoch++
    var oldGeneration = generation
    generation = -1
    if (oldGeneration >= 0 && previousAccountId !== "" && account && account.backend)
      account.backend.call("model.intent", {operation: "clear", accountId: previousAccountId,
        generation: oldGeneration}, function() {})
    if (previousAccountId !== "" && account) {
      account.actionPreparations = 0
      account.pendingAction = ""
      account.pendingActionQuery = ""
      account.queuedActions = []
    }
    previousAccountId = boundAccountId
  }
  Component.onDestruction: {
    if (generation >= 0 && previousAccountId !== "" && account && account.backend)
      account.backend.call("model.intent", {operation: "clear", accountId: previousAccountId,
        generation: generation}, function() {})
  }

  function errorText(error) {
    if (!error) return ""
    var code = String(error.message || error)
    if (code === "intent_limit") return "Too many changes are still finishing"
    if (code === "model_message_missing") return "This message is no longer in the list"
    if (code === "intent_stale") return "The mailbox changed before this action finished"
    return "Could not update this mailbox"
  }

  function enqueue(work) {
    var next = queue.slice()
    next.push(work)
    queue = next
    pump()
  }

  function pump() {
    if (running || queue.length === 0) return
    var next = queue.slice()
    var work = next.shift()
    queue = next
    running = true
    work(function() { intents.running = false; intents.pump() })
  }

  function begin(parameters, callback) {
    var requestedView = account.intentView()
    var mine = epoch
    enqueue(function(release) {
      if (mine !== intents.epoch || parameters.accountId !== account.accountId) {
        callback(null, "Account changed", "")
        release()
        return
      }
      if (!account.backend) { callback(null, "Mail backend is unavailable", ""); release(); return }
      function prepare() {
        if (mine !== intents.epoch) { callback(null, "Account changed", ""); release(); return }
        parameters.operation = "begin"
        parameters.generation = intents.generation
        parameters.view = account.cacheKey === parameters.query ? account.intentView() : requestedView
        var selected = String(parameters.view.selectedId || "")
        account.backend.call("model.intent", parameters, function(result, error) {
          callback(result, intents.errorText(error), selected)
          release()
        })
      }
      if (intents.generation >= 0) { prepare(); return }
      account.backend.call("model.intent", {operation: "reset", accountId: parameters.accountId},
        function(result, error) {
          if (error || !result || mine !== intents.epoch) {
            callback(null, intents.errorText(error) || "Account changed", "")
            release()
            return
          }
          intents.generation = result.generation
          prepare()
        })
    })
  }

  function settle(accountId, query, token, failedIds, callback, epoch) {
    enqueue(function(release) {
      if (!account.backend) { callback(null, "Mail backend is unavailable"); release(); return }
      account.backend.call("model.intent", {operation: "settle", accountId: accountId,
        query: query, token: token, failedIds: failedIds,
        generation: epoch === undefined ? intents.generation : epoch,
        view: {selectedId: account.selectedId, selectedMessage: account.selectedMessage}},
        function(result, error) { callback(result, intents.errorText(error)); release() })
    })
  }

  function coalesce(accountId, query, token, intoToken, epoch) {
    enqueue(function(release) {
      if (!account.backend) { release(); return }
      account.backend.call("model.intent", {operation: "coalesce", accountId: accountId,
        query: query, generation: epoch, token: token, intoToken: intoToken},
        function(result, error) {
          if (error) account.fail("Could not combine repeated actions")
          release()
        })
    })
  }

  function clear() {
    epoch++
    var accountId = account.accountId
    var oldGeneration = generation
    generation = -1
    enqueue(function(release) {
      if (!account.backend || oldGeneration < 0) { release(); return }
      account.backend.call("model.intent", {operation: "clear", accountId: accountId,
        generation: oldGeneration}, function() { release() })
    })
  }
}
