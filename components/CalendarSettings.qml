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
  // What the last "Find calendars" turned up, and which of them are ticked.
  property var found: []
  property var chosen: ({})

  width: parent ? parent.width : implicitWidth
  spacing: Style.space(8)

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
    model: root.controller && root.controller.sourceList
      ? root.controller.sourceList.sources : []

    Item {
      width: root.width
      implicitHeight: sourceRow.height + (passwordRow.visible
        ? passwordRow.implicitHeight + Style.space(6) : 0)

      Item {
        id: sourceRow
        width: parent.width
        height: Math.max(sourceText.implicitHeight, sourceActions.implicitHeight)

      Column {
        id: sourceText
        anchors.left: parent.left
        anchors.right: sourceActions.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          width: parent.width
          text: String(modelData.name || modelData.id || "Calendar")
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }
        Text {
          width: parent.width
          text: modelData.kind === "google" ? "Google Calendar" : String(modelData.url || "CalDAV")
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
          visible: modelData.kind === "caldav"
          text: "Set password"
          bordered: false
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.passwordEditingId = String(modelData.id)
        }
        IconTextButton {
          visible: modelData.kind !== "google"
          text: "Remove"
          bordered: false
          foreground: root.urgentColor
          fontFamily: root.panelFontFamily
          onClicked: root.controller.removeCalendar(modelData.id)
        }
      }
      }

      Row {
        id: passwordRow
        anchors.top: sourceRow.bottom
        anchors.topMargin: visible ? Style.space(6) : 0
        width: parent.width
        visible: modelData.kind === "caldav"
          && root.passwordEditingId === String(modelData.id)
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
          onClicked: root.controller.updateCalendarPassword(modelData, existingPassword.text)
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
      // Used only when the address turns out to be one calendar; a list keeps
      // the server's own names.
      placeholderText: "Calendar name"
    }
    TextField {
      id: calendarUrl
      width: parent.width
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      // The server is enough; one calendar's own address works as before.
      placeholderText: "CalDAV URL"
      onTextChanged: root.found = []
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
      onAccepted: root.findCalendars()
    }

    // The calendars the address turned out to hold, each with a switch. A
    // server address is where most people start, and it holds several.
    Column {
      width: parent.width
      spacing: Style.space(4)
      visible: root.found.length > 0

      Text {
        width: parent.width
        text: root.found.length === 1 ? "One calendar found:" : root.found.length + " calendars found:"
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }

      Repeater {
        model: root.found
        delegate: Row {
          required property var modelData
          width: parent.width
          spacing: Style.space(8)

          ToggleSwitch {
            anchors.verticalCenter: parent.verticalCenter
            checked: root.chosen[modelData.url] !== false
            foreground: root.textColor
            accent: root.accentColor
            onToggled: {
              var next = {}
              for (var key in root.chosen) next[key] = root.chosen[key]
              next[modelData.url] = root.chosen[modelData.url] === false
              root.chosen = next
            }
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: String(modelData.name || "")
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }
      }
    }

    Row {
      spacing: Style.space(6)
      IconTextButton {
        objectName: "calendar-find"
        visible: root.found.length === 0
        text: root.controller && root.controller.discovering ? "Looking" : "Find calendars"
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        enabled: root.controller && !root.controller.discovering && !root.controller.savingSource
        onClicked: root.findCalendars()
      }
      IconTextButton {
        objectName: "calendar-add"
        visible: root.found.length > 0
        text: root.controller && root.controller.savingSource ? "Adding"
          : (root.chosenCount() === 1 ? "Add calendar" : "Add " + root.chosenCount() + " calendars")
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        enabled: root.controller && !root.controller.savingSource && root.chosenCount() > 0
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

  function findCalendars() {
    resultText.text = ""
    root.found = []
    root.chosen = ({})
    root.controller.discoverCalDav(calendarUrl.text, calendarUsername.text, calendarPassword.text)
  }

  function chosenCount() {
    var count = 0
    for (var i = 0; i < root.found.length; i++) {
      if (root.chosen[root.found[i].url] !== false) count++
    }
    return count
  }

  function saveCalendar() {
    resultText.text = ""
    var picked = []
    for (var i = 0; i < root.found.length; i++) {
      if (root.chosen[root.found[i].url] === false) continue
      var entry = { name: root.found[i].name, url: root.found[i].url, username: root.found[i].username }
      // A typed name wins for a single calendar; a list keeps the server's.
      if (root.found.length === 1 && String(calendarName.text || "").trim() !== "")
        entry.name = calendarName.text
      picked.push(entry)
    }
    root.controller.addCalDavCalendars(picked, calendarPassword.text)
  }

  Connections {
    target: root.controller
    function onCalendarsDiscovered(calendars, error) {
      if (error !== "") { resultText.text = error; return }
      root.found = calendars
      root.chosen = ({})
    }
    function onCalendarSaved(ok, error) {
      if (!ok) { resultText.text = error; return }
      resultText.text = "Calendar saved"
      calendarName.text = ""
      calendarUrl.text = ""
      calendarUsername.text = ""
      calendarPassword.text = ""
      root.found = []
      root.chosen = ({})
      root.adding = false
      root.passwordEditingId = ""
    }
  }
}
