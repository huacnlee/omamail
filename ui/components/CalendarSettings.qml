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

  // Calendars listed under their mailbox's row: the provider and the address
  // are on that row already, so only what sets this calendar apart is left.
  function nestedDetail(source) {
    var value = source || {}
    var parts = []
    if (value.preferred === true) parts.push("Default for new events")
    if (value.readOnly === true) parts.push("Read-only")
    return parts.join(" · ")
  }

  // Google names a mailbox's own calendar after its address, which the row
  // above already shows; beside it the calendar is simply the primary one.
  function displayName(source) {
    var value = source || {}
    var name = String(value.name || value.id || "Calendar")
    var account = root.accountLabel(value)
    return account !== "" && name.toLowerCase() === account.toLowerCase() ? "Primary" : name
  }

  function accountCalendars(accountId) {
    return root.settingsSources.filter(function(source) {
      return String(source.accountId || "") === String(accountId || "") && !root.orphaned(source)
    })
  }

  // Hand-added CalDAV calendars and ones whose mailbox is gone or cannot be
  // discovered here: nothing above lists them, so they are listed on their own.
  readonly property var otherSources: settingsSources.filter(function(source) {
    var account = String(source.accountId || "")
    return account === "" || root.orphaned(source)
      || !root.discoverableAccounts().some(function(value) { return String(value.id) === account })
  })

  // One default per account, asked only where the account has more than one
  // calendar to put a new event in.
  readonly property var defaultChoices: Sources.writableGroups(Sources.groupByAccount(
    { sources: writableSources }, service ? service.accountSummaries : []))
    .filter(function(group) { return group.calendars.length > 1 })

  readonly property var reminderSources: settingsSources.filter(function(source) {
    return Sources.nativeCalendarFeatures(source) && !root.orphaned(source)
  })

  function reminderMode(source) {
    return source.remindersEnabled !== true ? "off"
      : Number(source.reminderMinutes) >= 0 ? "custom" : "google"
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
  spacing: Style.space(16)

  // One settings row, the shape every other row on this page has: a title and
  // a caption on the left, the control that changes it on the right.
  component SettingRow: Rectangle {
    id: settingRow
    property string title: ""
    property string detail: ""
    default property alias controls: rowControls.data
    width: parent ? parent.width : 0
    implicitHeight: Math.max(settingText.implicitHeight, rowControls.implicitHeight) + Style.space(16)
    radius: Style.cornerRadius
    color: Style.normalFillFor(root.textColor, root.accentColor)
    Column {
      id: settingText
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: rowControls.left
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)
      Text {
        width: parent.width
        text: settingRow.title
        textFormat: Text.PlainText
        elide: Text.ElideMiddle
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }
      Text {
        width: parent.width
        visible: text !== ""
        text: settingRow.detail
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
    Row {
      id: rowControls
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)
    }
  }

  component SectionHeading: Text {
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  // A calendar: its colour, its name and whether it is shown. The colour and
  // password editors open beneath the row they belong to.
  component CalendarRow: Column {
    id: calendarRow
    property var source: ({})
    property string detail: ""
    width: parent ? parent.width : 0
    spacing: Style.space(2)

    Rectangle {
      width: parent.width
      implicitHeight: Math.max(calendarText.implicitHeight, calendarActions.implicitHeight) + Style.space(16)
      radius: Style.cornerRadius
      color: Style.normalFillFor(root.textColor, root.accentColor)

      Button {
        id: colorButton
        objectName: "calendar-source-color"
        focusable: true
        // The dot's left edge sits on the same line as the titles above it.
        anchors.left: parent.left
        anchors.leftMargin: Style.space(12) - (width - Style.space(10)) / 2
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(24)
        height: width
        horizontalPadding: 0
        verticalPadding: 0
        background: "transparent"
        selected: root.colorEditingId === String(calendarRow.source.id)
        foreground: root.textColor
        accent: root.accentColor
        tooltipText: "Change calendar color"
        Accessible.name: "Change color for " + String(calendarRow.source.name || calendarRow.source.id)
        enabled: !!root.controller && !root.controller.savingSource
          && !root.controller.discoveringCalendars
        onClicked: {
          root.passwordEditingId = ""
          root.colorEditingId = root.colorEditingId === String(calendarRow.source.id)
            ? "" : String(calendarRow.source.id)
        }
        Rectangle {
          objectName: "calendar-source-color-swatch"
          anchors.centerIn: parent
          width: Style.space(10)
          height: width
          radius: width / 2
          color: calendarPalette.colorFor(calendarRow.source.colorKey)
        }
      }

      Column {
        id: calendarText
        anchors.left: parent.left
        anchors.leftMargin: Style.space(30)
        anchors.right: calendarActions.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)
        Text {
          width: parent.width
          text: root.displayName(calendarRow.source)
          textFormat: Text.PlainText
          elide: Text.ElideRight
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
        }
        Text {
          objectName: "calendar-source-detail"
          width: parent.width
          visible: text !== ""
          text: calendarRow.detail
          textFormat: Text.PlainText
          elide: Text.ElideMiddle
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }
      }

      Row {
        id: calendarActions
        anchors.right: parent.right
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)
        IconTextButton {
          anchors.verticalCenter: parent.verticalCenter
          visible: calendarRow.source.kind === "caldav" && calendarRow.source.discovered !== true
          text: "Set password"
          bordered: false
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          enabled: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          onClicked: {
            root.colorEditingId = ""
            root.passwordEditingId = String(calendarRow.source.id)
          }
        }
        IconTextButton {
          objectName: "calendar-source-remove"
          anchors.verticalCenter: parent.verticalCenter
          visible: root.removable(calendarRow.source)
          text: "Remove"
          bordered: false
          foreground: root.urgentColor
          fontFamily: root.panelFontFamily
          enabled: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          onClicked: root.controller.removeCalendar(calendarRow.source.id)
        }
        ToggleSwitch {
          objectName: "calendar-source-toggle"
          anchors.verticalCenter: parent.verticalCenter
          checked: calendarRow.source.enabled !== false
          interactive: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          foreground: root.textColor
          accent: root.accentColor
          onToggled: if (root.controller)
            root.controller.setSourceEnabled(calendarRow.source.id, calendarRow.source.enabled === false)
        }
      }
    }

    Row {
      id: colorRow
      objectName: "calendar-color-picker"
      x: Style.space(12)
      visible: root.colorEditingId === String(calendarRow.source.id)
      height: visible ? implicitHeight : 0
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
          selected: String(modelData) === String(calendarRow.source.colorKey || "")
          foreground: root.textColor
          accent: root.accentColor
          tooltipText: "Use " + modelData
          Accessible.name: "Use " + modelData + " for "
            + String(calendarRow.source.name || calendarRow.source.id)
          enabled: !!root.controller && !root.controller.savingSource
            && !root.controller.discoveringCalendars
          onClicked: {
            root.controller.setSourceColor(calendarRow.source.id, modelData)
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
    }

    Row {
      id: passwordRow
      x: Style.space(12)
      width: parent.width - x
      visible: calendarRow.source.kind === "caldav" && calendarRow.source.discovered !== true
        && root.passwordEditingId === String(calendarRow.source.id)
      height: visible ? implicitHeight : 0
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
        onClicked: root.controller.updateCalendarPassword(calendarRow.source, existingPassword.text)
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

  // --------------------------------------------------------------- calendars

  Column {
    width: parent.width
    spacing: Style.space(4)
    SectionHeading { text: "CALENDARS" }
    Text {
      width: parent.width
      text: "Choose which calendars appear and their colors. New events and reminders are set below."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      textFormat: Text.PlainText
    }
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

    Column {
      id: accountBlock
      required property var modelData
      readonly property var calendars: root.accountCalendars(modelData.id)
      width: root.width
      spacing: Style.space(2)

      SettingRow {
        title: String(accountBlock.modelData.email || accountBlock.modelData.label || "")
        detail: root.providerName(accountBlock.modelData) + " · "
          + (accountBlock.modelData.signedIn !== true ? "Sign in to connect calendars"
            : accountBlock.calendars.length > 0
              ? accountBlock.calendars.length + (accountBlock.calendars.length === 1 ? " calendar" : " calendars")
              : "Uses this mailbox's sign-in")
        Button {
          id: discoveryButton
          objectName: "calendar-discover-" + String(accountBlock.modelData.calendarProvider || "account")
          focusable: true
          bordered: true
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          enabled: !!root.controller && !root.controller.discoveringCalendars
            && !root.controller.savingSource
          text: accountBlock.modelData.signedIn !== true ? "Sign in..."
            : root.controller && root.controller.discoveringCalendars
            && root.controller.discoveringAccountId === String(accountBlock.modelData.id || "")
            ? "Finding..."
            : (accountBlock.calendars.length > 0
               ? "Refresh calendars" : accountBlock.modelData.calendarProvider === "google" ? "Enable Google Calendar" : "Find calendars")
            + (accountBlock.modelData.calendarProvider === "google" ? "..." : "")
          onClicked: {
            resultText.text = ""
            root.colorEditingId = ""
            root.passwordEditingId = ""
            root.setupAccountId = String(accountBlock.modelData.id || "")
            root.setupError = ""
            root.setupComplete = false
            if (accountBlock.modelData.signedIn !== true) {
              root.accountSetupRequested(root.accountIndex(root.setupAccountId))
              return
            }
            if (root.controller)
              root.controller.discoverAccountCalendars(accountBlock.modelData.id)
          }
        }
      }

      Repeater {
        model: accountBlock.calendars
        CalendarRow {
          required property var modelData
          source: modelData
          detail: root.nestedDetail(modelData)
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
      font.pixelSize: Style.font.bodySmall
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
      delegate: SettingRow {
        required property var modelData
        title: String(modelData.name || modelData.id)
        detail: modelData.readOnly === true ? "Read-only" : ""
        ToggleSwitch {
          objectName: "calendar-discovered-toggle"
          checked: modelData.enabled === true
          foreground: root.textColor
          accent: root.accentColor
          onToggled: root.controller.chooseDiscovered(modelData.id, !modelData.enabled)
        }
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

  Column {
    width: root.width
    visible: root.otherSources.length > 0
    spacing: Style.space(2)
    Text {
      text: "Other calendars"
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      bottomPadding: Style.space(4)
    }
    Repeater {
      model: root.otherSources
      CalendarRow {
        required property var modelData
        source: modelData
        detail: root.sourceDetail(modelData)
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

  SettingRow {
    title: "Unified calendar view"
    detail: "Show every account together instead of following the current mailbox."
    ToggleSwitch {
      id: unifiedSwitch
      objectName: "unifiedCalendarSwitch"
      checked: !!root.service && root.service.unifiedCalendarView === true
      foreground: root.textColor
      accent: root.accentColor
      onToggled: if (root.service) root.service.setUnifiedCalendarView(!root.service.unifiedCalendarView)
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

  // -------------------------------------------------------------- new events

  Column {
    width: parent.width
    visible: root.defaultChoices.length > 0
    spacing: Style.space(2)
    SectionHeading { text: "NEW EVENTS"; bottomPadding: Style.space(2) }
    Repeater {
      id: defaultGroups
      model: root.defaultChoices
      SettingRow {
        id: defaultGroup
        required property var modelData
        title: "Default calendar"
        detail: defaultGroup.modelData.accountLabel
        Dropdown {
          objectName: "calendar-default-picker"
          width: Style.space(200)
          showLabel: false
          options: defaultGroup.modelData.calendars.map(function(source) {
            return { value: source.id, label: root.displayName(source) }
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
  }

  // --------------------------------------------------------------- reminders

  Column {
    width: parent.width
    spacing: Style.space(2)
    visible: !!root.service && root.service.backendCanGoogleCalendars === true
      && root.reminderSources.length > 0
    SectionHeading { text: "REMINDERS"; bottomPadding: Style.space(2) }
    SettingRow {
      title: "Desktop reminders"
      detail: "Shown while Omamail is running, even with its window closed. Google calendars only."
      ToggleSwitch {
        objectName: "calendar-reminders-enabled"
        checked: !!root.service && root.service.calendarRemindersEnabled === true
        foreground: root.textColor
        accent: root.accentColor
        onToggled: root.service.persistSetting("calendarRemindersEnabled", !root.service.calendarRemindersEnabled)
      }
    }
    SettingRow {
      visible: !!root.service && root.service.calendarRemindersEnabled === true
      title: "Snooze"
      detail: "How long Snooze puts a reminder off."
      NumberField {
        objectName: "calendar-snooze-minutes"
        label: "Minutes"
        from: 1
        to: 1440
        stepSize: 1
        value: root.service ? root.service.calendarSnoozeMinutes : 5
        foreground: root.textColor
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        fontSize: Style.font.bodySmall
        onModified: function(next) { root.service.persistSetting("calendarSnoozeMinutes", next) }
      }
    }
    Repeater {
      model: !!root.service && root.service.calendarRemindersEnabled === true ? root.reminderSources : []
      SettingRow {
        id: reminderRow
        required property var modelData
        title: root.displayName(modelData)
        detail: root.accountLabel(modelData) + (modelData.enabled === false ? " · Hidden, still reminds" : "")
        NumberField {
          objectName: "calendar-reminder-minutes"
          anchors.verticalCenter: parent.verticalCenter
          visible: root.reminderMode(reminderRow.modelData) === "custom"
          label: "Minutes before"
          from: 0
          to: 40320
          stepSize: 5
          value: Math.max(0, Number(reminderRow.modelData.reminderMinutes))
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.bodySmall
          enabled: !!root.controller && !root.controller.savingSource
          onModified: function(next) { root.controller.setReminderPolicy(reminderRow.modelData.id, true, next) }
        }
        Dropdown {
          objectName: "calendar-reminder-mode"
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(200)
          showLabel: false
          value: root.reminderMode(reminderRow.modelData)
          options: [{ value: "off", label: "Off" }, { value: "google", label: "Google event reminders" },
            { value: "custom", label: "Custom timing" }]
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          enabled: !!root.controller && !root.controller.savingSource
          onChanged: function(next) {
            root.controller.setReminderPolicy(reminderRow.modelData.id, next !== "off",
              next === "google" ? -1 : Number(reminderRow.modelData.reminderMinutes) >= 0
                ? Number(reminderRow.modelData.reminderMinutes) : 10)
          }
        }
      }
    }
    Text {
      width: parent.width
      visible: text !== ""
      topPadding: Style.space(4)
      text: String(root.service && root.service.calendarReminderError || "")
      textFormat: Text.PlainText
      wrapMode: Text.WordWrap
      color: root.urgentColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
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
