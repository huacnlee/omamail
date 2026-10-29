import QtQuick
import QtTest
import "../../components" as Views

Item {
  width: 900
  height: 600
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

  TestCase {
    name: "CalendarDescriptionDetail"
    when: windowShown

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
