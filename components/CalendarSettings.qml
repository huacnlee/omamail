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
