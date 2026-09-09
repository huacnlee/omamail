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
  property bool discovering: false
  property var discoveryResults: []
  property var discoverySelected: ({})
  property string passwordEditingId: ""

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

  Row {
    visible: !root.adding && !root.discovering
    spacing: Style.space(6)
    IconTextButton {
      iconName: "plus"
      text: "Add a calendar"
      foreground: root.textColor
      fontFamily: root.panelFontFamily
      onClicked: root.adding = true
    }
    IconTextButton {
      text: "Discover calendars..."
      bordered: false
      foreground: root.textColor
      fontFamily: root.panelFontFamily
      onClicked: root.discovering = true
    }
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

  Column {
    width: parent.width
    visible: root.discovering
    spacing: Style.space(6)

    TextField {
      id: discoveryUrl
      width: parent.width
      visible: root.discoveryResults.length === 0
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "CalDAV server address"
    }
    TextField {
      id: discoveryUsername
      width: parent.width
      visible: root.discoveryResults.length === 0
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Username"
    }
    TextField {
      id: discoveryPassword
      width: parent.width
      visible: root.discoveryResults.length === 0
      password: true
      foreground: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      placeholderText: "Password or app password"
      onAccepted: root.findCalendars()
    }

    Row {
      visible: root.discoveryResults.length === 0
      spacing: Style.space(6)
      IconTextButton {
        text: root.controller && root.controller.discovering ? "Searching" : "Find calendars"
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        enabled: root.controller && !root.controller.discovering
        onClicked: root.findCalendars()
      }
      IconTextButton {
        text: "Cancel"
        bordered: false
        foreground: root.dimColor
        fontFamily: root.panelFontFamily
        onClicked: root.cancelDiscovery()
      }
    }

    Text {
      width: parent.width
      visible: root.discoveryResults.length > 0
      text: "Found " + root.discoveryResults.length + " calendar"
        + (root.discoveryResults.length === 1 ? "" : "s") + ". Choose which to add:"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      textFormat: Text.PlainText
    }

    Column {
      width: parent.width
      visible: root.discoveryResults.length > 0
      spacing: Style.space(4)

      Repeater {
        model: root.discoveryResults

        Item {
          width: root.width
          height: Math.max(discoveredText.implicitHeight, discoveredSwitch.implicitHeight)

          Column {
            id: discoveredText
            anchors.left: parent.left
            anchors.right: discoveredSwitch.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              width: parent.width
              text: String(modelData.name || "Calendar")
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
            Text {
              width: parent.width
              text: String(modelData.url || "")
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideMiddle
            }
          }

          ToggleSwitch {
            id: discoveredSwitch
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            checked: root.discoverySelected[modelData.url] !== false
            foreground: root.textColor
            accent: root.accentColor
            onToggled: root.toggleDiscovered(modelData.url)
          }
        }
      }

      Row {
        spacing: Style.space(6)
        IconTextButton {
          text: root.controller && root.controller.savingSource ? "Adding"
            : "Add " + root.selectedDiscoveredCalendars().length + " calendar"
              + (root.selectedDiscoveredCalendars().length === 1 ? "" : "s")
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          enabled: root.controller && !root.controller.savingSource
            && root.selectedDiscoveredCalendars().length > 0
          onClicked: root.controller.addDiscoveredCalendars(
            root.selectedDiscoveredCalendars(), discoveryUsername.text, discoveryPassword.text)
        }
        IconTextButton {
          text: "Cancel"
          bordered: false
          foreground: root.dimColor
          fontFamily: root.panelFontFamily
          onClicked: root.cancelDiscovery()
        }
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

  function findCalendars() {
    resultText.text = ""
    root.discoveryResults = []
    root.discoverySelected = ({})
    root.controller.discoverCalendars(discoveryUrl.text, discoveryUsername.text, discoveryPassword.text)
  }

  function toggleDiscovered(url) {
    var next = {}
    for (var key in root.discoverySelected) next[key] = root.discoverySelected[key]
    next[url] = root.discoverySelected[url] === false
    root.discoverySelected = next
  }

  function selectedDiscoveredCalendars() {
    var out = []
    for (var i = 0; i < root.discoveryResults.length; i++) {
      var item = root.discoveryResults[i]
      if (root.discoverySelected[item.url] !== false) out.push(item)
    }
    return out
  }

  function cancelDiscovery() {
    // Stops the request itself, not only this panel's view of it — without
    // this, an abandoned search kept running and could still land on
    // whatever the panel shows next, including a search typed after it.
    if (root.controller) root.controller.cancelDiscovery()
    root.discovering = false
    root.discoveryResults = []
    root.discoverySelected = ({})
    discoveryUrl.text = ""
    discoveryUsername.text = ""
    discoveryPassword.text = ""
    resultText.text = ""
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
      root.discovering = false
      root.discoveryResults = []
      root.discoverySelected = ({})
      discoveryUrl.text = ""
      discoveryUsername.text = ""
      discoveryPassword.text = ""
    }
    function onCalendarsDiscovered(ok, error, calendars) {
      if (!ok) { resultText.text = error; return }
      resultText.text = ""
      root.discoveryResults = calendars
      root.discoverySelected = ({})
    }
  }
}
