import QtQuick
import QtQuick.Controls
import qs.Commons
import "../calendar/Calendar.js" as Calendar

Item {
  id: root

  required property var controller
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property color calendarBorderColor
  required property color calendarTodayBackgroundColor
  required property int calendarBorderWidth
  required property string panelFontFamily

  property date visibleMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  property date visibleWeek: new Date()
  property string viewMode: "month"
  property string selectedEventId: ""
  property var detailEvent: null
  readonly property bool detailOpen: detailEvent !== null
  readonly property var days: Calendar.monthDays(
    visibleMonth.getFullYear(), visibleMonth.getMonth(), 1)
  readonly property var weekDays: Calendar.weekDays(visibleWeek.getTime(), 1)
  readonly property var monthNames: ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"]
  readonly property var weekdayNames: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  readonly property string todayIso: Calendar.isoDate(new Date())
  signal createAt(double startMs)
  signal copyRequested(string text)
  signal openRequested(string url)
  signal editRequested(string sourceId, var event)
  signal deleteRequested(string sourceId, var event)

  Binding {
    target: root.controller
    property: "clockRunning"
    value: root.visible && root.viewMode === "week"
    when: root.controller !== null
  }

  CalendarPalette {
    id: calendarPalette
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  onControllerChanged: if (controller && controller.sourcesLoaded)
    Qt.callLater(root.refresh)

  Connections {
    target: root.controller
    ignoreUnknownSignals: true
    function onSourcesLoadedChanged() {
      if (root.controller && root.controller.sourcesLoaded) root.refresh()
    }
  }

  function visibleEvents() {
    var range = viewMode === "week" ? weekDays : days
    var values = controller && Array.isArray(controller.events) ? controller.events : []
    if (range.length === 0) return []
    var start = range[0].startMs, end = range[range.length - 1].endMs
    return values.filter(function(event) {
      if (!event || !event.start) return false
      var eventEnd = event.end ? Number(event.end.ms) : Number(event.start.ms) + 1
      return Number(event.start.ms) < end && eventEnd > start
    })
  }

  function moveSelection(offset) {
    var values = visibleEvents()
    if (values.length === 0) { selectedEventId = ""; return }
    var index = -1
    for (var i = 0; i < values.length; i++) {
      if (String(values[i].uid || "") === selectedEventId) { index = i; break }
    }
    if (index < 0) index = Number(offset) < 0 ? values.length : -1
    index = Math.max(0, Math.min(values.length - 1, index + Number(offset)))
    selectedEventId = String(values[index].uid || "")
  }

  function activateEvent(event) {
    if (!event) return
    selectedEventId = String(event.uid || "")
    detailEvent = event
  }

  function closeDetail() { detailEvent = null }

  function activateSelection() {
    var values = visibleEvents()
    for (var i = 0; i < values.length; i++) {
      if (String(values[i].uid || "") === selectedEventId) {
        activateEvent(values[i])
        return
      }
    }
    moveSelection(1)
  }

  function refresh() {
    var range = viewMode === "week" ? weekDays : days
    if (!controller || range.length === 0) return
    controller.refresh(range[0].startMs, range[range.length - 1].endMs)
  }

  function moveMonth(offset) {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1)
    refresh()
  }

  function goToday() {
    var now = new Date()
    visibleMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    visibleWeek = now
    refresh()
  }

  function movePeriod(offset) {
    if (viewMode === "week") {
      visibleWeek = new Date(visibleWeek.getFullYear(), visibleWeek.getMonth(),
        visibleWeek.getDate() + offset * 7)
      refresh()
    } else moveMonth(offset)
  }

  function setView(mode) {
    viewMode = mode === "week" ? "week" : "month"
    refresh()
  }

  function showEvent(eventId, startMs) {
    selectedEventId = String(eventId || "")
    viewMode = "month"
    if (Number(startMs) > 0) {
      var date = new Date(Number(startMs))
      visibleMonth = new Date(date.getFullYear(), date.getMonth(), 1)
      visibleWeek = date
    }
    refresh()
  }

  Component.onCompleted: refresh()

  Column {
    anchors.fill: parent
    anchors.margins: Style.space(14)
    spacing: Style.space(10)

    Item {
      width: parent.width
      height: Style.space(34)

      Row {
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(10)

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.viewMode === "week" ? Calendar.weekTitle(root.weekDays)
            : root.monthNames[root.visibleMonth.getMonth()] + " " + root.visibleMonth.getFullYear()
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.heading
          font.bold: true
          textFormat: Text.PlainText
        }

        IconTextButton {
          anchors.verticalCenter: parent.verticalCenter
          text: "Go to today"
          tooltipText: "Show the current date"
          foreground: root.accentColor
          accent: root.accentColor
          bordered: false
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          onClicked: root.goToday()
        }
      }

      Row {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)

        Item {
          id: calendarLoading
          width: visible ? Style.space(24) : 0
          height: Style.space(24)
          visible: !!root.controller && root.controller.loading

          ActionIcon {
            anchors.centerIn: parent
            name: "refresh"
            iconSize: Style.font.iconSmall
            color: root.accentColor

            RotationAnimator on rotation {
              from: 0
              to: 360
              duration: 900
              loops: Animation.Infinite
              running: calendarLoading.visible
            }
          }
        }

        IconTextButton {
          text: "Week"
          foreground: root.viewMode === "week" ? root.textColor : root.dimColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          selected: root.viewMode === "week"
          onClicked: root.setView("week")
        }

        IconTextButton {
          text: "Month"
          foreground: root.viewMode === "month" ? root.textColor : root.dimColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          selected: root.viewMode === "month"
          onClicked: root.setView("month")
        }

        IconButton {
          iconName: "chevronLeft"
          tooltipText: root.viewMode === "week" ? "Previous week" : "Previous month"
          foreground: root.dimColor
          hoverColor: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.movePeriod(-1)
        }

        IconButton {
          iconName: "chevronRight"
          tooltipText: root.viewMode === "week" ? "Next week" : "Next month"
          foreground: root.dimColor
          hoverColor: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.movePeriod(1)
        }

      }
    }

    Rectangle {
      id: calendarError
      width: parent.width
      height: visible ? Style.space(34) : 0
      visible: root.controller && root.controller.lastError !== ""
      radius: Style.cornerRadius
      color: Qt.rgba(root.urgentColor.r, root.urgentColor.g, root.urgentColor.b, 0.12)
      border.width: 1
      border.color: root.urgentColor

      readonly property bool apiDisabled: root.controller
        && root.controller.lastErrorKind === "googleApiDisabled"

      Text {
        anchors.left: parent.left
        anchors.right: errorActions.visible ? errorActions.left : parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.leftMargin: Style.space(10)
        anchors.rightMargin: Style.space(10)
        verticalAlignment: Text.AlignVCenter
        text: root.controller ? root.controller.lastError : ""
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
        textFormat: Text.PlainText
      }

      Row {
        id: errorActions
        anchors.right: parent.right
        anchors.rightMargin: Style.space(4)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)
        visible: calendarError.apiDisabled

        IconTextButton {
          objectName: "calendarErrorCopy"
          text: "Copy"
          tooltipText: "Copy this error"
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          onClicked: root.copyRequested(root.controller.lastError)
        }

        IconTextButton {
          objectName: "calendarApiEnable"
          text: "Enable API..."
          tooltipText: "Open Google Cloud Calendar API setup..."
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          onClicked: root.openRequested(Calendar.googleCalendarApiUrl())
        }
      }
    }

    Row {
      id: calendarBody
      width: parent.width
      height: parent.height - y
      spacing: 0

      Item {
        width: calendarBody.width
        height: calendarBody.height

        Column {
          anchors.fill: parent

    Grid {
      id: weekdayGrid
      visible: root.viewMode === "month"
      width: parent.width
      columns: 7
      rowSpacing: 0
      columnSpacing: 0

      Repeater {
        model: root.weekdayNames
        delegate: Item {
          required property string modelData
          width: weekdayGrid.width / 7
          height: Style.space(24)

          Text {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(7)
            anchors.verticalCenter: parent.verticalCenter
            text: modelData
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            textFormat: Text.PlainText
          }
        }
      }
    }

    Grid {
      id: monthGrid
      visible: root.viewMode === "month"
      width: parent.width
      height: parent.height - y
      columns: 7
      rowSpacing: 0
      columnSpacing: 0

      Repeater {
        model: root.days

        delegate: Rectangle {
          id: dayCell
          required property var modelData
          readonly property var dayEvents: Calendar.eventsOnDay(
            root.controller ? root.controller.events : [], modelData)
          width: monthGrid.width / 7
          height: monthGrid.height / 6
          color: modelData.isoDate === root.todayIso
            ? root.calendarTodayBackgroundColor
            : "transparent"
          border.width: root.calendarBorderWidth
          border.color: root.calendarBorderColor
          radius: 0

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: root.createAt(dayCell.modelData.startMs + 9 * 3600000)
          }

          Text {
            id: dayNumber
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.margins: Style.space(6)
            text: dayCell.modelData.day
            color: dayCell.modelData.inMonth ? root.textColor : root.dimColor
            opacity: dayCell.modelData.inMonth ? 1 : 0.55
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            font.bold: dayCell.modelData.isoDate === root.todayIso
            textFormat: Text.PlainText
          }

          Column {
            anchors.top: dayNumber.bottom
            anchors.topMargin: Style.space(4)
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: Style.space(4)
            anchors.rightMargin: Style.space(4)
            spacing: Style.space(2)

            Repeater {
              model: Math.min(dayCell.dayEvents.length, 3)
              delegate: Rectangle {
                id: monthEvent
                required property int index
                readonly property var eventData: dayCell.dayEvents[index]
                readonly property color eventColor: calendarPalette.colorFor(
                  root.controller ? root.controller.colorKeyFor(eventData.sourceId) : "")
                width: parent.width
                height: Style.space(18)
                radius: 0
                color: Qt.rgba(eventColor.r, eventColor.g, eventColor.b,
                  eventData && String(eventData.uid || "") === root.selectedEventId ? 0.28 : 0.15)
                border.width: eventData && String(eventData.uid || "") === root.selectedEventId ? 2 : 1
                border.color: eventColor

                Rectangle {
                  anchors.left: parent.left
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  width: Style.space(3)
                  color: monthEvent.eventColor
                }

                Text {
                  anchors.fill: parent
                  anchors.leftMargin: Style.space(4)
                  anchors.rightMargin: Style.space(4)
                  verticalAlignment: Text.AlignVCenter
                  text: {
                    var event = monthEvent.eventData
                    if (!event) return ""
                    var time = event.start && !event.start.allDay
                      ? Calendar.two(new Date(event.start.ms).getHours()) + ":"
                        + Calendar.two(new Date(event.start.ms).getMinutes()) + " " : ""
                    return time + (event.summary || "Untitled event")
                  }
                  color: root.textColor
                  font.family: root.panelFontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.activateEvent(monthEvent.eventData)
                }
              }
            }

            Text {
              visible: dayCell.dayEvents.length > 3
              width: parent.width
              text: "+" + (dayCell.dayEvents.length - 3) + " more"
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }
          }
        }
      }
    }

    WeekCalendarView {
      width: parent.width
      height: parent.height - y
      visible: root.viewMode === "week"
      controller: root.controller
      nowMs: root.controller ? root.controller.nowMs : 0
      days: root.weekDays
      textColor: root.textColor
      backgroundColor: root.backgroundColor
      accentColor: root.accentColor
      urgentColor: root.urgentColor
      dimColor: root.dimColor
      calendarBorderColor: root.calendarBorderColor
      calendarTodayBackgroundColor: root.calendarTodayBackgroundColor
      calendarBorderWidth: root.calendarBorderWidth
      panelFontFamily: root.panelFontFamily
      selectedEventId: root.selectedEventId
      onCreateAt: function(startMs) { root.createAt(startMs) }
      onEventActivated: function(event) { root.activateEvent(event) }
    }
        }
      }
    }
  }

  CalendarEventDetail {
    anchors.fill: parent
    z: 20
    visible: root.detailOpen
    controller: root.controller
    event: root.detailEvent || ({})
    textColor: root.textColor
    backgroundColor: root.backgroundColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
    panelFontFamily: root.panelFontFamily
    onClosed: root.closeDetail()
    // Editing replaces the detail: the composer covers the view, and the
    // event it rewrites is not the one these labels would go on showing.
    onEditRequested: function(sourceId, event) {
      root.closeDetail()
      root.editRequested(sourceId, event)
    }
    onDeleteRequested: function(sourceId, event) { root.deleteRequested(sourceId, event) }
  }
}
