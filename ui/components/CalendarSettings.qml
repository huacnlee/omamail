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
  property string reminderEditingId: ""
  property string setupAccountId: ""
  property string setupError: ""
  property bool setupComplete: false
  signal accountSetupRequested(int index)
  signal clientSetupRequested()
  signal addAccountRequested()
  signal openCalendarRequested()
  readonly property var settingsSources: {
    var groups = Sources.groupByAccount(controller ? controller.availableSources : null,
      service ? service.accountSummaries : [])
    var values = []
    for (var i = 0; i < groups.length; i++) values = values.concat(groups[i].calendars)
    return values
  }
  readonly property var writableSources: settingsSources.filter(function(source) {
    return Sources.writable(source) && !root.orphaned(source)
  })

  function accountIndex(id) {
    var accounts = root.service ? root.service.accountSummaries : []
    for (var i = 0; i < accounts.length; i++) if (accounts[i].id === id) return i
    return -1
  }

  function discoverableAccounts() {
    if (!root.service || root.service.backendCanDiscoverCalendars !== true) return []
    var accounts = root.service && Array.isArray(root.service.accountSummaries)
      ? root.service.accountSummaries : []
    return accounts.filter(function(account) {
      return account
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
    text: "Connect an account, choose your calendars, then set where new events and reminders belong."
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.WordWrap
    textFormat: Text.PlainText
  }

  Text {
    text: "Accounts"
    color: root.textColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.body
    topPadding: Style.space(12)
  }

  Text {
    width: parent.width
    visible: root.discoverableAccounts().length === 0
    text: root.service && root.service.backendCanDiscoverCalendars !== true
      ? "Update the mail backend to connect account calendars."
      : "Add a Google, Microsoft or iCloud mailbox to connect its calendars."
    textFormat: Text.PlainText
    wrapMode: Text.WordWrap
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
  }

  Button {
    visible: root.discoverableAccounts().length === 0
    text: "Add an account..."
    foreground: root.textColor
    fontFamily: root.panelFontFamily
    onClicked: root.addAccountRequested()
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
        Text {
          width: parent.width
          text: discoveryRow.modelData.signedIn !== true ? "Sign in to connect calendars"
            : root.controller && root.controller.discoveredCount(discoveryRow.modelData.id) > 0
              ? "Calendars connected · refresh to change your selection"
              : "Use this mailbox's existing sign-in to connect calendars"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
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
        text: discoveryRow.modelData.signedIn !== true ? "Sign in..."
          : root.controller && root.controller.discoveringCalendars
          && root.controller.discoveringAccountId === String(discoveryRow.modelData.id || "")
          ? "Finding..."
          : (root.controller && root.controller.discoveredCount(discoveryRow.modelData.id) > 0
             ? "Refresh calendars" : discoveryRow.modelData.calendarProvider === "google" ? "Enable Google Calendar" : "Find calendars")
          + (discoveryRow.modelData.calendarProvider === "google" ? "..." : "")
        onClicked: {
          resultText.text = ""
          root.colorEditingId = ""
          root.passwordEditingId = ""
          root.setupAccountId = String(discoveryRow.modelData.id || "")
          root.setupError = ""
          root.setupComplete = false
          if (discoveryRow.modelData.signedIn !== true) {
            root.accountSetupRequested(root.accountIndex(root.setupAccountId))
            return
          }
          if (root.controller)
            root.controller.discoverAccountCalendars(discoveryRow.modelData.id)
        }
      }
    }
  }

  Column {
    objectName: "calendar-setup-recovery"
    width: root.width
    visible: root.setupError !== ""
    spacing: Style.space(6)
    Text {
      width: parent.width
      text: root.accountLabel({ accountId: root.setupAccountId }) + ": " + root.setupError
      color: root.urgentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      textFormat: Text.PlainText
    }
    Text {
      width: parent.width
      text: "For Google, enable the Google Calendar API in the same Cloud project as your Gmail client. If access was refused, sign in again and allow calendar access. Your saved calendar choices are kept."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      textFormat: Text.PlainText
      visible: root.setupAccountId !== "" && root.discoverableAccounts().some(function(account) {
        return account.id === root.setupAccountId && account.calendarProvider === "google"
      })
    }
    Flow {
      width: parent.width
      spacing: Style.space(6)
      Button {
        text: "Check again"
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        enabled: !!root.controller && !root.controller.discoveringCalendars && !root.controller.savingSource
        onClicked: root.controller.discoverAccountCalendars(root.setupAccountId)
      }
      Button {
        text: "Sign in again..."
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        enabled: root.accountIndex(root.setupAccountId) >= 0
        onClicked: root.accountSetupRequested(root.accountIndex(root.setupAccountId))
      }
      Button {
        text: "Google Calendar API setup..."
        visible: root.setupAccountId !== "" && root.discoverableAccounts().some(function(account) {
          return account.id === root.setupAccountId && account.calendarProvider === "google"
        })
        foreground: root.textColor
        fontFamily: root.panelFontFamily
        onClicked: Qt.openUrlExternally("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com")
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
    Text {
      width: parent.width
      text: "Start with your Google selection. You can change visibility and reminders independently below. Your primary writable calendar is selected for new events by default."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
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
        text: root.controller && root.controller.savingSource ? "Saving..." : "Save calendar selection"
        foreground: root.textColor
        enabled: !!root.controller && !root.controller.savingSource
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
    model: root.settingsSources

    Item {
      id: calendarEntry
      property string groupLabel: root.accountLabel(modelData) || Sources.providerLabel(modelData.kind)
      width: root.width
      implicitHeight: groupHeading.height + sourceRow.height
        + reminderActions.height + Style.space(8)
        + (colorRow.visible ? colorRow.implicitHeight + Style.space(6) : 0)
        + (passwordRow.visible ? passwordRow.implicitHeight + Style.space(6) : 0)

      Text {
        id: groupHeading
        width: parent.width
        visible: index === 0 || String(root.settingsSources[index - 1].accountId || root.settingsSources[index - 1].kind)
          !== String(modelData.accountId || modelData.kind)
        height: visible ? implicitHeight : 0
        topPadding: Style.space(14)
        bottomPadding: Style.space(8)
        text: calendarEntry.groupLabel
        textFormat: Text.PlainText
        elide: Text.ElideMiddle
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
      }

      Item {
        id: sourceRow
        anchors.top: groupHeading.bottom
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
        Button {
          id: sourceToggle
          objectName: "calendar-source-toggle"
          property bool checked: modelData.enabled !== false
          signal toggled()
          focusable: true
          text: checked ? "✓ Show in calendar" : "Show in calendar"
          selected: checked
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
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
        }
      }
      }

      Column {
        id: reminderActions
        anchors.top: sourceRow.bottom
        width: parent.width
        spacing: Style.space(6)
        visible: Sources.nativeCalendarFeatures(modelData) && !!root.service && root.service.backendCanGoogleCalendars === true
        height: visible ? implicitHeight : 0
        Button {
          objectName: "calendar-reminder-options"
          text: "Desktop reminders: " + (modelData.remindersEnabled !== true ? "Off"
            : Number(modelData.reminderMinutes) >= 0 ? String(modelData.reminderMinutes) + " min before"
            : modelData.kind === "google" ? "Use Google event reminders" : "No custom timing") + "..."
          foreground: root.dimColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          selected: root.reminderEditingId === String(modelData.id)
          onClicked: root.reminderEditingId = selected ? "" : String(modelData.id)
        }
        Column {
          width: parent.width
          visible: root.reminderEditingId === String(modelData.id)
          spacing: Style.space(6)
          Dropdown {
            objectName: "calendar-reminder-mode"
            width: parent.width
            showLabel: false
            value: modelData.remindersEnabled !== true ? "off"
              : Number(modelData.reminderMinutes) >= 0 ? "custom" : "google"
            options: modelData.kind === "google"
              ? [{ value: "off", label: "Off" }, { value: "google", label: "Use Google event reminders" }, { value: "custom", label: "Custom timing" }]
              : [{ value: "off", label: "Off" }, { value: "custom", label: "Custom timing" }]
            foreground: root.textColor
            accent: root.accentColor
            fontFamily: root.panelFontFamily
            enabled: !!root.controller && !root.controller.savingSource
            onChanged: function(next) {
              root.controller.setReminderPolicy(modelData.id, next !== "off",
                next === "google" ? -1 : Number(modelData.reminderMinutes) >= 0 ? Number(modelData.reminderMinutes) : 10)
            }
          }
          Row {
            spacing: Style.space(8)
            visible: modelData.remindersEnabled === true && Number(modelData.reminderMinutes) >= 0
            TextField {
              objectName: "calendar-reminder-minutes"
              width: Style.space(85)
              text: String(modelData.reminderMinutes)
              foreground: root.textColor
              accent: root.accentColor
              font.family: root.panelFontFamily
              Accessible.name: "Minutes before event"
              enabled: !!root.controller && !root.controller.savingSource
              onEditingFinished: {
                if (/^[0-9]+$/.test(text) && Number(text) <= 40320)
                  root.controller.setReminderPolicy(modelData.id, true, Number(text))
                else text = String(modelData.reminderMinutes)
              }
            }
            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: "minutes before the event"
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }
      }

      Row {
        id: colorRow
        objectName: "calendar-color-picker"
        anchors.top: reminderActions.bottom
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
        anchors.top: colorRow.visible ? colorRow.bottom : reminderActions.bottom
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
    text: "Connect a CalDAV calendar..."
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

  Repeater {
    model: Sources.writableGroups(Sources.groupByAccount({ sources: root.writableSources },
      root.service ? root.service.accountSummaries : []))
    Column {
    id: defaultGroup
    required property var modelData
    width: root.width
    spacing: Style.space(8)
    Text {
      width: parent.width
      text: "Default for new events · " + defaultGroup.modelData.accountLabel
      textFormat: Text.PlainText
      elide: Text.ElideMiddle
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      topPadding: Style.space(12)
    }
    Dropdown {
      objectName: "calendar-default-picker"
      width: parent.width
      showLabel: false
      options: defaultGroup.modelData.calendars.map(function(source) {
        return { value: source.id, label: String(source.name || source.id) }
      })
      value: {
        var values = defaultGroup.modelData.calendars
        for (var i = 0; i < values.length; i++) if (values[i].preferred) return values[i].id
        return values.length ? values[0].id : ""
      }
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      enabled: !!root.controller && !root.controller.savingSource && !root.controller.discoveringCalendars
      onChanged: function(next) { root.controller.setDefaultCalendar(next) }
    }
    }
  }

  Column {
    width: parent.width
    spacing: Style.space(8)
    visible: !!root.service && root.service.backendCanGoogleCalendars === true
      && !!root.controller && !!root.controller.availableSources
      && root.controller.availableSources.sources.some(Sources.nativeCalendarFeatures)
    Text {
      text: "Google desktop reminders"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.body
      topPadding: Style.space(12)
    }
    Button {
      objectName: "calendar-reminders-enabled"
      text: root.service && root.service.calendarRemindersEnabled ? "✓ Desktop reminders on" : "Desktop reminders off"
      selected: !!root.service && root.service.calendarRemindersEnabled === true
      foreground: root.textColor
      accent: root.accentColor
      fontFamily: root.panelFontFamily
      onClicked: root.service.persistSetting("calendarRemindersEnabled", !root.service.calendarRemindersEnabled)
    }
    Text {
      width: parent.width
      text: "Reminders run while Omamail is running, even with its window closed. Choose timing under each calendar above; hiding a calendar does not turn off its reminders. Google event reminders respect events with reminders turned off."
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }
    Row {
      spacing: Style.space(8)
      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: "Snooze (minutes)"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }
      TextField {
        width: Style.space(80)
        text: String(root.service ? root.service.calendarSnoozeMinutes : 5)
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        Accessible.name: "Snooze minutes"
        onEditingFinished: {
          if (/^[0-9]+$/.test(text) && Number(text) >= 1 && Number(text) <= 1440)
            root.service.persistSetting("calendarSnoozeMinutes", Number(text))
          else text = String(root.service.calendarSnoozeMinutes)
        }
      }
    }
    Text {
      width: parent.width
      visible: text !== ""
      text: String(root.service && root.service.calendarReminderError || "")
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      color: root.urgentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
    }
  }

  Button {
    objectName: "calendar-open-after-setup"
    visible: root.setupComplete
    text: "Open calendar"
    foreground: root.textColor
    accent: root.accentColor
    fontFamily: root.panelFontFamily
    onClicked: root.openCalendarRequested()
  }

  Rectangle {
    width: parent.width
    implicitHeight: Math.max(unifiedText.implicitHeight, unifiedSwitch.implicitHeight) + Style.space(24)
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
        text: "Unified calendar view"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }
      Text {
        width: parent.width
        text: "Show every account together instead of following the current mailbox."
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
      onToggled: if (root.service) root.service.setUnifiedCalendarView(!root.service.unifiedCalendarView)
    }
  }

  Button {
    text: "Advanced Google setup..."
    foreground: root.dimColor
    fontFamily: root.panelFontFamily
    fontSize: Style.font.caption
    onClicked: root.clientSetupRequested()
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
      root.setupError = ok ? "" : error
      root.setupComplete = ok
      resultText.text = ok ? "Saved " + count + (count === 1 ? " calendar. Choose reminders below, then open your calendar." : " calendars. Choose reminders below, then open your calendar.") : ""
    }
  }
}
