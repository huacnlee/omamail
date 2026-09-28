import QtQuick
import qs.Commons
import qs.Ui
import "../calendar/Sources.js" as Sources

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
  property string colorEditingId: ""

  function discoverableAccounts() {
    if (!root.service || root.service.backendCanDiscoverCalendars !== true) return []
    var accounts = root.service && Array.isArray(root.service.accountSummaries)
      ? root.service.accountSummaries : []
    return accounts.filter(function(account) {
      return account && account.signedIn === true
        && (account.calendarProvider === "microsoft" || account.calendarProvider === "icloud"
          || (account.calendarProvider === "google" && root.service.backendCanGoogleCalendars === true))
    })
  }

  function providerName(account) {
    return account && account.calendarProvider === "icloud" ? "iCloud"
      : account && account.calendarProvider === "google" ? "Google" : "Microsoft"
  }

  function accountLabel(source) {
    var wanted = String(source && source.accountId || "")
    var accounts = root.service && Array.isArray(root.service.accountSummaries)
      ? root.service.accountSummaries : []
    for (var i = 0; i < accounts.length; i++) {
      if (String(accounts[i] && accounts[i].id || "") === wanted)
        return String(accounts[i].email || accounts[i].label || "")
    }
    return ""
  }

  function orphaned(source) {
    return Sources.orphaned(source,
      root.service && Array.isArray(root.service.accountSummaries) ? root.service.accountSummaries : [])
  }

  // A hand-added calendar is removed here; one that came with a mailbox is
  // refreshed by discovery instead — unless the mailbox is gone, when there
  // is nothing left to refresh it and this is the only way to be rid of it.
  function removable(source) {
    var value = source || {}
    return (value.kind === "caldav" && value.discovered !== true) || root.orphaned(value)
  }

  function sourceDetail(source) {
    var value = source || {}
    if (value.kind === "caldav") return String(value.url || "CalDAV")
    var provider = value.kind === "google" ? "Google"
      : value.kind === "microsoft" ? "Microsoft" : "iCloud"
    var account = root.accountLabel(value)
    var detail = root.orphaned(value) ? provider + " · Mailbox removed"
      : account === "" ? provider + " calendar" : provider + " · " + account
    return value.readOnly === true ? detail + " · Read-only" : detail
  }

  CalendarPalette {
    id: calendarPalette
    palettePath: root.service ? String(root.service.calendarPalettePath || "") : ""
    textColor: root.textColor
    accentColor: root.accentColor
    urgentColor: root.urgentColor
    dimColor: root.dimColor
  }

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
    text: "Find Google, Microsoft and iCloud calendars from your connected mailboxes, or connect another CalDAV calendar manually. Choose visibility and desktop reminders independently."
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

  Column {
    width: parent.width
    spacing: Style.space(6)
    visible: !!root.service && root.service.backendCanGoogleCalendars === true
    Button {
      text: root.service && root.service.calendarRemindersEnabled ? "✓ Desktop reminders" : "Desktop reminders off"
      selected: !!root.service && root.service.calendarRemindersEnabled === true
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      onClicked: root.service.persistSetting("calendarRemindersEnabled", !root.service.calendarRemindersEnabled)
    }
    Text {
      width: parent.width
      visible: text !== ""
      text: String(root.service && root.service.calendarReminderError || "")
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.urgentColor
      font.family: root.panelFontFamily
    }
    Text {
      width: parent.width
      text: "Reminders run while Omamail is running, even with its window closed. Per-calendar minutes are before the event starts. Leave them blank to follow Google popup reminders; explicit event settings with no reminders stay silent."
      textFormat: Text.PlainText
      wrapMode: Text.Wrap
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }
    Row {
      spacing: Style.space(8)
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "Snooze (minutes)"
        textFormat: Text.PlainText
        color: root.textColor
        font.family: root.panelFontFamily
      }
      TextField {
        width: Style.space(80)
        text: String(root.service ? root.service.calendarSnoozeMinutes : 5)
        placeholderText: "5"
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        Accessible.name: "Snooze minutes"
        onEditingFinished: if (/^[0-9]+$/.test(text) && Number(text) >= 1 && Number(text) <= 1440)
          root.service.persistSetting("calendarSnoozeMinutes", Number(text))
      }
    }
    Repeater {
      model: root.controller && root.controller.availableSources ? root.controller.availableSources.sources : []
      delegate: Row {
        id: reminderRow
        required property var modelData
        width: parent.width
        spacing: Style.space(6)
        Text {
          width: Math.max(0, parent.width - reminderToggle.implicitWidth - reminderMinutes.width - parent.spacing * 2)
          anchors.verticalCenter: parent.verticalCenter
          text: String(reminderRow.modelData.name || reminderRow.modelData.id)
          textFormat: Text.PlainText
          elide: Text.ElideRight
          color: root.textColor
          font.family: root.panelFontFamily
        }
        Button {
          id: reminderToggle
          text: reminderRow.modelData.remindersEnabled ? "✓ Remind" : "Off"
          selected: reminderRow.modelData.remindersEnabled === true
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          enabled: !root.controller.savingSource
          onClicked: root.controller.setReminderPolicy(reminderRow.modelData.id,
            !reminderRow.modelData.remindersEnabled, reminderRow.modelData.reminderMinutes)
        }
        TextField {
          id: reminderMinutes
          width: Style.space(150)
          text: Number(reminderRow.modelData.reminderMinutes) >= 0 ? String(reminderRow.modelData.reminderMinutes) : ""
          placeholderText: reminderRow.modelData.kind === "google" ? "Google default" : "No reminders"
          foreground: root.textColor
          accent: root.accentColor
          font.family: root.panelFontFamily
          Accessible.name: "Minutes before " + String(reminderRow.modelData.name || "event")
          enabled: !root.controller.savingSource
          onEditingFinished: if (text === "" || (/^[0-9]+$/.test(text) && Number(text) <= 40320))
            root.controller.setReminderPolicy(reminderRow.modelData.id, reminderRow.modelData.remindersEnabled, text === "" ? -1 : Number(text))
        }
      }
    }
  }

  Repeater {
    model: root.discoverableAccounts()

    Rectangle {
      id: discoveryRow
      required property var modelData

      width: root.width
      implicitHeight: Math.max(discoveryText.implicitHeight, discoveryButton.implicitHeight)
        + Style.space(16)
      radius: Style.cornerRadius
      color: Style.normalFillFor(root.textColor, root.accentColor)

      Column {
        id: discoveryText
        anchors.left: parent.left
        anchors.leftMargin: Style.space(12)
        anchors.right: discoveryButton.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          width: parent.width
          text: root.providerName(discoveryRow.modelData) + " calendars"
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
        }
        Text {
          width: parent.width
          text: String(discoveryRow.modelData.email || discoveryRow.modelData.label || "")
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideMiddle
          textFormat: Text.PlainText
        }
      }

      Button {
        id: discoveryButton
        objectName: "calendar-discover-" + String(discoveryRow.modelData.calendarProvider || "account")
        focusable: true
        anchors.right: parent.right
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        bordered: true
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        fontSize: Style.font.caption
        enabled: !!root.controller && !root.controller.discoveringCalendars
          && !root.controller.savingSource
        text: root.controller && root.controller.discoveringCalendars
          && root.controller.discoveringAccountId === String(discoveryRow.modelData.id || "")
          ? "Finding..."
          : (root.controller && root.controller.discoveredCount(discoveryRow.modelData.id) > 0
             ? "Refresh calendars" : "Find calendars")
          + (discoveryRow.modelData.calendarProvider === "google" ? "..." : "")
        onClicked: {
          resultText.text = ""
          root.colorEditingId = ""
          root.passwordEditingId = ""
          if (root.controller)
            root.controller.discoverAccountCalendars(discoveryRow.modelData.id)
        }
      }
    }
  }

  Column {
    width: root.width
    visible: !!root.controller && root.controller.discoveryChoices !== null
    spacing: Style.space(8)
    Text {
      text: "Choose calendars to show"
      color: root.textColor
      font.family: root.panelFontFamily
      textFormat: Text.PlainText
    }
    Repeater {
      model: root.controller && root.controller.discoveryChoices ? root.controller.discoveryChoices.sources.filter(function(source) {
        return source.accountId === root.controller.discoveryChoiceAccount && source.kind === "google"
      }) : []
      delegate: Button {
        required property var modelData
        text: (modelData.enabled ? "✓ " : "○ ") + String(modelData.name || modelData.id)
        foreground: root.textColor
        accent: root.accentColor
        selected: modelData.enabled
        fontFamily: root.panelFontFamily
        Accessible.role: Accessible.CheckBox
        Accessible.checked: modelData.enabled
        onClicked: root.controller.chooseDiscovered(modelData.id, !modelData.enabled)
      }
    }
    Row {
      spacing: Style.space(8)
      Button {
        text: "Apply selection"
        foreground: root.textColor
        onClicked: root.controller.confirmDiscovery()
      }
      Button {
        text: "Cancel"
        foreground: root.textColor
        onClicked: root.controller.discoveryChoices = null
      }
    }
  }

  Repeater {
    model: root.controller && root.controller.availableSources
      ? root.controller.availableSources.sources : []

    Item {
      width: root.width
      implicitHeight: sourceRow.height
        + (colorRow.visible ? colorRow.implicitHeight + Style.space(6) : 0)
        + (passwordRow.visible ? passwordRow.implicitHeight + Style.space(6) : 0)

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
          objectName: "calendar-source-detail"
          width: parent.width
          text: root.sourceDetail(modelData)
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
        Button {
          id: colorButton
          objectName: "calendar-source-color"
          focusable: true
          width: Style.space(24)
          height: width
          // The switch reserves a taller cursor target than this compact
          // button. A Row top-aligns children of different heights, so bind
          // their centres explicitly instead of leaving the dot too high.
          anchors.verticalCenter: sourceToggle.verticalCenter
          horizontalPadding: 0
          verticalPadding: 0
          selected: root.colorEditingId === String(modelData.id)
          foreground: root.textColor
          accent: root.accentColor
          tooltipText: "Change calendar color"
          Accessible.name: "Change color for " + String(modelData.name || modelData.id)
          enabled: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          onClicked: {
            root.passwordEditingId = ""
            root.colorEditingId = root.colorEditingId === String(modelData.id)
              ? "" : String(modelData.id)
          }

          Rectangle {
            objectName: "calendar-source-color-swatch"
            anchors.centerIn: parent
            width: Style.space(10)
            height: width
            radius: width / 2
            color: calendarPalette.colorFor(modelData.colorKey)
          }
        }
        IconTextButton {
          visible: modelData.kind === "caldav" && modelData.discovered !== true
          text: "Set password"
          bordered: false
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          enabled: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          onClicked: {
            root.colorEditingId = ""
            root.passwordEditingId = String(modelData.id)
          }
        }
        IconTextButton {
          objectName: "calendar-source-remove"
          visible: root.removable(modelData)
          text: "Remove"
          bordered: false
          foreground: root.urgentColor
          fontFamily: root.panelFontFamily
          enabled: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          onClicked: root.controller.removeCalendar(modelData.id)
        }
        IconTextButton {
          visible: modelData.readOnly !== true
          text: modelData.preferred === true ? "✓ Default" : "Set default"
          selected: modelData.preferred === true
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          enabled: !!root.controller && !root.controller.savingSource
          onClicked: root.controller.setDefaultCalendar(modelData.id)
        }
        Button {
          id: sourceToggle
          objectName: "calendar-source-toggle"
          property bool checked: modelData.enabled !== false
          signal toggled()
          focusable: true
          horizontalPadding: 0
          verticalPadding: 0
          implicitWidth: switchGraphic.implicitWidth
          implicitHeight: switchGraphic.implicitHeight
          Accessible.role: Accessible.CheckBox
          Accessible.name: "Show " + String(modelData.name || modelData.id)
          Accessible.checked: checked
          foreground: root.textColor
          accent: root.accentColor
          enabled: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          onClicked: toggled()
          onToggled: if (root.controller)
            root.controller.setSourceEnabled(modelData.id, modelData.enabled === false)
          ToggleSwitch {
            id: switchGraphic
            anchors.centerIn: parent
            checked: sourceToggle.checked
            interactive: false
            cursorRing: true
            hasCursor: sourceToggle.hot || sourceToggle.activeFocus
            foreground: root.textColor
            accent: root.accentColor
          }
        }
      }
      }

      Row {
        id: colorRow
        objectName: "calendar-color-picker"
        anchors.top: sourceRow.bottom
        anchors.topMargin: visible ? Style.space(6) : 0
        width: parent.width
        visible: root.colorEditingId === String(modelData.id)
        spacing: Style.space(6)

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: "Color"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          textFormat: Text.PlainText
        }

        Repeater {
          model: calendarPalette.slots

          Button {
            id: paletteOption
            required property string modelData
            objectName: "calendar-color-" + modelData
            focusable: true
            width: Style.space(24)
            height: width
            horizontalPadding: 0
            verticalPadding: 0
            selected: String(modelData) === String(colorRow.modelDataForSource.colorKey || "")
            foreground: root.textColor
            accent: root.accentColor
            tooltipText: "Use " + modelData
            Accessible.name: "Use " + modelData + " for "
              + String(colorRow.modelDataForSource.name || colorRow.modelDataForSource.id)
            enabled: !!root.controller && !root.controller.savingSource
              && !root.controller.discoveringCalendars
            onClicked: {
              root.controller.setSourceColor(colorRow.modelDataForSource.id, modelData)
              root.colorEditingId = ""
            }

            Rectangle {
              anchors.centerIn: parent
              width: Style.space(14)
              height: width
              radius: width / 2
              color: "transparent"
              border.width: parent.selected ? Math.max(1, Style.normalBorderWidth) : 0
              border.color: root.textColor

              Rectangle {
                objectName: "calendar-color-swatch-" + paletteOption.modelData
                anchors.centerIn: parent
                width: Style.space(8)
                height: width
                radius: width / 2
                color: calendarPalette.colorFor(paletteOption.modelData)
              }
            }
          }
        }

        property var modelDataForSource: modelData
      }

      Row {
        id: passwordRow
        anchors.top: colorRow.visible ? colorRow.bottom : sourceRow.bottom
        anchors.topMargin: visible ? Style.space(6) : 0
        width: parent.width
        visible: modelData.kind === "caldav" && modelData.discovered !== true
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
          enabled: !!root.controller && existingPassword.text !== ""
            && !root.controller.savingSource && !root.controller.discoveringCalendars
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
    enabled: !!root.controller && !root.controller.savingSource
      && !root.controller.discoveringCalendars
    onClicked: {
      root.colorEditingId = ""
      root.passwordEditingId = ""
      root.adding = true
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
          && !root.controller.discoveringCalendars
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
    // Whether the text reports success, said by the reporter rather than
    // read back out of the words: an error can begin with anything.
    property bool ok: false
    width: parent.width
    visible: text !== ""
    color: ok ? root.dimColor : root.urgentColor
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
      resultText.ok = ok
      if (!ok) { resultText.text = error; return }
      resultText.text = "Calendar saved"
      calendarName.text = ""
      calendarUrl.text = ""
      calendarUsername.text = ""
      calendarPassword.text = ""
      root.adding = false
      root.passwordEditingId = ""
      root.colorEditingId = ""
    }
    function onDiscoveryFinished(ok, error, count) {
      resultText.ok = ok
      resultText.text = ok ? "Found " + count + (count === 1 ? " calendar" : " calendars") : error
    }
  }
}
