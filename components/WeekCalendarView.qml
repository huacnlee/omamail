import QtQuick
import QtQuick.Controls
import qs.Commons
import "../calendar/Calendar.js" as Calendar

Item {
  id: root

  required property var controller
  required property var days
  required property double nowMs
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property color calendarBorderColor
  required property color calendarTodayBackgroundColor
  required property int calendarBorderWidth
  required property string panelFontFamily
  required property string selectedEventId

  signal createAt(double startMs)
  signal eventActivated(var event)

  readonly property real timeRailWidth: Style.space(52)
  readonly property var weekdayNames: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  readonly property var hourRange: Calendar.weekHourRange(
    controller ? controller.events : [], days, 7, 19)
  readonly property int firstHour: hourRange.first
  readonly property int lastHour: hourRange.last
  readonly property int hourCount: Math.max(1, lastHour - firstHour)
  readonly property int allDayCount: Calendar.maxAllDayEvents(
    controller ? controller.events : [], days)
  readonly property real allDayHeight: allDayCount > 0
    ? Style.space(6 + allDayCount * 20) : 0

  CalendarPalette {
    id: calendarPalette
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  Row {
    id: dayHeaders
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    height: Style.space(28)

    Item { width: root.timeRailWidth; height: parent.height }

    Repeater {
      model: root.days
      delegate: Item {
        required property var modelData
        required property int index
        width: (dayHeaders.width - root.timeRailWidth) / 7
        height: parent.height
        Text {
          anchors.centerIn: parent
          text: root.weekdayNames[index] + " " + modelData.day
          color: modelData.isoDate === Calendar.isoDate(new Date())
            ? root.textColor : root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          font.bold: modelData.isoDate === Calendar.isoDate(new Date())
          textFormat: Text.PlainText
        }
      }
    }
  }

  Rectangle {
    id: allDayLane
    visible: root.allDayCount > 0
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: dayHeaders.bottom
    height: root.allDayHeight
    color: "transparent"
    border.width: root.calendarBorderWidth
    border.color: root.calendarBorderColor
    clip: true

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(4)
      anchors.verticalCenter: parent.verticalCenter
      width: root.timeRailWidth - Style.space(8)
      text: "all-day"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      textFormat: Text.PlainText
    }

    Row {
      anchors.left: parent.left
      anchors.leftMargin: root.timeRailWidth
      anchors.right: parent.right
      height: parent.height
      Repeater {
        model: root.days
        delegate: Item {
          id: allDayColumn
          required property var modelData
          readonly property var events: Calendar.allDayEventsOnDay(
            root.controller ? root.controller.events : [], modelData)
          width: (allDayLane.width - root.timeRailWidth) / 7
          height: parent.height

          Rectangle {
            anchors.fill: parent
            color: allDayColumn.modelData.isoDate === Calendar.isoDate(new Date())
              ? root.calendarTodayBackgroundColor : "transparent"
            border.width: root.calendarBorderWidth
            border.color: root.calendarBorderColor
          }

          Column {
            anchors.fill: parent
            anchors.margins: Style.space(2)
            spacing: Style.space(2)
            Repeater {
              model: allDayColumn.events
              delegate: Rectangle {
                id: allDayEvent
                required property var modelData
                readonly property color eventColor: calendarPalette.colorFor(
                  root.controller ? root.controller.colorKeyFor(modelData.sourceId) : "")
                width: parent.width
                height: Style.space(18)
                color: Qt.rgba(eventColor.r, eventColor.g, eventColor.b,
                  String(modelData.uid || "") === root.selectedEventId ? 0.3 : 0.16)
                border.width: String(modelData.uid || "") === root.selectedEventId ? 2 : 1
                border.color: eventColor
                clip: true

                Text {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(4)
                  anchors.rightMargin: Style.space(3)
                  verticalAlignment: Text.AlignVCenter
                  text: allDayEvent.modelData.summary || "Untitled event"
                  color: root.textColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                }
                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.eventActivated(allDayEvent.modelData)
                }
              }
            }
          }
        }
      }
    }
  }

  Flickable {
    id: timeline
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: root.allDayCount > 0 ? allDayLane.bottom : dayHeaders.bottom
    anchors.bottom: parent.bottom
    readonly property real hourHeight: Math.max(Style.space(28), height / root.hourCount)
    contentWidth: width
    contentHeight: Math.max(height, hourHeight * root.hourCount)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Item {
      width: timeline.width
      height: timeline.contentHeight

      Repeater {
        model: root.hourCount
        delegate: Item {
          required property int index
          y: index * timeline.hourHeight
          width: parent.width
          height: timeline.hourHeight
          Text {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(4)
            anchors.top: parent.top
            anchors.topMargin: index === 0 ? Style.space(2) : -implicitHeight / 2
            text: Calendar.two(root.firstHour + index) + ":00"
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            textFormat: Text.PlainText
          }
          Rectangle {
            anchors.left: parent.left
            anchors.leftMargin: root.timeRailWidth
            anchors.right: parent.right
            anchors.top: parent.top
            height: root.calendarBorderWidth
            color: root.calendarBorderColor
          }
        }
      }

      // Read off the rail rather than off the line: the hour labels stop at the
      // hour, so a line between two of them otherwise says only "somewhere in
      // here". Hidden when today is not the week on screen.
      Rectangle {
        readonly property real offset: Calendar.weekNowOffset(
          root.days, root.firstHour, root.lastHour, timeline.hourHeight, root.nowMs)
        visible: offset >= 0
        x: Style.space(4)
        y: offset - height / 2
        width: nowLabel.implicitWidth + Style.space(6)
        height: nowLabel.implicitHeight + Style.space(2)
        radius: Style.cornerRadius
        color: root.urgentColor
        z: 2
        Text {
          id: nowLabel
          anchors.centerIn: parent
          text: Calendar.timeLabel(root.nowMs)
          color: root.backgroundColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
          textFormat: Text.PlainText
        }
      }

      Row {
        anchors.left: parent.left
        anchors.leftMargin: root.timeRailWidth
        anchors.right: parent.right
        height: parent.height
        Repeater {
          model: root.days
          delegate: Item {
            id: dayColumn
            required property var modelData
            readonly property var dayEvents: Calendar.eventsOnDay(
              root.controller ? root.controller.events : [], modelData).filter(function(event) {
                return event && event.start && !event.start.allDay
              })
            width: (timeline.width - root.timeRailWidth) / 7
            height: parent.height

            Rectangle {
              anchors.fill: parent
              color: dayColumn.modelData.isoDate === Calendar.isoDate(new Date())
                ? root.calendarTodayBackgroundColor : "transparent"
              border.width: root.calendarBorderWidth
              border.color: root.calendarBorderColor
            }
            MouseArea {
              anchors.fill: parent
              cursorShape: Qt.CrossCursor
              onClicked: root.createAt(Calendar.slotStart(dayColumn.modelData,
                mouseY, root.firstHour, timeline.hourHeight, 30))
            }

            Repeater {
              model: dayColumn.dayEvents
              delegate: Rectangle {
                id: eventBlock
                required property var modelData
                readonly property color eventColor: calendarPalette.colorFor(
                  root.controller ? root.controller.colorKeyFor(modelData.sourceId) : "")
                x: Style.space(3)
                width: dayColumn.width - Style.space(6)
                y: Calendar.eventTop(modelData, dayColumn.modelData,
                  root.firstHour, timeline.hourHeight)
                height: Calendar.eventHeight(modelData, dayColumn.modelData, timeline.hourHeight)
                radius: Style.cornerRadius
                color: Qt.rgba(eventColor.r, eventColor.g, eventColor.b,
                  String(modelData.uid || "") === root.selectedEventId ? 0.3 : 0.17)
                border.width: String(modelData.uid || "") === root.selectedEventId ? 2 : 1
                border.color: eventColor
                clip: true

                Rectangle {
                  anchors.left: parent.left
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  width: Style.space(3)
                  color: eventBlock.eventColor
                }
                Column {
                  anchors.fill: parent
                  anchors.margins: Style.space(5)
                  spacing: Style.space(1)
                  Text {
                    width: parent.width
                    text: eventBlock.modelData.summary || "Untitled event"
                    color: root.textColor
                    font.family: root.panelFontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                  }
                  Text {
                    width: parent.width
                    text: Calendar.two(new Date(eventBlock.modelData.start.ms).getHours()) + ":"
                      + Calendar.two(new Date(eventBlock.modelData.start.ms).getMinutes())
                    color: root.dimColor
                    font.family: root.panelFontFamily
                    font.pixelSize: Style.font.caption
                    textFormat: Text.PlainText
                  }
                }
                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.eventActivated(eventBlock.modelData)
                }
              }
            }

            // After the events, so a meeting in progress is crossed by the line
            // rather than covering it. The dot is what survives a theme whose
            // urgent colour sits close to an event's border: a bare rule reads
            // as one more hour separator, a rule with a bead on it does not.
            Item {
              readonly property real offset: Calendar.nowOffset(
                dayColumn.modelData, root.firstHour, root.lastHour,
                timeline.hourHeight, root.nowMs)
              visible: offset >= 0
              y: offset
              width: parent.width
              height: 0
              z: 1
              Rectangle {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                height: Math.max(root.calendarBorderWidth, 2)
                color: root.urgentColor
              }
              Rectangle {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(7)
                height: width
                radius: width / 2
                color: root.urgentColor
              }
            }
          }
        }
      }
    }
  }
}
