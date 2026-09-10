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
    property var auth: null

    function setUnifiedCalendarView(value) {
      unifiedCalendarView = value === true
      settingChanges = settingChanges + 1
    }
  }

  QtObject {
    id: calendarController

    property var sourceList: ({ version: 1, sources: [] })
    // What the app offers, persisted or not: a discovered Google calendar is
    // listed here before anything has been written for it.
    property var availableSources: ({ version: 1, sources: [
      { id: "google:me@example.com", kind: "google", name: "me@example.com",
        accountId: "me@example.com", calendarId: "primary", enabled: true,
        readOnly: false, colorKey: "accent" },
      { id: "google:me@example.com:team", kind: "google", name: "Team",
        accountId: "me@example.com", calendarId: "team@group.calendar.google.com",
        enabled: true, readOnly: true, colorKey: "cyan" }
    ] })
    property bool savingSource: false
    property var colorChanges: []
    signal calendarSaved(bool ok, string error)

    function addCalDavCalendar(_source, _password) {}
    function removeCalendar(_sourceId) {}
    function updateCalendarPassword(_source, _password) {}
    function setSourceColor(sourceId, colorKey) {
      colorChanges = colorChanges.concat([[String(sourceId), String(colorKey)]])
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

  TestCase {
    name: "CalendarSettings"
    when: windowShown

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

    // Every offered calendar can be given a colour, including a discovered
    // Google calendar that nothing has been written for yet — which is the
    // one a fresh sign-in leaves you with.
    function test_each_offered_calendar_can_be_coloured() {
      var primary = findChild(settings, "calendarColor:google:me@example.com:red")
      var team = findChild(settings, "calendarColor:google:me@example.com:team:magenta")
      verify(primary !== null, "the account's own calendar offers the palette")
      verify(team !== null, "and so does a discovered one")

      primary.choose()
      team.choose()
      compare(JSON.stringify(calendarController.colorChanges), JSON.stringify([
        ["google:me@example.com", "red"],
        ["google:me@example.com:team", "magenta"]
      ]))
    }

    // The colour a calendar already wears is the one wearing the ring, so the
    // row says which of the seven you are on without relying on brightness.
    function test_the_current_colour_is_marked() {
      var chosen = findChild(settings, "calendarColor:google:me@example.com:accent")
      var other = findChild(settings, "calendarColor:google:me@example.com:red")
      compare(chosen.current, true)
      compare(other.current, false)
      verify(chosen.border.width > 0)
      compare(other.border.width, 0)
    }
  }
}
