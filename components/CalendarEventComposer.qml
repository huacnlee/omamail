import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../calendar/Calendar.js" as Calendar

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
  property string recurrenceFrequency: "WEEKLY"
  // Set while an existing event is being changed rather than a new one made.
  // The calendar picker and the recurrence section stand down then: the event
  // stays on the calendar that owns it, and the rule is the server's to keep.
  property var editingEvent: null
  property string editingSourceId: ""
  readonly property bool editing: editingEvent !== null
  // Set when this form's own write is in flight. A completion is answered only
  // while it is: a write the user cancelled out of — Escape, then a newer
  // edit — must not close or report into this one.
  property bool writePending: false
  // An all-day event is edited as the dates it spans; the time fields stand
  // down, because writing them back would turn the event into a timed one.
  readonly property bool editingAllDay: editing
    && !!(editingEvent.start && editingEvent.start.allDay)
  color: root.backgroundColor

  function localDate(date) {
    function two(value) { return value < 10 ? "0" + value : String(value) }
    return date.getFullYear() + "-" + two(date.getMonth() + 1) + "-" + two(date.getDate())
  }

  function localTime(date) {
    var hour = date.getHours(), minute = date.getMinutes()
    return (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") + minute
  }

  function beginAt(startMs) {
    var requested = Number(startMs)
    var start = isFinite(requested) && requested > 0
      ? new Date(requested) : new Date(Date.now() + 3600000)
    if (!(isFinite(requested) && requested > 0))
      start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0)
    var end = new Date(start.getTime() + 3600000)
    editingEvent = null
    editingSourceId = ""
    writePending = false
    titleField.text = ""
    dateField.text = localDate(start)
    startField.text = localTime(start)
    endField.text = localTime(end)
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
        if (groups[i].calendars && groups[i].calendars.length)
          return String(groups[i].calendars[0].id)
      }
    }
    return String(groups[0].calendars[0].id)
  }

  function beginEdit(sourceId, event) {
    if (!event || !event.start) return
    var start = new Date(Number(event.start.ms))
    var end = event.end ? new Date(Number(event.end.ms)) : new Date(start.getTime() + 3600000)
    editingEvent = event
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

  function close() {
    opened = false
    editingEvent = null
    editingSourceId = ""
  }
  function takeFocus() { titleField.forceActiveFocus() }

  function submit() {
    if (!controller) return
    // Create, update and delete share one controller write slot. Do not mark
    // this form pending unless that slot is free: otherwise an older write's
    // completion could be mistaken for this form's and close it.
    if (controller.creatingEvent || controller.eventWriting) return
    var start = new Date(dateField.text + "T" + startField.text + ":00")
    var end = new Date(dateField.text + "T" + endField.text + ":00")
    if (editingAllDay) {
      start = new Date(dateField.text + "T00:00:00")
      var lastDay = new Date(endDateField.text + "T00:00:00")
      // The written end is exclusive: the midnight after the last shown day,
      // reached by date fields so a daylight-saving boundary cannot shift it.
      end = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1)
    }
    var fields = {
      title: titleField.text,
      startMs: start.getTime(),
      endMs: end.getTime(),
      location: locationField.text,
      description: notesField.text,
      recurrence: {
        enabled: recurring,
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
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  Flickable {
    anchors.fill: parent
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
        text: root.editingAllDay ? "Edit event · All day"
          : root.editing ? "Edit event" : "Create event"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        textFormat: Text.PlainText
      }

      Text {
        visible: !root.editing
        text: "CALENDAR"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
        textFormat: Text.PlainText
      }

      Repeater {
        model: root.editing ? [] : (root.controller ? root.controller.writableSourceGroups : [])

        delegate: Column {
          id: sourceGroup
          required property var modelData
          width: form.width
          spacing: Style.space(4)

          Text {
            width: parent.width
            text: sourceGroup.modelData.providerLabel + " · "
              + sourceGroup.modelData.accountLabel
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideMiddle
            textFormat: Text.PlainText
          }

          Flow {
            width: parent.width
            height: childrenRect.height
            spacing: Style.space(5)

            Repeater {
              model: sourceGroup.modelData.calendars

              IconTextButton {
                required property var modelData
                text: String(modelData.name || modelData.id || "Calendar")
                selected: root.selectedSourceId === String(modelData.id)
                foreground: root.textColor
                accent: calendarPalette.colorFor(modelData.colorKey)
                fontFamily: root.panelFontFamily
                onClicked: root.selectedSourceId = String(modelData.id)
              }
            }
          }
        }
      }

      TextField {
        id: titleField
        width: parent.width
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        placeholderText: "Event title"
      }

      Row {
        width: parent.width
        spacing: Style.space(8)

        TextField {
          id: dateField
          width: root.editingAllDay ? (parent.width - parent.spacing) * 0.5
            : (parent.width - parent.spacing * 2) * 0.5
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: root.editingAllDay ? "First day (YYYY-MM-DD)" : "YYYY-MM-DD"
        }

        TextField {
          id: endDateField
          visible: root.editingAllDay
          width: (parent.width - parent.spacing) * 0.5
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "Last day (YYYY-MM-DD)"
        }

        TextField {
          id: startField
          visible: !root.editingAllDay
          width: (parent.width - parent.spacing * 2) * 0.25
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "Start"
        }

        TextField {
          id: endField
          visible: !root.editingAllDay
          width: (parent.width - parent.spacing * 2) * 0.25
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "End"
        }
      }

      TextField {
        id: locationField
        width: parent.width
        foreground: root.textColor
        font.family: root.panelFontFamily
        placeholderText: "Location or meeting link"
      }

      TextField {
        id: notesField
        width: parent.width
        foreground: root.textColor
        font.family: root.panelFontFamily
        placeholderText: "Notes"
      }

      IconTextButton {
        visible: !root.editing
        text: "Make recurring"
        iconName: root.recurring ? "check" : ""
        selected: root.recurring
        foreground: root.recurring ? root.textColor : root.dimColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        onClicked: root.recurring = !root.recurring
      }

      Column {
        width: parent.width
        visible: root.recurring && !root.editing
        spacing: Style.space(8)

        Text {
          text: "REPEATS"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
          textFormat: Text.PlainText
        }

        Flow {
          width: parent.width
          height: childrenRect.height
          spacing: Style.space(5)

          Repeater {
            model: [
              { label: "Daily", value: "DAILY" },
              { label: "Weekly", value: "WEEKLY" },
              { label: "Monthly", value: "MONTHLY" },
              { label: "Yearly", value: "YEARLY" }
            ]

            IconTextButton {
              required property var modelData
              text: modelData.label
              selected: root.recurrenceFrequency === modelData.value
              foreground: selected ? root.textColor : root.dimColor
              accent: root.accentColor
              fontFamily: root.panelFontFamily
              onClicked: root.recurrenceFrequency = modelData.value
            }
          }
        }

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

              TextField {
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

            TextField {
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

      Row {
        spacing: Style.space(6)

        IconTextButton {
          text: {
            var busy = root.controller
              && (root.controller.creatingEvent || root.controller.eventWriting)
            if (root.editing) return busy ? "Saving" : "Save changes"
            return busy ? "Creating" : "Create event"
          }
          iconName: root.editing ? "check" : "plus"
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          enabled: root.controller && !root.controller.creatingEvent
            && !root.controller.eventWriting
          onClicked: root.submit()
        }

        IconTextButton {
          text: "Cancel"
          bordered: false
          foreground: root.dimColor
          fontFamily: root.panelFontFamily
          onClicked: root.close()
        }
      }

      Text {
        id: resultText
        width: parent.width
        visible: text !== ""
        color: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }
    }
  }

  Connections {
    target: root.controller
    // A completion is answered only while this form's own write is in flight:
    // one the user cancelled out of belongs to no edit, and its failure is
    // already on the view's banner.
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
