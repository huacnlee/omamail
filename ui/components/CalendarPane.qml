import QtQuick
import qs.Commons
import qs.Ui
import "../calendar/Calendar.js" as Calendar

// The month and the picked day's events, in a pane at the right of the mail,
// as Outlook keeps its calendar beside the inbox. A day is picked with a click;
// a double click, or a click on an event, opens that day in the calendar view.
// It reads through its own controller, over the weeks the month shows.
Rectangle {
  id: root

  required property var controller
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color dimColor
  required property color urgentColor
  required property color borderColor
  required property string fontFamily

  signal openDay(var date)

  color: backgroundColor

  readonly property string todayIso: Calendar.isoDate(new Date())
  property string selectedIso: todayIso
  property date visibleMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  readonly property var days: Calendar.monthGridDays(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1)
  readonly property var events: controller ? controller.events : []
  readonly property var selectedDay: dayOf(selectedIso)
  readonly property var selectedEvents: Calendar.eventsOnDay(events, selectedDay)
  readonly property var weekdayNames: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
  readonly property var monthNames: ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"]
  readonly property var dayNames: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  readonly property real cell: Math.floor((width - Style.space(24)) / 7)

  function dayOf(iso) {
    var parts = String(iso).split("-").map(Number)
    var start = new Date(parts[0], parts[1] - 1, parts[2])
    return { isoDate: iso, startMs: start.getTime(),
      endMs: new Date(parts[0], parts[1] - 1, parts[2] + 1).getTime(), date: start }
  }

  function refresh() {
    if (!visible || !controller || !controller.sourcesLoaded || days.length === 0) return
    controller.refresh(days[0].startMs, days[days.length - 1].endMs)
  }

  function moveMonth(offset) {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1)
  }

  function goToday() {
    var now = new Date()
    visibleMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    selectedIso = todayIso
  }

  function hasEvents(day) {
    return Calendar.eventsOnDay(events, day).length > 0
  }

  function dayTitle() {
    var date = selectedDay.date
    var title = dayNames[date.getDay()] + " " + date.getDate() + " " + monthNames[date.getMonth()]
    return selectedIso === todayIso ? "Today · " + title : title
  }

  function eventTime(event) {
    if (Calendar.displayInAllDayLane(event)) return "All day"
    return Calendar.timeRangeLabel(event.start.ms, event.end ? event.end.ms : event.start.ms,
      Qt.locale().timeFormat(Locale.ShortFormat), "–")
  }

  onVisibleMonthChanged: Qt.callLater(refresh)
  onVisibleChanged: if (visible) Qt.callLater(refresh)
  onControllerChanged: Qt.callLater(refresh)
  Connections {
    target: root.controller
    ignoreUnknownSignals: true
    function onSourcesLoadedChanged() { Qt.callLater(root.refresh) }
  }
  // Keep "today" true across midnight and pick up events added elsewhere.
  Timer {
    interval: 5 * 60 * 1000
    repeat: true
    running: root.visible
    onTriggered: root.refresh()
  }

  CalendarPalette {
    id: palette
    palettePath: root.controller && root.controller.service
      ? String(root.controller.service.calendarPalettePath || "") : ""
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  Rectangle {
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: 1
    color: root.borderColor
  }

  Column {
    id: month
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.margins: Style.space(12)
    spacing: Style.space(6)

    Item {
      width: parent.width
      height: Style.space(26)

      Text {
        objectName: "calendar-pane-month"
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        text: root.monthNames[root.visibleMonth.getMonth()] + " " + root.visibleMonth.getFullYear()
        color: root.textColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
      }

      Row {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        IconButton {
          iconName: "calendar"
          tooltipText: "Today"
          foreground: root.dimColor
          hoverColor: root.textColor
          size: Style.space(24)
          fontFamily: root.fontFamily
          onClicked: root.goToday()
        }
        IconButton {
          iconName: "chevronLeft"
          tooltipText: "Previous month"
          foreground: root.dimColor
          hoverColor: root.textColor
          size: Style.space(24)
          fontFamily: root.fontFamily
          onClicked: root.moveMonth(-1)
        }
        IconButton {
          iconName: "chevronRight"
          tooltipText: "Next month"
          foreground: root.dimColor
          hoverColor: root.textColor
          size: Style.space(24)
          fontFamily: root.fontFamily
          onClicked: root.moveMonth(1)
        }
      }
    }

    Grid {
      id: grid
      columns: 7
      anchors.horizontalCenter: parent.horizontalCenter

      Repeater {
        model: root.weekdayNames
        Text {
          required property string modelData
          width: root.cell
          height: Style.space(20)
          text: modelData
          horizontalAlignment: Text.AlignHCenter
          verticalAlignment: Text.AlignVCenter
          color: root.dimColor
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      Repeater {
        model: root.days
        Item {
          id: dayCell
          required property var modelData
          readonly property bool isToday: modelData.isoDate === root.todayIso
          readonly property bool isSelected: modelData.isoDate === root.selectedIso
          width: root.cell
          height: root.cell

          Rectangle {
            anchors.centerIn: parent
            width: Math.min(parent.width, parent.height) - Style.space(4)
            height: width
            radius: width / 2
            color: dayCell.isToday ? root.accentColor
              : (dayCell.isSelected ? Qt.alpha(root.textColor, 0.14)
                : (dayMouse.containsMouse ? Qt.alpha(root.textColor, 0.07) : "transparent"))
            border.width: dayCell.isSelected && dayCell.isToday ? 2 : 0
            border.color: root.textColor
          }

          Text {
            anchors.centerIn: parent
            anchors.verticalCenterOffset: -Style.space(1)
            text: dayCell.modelData.day
            color: dayCell.isToday ? root.backgroundColor
              : (dayCell.modelData.inMonth ? root.textColor : Qt.alpha(root.dimColor, 0.6))
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: dayCell.isToday || dayCell.isSelected
          }

          // A dot under the number for a day that has something on it.
          Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            anchors.bottomMargin: Style.space(4)
            width: Style.space(4)
            height: width
            radius: width / 2
            visible: root.hasEvents(dayCell.modelData)
            color: dayCell.isToday ? root.backgroundColor : root.accentColor
          }

          MouseArea {
            id: dayMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: {
              root.selectedIso = dayCell.modelData.isoDate
              if (!dayCell.modelData.inMonth)
                root.visibleMonth = new Date(dayCell.modelData.year, dayCell.modelData.month, 1)
            }
            onDoubleClicked: root.openDay(new Date(dayCell.modelData.startMs))
          }
        }
      }
    }

    Rectangle {
      width: parent.width
      height: 1
      color: root.borderColor
    }

    Text {
      objectName: "calendar-pane-day"
      width: parent.width
      text: root.dayTitle()
      elide: Text.ElideRight
      color: root.textColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
    }
  }

  Flickable {
    id: agenda
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: month.bottom
    anchors.bottom: parent.bottom
    anchors.leftMargin: Style.space(12)
    anchors.rightMargin: Style.space(12)
    anchors.topMargin: Style.space(8)
    clip: true
    contentHeight: agendaColumn.height
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: agendaColumn
      width: agenda.width
      spacing: Style.space(6)

      Text {
        visible: root.selectedEvents.length === 0
        width: parent.width
        text: root.controller && root.controller.loading ? "Loading…" : "Nothing planned"
        color: root.dimColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Repeater {
        model: root.selectedEvents
        Rectangle {
          id: eventRow
          required property var modelData
          readonly property color eventColor: palette.colorFor(
            root.controller ? root.controller.colorKeyFor(modelData.sourceId) : "")
          width: agendaColumn.width
          height: eventText.height + Style.space(10)
          radius: Math.min(4, Style.cornerRadius)
          color: eventMouse.containsMouse ? Qt.alpha(eventColor, 0.22) : Qt.alpha(eventColor, 0.12)

          Rectangle {
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: Style.space(3)
            color: eventRow.eventColor
          }

          Column {
            id: eventText
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(10)
            anchors.rightMargin: Style.space(6)

            Text {
              width: parent.width
              text: root.eventTime(eventRow.modelData)
              color: root.dimColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Text {
              width: parent.width
              text: String(eventRow.modelData.summary || "")
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: root.textColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
            Text {
              width: parent.width
              visible: text !== ""
              text: String(eventRow.modelData.location || "")
              textFormat: Text.PlainText
              elide: Text.ElideRight
              color: root.dimColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          MouseArea {
            id: eventMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.openDay(root.selectedDay.date)
          }
        }
      }
    }
  }
}
