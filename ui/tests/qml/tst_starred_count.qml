import QtQuick 2.15
import QtTest 1.3
import "../../account" as Account

// The Flagged total on its own, against a mailbox and a client the test controls:
// when it is read, what a read asks for, and which answers it keeps.
Item {
  QtObject {
    id: platformStub
    property bool unified: false
  }

  QtObject {
    id: client
    property var asked: []
    function listMessages(query, limit, token, callback) {
      asked = asked.concat([{ query: query, limit: limit, token: token, callback: callback }])
    }
  }

  QtObject {
    id: mailbox
    property bool ready: true
    property bool credentialsRejected: false
    property bool active: true
    property bool windowOpen: false
    property string providerId: "exchange"
    property var platform: platformStub
    property var api: client
  }

  Account.StarredCount {
    id: counter
    account: mailbox
  }

  TestCase {
    name: "StarredCount"

    function init() {
      mailbox.windowOpen = false
      mailbox.active = true
      mailbox.ready = true
      mailbox.credentialsRejected = false
      mailbox.providerId = "exchange"
      platformStub.unified = false
      counter.timer.stop()
      counter.forget()
      counter.readAt = 0
      client.asked = []
    }

    function show() {
      mailbox.windowOpen = true
      asks(1)
    }

    function asks(n) {
      tryVerify(function() { return client.asked.length === n }, 1000, "reads: " + client.asked.length)
    }

    // Nothing draws the number unless the window shows this one mailbox, so
    // nothing asks for it: not with the window shut, another mailbox on screen,
    // a merged view, or a provider whose server does not count the view.
    function test_nothing_is_read_unless_this_mailbox_is_on_screen_alone() {
      counter.refresh()
      mailbox.active = false
      mailbox.windowOpen = true
      counter.refresh()
      platformStub.unified = true
      mailbox.active = true
      counter.refresh()
      mailbox.windowOpen = false
      platformStub.unified = false
      mailbox.providerId = "imap"
      mailbox.windowOpen = true
      counter.refresh()
      wait(50)
      compare(client.asked.length, 0)
      compare(counter.count, 0)
    }

    // Showing the mailbox asks once, on the next turn, for a page of one row:
    // only its estimate is wanted. However many ask in one turn, one read goes.
    function test_showing_the_mailbox_reads_once_on_the_next_turn() {
      mailbox.windowOpen = true
      compare(client.asked.length, 0, "not ahead of what the caller sends this turn")
      asks(1)
      compare(client.asked[0].query, "role:inbox flagged")
      compare(client.asked[0].limit, 1)
      compare(client.asked[0].token, "")
      client.asked[0].callback({ estimate: 12 })
      compare(counter.count, 12)
      counter.ask()
      counter.ask()
      counter.ask()
      wait(50)
      compare(client.asked.length, 2)
    }

    // A poll right behind a read asks nothing; one later asks again, and none
    // asks with the window shut.
    function test_a_poll_reads_again_only_after_ten_seconds() {
      show()
      counter.poll()
      wait(50)
      compare(client.asked.length, 1)
      counter.readAt = Date.now() - 10001
      counter.poll()
      asks(2)
      mailbox.windowOpen = false
      counter.readAt = 0
      counter.poll()
      wait(50)
      compare(client.asked.length, 2)
    }

    // An answer a newer question has overtaken is dropped, and a missing page
    // leaves the last number.
    function test_only_the_newest_answer_is_kept() {
      show()
      counter.refresh()
      compare(client.asked.length, 2)
      client.asked[1].callback({ estimate: 4 })
      compare(counter.count, 4)
      client.asked[0].callback({ estimate: 9 })
      compare(counter.count, 4, "the older answer came last and changed nothing")
      counter.refresh()
      client.asked[2].callback(null)
      compare(counter.count, 4)
    }

    // A mailbox that stops being ready, or whose password is refused, keeps no
    // number, and a read already sent cannot bring the old one back.
    function test_not_ready_or_refused_forgets_the_count() {
      show()
      client.asked[0].callback({ estimate: 3 })
      compare(counter.count, 3)
      counter.refresh()
      mailbox.ready = false
      compare(counter.count, 0)
      client.asked[1].callback({ estimate: 3 })
      compare(counter.count, 0)

      mailbox.ready = true
      counter.refresh()
      client.asked[2].callback({ estimate: 5 })
      compare(counter.count, 5)
      counter.refresh()
      mailbox.credentialsRejected = true
      compare(counter.count, 0)
      client.asked[3].callback({ estimate: 5 })
      compare(counter.count, 0)
    }
  }
}
