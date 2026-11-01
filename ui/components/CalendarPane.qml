import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../calendar"
import "../calendar/Calendar.js" as Calendar

// The month and the picked day's events, in a pane at the right of the mail,
// as Outlook keeps its calendar beside the inbox. A day is picked with a click;
// a double click, or a click on an event, opens that day in the calendar view.
// Under the month come the picked day's events and those of the two weeks after.
// It reads through its own controller, over the weeks the month shows.
Rectangle {
  id: root

  required property var service
  readonly property var controller: paneLoader.item
  property color textColor: Commons.Color.foreground
  property color backgroundColor: Commons.Color.background
  property color accentColor: Commons.Color.accent
  // As the window's own dim: the text colour two thirds of the way over.
  property color dimColor: Qt.rgba(
    textColor.r * 0.68 + backgroundColor.r * 0.32,
    textColor.g * 0.68 + backgroundColor.g * 0.32,
    textColor.b * 0.68 + backgroundColor.b * 0.32, 1)
  property color urgentColor: Commons.Color.urgent
  property color borderColor: Style.normalBorderColor
  property string fontFamily: Style.font.family

  signal openDay(var date)

  color: backgroundColor

  // Set rather than bound: a binding on `new Date()` is worked out once and
  // would keep yesterday as today in a window left open overnight.
  property string todayIso: Calendar.isoDate(new Date())
  property string selectedIso: todayIso
  function checkToday() {
    var now = Calendar.isoDate(new Date())
    if (now === todayIso) return
    // The picked day moves on with today when it was today.
    if (selectedIso === todayIso) selectedIso = now
    var month = new Date(visibleMonth)
    var wasThisMonth = Calendar.isoDate(new Date(month.getFullYear(), month.getMonth(), 1)).slice(0, 7)
      === todayIso.slice(0, 7)
    todayIso = now
    if (wasThisMonth) visibleMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  }
  property date visibleMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  readonly property var days: Calendar.monthGridDays(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1)
  readonly property var events: controller ? controller.events : []
  // The picked day, then the days after it that have something on, as
  // Outlook lists what is coming under its month.
  readonly property int agendaSpan: 14
  readonly property var agendaDays: {
    var list = []
    var parts = String(selectedIso).split("-").map(Number)
    for (var i = 0; i < agendaSpan; i++) {
      var date = new Date(parts[0], parts[1] - 1, parts[2] + i)
      var day = dayOf(Calendar.isoDate(date))
      var dayEvents = Calendar.eventsOnDay(events, day)
      if (i === 0 || dayEvents.length > 0)
        list.push({ day: day, events: dayEvents, first: i === 0 })
    }
    return list
  }
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
    // Far enough for the days listed after the picked one, which may run
    // past the last week the month shows.
    var agendaEnd = dayOf(selectedIso).startMs + agendaSpan * 86400000 + 86400000
    controller.refresh(days[0].startMs, Math.max(days[days.length - 1].endMs, agendaEnd))
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

  function dayTitle(day) {
    var date = day.date
    var title = dayNames[date.getDay()] + " " + date.getDate() + " " + monthNames[date.getMonth()]
    if (day.isoDate === todayIso) return "Today · " + title
    var tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    if (day.isoDate === Calendar.isoDate(tomorrow)) return "Tomorrow · " + title
    return title
  }

  function eventTime(event) {
    if (Calendar.displayInAllDayLane(event)) return "All day"
    return Calendar.timeRangeLabel(event.start.ms, event.end ? event.end.ms : event.start.ms,
      Qt.locale().timeFormat(Locale.ShortFormat), "–")
  }

  onVisibleMonthChanged: Qt.callLater(refresh)
  onSelectedIsoChanged: Qt.callLater(refresh)
  onVisibleChanged: if (visible) { wanted = true; checkToday(); Qt.callLater(refresh) }
  onControllerChanged: Qt.callLater(refresh)
  Connections {
    target: root.controller || null
    ignoreUnknownSignals: true
    function onSourcesLoadedChanged() { Qt.callLater(root.refresh) }
  }
  // Keep "today" true across midnight and pick up events added elsewhere.
  Timer {
    interval: 5 * 60 * 1000
    repeat: true
    running: root.visible
    onTriggered: { root.checkToday(); root.refresh() }
  }

  CalendarPalette {
    id: calendarColors
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
      spacing: Style.space(12)

      Repeater {
        model: root.agendaDays
        Column {
          id: dayBlock
          required property var modelData
          required property int index
          width: agendaColumn.width
          spacing: Style.space(6)

          Text {
            objectName: dayBlock.index === 0 ? "calendar-pane-day" : ""
            width: parent.width
            text: root.dayTitle(dayBlock.modelData.day)
            elide: Text.ElideRight
            color: dayBlock.modelData.first ? root.textColor : root.dimColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: true
          }

          Text {
            visible: dayBlock.modelData.events.length === 0
            width: parent.width
            text: root.controller && root.controller.loading ? "Loading..." : "Nothing planned"
            color: root.dimColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Repeater {
            model: dayBlock.modelData.events
            Rectangle {
              id: eventRow
              required property var modelData
              readonly property color eventColor: calendarColors.colorFor(
                root.controller ? root.controller.colorKeyFor(modelData.sourceId) : "")
              width: dayBlock.width
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
                onClicked: root.openDay(dayBlock.modelData.day.date)
              }
            }
          }
        }
      }
    }
  }

  // Its own controller, so the pane's month and the calendar view's range
  // never refetch over each other; the calendars shown are the view's. Made
  // the first time the pane shows, so a window that never opens it reads
  // nothing for it.
  property bool wanted: false
  readonly property var shared: service ? service.calendarController || null : null
  Loader {
    id: paneLoader
    active: root.wanted || root.visible
    sourceComponent: CalendarController {
      service: root.service
      pluginDir: root.service ? String(root.service.pluginDir || "") : ""
      cacheName: "calendar-pane"
      accountId: root.service ? String(root.service.calendarAccountId || "") : ""
      Component.onCompleted: {
        if (!root.shared) return
        sourceList = root.shared.sourceList
        sourcesLoaded = root.shared.sourcesLoaded
      }
    }
  }
  Connections {
    target: paneLoader.item ? root.shared : null
    function onSourceListChanged() { paneLoader.item.sourceList = root.shared.sourceList }
    function onSourcesLoadedChanged() { paneLoader.item.sourcesLoaded = root.shared.sourcesLoaded }
  }
}
