import QtQuick
import QtQuick.Window
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../calendar/Calendar.js" as Calendar

// A month to click a day in, opened from a date field of the event editor.
// It starts on the field's date, marks it and today, and hands back the day
// picked as YYYY-MM-DD. The keyboard works too: arrows move a day or a week,
// Page Up / Page Down a month, Return picks and Escape closes.
QQC.Popup {
  id: root

  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property string fontFamily

  property string selected: ""
  property string cursor: ""
  property Item anchorItem: null
  readonly property string today: Calendar.isoDate(new Date())
  readonly property var cursorDate: dateOf(cursor || today)
  readonly property var days: Calendar.monthGridDays(cursorDate.getFullYear(), cursorDate.getMonth(), 1)
  readonly property var weekdayNames: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

  signal picked(string isoDate)

  function dateOf(iso) {
    var parts = String(iso).split("-").map(Number)
    return new Date(parts[0], parts[1] - 1, parts[2])
  }

  function openFor(item, iso) {
    anchorItem = item
    selected = String(iso || "")
    cursor = selected || today
    open()
  }

  function moveDays(count) {
    var day = cursorDate
    cursor = Calendar.isoDate(new Date(day.getFullYear(), day.getMonth(), day.getDate() + count))
  }

  // A month on keeps the day where the month has it, or its last day.
  function moveMonths(count) {
    var day = cursorDate
    var last = new Date(day.getFullYear(), day.getMonth() + count + 1, 0).getDate()
    cursor = Calendar.isoDate(new Date(day.getFullYear(), day.getMonth() + count, Math.min(day.getDate(), last)))
  }

  function pick(iso) {
    picked(iso)
    close()
  }

  function place() {
    var window = anchorItem ? anchorItem.Window.window : null
    if (!window || !parent) return
    var point = anchorItem.mapToItem(window.contentItem, 0, 0)
    var top = point.y + anchorItem.height + Style.space(4)
    if (top + height > window.height) top = point.y - height - Style.space(4)
    var origin = parent.mapToItem(window.contentItem, 0, 0)
    y = Math.max(0, Math.min(top, window.height - height)) - origin.y
    x = Math.max(0, Math.min(point.x, window.width - width)) - origin.x
  }

  onOpened: { place(); grid.forceActiveFocus() }
  onHeightChanged: if (opened) place()

  width: Style.space(280)
  padding: Style.space(8)
  focus: true
  closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside

  background: Rectangle {
    color: root.backgroundColor
    border.width: Style.normalBorderWidth
    border.color: Style.normalBorderFor(root.textColor, root.accentColor)
    radius: Style.cornerRadius
  }

  contentItem: Column {
    spacing: Style.space(6)

    Item {
      width: parent.width
      height: Math.max(previous.height, monthTitle.implicitHeight)

      IconButton {
        id: previous
        objectName: "date-picker-previous"
        anchors.left: parent.left
        iconName: "chevronLeft"
        tooltipText: "Previous month"
        foreground: root.textColor
        accent: root.accentColor
        iconSize: Style.font.iconSmall
        onClicked: root.moveMonths(-1)
      }
      Text {
        id: monthTitle
        objectName: "date-picker-month"
        anchors.centerIn: parent
        text: Qt.formatDate(root.cursorDate, "MMMM yyyy")
        textFormat: Text.PlainText
        color: root.textColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
      }
      IconButton {
        objectName: "date-picker-next"
        anchors.right: parent.right
        iconName: "chevronRight"
        tooltipText: "Next month"
        foreground: root.textColor
        accent: root.accentColor
        iconSize: Style.font.iconSmall
        onClicked: root.moveMonths(1)
      }
    }

    Grid {
      id: grid
      objectName: "date-picker-grid"
      columns: 7
      width: parent.width
      readonly property real cell: width / 7
      focus: true

      Keys.onShortcutOverride: function(event) {
        // Return would otherwise save the event the picker is filling in.
        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) event.accepted = true
      }
      Keys.onPressed: function(event) {
        var moves = {}
        moves[Qt.Key_Left] = -1; moves[Qt.Key_Right] = 1; moves[Qt.Key_Up] = -7; moves[Qt.Key_Down] = 7
        if (moves[event.key] !== undefined) root.moveDays(moves[event.key])
        else if (event.key === Qt.Key_PageUp) root.moveMonths(-1)
        else if (event.key === Qt.Key_PageDown) root.moveMonths(1)
        else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) root.pick(root.cursor)
        else return
        event.accepted = true
      }

      Repeater {
        model: root.weekdayNames
        Text {
          required property string modelData
          width: grid.cell
          height: Style.space(20)
          text: modelData
          textFormat: Text.PlainText
          horizontalAlignment: Text.AlignHCenter
          verticalAlignment: Text.AlignVCenter
          color: Qt.alpha(root.textColor, 0.6)
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      Repeater {
        model: root.days
        Rectangle {
          id: dayCell
          required property var modelData
          readonly property bool chosen: modelData.isoDate === root.selected
          readonly property bool current: modelData.isoDate === root.cursor
          objectName: "date-picker-day-" + modelData.isoDate
          width: grid.cell
          height: Style.space(30)
          radius: Style.cornerRadius
          color: chosen ? root.accentColor
            : dayMouse.containsMouse || current ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent"
          border.width: modelData.isoDate === root.today && !chosen ? Style.normalBorderWidth : 0
          border.color: root.accentColor

          Text {
            anchors.centerIn: parent
            text: dayCell.modelData.day
            textFormat: Text.PlainText
            color: dayCell.chosen ? root.backgroundColor : root.textColor
            opacity: dayCell.modelData.inMonth || dayCell.chosen ? 1 : 0.45
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
          MouseArea {
            id: dayMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.pick(dayCell.modelData.isoDate)
          }
        }
      }
    }

    Button {
      objectName: "date-picker-today"
      text: "Today"
      foreground: root.textColor
      fontSize: Style.font.bodySmall
      onClicked: root.pick(root.today)
    }
  }
}
