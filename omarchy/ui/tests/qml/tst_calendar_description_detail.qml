import QtQuick
import QtTest
import "../../components" as Views

Item {
  id: host
  width: 900
  height: 600
  property string shortcut: ""
  SystemPalette { id: palette }

  QtObject {
    id: controller
    property var service: null
    property var availableSources: ({sources:[{id:"google:test",kind:"google",name:"Team calendar",readOnly:false}]})
  }

  Views.CalendarEventDetail {
    id: detail
    width: 900
    height: 600
    controller: controller
    event: null
    textColor: palette.text
    backgroundColor: palette.base
    accentColor: palette.highlight
    urgentColor: palette.highlight
    dimColor: palette.mid
    panelFontFamily: "sans-serif"
  }
  SignalSpy { id: edits; target: detail; signalName: "editRequested" }
  SignalSpy { id: deletes; target: detail; signalName: "deleteRequested" }
  TextEdit { id: clipboard; visible: false; textFormat: TextEdit.PlainText }
  Views.KeyRouter {
    context: "calendar"
    onTriggered: function(id) { host.shortcut = id }
  }

  TestCase {
    name: "CalendarDescriptionDetail"
    when: windowShown

    function init() {
      detail.width = 900
      detail.event = null
      host.shortcut = ""
      edits.clear()
      deletes.clear()
      findChild(detail, "event-detail-scroll").contentY = 0
    }

    function textItem(item, value) {
      if (item.text === value) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = textItem(children[i], value)
        if (found) return found
      }
      return null
    }

    function test_mouse_selection_copies_preview_text_data() {
      var rows = []
      var fields = ["title", "description", "location", "calendar", "guest-name", "guest-address", "date"]
      for (var i = 0; i < 2; i++) {
        var width = i === 0 ? 900 : 360
        for (var j = 0; j < fields.length; j++) rows.push({tag:width + "-" + fields[j],width:width,field:j})
      }
      return rows
    }

    function test_mouse_selection_copies_preview_text(data) {
      detail.width = data.width
      var event = {sourceId:"google:test",googleId:"one",summary:"Planning café <b>notes</b>",
        description:"Agenda\n\nBring café notes\n<b>Literal text</b>",location:"Meeting room 2",
        start:{ms:new Date(2026,9,30,10,0).getTime()},end:{ms:new Date(2026,9,30,11,0).getTime()},
        attendees:[{email:"guest@example.test",displayName:"Guest <b>name</b>",responseStatus:"accepted"}]}
      detail.event = event
      var original = JSON.stringify(detail.event)
      wait(0)
      var values = [event.summary, event.description, event.location, "Team calendar",
        "Guest <b>name</b>", "Accepted · guest@example.test", detail.dateSummary()]
      var text = textItem(detail, values[data.field])
      verify(text !== null)
      var scroll = findChild(detail, "event-detail-scroll")
      scroll.contentY = Math.max(0, Math.min(text.mapToItem(scroll.contentItem, 0, 0).y,
        scroll.contentHeight - scroll.height))
      waitForRendering(text)
      mouseDrag(text, 1, 1, text.width - 3, text.height - 3, Qt.LeftButton)
      compare(text.selectedText, values[data.field], "dragging selects the displayed plain text")
      keyClick(Qt.Key_C, Qt.ControlModifier)
      clipboard.text = ""
      clipboard.paste()
      compare(clipboard.text, values[data.field], "Ctrl+C copies the mouse selection")
      keyClick(Qt.Key_X, Qt.ControlModifier)
      keyClick(Qt.Key_V, Qt.ControlModifier)
      keyClick(Qt.Key_Delete)
      compare(text.text, values[data.field], "the preview stays read-only")
      compare(JSON.stringify(detail.event), original)
      compare(edits.count, 0)
      compare(deletes.count, 0)
    }

    function test_preview_selection_keeps_calendar_shortcuts() {
      detail.event = {sourceId:"read-only",summary:"Shared event",description:"Read-only notes"}
      wait(0)
      var text = textItem(detail, "Shared event")
      mouseDrag(text, 1, 1, text.width - 3, text.height - 3, Qt.LeftButton)
      compare(text.selectedText, "Shared event")
      verify(!findChild(detail, "event-edit-button").visible)
      keyClick(Qt.Key_C, Qt.ControlModifier)
      compare(host.shortcut, "")
      keyClick(Qt.Key_J)
      compare(host.shortcut, "calendarNext")
      host.shortcut = ""
      keyClick(Qt.Key_Down)
      compare(host.shortcut, "calendarNext")
      host.shortcut = ""
      keyClick(Qt.Key_Escape)
      compare(host.shortcut, "back")
      compare(edits.count, 0)
      compare(deletes.count, 0)
    }

    function test_edit_stays_in_header_with_long_description_data() {
      return [{tag:"wide",width:900},{tag:"narrow",width:360}]
    }

    function test_edit_stays_in_header_with_long_description(data) {
      detail.width = data.width
      var description = "Agenda\n\n- First item\n- Second item\n<b>Keep literal</b>\n\n"
        + Array(90).join("More event details\n")
      detail.event = {sourceId:"google:test",googleId:"one",summary:"Planning session",
        description:description,start:{ms:Date.now()},end:{ms:Date.now()+3600000}}
      edits.clear()
      wait(0)
      var text = findChild(detail, "event-description-text")
      compare(text.text, description)
      compare(text.textFormat, Text.PlainText)
      var edit = findChild(detail, "event-edit-button")
      var scroll = findChild(detail, "event-detail-scroll")
      verify(edit.visible)
      var position = edit.mapToItem(detail, 0, 0)
      verify(position.x >= 0 && position.x + edit.width <= detail.width)
      verify(position.y >= 0 && position.y + edit.height <= scroll.y)
      scroll.contentY = scroll.contentHeight - scroll.height
      wait(0)
      compare(edit.mapToItem(detail, 0, 0), position)
      mouseClick(edit, edit.width / 2, edit.height / 2)
      compare(edits.count, 1)
      compare(edits.signalArguments[0][0], "google:test")
      compare(edits.signalArguments[0][1].description, description)
      detail.event = {sourceId:"read-only",summary:"Shared event",description:description}
      verify(!edit.visible)
    }
  }
}
