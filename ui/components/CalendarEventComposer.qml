import QtQuick
import QtQuick.Window
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../calendar/Calendar.js" as Calendar
import "../compose/Recipients.js" as Recipients

Rectangle {
  id: root

  required property var controller
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property string panelFontFamily

  property bool opened: false
  property string selectedSourceId: ""
  property bool recurring: false
  property bool changeRecurrence: false
  property bool createMeet: false
  property string conferenceRequestId: ""
  property string originalGuestText: ""
  property bool advancedOptionsOpen: false
  readonly property var contactService: controller && controller.service ? controller.service : null
  readonly property var contactBook: contactService && Array.isArray(contactService.recipientContacts)
    ? contactService.recipientContacts : []
  property bool guestSuggestionsDismissed: false
  readonly property var guestSuggestions: opened && guestsField.visible && guestsField.activeFocus && !guestSuggestionsDismissed
    ? Recipients.suggest(contactBook, guestsField.text, 5) : []
  readonly property bool guestSuggestionsOpen: guestSuggestions.length > 0
  onGuestSuggestionsChanged: if (guestSuggestionsOpen) Qt.callLater(root.revealField, guestsField)

  function moveGuestSuggestion(delta) { guestSuggestionsList.moveSelection(delta) }
  function chooseGuestSuggestion() { guestSuggestionsList.acceptSelection() }
  function dismissGuestSuggestions() { guestSuggestionsDismissed = true }
  function acceptGuest(contact) {
    // Calendar's guest payload accepts addresses, not mail's display-name syntax.
    guestsField.text = Recipients.accept(guestsField.text, { email: contact.email }) + ", "
    guestsField.forceActiveFocus()
  }
  property string reminderMode: "default"
  property string availability: "opaque"
  property string eventVisibility: "default"
  property bool visibilityChanged: false
  property bool availabilityChanged: false
  readonly property var chosenSource: controller && typeof controller.findSource === "function"
    ? controller.findSource(selectedSourceId) : null
  property string recurrenceFrequency: "WEEKLY"
  // Set while an existing event is being changed rather than a new one made.
  // Calendar changes select a transfer destination; they are committed on Save.
  property var editingEvent: null
  property bool loadingSeries: false
  property bool transferring: false
  property bool transferNeedsRefresh: false
  property int editGeneration: 0
  // Google's options travel only through the API 6 backend; an older one
  // would save the event without them, so the controls are not offered.
  readonly property bool googleWrites: !!chosenSource && chosenSource.kind === "google"
    && !!controller && !!controller.service && controller.service.backendCanGoogleCalendars === true
  readonly property bool guestUpdate: editing && googleWrites
    && !!editingEvent.organizer && editingEvent.organizer.self === true
    && ((Array.isArray(editingEvent.attendees) && editingEvent.attendees.some(function(attendee) { return attendee.self !== true }))
      || guestsField.text.trim() !== "")
  property string editingSourceId: ""
  readonly property bool editing: editingEvent !== null
  // Nothing typed and nothing being edited: a form that can be replaced
  // without losing anyone anything.
  readonly property bool pristine: !editing && !writePending
    && String(titleField.text || "") === "" && String(locationField.text || "") === ""
    && String(notesField.text || "") === "" && String(guestsField.text || "").trim() === ""
  onOpenedChanged: {
    guestSuggestionsDismissed = false
    if (!opened && controller) controller.composeEnded()
    if (opened && contactService && typeof contactService.refreshRecipientContacts === "function")
      contactService.refreshRecipientContacts()
  }
  Binding {
    target: root.controller
    property: "composerHeld"
    value: root.opened && !root.pristine
    when: !!root.controller
  }
  // Set when this form's own write is in flight. A completion is answered only
  // while it is: a write the user cancelled out of — Escape, then a newer
  // edit — must not close or report into this one.
  property bool writePending: false
  // An all-day event is edited as the dates it spans; the time fields stand
  // down, because writing them back would turn the event into a timed one.
  property bool allDay: false
  readonly property bool editingAllDay: allDay
  readonly property var dateRange: Calendar.editorDateRange(dateField.text, startField.text,
    endDateField.text, endField.text, allDay)
  color: root.backgroundColor

  component FieldLabel: Text {
    width: parent.width
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.bodySmall
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
  }

  function revealField(field) {
    if (!field.activeFocus) return
    var top = field.mapToItem(composerFlick.contentItem, 0, 0).y
    var bottom = field === guestsField && guestSuggestionsOpen
      ? guestSuggestionsList.mapToItem(composerFlick.contentItem, 0, guestSuggestionsList.height).y
      : top + field.height
    if (top < composerFlick.contentY) composerFlick.contentY = top
    else if (bottom > composerFlick.contentY + composerFlick.height)
      composerFlick.contentY = Math.max(0, Math.min(top, bottom - composerFlick.height))
  }

  component EditorField: TextField {
    id: input
    font.pixelSize: Style.font.bodySmall
    onActiveFocusChanged: if (activeFocus) Qt.callLater(root.revealField, input)
  }

  component EventOption: QQC.ComboBox {
    id: option
    property string value: ""
    signal chosen(string value)
    width: parent.width
    implicitHeight: Style.spacing.controlHeight
    textRole: "label"
    valueRole: "value"
    currentIndex: {
      for (var i = 0; i < model.length; i++) if (model[i].value === value) return i
      return -1
    }
    onActivated: function(index) { chosen(String(model[index].value)) }
    leftPadding: Style.space(10)
    rightPadding: Style.space(30)
    contentItem: Text {
      text: option.displayText
      textFormat: Text.PlainText
      elide: Text.ElideRight
      verticalAlignment: Text.AlignVCenter
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.body
    }
    indicator: ActionIcon {
      name: "chevronDown"
      x: option.width - width - Style.space(10)
      y: (option.height - height) / 2
      color: root.dimColor
      iconSize: Style.font.iconSmall
    }
    background: Rectangle {
      color: option.popup.opened ? Style.selectedFillFor(root.textColor, root.accentColor)
        : Style.normalFillFor(root.textColor, root.accentColor)
      border.width: Style.normalBorderWidth
      border.color: option.popup.opened ? root.accentColor : Style.normalBorderFor(root.textColor, root.accentColor)
      radius: Style.cornerRadius
    }
    delegate: QQC.ItemDelegate {
      id: optionRow
      required property var modelData
      required property int index
      width: option.width
      implicitHeight: Style.spacing.controlHeight
      highlighted: option.highlightedIndex === index
      contentItem: Text {
        text: optionRow.modelData.label
        textFormat: Text.PlainText
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
      }
      background: Rectangle {
        color: optionRow.highlighted ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent"
      }
    }
    popup: QQC.Popup {
      width: option.width
      padding: Style.space(4)
      implicitHeight: Math.min(optionList.contentHeight + padding * 2, Style.space(280))
      function place() {
        var window = option.Window.window
        if (!window) return
        var point = option.mapToItem(window.contentItem, 0, 0)
        var top = point.y + option.height
        if (top + height > window.height) top = point.y - height
        y = Math.max(0, Math.min(top, window.height - height)) - point.y
        x = Math.max(0, Math.min(point.x, window.width - width)) - point.x
      }
      onOpened: place()
      onHeightChanged: if (opened) place()
      contentItem: ListView {
        id: optionList
        clip: true
        model: option.popup.visible ? option.delegateModel : null
        currentIndex: option.highlightedIndex
        QQC.ScrollBar.vertical: QQC.ScrollBar {}
      }
      background: Rectangle {
        color: root.backgroundColor
        border.color: Style.normalBorderFor(root.textColor, root.accentColor)
        border.width: Style.normalBorderWidth
        radius: Style.cornerRadius
      }
    }
  }

  function localDate(date) {
    function two(value) { return value < 10 ? "0" + value : String(value) }
    return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate())
  }

  function localTime(date) {
    var hour = date.getHours(), minute = date.getMinutes()
    return (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") + minute
  }

  function beginAt(startMs) {
    advancedOptionsOpen = false
    changeRecurrence = false
    visibilityChanged = false
    availabilityChanged = false
    editGeneration++
    loadingSeries = false
    transferring = false
    transferNeedsRefresh = false
    var requested = Number(startMs)
    var start = isFinite(requested) && requested > 0
      ? new Date(requested) : new Date(Date.now() + 3600000)
    if (!(isFinite(requested) && requested > 0))
      start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0)
    var end = new Date(start.getTime() + 3600000)
    editingEvent = null
    allDay = false
    createMeet = false
    originalGuestText = ""
    guestsField.text = ""
    reminderMode = "default"
    reminderField.text = "10"
    availability = "opaque"
    eventVisibility = "default"
    conferenceRequestId = "omamail-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2)
    editingSourceId = ""
    writePending = false
    titleField.text = ""
    dateField.text = localDate(start)
    startField.text = localTime(start)
    endField.text = localTime(end)
    endDateField.text = localDate(end)
    locationField.text = ""
    notesField.text = ""
    intervalField.text = "1"
    countField.text = ""
    recurring = false
    recurrenceFrequency = "WEEKLY"
    resultText.text = ""
    // The mailbox being read is the one the event most likely belongs to, and
    // under the unified view it is not the first group: `groupByAccount` walks
    // the stored accounts in their own order, so "Create event..." from mailbox
    // B would otherwise open with A's calendar chosen and write there unless
    // the user noticed the picker.
    selectedSourceId = preferredCalendarId()
    timeZoneField.text = chosenSource ? String(chosenSource.timeZone || "") : ""
    opened = true
    Qt.callLater(titleField.forceActiveFocus)
  }

  function preferredCalendarId() {
    var groups = controller ? controller.writableSourceGroups : []
    if (!groups.length) return ""
    // `groupByAccount` names an account's group "account:" + its id, which is
    // the only place the owner survives into the group.
    var wanted = controller ? String(controller.accountId || "") : ""
    if (wanted !== "") {
      for (var i = 0; i < groups.length; i++) {
        if (String(groups[i].id || "") !== "account:" + wanted) continue
        for (var c = 0; c < groups[i].calendars.length; c++) {
          if (groups[i].calendars[c].preferred) return String(groups[i].calendars[c].id)
        }
        if (groups[i].calendars && groups[i].calendars.length)
          return String(groups[i].calendars[0].id)
      }
    }
    return String(groups[0].calendars[0].id)
  }

  function beginEdit(sourceId, event) {
    advancedOptionsOpen = !!event && (event.transparency === "transparent"
      || event.visibility === "private" || event.visibility === "public")
    changeRecurrence = false
    visibilityChanged = false
    availabilityChanged = false
    editGeneration++
    loadingSeries = false
    transferring = false
    transferNeedsRefresh = false
    if (!event || !event.start) return
    var start = new Date(Number(event.start.ms))
    var end = event.end ? new Date(Number(event.end.ms)) : new Date(start.getTime() + 3600000)
    editingEvent = event
    allDay = !!(event.start && event.start.allDay)
    createMeet = false
    originalGuestText = (event.attendees || []).map(function(attendee) { return String(attendee.email || "") }).filter(function(email) { return email !== "" }).join(", ")
    guestsField.text = originalGuestText
    reminderMode = "preserve"
    reminderField.text = "10"
    availability = event.transparency || "opaque"
    eventVisibility = event.visibility || "default"
    timeZoneField.text = String(event.timeZone || "")
    conferenceRequestId = "omamail-" + Date.now().toString(36) + "-" + Math.random().toString(36).substring(2)
    editingSourceId = String(sourceId || "")
    writePending = false
    titleField.text = String(event.summary || "")
    dateField.text = localDate(start)
    startField.text = localTime(start)
    endField.text = localTime(end)
    // The stored all-day end is the exclusive midnight after the last shown
    // day, so the field shows a millisecond before it.
    endDateField.text = event.start.allDay && event.end
      ? localDate(new Date(Number(event.end.ms) - 1)) : localDate(end)
    locationField.text = String(event.location || "")
    notesField.text = String(event.description || "")
    intervalField.text = "1"
    countField.text = ""
    recurring = false
    resultText.text = ""
    selectedSourceId = editingSourceId
    opened = true
    Qt.callLater(titleField.forceActiveFocus)
  }

  function begin() { beginAt(0) }

  function beginReschedule(event, startMs, endMs) {
    beginEdit(event.sourceId, event)
    var start = new Date(startMs), end = new Date(endMs)
    dateField.text = localDate(start)
    startField.text = localTime(start)
    endDateField.text = localDate(new Date(allDay ? endMs - 1 : endMs))
    endField.text = localTime(end)
  }


  // What the form holds, for a test to read without reaching into fields.
  function titleText() { return String(titleField.text || "") }
  function whenText() { return dateField.text + " " + startField.text + " " + endField.text }
  function locationText() { return String(locationField.text || "") }
  function notesText() { return String(notesField.text || "") }

  // Open with fields already filled — a suggestion from a message — for the
  // owner to look over and put on the calendar of their choice. Nothing is
  // written until they say so, which is the point of opening here.
  function beginWith(prefill) {
    var fields = prefill || {}
    // A form the owner is in the middle of is not replaced.
    if (opened && !pristine) return false
    if (fields.editingEvent) {
      beginReschedule(fields.editingEvent, Number(fields.startMs), Number(fields.endMs))
      return true
    }
    beginAt(Number(fields.startMs) || 0)
    allDay = fields.allDay === true
    var start = Number(fields.startMs) || 0
    var end = Number(fields.endMs) || 0
    if (start > 0 && end > start) {
      endField.text = localTime(new Date(end))
      endDateField.text = localDate(new Date(allDay ? end - 1 : end))
    }
    titleField.text = String(fields.title || "")
    locationField.text = String(fields.location || "")
    notesField.text = String(fields.description || "")
    // The calendar of the mailbox the message was read in, when it has
    // one: under the merged view that is not always the open account.
    var owner = calendarOf(String(fields.accountId || ""))
    if (owner !== "") selectedSourceId = owner
    return true
  }

  function calendarOf(accountId) {
    var groups = controller ? controller.writableSourceGroups : []
    if (!accountId || !groups) return ""
    for (var i = 0; i < groups.length; i++) {
      if (String(groups[i].id || "") !== "account:" + accountId) continue
      for (var c = 0; c < groups[i].calendars.length; c++) {
        if (groups[i].calendars[c].preferred) return String(groups[i].calendars[c].id)
      }
      if (groups[i].calendars && groups[i].calendars.length) return String(groups[i].calendars[0].id)
    }
    return ""
  }

  function close() {
    opened = false
    editingEvent = null
    editingSourceId = ""
  }
  function takeFocus() { titleField.forceActiveFocus() }

  function editSeries() {
    if (!editingEvent || !editingEvent.recurringEventId || loadingSeries || transferring || transferNeedsRefresh || !chosenSource) return
    var serial = ++editGeneration
    var source = chosenSource
    loadingSeries = true
    controller.nativeRequest(source, "get", { eventId: editingEvent.recurringEventId }, function(result, error) {
      if (serial !== root.editGeneration || !root.opened) return
      root.loadingSeries = false
      if (error) { resultText.text = error; return }
      var payload
      try { payload = JSON.parse(result.body) } catch (e) { resultText.text = "Could not read the series"; return }
      var events = Calendar.eventsFromGoogle({ items: [payload] }, source.id)
      if (events.length !== 1) { resultText.text = "The series is no longer available"; return }
      root.beginEdit(source.id, events[0])
    })
  }

  function changeRepeat() {
    var lines = editingEvent.recurrenceLines || []
    var rules = lines.filter(function(line) { return String(line).indexOf("RRULE:") === 0 })
    if (rules.length > 1 || (rules.length && !/^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;(INTERVAL|COUNT)=\d+)*$/.test(rules[0]))) {
      resultText.text = "This series has an advanced repeat rule. Change its repetition in Google Calendar. Other edits preserve it."
      return
    }
    var rule = rules.length ? rules[0] : ""
    var frequency = /FREQ=([A-Z]+)/.exec(rule), interval = /INTERVAL=(\d+)/.exec(rule), count = /COUNT=(\d+)/.exec(rule)
    recurring = rule !== ""
    recurrenceFrequency = frequency ? frequency[1] : "WEEKLY"
    intervalField.text = interval ? interval[1] : "1"
    countField.text = count ? count[1] : ""
    changeRecurrence = true
  }

  function chooseCalendar(sourceId) {
    if (transferring || transferNeedsRefresh || writePending || sourceId === selectedSourceId) return
    if (!editing) { selectedSourceId = sourceId; return }
    var original = editingSourceId
    var generation = editGeneration
    selectedSourceId = sourceId
    transferring = true
    resultText.text = "Moving event"
    controller.transferEvent(original, sourceId, editingEvent, function(event, error, moved) {
      if (generation !== root.editGeneration || !root.opened) return
      root.transferring = false
      if (error) {
        root.transferNeedsRefresh = moved === true
        root.selectedSourceId = moved === true ? sourceId : original
        resultText.text = error
        return
      }
      root.editingEvent = event
      root.editingSourceId = sourceId
      resultText.text = "Calendar changed"
    })
  }

  function submit(sendUpdates) {
    if (!controller) return
    // Create, update and delete share one controller write slot. Do not mark
    // this form pending unless that slot is free: otherwise an older write's
    // completion could be mistaken for this form's and close it.
    if (controller.creatingEvent || controller.eventWriting || loadingSeries || transferring || transferNeedsRefresh) return
    if (!dateRange.ok) return
    var fields = {
      title: titleField.text,
      allDay: allDay,
      startMs: dateRange.startMs,
      endMs: dateRange.endMs,
      location: locationField.text,
      description: notesField.text,
      createMeet: createMeet,
      conferenceRequestId: conferenceRequestId,
      destinationSourceId: selectedSourceId,
      sendUpdates: sendUpdates === "none" ? "none" : "all",
      timeZone: timeZoneField.text.trim(),
      guestEmails: !editing || guestsField.text !== originalGuestText ? guestsField.text : undefined,
      transparency: !editing || availabilityChanged ? availability : undefined,
      visibility: !editing || visibilityChanged ? eventVisibility : undefined,
      reminderMode: reminderMode,
      reminderMinutes: reminderField.text,
      changeRecurrence: changeRecurrence,
      recurrence: {
        enabled: recurring && !!chosenSource && chosenSource.kind !== "microsoft",
        frequency: recurrenceFrequency,
        interval: intervalField.text,
        count: countField.text
      }
    }
    writePending = true
    if (editing) controller.updateEvent(editingSourceId, editingEvent, fields)
    else controller.createEvent(selectedSourceId, fields)
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

  Flickable {
    id: composerFlick
    objectName: "event-composer-scroll"

    WheelScroller { view: composerFlick }

    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: editorFooter.top
    anchors.margins: Style.space(18)
    contentWidth: width
    contentHeight: form.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    QQC.ScrollBar.vertical: QQC.ScrollBar { policy: QQC.ScrollBar.AsNeeded }

    Column {
      id: form
      anchors.horizontalCenter: parent.horizontalCenter
      width: Math.min(parent.width, Style.space(620))
      spacing: Style.space(10)

      BackBar {
        label: "Calendar"
        textColor: root.textColor
        dimColor: root.dimColor
        panelFontFamily: root.panelFontFamily
        onActivated: root.close()
      }

      Text {
        text: root.editing && root.editingEvent.recurringEventId ? "Edit this occurrence"
          : root.editing && root.editingEvent.recurrence ? "Edit entire series"
          : root.editing ? "Edit event" : "Create event"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        textFormat: Text.PlainText
      }

      FieldLabel { text: "Calendar" }

      QQC.ComboBox {
        id: calendarSelector
        objectName: "event-calendar-selector"
        width: parent.width
        implicitHeight: Style.spacing.controlHeight
        enabled: count > 0 && !root.writePending && !root.transferring && !root.transferNeedsRefresh
        model: Calendar.calendarChoiceRows(root.controller ? root.controller.writableSourceGroups : [],
          root.editing && root.controller && typeof root.controller.findSource === "function"
            ? root.controller.findSource(root.editingSourceId) : null, root.editingEvent)
        currentIndex: {
          for (var i = 0; i < model.length; i++)
            if (String(model[i].source.id) === root.selectedSourceId) return i
          return -1
        }
        onActivated: function(index) { root.chooseCalendar(String(model[index].source.id)) }
        readonly property var choice: currentIndex >= 0 && currentIndex < model.length ? model[currentIndex] : null
        Accessible.name: "Calendar"
        leftPadding: Style.space(30)
        rightPadding: Style.space(32)
        contentItem: Text {
          text: calendarSelector.choice ? String(calendarSelector.choice.source.name || calendarSelector.choice.source.id) : "Choose a calendar"
          textFormat: Text.PlainText
          elide: Text.ElideMiddle
          verticalAlignment: Text.AlignVCenter
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.body
        }
        Rectangle {
          x: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(8)
          height: width
          radius: width / 2
          color: calendarPalette.colorFor(calendarSelector.choice ? calendarSelector.choice.source.colorKey : "accent")
        }
        indicator: ActionIcon {
          name: "chevronDown"
          x: calendarSelector.width - width - Style.space(10)
          y: (calendarSelector.height - height) / 2
          color: root.dimColor
          iconSize: Style.font.iconSmall
        }
        background: Rectangle {
          color: calendarSelector.popup.opened ? Style.selectedFillFor(root.textColor, root.accentColor)
            : calendarSelector.hovered ? Style.hoverFillFor(root.textColor, root.accentColor)
            : Style.normalFillFor(root.textColor, root.accentColor)
          border.width: Style.normalBorderWidth
          border.color: calendarSelector.popup.opened ? root.accentColor : Style.normalBorderFor(root.textColor, root.accentColor)
          radius: Style.cornerRadius
        }
        delegate: QQC.ItemDelegate {
          id: calendarOption
          objectName: "event-calendar-option-" + index
          required property var modelData
          required property int index
          width: calendarSelector.popup.availableWidth
          implicitHeight: optionContent.implicitHeight + Style.space(12)
          highlighted: calendarSelector.highlightedIndex === index
          padding: Style.space(6)
          contentItem: Column {
            id: optionContent
            spacing: Style.space(8)
            Text {
              width: parent.width
              visible: calendarOption.modelData.firstInGroup
              text: calendarOption.modelData.groupLabel
              textFormat: Text.PlainText
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.Wrap
              MouseArea { anchors.fill: parent }
            }
            Row {
              width: parent.width
              spacing: Style.space(8)
              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(8)
                height: width
                radius: width / 2
                color: calendarPalette.colorFor(calendarOption.modelData.source.colorKey)
              }
              Text {
                width: parent.width - Style.space(40)
                text: String(calendarOption.modelData.source.name || calendarOption.modelData.source.id)
                textFormat: Text.PlainText
                elide: Text.ElideMiddle
                color: root.textColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.body
              }
              Text {
                text: root.selectedSourceId === String(calendarOption.modelData.source.id) ? "✓" : ""
                textFormat: Text.PlainText
                color: root.textColor
                font.family: root.panelFontFamily
              }
            }
          }
          background: Rectangle {
            color: calendarOption.highlighted ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent"
            radius: Style.cornerRadius
          }
        }
        popup: QQC.Popup {
          width: calendarSelector.width
          padding: Style.space(6)
          implicitHeight: Math.min(calendarOptions.contentHeight + padding * 2, Style.space(320))
          function place() {
            var window = calendarSelector.Window.window
            if (!window) return
            var point = calendarSelector.mapToItem(window.contentItem, 0, 0)
            var top = point.y + calendarSelector.height
            if (top + height > window.height) top = point.y - height
            y = Math.max(0, Math.min(top, window.height - height)) - point.y
            x = Math.max(0, Math.min(point.x, window.width - width)) - point.x
          }
          onOpened: place()
          onHeightChanged: if (opened) place()
          contentItem: ListView {
            id: calendarOptions
            clip: true
            model: calendarSelector.popup.visible ? calendarSelector.delegateModel : null
            currentIndex: calendarSelector.highlightedIndex
            boundsBehavior: Flickable.StopAtBounds
            QQC.ScrollBar.vertical: QQC.ScrollBar {}
          }
          background: Rectangle {
            color: root.backgroundColor
            border.width: Style.normalBorderWidth
            border.color: Style.normalBorderFor(root.textColor, root.accentColor)
            radius: Style.cornerRadius
          }
        }
      }

      FieldLabel { text: "Title" }
      EditorField {
        id: titleField
        objectName: "event-title-field"
        width: parent.width
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        placeholderText: "Event title"
        Accessible.name: "Event title"
      }

      Column {
        width: parent.width
        spacing: Style.space(6)
        FieldLabel { text: "Description" }
        EditorField {
          id: notesField
          objectName: "event-description-field"
          width: parent.width
          foreground: root.textColor
          accent: root.accentColor
          font.family: root.panelFontFamily
          placeholderText: "Add event details"
          Accessible.name: "Description"
        }
      }

      IconTextButton {
        visible: root.editing && !!root.editingEvent.recurringEventId
          && root.googleWrites
        text: root.loadingSeries ? "Loading series" : "Edit entire series..."
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        enabled: !root.loadingSeries && !root.writePending
        onClicked: root.editSeries()
      }

      IconTextButton {
        text: root.allDay ? "✓ All day" : "All day"
        selected: root.allDay
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        onClicked: root.allDay = !root.allDay
      }

      // Labelled above like every other field, so the form has one left edge.
      FieldLabel { text: "Starts" }
      Row {
        width: parent.width
        spacing: Style.space(8)
        EditorField {
          id: dateField
          objectName: "event-start-date-field"
          width: parent.width - (startField.visible ? startField.width + parent.spacing : 0)
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: root.editingAllDay ? "First day (YYYY-MM-DD)" : "YYYY-MM-DD"
        }

        EditorField {
          id: startField
          objectName: "event-start-time-field"
          visible: !root.editingAllDay
          width: Style.space(120)
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "Start"
        }
      }
      FieldLabel { text: root.allDay ? "Last day" : "Ends" }
      Row {
        width: parent.width
        spacing: Style.space(8)
        EditorField {
          id: endDateField
          objectName: "event-end-date-field"
          width: parent.width - (endField.visible ? endField.width + parent.spacing : 0)
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "YYYY-MM-DD"
        }
        EditorField {
          id: endField
          objectName: "event-end-time-field"
          visible: !root.editingAllDay
          width: Style.space(120)
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "End"
        }
      }

      Text {
        objectName: "event-date-range-error"
        width: parent.width
        visible: !root.dateRange.ok
        text: root.dateRange.error
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.urgentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Text {
        visible: !root.allDay && root.dateRange.ok
        text: "Times shown in " + Qt.formatDateTime(new Date(root.dateRange.startMs || Date.now()), "t") + " (local time)"
        textFormat: Text.PlainText
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      FieldLabel { text: "Location or meeting link" }
      EditorField {
        id: locationField
        objectName: "event-location-field"
        width: parent.width
        foreground: root.textColor
        font.family: root.panelFontFamily
        placeholderText: "Room, address or link"
        Accessible.name: "Location or meeting link"
      }

      IconTextButton {
        objectName: "event-add-meet"
        visible: root.googleWrites && root.chosenSource.canCreateMeet === true
          && !(root.editingEvent && root.editingEvent.conferenceData)
        text: root.createMeet ? "✓ Add Google Meet" : "Add Google Meet"
        selected: root.createMeet
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        onClicked: root.createMeet = !root.createMeet
      }

      Column {
        width: parent.width
        spacing: Style.space(6)
        visible: root.googleWrites
        FieldLabel { text: "Guests"; visible: guestsField.visible }
        EditorField {
          id: guestsField
          objectName: "event-guests-field"
          width: parent.width
          visible: !root.editing || (!!root.editingEvent.organizer && root.editingEvent.organizer.self === true)
          placeholderText: "Guest email addresses, separated by commas"
          foreground: root.textColor
          accent: root.accentColor
          font.family: root.panelFontFamily
          Accessible.name: "Guest email addresses"
          onTextChanged: root.guestSuggestionsDismissed = false
          onActiveFocusChanged: {
            root.guestSuggestionsDismissed = false
            if (activeFocus) Qt.callLater(root.revealField, guestsField)
          }
        }
        RecipientSuggestions {
          id: guestSuggestionsList
          onHeightChanged: if (root.guestSuggestionsOpen) Qt.callLater(root.revealField, guestsField)
          onYChanged: if (root.guestSuggestionsOpen) Qt.callLater(root.revealField, guestsField)
          objectName: "event-guest-suggestions"
          width: parent.width
          contacts: root.guestSuggestions
          textColor: root.textColor
          dimColor: root.dimColor
          accentColor: root.accentColor
          popupBackgroundColor: root.backgroundColor
          popupBorderColor: Style.normalBorderFor(root.textColor, root.accentColor)
          panelFontFamily: root.panelFontFamily
          onChosen: function(contact) { root.acceptGuest(contact) }
        }
        IconTextButton {
          objectName: "event-more-options"
          text: "More options..."
          selected: root.advancedOptionsOpen
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          onClicked: root.advancedOptionsOpen = !root.advancedOptionsOpen
        }
        Column {
          width: parent.width
          spacing: Style.space(6)
          visible: root.advancedOptionsOpen
          FieldLabel { text: "Time zone for repeating events" }
          EditorField {
            id: timeZoneField
            width: parent.width
            placeholderText: "e.g. Europe/Paris"
            foreground: root.textColor
            accent: root.accentColor
            font.family: root.panelFontFamily
            Accessible.name: "Time zone for repeating events"
          }
          Text {
            width: parent.width
            text: "Repeating events follow this time zone. Dates and times above use your computer's local time."
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
          }
          FieldLabel { text: "Availability" }
          EventOption {
            objectName: "event-availability-selector"
            value: root.availability
            model: [{value:"opaque",label:"Busy — blocks this time"},{value:"transparent",label:"Free — keeps this time available"}]
            onChosen: function(value) { root.availability = value; root.availabilityChanged = true }
          }
          FieldLabel { text: "Visibility" }
          EventOption {
            objectName: "event-visibility-selector"
            value: root.eventVisibility
            model: [{value:"default",label:"Calendar default"},{value:"public",label:"Public"},{value:"private",label:"Private"}]
            onChosen: function(value) { root.eventVisibility = value; root.visibilityChanged = true }
          }
        }
        FieldLabel { text: "Event reminders" }
        Flow {
          width: parent.width
          spacing: Style.space(6)
          Repeater {
            model: root.editing ? ["preserve", "default", "none", "custom"] : ["default", "none", "custom"]
            IconTextButton {
              required property string modelData
              text: modelData === "preserve" ? "Keep existing" : modelData === "default" ? "Calendar default"
                : modelData === "none" ? "None" : "Custom reminder"
              selected: root.reminderMode === modelData
              foreground: root.textColor
              accent: root.accentColor
              fontFamily: root.panelFontFamily
              onClicked: root.reminderMode = modelData
            }
          }
        }
        Row {
          visible: root.reminderMode === "custom"
          width: parent.width
          spacing: Style.space(8)
          EditorField {
            id: reminderField
            width: Style.space(80)
            placeholderText: "Minutes"
            foreground: root.textColor
            accent: root.accentColor
            font.family: root.panelFontFamily
            inputMethodHints: Qt.ImhDigitsOnly
            Accessible.name: "Reminder minutes before the event"
          }
          FieldLabel {
            width: parent.width - reminderField.width - parent.spacing
            anchors.verticalCenter: parent.verticalCenter
            text: "minutes before the event"
          }
        }
      }

      Column {
        width: parent.width
        spacing: Style.space(6)
        visible: (!root.editing && !!root.chosenSource && root.chosenSource.kind !== "microsoft")
          || (root.editing && !root.editingEvent.recurringEventId && root.googleWrites)
        FieldLabel { text: "Repeat" }
        EventOption {
          objectName: "event-repeat-selector"
          value: root.editing && !root.changeRecurrence ? Calendar.repeatChoice(root.editingEvent)
            : root.recurring ? root.recurrenceFrequency : "none"
          model: [{value:"none",label:"Does not repeat"},{value:"DAILY",label:"Daily"},
            {value:"WEEKLY",label:"Weekly"},{value:"MONTHLY",label:"Monthly"},{value:"YEARLY",label:"Yearly"}]
            .concat(root.editing && Calendar.repeatChoice(root.editingEvent) === "custom" ? [{value:"custom",label:"Custom schedule (edit in Google Calendar)"}] : [])
          onChosen: function(value) {
            if (root.editing && !root.changeRecurrence) root.changeRepeat()
            if (value === "custom" || (root.editing && !root.changeRecurrence)) return
            root.recurring = value !== "none"
            if (root.recurring) root.recurrenceFrequency = value
          }
        }
      }

      Column {
        width: parent.width
        visible: root.recurring && !!root.chosenSource && root.chosenSource.kind !== "microsoft" && (!root.editing || root.changeRecurrence)
        spacing: Style.space(8)

        Row {
          width: parent.width
          spacing: Style.space(8)

          Column {
            width: (parent.width - parent.spacing) * 0.5
            spacing: Style.space(4)

            Text {
              text: "Repeat every"
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }

            Row {
              width: parent.width
              spacing: Style.space(8)

              EditorField {
                id: intervalField
                width: Math.min(Style.space(96), parent.width * 0.5)
                foreground: root.textColor
                font.family: root.panelFontFamily
                inputMethodHints: Qt.ImhDigitsOnly
              }

              Text {
                anchors.verticalCenter: intervalField.verticalCenter
                text: Calendar.recurrenceIntervalUnit(
                  root.recurrenceFrequency, intervalField.text)
                color: root.textColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.body
                textFormat: Text.PlainText
              }
            }
          }

          Column {
            width: (parent.width - parent.spacing) * 0.5
            spacing: Style.space(4)

            Text {
              text: "End after (optional)"
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              textFormat: Text.PlainText
            }

            EditorField {
              id: countField
              width: parent.width
              foreground: root.textColor
              font.family: root.panelFontFamily
              placeholderText: "Occurrences"
              inputMethodHints: Qt.ImhDigitsOnly
            }
          }
        }
      }

    }
  }

  Column {
    id: editorFooter
    objectName: "event-editor-footer"
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: Style.space(18)
    width: Math.min(parent.width - Style.space(36), Style.space(620))
    spacing: Style.space(10)

    PanelSeparator { width: parent.width; foreground: root.textColor }

    Text {
      id: resultText
      objectName: "event-save-error"
      width: parent.width
      visible: text !== ""
      color: root.urgentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      textFormat: Text.PlainText
    }

    Flow {
      width: parent.width
      spacing: Style.space(6)

      IconTextButton {
        objectName: "event-save-button"
        text: {
          var busy = root.controller
            && (root.controller.creatingEvent || root.controller.eventWriting)
          if (root.editing) return busy ? "Saving" : root.guestUpdate ? "Send update" : "Save changes"
          return busy ? "Creating" : "Create event"
        }
        iconName: root.editing ? "check" : "plus"
        // The Enter action: accent edge and text, not a solid fill.
        foreground: root.accentColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        enabled: root.controller && !root.controller.creatingEvent
          && !root.controller.eventWriting && !root.loadingSeries && root.dateRange.ok
        onClicked: root.submit("all")
      }

      IconTextButton {
        visible: root.guestUpdate
        text: "Save without email"
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        enabled: !root.writePending && !root.loadingSeries && root.dateRange.ok
        onClicked: root.submit("none")
      }

      IconTextButton {
        text: "Cancel"
        bordered: false
        foreground: root.dimColor
        fontFamily: root.panelFontFamily
        onClicked: root.close()
      }
    }
  }

  Connections {
    target: root.controller
    // A completion is answered only while this form's own write is in flight:
    // one the user cancelled out of belongs to no edit, and its failure is
    // already on the view's banner.
    function onComposeRequested(prefill) { root.beginWith(prefill) }
    function onEventCreated(ok, error) {
      if (!root.writePending) return
      root.writePending = false
      if (ok) root.close()
      else resultText.text = error
    }
    function onEventUpdated(ok, error) {
      if (!root.writePending) return
      root.writePending = false
      if (ok) root.close()
      else resultText.text = error
    }
  }
}
