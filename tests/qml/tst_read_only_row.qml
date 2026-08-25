import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  id: host
  width: 500
  height: 100

  property int archiveRequests: 0

  Omamail.MessageRow {
    id: row
    anchors.fill: parent
    summary: ({
      id: "message-1",
      subject: "Read-only affordances",
      from: ({ display: "Sender" }),
      time: "now",
      snippet: "",
      unread: false,
      starred: true
    })
    textColor: Qt.rgba(1, 1, 1, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    dimColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    panelFontFamily: "monospace"
    hasCursor: true
    canArchive: true
    canStar: true
    onArchiveRequested: host.archiveRequests++
  }

  TestCase {
    name: "ReadOnlyMessageRow"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function init() {
      host.archiveRequests = 0
      row.readOnly = false
      wait(20)
    }

    function test_read_only_hides_the_entire_message_action_strip() {
      var actions = named(row, "message-row-actions")
      verify(actions)
      compare(actions.visible, true)
      row.readOnly = true
      wait(20)
      compare(actions.visible, false)
    }

    function test_read_only_middle_click_does_not_archive() {
      row.readOnly = true
      mouseClick(row, 20, 20, Qt.MiddleButton)
      compare(host.archiveRequests, 0)

      row.readOnly = false
      mouseClick(row, 20, 20, Qt.MiddleButton)
      compare(host.archiveRequests, 1)
    }
  }
}
