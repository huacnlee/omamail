import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window
import qs.Commons
import "../calendar/Calendar.js" as Calendar
import "../keys/Keymap.js" as Keymap

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
  property Item toolbarHost: null
  readonly property real toolbarHeight: calendarToolbar.height
  property string selectedEventId: ""
  property bool monthPointerDown: false
  property Item hoveredMonthDay: null
  function updateMonthHover() {
    if (overflowHover.hovered) return
    if (!monthHover.hovered || monthPointerDown || viewMode !== "month" || detailOpen) {
      hoveredMonthDay = null
      monthHoverDelay.stop()
      monthHoverClose.restart()
      return
    }
    var point = monthHover.point.position
    var index = Math.floor(point.y / monthGrid.weekHeight) * 7 + Math.floor(point.x / (monthGrid.width / 7))
    var cell = monthDaysRepeater.itemAt(index)
    if (!cell || cell.overflowCount === 0) cell = null
    if (hoveredMonthDay === cell) return
    hoveredMonthDay = cell
    monthHoverDelay.stop()
    if (cell) { monthHoverClose.stop(); monthHoverDelay.restart() }
    else monthHoverClose.restart()
  }
  function beginMonthGesture() {
    monthPointerDown = true
    monthHoverDelay.stop()
    monthOverflow.close()
  }
  onViewModeChanged: { monthOverflow.close(); monthHoverDelay.stop(); hoveredMonthDay = null; syncAgenda() }
  onDaysChanged: syncAgenda()
  // The agenda's clock ticks every minute to drop finished events. Its model
  // changes only when the list does, so a tick leaves the scroll where it was.
  property var agendaEvents: []
  function syncAgenda() {
    var next = viewMode === "agenda" ? visibleEvents() : []
    if (!Calendar.sameEvents(agendaEvents, next)) agendaEvents = next
  }
  Connections {
    target: root.controller
    function onEventsChanged() { root.syncAgenda() }
    function onNowMsChanged() { root.syncAgenda() }
  }
  onVisibleMonthChanged: { monthOverflow.close(); monthHoverDelay.stop(); hoveredMonthDay = null }
  onDetailOpenChanged: if (detailOpen) { monthOverflow.close(); monthHoverDelay.stop() }
  Timer {
    id: monthHoverDelay
    interval: 400
    onTriggered: {
      if (!root.hoveredMonthDay || root.monthPointerDown || root.detailOpen || root.viewMode !== "month") return
      monthOverflow.dayCell = root.hoveredMonthDay
      monthOverflow.open()
      monthOverflow.place()
    }
  }
  Timer {
    id: monthHoverClose
    interval: 220
    onTriggered: if (!overflowHover.hovered) monthOverflow.close()
  }
  property var detailEvent: null
  property int detailReadSerial: 0
  property bool detailLoading: false
  property string detailError: ""
  property double requestedEventStart: 0
  property bool waitingForEvent: false
  readonly property bool detailOpen: detailEvent !== null
  readonly property real toolbarFontSize: Style.font.body
  readonly property real toolbarControlHeight: Style.spacing.controlHeight
  readonly property var monthSpans: Calendar.monthSpanLayout(controller ? controller.events : [], days)
  readonly property var days: Calendar.monthGridDays(
    visibleMonth.getFullYear(), visibleMonth.getMonth(), 1)
  readonly property var weekDays: Calendar.weekDays(visibleWeek.getTime(), 1)
  readonly property var displayDays: viewMode === "day" ? weekDays.filter(function(day) {
    return day.isoDate === Calendar.isoDate(visibleWeek)
  }) : weekDays
  readonly property var monthNames: ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"]
  readonly property var weekdayNames: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  readonly property string todayIso: Calendar.isoDate(new Date())
  readonly property var viewOptions: ["Day", "Week", "Month", "Agenda"].map(function(label) {
    var binding = Keymap.bindingsFor("calendar").filter(function(row) { return row.id === "calendar" + label })[0]
    return { mode: label.toLowerCase(), label: label + " (" + Keymap.displayFor(binding) + ")" }
  })
  signal createAt(double startMs)
  signal copyRequested(string text)
  signal openRequested(string url)
  signal editRequested(string sourceId, var event)
  signal deleteRequested(string sourceId, var event)

  Binding {
    target: root.controller
    property: "clockRunning"
    value: root.visible && root.viewMode !== "month"
    when: root.controller !== null
  }

  CalendarPalette {
    id: calendarPalette
    palettePath: root.controller && root.controller.service
      ? String(root.controller.service.calendarPalettePath || "") : ""
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  onControllerChanged: if (controller && controller.sourcesLoaded)
    Qt.callLater(root.refresh)
  onVisibleChanged: {
    if (!visible) { monthOverflow.close(); monthHoverDelay.stop(); hoveredMonthDay = null }
    else if (controller && controller.sourcesLoaded) Qt.callLater(root.refresh)
  }

  Timer {
    interval: 60000
    repeat: true
    running: root.visible && !!root.controller && root.controller.sourcesLoaded
    onTriggered: if (!root.controller.loading) root.refresh()
  }

  Connections {
    target: root.Window.window
    function onActiveChanged() {
      if (root.visible && root.Window.window.active && root.controller && root.controller.sourcesLoaded)
        root.refresh()
    }
  }

  Connections {
    target: root.controller
    ignoreUnknownSignals: true
    function onSourcesLoadedChanged() {
      if (root.controller && root.controller.sourcesLoaded) root.refresh()
    }
    function onEventsChanged() {
      if (root.waitingForEvent) root.resolveRequestedEvent()
      if (!root.detailEvent) return
      var key = Calendar.eventKey(root.detailEvent)
      var matches = root.controller.events.filter(function(event) { return Calendar.eventKey(event) === key })
      if (matches.length === 1) {
        if (String(matches[0].etag || "") !== String(root.detailEvent.etag || "")) root.activateEvent(matches[0])
      }
      else if (!root.controller.loading) {
        var source = root.controller.findSource(root.detailEvent.sourceId)
        if (!source || source.enabled !== false) root.closeDetail()
      }
    }
    function onLoadingChanged() {
      if (root.controller.loading || !root.detailEvent || root.controller.lastError !== "") return
      var source = root.controller.findSource(root.detailEvent.sourceId)
      if (source && source.enabled === false) return
      var key = Calendar.eventKey(root.detailEvent)
      if (!root.controller.events.some(function(event) { return Calendar.eventKey(event) === key })) root.closeDetail()
    }
  }

  function visibleEvents() {
    var range = viewMode === "day" || viewMode === "week" ? displayDays : days
    var values = controller && Array.isArray(controller.events) ? controller.events : []
    if (viewMode === "agenda") values = Calendar.agendaEvents(values, controller ? controller.nowMs : Date.now())
    if (range.length === 0) return []
    var start = range[0].startMs, end = range[range.length - 1].endMs
    return values.filter(function(event) {
      if (!event || !event.start) return false
      var eventEnd = event.end ? Number(event.end.ms) : Number(event.start.ms) + 1
      return Number(event.start.ms) < end && eventEnd > start
    }).sort(Calendar.compareEvents)
  }

  function moveSelection(offset) {
    var values = visibleEvents()
    if (values.length === 0) { selectedEventId = ""; return }
    var index = -1
    for (var i = 0; i < values.length; i++) {
      if (Calendar.eventKey(values[i]) === selectedEventId) { index = i; break }
    }
    if (index < 0) index = Number(offset) < 0 ? values.length : -1
    index = Math.max(0, Math.min(values.length - 1, index + Number(offset)))
    selectedEventId = Calendar.eventKey(values[index])
  }

  function activateEvent(event, alreadyDetailed) {
    monthOverflow.close()
    if (!event) return
    var serial = ++detailReadSerial
    selectedEventId = Calendar.eventKey(event)
    detailEvent = event
    detailLoading = false
    detailError = ""
    var source = controller && typeof controller.findSource === "function" ? controller.findSource(event.sourceId) : null
    if (alreadyDetailed || !source || source.kind !== "google" || !controller.service
        || controller.service.backendCanGoogleCalendars !== true) return
    detailLoading = true
    controller.nativeRequest(source, "get", {eventId:event.googleId}, function(result, error) {
      if (serial !== root.detailReadSerial || !root.detailEvent
          || Calendar.eventKey(root.detailEvent) !== Calendar.eventKey(event)) return
      root.detailLoading = false
      if (error) { root.detailError = error; return }
      var resource
      try { resource = JSON.parse(result.body) } catch (e) { root.detailError = "Could not read the event details"; return }
      var values = Calendar.eventsFromGoogle({items:[resource]}, source.id)
      if (values.length === 1 && Calendar.eventKey(values[0]) === Calendar.eventKey(event)) root.detailEvent = values[0]
      else root.detailError = "This event is no longer available"
    })
  }

  // Escape's first answer while the busy-day preview is up.
  function dismissPreview() {
    if (!monthOverflow.opened) return false
    monthOverflow.close()
    monthHoverDelay.stop()
    hoveredMonthDay = null
    return true
  }

  function closeDetail() { detailReadSerial++; detailLoading = false; detailError = ""; waitingForEvent = false; detailEvent = null }

  function reschedule(event, startMs, endMs) {
    if (!controller || !event || !event.start || !event.end) return
    var refusal = controller.rescheduleRefusal(event)
    if (refusal !== "") { controller.lastError = refusal; return }
    if ((event.attendees || []).some(function(attendee) { return attendee.self !== true })) {
      controller.composeRequested({ editingEvent: event, startMs: startMs, endMs: endMs })
      return
    }
    controller.updateEvent(event.sourceId, event, Calendar.rescheduleFields(event, startMs, endMs))
  }

  function activateSelection() {
    var values = visibleEvents()
    for (var i = 0; i < values.length; i++) {
      if (Calendar.eventKey(values[i]) === selectedEventId) {
        activateEvent(values[i])
        return
      }
    }
    moveSelection(1)
  }

  function refresh() {
    var range = viewMode === "day" || viewMode === "week" ? displayDays : days
    if (!controller || range.length === 0) return
    controller.refresh(range[0].startMs, range[range.length - 1].endMs)
  }

  function moveMonth(offset) {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1)
    visibleWeek = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(),
      Math.min(visibleWeek.getDate(), new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate()))
    refresh()
  }

  function goToday() {
    var now = new Date()
    visibleMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    visibleWeek = now
    refresh()
  }

  function movePeriod(offset) {
    if (viewMode === "day" || viewMode === "week") {
      visibleWeek = new Date(visibleWeek.getFullYear(), visibleWeek.getMonth(),
        visibleWeek.getDate() + offset * (viewMode === "day" ? 1 : 7))
      visibleMonth = new Date(visibleWeek.getFullYear(), visibleWeek.getMonth(), 1)
      refresh()
    } else moveMonth(offset)
  }

  function setView(mode) {
    viewMode = ["day", "week", "month", "agenda"].indexOf(mode) >= 0 ? mode : "month"
    refresh()
  }

  function showEvent(eventId, startMs) {
    selectedEventId = String(eventId || "")
    requestedEventStart = Number(startMs) || 0
    waitingForEvent = selectedEventId !== ""
    viewMode = "month"
    if (Number(startMs) > 0) {
      var date = new Date(Number(startMs))
      visibleMonth = new Date(date.getFullYear(), date.getMonth(), 1)
      visibleWeek = date
    }
    refresh()
    resolveRequestedEvent()
    if (!waitingForEvent) return
    var separator = selectedEventId.indexOf("\n")
    var requested = selectedEventId
    var source = separator >= 0 && controller ? controller.findSource(requested.substring(0, separator)) : null
    if (source && source.kind === "google" && controller.service.backendCanGoogleCalendars === true) {
      controller.nativeRequest(source, "get", { eventId: requested.substring(separator + 1) }, function(result, error) {
        if (!root.waitingForEvent || root.selectedEventId !== requested || error) return
        var resource
        try { resource = JSON.parse(result.body) } catch (e) { return }
        var events = Calendar.eventsFromGoogle({ items: [resource] }, source.id)
        if (events.length === 1) { root.waitingForEvent = false; root.activateEvent(events[0], true) }
      })
    }
  }

  function resolveRequestedEvent() {
    if (!waitingForEvent || !controller) return
    var found = controller.events.filter(function(event) {
      return Calendar.eventKey(event) === root.selectedEventId
        || (String(event.uid || "") === root.selectedEventId && event.start
          && (!root.requestedEventStart || Number(event.start.ms) === root.requestedEventStart))
    })
    if (found.length === 1) { waitingForEvent = false; activateEvent(found[0]) }
  }

  Component.onCompleted: refresh()

  TextMetrics {
    id: monthLabelMetrics
    font.family: root.panelFontFamily
    font.pixelSize: root.toolbarFontSize
    text: "September " + root.visibleMonth.getFullYear() + " ▾"
  }

  FontMetrics {
    id: monthFontMetrics
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
  }

  TextMetrics {
    id: viewLabelMetrics
    font.family: root.panelFontFamily
    font.pixelSize: root.toolbarFontSize
    text: viewSelector.displayText
  }

  Column {
    id: mainColumn
    anchors.fill: parent
    anchors.margins: Style.space(14)
    spacing: Style.space(10)

    Item {
      id: calendarToolbar
      objectName: "calendar-toolbar"
      parent: root.toolbarHost || mainColumn
      visible: root.visible && !root.detailOpen
      width: parent.width
      readonly property bool stacked: width < dateControls.implicitWidth + viewControls.implicitWidth + Style.space(24)
      height: stacked ? dateControls.implicitHeight + viewControls.implicitHeight + Style.space(12)
        : Math.max(dateControls.implicitHeight, viewControls.implicitHeight)

      RowLayout {
        id: dateControls
        anchors.left: parent.left
        anchors.verticalCenter: !calendarToolbar.stacked ? parent.verticalCenter : undefined
        anchors.top: calendarToolbar.stacked ? parent.top : undefined
        spacing: Style.space(2)

        IconTextButton {
          text: "‹"
          implicitHeight: root.toolbarControlHeight
          tooltipText: "Previous period"
          ghost: true
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          fontSize: root.toolbarFontSize
          onClicked: root.movePeriod(-1)
        }

        IconTextButton {
          id: dateButton
          objectName: "calendar-date-picker"
          text: (root.viewMode === "day" ? Qt.formatDate(root.visibleWeek, "d MMMM yyyy")
            : root.viewMode === "week" ? Calendar.weekTitle(root.weekDays)
            : root.monthNames[root.visibleMonth.getMonth()] + " " + root.visibleMonth.getFullYear()) + " ▾"
          implicitHeight: root.toolbarControlHeight
          Layout.minimumWidth: root.viewMode === "month" || root.viewMode === "agenda"
            ? monthLabelMetrics.advanceWidth + Style.spacing.controlPaddingX * 2 : implicitWidth
          tooltipText: "Choose date..."
          ghost: true
          selected: datePopup.opened
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: root.toolbarFontSize
          onClicked: {
            datePopup.shownMonth = new Date(root.visibleWeek.getFullYear(), root.visibleWeek.getMonth(), 1)
            datePopup.open()
          }
        }

        IconTextButton {
          text: "›"
          implicitHeight: root.toolbarControlHeight
          tooltipText: "Next period"
          ghost: true
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          fontSize: root.toolbarFontSize
          onClicked: root.movePeriod(1)
        }

        IconTextButton {
          text: "Today"
          implicitHeight: root.toolbarControlHeight
          tooltipText: "Show the current date"
          Layout.leftMargin: Style.space(10)
          foreground: root.textColor
          accent: root.accentColor
          ghost: true
          fontFamily: root.panelFontFamily
          fontSize: root.toolbarFontSize
          onClicked: root.goToday()
        }

      }

      RowLayout {
        id: viewControls
        anchors.right: parent.right
        anchors.verticalCenter: !calendarToolbar.stacked ? parent.verticalCenter : undefined
        anchors.bottom: calendarToolbar.stacked ? parent.bottom : undefined
        spacing: Style.space(4)

        Item {
          id: calendarLoading
          width: visible ? Style.space(24) : 0
          height: Style.space(24)
          visible: !!root.controller && root.controller.loading

          ActionIcon {
            anchors.centerIn: parent
            name: "refresh"
            // The same size as the chevrons beside it and Check mail above.
            iconSize: Style.font.icon
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

        ComboBox {
          id: viewSelector
          objectName: "calendar-view-selector"
          implicitWidth: viewLabelMetrics.advanceWidth + leftPadding + rightPadding
          implicitHeight: root.toolbarControlHeight
          model: root.viewOptions
          textRole: "label"
          currentIndex: ["day", "week", "month", "agenda"].indexOf(root.viewMode)
          onActivated: function(index) { root.setView(root.viewOptions[index].mode) }
          leftPadding: Style.space(10)
          rightPadding: Style.space(28)
          contentItem: Text {
            text: viewSelector.displayText
            textFormat: Text.PlainText
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: root.toolbarFontSize
            verticalAlignment: Text.AlignVCenter
          }
          indicator: ActionIcon {
            name: "chevronDown"
            x: viewSelector.width - width - Style.space(8)
            y: (viewSelector.height - height) / 2
            iconSize: Style.font.iconSmall
            color: root.textColor
          }
          background: Rectangle {
            color: viewSelector.popup.opened ? Qt.alpha(root.accentColor, 0.16)
              : viewSelector.hovered ? Qt.alpha(root.textColor, 0.08) : "transparent"
            radius: Style.cornerRadius
          }
          delegate: ItemDelegate {
            id: viewOption
            required property var modelData
            required property int index
            width: viewSelector.popup.width - Style.space(8)
            implicitHeight: Style.spacing.controlHeight
            highlighted: viewSelector.highlightedIndex === index
            contentItem: Text {
              text: viewOption.modelData.label + (viewSelector.currentIndex === viewOption.index ? " ✓" : "")
              textFormat: Text.PlainText
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: root.toolbarFontSize
              verticalAlignment: Text.AlignVCenter
            }
            background: Rectangle {
              color: viewOption.highlighted ? Qt.alpha(root.accentColor, 0.12) : "transparent"
            }
          }
          popup: Popup {
            width: Math.max(viewSelector.width, Style.space(170))
            padding: Style.space(4)
            implicitHeight: viewList.contentHeight + padding * 2
            function place() {
              var window = viewSelector.Window.window
              if (!window) return
              var point = viewSelector.mapToItem(window.contentItem, 0, 0)
              var top = point.y + viewSelector.height
              if (top + height > window.height) top = point.y - height
              y = Math.max(0, Math.min(top, window.height - height)) - point.y
              x = Math.max(0, Math.min(point.x, window.width - width)) - point.x
            }
            onOpened: place()
            onHeightChanged: if (opened) place()
            contentItem: ListView {
              id: viewList
              clip: true
              model: viewSelector.popup.visible ? viewSelector.delegateModel : null
              currentIndex: viewSelector.highlightedIndex
            }
            background: Rectangle {
              color: root.backgroundColor
              border.color: Style.normalBorderFor(root.textColor, root.accentColor)
              radius: Style.cornerRadius
            }
          }
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

    Text {
      width: parent.width
      visible: !!root.controller && root.controller.lastError !== "" && root.controller.events.length > 0
      text: "Showing available events. Some calendar data may be out of date."
      textFormat: Text.PlainText
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
    }

    CalendarReminderPanel {
      width: parent.width
      service: root.controller ? root.controller.service : null
      textColor: root.textColor
      dimColor: root.dimColor
      accentColor: root.accentColor
      urgentColor: root.urgentColor
      panelFontFamily: root.panelFontFamily
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

    Item {
      id: monthGrid
      visible: root.viewMode === "month"
      width: parent.width
      height: parent.height - y
      readonly property real weekHeight: height / (root.days.length / 7)
      readonly property real eventTop: Style.space(10) + monthFontMetrics.height
      readonly property real eventPitch: Style.space(25)
      // Leave space for an overflow link even when spanning events fill a week.
      readonly property int spanLimit: Math.max(0, Math.floor(
        (weekHeight - eventTop - Style.space(5) - monthFontMetrics.height) / eventPitch))
      function visibleLanes(week) { return Math.min(spanLimit, root.monthSpans.laneCounts[week] || 0) }

      HoverHandler {
        id: monthHover
        onHoveredChanged: root.updateMonthHover()
        onPointChanged: root.updateMonthHover()
      }

      Repeater {
        id: monthDaysRepeater
        model: root.days

        delegate: Rectangle {
          id: dayCell
          objectName: "calendar-month-day-" + modelData.isoDate
          required property var modelData
          required property int index
          readonly property var dayEvents: Calendar.eventsOnDay(
             root.controller ? root.controller.events : [], modelData).filter(function(event) {
               return !Calendar.spansMultipleDays(event)
             })
          readonly property int week: Math.floor(index / 7)
          readonly property int hiddenSpans: root.monthSpans.segments.filter(function(segment) {
            return segment.week === dayCell.week && segment.lane >= monthGrid.visibleLanes(dayCell.week)
              && segment.startColumn <= dayCell.index % 7 && segment.endColumn >= dayCell.index % 7
          }).length
          readonly property int overflowCount: hiddenSpans + Math.max(0, dayEvents.length - eventLimit)
          readonly property int eventLimit: Calendar.monthEventLimit(
            height - eventRows.y - Style.space(5), Style.space(23), eventRows.spacing,
            overflowLabel.implicitHeight, hiddenSpans > 0 ? Number.MAX_VALUE : dayEvents.length)
          x: index % 7 * width
          y: week * height
          width: monthGrid.width / 7
          height: monthGrid.height / (root.days.length / 7)
          color: monthOverflow.opened && monthOverflow.dayCell === dayCell
            ? Qt.alpha(root.accentColor, 0.08)
            : modelData.isoDate === root.todayIso
            ? root.calendarTodayBackgroundColor
            : "transparent"
          radius: 0

          Rectangle {
            width: root.calendarBorderWidth
            height: parent.height
            color: Qt.alpha(root.calendarBorderColor, 0.25)
          }
          Rectangle {
            width: parent.width
            height: root.calendarBorderWidth
            color: Qt.alpha(root.calendarBorderColor, 0.25)
          }
          Rectangle {
            visible: dayCell.index % 7 === 6
            anchors.right: parent.right
            width: root.calendarBorderWidth
            height: parent.height
            color: Qt.alpha(root.calendarBorderColor, 0.25)
          }
          Rectangle {
            visible: dayCell.index >= root.days.length - 7
            anchors.bottom: parent.bottom
            width: parent.width
            height: root.calendarBorderWidth
            color: Qt.alpha(root.calendarBorderColor, 0.25)
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onPressed: root.beginMonthGesture()
            onReleased: root.monthPointerDown = false
            onCanceled: root.monthPointerDown = false
            onClicked: root.createAt(dayCell.modelData.startMs + 9 * 3600000)
          }

          Rectangle {
            anchors.centerIn: dayNumber
            width: Math.max(dayNumber.implicitWidth + Style.space(8), dayNumber.implicitHeight + Style.space(4))
            height: dayNumber.implicitHeight + Style.space(4)
            radius: height / 2
            color: root.accentColor
            visible: dayCell.modelData.isoDate === root.todayIso
          }

          Text {
            id: dayNumber
            height: monthFontMetrics.height
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.margins: Style.space(6)
            text: dayCell.modelData.day
            color: dayCell.modelData.isoDate === root.todayIso ? root.backgroundColor
              : dayCell.modelData.inMonth ? root.textColor : root.dimColor
            opacity: dayCell.modelData.inMonth ? 1 : 0.55
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            font.bold: dayCell.modelData.isoDate === root.todayIso
            textFormat: Text.PlainText
          }

          Column {
            id: eventRows
            anchors.top: dayNumber.bottom
            anchors.topMargin: Style.space(4) + monthGrid.visibleLanes(dayCell.week) * monthGrid.eventPitch
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: Style.space(4)
            anchors.rightMargin: Style.space(4)
            spacing: Style.space(2)

            Repeater {
              model: Math.min(dayCell.dayEvents.length, dayCell.eventLimit)
              delegate: Rectangle {
                id: monthEvent
                required property int index
                readonly property var eventData: dayCell.dayEvents[index]
                readonly property color eventColor: calendarPalette.colorFor(
                  root.controller ? root.controller.colorKeyFor(eventData.sourceId) : "")
                width: parent.width
                height: Style.space(23)
                radius: Style.space(3)
                color: Qt.rgba(eventColor.r, eventColor.g, eventColor.b,
                  eventData && Calendar.eventKey(eventData) === root.selectedEventId ? 0.28 : 0.15)
                border.width: eventData && Calendar.eventKey(eventData) === root.selectedEventId ? 2 : 0
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
                    var title = String(event.summary || "Untitled event")
                    return monthEvent.width < Style.space(140) ? title + (time ? " · " + time.trim() : "") : time + title
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
                  preventStealing: true
                  property point initial: Qt.point(0, 0)
                  onPressed: function(mouse) { root.beginMonthGesture(); initial = mapToItem(monthGrid, mouse.x, mouse.y) }
                  onCanceled: root.monthPointerDown = false
                  onReleased: function(mouse) {
                    root.monthPointerDown = false
                    var point = mapToItem(monthGrid, mouse.x, mouse.y)
                    if (Math.abs(point.x - initial.x) + Math.abs(point.y - initial.y) < 6) {
                      root.activateEvent(monthEvent.eventData)
                      return
                    }
                    if (!root.controller || root.controller.rescheduleRefusal(monthEvent.eventData) !== "") return
                    if (point.x < 0 || point.y < 0 || point.x >= monthGrid.width || point.y >= monthGrid.height) return
                    var rows = root.days.length / 7
                    var from = Math.floor(initial.y / (monthGrid.height / rows)) * 7 + Math.floor(initial.x / (monthGrid.width / 7))
                    var to = Math.floor(point.y / (monthGrid.height / rows)) * 7 + Math.floor(point.x / (monthGrid.width / 7))
                    var range = Calendar.gestureRange(monthEvent.eventData, to - from, 0, "")
                    if (range) root.reschedule(monthEvent.eventData, range.start, range.end)
                  }
                }
              }
            }

            Text {
              id: overflowLabel
              visible: dayCell.overflowCount > 0
              width: parent.width
              text: "+" + dayCell.overflowCount + " more..."
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: { root.visibleWeek = new Date(dayCell.modelData.startMs); root.setView("day") }
              }
            }
          }
        }
      }

      Repeater {
        model: root.monthSpans.segments
        delegate: Rectangle {
          id: spanBar
          required property var modelData
          objectName: "calendar-month-span-" + String(modelData.event.googleId || modelData.event.uid) + "-" + modelData.week
          readonly property var eventData: modelData.event
          readonly property color eventColor: calendarPalette.colorFor(
            root.controller ? root.controller.colorKeyFor(eventData.sourceId) : "")
          visible: modelData.lane < monthGrid.visibleLanes(modelData.week)
          x: modelData.startColumn * monthGrid.width / 7 + Style.space(4)
          y: modelData.week * monthGrid.weekHeight + monthGrid.eventTop + modelData.lane * monthGrid.eventPitch
          width: (modelData.endColumn - modelData.startColumn + 1) * monthGrid.width / 7 - Style.space(8)
          height: Style.space(23)
          radius: Style.space(3)
          color: Qt.alpha(eventColor, Calendar.eventKey(eventData) === root.selectedEventId ? 0.28 : 0.15)
          border.color: eventColor
          border.width: Calendar.eventKey(eventData) === root.selectedEventId ? 1 : 0
          Rectangle {
            anchors.left: parent.left
            height: parent.height
            width: Style.space(3)
            color: spanBar.eventColor
          }
          Text {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            text: spanBar.modelData.continuesBefore ? "‹" : ""
            textFormat: Text.PlainText
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            anchors.fill: parent
            anchors.leftMargin: Style.space(spanBar.modelData.continuesBefore ? 18 : 6)
            anchors.rightMargin: Style.space(spanBar.modelData.continuesAfter ? 18 : 6)
            verticalAlignment: Text.AlignVCenter
            text: (spanBar.eventData.start.allDay ? "" : Calendar.timeLabel(spanBar.eventData.start.ms) + " ")
              + String(spanBar.eventData.summary || "Untitled event")
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            text: spanBar.modelData.continuesAfter ? "›" : ""
            textFormat: Text.PlainText
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
          }
          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            preventStealing: true
            property point initial: Qt.point(0, 0)
            onPressed: function(mouse) { root.beginMonthGesture(); initial = mapToItem(monthGrid, mouse.x, mouse.y) }
            onCanceled: root.monthPointerDown = false
            onReleased: function(mouse) {
              root.monthPointerDown = false
              var point = mapToItem(monthGrid, mouse.x, mouse.y)
              if (Math.abs(point.x - initial.x) + Math.abs(point.y - initial.y) < 6) {
                root.activateEvent(spanBar.eventData)
                return
              }
              if (!root.controller || root.controller.rescheduleRefusal(spanBar.eventData) !== "") return
              if (point.x < 0 || point.y < 0 || point.x >= monthGrid.width || point.y >= monthGrid.height) return
              var from = Math.floor(initial.y / monthGrid.weekHeight) * 7 + Math.floor(initial.x / (monthGrid.width / 7))
              var to = Math.floor(point.y / monthGrid.weekHeight) * 7 + Math.floor(point.x / (monthGrid.width / 7))
              var range = Calendar.gestureRange(spanBar.eventData, to - from, 0, "")
              if (range) root.reschedule(spanBar.eventData, range.start, range.end)
            }
          }
        }
      }
    }

    WeekCalendarView {
      width: parent.width
      height: parent.height - y
       visible: root.viewMode === "day" || root.viewMode === "week"
      controller: root.controller
      nowMs: root.controller ? root.controller.nowMs : 0
       days: root.displayDays
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
      onCreateRange: function(startMs, endMs) {
        if (root.controller) root.controller.composeRequested({ startMs: startMs, endMs: endMs })
      }
      onCreateAllDay: function(startMs, endMs) {
        if (root.controller) root.controller.composeRequested({ startMs: startMs, endMs: endMs, allDay: true })
      }
      onEventRescheduled: function(event, startMs, endMs) { root.reschedule(event, startMs, endMs) }
      onEventActivated: function(event) { root.activateEvent(event) }
    }

    ListView {
      id: agendaList
      width: parent.width
      height: parent.height - y
      visible: root.viewMode === "agenda"
      clip: true
      spacing: Style.space(6)
      model: root.agendaEvents
      ScrollBar.vertical: ScrollBar {}
      Text {
        anchors.centerIn: parent
        width: parent.width - Style.space(24)
        visible: agendaList.count === 0
        text: "No upcoming events in this date range."
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        horizontalAlignment: Text.AlignHCenter
        color: root.dimColor
        font.family: root.panelFontFamily
      }
      delegate: Rectangle {
        id: agendaRow
        required property var modelData
        width: ListView.view.width
        height: Style.space(64)
        radius: Style.cornerRadius
        color: Calendar.eventKey(modelData) === root.selectedEventId
          ? Style.selectedFillFor(root.textColor, root.accentColor)
          : agendaMouse.containsMouse ? Style.hoverFillFor(root.textColor, root.accentColor)
          : Style.normalFillFor(root.textColor, root.accentColor)
        Column {
          anchors.fill: parent
          anchors.margins: Style.space(8)
          spacing: Style.space(4)
          Text {
            width: parent.width
            text: String(agendaRow.modelData.summary || "Untitled event")
            textFormat: Text.PlainText
            color: root.textColor
            font.family: root.panelFontFamily
            font.bold: true
            elide: Text.ElideRight
          }
          Text {
            width: parent.width
            text: Qt.formatDateTime(new Date(agendaRow.modelData.start.ms), agendaRow.modelData.start.allDay ? "ddd, MMM d" : "ddd, MMM d · hh:mm")
              + (agendaRow.modelData.start.allDay ? " · All day" : "")
            textFormat: Text.PlainText
            color: root.dimColor
            font.family: root.panelFontFamily
            elide: Text.ElideRight
          }
        }
        MouseArea {
          id: agendaMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.activateEvent(agendaRow.modelData)
        }
      }
    }
        }
      }
    }
  }

  // A hover preview, not a QQC.Popup: an open Popup takes every key before the
  // window's shortcuts see it, focused or not (tst_popup_keys), so resting the
  // pointer on a busy day would silence j, k and every view key until it left.
  // An item drawn above the window keeps the keyboard with KeyRouter; Escape
  // reaches it through goBack().
  Rectangle {
    id: monthOverflow
    objectName: "calendar-month-overflow"
    parent: root.Window.window ? root.Window.window.contentItem : root
    property Item dayCell: null
    property bool opened: false
    readonly property real padding: Style.space(10)
    readonly property var events: dayCell ? Calendar.eventsOnDay(root.controller ? root.controller.events : [], dayCell.modelData) : []
    function open() { opened = true }
    function close() {
      if (!opened) return
      opened = false
      monthHoverClose.stop()
    }
    visible: opened
    z: 1000
    width: Math.min(Style.space(400), parent.width - Style.space(16))
    height: Math.min(Style.space(460), parent.height - Style.space(24), overflowHeading.implicitHeight
      + overflowEvents.height + padding * 2 + Style.space(10))
    color: root.backgroundColor
    border.color: Style.normalBorderFor(root.textColor, root.accentColor)
    radius: Style.cornerRadius
    function place() {
      if (!dayCell) return
      var below = dayCell.mapToItem(parent, 0, dayCell.height)
      var above = dayCell.mapToItem(parent, 0, 0)
      x = Math.max(0, Math.min(above.x, parent.width - width))
      y = Math.max(0, Math.min(below.y + height > parent.height ? above.y - height : below.y, parent.height - height))
    }
    onOpenedChanged: if (opened) place()
    onHeightChanged: if (opened) place()
    // Swallows clicks that miss an event, as the popup's background did, so
    // one never lands on the month cell drawn underneath.
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onWheel: function(wheel) { wheel.accepted = true } }
    Item {
      anchors.fill: parent
      anchors.margins: monthOverflow.padding
      HoverHandler {
        id: overflowHover
        onHoveredChanged: {
          if (hovered) { monthHoverClose.stop(); monthHoverDelay.stop() }
          else { root.hoveredMonthDay = null; monthHoverClose.restart() }
        }
      }
      Text {
        id: overflowHeading
        width: parent.width
        text: monthOverflow.dayCell ? Qt.formatDate(new Date(monthOverflow.dayCell.modelData.startMs), "dddd, d MMMM")
          + " · " + monthOverflow.events.length + " events" : ""
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        font.bold: true
      }
      Flickable {
        id: overflowScroll
        objectName: "calendar-month-overflow-scroll"
        anchors.top: overflowHeading.bottom
        anchors.topMargin: Style.space(10)
        anchors.bottom: parent.bottom
        width: parent.width
        clip: true
        contentHeight: overflowEvents.height
        contentWidth: width
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: overflowScroll.contentHeight > overflowScroll.height ? ScrollBar.AlwaysOn : ScrollBar.AsNeeded }
        WheelScroller { view: overflowScroll }
        Column {
          id: overflowEvents
          width: parent.width
          spacing: Style.space(4)
          Repeater {
            model: monthOverflow.events
            delegate: Rectangle {
              id: overflowEvent
              required property var modelData
              objectName: "calendar-overflow-event-" + String(modelData.googleId || modelData.uid)
              readonly property color eventColor: calendarPalette.colorFor(root.controller ? root.controller.colorKeyFor(modelData.sourceId) : "")
              width: parent.width
              height: overflowTitle.implicitHeight + overflowTime.implicitHeight + Style.space(18)
              color: Qt.alpha(eventColor, overflowMouse.containsMouse ? 0.25 : 0.12)
              radius: Style.cornerRadius
              Rectangle { width: Style.space(3); height: parent.height; color: overflowEvent.eventColor }
              Text {
                id: overflowTitle
                x: Style.space(8)
                y: Style.space(6)
                width: parent.width - Style.space(20)
                text: String(overflowEvent.modelData.summary || "Untitled event")
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: root.textColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                id: overflowTime
                x: overflowTitle.x
                y: overflowTitle.y + overflowTitle.height + Style.space(2)
                width: overflowTitle.width
                text: overflowEvent.modelData.start.allDay ? "All day"
                  : Qt.formatDateTime(new Date(overflowEvent.modelData.start.ms), Calendar.spansMultipleDays(overflowEvent.modelData) ? "d MMM HH:mm" : "HH:mm")
                    + " – " + Qt.formatDateTime(new Date(overflowEvent.modelData.end.ms), Calendar.spansMultipleDays(overflowEvent.modelData) ? "d MMM HH:mm" : "HH:mm")
                textFormat: Text.PlainText
                color: root.dimColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                id: overflowMouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.activateEvent(overflowEvent.modelData)
              }
            }
          }
        }
      }
    }
  }

  Popup {
    id: datePopup
    parent: root.toolbarHost && root.toolbarHost.Window.window ? root.toolbarHost.Window.window.contentItem : root
    property date shownMonth: new Date()
    width: Style.space(310)
    padding: Style.space(10)
    focus: true
    function place() {
      var below = dateButton.mapToItem(parent, 0, dateButton.height)
      var above = dateButton.mapToItem(parent, 0, 0)
      x = Math.max(0, Math.min(below.x, parent.width - width))
      y = Math.max(0, Math.min(below.y + height > parent.height ? above.y - height : below.y, parent.height - height))
    }
    onOpened: place()
    onHeightChanged: if (opened) place()
    background: Rectangle {
      color: root.backgroundColor
      border.color: Style.normalBorderFor(root.textColor, root.accentColor)
      radius: Style.cornerRadius
    }
    contentItem: Column {
      spacing: Style.space(8)
      Row {
        spacing: Style.space(8)
        IconTextButton {
          text: "‹"
          Accessible.name: "Previous month"
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: datePopup.shownMonth = new Date(datePopup.shownMonth.getFullYear(), datePopup.shownMonth.getMonth() - 1, 1)
        }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: Qt.formatDate(datePopup.shownMonth, "MMM yyyy")
          textFormat: Text.PlainText
          color: root.textColor
          font.family: root.panelFontFamily
        }
        IconTextButton {
          text: "›"
          Accessible.name: "Next month"
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: datePopup.shownMonth = new Date(datePopup.shownMonth.getFullYear(), datePopup.shownMonth.getMonth() + 1, 1)
        }
      }
      Row {
        width: parent.width
        Repeater {
          model: root.weekdayNames
          Text {
            required property string modelData
            width: parent.width / 7
            text: modelData.substring(0, 2)
            textFormat: Text.PlainText
            horizontalAlignment: Text.AlignHCenter
            color: root.dimColor
            font.family: root.panelFontFamily
          }
        }
      }
      Grid {
        width: parent.width
        columns: 7
        Repeater {
          model: Calendar.monthDays(datePopup.shownMonth.getFullYear(), datePopup.shownMonth.getMonth(), 1)
          IconTextButton {
            required property var modelData
            width: parent.width / 7
            text: String(modelData.day)
            foreground: modelData.inMonth ? root.textColor : root.dimColor
            accent: root.accentColor
            fontFamily: root.panelFontFamily
            selected: modelData.isoDate === Calendar.isoDate(root.visibleWeek)
            onClicked: {
              root.visibleWeek = new Date(modelData.startMs)
              root.visibleMonth = new Date(modelData.year, modelData.month, 1)
              datePopup.close()
              root.refresh()
            }
          }
        }
      }
    }
  }

  CalendarEventDetail {
    refreshing: root.detailLoading
    refreshError: root.detailError
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
