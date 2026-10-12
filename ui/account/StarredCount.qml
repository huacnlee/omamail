import QtQuick
import "../providers/Registry.js" as Provider

// The number beside Flagged, for a provider whose listing counts that view
// (`Registry.countsStarred`); 0 draws none. Beside the account rather than in
// it, which is at its size ceiling. Only a window showing this one mailbox draws
// the number, so it is read then: when that begins, after a refresh or an
// action, and behind a poll; never with the window shut or in a merged view.
QtObject {
  id: root

  required property var account
  property int count: 0
  property int serial: 0
  // When the count was last asked for: a poll right behind a refresh's own read
  // does not ask again.
  property real readAt: 0
  readonly property bool ready: !!account && account.ready
  readonly property bool rejected: !!account && account.credentialsRejected
  readonly property bool shown: !!account && account.active && account.windowOpen
    && !(account.platform && account.platform.unified === true)
  onShownChanged: if (shown) ask()
  onReadyChanged: if (!ready) forget()
  onRejectedChanged: if (rejected) forget()

  // On the next turn, once, however many asked: after the new-mail listing a
  // refresh sends rather than ahead of it.
  readonly property Timer timer: Timer { interval: 0; onTriggered: root.refresh() }
  function ask() { timer.restart() }

  // The total on screen follows the server as the list does.
  function poll() { if (shown && Date.now() - readAt > 10000) ask() }

  // A page of one row: only its estimate is wanted. An answer a newer question
  // or a refusal has overtaken is dropped.
  function refresh() {
    if (!ready || !shown || !Provider.countsStarred(account.providerId)) return
    var asked = ++serial
    readAt = Date.now()
    account.api.listMessages(Provider.mailboxFor(account.providerId, "starred").query, 1, "",
      function(page) { if (asked === root.serial && page && root.ready) root.count = page.estimate })
  }

  function forget() {
    serial++
    count = 0
  }
}
