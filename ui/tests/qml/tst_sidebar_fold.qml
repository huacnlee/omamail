import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import qs.Commons as Commons
import "../../components" as Mail

// The chevron folds; it does not also open. Two tap handlers sit one inside
// the other — the fold's inside the row's — and Qt hands the same tap to
// both, so without the row asking where the tap landed, folding a parent
// navigated to it. Driven with real pointer events on the real sidebar.
Item {
  width: 460
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
    textColor: Commons.Color.foreground
    accentColor: Commons.Color.accent
    dimColor: Commons.Color.foreground
    panelFontFamily: "monospace"
    slots: [{ kind: "mailbox", key: "inbox" }]
  }

  // A mailbox whose listing counts its Flagged view. The window hands the rail the
  // number: nothing on the service, no account behind it to reach for.
  property var counted: ({
    labels: labels, collapsedFolders: [], rawQuery: "", mailboxKey: "inbox", searchQuery: "",
    providerId: "exchange",
    mailboxes: [{ key: "inbox", label: "Inbox", icon: "inbox" }, { key: "starred", label: "Flagged", icon: "star" }]
  })

  Mail.MailboxSidebar {
    id: tallied
    x: 230
    width: 220
    height: 600
    service: counted
    starredCount: 7
    textColor: Commons.Color.foreground
    accentColor: Commons.Color.accent
    dimColor: Qt.alpha(Commons.Color.foreground, 0.6)
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

    function init() {
      folded.clear(); opened.clear(); mailbox.clear()
      sidebar.numbersVisible = false
      sidebar.collapsed = false
      tallied.collapsed = false
    }

    // The row a sidebar draws for a name, and a part of it.
    function rowOf(item, label) {
      if (item.label === label && item.count !== undefined) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = rowOf(children[i], label)
        if (found) return found
      }
      return null
    }

    function part(row, name) {
      var children = row.children || []
      for (var i = 0; i < children.length; i++) if (children[i].objectName === name) return children[i]
      return null
    }

    // Flagged's number is a size, not mail waiting: the sidebar draws the number it
    // is given as secondary text, and drops it from a collapsed rail where a label's
    // unread count becomes a dot. The tooltip still says it.
    function test_the_flagged_total_is_secondary_text_and_no_dot() {
      var flagged = rowOf(tallied, "Flagged")
      var label = rowOf(tallied, "2026")
      verify(flagged && label)
      var number = part(flagged, "mailbox-entry-badge")
      verify(number.visible, "the given count is drawn with no account behind it")
      compare(number.text, "7")
      compare(String(number.color), String(tallied.dimColor), "secondary text")
      verify(String(number.color) !== String(tallied.accentColor), "not the accent")
      compare(number.font.bold, false)
      var unread = part(label, "mailbox-entry-badge")
      compare(String(unread.color), String(tallied.accentColor), "a label's unread count keeps the accent")
      compare(unread.font.bold, true)

      tallied.collapsed = true
      verify(part(label, "mailbox-entry-dot").visible, "unread mail is a dot on a collapsed rail")
      verify(!part(flagged, "mailbox-entry-dot").visible, "a size is not")
      compare(part(flagged, "label-tooltip").text, "Flagged · 7 in all")
    }

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

    function test_shortcut_number_is_an_informational_chip() {
      sidebar.collapsed = true
      sidebar.numbersVisible = true
      var chip = named(sidebar, "mailbox-shortcut-chip", [])[0]
      verify(chip, "the numbered mailbox draws its shortcut hint")
      verify(chip.x >= chip.parent.width / 2, "hint stays in the right corner")
      verify(chip.y < chip.parent.height / 4, "hint stays at the top")
      verify(chip.height < chip.parent.height / 2, "hint is smaller than the row icon")
      verify(named(sidebar, "mailbox-entry-icon", [])[0].visible, "modifier preserves mailbox icon")
      verify(chip.color.a < Style.selectedFillFor(Commons.Color.foreground, Commons.Color.accent).a,
        "a shortcut hint must not use the much heavier selected-state fill")
    }
  }
}
