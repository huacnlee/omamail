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
    var sources = controller ? controller.availableSources.sources : []
    selectedSourceId = sources.length ? String(sources[0].id) : ""
    opened = true
    Qt.callLater(titleField.forceActiveFocus)
  }

  function begin() { beginAt(0) }

  function close() { opened = false }
  function takeFocus() { titleField.forceActiveFocus() }

  function submit() {
    if (!controller) return
    var start = new Date(dateField.text + "T" + startField.text + ":00")
    var end = new Date(dateField.text + "T" + endField.text + ":00")
    controller.createEvent(selectedSourceId, {
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
    })
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
        text: "Create event"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        textFormat: Text.PlainText
      }

      Text {
        text: "CALENDAR"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        font.letterSpacing: 1
        textFormat: Text.PlainText
      }

      Repeater {
        model: root.controller ? root.controller.sourceGroups : []

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
          width: (parent.width - parent.spacing * 2) * 0.5
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "YYYY-MM-DD"
        }

        TextField {
          id: startField
          width: (parent.width - parent.spacing * 2) * 0.25
          foreground: root.textColor
          font.family: root.panelFontFamily
          placeholderText: "Start"
        }

        TextField {
          id: endField
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
        visible: root.recurring
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
          text: root.controller && root.controller.creatingEvent ? "Creating" : "Create event"
          iconName: "plus"
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          enabled: root.controller && !root.controller.creatingEvent
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
    function onEventCreated(ok, error) {
      if (ok) root.close()
      else resultText.text = error
    }
  }
}
