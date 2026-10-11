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
  signal createRange(double startMs, double endMs)
  signal createAllDay(double startMs, double endMs)
  signal eventRescheduled(var event, double startMs, double endMs)
  signal eventActivated(var event)
  property var dragPreview: null
  property var pendingGesture: null
  onControllerChanged: pendingGesture = null
  Connections {
    target: root.controller
    ignoreUnknownSignals: true
    function onEventUpdated(ok, error) {
      if (!ok) root.pendingGesture = null
    }
    function onLoadingChanged() {
      if (!root.controller.loading && !root.controller.eventWriting) root.pendingGesture = null
    }
  }

  readonly property real timeRailWidth: Math.max(Style.space(52), allDayLabelMetrics.advanceWidth + Style.space(12))
  TextMetrics {
    id: allDayLabelMetrics
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    text: "all-day"
  }
  readonly property var weekdayNames: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  readonly property var hourRange: Calendar.weekHourRange(
    controller ? controller.events : [], days, 7, 19)
  readonly property int firstHour: 0
  readonly property int lastHour: 24
  function resetTimeScroll() {
    timeline.contentY = Math.max(0, Math.min(hourRange.first * timeline.hourHeight,
      timeline.contentHeight - timeline.height))
  }
  Component.onCompleted: Qt.callLater(root.resetTimeScroll)
  onDaysChanged: Qt.callLater(root.resetTimeScroll)
  readonly property int hourCount: Math.max(1, lastHour - firstHour)
  readonly property var allDayLayout: Calendar.spanLayout(
    (controller ? controller.events : []).filter(Calendar.displayInAllDayLane), days)
  readonly property int allDayCount: allDayLayout.laneCounts[0] || 0
  readonly property real allDayHeight: Style.space(8 + Math.max(1, allDayCount) * 24)
  property int allDayDragStart: -1
  property int allDayDragEnd: -1
  readonly property string todayIso: Calendar.isoDate(new Date(nowMs))

  CalendarPalette {
    id: calendarPalette
    palettePath: root.controller && root.controller.service
      ? String(root.controller.service.calendarPalettePath || "") : ""
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
        id: dayHeader
        required property var modelData
        required property int index
        width: (dayHeaders.width - root.timeRailWidth) / Math.max(1, root.days.length)
        height: parent.height
        Rectangle {
          anchors.centerIn: parent
          width: headerLabel.implicitWidth + Style.space(14)
          height: headerLabel.implicitHeight + Style.space(6)
          radius: Style.cornerRadius
          color: Qt.alpha(root.accentColor, 0.12)
          visible: dayHeader.modelData.isoDate === root.todayIso
        }
        Text {
          id: headerLabel
          anchors.centerIn: parent
          text: root.weekdayNames[(new Date(modelData.startMs).getDay() + 6) % 7] + " " + modelData.day
          color: modelData.isoDate === root.todayIso
            ? root.textColor : root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          font.bold: modelData.isoDate === root.todayIso
          textFormat: Text.PlainText
        }
      }
    }
  }

  Rectangle {
    id: allDayLane
    objectName: "calendar-all-day-lane"
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: dayHeaders.bottom
    height: root.allDayHeight
    color: "transparent"
    border.width: root.calendarBorderWidth
    border.color: Qt.alpha(root.calendarBorderColor, 0.2)
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
      id: allDayColumns
      anchors.left: parent.left
      anchors.leftMargin: root.timeRailWidth
      anchors.right: parent.right
      height: parent.height
      Repeater {
        model: root.days
        delegate: Item {
          id: allDayColumn
          required property var modelData
          required property int index
          width: (allDayLane.width - root.timeRailWidth) / Math.max(1, root.days.length)
          height: parent.height

          Rectangle {
            anchors.fill: parent
            color: allDayMouse.containsMouse || (root.allDayDragStart >= 0
              && allDayColumn.index >= Math.min(root.allDayDragStart, root.allDayDragEnd)
              && allDayColumn.index <= Math.max(root.allDayDragStart, root.allDayDragEnd))
              ? Qt.alpha(root.accentColor, 0.12)
              : allDayColumn.modelData.isoDate === root.todayIso
              ? root.calendarTodayBackgroundColor : "transparent"
            border.width: root.calendarBorderWidth
            border.color: Qt.alpha(root.calendarBorderColor, 0.2)
          }

          MouseArea {
            id: allDayMouse
            objectName: "calendar-all-day-slots-" + allDayColumn.modelData.isoDate
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.CrossCursor
            preventStealing: true
            function selectTo(x, y) {
              var point = mapToItem(allDayColumns, x, y)
              root.allDayDragEnd = Math.max(0, Math.min(root.days.length - 1, Math.floor(point.x / allDayColumn.width)))
            }
            onPressed: {
              root.allDayDragStart = allDayColumn.index
              root.allDayDragEnd = allDayColumn.index
            }
            onPositionChanged: function(mouse) { if (pressed) selectTo(mouse.x, mouse.y) }
            onReleased: function(mouse) {
              selectTo(mouse.x, mouse.y)
              root.createAllDay(root.days[Math.min(root.allDayDragStart, root.allDayDragEnd)].startMs,
                root.days[Math.max(root.allDayDragStart, root.allDayDragEnd)].endMs)
              root.allDayDragStart = -1
              root.allDayDragEnd = -1
            }
            onCanceled: { root.allDayDragStart = -1; root.allDayDragEnd = -1 }
          }

        }
      }
    }
    Item {
      anchors.left: parent.left
      anchors.leftMargin: root.timeRailWidth
      anchors.right: parent.right
      height: parent.height
      Repeater {
        model: root.allDayLayout.segments
        delegate: Rectangle {
          id: allDayEvent
          required property var modelData
          readonly property var eventData: modelData.event
          objectName: "calendar-all-day-event-" + String(eventData.googleId || eventData.uid)
          readonly property color eventColor: calendarPalette.colorFor(
            root.controller ? root.controller.colorKeyFor(eventData.sourceId) : "")
          x: modelData.startColumn * parent.width / Math.max(1, root.days.length) + Style.space(2)
          y: Style.space(2) + modelData.lane * Style.space(24)
          width: (modelData.endColumn - modelData.startColumn + 1) * parent.width / Math.max(1, root.days.length) - Style.space(4)
          height: Style.space(22)
          color: Qt.alpha(eventColor, Calendar.eventKey(eventData) === root.selectedEventId ? 0.3 : 0.16)
          border.width: Calendar.eventKey(eventData) === root.selectedEventId ? 1 : 0
          border.color: eventColor
          clip: true

          Text {
            anchors.fill: parent
            anchors.leftMargin: Style.space(4)
            anchors.rightMargin: Style.space(3)
            verticalAlignment: Text.AlignVCenter
            text: (allDayEvent.modelData.continuesBefore ? "‹ " : "")
              + (allDayEvent.eventData.start.allDay ? "" : "Timed · ")
              + String(allDayEvent.eventData.summary || "Untitled event")
              + (allDayEvent.modelData.continuesAfter ? " ›" : "")
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            textFormat: Text.PlainText
          }
          MouseArea {
            id: allDayEventMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.eventActivated(allDayEvent.eventData)
          }
          ToolTip {
            visible: allDayEventMouse.containsMouse
            delay: 500
            contentItem: Text {
              text: String(allDayEvent.eventData.summary || "Untitled event")
                + (allDayEvent.eventData.start.allDay ? "" : "\n"
                  + Qt.formatDateTime(new Date(allDayEvent.eventData.start.ms), "ddd d MMM, HH:mm")
                  + " – " + Qt.formatDateTime(new Date(allDayEvent.eventData.end.ms), "ddd d MMM, HH:mm"))
              textFormat: Text.PlainText
              color: root.textColor
              font.family: root.panelFontFamily
            }
            background: Rectangle {
              color: root.backgroundColor
              border.color: Qt.alpha(root.textColor, 0.25)
              radius: Style.cornerRadius
            }
          }
        }
      }
    }
  }

  Flickable {
    id: timeline
    objectName: "calendar-time-scroll"

    WheelScroller { view: timeline }
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: allDayLane.bottom
    anchors.bottom: parent.bottom
    readonly property real hourHeight: Math.max(Style.space(60), height / root.hourCount)
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
            color: Qt.alpha(root.calendarBorderColor, 0.18)
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
              (root.controller ? root.controller.events : []).map(function(event) {
                if (!root.pendingGesture || Calendar.eventKey(event) !== root.pendingGesture.key) return event
                var moved = {}
                for (var key in event) moved[key] = event[key]
                moved.start = { ms: root.pendingGesture.start }
                moved.end = { ms: root.pendingGesture.end }
                return moved
              }), modelData)
            readonly property var positionedEvents: Calendar.timedLayout(dayEvents, modelData)
            width: (timeline.width - root.timeRailWidth) / Math.max(1, root.days.length)
            height: parent.height

            Rectangle {
              anchors.fill: parent
              color: dayColumn.modelData.isoDate === root.todayIso
                ? root.calendarTodayBackgroundColor : "transparent"
              border.width: root.calendarBorderWidth
              border.color: Qt.alpha(root.calendarBorderColor, 0.18)
            }
            MouseArea {
              objectName: "calendar-time-slots-" + dayColumn.modelData.isoDate
              anchors.fill: parent
              cursorShape: Qt.CrossCursor
              preventStealing: true
              property real initialY: 0
              property var selection: null
              function selectTo(y) {
                var first = Calendar.slotStart(dayColumn.modelData, Math.min(initialY, y), root.firstHour, timeline.hourHeight, 15)
                var last = Calendar.slotStart(dayColumn.modelData, Math.max(initialY, y) + timeline.hourHeight / 8,
                  root.firstHour, timeline.hourHeight, 15)
                last = Math.min(dayColumn.modelData.endMs, Math.max(first + 900000, last))
                selection = { start: first, end: last }
                var point = dayColumn.mapToItem(timeline.contentItem, 0, 0)
                root.dragPreview = { x: point.x,
                  y: Calendar.eventTop({start:{ms:first}}, dayColumn.modelData, root.firstHour, timeline.hourHeight),
                  width: dayColumn.width,
                  height: (last - first) / 3600000 * timeline.hourHeight,
                  label: Qt.formatTime(new Date(first), "HH:mm") + "–" + Qt.formatTime(new Date(last), "HH:mm") }
              }
              onPressed: function(mouse) { initialY = mouse.y; selectTo(mouse.y) }
              onPositionChanged: function(mouse) { if (pressed) selectTo(mouse.y) }
              onReleased: function(mouse) {
                selectTo(mouse.y)
                root.dragPreview = null
                if (Math.abs(mouse.y - initialY) < 6) root.createAt(selection.start)
                else root.createRange(selection.start, selection.end)
                selection = null
              }
              onCanceled: { selection = null; root.dragPreview = null }
            }

            Repeater {
              model: dayColumn.positionedEvents
              delegate: Rectangle {
                id: eventBlock
                required property var modelData
                readonly property color eventColor: calendarPalette.colorFor(
                  root.controller ? root.controller.colorKeyFor(eventData.sourceId) : "")
                readonly property var eventData: modelData.event
                readonly property bool canReschedule: !!root.controller
                  && typeof root.controller.rescheduleRefusal === "function"
                  && root.controller.rescheduleRefusal(eventData) === ""
                x: Style.space(3) + modelData.column * (dayColumn.width - Style.space(6)) / modelData.columns
                width: (dayColumn.width - Style.space(6)) / modelData.columns - Style.space(2)
                y: Calendar.eventTop(eventData, dayColumn.modelData,
                  root.firstHour, timeline.hourHeight)
                height: Calendar.eventHeight(eventData, dayColumn.modelData, timeline.hourHeight)
                radius: Style.cornerRadius
                z: 1
                color: Qt.tint(root.backgroundColor, Qt.alpha(eventColor,
                  Calendar.eventKey(eventData) === root.selectedEventId ? 0.3 : 0.17))
                border.width: Calendar.eventKey(eventData) === root.selectedEventId ? 1 : 0
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
                    text: eventBlock.eventData.summary || "Untitled event"
                    color: root.textColor
                    font.family: root.panelFontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    wrapMode: Text.WordWrap
                    maximumLineCount: eventBlock.height > Style.space(70) ? 2 : 1
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                  }
                  Text {
                    width: parent.width
                    visible: eventBlock.height >= Style.space(38)
                    text: Qt.formatTime(new Date(eventBlock.eventData.start.ms), "HH:mm")
                      + (width >= timeMetrics.advanceWidth ? "–" + Qt.formatTime(new Date(eventBlock.eventData.end.ms), "HH:mm") : "")
                    elide: Text.ElideRight
                    color: root.dimColor
                    font.family: root.panelFontFamily
                    font.pixelSize: Style.font.caption
                    textFormat: Text.PlainText
                    TextMetrics {
                      id: timeMetrics
                      font.family: root.panelFontFamily
                      font.pixelSize: Style.font.caption
                      text: "00:00–00:00"
                    }
                  }
                }
                MouseArea {
                  id: eventMouse
                  objectName: "calendar-event-drag-" + String(eventBlock.eventData.googleId || eventBlock.eventData.uid)
                  anchors.fill: parent
                  hoverEnabled: true
                  enabled: !root.pendingGesture && !(root.controller && root.controller.eventWriting)
                  cursorShape: !eventBlock.canReschedule ? Qt.PointingHandCursor
                    : mouseY < Style.space(9) || mouseY > height - Style.space(9)
                    ? Qt.SizeVerCursor : Qt.OpenHandCursor
                  preventStealing: true
                  property point initial: Qt.point(0, 0)
                  property string edge: ""
                  property bool moved: false
                  property var proposed: null
                  onPressed: function(mouse) {
                    initial = mapToItem(timeline, mouse.x, mouse.y)
                    edge = mouse.y < Style.space(9) ? "start" : mouse.y > height - Style.space(9) ? "end" : ""
                    moved = false
                    proposed = null
                  }
                  onPositionChanged: function(mouse) {
                    if (!pressed || !eventBlock.canReschedule) return
                    var point = mapToItem(timeline, mouse.x, mouse.y)
                    if (!moved && Math.abs(point.x - initial.x) + Math.abs(point.y - initial.y) < 6) return
                    moved = true
                    var column = Math.max(0, Math.min(root.days.length - 1,
                      Math.floor((point.x - root.timeRailWidth) / dayColumn.width)))
                    var initialColumn = Math.floor((initial.x - root.timeRailWidth) / dayColumn.width)
                    proposed = Calendar.gestureRange(eventBlock.eventData, column - initialColumn,
                      (point.y - initial.y) / timeline.hourHeight * 60, edge)
                    if (!proposed) { root.dragPreview = null; return }
                    var previewDay = root.days[edge === "" ? column : initialColumn]
                    var previewEvent = { start: {ms: proposed.start}, end: {ms: proposed.end} }
                    root.dragPreview = { x: root.timeRailWidth + (edge === "" ? column : initialColumn) * dayColumn.width,
                      y: Calendar.eventTop(previewEvent, previewDay, root.firstHour, timeline.hourHeight),
                      width: dayColumn.width, height: Calendar.eventHeight(previewEvent, previewDay, timeline.hourHeight),
                      label: Qt.formatTime(new Date(proposed.start), "HH:mm") + "–" + Qt.formatTime(new Date(proposed.end), "HH:mm") }
                  }
                  onReleased: {
                    root.dragPreview = null
                    if (moved && proposed) {
                      var event = eventBlock.eventData
                      var next = { key: Calendar.eventKey(event), start: proposed.start, end: proposed.end }
                      root.eventRescheduled(event, proposed.start, proposed.end)
                      if (root.controller && root.controller.eventWriting) root.pendingGesture = next
                    }
                    else if (!moved) root.eventActivated(eventBlock.eventData)
                  }
                  onCanceled: { root.dragPreview = null; proposed = null }
                }
                Rectangle {
                  anchors.horizontalCenter: parent.horizontalCenter
                  anchors.top: parent.top
                  anchors.topMargin: Style.space(3)
                  width: Math.min(Style.space(24), parent.width * 0.4)
                  height: Style.space(3)
                  radius: height / 2
                  color: eventBlock.eventColor
                  visible: eventBlock.canReschedule && (eventMouse.containsMouse || eventMouse.pressed)
                }
                Rectangle {
                  anchors.horizontalCenter: parent.horizontalCenter
                  anchors.bottom: parent.bottom
                  anchors.bottomMargin: Style.space(3)
                  width: Math.min(Style.space(24), parent.width * 0.4)
                  height: Style.space(3)
                  radius: height / 2
                  color: eventBlock.eventColor
                  visible: eventBlock.canReschedule && (eventMouse.containsMouse || eventMouse.pressed)
                }
                ToolTip {
                  visible: eventMouse.containsMouse && !eventMouse.pressed
                  delay: 500
                  contentItem: Text {
                    text: String(eventBlock.eventData.summary || "Untitled event") + "\n"
                      + Qt.formatTime(new Date(eventBlock.eventData.start.ms), "HH:mm") + "–"
                      + Qt.formatTime(new Date(eventBlock.eventData.end.ms), "HH:mm")
                    textFormat: Text.PlainText
                    color: root.textColor
                    font.family: root.panelFontFamily
                  }
                  background: Rectangle {
                    color: root.backgroundColor
                    border.color: Qt.alpha(root.textColor, 0.25)
                    radius: Style.cornerRadius
                  }
                }
                Text {
                  anchors.right: parent.right
                  anchors.bottom: parent.bottom
                  anchors.margins: Style.space(4)
                  visible: !!root.pendingGesture && root.pendingGesture.key === Calendar.eventKey(eventBlock.eventData)
                  text: "Saving"
                  textFormat: Text.PlainText
                  color: root.textColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }

            // Keep the line behind event text; the gutter time and dot remain
            // visible without striking through a meeting's title.
            Item {
              readonly property real offset: Calendar.nowOffset(
                dayColumn.modelData, root.firstHour, root.lastHour,
                timeline.hourHeight, root.nowMs)
              visible: offset >= 0
              y: offset
              width: parent.width
              height: 0
              z: 0
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
    Rectangle {
      visible: root.dragPreview !== null
      x: root.dragPreview ? root.dragPreview.x : 0
      y: root.dragPreview ? root.dragPreview.y : 0
      width: root.dragPreview ? root.dragPreview.width : 0
      height: root.dragPreview ? root.dragPreview.height : 0
      color: Qt.alpha(root.accentColor, 0.2)
      border.color: root.accentColor
      border.width: 2
      radius: Style.cornerRadius
      Text {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.margins: Style.space(5)
        text: root.dragPreview ? root.dragPreview.label || "" : ""
        textFormat: Text.PlainText
        color: root.textColor
        font.family: root.panelFontFamily
        font.bold: true
      }
    }
  }
}
