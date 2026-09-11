import QtQuick
import "Model.js" as Model
import "../providers/Registry.js" as Provider

// Several rows at once: the ticked ones. One optimistic edit for the lot,
// taken at the keystroke whatever is in flight, and one send that waits for
// the slot behind whatever holds it — one request where the client takes a
// list, one per row where it answers per message. Each row expands to its
// counted members the way a single action does, so a conversation row marked
// read reads as one across the rail as well as in the list. Each row's edit
// is its own intent under the batch's token, so a refusal on one row puts
// back that row and no other, and an edit taken on a row after the batch
// stays where a snapshot of the list would have lost it. A second caller of
// the account's queue and its `Intents`, kept beside it rather than in it:
// the account file is at its size ceiling.
QtObject {
  id: batch

  required property var account
  required property var intents

  function run(ids, action) {
    var wanted = []
    var given = Array.isArray(ids) ? ids : []
    for (var g = 0; g < given.length; g++) wanted.push(String(given[g]))
    if (!account.ready || wanted.length === 0) return false
    if (account.refuseUnavailableAction(action)) return false
    // Only the send waits for the slot; the rows move now, as one row does.
    var slotTaken = account.pendingAction !== ""
    var sourceLabelId = account.hasLabels ? account.rawLabelId : ""
    var change = action === "trash" || action === "untrash"
      ? { add: [], remove: [] } : Model.labelChangesFor(action, sourceLabelId)
    if (!change) return false
    var rows = []
    var listed = []
    for (var l = 0; l < account.messages.length; l++) {
      if (wanted.indexOf(String(account.messages[l].id)) < 0) continue
      rows.push(account.messages[l])
      listed.push(String(account.messages[l].id))
    }
    if (listed.length === 0) return false

    // The messages this action is sent for: every row's counted members, as
    // for a single action, so no client expands anything.
    var conversationAction = Model.actionScope(action) === "conversation"
    var targets = []
    var targetsOf = ({})
    for (var r = 0; r < rows.length; r++) {
      var own = Model.actionTargets(rows[r], action)
      targetsOf[String(rows[r].id)] = own
      for (var o = 0; o < own.length; o++) {
        if (targets.indexOf(own[o]) < 0) targets.push(own[o])
      }
    }
    if (targets.length === 0) return false

    var actionQuery = account.cacheKey
    var actionEstimate = account.resultEstimate
    var actionToken = account.nextPageToken
    // A live list owns snapshots taken before this action, for the reason
    // `act` gives. Stopped now, and again when a queued send goes out.
    var interrupted = false
    function stopLiveList() {
      if (account.cacheKey !== actionQuery || !account.listLoading) return
      interrupted = true
      account.listSerial++
      account.abortRequest(account.listHandle)
      account.listHandle = null
      account.listLoading = false
      account.nextPageToken = ""
      actionToken = ""
    }
    stopLiveList()
    var token = intents.nextToken()
    intents.holdLists(actionQuery)

    // Every member summary the rail holds for a target takes the change; a
    // representative takes its row's, block and all. What each was is kept
    // so a refusal can put it back.
    var memberBefore = ({})
    var memberAfter = ({})
    function memberAfterOf(summary) {
      return Model.applyLabelChange(summary, action, sourceLabelId)
    }
    for (var t = 0; t < targets.length; t++) {
      var known = account.memberSummaries[targets[t]]
      if (!known) continue
      var after = memberAfterOf(known)
      if (!after || after === known) continue
      memberBefore[targets[t]] = known
      memberAfter[targets[t]] = after
    }
    // What the action makes of a row, from whichever state it is applied to:
    // its own now, an earlier one if an edit ahead of it fails.
    function rowAfterOf(row) {
      if (conversationAction) {
        // Every counted member was sent the same patch, so the row says so
        // at once rather than waiting for the next read to agree.
        return Model.applyLabelChange(row, action, sourceLabelId,
          Model.threadAfterAction(row, action))
      }
      var id = String(row.id)
      return Model.rowAfterMemberEdit(row, Model.applyLabelChange(row, action, sourceLabelId),
        id, account.memberSummaries, targetsOf[id] || [], memberAfterOf)
    }

    var next = []
    var nextPreview = account.previewMessages.slice()
    var unreadDelta = 0
    var selectedGone = false
    var removedIds = []
    var edits = []
    var readerKey = ""
    var readerRow = ""
    for (var j = 0; j < account.messages.length; j++) {
      var row = account.messages[j]
      var rowId = String(row.id)
      if (listed.indexOf(rowId) < 0) {
        next.push(row)
        continue
      }
      var updated = rowAfterOf(row)
      if (account.memberSummaries[rowId]) {
        memberBefore[rowId] = account.memberSummaries[rowId]
        memberAfter[rowId] = updated
      }
      if (action === "markRead" && row.unread && !updated.unread) unreadDelta--
      if (action === "markUnread" && !row.unread && updated.unread) unreadDelta++
      var survives = Model.survivesAction(account.mailboxKey, action, account.rawQuery, account.hasLabels,
        sourceLabelId, updated)
      if (survives) next.push(updated)
      else removedIds.push(rowId)
      var previewIndex = Model.indexById(account.previewMessages, rowId)
      if (previewIndex >= 0) {
        nextPreview = updated.unread
          ? Model.replaceById(nextPreview, updated)
          : Model.removeById(nextPreview, rowId)
      }
      // The reader's copy takes the edit of what it shows.
      if (Model.rowHoldsMember(row, account.selectedId)) {
        if (!survives) selectedGone = true
        else if (account.selectedMessage) {
          var readerAfter = account.selectedId === rowId ? rowAfterOf
            : (memberAfter[account.selectedId] || targetsOf[rowId].indexOf(account.selectedId) >= 0
              ? memberAfterOf : null)
          if (readerAfter) {
            readerKey = "reader:" + account.selectedId
            readerRow = rowId
            intents.add(readerKey, { token: token, before: account.selectedMessage, apply: readerAfter })
            account.selectedMessage = readerAfter(account.selectedMessage)
          }
        }
      }
      var members = []
      var owned = targetsOf[rowId]
      for (var m = 0; m < owned.length; m++) {
        if (memberBefore[owned[m]] !== undefined) members.push(owned[m])
      }
      // Held until answered; the row's says whether it left the list.
      intents.add(rowId, { token: token, before: row, apply: rowAfterOf, removed: !survives })
      edits.push({ token: token, query: actionQuery, rowId: rowId, before: row, removed: !survives,
        index: j, previewIndex: previewIndex, members: members, memberBefore: memberBefore })
    }
    var changedMembers = false
    for (var held in memberBefore) {
      changedMembers = true
      if (listed.indexOf(held) < 0)
        intents.add(held, { token: token, before: memberBefore[held], apply: memberAfterOf })
    }
    if (changedMembers) account.mergeMembers(memberAfter)
    account.inboxUnread = Math.max(0, account.inboxUnread + unreadDelta)
    var opaqueQuery = account.effectiveQuery
      !== Provider.query(account.providerId, account.mailboxKey, "", "")
    var invalidatesPage = removedIds.length > 0 || opaqueQuery
    account.messages = next
    account.previewMessages = nextPreview
    if (selectedGone) account.clearSelection()
    if (invalidatesPage) account.nextPageToken = ""
    var optimistic = account.messages.slice()
    var optimisticToken = account.nextPageToken
    if (!interrupted) account.rememberList()

    // Answered row by row: a refused row's edit comes off, replayed over
    // whatever was taken on it since, and the rest are agreed to. The list
    // is built once — on screen, or in the cache of a query navigated away
    // from — and assigned once.
    function settleAll(refused, pageToken) {
      var lists = refused.length > 0 ? intents.listsOf(actionQuery) : null
      for (var e = 0; e < edits.length; e++) {
        if (lists && refused.indexOf(edits[e].rowId) >= 0) lists = intents.restore(edits[e], lists)
        else intents.keep(edits[e])
      }
      if (lists) intents.commit(actionQuery, lists, actionEstimate, pageToken)
      intents.settleReader(readerKey, token, refused.indexOf(readerRow) >= 0)
      intents.releaseLists(actionQuery)
    }

    // A failure is not proof that nothing changed. One request per row
    // reports each on its own, and only the rows whose request failed go
    // back where they were. A provider that answers a whole batch with one
    // word — Gmail's batchModify, IMAP's plan across folders — may have done
    // part of it, so every row goes back and the list is read again from the
    // server, which settles whatever it did do.
    var done = function(payload, error, failedIds) {
      account.pendingAction = ""
      account.pendingActionQuery = ""
      account.runQueuedAction()
      if (error) {
        var partial = Array.isArray(failedIds)
        var note = partial
          ? Model.batchFailureNote(listed.length, failedIds.length, account.actionLabel(action), error)
          : String(error)
        // After a partial refusal the page is not whole: the rows that did go
        // are gone, and a page token the optimistic update cleared names a
        // page that no longer starts where it did, so it is read again from
        // the server rather than put back.
        settleAll(partial ? failedIds : listed, partial ? "" : actionToken)
        if (intents.showing(actionQuery) && !interrupted) account.rememberList()
        account.refreshCounts()
        account.fail(note)
        if (account.resumeDeferredListLoad(actionQuery, note)) return
        if (account.cacheKey === actionQuery && (!partial || invalidatesPage))
          account.loadMessages(false, true, note)
        return
      }
      settleAll([], optimisticToken)
      account.note(Model.batchNote(listed.length, account.actionLabel(action)))
      account.refreshCounts()
      if (interrupted && account.deferredLoadCleared(actionQuery)
          && account.cache.loaded) {
        account.cache.putQuery(actionQuery, ({
          summaries: optimistic,
          estimate: actionEstimate,
          nextPageToken: optimisticToken
        }))
      }
      if (account.resumeDeferredListLoad(actionQuery, "")) return
      if (interrupted && account.cacheKey === actionQuery) {
        account.rememberList()
        account.loadMessages(false, true, "")
      } else if (interrupted && account.cache.loaded) {
        account.cache.putQuery(actionQuery, ({
          summaries: optimistic,
          estimate: actionEstimate,
          nextPageToken: optimisticToken
        }))
      } else if (invalidatesPage && account.cacheKey === actionQuery) {
        account.loadMessages(false, true, "")
      }
      if (account.active && account.cacheKey !== actionQuery)
        account.loadMessages(false, true, "")
    }

    function dispatch() {
      stopLiveList()
      account.pendingActionQuery = actionQuery
      account.pendingAction = action
      if (action === "trash" || action === "untrash") {
        // One request per row, so each answers for itself: `trashMessage` and
        // `untrashMessage` take a row's whole list of members on every client.
        var remaining = listed.length
        var firstError = ""
        var failed = []
        var each = function(id) {
          return function(payload, error) {
            if (error) {
              if (firstError === "") firstError = String(error)
              failed.push(id)
            }
            remaining--
            if (remaining === 0) done(null, firstError, failed)
          }
        }
        for (var d = 0; d < listed.length; d++) {
          var sent = targetsOf[listed[d]].length > 1 ? targetsOf[listed[d]] : targetsOf[listed[d]][0]
          if (action === "trash") account.api.trashMessage(sent, each(listed[d]))
          else account.api.untrashMessage(sent, each(listed[d]))
        }
        return
      }
      account.api.batchModify(targets, change.add, change.remove, done)
    }
    // A send already queued for these rows and this verb took its place.
    function discard() { settleAll([], "") }
    if (slotTaken) account.queueAction(listed.join(","), action, actionQuery, false, false, dispatch, discard)
    else dispatch()
    return true
  }
}
