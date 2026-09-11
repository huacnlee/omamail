import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Mail

// The chevron folds; it does not also open. Two tap handlers sit one inside
// the other — the fold's inside the row's — and Qt hands the same tap to
// both, so without the row asking where the tap landed, folding a parent
// navigated to it. Driven with real pointer events on the real sidebar.
Item {
  width: 400
  height: 600

  property var labels: [
    { id: "Work", name: "Work", rawName: "Work", delimiter: "/", unread: 0 },
    { id: "Work/2026", name: "Work/2026", rawName: "Work/2026", delimiter: "/", unread: 3 }
  ]
  property var fake: ({
    labels: labels, mailboxes: [{ key: "inbox", label: "Inbox", icon: "inbox" }],
    collapsedFolders: [], rawQuery: "", mailboxKey: "inbox", searchQuery: "", providerId: "imap"
  })

  Mail.MailboxSidebar {
    id: sidebar
    width: 220
    height: 600
    service: fake
    textColor: Color.foreground
    accentColor: Color.accent
    dimColor: Color.foreground
    panelFontFamily: "monospace"
  }

  SignalSpy { id: folded; target: sidebar; signalName: "folderToggled" }
  SignalSpy { id: opened; target: sidebar; signalName: "labelSelected" }
  SignalSpy { id: mailbox; target: sidebar; signalName: "mailboxSelected" }

  TestCase {
    name: "SidebarFold"
    when: windowShown

    function named(item, name, out) {
      if (item.objectName === name && item.visible) out.push(item)
      var children = item.children || []
      for (var i = 0; i < children.length; i++) named(children[i], name, out)
      return out
    }

    function textItem(item, value) {
      if (item.text === value && item.textFormat !== undefined) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = textItem(children[i], value)
        if (found) return found
      }
      return null
    }

    function init() { folded.clear(); opened.clear(); mailbox.clear() }

    function test_the_chevron_folds_without_opening() {
      var folds = named(sidebar, "fold", [])
      compare(folds.length, 1, "only the parent carries a chevron")
      var fold = folds[0]
      mouseClick(fold, fold.width / 2, fold.height / 2)
      compare(folded.count, 1, "the fold was asked for")
      compare(folded.signalArguments[0][0], "Work")
      compare(opened.count, 0, "and nothing opened")
      compare(mailbox.count, 0)
    }

    function test_the_name_opens_without_folding() {
      var name = textItem(sidebar, "Work")
      verify(name !== null)
      mouseClick(name, 2, name.height / 2)
      compare(opened.count, 1, "the label opened")
      compare(opened.signalArguments[0][0], "Work")
      compare(folded.count, 0, "and nothing folded")
    }

    function test_a_child_row_opens_by_its_id() {
      var name = textItem(sidebar, "2026")
      verify(name !== null, "the child is drawn by its leaf name")
      mouseClick(name, 2, name.height / 2)
      compare(opened.count, 1)
      compare(opened.signalArguments[0][0], "Work/2026", "opened by the server's id, not the leaf")
      compare(folded.count, 0)
    }
  }
}
