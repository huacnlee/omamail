import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import qs.Commons as Commons
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
    property string sharedError: ""
    property bool sharedOpening: false
    property int sharedCalls: 0
    property string sharedAccount: ""
    property string sharedText: ""
    property int cancelCalls: 0
    property string discoveryNotice: ""
    signal calendarSaved(bool ok, string error)
    signal discoveryFinished(bool ok, string error, int count)

    function addCalDavCalendar(_source, _password) {}
    function removeCalendar(sourceId) { removeCalls++; removedId = sourceId }
    function updateCalendarPassword(_source, _password) {}
    function discoveredCount(_accountId) { return 0 }
    function discoverAccountCalendars(_accountId) { discoverCalls++; return true }
    function addSharedCalendar(accountId, text) { sharedCalls++; sharedAccount = accountId; sharedText = text; return true }
    function cancelShared() { cancelCalls++; sharedError = ""; sharedOpening = false }
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
    textColor: Commons.Color.foreground
    dimColor: Commons.Color.foreground
    accentColor: Commons.Color.accent
    urgentColor: Commons.Color.accent
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
      calendarController.sharedError = ""
      calendarController.sharedOpening = false
      calendarController.sharedCalls = 0
      calendarController.sharedAccount = ""
      calendarController.sharedText = ""
      calendarController.cancelCalls = 0
      calendarController.discoveryNotice = ""
      calendarController.savingSource = false
      calendarController.discoveringCalendars = false
      calendarController.discoveryChoices = null
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

    // An Exchange mailbox lists its calendar under its own row, like the other mailboxes, with nothing to
    // find and no hint to add a mailbox; signed out, the row offers to sign in.
    function test_an_exchange_calendar_is_listed_under_its_mailbox() {
      mailService.accountSummaries = [{ id: "exchange:alice@example.org", email: "alice@example.org",
        provider: "exchange", calendarProvider: "exchange", signedIn: true }]
      calendarController.sourceList = ({ version: 1, sources: [{ id: "exchange:exchange:alice@example.org",
        kind: "exchange", name: "alice@example.org", accountId: "exchange:alice@example.org", enabled: true,
        colorKey: "accent" }] })
      wait(1)
      var texts = []
      function collect(item) {
        if (!item) return
        if (item.visible && item.text !== undefined) texts.push(String(item.text))
        if (item.visible && item.detail !== undefined) texts.push(String(item.detail))
        for (var i = 0; i < item.children.length; i++) collect(item.children[i])
      }
      collect(settings)
      verify(texts.indexOf("Exchange · 1 calendar") >= 0, JSON.stringify(texts))
      verify(texts.indexOf("Other calendars") < 0, "nothing is left over")
      verify(!texts.some(function(text) { return text.indexOf("mailbox to connect its calendars") >= 0 }))
      // Its default calendar is there before any is found; the others are found from here.
      var find = findChild(settings, "calendar-discover-exchange")
      compare(find.visible, true)
      compare(find.text, "Find calendars")
      find.clicked()
      compare(calendarController.discoverCalls, 1)
      var summaries = JSON.parse(JSON.stringify(mailService.accountSummaries))
      summaries[0].signedIn = false
      mailService.accountSummaries = summaries
      wait(1)
      compare(findChild(settings, "calendar-discover-exchange").visible, true)
      compare(findChild(settings, "calendar-discover-exchange").text, "Sign in...")
    }

    // An Exchange mailbox's calendars are listed under it, each with what sets it apart, and only one that was
    // added by hand is removed from here.
    function exchangeSources() {
      return [
        { id: "exchange:exchange:alice@example.org", kind: "exchange", name: "alice@example.org",
          accountId: "exchange:alice@example.org", enabled: true, readOnly: false, discovered: true,
          colorKey: "accent", preferred: true, remindersEnabled: true, reminderMinutes: -1 },
        { id: "exchange:exchange:alice@example.org:" + "1".repeat(64), kind: "exchange", name: "Team",
          accountId: "exchange:alice@example.org", calendarId: "aaaaaanfuws2ljnf", enabled: true, readOnly: false,
          discovered: true, colorKey: "accent", remindersEnabled: false, reminderMinutes: -1 },
        { id: "exchange:exchange:alice@example.org:" + "2".repeat(64), kind: "exchange",
          name: "Calendar \u00b7 colleague@example.org", accountId: "exchange:alice@example.org",
          calendarId: "aaaaaanfuws2ljnf:colleague@example.org", enabled: true, readOnly: true, discovered: false,
          colorKey: "accent", remindersEnabled: false, reminderMinutes: -1 },
        { id: "exchange:exchange:alice@example.org:" + "3".repeat(64), kind: "exchange",
          name: "Calendar \u00b7 team@example.org", accountId: "exchange:alice@example.org",
          calendarId: "aaaaaanfuws2ljnf:team@example.org", enabled: true, readOnly: false, discovered: false,
          colorKey: "accent", remindersEnabled: false, reminderMinutes: -1 }
      ]
    }

    function exchangeAccount(signedIn) {
      return [{ id: "exchange:alice@example.org", email: "alice@example.org", provider: "exchange",
        calendarProvider: "exchange", signedIn: signedIn !== false }]
    }

    function collectAll(root, objectName) {
      var found = []
      function collect(item) {
        if (!item) return
        if (item.objectName === objectName) found.push(item)
        for (var i = 0; i < item.children.length; i++) collect(item.children[i])
      }
      collect(root)
      return found
    }

    function test_an_exchange_mailbox_lists_its_calendars_under_it_and_refreshes_them() {
      mailService.accountSummaries = exchangeAccount()
      calendarController.sourceList = ({ version: 1, sources: exchangeSources() })
      wait(1)
      var details = collectAll(settings, "calendar-source-detail").map(function(item) { return item.text })
      compare(details, ["Default for new events", "", "Read-only", ""], "the name says whose a calendar is, once")
      var texts = []
      function collect(item) {
        if (!item) return
        if (item.visible && item.text !== undefined) texts.push(String(item.text))
        for (var i = 0; i < item.children.length; i++) collect(item.children[i])
      }
      collect(settings)
      verify(texts.indexOf("Calendar \u00b7 colleague@example.org") >= 0, JSON.stringify(texts))
      verify(!texts.some(function(text) { return text.indexOf("Shared by") >= 0 }), "the name already says whose it is")
      var removes = collectAll(settings, "calendar-source-remove")
      compare(removes.map(function(item) { return item.visible }), [false, false, true, true],
        "only a calendar added by hand is removed from here")
      var find = findChild(settings, "calendar-discover-exchange")
      compare(find.text, "Refresh calendars")
      compare(findChild(settings, "calendar-default-picker").options.map(function(option) { return option.label }),
        ["Primary", "Team", "Calendar \u00b7 team@example.org"], "a calendar that is only read is nowhere to put an event")
      var modes = collectAll(settings, "calendar-reminder-mode").map(function(item) { return item.value })
      compare(modes, ["google", "off", "off", "off"], "only the default calendar reminds until another is turned on")
    }

    // A calendar another mailbox shares is added by the address of that mailbox: the address, a button, and the
    // sentence for a refusal. The controller does the asking.
    function test_a_shared_calendar_is_added_by_typing_the_address_of_its_mailbox() {
      mailService.accountSummaries = exchangeAccount()
      calendarController.sourceList = ({ version: 1, sources: exchangeSources() })
      wait(1)
      compare(findChild(settings, "calendar-shared-form").visible, false)
      var open = findChild(settings, "calendar-shared-open")
      compare(open.visible, true)
      compare(open.text, "Add a shared calendar...")
      open.clicked()
      compare(findChild(settings, "calendar-shared-form").visible, true)
      compare(open.visible, false)
      var add = findChild(settings, "calendar-shared-add")
      compare(add.enabled, false, "nothing to add until an address is typed")
      var field = findChild(settings, "calendar-shared-address")
      field.text = "   "
      compare(add.enabled, false)
      field.text = "Colleague@Example.org"
      compare(add.enabled, true)
      add.clicked()
      compare(calendarController.sharedCalls, 1)
      compare(calendarController.sharedAccount, "exchange:alice@example.org")
      compare(calendarController.sharedText, "Colleague@Example.org", "the controller judges it")
      // While it is opened the button says so the way discovery's does, and Cancel stops it.
      calendarController.sharedOpening = true
      compare(add.text, "Opening...")
      findChild(settings, "calendar-shared-cancel").clicked()
      compare(calendarController.cancelCalls, 1)
      compare(findChild(settings, "calendar-shared-form").visible, false)
      compare(add.text, "Add calendar")
      open.clicked()
      // Nothing is added while something else is saved or found.
      calendarController.savingSource = true
      compare(add.enabled, false)
      calendarController.savingSource = false
      calendarController.discoveringCalendars = true
      compare(add.enabled, false)
      calendarController.discoveringCalendars = false
      // Saved: the form is done.
      calendarController.discoveryFinished(true, "", 1)
      compare(findChild(settings, "calendar-shared-form").visible, false)
      compare(findChild(settings, "calendar-shared-address").text, "")
    }

    function test_a_refusal_to_add_a_shared_calendar_is_said_under_the_form_and_cancel_closes_it() {
      mailService.accountSummaries = exchangeAccount()
      wait(1)
      findChild(settings, "calendar-shared-open").clicked()
      var error = findChild(settings, "calendar-shared-error")
      compare(error.visible, false)
      calendarController.sharedError = "That calendar is not shared with you"
      compare(error.visible, true)
      compare(error.text, "That calendar is not shared with you")
      findChild(settings, "calendar-shared-address").text = "nobody@example.org"
      findChild(settings, "calendar-shared-cancel").clicked()
      compare(findChild(settings, "calendar-shared-form").visible, false)
      compare(findChild(settings, "calendar-shared-address").text, "")
      compare(calendarController.sharedError, "", "and the sentence goes with the form")
      compare(calendarController.sharedCalls, 0)
      compare(calendarController.cancelCalls, 1)
    }

    // The mailbox poll replaces the account summaries twice a cycle; the address being typed into the form, the
    // open form and the field itself survive it, whether the mailbox's state changed or not.
    function test_an_address_being_typed_survives_the_mailbox_poll() {
      mailService.accountSummaries = exchangeAccount()
      calendarController.sourceList = ({ version: 1, sources: exchangeSources() })
      wait(1)
      findChild(settings, "calendar-shared-open").clicked()
      var field = findChild(settings, "calendar-shared-address")
      field.forceActiveFocus()
      var focused = field.activeFocus
      field.text = "lin@example.test"
      var changed = exchangeAccount()
      changed[0].lastError = "The server did not answer"
      mailService.accountSummaries = changed
      wait(1)
      mailService.accountSummaries = exchangeAccount()
      wait(1)
      var after = findChild(settings, "calendar-shared-address")
      verify(after === field, "the same field, not one built again")
      compare(after.text, "lin@example.test")
      compare(after.activeFocus, focused)
      compare(findChild(settings, "calendar-shared-form").visible, true)
      // The mailbox's live state still reaches its block.
      var signedOut = exchangeAccount(false)
      mailService.accountSummaries = signedOut
      wait(1)
      compare(findChild(settings, "calendar-discover-exchange").text, "Sign in...")
    }

    // "Find calendars" cannot be pressed while a shared calendar is being opened, and looks it.
    function test_find_calendars_looks_disabled_while_it_cannot_be_pressed() {
      mailService.accountSummaries = exchangeAccount()
      wait(1)
      var find = findChild(settings, "calendar-discover-exchange")
      compare([find.enabled, find.opacity], [true, 1])
      calendarController.discoveringCalendars = true
      compare(find.enabled, false)
      verify(find.opacity < 1)
    }

    // A discovery that did not see everything says so beside what it saved.
    function test_a_partial_discovery_is_said_with_what_was_saved() {
      mailService.accountSummaries = exchangeAccount()
      calendarController.sourceList = ({ version: 1, sources: exchangeSources() })
      wait(1)
      calendarController.discoveryNotice = "The mailbox's other calendar folders could not be read, so the calendars found before are kept."
      calendarController.discoveryFinished(true, "", 1)
      var said = collectAll(settings, "calendar-result").map(function(item) { return item.text })
      compare(said, ["Found 1 calendar. "
        + "The mailbox's other calendar folders could not be read, so the calendars found before are kept."],
        "what was found, not a count of what is listed")
      calendarController.discoveryNotice = ""
      calendarController.discoveryFinished(true, "", 2)
      compare(collectAll(settings, "calendar-result")[0].text, "Saved 2 calendars. Choose reminders below, then open your calendar.")
    }

    function test_a_shared_calendar_is_added_only_to_a_signed_in_exchange_mailbox() {
      mailService.accountSummaries = exchangeAccount(false)
      wait(1)
      compare(findChild(settings, "calendar-shared-open").visible, false)
      mailService.accountSummaries = [{ id: "imap:person@icloud.com", email: "person@icloud.com",
        calendarProvider: "icloud", signedIn: true }]
      wait(1)
      var open = findChild(settings, "calendar-shared-open")
      verify(open === null || open.visible === false)
    }

    // The server's own reminders are raised like Google's, so the calendar has a reminder row that says whose
    // reminders those are.
    function test_an_exchange_calendar_has_a_reminder_row_that_names_its_own_reminders() {
      mailService.accountSummaries = [{ id: "exchange:alice@example.org", email: "alice@example.org",
        provider: "exchange", calendarProvider: "exchange", signedIn: true }]
      calendarController.sourceList = ({ version: 1, sources: [{ id: "exchange:exchange:alice@example.org",
        kind: "exchange", name: "alice@example.org", accountId: "exchange:alice@example.org", enabled: true,
        colorKey: "accent", remindersEnabled: true, reminderMinutes: -1 }] })
      wait(1)
      var mode = findChild(settings, "calendar-reminder-mode")
      verify(mode !== null)
      compare(mode.value, "google", "the server's own reminders, until a fixed timing is chosen")
      compare(mode.options.map(function(option) { return option.label }).join(),
        "Off,Exchange event reminders,Custom timing")
    }

    // An Exchange calendar whose mailbox is gone says what it was, and can be removed.
    function test_an_orphaned_exchange_calendar_is_named_as_exchange() {
      calendarController.sourceList = ({ version: 1, sources: [{ id: "exchange:exchange:gone@example.org",
        kind: "exchange", name: "gone@example.org", accountId: "exchange:gone@example.org", enabled: true,
        colorKey: "accent" }] })
      wait(1)
      var details = []
      function collect(item) {
        if (!item) return
        if (item.objectName === "calendar-source-detail") details.push(item)
        for (var i = 0; i < item.children.length; i++) collect(item.children[i])
      }
      collect(settings)
      compare(details.length, 1)
      compare(details[0].text, "Exchange · Mailbox removed")
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
  }
}
