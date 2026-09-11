import QtQuick
import "Model.js" as Model
import "../cache/Cache.js" as Cache

// The edits waiting for their server, and what a refused one leaves behind.
//
// An optimistic edit is an intent: what a summary should say if the server
// agrees. Edits are taken at the keystroke, so one row can carry several
// before the first is answered, and the answer to one must not undo the
// others. Each summary an edit touched — the row, a member the rail draws,
// the reader's copy — keeps its intents in the order they were taken, each
// with the summary as it stood before it and the function that made the edit.
// A success drops its intent and nothing else, since the summaries the later
// ones started from already hold it. A failure drops its intent and replays
// the ones behind it from where the failed one started, so what stays on
// screen is exactly the edits still waiting.
//
// The rules are `Model.rebaseIntents` and its neighbours. This is the object
// that applies an answer to the account's lists — on screen, or in the cache
// when the view has moved on — and it is the one path for a single action,
// the batch and mark-all alike, so a bulk refusal cannot put back a snapshot
// over an edit taken a keystroke after it. Kept beside the account rather
// than in it: that file is at its size ceiling.
QtObject {
  id: intents

  required property var account

  // By summary id; `reader:` + id for the reader's copy.
  property var held: ({})
  property int serial: 0
  // Each query's lists as they stood before the first edit still in flight
  // on it, held while any is: the order a refused row goes back into. The
  // list the refused edit itself saw is not enough, because with two removals
  // queued the second saw a list the first had already shortened.
  property var settledLists: ({})

  function nextToken() { return ++serial }

  function add(id, entry) { held = Model.intentsWith(held, id, entry) }

  // Dropped on either answer; a failure also replays the intents behind it.
  function settle(id, token, failed, fallback) {
    var next = Model.intentsSettled(held, id, token, failed, fallback)
    held = next.intents
    return next.outcome
  }

  // Before the edit is applied: it is the lists as they stand that are held.
  function holdLists(query) {
    settledLists = Model.settledListsHeld(settledLists, query,
      account.messages, account.previewMessages)
  }

  function releaseLists(query) {
    settledLists = Model.settledListsReleased(settledLists, query)
  }

  // Whether the query's list is the one on screen and still stands.
  function showing(query) {
    return account.cacheKey === query && !account.deferredLoadCleared(query)
  }

  // An edit, as `act` and the bulk actions describe one: the row it changed
  // (`rowId`, `before`, `removed`, `index`, `previewIndex`), the members it
  // changed (`members`, `memberBefore`) and the query it was taken on, all
  // under one `token`. The reader's copy is settled apart, since a bulk edit
  // touches many rows and one reader.

  // Agreed to, or a repeat took the send's place: the intents come off and
  // nothing on screen changes.
  function keep(edit) {
    settle(edit.rowId, edit.token, false, null)
    for (var m = 0; m < edit.members.length; m++) {
      if (edit.members[m] !== edit.rowId) settle(edit.members[m], edit.token, false, null)
    }
  }

  // Where a refused edit on `query` goes back: the lists on screen while the
  // query is the one showing, else the cached copy the next visit paints
  // from — rebased, not replaced by the list the edit saw, which an edit
  // ahead of it may already have shortened. Null messages means nothing is
  // held for the query anywhere, and there is nothing to repair.
  function listsOf(query) {
    if (showing(query)) {
      return { messages: account.messages, previews: account.previewMessages, cached: false }
    }
    var entry = account.cache.loaded ? account.cache.get(query) : null
    return {
      messages: entry ? Cache.hydrate(entry.summaries) : null,
      previews: account.previewMessages,
      cached: true
    }
  }

  // Refused: only this edit comes off. The rail first, since the row's replay
  // reads the members as they stand; then the row into `lists`, the preview,
  // and the rail's copy of the row. Answers the lists with the row put right,
  // so a bulk refusal builds its list once and assigns it once.
  function restore(edit, lists) {
    for (var m = 0; m < edit.members.length; m++) {
      if (edit.members[m] === edit.rowId) continue
      account.rememberMember(settle(edit.members[m], edit.token, true,
        edit.memberBefore[edit.members[m]]).summary)
    }
    var outcome = settle(edit.rowId, edit.token, true, edit.before)
    var row = outcome.summary
    var stillRemoved = Model.anyIntentRemoved(outcome.entries)
    var settled = settledLists[edit.query] || { messages: [], previews: [] }
    var out = { messages: lists.messages, previews: lists.previews, cached: lists.cached }
    if (edit.index >= 0 && lists.messages) {
      out.messages = Model.listAfterRestore(lists.messages, row, edit.removed,
        stillRemoved, settled.messages, edit.index)
    }
    if (edit.previewIndex >= 0) {
      out.previews = Model.previewAfterRestore(lists.previews, row,
        row.unread && !stillRemoved, settled.previews, edit.previewIndex)
    }
    if (account.memberSummaries[edit.rowId]) account.rememberMember(row)
    return out
  }

  // The repaired lists, back where they came from: the screen, or the cache
  // of the query navigated away from, without touching the view now shown.
  function commit(query, lists, estimate, pageToken) {
    if (lists.previews !== account.previewMessages) account.previewMessages = lists.previews
    if (!lists.cached) {
      if (lists.messages !== account.messages) account.messages = lists.messages
      return
    }
    if (!lists.messages || !account.cache.loaded) return
    account.cache.putQuery(query, ({
      summaries: lists.messages,
      estimate: estimate,
      nextPageToken: pageToken
    }))
  }

  // The reader's copy is one intent under the token of the edit that changed
  // it, and goes back only while the reader still shows that message.
  function settleReader(key, token, failed) {
    if (key === "") return
    var reader = settle(key, token, failed, null)
    if (failed && key === "reader:" + account.selectedId && reader.summary)
      account.selectedMessage = reader.summary
  }
}
