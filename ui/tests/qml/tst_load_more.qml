import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Mail

// The next page comes as the list is scrolled to its foot: once per foot,
// never while a page is on its way, and not at all when there is no more.
// The button stays for the page that did not come.
Item {
  width: 400
  height: 300

  QtObject {
    id: fakeService
    property var messages: []
    property bool hasMore: true
    property bool listLoading: false
    property bool listLoaded: true
    property string searchQuery: ""
    property string selectedId: ""
    property bool canArchive: true
    property string contentDirection: "auto"
    property int loads: 0
    function loadMore() { loads++; listLoading = true }
    function act(_id, _action) {}
    function toggleStar(_id) {}
  }

  Flickable {
    id: flick
    anchors.fill: parent
    contentWidth: width
    contentHeight: list.implicitHeight + 16
    clip: true
    Mail.MessageList {
      id: list
      scroller: flick
      width: flick.width
      service: fakeService
      textColor: Color.foreground
      accentColor: Color.accent
      dimColor: Color.foreground
      urgentColor: Color.accent
      panelFontFamily: "monospace"
    }
  }

  TestCase {
    name: "LoadMore"
    when: windowShown

    function row(id) {
      return ({ id: id, threadId: "", from: { email: "x@example.com", display: "X" }, subject: "Message " + id,
        snippet: "", time: "", date: "", unread: false, starred: false, inInbox: true, labelIds: ["INBOX"] })
    }

    function init() {
      // Settle every deferred ask from the last case before counting.
      fakeService.hasMore = false
      fakeService.listLoading = false
      var rows = []
      for (var i = 1; i <= 12; i++) rows.push(row(i + ":INBOX"))
      fakeService.messages = rows
      flick.contentY = 0
      wait(30)
      fakeService.hasMore = true
      fakeService.loads = 0
      wait(30)
    }

    function test_the_foot_asks_for_the_next_page_once() {
      verify(flick.contentHeight > flick.height, "the list is longer than the view")
      compare(fakeService.loads, 0)
      flick.contentY = flick.contentHeight - flick.height
      tryCompare(fakeService, "loads", 1, 1000, "reaching the foot asks for the page")
      // Staying at the foot, or wobbling on it, does not ask again while
      // the page is on its way.
      flick.contentY = flick.contentY - 1
      flick.contentY = flick.contentHeight - flick.height
      wait(20)
      compare(fakeService.loads, 1)
      // The page lands: the list grows, the foot moves away, and reaching
      // it again asks for the next.
      fakeService.listLoading = false
      var more = fakeService.messages.slice()
      for (var i = 13; i <= 24; i++) more.push(row(i + ":INBOX"))
      fakeService.messages = more
      wait(20)
      verify(flick.contentY < flick.contentHeight - flick.height, "the foot moved away")
      flick.contentY = flick.contentHeight - flick.height
      tryCompare(fakeService, "loads", 2, 1000)
    }

    // A page that lands and still leaves the foot in view is followed by
    // the next once the list settles, until there is no more.
    function test_a_short_page_is_followed_until_the_foot_is_out_of_view() {
      // A first page shorter than the view: the foot is in view at rest,
      // and the next page is asked for a moment after the list settles.
      fakeService.hasMore = false
      fakeService.messages = []
      fakeService.listLoading = true
      fakeService.hasMore = true
      fakeService.messages = [row("1:INBOX"), row("2:INBOX")]
      wait(30)
      verify(flick.contentHeight <= flick.height, "shorter than the view")
      fakeService.listLoading = false
      tryCompare(fakeService, "loads", 1, 1000, "the page that settled short is followed")
      compare(fakeService.listLoading, true, "and that ask is on its way")
      // The next page lands, still short, with more: followed again.
      fakeService.messages = [row("1:INBOX"), row("2:INBOX"), row("3:INBOX")]
      wait(30)
      fakeService.listLoading = false
      tryCompare(fakeService, "loads", 2, 1000, "and the next, until the foot leaves the view")
      // The page after lands with no more: the foot is still in view, and
      // nothing is asked for.
      fakeService.hasMore = false
      fakeService.listLoading = false
      wait(30)
      compare(fakeService.loads, 2, "no more, no ask")
    }

    function test_no_more_means_no_ask() {
      fakeService.hasMore = false
      flick.contentY = flick.contentHeight - flick.height
      wait(20)
      compare(fakeService.loads, 0)
      compare(list.loadMoreIfAtFoot(), false)
    }

    function test_a_failed_page_waits_for_manual_retry() {
      flick.contentY = flick.contentHeight - flick.height
      tryCompare(fakeService, "loads", 1, 1000)

      // A failure ends the load without adding messages. Remaining at the
      // foot must not turn that failure into an unbounded retry loop.
      fakeService.listLoading = false
      wait(60)
      compare(fakeService.loads, 1)

      var button = findByName(list, "load-more")
      verify(button !== null)
      button.clicked()
      compare(fakeService.loads, 2, "the explicit retry remains available")
    }

    function test_the_button_is_still_there_for_a_page_that_did_not_come() {
      var button = findByName(list, "load-more")
      verify(button !== null)
      compare(button.visible, true)
      button.clicked()
      compare(fakeService.loads, 1)
    }

    function findByName(item, name) {
      if (item.objectName === name) return item
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) {
        var found = findByName(kids[i], name)
        if (found) return found
      }
      return null
    }
  }
}
