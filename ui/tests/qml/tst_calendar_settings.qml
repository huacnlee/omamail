import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Omamail

Item {
  width: 600
  height: 800

  QtObject {
    id: mailService

    property bool unifiedCalendarView: false
    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property int undoSendSeconds: 10
    property int settingChanges: 0
    property var accountSummaries: []
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: true
    property bool calendarRemindersEnabled: true
    property int calendarSnoozeMinutes: 5
    property string calendarReminderError: ""
    property var auth: null

    function setUnifiedCalendarView(value) {
      unifiedCalendarView = value === true
      settingChanges = settingChanges + 1
    }
  }

  QtObject {
    id: calendarController

    property var sourceList: ({ version: 1, sources: [] })
    property var availableSources: sourceList
    property bool savingSource: false
    property bool discoveringCalendars: false
    property string discoveringAccountId: ""
    property int discoverCalls: 0
    property int toggleCalls: 0
    property string toggledId: ""
    property int removeCalls: 0
    property string removedId: ""
    property int colorCalls: 0
    property string coloredId: ""
    property string selectedColor: ""
    property var discoveryChoices: null
    property string discoveryChoiceAccount: ""
    property string defaultId: ""
    property var reminderPolicy: null
    property bool caldavAvailable: true
    property bool caldavServerDiscovering: false
    property var caldavServerDiscoveryResults: []
    property bool caldavAdding: false
    property var caldavAsked: null
    property var caldavAdded: null
    property int caldavCancels: 0
    signal calendarSaved(bool ok, string error)
    signal discoveryFinished(bool ok, string error, int count)
    signal caldavServerDiscoveryFinished(bool ok, string error)
    signal caldavCalendarsAdded(bool ok, string error, int added, int total)

    function discoverCaldavServer(url, username, password) {
      caldavAsked = { url: url, username: username, password: password }
      caldavServerDiscovering = true
      return true
    }
    function canDiscoverCaldavServer() { return caldavAvailable }
    function cancelCaldavServerDiscovery() {
      caldavCancels++
      caldavServerDiscovering = false
      caldavServerDiscoveryResults = []
    }
    function addDiscoveredCaldavCalendars(urls) { caldavAdded = Array.prototype.slice.call(arguments); return true }

    function addCalDavCalendar(_source, _password) {}
    function removeCalendar(sourceId) { removeCalls++; removedId = sourceId }
    function updateCalendarPassword(_source, _password) {}
    function discoveredCount(_accountId) { return 0 }
    function discoverAccountCalendars(_accountId) { discoverCalls++; return true }
    function setSourceEnabled(sourceId, _enabled) { toggleCalls++; toggledId = sourceId }
    function setDefaultCalendar(sourceId) { defaultId = sourceId }
    function setReminderPolicy(sourceId, enabled, minutes) {
      reminderPolicy = { id: sourceId, enabled: enabled, minutes: minutes }
    }
    function setSourceColor(sourceId, colorKey) {
      colorCalls++
      coloredId = sourceId
      selectedColor = colorKey
    }
  }

  Omamail.SettingsPage {
    id: settings
    width: parent.width
    service: mailService
    calendarController: calendarController
    textColor: Color.foreground
    dimColor: Color.foreground
    accentColor: Color.accent
    urgentColor: Color.accent
    panelFontFamily: "monospace"
  }

  SignalSpy { id: signInSpy; target: settings; signalName: "calendarSignInRequested" }

  TestCase {
    name: "CalendarSettings"
    when: windowShown

    function init() {
      mailService.accountSummaries = []
      mailService.backendCanDiscoverCalendars = true
      calendarController.sourceList = ({ version: 1, sources: [] })
      calendarController.discoverCalls = 0
      calendarController.toggleCalls = 0
      calendarController.toggledId = ""
      calendarController.removeCalls = 0
      calendarController.removedId = ""
      calendarController.colorCalls = 0
      calendarController.coloredId = ""
      calendarController.selectedColor = ""
      calendarController.defaultId = ""
      calendarController.reminderPolicy = null
      calendarController.discoveryChoices = null
      calendarController.caldavServerDiscovering = false
      calendarController.caldavServerDiscoveryResults = []
      calendarController.caldavAdding = false
      calendarController.caldavAsked = null
      calendarController.caldavAdded = null
      calendarController.caldavAvailable = true
      signInSpy.clear()
      wait(1)
    }

    function test_unified_view_switch_updates_the_persistent_setting() {
      var toggle = findChild(settings, "unifiedCalendarSwitch")
      verify(toggle !== null)
      compare(toggle.checked, false)

      toggle.toggled()
      compare(mailService.unifiedCalendarView, true)
      compare(mailService.settingChanges, 1)
      compare(toggle.checked, true)

      toggle.toggled()
      compare(mailService.unifiedCalendarView, false)
      compare(mailService.settingChanges, 2)
      compare(toggle.checked, false)
    }

    function test_existing_icloud_account_is_discovered_and_selected_in_calendars() {
      mailService.accountSummaries = [{ id: "imap:person@icloud.com",
        email: "person@icloud.com", provider: "imap", calendarProvider: "icloud",
        signedIn: true }]
      calendarController.sourceList = ({ version: 1, sources: [{
        id: "icloud:one", kind: "icloud", name: "Personal",
        accountId: "imap:person@icloud.com", enabled: true, discovered: true,
        colorKey: "accent"
      }] })
      wait(1)
      var discover = findChild(settings, "calendar-discover-icloud")
      verify(discover !== null)
      // The account already lists a calendar, so the action refreshes it.
      compare(discover.text, "Refresh calendars")
      verify(discover.activeFocusOnTab, "discovery must be reachable with Tab")
      discover.forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(calendarController.discoverCalls, 1)
      // A switch like every other setting on the page; keyboard reach is the
      // switch's own, covered where the real control exists.
      var toggle = findChild(settings, "calendar-source-toggle")
      verify(toggle !== null)
      compare(toggle.checked, true)
      toggle.toggled()
      compare(calendarController.toggleCalls, 1)
      compare(calendarController.toggledId, "icloud:one")

      var colorButton = findChild(settings, "calendar-source-color")
      verify(colorButton !== null)
      var picker = findChild(settings, "calendar-color-picker")
      verify(picker !== null)
      compare(picker.visible, false)
      verify(colorButton.activeFocusOnTab, "the color trigger must be reachable with Tab")
      colorButton.forceActiveFocus()
      keyClick(Qt.Key_Return)
      compare(picker.visible, true)
      var blue = findChild(settings, "calendar-color-blue")
      verify(blue !== null)
      verify(blue.activeFocusOnTab, "palette choices must be reachable with Tab")
      blue.forceActiveFocus()
      keyClick(Qt.Key_Space)
      compare(calendarController.colorCalls, 1)
      compare(calendarController.coloredId, "icloud:one")
      compare(calendarController.selectedColor, "blue")
      compare(picker.visible, false)
    }
    // Removing a mailbox leaves the calendars discovered through it in the
    // settings file with nothing to sign in as. They can be removed here;
    // a calendar whose mailbox is still present is refreshed, not removed.
    function test_a_calendar_whose_mailbox_is_gone_can_be_removed() {
      mailService.accountSummaries = [{ id: "imap:person@icloud.com",
        email: "person@icloud.com", provider: "imap", calendarProvider: "icloud",
        signedIn: true }]
      calendarController.sourceList = ({ version: 1, sources: [{
        id: "icloud:kept", kind: "icloud", name: "Personal",
        accountId: "imap:person@icloud.com", enabled: true, discovered: true,
        colorKey: "accent"
      }, {
        id: "icloud:orphan", kind: "icloud", name: "Old",
        accountId: "imap:gone@icloud.com", enabled: true, discovered: true,
        colorKey: "accent"
      }] })
      wait(1)
      var removes = []
      var details = []
      function collect(item) {
        if (!item) return
        if (item.objectName === "calendar-source-remove") removes.push(item)
        if (item.objectName === "calendar-source-detail") details.push(item)
        for (var i = 0; i < item.children.length; i++) collect(item.children[i])
      }
      collect(settings)
      compare(removes.length, 2)
      compare(removes[0].visible, false, "a calendar with its mailbox is not removable")
      compare(removes[1].visible, true, "a calendar without its mailbox is")
      compare(details.length, 2)
      // Listed under its mailbox's row, which already names provider and
      // address; the orphan is listed on its own and says why.
      compare(details[0].text, "")
      compare(details[1].text, "iCloud · Mailbox removed")
      removes[1].clicked()
      compare(calendarController.removeCalls, 1)
      compare(calendarController.removedId, "icloud:orphan")
    }

    function test_old_backend_does_not_offer_discovery() {
      mailService.accountSummaries = [{ id: "imap:person@icloud.com",
        email: "person@icloud.com", calendarProvider: "icloud", signedIn: true }]
      mailService.backendCanDiscoverCalendars = false
      wait(1)
      compare(findChild(settings, "calendar-discover-icloud"), null)
      compare(calendarController.discoverCalls, 0)
    }

    function test_google_setup_failure_keeps_calendars_and_offers_retry() {
      mailService.accountSummaries = [{ id: "person@example.org", email: "person@example.org",
        provider: "gmail", calendarProvider: "google", signedIn: true }]
      calendarController.sourceList = ({ version: 1, sources: [{ id: "personal", kind: "google",
        accountId: "person@example.org", name: "Personal", enabled: true, readOnly: false,
        remindersEnabled: true, reminderMinutes: -1, preferred: true }] })
      wait(1)
      var discover = findChild(settings, "calendar-discover-google")
      compare(discover.text, "Refresh calendars...")
      discover.clicked()
      compare(calendarController.discoverCalls, 1)
      calendarController.discoveryFinished(false, "Sign in to this mailbox again", 0)
      var recovery = findChild(settings, "calendar-setup-recovery")
      compare(recovery.visible, true)
      compare(calendarController.sourceList.sources.length, 1)
      calendarController.discoveryFinished(true, "", 1)
      compare(recovery.visible, false)
      compare(findChild(settings, "calendar-open-after-setup").visible, true)
    }

    function test_signed_out_google_account_starts_its_own_sign_in() {
      mailService.accountSummaries = [{ id: "person@example.org", email: "person@example.org",
        provider: "gmail", calendarProvider: "google", signedIn: false }]
      wait(1)
      var discover = findChild(settings, "calendar-discover-google")
      compare(discover.text, "Sign in...")
      discover.clicked()
      compare(calendarController.discoverCalls, 0)
      compare(signInSpy.count, 1)
      compare(signInSpy.signalArguments[0][0], 0)
    }

    function test_reminders_are_independent_of_visibility_and_default_excludes_readonly() {
      mailService.accountSummaries = [{ id: "person@example.org", email: "person@example.org",
        provider: "gmail", calendarProvider: "google", signedIn: true }]
      calendarController.sourceList = ({ version: 1, sources: [
        { id: "personal", kind: "google", accountId: "person@example.org", name: "Personal",
          enabled: false, readOnly: false, remindersEnabled: true, reminderMinutes: -1, preferred: true },
        { id: "holidays", kind: "google", accountId: "person@example.org", name: "Holidays",
          enabled: true, readOnly: true, remindersEnabled: false, reminderMinutes: -1 }
      ] })
      wait(1)
      // One writable calendar is no choice: no default row is drawn for it.
      compare(findChild(settings, "calendar-default-picker"), null)
      calendarController.sourceList = ({ version: 1, sources: calendarController.sourceList.sources.concat([
        { id: "work", kind: "google", accountId: "person@example.org", name: "Work",
          enabled: true, readOnly: false, remindersEnabled: false, reminderMinutes: -1 }]) })
      wait(1)
      var picker = findChild(settings, "calendar-default-picker")
      compare(picker.options.length, 2, "the read-only calendar is not offered")
      compare(picker.value, "personal")
      picker.changed("work")
      compare(calendarController.defaultId, "work")
      var mode = findChild(settings, "calendar-reminder-mode")
      verify(mode !== null, "reminder timing is a visible setting, not a disclosure")
      mode.changed("custom")
      compare(calendarController.reminderPolicy.minutes, 10)
      compare(calendarController.reminderPolicy.enabled, true)
      compare(calendarController.toggleCalls, 0)
      mode.changed("off")
      compare(calendarController.reminderPolicy.enabled, false)
      compare(calendarController.toggleCalls, 0)
    }

    function openCaldavWizard() {
      // Each case starts from a closed wizard, whatever the last one left.
      var cancel = findChild(settings, "calendar-caldav-find")
      if (cancel && cancel.visible) findChild(settings, "calendar-caldav-password").text = ""
      var open = findChild(settings, "calendar-caldav-discover")
      verify(open !== null)
      if (open.visible) open.clicked()
      findChild(settings, "calendar-caldav-url").text = "https://caldav.example"
      findChild(settings, "calendar-caldav-username").text = "me@example.org"
      findChild(settings, "calendar-caldav-password").text = "first"
      wait(1)
    }

    function allNamed(item, name, out) {
      if (item.objectName === name) out.push(item)
      var children = item.children || []
      for (var i = 0; i < children.length; i++) allNamed(children[i], name, out)
      return out
    }

    function test_caldav_discovery_is_offered_only_by_a_backend_that_has_it() {
      calendarController.caldavAvailable = false
      wait(1)
      compare(findChild(settings, "calendar-caldav-discover").visible, false)
    }

    function test_caldav_form_cannot_be_retyped_while_it_is_looked_up() {
      openCaldavWizard()
      findChild(settings, "calendar-caldav-find").clicked()
      compare(JSON.stringify(calendarController.caldavAsked), JSON.stringify({
        url: "https://caldav.example", username: "me@example.org", password: "first" }))
      var fields = ["calendar-caldav-url", "calendar-caldav-username", "calendar-caldav-password"]
      for (var i = 0; i < fields.length; i++)
        compare(findChild(settings, fields[i]).readOnly, true, fields[i] + " is frozen while finding")
      findChild(settings, "calendar-caldav-find").parent.children[1].clicked()
    }

    function test_cancelling_caldav_discovery_tells_the_controller_and_forgets_the_password() {
      openCaldavWizard()
      findChild(settings, "calendar-caldav-find").clicked()
      var before = calendarController.caldavCancels
      // Cancel sits beside Find calendars.
      findChild(settings, "calendar-caldav-find").parent.children[1].clicked()
      compare(calendarController.caldavCancels, before + 1)
      compare(calendarController.caldavServerDiscovering, false)
      compare(findChild(settings, "calendar-caldav-password").text, "")
      compare(findChild(settings, "calendar-caldav-discover").visible, true, "the wizard is closed")
    }

    function test_discovered_caldav_names_are_plain_text_and_added_by_address_only() {
      openCaldavWizard()
      findChild(settings, "calendar-caldav-find").clicked()
      calendarController.caldavServerDiscovering = false
      calendarController.caldavServerDiscoveryResults = [
        { name: "<b>Home</b><img src=\"http://127.0.0.1:9/x\">", url: "https://caldav.example/home/", readOnly: false },
        { name: "Shared", url: "https://caldav.example/shared/", readOnly: true }
      ]
      calendarController.caldavServerDiscoveryFinished(true, "")
      wait(1)
      var names = allNamed(settings, "calendar-caldav-discovered-name", [])
      compare(names.length, 2)
      compare(names[0].text, "<b>Home</b><img src=\"http://127.0.0.1:9/x\">",
        "the server's name reaches the row unchanged")
      for (var i = 0; i < names.length; i++)
        compare(names[i].textFormat, Text.PlainText, "a calendar name is never HTML")

      // Typing over the form after the answer changes nothing that is saved:
      // the page hands the controller addresses, not credentials.
      findChild(settings, "calendar-caldav-password").text = "something else"
      findChild(settings, "calendar-caldav-discovered-0").clicked()
      findChild(settings, "calendar-caldav-add").clicked()
      compare(calendarController.caldavAdded.length, 1, "no credentials cross from the form")
      compare(JSON.stringify(calendarController.caldavAdded[0]),
        JSON.stringify(["https://caldav.example/shared/"]))
      findChild(settings, "calendar-caldav-add").parent.children[1].clicked()
    }
  }
}
