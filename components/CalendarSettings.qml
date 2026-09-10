import QtQuick
import qs.Commons
import qs.Ui

Column {
  id: root

  required property var service
  required property var controller
  required property color textColor
  required property color dimColor
  required property color accentColor
  required property color urgentColor
  required property string panelFontFamily
  property bool adding: false
  property string passwordEditingId: ""

  // Every calendar the app offers, not only the ones written to disk. A
  // discovered Google calendar is persisted the first time it is toggled or
  // coloured, and it has to be listed before either can happen — so a list of
  // what is already on disk is a list that cannot reach a new calendar.
  readonly property var offeredSources: {
    var available = root.controller ? root.controller.availableSources : null
    if (available && Array.isArray(available.sources)) return available.sources
    var stored = root.controller ? root.controller.sourceList : null
    return stored && Array.isArray(stored.sources) ? stored.sources : []
  }

  width: parent ? parent.width : implicitWidth
  spacing: Style.space(8)

  CalendarPalette {
    id: calendarPalette
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

  Text {
    text: "CALENDARS"
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Text {
    width: parent.width
    text: "Connect a CalDAV calendar here. Google Calendar appears when you add and sign in to a Google mailbox."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
    textFormat: Text.PlainText
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(unifiedText.implicitHeight, unifiedSwitch.implicitHeight)
      + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)

    Column {
      id: unifiedText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: unifiedSwitch.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        text: "Unified calendar view"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        width: parent.width
        text: "Show calendars from every connected account instead of following the current mailbox"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
      }
    }

    ToggleSwitch {
      id: unifiedSwitch
      objectName: "unifiedCalendarSwitch"
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      checked: !!root.service && root.service.unifiedCalendarView === true
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service)
        root.service.setUnifiedCalendarView(!root.service.unifiedCalendarView)
    }
  }

  Repeater {
    model: root.offeredSources

    Item {
      id: sourceItem
      required property var modelData
      readonly property string sourceId: String(modelData.id || "")
      readonly property color sourceColor: calendarPalette.colorFor(modelData.colorKey)
      width: root.width
      implicitHeight: sourceRow.height + Style.space(6) + swatchRow.implicitHeight
        + (passwordRow.visible ? passwordRow.implicitHeight + Style.space(6) : 0)

      Item {
        id: sourceRow
        width: parent.width
        height: Math.max(sourceText.implicitHeight, sourceActions.implicitHeight)

      Rectangle {
        id: colorDot
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(10)
        height: width
        radius: width / 2
        color: sourceItem.sourceColor
      }

      Column {
        id: sourceText
        anchors.left: colorDot.right
        anchors.leftMargin: Style.space(8)
        anchors.right: sourceActions.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          width: parent.width
          text: String(sourceItem.modelData.name || sourceItem.modelData.id || "Calendar")
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }
        Text {
          width: parent.width
          text: sourceItem.modelData.kind === "google"
            ? "Google Calendar" : String(sourceItem.modelData.url || "CalDAV")
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
        }
      }

      Row {
        id: sourceActions
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)
        IconTextButton {
          visible: sourceItem.modelData.kind === "caldav"
          text: "Set password"
          bordered: false
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.passwordEditingId = sourceItem.sourceId
        }
        IconTextButton {
          visible: sourceItem.modelData.kind !== "google"
          text: "Remove"
          bordered: false
          foreground: root.urgentColor
          fontFamily: root.panelFontFamily
          onClicked: root.controller.removeCalendar(sourceItem.sourceId)
        }
      }
      }

      // The palette a calendar can wear, as the colours themselves. A name
      // ("cyan") is not what you are choosing between when four calendars are
      // drawn over one another in a week; the swatch is.
      Row {
        id: swatchRow
        anchors.top: sourceRow.bottom
        anchors.topMargin: Style.space(6)
        anchors.left: parent.left
        anchors.leftMargin: Style.space(18)
        spacing: Style.space(6)

        Repeater {
          model: calendarPalette.slots

          Rectangle {
            id: swatch
            required property string modelData
            readonly property bool current: modelData === String(sourceItem.modelData.colorKey || "")

            objectName: "calendarColor:" + sourceItem.sourceId + ":" + modelData
            width: Style.space(14)
            height: width
            radius: width / 2
            color: calendarPalette.colorFor(swatch.modelData)
            // The chosen one wears a ring rather than only being brighter: a
            // theme can put two palette slots close together, and "which of
            // these seven am I on" is the whole question this row answers.
            border.width: swatch.current ? 2 : 0
            border.color: root.textColor
            opacity: swatch.current || swatchHover.containsMouse ? 1 : 0.6

            function choose() {
              if (root.controller && typeof root.controller.setSourceColor === "function")
                root.controller.setSourceColor(sourceItem.sourceId, swatch.modelData)
            }

            MouseArea {
              id: swatchHover
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: swatch.choose()
            }
          }
        }
      }

      Row {
        id: passwordRow
        anchors.top: swatchRow.bottom
        anchors.topMargin: visible ? Style.space(6) : 0
        width: parent.width
        visible: sourceItem.modelData.kind === "caldav"
          && root.passwordEditingId === sourceItem.sourceId
        spacing: Style.space(6)

        TextField {
          id: existingPassword
          width: Math.max(80, parent.width - saveExisting.implicitWidth
            - cancelExisting.implicitWidth - parent.spacing * 2)
          password: true
          foreground: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          placeholderText: "Password or app password"
          onAccepted: saveExisting.clicked()
        }
        IconTextButton {
          id: saveExisting
          text: "Save"
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          enabled: existingPassword.text !== "" && !root.controller.savingSource
          onClicked: root.controller.updateCalendarPassword(sourceItem.modelData, existingPassword.text)
        }
        IconTextButton {
          id: cancelExisting
          text: "Cancel"
          bordered: false
          foreground: root.dimColor
          fontFamily: root.panelFontFamily
          onClicked: root.passwordEditingId = ""
        }
      }
    }
  }

  IconTextButton {
    visible: !root.adding
    iconName: "plus"
    text: "Add a calendar"
    foreground: root.textColor
    fontFamily: root.panelFontFamily
    onClicked: root.adding = true
  }

  Column {
    width: parent.width
    visible: root.adding
    spacing: Style.space(6)

    TextField {
      id: calendarName
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Calendar name"
    }
    TextField {
      id: calendarUrl
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "CalDAV URL"
    }
    TextField {
      id: calendarUsername
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Username"
    }
    TextField {
      id: calendarPassword
      width: parent.width
      password: true
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Password or app password"
      onAccepted: root.saveCalendar()
    }

    Row {
      spacing: Style.space(6)
      IconTextButton {
        text: root.controller && root.controller.savingSource ? "Adding" : "Add calendar"
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        enabled: root.controller && !root.controller.savingSource
        onClicked: root.saveCalendar()
      }
      IconTextButton {
        text: "Cancel"
        bordered: false
        foreground: root.dimColor
        fontFamily: root.panelFontFamily
        onClicked: root.adding = false
      }
    }
  }

  Text {
    id: resultText
    width: parent.width
    visible: text !== ""
    color: text === "Calendar saved" ? root.dimColor : root.urgentColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
    textFormat: Text.PlainText
  }

  function saveCalendar() {
    resultText.text = ""
    root.controller.addCalDavCalendar({
      name: calendarName.text,
      url: calendarUrl.text,
      username: calendarUsername.text
    }, calendarPassword.text)
  }

  Connections {
    target: root.controller
    function onCalendarSaved(ok, error) {
      if (!ok) { resultText.text = error; return }
      resultText.text = "Calendar saved"
      calendarName.text = ""
      calendarUrl.text = ""
      calendarUsername.text = ""
      calendarPassword.text = ""
      root.adding = false
      root.passwordEditingId = ""
    }
  }
}
